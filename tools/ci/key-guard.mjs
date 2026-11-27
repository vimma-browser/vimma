#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Does this pull request change Mozilla's pinned release key? (ADR-021, docs/security.md B1.)
// Every Firefox source tarball is trusted because Mozilla's release key, pinned in
// tools/upstream/mozilla-release-key.asc and by PINNED_FINGERPRINT in verify-sha512.py, signed
// its SHA512SUMS. A pull request that changes either, or the guard's own files, fails this check
// unless it carries the
// key-rotation-approved label, which only people with triage access or more can add, so a key
// change cannot merge unnoticed inside an unrelated change (docs/runbook.md, "Mozilla's release
// key").
//
//   PR_LABELS='["..."]' node tools/ci/key-guard.mjs --base <sha> --head <sha>
//       exit 0: no key change, or one with the label; 1: a key change without the label;
//       2: the check could not run (bad arguments, labels or git)
//
// key-guard.yml runs on pull_request_target, so this file and the workflow come from the base
// branch and a pull request cannot weaken the check by editing them; the head is read as git
// objects only. Node built-ins only: nothing is installed in that job.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const KEY_PATH = "tools/upstream/mozilla-release-key.asc";
export const VERIFIER_PATH = "tools/upstream/verify-sha512.py";
export const APPROVAL_LABEL = "key-rotation-approved";
export const GUARD_SCRIPT = "tools/ci/key-guard.mjs";

/**
 * The guard's own files. A change to them is judged by the base's copy, not its own, but once
 * merged it decides every later run; requiring the label for these files keeps such a change from
 * merging unseen (docs/security.md B1).
 */
export const GUARD_PATHS = [
  ".github/workflows/key-guard.yml",
  GUARD_SCRIPT,
  "tools/ci/test/key-guard.test.mjs",
];

/**
 * The names whose lines in the verifier decide which key is trusted: the pinned primary
 * fingerprint and the key file it is read from. Every line that names one counts, not only the
 * assignment, so a second assignment, a changed default argument or a redirected key file is a
 * key change too. A comment that names one counts as well; that costs a label now and then and
 * keeps the rule free of a Python parser.
 */
const PINNED_NAME = /\b(?:PINNED_FINGERPRINT|KEY_FILE)\b/;

/**
 * @param {string | null} verifier  verify-sha512.py's text, or null when the file is missing
 * @returns {string[] | null}
 */
export function pinnedLines(verifier) {
  if (verifier === null) return null;
  return verifier.split("\n").filter((line) => PINNED_NAME.test(line));
}

/**
 * @typedef {{ key: string | null, verifier: string | null, guard?: Record<string, string | null> }} Side
 *   at one commit: the key file's tree entry (mode and object id, so the bytes and a switch to a
 *   symlink both count), the verifier's text, and the tree entry of each of GUARD_PATHS; null
 *   when the file is missing there
 */

/**
 * What the pull request changes in the key material and the guard, one line per changed file.
 * @param {Side} before  at the merge base
 * @param {Side} after  at the head
 * @param {{ guardOnBase?: boolean }} [options]  guardOnBase false: the base branch has no guard
 *   yet, so the pull request that adds it is not asked to approve itself
 * @returns {string[]}
 */
export function keyChanges(before, after, { guardOnBase = true } = {}) {
  /** @type {string[]} */
  const changes = [];
  if (before.key !== after.key) {
    const how = after.key === null ? "deleted" : before.key === null ? "added" : "changed";
    changes.push(`${KEY_PATH} ${how}`);
  }
  const was = pinnedLines(before.verifier);
  const is = pinnedLines(after.verifier);
  if (JSON.stringify(was) !== JSON.stringify(is)) {
    changes.push(
      is === null
        ? `${VERIFIER_PATH} deleted or moved`
        : `${VERIFIER_PATH}: a line that names PINNED_FINGERPRINT or KEY_FILE changed`,
    );
  }
  if (guardOnBase) {
    for (const path of GUARD_PATHS) {
      const was = before.guard?.[path] ?? null;
      const is = after.guard?.[path] ?? null;
      if (was === is) continue;
      const how = is === null ? "deleted" : was === null ? "added" : "changed";
      changes.push(`${path} ${how} (the key guard itself)`);
    }
  }
  return changes;
}

/**
 * The pull request's labels, as `toJSON(github.event.pull_request.labels.*.name)` gives them.
 * @param {string | undefined} json
 * @returns {string[]}
 */
export function parseLabels(json) {
  const labels = JSON.parse(json ?? "");
  if (!Array.isArray(labels) || !labels.every((l) => typeof l === "string"))
    throw new Error(`PR_LABELS is not a JSON list of label names: ${JSON.stringify(json)}`);
  return labels;
}

/**
 * @param {readonly string[]} changes  from keyChanges
 * @param {readonly string[]} labels
 * @returns {{ ok: boolean, message: string }}
 */
export function verdict(changes, labels) {
  if (changes.length === 0)
    return { ok: true, message: "The pull request leaves Mozilla's pinned release key alone." };
  const list = changes.map((c) => `  - ${c}`).join("\n");
  if (labels.includes(APPROVAL_LABEL))
    return {
      ok: true,
      message: `The pull request changes Mozilla's pinned release key or its guard, approved by the ${APPROVAL_LABEL} label:\n${list}`,
    };
  return {
    ok: false,
    message:
      `The pull request changes Mozilla's pinned release key or its guard:\n${list}\n` +
      `A maintainer adds the ${APPROVAL_LABEL} label after checking the change against ` +
      `Mozilla's announcement (docs/runbook.md, "Mozilla's release key"; ADR-021).`,
  };
}

/**
 * A path's tree entry at a commit ("<mode> <type> <object id>"), or null when it has none.
 * @param {string} rev
 * @param {string} path
 * @param {string} cwd
 */
function entryAt(rev, path, cwd) {
  const out = execFileSync("git", ["ls-tree", "--full-tree", rev, "--", path], {
    cwd,
    encoding: "utf8",
  });
  const line = out.split("\n").find((l) => l.endsWith(`\t${path}`));
  return line ? line.slice(0, line.indexOf("\t")) : null;
}

/**
 * A file's text at a commit, or null when the commit does not have it.
 * @param {string} rev
 * @param {string} path
 * @param {string} cwd
 */
function fileAt(rev, path, cwd) {
  try {
    execFileSync("git", ["cat-file", "-e", `${rev}:${path}`], { cwd, stdio: "ignore" });
  } catch {
    return null;
  }
  return execFileSync("git", ["cat-file", "blob", `${rev}:${path}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * The key material at the merge base of `base` and `head`, and at `head`: the pull request's own
 * changes, so a branch made before an approved rotation landed on main does not fail for it.
 * @param {string} base
 * @param {string} head
 * @param {string} [cwd]
 * @returns {{ before: Side, after: Side, guardOnBase: boolean }}
 */
export function sides(base, head, cwd = process.cwd()) {
  for (const sha of [base, head])
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a commit hash: ${JSON.stringify(sha)}`);
  const mergeBase = execFileSync("git", ["merge-base", base, head], {
    cwd,
    encoding: "utf8",
  }).trim();
  /** @param {string} rev @returns {Side} */
  const at = (rev) => ({
    key: entryAt(rev, KEY_PATH, cwd),
    verifier: fileAt(rev, VERIFIER_PATH, cwd),
    guard: Object.fromEntries(GUARD_PATHS.map((path) => [path, entryAt(rev, path, cwd)])),
  });
  // The base branch's tip, not the merge base: once the guard is on main, every pull request's
  // changes to it need the label, however old its branch.
  const guardOnBase = entryAt(base, GUARD_SCRIPT, cwd) !== null;
  return { before: at(mergeBase), after: at(head), guardOnBase };
}

/** @param {string[]} argv @returns {number} */
function main(argv) {
  /** @param {string} name */
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? "") : "";
  };
  const labels = parseLabels(process.env.PR_LABELS);
  const { before, after, guardOnBase } = sides(arg("--base"), arg("--head"));
  const { ok, message } = verdict(keyChanges(before, after, { guardOnBase }), labels);
  (ok ? console.log : console.error)(message);
  return ok ? 0 : 1;
}

// realpath: import.meta.url is the resolved path, argv[1] the path as given. Started through a
// symlink, a plain comparison is false and the script would exit 0 without a verdict.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let status;
  try {
    status = main(process.argv.slice(2));
  } catch (err) {
    console.error(`key-guard: ${err instanceof Error ? err.message : err}`);
    status = 2;
  }
  process.exit(status);
}
