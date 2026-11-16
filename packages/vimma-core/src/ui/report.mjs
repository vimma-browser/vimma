/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * about:vimma's pure parts (spec docs/specs/m5-about-vimma.md): what a key event did, and the
 * redaction `:bug` applies before the report reaches the clipboard.
 */

import { trimTrailing } from "../text/strings.mjs";

/** @import { DispatchResult } from "../keys/dispatcher.mjs" */

/** Any `scheme://…` up to whitespace: web pages, file:///, extensions. */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S*?(?=[\s,;)\]]|[.,;:!?]?(?:\s|$))/gi;

/**
 * What ends a file name in the report (#1173): whitespace, a path separator, or punctuation that
 * the report or an error message puts around a path: `path:4:`, `(path)`, `"path"`, `'path'`,
 * `` `path` ``, `[path]`, `{path}`, `<path>`, `path,` and `path;`. Anything else continues the
 * name, `+`, `~`, `@`, emoji, joiners and connector punctuation included, so `/home/alice` is not
 * the home in `/home/alice+b`. `.`, `!` and `?` continue a name (`/home/alice.bak`) except when
 * they close a sentence, with whitespace or the end after them.
 */
const ENDS_NAME = /[\s/\\:;,"'`()[\]{}<>]|[.!?](?=\s|$)/y;

/**
 * Whether the text at `at` ends a name: the end, or a character of {@link ENDS_NAME}.
 * @param {string} text
 * @param {number} at
 */
function endsName(text, at) {
  if (at === text.length) return true;
  ENDS_NAME.lastIndex = at;
  return ENDS_NAME.test(text);
}

/**
 * The last index in `sorted` (ascending) whose value is at most `n` (0 if none is).
 * @param {number[]} sorted
 * @param {number} n
 */
function lastAtMost(sorted, n) {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((sorted[mid] ?? 0) <= n) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Where a run's clusters (a non-mark and the marks after it) start in the run and in its NFD:
 * the only offsets inside a run that NFD changes that map back. If the clusters ever
 * decomposed apart differently from the run as a whole, only the run's edges map.
 * @param {string} run
 * @returns {{ text: number[], nfd: number[] }}
 */
function clusterOffsets(run) {
  const text = [0];
  const nfd = [0];
  let t = 0;
  let d = 0;
  for (const [cluster] of run.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    t += cluster.length;
    d += cluster.normalize("NFD").length;
    text.push(t);
    nfd.push(d);
  }
  return d === run.normalize("NFD").length ? { text, nfd } : { text: [0], nfd: [0] };
}

/**
 * @typedef {object} Piece  a stretch of the text, from where it starts in the text and in NFD
 * @property {number} text
 * @property {number} nfd
 * @property {string} [run]  a run NFD changes; the other stretches map one to one
 * @property {{ text: number[], nfd: number[] }} [clusters]  the run's, once a match needs them
 */

/**
 * `text` in NFD with a way back to `text`'s offsets, so a home and a path written in different
 * normal forms still match (an NFD $HOME is common on macOS) while the output keeps the text's
 * own characters. ASCII is its own NFD and never reorders with its neighbours, so the text is
 * decomposed one run of other characters at a time, and a run's clusters are worked out only
 * when a match ends inside it: a large report costs about two copies of it.
 * @param {string} text
 * @returns {{ nfd: string, toText: (at: number) => number | undefined }}
 */
function decomposed(text) {
  /** @type {Piece[]} */
  const pieces = [{ text: 0, nfd: 0 }];
  /** @type {number[]} */
  const starts = [0];
  let nfd = "";
  let last = 0;
  for (const match of text.matchAll(/[^\0-\x7f]+/g)) {
    const run = match[0];
    nfd += text.slice(last, match.index);
    const d = run.normalize("NFD");
    if (d !== run) {
      pieces.push({ text: match.index, nfd: nfd.length, run });
      pieces.push({ text: match.index + run.length, nfd: nfd.length + d.length });
      starts.push(nfd.length, nfd.length + d.length);
    }
    nfd += d;
    last = match.index + run.length;
  }
  nfd += text.slice(last);
  /** @param {number} n */
  const toText = (n) => {
    const piece = pieces[lastAtMost(starts, n)] ?? { text: 0, nfd: 0 };
    const offset = n - piece.nfd;
    if (offset === 0 || piece.run === undefined) return piece.text + offset;
    piece.clusters ??= clusterOffsets(piece.run);
    const k = lastAtMost(piece.clusters.nfd, offset);
    return piece.clusters.nfd[k] === offset
      ? piece.text + (piece.clusters.text[k] ?? 0)
      : undefined;
  };
  return { nfd, toText };
}

/**
 * The report as `:bug` copies it: every URL becomes `<url>` and every path under `home` starts
 * with `~`. The home matches whatever the normal form on either side, and only as a whole name:
 * {@link ENDS_NAME} must follow it. Titles never enter the report, so there is nothing else to
 * strip. Limits: docs/security/22-bug-report.md.
 * @param {string} text
 * @param {string} home  $HOME; "" leaves paths alone
 * @returns {string}
 */
export function redactReport(text, home) {
  const out = text.replace(URL_RE, "<url>");
  // Linear scans rather than a regular expression built from $HOME (CodeQL js/polynomial-redos).
  const h = trimTrailing(home, "/").normalize("NFD");
  if (!h) return out;
  const { nfd, toText } = decomposed(out);
  let redacted = "";
  let from = 0;
  for (let at = nfd.indexOf(h); at !== -1; at = nfd.indexOf(h, at + 1)) {
    const start = toText(at);
    const end = toText(at + h.length);
    // What ends the name is judged on the text as written: U+037E is `;` only in NFD.
    if (start === undefined || end === undefined || start < from || !endsName(out, end)) continue;
    redacted += `${out.slice(from, start)}~`;
    from = end;
  }
  return redacted + out.slice(from);
}

/**
 * What the dispatcher made of a key, for about:vimma's key log: the action id, or pass, cancel,
 * or `…` while a sequence is pending.
 * @param {Pick<DispatchResult, "kind"> & { action?: { id: string } }} result
 * @returns {string}
 */
export function describeOutcome(result) {
  if (result.kind === "action" && result.action) return result.action.id;
  if (result.kind === "pending") return "…";
  return result.kind;
}

/**
 * A duration in its two largest units: `4s`, `1m 30s`, `3h 12m`, `1d 2h` (seconds rounded down).
 * @param {number} ms
 * @returns {string}
 */
export function formatAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  /** @type {[number, string][]} */
  const units = [
    [Math.floor(s / 86400), "d"],
    [Math.floor(s / 3600) % 24, "h"],
    [Math.floor(s / 60) % 60, "m"],
    [s % 60, "s"],
  ];
  const first = units.findIndex(([n]) => n > 0);
  if (first === -1) return "0s";
  return units
    .slice(first, first + 2)
    .filter(([n]) => n > 0)
    .map(([n, u]) => `${n}${u}`)
    .join(" ");
}

/** The longest error the report keeps, in characters. */
const ERROR_MAX = 200;

/**
 * @typedef {object} WorkspaceReportData
 * @property {number} count  workspace definitions
 * @property {{ name: string, tabs: number, panes: number }[]} window  this window's workspaces
 * @property {number | null} live  this window's open unpinned tabs; null without workspaces
 * @property {number | null} pendingMs  how long a restore into the window has been under way
 * @property {{ reason: string, afterMs: number, agoMs: number } | null} recovered  the last
 *   restore that never finished and the rebuild that ended the wait: why, how long after the
 *   restore began, and how long ago
 * @property {string | null} lastError  the last failed rebuild's error
 */

/**
 * The report's workspace lines: the definitions, this window's workspaces with their tab and
 * pane counts, the open tabs beside the tabs the model holds (tab search and the side panel list
 * the model's, the status bar and `gt` the open ones: issue #546), then a restore still pending,
 * the last one that never finished, and the last rebuild error.
 * @param {WorkspaceReportData} data
 * @returns {string[]}
 */
export function workspaceReport({ count, window, live, pendingMs, recovered, lastError }) {
  const names = window.map((w) => `${w.name} ${w.tabs}t/${w.panes}p`).join(", ") || "none";
  let first = `Workspaces: ${count}; this window: ${names}`;
  if (window.length && live !== null) {
    const held = window.reduce((n, w) => n + w.tabs, 0);
    first += `; open tabs ${live}, in workspaces ${held}${held === live ? "" : " (out of step)"}`;
  }
  const lines = [first];
  if (pendingMs !== null) {
    lines.push(
      `  restore pending: ${formatAge(pendingMs)} (SessionStore has not said it finished)`,
    );
  }
  if (recovered) {
    lines.push(
      `  recovered: a restore that never finished (${recovered.reason}), rebuilt after ` +
        `${formatAge(recovered.afterMs)}, ${formatAge(recovered.agoMs)} ago`,
    );
  }
  if (lastError) {
    const flat = lastError.replace(/\s+/g, " ").trim();
    lines.push(`  error: ${flat.length > ERROR_MAX ? `${flat.slice(0, ERROR_MAX - 1)}…` : flat}`);
  }
  return lines;
}
