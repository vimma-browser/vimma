import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  OUTSIDER_TRIGGERS,
  jobs,
  runsOn,
  triggers,
  workflowRunnerProblems,
} from "./workflow-runners.mjs";

// js-yaml 5 loads `<<:` as a plain key, as GitHub does: a runs-on that only a merge key supplies
// is no runs-on, and fails here.
// docs/specs/build-supply-chain.md, decision 7; docs/security/14-build-and-release-supply-chain.md,
// B5. On a public repository a self-hosted runner that pull request code can reach is a machine
// anyone can run code on, and Vimma registers no self-hosted runner at all, so no workflow may
// target one.
const dir = new URL("../../.github/workflows/", import.meta.url);
const workflows = readdirSync(dir)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((name) => ({ name, text: readFileSync(new URL(name, dir), "utf8") }));

/** @param {string} name */
const workflow = (name) => workflows.find((w) => w.name === name)?.text ?? "";

/**
 * @param {string} on the `on:` block
 * @param {string} runner the `runs-on:` value
 * @param {string} [extra] more lines of the job
 */
const synthetic = (on, runner, extra = "") =>
  `name: t\non:\n${on}\npermissions: {}\njobs:\n  a:\n    runs-on: ${runner}\n${extra}` +
  "    steps:\n      - run: true\n";

/** @param {string} jobsBlock the lines under `jobs:` */
const onPullRequest = (jobsBlock) =>
  `name: t\non:\n  pull_request:\npermissions: {}\njobs:\n${jobsBlock}`;
const good = "  a:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: true\n";

describe("self-hosted runners: shapes that must fail closed", () => {
  it("a quoted job id is a job of its own", () => {
    const text = onPullRequest(
      good + '  "evil":\n    runs-on: vimma-build\n    steps:\n      - run: true\n',
    );
    expect(workflowRunnerProblems(text)).toHaveLength(1);
    const list = onPullRequest(
      good + '  "evil":\n    runs-on:\n      - self-hosted\n    steps:\n      - run: true\n',
    );
    expect(workflowRunnerProblems(list)).toHaveLength(1);
  });

  it("a job written as a flow mapping is checked", () => {
    const text = onPullRequest(good + "  evil: {runs-on: vimma-build, steps: [{run: x}]}\n");
    expect(workflowRunnerProblems(text)).toHaveLength(1);
  });

  it("a job with two runs-on keys fails", () => {
    const text = onPullRequest(
      "  a:\n    runs-on: ubuntu-24.04\n    runs-on: vimma-build\n    steps:\n      - run: true\n",
    );
    expect(() => workflowRunnerProblems(text)).toThrow(/duplicated mapping key/);
  });

  it("a runs-on that only a `<<:` merge key supplies fails, as GitHub does not merge", () => {
    const text =
      "name: t\non:\n  pull_request:\npermissions: {}\nx-base: &base\n  runs-on: ubuntu-24.04\n" +
      "jobs:\n  a:\n    <<: *base\n    steps:\n      - run: true\n";
    expect(workflowRunnerProblems(text)).toEqual(["a: no runs-on"]);
  });

  it("a matrix key is read only from the job's own strategy.matrix", () => {
    const nested = onPullRequest(
      "  a:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n" +
        "        cfg:\n          - name: x\n            os: [ubuntu-24.04]\n" +
        "        os: [vimma-build]\n    steps:\n      - run: true\n",
    );
    expect(workflowRunnerProblems(nested)).toHaveLength(1);
    const fromJson = onPullRequest(
      "  a:\n    runs-on: ${{ matrix.os }}\n    strategy:\n" +
        "      matrix: ${{ fromJSON(vars.M) }}\n    steps:\n      - run: |\n" +
        "          os: [ubuntu-24.04]\n",
    );
    expect(workflowRunnerProblems(fromJson)).toHaveLength(1);
    const entries = onPullRequest(
      "  a:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n" +
        "        os: [{name: ubuntu-24.04}]\n    steps:\n      - run: true\n",
    );
    expect(workflowRunnerProblems(entries)).toHaveLength(1);
  });

  it("a reusable workflow from another repository fails, a local one is checked as its own file", () => {
    const remote = onPullRequest("  a:\n    uses: someone/repo/.github/workflows/x.yml@main\n");
    expect(workflowRunnerProblems(remote)).toHaveLength(1);
    const local = onPullRequest("  a:\n    uses: ./.github/workflows/e2e.yml\n");
    expect(workflowRunnerProblems(local)).toEqual([]);
    for (const uses of [
      "./.github/workflows/../../x.yml",
      "./.github/workflows/sub/x.yml",
      "./.github/workflows/..yml",
      "./.github/workflows/x.yml@main",
      "./.github/workflows/x.json",
      "./other/x.yml",
    ]) {
      const text = onPullRequest(`  a:\n    uses: ${uses}\n`);
      expect(workflowRunnerProblems(text), uses).toHaveLength(1);
    }
    const yamlExt = onPullRequest("  a:\n    uses: ./.github/workflows/build.release.yaml\n");
    expect(workflowRunnerProblems(yamlExt)).toEqual([]);
  });

  it("triggers are read in every spelling YAML allows", () => {
    const body = "permissions: {}\njobs:\n" + good;
    for (const on of [
      'on:\n  "pull_request":\n',
      "on:\n  pull_request :\n",
      "on: {pull_request: {}, push: {}}\n",
      "on: [push, pull_request]\n",
      "on: pull_request\n",
      "x: &t\n  pull_request:\non: *t\n",
      '"on":\n  pull_request:\n',
    ]) {
      expect(triggers(on + body), on).toContain("pull_request");
    }
  });
});

describe("self-hosted runners", () => {
  it("the parser sees every workflow's triggers and jobs", () => {
    expect(workflows.length).toBeGreaterThan(10);
    for (const { name, text } of workflows) {
      expect(triggers(text).length, name).toBeGreaterThan(0);
      expect(jobs(text).size, name).toBeGreaterThan(0);
    }
    expect(triggers(workflow("ci.yml"))).toContain("pull_request");
    expect(triggers(workflow("e2e.yml"))).toContain("workflow_call");
    expect(runsOn(jobs(workflow("upstream.yml")).get("test") ?? {})).toEqual({
      kind: "reusable",
      uses: "./.github/workflows/e2e.yml",
    });
    // Every job has a runs-on or calls a workflow of this repository: none escapes the checks.
    for (const { name, text } of workflows) {
      for (const [id, job] of jobs(text)) {
        expect(["labels", "expression", "reusable"], `${name} ${id}`).toContain(runsOn(job).kind);
      }
    }
    // A comment in column 0 between jobs does not end the jobs map.
    const commented = synthetic("  pull_request:", "ubuntu-24.04").concat(
      "# a note\n  b:\n    runs-on: self-hosted\n    steps:\n      - run: true\n",
    );
    expect([...jobs(commented).keys()]).toEqual(["a", "b"]);
  });

  it("no workflow an outsider can trigger runs a job on a self-hosted runner", () => {
    const exposed = workflows.filter(({ text }) =>
      triggers(text).some((t) => OUTSIDER_TRIGGERS.has(t)),
    );
    expect(exposed.map((w) => w.name)).toEqual(
      expect.arrayContaining(["ci.yml", "e2e.yml", "claude.yml", "dependabot-automerge.yml"]),
    );
    for (const { name, text } of exposed) expect(workflowRunnerProblems(text), name).toEqual([]);

    for (const runner of [
      "self-hosted",
      "[self-hosted, linux, x64]",
      "vimma-build",
      "ubuntu-24.04-16core",
      "[ubuntu-24.04, gpu]",
    ]) {
      const text = synthetic("  pull_request:", runner);
      expect(workflowRunnerProblems(text), runner).toHaveLength(1);
    }
    const group = synthetic("  issue_comment:", "", "      group: builders\n");
    expect(workflowRunnerProblems(group)).toEqual(["a: a runner group"]);
    const list = synthetic("  workflow_run:", "", "      - self-hosted\n      - linux\n");
    expect(workflowRunnerProblems(list)).toHaveLength(1);
    expect(workflowRunnerProblems(synthetic("  pull_request:", "ubuntu-24.04"))).toEqual([]);
  });

  it("a runs-on expression in such a workflow fails unless it resolves to a hosted image", () => {
    const matrix = (/** @type {string} */ list) =>
      `    strategy:\n      matrix:\n        os: ${list}\n`;
    const hosted = synthetic(
      "  pull_request:",
      "${{ matrix.os }}",
      matrix("[ubuntu-24.04, macos-15]"),
    );
    expect(workflowRunnerProblems(hosted)).toEqual([]);
    const mixed = synthetic(
      "  pull_request:",
      "${{ matrix.os }}",
      matrix("[ubuntu-24.04, self-hosted]"),
    );
    expect(workflowRunnerProblems(mixed)).toHaveLength(1);
    for (const expression of [
      "${{ inputs.runner }}",
      "${{ vars.RUNNER }}",
      "${{ github.event_name == 'push' && 'ubuntu-24.04' || 'vimma-build' }}",
      "${{ matrix.os }}", // no matrix to resolve it against
    ]) {
      const text = synthetic("  pull_request_target:", expression);
      expect(workflowRunnerProblems(text), expression).toHaveLength(1);
    }
    const included = synthetic(
      "  pull_request:",
      "${{ matrix.os }}",
      matrix("[ubuntu-24.04]") + "        include:\n          - os: self-hosted\n",
    );
    expect(workflowRunnerProblems(included)).toHaveLength(1);
  });

  it("no workflow names a self-hosted runner, and both build jobs run on ubuntu-24.04", () => {
    for (const { name, text } of workflows) {
      expect(workflowRunnerProblems(text), name).toEqual([]);
      expect(text, name).not.toMatch(/runs-on:.*self-hosted/);
    }
    for (const name of ["nightly.yml", "release.yml"]) {
      expect(runsOn(jobs(workflow(name)).get("build") ?? {}), name).toEqual({
        kind: "labels",
        labels: ["ubuntu-24.04"],
      });
    }
    // actionlint does not run in CI; the empty list keeps a local run from accepting a label.
    const actionlint = readFileSync(
      new URL("../../.github/actionlint.yaml", import.meta.url),
      "utf8",
    );
    expect(actionlint).toMatch(/^self-hosted-runner:\n {2}labels: \[\]$/m);
  });

  it("each build job runs only from main", () => {
    const nightly = jobs(workflow("nightly.yml")).get("build") ?? {};
    // Then only when the change check did not say skip, or always for a manual run (spec
    // m6a-updater, decision 44): a further limit, never a wider gate.
    expect(nightly.if).toBe(
      "!cancelled() && vars.NIGHTLY_ENABLED == 'true' && ((github.event_name == 'workflow_dispatch' && " +
        "github.ref == 'refs/heads/main') || github.event_name == 'schedule') && " +
        "(github.event_name == 'workflow_dispatch' || needs.changes.result != 'success' || " +
        "needs.changes.outputs.build == 'true')",
    );
    expect(triggers(workflow("nightly.yml")).sort()).toEqual(["schedule", "workflow_dispatch"]);
    const release = jobs(workflow("release.yml")).get("build") ?? {};
    expect(release.if).toBe(
      "vars.RELEASE_ENABLED == 'true' && github.repository == 'vimma-browser/vimma' && " +
        "github.ref == 'refs/heads/main'",
    );
    expect(triggers(workflow("release.yml"))).toEqual(["workflow_dispatch"]);
  });
});
