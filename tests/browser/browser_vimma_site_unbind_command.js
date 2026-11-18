/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/site-unbind-command.md. `:siteunbind <key>` gives the selected tab's site a
// key until restart, `--save` writes it to `[sites."<host>"] unbind` in config.toml, `:sitebind`
// ends the temporary key and `:sitebind --delete` removes the saved one too.

/* global focusContent, recordPageKeys, waitForPageKey -- from head.js */
/* global add_setup -- the browser-chrome harness (browser-test.js) */

"use strict";

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);
const { TemporarySiteUnbinds } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/site-keys-ops.mjs",
);

const CONFIG_PATH_PREF = "vimma.config.path";
const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = ROOT + "file_vimma_site_unbind.html";
const OTHER_SITE = PAGE.replace("https://example.com", "https://example.org");

/** @type {string} */
let dir;
/** @type {string} */
let path;

add_setup(async function () {
  dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-siteunbind");
  path = PathUtils.join(dir, "config.toml");
  await IOUtils.writeUTF8(path, 'schema = 2\n# my keys\n[keys]\nnew_tab = "t" # tabs\n');
  await SpecialPowers.pushPrefEnv({ set: [[CONFIG_PATH_PREF, path]] });
  await ConfigHost.reload();
  registerCleanupFunction(async () => {
    for (const table of TemporarySiteUnbinds.tables()) {
      TemporarySiteUnbinds.remove(table, TemporarySiteUnbinds.keys(table));
    }
    VimmaHost.siteUnbindsChanged();
    await SpecialPowers.popPrefEnv();
    await ConfigHost.reload();
    await IOUtils.remove(dir, { recursive: true });
  });
});

/** The notice's text, "" without one. */
const notice = () => document.getElementById("vimma-notice")?.textContent ?? "";

/**
 * `:line` Enter, typed in the window, then the notice it leaves.
 * @param {string} line @param {string} [says]  the notice to wait for
 */
async function run(line, says) {
  const before = notice();
  EventUtils.synthesizeKey(":", { shiftKey: true });
  await TestUtils.waitForCondition(
    () => VimmaHost.status(window).mode === "command",
    "the : line is open",
  );
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(
    () => (says ? notice() === says : notice() !== "" && notice() !== before),
    `:${line} says ${says ?? "something"}`,
  );
  return notice();
}

/**
 * A tab on `url`, in normal mode with content focus, its keydowns recorded.
 * @param {string} url
 * @param {(browser: XULBrowserElement) => Promise<void>} fn
 */
async function withPage(url, fn) {
  await BrowserTestUtils.withNewTab(url, async (browser) => {
    await recordPageKeys(browser);
    await focusContent(browser);
    await TestUtils.waitForCondition(
      () => VimmaHost._browserMode(browser) === "normal",
      "the tab is in normal mode",
    );
    await fn(browser);
  });
}

/**
 * Whether `t` reaches the page (true) or opens a tab (false).
 * @param {XULBrowserElement} browser
 */
async function tReachesPage(browser) {
  await focusContent(browser);
  const tabs = gBrowser.tabs.length;
  EventUtils.synthesizeKey("t");
  if (await waitForPageKey(browser, ["t"], 1500)) {
    Assert.equal(gBrowser.tabs.length, tabs, "t opened no tab");
    return true;
  }
  await TestUtils.waitForCondition(() => gBrowser.tabs.length === tabs + 1, "t opened a tab");
  BrowserTestUtils.removeTab(gBrowser.selectedTab);
  await recordPageKeys(browser);
  return false;
}

const file = () => IOUtils.readUTF8(path);

add_task(async function siteunbind_gives_a_key_until_restart_and_sitebind_takes_it_back() {
  const before = await file();
  await withPage(PAGE, async (browser) => {
    Assert.equal(
      await run("siteunbind t <C-k>"),
      "example.com: t · ctrl+k go to the page (until restart)",
    );
    Assert.ok(await tReachesPage(browser), "t reaches the page");
    Assert.equal(await file(), before, "config.toml is untouched");
    Assert.equal(
      await run("siteunbind"),
      "example.com: t · ctrl+k go to the page until restart",
      "the list shows the keys until restart",
    );
    // A reload of config.toml keeps them.
    await ConfigHost.reload();
    Assert.ok(await tReachesPage(browser), "t still reaches the page after a reload");
  });
  await withPage(OTHER_SITE, async (browser) => {
    Assert.ok(!(await tReachesPage(browser)), "t is Vimma's on example.org");
  });
  await withPage(PAGE, async (browser) => {
    Assert.equal(await run("sitebind t ctrl+k"), "example.com: t · ctrl+k are Vimma's again");
    Assert.ok(!(await tReachesPage(browser)), "t is Vimma's again");
  });
});

add_task(async function a_bad_argument_is_refused_and_nothing_changes() {
  await withPage(PAGE, async (browser) => {
    Assert.equal(
      await run("siteunbind t gc"),
      ":siteunbind: gc is not one key (did you mean g c?)",
    );
    Assert.equal(
      await run("siteunbind esc"),
      ":siteunbind: esc stays Vimma's on every site: it leaves insert mode and a pending key",
    );
    Assert.ok(!(await tReachesPage(browser)), "the line was refused whole: t is Vimma's");
  });
});

add_task(async function a_page_without_a_site_is_refused() {
  await withPage("about:blank", async () => {
    Assert.equal(
      await run("siteunbind t"),
      ":siteunbind: this page has no site; it works on http and https pages",
    );
  });
});

add_task(async function save_writes_config_toml_and_delete_removes_it() {
  await withPage(PAGE, async (browser) => {
    Assert.equal(
      await run("siteunbind --save t"),
      "example.com: t goes to the page (saved to config.toml)",
    );
    Assert.equal(
      await file(),
      'schema = 2\n# my keys\n[keys]\nnew_tab = "t" # tabs\n\n[sites."example.com"]\nunbind = ["t"]\n',
      "a table of its own, the rest of the file as it was",
    );
    Assert.ok(await tReachesPage(browser), "t reaches the page");
    // :sitebind alone ends only the keys until restart.
    Assert.equal(await run("sitebind t"), "t is saved for example.com: :sitebind --delete t");
    Assert.ok(await tReachesPage(browser), "t still reaches the page");
    Assert.equal(
      await run("sitebind --delete t"),
      "example.com: t is Vimma's again (removed from config.toml)",
    );
    Assert.equal(
      await file(),
      'schema = 2\n# my keys\n[keys]\nnew_tab = "t" # tabs\n\n',
      "the emptied table is gone",
    );
    Assert.ok(!(await tReachesPage(browser)), "t is Vimma's again");
  });
});

add_task(async function a_config_toml_with_errors_is_never_written() {
  const broken = 'schema = 2\n[keys]\nnew_tab = "nope+t"\n';
  await IOUtils.writeUTF8(path, broken);
  await ConfigHost.reload();
  try {
    await withPage(PAGE, async () => {
      const said = await run("siteunbind --save t");
      Assert.ok(
        said.startsWith(":siteunbind --save: config.toml has errors; fix them first (:config)"),
        `refused: ${said}`,
      );
      Assert.equal(await file(), broken, "config.toml is as it was");
    });
  } finally {
    await IOUtils.writeUTF8(path, "schema = 2\n");
    await ConfigHost.reload();
  }
});

add_task(async function a_private_window_does_not_save() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    const browser = win.gBrowser.selectedBrowser;
    BrowserTestUtils.startLoadingURIString(browser, PAGE);
    await BrowserTestUtils.browserLoaded(browser, false, PAGE);
    // focusContent asserts against this test window's focus; the private window has its own.
    await SimpleTest.promiseFocus(win);
    await SimpleTest.promiseFocus(browser);
    await TestUtils.waitForCondition(
      () => VimmaHost.status(win).mode === "normal",
      "the private page is in normal mode",
    );
    const before = await file();
    EventUtils.synthesizeKey(":", { shiftKey: true }, win);
    await TestUtils.waitForCondition(() => VimmaHost.status(win).mode === "command", ": open");
    EventUtils.sendString("siteunbind --save t", win);
    EventUtils.synthesizeKey("KEY_Enter", {}, win);
    const text = () => win.document.getElementById("vimma-notice")?.textContent ?? "";
    await TestUtils.waitForCondition(() => text().startsWith(":siteunbind --save:"), "the refusal");
    Assert.equal(
      text(),
      ":siteunbind --save: not from a private window, whose sites stay off disk; " +
        ":siteunbind without --save gives the keys until restart",
    );
    Assert.equal(await file(), before, "nothing written");
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});
