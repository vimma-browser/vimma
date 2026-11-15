import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../test/temp-dir.mjs";
import { BODY_LIMIT, currentBeta, decide, render, title } from "../canary.mjs";

// Spec upstream-beta-canary, B1–B7: what the Beta canary tests and what it writes to its issue.
// The fixtures are real: product-details on 2026-10-14, `tools/upstream/source-check.sh 159.0b1`
// on main's patches (moz-build.patch fails), and suite-results.json of e2e.yml run 38560795339
// (159.0b1 with Firefox 158's patch set: 14 sidebar-theme checks and one e2e screenshot).
/** @param {string} name */
const fixture = (name) => readFileSync(new URL(`fixtures/canary/${name}`, import.meta.url), "utf8");
const versions159 = fixture("firefox_versions-159.0b1.json");
const patchCheck = JSON.parse(fixture("patch-check-159.0b1.json"));
const suites = JSON.parse(fixture("suite-results-159.0b1.json"));

/** @param {Record<string, string>} over */
const versions = (over) => JSON.stringify({ ...JSON.parse(versions159), ...over });
const now = new Date("2026-10-14T12:00:00Z");
const REPO_ID = 1411511592;

/**
 * An artifact as GitHub's Actions API lists it.
 * @param {string} name @param {{ days?: number, branch?: string, id?: number, expired?: boolean,
 *   headRepo?: number }} [o]
 */
const artifact = (name, o = {}) => ({
  id: o.id ?? 1,
  name,
  expired: o.expired ?? false,
  created_at: new Date(now.getTime() - (o.days ?? 1) * 86_400_000).toISOString(),
  workflow_run: {
    id: 500 + (o.id ?? 1),
    head_branch: o.branch ?? "main",
    head_repository_id: o.headRepo ?? REPO_ID,
    repository_id: REPO_ID,
  },
});

/**
 * @param {Record<string, import("../canary.mjs").Artifact[]>} byName artifacts the API returns
 *   for each exact name
 */
const listing = (byName) => async (/** @type {string} */ name) => byName[name] ?? [];

const RUN = "https://github.com/vimma-browser/vimma/actions/runs/1";
/** @param {Partial<Parameters<typeof render>[0]>} over */
const renderWith = (over = {}) =>
  render({
    version: "159.0b1",
    repo: "vimma-browser/vimma",
    sha: "a".repeat(40),
    runUrl: RUN,
    owner: "JRanne",
    patchCheck: null,
    sourceResult: "ok",
    artifacts: "yes",
    artifactsNote: "",
    testResult: "success",
    suiteResults: null,
    previous: null,
    ...over,
  });

/** suite-results.json of a run where every step passed */
const green = {
  version: "159.0b1",
  ok: true,
  steps: Object.fromEntries(
    ["import", "branding", "upstream-prefs", "artifact-build", "mochitest", "e2e"].map((s) => [
      s,
      "success",
    ]),
  ),
  mochitest: { log: true, failures: [] },
  e2e: { passed: 8, failed: [], pending: [] },
};
const passingPatches = {
  ...patchCheck,
  ok: true,
  patches: patchCheck.patches.filter((/** @type {{ imports: boolean }} */ p) => p.imports),
};

describe("canary detect (B1, B2)", () => {
  it("finds 159.0b1 as the current beta of an unreleased Firefox 159", () => {
    expect(currentBeta(versions159)).toEqual({
      version: "159.0b1",
      major: 159,
      releasedMajor: 158,
      reason: "Firefox 159.0b1 is the current Beta",
    });
  });

  it("does nothing when the devel version is not a beta", () => {
    for (const devel of ["160.0a1", "", "159.0b1; rm -rf /", "159.0", "159.1b1"]) {
      const r = currentBeta(versions({ LATEST_FIREFOX_DEVEL_VERSION: devel }));
      expect(r.version, devel).toBe("");
      expect(r.reason, devel).toMatch(/not a Beta version/);
    }
    // product-details unreadable: the canary is broken, the run fails (B9)
    expect(() => currentBeta("<html>")).toThrow();
    expect(() => currentBeta(versions({ LATEST_FIREFOX_VERSION: "" }))).toThrow(/release/);
  });

  it("does nothing for a beta whose major is already released", () => {
    for (const latest of ["159.0", "159.0.1", "160.0"]) {
      const r = currentBeta(versions({ LATEST_FIREFOX_VERSION: latest }));
      expect(r.version, latest).toBe("");
      expect(r.reason).toMatch(/Firefox 159 is already released/);
      expect(r.releasedMajor).toBe(Number(latest.split(".")[0]));
    }
  });

  it("tests a beta build not tested in the last 7 days, skips one tested 2 days ago", async () => {
    const base = { versionsText: versions159, manualVersion: "", repositoryId: REPO_ID, now };
    const fresh = await decide({ ...base, listArtifacts: listing({}) });
    expect(fresh).toMatchObject({ version: "159.0b1", major: "159", run: "true" });
    expect(fresh["released-majors"]).toBe("158");
    expect(fresh["previous-artifact"]).toBe("");

    const recent = await decide({
      ...base,
      listArtifacts: listing({ "upstream-beta-159.0b1": [artifact("upstream-beta-159.0b1")] }),
    });
    expect(recent.run).toBe("false");
    expect(recent.reason).toMatch(/tested 1 day\(s\) ago/);

    const old = await decide({
      ...base,
      listArtifacts: listing({
        "upstream-beta-159.0b1": [artifact("upstream-beta-159.0b1", { days: 8, id: 7 })],
      }),
    });
    expect(old.run).toBe("true");
    // the 8-day-old run is the previous result for B6
    expect(old["previous-artifact"]).toBe("7");
    expect(old["previous-run"]).toBe("507");

    // only main's runs count: a manual run on a branch, a fork's run or an expired artifact
    // does not stop the canary from testing main
    const others = await decide({
      ...base,
      listArtifacts: listing({
        "upstream-beta-159.0b1": [
          artifact("upstream-beta-159.0b1", { branch: "ci/upstream-beta-canary" }),
          artifact("upstream-beta-159.0b1", { headRepo: 99 }),
          artifact("upstream-beta-159.0b1", { expired: true }),
        ],
      }),
    });
    expect(others.run).toBe("true");
    expect(others["previous-artifact"]).toBe("");
  });

  it("the previous result is the newest one of the same Firefox version, any beta build", async () => {
    const r = await decide({
      versionsText: versions({ LATEST_FIREFOX_DEVEL_VERSION: "159.0b3" }),
      manualVersion: "",
      repositoryId: REPO_ID,
      now,
      listArtifacts: listing({
        "upstream-beta-159.0b1": [artifact("upstream-beta-159.0b1", { days: 5, id: 1 })],
        "upstream-beta-159.0b2": [
          artifact("upstream-beta-159.0b2", { days: 3, id: 2 }),
          artifact("upstream-beta-159.0b2", { days: 2, id: 3, branch: "topic" }),
        ],
      }),
    });
    expect(r).toMatchObject({ version: "159.0b3", run: "true", "previous-artifact": "2" });
  });

  it("a manual run with a version always tests it, and rejects a non-beta version", async () => {
    const r = await decide({
      versionsText: versions({ LATEST_FIREFOX_VERSION: "159.0" }),
      manualVersion: "159.0b1",
      repositoryId: REPO_ID,
      now,
      listArtifacts: listing({ "upstream-beta-159.0b1": [artifact("upstream-beta-159.0b1")] }),
    });
    expect(r).toMatchObject({ version: "159.0b1", major: "159", run: "true" });
    expect(r.reason).toMatch(/by hand/);
    for (const bad of ["158.0", "160.0a1", "159.0b1\n", "../159.0b1", "159.0b1 x"]) {
      await expect(
        decide({
          versionsText: versions159,
          manualVersion: bad,
          repositoryId: REPO_ID,
          now,
          listArtifacts: listing({}),
        }),
        JSON.stringify(bad),
      ).rejects.toThrow(/not a Firefox Beta version/);
    }
  });
});

describe("canary render (B5–B7)", () => {
  it('opens an issue titled "Firefox 159 beta: canary findings" when a patch fails', () => {
    const { issue, state } = renderWith({
      patchCheck,
      sourceResult: "fail",
      testResult: "skipped",
    });
    expect(title(159)).toBe("Firefox 159 beta: canary findings");
    expect(issue).toMatchObject({
      version: "159.0b1",
      major: 159,
      title: "Firefox 159 beta: canary findings",
      label: "upstream-beta",
      findings: true,
      action: "open",
      comment: "",
    });
    expect(issue.body).toContain("src/browser/base/moz-build.patch");
    expect(issue.body).toMatch(/Suites \| did not run: 1 patch does not apply/);
    expect(issue.body).toContain(`[run](${RUN})`);
    expect(issue.body).toContain("`releases/mozilla-beta` revision `c0c03f3f8990`");
    expect(issue.body).toContain(
      `[\`aaaaaaaaaaaa\`](https://github.com/vimma-browser/vimma/commit/${"a".repeat(40)})`,
    );
    expect(state).toMatchObject({ version: "159.0b1", major: 159, sha: "a".repeat(40) });
    expect(state.items.map((/** @type {{ key: string }} */ i) => i.key)).toEqual([
      "patch src/browser/base/moz-build.patch",
    ]);
  });

  it("lists failed patches with hunks, failed checks, mochitest and e2e failures", () => {
    const patches = renderWith({ patchCheck, sourceResult: "fail", testResult: "skipped" });
    const body = patches.issue.body;
    // both hunks of moz-build.patch, with git's message on what it searched for
    expect(body).toContain("hunk 1/2 of `browser/base/moz.build` fails");
    expect(body).toContain("hunk 2/2 of `browser/base/moz.build` fails");
    expect(body).toContain('+    "content/vimma",');
    expect(body).toContain("error: patch failed: browser/base/moz.build:72");

    const { issue, state } = renderWith({
      patchCheck: passingPatches,
      testResult: "success",
      suiteResults: {
        ...suites,
        steps: { ...suites.steps, branding: "failure" },
      },
    });
    expect(issue.body).toContain("### Checks");
    expect(issue.body).toContain("- branding prefs (`tools/branding/`): failure");
    // grouped by test: one heading for the 14 checks, the "finished in" line not repeated
    expect(issue.body).toContain("### Mochitests: 14 unexpected results in 1 file");
    expect(issue.body.match(/browser_vimma_sidebar_theme\.js/g)).toHaveLength(1);
    expect(issue.body).not.toContain("finished in");
    expect(issue.body).toContain(
      "the_history_sidebar_follows_a_dark_theme - dark: chrome://browser/content/sidebar/sidebar-history.html the search field is on --vimma-bg",
    );
    expect(issue.body).toContain("### e2e scenarios: 1 of 8 failed");
    expect(issue.body).toContain("m3-private-workspace: 0.59 % of pixels differ (max 0.5 %)");
    const keys = state.items.map((/** @type {{ key: string }} */ i) => i.key);
    expect(keys).toContain("check branding");
    expect(keys).toContain("e2e m3-private-workspace");
    expect(keys.filter((/** @type {string} */ k) => k.startsWith("mochitest "))).toHaveLength(14);
  });

  it("updates the open issue and comments what is new and what is fixed", () => {
    const first = renderWith({ patchCheck, sourceResult: "fail", testResult: "skipped" });
    const second = renderWith({
      version: "159.0b2",
      sha: "b".repeat(40),
      patchCheck: passingPatches,
      suiteResults: { ...suites, version: "159.0b2" },
      testResult: "success",
      previous: first.state,
    });
    expect(second.issue.action).toBe("update");
    expect(second.issue.title).toBe("Firefox 159 beta: canary findings");
    const c = second.issue.comment;
    expect(c).toMatch(/^Firefox 159\.0b2 at `main` \[`bbbbbbbbbbbb`\]/);
    expect(c).toContain("compared with the previous run (159.0b1 at `aaaaaaaaaaaa`)");
    expect(c).toMatch(/\*\*New\*\* \(15\)/);
    expect(c).toMatch(/\*\*Fixed\*\* \(1\)/);
    expect(c).toContain("e2e m3-private-workspace");
    expect(c).toContain("patch src/browser/base/moz-build.patch does not apply");
    // the body is the latest run's alone
    expect(second.issue.body).not.toContain("moz-build.patch");
  });

  it("adds no comment when the results are unchanged", () => {
    const first = renderWith({ patchCheck: passingPatches, suiteResults: suites });
    // a later Beta build and a later main: the timings and screenshot percentages differ
    const again = renderWith({
      version: "159.0b2",
      sha: "c".repeat(40),
      patchCheck: passingPatches,
      suiteResults: JSON.parse(
        JSON.stringify(suites)
          .replace("finished in 1923ms", "finished in 2210ms")
          .replace("0.59 %", "0.61 %"),
      ),
      previous: first.state,
    });
    expect(again.issue.action).toBe("update");
    expect(again.issue.comment).toBe("");
    expect(again.issue.body).toContain("0.61 %");
  });

  it("mentions the owner only when it opens an issue", () => {
    const opened = renderWith({ patchCheck, sourceResult: "fail", testResult: "skipped" });
    expect(opened.issue.openBody).toBe(
      `${opened.issue.body}\n@JRanne: the Beta canary found these on Firefox 159.0b1.\n`,
    );
    const updated = renderWith({
      patchCheck: passingPatches,
      suiteResults: suites,
      previous: opened.state,
    });
    const closed = renderWith({
      patchCheck: passingPatches,
      suiteResults: green,
      previous: updated.state,
    });
    for (const text of [
      opened.issue.body,
      updated.issue.body,
      updated.issue.comment,
      closed.issue.closeComment,
    ]) {
      // a hunk header (`@@ -72,6 …`) inside a fence mentions no one
      expect(outsideFences(text)).not.toContain("@");
    }
    expect(updated.issue.comment).not.toBe("");
    // an owner name that is not a GitHub login is refused, never pasted into the body
    expect(() => renderWith({ owner: "x y" })).toThrow(/owner/);
  });

  it("closes the issue when every patch, check and test passes", () => {
    const failing = renderWith({ patchCheck: passingPatches, suiteResults: suites });
    const r = renderWith({
      version: "159.0b2",
      patchCheck: passingPatches,
      suiteResults: green,
      previous: failing.state,
    });
    expect(r.issue).toMatchObject({ findings: false, action: "close" });
    expect(r.issue.closeComment).toContain("Every patch, check and test passes on Firefox 159.0b2");
    expect(r.issue.closeComment).toContain(`[run](${RUN})`);
    expect(r.state.items).toEqual([]);
    // green with nothing open before: nothing to do
    expect(renderWith({ patchCheck: passingPatches, suiteResults: green }).issue.action).toBe(
      "none",
    );
  });

  it("hands the report job the released major, whose issues it closes (B7)", () => {
    // The report job closes them and links the tracking issue (it holds the issue token):
    // tools/test/upstream-beta-workflow.test.mjs, "closes issues of released versions".
    expect(currentBeta(versions({ LATEST_FIREFOX_VERSION: "159.0" })).releasedMajor).toBe(159);
  });

  it("says the suites did not run when Mozilla's beta build is not indexed", () => {
    const { issue, state } = renderWith({
      patchCheck: passingPatches,
      artifacts: "no",
      artifactsNote: "not in the Taskcluster index",
      testResult: "skipped",
    });
    expect(issue.findings).toBe(true);
    expect(issue.body).toMatch(
      /Suites \| did not run: Mozilla's build of this Beta is not available \(not in the Taskcluster index\)/,
    );
    expect(state.items.map((/** @type {{ key: string }} */ i) => i.key)).toEqual(["artifacts no"]);
    // the e2e job ended without a report (a timeout): that is a finding too
    const lost = renderWith({ patchCheck: passingPatches, testResult: "failure" });
    expect(lost.state.items.map((/** @type {{ key: string }} */ i) => i.key)).toEqual([
      "suites no-report",
    ]);
  });

  it("fences test output and cuts the body to 60,000 characters", () => {
    const message = "@JRanne see [link](https://evil.example) ``` <img src=x>";
    const many = {
      ...suites,
      mochitest: {
        log: true,
        failures: Array.from({ length: 3000 }, (_, i) => ({
          status: "TEST-UNEXPECTED-FAIL",
          test: `browser/t/browser_${i % 40}.js`,
          message: `${message} ${i}`,
        })),
      },
    };
    const { issue } = renderWith({ patchCheck: passingPatches, suiteResults: many });
    expect(BODY_LIMIT).toBe(60_000);
    expect(issue.body.length).toBeLessThanOrEqual(60_000);
    expect(issue.openBody.length).toBeLessThanOrEqual(60_000 + 200);
    expect(issue.body).toContain("Cut to fit an issue");
    expect(issue.body).toContain("artifact `upstream-beta-159.0b1`");
    // every message sits inside a fence longer than any backtick run in it
    const outside = outsideFences(issue.body);
    expect(outside).not.toContain("@JRanne");
    expect(outside).not.toContain("evil.example");
    expect(outside).not.toContain("<img");
    // the fences pair up: the cut never leaves one open
    expect((issue.body.match(/^`{4,}/gm) ?? []).length % 2).toBe(0);
  });
});

describe("canary CLI", () => {
  it("render writes issue.json and state.json from the job's files", () => {
    const dir = tempDir("canary-");
    writeFileSync(join(dir, "patch-check.json"), JSON.stringify(patchCheck));
    const r = spawnSync(
      process.execPath,
      [
        fileURL("../canary.mjs"),
        "render",
        "--version",
        "159.0b1",
        "--repo",
        "vimma-browser/vimma",
        "--sha",
        "a".repeat(40),
        "--run-url",
        RUN,
        "--owner",
        "JRanne",
        "--patch-check",
        join(dir, "patch-check.json"),
        "--source-result",
        "fail",
        "--artifacts",
        "",
        "--test-result",
        "skipped",
        "--suite-results",
        join(dir, "missing.json"),
        "--previous",
        join(dir, "missing-state.json"),
        "--out-dir",
        join(dir, "out"),
      ],
      { encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    const issue = JSON.parse(readFileSync(join(dir, "out", "issue.json"), "utf8"));
    expect(issue).toMatchObject({ action: "open", findings: true });
    const state = JSON.parse(readFileSync(join(dir, "out", "state.json"), "utf8"));
    expect(state.version).toBe("159.0b1");
    expect(r.stdout).toContain("open: Firefox 159 beta: canary findings");
  });

  it("names the branch a manual run tested, and refuses a ref that is not a plain name", () => {
    const { issue } = renderWith({
      ref: "ci/upstream-beta-canary",
      patchCheck,
      sourceResult: "fail",
    });
    expect(issue.body).toContain("tested `ci/upstream-beta-canary` against Firefox 159.0b1");
    expect(issue.body).toContain("| `ci/upstream-beta-canary` tested |");
    expect(() => renderWith({ ref: "a`b" })).toThrow(/bad ref/);
  });

  it("render refuses a version that is not a beta", () => {
    expect(() => renderWith({ version: "159.0" })).toThrow(/not a Firefox Beta version/);
  });
});

/** @param {string} text @returns {string} the Markdown outside fenced blocks */
function outsideFences(text) {
  return text.replace(/^(`{4,})text\n[^]*?\n\1$/gm, "");
}

/** @param {string} rel */
function fileURL(rel) {
  return new URL(rel, import.meta.url).pathname;
}
