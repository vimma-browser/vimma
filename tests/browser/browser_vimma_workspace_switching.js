/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m3-workspaces.md, sub-spec 2b (m3-workspace-switching): ctrl+b ) / ctrl+b ( and
// `:workspace name` show one workspace's tabs and hide the others' (gBrowser.hideTab), a split
// hides and comes back whole, pinned tabs stay, new tabs join the active workspace, a tab of no
// workspace's container is `foreign`, and the tab keys and the goto picker follow.

"use strict";

/* global focusContent -- from head.js */

const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { leaves } = ChromeUtils.importESModule("chrome://browser/content/vimma/core/panes.mjs");

const PAGE = "https://example.com/";
const START = "chrome://browser/content/vimma/start/start.html";
const PICKER_ID = "vimma-picker";
const NOTICE_ID = "vimma-notice";

/** @type {string[]} */
const created = [];
/** @param {string} name */
function workspace(name) {
  const w = WorkspaceStore.addWorkspace({ name, color: "blue", icon: "briefcase" });
  created.push(w.id);
  return w;
}

/** A workspace definition (id, name, userContextId) by name. */
const def = (/** @type {string} */ name) =>
  WorkspaceStore.definitions.workspaces.find((w) => w.name === name);
const main = () => def("main");
const ww = () => WindowWorkspaces.get(window);

registerCleanupFunction(async () => {
  if (document.getElementById(PICKER_ID)?.open) EventUtils.synthesizeKey("KEY_Escape");
  ww().switchTo({ id: main().id });
  for (const id of created) await WorkspaceStore.deleteWorkspace(id, { confirmed: true });
  for (const t of gBrowser.tabs.filter((t) => t.pinned)) gBrowser.unpinTab(t);
  while (gBrowser.tabs.length > 1) BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
  Assert.ok(!gBrowser.tabs[0].hidden, "the window's last tab is visible again");
});

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/** @param {string} id statusSegments id */
function segText(id) {
  return (
    document.getElementById("vimma-statusbar")?.querySelector(`[data-segment="${id}"]`)
      ?.textContent ?? null
  );
}

/** The workspace segment as the bar draws it: `● <index>:<name>`. */
function wsLabel(/** @type {{ id: string, name: string }} */ w) {
  const index = WorkspaceStore.definitions.workspaces.findIndex((d) => d.id === w.id) + 1;
  return `● ${index}:${w.name}`;
}

/** The active workspace's id in this window's model. */
const active = () => ww().model.active;

/** The window model's workspace of `tab`, by id. */
function workspaceOf(tab) {
  return ww().model.workspaces.find((w) => w.tabs.includes(ww().idOf(tab)))?.id ?? null;
}

/** ctrl+b, then `key`. */
function prefix(key, mods = {}) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key, mods);
}

/** `:line` Enter, from the selected page in normal mode. */
async function runCommand(line) {
  await focusContent(gBrowser.selectedBrowser);
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
}

/** Waits for `win`'s selected tab to show the start page, and returns it. */
async function startTab() {
  const tab = gBrowser.selectedTab;
  await until(
    () =>
      tab.linkedBrowser.currentURI.spec === START &&
      tab.linkedBrowser.contentDocument?.readyState === "complete",
    "the start page has loaded",
  );
  return tab;
}

/** Opens `url` in a foreground tab of the active workspace (routed by the patch). */
function openPage(url = PAGE) {
  return BrowserTestUtils.openNewForegroundTab(gBrowser, url);
}

/** Pressing prefix+`key` (`)` next / `(` previous) and waiting for the window to show `to`. */
async function press(key, to) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key, { shiftKey: true });
  await until(() => active() === to.id, `ctrl+b ${key} switched to ${to.name}`);
}

/**
 * Two workspaces A and B made with the store API, the window switched to A (empty, so a start
 * tab opens in it) with two more pages; the window ends on A's second tab.
 */
async function setup(a, b) {
  const A = workspace(a);
  const B = workspace(b);
  Assert.ok(
    ww().model.workspaces.some((w) => w.id === B.id),
    "the window's model has the new workspaces",
  );
  await press(")", A);
  const a0 = await startTab();
  const a1 = await openPage(`${PAGE}?a1`);
  const a2 = await openPage(`${PAGE}?a2`);
  await BrowserTestUtils.switchTab(gBrowser, a1);
  return { A, B, aTabs: [a0, a1, a2] };
}

add_task(async function prefix_parens_show_one_workspace_and_restore_its_tab() {
  const first = gBrowser.selectedTab;
  Assert.equal(active(), main().id, "the window starts in main");
  await until(() => segText("workspace") === wsLabel(main()), "the bar shows main");
  const { A, B, aTabs } = await setup("sw-a", "sw-b");
  Assert.ok(first.hidden, "main's tab is hidden while A shows");
  for (const t of aTabs) {
    Assert.equal(t.userContextId, A.userContextId, "A's tabs are in A's container");
    Assert.equal(workspaceOf(t), A.id, "and in A");
  }

  await press(")", B);
  const b0 = await startTab();
  Assert.equal(b0.userContextId, B.userContextId, "an empty B gets a start tab in its container");
  Assert.equal(workspaceOf(b0), B.id, "which is B's");
  for (const t of aTabs) Assert.ok(t.hidden, "A's tabs hide");
  Assert.ok(!b0.hidden, "B's tab shows");
  Assert.deepEqual(gBrowser.visibleTabs, [b0], "only B's tabs are visible");
  await until(() => segText("workspace") === wsLabel(B), "the bar shows B");

  await press("(", A);
  Assert.equal(gBrowser.selectedTab, aTabs[1], "ctrl+b ( back to A restores A's selected tab");
  Assert.deepEqual(gBrowser.visibleTabs, aTabs, "A's tabs show, in order");
  Assert.ok(b0.hidden, "B's tab hides");
  await until(() => segText("workspace") === wsLabel(A), "the bar shows A");

  await press("(", main());
  Assert.equal(gBrowser.selectedTab, first, "main's tab comes back");
  await press("(", B);
  Assert.equal(gBrowser.selectedTab, b0, "ctrl+b ( wraps from the first workspace to the last");
  await press(")", main());

  for (const t of [...aTabs, b0]) BrowserTestUtils.removeTab(t);
  Assert.deepEqual(
    ww().model.workspaces.flatMap((w) => w.tabs),
    [ww().idOf(first)],
    "closed tabs leave the model",
  );
});

// ctrl+u / ctrl+i are vim's half page up and jump forward in normal
// mode, so they no longer switch workspace; prefix+( and prefix+) do (tmux's session keys).
add_task(async function ctrl_i_and_ctrl_u_no_longer_switch_workspace() {
  Assert.equal(active(), main().id, "the window is in main");
  const tab = await openPage(`${PAGE}?old-keys`);
  await focusContent(tab.linkedBrowser);
  EventUtils.synthesizeKey("u", { ctrlKey: true });
  EventUtils.synthesizeKey("i", { ctrlKey: true });
  EventUtils.synthesizeKey("u", { ctrlKey: true });
  // Had ctrl+u or ctrl+i switched (sw-b, then main, then sw-b), prefix+) would not land on sw-a.
  await press(")", def("sw-a"));
  const start = await startTab();
  await press("(", main());
  Assert.equal(gBrowser.selectedTab, tab, "main's page is selected again");
  BrowserTestUtils.removeTab(start);
  BrowserTestUtils.removeTab(tab);
});

// A switch that worked says nothing: switchTo/next/previous return null on success, and
// `null ?? NO_WORKSPACES` showed "no workspaces in this window" after every one.
add_task(async function a_switch_that_worked_shows_no_notice() {
  const notice = () => document.getElementById(NOTICE_ID);
  const noticeShown = () => !!notice()?.matches(":popover-open");
  notice()?.hidePopover?.();
  Assert.equal(active(), main().id, "the window is in main");
  const tab = await openPage(`${PAGE}?no-notice`);

  await press(")", def("sw-a"));
  const start = await startTab();
  Assert.ok(!noticeShown(), `ctrl+b ) shows no notice (got "${notice()?.textContent}")`);
  await press("(", main());
  Assert.ok(!noticeShown(), `ctrl+b ( shows no notice (got "${notice()?.textContent}")`);

  await runCommand("workspace sw-a");
  await until(() => active() === def("sw-a").id, ":workspace sw-a");
  Assert.ok(!noticeShown(), `:workspace shows no notice (got "${notice()?.textContent}")`);
  await runCommand("workspace main");
  await until(() => active() === main().id, ":workspace main");
  Assert.ok(!noticeShown(), "nor going back");

  BrowserTestUtils.removeTab(start);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function tab_keys_count_only_the_visible_workspace() {
  const A = def("sw-a");
  const B = def("sw-b");
  await press(")", A);
  const a0 = await startTab();
  const a1 = await openPage(`${PAGE}?a1`);
  await press(")", B);
  const b0 = await startTab();
  const b1 = await openPage(`${PAGE}?b1`);
  const b2 = await openPage(`${PAGE}?b2`);
  const bTabs = [b0, b1, b2];

  prefix("1");
  Assert.equal(gBrowser.selectedTab, b0, "prefix+1 is B's first tab");
  prefix("p");
  Assert.equal(gBrowser.selectedTab, b2, "prefix+p from the first wraps to B's last");
  prefix("n");
  Assert.equal(gBrowser.selectedTab, b0, "prefix+n from the last wraps to B's first");
  prefix("3");
  Assert.equal(gBrowser.selectedTab, b2, "prefix+3 is B's third tab");
  EventUtils.synthesizeKey("KEY_Tab", { ctrlKey: true });
  Assert.ok(bTabs.includes(gBrowser.selectedTab), "ctrl+tab stays in B");
  Assert.equal(active(), B.id, "still B");

  for (const t of [a0, a1, ...bTabs]) BrowserTestUtils.removeTab(t);
  await press(")", main());
});

add_task(async function a_split_hides_as_a_whole_and_comes_back_laid_out() {
  const A = def("sw-a");
  const B = def("sw-b");
  await press(")", A);
  const left = await openPage(`${PAGE}?left`);
  prefix("v");
  const right = await startTab();
  const view = PaneViews.get(window);
  Assert.equal(leaves(view.panes).length, 2, "A has two panes");
  const wrapper = left.splitview;
  Assert.ok(wrapper && right.splitview === wrapper, "in one split view");

  await press(")", B);
  const b0 = await startTab();
  Assert.ok(left.hidden && right.hidden, "every member of A's split is hidden");
  Assert.ok(wrapper.hasAttribute("hidden"), "and so is its wrapper");
  Assert.equal(view.panes, null, "B shows one pane");
  Assert.equal(gBrowser.selectedTab, b0, "B's tab is selected");

  await press("(", A);
  Assert.ok(!left.hidden && !right.hidden, "the split comes back");
  Assert.equal(gBrowser.selectedTab, right, "on its focused pane");
  Assert.equal(leaves(view.panes).length, 2, "with A's two panes");
  await until(() => {
    const l = document.getElementById(left.linkedPanel).getBoundingClientRect();
    const r = document.getElementById(right.linkedPanel).getBoundingClientRect();
    return l.width > 100 && r.width > 100 && Math.abs(r.left - l.right) <= 3 && l.top === r.top;
  }, "laid out side by side");

  prefix("x");
  await until(() => !view.panes, "back to one pane");
  for (const t of [left, right, b0]) BrowserTestUtils.removeTab(t);
  for (const t of gBrowser.tabs.filter((t) => workspaceOf(t) === A.id)) {
    BrowserTestUtils.removeTab(t);
  }
  await press("(", main());
});

add_task(async function a_tab_pinned_outside_vimma_is_unpinned_with_a_notice() {
  // Decision 11: hideTab refuses pinned tabs, so a tab pinned by an extension or an imported
  // session would show in every workspace; the host unpins it and says so.
  const A = def("sw-a");
  const tab = await openPage(`${PAGE}?pinned`);
  const home = workspaceOf(tab);
  gBrowser.pinTab(tab);
  await until(() => !tab.pinned, "the tab is unpinned again");
  Assert.equal(workspaceOf(tab), home, "it stays in its workspace");
  await until(
    () => document.getElementById(NOTICE_ID)?.textContent.startsWith("unpinned "),
    "a notice says it was unpinned",
  );
  Assert.stringContains(
    document.getElementById(NOTICE_ID).textContent,
    "every workspace",
    "and why",
  );
  await press(")", A);
  await startTab();
  Assert.ok(tab.hidden, "it is hidden in A like any other tab of its workspace");
  await press("(", main());
  BrowserTestUtils.removeTab(tab);
});

add_task(async function the_goto_picker_lists_every_workspace_and_switches() {
  const A = def("sw-a");
  const B = def("sw-b");
  await press(")", A);
  const a0 = await startTab();
  // A background tab in B's container joins B, hidden (decision 12: no switch on open).
  const bTab = BrowserTestUtils.addTab(gBrowser, `${PAGE}?only-in-b`, {
    userContextId: B.userContextId,
  });
  await BrowserTestUtils.browserLoaded(bTab.linkedBrowser);
  Assert.equal(workspaceOf(bTab), B.id, "a tab in B's container is B's");
  Assert.ok(bTab.hidden, "opened in the background, it stays hidden");
  Assert.equal(active(), A.id, "and A stays");

  prefix("g");
  const picker = document.getElementById(PICKER_ID);
  await until(() => picker?.open, "the picker opens");
  // Recently closed tabs are listed too, after them (docs/specs/tab-search.md).
  const rows = [...picker.querySelectorAll("[role=option]")].filter(
    (r) => !r.dataset.id.startsWith("closed"),
  );
  Assert.equal(
    rows.length,
    ww().model.workspaces.flatMap((w) => w.tabs).length,
    "it lists the tabs of every workspace",
  );
  // It opens typing (docs/specs/tab-search.md, decision 2).
  for (const ch of "only-in-b") EventUtils.synthesizeKey(ch);
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => active() === B.id, "selecting B's tab switches to B");
  Assert.equal(gBrowser.selectedTab, bTab, "on that tab");
  Assert.ok(a0.hidden, "A's tab hides");
  await until(() => segText("workspace") === wsLabel(B), "the bar shows B");

  BrowserTestUtils.removeTab(a0);
  BrowserTestUtils.removeTab(bTab);
  await until(() => !gBrowser.selectedTab.hidden, "a tab is selected");
  ww().switchTo({ id: main().id });
});

add_task(async function new_tabs_join_the_active_workspace_and_other_containers_are_foreign() {
  const A = def("sw-a");
  await press(")", A);
  const a0 = await startTab();
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, null, false, true);
  EventUtils.synthesizeKey("t", { accelKey: true });
  const fresh = await opened;
  Assert.equal(fresh.userContextId, A.userContextId, "ctrl+t opens in A's container");
  Assert.equal(workspaceOf(fresh), A.id, "and joins A");
  Assert.ok(!ww().isForeign(fresh), "not foreign");

  const none = BrowserTestUtils.addTab(gBrowser, PAGE, { userContextId: 0 });
  Assert.equal(none.userContextId, 0, "an explicit container 0 stays 0");
  Assert.equal(workspaceOf(none), A.id, "a tab of no workspace's container joins the active one");
  Assert.ok(ww().isForeign(none), "marked foreign");
  Assert.ok(!none.hidden, "and visible there");

  await press("(", main());
  Assert.ok(none.hidden, "it hides with A");
  for (const t of [a0, fresh, none]) BrowserTestUtils.removeTab(t);
});

add_task(async function colon_workspace_switches_by_name_or_number() {
  const B = def("sw-b");
  const A = def("sw-a");
  await runCommand("workspace sw-b");
  await until(() => active() === B.id, ":workspace sw-b switches to B");
  const b0 = await startTab();
  Assert.deepEqual(gBrowser.visibleTabs, [b0], "showing B");

  const index = WorkspaceStore.definitions.workspaces.findIndex((d) => d.id === A.id) + 1;
  await runCommand(`workspace ${index}`);
  await until(() => active() === A.id, `:workspace ${index} switches to A by number`);
  const a0 = await startTab();

  await runCommand("workspace no-such-ws");
  const notice = document.getElementById(NOTICE_ID);
  await until(() => notice?.matches(":popover-open"), "an unknown name shows a notice");
  Assert.equal(notice.textContent, 'no workspace "no-such-ws"', "saying so");
  Assert.equal(active(), A.id, "and nothing switches");
  notice.hidePopover();

  await runCommand("workspace main");
  await until(() => active() === main().id, ":workspace main");
  BrowserTestUtils.removeTab(a0);
  BrowserTestUtils.removeTab(b0);
});
