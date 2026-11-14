/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m7-a11y.md. What a screen reader gets from Vimma's own chrome UI, read
// through Firefox's accessibility API (nsIAccessibilityService, as
// browser/components/urlbar/tests/browser-UrlbarInput/browser_a11y.js does): each component's
// role, name and states, live regions that speak once and only when it matters, and focus that
// each overlay or panel takes when it opens and gives back when it closes.

"use strict";

// A dozen components, each opened and closed by keys.
requestLongerTimeout(3);

/* global focusContent -- from head.js */
/* global requestLongerTimeout -- the browser-chrome harness (browser-test.js) */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);

const PAGE = "https://example.com/";
const START = "chrome://browser/content/vimma/start/start.html";
const { nsIAccessibleRole: Role, nsIAccessibleStates: States } = Ci;

let accService = Cc["@mozilla.org/accessibilityService;1"].getService(Ci.nsIAccessibilityService);

registerCleanupFunction(async () => {
  for (const id of ["vimma-help", "vimma-picker", "vimma-workspace-picker", "vimma-addon-picker"]) {
    document.getElementById(id)?.close?.();
  }
  if (document.getElementById("vimma-rename")?.hidden === false) {
    EventUtils.synthesizeKey("KEY_Escape");
  }
  const ww = WindowWorkspaces.get(window);
  const main = WorkspaceStore.definitions.workspaces.find((w) => w.name === "main");
  if (ww && main) ww.switchTo({ id: main.id });
  for (const w of WorkspaceStore.definitions.workspaces.filter(
    (d) => d.name !== "main" && d.id !== WorkspaceStore.agent?.id,
  )) {
    await WorkspaceStore.deleteWorkspace(w.id, { confirmed: true });
  }
  while (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs.at(-1));
  // Let the accessibility service shut down, so later test files run without it.
  accService = null;
  Cu.forceGC();
  Cu.forceCC();
});

/** @param {() => unknown} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/** ctrl+b, then `key`. */
function prefix(key, mods = {}) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key, mods);
}

/** The accessible of `node`, once the tree has one. */
async function accOf(node, what) {
  let acc = null;
  await until(() => (acc = node && accService.getAccessibleFor(node)), `${what} is accessible`);
  return acc;
}

/** @param {nsIAccessible} acc */
function stateOf(acc) {
  const state = {};
  const extra = {};
  acc.getState(state, extra);
  return { state: state.value, extra: extra.value };
}

/** An object attribute (`xml-roles`, `live`, `level`), or null. */
function attr(acc, name) {
  try {
    return acc.attributes.getStringProperty(name);
  } catch {
    return null;
  }
}

function expectRole(acc, role, name, what) {
  Assert.equal(acc.role, role, `${what}: role`);
  if (name !== undefined) Assert.equal(acc.name, name, `${what}: name`);
}

/** Opens a page in a new tab and focuses it, in normal mode. */
async function openPage(url = PAGE) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  await focusContent(tab.linkedBrowser);
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode on the page");
  return tab;
}

/** Waits for focus to be back on `browser`, the element focused before the overlay opened. */
function focusBackOn(browser, what) {
  return until(() => document.activeElement === browser, `${what}: focus returns to the page`);
}

/**
 * A list (listbox or tree) with aria-activedescendant: the list itself has focus, so the
 * active row is the accessible's focused child, selected and focused.
 */
async function expectActiveRow(list, rowRole, what) {
  Assert.equal(document.activeElement, list, `${what}: the list has focus`);
  const id = list.getAttribute("aria-activedescendant");
  Assert.ok(id, `${what}: aria-activedescendant is set`);
  const row = document.getElementById(id);
  Assert.ok(row && list.contains(row), `${what}: it names a row of the list`);
  Assert.equal(row.getAttribute("aria-selected"), "true", `${what}: that row is aria-selected`);
  const rowAcc = await accOf(row, `${what} active row`);
  Assert.equal(rowAcc.role, rowRole, `${what}: the row's role`);
  await until(
    () => stateOf(rowAcc).state & States.STATE_FOCUSED,
    `${what}: the active row is the focused accessible`,
  );
  Assert.ok(stateOf(rowAcc).state & States.STATE_SELECTED, `${what}: and selected`);
  return row;
}

// ---- the status bar ---------------------------------------------------------------------------

const bar = () => document.getElementById("vimma-statusbar");
const modeLive = () => bar().querySelector("[aria-live=polite]");

add_task(async function status_bar_is_a_named_status_bar_read_on_demand() {
  const acc = await accOf(bar(), "the status bar");
  expectRole(acc, Role.ROLE_STATUSBAR, "Vimma status bar", "status bar");
  Assert.equal(attr(acc, "live"), "off", "title and URL changes are not announced");
  const live = await accOf(modeLive(), "the mode announcer");
  Assert.equal(attr(live, "live"), "polite", "mode changes are polite");
});

add_task(async function mode_is_announced_only_where_no_focused_ui_says_it() {
  const tab = await openPage();
  await until(() => modeLive().textContent === "normal mode", "normal mode");
  const changes = [];
  const observer = new MutationObserver(() => changes.push(modeLive().textContent));
  observer.observe(modeLive(), { childList: true, characterData: true, subtree: true });

  // The overlay, the command line and the panels announce themselves as they take focus.
  prefix("?", { shiftKey: true });
  await until(() => VimmaHost.status(window).mode === "help", "help mode");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => VimmaHost.status(window).mode === "normal", "back to normal");
  EventUtils.synthesizeKey(":", { shiftKey: true });
  await until(() => VimmaHost.status(window).mode === "command", "command mode");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => VimmaHost.status(window).mode === "normal", "back to normal");
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  Assert.deepEqual(changes, [], "help and command mode are not spoken twice");

  // Hint mode has no focused UI: it is spoken, and so is the way back.
  EventUtils.synthesizeKey("f");
  await until(() => modeLive().textContent === "hint mode", "hint mode is announced");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => modeLive().textContent === "normal mode", "and normal mode after Esc");
  observer.disconnect();
  gBrowser.removeTab(tab);
});

add_task(async function a_search_not_found_is_announced_once_the_find_bar_closes() {
  const tab = await openPage();
  EventUtils.synthesizeKey("/");
  await until(() => VimmaHost.status(window).mode === "command", "typing a search");
  EventUtils.sendString("zqxjzqxj");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(
    () => modeLive().textContent === "Pattern not found: zqxjzqxj",
    "the status bar says the search found nothing",
  );
  gBrowser.removeTab(tab);
});

// ---- link hints -------------------------------------------------------------------------------

add_task(async function hint_labels_stay_out_of_the_accessible_tree() {
  const tab = await openPage();
  EventUtils.synthesizeKey("f");
  let layer = null;
  await until(() => (layer = document.getElementById("vimma-hints")), "hint labels are drawn");
  Assert.equal(layer.getAttribute("aria-hidden"), "true", "the labels are hidden from AT");
  Assert.equal(accService.getAccessibleFor(layer), null, "so no accessible for the layer");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !document.getElementById("vimma-hints"), "hints cancelled");
  gBrowser.removeTab(tab);
});

// ---- notices ----------------------------------------------------------------------------------

add_task(async function notices_speak_politely_errors_assertively_and_never_twice() {
  const tab = await openPage();
  VimmaHost.say(window, "hello from a test");
  const polite = document.getElementById("vimma-notice-live");
  const alert = document.getElementById("vimma-notice-alert");
  Assert.ok(polite && alert, "the notice has a polite and an assertive live region");
  const politeAcc = await accOf(polite, "the polite notice region");
  expectRole(politeAcc, Role.ROLE_STATUSBAR, undefined, "polite notices");
  Assert.equal(attr(politeAcc, "live"), "polite", "a notice is polite");
  const alertAcc = await accOf(alert, "the assertive notice region");
  expectRole(alertAcc, Role.ROLE_ALERT, undefined, "error notices");
  Assert.equal(attr(alertAcc, "live"), "assertive", "an error is assertive");
  await until(() => polite.textContent === "hello from a test", "the text is in the polite region");
  const toast = document.getElementById("vimma-notice");
  Assert.equal(toast.getAttribute("aria-hidden"), "true", "the toast itself is not read twice");

  let mutations = 0;
  const observer = new MutationObserver(() => mutations++);
  observer.observe(polite, { childList: true, characterData: true, subtree: true });
  VimmaHost.say(window, "hello from a test");
  VimmaHost.say(window, "hello from a test");
  await new Promise((r) => requestAnimationFrame(r));
  Assert.equal(mutations, 0, "the same notice again while shown is not announced again");
  observer.disconnect();

  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("open javascript:void(0)");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => alert.textContent.startsWith("blocked:"), "a refused URL is an error");
  gBrowser.removeTab(tab);
});

// ---- the help overlay -------------------------------------------------------------------------

add_task(async function help_overlay_is_a_named_modal_dialog_that_returns_focus() {
  const tab = await openPage();
  prefix("?", { shiftKey: true });
  const dialog = await until(() => {
    const d = document.getElementById("vimma-help");
    return d?.open && d;
  }, "the overlay opens");
  Assert.equal(dialog.getAttribute("aria-modal"), "true", "aria-modal");
  const acc = await accOf(dialog, "the overlay");
  expectRole(acc, Role.ROLE_DIALOG, "Key bindings", "help overlay");
  Assert.ok(stateOf(acc).extra & States.EXT_STATE_MODAL, "the dialog is modal");
  Assert.ok(dialog.contains(document.activeElement), "focus is in the overlay");
  EventUtils.synthesizeKey("KEY_Escape");
  await focusBackOn(tab.linkedBrowser, "help overlay");
  gBrowser.removeTab(tab);
});

// ---- pickers ----------------------------------------------------------------------------------

/** Checks an open picker dialog: a named modal dialog around a named, focused listbox. */
async function expectPicker(id, title, listName) {
  const dialog = await until(() => {
    const d = document.getElementById(id);
    return d?.open && d;
  }, `${title} opens`);
  Assert.equal(dialog.getAttribute("aria-modal"), "true", `${title}: aria-modal`);
  const acc = await accOf(dialog, title);
  expectRole(acc, Role.ROLE_DIALOG, title, title);
  Assert.ok(stateOf(acc).extra & States.EXT_STATE_MODAL, `${title}: modal`);
  const list = dialog.querySelector("[role=listbox]");
  const listAcc = await accOf(list, `${title} list`);
  expectRole(listAcc, Role.ROLE_LISTBOX, listName, `${title} list`);
  return { dialog, list };
}

add_task(async function tab_search_is_a_listbox_whose_focus_follows_ctrl_n_and_ctrl_p() {
  const tabs = [await openPage(`${PAGE}?one`), await openPage(`${PAGE}?two`)];
  prefix("g");
  const { dialog, list } = await expectPicker("vimma-picker", "Tabs", "Tabs");
  // It opens on the selected tab, the last one: ctrl+p moves up, ctrl+n back down (letters
  // type: tab search opens typing, docs/specs/tab-search.md).
  const last = await expectActiveRow(list, Role.ROLE_OPTION, "tab search");
  const lastAcc = await accOf(last, "the active option");
  const main = WindowWorkspaces.get(window).model.workspaces.find(
    (w) => w.id === WindowWorkspaces.get(window).model.active,
  );
  Assert.stringContains(lastAcc.name, `, ${main.name}`, "an option's name says its workspace");
  for (const heading of dialog.querySelectorAll(".vimma-picker-heading")) {
    Assert.equal(heading.getAttribute("role"), "presentation", "a section heading is no option");
  }
  EventUtils.synthesizeKey("p", { ctrlKey: true });
  await until(
    () => list.getAttribute("aria-activedescendant") !== last.id,
    "ctrl+p moves the active row",
  );
  await expectActiveRow(list, Role.ROLE_OPTION, "tab search after ctrl+p");
  EventUtils.synthesizeKey("n", { ctrlKey: true });
  await until(() => list.getAttribute("aria-activedescendant") === last.id, "ctrl+n moves back");
  await expectActiveRow(list, Role.ROLE_OPTION, "tab search after ctrl+n");

  // A polite live region says how many tabs match as the query changes.
  const live = dialog.querySelector(".vimma-picker-count");
  const liveAcc = await accOf(live, "the match count");
  Assert.equal(attr(liveAcc, "live"), "polite", "the count is polite");
  EventUtils.sendString("zzqqxv");
  await until(() => live.textContent === "no tabs match", "no match is announced");
  EventUtils.synthesizeKey("u", { ctrlKey: true });
  await until(() => /^\d+ tabs?$/.test(live.textContent), "a count is announced");
  EventUtils.synthesizeKey("KEY_Escape");
  await focusBackOn(tabs[1].linkedBrowser, "tab search");
  for (const tab of tabs) gBrowser.removeTab(tab);
});

add_task(async function workspace_picker_is_a_listbox_and_returns_focus() {
  const tab = await openPage();
  prefix("w");
  const { list } = await expectPicker("vimma-workspace-picker", "Workspaces", "Workspaces");
  await expectActiveRow(list, Role.ROLE_OPTION, "workspace picker");
  EventUtils.synthesizeKey("KEY_Escape");
  await focusBackOn(tab.linkedBrowser, "workspace picker");
  gBrowser.removeTab(tab);
});

add_task(async function addon_picker_is_a_listbox_that_describes_an_empty_list() {
  const tab = await openPage();
  prefix("e");
  const { list } = await expectPicker("vimma-addon-picker", "Add-ons", "Add-ons");
  Assert.equal(document.activeElement, list, "the list has focus");
  const listAcc = await accOf(list, "add-on list");
  for (const child of list.children) {
    const role = child.getAttribute("role");
    Assert.ok(role === "option" || role === "none", `a row is an option or nothing: ${role}`);
  }
  if (!list.querySelector("[role=option]")) {
    Assert.stringContains(listAcc.description, "No add-ons installed", "the empty list says so");
  }
  EventUtils.synthesizeKey("KEY_Escape");
  await focusBackOn(tab.linkedBrowser, "add-on picker");
  gBrowser.removeTab(tab);
});

// ---- the side panel and the bookmarks panel ---------------------------------------------------

add_task(async function side_panel_is_a_named_region_around_a_focused_listbox() {
  const tab = await openPage();
  prefix("b");
  const panel = await until(() => {
    const p = document.getElementById("vimma-panel");
    return p && !p.hidden && p;
  }, "the side panel opens");
  const acc = await accOf(panel, "the side panel");
  expectRole(acc, Role.ROLE_REGION, "Side panel", "side panel");
  const list = panel.querySelector("[role=listbox]");
  const listAcc = await accOf(list, "the side panel's list");
  Assert.ok(listAcc.name.startsWith("Tabs in "), `the list is named: ${listAcc.name}`);
  await expectActiveRow(list, Role.ROLE_OPTION, "side panel");
  EventUtils.synthesizeKey("KEY_Escape");
  await focusBackOn(tab.linkedBrowser, "side panel");
  gBrowser.removeTab(tab);
});

add_task(async function side_panel_returns_focus_to_the_url_bar_it_was_opened_from() {
  const tab = await openPage();
  // ctrl+b b while the URL bar has focus: the panel opens over it, and gives focus back to it.
  gURLBar.focus();
  await until(() => gURLBar.focused, "the URL bar has focus");
  prefix("b");
  await until(() => document.getElementById("vimma-panel")?.hidden === false, "panel opens");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => gURLBar.focused, "Esc gives focus back to the URL bar, not the page");
  gBrowser.removeTab(tab);
});

add_task(async function bookmarks_panel_is_a_tree_with_levels_and_expanded_states() {
  // The panel lists the workspace's folder in the Bookmarks Toolbar (docs/specs/bookmarks.md):
  // give it a folder to show.
  const model = WindowWorkspaces.get(window).model;
  const active = model.workspaces.find((w) => w.id === model.active).name;
  const folder0 = await PlacesUtils.bookmarks
    .insertTree({
      guid: PlacesUtils.bookmarks.toolbarGuid,
      children: [
        {
          title: active,
          type: PlacesUtils.bookmarks.TYPE_FOLDER,
          children: [{ title: "a11y folder", type: PlacesUtils.bookmarks.TYPE_FOLDER }],
        },
      ],
    })
    .then(([f]) => f);
  registerCleanupFunction(() => PlacesUtils.bookmarks.remove(folder0.guid).catch(() => {}));
  const tab = await openPage();
  prefix("B", { shiftKey: true });
  const panel = await until(() => {
    const p = document.getElementById("vimma-bookmarks");
    return p && !p.hidden && p;
  }, "the bookmarks panel opens");
  const acc = await accOf(panel, "the bookmarks panel");
  expectRole(acc, Role.ROLE_REGION, "Bookmarks", "bookmarks panel");
  const tree = panel.querySelector("[role=tree]");
  Assert.ok(tree, "the bookmarks are a tree");
  const treeAcc = await accOf(tree, "the bookmarks tree");
  expectRole(treeAcc, Role.ROLE_OUTLINE, "Bookmarks", "bookmarks tree");
  await until(() => tree.querySelector("[role=treeitem]"), "the tree has loaded");
  for (const child of tree.children) {
    const role = child.getAttribute("role");
    Assert.ok(role === "treeitem" || role === "none", `a row is a treeitem or nothing: ${role}`);
  }
  const folder = tree.querySelector("[role=treeitem][aria-expanded]");
  Assert.ok(folder, "a folder row says whether it is open");
  Assert.equal(folder.getAttribute("aria-level"), "1", "a top-level row is at level 1");
  const folderAcc = await accOf(folder, "a folder row");
  const open = folder.getAttribute("aria-expanded") === "true";
  Assert.ok(
    stateOf(folderAcc).state & (open ? States.STATE_EXPANDED : States.STATE_COLLAPSED),
    "the folder is exposed expanded or collapsed",
  );
  const row = await expectActiveRow(tree, Role.ROLE_OUTLINEITEM, "bookmarks");
  Assert.equal(attr(await accOf(row, "active bookmark row"), "level"), "1", "level 1");
  EventUtils.synthesizeKey("KEY_Escape");
  await focusBackOn(tab.linkedBrowser, "bookmarks panel");
  gBrowser.removeTab(tab);
});

// ---- the command line and the prompts ---------------------------------------------------------

add_task(async function command_line_is_a_combobox_with_completions_and_an_alert() {
  const tab = await openPage();
  EventUtils.synthesizeKey(":", { shiftKey: true });
  const input = document.getElementById("vimma-cmdline-input");
  await until(() => document.activeElement === input, "the command line takes focus");
  const inputAcc = await accOf(input, "the command line");
  expectRole(inputAcc, Role.ROLE_EDITCOMBOBOX, "Command line", "command line");
  EventUtils.sendString("tab");
  const list = document.getElementById("vimma-cmdline-completions");
  await until(() => !list.hidden, "completions are listed");
  Assert.ok(stateOf(inputAcc).state & States.STATE_EXPANDED, "the combobox is expanded");
  expectRole(await accOf(list, "the completions"), Role.ROLE_LISTBOX, "Completions", "list");
  EventUtils.synthesizeKey("KEY_Tab");
  const id = input.getAttribute("aria-activedescendant");
  Assert.ok(id, "Tab makes a completion the active descendant");
  const option = await accOf(document.getElementById(id), "the chosen completion");
  await until(() => stateOf(option).state & States.STATE_FOCUSED, "it is the focused one");

  EventUtils.synthesizeKey("a", { ctrlKey: true });
  input.value = "";
  EventUtils.sendString("nosuchcommand");
  EventUtils.synthesizeKey("KEY_Enter");
  const error = document.querySelector("#vimma-cmdline .vimma-cmdline-error");
  await until(() => !error.hidden, "the error shows");
  expectRole(await accOf(error, "the error"), Role.ROLE_ALERT, undefined, "command error");
  EventUtils.synthesizeKey("KEY_Escape");
  await focusBackOn(tab.linkedBrowser, "command line");
  gBrowser.removeTab(tab);
});

const promptBox = () => document.getElementById("vimma-rename");

add_task(async function rename_prompt_is_a_named_dialog_that_returns_focus() {
  const tab = await openPage();
  prefix("T", { shiftKey: true });
  await until(() => promptBox()?.hidden === false, "the rename prompt opens");
  const input = document.getElementById("vimma-rename-input");
  Assert.equal(document.activeElement, input, "the prompt takes focus");
  const acc = await accOf(promptBox(), "the rename prompt");
  expectRole(acc, Role.ROLE_DIALOG, "Rename tab", "rename prompt");
  Assert.equal(attr(acc, "xml-roles"), "dialog", "a dialog, not an alert");
  EventUtils.synthesizeKey("KEY_Escape");
  await focusBackOn(tab.linkedBrowser, "rename prompt");
  gBrowser.removeTab(tab);
});

add_task(async function yes_no_question_is_an_alertdialog_that_returns_focus() {
  await openPage();
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("wsnew a11y");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(
    () => WorkspaceStore.definitions.workspaces.some((w) => w.name === "a11y"),
    "a second workspace, so closing one asks",
  );
  const browser = gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "its home tab has loaded");
  await focusContent(browser);
  prefix("D", { shiftKey: true });
  await until(() => promptBox()?.hidden === false, "prefix+shift+d asks y/N");
  const question = promptBox().querySelector(".vimma-cmdline-prompt").textContent.trim();
  Assert.stringContains(question, "y/N", "sanity: a y/N question");
  const acc = await accOf(promptBox(), "the question");
  expectRole(acc, Role.ROLE_DIALOG, question, "y/N question");
  Assert.equal(attr(acc, "xml-roles"), "alertdialog", "an alertdialog");
  Assert.equal(document.activeElement, document.getElementById("vimma-rename-input"), "focus");
  EventUtils.synthesizeKey("KEY_Escape");
  await focusBackOn(browser, "y/N question");
});

// docs/specs/vimma-mcp.md decisions 13-14: the agent question is an alertdialog named by its
// question, and it takes no focus.
add_task(async function agent_question_is_a_named_alertdialog_that_takes_no_focus() {
  const { VimmaControl } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
  );
  const { AgentGate } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/host/AgentGate.sys.mjs",
  );
  const { MCP_ENABLED_PREF } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/host/mcp-ops.mjs",
  );
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, true);
  await VimmaControl.settled();
  const tab = await openPage();
  await new Promise((r) => setTimeout(r, 1600)); // no key for 1,500 ms: it may open by itself
  // The gate directly, as an agent connection's request would (browser_vimma_mcp_prompt.js
  // drives it over the socket).
  AgentGate.connect("a11y", { client: "example-agent" });
  const asked = AgentGate.request("a11y", "vimma_tabs", { count: 2 });
  const line = () => document.getElementById("vimma-agent-prompt");
  await until(() => line()?.hidden === false, "the agent question opens");
  const acc = await accOf(line(), "the agent question");
  expectRole(
    acc,
    Role.ROLE_DIALOG,
    "◇ example-agent wants vimma_tabs: the list of agent tabs (2)",
    "agent question",
  );
  Assert.equal(attr(acc, "xml-roles"), "alertdialog", "an alertdialog");
  Assert.equal(document.activeElement, tab.linkedBrowser, "focus stays on the page");
  AgentGate.disconnect("a11y");
  Assert.equal((await asked).allow, false, "the request goes with its connection");
  await until(() => line().hidden, "and the line closes");
  Services.prefs.clearUserPref(MCP_ENABLED_PREF);
  await VimmaControl.settled();
});

// ---- the start page and about:vimma -----------------------------------------------------------

/** Role, name and the landmarks of the page in `browser`, read in its own process. */
function pageAccessibles(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    const service = Cc["@mozilla.org/accessibilityService;1"].getService(
      Ci.nsIAccessibilityService,
    );
    const doc = content.document;
    const of = (node) => (node ? service.getAccessibleFor(node) : null);
    await ContentTaskUtils.waitForCondition(() => of(doc.querySelector("main")), "tree built");
    const main = of(doc.querySelector("main"));
    const regions = [...doc.querySelectorAll("section")].map((s) => {
      const acc = of(s);
      return { role: acc?.role ?? null, name: acc?.name ?? null };
    });
    // The logo is a role="img" box painted through masks (logo.css), not an <img>.
    const img = of(doc.querySelector('img, [role="img"]'));
    return {
      lang: doc.documentElement.lang,
      title: doc.title,
      main: main ? { role: main.role } : null,
      regions,
      img: img ? { role: img.role, name: img.name } : null,
      status: of(doc.querySelector("[role=status]"))?.role ?? null,
    };
  });
}

add_task(async function start_page_has_a_main_landmark_and_a_named_logo() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, START);
  const page = await pageAccessibles(tab.linkedBrowser);
  Assert.equal(page.lang, "en", "the page has a language");
  Assert.ok(page.main, "a main landmark");
  Assert.equal(page.img?.role, Role.ROLE_GRAPHIC, "the logo is an image");
  Assert.equal(page.img?.name, "Vimma", "named Vimma");
  gBrowser.removeTab(tab);
});

add_task(async function about_vimma_has_a_main_landmark_and_regions_named_by_headings() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:vimma");
  const page = await pageAccessibles(tab.linkedBrowser);
  Assert.ok(page.main, "a main landmark");
  Assert.equal(page.img?.role, Role.ROLE_GRAPHIC, "the logo at its head is an image");
  Assert.equal(page.img?.name, "Vimma", "named Vimma");
  Assert.greater(page.regions.length, 5, "the sections");
  for (const r of page.regions) {
    Assert.equal(r.role, Role.ROLE_REGION, `a section is a region: ${r.name}`);
    Assert.ok(r.name, "named by its heading");
  }
  Assert.ok(
    page.regions.some((r) => r.name === "Bindings"),
    "e.g. Bindings",
  );
  Assert.equal(page.status, Role.ROLE_STATUSBAR, "the copy and refresh status is a live status");
  gBrowser.removeTab(tab);
});
