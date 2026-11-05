/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The downloads picker and the status bar's `↓` segment (docs/specs/downloads.md): a download's
 * state, its row, the keys that apply to it, and the segment. The host reads each Firefox
 * `Download` into a DownloadRecord and runs an op through Firefox's own download code; nothing
 * here knows Firefox.
 */
import { AGENT_GLYPH } from "./agent.mjs";

/**
 * Firefox's legacy states, as `DownloadsCommon.stateOfDownload` returns them
 * (browser/components/downloads/DownloadsCommon.sys.mjs).
 */
export const DOWNLOAD_STATE = Object.freeze({
  NOT_STARTED: -1,
  DOWNLOADING: 0,
  FINISHED: 1,
  FAILED: 2,
  CANCELED: 3,
  PAUSED: 4,
  BLOCKED_PARENTAL: 6,
  DIRTY: 8,
  BLOCKED_POLICY: 9,
  BLOCKED_CONTENT_ANALYSIS: 10,
});

/** The picker's row cap (decision 3); `shift+l` opens the Library for the rest. */
export const DOWNLOAD_ROW_CAP = 100;

/** How long `↓ done` stays on the status bar (decision 9). */
export const DONE_MS = 10_000;

/**
 * What the host reads from one Firefox `Download`.
 * @typedef {object} DownloadRecord
 * @property {number} id          the host's per-session id for the Download object
 * @property {string} name        the target file's leaf name
 * @property {string} url         the source URL (never shown, decision 13; `y` copies it)
 * @property {string} path        the target file's path
 * @property {string | null} referrer  the referring page, if any
 * @property {boolean} stopped
 * @property {boolean} succeeded
 * @property {boolean} canceled
 * @property {boolean} deleted    the file was deleted from Firefox's UI
 * @property {boolean} hasProgress  the total size is known
 * @property {boolean} hasPartialData
 * @property {boolean} hasBlockedData
 * @property {number} currentBytes
 * @property {number} totalBytes
 * @property {number} size        the finished file's size (`target.size`; a history entry has no
 *   byte counts)
 * @property {number} speed       bytes a second
 * @property {boolean} targetExists
 * @property {boolean} partFileExists
 * @property {DownloadError | null} error
 * @property {number} startTime   ms since the epoch
 * @property {number | null} endTime
 * @property {boolean} viewsInternally  a type Firefox shows itself (a PDF): `shift+o` applies
 * @property {string | null} workspace  another workspace's name, for a session download
 * @property {boolean} agent      a download of the agent workspace (ctl/AgentDownloads.sys.mjs)
 */
/**
 * `kind`: what stopped it. `parental`, `reputation` and `contentAnalysis` are Firefox's
 * `becauseBlockedBy…` flags; `failed` is any other error.
 * @typedef {object} DownloadError
 * @property {"failed" | "parental" | "reputation" | "contentAnalysis"} kind
 * @property {string} verdict  `Malware`, `PotentiallyUnwanted`, `Insecure`, `Uncommon`,
 *   `DownloadSpam`, or ""
 * @property {string} reason   Firefox's own wording of the verdict
 */
/**
 * A picker row. `section`: `active` (downloading, paused, blocked with data kept) or `recent`.
 * @typedef {object} DownloadItem
 * @property {"download"} kind
 * @property {string} downloadId
 * @property {string} display   the file's name
 * @property {string} state     the state as a word: `42%`, `paused`, `done`, `failed`, …
 * @property {string} detail    size or progress
 * @property {string} host      the host it came from, never the URL
 * @property {string} ended     when it finished: `14:07` today, `3 Nov` before
 * @property {string | null} workspace  another workspace's name, or `◇ agent`
 * @property {boolean} agent
 * @property {"active" | "recent"} section
 * @property {boolean} active   never: no download is the picker's current one
 */
/**
 * What a picker key does to a download: `run` an op, say a `notice` (Enter on a blocked one),
 * `refuse` with the reason, or `none` (not a downloads key, or nothing to do).
 * @typedef {{ type: "run", op: DownloadOp } | { type: "notice", text: string }
 *   | { type: "refuse", text: string } | { type: "none" }} DownloadKeyResult
 */
/**
 * @typedef {"open" | "openSystem" | "show" | "copyLink" | "copyPath" | "pauseResume" | "cancel"
 *   | "retry" | "referrer" | "remove" | "delete" | "unblock" | "library"} DownloadOp
 */

const S = DOWNLOAD_STATE;

/**
 * `DownloadsCommon.stateOfDownload`, on a record.
 * @param {DownloadRecord} r
 */
export function downloadState(r) {
  if (!r.stopped) return S.DOWNLOADING;
  if (r.succeeded) return S.FINISHED;
  if (r.error) {
    if (r.error.kind === "parental") return S.BLOCKED_PARENTAL;
    if (r.error.kind === "reputation") return S.DIRTY;
    if (r.error.kind === "contentAnalysis") {
      return r.error.verdict === "Malware" ? S.BLOCKED_CONTENT_ANALYSIS : S.DIRTY;
    }
    return S.FAILED;
  }
  if (r.canceled) return r.hasPartialData ? S.PAUSED : S.CANCELED;
  return S.NOT_STARTED;
}

/** @param {number} state */
const isBlocked = (state) =>
  state === S.DIRTY ||
  state === S.BLOCKED_CONTENT_ANALYSIS ||
  state === S.BLOCKED_PARENTAL ||
  state === S.BLOCKED_POLICY;

/** @param {DownloadRecord} r */
const percent = (r) =>
  r.hasProgress && r.totalBytes > 0 ? Math.floor((r.currentBytes / r.totalBytes) * 100) : null;

/**
 * The state as the row's word.
 * @param {DownloadRecord} r
 */
function stateWord(r) {
  const state = downloadState(r);
  if (state === S.DOWNLOADING) {
    const p = percent(r);
    return p === null ? "downloading" : `${p}%`;
  }
  if (state === S.FINISHED) return r.targetExists ? "done" : "missing";
  if (state === S.PAUSED) return "paused";
  if (state === S.FAILED) return "failed";
  if (state === S.CANCELED) return "canceled";
  if (isBlocked(state)) return "blocked";
  return "starting";
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/**
 * The unit a size is shown in, chosen after rounding to one decimal, so that a size just under
 * a unit boundary reads `1.0 MB`, never `1024.0 KB`.
 * @param {number} bytes
 */
function unitOf(bytes) {
  let i = 0;
  while (i < UNITS.length - 1 && Number((bytes / 1024 ** i).toFixed(1)) >= 1024) i++;
  return i;
}

/**
 * Bytes in a given unit, one decimal past bytes (Firefox's DownloadUtils counts in 1024s).
 * @param {number} bytes
 * @param {number} unit
 */
function inUnit(bytes, unit) {
  return unit === 0 ? String(Math.round(bytes)) : (bytes / 1024 ** unit).toFixed(1);
}

/** @param {number} bytes */
const size = (bytes) => `${inUnit(bytes, unitOf(bytes))} ${UNITS[unitOf(bytes)]}`;

/** @param {number} seconds */
function clock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * Size or progress: `3.1 / 7.4 MB · 1.2 MB/s · 0:35 left` while it runs, `3.1 MB · 1.2 MB/s`
 * with no known size, `3.1 / 7.4 MB` paused, the size when done.
 * @param {DownloadRecord} r
 */
export function downloadProgress(r) {
  const state = downloadState(r);
  if (state === S.FINISHED) return r.size > 0 ? size(r.size) : "";
  if (state !== S.DOWNLOADING && state !== S.PAUSED) return "";
  const running = state === S.DOWNLOADING && r.speed > 0;
  const parts = [];
  if (r.hasProgress && r.totalBytes > 0) {
    const unit = unitOf(r.totalBytes);
    parts.push(`${inUnit(r.currentBytes, unit)} / ${inUnit(r.totalBytes, unit)} ${UNITS[unit]}`);
  } else {
    parts.push(size(r.currentBytes));
  }
  if (running) {
    parts.push(`${size(r.speed)}/s`);
    if (r.hasProgress && r.totalBytes > 0) {
      parts.push(`${clock((r.totalBytes - r.currentBytes) / r.speed)} left`);
    }
  }
  return parts.join(" · ");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * When it finished, in local time: the time today, the day before.
 * @param {number | null} at
 * @param {number} now
 */
function endedText(at, now) {
  if (at === null) return "";
  const d = new Date(at);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/**
 * The host of a URL, or "" for one with none (`data:`, `blob:` of an opaque origin). A row
 * shows the host only, so that a token in the link is never on screen (decision 13).
 * @param {string} url
 */
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * A name for a download with no file path (an old history entry): its URL's last path segment,
 * else its host, never the whole URL, so a token in the link stays off screen (decision 13).
 * @param {string} url
 */
export function nameFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "ftp:") {
      return "download";
    }
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (last) {
      try {
        return decodeURIComponent(last);
      } catch {
        return last;
      }
    }
    return u.hostname || "download";
  } catch {
    return "download";
  }
}

/**
 * Whether a download is listed under `active`: downloading, paused, or blocked with its data
 * kept (decision 3).
 * @param {DownloadRecord} r
 */
function isActive(r) {
  const state = downloadState(r);
  return (
    state === S.DOWNLOADING ||
    state === S.NOT_STARTED ||
    state === S.PAUSED ||
    (isBlocked(state) && r.hasBlockedData)
  );
}

/**
 * The picker's row for a download.
 * @param {DownloadRecord} r
 * @param {number} now  ms since the epoch, for the end time's day
 * @returns {DownloadItem}
 */
export function downloadRow(r, now) {
  return {
    kind: "download",
    downloadId: String(r.id),
    display: r.name,
    state: stateWord(r),
    detail: downloadProgress(r),
    host: hostOf(r.url),
    ended: endedText(r.endTime, now),
    workspace: r.agent ? `${AGENT_GLYPH} agent` : r.workspace,
    agent: r.agent,
    section: isActive(r) ? "active" : "recent",
    active: false,
  };
}

/**
 * The picker's rows: `active` then `recent`, each newest first, at most DOWNLOAD_ROW_CAP.
 * @param {readonly DownloadRecord[]} records
 * @param {number} now
 * @returns {DownloadItem[]}
 */
export function downloadSections(records, now) {
  const rows = [...records]
    .sort((a, b) => b.startTime - a.startTime)
    .map((r) => downloadRow(r, now));
  // The cap cuts old finished rows first: a paused or blocked one still waits for the user.
  return [
    ...rows.filter((row) => row.section === "active"),
    ...rows.filter((row) => row.section === "recent"),
  ].slice(0, DOWNLOAD_ROW_CAP);
}

/**
 * What `/` matches a row by: name, host, state word and workspace (Behaviour 6).
 * @param {DownloadItem} row
 */
export function downloadSearchText(row) {
  return [row.display, row.host, row.state, row.workspace ?? ""].filter(Boolean).join(" ");
}

/** @type {Readonly<Record<string, DownloadOp>>} */
const KEY_OPS = Object.freeze({
  o: "open",
  "shift+o": "openSystem",
  s: "show",
  y: "copyLink",
  "shift+y": "copyPath",
  p: "pauseResume",
  c: "cancel",
  r: "retry",
  u: "referrer",
  d: "remove",
  "shift+d": "delete",
  "!": "unblock",
  "shift+l": "library",
});

/**
 * The keys the picker hands to the host on a download row, besides Enter: the ones whose op the
 * host runs (Delivery 3 and 4). Unblock (`!`) joins with its op (Delivery 5).
 */
export const DOWNLOAD_PICKER_KEYS = Object.freeze([
  "o",
  "shift+o",
  "s",
  "y",
  "shift+y",
  "u",
  "shift+l",
  "p",
  "c",
  "r",
  "d",
  "shift+d",
]);

/** The ops that ask `y/N` first, with the picker closed (decision 6). */
const ASKS = new Set(["cancel", "delete"]);

/**
 * Whether an op asks `y/N` before it runs.
 * @param {DownloadOp} op
 */
export function downloadAsks(op) {
  return ASKS.has(op);
}

/**
 * The `y/N` question for an op that asks (decision 6). The name is text the page chose; the
 * prompt sets it as text (docs/security.md D1).
 * @param {DownloadRecord} r
 * @param {"cancel" | "delete"} op
 */
export function downloadQuestion(r, op) {
  // Format characters (bidi overrides, zero-width) could reorder the line, and a long name could
  // push `(y/N)` out of view: both are the page's choice.
  const clean = r.name.replace(/\p{Cf}/gu, "");
  const name = [...clean].length > 80 ? [...clean].slice(0, 79).join("") + "…" : clean;
  return op === "cancel"
    ? `cancel "${name}" and remove its partial file? (y/N)`
    : `delete "${name}" from disk? (y/N)`;
}

/**
 * Whether the download is no longer the one the user answered yes for (decision 6,
 * docs/security.md D5): gone from the list, in another state, its file at another path or gone,
 * or the op no longer applies. Bytes moving on while the question is open do not count.
 * @param {DownloadRecord} asked  the download as it was when the question showed
 * @param {DownloadRecord | null} now  as it is at the answer, or null when it has gone
 * @param {DownloadOp} op
 */
export function downloadChanged(asked, now, op) {
  if (!now || now.id !== asked.id) return true;
  if (downloadState(now) !== downloadState(asked)) return true;
  if (now.path !== asked.path || now.targetExists !== asked.targetExists) return true;
  if (now.deleted !== asked.deleted || now.hasBlockedData !== asked.hasBlockedData) return true;
  return refusal(now, op, { allowOverride: false }) !== null;
}

const AGENT_NEVER_OPENED = "agent downloads are never opened by Vimma";

/**
 * Why an op does not apply to a download, or null when it does. The table follows Firefox's
 * `DownloadsViewUI.isCommandEnabled`, narrowed where the spec is stricter: `!` never for a
 * `Malware` verdict (decision 7), and the agent refusals (decision 8).
 * @param {DownloadRecord} r
 * @param {DownloadOp} op
 * @param {{ allowOverride: boolean }} ctx  `browser.safebrowsing.allowOverride`
 * @returns {string | null}
 */
function refusal(r, op, { allowOverride }) {
  const state = downloadState(r);
  const contentAnalysisMalware = state === S.BLOCKED_CONTENT_ANALYSIS;
  switch (op) {
    case "open":
    case "openSystem":
      if (r.agent) return AGENT_NEVER_OPENED;
      if (state !== S.FINISHED) return "not finished yet";
      if (!r.targetExists) return "the file is missing";
      if (op === "openSystem" && !r.viewsInternally) {
        return "only for a file Firefox shows itself; o opens it";
      }
      return null;
    case "show":
      return !r.deleted && (r.targetExists || r.partFileExists) ? null : "the file is missing";
    case "copyLink":
      return r.url ? null : "no link";
    case "copyPath":
      return r.targetExists ? null : "the file is missing";
    case "pauseResume":
      return r.hasPartialData && !r.error ? null : "cannot pause this download";
    case "cancel":
      return r.hasPartialData || !r.stopped ? null : "not in progress";
    case "retry":
      if (r.agent) return "agent downloads are never retried by Vimma";
      // A history entry with no path cannot be told apart from an agent download by its folder
      // (docs/security.md D4), so it is not fetched again from here.
      if (!r.path) return "no file to retry; the Library (shift+l) can";
      return state === S.FAILED || state === S.CANCELED ? null : "only a failed or canceled one";
    case "referrer":
      if (r.agent) return "an agent download's page is never opened by Vimma";
      // The referrer is the page's choice: only a web page opens, never a script, data or file.
      return r.referrer && /^https?:/i.test(r.referrer) ? null : "no page it came from";
    case "remove":
      if (contentAnalysisMalware) return "your organization's scanner keeps this download";
      return r.stopped ? null : "still downloading; c cancels it";
    case "delete":
      if (contentAnalysisMalware) return "your organization's scanner keeps this download";
      return !r.deleted && (r.targetExists || r.partFileExists || r.hasBlockedData)
        ? null
        : "the file is missing";
    case "unblock":
      if (r.agent) return "agent downloads are never allowed by Vimma";
      if (!r.hasBlockedData) return "nothing blocked to allow";
      if (r.error?.verdict === "Malware") return "a file named as malware can only be removed";
      if (!allowOverride) {
        return "allowing blocked downloads is off (browser.safebrowsing.allowOverride)";
      }
      return null;
    case "library":
      return null;
  }
}

/**
 * Enter on a blocked download: Firefox's reason and the keys that apply (decision 7).
 * @param {DownloadRecord} r
 * @param {{ allowOverride: boolean }} ctx
 */
function blockedNotice(r, ctx) {
  const keys = /** @type {[DownloadOp, string][]} */ ([
    ["unblock", "! allow or remove"],
    ["remove", "d remove"],
    ["delete", "shift+d delete"],
  ])
    .filter(([op]) => refusal(r, op, ctx) === null)
    .map(([, words]) => words);
  return ["blocked: " + (r.error?.reason || "blocked by Firefox"), ...keys].join(" · ");
}

/**
 * What a picker key does to a download (the table under Behaviour). Enter is the state's
 * default, as Firefox's `currentDefaultCommandName`: open when done, resume when paused, retry
 * when failed or canceled, the reason when blocked, nothing while it runs.
 * @param {DownloadRecord} r
 * @param {string} key  key notation (`o`, `shift+o`, `enter`)
 * @param {{ allowOverride: boolean }} ctx
 * @returns {DownloadKeyResult}
 */
export function downloadKey(r, key, ctx) {
  /** @type {DownloadOp | undefined} */
  let op = KEY_OPS[key];
  if (key === "enter") {
    const state = downloadState(r);
    if (isBlocked(state)) return { type: "notice", text: blockedNotice(r, ctx) };
    if (state === S.FINISHED) op = "open";
    else if (state === S.PAUSED) op = "pauseResume";
    else if (state === S.FAILED || state === S.CANCELED) op = "retry";
    else return { type: "none" };
  }
  if (!op) return { type: "none" };
  const why = refusal(r, op, ctx);
  if (why !== null) {
    // Enter's retry on an agent download is refused as its open is: Vimma never acts for it.
    return { type: "refuse", text: key === "enter" && r.agent ? AGENT_NEVER_OPENED : why };
  }
  return { type: "run", op };
}

/**
 * The window's downloads in progress or paused, as Firefox's `summarizeDownloads` counts them.
 * @typedef {{ count: number, paused: number, percent: number | null }} DownloadSummary
 */

/**
 * @param {readonly DownloadRecord[]} records
 * @returns {DownloadSummary}
 */
export function downloadSummary(records) {
  let count = 0;
  let paused = 0;
  let total = 0;
  let done = 0;
  for (const r of records) {
    const state = downloadState(r);
    if (state !== S.DOWNLOADING && state !== S.PAUSED) continue;
    count++;
    if (state === S.PAUSED) paused++;
    if (r.hasProgress && r.totalBytes > 0) {
      total += r.totalBytes;
      done += r.currentBytes;
    }
  }
  return { count, paused, percent: total > 0 ? Math.floor((done / total) * 100) : null };
}

/** @typedef {"done" | "failed" | "blocked"} DownloadEndState */
/**
 * The segment: its text, its accessible text (never only the arrow, m7-a11y) and whether it is a
 * problem (error colour, outlasts the title).
 * @typedef {{ text: string, label: string, problem: boolean }} DownloadSegment
 */

/**
 * The status bar's `↓` segment (Behaviour 12, decision 9): downloads in progress, else the last
 * end: `done` for DONE_MS, `failed` or `blocked` until the host clears it (the picker opened).
 * @param {DownloadSummary} summary
 * @param {{ state: DownloadEndState, at: number } | null} end
 * @param {number} now
 * @returns {DownloadSegment | null}
 */
export function downloadSegment(summary, end, now) {
  const { count, paused, percent: p } = summary;
  if (count > 0) {
    if (paused === count) {
      return {
        text: "↓ paused",
        label: count === 1 ? "download paused" : `${count} downloads paused`,
        problem: false,
      };
    }
    if (count === 1) {
      return p === null
        ? { text: "↓ 1", label: "1 download", problem: false }
        : { text: `↓ ${p}%`, label: `downloading ${p}%`, problem: false };
    }
    return p === null
      ? { text: `↓ ${count}`, label: `${count} downloads`, problem: false }
      : { text: `↓ ${count} · ${p}%`, label: `${count} downloads, ${p}%`, problem: false };
  }
  if (!end) return null;
  if (end.state === "done") {
    return now - end.at < DONE_MS
      ? { text: "↓ done", label: "download finished", problem: false }
      : null;
  }
  return { text: `↓ ${end.state}`, label: `download ${end.state}`, problem: true };
}

/** @param {number} state @returns {DownloadEndState | null} */
function endOf(state) {
  if (state === S.FINISHED) return "done";
  if (state === S.FAILED) return "failed";
  if (isBlocked(state)) return "blocked";
  return null;
}

const END_RANK = { done: 0, failed: 1, blocked: 2 };
const END_WORDS = { done: "finished", failed: "failed", blocked: "blocked" };

/**
 * The downloads that ended since the last call, each announced once (Behaviour 13), and the
 * worst of those ends for the segment. `seen` maps a download's id to its last state; `seed`
 * reads the list as the window first finds it, which announces nothing. A download first seen
 * already ended is announced only when it started at or after `since` (the seed's time),
 * because history entries and restored downloads reach the list late, after the seed. One with
 * no start time is new: Firefox adds an insecure download already blocked, before it starts
 * (DownloadLegacy.sys.mjs).
 * @param {ReadonlyMap<number, number>} seen
 * @param {readonly DownloadRecord[]} records
 * @param {{ seed?: boolean, since?: number }} [options]
 * @returns {{ texts: string[], end: DownloadEndState | null, seen: Map<number, number> }}
 */
export function downloadEnds(seen, records, { seed = false, since = -Infinity } = {}) {
  /** @type {Map<number, number>} */
  const next = new Map();
  /** @type {string[]} */
  const texts = [];
  /** @type {DownloadEndState | null} */
  let worst = null;
  for (const r of records) {
    const state = downloadState(r);
    next.set(r.id, state);
    if (seed) continue;
    const before = seen.get(r.id);
    const end = endOf(state);
    if (!end || (before !== undefined && endOf(before) !== null)) continue;
    if (before === S.CANCELED) continue;
    if (before === undefined && r.startTime > 0 && r.startTime < since) continue;
    texts.push(`download ${END_WORDS[end]}: ${r.name}`);
    if (worst === null || END_RANK[end] > END_RANK[worst]) worst = end;
  }
  return { texts, end: worst, seen: next };
}
