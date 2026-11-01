/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/side-panel-unsplit.md. With a split, the side panel opens with the panes'
// tabs marked; `space` unmarks or marks as for multiselect, and `Enter` applies a change: a
// pane unmarked leaves the split and stays open right after it, the other panes keep their
// shape and sizes; one mark or none ends the split; a tab marked joins and the set is arranged
// afresh. `Enter` on unchanged marks goes to the row; `Esc` puts changed marks back, then closes.

"use strict";

/* global focusContent -- from head.js */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const Panes = ChromeUtils.importESModule("chrome://browser/content/vimma/core/panes.mjs");
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);

const PAGE = "https://example.com/";
const PANEL_ID = "vimma-panel";
const NOTICE_ID = "vimma-notice";
const WIDTH = 1280;
const HEIGHT = 800;

const view = (win = window) => PaneViews.get(win);
const panel = (win = window) => win.document.getElementById(PANEL_ID);
const isOpen = (win = window) =>
  !!panel(win) && !panel(win).hidden && BrowserTestUtils.isVisible(panel(win));
const rows = (win = window) => [...(panel(win)?.querySelectorAll("[role=option]") ?? [])];
const titleOf = (row) => row.querySelector(".vimma-panel-title")?.textContent ?? "";
const rowOf = (name) => rows().find((r) => titleOf(r) === name);
const gutterOf = (name) => rowOf(name)?.querySelector(".vimma-panel-mark")?.textContent ?? "";
const selected = () => panel().querySelector("[role=option][aria-selected=true]");
const count = (win = window) => panel(win).querySelector(".vimma-panel-count");
const markedTitles = (win = window) =>
  rows(win)
    .filter((r) => r.getAttribute("aria-checked") === "true")
    .map(titleOf);

function notice() {
  const n = document.getElementById(NOTICE_ID);
  return n && n.matches(":popover-open") ? n.textContent : null;
}

function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 200);
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

/** @type {Map<string, Element>} */
const byName = new Map();
const tab = (name) => /** @type {Element} */ (byName.get(name));
const nameOf = (t) => [...byName].find(([, x]) => x === t)?.[0] ?? t.label;
const tabOf = (panelId) => gBrowser.tabs.find((t) => t.linkedPanel === panelId);

/** The shown tree with each leaf named by its tab: `x[a,y[b,c]]`; one pane: "". */
function shape(panes = view().panes) {
  const walk = (n) =>
    n.type === "leaf" ? nameOf(tabOf(n.tab)) : `${n.axis}[${n.children.map(walk).join(",")}]`;
  return panes ? walk(panes.root) : "";
}

/** Every split's ratios, depth first. */
function ratios(node) {
  return node.type === "leaf" ? [] : [node.ratios.slice(), ...node.children.flatMap(ratios)];
}

function focusedName() {
  const p = view().panes;
  return nameOf(tabOf(Panes.leaves(p).find((l) => l.pane === p.focus).tab));
}

/** A page titled `name` with a tall body, a text field and a JS marker. */
async function page(name) {
  const t = BrowserTestUtils.addTab(gBrowser, `${PAGE}?${name}`);
  await BrowserTestUtils.browserLoaded(t.linkedBrowser);
  await SpecialPowers.spawn(t.linkedBrowser, [name], (n) => {
    const doc = content.document;
    doc.title = n;
    const input = doc.createElement("input");
    input.id = "field";
    input.value = `typed in ${n}`;
    const tall = doc.createElement("div");
    tall.style.height = "5000px";
    doc.body.prepend(input, tall);
    content.scrollTo(0, 1234);
    content.wrappedJSObject.vimmaMarker = n;
  });
  await until(() => t.linkedBrowser.contentTitle === name, `${name} has its title`);
  byName.set(name, t);
  return t;
}

/** What a reload or a recreated page would change. */
function identity(tabs) {
  return tabs.map((t) => ({
    browser: t.linkedBrowser,
    outerWindowID: t.linkedBrowser.outerWindowID,
    innerWindowId: t.linkedBrowser.browsingContext.currentWindowGlobal.innerWindowId,
  }));
}

/** No page reloaded: same browser and document, marker, scroll and typed text. */
async function assertNotReloaded(tabs, before, what) {
  const now = identity(tabs);
  for (const [i, t] of tabs.entries()) {
    const n = nameOf(t);
    Assert.equal(now[i].browser, before[i].browser, `${what}: ${n} keeps its <browser>`);
    Assert.equal(now[i].outerWindowID, before[i].outerWindowID, `${what}: ${n}'s window`);
    Assert.equal(now[i].innerWindowId, before[i].innerWindowId, `${what}: ${n}'s document`);
    const state = await SpecialPowers.spawn(t.linkedBrowser, [], () => ({
      marker: content.wrappedJSObject.vimmaMarker,
      field: content.document.getElementById("field")?.value,
      scrolled: content.scrollY,
    }));
    Assert.equal(state.marker, n, `${what}: ${n}'s page state survives`);
    Assert.equal(state.field, `typed in ${n}`, `${what}: ${n}'s typed text survives`);
    Assert.equal(state.scrolled, 1234, `${what}: ${n}'s scroll position survives`);
  }
}

/** ctrl+b, then `key`. */
function prefix(key, win = window, modifiers = {}) {
  EventUtils.synthesizeKey("b", { ctrlKey: true }, win);
  EventUtils.synthesizeKey(key, modifiers, win);
}

async function openPanel() {
  const browser = gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the selected page has loaded");
  await focusContent(browser);
  prefix("b");
  await until(() => isOpen(), "ctrl+b b opens the side panel");
}

/** j / k until the highlight is on the row titled `name`. */
async function goTo(name) {
  const at = rows().findIndex((r) => titleOf(r) === name);
  Assert.greaterOrEqual(at, 0, `${name} is listed`);
  for (let i = 0; i < 20 && rows().indexOf(selected()) !== at; i++) {
    EventUtils.synthesizeKey(rows().indexOf(selected()) < at ? "j" : "k", {});
  }
  await until(() => titleOf(selected()) === name, `the highlight is on ${name}`);
}

/** `space` on each named row, which flips its mark. */
async function toggle(...names) {
  for (const n of names) {
    await goTo(n);
    const was = markedTitles().includes(n);
    EventUtils.synthesizeKey(" ", {});
    await until(() => markedTitles().includes(n) !== was, `${n} is ${was ? "un" : ""}marked`);
    Assert.equal(titleOf(selected()), n, `the highlight stays on ${n}`);
  }
}

async function enter() {
  EventUtils.synthesizeKey("KEY_Enter", {});
  await until(() => !isOpen(), "Enter closes the panel");
}

/** Shows the named tabs as the panes (no panel), focus on `focus`. */
async function split(names, focus = names[0]) {
  const result = view().showTabs(names.map(tab), tab(focus));
  Assert.ok(result.ok, `split ${names.join(", ")}`);
  await until(() => gBrowser.selectedTab === tab(focus), `${focus}'s pane is selected`);
  await nextFrame();
}

/** The tab strip's order of the workspace's tabs we made. */
const tabOrder = () => gBrowser.tabs.filter((t) => [...byName.values()].includes(t)).map(nameOf);

/** @type {Element[]} */
const opened = [];
const startSize = [window.outerWidth, window.outerHeight];

async function reset() {
  for (let i = 0; i < 3 && isOpen(); i++) EventUtils.synthesizeKey("KEY_Escape", {});
  while (view().panes) view().close();
  view().max = Panes.PANES_MAX_DEFAULT;
  view().mode = "dwindle";
  document.getElementById(NOTICE_ID)?.hidePopover?.();
  await nextFrame();
}

registerCleanupFunction(async () => {
  await reset();
  for (const t of opened.splice(0)) if (!t.closing && t.parentNode) gBrowser.removeTab(t);
  window.resizeTo(...startSize);
  Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
  Services.prefs.clearUserPref("sidebar.verticalTabs.dragToPinPromo.dismissed");
});

add_task(async function setup_five_pages() {
  await WindowWorkspaces.get(window).ready;
  if (window.outerWidth !== WIDTH || window.outerHeight !== HEIGHT) {
    const resized = BrowserTestUtils.waitForEvent(window, "resize");
    window.resizeTo(WIDTH, HEIGHT);
    await resized;
  }
  for (const n of ["a", "b", "c", "d", "e"]) opened.push(await page(n));
  await BrowserTestUtils.switchTab(gBrowser, tab("a"));
});

add_task(async function without_a_split_nothing_is_marked_and_esc_closes_once() {
  await openPanel();
  Assert.ok(!rows().some((r) => r.hasAttribute("aria-checked")), "no checked state");
  Assert.equal(count().textContent, "", "no count");
  EventUtils.synthesizeKey("KEY_Escape", {});
  await until(() => !isOpen(), "one Esc closes the panel");
});

add_task(async function a_split_opens_with_its_panes_marked_and_one_esc_closes() {
  await split(["a", "b", "c"]);
  await openPanel();
  Assert.deepEqual(
    markedTitles(),
    tabOrder().filter((n) => "abc".includes(n)),
    "a, b, c",
  );
  Assert.equal(count().textContent, "split: 3 panes", "the header names the split");
  for (const n of ["d", "e"]) {
    Assert.equal(rowOf(n).getAttribute("aria-checked"), "false", `${n} is checkable, unchecked`);
    Assert.equal(gutterOf(n), "", `${n}'s gutter is empty`);
  }
  Assert.equal(gutterOf("b"), "●", "a pane's row shows ●");
  EventUtils.synthesizeKey("KEY_Escape", {});
  await until(() => !isOpen(), "with the marks unchanged one Esc closes the panel");
  Assert.equal(shape(), "x[a,y[b,c]]", "the split is unchanged");
});

add_task(async function enter_on_unchanged_marks_goes_to_the_highlighted_row() {
  await openPanel();
  await goTo("b");
  await enter();
  await until(() => focusedName() === "b", "b's pane has focus");
  Assert.equal(shape(), "x[a,y[b,c]]", "the split is unchanged");
  await reset();
});

add_task(async function unmarking_a_pane_keeps_the_others_shape_and_the_tab_after_the_split() {
  await split(["a", "b", "c", "d"], "a");
  Assert.ok(view().resize("wider", 0.1).ok, "a is made wider by hand");
  const before = view().panes;
  const cPane = Panes.paneOfTab(before, tab("c").linkedPanel);
  const want = Panes.closePane(before, cPane);
  const all = ["a", "b", "c", "d"].map(tab);
  const kept = identity(all);

  await openPanel();
  await toggle("c");
  Assert.equal(count().textContent, "split: 4 → 3", "the header says what Enter will do");
  Assert.equal(gutterOf("c"), "○", "c shows it will leave");
  Assert.equal(rowOf("c").getAttribute("aria-checked"), "false", "c is unchecked");
  await goTo("d");
  await enter();

  await until(() => shape() === shape(want), `the rest keep their shape: ${shape(want)}`);
  Assert.deepEqual(ratios(view().panes.root), ratios(want.root), "and their sizes");
  Assert.equal(view().panes.layout, before.layout, "the stored preset is kept");
  Assert.equal(focusedName(), "d", "Enter goes to the highlighted row: d, a pane");
  Assert.ok(tab("c").isConnected && !tab("c").closing, "c is still open");
  Assert.ok(!tab("c").splitview, "c left the split");
  const order = gBrowser.tabs;
  const lastPane = Math.max(...["a", "b", "d"].map((n) => order.indexOf(tab(n))));
  const firstPane = Math.min(...["a", "b", "d"].map((n) => order.indexOf(tab(n))));
  Assert.equal(lastPane - firstPane, 2, "the panes' tabs sit together");
  Assert.equal(order.indexOf(tab("c")), lastPane + 1, "c sits right after the split");
  Assert.equal(gBrowser.selectedTab, tab(focusedName()), "its tab is selected");
  await assertNotReloaded(all, kept, "unmark one");
});

add_task(async function esc_puts_changed_marks_back_then_closes() {
  const was = shape();
  await openPanel();
  await toggle("a", "e");
  Assert.equal(count().textContent, "split: 3 → 3");
  EventUtils.synthesizeKey("KEY_Escape", {});
  await until(() => count().textContent === "split: 3 panes", "Esc puts the marks back");
  Assert.deepEqual(
    [...markedTitles()].sort(),
    ["a", "b", "d"],
    "the panes are marked again, e is not",
  );
  Assert.ok(isOpen(), "the panel stays open");
  EventUtils.synthesizeKey("KEY_Escape", {});
  await until(() => !isOpen(), "a second Esc closes it");
  Assert.equal(shape(), was, "the split is unchanged");
});

add_task(async function marking_a_tab_adds_it_and_the_set_is_arranged_afresh() {
  const all = ["a", "b", "c", "d"].map(tab);
  const kept = identity(all);
  await openPanel();
  await toggle("c");
  const [p, q, r, s] = markedTitles();
  await goTo("d");
  await enter();
  const want = `x[${p},y[${q},x[${r},${s}]]]`;
  await until(() => shape() === want, `a dwindle of four, in row order: ${want}`);
  Assert.equal(focusedName(), "d", "the highlighted row (d) has focus");
  await assertNotReloaded(all, kept, "add one");
});

add_task(async function past_max_is_refused_and_nothing_changes() {
  view().max = 4;
  const was = shape();
  await openPanel();
  await toggle("e");
  EventUtils.synthesizeKey("KEY_Enter", {});
  await until(() => notice() !== null, "a notice");
  Assert.equal(notice(), "Show together: at most 4 panes", "naming the limit");
  Assert.ok(isOpen(), "the panel stays open");
  Assert.equal(markedTitles().length, 5, "with its marks");
  Assert.equal(shape(), was, "the panes are unchanged");
  EventUtils.synthesizeKey("KEY_Escape", {});
  EventUtils.synthesizeKey("KEY_Escape", {});
  await until(() => !isOpen(), "Esc Esc closes");
  await reset();
});

add_task(async function remove_one_and_add_another_in_one_enter() {
  await split(["a", "b", "c"], "b");
  await openPanel();
  await toggle("a", "e");
  Assert.equal(count().textContent, "split: 3 → 3");
  const [p, q, r] = markedTitles();
  await enter();
  await until(() => shape() === `x[${p},y[${q},${r}]]`, "b, c and e as a dwindle");
  Assert.equal(focusedName(), "e", "the highlighted row (e, the last) has focus");
  Assert.ok(!tab("a").splitview && tab("a").isConnected, "a left and stays open");
  await reset();
});

add_task(async function unmarking_down_to_one_ends_the_split() {
  await split(["a", "b", "c"], "a");
  await openPanel();
  await toggle("a", "c");
  Assert.equal(count().textContent, "split: 3 → 1 (unsplit)");
  await goTo("b");
  await enter();
  await until(() => !view().panes, "no split");
  Assert.equal(gBrowser.selectedTab, tab("b"), "b is shown alone");
  await until(() => document.activeElement === tab("b").linkedBrowser, "its page has focus");
  for (const n of ["a", "c"]) {
    Assert.ok(tab(n).isConnected && !tab(n).splitview, `${n} is open and out of the split`);
  }
  Assert.ok(!tab("b").splitview, "no wrapper is left");
});

add_task(async function unmarking_every_pane_shows_the_highlighted_tab_alone() {
  await split(["a", "b"], "a");
  await openPanel();
  await toggle("a", "b");
  Assert.equal(count().textContent, "split: 2 → 0 (unsplit)");
  await goTo("e");
  await enter();
  await until(() => !view().panes, "no split");
  Assert.equal(gBrowser.selectedTab, tab("e"), "e, the highlighted row, is shown alone");
  await reset();
});

// Revision (decisions 20-27): a split kept as a hidden view.
const hiddenView = () => view().panes?.hidden === true;
const segText = (id) =>
  document.getElementById("vimma-statusbar")?.querySelector(`[data-segment="${id}"]`)
    ?.textContent ?? null;

add_task(async function the_users_flow_space_on_c_enter_on_c_shows_c_alone() {
  await split(["a", "b", "c"], "a");
  Assert.ok(view().resize("wider", 0.1).ok, "a is made wider by hand");
  const want = Panes.closePane(view().panes, Panes.paneOfTab(view().panes, tab("c").linkedPanel));
  await openPanel();
  await toggle("c");
  await goTo("c");
  await enter();
  await until(() => gBrowser.selectedTab === tab("c"), "c is selected");
  Assert.ok(hiddenView(), "a and b stay a view, hidden");
  Assert.equal(shape(), shape(want), "the view is a | b");
  Assert.deepEqual(ratios(view().panes.root), ratios(want.root), "at their sizes");
  Assert.ok(!tab("c").splitview, "c is out of the split, alone");
  await until(() => document.activeElement === tab("c").linkedBrowser, "c's page has focus");
  await until(() => segText("pane") === "split 2 hidden", "the status bar says so");
  for (const n of ["a", "b"]) {
    const panel = document.getElementById(tab(n).linkedPanel);
    Assert.ok(
      !panel.classList.contains("split-view-panel-active"),
      `${n}'s panel is suspended, not drawn over c`,
    );
  }
  Assert.equal(
    document.elementFromPoint(100, 300)?.closest?.(".browserSidebarContainer")?.id,
    tab("c").linkedPanel,
    "what shows on the left is c",
  );

  await openPanel();
  Assert.equal(count().textContent, "split: 2 panes (hidden)", "the panel header says so");
  Assert.deepEqual([...markedTitles()].sort(), ["a", "b"], "with the view's tabs marked");
  EventUtils.synthesizeKey("KEY_Escape", {});
  await until(() => !isOpen(), "one Esc closes the panel");
});

add_task(async function picking_a_tab_of_the_hidden_view_brings_it_back_whole() {
  const before = ratios(view().panes.root);
  await openPanel();
  await goTo("b");
  await enter();
  await until(() => !hiddenView(), "the view shows again");
  Assert.equal(focusedName(), "b", "focused on b's pane");
  Assert.deepEqual(ratios(view().panes.root), before, "at its sizes");
  await until(() => segText("pane") === "pane 2/2", "the status bar is back to pane 2/2");
});

add_task(async function every_route_to_an_outside_tab_shows_it_alone() {
  // The panel's Enter on an unmarked row, marks unchanged.
  await openPanel();
  await goTo("d");
  await enter();
  await until(() => gBrowser.selectedTab === tab("d") && hiddenView(), "Enter: d alone");
  gBrowser.selectedTab = tab("a");
  Assert.ok(!hiddenView(), "a brings the view back");

  // ctrl+b n / p step through the tab order: a view's tab shows the view, any other alone.
  const order = gBrowser.visibleTabs;
  const next = order[order.indexOf(gBrowser.selectedTab) + 1];
  await focusContent(gBrowser.selectedBrowser);
  prefix("n");
  await until(() => gBrowser.selectedTab === next, "ctrl+b n moves on");
  Assert.equal(hiddenView(), !Panes.paneOfTab(view().panes, next.linkedPanel), "per its tab");

  // The goto picker.
  gBrowser.selectedTab = tab("a");
  await focusContent(gBrowser.selectedBrowser);
  prefix("g");
  await until(() => document.getElementById("vimma-picker")?.open, "the picker opens");
  EventUtils.synthesizeKey("e"); // it opens typing (docs/specs/tab-search.md)
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => gBrowser.selectedTab === tab("e"), "the picker selects e");
  Assert.ok(hiddenView(), "e alone, the view hidden");
  Assert.deepEqual(
    Panes.leaves(view().panes).map((l) => nameOf(tabOf(l.tab))),
    ["a", "b"],
    "the view is unchanged",
  );
  await reset();
});

add_task(async function another_workspace_in_the_panel_shows_its_own_split() {
  const w = WorkspaceStore.addWorkspace({ name: "unsplit-b", color: "blue", icon: "briefcase" });
  registerCleanupFunction(() => WorkspaceStore.deleteWorkspace(w.id, { confirmed: true }));
  const win = await BrowserTestUtils.openNewBrowserWindow();
  registerCleanupFunction(() => !win.closed && BrowserTestUtils.closeWindow(win));
  const ww = WindowWorkspaces.get(win);
  await ww.ready;
  await until(() => !!ww.model, "the new window has its workspaces");
  const add = async (q) => {
    const t = BrowserTestUtils.addTab(win.gBrowser, `${PAGE}?${q}`);
    await BrowserTestUtils.browserLoaded(t.linkedBrowser);
    return t;
  };
  const first = ww.model.active;
  const x = await add("x");
  Assert.ok(view(win).split("vertical", { tab: x }).ok, "the first workspace: start | x");
  ww.switchTo({ id: w.id });
  await until(() => ww.model.active === w.id, "the second workspace");
  const inW = () => win.gBrowser.selectedTab.userContextId === Number(w.userContextId);
  await until(inW, "its start tab is selected");
  const y = await add("y");
  await add("z");
  Assert.ok(view(win).split("vertical", { tab: y }).ok, "the second workspace: start | y");

  await SimpleTest.promiseFocus(win);
  win.gBrowser.selectedBrowser.focus();
  prefix("b", win);
  await until(() => isOpen(win), "the panel opens");
  await until(() => count(win).textContent === "split: 2 panes", "on the second's split");
  Assert.equal(markedTitles(win).length, 2, "its two panes are marked");
  prefix("(", win, { shiftKey: true });
  await until(() => ww.model.active === first, "ctrl+b ( lists the first workspace");
  await until(() => count(win).textContent === "split: 2 panes", "with its own split");
  Assert.equal(markedTitles(win).length, 2, "and its two panes marked");
  Assert.equal(
    rows(win).length,
    2,
    "the first workspace lists two tabs, both panes (the start tab and x)",
  );
  await BrowserTestUtils.closeWindow(win);
});

// docs/specs/follow-link-switch.md behaviour 5: gF's switching open takes the focused pane, as
// every new foreground tab does in a split (decision 22), and the hinted tab stays open.
add_task(async function a_switching_follow_in_a_split_takes_the_focused_pane() {
  await reset();
  await split(["a", "b"], "a");
  const target = `${PAGE}?followed`;
  await SpecialPowers.spawn(tab("a").linkedBrowser, [target], (href) => {
    const a = content.document.createElement("a");
    a.href = href;
    a.textContent = "followed";
    a.style.cssText = "position: fixed; top: 10px; left: 10px; z-index: 9";
    content.document.body.append(a);
  });
  await focusContent(tab("a").linkedBrowser);
  EventUtils.synthesizeKey("g", {});
  EventUtils.synthesizeKey("F", { shiftKey: true });
  await until(() => VimmaHost._hints(window)?.hints.length, "gF labels the links");
  const { label } = VimmaHost._hints(window).hints.find((h) => h.target.href === target);
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, target, true);
  for (const c of label.slice(0, -1)) EventUtils.synthesizeKey(c, {});
  EventUtils.synthesizeKey(label.slice(-1).toUpperCase(), { shiftKey: true });
  const followed = await opened;
  byName.set("followed", followed);
  await until(() => gBrowser.selectedTab === followed, "the new tab is selected");
  await until(
    () => shape() === "x[followed,b]" || shape() === "y[followed,b]",
    "it takes a's pane",
  );
  Assert.equal(focusedName(), "followed", "and its focus");
  Assert.ok(tab("a").parentNode && !tab("a").closing, "the hinted tab stays open");
  await reset();
  gBrowser.removeTab(followed);
});
