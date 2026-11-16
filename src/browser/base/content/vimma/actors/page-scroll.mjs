/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Scrolling in one frame (docs/specs/m1-actor-insert-scroll.md): which element the scroll keys
// move, and the scroll position an agent or a mark reads and restores. VimmaChild owns one per
// actor and hands it the `Vimma:Scroll*` messages; it reads only the actor's document and window.

import { scrollStep } from "../core/scroll.mjs";
import { viewportSize } from "./hint-collect.mjs";

/** @import { ScrollKind } from "./VimmaActors.sys.mjs" */

/** Overflow values that lock an axis: a site's modal sets one on <html> or <body>. */
const LOCKED = new Set(["hidden", "clip"]);

/**
 * @param {Element} el
 * @param {boolean} vertical
 */
function overflowOf(el, vertical) {
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  return (vertical ? style?.overflowY : style?.overflowX) ?? "visible";
}

/**
 * Whether the page itself is scroll-locked on this axis. <body>'s overflow applies to the
 * viewport only while <html>'s is `visible` (CSS Overflow 3, § 3.3).
 * @param {Document} doc
 * @param {boolean} vertical
 */
function documentLocked(doc, vertical) {
  const html = doc.documentElement;
  const root = html ? overflowOf(html, vertical) : "visible";
  if (LOCKED.has(root)) return true;
  return root === "visible" && !!doc.body && LOCKED.has(overflowOf(doc.body, vertical));
}

/**
 * @param {Element} el
 * @param {boolean} vertical
 */
function canScroll(el, vertical) {
  const max = vertical ? el.scrollTopMax : el.scrollLeftMax;
  if (!(max > 0)) return false;
  const doc = el.ownerDocument;
  if (el === doc.scrollingElement) return !documentLocked(doc, vertical);
  const overflow = overflowOf(el, vertical);
  return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
}

/** At most this many elements are searched for the largest scrollable. */
const SEARCH_LIMIT = 10000;
/** A search that found nothing is not repeated for this long (holding j). */
const SEARCH_BACKOFF_MS = 1000;

/**
 * The largest element of `all` (at most SEARCH_LIMIT of them) that scrolls on the axis, or null.
 * @param {HTMLCollectionOf<Element>} all  a live collection, read lazily
 * @param {boolean} vertical
 * @param {boolean} [visibleOnly]  skip what is hidden (a layer's other tab panels)
 */
function largestScrollable(all, vertical, visibleOnly = false) {
  let best = null;
  let area = 0;
  for (let i = 0; i < Math.min(all.length, SEARCH_LIMIT); i++) {
    const el = /** @type {Element} */ (all[i]);
    if (!canScroll(el, vertical)) continue;
    if (visibleOnly && !el.checkVisibility({ visibilityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height > area) [best, area] = [el, r.width * r.height];
  }
  return best;
}

/**
 * The fixed layer under the middle of the viewport, and the scroller under that point inside it:
 * a cookie banner's settings, a modal or a lightbox drawn over a page that still scrolls (issue
 * #864). Cookiebot's layer is a `role=region`, Usercentrics' a dialog without `aria-modal` in a
 * shadow root, so the layer is told by its `position: fixed`, not by its ARIA. Null when the
 * middle of the viewport is the page's own: a fixed header or a chat widget in a corner is not
 * there.
 * @param {Window} win
 * @param {boolean} vertical
 * @returns {{ layer: Element, inner: Element | null } | null}
 */
function layerAtCentre(win, vertical) {
  const { vw, vh } = viewportSize(win);
  if (!(vw > 0 && vh > 0)) return null;
  const x = vw / 2;
  const y = vh / 2;
  const doc = win.document;
  let hit = doc.elementFromPoint(x, y);
  // elementFromPoint stops at a shadow host; the layer can be inside its tree, open or closed.
  for (let root = hit?.openOrClosedShadowRoot; root;) {
    const inner = root.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
    root = hit.openOrClosedShadowRoot;
  }
  /** @type {Element | null} */
  let inner = null;
  for (
    let el = hit;
    el && el !== doc.body && el !== doc.documentElement;
    // Slotted content belongs to the layer its slot is in, not to its light-tree parents.
    el = /** @type {Element | null} */ (el.assignedSlot) ?? parentOf(el)
  ) {
    if (!inner && canScroll(el, vertical)) inner = el;
    if (win.getComputedStyle(el)?.position === "fixed") return { layer: el, inner };
  }
  return null;
}

/**
 * The parent element, stepping out of a shadow root to its host.
 * @param {Element} el
 * @returns {Element | null}
 */
function parentOf(el) {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return "host" in root ? /** @type {ShadowRoot} */ (root).host : null;
}

export class PageScroll {
  /** @type {JSWindowActorChild} */
  #actor;
  /** @type {() => Element | null} */
  #activeElement;
  /** @type {WeakRef<Element> | null} the last largest scrollable, reused while it can scroll */
  #largest = null;
  /**
   * The last fixed layer's largest scrollable, reused while that layer is under the middle of
   * the viewport and the element can scroll.
   * `el` is null when the layer had nothing to scroll, and that search is not repeated for
   * SEARCH_BACKOFF_MS (holding j over a fixed background).
   * @type {{ layer: WeakRef<Element>, el: WeakRef<Element> | null, at: number } | null}
   */
  #layerScroller = null;
  /** When a search for the largest scrollable last found nothing (0: not since focus moved). */
  #emptySearchAt = 0;

  /**
   * @param {JSWindowActorChild} actor  the VimmaChild: its document and window are read
   * @param {() => Element | null} activeElement  the focused element, through shadow roots
   */
  constructor(actor, activeElement) {
    this.#actor = actor;
    this.#activeElement = activeElement;
  }

  /** Focus moved: a search that found nothing may run again at once. */
  focusMoved() {
    this.#emptySearchAt = 0;
  }

  /**
   * Where the page is scrolled to (docs/specs/mcp-drive.md D16): the element `j` scrolls, as a
   * fraction of how far it can go.
   * @returns {number}
   */
  fraction() {
    const el = this.target(true);
    if (!el) return 0;
    const max = el.scrollHeight - el.clientHeight;
    return max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0;
  }

  /** The window's scroll position, or null without a window. */
  position() {
    const win = this.#actor.contentWindow;
    return win ? { x: win.scrollX, y: win.scrollY } : null;
  }

  /**
   * Scrolls the window to a position the parent sends; anything but two finite numbers is
   * ignored.
   * @param {{ x?: unknown, y?: unknown } | null | undefined} data
   */
  scrollTo(data) {
    const x = Number(data?.x);
    const y = Number(data?.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      this.#actor.contentWindow?.scrollTo({ left: x, top: y, behavior: "instant" });
    }
  }

  /**
   * The element the scroll keys move on this axis: the focused element's scroller, a layer's,
   * the page, or the largest visible scroller.
   * @param {boolean} vertical
   * @returns {Element | null}
   */
  target(vertical) {
    const doc = this.#actor.document;
    const root = doc.scrollingElement;
    for (let el = this.#activeElement(); el && el !== root && el !== doc.body;) {
      if (canScroll(el, vertical)) return el;
      el = parentOf(el);
    }
    // A layer over the page (a cookie banner's settings) scrolls before the page behind it: the
    // scroller under the middle of the viewport, else the layer's largest.
    const win = /** @type {Window} */ (this.#actor.contentWindow);
    const over = win && layerAtCentre(win, vertical);
    if (over?.inner) return over.inner;
    if (over) {
      const c = this.#layerScroller?.layer.deref() === over.layer ? this.#layerScroller : null;
      const kept = c?.el?.deref();
      if (kept?.isConnected && canScroll(kept, vertical)) return kept;
      if (!(c && !c.el && Date.now() - c.at < SEARCH_BACKOFF_MS)) {
        const el = largestScrollable(over.layer.getElementsByTagName("*"), vertical, true);
        this.#layerScroller = {
          layer: new WeakRef(over.layer),
          el: el ? new WeakRef(el) : null,
          at: Date.now(),
        };
        if (el) return el;
      }
    }
    if (root && canScroll(root, vertical)) return root;
    // App shells, pdf.js and a locked page's modal scroll an inner element: take the largest
    // visible one. Cached; a search is bounded, and one that found nothing is not repeated
    // until focus moves or a second has passed.
    const last = this.#largest?.deref();
    if (last?.isConnected && canScroll(last, vertical)) return last;
    const now = Date.now();
    if (this.#emptySearchAt && now - this.#emptySearchAt < SEARCH_BACKOFF_MS) return null;
    const best = largestScrollable(doc.getElementsByTagName("*"), vertical);
    this.#largest = best ? new WeakRef(best) : null;
    this.#emptySearchAt = best ? 0 : now;
    return best;
  }

  /**
   * @param {ScrollKind} kind
   * @param {number} count
   * @param {boolean} [instant]  no smooth scroll: an agent's tab in the background, whose
   *   refresh driver is throttled (docs/specs/mcp-drive.md D8)
   * @param {unknown} [step]  j/k/h/l in CSS pixels, `[scroll] step` as the parent sends it;
   *   checked again here, and the default unless config.toml could have set it
   * @returns {boolean} whether this frame had something to scroll
   */
  scroll(kind, count, instant = false, step) {
    const vertical = kind !== "left" && kind !== "right";
    const el = this.target(vertical);
    if (!el) return false;
    const behavior =
      !instant && Services.prefs.getBoolPref("general.smoothScroll", true) ? "smooth" : "instant";
    const n = Math.max(1, Number(count) || 1);
    const by = scrollStep(step) * n;
    // Whole pixels, so d then u returns to the same place.
    const half = Math.round(el.clientHeight / 2) * n;
    /** @type {Record<ScrollKind, () => void>} */
    const run = {
      down: () => el.scrollBy({ top: by, behavior }),
      up: () => el.scrollBy({ top: -by, behavior }),
      right: () => el.scrollBy({ left: by, behavior }),
      left: () => el.scrollBy({ left: -by, behavior }),
      half_down: () => el.scrollBy({ top: half, behavior }),
      half_up: () => el.scrollBy({ top: -half, behavior }),
      top: () => el.scrollTo({ top: 0, behavior }),
      bottom: () => el.scrollTo({ top: el.scrollHeight, behavior }),
    };
    run[kind]();
    return true;
  }
}
