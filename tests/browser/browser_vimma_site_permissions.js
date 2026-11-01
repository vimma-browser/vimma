/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/site-permissions.md. `:site` opens a picker over the selected tab's site
// permissions, as Firefox's Page Info lists them, with each one's real state; `a` / `b` / `r`
// allow, block or reset the selected one and Enter steps through Firefox's states for it, all
// through SitePermissions. It acts only on the page it was opened for, and refuses in the agent
// workspace (docs/security.md SP1-SP3).

"use strict";

const { SitePermissions } = ChromeUtils.importESModule(
  "resource:///modules/SitePermissions.sys.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);

const PAGE = "https://example.com/";
const OTHER = "https://example.org/";
const PICKER_ID = "vimma-permission-picker";
const NOTICE_ID = "vimma-notice";

const picker = () => document.getElementById(PICKER_ID);
const isOpen = () => !!picker()?.open;
const rows = () => [...(picker()?.querySelectorAll("[role=option]") ?? [])];
const ids = () => rows().map((r) => r.dataset.id);
const selectedId = () => rows().find((r) => r.getAttribute("aria-selected") === "true")?.dataset.id;
const detail = (id) =>
  rows()
    .find((r) => r.dataset.id === id)
    ?.querySelector(".vimma-picker-host")?.textContent ?? null;
const heading = () => picker()?.querySelector("h1")?.textContent ?? "";
const noticeText = () => document.getElementById(NOTICE_ID)?.textContent ?? "";

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg, tries = 100) {
  return TestUtils.waitForCondition(cond, msg, 50, tries);
}

/** @param {string} text  a command line, without the colon */
function command(text) {
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(text);
  EventUtils.synthesizeKey("KEY_Enter");
}

async function openPicker() {
  command("site");
  await until(() => isOpen() && rows().length > 0, ":site opens the picker");
}

/** Moves the selection down to the row of `id`. */
function selectRow(id) {
  for (let i = 0; i < rows().length && selectedId() !== id; i++) EventUtils.synthesizeKey("j");
  Assert.equal(selectedId(), id, `${id} is selected`);
}

const principalOf = (url, attrs = {}) =>
  Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(url), attrs);
const stateOf = (url, id, browser = null) =>
  SitePermissions.getForPrincipal(principalOf(url), id, browser).state;
const label = (id, state) => SitePermissions.getMultichoiceStateLabel(id, state);

/** Page Info's list (pageinfo/permissions.js): labelled, not open-protocol-handler, by label. */
function pageInfoList() {
  return SitePermissions.listPermissions()
    .filter((id) => SitePermissions.getPermissionLabel(id) && id !== "open-protocol-handler")
    .sort((a, b) =>
      SitePermissions.getPermissionLabel(a).localeCompare(SitePermissions.getPermissionLabel(b)),
    );
}

function clearSites() {
  for (const url of [PAGE, OTHER]) {
    for (const id of SitePermissions.listPermissions()) {
      SitePermissions.removeFromPrincipal(principalOf(url), id);
    }
  }
}

add_task(async function setup() {
  clearSites();
  registerCleanupFunction(() => {
    clearSites();
    if (Services.prefs.prefIsLocked("permissions.default.camera")) {
      Services.prefs.unlockPref("permissions.default.camera");
    }
    // Selecting the agent's tab moved the window into the agent workspace; the next test file
    // expects the user's.
    const main = WorkspaceStore.definitions.workspaces.find((w) => w.name === "main");
    if (main) WindowWorkspaces.get(window).switchTo({ id: main.id });
    while (gBrowser.tabs.length > 1) BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
  });
});

add_task(async function test_lists_every_permission_with_its_real_state() {
  SitePermissions.setForPrincipal(principalOf(PAGE), "geo", SitePermissions.BLOCK);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await openPicker();
  Assert.ok(heading().includes("example.com"), "the heading names the site");
  Assert.deepEqual(ids(), pageInfoList(), "every permission Page Info lists, in its order");
  Assert.equal(detail("geo"), label("geo", SitePermissions.BLOCK), "a set permission: its state");
  Assert.equal(
    detail("camera"),
    `${label("camera", SitePermissions.UNKNOWN)} · default`,
    "an unset one: Firefox's default",
  );
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "Esc closes it");
  clearSites();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_keys_change_it_through_firefox_and_the_row_follows() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await openPicker();
  selectRow("camera");

  EventUtils.synthesizeKey("a");
  await until(() => stateOf(PAGE, "camera") === SitePermissions.ALLOW, "a allows");
  await until(() => detail("camera") === label("camera", SitePermissions.ALLOW), "row: Allow");
  Assert.ok(isOpen(), "the picker stays open");

  EventUtils.synthesizeKey("b");
  await until(() => stateOf(PAGE, "camera") === SitePermissions.BLOCK, "b blocks");
  await until(() => detail("camera") === label("camera", SitePermissions.BLOCK), "row: Block");

  EventUtils.synthesizeKey("r");
  await until(() => stateOf(PAGE, "camera") === SitePermissions.UNKNOWN, "r resets");
  await until(() => detail("camera").endsWith(" · default"), "row: the default");

  // Enter: the next of Firefox's states for it, after the default (Always Ask) comes Allow.
  const states = SitePermissions.getAvailableStates("camera");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => stateOf(PAGE, "camera") === states[1], "Enter steps to the next state");
  Assert.ok(isOpen(), "Enter keeps the picker open");

  Assert.equal(stateOf(OTHER, "camera"), SitePermissions.UNKNOWN, "no other site changed");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
  clearSites();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_a_state_firefox_does_not_offer_is_refused() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await openPicker();
  selectRow("screen");
  EventUtils.synthesizeKey("a");
  await until(() => noticeText().includes("cannot be set to allow"), "the refusal");
  Assert.equal(stateOf(PAGE, "screen"), SitePermissions.UNKNOWN, "screen is not allowed");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_a_locked_default_makes_the_row_read_only() {
  Services.prefs.lockPref("permissions.default.camera");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await openPicker();
  Assert.ok(detail("camera").endsWith(" · locked"), "the row says it is locked");
  selectRow("camera");
  EventUtils.synthesizeKey("a");
  await until(() => noticeText().includes("is locked"), "the refusal");
  Assert.equal(stateOf(PAGE, "camera"), SitePermissions.UNKNOWN, "nothing allowed");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
  Services.prefs.unlockPref("permissions.default.camera");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_acts_only_on_the_page_it_was_opened_for() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await openPicker();
  selectRow("camera");
  // The tab goes to another site while the picker is open (a redirect, a script).
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, OTHER);
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, OTHER);
  await loaded;
  EventUtils.synthesizeKey("a");
  await until(() => noticeText().includes("the page changed"), "the refusal");
  await until(() => !isOpen(), "the picker closes");
  Assert.equal(stateOf(PAGE, "camera"), SitePermissions.UNKNOWN, "the old site got nothing");
  Assert.equal(stateOf(OTHER, "camera"), SitePermissions.UNKNOWN, "the new site got nothing");

  // Another tab selected: the picker closes.
  await openPicker();
  const other = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await until(() => !isOpen(), "a tab switch closes the picker");
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_a_page_without_site_permissions_says_so() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  command("site");
  await until(() => noticeText().includes("this page has no site permissions"), "the notice");
  Assert.ok(!isOpen(), "no picker");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_the_agent_workspace_refuses_and_grants_nothing() {
  const agent = /** @type {any} */ (WorkspaceStore.agent);
  Assert.ok(agent?.userContextId > 0, "the agent workspace has its container");
  const tab = BrowserTestUtils.addTab(gBrowser, PAGE, { userContextId: agent.userContextId });
  gBrowser.selectedTab = tab;
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  command("site");
  await until(
    () => noticeText().includes("site permissions are not changed in the agent workspace"),
    "the refusal",
  );
  Assert.ok(!isOpen(), "no picker");
  const principal = tab.linkedBrowser.contentPrincipal;
  Assert.equal(
    SitePermissions.getForPrincipal(principal, "camera").state,
    SitePermissions.UNKNOWN,
    "nothing granted",
  );
  BrowserTestUtils.removeTab(tab);
});
