#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Upstream autopilot texts (spec m7-upstream-autopilot): the tracking issue, the bump PR's
 * title and body (what applied, what conflicts, what the tests said), the fallback comment when
 * Actions may not open PRs, and the drift issue.
 *
 *   node tools/upstream/autopilot-body.mjs <issue|title|pr|fallback|drift> --detection FILE
 *     [--patch-check FILE --patch-markdown FILE --patch-result ok|fail|norun --audit FILE
 *      --artifacts yes|no|unknown --artifacts-note TEXT --tests RESULT --has-token true|false
 *      --issue N --branch NAME --repo OWNER/NAME --run-url URL --owner LOGIN --error FILE
 *      --beta-issues JSON]
 *
 * Writes Markdown to stdout (`pr --draft-only` prints "true" or "false"). Node built-ins only.
 * Every string from outside (a hunk, an advisory, an error) is constrained by a regexp in
 * releases.mjs, inside a code fence that patch-check.py sized for it, or escaped for where it
 * goes: oneLine for Markdown text, codeLine for a code span.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { describe, driftLine, labelsFor } from "./detect.mjs";

/** A PR body may hold 65,536 characters; keep a margin for GitHub's own additions. */
export const BODY_LIMIT = 64000;

/**
 * @typedef {import("./detect.mjs").Detection} Detection
 * @typedef {{ patch: string, files: string[], status: string, imports: boolean,
 *   missing: string[], hunks: { file: string, index: number, of: number, header: string,
 *   status: string, offset: number, fuzz: number }[] }} PatchRow
 * @typedef {{ ran: boolean, ok: boolean, error?: string, firefox: string | null,
 *   revision?: string | null, counts: Record<string, number>, patches: PatchRow[] }} PatchReport
 * @typedef {{ detection: Detection, patchReport: PatchReport | null, patchMarkdown: string,
 *   patchResult: string, audit: string, artifacts: string, artifactsNote: string,
 *   tests: string, hasToken: boolean, issue: string, branch: string, repo: string,
 *   runUrl: string, owner: string, error: string, betaIssues: BetaIssue[],
 *   prefs?: PrefRefresh | null, reexport?: Reexport | null }} Context
 * @typedef {{ state: string, reexported: string[],
 *   refused: { patch: string, reason: string }[] }} Reexport
 * @typedef {{ state: string, refreshed: { pref: string, old: string, new: string }[],
 *   unresolved: string[] }} PrefRefresh
 * @typedef {{ number: number, state: "OPEN" | "CLOSED" }} BetaIssue
 */

/**
 * The bump PR's title, and so its squash commit's subject and changelog line (spec
 * firefox-versions, decision 9): `upstream: firefox 158.0 (MFSA 2026-106)`. Lowercase for
 * commitlint's subject-case; tools/release/firefox-notes.mjs capitalises it and links the IDs.
 * Only IDs of the form `MFSA YYYY-N` reach the subject.
 * @param {string} version
 * @param {{ id: string }[]} [advisories] the advisories that name this release
 */
export function prTitle(version, advisories = []) {
  const ids = advisories.map((a) => a.id).filter((id) => /^MFSA \d{4}-\d+$/.test(id));
  return `upstream: firefox ${version}` + (ids.length ? ` (${ids.join(", ")})` : "");
}

/** @param {string} version */
export function issueTitle(version) {
  return `Firefox ${version} released`;
}

/** @param {string} version */
export function branchName(version) {
  return `upstream/firefox-${version}`;
}

/** @param {string} current */
export function driftTitle(current) {
  return `Vimma's Firefox ${current} is past the security drift limit`;
}

/**
 * Open the PR as a draft unless it can be merged as it stands: every patch imports, the suites
 * passed, and a token is set so that the PR's own CI runs (a PR opened with GITHUB_TOKEN
 * starts no workflows; marking it ready for review does).
 * @param {{ patchResult: string, tests: string, hasToken: boolean,
 *   prefs?: PrefRefresh | null, reexport?: Reexport | null }} c
 * @returns {{ draft: boolean, reason: string }}
 */
export function draftDecision({ patchResult, tests, hasToken, prefs, reexport }) {
  // Fuzz-only patches re-exported by the autopilot (spec upstream-bump-automation, Behaviour 3
  // and 6): the suites did not run on the old patches, so PR CI runs them on the re-export; the
  // PR waits for the owner, never for auto-merge, because the artifact build cannot test every
  // patch (decision 15).
  if (patchResult !== "ok" && reexport?.state === "reexported") {
    if (!hasToken) {
      return { draft: true, reason: "opened with GITHUB_TOKEN: mark it ready to start CI" };
    }
    return { draft: false, reason: "patches re-exported" };
  }
  if (patchResult !== "ok") return { draft: true, reason: "some patches do not apply" };
  if (prefs?.state === "unresolved") {
    return { draft: true, reason: "a copied pref is gone upstream (renamed or removed)" };
  }
  if (tests !== "success") return { draft: true, reason: "the suites did not pass" };
  if (!hasToken) {
    return { draft: true, reason: "opened with GITHUB_TOKEN: mark it ready to start CI" };
  }
  return { draft: false, reason: "all green" };
}

/**
 * @param {PatchReport | null} report
 * @param {string} result ok, fail or norun (upstream.yml's patch-check step)
 */
export function patchLine(report, result) {
  if (!report || !report.ran || result === "norun") {
    return `**did not run**${report?.error ? `: ${oneLine(report.error)}` : ""}; no verdict`;
  }
  const order = ["clean", "offset", "applied", "fuzz", "failed"];
  const counts = order
    .filter((s) => report.counts[s])
    .map((s) => `${report.counts[s]} ${s}`)
    .join(", ");
  const n = report.patches.length;
  return report.ok
    ? `${n} patches apply (${counts})`
    : `**${report.patches.filter((p) => !p.imports).length} of ${n} do not apply** (${counts})`;
}

/**
 * The conflicts section: each patch that `surfer import` would stop at, its upstream files and
 * the hunks that need fuzz or fail. Empty when every patch imports.
 * @param {PatchReport | null} report
 * @returns {string[]}
 */
export function conflictLines(report) {
  if (!report?.ran) return [];
  const bad = report.patches.filter((p) => !p.imports);
  if (bad.length === 0) return [];
  const files = [...new Set(bad.flatMap((p) => p.files))].sort();
  const out = [
    "### Conflicts",
    "",
    `Upstream files to look at: ${files.map((f) => `\`${f}\``).join(", ")}.`,
    "",
  ];
  for (const p of bad) {
    out.push(`- \`${p.patch}\` (${p.status})`);
    for (const m of p.missing) out.push(`  - \`${m}\` is gone upstream`);
    for (const h of p.hunks.filter((x) => x.status === "fuzz" || x.status === "failed")) {
      const what = h.status === "fuzz" ? `applies only with fuzz ${h.fuzz}` : "fails";
      out.push(`  - hunk ${h.index}/${h.of} of \`${h.file}\` \`${codeLine(h.header)}\` ${what}`);
    }
  }
  out.push(
    "",
    "Fix: check out this branch, `npx surfer download --force`, re-make each change in " +
      "`engine/` and `npx surfer export <file>` (docs/rebase.md, step 3). The hunks are in the " +
      "patch check below and in the run's `patch-check` artifact. Then push to this branch: " +
      "PR CI runs the suites again.",
    "",
  );
  return out;
}

/**
 * The "Copied upstream prefs" row (spec upstream-bump-automation, Behaviour 1 and 2).
 * @param {PrefRefresh | null | undefined} prefs
 */
export function prefsLine(prefs) {
  if (!prefs) return "not checked";
  if (prefs.state === "refreshed") {
    return `refreshed ${prefs.refreshed.length} in this commit (below)`;
  }
  if (prefs.state === "unresolved") {
    return `**gone upstream**: ${prefs.unresolved.map((p) => `\`${codeLine(p)}\``).join(", ")}`;
  }
  return "current";
}

/**
 * The "Fuzz re-export" row and list (spec upstream-bump-automation, Behaviour 3).
 * @param {Reexport | null | undefined} r
 */
export function reexportLine(r) {
  if (!r || r.state === "none") return "none needed";
  if (r.state === "reexported") {
    const n = r.reexported.length;
    return `${n} patch${n === 1 ? "" : "es"} re-exported in a second commit (below)`;
  }
  if (r.state === "refused") return "**refused** (added or removed lines would change): see below";
  return "not attempted: a patch fails";
}

/** @param {Reexport | null | undefined} r @param {string} owner */
function reexportLines(r, owner) {
  if (r?.state === "reexported") {
    return [
      "### Re-exported patches",
      "",
      (owner ? `@${owner}: ` : "") +
        "these patches applied only with fuzz; the second commit re-exports them against this " +
        "release with the same added and removed lines. A bump that changes patches is never " +
        "set to auto-merge: review it, and run the full build for C++ or build patches " +
        "(docs/limits.md).",
      "",
      ...r.reexported.map((p) => `- \`${codeLine(p)}\``),
      "",
    ];
  }
  if (r?.state === "refused") {
    return [
      "### Re-export refused",
      "",
      ...r.refused.map((x) => `- \`${codeLine(x.patch)}\`: ${codeLine(x.reason)}`),
      "",
    ];
  }
  return [];
}

/** @param {PrefRefresh | null | undefined} prefs */
function refreshedLines(prefs) {
  if (prefs?.state !== "refreshed") return [];
  return [
    "### Refreshed prefs",
    "",
    "Upstream changed these values; the bump commit carries the derived lines in " +
      "`firefox-branding.js` (docs/rebase.md, step 6):",
    "",
    ...prefs.refreshed.map(
      (p) => `- \`${codeLine(p.pref)}\`: \`${codeLine(p.old)}\` → \`${codeLine(p.new)}\``,
    ),
    "",
  ];
}

/** @param {string} tests @param {Context} c */
export function testsLine(tests, c) {
  if (tests === "success") return "passed (`tests/browser/` and `tests/e2e/`)";
  if (tests === "failure") return "**failed**: see the run's `mochitest (artifact build)` job";
  if (tests === "cancelled") return "**cancelled** (timeout?): see the run";
  if (c.patchResult !== "ok") return "not run: the patches must apply first";
  if (c.artifacts === "no") {
    return "not run: no Mozilla artifacts for this revision (see the full-build path below)";
  }
  return `not run (${tests || "unknown"})`;
}

/** @param {Context} c */
function artifactsLine(c) {
  if (c.artifacts === "yes") return c.artifactsNote || "Mozilla's build is indexed";
  if (c.artifacts === "no") return `**not indexed**: ${c.artifactsNote}`;
  return c.patchResult === "ok"
    ? `not checked: ${c.artifactsNote || "see the run"}`
    : "not checked";
}

/** @param {Detection} d */
function advisoryLines(d) {
  const r = d.release;
  if (r.security === null) {
    return ["Advisories: the MFSA index could not be read; treated as a security release."];
  }
  if (!r.security) {
    return [
      "Advisories: none names this release yet. If Mozilla publishes one later, the next run " +
        "adds the `security` label.",
    ];
  }
  return r.advisories.map((a) => `- [${a.id}](${a.url}): ${a.severity}`);
}

/**
 * The Beta canary's issues for the release's major, as upstream.yml's detect job found them
 * (`gh issue list --json number,state`). Only a positive integer and GitHub's two issue states
 * pass, so nothing else from the list can reach the PR body. Newest first, each once.
 * @param {string} json
 * @returns {BetaIssue[]}
 */
export function betaIssues(json) {
  let list;
  try {
    list = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  /** @type {Map<number, BetaIssue>} */
  const seen = new Map();
  for (const i of list) {
    const ok = Number.isSafeInteger(i?.number) && i.number > 0;
    if (ok && (i.state === "OPEN" || i.state === "CLOSED")) {
      seen.set(i.number, { number: i.number, state: i.state });
    }
  }
  return [...seen.values()].sort((a, b) => b.number - a.number);
}

/**
 * The line naming the Beta canary's issues (spec upstream-beta-canary, decision 11), only for a
 * bump to a new major: the canary tests the Betas of a major, so a dot release within the major
 * Vimma ships has nothing new to show, and its bump of `N.0` already named them.
 * @param {Context} c
 * @returns {string[]}
 */
function betaLines(c) {
  const d = c.detection;
  const major = d.release.version.split(".")[0];
  if (!c.betaIssues.length || major === d.current.split(".")[0]) return [];
  const names = c.betaIssues.map((i) => `#${i.number} (${i.state === "OPEN" ? "open" : "closed"})`);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return [
    `Beta canary: Firefox ${major}'s Betas were reported in ${list}, label \`upstream-beta\`. ` +
      "One closed after a passing run was fixed on `main`; one still open, or closed when this " +
      "release shipped, lists breakage that may remain " +
      '(docs/rebase.md, "Before the release: the Beta canary").',
    "",
  ];
}

/**
 * The bump PR's body.
 * @param {Context} c
 */
export function prBody(c) {
  const d = c.detection;
  const r = d.release;
  const { draft, reason } = draftDecision(c);
  const out = [
    `## Firefox ${d.current} → ${r.version} (${describe(r)})`,
    "",
    `Opened by the upstream autopilot ([run](${c.runUrl})).` +
      (c.issue ? ` Closes #${c.issue}.` : ""),
    "",
    ...betaLines(c),
    "| Check | Result |",
    "| --- | --- |",
    "| Source tarball | SHA-512 matches a `SHA512SUMS` signed by Mozilla's release key |",
    `| Patches (\`surfer import\`) | ${patchLine(c.patchReport, c.patchResult)} |`,
    `| Patch register (ADR-003) | ${c.audit || "not run"} |`,
    `| Artifact build | ${artifactsLine(c)} |`,
    `| Copied upstream prefs | ${prefsLine(c.prefs)} |`,
    `| Fuzz re-export | ${reexportLine(c.reexport)} |`,
    `| Mochitests + e2e on the artifact build | ${testsLine(c.tests, c)} |`,
    "",
    ...refreshedLines(c.prefs),
    ...reexportLines(c.reexport, c.owner),
    "### Advisories",
    "",
    ...advisoryLines(d),
    "",
    ...conflictLines(c.patchReport),
    "### What you do",
    "",
  ];
  if (!draft && reason === "patches re-exported") {
    out.push(
      "PR CI runs the suites on the re-exported patches. Review the second commit and merge " +
        "when green.",
    );
  } else if (!draft) {
    out.push(
      "Everything passed and CI runs on this PR. Review the diff (`surfer.json`) and merge.",
    );
  } else if (reason.startsWith("opened with")) {
    out.push(
      "Everything passed in the autopilot run. Mark this PR **ready for review** (that starts " +
        "`ci.yml` and `e2e.yml` as you), then merge when green.",
    );
  } else {
    out.push(`This is a draft because ${reason}. docs/rebase.md says what to do.`);
  }
  out.push(
    "",
    'After the merge the nightly does the full build and runs the `skip-if = ["artifact"]` ' +
      "tests. The suites include the playbook's prefs checks (cfr provider, Safe Browsing " +
      "lists: `tools/upstream/upstream-prefs.mjs`).",
  );
  if (r.security !== false) {
    out.push(
      "",
      `Security release: merge by ${d.drift.worst?.deadline ?? "the drift deadline"} ` +
        "(docs/security.md, G2), or the drift check fails.",
    );
  }
  const head = out.join("\n") + "\n";
  const detail = c.patchMarkdown.trim()
    ? `\n<details><summary>Patch check</summary>\n\n${c.patchMarkdown.trim()}\n\n</details>\n`
    : "";
  return head.length + detail.length <= BODY_LIMIT
    ? head + detail
    : head +
        "\nThe full patch check is too long for a PR body: see the run's `patch-check` artifact.\n";
}

/**
 * Comment on the tracking issue when GitHub refused to let Actions open the PR.
 * @param {Context} c
 */
export function fallbackBody(c) {
  const v = c.detection.release.version;
  const params = new URLSearchParams({
    expand: "1",
    title: prTitle(v, c.detection.release.advisories),
    body: `Closes #${c.issue}. Summary: the autopilot comment on #${c.issue}.`,
  });
  const compare = `https://github.com/${c.repo}/compare/main...${c.branch}?${params}`;
  return [
    `The autopilot pushed \`${c.branch}\` but could not open the PR: Actions may not create ` +
      "pull requests in this repository (Settings → Actions → General → Workflow permissions → " +
      '"Allow GitHub Actions to create and approve pull requests"; docs/runbook.md).',
    "",
    `**Open it yourself:** [compare main...${c.branch}](${compare}) (title and \`Closes\` line ` +
      "filled in), then mark it ready.",
    c.error ? `\nGitHub said: \`${codeLine(c.error).slice(0, 300)}\`` : "",
    "",
    "---",
    "",
    prBody(c),
  ].join("\n");
}

/**
 * The tracking issue for a new release.
 * @param {Context} c
 */
export function issueBody(c) {
  const d = c.detection;
  const r = d.release;
  const mention = r.security !== false && c.owner ? `@${c.owner} ` : "";
  const deadline = d.drift.unshipped.find((u) => u.version === r.version)?.deadline;
  return [
    `${mention}Firefox ${r.version} was released on ${r.date ?? "an unknown date"}: ` +
      `${describe(r)}. Vimma ships ${d.current}.`,
    "",
    ...advisoryLines(d),
    "",
    `The upstream autopilot ([run](${c.runUrl})) rebases our patches on it, runs the suites ` +
      `and opens a PR on \`${branchName(r.version)}\` that closes this issue (docs/rebase.md).`,
    deadline
      ? `\nDrift limit: merged by ${deadline}, or the drift check fails (docs/security.md, G2).`
      : "",
    "",
    `Labels: ${labelsFor(r)
      .map((l) => `\`${l}\``)
      .join(", ")}.`,
  ].join("\n");
}

/**
 * The drift issue: opened once while Vimma is past a limit; upstream.yml fails every run until
 * surfer.json on main moves.
 * @param {Context} c
 */
export function driftBody(c) {
  const d = c.detection.drift;
  const rows = d.unshipped.map(
    (u) =>
      `| ${u.version} | ${u.date} | ${describe(u)} | ${u.limitDays} d | ${u.deadline} | ` +
      `${u.overdueHours ? `**${u.overdueHours} h over**` : "not yet"} |`,
  );
  return [
    `${c.owner ? `@${c.owner} ` : ""}${driftLine(d)}`,
    "",
    "| Release | Date | Kind | Limit | Deadline | Overdue |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "Merge the open `upstream` PR, or follow docs/rebase.md. `upstream.yml` fails every run " +
      `until \`surfer.json\` on main is past these releases ([run](${c.runUrl})). ` +
      "docs/security.md, G2.",
  ].join("\n");
}

/**
 * One line from patch-audit.py's output: its totals and whether the ADR-003 register matches.
 * @param {string} text
 */
export function auditLine(text) {
  const lines = text.split("\n").map((l) => l.trim());
  const total = lines.find((l) => l.startsWith("Total:"))?.replace(/^Total:\s*/, "");
  if (!total) return "";
  const ok = lines.some((l) => l.startsWith("Register matches"));
  // A table cell (prBody): the totals are escaped, the verdict is ours.
  const verdict = ok ? "register matches" : "**register does not match** (patch-audit.py)";
  return `${oneLine(total)}; ${verdict}`;
}

/**
 * Outside text as one line of plain Markdown, safe in a table cell: every character that could
 * start a link, an HTML tag, emphasis or a code span, or end the cell, is backslash-escaped,
 * the backslash itself first (CodeQL js/incomplete-sanitization: escaping only `|` let `\|`
 * through as an escaped backslash and a live pipe).
 * @param {string} s
 */
function oneLine(s) {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_~[\]<>|]/g, "\\$&");
}

/**
 * Outside text as one line for inside a code span, where Markdown is not read: only a backtick
 * could end the span, so it becomes `'`.
 * @param {string} s
 */
function codeLine(s) {
  return s.replace(/\s+/g, " ").trim().replace(/`/g, "'");
}

/** @param {string | undefined} path */
function readMaybe(path) {
  return path && existsSync(path) ? readFileSync(path, "utf8") : "";
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      detection: { type: "string" },
      "patch-check": { type: "string" },
      "patch-markdown": { type: "string" },
      "patch-result": { type: "string", default: "norun" },
      audit: { type: "string" },
      artifacts: { type: "string", default: "unknown" },
      "artifacts-note": { type: "string", default: "" },
      tests: { type: "string", default: "skipped" },
      "has-token": { type: "string", default: "false" },
      issue: { type: "string", default: "" },
      branch: { type: "string", default: "" },
      repo: { type: "string", default: "" },
      "run-url": { type: "string", default: "" },
      owner: { type: "string", default: "" },
      error: { type: "string" },
      "beta-issues": { type: "string", default: "" },
      prefs: { type: "string" },
      reexport: { type: "string" },
      "draft-only": { type: "boolean", default: false },
    },
  });
  const what = positionals[0];
  if (!values.detection) throw new Error("--detection FILE is required");
  const detection = JSON.parse(readFileSync(values.detection, "utf8"));
  const patchJson = readMaybe(values["patch-check"]);
  /** @type {Context} */
  const c = {
    detection,
    patchReport: patchJson ? JSON.parse(patchJson) : null,
    patchMarkdown: readMaybe(values["patch-markdown"]),
    patchResult: values["patch-result"] ?? "norun",
    audit: auditLine(readMaybe(values.audit)),
    artifacts: values.artifacts ?? "unknown",
    artifactsNote: values["artifacts-note"] ?? "",
    tests: values.tests ?? "skipped",
    hasToken: values["has-token"] === "true",
    issue: values.issue ?? "",
    branch: values.branch || branchName(detection.release.version),
    repo: values.repo ?? "",
    runUrl: values["run-url"] ?? "",
    owner: values.owner ?? "",
    error: readMaybe(values.error),
    betaIssues: betaIssues(values["beta-issues"] ?? ""),
    prefs: readMaybe(values.prefs) ? JSON.parse(readMaybe(values.prefs)) : null,
    reexport: readMaybe(values.reexport) ? JSON.parse(readMaybe(values.reexport)) : null,
  };
  const v = detection.release.version;
  /** @type {Record<string, () => string>} */
  const texts = {
    issue: () => issueBody(c),
    "issue-title": () => issueTitle(v),
    title: () => prTitle(v, detection.release.advisories),
    pr: () => (values["draft-only"] ? String(draftDecision(c).draft) : prBody(c)),
    fallback: () => fallbackBody(c),
    drift: () => driftBody(c),
    "drift-title": () => driftTitle(detection.current),
  };
  const make = texts[what ?? ""];
  if (!make) throw new Error(`unknown text ${what}; one of ${Object.keys(texts).join(", ")}`);
  process.stdout.write(make().replace(/\n*$/, "\n"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`autopilot-body: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
