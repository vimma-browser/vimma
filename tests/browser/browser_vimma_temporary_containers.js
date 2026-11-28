/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/temporary-containers.md, Delivery 1: `:tmp` opens a tab in a new temporary
// container in the current workspace; what its page opens joins it, what the user opens is the
// workspace's; its last close deletes the container and its site data; a crash's leftovers go at
// the next start; moving one, and opening one in the agent or private workspace, is refused;
// links from other apps never land in one; `vimma-ctl state` marks them and agents never see one.

"use strict";

/* global focusContent -- from head.js */
/* global add_setup -- the browser-chrome harness (browser-test.js) */

const { WorkspaceStore, WorkspaceStoreImpl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { WorkspaceRouter } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceRouter.sys.mjs",
);
const WorkspaceOps = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/workspace-ops.mjs",
);
/** `:tmp`'s action, as the host runs it. @param {BrowserWindow} win @returns {string | null} */
const openTemporaryTab = (win) => WorkspaceOps.openTemporaryTab(win);
const { agentTabs, agentWorkspace } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/agent-tabs.mjs",
);
const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
);
const { ContextualIdentityService: CIS } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
);

const { BrowserWindowTracker } = ChromeUtils.importESModule(
  "resource:///modules/BrowserWindowTracker.sys.mjs",
);
const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
);

const FEATURE = "vimma.feature.temporary_containers";
const SITE = "https://example.com/";
const NOTICE_ID = "vimma-notice";

const ww = () => /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(window));
const mainDef = () =>
  /** @type {ContainedWorkspace} */ (
    WorkspaceStore.definitions.workspaces.find(
      (/** @type {WorkspaceDefinition} */ w) => w.name === "main",
    )
  );
const noticeText = () => document.getElementById(NOTICE_ID)?.textContent ?? "";

/** @type {string[]} */
const files = [];

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [
      [FEATURE, true],
      // window.open from a spawned script has no user gesture.
      ["dom.disable_open_during_load", false],
    ],
  });
  registerCleanupFunction(async () => {
    ww().switchTo({ id: mainDef().id });
    while (gBrowser.tabs.length > 1) {
      BrowserTestUtils.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
    }
    for (const f of files) await IOUtils.remove(f, { ignoreAbsent: true });
  });
});

/** @param {() => unknown} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/** `:line` Enter, from the selected page in normal mode. @param {string} line */
async function runCommand(line) {
  const browser = gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the selected page has loaded");
  await focusContent(browser);
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
}

/** A loaded tab of the main workspace, selected. */
async function workspaceTab(url = SITE) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  Assert.equal(tab.userContextId, mainDef().userContextId, "a tab of main's container");
  return tab;
}

/** Runs `:tmp [text]` and returns the new temporary tab once it has loaded `url`. */
async function tmp(text = "", url = "") {
  const before = gBrowser.selectedTab;
  await runCommand(text ? `tmp ${text}` : "tmp");
  await until(() => gBrowser.selectedTab !== before, ":tmp selected a new tab");
  const tab = gBrowser.selectedTab;
  if (url) await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  return tab;
}

const tabsOf = (/** @type {number} */ ucid) =>
  gBrowser.tabs.filter((t) => t.userContextId === ucid && !t.closing);

const cookieCount = (/** @type {number} */ userContextId) =>
  Services.cookies.getCookiesWithOriginAttributes(JSON.stringify({ userContextId }), "example.com")
    .length;

/** Sets a cookie from the page of `tab`. @param {MozTabbrowserTab} tab @param {string} name */
function pageCookie(tab, name) {
  return SpecialPowers.spawn(tab.linkedBrowser, [name], (n) => {
    content.document.cookie = `${n}=1; Secure; SameSite=None; Path=/`;
  });
}

/** @param {MozTabbrowserTab} tab */
function pageCookies(tab) {
  return SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.cookie);
}

const closedOf = (/** @type {number} */ ucid) =>
  SessionStore.getClosedTabDataForWindow(window).filter((t) => t.state?.userContextId === ucid);

add_task(async function tmp_does_not_exist_while_the_feature_is_off() {
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
  try {
    const tab = await workspaceTab();
    const count = gBrowser.tabs.length;
    await runCommand("tmp");
    const error = () =>
      document.querySelector("#vimma-cmdline .vimma-cmdline-error")?.textContent ?? "";
    await until(() => error().startsWith('not a command: "tmp"'), "the command line says so");
    EventUtils.synthesizeKey("KEY_Escape");
    Assert.equal(gBrowser.tabs.length, count, "no tab opened");
    Assert.equal(openTemporaryTab(window), 'not a command: "tmp"', "the action refuses too");
    Assert.equal(gBrowser.tabs.length, count, "still no tab");
    BrowserTestUtils.removeTab(tab);
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function tmp_opens_a_tab_in_a_new_container_in_the_current_workspace() {
  const home = await workspaceTab();
  const tab = await tmp();
  const ucid = tab.userContextId;
  Assert.ok(ucid > 0, "in a container");
  Assert.notEqual(ucid, mainDef().userContextId, "not the workspace's");
  Assert.ok(
    !WorkspaceStore.definitions.workspaces.some(
      (/** @type {WorkspaceDefinition} */ w) => w.userContextId === ucid,
    ),
    "no workspace's container",
  );
  Assert.ok(CIS.getPublicIdentityFromId(ucid), "a real Firefox container");
  Assert.ok(WorkspaceStore.isTemporaryContainer(ucid), "recorded as temporary");
  Assert.ok(ww().isTemporary(tab), "the window knows it is temporary");
  Assert.ok(!ww().isForeign(tab), "not a foreign tab");
  const w = ww().model.workspaces.find((x) => x.id === mainDef().id);
  Assert.ok(w?.tabs.includes(ww().idOf(tab)), "in the workspace it was opened in");
  Assert.equal(ww().model.active, mainDef().id, "which stays shown");
  Assert.ok(!tab.hidden, "and the tab is visible");

  const second = await tmp();
  Assert.notEqual(second.userContextId, ucid, "a second :tmp makes a second container");
  BrowserTestUtils.removeTab(second);
  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(home);
});

add_task(async function tmp_with_text_opens_that_page_in_it() {
  const home = await workspaceTab();
  const tab = await tmp(SITE, SITE);
  Assert.equal(tab.linkedBrowser.currentURI.spec, SITE, "the page loaded");
  Assert.ok(WorkspaceStore.isTemporaryContainer(tab.userContextId), "in a temporary container");
  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(home);
});

add_task(async function a_cookie_set_in_a_temporary_tab_is_not_seen_by_the_workspace_and_back() {
  const home = await workspaceTab();
  await pageCookie(home, "signedin");
  const tab = await tmp(SITE, SITE);
  Assert.equal(await pageCookies(tab), "", "the temporary tab sees none of the workspace's");
  await pageCookie(tab, "throwaway");
  Assert.equal(await pageCookies(home), "signedin=1", "the workspace sees none of its cookies");
  Assert.equal(await pageCookies(tab), "throwaway=1", "it keeps its own");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.spawn(home.linkedBrowser, [], () => {
    content.document.cookie = "signedin=; Max-Age=0; Secure; SameSite=None; Path=/";
  });
  BrowserTestUtils.removeTab(home);
});

add_task(async function a_popup_from_a_temporary_tab_shares_its_container() {
  const home = await workspaceTab();
  const tab = await tmp(SITE, SITE);
  const ucid = tab.userContextId;
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, `${SITE}?child`, true);
  await SpecialPowers.spawn(tab.linkedBrowser, [`${SITE}?child`], (url) => {
    content.open(url);
  });
  const child = await opened;
  Assert.equal(child.userContextId, ucid, "a tab its page opens joins its container");
  Assert.ok(ww().isTemporary(child), "and is temporary");

  const popupOpened = BrowserTestUtils.waitForNewWindow({ url: `${SITE}?popup` });
  await SpecialPowers.spawn(tab.linkedBrowser, [`${SITE}?popup`], (url) => {
    content.open(url, "", "popup,width=300,height=300");
  });
  const popup = await popupOpened;
  Assert.equal(popup.gBrowser.selectedTab.userContextId, ucid, "so does a pop-up window");

  // The container stays while any of its tabs is open, in any window.
  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(child);
  await new Promise((r) => setTimeout(r, 500));
  Assert.ok(CIS.getPublicIdentityFromId(ucid), "the pop-up keeps the container");
  await BrowserTestUtils.closeWindow(popup);
  await until(() => !CIS.getPublicIdentityFromId(ucid), "closing the pop-up deletes it");
  BrowserTestUtils.removeTab(home);
});

add_task(async function closing_the_last_temporary_tab_removes_the_container_and_its_cookies() {
  const home = await workspaceTab();
  const tab = await tmp(SITE, SITE);
  const ucid = tab.userContextId;
  await pageCookie(tab, "throwaway");
  Assert.equal(cookieCount(ucid), 1, "the temporary container has a cookie");
  BrowserTestUtils.removeTab(tab);
  await until(() => !CIS.getPublicIdentityFromId(ucid), "the container is deleted");
  Assert.equal(cookieCount(ucid), 0, "with its cookies");
  Assert.ok(!WorkspaceStore.isTemporaryContainer(ucid), "and no longer recorded");
  // Late session updates from the closed tab must not put it back in the closed-tab list.
  await new Promise((r) => setTimeout(r, 1000));
  Assert.deepEqual(closedOf(ucid), [], "undo-close-tab cannot bring it back");
  Assert.ok(CIS.getPublicIdentityFromId(mainDef().userContextId), "main's container stays");
  BrowserTestUtils.removeTab(home);
});

add_task(async function a_new_tab_from_a_temporary_tab_takes_the_workspace_container() {
  const home = await workspaceTab();
  const tab = await tmp(SITE, SITE);
  const main = mainDef().userContextId;

  let opened = BrowserTestUtils.waitForNewTab(gBrowser);
  await focusContent(tab.linkedBrowser);
  EventUtils.synthesizeKey("t", { ctrlKey: true });
  let fresh = await opened;
  Assert.equal(fresh.userContextId, main, "ctrl+t opens in the workspace's container");
  BrowserTestUtils.removeTab(fresh);

  gBrowser.selectedTab = tab;
  opened = BrowserTestUtils.waitForNewTab(gBrowser, `${SITE}?new`);
  await runCommand(`tabnew ${SITE}?new`);
  fresh = await opened;
  Assert.equal(fresh.userContextId, main, ":tabnew opens in the workspace's container");
  BrowserTestUtils.removeTab(fresh);

  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(home);
});

add_task(async function a_temporary_tab_cannot_move_workspace() {
  const home = await workspaceTab();
  const other = WorkspaceStore.newWorkspace("tmp-target");
  try {
    const tab = await tmp(SITE, SITE);
    await runCommand("wsmove tmp-target");
    await until(() => noticeText().includes("stays in its workspace"), "the move is refused");
    Assert.equal(
      noticeText(),
      "a temporary tab stays in its workspace: open it again with :tmp there",
      "with the spec's text",
    );
    Assert.ok(tab.isConnected && !tab.closing, "the tab stays open");
    Assert.ok(WorkspaceStore.isTemporaryContainer(tab.userContextId), "in its container");
    Assert.equal(
      ww().moveTab(tab, { id: other.id }),
      "a temporary tab stays in its workspace: open it again with :tmp there",
      "WindowWorkspaces refuses every move of it, whatever asks",
    );
    BrowserTestUtils.removeTab(tab);
  } finally {
    await WorkspaceStore.deleteWorkspace(other.id, { confirmed: true });
    BrowserTestUtils.removeTab(home);
  }
});

const PICKER_ID = "vimma-workspace-picker";
const PANEL_ID = "vimma-panel";
const PROMPT_ID = "vimma-rename";
const pickerOpen = () =>
  !!(/** @type {HTMLDialogElement | null} */ (document.getElementById(PICKER_ID))?.open);
const pickerRowCount = () =>
  document.getElementById(PICKER_ID)?.querySelectorAll(".vimma-picker-row").length ?? 0;
const panelOpen = () => document.getElementById(PANEL_ID)?.hidden === false;
const promptOpen = () => document.getElementById(PROMPT_ID)?.hidden === false;

/** ctrl+b `key`. @param {string} key */
function prefix(key) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key);
}

/** In the open workspace picker, down to its last row: the private workspace's. */
async function toPrivateRow() {
  await until(() => pickerOpen() && pickerRowCount() > 1, "the workspace picker is open");
  for (let i = 0; i < pickerRowCount(); i++) EventUtils.synthesizeKey("j");
}

/**
 * The refusal of a move into the private workspace, before the y/N: the URL of a throwaway
 * session never reaches the private window, and no tab is left in its container.
 * @param {MozTabbrowserTab} tab
 */
async function refusedIntoPrivate(tab) {
  await until(() => noticeText().includes("stays in its workspace"), "the move is refused");
  Assert.equal(
    noticeText(),
    "a temporary tab stays in its workspace: open it again with :tmp there",
    "with the spec's text",
  );
  Assert.ok(!promptOpen(), "before the y/N");
  Assert.ok(tab.isConnected && !tab.closing, "the tab stays open");
  Assert.ok(
    !BrowserWindowTracker.orderedWindows.some((w) => PrivateBrowsingUtils.isWindowPrivate(w)),
    "no private window opened",
  );
}

add_task(async function a_temporary_tab_cannot_move_into_the_private_workspace() {
  const home = await workspaceTab();
  try {
    const tab = await tmp(SITE, SITE);
    // An earlier task's refusal may still show.
    document.getElementById(NOTICE_ID)?.replaceChildren();
    await focusContent(tab.linkedBrowser);
    // The workspace picker's m on the private row.
    prefix("w");
    await toPrivateRow();
    EventUtils.synthesizeKey("m");
    await refusedIntoPrivate(tab);
    if (pickerOpen()) EventUtils.synthesizeKey("KEY_Escape");
    await until(() => !pickerOpen(), "the picker closed");

    // The side panel's m on the tab's row, then the private row.
    document.getElementById(NOTICE_ID)?.replaceChildren();
    await focusContent(tab.linkedBrowser);
    prefix("b");
    await until(panelOpen, "the side panel is open");
    EventUtils.synthesizeKey("m");
    await toPrivateRow();
    EventUtils.synthesizeKey("KEY_Enter");
    await refusedIntoPrivate(tab);
    if (pickerOpen()) EventUtils.synthesizeKey("KEY_Escape");
    BrowserTestUtils.removeTab(tab);
  } finally {
    BrowserTestUtils.removeTab(home);
  }
});

// Delivery 2 (decision 16): numbered text markers in the tab line, the side panel, the status
// bar and the workspace picker, in a theme colour of their own.
const segment = (/** @type {string} */ id) =>
  /** @type {HTMLElement | null} */ (
    document.getElementById("vimma-statusbar")?.querySelector(`[data-segment="${id}"]`) ?? null
  );
/** The tab line's entry of `tab`, by its number in the workspace. @param {MozTabbrowserTab} tab */
const lineEntry = (tab) =>
  document
    .getElementById("vimma-tabline")
    ?.querySelector(`.vimma-tabline-tab[data-number="${gBrowser.visibleTabs.indexOf(tab) + 1}"]`);
/** @param {MozTabbrowserTab} tab */
const lineMarker = (tab) => lineEntry(tab)?.querySelector(".vimma-tabline-temporary")?.textContent;
/** @param {MozTabbrowserTab} tab */
const panelMarker = (tab) =>
  document
    .getElementById(PANEL_ID)
    ?.querySelector(`.vimma-panel-row:nth-child(${gBrowser.visibleTabs.indexOf(tab) + 1})`)
    ?.querySelector(".vimma-panel-temporary")?.textContent;
const pickerRowTexts = () =>
  [...(document.getElementById(PICKER_ID)?.querySelectorAll(".vimma-picker-row") ?? [])].map(
    (r) => r.textContent ?? "",
  );

add_task(async function markers_number_temporary_tabs_in_the_bar_line_panel_and_picker() {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.ui.tabline", "always"]] });
  const home = await workspaceTab();
  try {
    const a = await tmp(SITE, SITE);
    const b = await tmp(SITE, SITE);

    await until(() => segment("temporary")?.textContent?.startsWith("◇ tmp2"), "the bar: ◇ tmp2");
    const seg = /** @type {HTMLElement} */ (segment("temporary"));
    Assert.equal(seg.style.color, "var(--vimma-text-bright-green)", "in its own colour");
    Assert.equal(
      seg.querySelector(".vimma-sb-sr")?.textContent,
      "temporary container tmp2",
      "read in words",
    );
    await until(() => lineMarker(a) === "tmp1" && lineMarker(b) === "tmp2", "the line: tmp1, tmp2");
    Assert.equal(lineMarker(home), undefined, "no marker on a workspace tab");

    await focusContent(b.linkedBrowser);
    prefix("b");
    await until(panelOpen, "the side panel is open");
    await until(() => panelMarker(a) === "tmp1" && panelMarker(b) === "tmp2", "the panel: tmp1/2");
    Assert.equal(panelMarker(home), undefined, "no marker on a workspace tab's row");
    EventUtils.synthesizeKey("KEY_Escape");
    await until(() => !panelOpen(), "the side panel closed");

    await focusContent(b.linkedBrowser);
    prefix("w");
    await until(() => pickerOpen() && pickerRowCount() > 0, "the workspace picker is open");
    Assert.ok(
      pickerRowTexts().some((t) => t.includes("main") && t.includes(", 2 temporary")),
      `main's row counts 2 temporary: ${JSON.stringify(pickerRowTexts())}`,
    );
    EventUtils.synthesizeKey("KEY_Escape");
    await until(() => !pickerOpen(), "the picker closed");

    gBrowser.selectedTab = home;
    await until(() => !segment("temporary"), "no temporary segment on a workspace tab");

    // A closed container's number is free again; an open one's stays with it.
    BrowserTestUtils.removeTab(a);
    gBrowser.selectedTab = b;
    const c = await tmp(SITE, SITE);
    await until(
      () => lineMarker(c) === "tmp1" && lineMarker(b) === "tmp2",
      "tmp1 again, tmp2 kept",
    );
    BrowserTestUtils.removeTab(c);
    BrowserTestUtils.removeTab(b);
  } finally {
    BrowserTestUtils.removeTab(home);
  }
});

add_task(async function tmp_refuses_javascript_and_data_urls() {
  const count = gBrowser.tabs.length;
  const containers = CIS.getPublicIdentities().length;
  for (const text of ["javascript:alert(1)", " data:text/html,<p>x</p>"]) {
    Assert.equal(
      WorkspaceOps.openTemporaryTab(window, text),
      "blocked: javascript: and data: URLs can't be opened from the command line",
      `${text.trim()} is refused, as :open refuses it`,
    );
  }
  Assert.equal(gBrowser.tabs.length, count, "no tab opened");
  Assert.equal(CIS.getPublicIdentities().length, containers, "and no container made");
});

add_task(async function tmp_is_refused_in_the_agent_workspace() {
  const agent = /** @type {ContainedWorkspace} */ (WorkspaceStore.agent);
  ww().switchTo({ id: agent.id });
  try {
    const count = gBrowser.tabs.length;
    Assert.equal(
      openTemporaryTab(window),
      "no temporary containers in the agent workspace",
      "refused with the spec's text",
    );
    Assert.equal(gBrowser.tabs.length, count, "no tab opened");
  } finally {
    ww().switchTo({ id: mainDef().id });
  }
});

add_task(async function tmp_is_refused_in_the_private_workspace() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    const count = win.gBrowser.tabs.length;
    Assert.equal(
      openTemporaryTab(win),
      "the private workspace is discarded when it closes already",
      "refused with the spec's text",
    );
    Assert.equal(win.gBrowser.tabs.length, count, "no tab opened");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});

add_task(async function an_external_link_never_lands_in_a_temporary_container() {
  const home = await workspaceTab();
  const tab = await tmp(`${SITE}?ext`, `${SITE}?ext`);
  const uri = Services.io.newURI(`${SITE}?ext`);
  // Firefox's guess picks the container of a visible tab showing the site: here, only the
  // temporary one does.
  Assert.equal(
    WorkspaceRouter.externalUserContextId(uri, window, true),
    mainDef().userContextId,
    "the link takes the workspace's container",
  );
  const { OPEN_CURRENTWINDOW, OPEN_NEWTAB } = Ci.nsIBrowserDOMWindow;
  Assert.equal(
    WorkspaceRouter.externalWhere(OPEN_CURRENTWINDOW, window),
    OPEN_NEWTAB,
    "and never loads in the temporary tab that is selected",
  );
  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(home);
});

add_task(async function ctl_state_marks_temporary_tabs() {
  const home = await workspaceTab(`${SITE}?ws`);
  const tab = await tmp(`${SITE}?tmp`, `${SITE}?tmp`);
  const state = VimmaControl._commands.state();
  const listed = /** @type {{ url: string, temporary?: boolean }[]} */ (state.tabs);
  const temp = listed.find((t) => t.url === `${SITE}?tmp`);
  const ws = listed.find((t) => t.url === `${SITE}?ws`);
  Assert.strictEqual(temp?.temporary, true, "the temporary tab is listed temporary: true");
  Assert.ok(ws && !("temporary" in ws), "a workspace tab has no temporary field");
  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(home);
});

add_task(async function agent_tabs_list_no_temporary_tab() {
  const home = await workspaceTab();
  const tab = await tmp(SITE, SITE);
  const listed = agentTabs(agentWorkspace(), 1).map((/** @type {{ tab: unknown }} */ r) => r.tab);
  Assert.ok(!listed.includes(tab), "agents never see a temporary tab");
  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(home);
});

/** A fresh definitions path in the profile, removed at the end. */
function freshPath() {
  const path = PathUtils.join(PathUtils.profileDir, `vimma-tmp-test-${files.length}.json`);
  files.push(path, `${path}.bak`, `${path}.tmp`);
  return path;
}

/** Writes a definitions file recording `temporary`. @param {object[]} temporary */
async function fileRecording(temporary) {
  const path = freshPath();
  await IOUtils.writeJSON(path, { schema: 1, lastActive: null, workspaces: [], temporary });
  return path;
}

/** A cookie in container `userContextId`. @param {number} userContextId */
function setCookie(userContextId) {
  Services.cookies.add(
    "example.com",
    "/",
    "left",
    "1",
    true,
    false,
    false,
    Date.now() + 86400000,
    { userContextId },
    Ci.nsICookie.SAMESITE_NONE,
    Ci.nsICookie.SCHEME_HTTPS,
  );
}

add_task(async function a_recorded_container_left_by_a_crash_is_removed_at_startup() {
  const name = "vimma temporary 0badc0de";
  const { userContextId } = CIS.create(name, "fence", "toolbar");
  setCookie(userContextId);
  const path = await fileRecording([{ userContextId, name }]);
  const store = new WorkspaceStoreImpl({ path });
  await store.init();
  Assert.ok(!CIS.getPublicIdentityFromId(userContextId), "the container is deleted");
  Assert.equal(cookieCount(userContextId), 0, "with its cookies");
  await store.finalize();
  const onDisk = await IOUtils.readJSON(path);
  Assert.ok(!("temporary" in onDisk), "the file no longer records it");
  for (const w of store.definitions.workspaces) {
    if (w.userContextId) CIS.remove(w.userContextId);
  }
});

add_task(async function a_renamed_recorded_container_is_kept() {
  const name = "vimma temporary 5eed";
  const { userContextId } = CIS.create(name, "fence", "toolbar");
  CIS.update(userContextId, "bank", "dollar", "green");
  setCookie(userContextId);
  const path = await fileRecording([{ userContextId, name }]);
  const store = new WorkspaceStoreImpl({ path });
  await store.init();
  Assert.equal(CIS.getPublicIdentityFromId(userContextId)?.name, "bank", "the container stays");
  Assert.equal(cookieCount(userContextId), 1, "with its cookies");
  await store.finalize();
  Assert.ok(!("temporary" in (await IOUtils.readJSON(path))), "and is no longer recorded");
  for (const w of store.definitions.workspaces) {
    if (w.userContextId) CIS.remove(w.userContextId);
  }
  CIS.remove(userContextId);
});

add_task(async function a_temporary_tab_restored_into_a_deleted_container_is_closed() {
  const home = await workspaceTab();
  // What session restore brings back after a quit: a tab of a recorded container, which the
  // startup cleanup deletes.
  const name = "vimma temporary feed";
  const { userContextId } = CIS.create(name, "fence", "toolbar");
  const restored = BrowserTestUtils.addTab(gBrowser, `${SITE}?restored`, { userContextId });
  await BrowserTestUtils.browserLoaded(restored.linkedBrowser);
  setCookie(userContextId);
  WorkspaceStore.cleanTemporary([{ userContextId, name }]);
  await until(() => !restored.isConnected, "the restored tab is closed");
  Assert.ok(!CIS.getPublicIdentityFromId(userContextId), "its container is gone");
  await until(() => cookieCount(userContextId) === 0, "and what it stored meanwhile");
  await new Promise((r) => setTimeout(r, 500));
  Assert.deepEqual(closedOf(userContextId), [], "it is not in the recently closed tabs");
  Assert.equal(tabsOf(userContextId).length, 0, "no tab of it is left");
  BrowserTestUtils.removeTab(home);
});
