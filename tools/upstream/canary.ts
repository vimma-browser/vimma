#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The Firefox Beta canary (spec upstream-beta-canary, upstream-beta.yml): which Beta to test, and
 * what its issue says.
 *
 *   node tools/upstream/canary.mjs detect [--version 159.0b2] [--versions firefox_versions.json]
 *        [--repo OWNER/NAME] [--now ISO] [--github-output FILE]
 *
 * B1, B2: reads product-details (or --versions) for the current Beta and asks the Actions API
 * (GH_TOKEN, `actions: read`) whether main's canary tested that Beta build in the last 7 days,
 * through an artifact named upstream-beta-<version>. Outputs version, major, run, reason,
 * released-majors (the highest released Firefox major: the canary's issues for it and lower are
 * closed, B7) and previous-artifact/previous-run (the newest result of main for the same Firefox
 * version, for B6). A manual --version is always tested and must be a Beta.
 *
 *   node tools/upstream/canary.mjs render --version 159.0b1 --repo OWNER/NAME --sha SHA
 *        --run-url URL --owner LOGIN --patch-check patch-check.json --source-result ok|fail|norun
 *        --artifacts yes|no|unknown [--artifacts-note TEXT] --test-result success|failure|skipped
 *        --suite-results suite-results.json --previous state.json --out-dir DIR
 *
 * B5–B7: writes DIR/issue.json (title, findings, the action expected, the issue body, the body
 * with the owner mention for a new issue, the progress comment and the close comment) and
 * DIR/state.json (this run's findings, the next run's `previous`). Missing input files are
 * absent results, not errors. Node built-ins only: the jobs need no `npm ci`.
 * Exit status: 0 it ran, 1 an input could not be read or is invalid, 2 usage.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { githubOutputText } from "./detect.mjs";
import { VERSIONS_URL } from "./releases.mjs";

export const LABEL = "upstream-beta";
/** GitHub refuses a body over 65,536 characters; this leaves room for the mention line. */
export const BODY_LIMIT = 60_000;
/** A Beta build tested by main's canary within this many days is not tested again (B2). */
export const RETEST_DAYS = 7;
const BETA = /^(\d+)\.0b(\d+)$/;

/** @param {number} major */
export const title = (major) => `Firefox ${major} beta: canary findings`;
/** @param {string} version */
export const artifactName = (version) => `upstream-beta-${version}`;

/** @param {string} version @returns {{ major: number, build: number }} */
function parseBeta(version) {
  const m = BETA.exec(version);
  if (!m) throw new Error(`not a Firefox Beta version: ${JSON.stringify(version)}`);
  return { major: Number(m[1]), build: Number(m[2]) };
}

/**
 * B1: the Beta product-details names, unless its Firefox version is already released.
 * @param {string} versionsText firefox_versions.json
 * @returns {{ version: string, major: number, releasedMajor: number, reason: string }}
 */
export function currentBeta(versionsText) {
  const feed = JSON.parse(versionsText);
  const latest = String(feed.LATEST_FIREFOX_VERSION ?? "");
  const rm = /^(\d+)\.\d+(\.\d+)?$/.exec(latest);
  if (!rm) throw new Error(`product-details: LATEST_FIREFOX_VERSION is not a release: ${latest}`);
  const releasedMajor = Number(rm[1]);
  const devel = String(feed.LATEST_FIREFOX_DEVEL_VERSION ?? "");
  const m = BETA.exec(devel);
  if (!m) {
    return {
      version: "",
      major: 0,
      releasedMajor,
      reason: `LATEST_FIREFOX_DEVEL_VERSION is not a Beta version: ${JSON.stringify(devel.slice(0, 40))}`,
    };
  }
  const major = Number(m[1]);
  if (major <= releasedMajor) {
    return {
      version: "",
      major,
      releasedMajor,
      reason: `Firefox ${major} is already released (${latest}); the release autopilot owns it`,
    };
  }
  return { version: devel, major, releasedMajor, reason: `Firefox ${devel} is the current Beta` };
}

/**
 * @typedef {{ id: number, name: string, expired: boolean, created_at: string,
 *   workflow_run?: { id?: number, head_branch?: string, head_repository_id?: number,
 *   repository_id?: number } }} Artifact
 * @typedef {(name: string) => Promise<Artifact[]>} ListArtifacts
 */

/**
 * The newest unexpired artifact of that name from a run on main of this repository. A manual run
 * on a branch, or a fork's, never counts as main's result.
 * @param {Artifact[]} artifacts @param {number} repositoryId
 */
function newestOnMain(artifacts, repositoryId) {
  return (
    artifacts
      .filter(
        (a) =>
          !a.expired &&
          a.workflow_run?.head_branch === "main" &&
          a.workflow_run.head_repository_id === repositoryId &&
          a.workflow_run.repository_id === repositoryId,
      )
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null
  );
}

/**
 * B1, B2: the detect job's outputs.
 * @param {{ versionsText: string, manualVersion: string, repositoryId: number, now: Date,
 *   listArtifacts: ListArtifacts }} input
 * @returns {Promise<Record<string, string>>}
 */
export async function decide({ versionsText, manualVersion, repositoryId, now, listArtifacts }) {
  const current = currentBeta(versionsText);
  let { version, reason } = current;
  if (manualVersion) {
    parseBeta(manualVersion);
    version = manualVersion;
    reason = `Firefox ${version}, named by hand`;
  }
  const out = {
    version,
    major: "",
    run: "false",
    reason,
    "released-majors": String(current.releasedMajor),
    "previous-artifact": "",
    "previous-run": "",
  };
  if (!version) return out;
  const { major, build } = parseBeta(version);
  out.major = String(major);

  // B6: the newest result of main for this Firefox version, from this build down to b1.
  /** @type {Artifact | null} */
  let previous = null;
  /** @type {Artifact | null} */
  let thisBuild = null;
  for (let b = build; b >= 1 && !previous; b--) {
    previous = newestOnMain(await listArtifacts(artifactName(`${major}.0b${b}`)), repositoryId);
    if (b === build) thisBuild = previous;
  }
  if (previous) {
    out["previous-artifact"] = String(previous.id);
    out["previous-run"] = String(previous.workflow_run?.id ?? "");
  }

  const age = thisBuild ? (now.getTime() - Date.parse(thisBuild.created_at)) / 86_400_000 : null;
  if (!manualVersion && age !== null && age < RETEST_DAYS) {
    out.reason = `Firefox ${version} was tested ${Math.floor(age)} day(s) ago on main; next test after ${RETEST_DAYS} days`;
    return out;
  }
  out.run = "true";
  return out;
}

// --- render ------------------------------------------------------------------------------------

/**
 * @typedef {{ key: string, label: string }} Item a finding: its stable key, and one line for the
 *   progress comment
 * @typedef {{ version: string, major: number, sha: string, runUrl: string, items: Item[] }} State
 * @typedef {{ patch: string, status: string, imports: boolean, missing: string[], message: string,
 *   hunks: Array<{ file: string, index: number, of: number, status: string, fuzz: number,
 *   text?: string }> }} PatchRow
 * @typedef {{ ran?: boolean, ok?: boolean, error?: string, tree?: string | null,
 *   revision?: string | null, patches: PatchRow[] }} PatchCheck
 * @typedef {{ version: string, ok: boolean, steps: Record<string, string>,
 *   mochitest: { log: boolean, failures: Array<{ status: string, test: string, message: string }> },
 *   e2e: { passed: number, failed: Array<{ name: string, status: string, error: string }>,
 *   pending: unknown[] } | null }} SuiteResults
 */

/** The checks e2e.yml runs besides the suites, as the issue names them. */
const CHECKS = /** @type {Record<string, string>} */ ({
  brandings: "product names (`tools/branding/brandings.mjs`)",
  import: "patches and sources import (`npm run import`)",
  branding: "branding prefs (`tools/branding/`)",
  "upstream-prefs": "upstream pref copies (`tools/upstream/upstream-prefs.mjs`)",
  "artifact-build": "artifact build (`tools/artifact-build/`)",
  mochitest: "mochitests (no unexpected result was logged)",
  e2e: "e2e scenarios (no failed scenario was reported)",
});

/** @param {string} text @returns {string} a fence longer than any backtick run in text */
function fence(text) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(4, longest + 1));
}

/** @param {string} text @returns {string} a fenced block: nothing in it mentions or links */
function fenced(text) {
  const f = fence(text);
  return `${f}text\n${text.replace(/\n+$/, "")}\n${f}`;
}

/** @param {string} message @returns {string} a message without its timings, for comparing runs */
const stable = (message) => message.replace(/\d+(\.\d+)?\s?ms\b/g, "N ms");
const FINISHED = /^finished in \d+(\.\d+)?\s?ms$/;

/** @param {PatchRow} p */
function hunkSummary(p) {
  if (p.missing.length) return p.missing.map((m) => `\`${m}\` is gone upstream`).join("; ");
  return p.hunks
    .filter((h) => h.status === "failed" || h.status === "fuzz")
    .map(
      (h) =>
        `hunk ${h.index}/${h.of} of \`${h.file}\` ` +
        (h.status === "fuzz" ? `needs fuzz ${h.fuzz}` : "fails"),
    )
    .join("; ");
}

/**
 * The run's findings, each with its section of the body.
 * @param {RenderInput} input
 * @returns {{ items: Item[], sections: string[][], suites: string, patches: string }}
 */
function findings(input) {
  const { patchCheck, sourceResult, artifacts, artifactsNote, testResult, suiteResults } = input;
  /** @type {Item[]} */
  const items = [];
  /** @type {string[][]} body sections, each a list of blocks that are cut as a whole */
  const sections = [];
  const rows = patchCheck?.patches ?? [];
  const failing = rows.filter((p) => !p.imports);
  let patches = `${rows.length} checked, every one applies`;
  let suites = "ran";

  if (sourceResult === "norun" || !patchCheck || patchCheck.ran === false) {
    patches = "no verdict: the patch check did not run";
    suites = "did not run: the patch check gave no verdict";
    items.push({ key: "source no-verdict", label: "the patch check did not run" });
    sections.push([
      "### Patch check did not run",
      "No verdict on any patch; run it by hand (docs/rebase.md, step 2).",
      fenced(patchCheck?.error ?? "no patch-check.json (see the run log)"),
    ]);
  } else if (failing.length) {
    const n = failing.length;
    patches = `${n} of ${rows.length} do not apply`;
    suites = `did not run: ${n} patch${n === 1 ? " does" : "es do"} not apply`;
    /** @type {string[]} */
    const blocks = [
      "### Patches that do not apply",
      'Re-export each on the Beta tree (docs/rebase.md, "A patch does not apply"). A patch ' +
        "applies to one tree: prepare the re-export now and land it with the release bump.",
    ];
    for (const p of failing) {
      items.push({ key: `patch ${p.patch}`, label: `patch ${p.patch} does not apply` });
      blocks.push(`#### \`${p.patch}\`: ${p.status}\n\n${hunkSummary(p)}.`);
      for (const h of p.hunks) {
        if (h.text) {
          blocks.push(`Hunk ${h.index}/${h.of} of \`${h.file}\`:\n\n${fenced(h.text)}`);
        }
      }
      if (p.message) blocks.push(`\`git apply --check\`:\n\n${fenced(p.message)}`);
    }
    sections.push(blocks);
  } else if (artifacts !== "yes") {
    const why = artifactsNote ? ` (${artifactsNote})` : "";
    suites = `did not run: Mozilla's build of this Beta is not available${why}`;
    items.push({
      key: `artifacts ${artifacts || "unknown"}`,
      label: `Mozilla's build of the Beta is not available${why}`,
    });
  } else if (!suiteResults && testResult !== "skipped") {
    suites = `ended without suite-results.json (the test job: ${testResult})`;
    items.push({ key: "suites no-report", label: "the test job ended without a report" });
  }

  if (suiteResults) {
    const mochi = suiteResults.mochitest?.failures ?? [];
    const scenarios = suiteResults.e2e?.failed ?? [];
    /** @type {string[]} */
    const checks = [];
    for (const [id, outcome] of Object.entries(suiteResults.steps ?? {})) {
      if (outcome === "success" || outcome === "skipped") continue;
      if (id === "mochitest" && mochi.length) continue;
      if (id === "e2e" && scenarios.length) continue;
      items.push({ key: `check ${id}`, label: `${CHECKS[id] ?? id}: ${outcome}` });
      checks.push(`- ${CHECKS[id] ?? `\`${id}\``}: ${outcome}`);
    }
    if (checks.length) sections.push(["### Checks", checks.join("\n")]);

    /** @type {Map<string, string[]>} */
    const byTest = new Map();
    for (const f of mochi) byTest.set(f.test, [...(byTest.get(f.test) ?? []), f.message]);
    /** @type {string[]} */
    const blocks = [];
    let count = 0;
    for (const [test, all] of byTest) {
      // Each failed file adds a test-level "finished in N ms" line: the file's own failures say
      // more, so it is kept only when it is the file's one line.
      const messages = all.length > 1 ? all.filter((m) => !FINISHED.test(m)) : all;
      count += messages.length;
      for (const m of messages) {
        items.push({ key: `mochitest ${test} | ${stable(m)}`, label: `mochitest ${test} | ${m}` });
      }
      blocks.push(fenced([test, ...messages.map((m) => `  ${m}`)].join("\n")));
    }
    if (blocks.length) {
      const files = byTest.size;
      sections.push([
        `### Mochitests: ${count} unexpected result${count === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`,
        ...blocks,
      ]);
    }

    if (scenarios.length) {
      const total = (suiteResults.e2e?.passed ?? 0) + scenarios.length;
      sections.push([
        `### e2e scenarios: ${scenarios.length} of ${total} failed`,
        ...scenarios.map((s) => fenced(`${s.name}: ${s.error}`)),
      ]);
      for (const s of scenarios) items.push({ key: `e2e ${s.name}`, label: `e2e ${s.name}` });
    }
    const parts = [];
    if (suiteResults.mochitest?.log) parts.push(`mochitests ${count} unexpected`);
    if (suiteResults.e2e) parts.push(`e2e ${scenarios.length} failed`);
    if (parts.length) suites = `ran: ${parts.join(", ")}`;
  }
  return { items, sections, suites, patches };
}

/**
 * Joins blocks up to the limit; a cut ends with a pointer to the run's artifact.
 * @param {string} head @param {string[][]} sections @param {string} tail @param {string} cutNote
 */
function fit(head, sections, tail, cutNote) {
  let body = head;
  const room = BODY_LIMIT - tail.length - cutNote.length - 4;
  for (const blocks of sections) {
    for (const block of blocks) {
      const next = `${body}\n${block}\n`;
      if (next.length > room) {
        // One block too long alone (a huge message): its own text is cut, inside its fence.
        const m = /^(`{4,})text\n([^]*)\n\1$/.exec(block);
        const left = room - body.length - 60;
        if (m?.[1] && m[2] !== undefined && left > 200) {
          body += `\n${m[1]}text\n${m[2].slice(0, left)}\n…\n${m[1]}\n`;
        }
        return `${body}\n${cutNote}\n${tail}`;
      }
      body = next;
    }
  }
  return `${body}\n${tail}`;
}

/**
 * `ref` is the branch tested, `main` but for a manual run on a branch (whose report job is skipped).
 * @typedef {{ version: string, repo: string, ref?: string, sha: string, runUrl: string, owner: string,
 *   patchCheck: PatchCheck | null, sourceResult: string, artifacts: string, artifactsNote: string,
 *   testResult: string, suiteResults: SuiteResults | null, previous: State | null }} RenderInput
 */

/**
 * B5–B7: the issue for this run, and the state the next run compares with.
 * @param {RenderInput} input
 */
export function render(input) {
  const { version, repo, sha, runUrl, owner, previous, ref = "main" } = input;
  const { major } = parseBeta(version);
  // Only a GitHub login, a repository and a commit go into the Markdown outside a fence.
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) throw new Error(`bad owner: ${owner}`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`bad repo: ${repo}`);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`bad sha: ${sha}`);
  if (!/^[\w./-]{1,100}$/.test(ref)) throw new Error(`bad ref: ${ref}`);
  if (!/^https:\/\/github\.com\/[\w./-]+$/.test(runUrl)) throw new Error(`bad run url: ${runUrl}`);
  const { items, sections, suites, patches } = findings(input);
  const short = sha.slice(0, 12);
  const commit = `[\`${short}\`](https://github.com/${repo}/commit/${sha})`;
  const tree = input.patchCheck?.tree;
  const revision = input.patchCheck?.revision;
  const source =
    tree && revision && /^[\w/-]+$/.test(tree) && /^[0-9a-f]{40}$/.test(revision)
      ? `, \`${tree}\` revision \`${revision.slice(0, 12)}\``
      : "";

  const head = [
    `The Beta canary (\`upstream-beta.yml\`) tested \`${ref}\` against Firefox ${version} and found ` +
      "the problems below. Fix them on `main` so that the fix works on the release `main` ships " +
      'and on this Beta (docs/rebase.md, "Before the release: the Beta canary").',
    "",
    "| | |",
    "| --- | --- |",
    `| Beta build | Firefox ${version}${source} |`,
    `| \`${ref}\` tested | ${commit} |`,
    `| Run | [run](${runUrl}), artifact \`${artifactName(version)}\` |`,
    `| Patches | ${patches} |`,
    `| Suites | ${suites} |`,
    "",
  ].join("\n");
  const tail =
    `The canary replaces this body on each Beta build of Firefox ${major}, comments what changed, ` +
    `and closes this issue when a run passes or Firefox ${major} is released.\n`;
  const cut = `**Cut to fit an issue.** Every finding is in the run's artifact \`${artifactName(version)}\`.`;
  const body = fit(head, sections, tail, cut);

  /** @type {State} */
  const state = { version, major, sha, runUrl, items };
  const had = previous !== null && previous.major === major && previous.items.length > 0;
  const action = items.length ? (had ? "update" : "open") : had ? "close" : "none";

  let comment = "";
  if (items.length && previous && previous.major === major) {
    const before = new Set(previous.items.map((i) => i.key));
    const now = new Set(items.map((i) => i.key));
    const added = items.filter((i) => !before.has(i.key));
    const fixed = previous.items.filter((i) => !now.has(i.key));
    if (added.length || fixed.length) {
      const prevSha = /^[0-9a-f]{40}$/.test(previous.sha) ? previous.sha.slice(0, 12) : "?";
      const prevVersion = BETA.test(previous.version) ? previous.version : "?";
      /** @type {string[][]} */
      const lists = [];
      if (added.length) {
        lists.push([`**New** (${added.length})`, fenced(added.map((i) => i.label).join("\n"))]);
      }
      if (fixed.length) {
        lists.push([`**Fixed** (${fixed.length})`, fenced(fixed.map((i) => i.label).join("\n"))]);
      }
      comment = fit(
        `Firefox ${version} at \`${ref}\` ${commit} ([run](${runUrl})) compared with the previous ` +
          `run (${prevVersion} at \`${prevSha}\`):\n`,
        lists,
        "",
        cut,
      );
    }
  }
  const closeComment =
    `Every patch, check and test passes on Firefox ${version} at \`${ref}\` ${commit} ` +
    `([run](${runUrl})). Closing; the canary opens a new issue if a later Beta build fails.\n`;
  const issue = {
    version,
    major,
    title: title(major),
    label: LABEL,
    findings: items.length > 0,
    action,
    body,
    openBody: `${body}\n@${owner}: the Beta canary found these on Firefox ${version}.\n`,
    comment,
    closeComment,
  };
  return { issue, state };
}

// --- CLI ---------------------------------------------------------------------------------------

/** @param {string} url @param {Record<string, string>} headers */
async function fetchJson(url, headers = {}) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return await res.json();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** @param {string} path @returns {any} the parsed file, or null when it does not exist */
function readJsonIf(path) {
  return path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

/** @param {string[]} argv */
async function main(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      version: { type: "string", default: "" },
      versions: { type: "string" },
      repo: { type: "string", default: process.env.GITHUB_REPOSITORY ?? "" },
      now: { type: "string" },
      "github-output": { type: "string" },
      sha: { type: "string", default: "" },
      "run-url": { type: "string", default: "" },
      ref: { type: "string", default: "main" },
      owner: { type: "string", default: "" },
      "patch-check": { type: "string", default: "" },
      "source-result": { type: "string", default: "" },
      artifacts: { type: "string", default: "" },
      "artifacts-note": { type: "string", default: "" },
      "test-result": { type: "string", default: "" },
      "suite-results": { type: "string", default: "" },
      previous: { type: "string", default: "" },
      "out-dir": { type: "string", default: "" },
    },
  });

  if (command === "detect") {
    const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}),
    };
    if (!/^[\w.-]+\/[\w.-]+$/.test(values.repo)) throw new Error(`--repo: ${values.repo}`);
    // Actions sets GITHUB_REPOSITORY_ID; by hand, the API answers it.
    const repositoryId = Number(
      process.env.GITHUB_REPOSITORY_ID ||
        (await fetchJson(`${api}/repos/${values.repo}`, headers)).id,
    );
    const versionsText = values.versions
      ? readFileSync(values.versions, "utf8")
      : JSON.stringify(await fetchJson(VERSIONS_URL));
    const now = values.now ? new Date(values.now) : new Date();
    const out = await decide({
      versionsText,
      manualVersion: values.version,
      repositoryId,
      now,
      listArtifacts: async (name) =>
        (
          await fetchJson(
            `${api}/repos/${values.repo}/actions/artifacts?per_page=100&name=${encodeURIComponent(name)}`,
            headers,
          )
        ).artifacts ?? [],
    });
    for (const [k, v] of Object.entries(out)) console.log(`${k}: ${v}`);
    if (values["github-output"]) appendFileSync(values["github-output"], githubOutputText(out));
    return 0;
  }

  if (command === "render") {
    const outDir = values["out-dir"];
    if (!outDir) throw new Error("--out-dir is required");
    const { issue, state } = render({
      version: values.version,
      repo: values.repo,
      ref: values.ref,
      sha: values.sha,
      runUrl: values["run-url"],
      owner: values.owner,
      patchCheck: readJsonIf(values["patch-check"]),
      sourceResult: values["source-result"],
      artifacts: values.artifacts,
      artifactsNote: values["artifacts-note"],
      testResult: values["test-result"],
      suiteResults: readJsonIf(values["suite-results"]),
      previous: readJsonIf(values.previous),
    });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "issue.json"), `${JSON.stringify(issue, null, 2)}\n`);
    writeFileSync(join(outDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
    console.log(`${issue.action}: ${issue.title} (${state.items.length} findings)`);
    for (const i of state.items) console.log(`  ${i.label}`);
    return 0;
  }
  process.stderr.write("usage: canary.mjs detect|render [options] (see the file's header)\n");
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`canary: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
