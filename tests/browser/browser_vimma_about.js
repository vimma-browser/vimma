/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m5-about-vimma.md

"use strict";

/* global focusContent -- from head.js */

const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);

const ABOUT = "about:vimma";
const PAGE = "https://example.com/";
const DISCOVERY = PathUtils.join(PathUtils.profileDir, "vimma-control.json");

const dir = PathUtils.join(PathUtils.tempDir, `vimma-about-${Date.now()}`);
const file = PathUtils.join(dir, "config.toml");

function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/** The repository, found through `surfer import`'s symlink to this test file. */
function repoDir() {
  const self = getChromeDir(getResolvedURI(gTestPath));
  self.append(gTestPath.split("/").pop());
  self.normalize();
  return self.parent.parent.parent; // tests/browser/<file>
}

/** Every *.patch under `path`, recursively. */
async function countPatches(path) {
  let n = 0;
  for (const child of await IOUtils.getChildren(path)) {
    const info = await IOUtils.stat(child);
    if (info.type === "directory") n += await countPatches(child);
    else if (child.endsWith(".patch")) n++;
  }
  return n;
}

/** Opens about:vimma in a new tab and waits for its sections to be filled in. */
async function openAbout() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, ABOUT);
  await ready(tab.linkedBrowser);
  return tab;
}

/** @param {XULBrowserElement} browser */
async function ready(browser) {
  await until(
    () => browser.contentDocument?.documentElement?.dataset.ready === "true",
    "about:vimma rendered",
  );
}

/** @param {XULBrowserElement} browser @param {string} id */
function section(browser, id) {
  return browser.contentDocument.getElementById(id)?.textContent ?? "";
}

/** `:`, the line, Enter. */
function runCommand(line) {
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
}

add_task(async function setup() {
  await IOUtils.makeDirectory(dir, { createAncestors: true });
  registerCleanupFunction(async () => {
    while (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs.at(-1));
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
  });
});

add_task(async function the_url_opens_the_page_with_versions_and_patches() {
  const tab = await openAbout();
  const browser = tab.linkedBrowser;
  Assert.equal(browser.currentURI.spec, ABOUT, "the URL stays about:vimma");
  Assert.equal(browser.contentDocument.title, "about:vimma", "the page's title");
  const version = section(browser, "version");
  Assert.stringContains(version, Services.appinfo.version, "the Firefox version");
  Assert.stringContains(version, Services.appinfo.appBuildID, "the build ID");
  const { AppConstants } = ChromeUtils.importESModule(
    "resource://gre/modules/AppConstants.sys.mjs",
  );
  Assert.stringContains(version, AppConstants.MOZ_APP_VERSION_DISPLAY, "Vimma's version");
  Assert.stringContains(version, AppConstants.MOZ_UPDATE_CHANNEL, "the update channel");

  const expected = await countPatches(PathUtils.join(repoDir().path, "src"));
  Assert.greater(expected, 0, "sanity: the repository carries patches");
  const count = browser.contentDocument.getElementById("patch-count")?.textContent;
  Assert.equal(count, String(expected), "the patch count is the number of src/**/*.patch");
  const rows = browser.contentDocument.querySelectorAll("#patches tbody tr");
  Assert.equal(rows.length, expected, "one row per patch");
  Assert.stringContains(section(browser, "patches"), "browser-xhtml.patch", "patches by name");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function the_command_opens_it() {
  const page = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await focusContent(page.linkedBrowser);
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, ABOUT, true);
  runCommand("about");
  const tab = await opened;
  await ready(tab.linkedBrowser);
  Assert.equal(gBrowser.selectedTab, tab, ":about selects the new tab");
  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(page);
});

add_task(async function config_errors_show_with_file_and_line() {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.config.path", file]] });
  await IOUtils.writeUTF8(file, `schema = 2\n[keys]\nnew_tab = "prefix+y"\nnew_tabb = "x"\n`);
  await ConfigHost.reload();
  Assert.equal(ConfigHost.errors.length, 1, "sanity: one error");
  const tab = await openAbout();
  const config = section(tab.linkedBrowser, "config");
  Assert.stringContains(config, file, "the config path");
  Assert.stringContains(config, `${file}:4`, "the error with file:line");
  Assert.stringContains(config, "new_tabb", "the error's key");
  BrowserTestUtils.removeTab(tab);

  // A good file: loaded, its schema, and the override marked in the binding table.
  await IOUtils.writeUTF8(file, `schema = 2\n[keys]\nnew_tab = "prefix+y"\n`);
  await ConfigHost.reload();
  const again = await openAbout();
  const doc = again.linkedBrowser.contentDocument;
  Assert.stringContains(section(again.linkedBrowser, "config"), "loaded", "the file is loaded");
  Assert.equal(doc.getElementById("config-schema")?.textContent, "2", "the schema version");
  const overridden = [...doc.querySelectorAll("#bindings tr.overridden")].map((r) => r.textContent);
  Assert.equal(overridden.length, 1, "one override");
  Assert.stringContains(overridden[0], "new_tab", "new_tab is the override");
  Assert.stringContains(overridden[0], "ctrl+b y", "with its binding, as keys to press");
  BrowserTestUtils.removeTab(again);

  await SpecialPowers.popPrefEnv();
  await ConfigHost.reload();
});

add_task(async function workspaces_and_the_last_keys() {
  await WorkspaceStore.init();
  const page = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await focusContent(page.linkedBrowser);
  await until(() => VimmaHost.status(window).mode === "normal", "the page is in normal mode");
  EventUtils.synthesizeKey("j");
  EventUtils.synthesizeKey("k");
  EventUtils.synthesizeKey("j");
  const tab = await openAbout();
  const browser = tab.linkedBrowser;
  const n = WorkspaceStore.definitions.workspaces.length;
  Assert.equal(
    browser.contentDocument.getElementById("workspace-count")?.textContent,
    String(n),
    "the workspace count",
  );
  const keys = [...browser.contentDocument.querySelectorAll("#keys li")].map(
    (li) => li.textContent,
  );
  Assert.lessOrEqual(keys.length, 20, "at most the last 20 key events");
  Assert.deepEqual(
    keys.slice(-3),
    ["j → scroll.down", "k → scroll.up", "j → scroll.down"],
    "the last keys, with what each did",
  );
  Assert.stringContains(section(browser, "modes"), "normal", "the window's mode");
  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(page);
});

add_task(async function the_control_token_never_appears() {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.control.enabled", true]] });
  await VimmaControl.settled();
  const { token, port } = JSON.parse(await IOUtils.readUTF8(DISCOVERY));
  Assert.ok(token, "sanity: the server has a token");
  const tab = await openAbout();
  const html = tab.linkedBrowser.contentDocument.documentElement.outerHTML;
  Assert.stringContains(section(tab.linkedBrowser, "control"), "enabled", "the socket is on");
  Assert.stringContains(section(tab.linkedBrowser, "control"), String(port), "its port");
  Assert.ok(!html.includes(token), "the token is nowhere in the page");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
  await VimmaControl.settled();
});

add_task(async function bug_copies_a_redacted_report() {
  const page = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?secret-page`);
  await focusContent(page.linkedBrowser);
  await SimpleTest.promiseClipboardChange(
    (text) => text.startsWith("about:vimma report"),
    () => runCommand("bug"),
  );
  const text = SpecialPowers.getClipboardData("text/plain");
  const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
  Assert.stringContains(text, Services.appinfo.version, "the report has the versions");
  Assert.ok(!text.includes(home + "/"), "no path under $HOME");
  Assert.ok(!text.includes("secret-page") && !/https?:\/\//.test(text), "no URLs");
  while (gBrowser.tabs.length > 1) gBrowser.removeTab(gBrowser.tabs.at(-1));
});

add_task(async function the_report_counts_open_tabs_beside_the_workspace_model() {
  // Issue #546: tab search and the side panel list the model's tabs, the status bar the open
  // ones. The report says both, so a model out of step shows in the next `:bug`.
  const { AboutVimma } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/about/AboutVimma.sys.mjs",
  );
  const { WindowWorkspaces } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
  );
  await WorkspaceStore.init();
  const page = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?count`);
  const ww = WindowWorkspaces.get(window);
  await until(
    () => ww.idOf(page) && ww.model?.workspaces.some((w) => w.tabs.includes(ww.idOf(page))),
    "the tab is in the model",
  );
  const live = gBrowser.tabs.filter((t) => !t.pinned && !t.closing).length;
  const text = AboutVimma.report(await AboutVimma.collect(window));
  Assert.stringContains(text, `; open tabs ${live}, in workspaces ${live}\n`, "both counts");
  Assert.ok(!text.includes("restore pending"), "no restore under way");

  // A restore under way: the report says so, and for how long.
  window.dispatchEvent(new window.Event("SSWindowStateBusy"));
  try {
    const pending = AboutVimma.report(await AboutVimma.collect(window));
    Assert.stringMatches(
      pending,
      /\n {2}restore pending: \d+s \(SessionStore/,
      "the pending restore",
    );
  } finally {
    window.dispatchEvent(new window.Event("SSWindowStateReady"));
  }
  BrowserTestUtils.removeTab(page);
});

add_task(async function vim_keys_scroll_it() {
  const tab = await openAbout();
  const browser = tab.linkedBrowser;
  await focusContent(browser);
  await until(() => VimmaHost.status(window).mode === "normal", "about:vimma is in normal mode");
  const win = browser.contentWindow;
  Assert.equal(win.scrollY, 0, "starts at the top");
  EventUtils.synthesizeKey("j");
  await until(() => win.scrollY > 0, "j scrolls down");
  const down = win.scrollY;
  EventUtils.synthesizeKey("k");
  await until(() => win.scrollY < down, "k scrolls up");
  BrowserTestUtils.removeTab(tab);
});
