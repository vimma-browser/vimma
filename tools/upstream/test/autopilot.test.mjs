import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { detect, driftLine, githubOutputText, labelsFor, outputs, summary } from "../detect.mjs";
import {
  BODY_LIMIT,
  auditLine,
  betaIssues,
  branchName,
  conflictLines,
  draftDecision,
  driftBody,
  fallbackBody,
  issueBody,
  issueTitle,
  patchLine,
  prBody,
  prTitle,
  testsLine,
} from "../autopilot-body.mjs";
import { ADVISORIES_URL, RELEASES_URL, VERSIONS_URL } from "../releases.mjs";
import { tempDir } from "../../test/temp-dir.mjs";

const fixtures = fileURLToPath(new URL("fixtures/", import.meta.url));
const read = (/** @type {string} */ name) => readFileSync(join(fixtures, name), "utf8");
const detectScript = fileURLToPath(new URL("../detect.mjs", import.meta.url));
const bodyScript = fileURLToPath(new URL("../autopilot-body.mjs", import.meta.url));

/**
 * Feeds as on the day Firefox 157.0.2 ships with MFSA 2026-105 (critical): the real fixtures
 * plus that release. No network.
 * @param {{ advisory?: boolean, advisoriesDown?: boolean }} [opts]
 */
function feeds({ advisory = true, advisoriesDown = false } = {}) {
  const versions = JSON.parse(read("firefox_versions.json"));
  versions.LATEST_FIREFOX_VERSION = "157.0.2";
  versions.LAST_RELEASE_DATE = "2026-10-13";
  const releases = JSON.parse(read("firefox.json"));
  releases.releases["firefox-157.0.2"] = {
    category: "stability",
    date: "2026-10-13",
    version: "157.0.2",
  };
  let html = read("advisories.html");
  if (advisory) {
    html = html.replace(
      "<main>\n",
      '<main>\n<h2>October 13, 2026</h2>\n<ul><li class="level-item"><a href="/en-US/security/' +
        'advisories/mfsa2026-105/"><span class="level critical">MFSA 2026-105</span> Security ' +
        "Vulnerabilities fixed in Firefox 157.0.2</a></li></ul>\n",
    );
  }
  /** @type {Record<string, string>} */
  const byUrl = {
    [VERSIONS_URL]: JSON.stringify(versions),
    [RELEASES_URL]: JSON.stringify(releases),
    [ADVISORIES_URL]: html,
  };
  return async (/** @type {string} */ url) => {
    if (url === ADVISORIES_URL && advisoriesDown) throw new Error("HTTP 503 from " + url);
    const text = byUrl[url];
    if (text === undefined) throw new Error(`unexpected fetch ${url}`);
    return text;
  };
}

const now = new Date("2026-10-13T15:00:00Z");
const securityRelease = await detect({ current: "157.0.1", fetchText: feeds(), now });

/** A patch-check.py report (version 1): one patch clean, one that fails. */
const failingReport = {
  version: 1,
  ran: true,
  firefox: "157.0.2",
  revision: "a".repeat(40),
  source: "tarball (stdin)",
  ok: false,
  counts: { clean: 1, offset: 0, applied: 0, fuzz: 0, failed: 1 },
  patches: [
    {
      patch: "src/browser/base/moz-build.patch",
      files: ["browser/base/moz.build"],
      status: "clean",
      imports: true,
      missing: [],
      message: "",
      hunks: [
        {
          file: "browser/base/moz.build",
          index: 1,
          of: 1,
          header: "@@ -1,3 +1,4 @@",
          old_start: 1,
          status: "clean",
          offset: 0,
          fuzz: 0,
        },
      ],
    },
    {
      patch: "src/browser/base/content/browser-xhtml.patch",
      files: ["browser/base/content/browser.xhtml"],
      status: "failed",
      imports: false,
      missing: [],
      message: "",
      hunks: [
        {
          file: "browser/base/content/browser.xhtml",
          index: 1,
          of: 2,
          header: "@@ -90,6 +90,7 @@ <html>",
          old_start: 90,
          status: "fuzz",
          offset: 0,
          fuzz: 1,
          text: "@@ -90,6 +90,7 @@\n",
        },
        {
          file: "browser/base/content/browser.xhtml",
          index: 2,
          of: 2,
          header: "@@ -120,6 +121,7 @@",
          old_start: 120,
          status: "failed",
          offset: 0,
          fuzz: 0,
          text: "@@ -120,6 +121,7 @@\n",
        },
      ],
    },
  ],
};
const cleanReport = {
  ...failingReport,
  ok: true,
  counts: { clean: 1, offset: 1, applied: 0, fuzz: 0, failed: 0 },
  patches: [
    failingReport.patches[0],
    {
      ...failingReport.patches[1],
      status: "offset",
      imports: true,
      hunks: [{ ...failingReport.patches[1]?.hunks[0], status: "offset", offset: 3, fuzz: 0 }],
    },
  ],
};

/** @param {Partial<import("../autopilot-body.mjs").Context>} over */
const context = (over = {}) =>
  /** @type {import("../autopilot-body.mjs").Context} */ ({
    detection: securityRelease,
    patchReport: cleanReport,
    patchMarkdown: "### Patch check against Firefox 157.0.2\n",
    patchResult: "ok",
    audit: "10 patches, 11 hunks, +43 -7; register matches",
    artifacts: "yes",
    artifactsNote: "Mozilla's linux64 build of aaaa indexed until 2027-10-13",
    tests: "success",
    hasToken: false,
    issue: "42",
    branch: "upstream/firefox-157.0.2",
    repo: "vimma-browser/vimma",
    runUrl: "https://github.com/vimma-browser/vimma/actions/runs/1",
    owner: "JRanne",
    error: "",
    betaIssues: [],
    ...over,
  });

describe("detect", () => {
  it("finds 157.0.2 as a critical security dot release, 3 days to merge", () => {
    expect(securityRelease).toMatchObject({
      current: "157.0.1",
      latest: "157.0.2",
      newer: true,
      advisoriesError: null,
      release: { version: "157.0.2", kind: "dot", security: true, severity: "critical" },
      drift: {
        status: "behind",
        worst: { version: "157.0.2", deadline: "2026-10-16T00:00:00.000Z" },
      },
    });
  });

  it("outputs what upstream.yml reads: version, labels, drift and the whole result", () => {
    const o = outputs(securityRelease);
    expect(o).toMatchObject({
      version: "157.0.2",
      current: "157.0.1",
      kind: "dot",
      security: "true",
      severity: "critical",
      labels: "upstream,security",
      drift: "behind",
      "drift-version": "157.0.2",
    });
    expect(JSON.parse(o.detection ?? "")).toEqual(securityRelease);
  });

  it("no newer release: an empty version, drift current", async () => {
    const r = await detect({ current: "157.0.2", fetchText: feeds(), now });
    expect(outputs(r)).toMatchObject({ version: "", drift: "current", "drift-version": "" });
    expect(driftLine(r.drift)).toBe("Vimma's Firefox 157.0.2 is the latest release.");
  });

  it("a release without an advisory is labelled upstream only", async () => {
    const r = await detect({ current: "157.0.1", fetchText: feeds({ advisory: false }), now });
    expect(r.release.security).toBe(false);
    expect(labelsFor(r.release)).toEqual(["upstream"]);
    expect(r.drift.worst?.limitDays).toBe(14);
  });

  it("an unreachable advisories page: security unknown, labelled security, a warning", async () => {
    const r = await detect({ current: "157.0.1", fetchText: feeds({ advisoriesDown: true }), now });
    expect(r.advisoriesError).toMatch(/HTTP 503/);
    expect(outputs(r)).toMatchObject({ security: "unknown", labels: "upstream,security" });
    expect(summary(r)).toContain("security is unknown");
  });

  it("an unreachable product-details feed rejects", async () => {
    const fetchText = async () => {
      throw new Error("offline");
    };
    await expect(detect({ current: "157.0.1", fetchText, now })).rejects.toThrow("offline");
  });

  it("past the limit the drift line says by how much", async () => {
    const late = await detect({
      current: "157.0.1",
      fetchText: feeds(),
      now: new Date("2026-10-16T07:00:00Z"),
    });
    expect(late.drift.status).toBe("overdue");
    expect(driftLine(late.drift)).toBe(
      "Vimma ships Firefox 157.0.1, 7 h past the 3-day limit for Firefox 157.0.2 " +
        "(2026-10-13, security dot release, MFSA 2026-105, critical).",
    );
  });

  it("writes GITHUB_OUTPUT heredocs whose delimiter is not in the value", () => {
    expect(githubOutputText({ a: "1", b: "x\nEOF\ny" })).toBe(
      "a<<EOF\n1\nEOF\nb<<EOF_\nx\nEOF\ny\nEOF_\n",
    );
  });

  it("the CLI reads --feeds, prints a summary and appends step outputs (no network)", () => {
    const dir = tempDir("detect-");
    const surfer = join(dir, "surfer.json");
    writeFileSync(surfer, JSON.stringify({ version: { product: "firefox", version: "156.0" } }));
    const out = join(dir, "out");
    const r = spawnSync(
      process.execPath,
      [
        detectScript,
        "--surfer-json",
        surfer,
        "--feeds",
        fixtures,
        "--now",
        "2026-10-10T00:00:00Z",
        "--github-output",
        out,
      ],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Latest release: Firefox 157.0.1 (2026-10-06, security dot release");
    expect(readFileSync(out, "utf8")).toContain("version<<EOF\n157.0.1\nEOF\n");
    expect(readFileSync(out, "utf8")).toContain("drift<<EOF\noverdue\nEOF\n");
  });

  it("the CLI exits 2 when a feed is missing", () => {
    const r = spawnSync(process.execPath, [detectScript, "--feeds", tmpdir() + "/no-such-dir"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^detect: /);
  });
});

describe("autopilot body", () => {
  it("names: PR title, branch, issue title", () => {
    expect(prTitle("157.0.2")).toBe("upstream: firefox 157.0.2");
    expect(branchName("157.0.2")).toBe("upstream/firefox-157.0.2");
    expect(issueTitle("157.0.2")).toBe("Firefox 157.0.2 released");
  });

  // Spec firefox-versions, decision 9: the subject is the changelog line, so it names the
  // advisories; tools/release/firefox-notes.mjs capitalises Firefox and links them.
  it('the PR title lists the advisories: "upstream: firefox 158.0 (MFSA 2026-106)"', () => {
    const a = (/** @type {string} */ id) => ({ id, url: "", severity: "high" });
    expect(prTitle("158.0", [a("MFSA 2026-106")])).toBe("upstream: firefox 158.0 (MFSA 2026-106)");
    expect(prTitle("157.0.3", [a("MFSA 2026-104"), a("MFSA 2026-105")])).toBe(
      "upstream: firefox 157.0.3 (MFSA 2026-104, MFSA 2026-105)",
    );
    expect(prTitle("157.0.2", [])).toBe("upstream: firefox 157.0.2");
    // An ID that is not an MFSA ID never reaches the subject.
    expect(prTitle("158.0", [a("MFSA 2026-106"), a("x) evil")])).toBe(
      "upstream: firefox 158.0 (MFSA 2026-106)",
    );
    expect(securityRelease.release.advisories.map((x) => x.id)).toEqual(["MFSA 2026-105"]);
  });

  it("the PR title passes commitlint with zero, one and three advisories", () => {
    const a = (/** @type {string} */ id) => ({ id, url: "", severity: "high" });
    const titles = [
      prTitle("157.0.2", []),
      prTitle("158.0", [a("MFSA 2026-106")]),
      prTitle("158.0.1", [a("MFSA 2026-107"), a("MFSA 2026-108"), a("MFSA 2026-109")]),
    ];
    for (const title of titles) {
      // The squash commit: the title with GitHub's PR number, then the PR body.
      const run = spawnSync("npx", ["--no-install", "commitlint"], {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        input: `${title} (#200)\n\nBumps Firefox.\n`,
        encoding: "utf8",
      });
      expect(run.status, title + run.stdout + run.stderr).toBe(0);
    }
  });

  it("a ready PR only when patches apply, suites pass and a token starts CI", () => {
    const ok = { patchResult: "ok", tests: "success", hasToken: true };
    expect(draftDecision(ok)).toEqual({ draft: false, reason: "all green" });
    expect(draftDecision({ ...ok, patchResult: "fail" }).draft).toBe(true);
    expect(draftDecision({ ...ok, patchResult: "norun" }).draft).toBe(true);
    expect(draftDecision({ ...ok, tests: "failure" }).draft).toBe(true);
    expect(draftDecision({ ...ok, tests: "skipped" }).draft).toBe(true);
    expect(draftDecision({ ...ok, hasToken: false })).toEqual({
      draft: true,
      reason: "opened with GITHUB_TOKEN: mark it ready to start CI",
    });
  });

  it("the PR body says the tarball matched a SHA512SUMS Mozilla signed", () => {
    expect(prBody(context())).toContain(
      "| Source tarball | SHA-512 matches a `SHA512SUMS` signed by Mozilla's release key |",
    );
  });

  it("summarises the patch check: applies, conflicts, did not run", () => {
    expect(patchLine(cleanReport, "ok")).toBe("2 patches apply (1 clean, 1 offset)");
    expect(patchLine(failingReport, "fail")).toBe("**1 of 2 do not apply** (1 clean, 1 failed)");
    expect(
      patchLine({ ...failingReport, ran: false, error: "cannot read\ntarball" }, "norun"),
    ).toBe("**did not run**: cannot read tarball; no verdict");
    expect(patchLine(null, "norun")).toBe("**did not run**; no verdict");
  });

  it("outside text in a table cell stays one cell of plain text (js/incomplete-sanitization)", () => {
    const error = "a\\|b | [x](https://evil/) <img src=x> *y* `z`\\";
    const line = patchLine({ ...failingReport, ran: false, error }, "norun");
    // An unescaped pipe would end the cell: one preceded by an even run of backslashes.
    expect(line).not.toMatch(/(?:^|[^\\])(?:\\\\)*\|/);
    expect(line).toBe(
      "**did not run**: a\\\\\\|b \\| \\[x\\](https://evil/) \\<img src=x\\> \\*y\\* " +
        "\\`z\\`\\\\; no verdict",
    );
    const audit = auditLine("Total: 1 | 2 \\| <b>\nRegister matches\n");
    expect(audit).toBe("1 \\| 2 \\\\\\| \\<b\\>; register matches");
  });

  it("outside text in a code span cannot close it", () => {
    const report = {
      ...failingReport,
      patches: [
        {
          ...failingReport.patches[1],
          hunks: [{ ...failingReport.patches[1]?.hunks[1], header: "@@ -1 +1 @@ a`b\\` c|d" }],
        },
      ],
    };
    expect(conflictLines(report).join("\n")).toContain("`@@ -1 +1 @@ a'b\\' c|d` fails");
  });

  it("lists the conflicting files and hunks, fuzz included", () => {
    expect(conflictLines(cleanReport)).toEqual([]);
    const lines = conflictLines({
      ...failingReport,
      patches: [
        ...failingReport.patches,
        {
          ...failingReport.patches[0],
          patch: "src/x.patch",
          files: ["a/gone.js"],
          status: "failed",
          imports: false,
          missing: ["a/gone.js"],
          hunks: [],
        },
      ],
    }).join("\n");
    expect(lines).toContain(
      "Upstream files to look at: `a/gone.js`, `browser/base/content/browser.xhtml`.",
    );
    expect(lines).toContain(
      "  - hunk 1/2 of `browser/base/content/browser.xhtml` `@@ -90,6 +90,7 @@ <html>` " +
        "applies only with fuzz 1",
    );
    expect(lines).toContain(
      "  - hunk 2/2 of `browser/base/content/browser.xhtml` `@@ -120,6 +121,7 @@` fails",
    );
    expect(lines).toContain("  - `a/gone.js` is gone upstream");
    expect(lines).not.toContain("moz-build.patch");
  });

  it("says why the suites did not run", () => {
    expect(testsLine("success", context())).toMatch(/^passed/);
    expect(testsLine("failure", context())).toMatch(/^\*\*failed/);
    expect(testsLine("skipped", context({ patchResult: "fail" }))).toMatch(/patches must apply/);
    expect(testsLine("skipped", context({ artifacts: "no" }))).toMatch(/full-build path/);
  });

  it("reads patch-audit.py's totals and register verdict", () => {
    const ok =
      "Patch  Files\nx 1\nTotal: 10 patches, 11 hunks, +43 -7\nRegister matches src/ (10 patches).\n";
    expect(auditLine(ok)).toBe("10 patches, 11 hunks, +43 -7; register matches");
    expect(
      auditLine("Total: 1 patches, 1 hunks, +1 -0\nNot in the ADR-003 register (x):\n  y\n"),
    ).toBe("1 patches, 1 hunks, +1 -0; **register does not match** (patch-audit.py)");
    expect(auditLine("")).toBe("");
  });

  it("a green security bump: table, advisory, what to do, deadline", () => {
    const body = prBody(context());
    expect(body).toContain(
      "## Firefox 157.0.1 → 157.0.2 (security dot release, MFSA 2026-105, critical)",
    );
    expect(body).toContain("Closes #42.");
    expect(body).toContain("| Patches (`surfer import`) | 2 patches apply (1 clean, 1 offset) |");
    expect(body).toContain("| Mochitests + e2e on the artifact build | passed");
    expect(body).toContain(
      "- [MFSA 2026-105](https://www.mozilla.org/en-US/security/advisories/mfsa2026-105/): critical",
    );
    expect(body).toContain("Mark this PR **ready for review**");
    expect(body).toContain("merge by 2026-10-16T00:00:00.000Z");
    expect(body).toContain("<details><summary>Patch check</summary>");
    expect(body).not.toContain("### Conflicts");
  });

  it("a conflicting bump is a draft that lists the conflicts", () => {
    const body = prBody(
      context({ patchReport: failingReport, patchResult: "fail", tests: "skipped" }),
    );
    expect(body).toContain("### Conflicts");
    expect(body).toContain("This is a draft because some patches do not apply.");
    expect(body).toContain("not run: the patches must apply first");
  });

  it("a body over GitHub's limit drops the patch check, not the summary", () => {
    const body = prBody(context({ patchMarkdown: "x".repeat(BODY_LIMIT) }));
    expect(body.length).toBeLessThan(BODY_LIMIT);
    expect(body).toContain("see the run's `patch-check` artifact");
    expect(body).toContain("| Check | Result |");
  });

  it("the fallback comment links a prefilled compare page and keeps the summary", () => {
    const body = fallbackBody(
      context({ error: "GitHub Actions is not permitted to create or approve pull requests" }),
    );
    expect(body).toContain(
      "https://github.com/vimma-browser/vimma/compare/main...upstream/firefox-157.0.2?expand=1&title=upstream%3A+firefox+157.0.2+%28MFSA+2026-105%29&body=Closes+%2342.",
    );
    expect(body).toContain("Allow GitHub Actions to create and approve pull requests");
    expect(body).toContain("GitHub said: `GitHub Actions is not permitted");
    expect(body).toContain("| Check | Result |");
  });

  // Spec upstream-beta-canary, decision 11: the release-day reviewer sees what the Beta canary
  // already reported for the major the bump moves to.
  it("the PR body names the Beta canary's issues for a new major, open and closed", () => {
    const newMajor = { ...securityRelease, current: "156.0.1" };
    const body = prBody(
      context({
        detection: newMajor,
        betaIssues: [
          { number: 230, state: "OPEN" },
          { number: 221, state: "CLOSED" },
        ],
      }),
    );
    expect(body).toContain(
      "Beta canary: Firefox 157's Betas were reported in #230 (open) and #221 (closed), " +
        "label `upstream-beta`. One closed after a passing run was fixed on `main`; one still " +
        "open, or closed when this release shipped, lists breakage that may remain " +
        '(docs/rebase.md, "Before the release: the Beta canary").',
    );
    expect(body.indexOf("Beta canary:")).toBeLessThan(body.indexOf("| Check | Result |"));
    const one = prBody(
      context({ detection: newMajor, betaIssues: [{ number: 230, state: "OPEN" }] }),
    );
    expect(one).toContain("Firefox 157's Betas were reported in #230 (open), label");
  });

  it("no canary issue, or a release within the major Vimma ships: no Beta canary line", () => {
    const newMajor = { ...securityRelease, current: "156.0.1" };
    expect(prBody(context({ detection: newMajor }))).not.toContain("Beta canary");
    // 157.0.1 → 157.0.2: the 157 bump already named them, and they are closed by now
    expect(prBody(context({ betaIssues: [{ number: 221, state: "CLOSED" }] }))).not.toContain(
      "Beta canary",
    );
  });

  it("reads the issue list from upstream.yml and keeps only issue numbers and states", () => {
    expect(betaIssues('[{"number":221,"state":"CLOSED"},{"number":230,"state":"OPEN"}]')).toEqual([
      { number: 230, state: "OPEN" },
      { number: 221, state: "CLOSED" },
    ]);
    expect(betaIssues("")).toEqual([]);
    expect(betaIssues("not json")).toEqual([]);
    expect(betaIssues('{"number":1,"state":"OPEN"}')).toEqual([]);
    expect(
      betaIssues(
        JSON.stringify([
          { number: "230 [x](https://example.com)", state: "OPEN" },
          { number: 0, state: "OPEN" },
          { number: 1.5, state: "OPEN" },
          { number: 7, state: "MERGED" },
          { number: 8, state: "open" },
          { number: 9, state: "OPEN" },
          { number: 9, state: "OPEN" },
        ]),
      ),
    ).toEqual([{ number: 9, state: "OPEN" }]);
  });

  it("the tracking issue mentions the owner for a security release only", async () => {
    const body = issueBody(context());
    expect(body).toMatch(/^@JRanne Firefox 157\.0\.2 was released on 2026-10-13/);
    expect(body).toContain("merged by 2026-10-16T00:00:00.000Z");
    const plain = await detect({ current: "157.0.1", fetchText: feeds({ advisory: false }), now });
    expect(issueBody(context({ detection: plain }))).toMatch(/^Firefox 157\.0\.2 was released/);
  });

  it("the drift issue tables every unshipped release and mentions the owner", async () => {
    const late = await detect({
      current: "157.0.1",
      fetchText: feeds(),
      now: new Date("2026-10-16T07:00:00Z"),
    });
    const body = driftBody(context({ detection: late }));
    expect(body).toMatch(/^@JRanne Vimma ships Firefox 157\.0\.1, 7 h past/);
    expect(body).toContain(
      "| 157.0.2 | 2026-10-13 | security dot release, MFSA 2026-105, critical | 3 d | 2026-10-16T00:00:00.000Z | **7 h over** |",
    );
  });

  it("the CLI renders from files", () => {
    const dir = tempDir("body-");
    const det = join(dir, "d.json");
    writeFileSync(det, JSON.stringify(securityRelease));
    const run = (/** @type {string[]} */ args) =>
      spawnSync(process.execPath, [bodyScript, ...args, "--detection", det], { encoding: "utf8" });
    expect(run(["title"]).stdout).toBe("upstream: firefox 157.0.2 (MFSA 2026-105)\n");
    expect(run(["pr", "--draft-only", "--patch-result", "ok", "--tests", "success"]).stdout).toBe(
      "true\n",
    );
    expect(
      run([
        "pr",
        "--draft-only",
        "--patch-result",
        "ok",
        "--tests",
        "success",
        "--has-token",
        "true",
      ]).stdout,
    ).toBe("false\n");
    const newMajor = join(dir, "major.json");
    writeFileSync(newMajor, JSON.stringify({ ...securityRelease, current: "156.0.1" }));
    const pr = spawnSync(
      process.execPath,
      [
        bodyScript,
        "pr",
        "--detection",
        newMajor,
        "--beta-issues",
        '[{"number":230,"state":"OPEN"}]',
      ],
      { encoding: "utf8" },
    );
    expect(pr.stdout).toContain("Firefox 157's Betas were reported in #230 (open)");
    expect(run(["nope"]).status).toBe(2);
  });
});
