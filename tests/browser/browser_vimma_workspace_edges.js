/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m3-workspaces.md, the leftovers of sub-specs 4a/4b and 5: a workspace's
// container deleted outside Vimma (Settings → Containers, an extension) gets a new, empty one;
// containers off at startup is a persistent status-bar error; a lazy background tab moves
// without loading; a workspace name of digits (config.toml) is matched as a name first.

"use strict";

/* global focusContent -- from head.js */

const { WorkspaceStore, WorkspaceStoreImpl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces, WINDOW_KEY } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { getTabLabel, setTabLabel } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/tab-labels.mjs",
);
const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
);
const { ContextualIdentityService: CIS } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
);

const PAGE = "https://example.com/";
const NOTICE_ID = "vimma-notice";

const def = (/** @type {string} */ name) =>
  WorkspaceStore.definitions.workspaces.find((w) => w.name === name);
const main = () => def("main");
const ww = () => WindowWorkspaces.get(window);
const active = () => ww().model.active;
const modelWs = (/** @type {string} */ id) => ww().model.workspaces.find((w) => w.id === id);
const noticeText = () => document.getElementById(NOTICE_ID)?.textContent ?? "";
const segment = (/** @type {string} */ id) =>
  document.getElementById("vimma-statusbar")?.querySelector(`[data-segment="${id}"]`)
    ?.textContent ?? null;
const publicCount = () => CIS.getPublicIdentities().length;

registerCleanupFunction(async () => {
  await WorkspaceStore.setConfig([]);
  ww().switchTo({ id: main().id });
  for (const w of WorkspaceStore.definitions.workspaces.filter(
    (d) => d.name !== "main" && d.id !== WorkspaceStore.agent?.id,
  )) {
    await WorkspaceStore.deleteWorkspace(w.id, { confirmed: true });
  }
  while (gBrowser.tabs.length > 1) BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
});

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/** `:line` Enter, from the selected page in normal mode. */
async function runCommand(line) {
  const browser = gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the selected page has loaded");
  await focusContent(browser);
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
}

/** Opens `url` in container `ucid`, selected and loaded. */
async function openIn(url, ucid) {
  const tab = gBrowser.addTrustedTab(url, { userContextId: ucid });
  gBrowser.selectedTab = tab;
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  return tab;
}

/** A runtime workspace `name`, in the window's model. */
async function workspace(name) {
  const d = WorkspaceStore.newWorkspace(name);
  await until(() => !!modelWs(d.id), `${name} is in the window`);
  return d;
}

/** The definitions file on disk, once it has `cond`. */
async function savedFile(/** @type {(d: any) => boolean} */ cond, msg) {
  /** @type {any} */
  let data = null;
  await TestUtils.waitForCondition(
    async () => {
      data = await IOUtils.readJSON(WorkspaceStore.path).catch(() => null);
      return !!data && cond(data);
    },
    msg,
    100,
    100,
  );
  return data;
}

add_task(async function a_container_deleted_by_an_extension_is_replaced_at_once() {
  const ext = await workspace("ext");
  const old = ext.userContextId;
  ww().switchTo({ id: ext.id });
  const tab = await openIn(`${PAGE}?ext`, old);
  const tabId = ww().idOf(tab);

  // browser.contextualIdentities.remove(): CIS.remove alone, which leaves the tabs open.
  CIS.remove(old);
  await until(() => def("ext")?.userContextId !== old, "ext gets a new container");
  const fresh = def("ext").userContextId;
  Assert.ok(fresh > 0, "a real container");
  Assert.equal(CIS.getPublicIdentityFromId(fresh)?.name, "ext", "named after the workspace");
  Assert.equal(def("ext").id, ext.id, "the same workspace");
  Assert.equal(modelWs(ext.id).container, String(fresh), "the window's model has it");
  await until(() => /"ext"/.test(noticeText()) && /new/.test(noticeText()), "the notice says so");
  Assert.stringContains(noticeText(), "outside Vimma", "and why");

  Assert.ok(tab.isConnected && modelWs(ext.id).tabs.includes(tabId), "the old tab stays in ext");
  Assert.equal(tab.userContextId, old, "in its old, deleted container");
  Assert.ok(ww().isForeign(tab), "marked foreign");

  // New tabs route to the new container, never to container 0.
  // ctrl+t is Vimma's new_tab on every platform; cmd+t, accel on a Mac, is off there (#385).
  const routed = await BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    opening: () => EventUtils.synthesizeKey("t", { ctrlKey: true }),
  });
  Assert.equal(routed.userContextId, fresh, "ctrl+t opens in the new container");

  await savedFile(
    (d) => d.workspaces.some((w) => w.id === ext.id && w.userContextId === fresh),
    "the definitions file has the new container",
  );
  await until(() => {
    const snap = JSON.parse(SessionStore.getCustomWindowValue(window, WINDOW_KEY) || "{}");
    return snap.workspaces?.some((w) => w.id === ext.id && w.container === String(fresh));
  }, "and the window's snapshot");
  BrowserTestUtils.removeTab(routed);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_container_deleted_in_settings_is_replaced_and_ext_stays_usable() {
  const set = await workspace("set");
  const old = set.userContextId;
  ww().switchTo({ id: set.id });
  await openIn(`${PAGE}?set`, old);
  ww().switchTo({ id: main().id });
  const count = publicCount();

  // Settings → Containers → Remove: closeContainerTabs, then remove (containers.mjs).
  await CIS.closeContainerTabs(old);
  CIS.remove(old);
  await until(() => def("set")?.userContextId !== old, "set gets a new container");
  const fresh = def("set").userContextId;
  Assert.equal(publicCount(), count, "one container out, one in");
  Assert.equal(modelWs(set.id).tabs.length, 0, "set is empty");
  Assert.equal(active(), main().id, "the window stays where it was");

  ww().switchTo({ id: set.id });
  await until(() => modelWs(set.id).tabs.length === 1, "switching opens its home tab");
  Assert.equal(gBrowser.selectedTab.userContextId, fresh, "in the new container");
  ww().switchTo({ id: main().id });
});

add_task(async function vimmas_own_delete_does_not_bring_the_container_back() {
  const gone = await workspace("gone");
  const count = publicCount();
  await WorkspaceStore.deleteWorkspace(gone.id, { confirmed: true });
  Assert.ok(!def("gone"), "the workspace is gone");
  Assert.equal(publicCount(), count - 1, "and its container, not replaced");
  Assert.ok(!CIS.getPublicIdentities().some((i) => i.name === "gone"), "no container named gone");
});

add_task(async function containers_off_at_startup_is_a_persistent_status_bar_error() {
  // Flipping privacy.userContext.enabled wipes every container (CIS observe), so the pref is
  // read through `enabled` for a store of its own, and the app's store is marked for the bar.
  const store = new WorkspaceStoreImpl({
    path: PathUtils.join(PathUtils.tempDir, `vimma-ws-off-${Date.now()}.json`),
    enabled: () => false,
  });
  await store.init();
  Assert.ok(store.disabled, "disabled");
  Assert.stringContains(store.alert, "privacy.userContext.enabled", "it names the pref");
  Assert.equal(WorkspaceStore.alert, null, "the app's store has none");

  WorkspaceStore.disabled = true;
  try {
    VimmaHost.configure({});
    await until(() => segment("alert") !== null, "the bar shows an error");
    Assert.stringContains(segment("alert"), "privacy.userContext.enabled", "naming the pref");
    EventUtils.synthesizeKey("KEY_Escape");
    await new Promise((r) => setTimeout(r, 300));
    Assert.notEqual(segment("alert"), null, "it stays (not a notice)");
  } finally {
    WorkspaceStore.disabled = false;
    VimmaHost.configure({});
  }
  await until(() => segment("alert") === null, "and goes with the condition");
  Assert.ok(Services.prefs.getBoolPref("privacy.userContext.enabled"), "the pref is untouched");
});

add_task(async function containers_lost_at_startup_are_a_persistent_status_bar_error() {
  // The startup check fills lostContainers once, before any window; set it as that check would.
  Assert.deepEqual(WorkspaceStore.lostContainers, [], "sanity: none lost in this profile");
  WorkspaceStore.lostContainers.push("work");
  try {
    VimmaHost.configure({});
    await until(() => segment("alert") !== null, "the bar shows an error");
    Assert.stringContains(segment("alert"), '"work" lost its container', "naming the workspace");
    EventUtils.synthesizeKey("KEY_Escape");
    await new Promise((r) => setTimeout(r, 300));
    Assert.notEqual(segment("alert"), null, "it stays (not a notice)");
  } finally {
    WorkspaceStore.lostContainers.length = 0;
    VimmaHost.configure({});
  }
  await until(() => segment("alert") === null, "and goes with the list");
});

add_task(async function a_lazy_background_tab_moves_without_loading() {
  const a = await workspace("lazyA");
  const b = await workspace("lazyB");
  ww().switchTo({ id: a.id });
  const lazyTab = gBrowser.addTab(`${PAGE}?lazy`, {
    createLazyBrowser: true,
    lazyTabTitle: "Lazy page",
    userContextId: a.userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipal(
      Services.io.newURI(PAGE),
      { userContextId: a.userContextId },
    ),
  });
  await until(() => modelWs(a.id).tabs.includes(ww().idOf(lazyTab)), "the lazy tab is in A");
  setTabLabel(lazyTab, "lazy label");
  Assert.ok(!lazyTab.linkedPanel, "not loaded");

  Assert.equal(ww().moveTab(lazyTab, { id: b.id }), null, "the move goes ahead");
  Assert.ok(!lazyTab.isConnected, "the original is gone");
  const moved = gBrowser.tabs.find((t) => t.userContextId === b.userContextId && !t.closing);
  Assert.ok(moved, "a tab in B's container");
  Assert.ok(!moved.linkedPanel, "still not loaded");
  Assert.equal(moved.linkedBrowser.currentURI.spec, `${PAGE}?lazy`, "with its URL");
  Assert.equal(moved.label, "Lazy page", "and its title");
  Assert.equal(getTabLabel(moved), "lazy label", "and its label");
  Assert.ok(modelWs(b.id).tabs.includes(ww().idOf(moved)), "B has it");
  Assert.ok(moved.hidden, "hidden with B");
  const state = JSON.parse(SessionStore.getTabState(moved));
  Assert.equal(state.userContextId, b.userContextId, "SessionStore restores it into B");
  Assert.equal(state.entries.at(-1)?.url, `${PAGE}?lazy`, "at its URL");

  ww().switchTo({ id: b.id });
  gBrowser.selectedTab = moved;
  await BrowserTestUtils.browserLoaded(moved.linkedBrowser, false, `${PAGE}?lazy`);
  Assert.equal(moved.userContextId, b.userContextId, "it loads in B's container");
  ww().switchTo({ id: main().id });
});

add_task(async function a_number_like_name_is_matched_as_a_name_first() {
  await WorkspaceStore.setConfig([
    { name: "2", color: "red", icon: "circle", autofill: true },
    { name: "x", color: "blue", icon: "circle", autofill: true },
  ]);
  await until(() => !!def("2") && !!modelWs(def("2").id) && !!modelWs(def("x").id), "2 and x");
  const place = (/** @type {string} */ name) =>
    ww().model.workspaces.findIndex((w) => w.name === name) + 1;
  Assert.notEqual(place("2"), 2, "the workspace named 2 is not at place 2");
  Assert.notEqual(place("x"), 2, "nor is x");
  Assert.equal(place("main"), 1, "main is at place 1");

  await runCommand("workspace 2");
  await until(() => active() === def("2").id, ":workspace 2 shows the workspace named 2");
  await runCommand("workspace 1");
  await until(() => active() === main().id, "a number no workspace is named is still a place");
  await runCommand(`workspace ${place("x")}`);
  await until(() => active() === def("x").id, "and so is x's");

  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?num`);
  await runCommand("wsmove 2");
  await until(() => !tab.isConnected, "the tab moves");
  const moved = gBrowser.tabs.find((t) => t.userContextId === def("2").userContextId);
  Assert.ok(moved, "into the workspace named 2, not the one at place 2");
  await until(() => /moved to "2"/.test(noticeText()), "the notice names it");
  ww().switchTo({ id: main().id });
});
