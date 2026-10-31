/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m1-actor-insert-scroll.md (keys in the PDF viewer), issue #677: a PDF takes
// Vimma's keys as soon as it opens, without a click, also when a site serves it as a download.

/* global add_setup -- the browser-chrome harness (browser-test.js) */
/* global DownloadsPanel, DownloadsIndicatorView -- the browser window's */

"use strict";

const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);

/**
 * The PDF viewer's scroller, once pdf.js has laid its pages out.
 * @param {XULBrowserElement} browser
 * @returns {Promise<{ top: number, max: number } | null>}
 */
function viewerScroll(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const el = content.document.getElementById("viewerContainer");
    if (!el || el.scrollHeight <= el.clientHeight) return null;
    return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
  });
}

/**
 * With no click first: focus is in the tab, the tab is in normal mode, and `j`, `G` and `:` do
 * what they do on any page.
 * @param {XULBrowserElement} browser
 */
async function keysWorkAtOnce(browser) {
  await TestUtils.waitForCondition(() => viewerScroll(browser), "pdf.js laid its pages out");
  Assert.equal(document.activeElement, browser, "focus is in the PDF's tab");
  Assert.equal(VimmaHost.status(window).mode, "normal", "the status bar says NORMAL");

  const start = (await viewerScroll(browser)).top;
  EventUtils.synthesizeKey("j");
  await TestUtils.waitForCondition(
    async () => (await viewerScroll(browser)).top > start,
    "j scrolls the PDF down",
  );
  EventUtils.synthesizeKey("G", { shiftKey: true });
  await TestUtils.waitForCondition(async () => {
    const s = await viewerScroll(browser);
    return s.top >= s.max - 1;
  }, "G scrolls the PDF to its end");
  EventUtils.synthesizeKey(":", { shiftKey: true });
  await TestUtils.waitForCondition(
    () => VimmaHost.status(window).mode === "command",
    ": opens the command line",
  );
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => VimmaHost.status(window).mode === "normal",
    "Esc closes it, back in normal mode",
  );
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["general.smoothScroll", false]] });
});

add_task(async function a_pdf_opened_in_a_new_tab_takes_the_keys_at_once() {
  await BrowserTestUtils.withNewTab(ROOT + "file_vimma_test.pdf", keysWorkAtOnce);
});

add_task(async function a_pdf_served_as_a_download_takes_the_keys_at_once() {
  const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-pdf-focus");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.download.always_ask_before_handling_new_types", false],
      ["browser.download.useDownloadDir", true],
      ["browser.download.folderList", 2],
      ["browser.download.dir", dir],
      ["browser.download.start_downloads_in_tmp_dir", false],
    ],
    // Vimma's defaults, as in a new profile: the test profile marks the panel as shown before.
    clear: [["browser.download.panel.shown"], ["browser.download.alwaysOpenPanel"]],
  });
  // How the download's start and end are announced: the panel, or the button's animation only.
  /** @type {string[]} */
  const announced = [];
  const { showPanel } = DownloadsPanel;
  const { showEventNotification } = DownloadsIndicatorView;
  DownloadsPanel.showPanel = function (...args) {
    announced.push("panel");
    return showPanel.apply(this, args);
  };
  DownloadsIndicatorView.showEventNotification = function (...args) {
    announced.push(`button ${args[0]}`);
    return showEventNotification.apply(this, args);
  };
  const panel = document.getElementById("downloadsPanel");
  registerCleanupFunction(async () => {
    DownloadsPanel.showPanel = showPanel;
    DownloadsIndicatorView.showEventNotification = showEventNotification;
    while (gBrowser.tabs.length > 1) BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
    if (panel.state === "open" || panel.state === "showing") {
      const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
      DownloadsPanel.hidePanel();
      await hidden;
    }
    const list = await Downloads.getList(Downloads.ALL);
    for (const d of await list.getAll()) {
      await list.remove(d);
      await d.finalize(true);
    }
    await IOUtils.remove(dir, { recursive: true });
  });

  await BrowserTestUtils.withNewTab(
    `data:text/html,<a id="pdf" href="${ROOT}file_vimma_pdf_attachment.pdf">report</a>`,
    async (page) => {
      const opened = BrowserTestUtils.waitForNewTab(gBrowser, null, true);
      await BrowserTestUtils.synthesizeMouseAtCenter("#pdf", {}, page);
      const tab = await opened;
      const browser = tab.linkedBrowser;
      Assert.equal(browser.documentContentType, "application/pdf", "the download opens in a tab");
      await TestUtils.waitForCondition(
        () => announced.length >= 2,
        "the download's start and end are announced",
      );
      // The panel opens a moment after the tab and focuses its list (DownloadsPanel._focusPanel).
      if (announced.includes("panel")) {
        await TestUtils.waitForCondition(
          () => panel.contains(document.activeElement),
          "the panel takes focus",
        );
      }
      Assert.ok(
        !announced.includes("panel"),
        `the PDF's tab is the notice, not the panel: ${announced}`,
      );
      await keysWorkAtOnce(browser);
      BrowserTestUtils.removeTab(tab);
    },
  );
});
