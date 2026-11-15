/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m3-workspaces.md, sub-specs 4a (m3-workspace-lifecycle) and 4b
// (m3-workspace-move): prefix+shift+n / shift+w / shift+d and :wsnew / :wsrename / :wsdelete
// create, rename and close workspaces (closing asks y/N; a runtime workspace takes its container
// and site data with it, a config one only its tabs; the last one stays), and :wsmove reopens
// the tab in another workspace's container, keeping its label and mute, out of its split first.

"use strict";

/* global focusContent -- from head.js */

const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces, WINDOW_KEY, TAB_WORKSPACE_KEY } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { getTabLabel, setTabLabel } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/tab-labels.mjs",
);
const { sinon } = ChromeUtils.importESModule("resource://testing-common/Sinon.sys.mjs");
const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
);
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
);

const PAGE = "https://example.com/";
const START = "chrome://browser/content/vimma/start/start.html";
const NOTICE_ID = "vimma-notice";
const PROMPT_ID = "vimma-rename";
const CMDLINE_INPUT_ID = "vimma-cmdline-input";

const def = (/** @type {string} */ name) =>
  /** @type {ContainedWorkspace} */ (
    WorkspaceStore.definitions.workspaces.find(
      (/** @type {WorkspaceDefinition} */ w) => w.name === name,
    )
  );
const main = () => def("main");
const ww = () => /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(window));
const active = () => ww().model.active;
const identity = (/** @type {number} */ id) =>
  ContextualIdentityService.getPublicIdentityFromId(id);

registerCleanupFunction(async () => {
  if (document.getElementById(PROMPT_ID)?.hidden === false) EventUtils.synthesizeKey("KEY_Escape");
  await WorkspaceStore.setConfig([]);
  ww().switchTo({ id: main().id });
  for (const w of WorkspaceStore.definitions.workspaces.filter(
    (/** @type {WorkspaceDefinition} */ d) =>
      d.name !== "main" && d.id !== WorkspaceStore.agent?.id,
  )) {
    await WorkspaceStore.deleteWorkspace(w.id, { confirmed: true });
  }
  while (gBrowser.tabs.length > 1)
    BrowserTestUtils.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
});

/** @param {() => unknown} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/** ctrl+b, then `key`. @param {string} key @param {KeyEventOptions} [mods] */
function prefix(key, mods = {}) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key, mods);
}

/** Focuses the selected page, once it has loaded, so keys reach it in normal mode. */
async function focusPage() {
  // A new workspace's home tab may still be swapping its initial about:blank for the start
  // page; a spawn into it then fails on a busy runner. Wait until it has loaded.
  const browser = gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the selected page has loaded");
  await focusContent(browser);
}

/** Waits for the selected tab (a new workspace's home tab) to show the start page. */
function startPageLoaded() {
  const browser = gBrowser.selectedBrowser;
  return until(
    () => browser.currentURI.spec === START && browser.contentDocument?.readyState === "complete",
    "the start page has loaded",
  );
}

/** `:line` Enter, from the selected page in normal mode. */
/** @param {string} line */
async function runCommand(line) {
  await focusPage();
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
}

const noticeText = () => document.getElementById(NOTICE_ID)?.textContent ?? "";
const promptOpen = () => document.getElementById(PROMPT_ID)?.hidden === false;
/** The prompt's question, without the space before the input. */
const promptText = () =>
  (
    document.getElementById(PROMPT_ID)?.querySelector(".vimma-cmdline-prompt")?.textContent ?? ""
  ).trim();

/**
 * Waits for a tab of container `ucid` to have loaded `url`, and returns it.
 * @param {number} ucid @param {string} url
 */
async function reopened(ucid, url) {
  await until(
    () => tabsOf(ucid).some((t) => t.linkedBrowser.currentURI.spec === url),
    `${url} reopens in container ${ucid}`,
  );
  return tabsOf(ucid).find((t) => t.linkedBrowser.currentURI.spec === url);
}

/** The status bar's workspace segment. */
const wsSegment = () =>
  document.getElementById("vimma-statusbar")?.querySelector('[data-segment="workspace"]')
    ?.textContent ?? null;

/** The window's saved snapshot (SessionStore window value). */
const snapshot = () => JSON.parse(SessionStore.getCustomWindowValue(window, WINDOW_KEY) || "{}");

/** Tabs (in every window) of container `ucid`. */
const tabsOf = (/** @type {number} */ ucid) =>
  gBrowser.tabs.filter((t) => t.userContextId === ucid && !t.closing);

const cookieCount = (/** @type {number} */ userContextId) =>
  Services.cookies.getCookiesWithOriginAttributes(JSON.stringify({ userContextId }), "example.com")
    .length;

function setCookie(/** @type {number} */ userContextId) {
  Services.cookies.add(
    "example.com",
    "/",
    "session",
    "ops",
    true,
    false,
    false,
    Date.now() + 86400000,
    { userContextId },
    Ci.nsICookie.SAMESITE_NONE,
    Ci.nsICookie.SCHEME_HTTPS,
  );
}

/** :wsnew `name`, waiting for the window to show it. @param {string} name */
async function create(name) {
  await runCommand(`wsnew ${name}`);
  await until(() => def(name) && active() === def(name).id, `created and switched to ${name}`);
  await startPageLoaded();
  return def(name);
}

add_task(async function the_last_workspace_cannot_be_closed() {
  // And the agent workspace, which never counts as the one left (docs/specs/vimma-mcp.md 8).
  Assert.deepEqual(
    WorkspaceStore.definitions.workspaces.map((/** @type {WorkspaceDefinition} */ w) => w.name),
    ["main", "agent"],
    "only main (and the agent workspace) to begin with",
  );
  await runCommand("wsdelete");
  await until(() => /last workspace/.test(noticeText()), "the notice says why");
  Assert.ok(!promptOpen(), "nothing to confirm");
  Assert.ok(main(), "main stays");
});

add_task(async function new_workspace_appears_in_cycling_the_bar_and_the_snapshot() {
  await focusPage();
  prefix("N", { shiftKey: true });
  const input = /** @type {HTMLInputElement | null} */ (document.getElementById(CMDLINE_INPUT_ID));
  await until(() => input?.value === "wsnew ", "prefix+shift+n asks on the command line");
  EventUtils.sendString("shop");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => def("shop") && active() === def("shop").id, "shop is created and shown");
  await startPageLoaded();
  const shop = def("shop");
  Assert.equal(shop.source, "runtime", "a runtime workspace");
  Assert.ok(identity(shop.userContextId), "with a container of its own");
  await until(() => wsSegment() === "● 2:shop", "the bar shows it");
  await until(
    () => snapshot().workspaces?.some((/** @type {WorkspaceState} */ w) => w.id === shop.id),
    "the window's snapshot has it",
  );
  Assert.equal(gBrowser.selectedTab.userContextId, shop.userContextId, "its home tab is in it");

  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(")", { shiftKey: true });
  await until(() => active() === main().id, "ctrl+b ) wraps to main");
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(")", { shiftKey: true });
  await until(() => active() === shop.id, "and ctrl+b ) comes back to shop");

  await runCommand("wsnew shop");
  await until(() => /exists/.test(noticeText()), "a taken name is refused");
  Assert.equal(
    WorkspaceStore.definitions.workspaces.filter(
      (/** @type {WorkspaceDefinition} */ w) => w.name === "shop",
    ).length,
    1,
    "no second shop",
  );

  // A number is a place (`:wsmove 2`), so a name cannot be one.
  await runCommand("wsnew 2");
  await until(() => /digits/.test(noticeText()), "a name of digits only is refused");
  Assert.ok(!def("2"), "no workspace named 2");
  await runCommand("wsrename 7");
  await until(() => /digits/.test(noticeText()), "and so is a rename to one");
  Assert.ok(def("shop"), "shop keeps its name");
});

add_task(async function rename_shows_in_the_bar_and_renames_the_container() {
  const shop = def("shop");
  ww().switchTo({ id: shop.id });
  await focusPage();
  prefix("W", { shiftKey: true });
  const input = /** @type {HTMLInputElement | null} */ (document.getElementById(CMDLINE_INPUT_ID));
  await until(() => input?.value === "wsrename shop", "prefix+shift+w offers the name to edit");
  EventUtils.synthesizeKey("KEY_Escape");

  await runCommand("wsrename market");
  await until(() => wsSegment() === "● 2:market", "the bar shows the new name");
  Assert.equal(def("market")?.id, shop.id, "same workspace, new name");
  Assert.equal(identity(shop.userContextId)?.name, "market", "the container is renamed too");
  await until(
    () =>
      snapshot().workspaces?.find((/** @type {WorkspaceState} */ w) => w.id === shop.id)?.name ===
      "market",
    "and the snapshot",
  );
});

add_task(async function closing_asks_n_keeps_y_deletes_the_container_and_its_cookies() {
  const market = def("market");
  ww().switchTo({ id: market.id });
  await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?market`);
  setCookie(market.userContextId);
  setCookie(main().userContextId);
  setCookie(0);
  Assert.equal(cookieCount(market.userContextId), 1, "market has a cookie");

  await focusPage();
  prefix("D", { shiftKey: true });
  await until(promptOpen, "prefix+shift+d asks");
  Assert.equal(
    promptText(),
    'Close "market" (2 tabs) and delete its cookies and site data? y/N',
    "the question says what goes",
  );
  EventUtils.synthesizeKey("n");
  await until(() => !promptOpen(), "n closes the prompt");
  Assert.ok(def("market"), "n keeps the workspace");
  Assert.equal(tabsOf(market.userContextId).length, 2, "and its tabs");
  for (const key of ["KEY_Escape", "KEY_Enter"]) {
    await runCommand("wsdelete");
    await until(promptOpen, `asked again, to answer ${key}`);
    EventUtils.synthesizeKey(key);
    await until(() => !promptOpen(), `${key} closes the prompt`);
    Assert.ok(def("market"), `${key} answers no`);
    Assert.equal(tabsOf(market.userContextId).length, 2, `${key} closes no tab`);
  }

  await runCommand("wsdelete");
  await until(promptOpen, ":wsdelete asks too");
  /** @type {string[]} every origin-attributes clear while deleting */
  const clears = [];
  const record = (
    /** @type {unknown} */ _s,
    /** @type {string} */ _t,
    /** @type {string | null} */ data,
  ) => clears.push(/** @type {string} */ (data));
  Services.obs.addObserver(record, "clear-origin-attributes-data");
  const cleared = TestUtils.topicObserved(
    "clear-origin-attributes-data",
    (_s, data) => JSON.parse(/** @type {string} */ (data)).userContextId === market.userContextId,
  );
  EventUtils.synthesizeKey("y");
  await cleared;
  await TestUtils.waitForTick();
  Services.obs.removeObserver(record, "clear-origin-attributes-data");
  Assert.deepEqual(
    clears.map((d) => JSON.parse(d).userContextId),
    [market.userContextId],
    "only market's container is cleared",
  );
  Assert.equal(cookieCount(0), 1, "the default container's cookie stays");
  await until(() => !def("market"), "y deletes the workspace");
  await until(() => cookieCount(market.userContextId) === 0, "its cookie is gone");
  Assert.ok(!identity(market.userContextId), "and its container");
  Assert.equal(tabsOf(market.userContextId).length, 0, "and its tabs");
  Assert.equal(cookieCount(main().userContextId), 1, "main's cookie stays");
  Assert.equal(active(), main().id, "the window shows main");
  Assert.ok(
    !ww().model.workspaces.some((/** @type {WorkspaceState} */ w) => w.id === market.id),
    "the model has no market",
  );
  Services.cookies.removeAll();
});

add_task(async function closing_a_config_workspace_closes_its_tabs_only() {
  await WorkspaceStore.setConfig([
    { name: "job", color: "red", icon: "briefcase", autofill: true },
  ]);
  await until(
    () =>
      def("job") &&
      ww().model.workspaces.some((/** @type {WorkspaceState} */ w) => w.id === def("job").id),
    "job",
  );
  const job = def("job");
  ww().switchTo({ id: job.id });
  await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?job`);

  await runCommand("wsrename work");
  await until(() => /config\.toml/.test(noticeText()), "a config workspace is renamed there");
  Assert.equal(def("job")?.id, job.id, "the name stays");

  await runCommand("wsdelete");
  await until(promptOpen, "it asks");
  Assert.equal(
    promptText(),
    'Close the 2 tabs of "job"? It stays, as it is in config.toml. y/N',
    "the question says the workspace stays",
  );
  EventUtils.synthesizeKey("y");
  await until(() => tabsOf(job.userContextId).length === 0, "its tabs close");
  Assert.ok(def("job"), "the workspace stays");
  Assert.ok(identity(job.userContextId), "and its container");
  Assert.equal(active(), main().id, "the window shows main");

  await runCommand("wsdelete job");
  await until(() => /no tabs/.test(noticeText()), "with no tabs there is nothing to close");
  Assert.ok(!promptOpen(), "and nothing to ask");

  // The answer acts on what was asked: a config reload in between makes job a runtime
  // workspace, whose close would delete its container; the y is refused instead.
  const tab = BrowserTestUtils.addTab(gBrowser, `${PAGE}?job2`, {
    userContextId: job.userContextId,
  });
  await until(() => tabsOf(job.userContextId).length === 1, "job has a tab again");
  setCookie(job.userContextId);
  await runCommand("wsdelete job");
  await until(promptOpen, "asked to close job's tab");
  Assert.stringContains(promptText(), "config.toml", "a config workspace's question");
  await WorkspaceStore.setConfig([]);
  await until(() => def("job")?.source === "runtime", "job left config.toml meanwhile");
  EventUtils.synthesizeKey("y");
  await until(() => /changed/.test(noticeText()), "the answer is refused: job changed");
  Assert.ok(def("job"), "job stays");
  Assert.ok(identity(job.userContextId), "with its container");
  Assert.equal(cookieCount(job.userContextId), 1, "and its cookie");
  Assert.ok(tab.isConnected, "and its tab");
  BrowserTestUtils.removeTab(tab);
  Services.cookies.removeAll();
});

add_task(async function a_container_no_longer_ours_is_kept_and_the_notice_says_so() {
  const odd = await create("odd");
  const tab = gBrowser.selectedTab;
  setCookie(odd.userContextId);
  // Renamed in Firefox's Settings: the container is no longer recognisably the workspace's.
  ContextualIdentityService.update(odd.userContextId, "someone else", "circle", "blue");
  await runCommand("wsdelete");
  await until(promptOpen, "it asks");
  EventUtils.synthesizeKey("y");
  await until(() => !def("odd"), "the workspace goes");
  await until(() => /kept/.test(noticeText()), "the notice says the data was kept");
  Assert.ok(identity(odd.userContextId), "the container stays");
  Assert.equal(cookieCount(odd.userContextId), 1, "with its cookie");
  if (tab.isConnected) BrowserTestUtils.removeTab(tab);
  ContextualIdentityService.remove(odd.userContextId);
  Services.cookies.removeAll();
});

add_task(async function moving_a_tab_reopens_it_in_the_target_container() {
  const a = await create("alpha");
  const b = await create("beta");
  ww().switchTo({ id: a.id });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?moved`);
  const after = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?after`);
  gBrowser.selectedTab = tab;
  setTabLabel(tab, "my label");
  tab.toggleMuteAudio();
  const oldId = ww().idOf(tab);
  const at = tab.index;

  await runCommand("wsmove beta");
  await until(() => !tab.isConnected, "the original tab closes");
  const moved = await reopened(b.userContextId, `${PAGE}?moved`);
  Assert.ok(moved, "the URL reopens in beta's container");
  Assert.equal(getTabLabel(moved), "my label", "the label is kept");
  Assert.ok(moved.muted, "and the mute");
  // Reopened beside the original, as Firefox's "Reopen in Container" places it (tabIndex
  // `index + 1`), so it takes the original's place in the tab strip.
  Assert.equal(moved.index, at, "it takes the original's place");
  Assert.equal(after.index, at + 1, "before the tab that followed it");
  BrowserTestUtils.removeTab(after);
  const model = ww().model;
  const inA = /** @type {WorkspaceState} */ (
    model.workspaces.find((/** @type {WorkspaceState} */ w) => w.id === a.id)
  ).tabs;
  const inB = /** @type {WorkspaceState} */ (
    model.workspaces.find((/** @type {WorkspaceState} */ w) => w.id === b.id)
  ).tabs;
  Assert.ok(!inA.includes(oldId), "alpha no longer has it");
  Assert.ok(inB.includes(ww().idOf(moved)), "beta has it");
  Assert.equal(active(), a.id, "the window stays in alpha");
  Assert.ok(moved.hidden, "the moved tab is hidden with beta");
  await until(
    () => SessionStore.getCustomTabValue(moved, TAB_WORKSPACE_KEY) === b.id,
    "its saved workspace is beta",
  );

  await runCommand("wsmove nowhere");
  await until(() => /no workspace "nowhere"/.test(noticeText()), "an unknown target is refused");
});

add_task(async function moving_a_workspaces_last_tab_opens_its_home_tab() {
  const b = def("beta");
  const g = await create("gamma");
  Assert.equal(
    /** @type {WorkspaceState} */ (
      ww().model.workspaces.find((/** @type {WorkspaceState} */ w) => w.id === g.id)
    ).tabs.length,
    1,
    "one tab",
  );
  const only = gBrowser.selectedTab;
  BrowserTestUtils.startLoadingURIString(only.linkedBrowser, `${PAGE}?last`);
  await BrowserTestUtils.browserLoaded(only.linkedBrowser);

  await runCommand("wsmove beta");
  await until(() => !only.isConnected, "the tab moves");
  await reopened(b.userContextId, `${PAGE}?last`);
  Assert.equal(active(), g.id, "the window stays in gamma");
  const left = /** @type {WorkspaceState} */ (
    ww().model.workspaces.find((/** @type {WorkspaceState} */ w) => w.id === g.id)
  ).tabs;
  Assert.equal(left.length, 1, "gamma has a tab again");
  const home = /** @type {MozTabbrowserTab} */ (ww().tabOf(left[0]));
  Assert.equal(home.userContextId, g.userContextId, "in gamma's container");
  Assert.ok(home.selected && !home.hidden, "selected and shown");
});

add_task(async function a_split_member_leaves_its_split_before_it_moves() {
  const a = def("alpha");
  const b = def("beta");
  ww().switchTo({ id: a.id });
  const left = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?left`);
  const view = /** @type {PaneView} */ (PaneViews.get(window));
  Assert.ok(view.split("vertical").ok, "a split");
  const right = gBrowser.selectedTab;
  await until(() => right.splitview && left.splitview, "laid out on Firefox's split view");
  BrowserTestUtils.startLoadingURIString(right.linkedBrowser, `${PAGE}?right`);
  await BrowserTestUtils.browserLoaded(right.linkedBrowser);
  const number =
    WorkspaceStore.definitions.workspaces.findIndex(
      (/** @type {WorkspaceDefinition} */ w) => w.id === b.id,
    ) + 1;

  // A move refused for want of a principal (a lazy tab whose saved state does not read) leaves
  // the split as it was.
  Object.defineProperty(right, "linkedPanel", { value: "", configurable: true });
  const stub = sinon.stub(SessionStore, "getTabState").throws(new Error("unreadable"));
  try {
    Assert.equal(
      ww().moveTab(right, { index: number }),
      "this tab's page cannot be reopened",
      "the move is refused",
    );
  } finally {
    stub.restore();
    // The own property defined above, over the tab's getter.
    delete (/** @type {{ linkedPanel?: string }} */ (right).linkedPanel);
  }
  Assert.ok(view.panes, "the split stays");
  Assert.ok(right.splitview && right.isConnected, "with the tab in it");

  await runCommand(`wsmove ${number}`);
  await until(() => !right.isConnected, "the split member moves");
  // Read again after the close: the Assert.ok above narrowed it to set.
  Assert.equal(/** @type {Panes | null} */ (view.panes), null, "the split is gone: one pane left");
  await until(() => !left.splitview, "and so is Firefox's wrapper");
  const moved = await reopened(b.userContextId, `${PAGE}?right`);
  Assert.ok(moved, "it reopens in beta, by number");
  Assert.ok(!moved.splitview, "outside any split");
  Assert.ok(!left.hidden && left.isConnected, "the other member stays in alpha");
  Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
});
