/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/workspace-routing.md, docs/specs/app-routes.md. A new window's first tab: a
// cold start's or another program's window routes it (by the startup names `VIMMA_FROM`, read
// once and cleared, by a domain rule, or by `[routing] default_workspace`); a window opened from
// inside Vimma is not routed and takes no default. Every task opens windows, the slow part of
// routing's tests, so they run apart from browser_vimma_workspace_routes.js to keep each file
// under the harness's 45 s limit on two busy CPUs.

"use strict";

const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { WorkspaceRouter } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceRouter.sys.mjs",
);
const { resolveRoutes } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/routes.mjs",
);
const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

const WORK = "https://example.com/";
const ELSEWHERE = "https://example.org/";

const def = (/** @type {string} */ name) =>
  WorkspaceStore.definitions.workspaces.find((w) => w.name === name);
/**
 * A window's workspaces, built: every window of these tests has them.
 * @param {BrowserWindow} [win]
 */
const ww = (win = window) => /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(win));

/**
 * Resolves with the next tab opened in `win`.
 * @param {BrowserWindow} [win]
 */
const nextTab = (win = window) =>
  BrowserTestUtils.waitForEvent(win.gBrowser.tabContainer, "TabOpen").then(
    // Tabbrowser fires TabOpen on the new tab.
    (e) => /** @type {MozTabbrowserTab} */ (e.target),
  );

/**
 * A workspace definition these tests know exists.
 * @param {string} name
 */
const known = (name) => /** @type {ContainedWorkspace} */ (def(name));

/** @param {Record<string, string>[]} rules */
const route = (rules) => WorkspaceRouter.setRoutes(resolveRoutes(rules));

/**
 * Two workspaces, `rt-work` (example.com) and `rt-home` (the rest), `rt-home` shown; each has its
 * container, as containers are on in the browser tests.
 * @type {ContainedWorkspace}
 */
let work;
/** @type {ContainedWorkspace} */
let home;

add_task(async function setup() {
  work = /** @type {ContainedWorkspace} */ (
    WorkspaceStore.addWorkspace({ name: "rt-work", color: "blue", icon: "briefcase" })
  );
  home = /** @type {ContainedWorkspace} */ (
    WorkspaceStore.addWorkspace({ name: "rt-home", color: "green", icon: "tree" })
  );
  // The checks that a tab is not in rt-home hold only if rt-home has a container of its own.
  Assert.greater(work.userContextId ?? 0, 0, "work has a container");
  Assert.greater(home.userContextId ?? 0, 0, "home has a container");
  registerCleanupFunction(async () => {
    route([]);
    ww().switchTo({ id: known("main").id });
    for (const w of WorkspaceStore.definitions.workspaces.filter(
      (d) => d.name !== "main" && d.id !== WorkspaceStore.agent?.id,
    )) {
      await WorkspaceStore.deleteWorkspace(w.id, { confirmed: true });
    }
    while (gBrowser.tabs.length > 1) {
      BrowserTestUtils.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
    }
  });
  route([{ domain: "example.com", workspace: "rt-work" }]);
});

/** Closes every tab but the first, back to main. */
function tidy() {
  ww().switchTo({ id: known("main").id });
  while (gBrowser.tabs.length > 1) {
    BrowserTestUtils.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
  }
}

add_task(async function a_new_windows_first_tab_is_routed_with_the_startup_app() {
  route([
    { app: "coldapp", workspace: "rt-home" },
    { domain: "example.com", workspace: "rt-work" },
  ]);
  /**
   * A window opened with one URL, as a cold start or an external window open does.
   * @param {string} url
   */
  const openWindow = async (url) => {
    const opened = BrowserTestUtils.waitForNewWindow({ url });
    window.openDialog(AppConstants.BROWSER_CHROME_URL, "_blank", "chrome,all,dialog=no", url);
    return opened;
  };

  Services.env.set("VIMMA_FROM", "coldapp");
  WorkspaceRouter.resetStartupAppForTesting();
  // As BrowserContentHandler opens a cold start's window: its command-line URLs as an nsIArray.
  const coldList = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
  const coldUrl = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
  coldUrl.data = `${ELSEWHERE}?cold`;
  coldList.appendElement(coldUrl);
  const coldArgs = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
  coldArgs.appendElement(coldList);
  const coldOpened = BrowserTestUtils.waitForNewWindow({ url: coldUrl.data });
  Services.ww.openWindow(
    null,
    AppConstants.BROWSER_CHROME_URL,
    "_blank",
    "chrome,all,dialog=no",
    coldArgs,
  );
  const cold = await coldOpened;
  Assert.equal(
    cold.gBrowser.selectedTab.userContextId,
    home.userContextId,
    "a cold start from the app: its rule (VIMMA_FROM)",
  );
  Assert.equal(cold.gBrowser.tabs.length, 1, "in the first tab, no second one");
  Assert.equal(Services.env.get("VIMMA_FROM"), "", "the variable is read once and cleared");
  await BrowserTestUtils.closeWindow(cold);

  const later = await openWindow(`${ELSEWHERE}?later`);
  Assert.notEqual(
    later.gBrowser.selectedTab.userContextId,
    home.userContextId,
    "a later window does not get the startup app",
  );
  await BrowserTestUtils.closeWindow(later);

  // Read and cleared at once, even when the first window never asks (a private one).
  Services.env.set("VIMMA_FROM", "coldapp");
  WorkspaceRouter.resetStartupAppForTesting();
  Assert.equal(Services.env.get("VIMMA_FROM"), "", "cleared before any window asks");
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  await BrowserTestUtils.closeWindow(priv);
  const afterPrivate = await openWindow(`${ELSEWHERE}?after-private`);
  Assert.notEqual(
    afterPrivate.gBrowser.selectedTab.userContextId,
    home.userContextId,
    "the startup app is gone once a first window has started",
  );
  await BrowserTestUtils.closeWindow(afterPrivate);

  route([{ domain: "example.com", workspace: "rt-work" }]);
});

add_task(async function only_a_window_opened_for_another_programs_link_is_routed() {
  // Decision 9: a window opened inside Vimma (ctrl+n to a routed home page, a URL handed to a
  // new window) starts in the workspace shown; one opened for another program's link is routed.
  ww().switchTo({ id: home.id });
  const inside = BrowserTestUtils.waitForNewWindow({ url: `${WORK}?inside` });
  window.openDialog(
    AppConstants.BROWSER_CHROME_URL,
    "_blank",
    "chrome,all,dialog=no",
    `${WORK}?inside`,
  );
  const own = await inside;
  Assert.equal(
    own.gBrowser.selectedTab.userContextId,
    home.userContextId,
    "a window opened inside Vimma on a routed URL starts in rt-home",
  );
  await BrowserTestUtils.closeWindow(own);

  const external = await openExternalWindow(`${WORK}?external`);
  Assert.equal(
    external.gBrowser.selectedTab.userContextId,
    work.userContextId,
    "a window opened for another program's link on a routed URL starts in rt-work",
  );
  await BrowserTestUtils.closeWindow(external);
  tidy();
});

/**
 * A window opened for one URL from another program's command line, as BrowserContentHandler's
 * openBrowserWindow opens it (a cold start or an external window open: `fromExternal`).
 * @param {string} url
 */
async function openExternalWindow(url) {
  const extra = Cc["@mozilla.org/hash-property-bag;1"].createInstance(Ci.nsIWritablePropertyBag2);
  extra.setPropertyAsBool("fromExternal", true);
  const args = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
  const str = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
  str.data = url;
  args.appendElement(str);
  args.appendElement(extra);
  const opened = BrowserTestUtils.waitForNewWindow({ url });
  Services.ww.openWindow(
    null,
    AppConstants.BROWSER_CHROME_URL,
    "_blank",
    "chrome,all,dialog=no",
    args,
  );
  return opened;
}

add_task(async function the_startup_name_list_routes_the_first_tab() {
  route([{ app: "coldapp", workspace: "rt-home" }]);
  Services.env.set("VIMMA_FROM", "python3,zsh,coldapp");
  WorkspaceRouter.resetStartupAppForTesting();
  const cold = await openExternalWindow(`${ELSEWHERE}?cold-list`);
  Assert.equal(
    cold.gBrowser.selectedTab.userContextId,
    home.userContextId,
    "a cold start's name list (VIMMA_FROM) routes its first tab",
  );
  await BrowserTestUtils.closeWindow(cold);
  route([{ domain: "example.com", workspace: "rt-work" }]);
});

/** `[routing] default_workspace` as ConfigHost sets it. */
const defaultTo = (/** @type {string | null} */ name) => WorkspaceRouter.setDefaultWorkspace(name);

add_task(async function the_default_workspace_never_applies_to_the_url_bar() {
  defaultTo("rt-work");
  try {
    ww().switchTo({ id: home.id });
    const opened = nextTab();
    // What the URL bar, :open and bookmarks go through (routeLinkIn).
    window.openTrustedLinkIn(`${ELSEWHERE}?typed`, "tab");
    const tab = await opened;
    Assert.equal(tab.userContextId, home.userContextId, "what you type stays in rt-home");
    const plain = await BrowserTestUtils.openNewBrowserWindow();
    Assert.notEqual(
      plain.gBrowser.selectedTab.userContextId,
      work.userContextId,
      "a new window you open is not routed to the default",
    );
    await BrowserTestUtils.closeWindow(plain);
  } finally {
    defaultTo(null);
    tidy();
  }
});

add_task(async function a_cold_start_link_with_no_rule_opens_in_the_default_workspace() {
  defaultTo("rt-home");
  try {
    const cold = await openExternalWindow(`${ELSEWHERE}?cold-default`);
    Assert.equal(
      cold.gBrowser.selectedTab.userContextId,
      home.userContextId,
      "a window opened for another program's link: rt-home",
    );
    await BrowserTestUtils.closeWindow(cold);

    // A cold start: the first window's URL list, as BrowserContentHandler passes it.
    WorkspaceRouter.resetStartupAppForTesting();
    const list = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
    const str = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
    str.data = `${ELSEWHERE}?cold-list-default`;
    list.appendElement(str);
    const args = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
    args.appendElement(list);
    const first = BrowserTestUtils.waitForNewWindow({ url: str.data });
    Services.ww.openWindow(
      null,
      AppConstants.BROWSER_CHROME_URL,
      "_blank",
      "chrome,all,dialog=no",
      args,
    );
    const firstWin = await first;
    Assert.equal(
      firstWin.gBrowser.selectedTab.userContextId,
      home.userContextId,
      "the cold start's command-line URL: rt-home",
    );
    await BrowserTestUtils.closeWindow(firstWin);

    // A later window with a one-URL list (Places' "Open All in New Window", an extension's
    // windows.create) is not the cold start's.
    const later = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
    const laterStr = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
    laterStr.data = `${ELSEWHERE}?later-list`;
    later.appendElement(laterStr);
    const laterArgs = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
    laterArgs.appendElement(later);
    const laterOpened = BrowserTestUtils.waitForNewWindow({ url: laterStr.data });
    Services.ww.openWindow(
      null,
      AppConstants.BROWSER_CHROME_URL,
      "_blank",
      "chrome,all,dialog=no",
      laterArgs,
    );
    const laterWin = await laterOpened;
    Assert.notEqual(
      laterWin.gBrowser.selectedTab.userContextId,
      home.userContextId,
      "a later window's URL list does not take the default",
    );
    await BrowserTestUtils.closeWindow(laterWin);

    const url = `${ELSEWHERE}?own-window`;
    const own = BrowserTestUtils.waitForNewWindow({ url });
    window.openDialog(AppConstants.BROWSER_CHROME_URL, "_blank", "chrome,all,dialog=no", url);
    const w = await own;
    Assert.notEqual(
      w.gBrowser.selectedTab.userContextId,
      home.userContextId,
      "a window opened from inside Vimma does not take the default",
    );
    await BrowserTestUtils.closeWindow(w);
  } finally {
    defaultTo(null);
  }
});
