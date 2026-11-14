import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { jobs, parseWorkflow, triggers } from "./workflow-runners.mjs";

// Spec upstream-bump-automation, Behaviour 5 (since changed), docs/security/10-firefox-updates.md
// G13 and G14: the bump PR is set to auto-merge only once every check on its head is green.
const dir = new URL("../../.github/workflows/", import.meta.url);
/** @param {string} name */
const read = (name) => readFileSync(new URL(name, dir), "utf8");
const text = read("upstream-merge.yml");
const wf = parseWorkflow(text);
const merge = /** @type {Record<string, any>} */ (jobs(text).get("merge"));
/** @type {Record<string, any>[]} */
const steps = merge?.steps ?? [];
/** @param {string} id */
const stepById = (id) => steps.find((s) => s.id === id) ?? {};

describe("upstream merge workflow (upstream-merge.yml)", () => {
  it("runs when any workflow a pull request starts completes, and on nothing else", () => {
    expect(triggers(text)).toEqual(["workflow_run"]);
    const on = /** @type {Record<string, any>} */ (wf.on).workflow_run;
    expect(on.types).toEqual(["completed"]);
    // A PR workflow missing here would never wake the merge if it finished last.
    const prWorkflows = readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => read(f))
      .filter((t) => triggers(t).includes("pull_request"))
      .map((t) => String(parseWorkflow(t).name))
      .filter((n) => n !== "Dependabot auto-merge")
      .sort();
    expect([...on.workflows].sort()).toEqual(prWorkflows);
  });

  it("acts only on this repository's upstream branches, with the App set up", () => {
    expect(merge.if).toBe(
      "github.repository == 'vimma-browser/vimma' && " +
        "github.event.workflow_run.event == 'pull_request' && " +
        "github.event.workflow_run.head_repository.full_name == github.repository && " +
        "startsWith(github.event.workflow_run.head_branch, 'upstream/firefox-') && " +
        "vars.UPSTREAM_APP_ID != ''",
    );
  });

  it("grants nothing but contents: read and holds only the App's key, in its environment", () => {
    expect(wf.permissions).toEqual({});
    expect(merge.permissions).toEqual({ contents: "read" });
    expect(merge.environment).toBe("upstream-autopilot");
    expect([...text.matchAll(/secrets\.(\w+)/g)].map((m) => m[1])).toEqual(["UPSTREAM_APP_KEY"]);
  });

  it("mints the App token for this repository alone, to write contents and pull requests", () => {
    const app = stepById("app");
    expect(app.uses).toMatch(/^actions\/create-github-app-token@[0-9a-f]{40}$/);
    expect(app.with).toEqual({
      "client-id": "${{ vars.UPSTREAM_APP_ID }}",
      "private-key": "${{ secrets.UPSTREAM_APP_KEY }}",
      owner: "vimma-browser",
      repositories: "vimma",
      "permission-contents": "write",
      "permission-pull-requests": "write",
    });
  });

  it("checks out main's code without credentials", () => {
    const checkout = steps.find((s) => String(s.uses).startsWith("actions/checkout@"));
    expect(checkout?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(checkout?.with).toEqual({ "persist-credentials": false });
  });

  it("reads every run and check of the head, and merges that head only, with the bump's subject", () => {
    const s = stepById("merge");
    expect(s.env).toEqual({
      GH_TOKEN: "${{ steps.app.outputs.token }}",
      BRANCH: "${{ github.event.workflow_run.head_branch }}",
      HEAD: "${{ github.event.workflow_run.head_sha }}",
    });
    const run = String(s.run);
    // Event values reach the shell only through env.
    expect(run).not.toContain("${{");
    expect(run).toContain('actions/runs?head_sha=$HEAD&event=pull_request&per_page=100"');
    expect(run).toContain('commits/$HEAD/check-runs?per_page=100"');
    expect(run).toContain("node tools/upstream/merge-ready.mjs");
    expect(run).toContain(
      'gh pr merge "$number" --auto --squash --match-head-commit "$HEAD" ' +
        '--subject "$title (#$number)" --body-file "$RUNNER_TEMP/body.txt"',
    );
  });

  it("evaluates one head at a time and never cancels an evaluation", () => {
    expect(wf.concurrency).toEqual({
      group: "upstream-merge-${{ github.event.workflow_run.head_sha }}",
      "cancel-in-progress": false,
    });
  });
});
