/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Scrolling in one frame (docs/specs/m1-actor-insert-scroll.md): which element the scroll keys
// move, and the scroll position an agent or a mark reads and restores. VimmaChild owns one per
// actor and hands it the `Vimma:Scroll*` messages; it reads only the actor's document and window.

import { scrollStep } from "../core/scroll.mjs";
import { viewportSize } from "./hint-collect.mjs";

/** @import { ScrollKind } from "./VimmaActors.sys.mjs" */

const lazy = /** @type {Lazy<"setTimeout" | "clearTimeout">} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/**
 * How long a smooth scroll this frame started may still be running. `scrollBy` with
 * `behavior: "smooth"` runs on a spring (ScrollAnimationMSDPhysics.cpp, spring constant 250 by
 * default) that settles in about half a second; its scrollend ends it sooner.
 */
const SMOOTH_MAX_MS = 1000;
/** A scroll that sent no scroll event for this long has ended (a wheel at the page's end). */
const SETTLE_QUIET_MS = 150;
/** At most this long a collection waits for a scroll to end (the parent gives the top 2 s). */
const SETTLE_MAX_MS = 1000;

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
  const doc = win.document;
  const hit = deepElementFromPoint(doc, vw / 2, vh / 2);
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
 * The element at a point of the viewport, inside shadow trees too.
 * @param {Document} doc
 * @param {number} x
 * @param {number} y
 */
function deepElementFromPoint(doc, x, y) {
  let hit = doc.elementFromPoint(x, y);
  // elementFromPoint stops at a shadow host; the element can be inside its tree, open or closed.
  for (let root = hit?.openOrClosedShadowRoot; root;) {
    const inner = root.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
    root = hit.openOrClosedShadowRoot;
  }
  return hit;
}

/** Elements that show another document, which scrolls in its own frame. */
const FRAME_ELEMENTS = new Set(["iframe", "frame", "object", "embed"]);

/**
 * What a wheel at `point` (viewport CSS pixels) can scroll in this frame: the page, and each
 * element on the way up from the one under the point (a wheel scrolls the nearest of them that
 * can go its way, and the next one up at its end). Their scroll and scrollend events are the
 * wheel's; another scroller's (a carousel the page's script turns) are not (issue #1337).
 * `frame`: a subframe is under the point, whose own scroll this frame never sees.
 * @param {Window} win
 * @param {{ x: number, y: number } | null} point
 * @returns {{ targets: Set<EventTarget>, frame: boolean }}
 */
export function scrollersUnder(win, point) {
  const doc = win.document;
  /** @type {Set<EventTarget>} */
  const targets = new Set([doc]);
  const hit = point && deepElementFromPoint(doc, point.x, point.y);
  const frame = !!hit && FRAME_ELEMENTS.has(hit.localName);
  for (let el = hit; el; el = /** @type {Element | null} */ (el.assignedSlot) ?? parentOf(el)) {
    targets.add(el);
  }
  return { targets, frame };
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
   * The smooth scroll this frame last started, and where it goes, until its scrollend or
   * SMOOTH_MAX_MS: hints collected meanwhile finish it first (issue #1308).
   * `x`, `y`: where it started; `left`, `top`: its destination; `target`: where its scroll
   * events are fired; `over`: something else took it over meanwhile (moved the scroller back,
   * or a wheel over it); `moving`: it has moved the scroller; `idleEnd`: a scrollend came
   * before it moved; `stop`: removes its listeners.
   * @type {{ el: WeakRef<Element>, x: number, y: number, left: number, top: number,
   *   target: EventTarget, until: number, over: boolean, moving: boolean, idleEnd: boolean,
   *   stop: () => void } | null}
   */
  #running = null;

  /**
   * @param {JSWindowActorChild} actor  the VimmaChild: its document and window are read
   * @param {() => Element | null} activeElement  the focused element, through shadow roots
   */
  constructor(actor, activeElement) {
    this.#actor = actor;
    this.#activeElement = activeElement;
  }

  /**
   * Ends the smooth scroll this frame started, if it still runs, where it was going: hints
   * collected now must label what will be on screen, not what the scroll is passing (issue
   * #1308). Jumping there, rather than waiting for the animation, keeps `d f` as fast as `f`.
   * A scroll on a scroll-snap container is waited for instead: its end is a snap point. A
   * scroll that has left the stretch between its start and its destination, or stepped back
   * within it, was taken over (a snap point further on, the user's wheel or scrollbar): it is
   * not undone, and the caller waits for it to end instead. So is one a wheel over its scroller
   * came during, whichever way (issue #1337): a wheel forward that ends short of the
   * destination is the user's too. A scrollend before the scroll moved is either an earlier
   * scroll's or the end of this one, cancelled before it moved (the page's own instant scroll
   * to where it is): which one is not known, so the caller waits rather than jump.
   * A snapped scroll that has not moved yet has not started: APZ runs it, and the page sees its
   * first scroll event only after APZ has learnt of it at the next paint and moved it, which
   * on a busy machine takes longer than SETTLE_QUIET_MS (issue #1400). So `starting` tells the
   * caller to let the quiet time count only from its first scroll event. It moves unless the
   * snap point it goes to is where it is (scrollBy goes to the next snap point its way, and
   * #started noted none for a scroller already at the end of its range); then nothing ends the
   * wait but SETTLE_MAX_MS.
   * @returns {{ target: EventTarget, starting: boolean } | null} for a scroll still running,
   *   whose end is not known, where its scroll events are fired: wait for it (settled()); null
   *   when there is none
   */
  finish() {
    const run = this.#running;
    this.#running = null;
    run?.stop();
    if (!run || ChromeUtils.now() > run.until) return null;
    const el = run.el.deref();
    if (!el?.isConnected) return null;
    const x = el.scrollLeft;
    const y = el.scrollTop;
    if (x === run.left && y === run.top) return null;
    const within = (/** @type {number} */ v, /** @type {number} */ a, /** @type {number} */ b) =>
      v >= Math.min(a, b) - 1 && v <= Math.max(a, b) + 1;
    const taken = run.over || (run.idleEnd && !run.moving);
    if (taken || !within(x, run.x, run.left) || !within(y, run.y, run.top)) {
      return { target: run.target, starting: false };
    }
    // A scroll-snap container ends the scroll at a snap point that only layout knows; a jump to
    // the unsnapped destination would snap to the nearest point instead, back where the scroll
    // started. Nor does a relative jump (scrollBy) work: APZ shifts its running animation by
    // the same distance, so the page ends beyond where the labels were collected.
    const doc = el.ownerDocument;
    const snapper = el === doc.scrollingElement ? doc.documentElement : el;
    const snap = doc.defaultView?.getComputedStyle(snapper)?.scrollSnapType ?? "none";
    if (snap !== "none") return { target: run.target, starting: !run.moving };
    el.scrollTo({ left: run.left, top: run.top, behavior: "instant" });
    return null;
  }

  /**
   * Resolves once a scroll of one of `scrollers` (where their scroll events are fired: the
   * document for the page) has ended: at its scrollend, once no scroll event came for
   * SETTLE_QUIET_MS (a wheel at the page's end scrolls nothing), and at the latest after
   * SETTLE_MAX_MS. Another scroller's events, such as a carousel the page's script turns every
   * frame, neither end the wait nor hold it open (issue #1337). Only the browser's own scroll
   * events count: the page can dispatch untrusted ones, which a chrome listener on content
   * receives too, but they neither end the wait nor prolong it.
   * @param {Set<EventTarget>} scrollers
   * @param {boolean} [starting]  a scroll is on its way that has not moved yet (finish()): the
   *   quiet time counts from its first scroll event, not from now
   * @returns {Promise<void>}
   */
  settled(scrollers, starting = false) {
    const win = this.#actor.contentWindow;
    if (!win) return Promise.resolve();
    return new Promise((resolve) => {
      const opts = /** @type {AddEventListenerOptions} */ ({ capture: true, mozSystemGroup: true });
      /** @type {number} */
      let quiet;
      const done = () => {
        lazy.clearTimeout(quiet);
        lazy.clearTimeout(cap);
        win.removeEventListener("scroll", onScroll, opts);
        win.removeEventListener("scrollend", onEnd, opts);
        resolve();
      };
      const wait = () => {
        lazy.clearTimeout(quiet);
        quiet = lazy.setTimeout(done, SETTLE_QUIET_MS);
      };
      const ours = (/** @type {Event} */ e) => e.isTrusted && !!e.target && scrollers.has(e.target);
      const onScroll = (/** @type {Event} */ e) => {
        if (ours(e)) wait();
      };
      const onEnd = (/** @type {Event} */ e) => {
        if (ours(e)) done();
      };
      const cap = lazy.setTimeout(done, SETTLE_MAX_MS);
      win.addEventListener("scroll", onScroll, opts);
      win.addEventListener("scrollend", onEnd, opts);
      if (!starting) wait();
    });
  }

  /** Forgets the smooth scroll noted for finish(), and stops watching it. */
  #forget() {
    this.#running?.stop();
    this.#running = null;
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
      this.#forget(); // this position replaces where a smooth scroll was going
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
    const from = { x: el.scrollLeft, y: el.scrollTop };
    run[kind]();
    // An instant scroll has ended already, and replaces where an earlier smooth one was going.
    this.#forget();
    if (behavior === "smooth") this.#running = this.#started(el, from, kind, by, half);
    return true;
  }

  /**
   * Where the smooth scroll just started on `el` goes, for finish(), or null when it goes
   * nowhere (at the end already). As Gecko does for scrollBy
   * (ScrollContainerFrame::ScrollByCSSPixelsInternal), from the rounded position; clamped to
   * the scroll range.
   * @param {Element} el
   * @param {{ x: number, y: number }} from  its position before the scroll
   * @param {ScrollKind} kind
   * @param {number} by
   * @param {number} half
   */
  #started(el, from, kind, by, half) {
    const x = Math.round(from.x);
    const y = Math.round(from.y);
    /** @type {Record<ScrollKind, [number, number]>} */
    const to = {
      down: [x, y + by],
      up: [x, y - by],
      right: [x + by, y],
      left: [x - by, y],
      half_down: [x, y + half],
      half_up: [x, y - half],
      top: [x, 0],
      bottom: [x, el.scrollTopMax],
    };
    const clamp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) =>
      Math.min(Math.max(v, lo), hi);
    const left = clamp(to[kind][0], el.scrollLeftMin, el.scrollLeftMax);
    const top = clamp(to[kind][1], 0, el.scrollTopMax);
    if (left === x && top === y) return null;
    // The root scroller's scroll and scrollend are fired at its document. Only the browser's
    // own count: the page can dispatch untrusted ones, which a chrome listener gets too.
    const target = el === el.ownerDocument.scrollingElement ? el.ownerDocument : el;
    const opts = /** @type {AddEventListenerOptions} */ ({ mozSystemGroup: true });
    // Passive: a listener that may cancel a wheel makes APZ wait for content before scrolling.
    const wheelOpts = /** @type {AddEventListenerOptions} */ ({
      mozSystemGroup: true,
      capture: true,
      passive: true,
    });
    const stop = () => {
      target.removeEventListener("scroll", moved, opts);
      target.removeEventListener("scrollend", ended, opts);
      target.removeEventListener("wheel", wheeled, wheelOpts);
    };
    const run = {
      el: new WeakRef(el),
      x: from.x,
      y: from.y,
      left,
      top,
      target,
      until: ChromeUtils.now() + SMOOTH_MAX_MS,
      over: false,
      moving: false,
      idleEnd: false,
      stop,
    };
    // A step back on either axis is not this scroll's: the user's wheel or scrollbar took over,
    // and finish() must not undo it.
    let last = { x: from.x, y: from.y };
    // `run.moving`: whether this scroll has moved the scroller yet. An instant scroll just
    // before it (the page's, or a mark's) fires its scroll and scrollend at the next refresh,
    // which can come after this scroll started: that scrollend is not this scroll's end.
    const back = (/** @type {number} */ now, /** @type {number} */ was, /** @type {number} */ to) =>
      (now - was) * Math.sign(to - was) < -1;
    const moved = (/** @type {Event} */ e) => {
      if (!e.isTrusted) return;
      const now = { x: el.scrollLeft, y: el.scrollTop };
      if (Math.abs(now.x - from.x) > 0.5 || Math.abs(now.y - from.y) > 0.5) run.moving = true;
      if (back(now.x, last.x, left) || back(now.y, last.y, top)) run.over = true;
      last = now;
    };
    const ended = (/** @type {Event} */ e) => {
      if (!e.isTrusted) return;
      if (!run.moving) {
        run.idleEnd = true;
        return;
      }
      stop();
      if (this.#running === run) this.#running = null;
    };
    // A wheel over the scroller takes the scroll over, also one that goes the same way, which
    // APZ carries on past the destination with no step back to show it (issue #1337). On the
    // page this also counts a wheel over an inner scroller that the page's scroll never sees:
    // f then waits for that scroll's end (at most SETTLE_MAX_MS) where a jump would have done,
    // slower but never wrong, and cheaper than finding which scroller the wheel will move.
    const wheeled = (/** @type {Event} */ e) => {
      if (e.isTrusted) run.over = true;
    };
    target.addEventListener("scroll", moved, opts);
    target.addEventListener("scrollend", ended, opts);
    target.addEventListener("wheel", wheeled, wheelOpts);
    return run;
  }
}
