#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Did a pull request already pass this workflow on the tree just pushed to main? (Issue #358,
// docs/runbook.md "CI and automation".) A squash merge usually gives main a commit whose tree
// is the pull request head's tree, so the push run would check the same files again. The guard
// job of ci.yml, semgrep.yml and pkgbuild.yml runs this on the push event; on a match the
// workflow's checks skip with a notice naming the run that covered the tree. When main moved
// after the pull request's last run, the trees differ and the checks run: the ruleset does not
// require branches to be up to date, so that run is the only check of the merged combination.
// Equal trees include .github/workflows, so the covering run used this workflow definition.
//
//   GITHUB_TOKEN=... node tools/ci/tree-covered.mjs
//       reads GITHUB_REPOSITORY, GITHUB_SHA and GITHUB_WORKFLOW_REF (the runner sets them),
//       prints the verdict, appends skip=true|false (and run=<url>) to $GITHUB_OUTPUT when set
//       exit 0: a verdict (an API failure is a warning and skip=false: the checks then run);
//       2: a missing variable or token, which is a workflow bug and must show
//
// Reads only this repository's run list and commit objects, both public: the token needs
// `actions: read` and `contents: read`. Node built-ins only.

import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Successful pull_request runs looked at, newest first. One page: a cover is a recent run. */
export const PER_PAGE = 50;

/** @typedef {{ id: number, head_sha: string, html_url: string }} Run */
/** @typedef {(path: string) => Promise<any>} Api  JSON of a GET, or null for 404 */

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW = /^[A-Za-z0-9_.-]+\.ya?ml$/;

/**
 * The workflow file this run executes, from GITHUB_WORKFLOW_REF
 * ("owner/repo/.github/workflows/ci.yml@refs/heads/main"). Each workflow could name itself in
 * its YAML instead, but a name copied from another workflow would let that workflow's passes
 * skip this one's checks.
 * @param {string | undefined} ref
 */
export function workflowFile(ref) {
  const match = /\/\.github\/workflows\/([^/@]+)@/.exec(ref ?? "");
  if (!match || !WORKFLOW.test(match[1] ?? ""))
    throw new Error(`GITHUB_WORKFLOW_REF does not name a workflow file: ${JSON.stringify(ref)}`);
  return /** @type {string} */ (match[1]);
}

/**
 * The newest run whose head commit has `tree`. A head commit the API no longer has (null from
 * `treeOf`) is skipped. Each head commit is looked up once: re-runs share one.
 * @param {{ tree: string, runs: readonly Run[], treeOf: (sha: string) => Promise<string | null> }} q
 * @returns {Promise<Run | null>}
 */
export async function coveringRun({ tree, runs, treeOf }) {
  /** @type {Map<string, string | null>} */
  const trees = new Map();
  for (const run of runs) {
    if (!trees.has(run.head_sha)) trees.set(run.head_sha, await treeOf(run.head_sha));
    if (trees.get(run.head_sha) === tree) return run;
  }
  return null;
}

/**
 * @param {{ repo: string, workflow: string, sha: string, api: Api }} q
 * @returns {Promise<{ tree: string, run: Run | null }>}  the pushed commit's tree and the run
 *   that covers it, null when the checks must run
 */
export async function findCover({ repo, workflow, sha, api }) {
  if (!REPO.test(repo)) throw new Error(`not a repository name: ${JSON.stringify(repo)}`);
  if (!WORKFLOW.test(workflow)) throw new Error(`not a workflow file: ${JSON.stringify(workflow)}`);
  if (!SHA.test(sha)) throw new Error(`not a commit hash: ${JSON.stringify(sha)}`);
  /** @param {string} commit */
  const treeOf = async (commit) => {
    if (!SHA.test(commit)) return null;
    const json = await api(`repos/${repo}/git/commits/${commit}`);
    return typeof json?.tree?.sha === "string" ? json.tree.sha : null;
  };
  const tree = await treeOf(sha);
  if (tree === null) throw new Error(`the pushed commit ${sha} has no tree in the API`);
  const list = await api(
    `repos/${repo}/actions/workflows/${workflow}/runs?event=pull_request&status=success&per_page=${PER_PAGE}`,
  );
  const runs = Array.isArray(list?.workflow_runs) ? list.workflow_runs : [];
  return { tree, run: await coveringRun({ tree, runs, treeOf }) };
}

/**
 * What the job prints and outputs. The notice (a workflow command on stdout) shows on the run's
 * summary, so a skipped run says which run checked the tree.
 * @param {{ tree: string, run: Run | null }} found
 */
export function report({ tree, run }) {
  if (run)
    return {
      outputs: ["skip=true", `run=${run.html_url}`],
      message:
        `::notice title=Checks skipped: tree already passed::Tree ${tree} passed this workflow ` +
        `on pull request run ${run.html_url} (head ${run.head_sha}); nothing to check again.`,
    };
  return {
    outputs: ["skip=false"],
    message: `No successful pull_request run of this workflow has tree ${tree}: running the checks.`,
  };
}

/**
 * A GET of GitHub's REST API as JSON: null for 404 (a commit the API no longer serves), an
 * error for any other failure.
 * @param {{ token: string, base: string, fetch?: typeof globalThis.fetch }} o
 * @returns {Api}
 */
export function githubApi({ token, base, fetch = globalThis.fetch }) {
  return async (path) => {
    const url = `${base.replace(/\/$/, "")}/${path}`;
    const res = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
    return res.json();
  };
}

/** @param {string[]} argv */
async function main(argv) {
  /** @param {string} name */
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? "") : "";
  };
  const env = process.env;
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || "";
  if (!token) throw new Error("GITHUB_TOKEN (or GH_TOKEN) is not set");
  const repo = env.GITHUB_REPOSITORY ?? "";
  const sha = arg("--sha") || env.GITHUB_SHA || "";
  const workflow = arg("--workflow") || workflowFile(env.GITHUB_WORKFLOW_REF);
  const api = githubApi({ token, base: env.GITHUB_API_URL || "https://api.github.com" });
  /** @type {ReturnType<typeof report>} */
  let out;
  try {
    out = report(await findCover({ repo, workflow, sha, api }));
  } catch (err) {
    // The checks run: a lookup that failed must never skip them.
    out = report({ tree: sha, run: null });
    out.message =
      `::warning title=tree-covered could not look for a covering run::` +
      `${err instanceof Error ? err.message : err}; running the checks.`;
  }
  console.log(out.message);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, out.outputs.join("\n") + "\n");
}

// realpath: started through a symlink, a plain comparison would exit 0 without a verdict.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`tree-covered: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  });
}
