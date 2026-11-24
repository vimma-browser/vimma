/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Hovering an element in one document (docs/specs/hover.md decisions 2, 5, 6, 12 and 13). Runs in
// the content process, in VimmaChild. `:hover` follows the real pointer only: an event a script
// or this actor dispatches does not set it (EventStateManager::NotifyMouseOver is reached only
// from a widget mouse move), so the hover is a `:hover` pseudo-class lock
// (InspectorUtils.addPseudoClassLock, chrome-only, the DevTools "force element state") on the
// element and on each element a real pointer there would hover with it, with the pointer and
// mouse events a pointer entering it sends. A lock is one bit per state, not a count
// (Element::LockStyleStates, dom/base/Element.cpp), so only the elements this module locked are
// unlocked, and an element already locked (by DevTools) is left alone.
//
// Who dispatches the events decides their trust (decision 3): VimmaChild passes the dispatch
// function, and this module has no trust option of its own.

/** @typedef {(target: Element, event: Event) => void} Dispatch */

const HOVER = ":hover";
/** The system group sees the real mouse even when the page stops it (chrome-only option). */
const SYSTEM_CAPTURE = /** @type {AddEventListenerOptions} */ ({
  capture: true,
  mozSystemGroup: true,
});

/**
 * The elements a real pointer over `el` hovers with it, innermost first: the element and its
 * flattened-tree ancestors, through slots and shadow hosts (EventStateManager::
 * UpdateAncestorState walks GetFlattenedTreeParent), with the control of each `<label>` among
 * them, which a real pointer hovers too (GetLabelTarget) and a lock on the label does not.
 * `path` is the walk itself, for the enter and leave events; `extra` the labels' controls.
 * @param {Element} el
 * @returns {{ path: Element[], extra: Element[] }}
 */
export function hoverChain(el) {
  /** @type {Element[]} */
  const path = [];
  /** @type {Element[]} */
  const extra = [];
  for (let n = /** @type {Node | null} */ (el); n; n = n.flattenedTreeParentNode) {
    if (n.nodeType !== 1) break;
    const e = /** @type {Element} */ (n);
    path.push(e);
    if (e.localName === "label") {
      const control = /** @type {HTMLLabelElement} */ (e).control;
      if (control && !path.includes(control)) extra.push(control);
    }
  }
  return { path, extra };
}

/**
 * The point a pointer resting on `el` would be at: the centre of its first box that has a size,
 * as a press takes it (VimmaChild #press uses the border box).
 * @param {Element} el
 */
function centreOf(el) {
  for (const r of el.getClientRects()) {
    if (r.width >= 1 && r.height >= 1) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * What the status bar says of a hovered element (decision 8): its accessible name, else its text,
 * else its title. Raw: the parent cleans and cuts it (core hoverStatusText).
 * @param {Element} el
 */
function hoverText(el) {
  const html = /** @type {HTMLElement} */ (el);
  const label = el.getAttribute("aria-label")?.trim();
  if (label) return label.slice(0, 4096);
  const text = (typeof html.innerText === "string" ? html.innerText : el.textContent) ?? "";
  if (text.trim()) return text.slice(0, 4096);
  return (el.getAttribute("title") ?? el.getAttribute("alt") ?? el.localName).slice(0, 4096);
}

/**
 * Locks `:hover` on each element that has no lock yet; returns those it locked.
 * @param {Iterable<Element>} elements
 * @returns {Element[]}
 */
function lockAll(elements) {
  /** @type {Element[]} */
  const locked = [];
  for (const e of elements) {
    if (InspectorUtils.hasPseudoClassLock(e, HOVER)) continue;
    InspectorUtils.addPseudoClassLock(e, HOVER);
    locked.push(e);
  }
  return locked;
}

/** @param {Iterable<WeakRef<Element>>} refs */
function unlockAll(refs) {
  for (const ref of refs) {
    const e = ref.deref();
    if (!e) continue;
    try {
      InspectorUtils.removePseudoClassLock(e, HOVER);
    } catch {
      // A dead wrapper: its document is gone, and its lock with it.
    }
  }
}

/**
 * @typedef {object} Held
 * @property {WeakRef<Element>} el
 * @property {WeakRef<Element>[]} path  the enter path, innermost first, as locked or not
 * @property {WeakRef<Element>[]} locked  the elements this hover locked
 * @property {Dispatch} dispatch
 * @property {() => void} onEnd  told when the hover ends by itself (decisions 5 and 13)
 * @property {MutationObserver[]} observers
 * @property {{ slot: Element, fn: () => void }[]} slots
 * @property {((e: Event) => void) | null} move
 */

/** One document's hover, and the `<iframe>` chain it locks for a hovered subframe (decision 12). */
export class DocumentHover {
  /** @type {Held | null} */
  #held = null;
  /** @type {{ frame: WeakRef<Element>, locked: WeakRef<Element>[] } | null} */
  #embedder = null;
  /** The actor is dispatching hover events: its own trusted mousemove is no user's move. */
  #dispatching = false;
  /** The last trusted mousemove's screen point not dispatched here (decision 5). */
  /** @type {{ x: number, y: number } | null} */
  #lastMove = null;

  /** Whether an element of this document is hovered. */
  get held() {
    return !!this.#held;
  }

  /**
   * Hovers `el`: a new hover, a move from the element held (the two share their common
   * ancestors, as a real move does), or the same element again (one pointermove and one
   * mousemove, as a mouse moved within it).
   * @param {Element} el
   * @param {{ dispatch: Dispatch, onEnd: () => void }} how
   * @returns {{ hovered: true, text: string }}
   */
  hover(el, { dispatch, onEnd }) {
    const win = /** @type {Window} */ (el.ownerDocument.defaultView);
    // Read before the events: a menu they open is not the element's own text.
    const text = hoverText(el);
    const prev = this.#held;
    const prevEl = prev?.el.deref() ?? null;
    if (prev && prevEl === el) {
      // The same element: no enter or leave, and no lock changes (hover.md decision 9).
      prev.dispatch = dispatch;
      prev.onEnd = onEnd;
      const at = centreOf(el);
      this.#send(dispatch, [[el, this.#event(win, "pointermove", at, null)]]);
      this.#send(dispatch, [[el, this.#event(win, "mousemove", at, null)]]);
      return { hovered: true, text };
    }
    const { path, extra } = hoverChain(el);
    const pathSet = new Set(path);
    /** @type {Element[]} */
    const oldPath = [];
    if (prev) {
      for (const ref of prev.path) {
        const e = ref.deref();
        if (e) oldPath.push(e);
      }
      this.#stopWatching(prev);
      this.#held = null;
      // Unlock what the old hover locked and the new one does not keep.
      const kept = new Set([...path, ...extra]);
      unlockAll(prev.locked.filter((r) => !kept.has(/** @type {Element} */ (r.deref()))));
      const stillLocked = prev.locked
        .map((r) => r.deref())
        .filter((e) => e && kept.has(e))
        .map((e) => new WeakRef(/** @type {Element} */ (e)));
      // Leave events for what stops being hovered (decision 6), before the enter events.
      const leaving = oldPath.filter((e) => !pathSet.has(e) && e.isConnected);
      if (prevEl?.isConnected) this.#leave(prev.dispatch, win, prevEl, leaving, el);
      const locked = [...stillLocked, ...lockAll([...path, ...extra]).map((e) => new WeakRef(e))];
      this.#begin(el, path, locked, dispatch, onEnd);
      this.#enter(
        dispatch,
        win,
        el,
        path.filter((e) => !oldPath.includes(e)),
        prevEl,
      );
    } else {
      const locked = lockAll([...path, ...extra]).map((e) => new WeakRef(e));
      this.#begin(el, path, locked, dispatch, onEnd);
      this.#enter(dispatch, win, el, path, null);
    }
    return { hovered: true, text };
  }

  /**
   * Ends the hover: unlocks this hover's own locks and, with `events`, sends the leave events
   * on the elements still in the document (decision 6). No events on a `pagehide`, since the page
   * is going away (decision 5).
   * @param {{ events?: boolean }} [options]
   */
  release({ events = true } = {}) {
    const held = this.#held;
    if (!held) return false;
    this.#held = null;
    this.#stopWatching(held);
    unlockAll(held.locked);
    const el = held.el.deref();
    if (events && el?.isConnected) {
      const path = /** @type {Element[]} */ (held.path.map((r) => r.deref()).filter(Boolean));
      this.#leave(
        held.dispatch,
        /** @type {Window} */ (el.ownerDocument.defaultView),
        el,
        path.filter((e) => e.isConnected),
        null,
      );
    }
    return true;
  }

  /**
   * Locks the chain of the `<iframe>` element of a hovered subframe (decision 12): locks only, no
   * events. Replaces any embedder lock this document held.
   * @param {Element} frame
   */
  lockEmbedder(frame) {
    this.releaseEmbedder();
    const { path, extra } = hoverChain(frame);
    this.#embedder = {
      frame: new WeakRef(frame),
      locked: lockAll([...path, ...extra]).map((e) => new WeakRef(e)),
    };
  }

  releaseEmbedder() {
    const held = this.#embedder;
    this.#embedder = null;
    if (held) unlockAll(held.locked);
    return !!held;
  }

  /** The document is going away, also into the back-forward cache (decision 5). */
  pageHidden() {
    const had = this.release({ events: false });
    this.releaseEmbedder();
    return had;
  }

  /**
   * @param {Element} el @param {Element[]} path @param {WeakRef<Element>[]} locked
   * @param {Dispatch} dispatch @param {() => void} onEnd
   */
  #begin(el, path, locked, dispatch, onEnd) {
    /** @type {Held} */
    const held = {
      el: new WeakRef(el),
      path: path.map((e) => new WeakRef(e)),
      locked,
      dispatch,
      onEnd,
      observers: [],
      slots: [],
      move: null,
    };
    this.#held = held;
    this.#watch(held, el, path);
  }

  /**
   * Watches for the element leaving its place (decision 13): mutations in its document and in
   * each shadow tree on its chain, and slot reassignments on it; and for the real mouse moving
   * (decision 5).
   * @param {Held} held @param {Element} el @param {Element[]} path
   */
  #watch(held, el, path) {
    const doc = el.ownerDocument;
    const win = /** @type {Window} */ (el.ownerDocument.defaultView);
    const check = () => {
      if (this.#held !== held) return;
      if (this.#inPlace(held, el, doc)) return;
      this.release();
      held.onEnd();
    };
    /** @type {Node[]} */
    const roots = [doc];
    for (const e of path) {
      const root = e.openOrClosedShadowRoot;
      if (root) roots.push(root);
      if (e.localName === "slot") {
        e.addEventListener("slotchange", check);
        held.slots.push({ slot: e, fn: check });
      }
    }
    for (const root of roots) {
      const observer = new win.MutationObserver(check);
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["slot"],
      });
      held.observers.push(observer);
    }
    this.#lastMove = null;
    held.move = (e) => {
      if (this.#held !== held || this.#dispatching || !e.isTrusted) return;
      const m = /** @type {MouseEvent} */ (e);
      const at = { x: m.screenX, y: m.screenY };
      const last = this.#lastMove;
      this.#lastMove = at;
      // Firefox's own moves after a scroll or a reflow send no DOM mousemove (hover.md
      // Research), so any trusted one is a real pointer; one at the point already seen is not a
      // move.
      if (last && last.x === at.x && last.y === at.y) return;
      this.release();
      held.onEnd();
    };
    win.addEventListener("mousemove", held.move, SYSTEM_CAPTURE);
  }

  /** @param {Held} held @param {Element} el @param {Document} doc */
  #inPlace(held, el, doc) {
    if (!el.isConnected || el.ownerDocument !== doc) return false;
    const { path } = hoverChain(el);
    if (path.length !== held.path.length) return false;
    return path.every((e, i) => held.path[i]?.deref() === e);
  }

  /** @param {Held} held */
  #stopWatching(held) {
    for (const o of held.observers) o.disconnect();
    held.observers = [];
    for (const { slot, fn } of held.slots) slot.removeEventListener("slotchange", fn);
    held.slots = [];
    if (held.move) {
      const el = held.el.deref();
      const win = el?.ownerDocument?.defaultView;
      try {
        if (win) win.removeEventListener("mousemove", held.move, SYSTEM_CAPTURE);
      } catch {
        // The window is gone, with its listeners.
      }
      held.move = null;
    }
  }

  /**
   * An event as a mouse pointer gives it (decision 2): the page's own constructor, at the
   * element's centre, with no buttons; pointer events of type mouse, primary, pointer 1, which
   * menu libraries look for.
   * @param {Window} win @param {string} type @param {{ x: number, y: number }} at
   * @param {Element | null} related
   */
  #event(win, type, at, related) {
    const bubbles = !type.endsWith("enter") && !type.endsWith("leave");
    const init = {
      bubbles,
      cancelable: bubbles,
      composed: true,
      view: win,
      clientX: at.x,
      clientY: at.y,
      button: 0,
      buttons: 0,
      relatedTarget: related,
    };
    if (type.startsWith("pointer")) {
      return new win.PointerEvent(type, {
        ...init,
        pointerType: "mouse",
        pointerId: 1,
        isPrimary: true,
      });
    }
    return new win.MouseEvent(type, init);
  }

  /** @param {Dispatch} dispatch @param {[Element, Event][]} list */
  #send(dispatch, list) {
    this.#dispatching = true;
    try {
      for (const [target, event] of list) dispatch(target, event);
    } finally {
      this.#dispatching = false;
    }
  }

  /**
   * The events of a pointer entering `el` (decision 2, experiments F and X3): pointerover,
   * pointerenter from the outermost newly hovered element down, pointermove, then the same
   * for the mouse events.
   * @param {Dispatch} dispatch @param {Window} win @param {Element} el
   * @param {Element[]} entering  innermost first @param {Element | null} related
   */
  #enter(dispatch, win, el, entering, related) {
    const at = centreOf(el);
    const outerFirst = [...entering].reverse();
    /** @type {[Element, Event][]} */
    const list = [];
    for (const [over, enter, move] of [
      ["pointerover", "pointerenter", "pointermove"],
      ["mouseover", "mouseenter", "mousemove"],
    ]) {
      list.push([el, this.#event(win, /** @type {string} */ (over), at, related)]);
      for (const e of outerFirst) {
        list.push([e, this.#event(win, /** @type {string} */ (enter), at, related)]);
      }
      list.push([el, this.#event(win, /** @type {string} */ (move), at, null)]);
    }
    this.#send(dispatch, list);
  }

  /**
   * The events of a pointer leaving `el` (decision 6): pointerout, pointerleave innermost first,
   * then mouseout and mouseleave.
   * @param {Dispatch} dispatch @param {Window} win @param {Element} el
   * @param {Element[]} leaving  innermost first @param {Element | null} related
   */
  #leave(dispatch, win, el, leaving, related) {
    const at = centreOf(el);
    /** @type {[Element, Event][]} */
    const list = [];
    for (const [out, leave] of [
      ["pointerout", "pointerleave"],
      ["mouseout", "mouseleave"],
    ]) {
      list.push([el, this.#event(win, /** @type {string} */ (out), at, related)]);
      for (const e of leaving) {
        list.push([e, this.#event(win, /** @type {string} */ (leave), at, related)]);
      }
    }
    this.#send(dispatch, list);
  }
}
