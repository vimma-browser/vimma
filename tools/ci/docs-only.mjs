#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Which of CI's heavy work can this pull request's change reach? (Issue #245,
// docs/runbook/ci-docs-only-pull-requests.md, "Docs-only pull requests" and "Pull requests the
// browser jobs skip".) Three answers:
//   docs-only      only prose Markdown changed: ci.yml skips what Markdown cannot affect;
//   browser-tests  e2e.yml's mochitest jobs (the build, mochitests, e2e) can be affected;
//   rust           vimma-ctl's cargo steps in ci.yml can be affected.
// The workflows skip with `if:`, not with a workflow `paths` filter: a required check whose
// workflow never runs blocks the merge, while a job or step skipped by `if:` reports success.
//
//   node tools/ci/docs-only.mjs --event <event> --base <sha> --head <sha>
//       prints why, and appends docs-only=, browser-tests= and rust=true|false to
//       $GITHUB_OUTPUT when it is set
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
 * The Vitest files that read a Markdown file of the repo (docs/runbook/, docs/security/,
 * docs/guide.md). A docs-only pull request runs these instead of the whole suite. The test of
 * this file fails when a test that reads Markdown is missing here.
 */
export const MARKDOWN_TESTS = Object.freeze([
  "packages/vimma-core/test/firefox-keys.test.ts",
  "packages/vimma-core/test/guide-agent-examples.test.ts",
  "packages/vimma-core/test/updates.test.ts",
  "tools/config-reference/test/config-reference.test.ts",
  "tools/package/test/openpgp-kms.test.ts",
  "tools/package/test/package.test.ts",
  "tools/release/test/changelog.test.ts",
  "tools/security/test/check-doc-links.test.ts",
  "tools/security/test/doc-index.test.ts",
]);

/**
 * Why `file` is not prose Markdown, or "" when it is.
 * @param {string} file
 */
function notProse(file) {
  const name = JSON.stringify(file);
  if (!file.endsWith(".md")) return `${name} is not Markdown`;
  if (GENERATED_MARKDOWN.includes(file)) return `${name} is generated (npm run gen-docs)`;
  const dir = CODE_DIRS.find((d) => file.startsWith(d));
  return dir ? `${name} is Markdown under ${dir}` : "";
}

/**
 * @param {readonly string[]} files  the changed paths, repo-relative
 * @returns {{ docsOnly: boolean, reason: string }}
 */
export function isDocsOnly(files) {
  if (files.length === 0) return { docsOnly: false, reason: "no changed files: run everything" };
  for (const file of files) {
    const reason = notProse(file);
    if (reason) return { docsOnly: false, reason };
  }
  return { docsOnly: true, reason: `${files.length} Markdown file(s), all prose` };
}

/**
 * Paths that no required job of e2e.yml reads: e2e.yml checks out the repository, runs npm ci, builds
 * vimma-ctl, imports src/ and packages/ into the engine with tools/import, tools/sync-core.ts and
 * tools/version-files, builds with tools/artifact-build, and runs tools/mochitest.ts, tools/e2e,
 * tools/sites, tools/agent-bench, tools/branding and tools/upstream on tests/. An allowlist, so
 * that a path not named here, a new folder or file included, runs the browser jobs. The test of
 * this file fails when a file that runs them imports one of these. Besides these, prose Markdown,
 * every workflow but e2e.yml, and the Vitest files under tools/ that e2e.yml does not run
 * (BROWSER_TESTS) skip them. The informational macOS job also runs the whole Vitest suite
 * (`npm test`); it skips with the mochitests, so such a change gets no Vitest run on macOS.
 */
export const BROWSER_SKIP = Object.freeze({
  dirs: Object.freeze([
    ".claude-plugin/",
    ".gemini/",
    ".github/ISSUE_TEMPLATE/",
    ".github/codeql/",
    "tools/arch-lint/",
    "tools/bench/",
    // e2e.yml runs the base branch's docs-only.mjs, never the pull request's.
    "tools/ci/",
    "tools/claude-plugin/",
    "tools/commitlint/",
    "tools/config-reference/",
    "tools/deps/",
    "tools/diagrams/",
    "tools/layering/",
    "tools/license-check/",
    "tools/md-wording/",
    "tools/mutation/",
    "tools/omarchy/",
    "tools/release/",
    "tools/security/",
    "tools/spec-lint/",
    "tools/stats/",
    "tools/unicode/",
    // Type declarations for tsc; nothing loads them at run time.
    "types/",
  ]),
  files: Object.freeze([
    ".github/FUNDING.yml",
    ".github/actionlint.yaml",
    ".github/copilot-instructions.md",
    ".github/dependabot.yml",
    ".github/pull_request_template.md",
    ".prettierignore",
    ".prettierrc.json",
    ".semgrepignore",
    "commitlint.config.ts",
    "eslint.config.mjs",
    "release-please-config.json",
    "stryker.config.mjs",
    // Generators: what they write is a changed path of its own, and judged as one.
    "tools/gen-agent-tools.ts",
    "tools/gen-docs.ts",
    "tools/gen-mochitest-head.ts",
    "tools/gen-vimma-modules.ts",
    "tools/sjs-typecheck.ts",
  ]),
});

/** The folders whose Vitest files e2e.yml runs (`vitest run tools/e2e/`, `tools/branding/`). */
export const BROWSER_TESTS = Object.freeze(["tools/e2e/", "tools/branding/"]);

/**
 * Is `file` the path `p`, or under it when `p` is a folder (ends in "/")?
 * @param {string} p
 * @param {string} file
 */
const names = (p, file) => (p.endsWith("/") ? file.startsWith(p) : file === p);

/** @param {string} file */
function skipsBrowser(file) {
  if (!notProse(file)) return true;
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file)) return file !== ".github/workflows/e2e.yml";
  if (BROWSER_SKIP.files.includes(file) || BROWSER_SKIP.dirs.some((d) => file.startsWith(d)))
    return true;
  return (
    /^tools\/.+\.test\.[cm]?[jt]s$/.test(file) && !BROWSER_TESTS.some((d) => file.startsWith(d))
  );
}

/**
 * Do e2e.yml's mochitest jobs (the artifact build, the mochitests, the e2e scenarios) need to
 * run for these changed paths?
 * @param {readonly string[]} files  the changed paths, repo-relative
 * @returns {{ run: boolean, reason: string }}
 */
export function needsBrowser(files) {
  if (files.length === 0) return { run: true, reason: "no changed files: run everything" };
  const file = files.find((f) => !skipsBrowser(f));
  if (file !== undefined)
    return {
      run: true,
      reason: `${JSON.stringify(file)} can reach the browser build or its tests`,
    };
  return { run: false, reason: `${files.length} file(s), none read by the browser jobs` };
}

/**
 * What vimma-ctl's build and tests read outside tools/vimma-ctl, among paths the browser jobs
 * skip: tests/guide_snippets.rs reads docs/guide.md, ci.yml holds the cargo steps, and
 * tools/license-check judges the crates' licences.
 */
export const RUST_INPUTS = Object.freeze([
  ".github/workflows/ci.yml",
  "docs/guide.md",
  "tools/license-check/",
]);

/**
 * Paths that the browser jobs read but vimma-ctl's cargo steps do not (a folder ends in "/").
 * vimma-ctl reads surfer.json, tests/contract/ and packages/vimma-core/src/, which stay inputs.
 */
export const RUST_SKIP = Object.freeze([
  ".github/workflows/e2e.yml",
  "src/",
  "tests/browser/",
  "tests/e2e/",
  "tools/e2e/",
]);

/**
 * Do the cargo steps of ci.yml (fmt, clippy, tests, the crates' licences) need to run?
 * @param {readonly string[]} files  the changed paths, repo-relative
 * @returns {{ run: boolean, reason: string }}
 */
export function needsRust(files) {
  if (files.length === 0) return { run: true, reason: "no changed files: run everything" };
  for (const file of files) {
    if (RUST_INPUTS.some((p) => names(p, file)))
      return {
        run: true,
        reason: `${JSON.stringify(file)} is an input of vimma-ctl's cargo steps`,
      };
    if (!skipsBrowser(file) && !RUST_SKIP.some((p) => names(p, file)))
      return { run: true, reason: `${JSON.stringify(file)} can reach vimma-ctl's build or tests` };
  }
  return { run: false, reason: `${files.length} file(s), none read by vimma-ctl's cargo steps` };
}

/**
 * Only a pull request can skip anything; a push, schedule, manual run or workflow_call runs
 * everything.
 * @param {{ event: string, files: readonly string[] }} change
 */
export function classify({ event, files }) {
  if (event !== "pull_request") {
    const reason = `a ${event || "(no event)"} run, not pull_request`;
    return {
      docsOnly: false,
      reason,
      browser: true,
      browserReason: reason,
      rust: true,
      rustReason: reason,
    };
  }
  const { docsOnly, reason } = isDocsOnly(files);
  const browser = needsBrowser(files);
  const rust = needsRust(files);
  return {
    docsOnly,
    reason,
    browser: browser.run,
    browserReason: browser.reason,
    rust: rust.run,
    rustReason: rust.reason,
  };
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
  const c = classify({ event, files });
  console.log(`docs-only=${c.docsOnly}: ${c.reason}`);
  console.log(`browser-tests=${c.browser}: ${c.browserReason}`);
  console.log(`rust=${c.rust}: ${c.rustReason}`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `docs-only=${c.docsOnly}\nbrowser-tests=${c.browser}\nrust=${c.rust}\n`,
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`docs-only: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
