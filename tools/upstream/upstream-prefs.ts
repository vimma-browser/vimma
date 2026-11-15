#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Prefs our branding file copies from upstream, checked against the imported engine (docs/
 * rebase.md, step 6; spec m7-upstream-autopilot). A stale copy silently shadows upstream's:
 * - the cfr provider (spec m0-mozilla-services): upstream's JSON with "enabled":false;
 * - the google4/google5 Safe Browsing lists (spec m0-safebrowsing-key): upstream's lists minus
 *   the two that only Mozilla's key may fetch.
 *
 *   node tools/upstream/upstream-prefs.mjs [--engine engine] [--ours FILE]
 *   node tools/upstream/upstream-prefs.mjs --firefox-js F --all-js F --write-diff PATCH
 *     [--json FILE] [--github-output FILE] [--ours FILE]
 *
 * Check mode exits 0 up to date, 1 stale or missing (each with the line to paste), 2 unreadable.
 * e2e.yml runs it after `npm run import`, so PR CI fails on a stale copy.
 *
 * Refresh mode (--write-diff, spec upstream-bump-automation, sub-PR 1) reads upstream's two
 * prefs files as extracted from the verified tarball by source-check.sh, and writes a `git diff`
 * of firefox-branding.js with each stale line replaced (empty when nothing changes), the refresh
 * as JSON, and `prefs=current|refreshed|unresolved` to the GitHub output. A pref missing
 * upstream or in ours is unresolved and nothing is written for any pref: a rename needs a person.
 * An absent upstream file reads as empty. Exits 0 unless a file cannot be written (2).
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const CFR = "browser.newtabpage.activity-stream.asrouter.providers.cfr";
export const SB_LISTS = [
  "browser.safebrowsing.provider.google4.lists",
  "browser.safebrowsing.provider.google5.lists",
];
/** Lists only Mozilla's own Safe Browsing key may fetch; one refused list fails every update. */
export const MOZILLA_KEY_LISTS = ["goog-badbinurl-proto", "goog-downloadwhite-proto"];
const OURS = "src/browser/branding/vimma/pref/firefox-branding.js";

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The string value of `pref("name", "…")` in a prefs file, or null when there is none.
 * @param {string} text
 * @param {string} name
 */
export function readPref(text, name) {
  const m = new RegExp(`^\\s*pref\\("${escapeRe(name)}",\\s*("(?:[^"\\\\]|\\\\.)*")\\);`, "m").exec(
    text,
  );
  return m?.[1] ? JSON.parse(m[1]) : null;
}

/**
 * @param {string} name
 * @param {string} value
 * @returns {string} a prefs-file line setting it
 */
export function prefLine(name, value) {
  return `pref("${name}", ${JSON.stringify(value)});`;
}

/**
 * @typedef {{ pref: string, ours: string | null, want: string | null,
 *   missing?: "upstream" | "ours" }} Problem
 */

/**
 * @param {{ firefoxJs: string, allJs: string, ours: string }} files
 * @returns {Problem[]} empty when every copy is current
 */
export function checkPrefs({ firefoxJs, allJs, ours }) {
  /** @type {Problem[]} */
  const problems = [];
  /**
   * @param {string} pref
   * @param {string | null} upstream
   * @param {(v: string) => string} derive
   * @param {(a: string, b: string) => boolean} same
   */
  const check = (pref, upstream, derive, same) => {
    const mine = readPref(ours, pref);
    if (upstream === null) {
      problems.push({ pref, ours: mine, want: null, missing: "upstream" });
      return;
    }
    const want = derive(upstream);
    if (mine === null) problems.push({ pref, ours: null, want, missing: "ours" });
    else if (!same(mine, want)) problems.push({ pref, ours: mine, want });
  };
  check(
    CFR,
    readPref(firefoxJs, CFR),
    (v) => JSON.stringify({ ...JSON.parse(v), enabled: false }),
    (a, b) => JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b)),
  );
  for (const pref of SB_LISTS) {
    check(
      pref,
      readPref(allJs, pref),
      (v) =>
        v
          .split(",")
          .filter((l) => !MOZILLA_KEY_LISTS.includes(l))
          .join(","),
      (a, b) => a === b,
    );
  }
  return problems;
}

/**
 * @typedef {{ state: "current" | "refreshed" | "unresolved", text: string,
 *   refreshed: { pref: string, old: string, new: string }[], unresolved: string[] }} Refresh
 */

/**
 * Our branding file with every stale copy replaced by the value derived from upstream's.
 * @param {{ firefoxJs: string, allJs: string, ours: string }} files
 * @returns {Refresh}
 */
export function refreshPrefs(files) {
  const problems = checkPrefs(files);
  const unresolved = problems.filter((p) => p.missing).map((p) => p.pref);
  if (unresolved.length)
    return { state: "unresolved", text: files.ours, refreshed: [], unresolved };
  let text = files.ours;
  /** @type {Refresh["refreshed"]} */
  const refreshed = [];
  for (const p of problems) {
    const want = p.want ?? "";
    const re = new RegExp(`^\\s*pref\\("${escapeRe(p.pref)}",.*$`, "m");
    text = text.replace(re, () => prefLine(p.pref, want));
    refreshed.push({ pref: p.pref, old: p.ours ?? "", new: want });
  }
  return { state: refreshed.length ? "refreshed" : "current", text, refreshed, unresolved: [] };
}

/**
 * A `git diff` of two versions of a file that differ only in replaced lines (what refreshPrefs
 * makes), with three lines of context like `surfer export`; "" when they are equal.
 * @param {string} path repository-relative
 * @param {string} before
 * @param {string} after
 */
export function unifiedDiff(path, before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length !== b.length) throw new Error("unifiedDiff: only line replacements are supported");
  const changed = a.flatMap((l, i) => (l === b[i] ? [] : [i]));
  if (!changed.length) return "";
  // A trailing newline leaves an empty last element, which is not a line.
  const n = before.endsWith("\n") ? a.length - 1 : a.length;
  /** @type {[number, number][]} */
  const hunks = [];
  for (const i of changed) {
    const lo = Math.max(0, i - 3);
    const hi = Math.min(n - 1, i + 3);
    const last = hunks.at(-1);
    if (last && lo <= last[1] + 1) last[1] = hi;
    else hunks.push([lo, hi]);
  }
  const out = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  for (const [lo, hi] of hunks) {
    const len = hi - lo + 1;
    out.push(`@@ -${lo + 1},${len} +${lo + 1},${len} @@`);
    for (let i = lo; i <= hi; i++) {
      if (a[i] === b[i]) out.push(` ${a[i]}`);
      else out.push(`-${a[i]}`, `+${b[i]}`);
    }
  }
  return out.join("\n") + "\n";
}

/** @param {string | undefined} path */
const readOrEmpty = (path) => (path && existsSync(path) ? readFileSync(path, "utf8") : "");

/**
 * Refresh mode: see the header.
 * @param {Record<string, string | undefined>} values
 * @param {string} oursPath
 */
function refreshMain(values, oursPath) {
  const r = refreshPrefs({
    firefoxJs: readOrEmpty(values["firefox-js"]),
    allJs: readOrEmpty(values["all-js"]),
    ours: readFileSync(oursPath, "utf8"),
  });
  const before = readFileSync(oursPath, "utf8");
  writeFileSync(values["write-diff"] ?? "", unifiedDiff(OURS, before, r.text));
  const report = { state: r.state, refreshed: r.refreshed, unresolved: r.unresolved };
  if (values.json) writeFileSync(values.json, JSON.stringify(report, null, 2) + "\n");
  if (values["github-output"]) appendFileSync(values["github-output"], `prefs=${r.state}\n`);
  for (const pref of r.unresolved) {
    console.log(
      `upstream-prefs: ${pref} is gone upstream (renamed or removed) or missing in ${OURS}: ` +
        "nothing refreshed; a person decides (docs/rebase.md, step 6)",
    );
  }
  for (const p of r.refreshed) console.log(`upstream-prefs: refreshed ${p.pref}`);
  if (r.state === "current") console.log("upstream-prefs: copied prefs are current");
  return 0;
}

function main() {
  const { values } = parseArgs({
    options: {
      engine: { type: "string", default: "engine" },
      ours: { type: "string" },
      "firefox-js": { type: "string" },
      "all-js": { type: "string" },
      "write-diff": { type: "string" },
      json: { type: "string" },
      "github-output": { type: "string" },
    },
  });
  const engine = values.engine ?? "engine";
  const root = fileURLToPath(new URL("../../", import.meta.url));
  if (values["write-diff"]) return refreshMain(values, values.ours ?? join(root, OURS));
  const problems = checkPrefs({
    firefoxJs: readFileSync(join(engine, "browser/app/profile/firefox.js"), "utf8"),
    allJs: readFileSync(join(engine, "modules/libpref/init/all.js"), "utf8"),
    ours: readFileSync(values.ours ?? join(root, OURS), "utf8"),
  });
  if (problems.length === 0) {
    console.log("upstream-prefs: cfr provider and Safe Browsing lists up to date");
    return 0;
  }
  for (const p of problems) {
    if (p.missing === "upstream") {
      console.log(
        `upstream-prefs: ${p.pref} is gone upstream (renamed or removed): read the engine's ` +
          "prefs and the spec before changing ours (docs/rebase.md, step 6)",
      );
    } else {
      console.log(`upstream-prefs: ${p.pref} is ${p.missing ? "missing" : "stale"} in ${OURS}.`);
      console.log(`  Replace its line with (keep the // prettier-ignore above it):`);
      console.log(`  ${prefLine(p.pref, p.want ?? "")}`);
    }
  }
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`upstream-prefs: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 2;
  }
}
