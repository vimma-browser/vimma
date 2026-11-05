/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// docs/specs/downloads.md: the status bar's `↓` segment for downloads in progress and the last
// end, announced once (Behaviour 12 and 13, decision 9); the `ctrl+b d` picker, its rows, live
// updates and keys (Behaviour 1-11, 15; decisions 3-5, 8, 12, 13, 19); blocked downloads, allowed
// or removed only through Firefox's own dialog (Behaviour 10, decision 7, docs/security.md D3);
// and Firefox's downloads panel, which stays shut for an ordinary download and still opens for a
// blocked one (Behaviour 14, decision 10). An
// Integration.downloads override records what would reach the OS (launchFile,
// confirmLaunchExecutable, showContainingDirectory) instead of reaching it.

"use strict";

// Thirty-five tasks, several of them waiting on a download or a window.
requestLongerTimeout(3);

/* global DownloadsPanel -- browser window global (browser.js) */
/* global requestLongerTimeout -- the browser-chrome harness (browser-test.js) */
/* global focusContent -- from head.js */

const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
const { Integration } = ChromeUtils.importESModule("resource://gre/modules/Integration.sys.mjs");
const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
const { DownloadIntegration } = ChromeUtils.importESModule(
  "resource://gre/modules/DownloadIntegration.sys.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);

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

/**
 * A download of `name` that stops half way until `release`. `resumable` keeps its `.part` file
 * on a pause, as Firefox does for a download from a page (DownloadLegacy.sys.mjs).
 * @param {string} name
 * @param {{ resumable?: boolean }} [options]
 */
async function held(name, { resumable = false } = {}) {
  const list = await Downloads.getList(Downloads.PUBLIC);
  const path = PathUtils.join(saveDir, name);
  const download = await Downloads.createDownload({
    source: `${SJS}?hold&name=${name}`,
    target: resumable ? { path, partFilePath: `${path}.part` } : path,
    ...(resumable ? { tryToKeepPartialData: true } : {}),
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
/** The `y/N` line at the window's foot (ui/rename-prompt.mjs). */
const promptOpen = () => document.getElementById("vimma-rename")?.hidden === false;
const promptText = () =>
  document.getElementById("vimma-rename")?.querySelector(".vimma-cmdline-prompt")?.textContent ??
  "";

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
  await until(() => titles().includes(name), `${name} is listed`);
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
      ["browser.download.dir", saveDir],
      ["browser.download.folderList", 2],
      ["browser.download.always_ask_before_handling_new_types", false],
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
  // the panel has shown before (DownloadsCommon.sys.mjs, _notifyDownloadEvent); both are needed.
  const defaults = Services.prefs.getDefaultBranch("");
  Assert.ok(
    defaults.getBoolPref("browser.download.panel.shown"),
    "Vimma's default marks the panel as shown",
  );
  Assert.ok(
    !defaults.getBoolPref("browser.download.alwaysOpenPanel"),
    "and does not open it for every new burst of downloads",
  );
  Assert.ok(
    !Services.prefs.prefHasUserValue("browser.download.alwaysOpenPanel"),
    "the test runs on Vimma's default",
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

add_task(async function test_the_picker_is_on_by_default_in_help_and_the_command_line() {
  Assert.equal(
    Services.prefs.getPrefType("vimma.feature.downloads"),
    Services.prefs.PREF_INVALID,
    "no feature pref is left for the downloads picker",
  );
  const tab = await pageTab();
  // Its help row is listed beside `downloads` (the Library).
  prefix("?", { shiftKey: true });
  const help = () => document.getElementById("vimma-help");
  await until(() => !!(/** @type {any} */ (help())?.open), "the help overlay opens");
  const listed = (/** @type {string} */ name) =>
    BrowserTestUtils.isVisible(
      /** @type {Element} */ (help()?.querySelector(`[data-action="${name}"]`)),
    );
  Assert.ok(listed("downloads_picker"), "the downloads_picker row");
  Assert.ok(listed("downloads"), "and the Library's row");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !(/** @type {any} */ (help())?.open), "the help overlay closes");
  // `:downloads` opens it too.
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("downloads");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(isOpen, ":downloads opens the picker");
  await closePicker();
  BrowserTestUtils.removeTab(tab);
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
  const parts = cell(rows()[1], "host").split(" · ");
  Assert.deepEqual(
    parts.slice(0, 2),
    ["5 B", "example.com"],
    "its size, then the host it came from",
  );
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

add_task(async function test_pause_resume_and_retry() {
  const tab = await pageTab();
  const one = await held("pause-me.bin", { resumable: true });
  await openPicker();
  await highlight("pause-me.bin");
  EventUtils.synthesizeKey("p");
  await until(() => one.download.stopped && one.download.hasPartialData, "p pauses it");
  await until(() => cell(rows()[0], "index") === "paused", "the row says paused");
  Assert.ok(await IOUtils.exists(`${one.download.target.path}.part`), "its partial file stays");
  // Enter on a paused download resumes it, from where it stopped.
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => one.download.succeeded, "Enter resumes it, and it finishes");
  Assert.equal((await IOUtils.stat(one.download.target.path)).size, 20000, "all of the file");
  Assert.ok(isOpen(), "the picker stays open");
  await closePicker();

  // The first answer for this name is short, so it fails; a retry gets all of it.
  const list = await Downloads.getList(Downloads.PUBLIC);
  const failing = await Downloads.createDownload({
    source: `${SJS}?short&name=retry-me.bin`,
    target: PathUtils.join(saveDir, "retry-me.bin"),
  });
  await list.add(failing);
  await failing.start().catch(() => {});
  Assert.ok(failing.error, "the first attempt failed");
  await openPicker();
  await highlight("retry-me.bin");
  EventUtils.synthesizeKey("r");
  await until(() => failing.succeeded, "r retries it");
  // A finished download has nothing to pause: the key says why.
  EventUtils.synthesizeKey("p");
  await until(() => noticeText().includes("cannot pause"), "p on a finished one says why");
  await closePicker();
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_cancel_asks_and_removes_the_partial_file() {
  const tab = await pageTab();
  const one = await held("cancel-me.bin", { resumable: true });
  const part = `${one.download.target.path}.part`;
  await openPicker();
  await highlight("cancel-me.bin");
  EventUtils.synthesizeKey("c");
  await until(promptOpen, "c asks first");
  Assert.ok(!isOpen(), "with the picker closed");
  Assert.equal(promptText(), 'cancel "cancel-me.bin" and remove its partial file? (y/N) ');
  EventUtils.synthesizeKey("n");
  await until(() => !promptOpen(), "n answers no");
  Assert.ok(!one.download.stopped, "and the download runs on");
  await openPicker();
  await highlight("cancel-me.bin");
  EventUtils.synthesizeKey("c");
  await until(promptOpen, "c asks again");
  EventUtils.synthesizeKey("y");
  await until(
    () => one.download.canceled && !one.download.hasPartialData,
    "y cancels it and removes its partial data",
  );
  await until(() => noticeText().includes("canceled"), "the notice says so");
  Assert.ok(!(await IOUtils.exists(part)), "the .part file is gone");
  await openPicker();
  Assert.equal(cell(rows()[0], "index"), "canceled", "the row says canceled");
  await closePicker();
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_d_removes_the_entry_and_keeps_the_file() {
  const tab = await pageTab();
  await finished("keep-me.bin");
  const gone = await finished("remove-me.bin");
  await openPicker();
  await highlight("remove-me.bin");
  EventUtils.synthesizeKey("d");
  await until(() => !titles().includes("remove-me.bin"), "d removes the row at once");
  Assert.ok(!promptOpen(), "with no question");
  Assert.ok(isOpen(), "and the picker stays open");
  Assert.deepEqual(titles(), ["keep-me.bin"], "the other download stays");
  Assert.ok(await IOUtils.exists(gone.target.path), "the file stays on disk");
  const list = await Downloads.getList(Downloads.ALL);
  Assert.ok(!(await list.getAll()).includes(gone), "and the download left Firefox's list");
  // A running download is not removed by mistake.
  const one = await held("running.bin");
  await until(() => titles().includes("running.bin"), "the running one is listed");
  // It heads the active section, above the highlight.
  EventUtils.synthesizeKey("k");
  await highlight("running.bin");
  EventUtils.synthesizeKey("d");
  await until(() => noticeText().includes("still downloading"), "d on a running one says why");
  await closePicker();
  await release();
  await one.done;
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_D_asks_and_deletes_the_file() {
  const tab = await pageTab();
  const file = await finished("delete-me.bin");
  await openPicker();
  await highlight("delete-me.bin");
  EventUtils.synthesizeKey("D", { shiftKey: true });
  await until(promptOpen, "shift+d asks first");
  Assert.ok(!isOpen(), "with the picker closed");
  Assert.equal(promptText(), 'delete "delete-me.bin" from disk? (y/N) ');
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !promptOpen(), "Esc answers no");
  Assert.ok(await IOUtils.exists(file.target.path), "and the file stays");
  await openPicker();
  await highlight("delete-me.bin");
  EventUtils.synthesizeKey("D", { shiftKey: true });
  await until(promptOpen, "shift+d asks again");
  EventUtils.synthesizeKey("y");
  await until(() => file.deleted, "y deletes the file");
  Assert.ok(!(await IOUtils.exists(file.target.path)), "it is gone from disk");
  await until(() => noticeText().includes("deleted"), "the notice says so");
  Assert.deepEqual(calls, [], "nothing reached the OS");
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_the_y_answer_goes_to_the_question_never_to_the_picker() {
  const tab = await pageTab();
  const file = await finished("answer-me.bin");
  await openPicker();
  await highlight("answer-me.bin");
  EventUtils.synthesizeKey("D", { shiftKey: true });
  await until(promptOpen, "shift+d asks");
  Assert.ok(!isOpen(), "the picker is closed before the question shows");
  // In the picker `y` would copy the link; here it is the answer.
  EventUtils.synthesizeKey("y");
  await until(() => file.deleted, "the y reached the question");
  Assert.ok(!isOpen(), "and the picker did not come back");
  Assert.ok(!noticeText().includes("copied"), "nothing was copied");
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_an_answer_does_nothing_if_the_download_changed() {
  const tab = await pageTab();
  const one = await held("changes.bin");
  await openPicker();
  await highlight("changes.bin");
  EventUtils.synthesizeKey("c");
  await until(promptOpen, "c asks");
  // It finishes while the question is open: the yes was for a running download.
  await release();
  await one.done;
  EventUtils.synthesizeKey("y");
  await until(() => noticeText().includes("changed"), "the notice says it changed");
  Assert.ok(one.download.succeeded && !one.download.canceled, "the download was not canceled");
  Assert.ok(await IOUtils.exists(one.download.target.path), "and its file stays");
  // Removed elsewhere while asked: nothing is deleted either.
  const file = await finished("removed-elsewhere.bin");
  await openPicker();
  await highlight("removed-elsewhere.bin");
  EventUtils.synthesizeKey("D", { shiftKey: true });
  await until(promptOpen, "shift+d asks");
  const list = await Downloads.getList(Downloads.PUBLIC);
  await list.remove(file);
  await PlacesUtils.history.clear();
  EventUtils.synthesizeKey("y");
  await until(() => noticeText().includes("changed"), "the notice says it changed");
  Assert.ok(await IOUtils.exists(file.target.path), "the file stays");
  // Its file deleted outside Firefox while asked: the answer finds it changed.
  const outside = await finished("deleted-outside.bin");
  await openPicker();
  await highlight("deleted-outside.bin");
  EventUtils.synthesizeKey("D", { shiftKey: true });
  await until(promptOpen, "shift+d asks");
  await IOUtils.remove(outside.target.path);
  const said = noticeText();
  EventUtils.synthesizeKey("y");
  await until(
    () => noticeText() !== said && noticeText().includes("changed"),
    "a file gone while asked counts as a change",
  );
  Assert.ok(!outside.deleted, "nothing was deleted");
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

const REP = Ci.nsIApplicationReputationService;

/**
 * A download Firefox blocked by a verdict, through the integration points its reputation and
 * content-analysis checks ask (DownloadCore.sys.mjs, DownloadCopySaver). A reputation block keeps
 * its bytes in the `.part` file; a content-analysis `Malware` block never does.
 * @param {string} name
 * @param {{ verdict?: number, by?: "reputation" | "contentAnalysis" }} [options]
 */
async function blockedDownload(name, { verdict = REP.VERDICT_UNCOMMON, by = "reputation" } = {}) {
  const safe = { shouldBlock: false, verdict: REP.VERDICT_SAFE };
  const block = (/** @type {any} */ base) => ({
    __proto__: base,
    async shouldBlockForReputationCheck() {
      return by === "reputation" ? { shouldBlock: true, verdict } : safe;
    },
    async shouldBlockForContentAnalysis() {
      return by === "contentAnalysis" ? { shouldBlock: true, verdict } : safe;
    },
    shouldKeepBlockedData: () => true,
  });
  Integration.downloads.register(block);
  try {
    const path = PathUtils.join(saveDir, name);
    const download = await Downloads.createDownload({
      source: `${SJS}?now&name=${name}`,
      target: { path, partFilePath: `${path}.part` },
    });
    await (await Downloads.getList(Downloads.PUBLIC)).add(download);
    const error = await download.start().then(
      () => null,
      (/** @type {any} */ e) => e,
    );
    Assert.ok(error?.becauseBlocked, `${name} is blocked`);
    return download;
  } finally {
    Integration.downloads.unregister(block);
  }
}

/** Firefox's commonDialog window, once built (CommonDialog.onLoad). */
const nextDialog = () => TestUtils.topicObserved("common-dialog-loaded").then(([w]) => w);

/** @param {any} download */
const partOf = (download) => /** @type {string} */ (download.target.partFilePath);

add_task(async function test_enter_on_a_blocked_download_says_why_and_the_keys() {
  const tab = await pageTab();
  const download = await blockedDownload("uncommon.bin");
  // Blocked after its transfer: Firefox sends `finish`, not `error`, so no panel; the status bar
  // is its warning (decision 10).
  await until(() => shown() === "↓ blocked", "the status bar says blocked");
  Assert.ok(!DownloadsPanel.isPanelShowing, "and Firefox's panel stays shut");
  await openPicker();
  await highlight("uncommon.bin");
  Assert.equal(cell(rows()[0], "index"), "blocked", "listed as blocked");
  Assert.deepEqual(headings(), ["Active · 1"], "under active while its data is kept");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => noticeText().startsWith("blocked: "), "Enter says why");
  Assert.ok(
    noticeText().endsWith("! allow or remove · d remove · shift+d delete"),
    `and the keys that apply: ${noticeText()}`,
  );
  Assert.ok(isOpen(), "the picker stays open");
  Assert.ok(download.hasBlockedData && !download.succeeded, "Enter never unblocks");
  await closePicker();
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_a_blocked_download_unblocks_only_through_firefoxs_dialog() {
  const tab = await pageTab();
  const download = await blockedDownload("allow-me.bin");
  await openPicker();
  await highlight("allow-me.bin");
  // Esc in Firefox's dialog cancels: nothing changes.
  let shown = nextDialog();
  EventUtils.synthesizeKey("!", { shiftKey: true });
  let dialog = await shown;
  Assert.ok(!isOpen(), "the picker closed before Firefox's dialog");
  EventUtils.synthesizeKey("KEY_Escape", {}, dialog);
  await until(() => dialog.closed, "Esc closes the dialog");
  await TestUtils.waitForTick();
  Assert.ok(download.hasBlockedData && !download.succeeded, "Esc keeps it blocked");
  Assert.ok(await IOUtils.exists(partOf(download)), "and its data");
  Assert.ok(!isOpen(), "the picker does not come back");
  // Its allow button releases the file, and opens nothing, even for a download the page's
  // question was answered "open" for (Behaviour 10: an allowed file is opened with `o`).
  download.launchWhenSucceeded = true;
  await focusContent(tab.linkedBrowser);
  await openPicker();
  await highlight("allow-me.bin");
  shown = nextDialog();
  EventUtils.synthesizeKey("!", { shiftKey: true });
  dialog = await shown;
  dialog.document.getElementById("commonDialog").getButton("accept").click();
  await until(() => download.succeeded, "allowed, the download is done");
  Assert.ok(await IOUtils.exists(download.target.path), "its file is in place");
  await until(() => noticeText().includes("allowed"), "the notice says so");
  Assert.deepEqual(calls, [], "nothing was opened or reached the OS");
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_enter_in_firefoxs_unblock_dialog_never_reaches_the_picker() {
  const tab = await pageTab();
  const download = await blockedDownload("enter-me.bin");
  await openPicker();
  await highlight("enter-me.bin");
  const shown = nextDialog();
  EventUtils.synthesizeKey("!", { shiftKey: true });
  const dialog = await shown;
  // The chooseUnblock dialog's default button removes the file (decision 7).
  EventUtils.synthesizeKey("KEY_Enter", {}, dialog);
  await until(() => download.deleted, "Enter removes the blocked file");
  Assert.ok(!download.hasBlockedData && !download.succeeded, "nothing was allowed");
  Assert.ok(!(await IOUtils.exists(partOf(download))), "its data is gone");
  Assert.ok(!isOpen(), "the picker did not come back");
  Assert.deepEqual(calls, [], "nothing reached the OS");
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_no_unblock_when_allowOverride_is_false() {
  await SpecialPowers.pushPrefEnv({ set: [["browser.safebrowsing.allowOverride", false]] });
  const tab = await pageTab();
  const download = await blockedDownload("no-override.bin");
  await openPicker();
  await highlight("no-override.bin");
  EventUtils.synthesizeKey("!", { shiftKey: true });
  await until(() => noticeText().includes("allowOverride"), "! says why");
  Assert.ok(isOpen(), "no dialog: the picker stays open");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => noticeText().startsWith("blocked: "), "Enter says why");
  Assert.ok(!noticeText().includes("allow or remove"), "and names no !");
  Assert.ok(download.hasBlockedData, "still blocked");
  await closePicker();
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
  await clean();
});

add_task(async function test_a_malware_verdict_can_only_be_removed() {
  const tab = await pageTab();
  const download = await blockedDownload("malware.bin", { verdict: REP.VERDICT_DANGEROUS });
  Assert.equal(download.error.reputationCheckVerdict, "Malware", "a Malware verdict");
  await openPicker();
  await highlight("malware.bin");
  EventUtils.synthesizeKey("!", { shiftKey: true });
  await until(() => noticeText().includes("can only be removed"), "! says why");
  Assert.ok(isOpen(), "no dialog: the picker stays open");
  EventUtils.synthesizeKey("d");
  await until(() => !titles().includes("malware.bin"), "d removes it");
  await until(() => download.deleted, "with its blocked data");
  Assert.ok(!(await IOUtils.exists(partOf(download))), "the data is gone from disk");
  await closePicker();
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_d_on_a_blocked_download_deletes_its_data() {
  const tab = await pageTab();
  const download = await blockedDownload("remove-blocked.bin");
  await openPicker();
  await highlight("remove-blocked.bin");
  EventUtils.synthesizeKey("d");
  await until(() => !titles().includes("remove-blocked.bin"), "d removes the row");
  await until(() => download.deleted && !download.hasBlockedData, "and confirms the block");
  Assert.ok(!(await IOUtils.exists(partOf(download))), "its data is gone");
  Assert.ok(!promptOpen(), "with no question, as Firefox's remove");
  await until(() => noticeText().includes("and its blocked data"), "the notice says so");
  await closePicker();
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_D_on_a_blocked_download_confirms_the_block() {
  const tab = await pageTab();
  const download = await blockedDownload("delete-blocked.bin");
  await openPicker();
  await highlight("delete-blocked.bin");
  EventUtils.synthesizeKey("D", { shiftKey: true });
  await until(promptOpen, "shift+d asks");
  EventUtils.synthesizeKey("y");
  await until(() => download.deleted && !download.hasBlockedData, "y confirms the block");
  Assert.ok(!(await IOUtils.exists(partOf(download))), "its data is gone");
  Assert.ok(!download.succeeded, "and nothing was allowed");
  await until(() => noticeText().includes("deleted"), "the notice says so");
  BrowserTestUtils.removeTab(tab);
  await clean();

  // An Insecure block keeps no bytes, yet stays blocked until its block is confirmed
  // (Download.refresh keeps hasBlockedData for that verdict).
  await SpecialPowers.pushPrefEnv({
    set: [
      ["dom.block_download_insecure", true],
      ["dom.security.https_first", false],
    ],
  });
  const page = await pageTab();
  const insecure = await clickDownload(`${SJS.replace("https://", "http://")}?now&name=http.bin`);
  await until(() => insecure.hasBlockedData, "blocked as Insecure");
  await until(() => DownloadsPanel.isPanelShowing, "Firefox's panel opens as its warning");
  const hidden = BrowserTestUtils.waitForEvent(DownloadsPanel.panel, "popuphidden");
  DownloadsPanel.hidePanel();
  await hidden;
  await focusContent(page.linkedBrowser);
  await openPicker();
  await highlight("http.bin");
  EventUtils.synthesizeKey("D", { shiftKey: true });
  await until(promptOpen, "shift+d asks");
  EventUtils.synthesizeKey("y");
  await until(() => insecure.deleted && !insecure.hasBlockedData, "y confirms the block");
  Assert.ok(!insecure.succeeded, "and nothing was allowed");
  BrowserTestUtils.removeTab(page);
  await SpecialPowers.popPrefEnv();
  await clean();
});

add_task(
  async function test_a_content_analysis_malware_verdict_cannot_be_unblocked_removed_or_deleted() {
    const tab = await pageTab();
    const download = await blockedDownload("scanned.bin", {
      verdict: REP.VERDICT_DANGEROUS,
      by: "contentAnalysis",
    });
    Assert.ok(download.error.becauseBlockedByContentAnalysis, "blocked by content analysis");
    await openPicker();
    await highlight("scanned.bin");
    EventUtils.synthesizeKey("!", { shiftKey: true });
    await until(() => noticeText().includes("nothing blocked to allow"), "! says why");
    EventUtils.synthesizeKey("d");
    await until(() => noticeText().includes("scanner keeps"), "d says why");
    EventUtils.synthesizeKey("D", { shiftKey: true });
    await TestUtils.waitForTick();
    Assert.ok(!promptOpen(), "shift+d asks nothing");
    Assert.ok(noticeText().includes("scanner keeps"), "and says why");
    Assert.ok(isOpen(), "the picker stays open");
    Assert.deepEqual(titles(), ["scanned.bin"], "the row stays");
    const list = await Downloads.getList(Downloads.ALL);
    Assert.ok((await list.getAll()).includes(download), "and so does the download");
    await closePicker();
    BrowserTestUtils.removeTab(tab);
    await clean();
  },
);

add_task(async function test_spam_blocks_are_not_listed() {
  const tab = await pageTab();
  await finished("real.bin");
  // As nsExternalAppHandler reports a page that started too many downloads.
  Services.obs.notifyObservers(
    tab.linkedBrowser.browsingContext,
    "blocked-automatic-download",
    `${DIR}spam.bin`,
  );
  const spam = DownloadIntegration.downloadSpamProtection;
  await until(() => DownloadsPanel.isPanelShowing, "Firefox's panel shows the spam block");
  const hidden = BrowserTestUtils.waitForEvent(DownloadsPanel.panel, "popuphidden");
  DownloadsPanel.hidePanel();
  await hidden;
  await focusContent(tab.linkedBrowser);
  await openPicker();
  await until(() => titles().length > 0, "the picker lists its rows");
  Assert.deepEqual(titles(), ["real.bin"], "the spam block is not listed");
  await closePicker();
  spam.removeDownloadSpamForWindow(`${DIR}spam.bin`, window);
  BrowserTestUtils.removeTab(tab);
  await clean();
});
