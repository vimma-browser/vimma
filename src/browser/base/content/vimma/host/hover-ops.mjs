/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A tab's hover, the user's or an agent's (docs/specs/hover.md; one at a time per tab, decision
// 7): which frame and document of a tab hold it, what the status bar says of it, and every way
// it ends that chrome sees (decision 5): `Esc`, `hover.release`, another hover, the selected tab
// changing, the tab closing or moving to another window, and its document going away; for an
// agent's (decision 9), its `release: true`, the user's key in the tab, the connection's end and
// the tab leaving the agent workspace. The page's own ends (a pagehide, the element leaving its
// place, a real mouse move) come from the frame (Vimma:HoverEnded). An agent's hover is begun and
// released only through `Vimma:AgentElement` (AgentActors), never the user's `Vimma:Hover`
// (security.md M67).

import { AgentActors } from "../actors/AgentActors.sys.mjs";
import { VimmaActors } from "../actors/VimmaActors.sys.mjs";
import { hoverStatusText } from "../core/hints.mjs";

/** @import { HintTarget } from "../actors/VimmaActors.sys.mjs" */
/** @import { ConnId } from "../core/agent.mjs" */

/**
 * @typedef {object} HeldHover
 * @property {CanonicalBrowsingContext} bc  the frame of the hovered element
 * @property {WindowGlobalParent} wg  its document when hovered
 * @property {string} text  for the status bar, cleaned and cut (core hoverStatusText)
 * @property {number} seq  changes on every hover, so that each is spoken
 * @property {ConnId | null} conn  the agent connection whose hover it is; null: the user's
 */

/**
 * Lets a hover go in its frame, through the message of whoever began it, and unlocks the frames
 * around it.
 * @param {{ bc: CanonicalBrowsingContext, wg: WindowGlobalParent, conn: ConnId | null }} h
 */
function letGo(h) {
  if (h.conn === null) {
    VimmaActors.releaseHover(h.bc, h.wg);
    return;
  }
  AgentActors.agentHoverRelease(h.bc, h.wg).catch(() => {});
  VimmaActors.hoverEmbedders(h.bc, "release");
}

/** @type {WeakMap<MozBrowser, HeldHover>} */
const held = new WeakMap();
/**
 * A hover asked of a frame and not yet answered: a release or a newer hover meanwhile must reach
 * the frame too, which may hover the element before it hears of either.
 * @type {WeakMap<MozBrowser, { bc: CanonicalBrowsingContext, wg: WindowGlobalParent,
 *   conn: ConnId | null }>}
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

/**
 * Each tab's agent releases, by connection: a hover call that began before the count it read
 * changed was released before it ran, and must not hover (security.md M67).
 * @type {WeakMap<MozBrowser, Map<ConnId, number>>}
 */
const releases = new WeakMap();
/** Connections that ended: a hover of theirs still on its way must not run. */
/** @type {Set<ConnId>} */
const ended = new Set();

/** @param {MozBrowser} browser @param {ConnId} conn */
function releaseCount(browser, conn) {
  return releases.get(browser)?.get(conn) ?? 0;
}

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
      letGo(old);
      forget(browser);
      changed(browser);
    }
    pending.set(browser, { bc: target.bc, wg: target.wg, conn: null });
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
    held.set(browser, { bc: target.bc, wg: target.wg, text: reply.text, seq: ++seq, conn: null });
    VimmaActors.hoverEmbedders(target.bc, "lock");
    changed(browser);
  },

  /**
   * An agent's hover of `target` in `browser` is about to run (docs/specs/hover.md decision 9):
   * a hover held in another frame of the tab ends first, and the frame's hover is pending until
   * `agentRan` says whether it ran, so that an end the page reports meanwhile is not lost.
   * @param {MozBrowser} browser @param {HintTarget} target @param {ConnId} conn
   * @returns {number} the run, for agentRan
   */
  agentBegin(browser, target, conn) {
    this.cancelPending(browser);
    const run = (runs.get(browser) ?? 0) + 1;
    runs.set(browser, run);
    const old = held.get(browser);
    if (old && (old.bc !== target.bc || old.wg !== target.wg)) {
      letGo(old);
      forget(browser);
      changed(browser);
    }
    pending.set(browser, { bc: target.bc, wg: target.wg, conn });
    track(browser);
    return run;
  },

  /**
   * The agent's hover begun as `run` ran in its frame, or not (`ran`): it is held as the
   * connection's, with `text` for the status bar, and the frames around it lock their `<iframe>`
   * chains (decision 12). False when it does not hold: it did not run, its frame shows another
   * document, or it ended or was replaced meanwhile.
   * @param {MozBrowser} browser @param {number} run @param {HintTarget} target
   * @param {ConnId} conn @param {boolean} ran @param {string} text
   */
  agentRan(browser, run, target, conn, ran, text) {
    if (runs.get(browser) !== run) {
      // Released or replaced while it was on its way: a hover that ran anyway is let go, unless
      // a newer one holds that document (it replaced this one there).
      const now = held.get(browser) ?? pending.get(browser);
      if (ran && now?.wg !== target.wg) {
        AgentActors.agentHoverRelease(target.bc, target.wg).catch(() => {});
      }
      return false;
    }
    pending.delete(browser);
    if (!ran || target.bc.currentWindowGlobal !== target.wg) {
      // A hover of this connection's the frame held in that document before is let go too,
      // so that none stays without chrome knowing of it; never the user's.
      const h = held.get(browser);
      if (h?.wg === target.wg && h.conn === conn) letGo(h);
      forget(browser);
      changed(browser);
      return false;
    }
    held.set(browser, {
      bc: target.bc,
      wg: target.wg,
      text: hoverStatusText(text),
      seq: ++seq,
      conn,
    });
    VimmaActors.hoverEmbedders(target.bc, "lock");
    changed(browser);
    return true;
  },

  /**
   * An agent's `release: true` (decision 9): ends the connection's own hover in the tab, held
   * or pending, never the user's or another connection's.
   * @param {MozBrowser} browser @param {ConnId} conn
   * @returns {boolean} whether it had one
   */
  agentRelease(browser, conn) {
    let counts = releases.get(browser);
    if (!counts) releases.set(browser, (counts = new Map()));
    counts.set(conn, releaseCount(browser, conn) + 1);
    const mine = held.get(browser)?.conn === conn || pending.get(browser)?.conn === conn;
    return mine ? this.release(browser) : false;
  },

  /**
   * A token for an agent's hover call in `browser`, taken when the call starts: `stillWanted`
   * says whether it may still hover, false once the connection released in that tab or ended
   * since, so that a release or an end that overtakes a hover on its way ends it too.
   * @param {MozBrowser} browser @param {ConnId} conn
   */
  agentCall(browser, conn) {
    const at = releaseCount(browser, conn);
    return { stillWanted: () => !ended.has(conn) && releaseCount(browser, conn) === at };
  },

  /**
   * Whether the user holds or is asking a hover in `browser`: an agent's hover there would
   * replace it, so it is denied as the tab being in use.
   * @param {MozBrowser} browser
   */
  userHovering(browser) {
    return held.get(browser)?.conn === null || pending.get(browser)?.conn === null;
  },

  /**
   * The agent connection `conn` ended (decision 9): each of its hovers ends.
   * @param {ConnId} conn
   */
  forgetConn(conn) {
    ended.add(conn);
    for (const ref of [...holders]) {
      const b = ref.deref();
      if (b) this.agentRelease(b, conn);
    }
  },

  /**
   * Ends each agent's hover in a tab that is no longer its connection's to act in (the tab left
   * the agent workspace, decision 9).
   * @param {(browser: MozBrowser, conn: ConnId) => boolean} keep
   */
  recheckAgents(keep) {
    for (const ref of [...holders]) {
      const b = ref.deref();
      const conn = b && (held.get(b)?.conn ?? pending.get(b)?.conn ?? null);
      if (b && conn !== null && conn !== undefined && !keep(b, conn)) this.release(b);
    }
  },

  /**
   * The user pressed a key in `browser`'s page: an agent's hover there ends, since the user has
   * started to use the tab (decision 9); the user's own stays.
   * @param {MozBrowser | null | undefined} browser
   */
  userActs(browser) {
    if (!browser) return;
    const conn = held.get(browser)?.conn ?? pending.get(browser)?.conn ?? null;
    if (conn !== null) this.release(browser);
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
    letGo(p);
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
    letGo(h);
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
    return h ? { text: h.text, agent: h.conn !== null, seq: h.seq } : null;
  },

  /**
   * The selected tab of `win` changed (a tab, workspace or split pane switch): every other tab
   * of the window lets the user's hover go, since the status bar shows only the selected tab's
   * (decision 5). An agent's stays: its tab is in the background by design (decision 9).
   * @param {BrowserWindow} win
   */
  onTabSelect(win) {
    const selected = win.gBrowser?.selectedBrowser;
    for (const ref of [...holders]) {
      const b = ref.deref();
      const own = /** @type {unknown} */ (b?.ownerDocument?.defaultView) === win;
      const agent = !!b && (held.get(b)?.conn ?? pending.get(b)?.conn ?? null) !== null;
      if (b && b !== selected && own && !agent) this.release(b);
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
