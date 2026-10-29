/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m3-workspaces.md, sub-spec 2a (m3-workspace-routing): gate 1 (a login in one
// workspace is invisible in another) and the routing of new tabs and windows into the active
// workspace's container (Tabbrowser-sys-mjs.patch, decision 3).

"use strict";

const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
);

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = `${ROOT}file_vimma_cookie.html`;
const system = () => Services.scriptSecurityManager.getSystemPrincipal();

/** The workspace the app starts with when nothing is configured. */
const main = () => WorkspaceStore.definitions.workspaces.find((w) => w.name === "main");

/** @type {string[]} */
const created = [];
/** @param {string} name */
function workspace(name) {
  const w = WorkspaceStore.addWorkspace({ name, color: "blue", icon: "briefcase" });
  created.push(w.id);
  return w;
}

registerCleanupFunction(async () => {
  WorkspaceStore.setActive(window, main().id);
  // Deleting a workspace removes its container, which clears its cookies and storage.
  for (const id of created) await WorkspaceStore.deleteWorkspace(id, { confirmed: true });
  while (gBrowser.tabs.length > 1) BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
});

const cookiesIn = (/** @type {number} */ userContextId) =>
  Services.cookies
    .getCookiesWithOriginAttributes(JSON.stringify({ userContextId }), "example.com")
    .map((c) => `${c.name}=${c.value}`);

/** @param {MozTabbrowserTab} tab @returns {Promise<[string, string | null]>} */
const pageSees = (tab) =>
  SpecialPowers.spawn(tab.linkedBrowser, [], () => [
    content.document.cookie,
    content.localStorage.getItem("session"),
  ]);

/** Resolves with the next tab opened in `win`. */
const nextTab = (win = window) =>
  BrowserTestUtils.waitForEvent(win.gBrowser.tabContainer, "TabOpen").then((e) => e.target);

add_task(async function startup_wires_the_store_and_new_tabs_land_in_main() {
  Assert.ok(main(), "the store was started at startup with its default workspace, main");
  Assert.ok(main().userContextId > 0, "main has a container of its own");
  // ctrl+t is Vimma's new_tab on every platform; cmd+t, accel on a Mac, is off there (#385).
  const opened = nextTab();
  EventUtils.synthesizeKey("t", { ctrlKey: true });
  const tab = await opened;
  Assert.equal(tab.userContextId, main().userContextId, "ctrl+t opens in main's container");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function gate1_a_login_in_one_workspace_is_invisible_in_another() {
  const work = workspace("routing-work");
  const personal = workspace("routing-personal");

  WorkspaceStore.setActive(window, work.id);
  const workTab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?set=work`);
  Assert.equal(workTab.userContextId, work.userContextId, "the work tab is in work's container");
  Assert.deepEqual(await pageSees(workTab), ["session=work", "work"], "signed in, in work");

  WorkspaceStore.setActive(window, personal.id);
  const personalTab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  Assert.equal(
    personalTab.userContextId,
    personal.userContextId,
    "the same site in personal is in personal's container",
  );
  Assert.deepEqual(await pageSees(personalTab), ["", null], "personal sees no cookie or storage");
  Assert.deepEqual(cookiesIn(work.userContextId), ["session=work"], "the cookie is under work");
  Assert.deepEqual(cookiesIn(personal.userContextId), [], "and not under personal");

  WorkspaceStore.setActive(window, work.id);
  gBrowser.selectedTab = workTab;
  Assert.deepEqual(await pageSees(workTab), ["session=work", "work"], "work still sees both");
  BrowserTestUtils.removeTab(personalTab);
  BrowserTestUtils.removeTab(workTab);
});

add_task(async function new_tabs_without_a_container_take_the_active_workspaces() {
  const work = workspace("routing-tabs");
  WorkspaceStore.setActive(window, work.id);

  let opened = nextTab();
  EventUtils.synthesizeKey("t", { ctrlKey: true });
  const ctrlT = await opened;
  Assert.equal(ctrlT.userContextId, work.userContextId, "ctrl+t");

  // An external link (another app): no opener, no referrer.
  opened = nextTab();
  window.browserDOMWindow.openURI(
    Services.io.newURI(`${PAGE}?from=external`),
    null,
    Ci.nsIBrowserDOMWindow.OPEN_NEWTAB,
    Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL,
    system(),
  );
  const external = await opened;
  Assert.equal(external.userContextId, work.userContextId, "an external link");

  const lazy = gBrowser.addTab(`${PAGE}?from=lazy`, {
    createLazyBrowser: true,
    triggeringPrincipal: system(),
  });
  Assert.equal(lazy.userContextId, work.userContextId, "a lazy background tab");
  Assert.equal(
    JSON.parse(SessionStore.getTabState(lazy)).userContextId,
    work.userContextId,
    "and its saved state, which it restores into",
  );

  for (const tab of [ctrlT, external, lazy]) BrowserTestUtils.removeTab(tab);
});

add_task(async function a_new_windows_first_tab_takes_the_active_workspaces() {
  const work = workspace("routing-window");
  WorkspaceStore.setActive(window, work.id);
  const win = await BrowserTestUtils.openNewBrowserWindow();
  Assert.equal(
    win.gBrowser.selectedTab.userContextId,
    work.userContextId,
    "the first tab of a window opened from a work window is in work's container",
  );
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function an_opener_or_an_explicit_container_wins() {
  const work = workspace("routing-opener");
  const personal = workspace("routing-explicit");
  WorkspaceStore.setActive(window, personal.id);
  // Pinning dismisses a promo, which the harness reports as a changed pref.
  await SpecialPowers.pushPrefEnv({
    set: [["sidebar.verticalTabs.dragToPinPromo.dismissed", true]],
  });

  // A page of work's, opened while personal is active: its links stay in work.
  const page = BrowserTestUtils.addTab(gBrowser, PAGE, { userContextId: work.userContextId });
  gBrowser.selectedTab = page;
  await BrowserTestUtils.browserLoaded(page.linkedBrowser);
  Assert.equal(page.userContextId, work.userContextId, "an explicit container wins");
  const opened = nextTab();
  await BrowserTestUtils.synthesizeMouseAtCenter("#link", {}, page.linkedBrowser);
  const fromLink = await opened;
  Assert.equal(fromLink.userContextId, work.userContextId, "a link keeps its page's container");
  // What an extension or a caller with no container does: related to the page, nothing given.
  const related = gBrowser.addTab(`${PAGE}?from=related`, {
    relatedToCurrent: true,
    triggeringPrincipal: system(),
  });
  Assert.equal(related.userContextId, work.userContextId, "a tab opened from it, too");

  const none = gBrowser.addTab(PAGE, { userContextId: 0, triggeringPrincipal: system() });
  Assert.equal(none.userContextId, 0, "an explicit no-container stays 0");

  const pinned = gBrowser.addTab(PAGE, { pinned: true, triggeringPrincipal: system() });
  Assert.equal(pinned.userContextId, 0, "a tab opened pinned is left to upstream");

  for (const tab of [fromLink, related, page, none, pinned]) BrowserTestUtils.removeTab(tab);
});

/**
 * Waits for a new window whose tabs include one on `url`, and returns the window.
 * @param {() => unknown} open @param {string} url
 */
async function windowOpenedOn(open, url) {
  const opened = BrowserTestUtils.waitForNewWindow();
  open();
  const win = await opened;
  await TestUtils.waitForCondition(
    () => win.gBrowser.tabs.some((t) => t.linkedBrowser.currentURI.spec == url),
    `a tab on ${url}`,
  );
  return win;
}

/** @param {Window} win */
const containersOf = (win) => win.gBrowser.tabs.map((t) => t.userContextId);

add_task(async function open_link_in_new_window_keeps_the_pages_container() {
  const work = workspace("routing-ctx-page");
  const personal = workspace("routing-ctx-active");
  WorkspaceStore.setActive(window, personal.id);
  const page = BrowserTestUtils.addTab(gBrowser, PAGE, { userContextId: work.userContextId });
  gBrowser.selectedTab = page;
  await BrowserTestUtils.browserLoaded(page.linkedBrowser);

  const menu = document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#link",
    { type: "contextmenu", button: 2 },
    page.linkedBrowser,
  );
  await shown;
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  const url = new URL("file_vimma_cookie.html?from=link", PAGE).href;
  const win = await windowOpenedOn(
    () => menu.activateItem(document.getElementById("context-openlink")),
    url,
  );
  await hidden;
  Assert.deepEqual(
    containersOf(win),
    [work.userContextId],
    "Open Link in New Window: one tab, in the page's container, not the active workspace's",
  );
  await BrowserTestUtils.closeWindow(win);
  BrowserTestUtils.removeTab(page);
});

add_task(async function a_bookmark_or_typed_url_in_a_new_window_takes_the_workspaces() {
  const work = workspace("routing-bookmark");
  WorkspaceStore.setActive(window, work.id);
  const url = `${PAGE}?from=bookmark`;
  // What bookmark and URL-bar "open in new window" do: a trusted openLinkIn, no container.
  const win = await windowOpenedOn(() => window.openTrustedLinkIn(url, "window"), url);
  Assert.deepEqual(containersOf(win), [work.userContextId], "one tab, in work's container");
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function an_external_link_in_a_new_window_opens_one_tab_in_the_workspace() {
  const work = workspace("routing-external-window");
  WorkspaceStore.setActive(window, work.id);
  const url = `${PAGE}?from=external-window`;
  const win = await windowOpenedOn(
    () =>
      window.browserDOMWindow.openURI(
        Services.io.newURI(url),
        null,
        Ci.nsIBrowserDOMWindow.OPEN_NEWWINDOW,
        Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL,
        system(),
      ),
    url,
  );
  Assert.deepEqual(containersOf(win), [work.userContextId], "one tab, in work's container");
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function the_active_container_is_cached_for_the_next_start() {
  const work = workspace("routing-cache");
  WorkspaceStore.setActive(window, work.id);
  Assert.equal(
    Services.prefs.getIntPref("vimma.workspaces.startupUserContextId", 0),
    work.userContextId,
    "the next start routes its first tab without reading the file synchronously",
  );
});

add_task(async function private_windows_are_untouched() {
  const work = workspace("routing-private");
  WorkspaceStore.setActive(window, work.id);
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  Assert.equal(win.gBrowser.selectedTab.userContextId, 0, "a private window's first tab");
  const tab = win.gBrowser.addTab(PAGE, { triggeringPrincipal: system() });
  Assert.equal(tab.userContextId, 0, "and its new tabs");
  await BrowserTestUtils.closeWindow(win);
});
