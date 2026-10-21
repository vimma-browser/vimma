/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/bookmarks-toolbar-hidden.md. Firefox's Bookmarks Toolbar is hidden by
// default, on the start page and new tabs too, and after a bookmarks import; an upgraded profile
// that showed it has it hidden once; `:bookmarkstoolbar [show|hide|newtab]`, ctrl+shift+b and
// `[ui] bookmarks_toolbar` bring it back, in every window; Firefox's own menu keeps working.

"use strict";

/* global focusContent -- from head.js */
/* global BookmarkingUI, CustomizableUI, StarUI, onViewToolbarCommand -- browser
   window globals (browser.js) */

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);
const { BookmarksToolbar, MIGRATED_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ui/bookmarks-toolbar.mjs",
);
const { MigrationUtils } = ChromeUtils.importESModule("resource:///modules/MigrationUtils.sys.mjs");

const PREF = "browser.toolbars.bookmarks.visibility";
const TOOLBAR_PREF = "vimma.ui.toolbar.hidden";
const START = "chrome://browser/content/vimma/start/start.html";
const PAGE = "https://example.com/";
const VISIBLE = { visibilityProperty: true };
const MIGRATION_NOTICE =
  "bookmarks toolbar hidden: ctrl+b shift+b opens your bookmarks; " +
  ":bookmarkstoolbar show brings it back";

const dir = PathUtils.join(PathUtils.tempDir, `vimma-bookmarks-toolbar-${Date.now()}`);
const configFile = PathUtils.join(dir, "config.toml");

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg, tries = 100) {
  return TestUtils.waitForCondition(cond, msg, 50, tries);
}

const $ = (id, win = window) => win.document.getElementById(id);
/** The Bookmarks Toolbar shows in `win`. */
const shown = (win = window) => !!$("PersonalToolbar", win)?.checkVisibility(VISIBLE);
const noticeText = (win = window) => $("vimma-notice-live", win)?.textContent ?? "";
/** A refusal is spoken in the assertive region. */
const alertText = (win = window) => $("vimma-notice-alert", win)?.textContent ?? "";
const pref = () => Services.prefs.getCharPref(PREF);

/** `:line` Enter, typed in `win`. */
function runCommand(line, win = window) {
  EventUtils.synthesizeKey(":", { shiftKey: true }, win);
  EventUtils.sendString(line, win);
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
}

/** A page, selected and focused in normal mode, so the command line and keys reach Vimma. */
async function openPage(win = window, url = PAGE) {
  const tab = await BrowserTestUtils.openNewForegroundTab(win.gBrowser, url);
  await focusContent(tab.linkedBrowser);
  await until(() => VimmaHost.status(win).mode === "normal", "the page is in normal mode");
  return tab;
}

/** A new tab the way ctrl+t opens it: the start page. */
async function openStartTab(win = window) {
  const loaded = BrowserTestUtils.waitForNewTab(win.gBrowser, START, true);
  win.BrowserCommands.openTab();
  return loaded;
}

/** Back to the default: no user value, hidden in every window. */
async function reset() {
  Services.prefs.clearUserPref(PREF);
  CustomizableUI.setToolbarVisibility("PersonalToolbar", "never");
  await until(() => !shown(), "hidden again");
}

add_task(async function setup() {
  await IOUtils.makeDirectory(dir, { createAncestors: true });
  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref(PREF);
    CustomizableUI.setToolbarVisibility("PersonalToolbar", "never");
    while (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs.at(-1));
    await PlacesUtils.bookmarks.eraseEverything();
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
  });
});

// 1: a fresh profile: no user value, hidden on the start page, a new tab, a private window.
add_task(async function hidden_by_default_on_the_start_page_too() {
  Assert.equal(Services.prefs.getDefaultBranch("").getCharPref(PREF), "never", "the default");
  Assert.ok(!Services.prefs.prefIsLocked(PREF), "a default, not locked");
  Assert.ok(!Services.prefs.prefHasUserValue(PREF), "the harness profile has no user value");
  Assert.ok(!shown(), "hidden in the first window");

  const start = await openStartTab();
  Assert.equal(start.linkedBrowser.currentURI.spec, START, "the start page");
  Assert.ok(!shown(), "hidden on the start page");
  const page = await openPage();
  Assert.ok(!shown(), "hidden on a page");

  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  Assert.ok(!shown(priv), "hidden in a private window");
  await BrowserTestUtils.closeWindow(priv);
  BrowserTestUtils.removeTab(page);
  BrowserTestUtils.removeTab(start);
});

// 2: the start page names the bookmarks panel.
add_task(async function start_page_hint_names_the_bookmarks_panel() {
  const tab = await openStartTab();
  const hint = await SpecialPowers.spawn(
    tab.linkedBrowser,
    [],
    () => content.document.querySelector(".hint").textContent,
  );
  Assert.stringContains(hint.replace(/\s+/g, " "), "ctrl+b shift+b bookmarks", "the hint");
  BrowserTestUtils.removeTab(tab);
});

// 3: an upgraded profile that shows the toolbar has it hidden once, with a notice.
add_task(async function an_upgraded_profile_has_it_hidden_once() {
  Assert.ok(Services.prefs.getBoolPref(MIGRATED_PREF, false), "startup recorded the migration");
  const win2 = await BrowserTestUtils.openNewBrowserWindow();
  await SimpleTest.promiseFocus(window);
  for (const value of ["always", "newtab"]) {
    Services.prefs.clearUserPref(MIGRATED_PREF);
    CustomizableUI.setToolbarVisibility("PersonalToolbar", "always");
    Services.prefs.setCharPref(PREF, value);
    await until(() => shown() && shown(win2), `${value}: shown in both windows`);
    /** @type {string[]} */
    const said = [];
    BookmarksToolbar.migrate(null, (text) => said.push(text));
    Assert.equal(pref(), "never", `${value}: the pref is never`);
    await until(() => !shown() && !shown(win2), `${value}: hidden in both windows`);
    Assert.deepEqual(said, [MIGRATION_NOTICE], `${value}: the notice`);
    Assert.ok(Services.prefs.getBoolPref(MIGRATED_PREF), `${value}: recorded`);

    // A later choice stands: the next start leaves it.
    CustomizableUI.setToolbarVisibility("PersonalToolbar", "always");
    Services.prefs.setCharPref(PREF, "always");
    said.length = 0;
    BookmarksToolbar.migrate(null, (text) => said.push(text));
    Assert.equal(pref(), "always", `${value}: the next start keeps the user's choice`);
    Assert.deepEqual(said, [], `${value}: and says nothing`);
  }
  await BrowserTestUtils.closeWindow(win2);
  await reset();
});

// 4: with [ui] bookmarks_toolbar set, the key decides and the migration only records itself.
add_task(async function config_overrides_the_migration() {
  Services.prefs.clearUserPref(MIGRATED_PREF);
  CustomizableUI.setToolbarVisibility("PersonalToolbar", "always");
  Services.prefs.setCharPref(PREF, "always");
  const said = [];
  BookmarksToolbar.migrate("shown", (text) => said.push(text));
  Assert.equal(pref(), "always", "the toolbar stays shown");
  Assert.ok(shown(), "and shows");
  Assert.deepEqual(said, [], "no notice");
  Assert.ok(Services.prefs.getBoolPref(MIGRATED_PREF), "recorded");
  await reset();
});

/** Five bookmarks into the toolbar folder, as a browser import does. */
async function importIntoToolbar(tag) {
  const bookmarks = [1, 2, 3, 4, 5].map((i) => ({
    url: `https://example.com/${tag}/${i}`,
    title: `${tag} ${i}`,
  }));
  await MigrationUtils.insertManyBookmarksWrapper(bookmarks, PlacesUtils.bookmarks.toolbarGuid);
  // The forced reveal is an observer notification after an async step: let it run.
  await new Promise((r) => setTimeout(r, 500));
}

// 5: an import keeps a hidden toolbar hidden; with newtab it shows it, as in Firefox.
add_task(async function import_keeps_it_hidden() {
  Assert.equal(pref(), "never", "hidden");
  await importIntoToolbar("never");
  const found = await PlacesUtils.bookmarks.fetch({ url: "https://example.com/never/3" });
  Assert.equal(found?.parentGuid, PlacesUtils.bookmarks.toolbarGuid, "imported into the folder");
  Assert.equal(pref(), "never", "the pref is still never");
  Assert.ok(!shown(), "the toolbar is still hidden");

  Services.prefs.setCharPref(PREF, "newtab");
  await importIntoToolbar("newtab");
  await until(() => pref() === "always", "with newtab, the import shows it, as in Firefox");
  Assert.ok(shown(), "shown");
  await PlacesUtils.bookmarks.eraseEverything();
  await reset();
});

// 6: bookmarking into the toolbar folder with the star does not show it.
add_task(async function star_panel_does_not_show_it() {
  const tab = await openPage(window, `${PAGE}?star`);
  const shownPanel = BrowserTestUtils.waitForPopupEvent(StarUI.panel, "shown");
  BookmarkingUI.star.click();
  await shownPanel;
  let bm = null;
  await TestUtils.waitForCondition(async () => {
    bm = await PlacesUtils.bookmarks.fetch({ url: `${PAGE}?star` });
    return !!bm;
  }, "the star bookmarks the page");
  Assert.equal(bm?.parentGuid, PlacesUtils.bookmarks.toolbarGuid, "filed in the toolbar folder");
  Assert.ok(!shown(), "the toolbar stays hidden while the panel is open");
  const hidden = BrowserTestUtils.waitForPopupEvent(StarUI.panel, "hidden");
  StarUI.panel.hidePopup();
  await hidden;
  Assert.ok(!shown(), "and after");
  await PlacesUtils.bookmarks.eraseEverything();
  BrowserTestUtils.removeTab(tab);
});

// 7: :bookmarkstoolbar, its words and ctrl+shift+b, in every window, with a notice.
add_task(async function command_and_key_in_every_window() {
  const win2 = await BrowserTestUtils.openNewBrowserWindow();
  await SimpleTest.promiseFocus(window);
  const tab = await openPage();

  runCommand("bookmarkstoolbar");
  await until(() => shown() && shown(win2), ":bookmarkstoolbar shows it in both windows");
  Assert.equal(pref(), "always", "and writes always");
  await until(() => noticeText() === "bookmarks toolbar shown", "the notice");

  runCommand("bookmarkstoolbar");
  await until(() => !shown() && !shown(win2), "again hides it");
  Assert.equal(pref(), "never", "never");
  await until(() => noticeText() === "bookmarks toolbar hidden", "the notice");

  runCommand("bookmarkstoolbar show");
  await until(() => shown() && shown(win2), "show");
  runCommand("bookmarkstoolbar hide");
  await until(() => !shown() && !shown(win2), "hide");

  runCommand("bookmarkstoolbar newtab");
  await until(() => pref() === "newtab", "newtab");
  await until(() => noticeText() === "bookmarks toolbar shown on new tabs", "the notice");
  Assert.ok(!shown(), "not on a loaded page");
  const start = await openStartTab();
  await until(() => shown(), "on the start page");
  BrowserTestUtils.removeTab(start);
  await until(() => !shown(), "not on the page again");

  runCommand("bookmarkstoolbar blue");
  await until(
    () => alertText().startsWith(':bookmarkstoolbar takes "show", "hide", "newtab"'),
    "an unknown word is refused",
  );
  Assert.equal(pref(), "newtab", "and changes nothing");

  await focusContent(tab.linkedBrowser);
  EventUtils.synthesizeKey("B", { ctrlKey: true, shiftKey: true });
  await until(() => shown() && shown(win2), "ctrl+shift+b shows it, as Firefox's key does");
  Assert.equal(pref(), "always", "Firefox's toggle writes always");
  await until(() => noticeText() === "bookmarks toolbar shown", "with a notice");
  EventUtils.synthesizeKey("B", { ctrlKey: true, shiftKey: true });
  await until(() => !shown() && !shown(win2), "and hides it");
  Assert.equal(pref(), "never", "never");

  await BrowserTestUtils.closeWindow(win2);
  BrowserTestUtils.removeTab(tab);
  await reset();
});

// 8: [ui] bookmarks_toolbar from config.toml; a change lasts until that line changes.
add_task(async function config_sets_it_in_every_window() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.config.path", configFile],
      ["vimma.config.pollMs", 100],
    ],
  });
  let n = 0;
  const write = (text) =>
    IOUtils.writeUTF8(configFile, `schema = 2\n${text}\n${"#".repeat(++n)}\n`);
  const win2 = await BrowserTestUtils.openNewBrowserWindow();
  await SimpleTest.promiseFocus(window);
  const tab = await openPage();

  await write(`[ui]\nbookmarks_toolbar = "shown"`);
  await until(() => ConfigHost.config?.ui.bookmarksToolbar === "shown", "the poll reads it");
  await until(() => shown() && shown(win2), "shown in every open window, without a load");
  Assert.equal(pref(), "always", "always");

  runCommand("bookmarkstoolbar hide");
  await until(() => !shown(), "hidden by the command");
  await until(
    () => noticeText() === 'bookmarks toolbar hidden (config.toml sets "shown"; until restart)',
    "the notice says until restart",
  );
  await write(`[ui]\nbookmarks_toolbar = "shown"\n# another line`);
  await new Promise((r) => setTimeout(r, 600));
  Assert.ok(!shown(), "an edit elsewhere keeps the change");
  await write(`[ui]\nbookmarks_toolbar = "hidden"`);
  await until(() => ConfigHost.config?.ui.bookmarksToolbar === "hidden", "hidden in the file");
  await write(`[ui]\nbookmarks_toolbar = "shown"`);
  await until(() => shown() && shown(win2), "changing the line back applies it");

  await IOUtils.remove(configFile);
  await SpecialPowers.popPrefEnv();
  await ConfigHost.reload();
  Assert.equal(ConfigHost.config?.ui.bookmarksToolbar, null, "no config: no key");
  Assert.equal(pref(), "always", "and the pref keeps what it had");
  await BrowserTestUtils.closeWindow(win2);
  BrowserTestUtils.removeTab(tab);
  await reset();
});

// 9: Firefox's View > Toolbars > Bookmarks Toolbar > Always show, untouched by Vimma.
add_task(async function firefox_menu_still_works() {
  const item = document.createXULElement("menuitem");
  item.dataset.bookmarksToolbarVisibility = "true";
  item.dataset.visibilityEnum = "always";
  // onViewToolbarCommand reads the menu's id three levels up.
  const menu = document.createXULElement("menu");
  const popup = document.createXULElement("menupopup");
  const sub = document.createXULElement("menupopup");
  menu.id = "vimma-test-menu";
  menu.append(popup);
  popup.append(sub);
  sub.append(item);
  document.documentElement.append(menu);
  item.addEventListener("command", (e) => onViewToolbarCommand(e));
  item.doCommand();
  await until(() => shown(), "the menu shows it");
  Assert.equal(pref(), "always", "and writes always");
  menu.remove();
  await reset();
});

// 10: with the nav bar hidden (toolbar-toggle decision 5), the bookmarks toolbar hides with it;
// the minimal bar never shows it; the full reveal shows it when this setting would.
add_task(async function hidden_with_the_nav_bar() {
  const tab = await openPage();
  runCommand("bookmarkstoolbar show");
  await until(() => shown(), "shown");
  Services.prefs.setBoolPref(TOOLBAR_PREF, true);
  await until(() => !$("nav-bar").checkVisibility(VISIBLE), "the nav bar is hidden");
  Assert.ok(!shown(), "the bookmarks toolbar hides with it");
  const toolbar = VimmaHost._state(window).toolbar;
  toolbar.hold("test", "minimal");
  Assert.ok(!shown(), "the minimal bar does not show it");
  toolbar.hold("test", "full");
  await until(() => shown(), "the full reveal shows it");
  toolbar.release("test");
  await until(() => !shown(), "hidden again");
  runCommand("bookmarkstoolbar hide");
  await until(() => pref() === "never", "hidden for good");
  toolbar.hold("test", "full");
  await new Promise((r) => requestAnimationFrame(r));
  Assert.ok(!shown(), "then the full reveal does not show it");
  toolbar.release("test");
  Services.prefs.clearUserPref(TOOLBAR_PREF);
  BrowserTestUtils.removeTab(tab);
  await reset();
});
