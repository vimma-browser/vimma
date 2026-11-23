/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The user's hover, per tab (docs/specs/hover.md): which frame and document of a tab hold it,
// what the status bar says of it, and every way it ends that chrome sees (decision 5): `Esc`,
// `hover.release`, another hover, the selected tab changing, the tab closing or moving to
// another window, and its document going away. The page's own ends (a pagehide, the element
// leaving its place, a real mouse move) come from the frame (Vimma:HoverEnded).

import { VimmaActors } from "../actors/VimmaActors.sys.mjs";

/** @import { HintTarget } from "../actors/VimmaActors.sys.mjs" */

/**
 * @typedef {object} HeldHover
 * @property {CanonicalBrowsingContext} bc  the frame of the hovered element
 * @property {WindowGlobalParent} wg  its document when hovered
 * @property {string} text  for the status bar, cleaned and cut (core hoverStatusText)
 * @property {number} seq  changes on every hover, so that each is spoken
 */

/** @type {WeakMap<MozBrowser, HeldHover>} */
const held = new WeakMap();
/**
 * A hover asked of a frame and not yet answered: a release or a newer hover meanwhile must reach
 * the frame too, which may hover the element before it hears of either.
 * @type {WeakMap<MozBrowser, { bc: CanonicalBrowsingContext, wg: WindowGlobalParent }>}
 */
const pending = new WeakMap();
/** Browsers that hold or are asking a hover, for the selected tab's change; weak, as tabs close. */
/** @type {Set<WeakRef<MozBrowser>>} */
const holders = new Set();
let seq = 0;
/** Each hover's run: a release or a newer hover while one is asked drops the older answer. */
/** @type {WeakMap<MozBrowser, number>} */
const runs = new WeakMap();

/** @type {(browser: MozBrowser) => void} */
let changed = () => {};

/** @param {MozBrowser} browser */
function forget(browser) {
  held.delete(browser);
  if (pending.has(browser)) return;
  for (const ref of holders) {
    const b = ref.deref();
    if (!b || b === browser) holders.delete(ref);
  }
}

/** @param {MozBrowser} browser */
function track(browser) {
  for (const ref of holders) if (ref.deref() === browser) return;
  holders.add(new WeakRef(browser));
}

export const HoverOps = {
  /**
   * Who hears that a tab's hover changed: the host, which redraws that window's status bar.
   * @param {(browser: MozBrowser) => void} fn
   */
  onChange(fn) {
    changed = fn;
  },

  /**
   * Hovers `target` in `browser` (a `gh` label). A hover held in another frame of the tab ends
   * first; one in the same document moves, sharing the ancestors both hover (decision 2). The
   * frames around it lock their `<iframe>` chains only once the frame holds the hover, and only
   * while this run is the tab's last (decision 12).
   * @param {MozBrowser} browser
   * @param {HintTarget} target
   */
  async hover(browser, target) {
    this.cancelPending(browser);
    const run = (runs.get(browser) ?? 0) + 1;
    runs.set(browser, run);
    const old = held.get(browser);
    if (old && (old.bc !== target.bc || old.wg !== target.wg)) {
      VimmaActors.releaseHover(old.bc, old.wg);
      forget(browser);
      changed(browser);
    }
    pending.set(browser, { bc: target.bc, wg: target.wg });
    track(browser);
    const reply = await VimmaActors.hover(target);
    if (runs.get(browser) !== run) {
      // Released or replaced meanwhile: whatever the frame did, it lets it go (cancelPending
      // asked already; this covers a frame that answered after an onEnded).
      if (reply) VimmaActors.releaseHover(target.bc, target.wg);
      return;
    }
    pending.delete(browser);
    if (!reply) {
      // The frame refused (the element went away): a hover it held in that document before is
      // let go too, so that none stays without chrome knowing of it.
      if (held.get(browser)?.wg === target.wg) VimmaActors.releaseHover(target.bc, target.wg);
      forget(browser);
      changed(browser);
      return;
    }
    held.set(browser, { bc: target.bc, wg: target.wg, text: reply.text, seq: ++seq });
    VimmaActors.hoverEmbedders(target.bc, "lock");
    changed(browser);
  },

  /**
   * A hover asked and not answered ends: the frame hears a release after the hover it was sent.
   * @param {MozBrowser} browser
   */
  cancelPending(browser) {
    const p = pending.get(browser);
    if (!p) return;
    pending.delete(browser);
    runs.set(browser, (runs.get(browser) ?? 0) + 1);
    VimmaActors.releaseHover(p.bc, p.wg);
  },

  /**
   * Ends the tab's hover, held or asked.
   * @param {MozBrowser} browser
   * @returns {boolean} whether it held or asked one
   */
  release(browser) {
    const asked = pending.has(browser);
    this.cancelPending(browser);
    runs.set(browser, (runs.get(browser) ?? 0) + 1);
    const h = held.get(browser);
    if (!h) {
      forget(browser);
      return asked;
    }
    forget(browser);
    VimmaActors.releaseHover(h.bc, h.wg);
    changed(browser);
    return true;
  },

  /**
   * Whether the tab holds a hover (core resolveEscape's `hovering`).
   * @param {MozBrowser | null | undefined} browser
   */
  held(browser) {
    return !!browser && held.has(browser);
  },

  /**
   * What the status bar shows of the tab's hover (decision 8), or null.
   * @param {MozBrowser | null | undefined} browser
   * @returns {{ text: string, agent: boolean, seq: number } | null}
   */
  status(browser) {
    const h = browser ? held.get(browser) : undefined;
    return h ? { text: h.text, agent: false, seq: h.seq } : null;
  },

  /**
   * The selected tab of `win` changed (a tab, workspace or split pane switch): every other tab
   * of the window lets its hover go, since the status bar shows only the selected tab's
   * (decision 5).
   * @param {BrowserWindow} win
   */
  onTabSelect(win) {
    const selected = win.gBrowser?.selectedBrowser;
    for (const ref of [...holders]) {
      const b = ref.deref();
      const own = /** @type {unknown} */ (b?.ownerDocument?.defaultView) === win;
      if (b && b !== selected && own) this.release(b);
    }
  },

  /**
   * A frame's document ended its hover itself (Vimma:HoverEnded), or went away (a navigation, a
   * crash, a discarded or closed tab): the tab whose hover it held lets it go. The page's own
   * locks went with its document, or were removed by the frame; the frames around it unlock.
   * @param {WindowGlobalParent} wg
   */
  onEnded(wg) {
    for (const ref of [...holders]) {
      const b = ref.deref();
      // A frame that ended or lost a hover still being asked: its answer is dropped.
      if (b && pending.get(b)?.wg === wg) {
        pending.delete(b);
        runs.set(b, (runs.get(b) ?? 0) + 1);
        forget(b);
      }
      const h = b && held.get(b);
      if (!b || !h || h.wg !== wg) continue;
      forget(b);
      VimmaActors.hoverEmbedders(h.bc, "release");
      changed(b);
    }
  },
};
