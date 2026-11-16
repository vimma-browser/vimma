#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec statuses against their GitHub issues (docs/specs/README.md, "Keeping statuses
// current"). A spec names its issues on an `Issue:` line; this reports:
// - a draft or accepted spec whose issues are all closed (it was built: set `implemented`, or
//   link the issue that tracks the rest), unless one of them is labelled `on-hold` (the work was
//   parked, not finished, and the spec keeps its status until the issue is reopened);
// - an implemented spec with an open issue;
// - an open issue whose `spec:draft` / `spec:accepted` label does not match the spec;
// - a linked number that is not an issue.
// spec-status.yml runs it daily and keeps one issue with the report. Read-only: it only reads
// the repository and the issues.
//
//   node tools/spec-lint/spec-status.ts [--markdown FILE] [--repo OWNER/NAME]
//
// Exit status: 0 nothing to report, 1 findings (the report says what), 2 could not check.
// GH_TOKEN or GITHUB_TOKEN is used when set; without one, GitHub's anonymous limit (60
// requests an hour) is enough for a local run.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { REPO } from "../repo.ts";
import { parseSpec } from "./spec-lint.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE = new Set(["draft", "accepted"]);

export type Spec = { file: string; status: string | null; issues: number[] };
export type Issue = { state: "open" | "closed"; labels: string[]; pullRequest: boolean };
export type Finding = { file: string; message: string };

const list = (ns: number[]) => {
  const refs = ns.map((n) => `#${n}`);
  return refs.length < 2 ? refs.join("") : `${refs.slice(0, -1).join(", ")} and ${refs.at(-1)}`;
};

/**
 * @param issues  every linked number that GitHub knows
 */
export function driftFindings(specs: Spec[], issues: Map<number, Issue>): Finding[] {
  const found: Finding[] = [];
  for (const spec of specs) {
    const { file, status } = spec;
    const known: number[] = [];
    for (const n of spec.issues) {
      const issue = issues.get(n);
      if (!issue || issue.pullRequest)
        found.push({ file, message: `#${n} is not an issue (missing, or a pull request)` });
      else known.push(n);
    }
    const open = known.filter((n) => issues.get(n)?.state === "open");
    const closed = known.filter((n) => issues.get(n)?.state === "closed");
    const onHold = closed.some((n) => issues.get(n)?.labels.includes("on-hold"));
    if (status && LIVE.has(status) && known.length > 0 && open.length === 0 && !onHold)
      found.push({
        file,
        message:
          `${status}, but ${list(closed)} ${closed.length > 1 ? "are" : "is"} closed: set ` +
          "`implemented`, or link the issue that tracks the rest",
      });
    if (status === "implemented" && open.length > 0)
      found.push({
        file,
        message:
          `implemented, but ${list(open)} ${open.length > 1 ? "are" : "is"} open: close ` +
          `${open.length > 1 ? "them" : "it"}, or set the status back with a note`,
      });
    for (const n of open) {
      const label = issues.get(n)?.labels.find((l) => /^spec:/.test(l));
      if (status && LIVE.has(status) && label && label !== `spec:${status}`)
        found.push({ file, message: `#${n} is labelled ${label}; the spec is ${status}` });
    }
  }
  return found;
}

/**
 * @returns Markdown
 */
export function renderReport(
  findings: Finding[],
  { repo, sha }: { repo: string; sha: string },
): string {
  if (findings.length === 0)
    return "Every spec's status and label match their issues (docs/specs/README.md, Lifecycle).\n";
  const lines = [
    "Spec statuses that do not match their GitHub issues. Fix the spec's `Status:` line, its",
    '`Issue:` line or the issue, as docs/specs/README.md ("Keeping statuses current") says.',
    "This issue is updated on each run and closed when nothing is left.",
    "",
    ...findings.map(
      (f) =>
        `- [\`docs/specs/${f.file}\`](https://github.com/${repo}/blob/${sha}/docs/specs/${f.file}): ${f.message}`,
    ),
  ];
  return lines.join("\n") + "\n";
}

function readSpecs(): Spec[] {
  return readdirSync(join(ROOT, "docs/specs"))
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort()
    .map((file) => ({ file, ...parseSpec(readFileSync(join(ROOT, "docs/specs", file), "utf8")) }));
}

async function fetchIssues(numbers: number[], repo: string): Promise<Map<number, Issue>> {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const issues: Map<number, Issue> = new Map();
  for (const n of numbers) {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${n}`, { headers });
    if (res.status === 404 || res.status === 410) continue;
    if (!res.ok) throw new Error(`GET issue #${n}: HTTP ${res.status}`);
    const body = await res.json();
    issues.set(n, {
      state: body.state === "open" ? "open" : "closed",
      labels: (body.labels ?? []).map((l: { name: string }) => l.name),
      pullRequest: Boolean(body.pull_request),
    });
  }
  return issues;
}

async function main() {
  const { values } = parseArgs({
    options: { markdown: { type: "string" }, repo: { type: "string" } },
  });
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY ?? REPO;
  const sha = process.env.GITHUB_SHA ?? "main";
  const specs = readSpecs();
  const numbers = [...new Set(specs.flatMap((s) => s.issues))].sort((a, b) => a - b);
  const findings = driftFindings(specs, await fetchIssues(numbers, repo));
  const report = renderReport(findings, { repo, sha });
  if (values.markdown) writeFileSync(values.markdown, report);
  process.stdout.write(report);
  process.exit(findings.length ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => {
    console.error(`spec-status: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  });
