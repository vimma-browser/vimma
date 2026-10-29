/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * about:vimma's pure parts (spec docs/specs/m5-about-vimma.md): what a key event did, and the
 * redaction `:bug` applies before the report reaches the clipboard.
 */

import { trimTrailing } from "./strings.mjs";

/** @import { DispatchResult } from "./dispatcher.mjs" */

/** Any `scheme://…` up to whitespace: web pages, file:///, extensions. */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S*?(?=[\s,;)\]]|[.,;:!?]?(?:\s|$))/gi;

/** A character `\w` matches. @param {string | undefined} c */
const isWordChar = (c) => c !== undefined && /\w/.test(c);

/**
 * Whether `home`, found at `at` in `text`, ends a whole path component there: what follows is
 * the end, a `/`, or a character that cannot continue a file name (`/home/alice` is not the home
 * in `/home/alicebob` or `/home/alice.bak`).
 * @param {string} text
 * @param {number} at
 * @param {string} home
 */
function homeEndsAt(text, at, home) {
  const next = text[at + home.length];
  if (next === undefined || next === "/") return true;
  if (isWordChar(next) || next === "." || next === "-") return false;
  return isWordChar(home.at(-1)); // the word boundary a `\b` would want
}

/**
 * The report as `:bug` copies it: every URL becomes `<url>` and every path under `home` starts
 * with `~`. Titles never enter the report, so there is nothing else to strip.
 * @param {string} text
 * @param {string} home  $HOME; "" leaves paths alone
 * @returns {string}
 */
export function redactReport(text, home) {
  const out = text.replace(URL_RE, "<url>");
  // Linear scans rather than a regular expression built from $HOME (CodeQL js/polynomial-redos).
  const h = trimTrailing(home, "/");
  if (!h) return out;
  let redacted = "";
  let from = 0;
  for (let at = out.indexOf(h); at !== -1; at = out.indexOf(h, at + 1)) {
    if (at < from || !homeEndsAt(out, at, h)) continue;
    redacted += `${out.slice(from, at)}~`;
    from = at + h.length;
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
    .filter(([n], i) => i === 0 || n > 0)
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
