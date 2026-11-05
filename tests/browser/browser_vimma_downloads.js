/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// docs/specs/downloads.md: the status bar's `↓` segment for downloads in progress and the last
// end, announced once (Behaviour 12 and 13, decision 9); the `ctrl+b d` picker, its rows, live
// updates and keys (Behaviour 1-11, 15; decisions 3-5, 8, 12, 13, 19); all behind
// `vimma.feature.downloads` (decision 20); and Firefox's downloads panel, which stays shut for an
// ordinary download and still opens for a blocked one (Behaviour 14, decision 10). An
// Integration.downloads override records what would reach the OS (launchFile,
// confirmLaunchExecutable, showContainingDirectory) instead of reaching it.

"use strict";

// Twenty tasks, several of them waiting on a download or a window.
requestLongerTimeout(3);

/* global DownloadsPanel -- browser window global (browser.js) */
/* global requestLongerTimeout -- the browser-chrome harness (browser-test.js) */
/* global focusContent -- from head.js */

const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
const { Integration } = ChromeUtils.importESModule("resource://gre/modules/Integration.sys.mjs");
const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);

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

/**
 * A finished download of `name`, made without the network: its file is written, then the
 * download is added to the window's list, as a session restore adds one.
 * @param {string} name
 * @param {{ dir?: string, source?: object, contentType?: string, bytes?: Uint8Array,
 *   list?: number, startTime?: Date }} [options]
 */
async function finished(name, options = {}) {
  const path = PathUtils.join(options.dir ?? saveDir, name);
  await IOUtils.write(path, options.bytes ?? new TextEncoder().encode("hello"));
  const download = await Downloads.createDownload({
    source: { url: `${SJS}?now&name=${encodeURIComponent(name)}`, ...options.source },
    target: path,
    succeeded: true,
    startTime: options.startTime ?? new Date(),
    ...(options.contentType ? { contentType: options.contentType } : {}),
  });
  await download.refresh();
  const list = await Downloads.getList(options.list ?? Downloads.PUBLIC);
  await list.add(download);
  return download;
}

/** What reached DownloadIntegration's OS calls (the recorder below), in order. */
/** @type {{ op: string, path: string, system?: boolean }[]} */
const calls = [];
/** Records the calls that would reach the OS, and reaches nothing. */
const recorder = (/** @type {any} */ base) => ({
  __proto__: base,
  /** @param {nsIFile} file @param {nsIMIMEInfo} [mimeInfo] */
  launchFile(file, mimeInfo) {
    calls.push({
      op: "launch",
      path: file.path,
      system: mimeInfo?.preferredAction === Ci.nsIHandlerInfo.useSystemDefault,
    });
  },
  /** @param {string} path */
  async confirmLaunchExecutable(path) {
    calls.push({ op: "confirm", path });
    return false;
  },
  /** @param {string} path */
  async showContainingDirectory(path) {
    calls.push({ op: "show", path });
  },
});

const PICKER_ID = "vimma-downloads-picker";
const picker = () => /** @type {HTMLDialogElement | null} */ (document.getElementById(PICKER_ID));
const isOpen = () => !!picker()?.open;
const rows = () => [...(picker()?.querySelectorAll("[role=option]") ?? [])];
/** @param {Element} row @param {string} name */
const cell = (row, name) => row.querySelector(`.vimma-picker-${name}`)?.textContent ?? "";
const titles = () => rows().map((r) => cell(r, "title"));
const selectedTitle = () =>
  cell(/** @type {Element} */ (picker()?.querySelector("[aria-selected=true]")), "title");
const headings = () =>
  [...(picker()?.querySelectorAll(".vimma-picker-heading") ?? [])].map((h) => h.textContent);
const noticeText = () => document.getElementById("vimma-notice")?.textContent ?? "";

/** ctrl+b, then `key`. @param {string} key @param {object} [mods] */
function prefix(key, mods = {}) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key, mods);
}

async function openPicker() {
  prefix("d");
  await until(isOpen, "ctrl+b d opens the downloads picker");
}

async function closePicker() {
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !isOpen(), "Esc closes the picker");
}

/** Highlights the row titled `name`. @param {string} name */
async function highlight(name) {
  for (let i = 0; i < rows().length && selectedTitle() !== name; i++) {
    EventUtils.synthesizeKey("j");
  }
  Assert.equal(selectedTitle(), name, `${name} is highlighted`);
}

async function release() {
  await fetch(`${SJS}?release`);
}

async function clean() {
  if (isOpen()) await closePicker();
  const list = await Downloads.getList(Downloads.ALL);
  for (const d of await list.getAll()) {
    await list.remove(d);
    await d.finalize(true);
  }
  await PlacesUtils.history.clear();
  calls.length = 0;
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
  Integration.downloads.register(recorder);
  registerCleanupFunction(async () => {
    Integration.downloads.unregister(recorder);
    await release();
    await clean();
    await IOUtils.remove(saveDir, { recursive: true, ignoreAbsent: true });
  });
});

/** Everything the status bar's live region says from now on, until `stop`. */
function listen() {
  const region = /** @type {Element} */ (document.querySelector("#vimma-statusbar .vimma-sb-live"));
  /** @type {string[]} */
  const said = [];
  const observer = new MutationObserver(() => said.push(region.textContent ?? ""));
  observer.observe(region, { childList: true, characterData: true, subtree: true });
  return { said, stop: () => observer.disconnect() };
}

add_task(async function test_the_status_bar_shows_progress_then_done_failed_or_blocked() {
  const first = await held("one.bin");
  await until(() => shown() === "↓ 50%", "one download at half way");
  const spoken = segment()?.querySelector(".vimma-sb-sr")?.textContent;
  Assert.equal(spoken, "downloading 50%", "the spoken text has no arrow");

  const second = await held("two.bin");
  await until(() => shown() === "↓ 2 · 50%", "two downloads at half way");

  const region = listen();
  await release();
  await Promise.all([first.done, second.done]);
  await until(() => shown() === "↓ done", "then done");
  const words = region.said.join(" ").match(/download finished: \w+\.bin/g) ?? [];
  Assert.deepEqual(
    words.sort(),
    ["download finished: one.bin", "download finished: two.bin"],
    "each end is announced once",
  );

  // A failed download stays until the picker opens, in the error colour.
  const list = await Downloads.getList(Downloads.PUBLIC);
  const bad = await Downloads.createDownload({
    source: `${SJS}?short&name=short.bin`,
    target: PathUtils.join(saveDir, "short.bin"),
  });
  await list.add(bad);
  await bad.start().catch(() => {});
  await until(() => shown() === "↓ failed", "a failed download shows failed");
  await until(() => region.said.join(" ").includes("download failed: short.bin"), "said once");
  region.stop();
  await openPicker();
  await closePicker();
  await until(() => segment() === null, "the picker has shown it: the segment goes");
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

add_task(async function test_a_private_window_counts_only_its_private_downloads() {
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  /** @param {Window} win */
  const seg = (win) =>
    win.document.querySelector('#vimma-statusbar [data-segment="downloads"] [aria-hidden]')
      ?.textContent ?? null;
  const list = await Downloads.getList(Downloads.PRIVATE);
  const download = await Downloads.createDownload({
    source: { url: `${SJS}?hold&name=private.bin`, isPrivate: true },
    target: PathUtils.join(saveDir, "private.bin"),
  });
  await list.add(download);
  const done = download.start();
  await until(() => seg(priv) === "↓ 50%", "the private window shows its private download");
  // The normal window may still say `↓ done` for an earlier download, never this one's progress.
  Assert.ok(!seg(window)?.includes("%"), "a normal window never counts a private download");

  const normal = await held("public.bin");
  await until(() => seg(window) === "↓ 50%", "the normal window shows its own download");
  Assert.equal(seg(priv), "↓ 50%", "the private window does not count the normal download");

  await release();
  await Promise.all([done, normal.done]);
  await BrowserTestUtils.closeWindow(priv);
  await clean();
});

add_task(async function test_a_new_profiles_first_download_opens_no_panel() {
  // Firefox opens its panel on a profile's first download whatever alwaysOpenPanel says, unless
  // the panel has shown before (DownloadsCommon.sys.mjs, _notifyDownloadEvent).
  Assert.ok(
    Services.prefs.getDefaultBranch("").getBoolPref("browser.download.panel.shown"),
    "Vimma's default marks the panel as shown",
  );
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
  await until(() => shown() === "↓ blocked", "the status bar says blocked");
  Assert.equal(
    segment()?.querySelector(".vimma-sb-sr")?.textContent,
    "download blocked",
    "in words too",
  );
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
  await clean();
});

/** A tab on the plain page, focused, for the picker's keys. */
async function pageTab() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await focusContent(tab.linkedBrowser);
  return tab;
}

add_task(async function test_ctrl_b_d_opens_the_picker_and_esc_closes_it() {
  const tab = await pageTab();
  await finished("a.bin");
  await openPicker();
  Assert.deepEqual(titles(), ["a.bin"], "the download is listed");
  Assert.equal(picker()?.getAttribute("aria-label"), "Downloads", "the dialog says what it is");
  // A picker takes every key, ctrl+b included (Behaviour 1).
  prefix("d");
  await TestUtils.waitForTick();
  Assert.ok(isOpen(), "a second ctrl+b d does not close it");
  EventUtils.synthesizeKey("q");
  await until(() => !isOpen(), "q closes it");
  await openPicker();
  await closePicker();
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_no_picker_while_the_feature_is_off() {
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE, false]] });
  const tab = await pageTab();
  prefix("d");
  await TestUtils.waitForTick();
  Assert.ok(!isOpen(), "ctrl+b d does nothing while vimma.feature.downloads is off");
  // Its help row is not listed either, while `downloads` (the Library) still is.
  prefix("?", { shiftKey: true });
  const help = () => document.getElementById("vimma-help");
  await until(() => !!(/** @type {any} */ (help())?.open), "the help overlay opens");
  const listed = (/** @type {string} */ name) =>
    BrowserTestUtils.isVisible(
      /** @type {Element} */ (help()?.querySelector(`[data-action="${name}"]`)),
    );
  Assert.ok(!listed("downloads_picker"), "no downloads_picker row");
  Assert.ok(listed("downloads"), "the Library's row stays");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !(/** @type {any} */ (help())?.open), "the help overlay closes");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
  await clean();
});

add_task(async function test_lists_session_then_history_newest_first() {
  const tab = await pageTab();
  // A real download reaches Places history; removed from the session list, it stays there.
  const list = await Downloads.getList(Downloads.PUBLIC);
  const old = await Downloads.createDownload({
    source: `${SJS}?now&name=old.bin`,
    target: PathUtils.join(saveDir, "old.bin"),
  });
  await list.add(old);
  await old.start();
  await until(() => old.succeeded, "old.bin finished");
  await list.remove(old);
  // Start times after old.bin's Places visit, which is only milliseconds old here.
  await finished("middle.bin", { startTime: new Date(Date.now() + 1000) });
  await finished("new.bin", { startTime: new Date(Date.now() + 2000) });
  const running = await held("running.bin");
  await openPicker();
  await until(() => titles().length === 4, "four rows");
  Assert.deepEqual(
    titles(),
    ["running.bin", "new.bin", "middle.bin", "old.bin"],
    "in progress first, then newest first, history last",
  );
  Assert.deepEqual(headings(), ["Active · 1", "Recent · 3"], "two sections");
  Assert.equal(cell(rows()[0], "index"), "50%", "the state word");
  Assert.ok(cell(rows()[1], "host").includes("example.com"), "the host it came from");
  Assert.ok(!cell(rows()[1], "host").includes("?now"), "never the URL");
  await closePicker();
  await release();
  await running.done;
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_progress_updates_live_and_the_highlight_stays() {
  const tab = await pageTab();
  await finished("done.bin");
  const one = await held("live.bin");
  await openPicker();
  await highlight("done.bin");
  const two = await held("second.bin");
  await until(() => titles().length === 3, "a new download is listed while open");
  Assert.equal(selectedTitle(), "done.bin", "the highlight stays on its download");
  await release();
  await Promise.all([one.done, two.done]);
  await until(
    () => rows().every((r) => cell(r, "index") === "done"),
    "progress and the end state update in place",
  );
  Assert.equal(selectedTitle(), "done.bin", "and the highlight still stays");
  await closePicker();
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_enter_and_o_open_through_launchDownload() {
  const tab = await pageTab();
  const file = await finished("open-me.bin");
  await openPicker();
  EventUtils.synthesizeKey("o");
  await until(() => calls.length === 1, "o reaches launchFile");
  Assert.deepEqual([calls[0].op, calls[0].path], ["launch", file.target.path]);
  Assert.ok(!isOpen(), "the picker closes for the file");
  await openPicker();
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => calls.length === 2, "Enter opens a finished download too");
  Assert.equal(calls[1].path, file.target.path);
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_an_executable_asks_firefoxs_prompt_first() {
  const tab = await pageTab();
  const file = await finished("run-me.sh", { bytes: new TextEncoder().encode("#!/bin/sh\n") });
  await IOUtils.setPermissions(file.target.path, 0o755);
  await openPicker();
  EventUtils.synthesizeKey("o");
  await until(() => calls.length === 1, "o asks first");
  Assert.deepEqual(
    calls,
    [{ op: "confirm", path: file.target.path }],
    "and, refused, runs nothing",
  );
  BrowserTestUtils.removeTab(tab);
  await clean();
});

/** The test PDF's bytes. */
async function pdfBytes() {
  const dir = getChromeDir(getResolvedURI(gTestPath));
  dir.append("file_vimma_test.pdf");
  return IOUtils.read(dir.path);
}

add_task(async function test_a_pdf_opens_in_a_tab_and_O_uses_the_system_app() {
  const tab = await pageTab();
  const pdf = await finished("paper.pdf", {
    bytes: await pdfBytes(),
    contentType: "application/pdf",
  });
  await openPicker();
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, (url) => url.endsWith("paper.pdf"));
  EventUtils.synthesizeKey("o");
  const pdfTab = await opened;
  Assert.equal(gBrowser.selectedTab, pdfTab, "Firefox shows the PDF in a tab, selected");
  Assert.deepEqual(calls, [], "nothing reached the OS");
  BrowserTestUtils.removeTab(pdfTab);
  gBrowser.selectedTab = tab;
  await focusContent(tab.linkedBrowser);
  await openPicker();
  EventUtils.synthesizeKey("O", { shiftKey: true });
  await until(() => calls.length === 1, "shift+o opens it in the system's app");
  Assert.deepEqual(calls[0], { op: "launch", path: pdf.target.path, system: true });
  // shift+o is only for a file Firefox shows itself.
  await finished("plain.bin");
  await focusContent(tab.linkedBrowser);
  await openPicker();
  await highlight("plain.bin");
  EventUtils.synthesizeKey("O", { shiftKey: true });
  await until(() => noticeText().includes("o opens it"), "says why");
  Assert.equal(calls.length, 1, "and opens nothing");
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_o_on_another_workspaces_pdf_switches_to_it() {
  const tab = await pageTab();
  const work = WorkspaceStore.addWorkspace({ name: "dlwork", color: "blue", icon: "briefcase" });
  const main = WorkspaceStore.definitions.workspaces.find((w) => w.name === "main");
  try {
    await finished("work.pdf", {
      bytes: await pdfBytes(),
      contentType: "application/pdf",
      source: { userContextId: work.userContextId },
    });
    await openPicker();
    Assert.ok(cell(rows()[0], "host").includes("dlwork"), "the row names its workspace");
    const opened = BrowserTestUtils.waitForNewTab(gBrowser, (url) => url.endsWith("work.pdf"));
    EventUtils.synthesizeKey("o");
    const pdfTab = await opened;
    Assert.equal(pdfTab.userContextId, work.userContextId, "in the download's container");
    await until(
      () => WindowWorkspaces.get(window)?.status()?.name === "dlwork",
      "Vimma switches to that workspace",
    );
    Assert.equal(gBrowser.selectedTab, pdfTab, "with the PDF selected");
    BrowserTestUtils.removeTab(pdfTab);
  } finally {
    WorkspaceStore.setActive(window, /** @type {any} */ (main).id);
    await WorkspaceStore.deleteWorkspace(work.id, { confirmed: true });
    // The workspace's home tab, if switching made one.
    for (const t of [...gBrowser.tabs]) {
      if (t !== gBrowser.tabs[0] && t !== tab) BrowserTestUtils.removeTab(t);
    }
  }
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_s_shows_the_file_in_its_folder() {
  const tab = await pageTab();
  const file = await finished("show-me.bin");
  await openPicker();
  EventUtils.synthesizeKey("s");
  await until(() => calls.length === 1, "s reaches showContainingDirectory");
  Assert.deepEqual(calls[0], { op: "show", path: file.target.path });
  // macOS confirms with Finder; elsewhere Vimma only asked the file manager (decision 15).
  const said = AppConstants.platform === "macosx" ? "shown in Finder" : "file manager";
  await until(() => noticeText().includes(said), "says what it asked");
  Assert.ok(isOpen(), "the picker stays open");
  await closePicker();
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_y_copies_the_link_and_Y_the_path() {
  const tab = await pageTab();
  const file = await finished("copy-me.bin");
  await openPicker();
  await SimpleTest.promiseClipboardChange(file.source.url, () => EventUtils.synthesizeKey("y"));
  await SimpleTest.promiseClipboardChange(file.target.path, () =>
    EventUtils.synthesizeKey("Y", { shiftKey: true }),
  );
  Assert.ok(isOpen(), "the picker stays open");
  await closePicker();
  BrowserTestUtils.removeTab(tab);
  await clean();
});

/** @param {string} url */
const referrerOf = (url) => {
  const info = Cc["@mozilla.org/referrer-info;1"].createInstance(Ci.nsIReferrerInfo);
  info.init(Ci.nsIReferrerInfo.EMPTY, true, Services.io.newURI(url));
  return info;
};

add_task(async function test_u_opens_the_referring_page() {
  const tab = await pageTab();
  const from = `${DIR}file_vimma_plain.html?from`;
  await finished("from-page.bin", { source: { referrerInfo: referrerOf(from) } });
  await openPicker();
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, from, true);
  EventUtils.synthesizeKey("u");
  const page = await opened;
  Assert.ok(!isOpen(), "the picker closed for the page");
  const main = /** @type {any} */ (
    WorkspaceStore.definitions.workspaces.find((w) => w.name === "main")
  );
  Assert.equal(page.userContextId, main.userContextId, "a download with no container: main's");
  BrowserTestUtils.removeTab(page);
  await clean();

  // A download from another workspace's container opens its page in that container, whatever
  // workspace is on screen (docs/security.md D4).
  const work = WorkspaceStore.addWorkspace({ name: "dlfrom", color: "blue", icon: "briefcase" });
  try {
    await finished("from-work.bin", {
      source: { referrerInfo: referrerOf(from), userContextId: work.userContextId },
    });
    gBrowser.selectedTab = tab;
    await focusContent(tab.linkedBrowser);
    await openPicker();
    const again = BrowserTestUtils.waitForNewTab(gBrowser, from, true);
    EventUtils.synthesizeKey("u");
    const workPage = await again;
    Assert.equal(workPage.userContextId, work.userContextId, "in the download's own container");
    BrowserTestUtils.removeTab(workPage);
  } finally {
    WorkspaceStore.setActive(window, main.id);
    await WorkspaceStore.deleteWorkspace(work.id, { confirmed: true });
    for (const t of [...gBrowser.tabs]) {
      if (t !== gBrowser.tabs[0] && t !== tab) BrowserTestUtils.removeTab(t);
    }
  }
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_names_with_html_stay_text() {
  const tab = await pageTab();
  const name = "<img src=x onerror=alert(1)>.bin";
  await finished(name);
  await openPicker();
  Assert.deepEqual(titles(), [name], "the name is text");
  Assert.equal(picker()?.querySelector("img"), null, "and never markup");
  await closePicker();
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_L_opens_firefoxs_downloads_view() {
  const tab = await pageTab();
  await finished("library.bin");
  await openPicker();
  const library = BrowserTestUtils.domWindowOpenedAndLoaded(null, (win) =>
    win.location.href.startsWith("chrome://browser/content/places/places.xhtml"),
  );
  EventUtils.synthesizeKey("L", { shiftKey: true });
  const win = await library;
  Assert.ok(!isOpen(), "the picker closes");
  await BrowserTestUtils.closeWindow(win);
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_a_private_window_lists_only_private_downloads() {
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  await finished("private.bin", { source: { isPrivate: true }, list: Downloads.PRIVATE });
  await finished("public.bin");
  const privTab = await BrowserTestUtils.openNewForegroundTab(priv.gBrowser, PAGE);
  await SimpleTest.promiseFocus(privTab.linkedBrowser);
  EventUtils.synthesizeKey("b", { ctrlKey: true }, priv);
  EventUtils.synthesizeKey("d", {}, priv);
  const privPicker = () => priv.document.getElementById(PICKER_ID);
  await until(() => !!(/** @type {any} */ (privPicker())?.open), "the private window's picker");
  const privTitles = () =>
    [...(privPicker()?.querySelectorAll("[role=option] .vimma-picker-title") ?? [])].map(
      (t) => t.textContent,
    );
  await until(() => privTitles().length === 1, "one row");
  Assert.deepEqual(privTitles(), ["private.bin"], "a private window lists only its own");
  await BrowserTestUtils.closeWindow(priv);

  const tab = await pageTab();
  await openPicker();
  Assert.deepEqual(titles(), ["public.bin"], "a normal window never lists a private one");
  await closePicker();
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_the_picker_never_opens_an_agent_download() {
  const tab = await pageTab();
  // A path in the agent's folders makes it an agent download (docs/security.md M11).
  const dir = PathUtils.join(PathUtils.profileDir, "vimma-agent-refused");
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  const from = `${DIR}file_vimma_plain.html?agent`;
  await finished("agent.bin", { dir, source: { referrerInfo: referrerOf(from) } });
  await openPicker();
  Assert.ok(cell(rows()[0], "host").includes("◇ agent"), "the row carries the agent glyph");
  EventUtils.synthesizeKey("o");
  await until(() => noticeText().includes("never opened by Vimma"), "o says why");
  EventUtils.synthesizeKey("KEY_Enter");
  EventUtils.synthesizeKey("O", { shiftKey: true });
  EventUtils.synthesizeKey("u");
  await until(() => noticeText().includes("page is never opened"), "u says why");
  Assert.ok(isOpen(), "the picker stays open");
  Assert.deepEqual(calls, [], "nothing reached the OS");
  Assert.equal(gBrowser.selectedTab, tab, "no page was opened");
  await closePicker();
  BrowserTestUtils.removeTab(tab);
  await clean();
  await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
});
