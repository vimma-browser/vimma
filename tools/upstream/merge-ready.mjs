#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec upstream-bump-automation, Behaviour 5 (since changed), docs/security.md G13: whether the
// upstream bump PR may be set to auto-merge, read by upstream-merge.yml each time a workflow on
// the PR finishes. Ready only once every workflow run the PR started finished green or skipped,
// so a check the ruleset does not require (the macOS mochitests, the package checks) still holds
// the merge. Pure: the workflow fetches the JSON and passes it in.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const BOT = "vimma-upstream-autopilot[bot]";
const GREEN = new Set(["success", "skipped", "neutral"]);

/**
 * The commit the autopilot allowed to merge itself (autoMergeMarker in autopilot-body.mjs).
 * @param {string} body
 * @returns {string | null}
 */
export function markerSha(body) {
  const m = /<!-- upstream-auto-merge: ([0-9a-f]{40}) -->/.exec(body ?? "");
  return m ? m[1] : null;
}

/**
 * @typedef {{ number: number, title: string, user: { login: string }, draft: boolean,
 *   head: { sha: string }, body: string | null, auto_merge: unknown }} Pull
 * @typedef {{ name: string, event: string, head_sha: string, status: string,
 *   conclusion: string | null }} Run
 * @typedef {{ name: string, status: string, conclusion: string | null }} Check
 * @param {{ pr: Pull | null, runs: Run[], checks: Check[], head: string }} input
 * @returns {{ ready: boolean, reason: string }}
 */
export function mergeReady({ pr, runs, checks, head }) {
  /** @param {string} reason */
  const no = (reason) => ({ ready: false, reason });
  if (!pr) return no("no open pull request");
  if (pr.user?.login !== BOT) return no("not opened by the upstream App");
  if (pr.draft) return no("a draft");
  if (pr.head?.sha !== head) return no("the head moved");
  if (markerSha(pr.body ?? "") !== head) {
    return no("the autopilot did not allow auto-merge for this head");
  }
  if (pr.auto_merge) return no("auto-merge is already on");
  const mine = runs.filter((r) => r.event === "pull_request" && r.head_sha === head);
  if (mine.length === 0) return no("no pull request run on the head");
  for (const r of mine) {
    if (r.status !== "completed") return no(`waiting for ${r.name}`);
    if (!GREEN.has(String(r.conclusion))) return no(`${r.name}: ${r.conclusion}`);
  }
  for (const c of checks) {
    if (c.status === "completed" && !GREEN.has(String(c.conclusion))) {
      return no(`${c.name}: ${c.conclusion}`);
    }
  }
  return { ready: true, reason: "every check is green" };
}

/**
 * @param {string} file `gh api --paginate --slurp` output: an array of pages
 * @param {string} key the list in each page
 */
function pages(file, key) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  return (Array.isArray(data) ? data : [data]).flatMap((p) => p[key] ?? []);
}

function main() {
  const { values } = parseArgs({
    options: {
      pulls: { type: "string" },
      runs: { type: "string" },
      checks: { type: "string" },
      head: { type: "string" },
    },
  });
  if (!values.pulls || !values.runs || !values.checks || !values.head) {
    throw new Error("--pulls, --runs, --checks and --head are required");
  }
  const pulls = JSON.parse(readFileSync(values.pulls, "utf8"));
  const pr = Array.isArray(pulls) && pulls.length === 1 ? pulls[0] : null;
  const result = mergeReady({
    pr,
    runs: pages(values.runs, "workflow_runs"),
    checks: pages(values.checks, "check_runs"),
    head: values.head,
  });
  process.stdout.write(
    JSON.stringify({ ...result, number: pr?.number ?? 0, title: pr?.title ?? "" }) + "\n",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`merge-ready: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
