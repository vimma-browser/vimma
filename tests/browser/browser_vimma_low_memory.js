/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/tab-sleep.md, Behaviour 16 and 17, decision 21 (Delivery slice 5). Firefox's
// low-memory unloader runs from `[tabs] sleep_on_low_memory`, and the `undiscardable` mark
// keeps it off the panes on screen and a connected agent's tabs. Low memory is real Firefox's:
// the Linux memory watcher counts memory as low under `browser.low_commit_space_threshold_percent`
// = 100 and asks TabUnloader for a tab at each poll (AvailableMemoryWatcherLinux.cpp).

"use strict";

const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/AgentGate.sys.mjs",
);
const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

const FEATURE = "vimma.feature.tabSleep";
const UNLOAD_PREF = "browser.tabs.unloadOnLowMemory";
const HOUR = 60 * 60_000;
const PAGE = "https://example.com/";
const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const AGENT_PAGE = `${ROOT}file_vimma_agent_page.html`;
const CONN = "low-memory-test";
const dir = PathUtils.join(PathUtils.tempDir, `vimma-low-memory-${Date.now()}`);
const configFile = PathUtils.join(dir, "config.toml");

/** @typedef {MozTabbrowserTab} Tab */

/** @param {() => unknown} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 50, 300);

const view = () => /** @type {PaneView} */ (PaneViews.get(window));
const agent = () => /** @type {ContainedWorkspace} */ (WorkspaceStore.agent);
/** @param {Tab} t */
const asleep = (t) => !t.linkedPanel || t.hasAttribute("pending");
/** @param {Tab} t */
const marked = (t) => t.hasAttribute("undiscardable");

/** @type {Tab[]} */
const opened = [];

registerCleanupFunction(async () => {
  AgentGate.disconnect(CONN);
  for (const t of opened) if (!t.closing && t.parentNode) BrowserTestUtils.removeTab(t);
  await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
  await SpecialPowers.popPrefEnv();
  await ConfigHost.reload();
});

/** Writes config.toml and waits until it is in force. @param {string} text */
async function config(text) {
  await IOUtils.writeUTF8(configFile, text);
  await ConfigHost.reload();
}

/** A background tab loaded with `url`, last used an hour ago. @param {string} url */
async function background(url, userContextId = 0) {
  const t = gBrowser.addTab(url, {
    userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  opened.push(t);
  await BrowserTestUtils.browserLoaded(t.linkedBrowser, false, url);
  await until(() => !t.hasAttribute("busy"), "the tab is done loading");
  return t;
}

/**
 * Past the unloader's ten minutes (browser.tabs.min_inactive_duration_before_unload).
 * @param {Tab[]} tabs
 */
function makeOld(tabs) {
  for (const t of tabs) t.updateLastAccessed(Date.now() - HOUR);
}

/**
 * Resolves after `n` polls of the memory watcher; the poller tells them only to a watcher in
 * testing mode (setPSIPathForTesting).
 * @param {number} n
 */
function polls(n) {
  let left = n;
  return TestUtils.topicObserved("memory-poller-sync", () => --left === 0);
}

add_task(async function setup() {
  await IOUtils.makeDirectory(dir);
  await SpecialPowers.pushPrefEnv({
    set: [
      [FEATURE, true],
      ["vimma.config.path", configFile],
    ],
    // The test profile turns the unloader off as a user value (testing/profiles/common/user.js);
    // a user's profile has none.
    clear: [[UNLOAD_PREF]],
  });
  await config("");
  await /** @type {WindowWorkspacesImpl} */ (WindowWorkspaces.get(window)).ready;
});

add_task(async function sleep_on_low_memory_turns_firefoxs_unloader_on_and_off() {
  Assert.equal(Services.prefs.getBoolPref(UNLOAD_PREF), true, "on by default, on Linux too");
  await config("[tabs]\nsleep_on_low_memory = false\n");
  Assert.equal(Services.prefs.getBoolPref(UNLOAD_PREF), false, "false turns it off");
  await config("[tabs]\nsleep_after = 0\n");
  Assert.equal(
    Services.prefs.getBoolPref(UNLOAD_PREF),
    true,
    "independent of sleep_after: 0 leaves it on",
  );
  Assert.ok(!Services.prefs.prefHasUserValue(UNLOAD_PREF), "nothing is written to prefs.js");
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
  Assert.equal(
    Services.prefs.getBoolPref(UNLOAD_PREF),
    AppConstants.platform !== "linux",
    "with the feature off, Firefox's own default",
  );
  await SpecialPowers.popPrefEnv();
  Assert.equal(Services.prefs.getBoolPref(UNLOAD_PREF), true, "back on with the feature");
});

add_task(async function low_memory_unloads_other_tabs_but_never_a_shown_pane_or_an_agents_tab() {
  // No check runs: the low-memory unloader works without the time limit.
  await config("[tabs]\nsleep_after = 0\n");
  const a = await background(`${PAGE}?a`);
  const b = await background(`${PAGE}?b`);
  const c = await background(`${PAGE}?c`);
  AgentGate.connect(CONN, { client: "example-agent" });
  const d = await background(AGENT_PAGE, agent().userContextId);
  await BrowserTestUtils.switchTab(gBrowser, a);
  Assert.ok(
    view().showTabs(/** @type {SplitTab[]} */ ([a, b]), /** @type {SplitTab} */ (a)).ok,
    "a | b",
  );
  await until(() => view().panes && !view().hidden, "the split shows");
  makeOld([b, c, d]);
  Assert.ok(marked(b), "the pane beside the selected tab is marked undiscardable");
  Assert.ok(marked(d), "so is the connected agent's tab");
  Assert.ok(!marked(c), "not a tab off screen");

  const watcher = Cc["@mozilla.org/xpcom/memory-watcher;1"].getService(
    Ci.nsIAvailableMemoryWatcherTestingLinux,
  );
  watcher.setPSIPathForTesting("/proc/pressure/memory");
  // PaneView gives a discarded pane its browser back at once, so the discards are counted.
  /** @type {Tab[]} */
  const discarded = [];
  const onDiscard = (/** @type {Event} */ e) => discarded.push(/** @type {Tab} */ (e.target));
  window.addEventListener("TabBrowserDiscarded", onDiscard);
  await SpecialPowers.pushPrefEnv({ set: [["browser.low_commit_space_threshold_percent", 100]] });
  Services.obs.notifyObservers(null, "user-interaction-active");
  await until(() => discarded.includes(c), "low memory unloads the background tab");
  // The pressure stays: one tab per poll, until only the protected ones are left.
  await polls(4);
  await SpecialPowers.popPrefEnv();
  await polls(2);
  window.removeEventListener("TabBrowserDiscarded", onDiscard);
  Assert.ok(asleep(c), "the background tab is asleep");
  Assert.ok(!discarded.includes(b) && !asleep(b), "the pane on screen stays loaded");
  Assert.ok(!discarded.includes(d) && !asleep(d), "the agent's tab stays loaded");
  Assert.ok(!discarded.includes(a), "the selected tab stays loaded");
});

add_task(async function the_mark_follows_the_split_the_agent_and_the_config() {
  const [a, b, , d] = /** @type {Tab[]} */ (opened);
  const other = await background(`${PAGE}?other`);
  // What an add-on's `autoDiscardable: false` sets (ext-tabs.js): Vimma leaves it alone.
  other.undiscardable = true;
  const e = await background(AGENT_PAGE, agent().userContextId);
  Assert.ok(marked(e), "an agent tab opened while an agent is connected is marked at once");

  await BrowserTestUtils.switchTab(gBrowser, other);
  await until(() => view().hidden, "the split is hidden");
  Assert.ok(
    !marked(/** @type {Tab} */ (a)) && !marked(/** @type {Tab} */ (b)),
    "a hidden split's tabs are not marked",
  );
  AgentGate.disconnect(CONN);
  await until(
    () => !marked(/** @type {Tab} */ (d)),
    "with no agent connected, its tabs lose the mark",
  );
  Assert.ok(!marked(e), "every one of them");
  Assert.ok(marked(other), "an add-on's mark stays");

  gBrowser.selectedTab = /** @type {Tab} */ (a);
  await until(
    () => !view().hidden && marked(/** @type {Tab} */ (b)),
    "the split shows: b is marked",
  );
  await config("[tabs]\nsleep_on_low_memory = false\n");
  Assert.ok(!marked(/** @type {Tab} */ (b)), "with the unloader off, nothing is marked");
  await config("");
  Assert.ok(marked(/** @type {Tab} */ (b)), "on again: marked again");
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
  Assert.ok(!marked(/** @type {Tab} */ (b)), "with the feature off, nothing is marked");
  Assert.ok(marked(other), "an add-on's mark stays throughout");
  await SpecialPowers.popPrefEnv();
});
