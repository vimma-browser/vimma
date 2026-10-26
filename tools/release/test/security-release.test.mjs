import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SLOW_CHECKS, commands, decide, gather, slowChecksStarted } from "../security-release.mjs";

// Spec firefox-versions, decisions 11 to 15; docs/security.md G9 and G10. The fixtures are
// recorded API responses: the merge of #186 (upstream: firefox 158.0, labelled security) and
// release PR #347 while it was open.
/** @type {Record<string, any>} */
const recorded = JSON.parse(
  readFileSync(new URL("fixtures/security-release.json", import.meta.url), "utf8"),
);

/**
 * The inputs of a run started by #186's merge with the variable on, with `change` applied.
 * @param {(input: any) => void} [change]
 */
function input(change) {
  const value = structuredClone({
    enabled: "true",
    hasToken: true,
    repository: "vimma-browser/vimma",
    event: "push",
    ref: "refs/heads/main",
    sha: recorded.sha,
    subject: recorded.commit.commit.message.split("\n")[0],
    bumpPulls: recorded.bumpPulls,
    releasePulls: recorded.releasePulls,
    user: recorded.user,
    compare: recorded.compare,
    releases: recorded.releases,
  });
  change?.(value);
  return value;
}

/** @param {ReturnType<typeof decide>} decision */
const skipped = (decision) => (decision.action === "skip" ? decision.reason : decision.action);

describe("decide", () => {
  it("auto-merges the release PR after a merged security bump", () => {
    expect(decide(input())).toEqual({
      action: "merge",
      release: 347,
      head: "cec9a520593c407d909a4a9352865dddb1805496",
      bump: 186,
      ready: false,
    });
  });

  // Issue #443: release-please opens the release PR as a draft, and GitHub never merges a draft,
  // auto-merge or not. Marking it ready through RELEASE_PLEASE_TOKEN starts its full checks.
  it("marks a draft release PR ready for review, then sets it to auto-merge", () => {
    const decision = decide(input((i) => (i.releasePulls[0].draft = true)));
    expect(decision).toMatchObject({ action: "merge", release: 347, ready: true });
    const [ready, merge, comment] = commands(/** @type {any} */ (decision));
    expect(ready).toEqual(["pr", "ready", "347", "--repo", "vimma-browser/vimma"]);
    expect(merge).toEqual([
      "pr",
      "merge",
      "347",
      "--repo",
      "vimma-browser/vimma",
      "--auto",
      "--squash",
      "--match-head-commit",
      "cec9a520593c407d909a4a9352865dddb1805496",
    ]);
    expect(comment?.slice(0, 5)).toEqual(["pr", "comment", "186", "--repo", "vimma-browser/vimma"]);
  });

  // A draft's run reports the slow checks as skipped successes on the head; until the run that
  // "ready for review" starts has replaced them, auto-merge could take them for passes.
  it("sets auto-merge only once the slow checks of the ready run have replaced the draft's", () => {
    expect(SLOW_CHECKS).toEqual([
      "mochitest (artifact build)",
      "semgrep (javascript, typescript, rust, secrets, github-actions)",
    ]);
    /** @param {number} id @param {string} name @param {string} status @param {string | null} conclusion */
    const c = (id, name, status, conclusion) => ({ id, name, status, conclusion });
    const [mochitest, semgrep] = /** @type {[string, string]} */ (SLOW_CHECKS);
    const draft = [c(1, mochitest, "completed", "skipped"), c(2, semgrep, "completed", "skipped")];
    expect(slowChecksStarted(draft)).toBe(false);
    expect(slowChecksStarted([...draft, c(3, mochitest, "queued", null)])).toBe(false);
    expect(
      slowChecksStarted([
        ...draft,
        c(3, mochitest, "queued", null),
        c(4, semgrep, "in_progress", null),
      ]),
    ).toBe(true);
    // the newest run of a name counts, whatever order the API lists them in
    expect(
      slowChecksStarted([
        c(5, mochitest, "completed", "skipped"),
        c(3, mochitest, "queued", null),
        c(4, semgrep, "completed", "success"),
      ]),
    ).toBe(false);
    expect(
      slowChecksStarted([
        c(3, mochitest, "completed", "failure"),
        c(4, semgrep, "completed", "success"),
      ]),
    ).toBe(true);
    expect(slowChecksStarted([])).toBe(false);
  });

  it("leaves a release PR that is already ready as it is", () => {
    for (const draft of [false, undefined]) {
      const decision = decide(input((i) => (i.releasePulls[0].draft = draft)));
      expect(decision).toMatchObject({ action: "merge", ready: false });
      const run = commands(/** @type {any} */ (decision));
      expect(run.map((args) => args[1])).toEqual(["merge", "comment"]);
    }
  });

  it("does nothing when AUTO_SECURITY_RELEASE is off", () => {
    for (const enabled of ["", "false", "TRUE", "1", undefined]) {
      expect(skipped(decide(input((i) => (i.enabled = enabled)))), String(enabled)).toMatch(
        /AUTO_SECURITY_RELEASE/,
      );
    }
    // off wins over a missing token: an unset variable never fails a run
    expect(
      decide(
        input((i) => {
          i.enabled = undefined;
          i.hasToken = false;
        }),
      ).action,
    ).toBe("skip");
  });

  it("does nothing outside a push to main of vimma-browser/vimma", () => {
    expect(skipped(decide(input((i) => (i.repository = "someone/vimma"))))).toMatch(/repository/);
    expect(skipped(decide(input((i) => (i.event = "workflow_dispatch"))))).toMatch(/event/);
    expect(skipped(decide(input((i) => (i.ref = "refs/heads/other"))))).toMatch(/ref/);
  });

  it("does nothing for an upstream bump without the security label", () => {
    const decision = decide(input((i) => (i.bumpPulls[0].labels = [{ name: "upstream" }])));
    expect(skipped(decision)).toMatch(/security/);
    const noUpstream = decide(input((i) => (i.bumpPulls[0].labels = [{ name: "security" }])));
    expect(skipped(noUpstream)).toMatch(/upstream/);
  });

  it("does nothing for a security-labelled PR from another branch or a fork", () => {
    const cases = [
      (/** @type {any} */ i) => (i.bumpPulls[0].head.ref = "feature/firefox-158.0"),
      (/** @type {any} */ i) => (i.bumpPulls[0].head.ref = "upstream/firefox-158.0.1"),
      (/** @type {any} */ i) => (i.bumpPulls[0].head.repo.full_name = "someone/vimma"),
      (/** @type {any} */ i) => (i.bumpPulls[0].head.repo = null),
      (/** @type {any} */ i) => (i.bumpPulls[0].base.ref = "other"),
      (/** @type {any} */ i) => (i.bumpPulls[0].merged_at = null),
      (/** @type {any} */ i) => (i.bumpPulls = []),
      (/** @type {any} */ i) => i.bumpPulls.push({ ...i.bumpPulls[0], number: 187 }),
    ];
    for (const change of cases) expect(decide(input(change)).action, String(change)).toBe("skip");
  });

  it("does nothing for a commit whose subject is not an upstream bump", () => {
    for (const subject of [
      "fix(keys): something (#200)",
      "upstream: Firefox 158.0 (#186)",
      "Upstream: firefox 158.0",
      "chore(main): release 0.1.5 (#347)",
      "upstream: firefox158.0",
    ]) {
      expect(skipped(decide(input((i) => (i.subject = subject)))), subject).toMatch(/subject/);
    }
  });

  it("refuses a release PR with another author, branch, base, label or title", () => {
    const cases = [
      (/** @type {any} */ i) => (i.releasePulls[0].user.login = "github-actions[bot]"),
      (/** @type {any} */ i) => (i.releasePulls[0].head.ref = "release-please--branches--other"),
      (/** @type {any} */ i) => (i.releasePulls[0].head.repo.full_name = "someone/vimma"),
      (/** @type {any} */ i) => (i.releasePulls[0].base.ref = "other"),
      (/** @type {any} */ i) => (i.releasePulls[0].labels = [{ name: "autorelease: tagged" }]),
      (/** @type {any} */ i) => (i.releasePulls[0].title = "chore(main): release 0.1.5 and more"),
      (/** @type {any} */ i) => (i.releasePulls[0].title = "feat: release 0.1.5"),
      (/** @type {any} */ i) => (i.releasePulls[0].state = "closed"),
      (/** @type {any} */ i) => (i.releasePulls = []),
      (/** @type {any} */ i) => i.releasePulls.push({ ...i.releasePulls[0], number: 348 }),
    ];
    for (const change of cases) {
      expect(skipped(decide(input(change))), String(change)).toMatch(/release PR/);
    }
  });

  it("refuses when the release PR does not contain the bump commit", () => {
    for (const status of ["behind", "diverged", undefined]) {
      expect(skipped(decide(input((i) => (i.compare = { status })))), String(status)).toMatch(
        /contain/,
      );
    }
    expect(decide(input((i) => (i.compare = { status: "identical" }))).action).toBe("merge");
  });

  it("refuses before the first release exists", () => {
    expect(skipped(decide(input((i) => (i.releases = []))))).toMatch(/first release/);
  });

  it("pins the merge to the release PR's head commit", () => {
    const decision = decide(input((i) => (i.releasePulls[0].head.sha = "a".repeat(40))));
    expect(decision).toMatchObject({ action: "merge", head: "a".repeat(40) });
    const bad = decide(input((i) => (i.releasePulls[0].head.sha = "main")));
    expect(bad.action).toBe("skip");
  });

  it("fails when the variable is on and RELEASE_PLEASE_TOKEN is missing", () => {
    expect(decide(input((i) => (i.hasToken = false)))).toEqual({
      action: "fail",
      reason: expect.stringMatching(/RELEASE_PLEASE_TOKEN/),
    });
  });
});

describe("gather", () => {
  /** @type {Record<string, unknown>} */
  const responses = {
    [`repos/vimma-browser/vimma/commits/${recorded.sha}`]: recorded.commit,
    [`repos/vimma-browser/vimma/commits/${recorded.sha}/pulls`]: recorded.bumpPulls,
    "repos/vimma-browser/vimma/pulls?state=open&base=main&head=vimma-browser%3Arelease-please--branches--main":
      recorded.releasePulls,
    user: recorded.user,
    [`repos/vimma-browser/vimma/compare/${recorded.sha}...cec9a520593c407d909a4a9352865dddb1805496`]:
      recorded.compare,
    "repos/vimma-browser/vimma/releases?per_page=1": recorded.releases,
  };
  const env = {
    AUTO_SECURITY_RELEASE: "true",
    RELEASE_TOKEN: "x",
    GITHUB_REPOSITORY: "vimma-browser/vimma",
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: recorded.sha,
  };

  it("reads the API responses decide() needs and leads to the merge", async () => {
    /** @type {string[]} */
    const asked = [];
    const api = async (/** @type {string} */ path) => {
      asked.push(path);
      if (!(path in responses)) throw new Error(`unexpected ${path}`);
      return responses[path];
    };
    expect(decide(await gather(env, api))).toMatchObject({ action: "merge", release: 347 });
    expect(asked).toHaveLength(Object.keys(responses).length);
  });

  it("asks the API nothing while the variable is off or outside main", async () => {
    const api = async () => {
      throw new Error("no API call expected");
    };
    expect(decide(await gather({ ...env, AUTO_SECURITY_RELEASE: "" }, api)).action).toBe("skip");
    expect(decide(await gather({ ...env, GITHUB_REF: "refs/heads/x" }, api)).action).toBe("skip");
    expect(decide(await gather({ ...env, RELEASE_TOKEN: "" }, api)).action).toBe("fail");
  });
});
