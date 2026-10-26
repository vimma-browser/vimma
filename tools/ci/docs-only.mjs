#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Is this pull request docs-only? (Issue #245, docs/runbook.md "Docs-only pull requests".)
// ci.yml and e2e.yml skip their heavy steps and jobs on a docs-only pull request
// with `if:`, not with a workflow `paths` filter: a required check whose workflow never runs
// blocks the merge, while a job or step skipped by `if:` reports success.
//
//   node tools/ci/docs-only.mjs --event <event> --base <sha> --head <sha>
//       prints why, and appends docs-only=true|false to $GITHUB_OUTPUT when it is set
//   node tools/ci/docs-only.mjs --markdown-tests
//       prints the Vitest files that read the repo's Markdown, which still run on a docs-only PR
//
// The workflows run this file as the base branch has it (`git show "$BASE:..."`), never as the
// pull request has it, so a pull request cannot change the answer except through the files it
// really changes. Node built-ins only: the copy runs from outside the checkout.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Markdown written by a tool (npm run gen-docs): a hand edit must meet the full CI. */
export const GENERATED_MARKDOWN = Object.freeze(["docs/bindings.md"]);

/**
 * Markdown under these is not prose: test fixtures (tools/upstream/fixtures), vendored files
 * pinned by hash (tools/package/vendor), templates GitHub reads (.github), or sources.
 */
export const CODE_DIRS = Object.freeze([".github/", "packages/", "src/", "tests/", "tools/"]);

/**
 * The Vitest files that read a Markdown file of the repo (docs/runbook.md, docs/security.md).
 * A docs-only pull request runs these instead of the whole suite. The test of this file fails
 * when a test that reads Markdown is missing here.
 */
export const MARKDOWN_TESTS = Object.freeze([
  "packages/vimma-core/test/updates.test.mjs",
  "tools/package/test/package.test.mjs",
  "tools/release/test/changelog.test.mjs",
  "tools/security/test/check-doc-links.test.mjs",
]);

/**
 * @param {readonly string[]} files  the changed paths, repo-relative
 * @returns {{ docsOnly: boolean, reason: string }}
 */
export function isDocsOnly(files) {
  if (files.length === 0) return { docsOnly: false, reason: "no changed files: run everything" };
  for (const file of files) {
    if (!file.endsWith(".md")) return { docsOnly: false, reason: `${file} is not Markdown` };
    if (GENERATED_MARKDOWN.includes(file))
      return { docsOnly: false, reason: `${file} is generated (npm run gen-docs)` };
    const dir = CODE_DIRS.find((d) => file.startsWith(d));
    if (dir) return { docsOnly: false, reason: `${file} is Markdown under ${dir}` };
  }
  return { docsOnly: true, reason: `${files.length} Markdown file(s), all prose` };
}

/**
 * Only a pull request can be docs-only; a push, schedule, manual run or workflow_call runs
 * everything.
 * @param {{ event: string, files: readonly string[] }} change
 */
export function classify({ event, files }) {
  if (event !== "pull_request")
    return { docsOnly: false, reason: `a ${event || "(no event)"} run, not pull_request` };
  return isDocsOnly(files);
}

/**
 * The paths changed between the merge base of `base` and `head`, and `head`. --no-renames: a
 * code file renamed to *.md must show its old name too.
 * @param {string} base
 * @param {string} head
 * @param {string} [cwd]
 */
export function changedFiles(base, head, cwd = process.cwd()) {
  for (const sha of [base, head])
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a commit hash: ${JSON.stringify(sha)}`);
  const out = execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`, "--"],
    { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split("\0").filter(Boolean);
}

/** @param {string[]} argv */
function main(argv) {
  if (argv.includes("--markdown-tests")) {
    process.stdout.write(MARKDOWN_TESTS.join("\n") + "\n");
    return;
  }
  /** @param {string} name */
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? "") : "";
  };
  const event = arg("--event");
  const files = event === "pull_request" ? changedFiles(arg("--base"), arg("--head")) : [];
  const { docsOnly, reason } = classify({ event, files });
  console.log(`docs-only=${docsOnly}: ${reason}`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `docs-only=${docsOnly}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`docs-only: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
