/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Tabs nobody has looked at for `[tabs] sleep_after` minutes go to sleep through Firefox's own
// discard (docs/specs/tab-sleep.md). One check every few minutes walks every tab; core's
// planSleep decides, this module gathers the facts and calls Firefox. It also runs Firefox's
// own low-memory unloader from `[tabs] sleep_on_low_memory` and keeps it off the tabs the check
// protects that it does not know about (decision 21).

import { SLEEP_CHECK_MS, planSleep } from "../core/tabsleep.mjs";

/** @import { SleepTab } from "../core/tabsleep.mjs" */

/** @typedef {"PrivateBrowsingUtils" | "webrtcUI" | "setInterval" | "clearInterval"} LazyName */
const lazy = /** @type {Lazy<LazyName>} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  webrtcUI: "resource:///modules/webrtcUI.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
});

/** How often the check runs, in ms; tests shorten it (decision 20). */
export const CHECK_PREF = "vimma.tabs.sleepCheckMs";
/** Firefox's low-memory unloader, read at each low-memory signal (TabUnloader.sys.mjs). */
export const UNLOAD_PREF = "browser.tabs.unloadOnLowMemory";

/** @typedef {MozTabbrowserTab} Tab */

/**
 * What TabSleep reads of higher layers, which services/ does not import (ADR-026): vimma.js
 * hands over their module singletons once.
 * @typedef {object} TabSleepDeps
 * @property {{ readonly config: { tabs: { sleepAfter: number, sleepOnLowMemory: boolean },
 *   sites: readonly { match: string, sleep: boolean }[] } | null }} configHost  the config in
 *   force (null before the first read)
 * @property {string} configTopic  notified after each config read
 * @property {{ readonly agentConnected: boolean,
 *   watchAgentConnected(fn: () => void): () => void }} mcp  whether an agent connection is open,
 *   and a call when that changes
 * @property {{ readonly agent: { userContextId?: number | null } | null }} workspaces  the
 *   agent workspace, by its container
 * @property {{ get(win: BrowserWindow): { readonly shownTabs: Tab[] } | undefined,
 *   watch(win: BrowserWindow, fn: () => void): () => void }} panes  the panes of the split each
 *   window shows, and a call after each change of them
 */

/** @param {TabSleepDeps} d @param {Tab} tab  in the agent workspace's container */
function isAgentTab(d, tab) {
  const id = d.workspaces.agent?.userContextId;
  // 0 is the default container, never the agent workspace's (AgentConsole checks the same).
  return typeof id === "number" && id > 0 && tab.userContextId === id;
}

/** @param {TabSleepDeps} d @param {BrowserWindow} win */
const shownTabs = (d, win) => d.panes.get(win)?.shownTabs ?? [];

/** @type {TabSleepDeps | null} */
let deps = null;
/** @type {number | null} */
let timer = null;
let checks = 0;
/**
 * When a check last found each tab on screen (decision 4): a pane watched without focus keeps
 * its `lastAccessed` from when focus left it. In memory only.
 * @type {WeakMap<Tab, number>}
 */
const seenOnScreen = new WeakMap();

/**
 * The browsers' permanent keys of the tabs this module marked `undiscardable`, so that it never
 * clears a mark an add-on set (`autoDiscardable: false`, ext-tabs.js). The key, not the tab:
 * Firefox moves both the key and the attribute to the new tab when a tab changes window
 * (Tabbrowser.sys.mjs, swapBrowsersAndCloseOther), and keeps the key through a discard.
 * @type {WeakSet<object>}
 */
const marked = new WeakSet();

/** Whether `[tabs] sleep_on_low_memory` asks for Firefox's low-memory unloader (decision 21). */
function configUnloads() {
  return !!deps && (deps.configHost.config?.tabs.sleepOnLowMemory ?? true);
}

/**
 * Whether the unloader runs, whoever turned it on: a value set in about:config beats the
 * config's default-branch one, and the marks must follow the unloader that runs.
 */
function lowMemoryOn() {
  return !!deps && Services.prefs.getBoolPref(UNLOAD_PREF, false);
}

/**
 * Sets Firefox's unloader pref from `[tabs] sleep_on_low_memory`, on the default branch: nothing
 * is written to prefs.js, and a value set in about:config still wins.
 */
function applyUnloadPref() {
  const value = configUnloads();
  const defaults = Services.prefs.getDefaultBranch("");
  if (defaults.getBoolPref(UNLOAD_PREF, false) !== value) defaults.setBoolPref(UNLOAD_PREF, value);
}

/**
 * Sets or clears this module's `undiscardable` mark on `tab`; a mark it did not set stays.
 * @param {Tab} tab
 * @param {boolean} want
 */
function mark(tab, want) {
  const key = tab.permanentKey;
  if (!key) return;
  if (want && !tab.undiscardable) {
    tab.undiscardable = true;
    marked.add(key);
  } else if (!want && marked.has(key)) {
    marked.delete(key);
    tab.undiscardable = false;
  }
}

/**
 * Keeps `undiscardable`, which Firefox's unloader honours (TabUnloader.sys.mjs,
 * isNonDiscardable), on the tabs of `win` that the unloader would otherwise take: every pane of
 * the split on screen, which PaneView would reload at once, and the agent workspace's tabs
 * while an agent is connected, whose ids the agent holds (decisions 5, 8 and 21). The selected
 * tab needs no mark; the unloader skips it.
 * @param {BrowserWindow} win
 */
function markWindow(win) {
  const d = deps;
  if (!d || win.closed || !win.gBrowser) return;
  const on = lowMemoryOn();
  const shown = new Set(on ? shownTabs(d, win) : []);
  const agents = on && d.mcp.agentConnected;
  for (const tab of /** @type {Tab[]} */ (win.gBrowser.tabs)) {
    mark(tab, shown.has(tab) || (agents && isAgentTab(d, tab)));
  }
}

function markAll() {
  for (const win of Services.wm.getEnumerator("navigator:browser")) markWindow(win);
}

/** The config changed: the check's interval, the pref and the marks. */
function refresh() {
  update();
  applyUnloadPref();
  markAll();
}

/**
 * Whether the tab has no loaded page: Firefox's lazy tab, with no browser or one still to
 * restore, whoever left it so (a restart, this module or Firefox's unloader; decision 16).
 * Reads attributes only, so it never inserts the browser.
 * @param {Tab} tab
 */
export const tabAsleep = (tab) => !tab.linkedPanel || tab.hasAttribute("pending");

/** The limit in force, in ms; 0 when the check is off or nothing is known yet. */
function sleepAfterMs() {
  if (!deps) return 0;
  const minutes = deps.configHost.config?.tabs.sleepAfter ?? 0;
  return minutes * 60_000;
}

/** Starts or stops the interval to match `sleep_after` (decision 13). */
function update() {
  const want = sleepAfterMs() > 0;
  if (!want && timer !== null) {
    lazy.clearInterval(timer);
    timer = null;
  } else if (want && timer === null) {
    // At least 100 ms, so that a mistyped value never runs the walk back to back.
    const ms = Math.max(100, Services.prefs.getIntPref(CHECK_PREF, SLEEP_CHECK_MS));
    timer = lazy.setInterval(() => {
      TabSleep._check().catch((/** @type {unknown} */ e) => console.error("vimma: tab sleep", e));
    }, ms);
  }
}

function restart() {
  if (timer !== null) lazy.clearInterval(timer);
  timer = null;
  update();
}

/**
 * Whether the tab holds a camera, microphone or screen stream, or a WebRTC connection, as
 * Firefox's unloader asks (TabUnloader.sys.mjs, usingWebRTC).
 * @param {Tab} tab
 */
function sharing(tab) {
  const browser = tab.linkedBrowser;
  if (!browser) return false;
  return (
    lazy.webrtcUI.browserHasStreams(browser) ||
    !!browser.browsingContext?.currentWindowGlobal?.hasActivePeerConnections()
  );
}

/**
 * Discards `tab` as Firefox's unloader does: its session state flushed first, so the restore has
 * the latest scroll and form data, then unforced, so a page that would ask before leaving, or
 * has a dialog open, stays (decisions 1 and 10). Checked again after the flush, which yields:
 * the user may have selected the tab or shown its split meanwhile, or an agent connected and
 * been given the tab's id (decision 8).
 * @param {BrowserWindow} win
 * @param {Tab} tab
 * @param {TabSleepDeps} d
 */
async function discard(win, tab, d) {
  await win.gBrowser.prepareDiscardBrowser(tab);
  if (win.closed || tab.closing || tab.selected || shownTabs(d, win).includes(tab)) return false;
  if (d.mcp.agentConnected && isAgentTab(d, tab)) return false;
  return win.gBrowser.discardBrowser(tab, false);
}

export const TabSleep = {
  /**
   * Once per process (vimma.js); later calls change nothing.
   * @param {TabSleepDeps} d
   */
  init(d) {
    if (deps) return;
    deps = d;
    Services.prefs.addObserver(CHECK_PREF, restart);
    Services.prefs.addObserver(UNLOAD_PREF, markAll);
    Services.obs.addObserver(refresh, d.configTopic);
    d.mcp.watchAgentConnected(markAll);
    refresh();
  },

  /**
   * Keeps the marks of `win`'s tabs current (vimma.js, once per window): after each change of
   * its panes, and for each tab it opens, which may be an agent's.
   * @param {BrowserWindow} win
   */
  watch(win) {
    const d = deps;
    if (!d) return;
    const stop = d.panes.watch(win, () => markWindow(win));
    // The new tab itself: an agent's, opened while it is connected, is marked before its page
    // loads.
    const onOpen = (/** @type {Event} */ e) => {
      const tab = /** @type {Tab} */ (e.target);
      if (lowMemoryOn() && d.mcp.agentConnected && isAgentTab(d, tab)) mark(tab, true);
    };
    win.addEventListener("TabOpen", onOpen);
    win.addEventListener(
      "unload",
      () => {
        stop();
        win.removeEventListener("TabOpen", onOpen);
      },
      { once: true },
    );
    markWindow(win);
  },

  /** Whether the interval runs (tests). */
  get running() {
    return timer !== null;
  },

  /** How many checks have run (tests). */
  get checks() {
    return checks;
  },

  /**
   * One check, at time `now` (tests move the clock): every tab of every window that the rules
   * let sleep is discarded. Resolves to the tabs put to sleep.
   * @param {number} [now]
   * @returns {Promise<Tab[]>}
   */
  async _check(now = Date.now()) {
    const d = deps;
    const limit = sleepAfterMs();
    const config = d?.configHost.config;
    if (d) markAll();
    if (!d || !config || limit <= 0) return [];
    checks++;
    /** @type {SleepTab[]} */
    const facts = [];
    /** @type {Map<string, { win: BrowserWindow, tab: Tab }>} */
    const byId = new Map();
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (win.closed || !win.gBrowser) continue;
      const isPrivate = lazy.PrivateBrowsingUtils.isWindowPrivate(win);
      const shown = new Set(shownTabs(d, win));
      for (const tab of /** @type {Tab[]} */ (win.gBrowser.tabs)) {
        if (tab.closing) continue;
        const onScreen = tab.selected || shown.has(tab);
        if (onScreen) seenOnScreen.set(tab, now);
        const id = String(byId.size);
        byId.set(id, { win, tab });
        const asleep = tabAsleep(tab);
        facts.push({
          id,
          lastSeen: Math.max(tab.lastAccessed, seenOnScreen.get(tab) ?? 0),
          onScreen,
          pinned: tab.pinned,
          sound: tab.soundPlaying,
          pip: !!tab.pictureinpicture,
          sharing: !asleep && sharing(tab),
          private: isPrivate,
          agent: isAgentTab(d, tab),
          url: tab.linkedBrowser?.currentURI?.spec ?? "",
          loading: tab.hasAttribute("busy"),
          asleep,
        });
      }
    }
    const plan = planSleep({
      now,
      sleepAfterMs: limit,
      tabs: facts,
      sites: config.sites,
      agentConnected: d.mcp.agentConnected,
    });
    /** @type {Tab[]} */
    const slept = [];
    for (const id of plan.sleep) {
      const { win, tab } = /** @type {{ win: BrowserWindow, tab: Tab }} */ (byId.get(id));
      if (await discard(win, tab, d)) slept.push(tab);
    }
    return slept;
  },
};
