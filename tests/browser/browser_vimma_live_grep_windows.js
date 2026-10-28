/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/live-grep.md, the scopes past this workspace: private and agent tabs, other
// windows, the scope box, and recently closed tabs and windows. The rest of live grep is in
// browser_vimma_live_grep.js; the helpers are in head_vimma_grep.js.

"use strict";

/* global focusContent -- from head.js */
/* global VimmaHost, WorkspaceStore, SessionStore -- from head_vimma_grep.js */
/* global TabStateFlusher, GrepMatcher, PAGE, OTHER_WS, def, ww -- from head_vimma_grep.js */
/* global dialog, isOpen, rows, textOf, texts, countText, flagsText -- from head_vimma_grep.js */
/* global noticeText, scopeTitle, scopeLines, closedTitle -- from head_vimma_grep.js */
/* global closeTitled, closeWindowTitled, ctrlS, until, openFixture -- from head_vimma_grep.js */
/* global reset, openGrep, type, clearQuery, resultsSettle -- from head_vimma_grep.js */
/* global setupSecondWorkspace -- from head_vimma_grep.js */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_grep.js", this);

add_task(setupSecondWorkspace);

add_task(async function private_tabs_never_reach_a_normal_window_and_back() {
  await reset();
  await openFixture({ title: "Normal", t: "normal secretneedle" });
  // Normal closed entries that match: the private window must list none of them.
  await closeTitled("Normal gone secretneedle");
  await closeWindowTitled("Normal window secretneedle");
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const url = `${PAGE}?t=${encodeURIComponent("private secretneedle")}`;
  BrowserTestUtils.startLoadingURIString(priv.gBrowser.selectedBrowser, url);
  await BrowserTestUtils.browserLoaded(priv.gBrowser.selectedBrowser, false, url);

  // A private tab closed in the private window: SessionStore keeps it for that window only.
  const closing = BrowserTestUtils.addTab(
    priv.gBrowser,
    `${PAGE}?title=${encodeURIComponent("private closed secretneedle")}`,
  );
  await BrowserTestUtils.browserLoaded(closing.linkedBrowser);
  await until(() => closing.linkedBrowser.contentTitle === "private closed secretneedle", "titled");
  await TabStateFlusher.flush(closing.linkedBrowser);
  BrowserTestUtils.removeTab(closing);
  await until(() => SessionStore.getClosedTabCountForWindow(priv) > 0, "kept as closed");

  await openGrep(priv);
  type("secretneedle", priv);
  await resultsSettle(1, priv);
  Assert.deepEqual(texts(priv), ["private secretneedle"], "the private window: its tabs only");
  ctrlS(priv, 2);
  await until(() => scopeTitle(priv).includes("all windows"), "all windows");
  await resultsSettle(1, priv);
  Assert.deepEqual(texts(priv), ["private secretneedle"], "all windows: the private ones only");
  ctrlS(priv);
  await until(() => scopeTitle(priv).includes("closed"), "closed scope");
  await resultsSettle(2, priv);
  Assert.deepEqual(
    rows(priv).map((r) => [
      r.dataset.kind,
      r.dataset.kind === "closed" ? closedTitle(r) : textOf(r),
    ]),
    [
      ["match", "private secretneedle"],
      ["closed", "private closed secretneedle"],
    ],
    "the private window: its own open and closed tabs, no normal closed tab or window",
  );
  Assert.equal(
    scopeLines(priv).at(-1),
    "recently closed: 1 tab, 0 windows · titles and URLs only",
    "it counts only its own recently closed",
  );
  EventUtils.synthesizeKey("KEY_Escape", {}, priv);
  EventUtils.synthesizeKey("KEY_Escape", {}, priv);

  await SimpleTest.promiseFocus(window);
  await openGrep();
  type("secretneedle");
  await resultsSettle(1);
  for (const scope of ["this window", "all windows"]) {
    EventUtils.synthesizeKey("s", { ctrlKey: true });
    await until(() => scopeTitle() === `Scope: ${scope} · ctrl+s`, scope);
    await resultsSettle(1);
    Assert.deepEqual(texts(), ["normal secretneedle"], `${scope}: never a private tab`);
    Assert.ok(!scopeLines().some((l) => l.startsWith("w2")), `${scope}: no private window`);
  }
  EventUtils.synthesizeKey("s", { ctrlKey: true });
  await until(() => scopeTitle().includes("closed"), "closed scope");
  await resultsSettle(3);
  Assert.deepEqual(
    rows().map((r) => (r.dataset.kind === "closed" ? closedTitle(r) : textOf(r))),
    ["normal secretneedle", "Normal gone secretneedle", "Normal window secretneedle"],
    "closed: the normal side only, never the private closed tab",
  );
  Assert.ok(!scopeLines().some((l) => l.startsWith("w2")), "closed: no private window");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
  await BrowserTestUtils.closeWindow(priv);

  // Firefox keeps no closed private window; its tabs never reach recently closed here.
  await openGrep();
  type("secretneedle");
  ctrlS(window, 3);
  await until(() => scopeTitle().includes("closed"), "closed scope");
  await resultsSettle(3);
  Assert.ok(
    rows().every((r) => !closedTitle(r).startsWith("private") && !textOf(r).startsWith("private")),
    "nothing private from a closed window",
  );
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function the_scope_box_lists_the_windows_and_tabs_searched() {
  await reset();
  ww().switchTo({ id: def(OTHER_WS).id });
  await openFixture({ title: "Delta", t: "delta scopeneedle" });
  ww().switchTo({ id: def("main").id });
  await openFixture({ title: "Alpha", t: "alpha scopeneedle" });
  await openGrep();
  const mainTabs = ww().model.workspaces.find((w) => w.name === "main").tabs.length;
  Assert.deepEqual(
    scopeLines(),
    [`w1 this window: main · ${mainTabs} tabs`],
    "the workspace, its window and its tabs, before anything is typed",
  );
  type("scopeneedle");
  await resultsSettle(1);
  EventUtils.synthesizeKey("s", { ctrlKey: true });
  await resultsSettle(2);
  const [line] = scopeLines();
  Assert.ok(line.startsWith("w1 this window: main "), "this window's workspaces by name");
  Assert.ok(new RegExp(`${OTHER_WS} \\d+`).test(line), "with their tab counts");
  const scope = dialog().querySelector(".vimma-grep-scope");
  const results = dialog().querySelector(".vimma-grep-results");
  Assert.ok(
    scope.getBoundingClientRect().bottom <= results.getBoundingClientRect().top + 1,
    "the scope box sits above the results",
  );
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function rows_name_their_window_tab_and_host() {
  await reset();
  await openFixture({ title: "Hosted", t: "hostneedle here" });
  await openGrep();
  type("hostneedle");
  await resultsSettle(1);
  const row = rows()[0];
  Assert.equal(row.querySelector(".vimma-grep-win")?.textContent, "w1", "its window");
  Assert.ok(row.querySelector(".vimma-grep-tab").textContent.includes("Hosted"), "its tab");
  Assert.equal(row.querySelector(".vimma-grep-host")?.textContent, "example.com", "its host");
  const where = dialog().querySelector(".vimma-grep-preview .vimma-grep-title");
  await until(() => where.textContent.includes("Hosted"), "the preview names the result's tab");
  Assert.equal(where.textContent.split(" · ").at(-1), "example.com", "and its host, last");
  Assert.ok(where.textContent.includes("w1"), "and its window");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function all_windows_searches_the_other_windows_and_enter_goes_there() {
  await reset();
  await openFixture({ title: "Here", t: "farneedle here" });
  const other = await BrowserTestUtils.openNewBrowserWindow();
  const url = `${PAGE}?title=Far&t=${encodeURIComponent("farneedle over there")}`;
  BrowserTestUtils.startLoadingURIString(other.gBrowser.selectedBrowser, url);
  await BrowserTestUtils.browserLoaded(other.gBrowser.selectedBrowser, false, url);
  const farTab = other.gBrowser.selectedTab;

  await SimpleTest.promiseFocus(window);
  await openGrep();
  type("farneedle");
  await resultsSettle(1);
  ctrlS(window, 2);
  await until(() => scopeTitle() === "Scope: all windows · ctrl+s", "all windows");
  await resultsSettle(2);
  Assert.deepEqual(texts(), ["farneedle here", "farneedle over there"], "this window first");
  Assert.equal(rows()[1].querySelector(".vimma-grep-win").textContent, "w2", "marked w2");
  Assert.ok(
    scopeLines().some((l) => l.startsWith("w2: ")),
    "the scope box lists the window",
  );

  EventUtils.synthesizeKey("KEY_ArrowUp");
  const focused = BrowserTestUtils.waitForEvent(other, "focus");
  EventUtils.synthesizeKey("KEY_Enter");
  await focused;
  await until(() => Services.focus.activeWindow === other, "the other window comes to the front");
  Assert.equal(other.gBrowser.selectedTab, farTab, "its tab is selected");
  // One query at a time: a poll left in flight when the window closes rejects in the next task.
  let sel = "";
  for (let i = 0; i < 100 && sel !== "farneedle"; i++) {
    if (i) await new Promise((r) => setTimeout(r, 50));
    sel = await SpecialPowers.spawn(farTab.linkedBrowser, [], () => String(content.getSelection()));
  }
  Assert.equal(sel, "farneedle", "the match is selected there");
  await BrowserTestUtils.closeWindow(other);
  await SimpleTest.promiseFocus(window);
});

add_task(async function closed_tabs_and_windows_match_on_title_and_url_and_enter_reopens() {
  await reset();
  const tab = await openFixture({ title: "Zulu closedneedle", t: "the page text is gone" });
  await TabStateFlusher.flush(tab.linkedBrowser);
  BrowserTestUtils.removeTab(tab);
  const other = await BrowserTestUtils.openNewBrowserWindow();
  const url = `${PAGE}?title=${encodeURIComponent("Yankee closedneedle")}`;
  BrowserTestUtils.startLoadingURIString(other.gBrowser.selectedBrowser, url);
  await BrowserTestUtils.browserLoaded(other.gBrowser.selectedBrowser, false, url);
  await TabStateFlusher.flush(other.gBrowser.selectedBrowser);
  await BrowserTestUtils.closeWindow(other);
  await until(() => SessionStore.getClosedWindowCount() > 0, "the window is kept as closed");

  await SimpleTest.promiseFocus(window);
  await openGrep();
  type("closedneedle");
  await until(() => !dialog().hasAttribute("busy"), "settled");
  Assert.equal(rows().length, 0, "open tabs only, until the closed scope");
  type("|gone");
  await until(() => !dialog().hasAttribute("busy"), "settled");
  Assert.equal(rows().length, 0, "a closed tab's page text is not searched");
  for (let i = 0; i < 5; i++) EventUtils.synthesizeKey("KEY_Backspace");
  ctrlS(window, 3);
  await until(() => scopeTitle() === "Scope: all windows + closed · ctrl+s", "closed");
  await resultsSettle(2);
  Assert.deepEqual(
    rows().map((r) => r.dataset.kind),
    ["closed", "closed"],
    "the closed tab, then the closed window",
  );
  Assert.equal(countText(), "2 / 2", "closed rows count as matches");
  Assert.ok(textOf(rows()[0]).includes("Zulu closedneedle"), "matched on its title");
  Assert.equal(rows()[0].querySelector("mark")?.textContent, "closedneedle", "marked");
  Assert.equal(rows()[0].querySelector(".vimma-grep-tab").textContent, "closed", "labelled");
  Assert.equal(
    rows()[1].querySelector(".vimma-grep-tab").textContent,
    "closed window",
    "the window labelled",
  );
  Assert.ok(
    scopeLines().some((l) => l.startsWith("recently closed: ")),
    "the scope box says what recently closed holds",
  );
  const body = dialog().querySelector(".vimma-grep-preview-body");
  await until(() => body.textContent.includes("Recently closed tab"), "the closed preview");

  const opened = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabOpen");
  // SessionStore labels the tab from its saved state before the page loads; the restore then
  // replaces the browser's first document, and a SpecialPowers.spawn into that one (openGrep's
  // focus check) aborts. Wait for the restore itself, listened for before it can happen.
  const restored = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "SSTabRestored");
  EventUtils.synthesizeKey("KEY_Enter");
  const reopened = (await opened).target;
  Assert.equal((await restored).target, reopened, "the reopened tab is restored");
  await until(() => gBrowser.selectedTab === reopened, "Enter reopens it and goes there");
  await until(() => reopened.label === "Zulu closedneedle", "the closed tab is back");

  await openGrep();
  type("closedneedle");
  ctrlS(window, 3);
  await until(() => scopeTitle().includes("closed"), "closed scope");
  await until(
    () => rows().some((r) => r.dataset.kind === "closed"),
    "the closed window is still listed",
  );
  const winRow = rows().findIndex((r) => r.dataset.kind === "closed");
  for (let i = 0; i < winRow; i++) EventUtils.synthesizeKey("KEY_ArrowUp");
  const newWin = BrowserTestUtils.waitForNewWindow();
  EventUtils.synthesizeKey("KEY_Enter");
  const back = await newWin;
  Assert.ok(back, "Enter on a closed window reopens it");
  await BrowserTestUtils.closeWindow(back);
  await SimpleTest.promiseFocus(window);
});

add_task(async function a_catastrophic_pattern_on_closed_titles_never_freezes_the_browser() {
  await reset();
  const tab = await openFixture({ title: "a".repeat(30) });
  await TabStateFlusher.flush(tab.linkedBrowser);
  BrowserTestUtils.removeTab(tab);
  await openGrep();
  ctrlS(window, 3);
  await until(() => scopeTitle().includes("closed"), "closed scope");
  type("(a+)+b");
  const started = performance.now();
  await until(() => flagsText().includes("timed out"), "the closed titles' search timed out");
  Assert.less(performance.now() - started, 2500, "stopped within its budget, off the main thread");
  clearQuery();
  type("aaa");
  await until(
    () => rows().some((r) => r.dataset.kind === "closed"),
    "the next query runs in a new worker and finds the title",
  );
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
});

add_task(async function the_closed_titles_have_one_matcher_key_until_close() {
  await reset();
  await closeTitled("Keyed closedkeyneedle");
  const closedKeys = () => GrepMatcher.frames.filter((k) => k.startsWith("closed-"));
  await openGrep();
  ctrlS(window, 3);
  await until(() => scopeTitle().includes("closed"), "closed scope");
  type("closedkey");
  await resultsSettle(1);
  Assert.equal(closedKeys().length, 1, "the closed titles are held under one key");
  type("needle");
  await resultsSettle(1);
  Assert.equal(closedKeys().length, 1, "a newer query replaces the older under the same key");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => closedKeys().length === 0, "closing the picker drops them");
});

add_task(async function enter_on_a_closed_row_already_gone_says_so() {
  await reset();
  await closeTitled("Stale staleneedle");
  await openGrep();
  ctrlS(window, 3);
  await until(() => scopeTitle().includes("closed"), "closed scope");
  type("staleneedle");
  await resultsSettle(1);
  const closedId = Number(rows()[0].dataset.tabId.split(":")[1]);
  SessionStore.forgetClosedTabById(closedId);
  const tabs = gBrowser.tabs.length;
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => noticeText() === "no longer in recently closed", "a notice says why");
  Assert.equal(gBrowser.tabs.length, tabs, "nothing reopened");
});

add_task(async function the_grep_list_drops_a_closed_windows_lines() {
  await reset();
  await openFixture({ title: "Here", t: "winclosedneedle here" });
  const other = await BrowserTestUtils.openNewBrowserWindow();
  const url = `${PAGE}?title=There&t=${encodeURIComponent("winclosedneedle there")}`;
  BrowserTestUtils.startLoadingURIString(other.gBrowser.selectedBrowser, url);
  await BrowserTestUtils.browserLoaded(other.gBrowser.selectedBrowser, false, url);
  await SimpleTest.promiseFocus(window);
  await openGrep();
  type("winclosedneedle");
  ctrlS(window, 2);
  await until(() => scopeTitle() === "Scope: all windows · ctrl+s", "all windows");
  await resultsSettle(2);
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !isOpen(), "jumped");
  const session = VimmaHost._grep(window);
  Assert.equal(session.list.rows.length, 2, "the list reaches both windows");
  await BrowserTestUtils.closeWindow(other);
  await SimpleTest.promiseFocus(window);
  Assert.equal(session.list.rows.length, 1, "the closed window's lines are gone");
  Assert.equal(session.watched.size, 1, "and the closed window is no longer watched");
  await focusContent(gBrowser.selectedBrowser);
  type("]q");
  await until(() => noticeText() === "grep 1/1", "]q: one result left");
  Assert.equal(Services.focus.activeWindow, window, "and it stays in this window");
});

add_task(async function a_window_sessionstore_does_not_track_is_skipped() {
  await reset();
  await closeWindowTitled("Tracked trackneedle");
  const real = SessionStore.getClosedTabDataForWindow;
  SessionStore.getClosedTabDataForWindow = (/** @type {Window} */ w) => {
    if (w === window) throw new Error("Window is not tracked");
    return real.call(SessionStore, w);
  };
  try {
    await openGrep();
    type("trackneedle");
    ctrlS(window, 3);
    await until(() => scopeTitle().includes("closed"), "closed scope");
    await resultsSettle(1);
    Assert.equal(rows()[0].dataset.kind, "closed", "the closed window is still listed");
  } finally {
    SessionStore.getClosedTabDataForWindow = real;
    EventUtils.synthesizeKey("KEY_Escape");
    EventUtils.synthesizeKey("KEY_Escape");
  }
});

add_task(async function the_panel_starts_at_the_page_top_and_follows_the_toolbar() {
  await reset();
  const content = () => gBrowser.tabbox.getBoundingClientRect();
  await openGrep();
  const top = () => dialog().getBoundingClientRect().top;
  Assert.lessOrEqual(Math.abs(top() - content().top), 1, "the panel starts where the page does");
  Assert.lessOrEqual(dialog().getBoundingClientRect().bottom, content().bottom + 1, "and ends");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");

  const navBar = document.getElementById("nav-bar");
  navBar.setAttribute("collapsed", "true");
  try {
    await until(() => content().top < 10, "without the toolbar the page starts at the top");
    await openGrep();
    Assert.lessOrEqual(Math.abs(top() - content().top), 1, "the panel moves up with the page");
    EventUtils.synthesizeKey("KEY_Escape");
    EventUtils.synthesizeKey("KEY_Escape");
  } finally {
    navBar.removeAttribute("collapsed");
  }
});

add_task(async function agent_tabs_only_in_window_scope_marked_and_last() {
  await reset();
  const agent = WorkspaceStore.agent;
  Assert.ok(agent, "the profile has the agent workspace");
  const url = `${PAGE}?t=${encodeURIComponent("agentneedle from an agent")}`;
  const agentTab = gBrowser.addTab(url, {
    userContextId: agent.userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(agentTab.linkedBrowser, false, url);
  await until(() => agentTab.hidden, "the agent tab is hidden in its workspace");
  await openFixture({ title: "Mine", t: "agentneedle of mine" });
  await openGrep();
  type("agentneedle");
  await resultsSettle(1);
  Assert.deepEqual(texts(), ["agentneedle of mine"], "the workspace scope leaves agent tabs out");
  EventUtils.synthesizeKey("s", { ctrlKey: true });
  await resultsSettle(2);
  Assert.equal(textOf(rows()[1]), "agentneedle from an agent", "window scope: the agent's, last");
  Assert.equal(
    rows()[1].querySelector(".vimma-grep-agent")?.textContent,
    "◇ agent",
    "marked as the agent's",
  );
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
  BrowserTestUtils.removeTab(agentTab);
});
