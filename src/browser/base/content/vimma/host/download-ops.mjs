/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The window's downloads (docs/specs/downloads.md): the status bar's `↓` segment (Behaviour 12,
// decision 9) and the `ctrl+b d` picker (decisions 3, 5 and 12), each a view on the window's
// Firefox download list, read into core DownloadRecords. A picker key runs through Firefox's own
// download code only: `DownloadsCommon.openDownload` and `Download.showContainingDirectory` are
// the only calls here that hand a file to the OS (docs/security/06-chrome-ui-rendering.md C2).
// Cancel and delete ask `y/N` first, with the picker closed (decision 6,
// docs/security/21-downloads-picker.md D5).

import {
  DONE_MS,
  DOWNLOAD_ROW_CAP,
  downloadAsks,
  downloadChanged,
  downloadEnds,
  downloadKey,
  downloadQuestion,
  downloadSections,
  downloadSegment,
  downloadState,
  downloadSummary,
  nameFromUrl,
} from "../core/downloads.mjs";
import { WindowWorkspaces } from "../workspaces/WindowWorkspaces.sys.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";
import { runCommand } from "./browser-ops.mjs";
import { refusedScheme } from "../core/pageurl.mjs";
import { openUrl } from "./tab-ops.mjs";
import { HostServices } from "./host-services.mjs";

/** @import { DownloadEndState, DownloadItem, DownloadOp, DownloadRecord, DownloadSegment } from "../core/downloads.mjs" */

/**
 * @typedef {"AppConstants" | "DownloadHistory" | "DownloadIntegration" | "Downloads"
 *   | "DownloadsCommon" | "Integration" | "PrivateBrowsingUtils"} LazyName
 */
const lazy = /** @type {Lazy<LazyName>} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  DownloadHistory: "resource://gre/modules/DownloadHistory.sys.mjs",
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  DownloadsCommon: "moz-src:///browser/components/downloads/DownloadsCommon.sys.mjs",
  DownloadIntegration: "resource://gre/modules/DownloadIntegration.sys.mjs",
  Integration: "resource://gre/modules/Integration.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

/**
 * The combined download integration, as DownloadsViewUI reads it: Firefox's
 * DownloadsViewableInternally registers the types it shows itself there, not on the module.
 */
const integration = () => lazy.Integration.downloads.getCombined(lazy.DownloadIntegration);

/** A picker re-renders a download's progress at most this often (decision 12). */
const PROGRESS_MS = 1000;

/** A per-session id for each Firefox `Download` object, so a row keeps its download. */
const ids = new WeakMap();
let nextId = 1;

/** @param {any} download */
function idOf(download) {
  let id = ids.get(download);
  if (id === undefined) {
    id = nextId++;
    ids.set(download, id);
  }
  return id;
}

/** @param {any} error  a Downloads.Error, or null */
function errorOf(error) {
  if (!error) return null;
  /** @type {"parental" | "reputation" | "contentAnalysis" | "failed"} */
  const kind = error.becauseBlockedByParentalControls
    ? "parental"
    : error.becauseBlockedByReputationCheck
      ? "reputation"
      : error.becauseBlockedByContentAnalysis
        ? "contentAnalysis"
        : "failed";
  return {
    kind,
    verdict: String(error.reputationCheckVerdict ?? ""),
    reason: String(error.message ?? ""),
  };
}

/**
 * What a picker row needs beyond the status bar: whether it is an agent download, another
 * workspace's name, and whether Firefox shows the file itself. Read once per state, not on every
 * progress chunk: the agent test and the MIME lookup cost more than the byte counts.
 * @typedef {{ key: string, agent: boolean, workspace: string | null, viewsInternally: boolean }}
 *   About
 */
/** @type {WeakMap<object, About>} */
const abouts = new WeakMap();

/**
 * The workspace whose container a session download came from, when it is not this window's
 * current one (decision 4). A history entry keeps no container, so it names none.
 * @param {BrowserWindow} win
 * @param {any} d
 */
function workspaceOf(win, d) {
  const ucid = d.source?.userContextId;
  if (!ucid) return null;
  const def = WorkspaceStore.definitions.workspaces.find((w) => w.userContextId === ucid);
  if (!def) return null;
  return def.name === WindowWorkspaces.get(win)?.status()?.name ? null : def.name;
}

/**
 * Whether Firefox would show the finished file in a tab of its own (a PDF), as its panel decides
 * `openInSystemViewer` (DownloadsViewUI.sys.mjs, isCommandEnabled).
 * @param {any} d
 */
function viewsInternally(d) {
  if (!d.succeeded) return false;
  try {
    const type = lazy.DownloadsCommon.getMimeInfo(d)?.type;
    return !!type && !!integration().shouldViewDownloadInternally(type);
  } catch {
    return false;
  }
}

/**
 * @param {BrowserWindow} win
 * @param {any} d
 * @returns {About}
 */
function aboutOf(win, d) {
  const key = `${d.stopped}/${d.succeeded}/${d.target?.path ?? ""}`;
  const known = abouts.get(d);
  if (known && known.key === key) return known;
  const about = {
    key,
    // The test AgentDownloads applies to every download: its container, its tab's, or the
    // quarantine folder (docs/security/12-agents-mcp.md M11). Asked before vimma.js provides it, it
    // calls every download an agent's, which the picker refuses to open.
    agent: !!HostServices.isAgentDownload(d),
    workspace: workspaceOf(win, d),
    viewsInternally: viewsInternally(d),
  };
  abouts.set(d, about);
  return about;
}

/**
 * A Firefox `Download` (toolkit/components/downloads/DownloadCore.sys.mjs), or a history entry
 * (DownloadHistory.sys.mjs, HistoryDownload: no byte counts, no referrer, no start time but its
 * Places visit's), as a core record. With `win`, the picker's fields are filled too.
 * @param {any} d
 * @param {BrowserWindow | null} [win]
 * @returns {DownloadRecord}
 */
export function recordOf(d, win = null) {
  const path = d.target?.path ?? "";
  const about = win ? aboutOf(win, d) : { agent: false, workspace: null, viewsInternally: false };
  const start = d.startTime
    ? new Date(d.startTime).getTime()
    : d.placesNode
      ? d.placesNode.time / 1000
      : 0;
  return {
    id: idOf(d),
    name: path ? PathUtils.filename(path) : nameFromUrl(String(d.source?.url ?? "")),
    url: String(d.source?.url ?? ""),
    path,
    referrer: d.source?.referrerInfo?.originalReferrer?.spec ?? null,
    stopped: !!d.stopped,
    succeeded: !!d.succeeded,
    canceled: !!d.canceled,
    deleted: !!d.deleted,
    hasProgress: !!d.hasProgress,
    hasPartialData: !!d.hasPartialData,
    hasBlockedData: !!d.hasBlockedData,
    currentBytes: d.currentBytes ?? 0,
    totalBytes: d.totalBytes ?? 0,
    size: d.target?.size ?? 0,
    speed: d.speed ?? 0,
    targetExists: !!d.target?.exists,
    partFileExists: !!d.target?.partFileExists,
    error: errorOf(d.error),
    startTime: start,
    endTime: d.endTime ? new Date(d.endTime).getTime() : null,
    viewsInternally: about.viewsInternally,
    workspace: about.workspace,
    agent: about.agent,
  };
}

/**
 * The list a window shows (decision 3): a private window, its private session's downloads only;
 * a normal one, the profile's session downloads then the newest from history, as the Library.
 * @param {BrowserWindow} win
 */
function listFor(win) {
  if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
    return lazy.Downloads.getList(lazy.Downloads.PRIVATE);
  }
  return lazy.DownloadHistory.getList({
    type: lazy.Downloads.PUBLIC,
    maxHistoryResults: DOWNLOAD_ROW_CAP,
  });
}

/**
 * One window's view on its download list: the private session's in a private window, the
 * profile's otherwise (decision 3), so a private download is never counted in a normal window.
 * It keeps the last end (`done`, `failed`, `blocked`) for the segment and announces each end
 * once (Behaviour 12 and 13).
 */
export class DownloadWatch {
  /**
   * @param {BrowserWindow} win
   * @param {() => void} emit  the segment changed
   * @param {(text: string) => void} [say]  an announcement for the status bar's live region
   */
  constructor(win, emit, say = () => {}) {
    this.win = win;
    this.emit = emit;
    this.say = say;
    /** @type {Set<any>} */
    this.downloads = new Set();
    /** @type {any} */
    this.list = null;
    this.view = null;
    /** @type {DownloadSegment | null} */
    this.current = null;
    this.text = "null";
    this.destroyed = false;
    /** @type {Map<number, number>} each download's last state, for downloadEnds */
    this.seen = new Map();
    /** When the list was first read: a download already ended before it is not announced. */
    this.since = Infinity;
    /** @type {{ state: DownloadEndState, at: number } | null} */
    this.end = null;
    /** @type {number | null} the timer that takes `↓ done` away */
    this.doneTimer = null;
    this.attach().catch(console.error);
  }

  /** @private A view on the window's list, for the life of the window. */
  async attach() {
    const view = {
      /** @param {any} d */
      onDownloadAdded: (d) => (this.downloads.add(d), this.changed()),
      onDownloadChanged: () => this.changed(),
      /** @param {any} d */
      onDownloadRemoved: (d) => (this.downloads.delete(d), this.changed()),
    };
    this.view = view;
    const priv = lazy.PrivateBrowsingUtils.isWindowPrivate(this.win);
    const list = await lazy.Downloads.getList(
      priv ? lazy.Downloads.PRIVATE : lazy.Downloads.PUBLIC,
    );
    if (this.view !== view || this.destroyed) return;
    this.list = list;
    await list.addView(view);
    // addView lists what is there already: those ends happened before this window looked.
    this.seen = downloadEnds(new Map(), this.records(), { seed: true }).seen;
    this.since = Date.now();
  }

  /** @private */
  detach() {
    if (this.list && this.view) this.list.removeView(this.view);
    this.list = null;
    this.view = null;
    this.downloads.clear();
    this.seen = new Map();
    this.end = null;
  }

  /** @private */
  records() {
    return [...this.downloads].map((d) => recordOf(d));
  }

  /** @private Progress fires on every chunk; the bar hears only of a change it shows. */
  changed() {
    if (this.view && this.since !== Infinity) this.ended();
    this.current = this.compute();
    const text = JSON.stringify(this.current);
    if (text === this.text) return;
    this.text = text;
    this.emit();
  }

  /** @private Announce the downloads that ended, and keep the worst end for the segment. */
  ended() {
    const { texts, end, seen } = downloadEnds(this.seen, this.records(), { since: this.since });
    this.seen = seen;
    // One announcement for every end at once: a second write to the region would cut the first.
    if (texts.length) this.say(texts.join(". "));
    if (!end) return;
    // `failed` and `blocked` wait for the picker; a later `done` does not hide them.
    if (end === "done" && this.end && this.end.state !== "done") return;
    this.end = { state: end, at: Date.now() };
    if (end === "done") {
      if (this.doneTimer !== null) this.win.clearTimeout(this.doneTimer);
      this.doneTimer = this.win.setTimeout(() => {
        this.doneTimer = null;
        this.changed();
      }, DONE_MS);
    }
  }

  /** The picker opened in this window: `failed`, `blocked` and `done` have been seen. */
  clearEnd() {
    if (!this.end) return;
    this.end = null;
    this.changed();
  }

  /**
   * The segment as last computed: the bar asks on every host change, downloads change it rarely.
   * @returns {DownloadSegment | null}
   */
  segment() {
    return this.current;
  }

  /** @private */
  compute() {
    if (!this.view) return null;
    return downloadSegment(downloadSummary(this.records()), this.end, Date.now());
  }

  destroy() {
    this.destroyed = true;
    if (this.doneTimer !== null) this.win.clearTimeout(this.doneTimer);
    this.detach();
  }
}

/**
 * The picker's rows while it is open (decision 12): a view on the window's list, attached on
 * open and removed on close. A state change or a new download re-renders at once; progress at
 * most once a second, so a fast download does not rebuild the list on every chunk.
 */
export class DownloadRows {
  /**
   * @param {BrowserWindow} win
   * @param {(rows: DownloadItem[]) => void} changed  new rows while open
   */
  constructor(win, changed) {
    this.win = win;
    this.changed = changed;
    /** @type {Set<any>} */
    this.downloads = new Set();
    /** @type {any} */
    this.list = null;
    /** @type {object | null} */
    this.view = null;
    this.shape = "";
    this.at = 0;
    /** @type {number | null} */
    this.timer = null;
  }

  /**
   * Attach to the window's list and read it.
   * @returns {Promise<DownloadItem[]>}
   */
  async open() {
    if (!this.view) {
      const view = {
        /** @param {any} d */
        onDownloadAdded: (d) => (this.downloads.add(d), this.update()),
        onDownloadChanged: () => this.update(),
        /** @param {any} d */
        onDownloadRemoved: (d) => (this.downloads.delete(d), this.update()),
      };
      this.view = view;
      const list = await listFor(this.win);
      if (this.view !== view) return [];
      this.list = list;
      await list.addView(view);
      // A history entry assumes its file is there, and a finished file can be deleted outside
      // Firefox: `refresh` checks the disk, as Firefox's views do, and reports a change.
      for (const d of this.downloads) {
        if (d.stopped && typeof d.refresh === "function") d.refresh().catch(() => {});
      }
    }
    const { rows } = this.read();
    return rows;
  }

  /** Detach (the picker closed). */
  close() {
    if (this.list && this.view) this.list.removeView(this.view);
    this.list = null;
    this.view = null;
    this.downloads.clear();
    this.shape = "";
    if (this.timer !== null) this.win.clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * The download a row stands for, or null when it has gone.
   * @param {string} id
   */
  byId(id) {
    for (const d of this.downloads) if (String(idOf(d)) === id) return d;
    return null;
  }

  /** @private */
  read() {
    const records = [...this.downloads].map((d) => recordOf(d, this.win));
    const shape = JSON.stringify(
      records.map((r) => [r.id, downloadState(r), r.targetExists, r.partFileExists, r.deleted]),
    );
    return { rows: downloadSections(records, Date.now()), shape };
  }

  /** @private */
  update() {
    if (!this.list) return;
    const { rows, shape } = this.read();
    const now = Date.now();
    if (shape !== this.shape || now - this.at >= PROGRESS_MS) {
      this.shape = shape;
      this.at = now;
      if (this.timer !== null) this.win.clearTimeout(this.timer);
      this.timer = null;
      this.changed(rows);
    } else if (this.timer === null) {
      this.timer = this.win.setTimeout(
        () => {
          this.timer = null;
          this.update();
        },
        PROGRESS_MS - (now - this.at),
      );
    }
  }
}

/**
 * Show a download's file in its folder through `Download.showContainingDirectory`, which goes
 * through DownloadIntegration (decision 5). A history entry is not a `Download`: one is made for
 * its path, as `DownloadsCommon.openDownload` makes one to open it.
 * @param {any} d
 */
async function showInFolder(d) {
  const download =
    typeof d.showContainingDirectory === "function"
      ? d
      : await lazy.Downloads.createDownload({ source: d.source.url, target: d.target.path });
  await download.showContainingDirectory();
}

/**
 * The download as it is now, or null when it has left the window's list (removed in the
 * Library, by another window, or by clearing history).
 * @param {BrowserWindow} win
 * @param {any} d
 */
async function current(win, d) {
  const list = await listFor(win);
  if (!(await list.getAll()).includes(d)) return null;
  // The file may have gone outside Firefox while the question was open: `refresh` reads the
  // disk, as Firefox's views do, before the answer is weighed.
  if (d.stopped && typeof d.refresh === "function") await d.refresh().catch(() => {});
  return recordOf(d, win);
}

/**
 * Cancel and delete, after `y/N`, through Firefox's own commands (decision 6): the picker has
 * closed, so the answer goes to the question. The yes stands only for the download asked about:
 * if it changed before the answer, nothing is done and the notice says so
 * (docs/security/21-downloads-picker.md D5).
 * @param {BrowserWindow} win
 * @param {any} d
 * @param {DownloadRecord} asked  the download as it was when the question showed
 * @param {"cancel" | "delete"} op
 * @param {(text: string, error?: boolean) => void} say
 */
async function answered(win, d, asked, op, say) {
  if (downloadChanged(asked, await current(win, d), op)) {
    say(`${op}: "${asked.name}" changed since you were asked; nothing was done`, true);
    return;
  }
  if (op === "cancel") {
    // DownloadsViewUI's downloadsCmd_cancel: cancel, then remove the partial data, the order
    // Firefox uses to avoid a race with the cancellation.
    d.cancel().catch(() => {});
    await d.removePartialData().finally(() => d.target.refresh());
    say(`canceled "${asked.name}"`);
    return;
  }
  if (d.hasBlockedData) {
    // Blocked data is removed as Firefox's blocked view removes it (downloadsCmd_confirmBlock):
    // `deleteDownloadFiles` would leave it marked as blocked (decision 7,
    // docs/security/21-downloads-picker.md D3).
    await d.confirmBlock();
    say(`deleted "${asked.name}"`);
    return;
  }
  // DownloadsViewUI's downloadsCmd_deleteFile, with the user's browser.download.clearHistoryOnDelete.
  await lazy.DownloadsCommon.deleteDownloadFiles(
    d,
    Services.prefs.getIntPref("browser.download.clearHistoryOnDelete", 0),
  );
  say(`deleted "${asked.name}"`);
}

/**
 * Pause, resume, retry and remove, as Firefox's panel runs them (DownloadsViewUI.sys.mjs,
 * downloadsCmd_pauseResume, downloadsCmd_retry and cmd_delete).
 * @param {BrowserWindow} win
 * @param {any} d
 * @param {DownloadRecord} r
 * @param {DownloadOp} op
 * @param {(text: string, error?: boolean) => void} say
 */
function runState(win, d, r, op, say) {
  if (op === "pauseResume") {
    if (d.stopped) {
      // A failure while it runs is reported as the download's own failed state.
      d.start().catch(() => {});
      say(`resumed "${r.name}"`);
    } else {
      d.cancel().catch(console.error);
      say(`paused "${r.name}"`);
    }
  } else if (op === "retry") {
    if (typeof d.start === "function") {
      d.start().catch(() => {});
    } else {
      // A history entry is not a Download: Firefox's Library downloads its URL again.
      win.DownloadURL(r.url, r.path ? r.name : null, win.document);
    }
    say(`retrying "${r.name}"`);
  } else if (op === "remove") {
    lazy.DownloadsCommon.deleteDownload(d).catch(console.error);
    // Firefox's remove confirms the block of blocked data, which deletes it (decision 7, D3).
    say(
      r.hasBlockedData
        ? `removed "${r.name}" and its blocked data`
        : `removed "${r.name}" from the list; the file stays`,
    );
  }
}

/**
 * `u`: the page a download came from, in a new tab of the download's own container, or of the
 * window's non-agent one for a history entry, which keeps none. Never the agent workspace's, even
 * with it on screen: the full referrer may carry a token, and an agent can read that workspace's
 * pages (docs/security/21-downloads-picker.md D4). A private window opens it as any private tab.
 * @param {BrowserWindow} win
 * @param {any} d
 * @param {string} referrer  core allows an http: or https: page only
 */
function openReferrer(win, d, referrer) {
  if (refusedScheme(referrer)) return;
  if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
    openUrl(win, referrer, "tab");
    return;
  }
  const agent = WorkspaceStore.agent?.userContextId;
  const own = d.source?.userContextId;
  const userContextId =
    own && own !== agent ? own : (WorkspaceStore.nonAgentUserContextId(win) ?? 0);
  win.openTrustedLinkIn(referrer, "tab", {
    userContextId,
    inBackground: false,
  });
}

/** `browser.safebrowsing.allowOverride`: off, no blocked download is allowed (decision 7). */
const allowOverride = () => Services.prefs.getBoolPref("browser.safebrowsing.allowOverride", true);

/**
 * `!`: Firefox's own dialog decides, in Firefox's wording, and its answer runs as Firefox's
 * Library runs it (DownloadsViewUI.sys.mjs, confirmUnblock). Always `chooseUnblock`, whose default
 * button removes the file, never `chooseOpen`, whose default opens it: a habitual Enter cannot run
 * a blocked file, and opening is a separate `o` (decision 7, docs/security/21-downloads-picker.md
 * D3). The answer stands only for the download asked about, as in D5: the dialog is modal, but the
 * list, the file and the pref can change under it.
 * @param {BrowserWindow} win
 * @param {any} d
 * @param {DownloadRecord} asked
 * @param {(text: string, error?: boolean) => void} say
 */
async function unblock(win, d, asked, say) {
  const action = await lazy.DownloadsCommon.confirmUnblockDownload({
    verdict: d.error?.reputationCheckVerdict,
    // A content-analysis warning is worded by its verdict without the reputation flag.
    becauseBlockedByReputationCheck: !!d.error?.becauseBlockedByReputationCheck,
    window: win,
    dialogType: "chooseUnblock",
  });
  if (action !== "unblock" && action !== "confirmBlock") return;
  const op = action === "unblock" ? "unblock" : "delete";
  if (downloadChanged(asked, await current(win, d), op, { allowOverride: allowOverride() })) {
    say(`"${asked.name}" changed while Firefox asked; nothing was done`, true);
    return;
  }
  if (action === "unblock") {
    // A download whose question was answered "open with" would open as it is released
    // (Download._succeed). An allowed file is opened with `o`, through Firefox's executable
    // prompt, never by the allow itself (Behaviour 10).
    d.launchWhenSucceeded = false;
    await d.unblock();
    say(`allowed "${asked.name}"; o opens it`);
  } else {
    await d.confirmBlock();
    say(`removed the blocked file "${asked.name}"`);
  }
}

/** @param {string} text */
function copy(text) {
  Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(text);
}

/**
 * A key on a download row (the table under Behaviour), through core downloadKey and Firefox's
 * own download code.
 * @param {BrowserWindow} win
 * @param {DownloadRows} rows
 * @param {string} key
 * @param {string} id
 * @param {{ say: (text: string, error?: boolean) => void, close: () => void,
 *   ask: (question: string, yes: () => void) => boolean }} ui
 */
export function downloadPickerKey(win, rows, key, id, { say, close, ask }) {
  const d = rows.byId(id);
  if (!d) {
    say("that download is gone", true);
    return;
  }
  const r = recordOf(d, win);
  const result = downloadKey(r, key, { allowOverride: allowOverride() });
  if (result.type === "refuse") say(result.text, true);
  // Enter on a blocked download: Firefox's reason and the keys that apply, never an unblock.
  if (result.type === "notice") say(result.text);
  if (result.type !== "run") return;
  if (downloadAsks(result.op)) {
    const op = /** @type {"cancel" | "delete"} */ (result.op);
    // An open picker takes every key first: it closes, so the `y` reaches the question
    // (decision 6, docs/security/21-downloads-picker.md D5). Closing detaches the rows; `d` and `r`
    // are kept.
    close();
    const asked = ask(downloadQuestion(r, op), () =>
      answered(win, d, r, op, say).catch((/** @type {any} */ e) => {
        console.error(e);
        say(`${op}: ${e?.message ?? e}`, true);
      }),
    );
    // The question line does not show over a page in DOM fullscreen.
    if (!asked) say(`${op}: cannot ask over a fullscreen page; nothing was done`, true);
    return;
  }
  switch (result.op) {
    case "pauseResume":
    case "retry":
    case "remove":
      runState(win, d, r, result.op, say);
      return;
    case "open":
    case "openSystem":
      // The file shows over the picker's page, in a tab or the system's app.
      close();
      lazy.DownloadsCommon.openDownload(
        d,
        result.op === "openSystem" ? { useSystemDefault: true } : {},
      ).catch(console.error);
      return;
    case "show":
      showInFolder(d)
        .then(() =>
          // Only macOS confirms that something showed (decision 15).
          say(
            lazy.AppConstants.platform === "macosx"
              ? "shown in Finder"
              : "asked the file manager to show it",
          ),
        )
        .catch((/** @type {unknown} */ e) => {
          console.error(e);
          say("could not show the folder", true);
        });
      return;
    case "copyLink":
      lazy.DownloadsCommon.copyDownloadLink(d);
      say("copied the link");
      return;
    case "copyPath":
      copy(r.path);
      say("copied the path");
      return;
    case "referrer":
      close();
      openReferrer(win, d, /** @type {string} */ (r.referrer));
      return;
    case "library":
      close();
      runCommand(win, "Tools:Downloads");
      return;
    case "unblock":
      // An open picker takes every key first: it closes, so the dialog's keys reach the dialog
      // (decision 6). The dialog is a modal `confirmEx`, which spins a nested event loop: it runs
      // on its own turn, not inside the key's dispatch.
      close();
      win.setTimeout(() =>
        unblock(win, d, r, say).catch((/** @type {any} */ e) => {
          console.error(e);
          say(`allow: ${e?.message ?? e}`, true);
        }),
      );
      return;
  }
}
