/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The private workspace in place of the Vimma window on macOS (docs/specs/private-swap-macos.md),
// without a window manager: the browser process owns both windows, so it hides the normal one
// with Firefox's own window visibility call and shows the private one at its exact frame. Core
// plans each swap (nativeswap.mjs) and keeps the pair (privatepair.mjs); this module reads and
// applies frames and watches each window's close, activation and new tabs. Nothing is written to
// disk. private-swap.mjs selects it on macOS; everywhere else it does nothing.

import { frameApplied, openFrame, planNativeShow } from "../core/nativeswap.mjs";
import { pairStep, parkedWindow } from "../core/privatepair.mjs";
import { startedUp } from "./private-swap.mjs";

/** @import { Frame, NativePlan, Rect } from "../core/nativeswap.mjs" */
/** @import { Pair, PairEvent, ShowOp } from "../core/privatepair.mjs" */
/** @import { PrivatePlacement } from "../core/config.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  VimmaHost: "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
});

/** What a failed swap says, once (decision 9). */
export const SWAP_FAILED = "private: the swap failed; showing it as a window";

/** @type {PrivatePlacement} */
let placement = "swap";
/** config.toml was read: until then no window is hidden, whatever it says. */
let configured = false;
/** A swap failed: "window" placement until the next config reload (decision 9). */
let failed = false;
/** Tests: the backend selected off macOS, or headless. */
let forced = false;
/** Tests: each visibility write, since the getter always returns true (Research). */
/** @type {{ win: Window, visible: boolean }[] | null} */
let spy = null;
/** @type {Set<string>} each console line once a session */
const logged = new Set();

/** Each window's identifier: opaque to core, a counter here (decision 3). */
/** @type {WeakMap<Window, string>} */
const ids = new WeakMap();
/** @type {Map<string, WeakRef<Window>>} */
const byId = new Map();
let counter = 0;
/** The windows Vimma hid: Firefox cannot read a window's visibility back (Research). */
/** @type {WeakSet<Window>} */
const hidden = new WeakSet();
/** The slot's last frame, for a slot window that can no longer report it (closing). */
/** @type {Frame | null} */
let slot = null;
/** @type {Set<Window>} every browser window seen */
const windows = new Set();
/** @type {Pair} */
let pair = null;
/** A swap is running: activations and new tabs meanwhile are its own. */
let running = 0;
/** Bumped by every switch: an enter still waiting for a new window when another began drops. */
let switches = 0;
/** Bumped by every swap: only the latest one's frame check may update the slot. */
let swaps = 0;
/** Whether Vimma is quitting: SessionStore hides every window then, and no swap may run. */
let quitting = () => /** @type {any} */ (Services).startup.shuttingDown;

/**
 * A browser window, not a pop-up: pop-ups never swap or hide (private-swap decision 6).
 * @param {Window} win
 */
export const isBrowserWindow = (win) =>
  !win.closed && /** @type {any} */ (win).toolbar?.visible !== false;

/** @param {string} text */
function logOnce(text) {
  if (logged.has(text)) return;
  logged.add(text);
  console.warn(`vimma: ${text}`);
}

/** Whether this backend applies at all: macOS with a real window system, or a test. */
function selected() {
  if (forced) return true;
  return Services.appinfo.OS === "Darwin" && !Services.env.get("MOZ_HEADLESS");
}

/** Whether a switch tries the swap. */
function wanted() {
  return selected() && configured && placement === "swap" && !failed;
}

/** @param {Window} win */
function idOf(win) {
  let id = ids.get(win);
  if (!id) {
    id = `${++counter}`;
    ids.set(win, id);
    byId.set(id, new WeakRef(win));
  }
  return id;
}

/** @param {string} id @returns {Window | null} */
function windowOf(id) {
  const win = byId.get(id)?.deref();
  return win && !win.closed ? win : null;
}

/**
 * Shows or hides `win`'s native window, as Firefox's SessionStore and Tabbrowser do
 * (nsIBaseWindow.visibility, Research).
 * @param {Window} win
 * @param {boolean} visible
 */
function setVisible(win, visible) {
  const base = /** @type {any} */ (win).docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow);
  base.visibility = visible;
  if (visible) hidden.delete(win);
  else hidden.add(win);
  spy?.push({ win, visible });
}

/** @param {Window} win @param {boolean} on */
function suppress(win, on) {
  try {
    /** @type {any} */ (win).windowUtils.suppressAnimation(on);
  } catch {
    // A window that is going away: nothing to animate.
  }
}

const SIZEMODES = /** @type {const} */ ({
  1: "maximized",
  2: "minimized",
  3: "normal",
  4: "fullscreen",
});

/**
 * `win`'s frame for core: position in desktop pixels, size in CSS pixels (decision 2), and a
 * zoomed window's restored frame from the attributes AppWindow persists on its root element.
 * Those hold the inner size, so the window's outer-to-inner difference is added back.
 * @param {Window} win
 * @returns {Frame}
 */
function frameOf(win) {
  const w = /** @type {any} */ (win);
  const sizemode = w.fullScreen
    ? "fullscreen"
    : (SIZEMODES[/** @type {1 | 2 | 3 | 4} */ (w.windowState)] ?? "normal");
  /** @type {Rect | null} */
  let restored = null;
  if (sizemode === "maximized") {
    const root = w.document.documentElement;
    /** @param {string} name */
    const attr = (name) => Number.parseInt(root.getAttribute(name) ?? "", 10);
    restored = {
      x: attr("screenX"),
      y: attr("screenY"),
      width: attr("width") + (w.outerWidth - w.innerWidth),
      height: attr("height") + (w.outerHeight - w.innerHeight),
    };
  }
  return {
    x: w.screenX,
    y: w.screenY,
    width: w.outerWidth,
    height: w.outerHeight,
    sizemode,
    restored,
  };
}

/** The pair is forgotten. */
function forget() {
  pair = null;
  slot = null;
}

/** Every window Vimma hid is shown again where it is, and the pair is forgotten. */
function revealAll() {
  // First: a window shown is raised, and its activate event (synchronous, headless) must not
  // find a pair to swap back.
  forget();
  for (const ref of byId.values()) {
    const win = ref.deref();
    if (win && !win.closed && hidden.has(win)) setVisible(win, true);
  }
}

/**
 * The swap could not be done (decision 9): every hidden window of the pair is shown at the
 * slot's frame, the pair is forgotten, the swap is off until the next config reload, and it
 * says so once.
 * @param {ShowOp} op
 * @param {unknown} error
 */
function fail(op, error) {
  console.error("vimma: private swap failed", error);
  const ids_ = pair ? [pair.normal, pair.private] : [];
  const frame = slot;
  forget();
  failed = true;
  for (const id of new Set([...ids_, op.show, op.place])) {
    const win = windowOf(id);
    if (!win || !hidden.has(win)) continue;
    try {
      if (frame && frame.sizemode === "normal") {
        win.moveTo(frame.x, frame.y);
        win.resizeTo(frame.width, frame.height);
      }
    } catch {
      // Shown where it was: still on screen.
    }
    try {
      setVisible(win, true);
    } catch (e) {
      console.error("vimma: could not show a hidden window", e);
    }
  }
  logOnce(SWAP_FAILED);
  const shown = windowOf(op.show) ?? windowOf(op.place);
  if (shown) lazy.VimmaHost.say(shown, SWAP_FAILED);
}

/**
 * Shows `op.show` in `op.place`'s slot, in one synchronous step (Design: the mechanism).
 * @param {ShowOp} op
 * @returns {boolean} whether the swap was done
 */
function showInPlace(op) {
  const x = windowOf(op.show);
  const y = byId.get(op.place)?.deref() ?? null;
  if (!x) {
    // The window to show is gone: whatever is hidden comes back, the pair forgotten first so
    // that its activation finds nothing to swap.
    forget();
    if (y && !y.closed && hidden.has(y)) setVisible(y, true);
    return false;
  }
  // A slot window that is closing reports no frame: its last known one stands in.
  const live = y && !y.closed ? frameOf(y) : null;
  const place = live && live.width > 0 ? live : slot;
  const plan = place ? planNativeShow(frameOf(x), place) : null;
  if (!plan || plan.kind === "refuse") {
    // A minimized or unreadable slot: shown as a window of its own, nothing hidden.
    if (hidden.has(x)) setVisible(x, true);
    forget();
    x.focus();
    return false;
  }
  if (plan.kind === "fullscreen") {
    // Never hide a window in a native fullscreen Space (decision 7): a private window gets one
    // of its own; macOS switches Spaces.
    if (hidden.has(x)) setVisible(x, true);
    const intoPrivate = pair?.private === op.show;
    forget();
    if (intoPrivate && !(/** @type {any} */ (x).fullScreen)) {
      /** @type {any} */ (x).fullScreen = true;
    }
    x.focus();
    return false;
  }
  const mine = ++swaps;
  running++;
  const others = [x, ...(y && !y.closed ? [y] : [])];
  try {
    for (const w of others) suppress(w, true);
    if (plan.restoreFirst) /** @type {any} */ (x).restore();
    x.moveTo(plan.frame.x, plan.frame.y);
    x.resizeTo(plan.frame.width, plan.frame.height);
    if (plan.zoom) /** @type {any} */ (x).maximize();
    // X first, at Y's frame, so nothing behind them shows through.
    setVisible(x, true);
    if (y && !y.closed) setVisible(y, false);
  } finally {
    for (const w of others) suppress(w, false);
    running--;
  }
  slot = /** @type {Frame} */ (place);
  // Not the active app (a link, vimma-ctl from a terminal): focus() brings Vimma forward
  // (decision 5). Shown, the window is already key otherwise.
  if (/** @type {any} */ (Services.focus).activeWindow !== x) x.focus();
  checkFrame(op, plan, mine);
  return true;
}

/**
 * Decision 9: the shown window must report the frame it was given within one event loop turn.
 * @param {ShowOp} op
 * @param {Extract<NativePlan, { kind: "swap" }>} plan
 * @param {number} mine  the swap's number: a later swap's slot is never overwritten
 */
function checkFrame(op, plan, mine) {
  const at = pair;
  Services.tm.dispatchToMainThread(() => {
    const x = windowOf(op.show);
    // The pair moved on meanwhile: a later swap checks its own frame.
    if (!x || pair !== at || parkedWindow(pair) === op.show) return;
    if (!frameApplied(plan, frameOf(x))) fail(op, new Error("the frame was not applied"));
    else if (mine === swaps) slot = frameOf(x);
  });
}

/**
 * Advances the pair and runs its swaps, in order, synchronously.
 * @param {PairEvent} event
 * @returns {boolean} whether every swap was done
 */
function step(event) {
  if (quitting()) return false;
  const { state, ops } = pairStep(pair, event);
  pair = state;
  for (const op of ops) {
    try {
      if (!showInPlace(op)) return false;
    } catch (e) {
      fail(op, e);
      return false;
    }
  }
  return true;
}

/** @param {Window} win */
function onActivated(win) {
  // The Window menu, the Dock menu or cmd+` brought the hidden window forward (decision 6).
  if (running || !hidden.has(win) || parkedWindow(pair) !== ids.get(win)) return;
  step({ type: "activated", window: idOf(win) });
}

/**
 * A new tab in the hidden normal window (a link from another app) brings it back, before
 * Firefox's own focus() (Research). Never the hidden private window's.
 * @param {Window} win
 */
function onTabOpen(win) {
  if (running || pair?.parked !== "normal" || pair.normal !== ids.get(win)) return;
  step({ type: "activated", window: pair.normal });
}

/**
 * A window closes, by any path: its docshell unloads before its native window is destroyed
 * (AppWindow::Destroy), so the hidden window is shown in its place first (decision 6). Off GTK
 * Destroy orders the closing window out before that, so the desktop may show for a frame.
 * @param {Window} win
 */
function onUnload(win) {
  windows.delete(win);
  const id = ids.get(win);
  if (!id) return;
  if (pair && (pair.normal === id || pair.private === id)) {
    // Its frame now, if it still has one, else the last one known.
    try {
      const f = frameOf(win);
      if (f.width > 0 && f.height > 0 && f.sizemode !== "minimized") slot = f;
    } catch {
      // Keep the last known slot.
    }
    step({ type: "closing", window: id });
  }
  byId.delete(id);
}

export const NativeSwap = {
  /** Whether private-swap.mjs uses this backend: on macOS, outside headless runs and tests. */
  get selected() {
    return selected();
  },

  /**
   * Once per browser window: its close, activation and new tabs are watched.
   * @param {Window} win
   */
  init(win) {
    if (windows.has(win)) return;
    windows.add(win);
    win.addEventListener("unload", () => onUnload(win), { once: true });
    win.addEventListener("activate", () => onActivated(win));
    // TabOpen bubbles from the tab; gBrowser does not exist yet when vimma.js runs.
    win.addEventListener("TabOpen", () => onTabOpen(win));
  },

  /**
   * `[private] placement` from config.toml, live. A reload also lifts a failure's fallback.
   * @param {PrivatePlacement} next
   */
  configure(next) {
    placement = next;
    configured = true;
    failed = false;
    // Never stranded: with "window" placement nothing may stay hidden, or a hidden private
    // window could not be reached (focus() does not show a hidden window on macOS).
    if (next === "window") {
      // Shown, a window is raised and made key. The private window must not come to the front
      // by itself (a screen being shared), so the window in front stays there: in the slot it
      // covers the private window, which is one key away. Minimizing the private window
      // instead was rejected, because it animates into the Dock and what AppKit does with a
      // hidden window that is minimized is unverified.
      const front = /** @type {any} */ (Services.focus).activeWindow;
      const shown = [...byId.values()].some((r) => {
        const w = r.deref();
        return w && !w.closed && hidden.has(w);
      });
      revealAll();
      if (shown && front && !front.closed && !hidden.has(front)) front.focus();
    }
  },

  /**
   * The features a new private window opens with to take `from`'s place: its frame (the
   * restored one when zoomed) and no animation. Null when the swap does not apply.
   * @param {Window} from
   * @returns {string | null}
   */
  openFeatures(from) {
    if (!wanted() || !isBrowserWindow(from)) return null;
    const f = openFrame(frameOf(from));
    if (!f) return null;
    return [
      `screenX=${f.x}`,
      `screenY=${f.y}`,
      `outerWidth=${f.width}`,
      `outerHeight=${f.height}`,
      "suppressanimation",
    ].join(",");
  },

  /**
   * Going to private: shows `priv` in `from`'s place. False when the swap does not apply, and
   * the caller focuses `priv` as before.
   * @param {Window} from  a normal window
   * @param {Window} priv  the most recent private window
   * @param {boolean} fresh  just opened by this switch
   * @returns {boolean}
   */
  enter(from, priv, fresh) {
    if (!wanted() || !isBrowserWindow(from)) {
      // Declined: the caller focuses priv, which must then be on screen.
      if (!priv.closed && hidden.has(priv)) revealAll();
      return false;
    }
    const mine = ++switches;
    const go = () => {
      // Another switch began meanwhile: this one would hide a window under the user.
      if (mine !== switches || !wanted() || from.closed || priv.closed) return;
      const p = idOf(priv);
      // A private window shown somewhere else (a second one from ctrl+n): focused, as today.
      if (!fresh && p !== pair?.private) {
        priv.focus();
        return;
      }
      if (!step({ type: "enter", normal: idOf(from), private: p }) && !priv.closed) priv.focus();
    };
    if (!fresh) {
      go();
      return true;
    }
    // A new window is shown after its first paint: hiding the normal one before would show
    // the desktop for a moment.
    startedUp(priv).then((ok) => {
      if (ok) go();
    });
    return true;
  },

  /**
   * Going back to normal window `win`: the hidden window comes back in the private one's place,
   * then `win` is focused if it is another one. False when nothing is hidden.
   * @param {Window} win
   * @returns {boolean}
   */
  show(win) {
    switches++;
    if (pair?.parked !== "normal") return false;
    const back = pair.normal;
    const ok = step({ type: "leave" });
    if ((!ok || ids.get(win) !== back) && !win.closed) win.focus();
    return true;
  },

  /**
   * Before the private workspace closes (ctrl+b shift+d): the hidden normal window is shown in
   * its place first.
   * @returns {Promise<void>}
   */
  async beforeClose() {
    if (pair?.parked !== "normal") return;
    step({ type: "closing", window: pair.private });
  },

  /** about:vimma's line (decision 11): no frame, title or window identifier. */
  get status() {
    const how = !configured
      ? "window (config not read yet)"
      : placement === "window"
        ? "window (config)"
        : failed
          ? "window (swap failed)"
          : "swap";
    return `none needed (macOS), private placement: ${how}`;
  },

  /** Tests: the pair, as identifiers. */
  get _pair() {
    return pair;
  },

  /** Tests: `win`'s identifier, and whether Vimma hid it. */
  _windowForTests(/** @type {Window} */ win) {
    return { id: ids.get(win) ?? null, hidden: hidden.has(win) };
  },

  /**
   * Tests only: forget the pair and every hidden window (showing them), select this backend
   * (`force`) or not, and record visibility writes in `log`.
   * @param {{ force?: boolean, log?: { win: Window, visible: boolean }[] | null,
   *   configured?: boolean, shuttingDown?: () => boolean }} [options]
   */
  _resetForTests({ force = false, log = null, configured: read = true, shuttingDown } = {}) {
    quitting = shuttingDown ?? (() => /** @type {any} */ (Services).startup.shuttingDown);
    revealAll();
    forced = force;
    spy = log;
    failed = false;
    placement = "swap";
    configured = read;
    logged.clear();
    running = 0;
    switches++;
  },
};
