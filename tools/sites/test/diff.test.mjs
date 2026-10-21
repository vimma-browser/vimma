import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  MAX_BODY,
  MAX_ITEMS,
  MAX_TEXT,
  compareRuns,
  diffState,
  inertCode,
  issueAction,
  parseRun,
  parseState,
  renderDiff,
  renderIssue,
} from "../diff.mjs";

// docs/specs/site-compat.md, decision 12. The fixtures are results.json files of three nightly
// runs of sites.yml (2026-10-19 to 2026-10-21), with each check's details, the mode steps and the
// screenshot list dropped: the comparison reads none of them.
/** @param {string} day @returns {import("../results.mjs").Run} */
const night = (day) =>
  JSON.parse(readFileSync(new URL(`fixtures/nightly-${day}.json`, import.meta.url), "utf8"));

/**
 * A copy of `run` with `check` of site `id` set to `status` (the site's status follows).
 * @param {import("../results.mjs").Run} run
 * @param {string} id
 * @param {string} check
 * @param {"pass" | "fail" | "skip"} status
 * @param {string} [reason]
 */
function withCheck(run, id, check, status, reason) {
  const copy = structuredClone(run);
  const site = copy.sites.find((s) => s.id === id);
  if (!site) throw new Error(`no site ${id}`);
  site.checks = site.checks.map((c) => (c.id === check ? { id: check, status, reason } : c));
  if (status === "fail") site.status = "fail";
  else if (!site.checks.some((c) => c.status === "fail")) site.status = "ok";
  return copy;
}

/** A copy of `run` with site `id` blocked by a bot check, its checks after load skipped. */
function blocked(/** @type {import("../results.mjs").Run} */ run, /** @type {string} */ id) {
  const copy = structuredClone(run);
  const site = copy.sites.find((s) => s.id === id);
  if (!site) throw new Error(`no site ${id}`);
  site.status = "blocked";
  site.block = { kind: "bot-check", reason: "Cloudflare challenge" };
  site.checks = site.checks.map((c) =>
    c.id === "load" ? c : { id: c.id, status: "skip", reason: "blocked (bot check)" },
  );
  return copy;
}

const key = (/** @type {{ site: string, check: string }} */ r) => `${r.site}/${r.check}`;

describe("compareRuns", () => {
  it("finds no regression between two recorded nights whose failures are the same", () => {
    const diff = compareRuns(night("2026-10-20"), night("2026-10-21"), []);
    expect(diff.baseline).toEqual({ startedAt: "2026-10-20T09:35:30.478Z", commit: "0ee6c71" });
    expect(diff.regressions).toEqual([]);
    expect(diff.tracked).toEqual([]);
    // npm was blocked on the 20th and loaded on the 21st.
    expect(diff.changes).toEqual([{ site: "npm", name: "npmjs.com", from: "blocked", to: "ok" }]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("does not call a failure new when the site could not be checked the night before", () => {
    // YouTube was a harness error on the 19th: its insert and statusbar checks were skipped,
    // then failed on the 20th. A failure never seen to pass is not a regression.
    const diff = compareRuns(night("2026-10-19"), night("2026-10-20"), []);
    expect(diff.regressions).toEqual([]);
    expect(diff.changes).toContainEqual({
      site: "youtube",
      name: "YouTube",
      from: "error",
      to: "fail",
    });
    expect(diff.changes).toContainEqual({
      site: "codepen",
      name: "CodePen",
      from: "fail",
      to: "blocked",
    });
  });

  it("a check that passed and now fails is a regression, with its reason and the page title", () => {
    const cur = withCheck(night("2026-10-21"), "github-pr", "hints", "fail", "no labels");
    const diff = compareRuns(night("2026-10-20"), cur, []);
    expect(diff.regressions).toEqual([
      {
        site: "github-pr",
        name: "GitHub PR",
        check: "hints",
        reason: "no labels",
        title: expect.stringContaining("Pull Request #30000"),
      },
    ]);
    expect(diff.tracked).toEqual([
      {
        site: "github-pr",
        check: "hints",
        since: cur.startedAt,
        reason: "no labels",
        checked: true,
      },
    ]);
    expect(diff.changes).toContainEqual({
      site: "github-pr",
      name: "GitHub PR",
      from: "ok",
      to: "fail",
    });
  });

  it("a tracked regression stays while it fails, and while its site is blocked", () => {
    const first = withCheck(night("2026-10-20"), "mdn", "find", "fail", "0 matches");
    const d1 = compareRuns(night("2026-10-19"), first, []);
    expect(d1.tracked.map(key)).toEqual(["mdn/find"]);

    const still = withCheck(night("2026-10-21"), "mdn", "find", "fail", "0 matches again");
    const d2 = compareRuns(first, still, d1.tracked);
    expect(d2.regressions).toEqual([]);
    expect(d2.tracked).toEqual([
      {
        site: "mdn",
        check: "find",
        since: first.startedAt,
        reason: "0 matches again",
        checked: true,
      },
    ]);

    const d3 = compareRuns(still, blocked(night("2026-10-21"), "mdn"), d2.tracked);
    expect(d3.tracked).toEqual([
      {
        site: "mdn",
        check: "find",
        since: first.startedAt,
        reason: "0 matches again",
        checked: false,
      },
    ]);
  });

  it("a tracked regression goes when its check passes again, and is listed as fixed", () => {
    const failing = withCheck(night("2026-10-20"), "mdn", "find", "fail", "0 matches");
    const tracked = compareRuns(night("2026-10-19"), failing, []).tracked;
    // Blocked in between, then passing: the fix is still seen.
    const blockedNight = blocked(night("2026-10-21"), "mdn");
    const carried = compareRuns(failing, blockedNight, tracked).tracked;
    const diff = compareRuns(blockedNight, night("2026-10-21"), carried);
    expect(diff.tracked).toEqual([]);
    expect(diff.fixed).toContainEqual({ site: "mdn", name: "MDN", check: "find" });
  });

  it("a tracked regression goes when its site leaves the list", () => {
    const failing = withCheck(night("2026-10-20"), "mdn", "find", "fail", "0 matches");
    const tracked = compareRuns(night("2026-10-19"), failing, []).tracked;
    const cur = structuredClone(night("2026-10-21"));
    cur.sites = cur.sites.filter((s) => s.id !== "mdn");
    const diff = compareRuns(failing, cur, tracked);
    expect(diff.tracked).toEqual([]);
    expect(diff.removed).toEqual(["mdn"]);
  });

  it("a filtered run removes no site: the ones it did not run stay tracked, unchecked", () => {
    const failing = withCheck(night("2026-10-20"), "mdn", "find", "fail", "0 matches");
    const tracked = compareRuns(night("2026-10-19"), failing, []).tracked;
    const cur = structuredClone(night("2026-10-21"));
    cur.filter = "github";
    cur.sites = cur.sites.filter((s) => s.id.startsWith("github-"));
    const diff = compareRuns(failing, cur, tracked);
    expect(diff.removed).toEqual([]);
    expect(diff.tracked).toEqual([{ ...tracked[0], checked: false }]);
  });

  it("lists added sites, and does not call a new site's failures regressions", () => {
    const cur = structuredClone(night("2026-10-21"));
    cur.sites.push({
      id: "crates-io",
      name: "crates.io",
      url: "https://crates.io/crates/serde",
      status: "fail",
      checks: [{ id: "load", status: "fail", reason: "timed out" }],
      latency: {},
      screenshots: [],
      durationMs: 1,
    });
    const diff = compareRuns(night("2026-10-21"), cur, []);
    expect(diff.added).toEqual(["crates-io"]);
    expect(diff.regressions).toEqual([]);
  });

  it("with no baseline, compares nothing and tracks nothing", () => {
    const diff = compareRuns(null, night("2026-10-21"), []);
    expect(diff).toEqual({
      baseline: null,
      regressions: [],
      tracked: [],
      fixed: [],
      changes: [],
      added: [],
      removed: [],
    });
  });
});

describe("parseRun and parseState", () => {
  it("accepts the recorded nights", () => {
    for (const day of ["2026-10-19", "2026-10-20", "2026-10-21"]) {
      const { run, problems } = parseRun(night(day));
      expect(problems).toEqual([]);
      expect(run?.sites).toHaveLength(22);
    }
  });

  it("rejects a run of the wrong shape, unknown statuses and check ids, and odd site ids", () => {
    expect(parseRun(null).run).toBeNull();
    expect(parseRun({ sites: "no" }).run).toBeNull();
    const bad = (/** @type {(r: any) => void} */ edit) => {
      const r = structuredClone(night("2026-10-21"));
      edit(r);
      return parseRun(r);
    };
    expect(bad((r) => (r.sites[0].status = "great")).run).toBeNull();
    expect(bad((r) => (r.sites[0].id = "@everyone")).run).toBeNull();
    expect(bad((r) => (r.sites[0].checks[0].id = "evil")).run).toBeNull();
    expect(bad((r) => (r.sites[0].checks[0].status = "maybe")).run).toBeNull();
    expect(bad((r) => (r.sites[0].checks[0].reason = 7)).run).toBeNull();
    expect(bad((r) => (r.startedAt = 1)).problems.length).toBeGreaterThan(0);
  });

  it("accepts a filtered run as the current run", () => {
    const r = structuredClone(night("2026-10-21"));
    r.filter = "github";
    expect(parseRun(r, { baseline: false }).problems).toEqual([]);
  });

  it("treats a filtered run as no baseline", () => {
    const r = structuredClone(night("2026-10-21"));
    r.filter = "github";
    const { run, problems } = parseRun(r);
    expect(run).toBeNull();
    expect(problems.join(" ")).toMatch(/filter/);
  });

  it("round-trips the tracked list through diff.json, and rejects one of the wrong shape", () => {
    const cur = withCheck(night("2026-10-21"), "mdn", "find", "fail", "0 matches");
    const diff = compareRuns(night("2026-10-20"), cur, []);
    const state = JSON.parse(JSON.stringify(diffState(diff, cur)));
    expect(parseState(state)).toEqual({ tracked: diff.tracked, problems: [] });
    expect(parseState({ version: 1, tracked: [{ site: "x y", check: "find" }] }).tracked).toEqual(
      [],
    );
    expect(parseState({ version: 2, tracked: [] }).problems.length).toBeGreaterThan(0);
    expect(parseState(undefined)).toEqual({ tracked: [], problems: [] });
  });
});

describe("issueAction", () => {
  const cur = night("2026-10-21");
  const regressed = compareRuns(
    night("2026-10-20"),
    withCheck(cur, "mdn", "find", "fail", "x"),
    [],
  );
  const carried = compareRuns(
    withCheck(cur, "mdn", "find", "fail", "x"),
    withCheck(cur, "mdn", "find", "fail", "y"),
    regressed.tracked,
  );
  const clean = compareRuns(night("2026-10-20"), cur, []);

  it("opens an issue on a new regression, or updates the open one", () => {
    expect(issueAction(regressed, { scheduled: true, openIssue: null })).toBe("create");
    expect(issueAction(regressed, { scheduled: true, openIssue: 501 })).toBe("update");
  });

  it("updates an open issue while a regression is tracked, and opens none for an old one", () => {
    expect(issueAction(carried, { scheduled: true, openIssue: 501 })).toBe("update");
    // Closed by hand while a regression is still tracked: not reopened until a new one appears.
    expect(issueAction(carried, { scheduled: true, openIssue: null })).toBe("none");
  });

  it("closes the open issue when nothing is tracked", () => {
    expect(issueAction(clean, { scheduled: true, openIssue: 501 })).toBe("close");
    expect(issueAction(clean, { scheduled: true, openIssue: null })).toBe("none");
  });

  it("does nothing for a run that is not scheduled, or one without a baseline", () => {
    expect(issueAction(regressed, { scheduled: false, openIssue: null })).toBe("none");
    expect(issueAction(regressed, { scheduled: false, openIssue: 501 })).toBe("none");
    const none = compareRuns(null, cur, []);
    expect(issueAction(none, { scheduled: true, openIssue: 501 })).toBe("none");
  });
});

describe("inertCode: untrusted text in an issue body", () => {
  it("wraps text in a code span, where GitHub renders no mention, reference, link or HTML", () => {
    expect(inertCode("Pull Request #30000 · neovim/neovim")).toBe(
      "`Pull Request #30000 · neovim/neovim`",
    );
    expect(inertCode("@everyone see https://evil.example/x <img src=x> [a](b) **b**")).toBe(
      "`@everyone see https://evil.example/x <img src=x> [a](b) **b**`",
    );
  });

  it("picks a fence longer than any run of backticks inside, padded at a backtick edge", () => {
    expect(inertCode("a `b` c")).toBe("``a `b` c``");
    expect(inertCode("`x`")).toBe("`` `x` ``");
    expect(inertCode("```")).toBe("```` ``` ````");
  });

  it("puts everything on one line: newlines, control and bidirectional characters", () => {
    expect(inertCode("a\nb\r\n\tc\u0000d‮e⁦f g")).toBe("`a b c d e f g`");
  });

  it("cuts to MAX_TEXT characters, and says when it is empty", () => {
    const out = inertCode("x".repeat(500));
    expect(out).toBe(`\`${"x".repeat(MAX_TEXT - 1)}…\``);
    expect(inertCode("")).toBe("(none)");
    expect(inertCode(undefined)).toBe("(none)");
    // A cut never splits a surrogate pair.
    expect(inertCode("😀".repeat(400))).toBe(`\`${"😀".repeat(MAX_TEXT - 1)}…\``);
  });
});

describe("renderIssue and renderDiff", () => {
  const evil =
    "@octocat closes #1, see vimma-browser/vimma#2 and https://github.com/x/y/issues/3 " +
    "<script>x</script> ![t](https://e.example/p.png)\n## heading";
  const cur = withCheck(night("2026-10-21"), "github-pr", "hints", "fail", evil);
  const site = cur.sites.find((s) => s.id === "github-pr");
  if (site) site.title = evil;
  const diff = compareRuns(night("2026-10-20"), cur, []);
  const runUrl = "https://github.com/vimma-browser/vimma/actions/runs/1";

  /** Text outside code spans: what GitHub would parse for mentions and references. */
  const outsideCode = (/** @type {string} */ md) => md.replace(/(`+)[^`]*?\1/g, "");

  it("lists the new regression with its reason and title, and links the run", () => {
    const body = renderIssue(diff, { action: "create", runUrl });
    expect(body).toContain("GitHub PR");
    expect(body).toContain("hints");
    expect(body).toContain(runUrl);
    expect(body).toContain("2026-10-20");
    expect(body).toContain("0ee6c71");
  });

  it("puts no untrusted text outside a code span", () => {
    for (const body of [renderIssue(diff, { action: "create", runUrl }), renderDiff(diff, cur)]) {
      const outside = outsideCode(body);
      expect(outside).not.toMatch(/@octocat|#1\b|#2\b|issues\/3|<script|!\[|^## heading/m);
      expect(body).toContain("@octocat");
    }
  });

  it("drops a run URL that is not GitHub's", () => {
    const body = renderIssue(diff, { action: "create", runUrl: "https://evil.example/@x" });
    expect(body).not.toContain("evil.example");
  });

  it("caps the list and the body", () => {
    const many = structuredClone(cur);
    for (let i = 0; i < 200; i++) {
      many.sites.push({
        ...structuredClone(night("2026-10-21").sites[0]),
        id: `extra-${i}`,
        name: `Extra ${i}`,
      });
    }
    const failing = structuredClone(many);
    for (const s of failing.sites.filter((x) => x.id.startsWith("extra-"))) {
      s.status = "fail";
      s.checks = s.checks.map((c) =>
        c.status === "pass" ? { id: c.id, status: "fail", reason: "z".repeat(400) } : c,
      );
    }
    const big = compareRuns(many, failing, []);
    expect(big.regressions.length).toBeGreaterThan(MAX_ITEMS);
    const body = renderIssue(big, { action: "update", runUrl });
    expect(body.length).toBeLessThanOrEqual(MAX_BODY);
    expect(body).toMatch(/and \d+ more/);
    expect((body.match(/^- /gm) ?? []).length).toBeLessThanOrEqual(3 * MAX_ITEMS + 3);
  });

  it("says why it closes", () => {
    const clean = compareRuns(cur, night("2026-10-21"), diff.tracked);
    const body = renderIssue(clean, { action: "close", runUrl });
    expect(body).toMatch(/no regression is left/i);
    expect(body).toContain("GitHub PR");
  });

  it("renders the summary diff when nothing changed and when there is no baseline", () => {
    expect(renderDiff(compareRuns(night("2026-10-20"), night("2026-10-21"), []), cur)).toMatch(
      /no new regression/i,
    );
    expect(renderDiff(compareRuns(null, cur, []), cur)).toMatch(/no baseline/i);
  });
});
