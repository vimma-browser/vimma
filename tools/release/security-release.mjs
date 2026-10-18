#!/usr/bin/env node
/**
 * A merged Firefox security bump releases itself (spec firefox-versions, decisions 11 to 15;
 * ADR-020; docs/security.md G9 and G10). Run by the `security-release` job of
 * release-please.yml on every push to `main`: when the pushed commit is the squash merge of the
 * upstream autopilot's PR labelled `security`, the open release PR is set to auto-merge, pinned
 * to its current head commit. GitHub then merges it once the `main` ruleset is satisfied; the
 * merge is made as RELEASE_PLEASE_TOKEN's user, so its push starts release-please.yml, which
 * tags and creates the (draft) release.
 *
 * `decide()` is pure: every check of decision 12 on the API responses `gather()` reads. Any
 * failed check is a notice and a green exit, so an ordinary push to `main` never fails the run;
 * the one failure is a missing RELEASE_PLEASE_TOKEN while AUTO_SECURITY_RELEASE is on, because
 * the switch is then on and the chain silently cannot run.
 *
 * Environment: AUTO_SECURITY_RELEASE, RELEASE_TOKEN (RELEASE_PLEASE_TOKEN), and Actions'
 * GITHUB_REPOSITORY, GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_SHA. Needs `gh`. Node built-ins only.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REPOSITORY = "vimma-browser/vimma";
export const RELEASE_BRANCH = "release-please--branches--main";
/** The autopilot's squash subject (tools/upstream/autopilot-body.mjs prTitle). */
const BUMP_SUBJECT = /^upstream: firefox (\d+(?:\.\d+)+)(?: |$)/;
/** release-please's PR title with `include-component-in-tag` off. */
const RELEASE_TITLE = /^chore\(main\): release \d+\.\d+\.\d+$/;
const SHA = /^[0-9a-f]{40}$/;

/**
 * @typedef {{ name: string }} Label
 * @typedef {{ ref: string, sha?: string, repo?: { full_name: string } | null }} Ref
 * @typedef {{ number: number, state?: string, merged_at?: string | null, title?: string,
 *   base: Ref, head: Ref, labels: Label[], user?: { login: string } }} Pull
 * @typedef {{
 *   enabled: string | undefined, hasToken: boolean, repository: string | undefined,
 *   event: string | undefined, ref: string | undefined, sha: string | undefined,
 *   subject?: string, bumpPulls?: Pull[], releasePulls?: Pull[], user?: { login: string },
 *   compare?: { status?: string }, releases?: unknown[],
 * }} Input
 * @typedef {{ action: "merge", release: number, head: string, bump: number }
 *   | { action: "skip" | "fail", reason: string }} Decision
 */

/** @param {string} reason @returns {Decision} */
const skip = (reason) => ({ action: "skip", reason });

/** @param {Pull} pull @param {string} name */
const hasLabel = (pull, name) => pull.labels.some((l) => l.name === name);

/**
 * Whether the run's own context allows the job at all; checked before any API call.
 * @param {Input} input
 * @returns {Decision | null} a skip or fail, or null to go on
 */
function gate(input) {
  if (input.enabled !== "true") return skip("AUTO_SECURITY_RELEASE is not true");
  if (input.repository !== REPOSITORY)
    return skip(`repository ${input.repository} is not ${REPOSITORY}`);
  if (input.event !== "push") return skip(`event ${input.event} is not a push`);
  if (input.ref !== "refs/heads/main") return skip(`ref ${input.ref} is not refs/heads/main`);
  if (!input.hasToken) {
    return {
      action: "fail",
      reason:
        "AUTO_SECURITY_RELEASE is on but RELEASE_PLEASE_TOKEN is not set (docs/runbook.md, Releases)",
    };
  }
  return null;
}

/**
 * Every check of decision 12; all must hold for a merge.
 * @param {Input} input
 * @returns {Decision}
 */
export function decide(input) {
  const stop = gate(input);
  if (stop) return stop;

  const version = BUMP_SUBJECT.exec(input.subject ?? "")?.[1];
  if (!version) return skip(`commit subject "${input.subject}" is not an upstream: firefox bump`);

  const bumps = input.bumpPulls ?? [];
  if (bumps.length !== 1) return skip(`the commit belongs to ${bumps.length} PRs, not exactly one`);
  const bump = /** @type {Pull} */ (bumps[0]);
  if (!bump.merged_at) return skip(`bump PR #${bump.number} is not merged`);
  if (bump.base.ref !== "main") return skip(`bump PR #${bump.number}'s base is not main`);
  if (bump.head.ref !== `upstream/firefox-${version}` || bump.head.repo?.full_name !== REPOSITORY) {
    return skip(`bump PR #${bump.number} is not from ${REPOSITORY}'s upstream/firefox-${version}`);
  }
  if (!hasLabel(bump, "upstream")) return skip(`bump PR #${bump.number} has no upstream label`);
  if (!hasLabel(bump, "security")) return skip(`bump PR #${bump.number} has no security label`);

  const releases = input.releasePulls ?? [];
  if (releases.length !== 1) return skip(`${releases.length} open release PRs, not exactly one`);
  const release = /** @type {Pull} */ (releases[0]);
  const author = input.user?.login;
  const problem =
    release.state !== "open"
      ? "is not open"
      : release.head.ref !== RELEASE_BRANCH || release.head.repo?.full_name !== REPOSITORY
        ? `is not from ${REPOSITORY}'s ${RELEASE_BRANCH}`
        : release.base.ref !== "main"
          ? "is not based on main"
          : !hasLabel(release, "autorelease: pending")
            ? "has no autorelease: pending label"
            : !RELEASE_TITLE.test(release.title ?? "")
              ? `title "${release.title}" is not a release title`
              : !author || release.user?.login !== author
                ? `author ${release.user?.login} is not RELEASE_PLEASE_TOKEN's user ${author}`
                : !SHA.test(release.head.sha ?? "")
                  ? "has no head commit"
                  : null;
  if (problem) return skip(`release PR #${release.number} ${problem}`);

  const status = input.compare?.status;
  if (status !== "ahead" && status !== "identical") {
    return skip(`release PR #${release.number} does not contain ${input.sha} (${status})`);
  }
  if ((input.releases ?? []).length === 0) {
    return skip("no first release exists yet; the runbook has a person merge it");
  }
  return {
    action: "merge",
    release: release.number,
    head: /** @type {string} */ (release.head.sha),
    bump: bump.number,
  };
}

/**
 * Reads what `decide()` needs. Asks nothing when the run's context already rules the job out.
 * @param {Record<string, string | undefined>} env
 * @param {(path: string) => Promise<any>} api a GET of the REST API, with RELEASE_PLEASE_TOKEN
 * @returns {Promise<Input>}
 */
export async function gather(env, api) {
  /** @type {Input} */
  const input = {
    enabled: env.AUTO_SECURITY_RELEASE,
    hasToken: Boolean(env.RELEASE_TOKEN),
    repository: env.GITHUB_REPOSITORY,
    event: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    sha: env.GITHUB_SHA,
  };
  if (gate(input) || !SHA.test(input.sha ?? "")) return input;
  const repo = `repos/${REPOSITORY}`;
  const commit = await api(`${repo}/commits/${input.sha}`);
  input.subject = String(commit?.commit?.message ?? "").split("\n")[0];
  if (!BUMP_SUBJECT.test(input.subject)) return input;
  input.bumpPulls = await api(`${repo}/commits/${input.sha}/pulls`);
  const owner = REPOSITORY.split("/")[0];
  const head = encodeURIComponent(`${owner}:${RELEASE_BRANCH}`);
  input.releasePulls = await api(`${repo}/pulls?state=open&base=main&head=${head}`);
  input.user = await api("user");
  const releaseHead = input.releasePulls?.[0]?.head?.sha;
  if (input.releasePulls?.length === 1 && SHA.test(releaseHead ?? "")) {
    input.compare = await api(`${repo}/compare/${input.sha}...${releaseHead}`);
  }
  input.releases = await api(`${repo}/releases?per_page=1`);
  return input;
}

/* c8 ignore start: the CLI around the tested functions, exercised by the dry run */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = { ...process.env, GH_TOKEN: process.env.RELEASE_TOKEN ?? "" };
  /** @param {string[]} args */
  const gh = (args) => execFileSync("gh", args, { env, encoding: "utf8" });
  const decision = decide(await gather(process.env, async (path) => JSON.parse(gh(["api", path]))));
  if (decision.action === "fail") {
    console.log(`::error::${decision.reason}`);
    process.exit(1);
  }
  if (decision.action === "skip") {
    console.log(`::notice::No security release: ${decision.reason}`);
    process.exit(0);
  }
  const { release, head, bump } = decision;
  // --match-head-commit: GitHub refuses if the branch moved since the checks above; later
  // pushes by release-please keep auto-merge on (decision 14).
  gh([
    "pr",
    "merge",
    String(release),
    "--repo",
    REPOSITORY,
    "--auto",
    "--squash",
    "--match-head-commit",
    head,
  ]);
  const body =
    `Security bump merged: release PR #${release} is set to auto-merge at ${head} and merges ` +
    "when its required checks pass (spec firefox-versions; AUTO_SECURITY_RELEASE).";
  gh(["pr", "comment", String(bump), "--repo", REPOSITORY, "--body", body]);
  const summary = `#${bump} merged: release PR #${release} set to auto-merge at ${head}`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
}
/* c8 ignore stop */
