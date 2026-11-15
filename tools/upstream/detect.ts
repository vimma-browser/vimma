#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Upstream autopilot, step 1 (spec m7-upstream-autopilot): is there a Firefox release newer than
 * the one surfer.json pins, is it a security release, and how far behind is Vimma?
 *
 *   node tools/upstream/detect.mjs [--surfer-json surfer.json] [--feeds DIR] [--now ISO]
 *                                  [--json FILE] [--github-output FILE]
 *
 * Reads Mozilla's live feeds (releases.mjs), or with --feeds the files firefox_versions.json,
 * firefox.json and advisories.html in DIR. Prints a summary; --github-output appends the step
 * outputs upstream.yml uses. Node built-ins only, so the scheduled job needs no `npm ci`.
 * Exit status: 0 it ran (whatever it found; drift is an output, not an exit status), 2 a
 * product-details feed was unreadable. An unreadable advisories page is a warning: security
 * becomes "unknown", which the drift check treats as a security release.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  ADVISORIES_URL,
  RELEASES_URL,
  VERSIONS_URL,
  classify,
  compareVersions,
  drift,
  parseAdvisories,
  parseReleasesFeed,
  parseVersionsFeed,
  versionKey,
} from "./releases.mjs";

/**
 * @typedef {import("./releases.mjs").Classification} Classification
 * @typedef {import("./releases.mjs").Drift} Drift
 * @typedef {{ current: string, latest: string, newer: boolean, release: Classification,
 *   drift: Drift, advisoriesError: string | null, checkedAt: string }} Detection
 */

/**
 * @param {{ current: string, fetchText: (url: string) => Promise<string>, now: Date }} input
 * @returns {Promise<Detection>}
 */
export async function detect({ current, fetchText, now }) {
  versionKey(current);
  const [versionsText, releasesText] = await Promise.all([
    fetchText(VERSIONS_URL),
    fetchText(RELEASES_URL),
  ]);
  const { latest, lastReleaseDate } = parseVersionsFeed(versionsText);
  const releases = parseReleasesFeed(releasesText);
  /** @type {import("./releases.mjs").Advisory[] | null} */
  let advisories = null;
  let advisoriesError = null;
  try {
    advisories = parseAdvisories(await fetchText(ADVISORIES_URL));
  } catch (e) {
    advisoriesError = e instanceof Error ? e.message : String(e);
  }
  return {
    current,
    latest,
    newer: compareVersions(latest, current) > 0,
    release: classify(latest, { releases, advisories, fallbackDate: lastReleaseDate }),
    drift: drift({ current, latest, releases, advisories, now, fallbackDate: lastReleaseDate }),
    advisoriesError,
    checkedAt: now.toISOString(),
  };
}

/** @param {boolean | null} security */
export function securityWord(security) {
  return security === null ? "unknown" : String(security);
}

/**
 * The labels a tracking issue or PR for this release carries. Unknown counts as security
 * until the advisories page can be read: a false alarm is cheaper than a missed one.
 * @param {Classification} release
 */
export function labelsFor(release) {
  return release.security === false ? ["upstream"] : ["upstream", "security"];
}

/**
 * One line for logs, issue titles and the drift error.
 * @param {Drift} d
 */
export function driftLine(d) {
  const w = d.worst;
  if (!w) return `Vimma's Firefox ${d.current} is the latest release.`;
  const what = `Firefox ${w.version} (${w.date}, ${describe(w)})`;
  if (d.status === "overdue") {
    return (
      `Vimma ships Firefox ${d.current}, ${w.overdueHours} h past the ${w.limitDays}-day ` +
      `limit for ${what}.`
    );
  }
  return `Vimma ships Firefox ${d.current}; ${what} must be merged by ${w.deadline}.`;
}

/** @param {Classification} c */
export function describe(c) {
  const kind = c.kind === "major" ? "major release" : "dot release";
  if (c.security === null) return `${kind}, security unknown`;
  if (!c.security) return `${kind}, no advisory`;
  return `security ${kind}, ${c.advisories.map((a) => a.id).join(", ")}, ${c.severity}`;
}

/**
 * Step outputs for upstream.yml. `version` is empty when nothing is newer; `detection` is the
 * whole result as one line of JSON for the later jobs.
 * @param {Detection} r
 * @returns {Record<string, string>}
 */
export function outputs(r) {
  return {
    version: r.newer ? r.latest : "",
    current: r.current,
    kind: r.release.kind,
    security: securityWord(r.release.security),
    severity: r.release.severity ?? "",
    labels: labelsFor(r.release).join(","),
    drift: r.drift.status,
    "drift-version": r.drift.worst?.version ?? "",
    "drift-line": driftLine(r.drift),
    detection: JSON.stringify(r),
  };
}

/**
 * @param {Detection} r
 * @returns {string} Markdown for the job summary and the console
 */
export function summary(r) {
  const lines = [
    "### Upstream autopilot: detection",
    "",
    `- Shipped (surfer.json): Firefox ${r.current}`,
    `- Latest release: Firefox ${r.latest} (${r.release.date ?? "date unknown"}, ` +
      `${describe(r.release)})${r.newer ? " **newer**" : ""}`,
    `- Drift: **${r.drift.status}**. ${driftLine(r.drift)}`,
  ];
  for (const a of r.release.advisories) lines.push(`- [${a.id}](${a.url}) (${a.severity})`);
  if (r.advisoriesError) {
    lines.push(`- Advisories page unreadable (${r.advisoriesError}); security is unknown.`);
  }
  return lines.join("\n") + "\n";
}

/**
 * $GITHUB_OUTPUT lines, each value in a heredoc with a delimiter it cannot contain.
 * @param {Record<string, string>} values
 */
export function githubOutputText(values) {
  return Object.entries(values)
    .map(([k, v]) => {
      let delim = "EOF";
      while (v.includes(delim)) delim += "_";
      return `${k}<<${delim}\n${v}\n${delim}\n`;
    })
    .join("");
}

/** @param {string} url */
async function fetchLive(url) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return await res.text();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** @param {string} dir */
function fetchFromDir(dir) {
  /** @type {Record<string, string>} */
  const files = {
    [VERSIONS_URL]: "firefox_versions.json",
    [RELEASES_URL]: "firefox.json",
    [ADVISORIES_URL]: "advisories.html",
  };
  return async (/** @type {string} */ url) => readFileSync(join(dir, files[url] ?? "?"), "utf8");
}

async function main() {
  const { values } = parseArgs({
    options: {
      "surfer-json": { type: "string", default: "surfer.json" },
      feeds: { type: "string" },
      now: { type: "string" },
      json: { type: "string" },
      "github-output": { type: "string" },
    },
  });
  const current = JSON.parse(readFileSync(values["surfer-json"] ?? "surfer.json", "utf8")).version
    .version;
  const now = values.now ? new Date(values.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--now: not a date: ${values.now}`);
  const result = await detect({
    current,
    now,
    fetchText: values.feeds ? fetchFromDir(values.feeds) : fetchLive,
  });
  process.stdout.write(summary(result));
  if (result.advisoriesError) {
    console.log(`::warning::advisories page unreadable: ${result.advisoriesError}`);
  }
  if (values.json) writeFileSync(values.json, JSON.stringify(result, null, 2) + "\n");
  if (values["github-output"]) {
    appendFileSync(values["github-output"], githubOutputText(outputs(result)));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`detect: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  });
}
