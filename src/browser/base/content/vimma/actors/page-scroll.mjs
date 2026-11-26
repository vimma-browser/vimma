/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Scrolling in one frame (docs/specs/m1-actor-insert-scroll.md): which element the scroll keys
// move, the scroll areas `gs` cycles and the one it or a click chose (docs/specs/scroll-area.md),
// and the scroll position an agent or a mark reads and restores. VimmaChild owns one per
// actor and hands it the `Vimma:Scroll*` messages; it reads only the actor's document and window.

import { scrollStep } from "../core/scroll.mjs";
import { SCROLL_AREA_MAX_PER_FRAME, SCROLL_AREA_MIN_SHARE } from "../core/scroll-areas.mjs";
import { viewportSize, visibleFrames } from "./hint-collect.mjs";

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
export const SETTLE_MAX_MS = 1000;

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
 * Whether a wheel with these deltas can scroll one of `scrollers` (scrollersUnder) or the page:
 * one that scrolls on an axis has room left the wheel's way on it. Shift can turn a vertical
 * wheel horizontal (mousewheel.with_shift.action), so with shift either axis counts.
 * @param {Window} win
 * @param {Set<EventTarget>} scrollers
 * @param {{ dx: number, dy: number, shift: boolean }} wheel
 */
export function wheelCanScroll(win, scrollers, wheel) {
  const doc = win.document;
  const ways = [
    { vertical: true, sign: Math.sign(wheel.dy) },
    { vertical: false, sign: Math.sign(wheel.dx) },
  ];
  if (wheel.shift) {
    ways.push({ vertical: false, sign: Math.sign(wheel.dy) });
    ways.push({ vertical: true, sign: Math.sign(wheel.dx) });
  }
  /** @type {Set<Element>} */
  const els = new Set();
  if (doc.scrollingElement) els.add(doc.scrollingElement);
  for (const t of scrollers) {
    if (/** @type {Node} */ (t).nodeType === 1) els.add(/** @type {Element} */ (t));
  }
  for (const el of els) {
    for (const { vertical, sign } of ways) {
      if (!sign) continue;
      const pos = vertical ? el.scrollTop : el.scrollLeft;
      // Min, not 0: a right-to-left scroller's scrollLeft runs from a negative min to 0.
      const min = vertical ? el.scrollTopMin : el.scrollLeftMin;
      const max = vertical ? el.scrollTopMax : el.scrollLeftMax;
      if (!(max > min) || !scrollsOn(el, vertical)) continue;
      if (sign > 0 ? pos < max - 0.5 : pos > min + 0.5) return true;
    }
  }
  return false;
}

/**
 * Whether the user can scroll `el` on the axis, whatever its range: the page unless it is
 * locked, another element when its overflow lets it.
 * @param {Element} el
 * @param {boolean} vertical
 */
function scrollsOn(el, vertical) {
  const doc = el.ownerDocument;
  if (el === doc.scrollingElement) return !documentLocked(doc, vertical);
  const overflow = overflowOf(el, vertical);
  return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
}

/**
 * How long the page waits for a wheel the parent asks about (wheelSeen). It is sent right after
 * the question, on the same channel: this only bounds a wheel whose point the page reads
 * otherwise, which then waits for quiet as before.
 */
export const WHEEL_WAIT_MS = 500;
/** Wheels seen by this frame and not yet looked at (wheelSeen); a few are kept. */
const WHEELS_KEPT = 8;
/** A wheel the parent names is this frame's when its point is within this, in CSS pixels. */
const WHEEL_POINT_SLACK = 2;

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

/**
 * Whether the element scrolls on either axis.
 * @param {Element} el
 */
function scrollsEither(el) {
  return canScroll(el, true) || canScroll(el, false);
}

/**
 * The part of `r` inside the viewport, or null when none is.
 * @param {DOMRect} r
 * @param {number} vw
 * @param {number} vh
 */
function inView(r, vw, vh) {
  const x = Math.max(r.left, 0);
  const y = Math.max(r.top, 0);
  const width = Math.min(r.right, vw) - x;
  const height = Math.min(r.bottom, vh) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/**
 * @param {{ x: number, y: number, width: number, height: number }} a
 * @param {{ x: number, y: number, width: number, height: number }} b
 */
function sameBox(a, b) {
  return (
    Math.abs(a.x - b.x) <= 1 &&
    Math.abs(a.y - b.y) <= 1 &&
    Math.abs(a.width - b.width) <= 1 &&
    Math.abs(a.height - b.height) <= 1
  );
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
   * The wheels this frame's document got lately, oldest first, each where it was (viewport CSS
   * pixels) and whether the page cancelled it, until wheelSeen() takes them. `#onWheel` is a
   * wheelSeen() waiting for the next one.
   * @type {{ x: number, y: number, prevented: boolean }[]}
   */
  #wheels = [];
  /** @type {(() => void) | null} */
  #onWheel = null;
  /**
   * The scroll area `gs` or the user's click chose in this document (docs/specs/scroll-area.md),
   * tried before the default rule; null when there is none.
   * @type {WeakRef<Element> | null}
   */
  #chosen = null;
  /** @type {(chosen: boolean) => void} */
  #onChoice;

  /**
   * @param {JSWindowActorChild} actor  the VimmaChild: its document and window are read
   * @param {() => Element | null} activeElement  the focused element, through shadow roots
   * @param {(chosen: boolean) => void} [onChoice]  a click chose an area here, or the choice
   *   ended by itself (the area left the page): the parent's status bar marker follows
   */
  constructor(actor, activeElement, onChoice = () => {}) {
    this.#actor = actor;
    this.#activeElement = activeElement;
    this.#onChoice = onChoice;
  }

  /**
   * The scroll areas of this document (docs/specs/scroll-area.md decision 2): its scroller and
   * each visible element that can scroll and shows at least SCROLL_AREA_MIN_SHARE of the
   * viewport, without one whose box is the same as an area's around it; each with the part of
   * it inside the viewport.
   * @returns {{ el: Element, rect: { x: number, y: number, width: number, height: number } }[]}
   */
  #areas() {
    const win = this.#actor.contentWindow;
    const doc = this.#actor.document;
    if (!win || !doc) return [];
    const { vw, vh } = viewportSize(win);
    if (!(vw > 0 && vh > 0)) return [];
    /** @type {{ el: Element, rect: { x: number, y: number, width: number, height: number } }[]} */
    const out = [];
    const root = doc.scrollingElement;
    if (root && scrollsEither(root))
      out.push({ el: root, rect: { x: 0, y: 0, width: vw, height: vh } });
    const all = doc.getElementsByTagName("*");
    for (let i = 0; i < Math.min(all.length, SEARCH_LIMIT); i++) {
      if (out.length >= SCROLL_AREA_MAX_PER_FRAME) break;
      const el = /** @type {Element} */ (all[i]);
      if (el === root || !this.#isArea(el, vw, vh)) continue;
      const rect = /** @type {{ x: number, y: number, width: number, height: number }} */ (
        inView(el.getBoundingClientRect(), vw, vh)
      );
      if (out.some((a) => a.el.contains(el) && sameBox(a.rect, rect))) continue;
      out.push({ el, rect });
    }
    return out;
  }

  /** The chosen area while it is still in its document, else null (and the choice ends). */
  #chosenArea() {
    const el = this.#chosen?.deref();
    if (el?.isConnected && el.ownerDocument === this.#actor.document) return el;
    if (this.#chosen) {
      this.#chosen = null;
      this.#onChoice(false);
    }
    return null;
  }

  /**
   * Chooses `el` as the area the scroll keys move, or no area when it is the one the default
   * rule picks in the top document, so that the rule's other steps apply again.
   * @param {Element | null} el
   * @returns {boolean} whether an area is chosen now
   */
  #choose(el) {
    const top = !this.#actor.browsingContext?.parent;
    // Vertical only: the default rule's search caches one element for whichever axis it ran
    // on last, and the vertical one is the page's own area.
    const plain = !!el && top && el === this.#defaultTarget(true);
    this.#chosen = el && !plain ? new WeakRef(el) : null;
    return !!this.#chosen;
  }

  /**
   * What `gs` needs of this frame (`Vimma:ScrollAreas`): its areas, which of them the scroll
   * keys move now and which one is chosen, its viewport and its visible subframes, in its
   * viewport's CSS pixels.
   */
  scrollAreas() {
    const win = this.#actor.contentWindow;
    const areas = this.#areas();
    const current = this.target(true) ?? this.target(false);
    const chosen = this.#chosenArea();
    const { vw, vh } = win ? viewportSize(win) : { vw: 0, vh: 0 };
    const doc = this.#actor.document;
    const frameEls = doc
      ? [...doc.getElementsByTagName("iframe"), ...doc.getElementsByTagName("frame")]
      : [];
    return {
      viewport: { x: 0, y: 0, width: vw, height: vh },
      areas: areas.map((a) => ({
        rect: a.rect,
        current: a.el === current,
        chosen: a.el === chosen,
      })),
      frames: win ? visibleFrames(win, frameEls).map((f) => ({ id: f.bc.id, rect: f.rect })) : [],
    };
  }

  /**
   * `gs` chose this document's area `index` (`Vimma:ScrollAreaPick`): the scroll keys move it,
   * and focus comes to this frame, since they go to the focused frame first: a subframe's
   * window is focused, and the top document takes focus back from a frame element.
   * @param {unknown} index
   * @returns {boolean | null} whether an area is chosen (false: the default rule's own), or null
   *   when there is no such area
   */
  pickArea(index) {
    if (!Number.isSafeInteger(index)) return null;
    const area = this.#areas()[/** @type {number} */ (index)];
    if (!area) return null;
    const win = this.#actor.contentWindow;
    if (this.#actor.browsingContext?.parent) win?.focus();
    else {
      const active = this.#actor.document?.activeElement;
      if (active && FRAME_ELEMENTS.has(active.localName))
        /** @type {HTMLElement} */ (active).blur();
    }
    // After the focus moved: the default rule starts from the focused element.
    return this.#choose(area.el);
  }

  /**
   * Another frame's area was chosen (`Vimma:ScrollAreaClear`), or this document is hidden.
   * @returns {boolean} whether a choice was held here
   */
  clearArea() {
    const held = !!this.#chosen;
    this.#chosen = null;
    return held;
  }

  /**
   * The user pressed the mouse (or `f` pressed for them) on `node`: the scroll area around it
   * becomes the target (docs/specs/scroll-area.md decision 5), found the way a wheel there finds
   * what it scrolls (EventStateManager::ComputeScrollTargetAndMayAdjustWheelEvent): the nearest
   * element around it, through shadow hosts, that is an area by decision 2, else the document's
   * scroller. A smaller scroller (a code block, a tab strip) is passed over, so that a click in
   * one does not leave the keys there. Decided after the mousedown's own focus change, since
   * the default rule starts from the focused element. Every such click is reported, also one
   * that keeps the default rule here, so that it ends a choice held in another frame.
   * @param {EventTarget | null} node
   */
  clicked(node) {
    lazy.setTimeout(() => {
      try {
        this.#clickedNow(node);
      } catch {
        // The actor was destroyed meanwhile (its document went away): nothing to choose.
      }
    }, 0);
  }

  /** @param {EventTarget | null} node */
  #clickedNow(node) {
    const doc = this.#actor.document;
    const win = this.#actor.contentWindow;
    if (!doc || !win) return;
    let el =
      node && /** @type {Node} */ (node).nodeType === 1 ? /** @type {Element} */ (node) : null;
    if (!el && node && /** @type {Node} */ (node).nodeType === 3) {
      el = /** @type {Node} */ (node).parentElement;
    }
    if (el && !el.isConnected) return;
    const { vw, vh } = viewportSize(win);
    for (; el; el = /** @type {Element | null} */ (el.assignedSlot) ?? parentOf(el)) {
      if (el !== doc.scrollingElement && this.#isArea(el, vw, vh)) break;
    }
    const root = doc.scrollingElement;
    const area = el ?? (root && scrollsEither(root) ? root : null);
    // A click that focused a smaller scroller inside the area (a list box, a widget with
    // tabindex) leaves the keys with the default rule, which starts from that focus.
    const own = this.#defaultTarget(true);
    if (area && own && own !== area && area.contains(own)) {
      this.#chosen = null;
      this.#onChoice(false);
      return;
    }
    this.#onChoice(this.#choose(area));
  }

  /**
   * Whether `el` is a scroll area by decision 2: it scrolls, is visible, and shows at least
   * SCROLL_AREA_MIN_SHARE of the viewport.
   * @param {Element} el
   * @param {number} vw
   * @param {number} vh
   */
  #isArea(el, vw, vh) {
    if (!scrollsEither(el) || !el.checkVisibility({ visibilityProperty: true })) return false;
    const rect = inView(el.getBoundingClientRect(), vw, vh);
    return !!rect && rect.width * rect.height >= SCROLL_AREA_MIN_SHARE * vw * vh;
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
   * A snapped scroll that has not moved yet may not have reached the page: APZ runs it, and the
   * page sees its first scroll event only after APZ has learnt of it at the next paint and
   * moved it, which on a busy machine takes longer than SETTLE_QUIET_MS (issue #1400). So
   * `starting` tells the caller to let the quiet time count only from its first scroll event.
   * On a mandatory snap container whose snap point that way is where it is (none further on
   * for j or d, or already at the first or last one for gg or G), the scroll does not move,
   * and only SETTLE_MAX_MS ends the wait. A scrollend that came before the scroll moved still
   * gives `starting: false` (above): it may be a cancelled scroll's, which nothing follows.
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
   * @param {boolean} [starting]  a scroll is on its way that has not moved yet (finish(), or a
   *   wheel that can scroll): the quiet time counts from its first scroll event, not from now
   * @param {number} [maxMs]  the wait's limit, SETTLE_MAX_MS unless part of it went already
   * @returns {Promise<void>}
   */
  settled(scrollers, starting = false, maxMs = SETTLE_MAX_MS) {
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
      const cap = lazy.setTimeout(done, Math.max(0, maxMs));
      win.addEventListener("scroll", onScroll, opts);
      win.addEventListener("scrollend", onEnd, opts);
      if (!starting) wait();
    });
  }

  /**
   * A wheel reached this frame's document (VimmaChild, a passive listener in the system group,
   * so after the page's own listeners have had their say).
   * @param {WheelEvent} e
   */
  wheeled(e) {
    if (!e.isTrusted) return;
    this.#wheels.push({ x: e.clientX, y: e.clientY, prevented: e.defaultPrevented });
    if (this.#wheels.length > WHEELS_KEPT) this.#wheels.shift();
    this.#onWheel?.();
  }

  /** Forgets the wheels seen so far: they answer for no later question (wheelSeen). */
  forgetWheels() {
    this.#wheels = [];
  }

  /**
   * The wheel at `point` (viewport CSS pixels) that the parent saw, once this document has got
   * it: whether the page cancelled it. The parent asks before the wheel has reached the page
   * (it sends a wheel on to a content process only after its own listeners have run,
   * EventStateManager::PostHandleEvent), and the page may handle the two in either order, so
   * this waits for the wheel, at most `maxMs`. That wheel and those before it are taken.
   * @param {{ x: number, y: number }} point
   * @param {number} maxMs
   * @returns {Promise<{ prevented: boolean } | null>} null when no such wheel came in time
   */
  wheelSeen(point, maxMs) {
    const take = () => {
      for (let i = this.#wheels.length - 1; i >= 0; i--) {
        const w = /** @type {{ x: number, y: number, prevented: boolean }} */ (this.#wheels[i]);
        if (
          Math.abs(w.x - point.x) <= WHEEL_POINT_SLACK &&
          Math.abs(w.y - point.y) <= WHEEL_POINT_SLACK
        ) {
          this.#wheels.splice(0, i + 1);
          return { prevented: w.prevented };
        }
      }
      return null;
    };
    const now = take();
    if (now) return Promise.resolve(now);
    return new Promise((resolve) => {
      /** @param {{ prevented: boolean } | null} found */
      const end = (found) => {
        lazy.clearTimeout(timer);
        if (this.#onWheel === check) this.#onWheel = null;
        resolve(found);
      };
      const check = () => {
        const found = take();
        if (found) end(found);
      };
      const timer = lazy.setTimeout(() => end(null), Math.max(0, maxMs));
      this.#onWheel = check;
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
   * The element the scroll keys move on this axis: the chosen area, or the nearest element
   * around it that scrolls on the axis (docs/specs/scroll-area.md); else the default rule.
   * @param {boolean} vertical
   * @returns {Element | null}
   */
  target(vertical) {
    for (
      let el = this.#chosenArea();
      el;
      el = /** @type {Element | null} */ (el.assignedSlot) ?? parentOf(el)
    ) {
      if (canScroll(el, vertical)) return el;
    }
    return this.#defaultTarget(vertical);
  }

  /**
   * The default rule: the focused element's scroller, a layer's, the page, or the largest
   * visible scroller.
   * @param {boolean} vertical
   * @returns {Element | null}
   */
  #defaultTarget(vertical) {
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
