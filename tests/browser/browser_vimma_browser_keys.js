/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/firefox-keys.md (sub-PR 1). Firefox's keys are Vimma bindings: each runs
// what Firefox's key ran, the page has the key first where Firefox let it (decision 6), and
// Firefox's own key on the chord is off, so the two never both run.

"use strict";

/* global focusContent, recordPageKeys, waitForPageKey -- from head.js */
/* global ZoomManager, FullZoom -- the browser window's */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PLAIN = ROOT + "file_vimma_plain.html";
const SLOW = ROOT + "file_vimma_slow.sjs";

// docs/specs/macos-build.md decision 29: on macOS the alt keys are Firefox's macOS keys, cmd
// (meta) chords, since Option types characters there; undo and redo are cmd+z and cmd+shift+z.
const MAC = Services.appinfo.OS === "Darwin";
/** The modifier of the back / forward arrows and of the tab digits: alt on Linux, cmd on macOS. */
const NAV = MAC ? { metaKey: true } : { altKey: true };
const NAV_NAME = MAC ? "cmd" : "alt";
/** The modifier of undo and redo in a text field. */
const EDIT = MAC ? { metaKey: true } : { ctrlKey: true };

/**
 * A page in its own tab, focused, in normal mode, its keys recorded.
 * @param {string} [url]
 */
async function normalPage(url = PLAIN) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  await recordPageKeys(tab.linkedBrowser);
  await focusContent(tab.linkedBrowser);
  await TestUtils.waitForCondition(
    () => VimmaHost._browserMode(tab.linkedBrowser) === "normal",
    "normal mode",
  );
  return tab;
}

/**
 * The page calls preventDefault on the keydown of these keys (`ctrl+` then `KeyboardEvent.key`).
 * @param {XULBrowserElement} browser
 * @param {string[]} keys
 */
function pageTakes(browser, keys) {
  return SpecialPowers.spawn(browser, [keys], (list) => {
    content.addEventListener(
      "keydown",
      (e) => {
        if (list.includes(`${e.ctrlKey ? "ctrl+" : ""}${e.key}`)) e.preventDefault();
      },
      true,
    );
  });
}

/**
 * Counts command events on a `<key>` element and stops them there, so the key's own listener
 * (DevTools, goHome) does not run in the test.
 * @param {string} id
 */
function catchKey(id) {
  const key = document.getElementById(id);
  Assert.ok(key, `#${id} exists`);
  const spy = { count: 0 };
  const listener = (e) => {
    spy.count++;
    e.stopImmediatePropagation();
  };
  key.addEventListener("command", listener, true);
  registerCleanupFunction(() => key.removeEventListener("command", listener, true));
  return spy;
}

/** @param {XULBrowserElement} browser */
const zoomOf = (browser) => ZoomManager.getZoomForBrowser(browser);

/** @param {XULBrowserElement} browser */
const urlOf = (browser) => browser.currentURI.spec;

add_task(async function setup() {
  await SpecialPowers.pushPrefEnv({
    set: [
      // Back and forward skip entries without a user's interaction; these are loaded by the test.
      ["browser.navigation.requireUserInteraction", false],
      ["browser.warnOnQuitShortcut", false],
      ["browser.warnOnQuit", false],
    ],
  });
  registerCleanupFunction(() => {
    while (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs.at(-1));
  });
});

add_task(async function nav_left_goes_back_in_normal_and_insert_mode_and_from_the_url_bar() {
  const tab = await normalPage();
  const browser = tab.linkedBrowser;
  const second = PLAIN + "?second";
  BrowserTestUtils.startLoadingURIString(browser, second);
  await BrowserTestUtils.browserLoaded(browser, false, second);
  await focusContent(browser);

  EventUtils.synthesizeKey("KEY_ArrowLeft", NAV);
  await TestUtils.waitForCondition(() => urlOf(browser) === PLAIN, `${NAV_NAME}+left: back`);
  await focusContent(browser);
  EventUtils.synthesizeKey("KEY_ArrowRight", NAV);
  await TestUtils.waitForCondition(() => urlOf(browser) === second, `${NAV_NAME}+right: forward`);

  await focusContent(browser);
  await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "normal", "normal");
  EventUtils.synthesizeKey("i");
  await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "insert", "insert");
  EventUtils.synthesizeKey("KEY_ArrowLeft", NAV);
  await TestUtils.waitForCondition(() => urlOf(browser) === PLAIN, "back (insert)");

  // From the address bar, as Firefox's alt+left: the selected tab's page. On macOS cmd+left
  // there moves to the line's start, as in Firefox, and cmd+[ goes back.
  await focusContent(browser);
  EventUtils.synthesizeKey("KEY_ArrowRight", NAV);
  await TestUtils.waitForCondition(() => urlOf(browser) === second, "forward again");
  gURLBar.focus();
  await TestUtils.waitForCondition(() => gURLBar.focused, "the address bar has focus");
  EventUtils.synthesizeKey("KEY_ArrowLeft", NAV);
  if (MAC) {
    await new Promise((r) => setTimeout(r, 300));
    Assert.equal(urlOf(browser), second, "cmd+left in the address bar is the field's key");
    Assert.ok(gURLBar.focused, "and the address bar keeps the focus");
    EventUtils.synthesizeKey("[", { metaKey: true });
  }
  await TestUtils.waitForCondition(() => urlOf(browser) === PLAIN, "back (URL bar)");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function on_macos_cmd_brackets_go_back_and_forward_as_firefoxs_keys() {
  if (!MAC) {
    Assert.ok(true, "macOS only: Linux's ctrl+[ and ctrl+] are the next task's");
    return;
  }
  const tab = await normalPage();
  const browser = tab.linkedBrowser;
  const second = PLAIN + "?cmd-bracket";
  BrowserTestUtils.startLoadingURIString(browser, second);
  await BrowserTestUtils.browserLoaded(browser, false, second);
  await focusContent(browser);
  EventUtils.synthesizeKey("[", { metaKey: true });
  await TestUtils.waitForCondition(() => urlOf(browser) === PLAIN, "cmd+[: back");
  await focusContent(browser);
  EventUtils.synthesizeKey("]", { metaKey: true });
  await TestUtils.waitForCondition(() => urlOf(browser) === second, "cmd+]: forward");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function on_macos_cmd_left_in_a_field_moves_to_the_line_start_and_stays() {
  if (!MAC) {
    Assert.ok(true, "macOS only: Linux's alt+left goes back from a field, as in Firefox");
    return;
  }
  // The page has cmd+left first (decision 29): a text field's own key wins, as in Firefox.
  const tab = await normalPage();
  const browser = tab.linkedBrowser;
  const second = PLAIN + "?field";
  BrowserTestUtils.startLoadingURIString(browser, second);
  await BrowserTestUtils.browserLoaded(browser, false, second);
  for (const kind of ["input", "contenteditable"]) {
    await SpecialPowers.spawn(browser, [kind], (k) => {
      const doc = content.document;
      doc.getElementById("vimma-field")?.remove();
      const el = doc.createElement(k === "input" ? "input" : "div");
      el.id = "vimma-field";
      if (k === "input") el.value = "hello world";
      else {
        el.contentEditable = "true";
        el.textContent = "hello world";
      }
      doc.body.append(el);
      el.focus();
      if (k === "input") el.setSelectionRange(11, 11);
      else content.getSelection().collapse(el.firstChild, 11);
    });
    await TestUtils.waitForCondition(
      () => VimmaHost._browserMode(browser) === "insert",
      `${kind}: insert mode`,
    );
    EventUtils.synthesizeKey("KEY_ArrowLeft", { metaKey: true });
    const caret = () =>
      SpecialPowers.spawn(browser, [kind], (k) => {
        const el = content.document.getElementById("vimma-field");
        return k === "input" ? el.selectionStart : content.getSelection().focusOffset;
      });
    await TestUtils.waitForCondition(async () => (await caret()) === 0, `${kind}: line start`);
    await new Promise((r) => setTimeout(r, 300));
    Assert.equal(urlOf(browser), second, `${kind}: cmd+left did not go back`);
  }
  BrowserTestUtils.removeTab(tab);
});

add_task(async function the_address_bar_keys_focus_it() {
  // Firefox's second address bar key: alt+d on Linux, cmd+l on macOS (no alt+d there).
  for (const [key, mods, name] of [
    ["l", { ctrlKey: true }, "ctrl+l"],
    MAC ? ["l", { metaKey: true }, "cmd+l"] : ["d", { altKey: true }, "alt+d"],
  ]) {
    const tab = await normalPage();
    EventUtils.synthesizeKey(key, mods);
    await TestUtils.waitForCondition(() => gURLBar.focused, `${name} focuses the address bar`);
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function ctrl_bracket_goes_back_in_normal_mode_only() {
  const tab = await normalPage();
  const browser = tab.linkedBrowser;
  const second = PLAIN + "?bracket";
  BrowserTestUtils.startLoadingURIString(browser, second);
  await BrowserTestUtils.browserLoaded(browser, false, second);
  await focusContent(browser);
  await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "normal", "normal");
  EventUtils.synthesizeKey("[", { ctrlKey: true });
  await TestUtils.waitForCondition(() => urlOf(browser) === PLAIN, "ctrl+[: back");
  await focusContent(browser);
  EventUtils.synthesizeKey("]", { ctrlKey: true });
  await TestUtils.waitForCondition(() => urlOf(browser) === second, "ctrl+]: forward");
  await SpecialPowers.spawn(browser, [], () =>
    ContentTaskUtils.waitForCondition(() => content.document.readyState === "complete", "loaded"),
  );
  await recordPageKeys(browser);

  await focusContent(browser);
  await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "normal", "normal");
  EventUtils.synthesizeKey("i");
  await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "insert", "insert");
  EventUtils.synthesizeKey("[", { ctrlKey: true });
  Assert.ok(await waitForPageKey(browser, ["[", "!["]), "insert mode: the page got ctrl+[");
  await new Promise((r) => setTimeout(r, 300));
  Assert.equal(urlOf(browser), second, "and nothing went back");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function the_tab_keys_count_the_visible_tabs() {
  const first = gBrowser.selectedTab;
  const tabs = [];
  for (let i = 0; i < 3; i++) {
    tabs.push(await BrowserTestUtils.openNewForegroundTab(gBrowser, PLAIN + `?tab${i}`));
  }
  gBrowser.selectedTab = tabs[0];
  await focusContent(tabs[0].linkedBrowser);
  EventUtils.synthesizeKey("9", NAV);
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab === tabs[2],
    `${NAV_NAME}+9: last tab`,
  );
  await focusContent(tabs[2].linkedBrowser);
  EventUtils.synthesizeKey("1", NAV);
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab === first,
    `${NAV_NAME}+1: first tab`,
  );
  await focusContent(first.linkedBrowser);
  EventUtils.synthesizeKey("3", NAV);
  await TestUtils.waitForCondition(() => gBrowser.selectedTab === tabs[1], `${NAV_NAME}+3: tab 3`);

  gBrowser.selectedTab = tabs[0];
  await focusContent(tabs[0].linkedBrowser);
  const before = gBrowser.tabs.indexOf(tabs[0]);
  EventUtils.synthesizeKey("KEY_PageDown", { ctrlKey: true, shiftKey: true });
  await TestUtils.waitForCondition(
    () => gBrowser.tabs.indexOf(tabs[0]) === before + 1,
    "moved right",
  );
  EventUtils.synthesizeKey("KEY_PageUp", { ctrlKey: true, shiftKey: true });
  await TestUtils.waitForCondition(
    () => gBrowser.tabs.indexOf(tabs[0]) === before,
    "and back left",
  );
  for (const t of tabs) BrowserTestUtils.removeTab(t);
});

add_task(async function zoom_keys_zoom_and_a_page_that_takes_one_keeps_it() {
  const tab = await normalPage();
  const browser = tab.linkedBrowser;
  EventUtils.synthesizeKey("+", { ctrlKey: true, shiftKey: true });
  await TestUtils.waitForCondition(() => zoomOf(browser) > 1, "ctrl+plus zooms in");
  EventUtils.synthesizeKey("0", { ctrlKey: true });
  await TestUtils.waitForCondition(() => zoomOf(browser) === 1, "ctrl+0 resets");
  EventUtils.synthesizeKey("-", { ctrlKey: true });
  await TestUtils.waitForCondition(() => zoomOf(browser) < 1, "ctrl+minus zooms out");
  EventUtils.synthesizeKey("0", { ctrlKey: true });
  await TestUtils.waitForCondition(() => zoomOf(browser) === 1, "reset again");

  // Keys typed fast (or held down) each run: each waits for its own reply from the page.
  EventUtils.synthesizeKey("=", { ctrlKey: true });
  EventUtils.synthesizeKey("=", { ctrlKey: true });
  EventUtils.synthesizeKey("=", { ctrlKey: true });
  await TestUtils.waitForCondition(() => zoomOf(browser) > 1.25, "three ctrl+= zoom three steps");
  EventUtils.synthesizeKey("0", { ctrlKey: true });
  await TestUtils.waitForCondition(() => zoomOf(browser) === 1, "reset after the three");

  // A page that takes ctrl+= for itself (an editor's zoom) keeps it, as in Firefox.
  await pageTakes(browser, ["ctrl+=", "ctrl+t"]);
  EventUtils.synthesizeKey("=", { ctrlKey: true });
  Assert.ok(await waitForPageKey(browser, ["=", "!="]), "the page had ctrl+=");
  await new Promise((r) => setTimeout(r, 300));
  Assert.equal(zoomOf(browser), 1, "and Vimma did not zoom");

  // ctrl+t is Firefox's reserved key: the page cannot keep it.
  const opened = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabOpen");
  EventUtils.synthesizeKey("t", { ctrlKey: true });
  const { target: fresh } = await opened;
  BrowserTestUtils.removeTab(fresh);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_blocked_shortcuts_permission_makes_the_key_vimmas_first() {
  const tab = await normalPage();
  const browser = tab.linkedBrowser;
  // The tab's own principal: site permissions are per workspace (container), as Firefox's site
  // panel sets them (docs/specs/vimma-mcp.md decision 30).
  const principal = browser.contentPrincipal;
  Services.perms.addFromPrincipal(principal, "shortcuts", Services.perms.DENY_ACTION);
  registerCleanupFunction(() => Services.perms.removeFromPrincipal(principal, "shortcuts"));
  await pageTakes(browser, ["ctrl+="]);
  EventUtils.synthesizeKey("=", { ctrlKey: true });
  await TestUtils.waitForCondition(() => zoomOf(browser) > 1, "zoomed although the page asked");
  FullZoom.reset(browser);
  Services.perms.removeFromPrincipal(principal, "shortcuts");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function ctrl_m_mutes_unless_the_page_takes_it() {
  const tab = await normalPage();
  EventUtils.synthesizeKey("m", { ctrlKey: true });
  await TestUtils.waitForCondition(() => tab.muted, "ctrl+m mutes the tab");
  await pageTakes(tab.linkedBrowser, ["ctrl+m"]);
  EventUtils.synthesizeKey("m", { ctrlKey: true });
  Assert.ok(await waitForPageKey(tab.linkedBrowser, ["m", "!m"]), "the page had ctrl+m");
  await new Promise((r) => setTimeout(r, 300));
  Assert.ok(tab.muted, "and the tab stays muted");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function redo_in_a_field_redoes_and_opens_no_debugger() {
  const tab = await normalPage();
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () => {
    const input = content.document.createElement("input");
    input.id = "redo";
    content.document.body.append(input);
    input.focus();
  });
  await TestUtils.waitForCondition(() => VimmaHost._browserMode(browser) === "insert", "insert");
  const debuggerKey = catchKey("key_jsdebugger");
  EventUtils.sendString("ab");
  const value = () =>
    SpecialPowers.spawn(browser, [], () => content.document.getElementById("redo").value);
  await TestUtils.waitForCondition(async () => (await value()) === "ab", "typed");
  // Undo and redo are ctrl+z and ctrl+shift+z on Linux, where ctrl+shift+z is also the
  // Debugger's key, and cmd+z and cmd+shift+z on macOS.
  EventUtils.synthesizeKey("z", EDIT);
  await TestUtils.waitForCondition(async () => (await value()) !== "ab", "undo");
  EventUtils.synthesizeKey("z", { ...EDIT, shiftKey: true });
  await TestUtils.waitForCondition(async () => (await value()) === "ab", "redo");
  Assert.equal(debuggerKey.count, 0, "and the Debugger did not open");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function keys_without_a_command_run_their_own_listener() {
  const tab = await normalPage();
  const toolbox = catchKey("key_toggleToolbox");
  const home = catchKey("goHome");
  EventUtils.synthesizeKey("KEY_F12");
  await TestUtils.waitForCondition(() => toolbox.count === 1, "F12 reached the DevTools key");
  EventUtils.synthesizeKey("I", { ctrlKey: true, shiftKey: true });
  await TestUtils.waitForCondition(() => toolbox.count === 2, "ctrl+shift+i too");
  EventUtils.synthesizeKey("KEY_Home", { altKey: true });
  await TestUtils.waitForCondition(() => home.count === 1, "alt+home reached goHome");
  Assert.equal(
    document.getElementById("key_toggleToolbox").getAttribute("disabled"),
    "true",
    "the key is off again after its one dispatch",
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function ctrl_q_asks_as_firefoxs_quit_shortcut() {
  const tab = await normalPage();
  let source = null;
  const observer = (subject) => {
    source = Cc["@mozilla.org/browser/browserglue;1"].getService(Ci.nsISupports).wrappedJSObject
      ._quitSource;
    subject.QueryInterface(Ci.nsISupportsPRBool).data = true; // cancel
  };
  Services.obs.addObserver(observer, "quit-application-requested");
  registerCleanupFunction(() =>
    Services.obs.removeObserver(observer, "quit-application-requested"),
  );
  EventUtils.synthesizeKey("q", { ctrlKey: true });
  await TestUtils.waitForCondition(() => source !== null, "a quit was requested");
  Assert.equal(source, "shortcut", "as the shortcut, so Firefox asks first when set to");
  Assert.ok(!window.closed, "the cancelled quit keeps the browser");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function ctrl_n_opens_a_window() {
  const tab = await normalPage();
  const opened = BrowserTestUtils.waitForNewWindow();
  EventUtils.synthesizeKey("n", { ctrlKey: true });
  const win = await opened;
  Assert.ok(win.gBrowser, "a browser window opened");
  await BrowserTestUtils.closeWindow(win);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function esc_in_normal_mode_stops_a_load_after_the_page() {
  const tab = BrowserTestUtils.addTab(gBrowser, SLOW);
  gBrowser.selectedTab = tab;
  const browser = tab.linkedBrowser;
  // The load starts on the tab's initial about:blank: wait for the slow page itself, or the
  // focus wait below runs in a document the slow page then replaces.
  await TestUtils.waitForCondition(
    () =>
      browser.currentURI?.spec === SLOW &&
      browser.webProgress?.isLoadingDocument &&
      VimmaHost._browserMode(browser) === "normal",
    "the slow page is shown and still loading",
  );
  // The location changes as soon as the slow page's document exists, before its parser has made
  // a root element. promiseFocus reads that document's activeElement, which is null until then.
  await SpecialPowers.spawn(browser, [SLOW], (url) =>
    ContentTaskUtils.waitForCondition(
      () => content.location.href === url && content.document.body !== null,
      "the slow page has its body",
    ),
  );
  await SimpleTest.promiseFocus(browser);
  await TestUtils.waitForCondition(
    () => !document.getElementById("Browser:Stop").hasAttribute("disabled"),
    "Stop is on",
  );
  Assert.equal(browser.currentURI.spec, SLOW, "the slow page is shown");
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(() => !browser.webProgress.isLoadingDocument, "Esc stopped it");
  BrowserTestUtils.removeTab(tab);
});
