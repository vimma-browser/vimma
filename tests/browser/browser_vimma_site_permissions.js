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

const { AGENT_DENIED_PERMISSIONS } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentPages.sys.mjs",
);

const PAGE = "https://example.com/";
const OTHER = "https://example.org/";
const PICKER_ID = "vimma-permission-picker";
const NOTICE_ID = "vimma-notice";

/**
 * A value the test's own lookup found. It changes nothing at run time: a read through a missing
 * one throws, as it did before.
 * @template T
 * @param {T | null | undefined} value
 */
function found(value) {
  return /** @type {T} */ (value);
}

// The pickers are modal <dialog>s in the chrome document (ui/picker.mjs), their rows HTML
// elements.
/** @param {Document} doc @param {string} id */
const dialogIn = (doc, id) => /** @type {HTMLDialogElement | null} */ (doc.getElementById(id));
/** @param {HTMLDialogElement | null} dialog */
const rowsOf = (dialog) =>
  /** @type {HTMLElement[]} */ ([...(dialog?.querySelectorAll("[role=option]") ?? [])]);
const picker = () => dialogIn(document, PICKER_ID);
const isOpen = () => !!picker()?.open;
const rows = () => rowsOf(picker());
const ids = () => rows().map((r) => r.dataset.id);
const selectedId = () => rows().find((r) => r.getAttribute("aria-selected") === "true")?.dataset.id;
/** @param {string} id */
const detail = (id) =>
  rows()
    .find((r) => r.dataset.id === id)
    ?.querySelector(".vimma-picker-host")?.textContent ?? null;
const heading = () => picker()?.querySelector("h1")?.textContent ?? "";
const noticeText = () => document.getElementById(NOTICE_ID)?.textContent ?? "";

/**
 * Resolves with the first truthy value of `cond`.
 * @template T
 * @param {() => T} cond
 * @param {string} msg
 */
function until(cond, msg, tries = 100) {
  return TestUtils.waitForCondition(cond, msg, 50, tries);
}

/**
 * @param {string} text  a command line, without the colon
 * @param {Window} [win]
 */
function command(text, win = window) {
  EventUtils.synthesizeKey(":", { shiftKey: true }, win);
  EventUtils.sendString(text, win);
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
}

async function openPicker() {
  command("site");
  await until(() => isOpen() && rows().length > 0, ":site opens the picker");
}

/**
 * Moves the selection down to the row of `id`.
 * @param {string} id
 */
function selectRow(id) {
  for (let i = 0; i < rows().length && selectedId() !== id; i++) EventUtils.synthesizeKey("j");
  Assert.equal(selectedId(), id, `${id} is selected`);
}

// Vimma isolates permissions by container (permissions.isolateBy.userContext), and a
// workspace's tab is in that workspace's container: the site's principal is the tab's.
/** @param {string} url @param {MozTabbrowserTab} tab */
const principalOf = (url, tab) =>
  Services.scriptSecurityManager.createContentPrincipal(
    Services.io.newURI(url),
    tab.linkedBrowser.contentPrincipal.originAttributes,
  );
/** @param {string} url @param {string} id @param {MozTabbrowserTab} tab */
const stateOf = (url, id, tab) => SitePermissions.getForPrincipal(principalOf(url, tab), id).state;
/** @param {string} id @param {number} state */
const label = (id, state) => SitePermissions.getMultichoiceStateLabel(id, state);

/** Page Info's list (pageinfo/permissions.js): labelled, not open-protocol-handler, by label. */
function pageInfoList() {
  return SitePermissions.listPermissions()
    .filter(
      (/** @type {string} */ id) =>
        SitePermissions.getPermissionLabel(id) && id !== "open-protocol-handler",
    )
    .sort((/** @type {string} */ a, /** @type {string} */ b) =>
      SitePermissions.getPermissionLabel(a).localeCompare(SitePermissions.getPermissionLabel(b)),
    );
}

/** Every permission of the test sites, in any container. */
function clearSites() {
  for (const perm of Services.perms.all) {
    // Only http(s) principals have a host: nsIPrincipal.host throws for the others.
    if (!perm.principal.schemeIs("https")) continue;
    if (["example.com", "example.org"].includes(perm.principal.host)) {
      Services.perms.removeFromPrincipal(perm.principal, perm.type);
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
    // Vimma made the window's workspaces when it started this window.
    if (main) found(WindowWorkspaces.get(window)).switchTo({ id: main.id });
    while (gBrowser.tabs.length > 1) {
      BrowserTestUtils.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
    }
  });
});

add_task(async function test_lists_every_permission_with_its_real_state() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  SitePermissions.setForPrincipal(principalOf(PAGE, tab), "geo", SitePermissions.BLOCK);
  await openPicker();
  Assert.equal(heading(), "Site permissions · example.com", "the heading names the site");
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
  await until(() => stateOf(PAGE, "camera", tab) === SitePermissions.ALLOW, "a allows");
  await until(() => detail("camera") === label("camera", SitePermissions.ALLOW), "row: Allow");
  Assert.ok(isOpen(), "the picker stays open");

  EventUtils.synthesizeKey("b");
  await until(() => stateOf(PAGE, "camera", tab) === SitePermissions.BLOCK, "b blocks");
  await until(() => detail("camera") === label("camera", SitePermissions.BLOCK), "row: Block");

  EventUtils.synthesizeKey("r");
  await until(() => stateOf(PAGE, "camera", tab) === SitePermissions.UNKNOWN, "r resets");
  await until(() => found(detail("camera")).endsWith(" · default"), "row: the default");

  // Enter: the next of Firefox's states for it, after the default (Always Ask) comes Allow.
  const states = SitePermissions.getAvailableStates("camera");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => stateOf(PAGE, "camera", tab) === states[1], "Enter steps to the next state");
  Assert.ok(isOpen(), "Enter keeps the picker open");

  Assert.equal(stateOf(OTHER, "camera", tab), SitePermissions.UNKNOWN, "no other site changed");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
  clearSites();
  BrowserTestUtils.removeTab(tab);
});

// Pop-ups: Firefox's default is Block, and SitePermissions drops a block as the default rather
// than storing it, so `b` must still leave the site a block of its own that `r` takes back (the
// second way to undo a mistaken `n` on the pop-up blocked bar, docs/specs/popup-blocked.md).
add_task(async function test_popups_can_be_allowed_blocked_and_reset() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const exact = () =>
    Services.perms.testExactPermissionFromPrincipal(principalOf(PAGE, tab), "popup");
  await openPicker();
  Assert.ok(ids().includes("popup"), "the pop-up permission is listed");
  Assert.equal(
    detail("popup"),
    `${label("popup", SitePermissions.BLOCK)} · default`,
    "unset: Firefox's default, Block",
  );
  selectRow("popup");

  EventUtils.synthesizeKey("a");
  await until(() => exact() === Services.perms.ALLOW_ACTION, "a allows pop-ups");
  await until(() => detail("popup") === label("popup", SitePermissions.ALLOW), "row: Allow");

  EventUtils.synthesizeKey("b");
  await until(() => exact() === Services.perms.DENY_ACTION, "b stores a block for the site");
  await until(() => detail("popup") === label("popup", SitePermissions.BLOCK), "row: Block, set");

  EventUtils.synthesizeKey("r");
  await until(() => exact() === Services.perms.UNKNOWN_ACTION, "r removes the site's block");
  await until(
    () => detail("popup") === `${label("popup", SitePermissions.BLOCK)} · default`,
    "row: the default",
  );

  // From the default, b still stores a block, and Enter steps from it to Allow and back.
  EventUtils.synthesizeKey("b");
  await until(() => exact() === Services.perms.DENY_ACTION, "b on the default stores a block");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => exact() === Services.perms.ALLOW_ACTION, "Enter: Block to Allow");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => exact() === Services.perms.DENY_ACTION, "Enter: Allow to a stored Block");

  Assert.equal(
    Services.perms.testExactPermissionFromPrincipal(principalOf(OTHER, tab), "popup"),
    Services.perms.UNKNOWN_ACTION,
    "no other site changed",
  );
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
  clearSites();
  BrowserTestUtils.removeTab(tab);
});

// `:site` and `:popups` (docs/specs/popup-blocked.md) change one and the same pop-up permission:
// a block from either is the stored block the other shows and takes back, and the status bar's
// undo cue follows a change made in `:site`.
const POPUP_PICKER_ID = "vimma-popup-picker";
const UNDO_CUE = "pop-ups blocked · :popups to allow";
/** @param {Window} [win] */
const popupCue = (win = window) =>
  win.document.querySelector('#vimma-statusbar [data-segment="popups"]')?.textContent ?? null;
/** @param {Window} [win] */
const popupRows = (win = window) => rowsOf(dialogIn(win.document, POPUP_PICKER_ID));
/** @param {Window} [win] */
const popupPickerOpen = (win = window) => !!dialogIn(win.document, POPUP_PICKER_ID)?.open;

/**
 * Runs the `:popups` row `id`.
 * @param {string} id
 * @param {Window} [win]
 */
async function runPopupRow(id, win = window) {
  command("popups", win);
  await until(
    () => popupPickerOpen(win) && popupRows(win).some((r) => r.dataset.id === id),
    `:popups lists ${id}`,
  );
  const at = popupRows(win).findIndex((r) => r.dataset.id === id);
  for (let i = 0; i < at; i++) EventUtils.synthesizeKey("j", {}, win);
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
  await until(() => !popupPickerOpen(win), ":popups closes after the row");
}

add_task(async function test_site_and_popups_share_one_popup_permission() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const exact = () =>
    Services.perms.testExactPermissionFromPrincipal(principalOf(PAGE, tab), "popup");

  // A block from :site is the block :popups offers to undo.
  await openPicker();
  selectRow("popup");
  EventUtils.synthesizeKey("b");
  await until(() => exact() === Services.perms.DENY_ACTION, ":site b stores the block");
  await until(() => popupCue() === UNDO_CUE, "the status bar names the undo while :site is open");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
  await runPopupRow("reset");
  await until(() => exact() === Services.perms.UNKNOWN_ACTION, ":popups reset takes it back");
  await until(() => popupCue() === null, "no cue on the default");
  await openPicker();
  Assert.equal(
    detail("popup"),
    `${label("popup", SitePermissions.BLOCK)} · default`,
    ":site shows the default again",
  );
  // A block from :popups (from an allowed site) is the block :site shows and resets.
  selectRow("popup");
  EventUtils.synthesizeKey("a");
  await until(() => exact() === Services.perms.ALLOW_ACTION, ":site a allows");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
  await runPopupRow("block");
  await until(() => exact() === Services.perms.DENY_ACTION, ":popups block stores the block");
  await openPicker();
  Assert.equal(
    detail("popup"),
    label("popup", SitePermissions.BLOCK),
    ":site shows the stored block",
  );
  selectRow("popup");
  EventUtils.synthesizeKey("r");
  await until(() => exact() === Services.perms.UNKNOWN_ACTION, ":site r takes it back");
  await until(() => popupCue() === null, "and the status bar's cue goes");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
  clearSites();
  BrowserTestUtils.removeTab(tab);
});

// In a private window either way of blocking lasts for the private session only, as Firefox's
// permission manager keeps every private-browsing permission.
add_task(async function test_a_private_window_keeps_a_popup_block_for_its_session() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const browser = win.gBrowser.selectedBrowser;
  BrowserTestUtils.startLoadingURIString(browser, PAGE);
  await BrowserTestUtils.browserLoaded(browser, false, PAGE);
  await SimpleTest.promiseFocus(win);
  await SimpleTest.promiseFocus(browser);
  const principal = browser.contentPrincipal;
  Assert.greater(principal.privateBrowsingId, 0, "a private page");
  const entry = () => Services.perms.getPermissionObject(principal, "popup", true);
  const doc = win.document;
  const privRows = () => rowsOf(dialogIn(doc, PICKER_ID));

  command("site", win);
  await until(() => !!dialogIn(doc, PICKER_ID)?.open && privRows().length > 0, ":site opens");
  Assert.equal(
    found(found(doc.getElementById(PICKER_ID)).querySelector("h1")).textContent,
    "Site permissions · example.com · private: until the private workspace closes",
    "the heading says how long a change lasts",
  );
  const at = privRows().findIndex((r) => r.dataset.id === "popup");
  for (let i = 0; i < at; i++) EventUtils.synthesizeKey("j", {}, win);
  EventUtils.synthesizeKey("b", {}, win);
  await until(() => entry()?.capability === Services.perms.DENY_ACTION, ":site b blocks");
  Assert.equal(found(entry()).expireType, Services.perms.EXPIRE_SESSION, "for the session only");
  EventUtils.synthesizeKey("KEY_Escape", {}, win);
  await until(() => !dialogIn(doc, PICKER_ID)?.open, "closed");

  await runPopupRow("allow", win);
  await until(() => entry()?.capability === Services.perms.ALLOW_ACTION, ":popups allows");
  Assert.equal(found(entry()).expireType, Services.perms.EXPIRE_SESSION, "for the session only");
  await runPopupRow("block", win);
  await until(() => entry()?.capability === Services.perms.DENY_ACTION, ":popups blocks");
  Assert.equal(found(entry()).expireType, Services.perms.EXPIRE_SESSION, "for the session only");
  Services.perms.removeFromPrincipal(principal, "popup");
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function test_a_state_firefox_does_not_offer_is_refused() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await openPicker();
  selectRow("screen");
  EventUtils.synthesizeKey("a");
  await until(() => noticeText().includes("cannot be set to allow"), "the refusal");
  Assert.equal(stateOf(PAGE, "screen", tab), SitePermissions.UNKNOWN, "screen is not allowed");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "closed");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_a_locked_default_makes_the_row_read_only() {
  Services.prefs.lockPref("permissions.default.camera");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await openPicker();
  Assert.ok(found(detail("camera")).endsWith(" · locked"), "the row says it is locked");
  selectRow("camera");
  EventUtils.synthesizeKey("a");
  await until(() => noticeText().includes("is locked"), "the refusal");
  Assert.equal(stateOf(PAGE, "camera", tab), SitePermissions.UNKNOWN, "nothing allowed");
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
  Assert.equal(stateOf(PAGE, "camera", tab), SitePermissions.UNKNOWN, "the old site got nothing");
  Assert.equal(stateOf(OTHER, "camera", tab), SitePermissions.UNKNOWN, "the new site got nothing");

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
  // The test profile has the agent workspace; a read through a missing one throws.
  const agent = found(WorkspaceStore.agent);
  const agentContext = agent.userContextId;
  Assert.ok(agentContext && agentContext > 0, "the agent workspace has its container");
  // Every permission the agent's page has, but the WebRTC denies Vimma itself sets on each agent
  // tab (AgentPages, AGENT_DENIED_PERMISSIONS).
  /** @param {MozTabbrowserTab} tab */
  const agentPerms = (tab) =>
    Services.perms
      .getAllForPrincipal(tab.linkedBrowser.contentPrincipal)
      .filter(
        (p) =>
          !(
            AGENT_DENIED_PERMISSIONS.includes(p.type) && p.capability === Services.perms.DENY_ACTION
          ),
      )
      .map((p) => `${p.type}=${p.capability}`);

  // A picker open on the user's tab closes when the agent's tab is selected, and grants nothing
  // there.
  const mine = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await openPicker();
  selectRow("popup");
  const tab = BrowserTestUtils.addTab(gBrowser, PAGE, { userContextId: agentContext });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  gBrowser.selectedTab = tab;
  await until(() => !isOpen(), "selecting the agent's tab closes the picker");
  Assert.deepEqual(agentPerms(tab), [], "nothing granted to the agent's page");

  // :site there opens nothing.
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
  Assert.equal(
    Services.perms.testExactPermissionFromPrincipal(principal, "popup"),
    Services.perms.UNKNOWN_ACTION,
    "no pop-up permission",
  );
  Assert.deepEqual(agentPerms(tab), [], "no permission of any kind for the agent's page");
  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(mine);
});
