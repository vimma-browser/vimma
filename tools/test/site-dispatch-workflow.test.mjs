import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// docs/security.md B15: site-dispatch.yml holds the vimma-site-dispatch app's key and a release
// event runs the tag's copy, so its token must reach vimma-site alone and nothing from the event
// may reach the shell but through env. Text checks, like sites-workflow.test.mjs: no YAML
// dependency.
const text = readFileSync(
  new URL("../../.github/workflows/site-dispatch.yml", import.meta.url),
  "utf8",
);

/** The `with:` block of the step that uses `action`. @param {string} action */
function withOf(action) {
  const start = text.indexOf(`uses: ${action}@`);
  if (start < 0) throw new Error(`no step uses ${action}`);
  const block = /\n {8}with:\n((?: {10}.+\n)+)/.exec(text.slice(start))?.[1] ?? "";
  return Object.fromEntries(
    [...block.matchAll(/^ {10}([\w-]+): (.+)$/gm)].map((m) => [m[1], m[2]?.trim()]),
  );
}

/** Every `run:` script's text: a block's lines without the `run: |` line, or a one-line value. */
function runScripts() {
  const blocks = [...text.matchAll(/\n( +)run: \|\n((?:\1 {2}.*\n|\n)+)/g)].map((m) => m[2] ?? "");
  const lines = [...text.matchAll(/^ +(?:- )?run: (?![|>])(.+)$/gm)].map((m) => m[1] ?? "");
  return [...blocks, ...lines];
}

/** The text of one job under `jobs:`, up to the next job. @param {string} name */
function job(name) {
  const start = text.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`no job ${name}`);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** A job's `permissions:` block as name → level. @param {string} jobText */
function permissionsOf(jobText) {
  const block = /\n {4}permissions:\n((?: {6}[\w-]+: \w+.*\n)+)/.exec(jobText)?.[1] ?? "";
  return Object.fromEntries([...block.matchAll(/^ {6}([\w-]+): (\w+)/gm)].map((m) => [m[1], m[2]]));
}

/** A job's `if:` condition, folded onto one line. @param {string} jobText */
function ifOf(jobText) {
  const m = /\n {4}if: (?:>-\n((?: {6}.*\n)+)|(.*)\n)/.exec(jobText);
  return (m?.[1] ?? m?.[2] ?? "").replace(/\s+/g, " ").trim();
}

/** The job names under `jobs:`. */
function jobNames() {
  const jobs = text.slice(text.indexOf("\njobs:\n"));
  return [...jobs.matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((m) => m[1]);
}

describe("site dispatch workflow (site-dispatch.yml)", () => {
  it("has no permission at the top level, and only start asks for one: actions: write", () => {
    expect(text).toMatch(/^permissions: \{\}$/m);
    expect(jobNames()).toEqual(["start", "dispatch"]);
    expect(text.match(/^\s*permissions:/gm)).toHaveLength(2);
    expect(permissionsOf(job("start"))).toEqual({ actions: "write" });
    expect(job("dispatch")).not.toMatch(/\n {4}permissions:/);
  });

  // docs/security.md B15: a release event runs the tag's copy of this file, which a writer can
  // edit, and an edited copy could push to an auto-merging release-sync branch of vimma-site.
  it("the job that uses the key deploys to site-dispatch and runs only from main", () => {
    const dispatch = job("dispatch");
    expect(dispatch).toContain("secrets.SITE_DISPATCH_APP_KEY");
    expect(dispatch).toMatch(/\n {4}environment: site-dispatch\n/);
    expect(ifOf(dispatch)).toBe(
      "github.repository == 'vimma-browser/vimma' && github.ref == 'refs/heads/main' && " +
        "(github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
    );
  });

  it("the release event never reaches the key: start only starts main's copy", () => {
    const start = job("start");
    expect(ifOf(start)).toBe(
      "github.event_name == 'release' && github.repository == 'vimma-browser/vimma' && " +
        "!github.event.release.prerelease",
    );
    expect(start).not.toContain("secrets.");
    expect(start).not.toContain("environment:");
    expect(start).not.toContain("uses:");
    expect(start).toContain("GH_TOKEN: ${{ github.token }}");
    expect(start).toContain(
      'gh workflow run site-dispatch.yml --repo "$GITHUB_REPOSITORY" --ref main -f release=true',
    );
    expect(text.indexOf("secrets.")).toBeGreaterThan(text.indexOf("\n  dispatch:\n"));
  });

  // GitHub keeps one pending run per concurrency group: the release event's run, which only
  // starts the dispatch, must not share a group with the dispatch it starts or a bindings one.
  it("keeps the release event's run, a release dispatch and a bindings dispatch apart", () => {
    expect(text).toMatch(
      /^concurrency:\n {2}group: site-dispatch-\$\{\{ github\.event_name \}\}-\$\{\{ inputs\.release \|\| 'bindings' \}\}\n {2}cancel-in-progress: false$/m,
    );
  });

  it("mints the app token for vimma-browser/vimma-site alone, with contents: write only", () => {
    const app = withOf("actions/create-github-app-token");
    expect(app).toEqual({
      "client-id": "${{ vars.SITE_DISPATCH_APP_ID }}",
      "private-key": "${{ secrets.SITE_DISPATCH_APP_KEY }}",
      owner: "vimma-browser",
      repositories: "vimma-site",
      "permission-contents": "write",
    });
  });

  it("holds the app's key and no other secret, and no personal token", () => {
    expect([...text.matchAll(/secrets\.(\w+)/g)].map((m) => m[1])).toEqual([
      "SITE_DISPATCH_APP_KEY",
    ]);
    expect(text).not.toContain("SITE_DISPATCH_TOKEN");
  });

  it("pins every action by full commit SHA and checks nothing out", () => {
    const uses = [...text.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
    expect(uses).toHaveLength(1);
    for (const use of uses) expect(use).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
    expect(text).not.toContain("actions/checkout");
  });

  it("sends the dispatch to vimma-site only", () => {
    const targets = [...text.matchAll(/repos\/([\w-]+\/[\w-]+)\//g)].map((m) => m[1]);
    expect(targets).toEqual(["vimma-browser/vimma-site"]);
  });

  it("passes the tag and every event value to run: through env only", () => {
    const scripts = runScripts();
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script).not.toContain("${{");
    expect(text).toMatch(/^ {10}TAG: \$\{\{ github\.event\.release\.tag_name \}\}$/m);
  });

  // A skip that succeeds hid a release the site never heard of; without the app's ID or key the
  // token step fails, so the run goes red.
  it("fails without the app's ID or key instead of skipping the dispatch", () => {
    expect(text).not.toContain("vars.SITE_DISPATCH_APP_ID != ''");
    const script = runScripts().find((run) => run.includes("gh api")) ?? "";
    expect(script).not.toContain("exit 0");
    expect(script).not.toContain("::notice::");
  });

  it("never runs for a pre-release or outside vimma-browser/vimma", () => {
    expect(ifOf(job("start"))).toContain("!github.event.release.prerelease");
    for (const name of jobNames()) {
      expect(ifOf(job(name))).toContain("github.repository == 'vimma-browser/vimma'");
    }
  });
});
