/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m1-cmdline.md

"use strict";

const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);

/* global focusContent, recordPageKeys, pageKeys, waitForPageKey, bindUnbuiltPrefixKey -- from head.js */

// ctrl+b o: a key under the prefix the host has not built (head.js).
bindUnbuiltPrefixKey();

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { completeCommandLine } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/cmdline.mjs",
);
const { SearchTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/SearchTestUtils.sys.mjs",
);
SearchTestUtils.init(this);

const PAGE = "https://example.org/";
const BLOCKED = "blocked: javascript: and data: URLs can't be opened from the command line";
const CMDLINE_ID = "vimma-cmdline";
const INPUT_ID = "vimma-cmdline-input";
const NOTICE_ID = "vimma-notice";
const HELP_ID = "vimma-help";

/** Every tab this file opened is closed again, even when a task fails half-way. */
registerCleanupFunction(() => {
  while (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs.at(-1));
});

const input = (win = window) => win.document.getElementById(INPUT_ID);
const container = (win = window) => win.document.getElementById(CMDLINE_ID);
const isOpen = (win = window) => !!container(win) && !container(win).hidden;
const errorText = () => container().querySelector(".vimma-cmdline-error")?.textContent ?? "";
const errorShown = () => {
  const el = container().querySelector(".vimma-cmdline-error");
  return !!el && !el.hidden && BrowserTestUtils.isVisible(el);
};
const options = () => [...container().querySelectorAll("[role=option]")];
const selectedOption = () => container().querySelector("[role=option][aria-selected=true]");

function noticeShown() {
  const n = document.getElementById(NOTICE_ID);
  return !!n && n.matches(":popover-open") && BrowserTestUtils.isVisible(n);
}

/** Selects `tab`; BrowserTestUtils.switchTab never resolves for the tab already selected. */
async function select(tab) {
  if (gBrowser.selectedTab !== tab) await BrowserTestUtils.switchTab(gBrowser, tab);
}

/** Opens `n` pages, each recording its keys, and focuses the first (normal mode). */
async function openTabs(n, url = PAGE) {
  const tabs = [];
  for (let i = 0; i < n; i++) {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${url}?tab=${i}`);
    await recordPageKeys(tab.linkedBrowser);
    tabs.push(tab);
  }
  await select(tabs[0]);
  await focusContent(tabs[0].linkedBrowser);
  Assert.equal(VimmaHost.status(window).mode, "normal", "sanity: the page is in normal mode");
  return tabs;
}

function closeTabs(tabs) {
  for (const tab of tabs) if (!tab.closing && tab.isConnected) BrowserTestUtils.removeTab(tab);
}

/** `:` as typed on a US layout. */
function colon(win = window) {
  EventUtils.synthesizeKey(":", { shiftKey: true }, win);
}

/** `:`, then `line` typed key by key. */
function typeCommand(line, win = window) {
  colon(win);
  Assert.ok(isOpen(win), "the command line is open");
  EventUtils.sendString(line, win);
}

/** `:line` Enter. */
function runCommand(line, win = window) {
  typeCommand(line, win);
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
}

/** Presses z (unbound) in `tab`'s page and returns every key it saw, ending with "z". */
async function pageKeysThenZ(tab) {
  await select(tab);
  const browser = tab.linkedBrowser;
  await focusContent(browser);
  EventUtils.synthesizeKey("z");
  await waitForPageKey(browser, ["z", "!z"]);
  return pageKeys(browser);
}

/** The next TabOpen, or null after 5 s (a command that opens nothing fails, not times out). */
function tabOpened() {
  const opened = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabOpen");
  return Promise.race([
    opened.then((e) => e.target),
    new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);
}

add_task(async function colon_opens_the_command_line_and_esc_closes_it() {
  const tabs = await openTabs(1);
  const browser = tabs[0].linkedBrowser;
  colon();
  Assert.ok(isOpen(), ": opens the command line");
  Assert.ok(BrowserTestUtils.isVisible(input()), "its input is visible");
  const box = input().getBoundingClientRect();
  Assert.equal(
    document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2),
    input(),
    "on top of the page, not under it",
  );
  Assert.lessOrEqual(
    Math.round(box.bottom),
    Math.round(document.documentElement.getBoundingClientRect().bottom),
    "inside the window, at its foot",
  );
  Assert.greater(
    box.top,
    browser.getBoundingClientRect().top + browser.getBoundingClientRect().height / 2,
    "in the lower half of the content area",
  );
  Assert.equal(document.activeElement, input(), "with focus in it");
  Assert.equal(VimmaHost.status(window).mode, "command", "in command mode");
  Assert.equal(input().value, "", "empty");

  EventUtils.sendString("jk:x");
  Assert.equal(input().value, "jk:x", "keys type into it, : and the scroll keys too");

  EventUtils.synthesizeKey("KEY_Escape");
  Assert.ok(!isOpen(), "Esc closes it");
  Assert.equal(document.activeElement, browser, "focus is back on the page");
  Assert.equal(VimmaHost.status(window).mode, "normal", "and the mode is normal again");

  colon();
  Assert.equal(input().value, "", "it opens empty the next time");
  EventUtils.synthesizeKey("KEY_Escape");

  Assert.deepEqual(await pageKeysThenZ(tabs[0]), ["z"], "the page saw none of those keys");
  closeTabs(tabs);
});

add_task(async function colon_in_a_text_field_is_typed() {
  const tabs = await openTabs(1);
  const browser = tabs[0].linkedBrowser;
  await SpecialPowers.spawn(browser, [], () => {
    const field = content.document.createElement("input");
    field.id = "field";
    content.document.body.prepend(field);
    field.focus();
  });
  await TestUtils.waitForCondition(() => VimmaHost.status(window).mode === "insert", "insert mode");
  colon();
  Assert.ok(!isOpen(), ": in insert mode does not open the command line");
  const value = await SpecialPowers.spawn(browser, [], () =>
    ContentTaskUtils.waitForCondition(
      () => content.document.getElementById("field").value === ":",
      "the page's field got :",
    ).then(() => content.document.getElementById("field").value),
  );
  Assert.equal(value, ":", "it is typed into the field");
  closeTabs(tabs);
});

add_task(async function tabnew_opens_a_tab() {
  const tabs = await openTabs(1);
  const count = gBrowser.tabs.length;
  const opened = tabOpened();
  runCommand("tabnew");
  const tab = await opened;
  Assert.ok(tab, ":tabnew opens a tab");
  Assert.equal(gBrowser.tabs.length, count + 1, "one tab more");
  Assert.equal(gBrowser.selectedTab, tab, "and selects it");
  Assert.ok(!isOpen(), "the command line closed");
  Assert.deepEqual(await pageKeysThenZ(tabs[0]), ["z"], "the page saw none of the keys");
  closeTabs([...tabs, tab]);
});

add_task(async function q_closes_the_tab_but_not_a_pinned_one() {
  const tabs = await openTabs(3);
  const count = gBrowser.tabs.length;
  const closed = BrowserTestUtils.waitForTabClosing(tabs[0]);
  runCommand("q");
  await closed;
  Assert.ok(tabs[0].closing, ":q closes the selected tab");
  await TestUtils.waitForCondition(() => !tabs[0].isConnected, "the closed tab is removed");
  Assert.equal(gBrowser.tabs.length, count - 1, "and only that one");
  Assert.ok(!isOpen(), "the command line closed");

  // Decision 11 unpins it in a window with workspaces; this checks the guard other windows keep.
  WindowWorkspaces.get(window).unpinsPinnedTabs = false;
  gBrowser.pinTab(tabs[2]);
  await select(tabs[2]);
  await focusContent(tabs[2].linkedBrowser);
  runCommand("quit");
  Assert.equal(gBrowser.tabs.length, count - 1, ":quit on a pinned tab closes nothing");
  Assert.equal(
    gBrowser.selectedTab,
    gBrowser.tabs[gBrowser.pinnedTabCount],
    "and selects the first unpinned tab, as tab.close does",
  );
  gBrowser.unpinTab(tabs[2]);
  WindowWorkspaces.get(window).unpinsPinnedTabs = true;
  Assert.deepEqual(await pageKeysThenZ(tabs[1]), ["z"], "no page saw the keys");
  closeTabs(tabs);
});

add_task(async function q_on_the_last_tab_follows_close_window_with_last_tab() {
  await SpecialPowers.pushPrefEnv({ set: [["browser.tabs.closeWindowWithLastTab", false]] });
  const win = await BrowserTestUtils.openNewBrowserWindow();
  const browser = win.gBrowser.selectedBrowser;
  BrowserTestUtils.startLoadingURIString(browser, PAGE);
  await BrowserTestUtils.browserLoaded(browser, false, PAGE);
  await SimpleTest.promiseFocus(win);
  await SimpleTest.promiseFocus(browser);
  const first = win.gBrowser.selectedTab;
  runCommand("q", win);
  await TestUtils.waitForCondition(() => !first.isConnected, "the tab is closed");
  Assert.ok(!win.closed, "the window stays (closeWindowWithLastTab = false)");
  Assert.equal(win.gBrowser.tabs.length, 1, "with a fresh tab");
  await BrowserTestUtils.closeWindow(win);
  await SpecialPowers.popPrefEnv();
});

add_task(async function tab_completes_and_cycles() {
  const tabs = await openTabs(1);
  const expected = completeCommandLine("tabn").candidates.map((c) => c.value);
  Assert.equal(expected[0], "tabnew", "sanity: core's first candidate");
  Assert.greater(expected.length, 1, "sanity: more than one candidate to cycle");

  typeCommand("tabn");
  Assert.ok(options().length >= 2, "the list shows the candidates as you type");
  EventUtils.synthesizeKey("KEY_Tab");
  Assert.equal(input().value, "tabnew", "Tab completes tabn to tabnew");
  Assert.equal(document.activeElement, input(), "and keeps focus in the line");
  Assert.equal(selectedOption()?.dataset.value, "tabnew", "the list marks it");
  EventUtils.synthesizeKey("KEY_Tab");
  Assert.equal(input().value, expected[1], "Tab again cycles to the next candidate");
  EventUtils.synthesizeKey("KEY_Tab", { shiftKey: true });
  Assert.equal(input().value, "tabnew", "shift+Tab goes back");
  EventUtils.synthesizeKey("KEY_Escape");
  Assert.ok(!isOpen(), "Esc closes it");
  Assert.deepEqual(await pageKeysThenZ(tabs[0]), ["z"], "the page saw none of the keys");
  closeTabs(tabs);
});

add_task(async function up_recalls_the_previous_command() {
  const tabs = await openTabs(1);
  runCommand("scroll_top");
  Assert.ok(!isOpen(), "sanity: it ran and closed");
  await focusContent(tabs[0].linkedBrowser);
  typeCommand("scr");
  EventUtils.synthesizeKey("KEY_ArrowUp");
  Assert.equal(input().value, "scroll_top", "Up recalls the previous line starting with scr");
  EventUtils.synthesizeKey("KEY_ArrowDown");
  Assert.equal(input().value, "scr", "Down returns to what was typed");
  EventUtils.synthesizeKey("KEY_Escape");
  Assert.deepEqual(await pageKeysThenZ(tabs[0]), ["z"], "the page saw none of the keys");
  closeTabs(tabs);
});

add_task(async function an_unknown_command_shows_an_error_and_stays_open() {
  const tabs = await openTabs(1);
  const count = gBrowser.tabs.length;
  runCommand("tabnwe");
  Assert.ok(isOpen(), "the line stays open");
  Assert.equal(input().value, "tabnwe", "with the text as typed");
  Assert.ok(errorShown(), "an error shows");
  Assert.stringContains(errorText(), 'not a command: "tabnwe"', "core's message");
  Assert.stringContains(errorText(), "tabnew", "suggesting tabnew");
  Assert.equal(document.activeElement, input(), "focus stays in the line");
  Assert.equal(gBrowser.tabs.length, count, "nothing ran");
  EventUtils.synthesizeKey("KEY_Backspace");
  Assert.ok(!errorShown(), "editing clears the error");
  EventUtils.synthesizeKey("KEY_Escape");
  Assert.deepEqual(await pageKeysThenZ(tabs[0]), ["z"], "the page saw none of the keys");
  closeTabs(tabs);
});

add_task(async function open_loads_through_fixup() {
  const tabs = await openTabs(1);
  const browser = tabs[0].linkedBrowser;
  const isExampleCom = (url) => /^https?:\/\/example\.com\/$/.test(url);
  const loaded = BrowserTestUtils.browserLoaded(browser, false, isExampleCom);
  runCommand("open example.com");
  await loaded;
  Assert.ok(
    isExampleCom(browser.currentURI.spec),
    `:open example.com loaded ${browser.currentURI.spec}`,
  );
  Assert.equal(gBrowser.selectedTab, tabs[0], "in the current tab");

  await focusContent(browser);
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, isExampleCom, true);
  runCommand("tabnew example.com");
  const tab = await opened;
  Assert.ok(isExampleCom(tab.linkedBrowser.currentURI.spec), ":tabnew example.com in a new tab");
  closeTabs([...tabs, tab]);
});

add_task(async function unbuilt_and_pending_commands_say_so() {
  const tabs = await openTabs(1);
  // Every command runs since the side panel (m3-workspaces 6): `:sidebar`, the last unbuilt
  // one, opens it now. The notice path is the keys' (`_run`), tested with ctrl+b o.
  runCommand("sidebar");
  Assert.ok(!isOpen(), "the line closes");
  await TestUtils.waitForCondition(
    () => BrowserTestUtils.isVisible(document.getElementById("vimma-panel")),
    ":sidebar opens the side panel",
  );
  EventUtils.synthesizeKey("KEY_Escape");
  await focusContent(tabs[0].linkedBrowser);
  runCommand("workspace work");
  Assert.equal(
    document.getElementById(NOTICE_ID).textContent,
    'no workspace "work"',
    "an unknown workspace is refused (no longer pending: m3-workspaces 2b)",
  );
  document.getElementById(NOTICE_ID).hidePopover();
  Assert.deepEqual(await pageKeysThenZ(tabs[0]), ["z"], "the page saw none of the keys");
  closeTabs(tabs);
});

add_task(async function map_and_help_open_the_bindings_overlay() {
  const tabs = await openTabs(1);
  for (const command of ["map", "help"]) {
    runCommand(command);
    const help = document.getElementById(HELP_ID);
    Assert.ok(help?.open, `:${command} opens the overlay`);
    Assert.ok(!isOpen(), "the command line closed");
    EventUtils.synthesizeKey("KEY_Escape");
    Assert.ok(!help.open, "Esc closes the overlay");
    Assert.equal(document.activeElement, tabs[0].linkedBrowser, "focus is back on the page");
  }
  Assert.deepEqual(await pageKeysThenZ(tabs[0]), ["z"], "the page saw none of the keys");
  closeTabs(tabs);
});

add_task(async function the_status_bar_shows_command_and_the_line_sits_above_it() {
  const tabs = await openTabs(1);
  const bar = document.getElementById("vimma-statusbar");
  const modeText = () => bar.querySelector('[data-segment="mode"]')?.textContent;
  const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 50, 100);
  colon();
  await until(() => modeText() === "COMMAND", "the status bar says COMMAND");
  const panel = container().firstElementChild.getBoundingClientRect();
  const top = bar.getBoundingClientRect().top;
  Assert.lessOrEqual(Math.abs(panel.bottom - top), 1, "the line sits just above the status bar");
  gURLBar.focus();
  await until(() => !isOpen(), "focus moving elsewhere in the window closes the line");
  await until(() => modeText() !== "COMMAND", "and the status bar leaves COMMAND");
  closeTabs(tabs);
});

/** A new window (private if asked) with one page focused in normal mode. */
async function windowWithPage(options = {}) {
  const win = await BrowserTestUtils.openNewBrowserWindow(options);
  const browser = win.gBrowser.selectedBrowser;
  BrowserTestUtils.startLoadingURIString(browser, PAGE);
  await BrowserTestUtils.browserLoaded(browser, false, PAGE);
  await SimpleTest.promiseFocus(win);
  await SimpleTest.promiseFocus(browser);
  return win;
}

add_task(async function private_window_lines_stay_out_of_the_shared_history() {
  const priv = await windowWithPage({ private: true });
  runCommand("tabrename secret-private-thing", priv);
  Assert.ok(!isOpen(priv), "sanity: it ran (not implemented yet) and closed");
  await SimpleTest.promiseFocus(priv.gBrowser.selectedBrowser);
  colon(priv);
  EventUtils.synthesizeKey("KEY_ArrowUp", {}, priv);
  Assert.equal(
    input(priv).value,
    "tabrename secret-private-thing",
    "the private window recalls it",
  );
  EventUtils.synthesizeKey("KEY_Escape", {}, priv);
  await BrowserTestUtils.closeWindow(priv);

  const tabs = await openTabs(1);
  colon();
  EventUtils.synthesizeKey("KEY_ArrowUp");
  Assert.ok(!input().value.includes("secret"), `a normal window does not (${input().value})`);
  EventUtils.synthesizeKey("KEY_Escape");

  const priv2 = await windowWithPage({ private: true });
  colon(priv2);
  EventUtils.synthesizeKey("KEY_ArrowUp", {}, priv2);
  Assert.ok(!input(priv2).value.includes("secret"), "nor does the next private window");
  EventUtils.synthesizeKey("KEY_Escape", {}, priv2);
  await BrowserTestUtils.closeWindow(priv2);
  closeTabs(tabs);
});

add_task(async function each_window_keeps_its_own_history_cursor() {
  const tabs = await openTabs(1);
  runCommand("scroll_top");
  await focusContent(tabs[0].linkedBrowser);
  runCommand("scroll_bottom");
  await focusContent(tabs[0].linkedBrowser);
  typeCommand("scroll");
  EventUtils.synthesizeKey("KEY_ArrowUp");
  Assert.equal(input().value, "scroll_bottom", "Up recalls the newest match");

  const other = await windowWithPage();
  colon(other);
  EventUtils.synthesizeKey("KEY_ArrowUp", {}, other);
  Assert.equal(input(other).value, "scroll_bottom", "another window shares the entries");
  EventUtils.synthesizeKey("KEY_ArrowUp", {}, other);
  Assert.equal(input(other).value, "scroll_top", "and walks them with its own cursor");

  await SimpleTest.promiseFocus(window);
  Assert.ok(isOpen(), "the first window's line stayed open while it was in the background");
  Assert.equal(document.activeElement, input(), "with focus back in it");
  EventUtils.synthesizeKey("KEY_ArrowUp");
  Assert.equal(input().value, "scroll_top", "its cursor and draft were kept: Up goes on");
  EventUtils.synthesizeKey("KEY_ArrowDown");
  EventUtils.synthesizeKey("KEY_ArrowDown");
  Assert.equal(input().value, "scroll", "and Down returns to its own draft");
  EventUtils.synthesizeKey("KEY_Escape");
  await BrowserTestUtils.closeWindow(other);
  closeTabs(tabs);
});

add_task(async function a_notice_does_not_cover_the_line() {
  const tabs = await openTabs(1);
  typeCommand("ta");
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("o");
  Assert.ok(noticeShown(), "ctrl+b o from the line shows the notice");
  Assert.ok(isOpen(), "and the line stays open");
  const gap = () =>
    document.getElementById(NOTICE_ID).getBoundingClientRect().bottom -
    container().firstElementChild.getBoundingClientRect().top;
  // --vimma-cmdline-height comes from a ResizeObserver: the completion list just grew, so the
  // notice moves on the observer's next callback, not in this tick.
  await TestUtils.waitForCondition(() => gap() <= 1, "the notice moves above the line");
  Assert.lessOrEqual(gap(), 1, "the notice sits above the line");
  document.getElementById(NOTICE_ID).hidePopover();
  EventUtils.synthesizeKey("KEY_Escape");
  closeTabs(tabs);
});

add_task(async function no_command_line_in_dom_fullscreen() {
  const tabs = await openTabs(1);
  const root = document.documentElement;
  root.setAttribute("inDOMFullscreen", "true"); // as browser-fullScreenAndPointerLock.js does
  try {
    colon();
    Assert.ok(!isOpen(), ": does not open over a fullscreen page");
  } finally {
    root.removeAttribute("inDOMFullscreen");
  }
  colon();
  root.setAttribute("inDOMFullscreen", "true");
  try {
    Assert.ok(!BrowserTestUtils.isVisible(input()), "an open line is hidden in fullscreen");
  } finally {
    root.removeAttribute("inDOMFullscreen");
  }
  EventUtils.synthesizeKey("KEY_Escape");
  Assert.deepEqual(await pageKeysThenZ(tabs[0]), ["z"], "the page saw none of the keys");
  closeTabs(tabs);
});

add_task(async function javascript_urls_are_blocked_with_a_notice() {
  const tabs = await openTabs(1);
  const count = gBrowser.tabs.length;
  const blocked = BLOCKED;
  runCommand("tabnew javascript:void(0)");
  Assert.equal(document.getElementById(NOTICE_ID)?.textContent, blocked, ":tabnew says so");
  Assert.equal(gBrowser.tabs.length, count, "and leaves no blank tab");
  await focusContent(tabs[0].linkedBrowser);
  const url = tabs[0].linkedBrowser.currentURI.spec;
  runCommand("open  JavaScript:alert(1)");
  Assert.equal(document.getElementById(NOTICE_ID).textContent, blocked, ":open says so");
  Assert.equal(tabs[0].linkedBrowser.currentURI.spec, url, "and loads nothing");
  document.getElementById(NOTICE_ID).hidePopover();
  closeTabs(tabs);
});

// Issue #98: :open and :tabnew load with the system principal, which Gecko lets navigate a
// top-level tab to data:, so a pasted data:text/html page could pose as a login page.
add_task(async function data_urls_are_blocked_with_a_notice() {
  const tabs = await openTabs(1);
  const browser = tabs[0].linkedBrowser;
  const count = gBrowser.tabs.length;
  const notice = () => document.getElementById(NOTICE_ID);
  // An earlier task's notice keeps its text when hidden: only a shown one counts.
  const says = () => noticeShown() && notice().textContent;
  if (noticeShown()) notice().hidePopover();
  runCommand("tabnew data:text/html,<h1>sign in</h1>");
  Assert.equal(says(), BLOCKED, ":tabnew data: says so");
  Assert.equal(gBrowser.tabs.length, count, "and opens no tab");
  notice().hidePopover();

  await focusContent(browser);
  const url = browser.currentURI.spec;
  for (const text of [
    "data:text/html;base64,PGgxPnNpZ24gaW48L2gxPg==",
    "  DaTa:text/plain,x",
    "view-source:data:text/html,x",
  ]) {
    runCommand(`open ${text}`);
    Assert.equal(says(), BLOCKED, `:open ${text} says so`);
    notice().hidePopover();
    await focusContent(browser);
  }
  Assert.equal(browser.currentURI.spec, url, "and :open loads nothing");
  // A data: load in flight would commit before (or be cut off by) the next load, so one more
  // :open and the history show whether any of them got in: one entry more, and not data:.
  const history = browser.browsingContext.sessionHistory;
  const entries = history.count;
  const next = `${PAGE}?after`;
  const loaded = BrowserTestUtils.browserLoaded(browser, false, next);
  runCommand(`open ${next}`);
  await loaded;
  Assert.equal(history.count, entries + 1, "only the next :open added a history entry");
  Assert.equal(history.getEntryAtIndex(history.count - 2).URI.spec, url, "after the page");
  Assert.equal(gBrowser.tabs.length, count, "and no tab was opened");
  closeTabs(tabs);
});

add_task(async function search_words_still_open_with_the_default_engine() {
  await SearchTestUtils.installSearchExtension(
    {
      name: "VimmaCmdlineTest",
      search_url: "https://example.com/search",
      search_url_get_params: "q={searchTerms}",
    },
    { setAsDefault: true },
  );
  const tabs = await openTabs(1);
  const browser = tabs[0].linkedBrowser;
  const want = "https://example.com/search?q=learn+data%3A+urls";
  const loaded = BrowserTestUtils.browserLoaded(browser, false, want);
  runCommand("open learn data: urls");
  await loaded;
  Assert.equal(browser.currentURI.spec, want, "words that mention data: are a search");
  closeTabs(tabs);
});
