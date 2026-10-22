/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The private workspace in place of the Vimma window on Hyprland (docs/specs/private-swap.md).
// Going to private parks the normal window in special:vimma and puts the private window in its
// exact slot; going back swaps again. This module does the I/O around core's hyprswap.mjs: it
// finds Hyprland, learns each Vimma window's address from a random nonce title, keeps the pair
// in memory (nothing on disk, decision 8), and never leaves a window stranded (decision 7).
// Elsewhere, or with `[private] placement = "window"`, it does nothing and private-ops.mjs
// shows windows as before.

import {
  PARK,
  PROBE_LUA,
  QUERY_ACTIVE_WORKSPACE,
  QUERY_CLIENTS,
  QUERY_VERSION,
  detectDialect,
  encodeBatch,
  findNonce,
  nonceTitle,
  pairStep,
  parkedWindow,
  parseActiveWorkspace,
  parseClients,
  parseEvent,
  planRescue,
  planShow,
  repliesOk,
} from "../core/hyprswap.mjs";
import { HyprIpc, REPLY_MS } from "./hypr/HyprIpc.sys.mjs";
import { NativeSwap } from "./native-swap.mjs";

export { isBrowserWindow } from "./native-swap.mjs";

/** @import { Client, Command, Dialect, Pair, PairEvent, ShowOp } from "../core/hyprswap.mjs" */
/** @import { PrivatePlacement } from "../core/config.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  VimmaHost: "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
});

/** What a failed swap says, once (decision 7). */
export const SWAP_REFUSED = "private: the window manager refused the swap; showing it as a window";

/** @type {PrivatePlacement} */
let placement = "swap";
/** config.toml was read: until then nothing is sent, whatever it says. */
let configured = false;
/** GTK's activate for a window a batch just focused or parked comes late: it is the swap's. */
const SETTLE_MS = 400;
let settleUntil = 0;
/** movewindowv2 events our own batches will cause, per window: not the user's moves. */
/** @type {Map<string, number>} */
const ownMoves = new Map();
/** Bumped when the pair is forgotten: swaps queued before that are dropped. */
let epoch = 0;
/** A swap failed: "window" placement until the next config reload (decision 7). */
let failed = false;
/**
 * @type {{ state: "unknown" } | { state: "pending", promise: Promise<boolean> }
 *   | { state: "ok", dialect: Dialect, version: string }
 *   | { state: "none", reason: string, retry: boolean }}
 */
let wm = { state: "unknown" };
/** Each kind of console line once a session (decisions 3 and 7). @type {Set<string>} */
const logged = new Set();
/** Why the last switch was shown as a window although Hyprland was found, for about:vimma. */
/** @type {string | null} */
let skipped = null;
/** Tests: a fake Hyprland, so the headless and Wayland checks do not apply. */
let forced = false;

/** @type {WeakMap<Window, string>} */
const addresses = new WeakMap();
/** @type {WeakMap<Window, Promise<string | null>>} */
let resolving = new WeakMap();
/** The switches that wait on the naming in `resolving`. @type {WeakMap<Window, Set<number>>} */
let waiters = new WeakMap();
/** Bumped by a reset: a naming begun before it ends without an address. */
let naming = 0;
/** @type {Map<string, WeakRef<Window>>} */
const byAddress = new Map();
/** Pending nonce titles and who waits for them. @type {Map<string, (a: string | null) => void>} */
const nonces = new Map();
/** The last known record of each of our windows, for a window already gone (decision 7). */
/** @type {Map<string, Client>} */
const records = new Map();
/** @type {Set<Window>} every browser window seen, to resolve once swap applies */
const windows = new Set();
/** @type {{ close: () => void } | null} */
let events = null;
/** The listener was wanted after it opened: if it turns out dropped, listen again at once. */
let relisten = false;
/** @type {Pair} */
let pair = null;
/** Swaps run one after another. */
let chain = Promise.resolve(true);
/** A swap is running: activations meanwhile are the swap's own. */
let running = 0;

/** @param {string} text @param {string} [kind]  lines of one kind share their once */
function logOnce(text, kind = text) {
  if (logged.has(kind)) return;
  logged.add(kind);
  console.warn(`vimma: ${text}`);
}

/**
 * How long a naming waits for Hyprland's event (#422). The event for a window that is still
 * starting up can come well after REPLY_MS on a busy machine, before j/clients shows the title.
 */
export const NAME_MS = 2000;
/**
 * A naming a switch waited on gave up, and none has succeeded since (nor was config.toml read):
 * later ones wait only REPLY_MS, so a Hyprland that does not name windows does not hold every
 * switch for NAME_MS. A naming no switch waits on (at startup, from track) never sets it.
 */
let unnamed = false;
/** Bumped by every switch (enter, show): a switch still naming when another began is dropped. */
let switches = 0;
/**
 * Private windows a switch opened that no switch has swapped in yet: a dropped switch, or one
 * whose naming gave up, leaves its window here, so the next switch to it still swaps it in
 * rather than only focusing it.
 * @type {WeakSet<Window>}
 */
let unswapped = new WeakSet();

/** What a switch says when Hyprland never named a Vimma window (decision 7). */
const NOT_NAMED = "private: Hyprland did not name the Vimma window; showing it as a window";

/**
 * Resolves once `win`'s browser document has finished its delayed startup: true, or false when
 * it closed first. The window OpenBrowserWindow returns still shows the initial about:blank,
 * without browser-init.js's delayedStartupPromise, and a title set on that document never
 * reaches the window manager.
 * @param {Window} win
 * @returns {Promise<boolean>}
 */
export function startedUp(win) {
  const w = /** @type {any} */ (win);
  if (w.closed) return Promise.resolve(false);
  if (w.gBrowserInit?.delayedStartupFinished) return Promise.resolve(true);
  const READY = "browser-delayed-startup-finished";
  const CLOSED = "domwindowclosed";
  return new Promise((resolve) => {
    /** @param {unknown} subject @param {string} topic */
    const observer = (subject, topic) => {
      if (subject !== win) return;
      Services.obs.removeObserver(observer, READY);
      Services.obs.removeObserver(observer, CLOSED);
      resolve(topic === READY);
    };
    Services.obs.addObserver(observer, READY);
    Services.obs.addObserver(observer, CLOSED);
  });
}

/** Why Hyprland is not even tried, or null. */
function gate() {
  if (!forced) {
    if (Services.env.get("MOZ_HEADLESS")) return "headless";
    if (!(/** @type {any} */ (Services.appinfo).isWayland)) return "not on Wayland";
  }
  return HyprIpc.sockets ? null : "not on Hyprland";
}

/**
 * Finds Hyprland and its dialect, once per session; a timeout is tried again at the next
 * switch (decision 3).
 * @returns {Promise<boolean>}
 */
function detect() {
  if (wm.state === "ok") return Promise.resolve(true);
  if (wm.state === "pending") return wm.promise;
  if (wm.state === "none" && !wm.retry) return Promise.resolve(false);
  /** @param {string} reason @param {boolean} retry */
  const none = (reason, retry) => {
    wm = { state: "none", reason, retry };
    if (reason !== "not on Hyprland" && reason !== "not on Wayland" && reason !== "headless") {
      logOnce(`private workspace shown as a window: ${reason}`, "detect");
    }
    return false;
  };
  const promise = (async () => {
    const why = gate();
    if (why) return none(why, false);
    try {
      const version = await HyprIpc.request(QUERY_VERSION);
      const probe = await HyprIpc.request(PROBE_LUA);
      const found = detectDialect(version, probe);
      if ("error" in found) return none("Hyprland's socket gave no version", false);
      wm = { state: "ok", dialect: found.dialect, version: found.version };
      return true;
    } catch (e) {
      const timeout = /** @type {any} */ (e)?.message === "no reply";
      return none(
        timeout ? "Hyprland did not reply" : "Hyprland's socket is not reachable",
        timeout,
      );
    }
  })();
  wm = { state: "pending", promise };
  return promise;
}

/** Whether a switch tries the swap at all. */
function wanted() {
  return configured && placement === "swap" && !failed && !(wm.state === "none" && !wm.retry);
}

/**
 * Holds the event socket while swap placement applies. Hyprland's drop reaches us as a later
 * main-thread event, so a caller can find a listener that is already dead (#163): it is then
 * marked, and its close handler listens again once. One extra connection per call at most, so
 * a socket that keeps hanging up is not retried in a loop.
 */
function ensureEvents() {
  if (wm.state !== "ok" || placement !== "swap") return;
  if (events) {
    relisten = true;
    return;
  }
  relisten = false;
  try {
    /** @type {{ close: () => void }} */
    const mine = HyprIpc.listen(onLine, () => {
      // Our own close (placement "window", tests) has already let go of it.
      if (events !== mine) return;
      events = null;
      if (relisten) ensureEvents();
    });
    events = mine;
  } catch {
    events = null;
  }
}

/** Stops listening; its close handler then does nothing. */
function stopEvents() {
  const old = events;
  events = null;
  old?.close();
}

/** @param {string} line  never logged: it can hold any window's title (decision 8) */
function onLine(line) {
  const ev = parseEvent(line, new Set(nonces.keys()));
  if (!ev) return;
  switch (ev.type) {
    case "nonce": {
      const resolve = nonces.get(ev.nonce);
      nonces.delete(ev.nonce);
      resolve?.(ev.address);
      return;
    }
    case "close": {
      const known = byAddress.has(ev.address);
      byAddress.delete(ev.address);
      // Too late for the unload swap: the parked window still comes back (decision 7).
      if (known) step({ type: "closing", window: ev.address }, { cached: true });
      records.delete(ev.address);
      return;
    }
    case "move": {
      // Our own batches' moves can arrive after their reply, even after the next swap began.
      const own = ownMoves.get(ev.address) ?? 0;
      if (own > 0) {
        if (own === 1) ownMoves.delete(ev.address);
        else ownMoves.set(ev.address, own - 1);
        return;
      }
      if (running) return;
      step({ type: "moved", window: ev.address, workspace: ev.workspace });
      return;
    }
    default:
  }
}

/**
 * The window's Hyprland address, learnt once: it carries a random title until Hyprland's event
 * names it, then its own title again (decision 5).
 * @param {Window} win
 * @param {number} [by]  the switch that waits on it (0: none). Only a give-up that the latest
 *   switch waits on shortens later waits.
 * @returns {Promise<string | null>}
 */
function addressOf(win, by = 0) {
  const known = addresses.get(win);
  if (known) return Promise.resolve(known);
  const running_ = resolving.get(win);
  if (running_) {
    if (by) waiters.get(win)?.add(by);
    return running_;
  }
  /** @type {Set<number>} */
  const job = new Set(by ? [by] : []);
  /** Whether a switch still in force waits on this naming. */
  const waited = () => job.has(switches);
  const promise = (async () => {
    const at = naming;
    if (!(await startedUp(win)) || !(await detect()) || at !== naming) return null;
    ensureEvents();
    const nonce = nonceTitle(crypto.getRandomValues(new Uint8Array(16)));
    /** @type {Promise<string | null>} */
    const heard = new Promise((resolve) => nonces.set(nonce, resolve));
    /** @param {number} ms @returns {Promise<null>} */
    const after = (ms) => new Promise((resolve) => lazy.setTimeout(() => resolve(null), ms));
    // Held until Hyprland names the window: a page loading meanwhile would retitle it.
    const doc = win.document;
    doc.title = nonce;
    const deadline = Date.now() + NAME_MS;
    const keep = new /** @type {any} */ (win).MutationObserver(() => {
      // A reset began another naming of this window while this one still waits on a request:
      // two observers holding two nonces would retitle each other forever.
      if (at !== naming) {
        keep.disconnect();
        return;
      }
      if (doc.title !== nonce) doc.title = nonce;
    });
    keep.observe(doc.documentElement, { subtree: true, childList: true, characterData: true });
    let address = await Promise.race([heard, after(REPLY_MS)]);
    if (!address && at === naming) {
      // No event yet: j/clients may already show the title. The nonce stays pending meanwhile,
      // so an event that comes during the request still counts.
      try {
        address = findNonce(
          await HyprIpc.request(QUERY_CLIENTS),
          nonce,
          Services.appinfo.processID,
        );
      } catch {
        address = null;
      }
      // A busy machine names a starting window late: wait for the event up to NAME_MS, then
      // look in j/clients again, as socket2 does not replay an event sent before we listened.
      if (!address && at === naming && !(unnamed && waited())) {
        address = await Promise.race([heard, after(Math.max(0, deadline - Date.now()))]);
        if (!address && at === naming) {
          try {
            address = findNonce(
              await HyprIpc.request(QUERY_CLIENTS),
              nonce,
              Services.appinfo.processID,
            );
          } catch {
            address = null;
          }
        }
      }
      // An event that came while j/clients was being asked still counts.
      if (!address) address = await Promise.race([heard, Promise.resolve(null)]);
      if (!address && at === naming && !win.closed && waited()) unnamed = true;
    }
    nonces.delete(nonce);
    if (at !== naming) address = null;
    keep.disconnect();
    if (!win.closed) /** @type {any} */ (win).gBrowser?.updateTitlebar();
    if (address && !win.closed) {
      addresses.set(win, address);
      byAddress.set(address, new WeakRef(win));
      unnamed = false;
    }
    return address;
  })();
  const pending = resolving;
  const jobs = waiters;
  pending.set(win, promise);
  jobs.set(win, job);
  promise.finally(() => {
    pending.delete(win);
    jobs.delete(win);
  });
  return promise;
}

/** @returns {Promise<Client[] | null>} */
async function clients() {
  try {
    const list = parseClients(await HyprIpc.request(QUERY_CLIENTS));
    for (const c of list) if (byAddress.has(c.address)) records.set(c.address, c);
    return list;
  } catch {
    return null;
  }
}

/**
 * Sends `commands` as one batch, counting the moves it will cause as our own.
 * @param {Dialect} dialect
 * @param {Command[]} commands
 * @returns {Promise<boolean>} every command succeeded
 */
async function send(dialect, commands) {
  const batch = encodeBatch(dialect, commands);
  if (!batch) return false;
  for (const c of commands) {
    if (c.verb === "move") ownMoves.set(c.window, (ownMoves.get(c.window) ?? 0) + 1);
  }
  let reply = "";
  try {
    reply = await HyprIpc.request(batch.text);
  } catch {
    // no reply: a failure
  }
  settleUntil = Date.now() + SETTLE_MS;
  return repliesOk(reply, batch.count);
}

/** The pair is forgotten: swaps queued for it are dropped. */
function forget() {
  pair = null;
  epoch++;
}

/**
 * The swap could not be done: whatever is in special:vimma comes out (to the other window's
 * workspace, else the active one), the pair is forgotten, and the window to show is focused.
 * A window is never left parked. A refusal by Hyprland itself also turns
 * the swap off until the next config reload, and says so once (decision 7).
 * @param {Dialect} dialect
 * @param {string} show  the window to show
 * @param {string} place
 * @param {boolean} refused  Hyprland refused a batch (not: a slot Vimma cannot swap into)
 */
async function rescue(dialect, show, place, refused) {
  forget();
  ownMoves.clear();
  if (refused) failed = true;
  const list = await clients();
  const x = list?.find((c) => c.address === show) ?? records.get(show);
  const y = list?.find((c) => c.address === place) ?? records.get(place);
  let active = null;
  if ([x, y].some((c) => c?.workspace.name === PARK)) {
    try {
      active = parseActiveWorkspace(await HyprIpc.request(QUERY_ACTIVE_WORKSPACE));
    } catch {
      active = null;
    }
  }
  const commands = planRescue(x, y, active);
  if (commands.length) await send(dialect, commands);
  if (!refused) return;
  logOnce(SWAP_REFUSED);
  const win = byAddress.get(show)?.deref();
  if (win && !win.closed) lazy.VimmaHost.say(win, SWAP_REFUSED);
}

/**
 * Shows `op.show` in `op.place`'s slot.
 * @param {ShowOp} op
 * @param {{ cached?: boolean }} options  cached: the slot window is closing; its last record
 * @returns {Promise<boolean>}
 */
async function showInPlace(op, { cached = false }) {
  if (wm.state !== "ok") return false;
  const { dialect } = wm;
  const list = cached ? null : await clients();
  const x = list?.find((c) => c.address === op.show) ?? (cached ? records.get(op.show) : null);
  const y = list?.find((c) => c.address === op.place) ?? (cached ? records.get(op.place) : null);
  if (!x || !y) {
    await rescue(dialect, op.show, op.place, false);
    return false;
  }
  const plan = planShow(dialect, x, y);
  if (plan.kind === "refuse") {
    await rescue(dialect, op.show, op.place, false);
    return false;
  }
  if (!(await send(dialect, plan.commands))) {
    // The slot window closing can make Hyprland's swap fail: not a refusal.
    await rescue(dialect, op.show, op.place, !cached);
    return false;
  }
  // A grouped or pinned slot: shown beside, nothing parked.
  if (!plan.parks) {
    pair = null;
    return true;
  }
  // What Hyprland now has, for a slot window that closes before the next read (unload).
  const { workspace, at, size, floating, fullscreen, fullscreenClient } = y;
  records.set(x.address, { ...x, workspace, at, size, floating, fullscreen, fullscreenClient });
  records.set(y.address, { ...y, workspace: { id: 0, name: PARK }, fullscreen: 0 });
  return true;
}

/**
 * Advances the pair and runs its swaps, in order.
 * @param {PairEvent} event
 * @param {{ cached?: boolean }} [options]
 * @returns {Promise<boolean>} whether every swap was done
 */
function step(event, options = {}) {
  if (/** @type {any} */ (Services).startup.shuttingDown) return Promise.resolve(false);
  const { state, ops } = pairStep(pair, event);
  if (pair && !state && (event.type === "moved" || event.type === "failed")) forget();
  else pair = state;
  ensureEvents();
  if (!ops.length) return Promise.resolve(true);
  const at = epoch;
  running++;
  chain = chain.then(async () => {
    try {
      for (const op of ops) {
        // The pair was forgotten meanwhile: parking now would strand a window.
        if (at !== epoch) return false;
        if (!(await showInPlace(op, options))) return false;
      }
      return true;
    } catch (e) {
      console.error("vimma: private swap failed", e);
      return false;
    } finally {
      running--;
    }
  });
  return chain;
}

/** @param {Window} win */
function onActivated(win) {
  const a = addresses.get(win);
  if (!a || running || Date.now() < settleUntil || parkedWindow(pair) !== a) return;
  step({ type: "activated", window: a });
}

/**
 * A new tab in the parked normal window (a link from another app, decided question 2) brings
 * it back. Never the parked private window's: that would show private content in the slot.
 * @param {Window} win
 */
function onTabOpen(win) {
  const a = addresses.get(win);
  if (!a || pair?.parked !== "normal" || pair.normal !== a) return;
  step({ type: "activated", window: a });
}

/** @param {Window} win */
function onUnload(win) {
  windows.delete(win);
  const a = addresses.get(win);
  if (!a) return;
  step({ type: "closing", window: a }, { cached: true });
}

/** @param {Window} win */
function track(win) {
  if (!configured || placement !== "swap" || failed || win.closed) return;
  addressOf(win).then((a) => {
    if (a) clients();
  });
}

const HyprSwap = {
  /**
   * Once per browser window (vimma.js): its address is learnt while swap placement applies,
   * and its close, activation and new tabs are watched (decision 7).
   * @param {Window} win
   */
  init(win) {
    if (windows.has(win)) return;
    windows.add(win);
    win.addEventListener("unload", () => onUnload(win), { once: true });
    win.addEventListener("activate", () => onActivated(win));
    // TabOpen bubbles from the tab; gBrowser does not exist yet when vimma.js runs.
    win.addEventListener("TabOpen", () => onTabOpen(win));
    track(win);
  },

  /**
   * `[private] placement` from config.toml, live. A reload also lifts a failure's fallback.
   * @param {PrivatePlacement} next
   */
  configure(next) {
    placement = next;
    configured = true;
    failed = false;
    unnamed = false;
    skipped = null;
    if (next === "window") {
      stopEvents();
      return;
    }
    ensureEvents();
    for (const win of windows) track(win);
  },

  /**
   * Going to private (private-ops enterPrivate): shows `priv` in `from`'s slot. False when the
   * swap does not apply, and the caller focuses `priv` as before.
   * @param {Window} from  a normal window
   * @param {Window} priv  the most recent private window
   * @param {boolean} fresh  just opened by this switch
   * @returns {boolean}
   */
  enter(from, priv, fresh) {
    if (!wanted()) return false;
    const mine = ++switches;
    if (fresh) unswapped.add(priv);
    (async () => {
      const [normal, p] = await Promise.all([addressOf(from, mine), addressOf(priv, mine)]);
      // The user switched again meanwhile (back to normal): this swap would park it under them.
      // A fresh window stays in `unswapped` for the next switch, as it does after a give-up.
      if (mine !== switches) return;
      if (!normal || !p) {
        // Hyprland is there but did not name a window: never silent (decision 7).
        if (wm.state === "ok" && !from.closed && !priv.closed) {
          skipped = "window not named";
          logOnce(NOT_NAMED);
        }
        if (!priv.closed) priv.focus();
        return;
      }
      skipped = null;
      const opened = unswapped.delete(priv);
      // A private window shown somewhere else (a second one from ctrl+n): focus it, as today.
      if (!opened && p !== pair?.private) {
        if (!priv.closed) priv.focus();
        return;
      }
      if (!(await step({ type: "enter", normal, private: p })) && !priv.closed) priv.focus();
    })().catch((e) => console.error("vimma: private swap failed", e));
    return true;
  },

  /**
   * Going back to normal window `win` (private-ops showNormal): the parked window comes back in
   * the private one's slot, then `win` is focused if it is another one. False when nothing is
   * parked, and the caller focuses `win` as before.
   * @param {Window} win
   * @returns {boolean}
   */
  show(win) {
    switches++;
    if (pair?.parked !== "normal") return false;
    const back = pair.normal;
    step({ type: "leave" }).then((ok) => {
      if ((!ok || addresses.get(win) !== back) && !win.closed) win.focus();
    });
    return true;
  },

  /**
   * Before the private workspace closes (ctrl+b shift+d): the parked normal window is shown in
   * its slot first, and the close waits for Hyprland's reply (decision 7).
   * @returns {Promise<void>}
   */
  async beforeClose() {
    if (pair?.parked !== "normal") return;
    await step({ type: "closing", window: pair.private });
  },

  /** about:vimma's line (decision 10): no addresses, no titles. */
  get status() {
    const how = placement === "window" ? "window (config)" : failed ? "window (swap failed)" : "";
    switch (wm.state) {
      case "ok": {
        const last = !how && skipped ? ` (last switch: ${skipped})` : "";
        return `Hyprland ${wm.version} (${wm.dialect}), private placement: ${how || "swap"}${last}`;
      }
      case "none":
        return `none (${wm.reason}), private placement: window`;
      default:
        return `not checked yet, private placement: ${how || placement}`;
    }
  },

  /** Tests: whether namings wait only REPLY_MS. */
  get _unnamed() {
    return unnamed;
  },

  /** Tests: the pair, as addresses. */
  get _pair() {
    return pair;
  },

  /**
   * Tests only: forget Hyprland, the pair and every address, and talk to `sockets` (a fake)
   * from now on; undefined: back to the environment.
   * @param {{ request: string, events: string } | null | undefined} sockets
   */
  _resetForTests(sockets, { configured: read = true } = {}) {
    stopEvents();
    HyprIpc._setSocketsForTests(sockets);
    forced = sockets !== undefined;
    wm = { state: "unknown" };
    pair = null;
    failed = false;
    unnamed = false;
    logged.clear();
    skipped = null;
    placement = "swap";
    configured = read;
    settleUntil = 0;
    ownMoves.clear();
    epoch++;
    // A naming in flight ends now (null), drops its nonce title and is not reused: left
    // waiting, it would hold the title and stand in for every later naming of that window.
    naming++;
    for (const resolve of nonces.values()) resolve(null);
    nonces.clear();
    resolving = new WeakMap();
    waiters = new WeakMap();
    unswapped = new WeakSet();
    byAddress.clear();
    records.clear();
    for (const win of windows) addresses.delete(win);
    chain = Promise.resolve(true);
    running = 0;
  },

  /** Tests: settles once the swaps queued so far are done. */
  _settled() {
    return chain;
  },
};

/**
 * The backend switch (docs/specs/private-swap-macos.md, decision 3): the native swap on macOS
 * (native-swap.mjs), Hyprland's everywhere else. Both watch every window and read the config,
 * so a switch goes to whichever applies. Only HyprSwap's test hooks (`_` names) may be
 * inherited: every public member (init, configure, enter, show, beforeClose, status) is routed
 * here, and a new one must be too, or it would reach macOS through the prototype.
 * browser_vimma_private_swap_native.js fails on a public member that is not routed.
 * @type {typeof HyprSwap & { openFeatures(from: Window): string | null }}
 */
export const PrivateSwap = Object.create(HyprSwap, {
  init: {
    value(/** @type {Window} */ win) {
      NativeSwap.init(win);
      HyprSwap.init(win);
    },
  },
  configure: {
    value(/** @type {PrivatePlacement} */ next) {
      NativeSwap.configure(next);
      HyprSwap.configure(next);
    },
  },
  // Where a new private window opens to take a window's place; null: as before.
  openFeatures: {
    value: (/** @type {Window} */ from) =>
      NativeSwap.selected ? NativeSwap.openFeatures(from) : null,
  },
  enter: {
    value: (/** @type {Window} */ from, /** @type {Window} */ priv, /** @type {boolean} */ fresh) =>
      (NativeSwap.selected ? NativeSwap : HyprSwap).enter(from, priv, fresh),
  },
  show: {
    value: (/** @type {Window} */ win) => (NativeSwap.selected ? NativeSwap : HyprSwap).show(win),
  },
  beforeClose: {
    value: () => (NativeSwap.selected ? NativeSwap : HyprSwap).beforeClose(),
  },
  status: {
    get: () => (NativeSwap.selected ? NativeSwap : HyprSwap).status,
  },
});
