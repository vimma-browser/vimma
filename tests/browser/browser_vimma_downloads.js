/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// docs/specs/downloads.md: the status bar's `↓` segment for downloads in progress (Behaviour 12,
// decision 9), behind `vimma.feature.downloads` (decision 20), and Firefox's downloads panel,
// which stays shut for an ordinary download and still opens for a blocked one (Behaviour 14,
// decision 10).

"use strict";

/* global DownloadsPanel -- browser window global (browser.js) */

const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");

const FEATURE = "vimma.feature.downloads";
const HIDDEN = "vimma-toolbar-hidden";
const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const SJS = DIR + "file_vimma_downloads.sjs";
const PAGE = DIR + "file_vimma_plain.html";
const saveDir = PathUtils.join(PathUtils.tempDir, `vimma-downloads-${Date.now()}`);

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg, tries = 100) {
  return TestUtils.waitForCondition(cond, msg, 50, tries);
}

/** The `↓` segment on this window's status bar, or null. */
function segment() {
  return /** @type {HTMLElement | null} */ (
    document.querySelector('#vimma-statusbar [data-segment="downloads"]')
  );
}

/** What the segment shows on screen, without its spoken text. */
function shown() {
  return segment()?.querySelector("[aria-hidden]")?.textContent ?? null;
}

/** @param {string} name */
async function held(name) {
  const list = await Downloads.getList(Downloads.PUBLIC);
  const download = await Downloads.createDownload({
    source: `${SJS}?hold&name=${name}`,
    target: PathUtils.join(saveDir, name),
  });
  await list.add(download);
  const done = download.start();
  await until(() => download.currentBytes > 0 && download.hasProgress, `${name} has started`);
  return { download, done };
}

async function release() {
  await fetch(`${SJS}?release`);
}

async function clean() {
  const list = await Downloads.getList(Downloads.ALL);
  for (const d of await list.getAll()) {
    await list.remove(d);
    await d.finalize(true);
  }
  await IOUtils.remove(saveDir, { recursive: true, ignoreAbsent: true });
  await IOUtils.makeDirectory(saveDir);
}

add_task(async function setup() {
  await IOUtils.makeDirectory(saveDir);
  await SpecialPowers.pushPrefEnv({
    set: [
      [FEATURE, true],
      ["browser.download.dir", saveDir],
      ["browser.download.folderList", 2],
      ["browser.download.always_ask_before_handling_new_types", false],
      // Set by the sub-PR that turns the feature on (decision 20); the panel tests need it now.
      ["browser.download.alwaysOpenPanel", false],
    ],
  });
  await clean();
  registerCleanupFunction(async () => {
    await release();
    await clean();
    await IOUtils.remove(saveDir, { recursive: true, ignoreAbsent: true });
  });
});

add_task(async function test_the_status_bar_shows_progress() {
  const first = await held("one.bin");
  await until(() => shown() === "↓ 50%", "one download at half way");
  const spoken = segment()?.querySelector(".vimma-sb-sr")?.textContent;
  Assert.equal(spoken, "downloading 50%", "the spoken text has no arrow");

  const second = await held("two.bin");
  await until(() => shown() === "↓ 2 · 50%", "two downloads at half way");

  await release();
  await Promise.all([first.done, second.done]);
  // The end states (`↓ done`, `failed`, `blocked`) come with the picker (Delivery 3).
  await until(() => segment() === null, "the segment goes when none is running");
  await clean();
});

add_task(async function test_no_segment_while_the_feature_is_off() {
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
  const one = await held("off.bin");
  // The segment would show within a frame; give the bar several before checking.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await TestUtils.waitForTick();
  Assert.equal(segment(), null, "no segment while vimma.feature.downloads is off");
  await SpecialPowers.popPrefEnv();
  await until(() => shown() === "↓ 50%", "it shows once the feature is on");
  await release();
  await one.done;
  await clean();
});

/** @param {string} url */
async function clickDownload(url) {
  const added = new Promise((resolve) => {
    Downloads.getList(Downloads.ALL).then((list) => {
      const view = {
        /** @param {any} d */
        onDownloadAdded(d) {
          list.removeView(view);
          resolve(d);
        },
      };
      list.addView(view);
    });
  });
  await SpecialPowers.spawn(gBrowser.selectedBrowser, [url], (u) => {
    const a = content.document.createElement("a");
    a.href = u;
    a.download = "";
    content.document.body.append(a);
    a.click();
  });
  return /** @type {Promise<any>} */ (added);
}

add_task(async function test_starting_a_download_opens_no_panel_and_keeps_the_toolbar_hidden() {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.ui.toolbar.hidden", true]] });
  await until(() => document.documentElement.hasAttribute(HIDDEN), "the toolbar is hidden");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const download = await clickDownload(`${SJS}?now&name=plain.bin`);
  await download.whenSucceeded();
  await TestUtils.waitForTick();
  Assert.ok(!DownloadsPanel.isPanelShowing, "no downloads panel for an ordinary download");
  Assert.ok(document.documentElement.hasAttribute(HIDDEN), "the toolbar stays hidden");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
  await clean();
});

add_task(async function test_a_blocked_download_still_opens_firefoxs_panel() {
  // The test harness turns the insecure-download block off; Firefox's default is on.
  // HTTPS-First would upgrade the http: link, so nothing would be insecure to block.
  await SpecialPowers.pushPrefEnv({
    set: [
      ["dom.block_download_insecure", true],
      ["dom.security.https_first", false],
    ],
  });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  // An http: file from an https: page is blocked as Insecure (dom.block_download_insecure).
  const download = await clickDownload(`${SJS.replace("https://", "http://")}?now&name=bad.bin`);
  await until(() => !!download.error, "the download is blocked");
  Assert.equal(download.error.reputationCheckVerdict, "Insecure", "blocked as Insecure");
  await until(() => DownloadsPanel.isPanelShowing, "Firefox's panel opens as its warning");
  const hidden = BrowserTestUtils.waitForEvent(DownloadsPanel.panel, "popuphidden");
  DownloadsPanel.hidePanel();
  await hidden;
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
  await clean();
});
