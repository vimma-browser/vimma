/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/vimma-mcp.md decision 31 (sub-PR 2c). A download from the agent workspace
// asks in the question line (name, size, type, host; never the URL), and a
// `vimma_download` grant covers it; it lands only in the quarantine folder, mode 0600, never
// opened; dangerous files need `!` for that one file; http and files over the cap are refused;
// with clamscan on PATH it is scanned before it leaves its .part name. The user's own Save Page
// in an agent tab is the user's. A download from another workspace is untouched.

"use strict";

/* global focusContent -- from head.js */
/* global Client -- from head_vimma_control.js */
/* global saveBrowser, DownloadsPanel, FileUtils -- the browser window's */
/* global requestLongerTimeout -- the browser-chrome harness (browser-test.js) */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);
requestLongerTimeout(4);

const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentGate.sys.mjs",
);
const { AgentPages } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentPages.sys.mjs",
);
const { McpHost, MCP_ENABLED_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/mcp-ops.mjs",
);
const { AgentDownloads } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentDownloads.sys.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
const { DownloadIntegration } = ChromeUtils.importESModule(
  "resource://gre/modules/DownloadIntegration.sys.mjs",
);
const { Integration } = ChromeUtils.importESModule("resource://gre/modules/Integration.sys.mjs");

const ASK_TIMEOUT = "vimma.mcp.askTimeoutMs";
const ARMING = "security.dialog_enable_delay";
const HTTPS = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const HTTP = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "http://mochi.test:8888",
);
const PAGE = `${HTTPS}file_vimma_agent_page.html`;
const SANDBOXED_AUXILIARY_NAVIGATION = 0x2;
const SANDBOXED_DOWNLOADS = 0x10000;

/** @param {Record<string, string | number>} q  the .sjs's query */
const fileUrl = (q, base = HTTPS) =>
  `${base}file_vimma_agent_download.sjs?${new URLSearchParams(
    /** @type {Record<string, string>} */ (q),
  )}`;

/** @param {() => boolean | Promise<boolean>} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 500);
const line = () => document.getElementById("vimma-agent-prompt");
const lineOpen = () => !!line() && !line().hidden;
const lineText = () => line()?.querySelector(".vimma-agent-prompt-text")?.textContent ?? "";
const hintText = () => line()?.querySelector(".vimma-agent-prompt-hint")?.textContent ?? "";
const noticeText = () => document.getElementById("vimma-notice")?.textContent ?? "";

let quarantine = "";
let normal = "";
let clamDir = "";

/** The `[mcp]` config in force, with the quarantine folder and `extra` set. */
function configure(extra = {}) {
  McpHost.configure({
    workspace: "agent",
    askTimeout: 50,
    grantMinutes: 10,
    grantMaxMinutes: 480,
    maxReadChars: 200000,
    notify: false,
    downloadDir: quarantine,
    downloadMaxMb: 200,
    ...extra,
  });
}

/**
 * A fake `clamscan` (decision 31 g). Vimma runs only /usr/bin/clamscan or /usr/local/bin/clamscan,
 * and only one it cannot write, so a replaced scanner is never run: the test's hook puts the fake in
 * that list and, unless `owned` is asked for, lets a file of ours count as not ours. `clean`
 * exits 0, `infected` 1 with a signature, `partial` 1 with Heuristics.Encrypted, `error` 2,
 * `hang` sleeps past the timeout; `missing` leaves none.
 * `--version` prints definitions dated now, `defs` days ago, or (`"none"`) none at all.
 * @param {"clean" | "infected" | "partial" | "error" | "hang" | "missing"} mode
 * @param {{ owned?: boolean, defs?: number | "none" }} [options]  `owned`: check ownership for
 *   real (the fake is ours)
 */
async function fakeClam(mode, { owned = false, defs = 0 } = {}) {
  const script = PathUtils.join(clamDir, "clamscan");
  if (mode === "missing") {
    await IOUtils.remove(script, { ignoreAbsent: true });
  } else {
    const out = {
      clean: 'echo "$f: OK"; exit 0',
      infected: 'echo "$f: Vimma-Test-Signature FOUND"; exit 1',
      partial: 'echo "$f: Heuristics.Encrypted.Zip FOUND"; exit 1',
      error: 'echo "cannot open" >&2; exit 2',
      hang: "sleep 30; exit 0",
    }[mode];
    await IOUtils.writeUTF8(
      script,
      [
        "#!/bin/sh",
        version(defs),
        // Every argument, one per line, then a blank line; the file is the last one.
        'for a; do echo "$a"; done >> "$(dirname "$0")/args"; echo >> "$(dirname "$0")/args"',
        'for f; do :; done; echo "$f" >> "$(dirname "$0")/scanned"',
        out,
        "",
      ].join("\n"),
    );
    await IOUtils.setPermissions(script, 0o755);
  }
  AgentDownloads._clamForTests = { paths: [script], trusted: !owned };
}

/**
 * The fake's answer to `--version` (decisions 43-44): ClamAV prints the definitions' date with
 * ctime(3), in local time.
 * @param {number | "none"} defs  days old, or no date
 */
function version(defs) {
  const date =
    defs === "none" ? "" : `/28156/$(date -d '${defs} days ago' '+%a %b %e %H:%M:%S %Y')`;
  return `for a; do [ "$a" = --version ] && { echo "ClamAV 1.5.4${date}"; exit 0; }; done`;
}

/**
 * A fake `clamdscan` and clamd.conf (decision 45), added to the fake clamscan's hook (call
 * fakeClam first). `clean` exits 0, `error` 2 (no clamd to connect to); `defs` as in fakeClam.
 * It logs what it scanned to `dscanned` and its arguments to `dargs`.
 * @param {"clean" | "error"} mode
 * @param {{ defs?: number | "none", conf?: string[] }} [options]  `conf`: clamd.conf's lines
 */
async function fakeClamd(mode, { defs = 0, conf } = {}) {
  const dir = PathUtils.join(clamDir, "d");
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  const script = PathUtils.join(dir, "clamdscan");
  const confPath = PathUtils.join(dir, "clamd.conf");
  await IOUtils.writeUTF8(
    script,
    [
      "#!/bin/sh",
      version(defs),
      `for a; do echo "$a"; done > "${clamDir}/dargs"`,
      `for f; do :; done; echo "$f" >> "${clamDir}/dscanned"`,
      mode === "clean" ? 'echo "$f: OK"; exit 0' : 'echo "ERROR: Could not connect"; exit 2',
      "",
    ].join("\n"),
  );
  await IOUtils.setPermissions(script, 0o755);
  await IOUtils.writeUTF8(
    confPath,
    (
      conf ?? [
        `LocalSocket ${PathUtils.join(dir, "clamd.ctl")}`,
        "AlertEncrypted yes",
        "AlertExceedsMax yes",
      ]
    ).join("\n"),
  );
  const hook = /** @type {any} */ (AgentDownloads._clamForTests);
  hook.clamd = { paths: [script], conf: confPath };
  return { conf: confPath };
}

/** What the fake clamdscan scanned, and clears it. */
async function dscanned() {
  const log = PathUtils.join(clamDir, "dscanned");
  if (!(await IOUtils.exists(log))) return [];
  const files = (await IOUtils.readUTF8(log)).trim().split("\n").filter(Boolean);
  await IOUtils.remove(log);
  return files;
}

/** The files the fake clamscan was asked to scan. */
async function scanned() {
  const log = PathUtils.join(clamDir, "scanned");
  if (!(await IOUtils.exists(log))) return [];
  return (await IOUtils.readUTF8(log)).trim().split("\n").filter(Boolean);
}

add_task(async function setup() {
  // In home: a quarantine is never in /tmp, /var/tmp or /dev/shm, where others can write.
  quarantine = await IOUtils.createUniqueDirectory(
    Services.dirsvc.get("Home", Ci.nsIFile).path,
    "vimma-test-quarantine",
  );
  normal = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-downloads");
  clamDir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-clam");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.download.always_ask_before_handling_new_types", false],
      ["browser.download.useDownloadDir", true],
      ["browser.download.folderList", 2],
      ["browser.download.dir", normal],
      ["browser.download.start_downloads_in_tmp_dir", false],
      ["browser.download.panel.shown", true],
      ["browser.download.alwaysOpenPanel", false],
      ["browser.download.autohideButton", false],
      ["dom.security.https_first", false],
      ["dom.security.https_only_mode", false],
      [ARMING, 0],
    ],
  });
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, true);
  await VimmaControl.settled();
  configure();
  AgentGate.addListener(collect);
  await fakeClam("missing");
  registerCleanupFunction(async () => {
    AgentGate.removeListener(collect);
    while (gBrowser.tabs.length > 1) BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
    const panel = document.getElementById("downloadsPanel");
    if (panel?.state === "open" || panel?.state === "showing") {
      const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
      DownloadsPanel.hidePanel();
      await hidden;
    }
    AgentDownloads._clamForTests = null;
    Services.prefs.clearUserPref(MCP_ENABLED_PREF);
    Services.prefs.clearUserPref(ASK_TIMEOUT);
    McpHost.configure(null);
    AgentGate.revoke();
    await VimmaControl.settled();
    const list = await Downloads.getList(Downloads.ALL);
    for (const d of await list.getAll()) {
      await d.finalize(true).catch(() => {});
      await list.remove(d);
    }
    for (const dir of [quarantine, normal, clamDir]) {
      await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    }
  });
});

/** A tab in the agent workspace's container, loaded with PAGE. */
async function agentTab() {
  const agent = /** @type {any} */ (WorkspaceStore.agent);
  const tab = gBrowser.addTab(PAGE, {
    userContextId: agent.userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE);
  return tab;
}

/** An agent connection, after its agent-hello. */
async function agentClient(name = "example-agent") {
  const c = new Client(/** @type {number} */ (VimmaControl.port));
  await c.handshake({ protocol: 2, role: "agent" });
  await c.call("agent-hello", { client: { name }, via: "example" });
  return c;
}

/** The next download added to the list (addView reports those there already: not them). */
async function nextDownload() {
  const list = await Downloads.getList(Downloads.ALL);
  const before = new Set(await list.getAll());
  return new Promise((resolve) => {
    const view = {
      onDownloadAdded(/** @type {any} */ d) {
        if (before.has(d)) return;
        list.removeView(view);
        resolve(d);
      },
    };
    list.addView(view);
  });
}

/** Every agent-download notice, in order (the notice line shows only the last). */
/** @type {string[]} */
const notices = [];
/** @param {any} e */
const collect = (e) => {
  if (e?.kind === "notice") notices.push(e.text);
};
/** @param {string} part */
const noticed = (part) => until(() => notices.some((n) => n.includes(part)), `a notice: ${part}`);

/** A page in `tab` starts a download of `url`, as a link the user or a script follows. */
function startIn(tab, url) {
  return SpecialPowers.spawn(tab.linkedBrowser, [url], (href) => {
    const a = content.document.createElement("a");
    a.href = href;
    content.document.body.append(a);
    a.click();
  });
}

/** The download question waiting now, once there is one. */
async function downloadQuestion() {
  await until(
    () => AgentGate.waiting.some((q) => q.tool === "vimma_download"),
    "a download question waits",
  );
  return /** @type {any} */ (AgentGate.waiting.find((q) => q.tool === "vimma_download"));
}

/** The files in a folder, by name. @param {string} dir */
async function names(dir) {
  return (await IOUtils.getChildren(dir)).map((p) => PathUtils.filename(p)).sort();
}

/** Wait for `download` to stop; whether it succeeded. @param {any} download */
async function settled(download) {
  await until(() => download.stopped, "the download stopped");
  if (!download.succeeded) {
    info(
      `not saved: ${download.error?.message ?? "no error"}; notices: ${notices.slice(-2).join(" / ")}`,
    );
  }
  return download.succeeded;
}

/** Removes every finished download and the quarantine's files, between tasks. */
async function clean() {
  const list = await Downloads.getList(Downloads.ALL);
  for (const d of await list.getAll()) {
    await d.finalize(true).catch(() => {});
    await list.remove(d);
  }
  for (const dir of [quarantine, normal]) {
    for (const f of await IOUtils.getChildren(dir)) {
      await IOUtils.setPermissions(f, 0o600).catch(() => {});
      await IOUtils.remove(f, { recursive: true });
    }
  }
  await IOUtils.remove(PathUtils.join(clamDir, "scanned"), { ignoreAbsent: true });
  AgentGate.revoke();
}

add_task(async function test_agent_tabs_may_download_again() {
  // Agent tabs have no SANDBOXED_DOWNLOADS flag; their browsing context's download folder is the
  // quarantine folder instead.
  const tab = await agentTab();
  const bc = tab.linkedBrowser.browsingContext;
  Assert.equal(bc.sandboxFlags & SANDBOXED_DOWNLOADS, 0, "agent tabs may start downloads");
  Assert.equal(
    bc.sandboxFlags & SANDBOXED_AUXILIARY_NAVIGATION,
    SANDBOXED_AUXILIARY_NAVIGATION,
    "and still open no pop-ups",
  );
  Assert.equal(bc.downloadFolderOverride, quarantine, "their downloads land in the quarantine");
  Assert.equal(
    gBrowser.selectedBrowser.browsingContext.downloadFolderOverride,
    "",
    "another workspace's tab keeps Firefox's folder",
  );
  Assert.ok(AgentPages, "the agent pages' hooks are in");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_the_question_then_yes_saves_to_the_quarantine_0600_unopened() {
  const tab = await agentTab();
  const added = nextDownload();
  await startIn(tab, fileUrl({ name: "report.pdf", type: "application/pdf", bytes: 2100 }));
  const q = await downloadQuestion();
  Assert.equal(q.label.client, "a page in the agent workspace", "no agent asked: the page's own");
  Assert.deepEqual(
    { name: q.what.name, size: q.what.size, type: q.what.type, host: q.what.host },
    { name: "report.pdf", size: 2100, type: "application/pdf", host: "example.com" },
    "the question has the name, size, type and host",
  );
  Assert.ok(!("url" in q.what), "and never the URL");
  Assert.deepEqual(await names(normal), [], "nothing in the Downloads folder");
  AgentGate.answer(q.id, { kind: "once" });
  const download = await added;
  Assert.ok(await settled(download), "saved");
  Assert.equal(PathUtils.parent(download.target.path), quarantine, "in the quarantine folder");
  Assert.deepEqual(await names(quarantine), ["report.pdf"], "only the file, no .part left");
  Assert.equal((await IOUtils.stat(download.target.path)).permissions, 0o600, "mode 0600");
  await until(() => noticeText().includes('saved "report.pdf"'), "a notice says where");
  Assert.ok(noticeText().endsWith(", not scanned"), "without ClamAV: not scanned");
  Assert.ok(!download.launchWhenSucceeded, "never opened");
  const combined = Integration.downloads.getCombined(DownloadIntegration);
  await Assert.rejects(
    combined.launchDownload(download, {}),
    /never opened/,
    "and Vimma refuses to open it later",
  );
  Assert.deepEqual(await names(normal), [], "still nothing in the Downloads folder");
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_no_saves_nothing() {
  const tab = await agentTab();
  const added = nextDownload();
  await startIn(tab, fileUrl({ name: "notes.txt", type: "text/plain", bytes: 300000 }));
  const q = await downloadQuestion();
  AgentGate.answer(q.id, { kind: "deny" });
  const download = await added;
  Assert.ok(!(await settled(download)), "refused");
  await until(async () => !(await names(quarantine)).length, "the part file is removed");
  Assert.deepEqual(await names(normal), [], "and nothing reaches the Downloads folder");
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_a_dangerous_file_needs_bang_for_that_one_file() {
  Services.prefs.setIntPref(ARMING, 0);
  const tab = await agentTab();
  await focusContent(gBrowser.selectedBrowser);
  const added = nextDownload();
  await startIn(tab, fileUrl({ name: "install.sh", type: "text/x-shellscript" }));
  const q = await downloadQuestion();
  Assert.equal(q.what.danger, "a script", "named as dangerous in the question");
  await until(lineOpen, "the line opens");
  Assert.ok(lineText().includes('"install.sh"') && lineText().includes("⚠ a script"), lineText());
  Assert.ok(!lineText().includes("https://"), "no URL on the line");
  await until(() => hintText() === "! allow this one file · n deny", "the hint asks for !");
  for (const key of ["y", "a", "5"]) EventUtils.synthesizeKey(key);
  await new Promise((r) => setTimeout(r, 100));
  Assert.equal(AgentGate.waiting.length, 1, "y, a and a count do not allow it");
  EventUtils.synthesizeKey("!", { shiftKey: true });
  const download = await added;
  Assert.ok(await settled(download), "! allows it");
  Assert.deepEqual(await names(quarantine), ["install.sh"], "saved, to the quarantine");
  Assert.equal((await IOUtils.stat(download.target.path)).permissions, 0o600, "with no exec bit");
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_dangerous_content_asks_again_and_no_deletes_it() {
  const tab = await agentTab();
  // An ELF under a harmless name: the name passes, the bytes do not.
  let added = nextDownload();
  await startIn(tab, fileUrl({ name: "data.bin2", type: "application/octet-stream", body: "elf" }));
  let q = await downloadQuestion();
  Assert.ok(!q.what.danger, "nothing dangerous by its name");
  AgentGate.answer(q.id, { kind: "once" });
  q = await downloadQuestion();
  Assert.equal(q.what.danger, "an executable (ELF)", "the bytes ask again");
  AgentGate.answer(q.id, { kind: "deny" });
  let download = await added;
  Assert.ok(!(await settled(download)), "refused");
  // Gone by the time it stopped (#204): its part and the placeholder at its name, no waiting.
  Assert.deepEqual(await names(quarantine), [], "and deleted");
  await noticed("an executable (ELF), not allowed");

  // A zip holding an executable: listed, never extracted; allowed only for that file.
  added = nextDownload();
  await startIn(tab, fileUrl({ name: "tools.zip", type: "application/zip", body: "zipexe" }));
  q = await downloadQuestion();
  AgentGate.answer(q.id, { kind: "once" });
  q = await downloadQuestion();
  Assert.equal(q.what.danger, "a zip holding an executable (bin/tool.exe)", "says what is inside");
  AgentGate.answer(q.id, { kind: "once" });
  download = await added;
  Assert.ok(await settled(download), "allowed for that one file");
  Assert.deepEqual(await names(quarantine), ["tools.zip"], "kept in the quarantine");

  // A zip with nothing dangerous asks once.
  added = nextDownload();
  await startIn(tab, fileUrl({ name: "docs.zip", type: "application/zip", body: "zip" }));
  q = await downloadQuestion();
  AgentGate.answer(q.id, { kind: "once" });
  download = await added;
  Assert.ok(await settled(download), "saved with one question");
  BrowserTestUtils.removeTab(tab);
  await clean();
});

// A `!` for one kind of danger is not a `!` for another.
add_task(async function test_a_different_danger_in_the_bytes_asks_again() {
  const tab = await agentTab();
  const added = nextDownload();
  await startIn(tab, fileUrl({ name: "run.sh", type: "text/x-sh", body: "elf" }));
  let q = await downloadQuestion();
  Assert.equal(q.what.danger, "a script", "a script by its name");
  AgentGate.answer(q.id, { kind: "once" });
  q = await downloadQuestion();
  Assert.equal(q.what.danger, "an executable (ELF)", "an ELF by its bytes asks again");
  AgentGate.answer(q.id, { kind: "deny" });
  Assert.ok(!(await settled(await added)), "and no deletes it");
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_http_is_refused() {
  const tab = await agentTab();
  const added = nextDownload();
  await startIn(tab, fileUrl({ name: "plain.txt", type: "text/plain" }, HTTP));
  const download = await added;
  // Firefox blocks an http download from an https page itself (insecure content); allowing it
  // there ("Allow download") reaches Vimma's check, which refuses any http download.
  Assert.ok(!(await settled(download)), "an http download from the agent container fails");
  if (download.hasBlockedData) await download.unblock().catch(() => {});
  await noticed('"plain.txt": not https');
  Assert.ok(!download.succeeded, "and stays refused");
  Assert.equal(AgentGate.waiting.length, 0, "without a question");
  await until(async () => !(await names(quarantine)).length, "nothing is kept");
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_the_size_cap() {
  configure({ downloadMaxMb: 1 });
  const tab = await agentTab();
  // Known from Content-Length: refused before the question.
  let added = nextDownload();
  await startIn(tab, fileUrl({ name: "big.dat", type: "application/octet-stream", bytes: 2e6 }));
  let download = await added;
  Assert.ok(!(await settled(download)), "over the cap: refused");
  Assert.equal(AgentGate.waiting.length, 0, "without a question");
  await noticed('"big.dat": over [mcp] download_max_mb (1 MB)');
  await until(async () => !(await names(quarantine)).length, "nothing is kept");

  // Unknown size, past the cap while streaming: cancelled and removed.
  added = nextDownload();
  await startIn(
    tab,
    fileUrl({ name: "stream.dat", type: "application/octet-stream", bytes: 3e6, stream: 1 }),
  );
  const q = await downloadQuestion();
  Assert.equal(q.what.size, -1, "the size is unknown");
  AgentGate.answer(q.id, { kind: "once" });
  download = await added;
  Assert.ok(!(await settled(download)), "cancelled past the cap");
  await until(async () => !(await names(quarantine)).length, "its part removed");
  BrowserTestUtils.removeTab(tab);
  configure();
  await clean();
});

/**
 * Download `name` in `tab`, allowed; if a second question asks to keep it unscanned, answer it.
 * @param {any} tab @param {string} name
 * @param {"once" | "deny" | null} [unscanned]  the answer if asked
 */
async function scanRun(tab, name, unscanned = null) {
  const added = nextDownload();
  await startIn(tab, fileUrl({ name, type: "text/plain" }));
  const q = await downloadQuestion();
  AgentGate.answer(q.id, { kind: "once" });
  let why = "";
  if (unscanned) {
    const again = await until(
      () => AgentGate.waiting.find((w) => /** @type {any} */ (w.what).unscanned),
      "asks whether to keep it unscanned",
    ).then(() => /** @type {any} */ (AgentGate.waiting[0]));
    why = again.what.unscanned;
    Assert.ok(why, `the question says why: ${why}`);
    AgentGate.answer(again.id, { kind: unscanned });
  }
  const download = await added;
  return { download, ok: await settled(download), why };
}

add_task(async function test_clamav_clean_infected_error_and_missing() {
  const tab = await agentTab();
  /** @param {string} name @param {"once" | "deny" | null} [unscanned] */
  const run = (name, unscanned = null) => scanRun(tab, name, unscanned);

  await fakeClam("clean");
  let r = await run("clean.txt");
  Assert.ok(r.ok, "clean: released");
  const asked = await scanned();
  Assert.equal(asked.length, 1, "scanned once");
  Assert.ok(asked[0]?.endsWith(".part"), `while it still had its .part name: ${asked[0]}`);
  Assert.equal(PathUtils.parent(asked[0] ?? ""), quarantine, "in the quarantine");
  const args = (await IOUtils.readUTF8(PathUtils.join(clamDir, "args"))).split("\n\n")[0];
  Assert.deepEqual(
    args?.split("\n"),
    [
      "--no-summary",
      "--stdout",
      "--alert-encrypted=yes",
      "--alert-exceeds-max=yes",
      "--",
      asked[0],
    ],
    "fixed arguments, alerting on what it cannot open, the path after --",
  );
  await noticed('"clean.txt" to ');
  Assert.ok(notices.at(-1)?.endsWith(", scanned (ClamAV)"), notices.at(-1));

  await fakeClam("infected");
  r = await run("bad.txt");
  Assert.ok(!r.ok, "infected: refused");
  // Gone by the time it stopped (#204): its part and the placeholder at its name, no waiting.
  Assert.deepEqual(await names(quarantine), ["clean.txt"], "and deleted");
  await noticed('"bad.txt": ClamAV found Vimma-Test-Signature');

  // What ClamAV could not scan is asked about, and no deletes it.
  await fakeClam("error");
  r = await run("unsure.txt", "deny");
  Assert.ok(!r.ok, "a ClamAV error asks; no deletes it");
  Assert.deepEqual(await names(quarantine), ["clean.txt"], "deleted");
  r = await run("kept.txt", "once");
  Assert.ok(r.ok, "yes keeps it");
  await noticed('"kept.txt" to ');
  Assert.ok(notices.at(-1)?.endsWith("not scanned (ClamAV failed)"), notices.at(-1));

  await fakeClam("partial");
  r = await run("locked.txt", "once");
  Assert.ok(r.ok, "encrypted: asked, and kept on a yes");
  await noticed('"locked.txt" to ');
  Assert.ok(notices.at(-1)?.endsWith("not fully scanned (ClamAV)"), notices.at(-1));

  await SpecialPowers.pushPrefEnv({ set: [["vimma.mcp.clamTimeoutMs", 500]] });
  await fakeClam("hang");
  r = await run("slow.txt", "deny");
  Assert.ok(!r.ok, "a ClamAV that does not finish in time asks; no deletes it");
  await SpecialPowers.popPrefEnv();

  // Vimma's own copy check: a clamscan the user can write is never run.
  await fakeClam("clean", { owned: true });
  await IOUtils.remove(PathUtils.join(clamDir, "scanned"), { ignoreAbsent: true });
  r = await run("owned.txt");
  Assert.ok(r.ok, "saved");
  Assert.deepEqual(await scanned(), [], "a clamscan of the user's own is not run");
  await noticed('"owned.txt" to ');
  Assert.ok(notices.at(-1)?.endsWith(", not scanned"), notices.at(-1));

  await fakeClam("missing");
  r = await run("plain.txt");
  Assert.ok(r.ok, "no ClamAV: released");
  await noticed('"plain.txt" to ');
  Assert.ok(notices.at(-1)?.endsWith(", not scanned"), notices.at(-1));
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_clamav_stale_definitions_and_clamd() {
  const tab = await agentTab();
  /** @param {string} name @param {"once" | "deny" | null} [unscanned] */
  const run = (name, unscanned = null) => scanRun(tab, name, unscanned);

  // Decision 43: clean by old definitions is asked about like a file not fully scanned.
  await fakeClam("clean", { defs: 30 });
  let r = await run("old.txt", "deny");
  Assert.ok(!r.ok, "stale definitions ask; no deletes it");
  Assert.equal(
    r.why,
    "ClamAV's definitions are 30 days old (over [mcp] clamav_max_age_days, 7)",
    "the question says how old",
  );
  Assert.deepEqual(await names(quarantine), [], "deleted");
  r = await run("old-kept.txt", "once");
  Assert.ok(r.ok, "yes keeps it");
  await noticed('"old-kept.txt" to ');
  Assert.ok(
    notices.at(-1)?.endsWith(", scanned with outdated definitions (ClamAV)"),
    notices.at(-1),
  );
  // Decision 44: the age is the config's.
  configure({ clamavMaxAgeDays: 60 });
  r = await run("old-ok.txt");
  Assert.ok(r.ok, "within [mcp] clamav_max_age_days: not asked");
  await noticed('"old-ok.txt" to ');
  Assert.ok(notices.at(-1)?.endsWith(", scanned (ClamAV)"), notices.at(-1));
  configure();
  await fakeClam("clean", { defs: "none" });
  r = await run("undated.txt", "once");
  Assert.equal(r.why, "ClamAV's definitions have no date", "no date is stale");
  // Infected stays infected, however old the definitions.
  await fakeClam("infected", { defs: 30 });
  r = await run("old-bad.txt");
  Assert.ok(!r.ok, "infected by old definitions: refused, not asked");

  // Decision 45: clamdscan when clamd can be used, the file passed open, the checked config.
  await fakeClam("infected");
  const { conf } = await fakeClamd("clean");
  r = await run("fast.txt");
  Assert.ok(r.ok, "clamd's clean is clean (the fake clamscan would have said infected)");
  const viaClamd = await dscanned();
  Assert.equal(viaClamd.length, 1, "clamdscan scanned it");
  const dargs = (await IOUtils.readUTF8(PathUtils.join(clamDir, "dargs"))).trim().split("\n");
  Assert.deepEqual(
    dargs,
    [`--config-file=${conf}`, "--fdpass", "--no-summary", "--stdout", "--", viaClamd[0]],
    "the checked config, the file passed open, the path after --",
  );
  await noticed('"fast.txt" to ');
  Assert.ok(notices.at(-1)?.endsWith(", scanned (ClamAV)"), notices.at(-1));

  // Any clamd failure ends in a full clamscan.
  await IOUtils.remove(PathUtils.join(clamDir, "scanned"), { ignoreAbsent: true });
  await fakeClam("clean");
  await fakeClamd("error");
  r = await run("fallback.txt");
  Assert.ok(r.ok, "clamd failed: clamscan's clean");
  Assert.equal((await dscanned()).length, 1, "clamdscan was tried");
  Assert.equal((await scanned()).length, 1, "then clamscan scanned it");

  await fakeClam("clean");
  await fakeClamd("clean", { defs: "none" });
  r = await run("nodate.txt");
  Assert.ok(r.ok, "clamd with no dated definitions: clamscan instead");
  Assert.deepEqual(await dscanned(), [], "clamdscan did not scan");

  await fakeClam("clean");
  await fakeClamd("clean", { conf: ["LocalSocket /run/x.ctl", "AlertEncrypted yes"] });
  r = await run("noalert.txt");
  Assert.ok(r.ok, "saved");
  Assert.deepEqual(await dscanned(), [], "a clamd that does not alert past its limits is not used");

  await fakeClam("clean", { owned: true });
  await fakeClamd("clean");
  r = await run("ours.txt");
  Assert.ok(r.ok, "saved");
  Assert.deepEqual(await dscanned(), [], "a clamdscan and config of the user's own are not used");

  // The socket's owner, from statx: root's folder is root's and not a socket.
  Assert.deepEqual(AgentDownloads._socketOwnerForTests("/"), { isSocket: false, uid: 0 });
  Assert.equal(AgentDownloads._socketOwnerForTests(PathUtils.join(clamDir, "none")), null);
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_an_agents_download_is_its_and_a_grant_covers_it() {
  const c = await agentClient();
  const url = fileUrl({ name: "a.txt", type: "text/plain" });
  // The agent opens the file's URL (vimma_open, asked and allowed), and the download it starts
  // asks as that agent's vimma_download.
  let added = nextDownload();
  const open = c.request("agent-open", { url });
  await until(() => AgentGate.waiting.length === 1, "the open asks");
  AgentGate.answer(/** @type {any} */ (AgentGate.waiting[0]).id, { kind: "once" });
  await c.response(open);
  let q = await downloadQuestion();
  Assert.equal(q.label.client, "example-agent", "the agent that opened the tab");
  Assert.equal(AgentGate.answer(q.id, { kind: "grant", minutes: 10 })?.minutes, 10, "granted");
  Assert.ok(await settled(await added), "saved");

  // Under the grant, the next one runs without a question; a dangerous one still asks.
  added = nextDownload();
  const open2 = c.request("agent-open", { url: fileUrl({ name: "b.txt", type: "text/plain" }) });
  await until(() => AgentGate.waiting.length === 1, "the open asks (no open grant)");
  AgentGate.answer(/** @type {any} */ (AgentGate.waiting[0]).id, { kind: "once" });
  await c.response(open2);
  Assert.ok(await settled(await added), "saved under the grant");
  Assert.equal(AgentGate.waiting.length, 0, "without a question");

  added = nextDownload();
  const open3 = c.request("agent-open", { url: fileUrl({ name: "c.sh", type: "text/x-sh" }) });
  await until(() => AgentGate.waiting.length === 1, "the open asks");
  AgentGate.answer(/** @type {any} */ (AgentGate.waiting[0]).id, { kind: "once" });
  await c.response(open3);
  q = await downloadQuestion();
  Assert.equal(q.what.danger, "a script", "a dangerous one asks even under the grant");
  AgentGate.answer(q.id, { kind: "deny" });
  Assert.ok(!(await settled(await added)), "and no refuses it");
  await until(
    async () => (await names(quarantine)).join() === "a.txt,b.txt",
    "two files kept, the refused one's part and name removed",
  );
  c.close();
  for (const tab of [...gBrowser.tabs]) {
    if (tab.userContextId === WorkspaceStore.agent?.userContextId) BrowserTestUtils.removeTab(tab);
  }
  await clean();
});

// A grant covers the downloads the agent's own open
// started, not what the page it opened downloads later.
add_task(async function test_a_grant_never_covers_the_pages_own_downloads() {
  const c = await agentClient();
  /** @param {string} url */
  const open = async (url) => {
    const id = c.request("agent-open", { url });
    await until(() => AgentGate.waiting.length === 1, "the open asks");
    AgentGate.answer(/** @type {any} */ (AgentGate.waiting[0]).id, { kind: "once" });
    return /** @type {any} */ (await c.response(id)).result.tab;
  };
  let added = nextDownload();
  await open(fileUrl({ name: "first.txt", type: "text/plain" }));
  const q = await downloadQuestion();
  Assert.equal(q.label.client, "example-agent", "the agent's own download");
  AgentGate.answer(q.id, { kind: "grant", minutes: 10 });
  Assert.ok(await settled(await added), "granted and saved");

  // The agent opens a page; whatever that page downloads afterwards is the page's.
  await open(PAGE);
  const agentTabs = () =>
    gBrowser.tabs.filter((t) => t.userContextId === WorkspaceStore.agent?.userContextId);
  const tab = /** @type {any} */ (
    agentTabs().find((t) => t.linkedBrowser.currentURI.spec === PAGE) ??
      (await until(
        () => agentTabs().some((t) => t.linkedBrowser.currentURI.spec === PAGE),
        "the page loads",
      ).then(() => agentTabs().find((t) => t.linkedBrowser.currentURI.spec === PAGE)))
  );
  // currentURI is the page's from the moment its load commits, before its body is parsed: wait
  // for the document, or the first script below finds no body to append to.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    ContentTaskUtils.waitForCondition(
      () => content.document.readyState === "complete",
      "the page has loaded",
    ),
  );
  for (const [how, go] of [
    ["location=", (/** @type {string} */ u) => `location.href = ${JSON.stringify(u)}`],
    [
      "<a download>",
      (/** @type {string} */ u) =>
        `{ const a = document.createElement("a"); a.href = ${JSON.stringify(u)}; ` +
        `a.download = "x"; document.body.append(a); a.click(); }`,
    ],
    [
      "meta refresh",
      (/** @type {string} */ u) =>
        `{ const m = document.createElement("meta"); m.httpEquiv = "refresh"; ` +
        `m.content = "0;url=" + ${JSON.stringify(u)}; document.head.append(m); }`,
    ],
  ]) {
    // The grant is still in force and its connection still open: without them the page's
    // download would be asked anyway, and the check below would prove nothing.
    Assert.ok(
      AgentGate.grants().some((g) => g.tool === "vimma_download"),
      `${how}: the agent's vimma_download grant is in force`,
    );
    added = nextDownload();
    const url = fileUrl({ name: `page-${how.replace(/\W/g, "")}.txt`, type: "text/plain" });
    await SpecialPowers.spawn(tab.linkedBrowser, [go(url)], (code) => {
      const script = content.document.createElement("script");
      script.textContent = code;
      content.document.body.append(script);
    });
    const asked = await downloadQuestion();
    Assert.equal(asked.label.client, "a page in the agent workspace", `${how}: the page's, asked`);
    // A yes on the last: three noes in a row would mute the page's questions for a minute.
    const yes = how === "meta refresh";
    AgentGate.answer(asked.id, { kind: yes ? "once" : "deny" });
    Assert.equal(await settled(await added), yes, `${how}: as answered`);
  }
  c.close();
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  await clean();
});

// The quarantine folder must be a private folder of the
// user's; one that is not is refused, and so is every download meanwhile.
add_task(async function test_a_folder_that_is_not_private_is_refused() {
  const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
  for (const [dir, why] of [
    ["/usr/share", "not yours"],
    [PathUtils.join(home, ".vimma-test-hidden"), "a hidden folder"],
  ]) {
    configure({ downloadDir: dir });
    const tab = await agentTab();
    const added = nextDownload();
    await startIn(tab, fileUrl({ name: "x.txt", type: "text/plain" }));
    const download = await added;
    Assert.ok(!(await settled(download)), `${why}: refused`);
    Assert.equal(AgentGate.waiting.length, 0, `${why}: without a question`);
    await noticed('"x.txt": the quarantine folder is not usable');
    Assert.ok(!(await IOUtils.exists(PathUtils.join(home, ".vimma-test-hidden"))), "not made");
    BrowserTestUtils.removeTab(tab);
    notices.length = 0;
  }
  configure();
  await clean();
});

// A download is an agent download by its container, by its
// tab's container, or by being in the quarantine folder.
add_task(async function test_classified_by_tab_and_by_place_too() {
  const tab = await agentTab();
  // From an agent tab, with no container on the download itself: still the agent's, and
  // refused outside the quarantine.
  let download = await Downloads.createDownload({
    source: {
      url: fileUrl({ name: "t.txt", type: "text/plain" }),
      browsingContextId: tab.linkedBrowser.browsingContext.id,
    },
    target: PathUtils.join(normal, "t.txt"),
  });
  download.start().catch(() => {});
  await until(() => download.stopped, "stopped");
  Assert.ok(!download.succeeded, "its tab: an agent download, refused outside the quarantine");
  await noticed('"t.txt": not in the quarantine folder');
  Assert.ok(!(await IOUtils.exists(PathUtils.join(normal, "t.txt"))), "nothing written");

  // Into the quarantine, with no container and no tab: asked like an agent download.
  download = await Downloads.createDownload({
    source: { url: fileUrl({ name: "p.txt", type: "text/plain" }) },
    target: PathUtils.join(quarantine, "p.txt"),
  });
  download.start().catch(() => {});
  const q = await downloadQuestion();
  Assert.equal(q.what.name, "p.txt", "its place: asked");
  AgentGate.answer(q.id, { kind: "deny" });
  await until(() => download.stopped, "stopped");
  Assert.ok(!download.succeeded, "and refused on a no");
  BrowserTestUtils.removeTab(tab);
  await clean();
});

// The other ways a download starts.
add_task(async function test_the_dialog_the_launch_path_a_frame_and_a_blob() {
  const tab = await agentTab();
  // Firefox's "always ask" dialog: never shown for an agent tab; saved to the quarantine.
  await SpecialPowers.pushPrefEnv({
    set: [["browser.download.always_ask_before_handling_new_types", true]],
  });
  let added = nextDownload();
  await startIn(tab, fileUrl({ name: "asked.txt", type: "application/x-vimma-ask" }));
  let q = await downloadQuestion();
  AgentGate.answer(q.id, { kind: "once" });
  let download = await added;
  Assert.ok(await settled(download), "saved, with no dialog");
  Assert.equal(PathUtils.parent(download.target.path), quarantine, "in the quarantine");
  await SpecialPowers.popPrefEnv();

  // "Always open similar files" (useSystemDefault): saved, never launched.
  const mime = Cc["@mozilla.org/mime;1"].getService(Ci.nsIMIMEService);
  const handlers = Cc["@mozilla.org/uriloader/handler-service;1"].getService(Ci.nsIHandlerService);
  const info = mime.getFromTypeAndExtension("application/x-vimma-open", "vopen");
  info.preferredAction = Ci.nsIHandlerInfo.useSystemDefault;
  info.alwaysAskBeforeHandling = false;
  handlers.store(info);
  registerCleanupFunction(() => handlers.remove(info));
  added = nextDownload();
  await startIn(tab, fileUrl({ name: "open.vopen", type: "application/x-vimma-open" }));
  q = await downloadQuestion();
  AgentGate.answer(q.id, { kind: "once" });
  download = await added;
  Assert.ok(await settled(download), "saved");
  Assert.ok(!download.launchWhenSucceeded, "not launched");
  Assert.equal(PathUtils.parent(download.target.path), quarantine, "in the quarantine");

  // A frame's download: the top's folder and question.
  added = nextDownload();
  const frameUrl = fileUrl({ name: "frame.txt", type: "text/plain" });
  await SpecialPowers.spawn(tab.linkedBrowser, [PAGE, frameUrl], async (page, url) => {
    const f = content.document.createElement("iframe");
    f.src = page;
    content.document.body.append(f);
    await new Promise((r) => (f.onload = r));
    const a = f.contentDocument.createElement("a");
    a.href = url;
    f.contentDocument.body.append(a);
    a.click();
  });
  q = await downloadQuestion();
  AgentGate.answer(q.id, { kind: "once" });
  download = await added;
  Assert.ok(await settled(download), "a frame's download is asked and saved");
  Assert.equal(PathUtils.parent(download.target.path), quarantine, "in the quarantine");

  // A blob: download made by the page's script: refused, not https.
  added = nextDownload();
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const script = content.document.createElement("script");
    script.textContent =
      'const a = document.createElement("a"); a.download = "made.txt"; ' +
      'a.href = URL.createObjectURL(new Blob(["x"])); document.body.append(a); a.click();';
    content.document.body.append(script);
  });
  download = await added;
  Assert.ok(!(await settled(download)), "a blob: download is refused");
  await noticed('"made.txt": not https');
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_another_workspace_downloads_as_before() {
  const added = nextDownload();
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await startIn(tab, fileUrl({ name: "mine.txt", type: "text/plain" }));
  const download = await added;
  Assert.ok(await settled(download), "saved");
  Assert.equal(AgentGate.waiting.length, 0, "no question");
  Assert.equal(PathUtils.parent(download.target.path), normal, "in the Downloads folder");
  Assert.deepEqual(await names(quarantine), [], "not the quarantine");
  BrowserTestUtils.removeTab(tab);
  await clean();
});

add_task(async function test_the_users_save_page_in_an_agent_tab_is_the_users() {
  // Not selected: that would switch the window to the agent workspace.
  const tab = await agentTab();
  const MockFilePicker = SpecialPowers.MockFilePicker;
  MockFilePicker.init(window.browsingContext);
  registerCleanupFunction(() => MockFilePicker.cleanup());
  const chosen = PathUtils.join(normal, "page.html");
  MockFilePicker.showCallback = () => {
    MockFilePicker.setFiles([new FileUtils.File(chosen)]);
    MockFilePicker.filterIndex = 1; // "Web Page, HTML only"
    return Ci.nsIFilePicker.returnOK;
  };
  await SpecialPowers.pushPrefEnv({ set: [["browser.download.useDownloadDir", false]] });
  const added = nextDownload();
  saveBrowser(tab.linkedBrowser);
  const download = await added;
  Assert.ok(await settled(download), "saved");
  Assert.equal(download.target.path, chosen, "where the user chose");
  Assert.equal(AgentGate.waiting.length, 0, "without an agent question");
  Assert.ok((await IOUtils.readUTF8(chosen)).length > 0, "with the page in it");
  await SpecialPowers.popPrefEnv();
  BrowserTestUtils.removeTab(tab);
  await clean();
});
