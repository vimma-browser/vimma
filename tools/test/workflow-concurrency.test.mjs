import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { PR_TRIGGERS, concurrencyGroup, prConcurrencyProblem } from "./workflow-concurrency.mjs";
import { triggers } from "./workflow-runners.mjs";

// Every workflow a pull request triggers cancels the pull request's superseded run, and only
// that run (workflow-concurrency.mjs; docs/runbook.md, "Superseded pull request runs").
const dir = new URL("../../.github/workflows/", import.meta.url);
const workflows = readdirSync(dir)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((name) => ({ name, text: readFileSync(new URL(name, dir), "utf8") }));

/**
 * Workflows that let a superseded pull request run finish, each with its reason.
 * @type {Record<string, string>}
 */
const KEEPS_RUNS = {
  // Its jobs take seconds and turn auto-merge on or leave a comment for the head they ran on, so
  // cancelling one saves nothing; its runs keep their order instead.
  "dependabot-automerge.yml": "seconds-long runs that act on the pull request's merge state",
};

/**
 * @param {string} on the `on:` block
 * @param {string} concurrency the `concurrency:` block, or ""
 */
const synthetic = (on, concurrency) =>
  `name: t\non:\n${on}\npermissions: {}\n${concurrency}jobs:\n  a:\n    runs-on: ubuntu-24.04\n` +
  "    steps:\n      - run: true\n";

describe("pull request concurrency: the rule", () => {
  it("a workflow without a pull request trigger is not checked", () => {
    expect(prConcurrencyProblem(synthetic("  push:\n", ""))).toBeNull();
  });

  it("a pull request workflow needs a concurrency mapping", () => {
    expect(prConcurrencyProblem(synthetic("  pull_request:\n", ""))).toMatch(/no workflow-level/);
    expect(
      prConcurrencyProblem(synthetic("  pull_request:\n", "concurrency: t-${{ github.ref }}\n")),
    ).toMatch(/no workflow-level/);
  });

  it("the group must differ between pull requests", () => {
    const text = synthetic(
      "  pull_request:\n",
      "concurrency:\n  group: t\n  cancel-in-progress: true\n",
    );
    expect(prConcurrencyProblem(text)).toMatch(/no per-pull-request key/);
    const perWorkflow = synthetic(
      "  pull_request:\n",
      "concurrency:\n  group: t-${{ github.workflow }}\n  cancel-in-progress: true\n",
    );
    expect(prConcurrencyProblem(perWorkflow)).toMatch(/no per-pull-request key/);
  });

  it("a pull-request-only workflow may cancel with true", () => {
    for (const key of ["github.ref", "github.event.pull_request.number", "github.head_ref"]) {
      const text = synthetic(
        "  pull_request:\n",
        `concurrency:\n  group: t-\${{ ${key} }}\n  cancel-in-progress: true\n`,
      );
      expect(prConcurrencyProblem(text)).toBeNull();
    }
  });

  it("a workflow with other triggers cancels pull request runs only", () => {
    const on =
      "  push:\n    branches: [main]\n  pull_request:\n  schedule:\n    - cron: '1 1 * * 1'\n";
    const conc = (/** @type {string} */ cancel) =>
      `concurrency:\n  group: t-\${{ github.ref }}\n  cancel-in-progress: ${cancel}\n`;
    expect(prConcurrencyProblem(synthetic(on, conc("true")))).toMatch(
      /also cancels its push, schedule runs/,
    );
    expect(prConcurrencyProblem(synthetic(on, conc("false")))).toMatch(/not cancelled/);
    expect(
      prConcurrencyProblem(synthetic(on, conc("${{ github.event_name == 'pull_request' }}"))),
    ).toBeNull();
    expect(
      prConcurrencyProblem(synthetic(on, conc("${{ github.event_name != 'pull_request' }}"))),
    ).toMatch(/not cancelled/);
  });

  it("an allowlisted workflow keeps its runs, and only it", () => {
    const keep = synthetic(
      "  pull_request:\n",
      "concurrency:\n  group: t-${{ github.ref }}\n  cancel-in-progress: false\n",
    );
    expect(prConcurrencyProblem(keep, { keepsRuns: true })).toBeNull();
    expect(prConcurrencyProblem(keep)).toMatch(/not cancelled/);
  });
});

describe("pull request concurrency: this repository's workflows", () => {
  const prWorkflows = workflows.filter((w) => triggers(w.text).some((e) => PR_TRIGGERS.has(e)));

  it("finds the pull request workflows", () => {
    expect(prWorkflows.map((w) => w.name)).toEqual(
      expect.arrayContaining(["ci.yml", "codeql.yml", "e2e.yml", "semgrep.yml", "pkgbuild.yml"]),
    );
  });

  it.each(prWorkflows.map((w) => [w.name, w.text]))(
    "%s cancels superseded pull request runs, and only those",
    (name, text) => {
      expect(prConcurrencyProblem(text, { keepsRuns: name in KEEPS_RUNS })).toBeNull();
    },
  );

  it("every allowlisted workflow still exists and triggers on pull requests", () => {
    for (const name of Object.keys(KEEPS_RUNS))
      expect(prWorkflows.map((w) => w.name)).toContain(name);
  });

  it("no two workflows share a concurrency group", () => {
    /** @param {string} group */
    const prefix = (group) => group.split("${{")[0];
    const prefixes = workflows
      .map((w) => concurrencyGroup(w.text))
      .filter((g) => g !== null)
      .map(prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
