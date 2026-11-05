import { describe, test, expect } from "vitest";
import {
  DOWNLOAD_STATE,
  DOWNLOAD_ROW_CAP,
  DONE_MS,
  downloadState,
  downloadRow,
  downloadProgress,
  downloadSections,
  downloadSearchText,
  downloadKey,
  downloadAsks,
  downloadSummary,
  downloadSegment,
  downloadEnds,
  nameFromUrl,
} from "../src/downloads.mjs";
import { statusSegments } from "../src/statusbar.mjs";

/** @import { DownloadRecord } from "../src/downloads.mjs" */

const MB = 1024 * 1024;

/**
 * A finished download, overridden per test.
 * @param {Partial<DownloadRecord>} over
 * @returns {DownloadRecord}
 */
const rec = (over = {}) => ({
  id: 1,
  name: "report.pdf",
  url: "https://files.example.com/get/report.pdf?token=secret",
  path: "/home/u/Downloads/report.pdf",
  referrer: "https://example.com/reports",
  stopped: true,
  succeeded: true,
  canceled: false,
  deleted: false,
  hasProgress: true,
  hasPartialData: false,
  hasBlockedData: false,
  currentBytes: 7.4 * MB,
  totalBytes: 0,
  size: 7.4 * MB,
  speed: 0,
  targetExists: true,
  partFileExists: false,
  error: null,
  startTime: 1000,
  endTime: 2000,
  viewsInternally: true,
  workspace: null,
  agent: false,
  ...over,
});

/** @param {Partial<DownloadRecord>} over */
const running = (over = {}) =>
  rec({
    stopped: false,
    succeeded: false,
    hasPartialData: true,
    currentBytes: 3.1 * MB,
    totalBytes: 7.4 * MB,
    speed: 1.2 * MB,
    targetExists: false,
    partFileExists: true,
    endTime: null,
    ...over,
  });
/** @param {Partial<DownloadRecord>} over */
const paused = (over = {}) => running({ stopped: true, canceled: true, speed: 0, ...over });
/** @param {Partial<DownloadRecord>} over */
const failed = (over = {}) =>
  rec({
    succeeded: false,
    targetExists: false,
    error: { kind: "failed", verdict: "", reason: "" },
    ...over,
  });
/** @param {Partial<DownloadRecord>} over */
const canceled = (over = {}) =>
  rec({ succeeded: false, canceled: true, targetExists: false, ...over });
/** @param {Partial<DownloadRecord>} over */
const blocked = (over = {}) =>
  rec({
    succeeded: false,
    targetExists: false,
    hasBlockedData: true,
    error: { kind: "reputation", verdict: "Insecure", reason: "Insecure download" },
    ...over,
  });
const caMalware = (/** @type {Partial<DownloadRecord>} */ over = {}) =>
  blocked({
    hasBlockedData: false,
    error: { kind: "contentAnalysis", verdict: "Malware", reason: "Blocked by your organization" },
    ...over,
  });

const ctx = { allowOverride: true };

describe("downloadState", () => {
  test("the state of a download follows Firefox's stateOfDownload", () => {
    const S = DOWNLOAD_STATE;
    expect(downloadState(running())).toBe(S.DOWNLOADING);
    expect(downloadState(rec())).toBe(S.FINISHED);
    expect(downloadState(failed())).toBe(S.FAILED);
    expect(downloadState(canceled())).toBe(S.CANCELED);
    expect(downloadState(paused())).toBe(S.PAUSED);
    expect(downloadState(blocked())).toBe(S.DIRTY);
    expect(
      downloadState(
        blocked({ error: { kind: "contentAnalysis", verdict: "Uncommon", reason: "" } }),
      ),
    ).toBe(S.DIRTY);
    expect(downloadState(caMalware())).toBe(S.BLOCKED_CONTENT_ANALYSIS);
    expect(downloadState(blocked({ error: { kind: "parental", verdict: "", reason: "" } }))).toBe(
      S.BLOCKED_PARENTAL,
    );
    expect(
      downloadState(rec({ stopped: true, succeeded: false, canceled: false, error: null })),
    ).toBe(S.NOT_STARTED);
  });
});

describe("downloadRow", () => {
  test("a row shows name, state word, progress, host and end time", () => {
    const end = new Date(2026, 10, 5, 14, 7).getTime();
    const now = new Date(2026, 10, 5, 18, 0).getTime();
    const row = downloadRow(rec({ endTime: end }), now);
    expect(row).toMatchObject({
      kind: "download",
      downloadId: "1",
      display: "report.pdf",
      state: "done",
      detail: "7.4 MB",
      host: "files.example.com",
      ended: "14:07",
      active: false,
    });
    const older = downloadRow(rec({ endTime: new Date(2026, 10, 3, 9, 0).getTime() }), now);
    expect(older.ended).toBe("3 Nov");
  });

  test("state words for each state", () => {
    expect(downloadRow(running(), 0).state).toBe("41%");
    expect(downloadRow(running({ hasProgress: false }), 0).state).toBe("downloading");
    expect(downloadRow(paused(), 0).state).toBe("paused");
    expect(downloadRow(failed(), 0).state).toBe("failed");
    expect(downloadRow(canceled(), 0).state).toBe("canceled");
    expect(downloadRow(blocked(), 0).state).toBe("blocked");
    expect(downloadRow(rec({ targetExists: false }), 0).state).toBe("missing");
  });

  test("progress reads 3.1 / 7.4 MB · 1.2 MB/s · 0:35 left", () => {
    expect(downloadProgress(running())).toBe("3.1 / 7.4 MB · 1.2 MB/s · 0:04 left");
    expect(downloadProgress(running({ speed: (4.3 * MB) / 35 }))).toBe(
      "3.1 / 7.4 MB · 125.8 KB/s · 0:35 left",
    );
    expect(downloadProgress(paused())).toBe("3.1 / 7.4 MB");
    expect(downloadProgress(running({ speed: 0 }))).toBe("3.1 / 7.4 MB");
  });

  test("a size just under a unit reads in the larger unit", () => {
    expect(downloadProgress(rec({ size: 1024 * 1024 - 10 }))).toBe("1.0 MB");
    expect(downloadProgress(rec({ size: 512 }))).toBe("512 B");
  });

  test("an unknown size shows bytes so far", () => {
    expect(downloadProgress(running({ hasProgress: false, totalBytes: 0 }))).toBe(
      "3.1 MB · 1.2 MB/s",
    );
  });

  test("a row shows the host, never the URL", () => {
    const row = downloadRow(rec(), 0);
    expect(JSON.stringify(row)).not.toContain("token=secret");
    expect(downloadSearchText(row)).not.toContain("token");
    expect(downloadRow(rec({ url: "data:text/plain,hi" }), 0).host).toBe("");
  });

  test("a download with no file path is named by its URL's last segment, never the URL", () => {
    expect(nameFromUrl("https://files.example.com/get/report%20one.pdf?token=secret#x")).toBe(
      "report one.pdf",
    );
    expect(nameFromUrl("https://files.example.com/?token=secret")).toBe("files.example.com");
    expect(nameFromUrl("data:text/plain,secret")).toBe("download");
    expect(nameFromUrl("not a url")).toBe("download");
  });

  test("another workspace's download names it", () => {
    expect(downloadRow(rec({ workspace: "work" }), 0).workspace).toBe("work");
  });

  test("an agent download carries the agent glyph", () => {
    const row = downloadRow(rec({ agent: true }), 0);
    expect(row.agent).toBe(true);
    expect(row.workspace).toBe("◇ agent");
  });
});

describe("downloadSections", () => {
  test("sections: active then recent, newest first", () => {
    const rows = downloadSections(
      [
        rec({ id: 1, startTime: 10 }),
        running({ id: 2, startTime: 20 }),
        rec({ id: 3, startTime: 30 }),
        paused({ id: 4, startTime: 5 }),
        blocked({ id: 5, startTime: 1 }),
        blocked({ id: 6, startTime: 2, hasBlockedData: false }),
      ],
      0,
    );
    expect(rows.map((r) => [r.section, r.downloadId])).toEqual([
      ["active", "2"],
      ["active", "4"],
      ["active", "5"],
      ["recent", "3"],
      ["recent", "1"],
      ["recent", "6"],
    ]);
  });

  test("the cap keeps active rows over old finished ones", () => {
    const many = Array.from({ length: 120 }, (_, i) => rec({ id: i + 10, startTime: 100 + i }));
    const rows = downloadSections([paused({ id: 1, startTime: 1 }), ...many], 0);
    expect(rows).toHaveLength(DOWNLOAD_ROW_CAP);
    expect(rows[0].downloadId).toBe("1");
  });

  test("the list is capped at 100 rows", () => {
    const many = Array.from({ length: 130 }, (_, i) => rec({ id: i, startTime: i }));
    const rows = downloadSections(many, 0);
    expect(rows).toHaveLength(DOWNLOAD_ROW_CAP);
    expect(DOWNLOAD_ROW_CAP).toBe(100);
    expect(rows[0].downloadId).toBe("129");
  });

  test("the filter matches name, host, state and workspace", () => {
    const text = downloadSearchText(downloadRow(rec({ workspace: "work" }), 0));
    for (const word of ["report.pdf", "files.example.com", "done", "work"]) {
      expect(text).toContain(word);
    }
  });
});

describe("downloadKey", () => {
  /** @param {DownloadRecord} r @param {string} key */
  const op = (r, key, c = ctx) => {
    const k = downloadKey(r, key, c);
    return k.type === "run" ? k.op : k.type;
  };

  test("the keys that apply follow isCommandEnabled for each state", () => {
    // Finished, file present.
    expect(op(rec(), "o")).toBe("open");
    expect(op(rec(), "shift+o")).toBe("openSystem");
    expect(op(rec({ viewsInternally: false }), "shift+o")).toBe("refuse");
    expect(op(rec(), "s")).toBe("show");
    expect(op(rec(), "y")).toBe("copyLink");
    expect(op(rec(), "shift+y")).toBe("copyPath");
    expect(op(rec(), "p")).toBe("refuse");
    expect(op(rec(), "c")).toBe("refuse");
    expect(op(rec(), "r")).toBe("refuse");
    expect(op(rec(), "u")).toBe("referrer");
    expect(op(rec({ referrer: null }), "u")).toBe("refuse");
    expect(op(rec({ referrer: "about:blank" }), "u")).toBe("refuse");
    // A referrer is chosen by the page: only a web page is opened, never a script or a file.
    expect(op(rec({ referrer: "http://example.com/a" }), "u")).toBe("referrer");
    for (const referrer of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"]) {
      expect(op(rec({ referrer }), "u"), referrer).toBe("refuse");
    }
    expect(op(rec(), "d")).toBe("remove");
    expect(op(rec(), "shift+d")).toBe("delete");
    expect(op(rec(), "!")).toBe("refuse");
    expect(op(rec(), "shift+l")).toBe("library");
    // The file was deleted outside Firefox.
    const gone = rec({ targetExists: false });
    expect(op(gone, "o")).toBe("refuse");
    expect(op(gone, "s")).toBe("refuse");
    expect(op(gone, "shift+y")).toBe("refuse");
    expect(op(gone, "shift+d")).toBe("refuse");
    expect(op(gone, "d")).toBe("remove");
    // In progress.
    expect(op(running(), "o")).toBe("refuse");
    expect(op(running(), "s")).toBe("show");
    expect(op(running(), "p")).toBe("pauseResume");
    expect(op(running({ hasPartialData: false }), "p")).toBe("refuse");
    expect(op(running(), "c")).toBe("cancel");
    expect(op(running({ hasPartialData: false }), "c")).toBe("cancel");
    expect(op(running(), "d")).toBe("refuse");
    expect(op(running(), "shift+d")).toBe("delete");
    // Paused.
    expect(op(paused(), "p")).toBe("pauseResume");
    expect(op(paused(), "c")).toBe("cancel");
    expect(op(paused(), "d")).toBe("remove");
    // Failed and canceled.
    expect(op(failed(), "r")).toBe("retry");
    expect(op(failed(), "p")).toBe("refuse");
    expect(op(canceled(), "r")).toBe("retry");
    expect(op(canceled(), "c")).toBe("refuse");
    expect(op(blocked(), "r")).toBe("refuse");
  });

  test("a key that does not apply says why", () => {
    expect(downloadKey(running(), "o", ctx)).toEqual({ type: "refuse", text: "not finished yet" });
    expect(downloadKey(rec({ targetExists: false }), "o", ctx)).toEqual({
      type: "refuse",
      text: "the file is missing",
    });
    expect(downloadKey(rec(), "z", ctx)).toEqual({ type: "none" });
  });

  test("Enter is open, resume, retry, the reason or nothing by state", () => {
    expect(op(rec(), "enter")).toBe("open");
    expect(op(paused(), "enter")).toBe("pauseResume");
    expect(op(failed(), "enter")).toBe("retry");
    expect(op(canceled(), "enter")).toBe("retry");
    expect(op(running(), "enter")).toBe("none");
    const reason = downloadKey(blocked(), "enter", ctx);
    expect(reason).toEqual({
      type: "notice",
      text: "blocked: Insecure download · ! allow or remove · d remove · shift+d delete",
    });
  });

  test("unblock needs blocked data and allowOverride", () => {
    expect(op(blocked(), "!")).toBe("unblock");
    expect(op(blocked({ hasBlockedData: false }), "!")).toBe("refuse");
    expect(downloadKey(blocked(), "!", { allowOverride: false })).toEqual({
      type: "refuse",
      text: "allowing blocked downloads is off (browser.safebrowsing.allowOverride)",
    });
    expect(downloadKey(blocked(), "enter", { allowOverride: false })).toEqual({
      type: "notice",
      text: "blocked: Insecure download · d remove · shift+d delete",
    });
  });

  test("a Malware verdict refuses !", () => {
    const m = blocked({ error: { kind: "reputation", verdict: "Malware", reason: "Virus" } });
    expect(downloadKey(m, "!", ctx)).toEqual({
      type: "refuse",
      text: "a file named as malware can only be removed",
    });
    expect(op(m, "d")).toBe("remove");
    expect(op(m, "shift+d")).toBe("delete");
  });

  test("a content-analysis Malware verdict refuses !, d and shift+d", () => {
    for (const key of ["!", "d", "shift+d"]) expect(op(caMalware(), key)).toBe("refuse");
    expect(downloadKey(caMalware(), "d", ctx)).toEqual({
      type: "refuse",
      text: "your organization's scanner keeps this download",
    });
    expect(downloadKey(caMalware(), "enter", ctx)).toEqual({
      type: "notice",
      text: "blocked: Blocked by your organization",
    });
  });

  test("d on blocked data is offered with the data deleted, as Firefox's remove", () => {
    expect(op(blocked(), "d")).toBe("remove");
    expect(op(blocked(), "shift+d")).toBe("delete");
    expect(op(blocked({ hasBlockedData: false }), "shift+d")).toBe("refuse");
  });

  test("an agent download refuses o, shift+o, u, r and !", () => {
    const agent = { agent: true };
    const never = { type: "refuse", text: "agent downloads are never opened by Vimma" };
    expect(downloadKey(rec(agent), "o", ctx)).toEqual(never);
    expect(downloadKey(rec(agent), "enter", ctx)).toEqual(never);
    expect(downloadKey(rec(agent), "shift+o", ctx)).toEqual(never);
    expect(downloadKey(rec(agent), "u", ctx)).toEqual({
      type: "refuse",
      text: "an agent download's page is never opened by Vimma",
    });
    expect(op(failed(agent), "r")).toBe("refuse");
    expect(op(failed(agent), "enter")).toBe("refuse");
    expect(op(blocked(agent), "!")).toBe("refuse");
    for (const [key, want] of [
      ["s", "show"],
      ["y", "copyLink"],
      ["shift+y", "copyPath"],
      ["d", "remove"],
      ["shift+d", "delete"],
    ]) {
      expect(op(rec(agent), key)).toBe(want);
    }
  });

  test("shift+d and c need a y/N; d does not", () => {
    expect(downloadAsks("delete")).toBe(true);
    expect(downloadAsks("cancel")).toBe(true);
    expect(downloadAsks("remove")).toBe(false);
    expect(downloadAsks("open")).toBe(false);
  });
});

describe("downloadSegment", () => {
  /** @param {readonly DownloadRecord[]} list */
  const at = (list, ends = null, now = 0) => downloadSegment(downloadSummary(list), ends, now);

  test("the segment shows one, several, unknown size and paused", () => {
    expect(at([running()])).toMatchObject({ text: "↓ 41%", label: "downloading 41%" });
    expect(at([running(), running({ id: 2 }), running({ id: 3 })])).toMatchObject({
      text: "↓ 3 · 41%",
      label: "3 downloads, 41%",
    });
    expect(
      at([
        running({ hasProgress: false, totalBytes: 0 }),
        running({ id: 2, hasProgress: false, totalBytes: 0 }),
      ]),
    ).toMatchObject({
      text: "↓ 2",
      label: "2 downloads",
    });
    expect(at([paused()])).toMatchObject({ text: "↓ paused", label: "download paused" });
    expect(at([rec()])).toBe(null);
    expect(at([])).toBe(null);
  });

  test("done goes after 10 seconds; failed and blocked stay until the picker is opened", () => {
    expect(DONE_MS).toBe(10_000);
    expect(at([], { state: "done", at: 0 }, 9_999)).toMatchObject({ text: "↓ done" });
    expect(at([], { state: "done", at: 0 }, 10_000)).toBe(null);
    expect(at([], { state: "failed", at: 0 }, 3_600_000)).toMatchObject({
      text: "↓ failed",
      label: "download failed",
    });
    expect(at([], { state: "blocked", at: 0 }, 3_600_000)).toMatchObject({
      text: "↓ blocked",
      label: "download blocked",
    });
    // A running download is shown over an end.
    expect(at([running()], { state: "failed", at: 0 }, 1)).toMatchObject({ text: "↓ 41%" });
  });

  test("failed and blocked outrank the title; progress gives way first", () => {
    const status = (/** @type {any} */ downloads) =>
      statusSegments({ mode: "normal", downloads }).find((s) => s.id === "downloads");
    const progress = status(at([running()]));
    expect(progress).toMatchObject({
      text: "↓ 41%",
      label: "downloading 41%",
      side: "right",
      fg: "--vimma-fg-dim",
      priority: 6.5,
    });
    const problem = status(at([], { state: "blocked", at: 0 }, 1));
    expect(problem).toMatchObject({ fg: "--vimma-text-error", priority: 3 });
    expect(statusSegments({ mode: "normal" }).some((s) => s.id === "downloads")).toBe(false);
  });

  test("the segment's accessible text has no arrow", () => {
    for (const seg of [
      at([running()]),
      at([paused()]),
      at([], { state: "done", at: 0 }, 1),
      at([], { state: "failed", at: 0 }, 1),
    ]) {
      expect(seg?.label).not.toContain("↓");
    }
  });
});

describe("downloadEnds", () => {
  test("each end is announced once", () => {
    // The list as the window first reads it (history included) is never announced.
    let out = downloadEnds(new Map(), [rec(), failed({ id: 2 }), running({ id: 3 })], {
      seed: true,
    });
    expect(out.texts).toEqual([]);
    expect(out.end).toBe(null);
    out = downloadEnds(out.seen, [rec(), failed({ id: 2 }), rec({ id: 3, name: "c.iso" })]);
    expect(out.texts).toEqual(["download finished: c.iso"]);
    expect(out.end).toBe("done");
    out = downloadEnds(out.seen, [rec(), failed({ id: 2 }), rec({ id: 3, name: "c.iso" })]);
    expect(out.texts).toEqual([]);
    expect(out.end).toBe(null);
  });

  test("a download blocked before it started is new, whatever the seed's time", () => {
    // Firefox adds an insecure download already blocked, with no start time yet.
    const seeded = downloadEnds(new Map(), [rec()], { seed: true }).seen;
    const out = downloadEnds(seeded, [rec(), blocked({ id: 2, name: "x.bin", startTime: 0 })], {
      since: 5000,
    });
    expect(out.texts).toEqual(["download blocked: x.bin"]);
    expect(out.end).toBe("blocked");
  });

  test("a canceled or paused download is not an end", () => {
    let out = downloadEnds(new Map(), [running(), running({ id: 2 })], { seed: true });
    out = downloadEnds(out.seen, [canceled(), paused({ id: 2 })]);
    expect(out.texts).toEqual([]);
    expect(out.end).toBe(null);
  });

  test("a download that was seen running and ends is announced, the worst end wins", () => {
    let out = downloadEnds(new Map(), [
      running({ id: 1 }),
      running({ id: 2, name: "a.zip" }),
      running({ id: 3, name: "b.exe" }),
    ]);
    out = downloadEnds(out.seen, [
      rec({ id: 1 }),
      failed({ id: 2, name: "a.zip" }),
      blocked({ id: 3, name: "b.exe" }),
    ]);
    expect(out.texts).toEqual([
      "download finished: report.pdf",
      "download failed: a.zip",
      "download blocked: b.exe",
    ]);
    expect(out.end).toBe("blocked");
  });

  test("a history entry that reaches the list after the seed is not announced", () => {
    const out = downloadEnds(
      new Map(),
      [rec({ id: 7, startTime: 500 }), blocked({ id: 8, startTime: 2000 })],
      {
        since: 1000,
      },
    );
    expect(out.texts).toEqual(["download blocked: report.pdf"]);
  });

  test("a download blocked as it is added is announced", () => {
    const out = downloadEnds(new Map(), [blocked({ id: 9, name: "b.exe" })]);
    expect(out.texts).toEqual(["download blocked: b.exe"]);
    expect(out.end).toBe("blocked");
  });
});
