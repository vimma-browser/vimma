/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_SCHEMA, load } from "js-yaml";
import { describe, expect, it } from "vitest";

// ADR-025, Consequences: a job that runs `node`, `npm` or `npx` before any actions/setup-node with
// .nvmrc runs on the runner image's own Node, which this repository does not choose and which may
// be older than 22.18, where a .ts tool fails with ERR_UNKNOWN_FILE_EXTENSION. Such a job gets the
// step before its tool can move (#946). RUNNER_NODE lists the jobs that still lack it; the list
// only shrinks, as each area's move adds the step. Only `run:` text is read: a tools/**/*.sh
// wrapper that starts node is not followed, so a job that runs one is checked by hand.
const WORKFLOWS = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));

const RUNNER_NODE = [
  "dependabot-automerge.yml classify",
  "upstream-beta.yml detect",
  "upstream-beta.yml render",
  "upstream-merge.yml merge",
  "upstream.yml detect",
  "upstream.yml drift",
  "upstream.yml patch-issue",
  "upstream.yml publish",
  "upstream.yml track",
];

// Steps that print a command for a person to run rather than run it.
const PRINTS_ONLY = ["fuzz.yml report"];

// Jobs whose setup-node runs before a guard (the docs-only classifier, tree-covered) or before a
// tool that holds a write token, with no npm install after it. actions/setup-node caches
// automatically when package.json names npm in packageManager or devEngines.packageManager
// (package-manager-cache, true by default), which would read the checkout's package.json and
// .npmrc before the guard, restore ~/.npm and save a cache in the post step. Each says
// package-manager-cache: false, so that a field added to package.json later changes nothing here.
const NO_AUTO_CACHE = [
  "ci.yml covered",
  "downloads.yml collect",
  "mutation.yml report",
  "pkgbuild.yml covered",
  "semgrep.yml covered",
  "spec-status.yml check",
];

// Jobs that run a guard from the base branch (`git show "$BASE:tools/…"`): the docs-only
// classifier and the Mozilla release key guard. They run it on the runner image's own Node on
// purpose, and stay on it: nothing of the pull request may run in its checkout before the guard,
// and actions/setup-node does (it prints `npm --version` and `yarn --version` there, and a
// package manager reads its configuration from the current directory). So these guards stay
// .mjs (ADR-025, decision 7). Not a list that shrinks.
const BASE_GUARDS = [
  "ci.yml check",
  "ci.yml vimma-ctl-macos",
  "e2e.yml changes",
  "key-guard.yml key-guard",
];

/** A step that runs a tool from the base branch's tree. */
const runsBaseGuard = (s: Step) => /git show "\$BASE:tools\//.test(s.run ?? "");

type Step = { uses?: string; run?: string; if?: string; with?: Record<string, unknown> };
type Job = { steps?: Step[] };
type Workflow = { jobs: Record<string, Job> };

function workflowJobs(): { name: string; job: Job; workflow: Workflow }[] {
  const out: { name: string; job: Job; workflow: Workflow }[] = [];
  for (const file of readdirSync(WORKFLOWS)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()) {
    const workflow = load(readFileSync(WORKFLOWS + file, "utf8"), {
      schema: CORE_SCHEMA,
    }) as Workflow;
    for (const [id, job] of Object.entries(workflow.jobs))
      out.push({ name: `${file} ${id}`, job, workflow });
  }
  return out;
}

// What may come before a guard from the base, and what the guard step itself may carry. Anything
// else is refused, not judged: a `run:` step of any kind (a script from the checkout, make,
// corepack, pnpm, bun, an absolute path to node), an action other than the checkout, a checkout
// input that starts a program from the checkout (lfs reads its .lfsconfig, submodules fetch what
// its .gitmodules names), a `shell:` or `working-directory:` on the guard step, and environment
// such as NODE_OPTIONS or BASH_ENV, which make the guard's own node or bash load a file from the
// checkout. A job-level container, services or defaults, and a workflow-level defaults or env,
// change how every step runs, the guard's included.
const BEFORE_GUARD_KEYS = ["name", "id", "if", "uses", "with"];
const CHECKOUT_INPUTS = ["fetch-depth", "persist-credentials"];
const GUARD_KEYS = ["name", "id", "if", "env", "run"];
const GUARD_ENV = ["BASE", "HEAD", "PR_LABELS"];
const REFUSED_JOB_KEYS = ["container", "services", "defaults", "env"];
const REFUSED_WORKFLOW_KEYS = ["defaults", "env"];

const extra = (o: object | undefined, allowed: string[]) =>
  Object.keys(o ?? {}).filter((k) => !allowed.includes(k));

/** What a job runs before, or around, its guard from the base; empty when the guard runs first. */
function guardFaults(workflow: object, job: Job): string[] {
  const steps = (job.steps ?? []) as (Step & Record<string, unknown>)[];
  const guard = steps.findIndex(runsBaseGuard);
  if (guard < 0) return ["no guard from the base"];
  const faults: string[] = [];
  for (const k of REFUSED_WORKFLOW_KEYS) if (k in workflow) faults.push(`workflow ${k}`);
  for (const k of REFUSED_JOB_KEYS) if (k in job) faults.push(`job ${k}`);
  steps.slice(0, guard).forEach((s, i) => {
    if (!(s.uses ?? "").startsWith("actions/checkout@"))
      faults.push(`step ${i}: ${(s.uses ?? s.run ?? "").split("\n")[0]}`);
    for (const k of extra(s, BEFORE_GUARD_KEYS)) faults.push(`step ${i} ${k}`);
    for (const k of extra(s.with, CHECKOUT_INPUTS)) faults.push(`step ${i} with ${k}`);
  });
  const g = steps[guard] as Record<string, unknown>;
  for (const k of extra(g, GUARD_KEYS)) faults.push(`guard ${k}`);
  for (const k of extra(g.env as object | undefined, GUARD_ENV)) faults.push(`guard env ${k}`);
  return faults;
}

/** A shell line that starts Node: `node`, `npm` or `npx` as a command, not inside a word. */
const RUNS_NODE = /(?:^|[\s;&|(`])(?:node|npm|npx)(?:\s|$)/;

function runsNode(step: Step): boolean {
  return (step.run ?? "")
    .split("\n")
    .some((line) => !line.trim().startsWith("#") && RUNS_NODE.test(line));
}

const isAnySetupNode = (s: Step) => (s.uses ?? "").startsWith("actions/setup-node@");
// With both inputs, setup-node takes `node-version` and only warns, so .nvmrc must stand alone.
const isSetupNode = (s: Step) =>
  isAnySetupNode(s) &&
  s.with?.["node-version-file"] === ".nvmrc" &&
  s.with?.["node-version"] === undefined;

/** The jobs whose first Node step comes before any setup-node step. */
function onRunnerNode(): string[] {
  return workflowJobs()
    .filter(({ name, job }) => {
      if (PRINTS_ONLY.includes(name)) return false;
      const steps = job.steps ?? [];
      const first = steps.findIndex(runsNode);
      const setup = steps.findIndex(isAnySetupNode);
      return first >= 0 && (setup < 0 || setup > first);
    })
    .map(({ name }) => name)
    .sort();
}

/** The paths a sparse checkout keeps (`sparse-checkout:` lines) and whether in cone mode. */
function sparse(step: Step): { paths: string[]; cone: boolean } | null {
  const spec = step.with?.["sparse-checkout"];
  if (typeof spec !== "string") return null;
  const paths = spec
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return { paths, cone: step.with?.["sparse-checkout-cone-mode"] !== false };
}

/**
 * Whether a sparse checkout has a file. Cone mode (git sparse-checkout's default and
 * actions/checkout's) keeps every file under a listed directory and the files directly in each
 * of its parents, the root included; without cone mode only a listed path is kept.
 */
function kept(file: string, { paths, cone }: { paths: string[]; cone: boolean }): boolean {
  if (!cone) return paths.some((p) => p.replace(/^\//, "") === file);
  const dir = dirname(file);
  return (
    dir === "." ||
    paths.some((p) => dir === p || dir.startsWith(`${p}/`) || `${p}/`.startsWith(`${dir}/`))
  );
}

describe("the Node a workflow job runs its tools on", () => {
  it("every job sets up Node before it runs node, npm or npx, but the listed ones", () => {
    expect(onRunnerNode()).toEqual([...RUNNER_NODE, ...BASE_GUARDS].sort());
  });

  // `node-version: 22` would take the newest 22.x in the runner's tool cache or the version
  // manifest, not .nvmrc's: a job that runs a .ts tool on it depends on what the runner has. The
  // last six such jobs (release.yml ctl, package, mar, macos-ctl and macos-smoke, macos.yml smoke)
  // moved to .nvmrc before their tools did (#946); each checks out the built commit first, and
  // every release tag has .nvmrc.
  it("every setup-node step takes .nvmrc's version", () => {
    const loose = workflowJobs()
      .filter(({ job }) => (job.steps ?? []).some((s) => isAnySetupNode(s) && !isSetupNode(s)))
      .map(({ name }) => name)
      .sort();
    expect(loose).toEqual([]);
  });

  it("the command a step only prints is still not run on the runner's Node", () => {
    const fuzz = workflowJobs().find(({ name }) => name === PRINTS_ONLY[0])?.job.steps ?? [];
    const lines = fuzz.flatMap((s) => (s.run ?? "").split("\n")).filter((l) => RUNS_NODE.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.trim()).toMatch(/^echo "/);
  });

  // A setup-node step that skips while the Node step after it runs leaves that step on the
  // runner's Node again: every Node step needs a setup-node before it that runs at least whenever
  // it does (no `if:`, or the same one).
  it("every Node step has a setup-node before it that runs whenever it runs", () => {
    for (const { name, job } of workflowJobs()) {
      if (RUNNER_NODE.includes(name) || PRINTS_ONLY.includes(name)) continue;
      const steps = job.steps ?? [];
      steps.forEach((step, i) => {
        if (!runsNode(step) || runsBaseGuard(step)) return;
        const covered = steps
          .slice(0, i)
          .some((s) => isAnySetupNode(s) && (s.if === undefined || s.if === step.if));
        expect(`${name} step ${i} (${step.if ?? "always"}): ${covered}`).toMatch(/: true$/);
      });
    }
  });

  it("finds node, npm or npx at the end of a line too", () => {
    expect(runsNode({ run: "node" })).toBe(true);
    expect(runsNode({ run: "cat x | npx" })).toBe(true);
    expect(runsNode({ run: "nodes x\n# node x" })).toBe(false);
  });

  it("a setup-node before a guard or a token-holding tool never caches by itself", () => {
    for (const { name, job } of workflowJobs()) {
      if (!NO_AUTO_CACHE.includes(name)) continue;
      const steps = job.steps ?? [];
      const first = steps.findIndex(runsNode);
      const setup = steps.findIndex(isAnySetupNode);
      expect(setup, name).toBeGreaterThanOrEqual(0);
      expect(setup, name).toBeLessThan(first);
      expect(steps[setup]?.with?.cache, name).toBeUndefined();
      expect(steps[setup]?.with?.["package-manager-cache"], name).toBe(false);
      // Yarn 1 on the runner, which setup-node asks for its version, honours this.
      expect((steps[setup] as { env?: Record<string, string> }).env?.YARN_IGNORE_PATH, name).toBe(
        "1",
      );
    }
  });

  // A guard from the base judges the pull request, so nothing the pull request supplies may run
  // before it: only actions/checkout comes first (setup-node runs npm and yarn in the checkout,
  // which read its .npmrc and .yarnrc; any `run:` step may start a program of the checkout).
  // The four jobs fit the rule as they stand, so it has no exceptions.
  it("nothing runs in the pull request's checkout before a guard from the base", () => {
    const faults: Record<string, string[]> = {};
    for (const { name, job, workflow } of workflowJobs())
      if ((job.steps ?? []).some(runsBaseGuard)) faults[name] = guardFaults(workflow, job);
    expect(Object.keys(faults).sort()).toEqual(BASE_GUARDS);
    expect(Object.fromEntries(Object.entries(faults).filter(([, f]) => f.length))).toEqual({});
  });

  const GUARD = {
    name: "guard",
    env: { BASE: "b", HEAD: "h" },
    run: 'git show "$BASE:tools/ci/docs-only.mjs" > g.mjs && node g.mjs',
  };
  const CHECKOUT = { uses: "actions/checkout@0", with: { "persist-credentials": false } };
  const SETUP_NODE = { uses: "actions/setup-node@0", with: { "node-version-file": ".nvmrc" } };
  it.each([
    ["a script from the checkout", { steps: [CHECKOUT, { run: "./tools/x.sh" }, GUARD] }, "step 1"],
    ["bash with a script", { steps: [CHECKOUT, { run: "bash tools/x.sh" }, GUARD] }, "step 1"],
    [
      "python3 with a script",
      { steps: [CHECKOUT, { run: "python3 tools/x.py" }, GUARD] },
      "step 1",
    ],
    ["make", { steps: [CHECKOUT, { run: "make" }, GUARD] }, "step 1"],
    ["corepack", { steps: [CHECKOUT, { run: "corepack enable" }, GUARD] }, "step 1"],
    ["pnpm", { steps: [CHECKOUT, { run: "pnpm --version" }, GUARD] }, "step 1"],
    ["bun", { steps: [CHECKOUT, { run: "bun x tsc" }, GUARD] }, "step 1"],
    ["node by its path", { steps: [CHECKOUT, { run: "/usr/bin/node t.js" }, GUARD] }, "step 1"],
    ["any run step", { steps: [CHECKOUT, { run: "echo hi" }, GUARD] }, "step 1"],
    ["setup-node", { steps: [CHECKOUT, SETUP_NODE, GUARD] }, "step 1"],
    ["a run step first", { steps: [{ run: "ls" }, CHECKOUT, GUARD] }, "step 0"],
    ["a checkout with lfs", { steps: [{ ...CHECKOUT, with: { lfs: true } }, GUARD] }, "with lfs"],
    ["a checkout with env", { steps: [{ ...CHECKOUT, env: { A: "1" } }, GUARD] }, "step 0 env"],
    ["a shell on the guard", { steps: [CHECKOUT, { ...GUARD, shell: "./x {0}" }] }, "guard shell"],
    [
      "a working directory on the guard",
      { steps: [CHECKOUT, { ...GUARD, "working-directory": "tools" }] },
      "guard working-directory",
    ],
    [
      "NODE_OPTIONS on the guard",
      { steps: [CHECKOUT, { ...GUARD, env: { NODE_OPTIONS: "--import ./x.mjs" } }] },
      "guard env NODE_OPTIONS",
    ],
    ["a container", { container: "node:22", steps: [CHECKOUT, GUARD] }, "job container"],
    ["services", { services: { db: { image: "x" } }, steps: [CHECKOUT, GUARD] }, "job services"],
    [
      "a job-level defaults.run",
      { defaults: { run: { shell: "./x {0}" } }, steps: [CHECKOUT, GUARD] },
      "job defaults",
    ],
    ["a job-level env", { env: { BASH_ENV: "./x" }, steps: [CHECKOUT, GUARD] }, "job env"],
  ])("refuses %s before or around a guard from the base", (_, job, fault) => {
    expect(guardFaults({}, job as Job).join("; ")).toContain(fault);
  });

  it("refuses a workflow-level defaults or env in a guard's workflow", () => {
    const job = { steps: [CHECKOUT, GUARD] };
    expect(guardFaults({}, job)).toEqual([]);
    expect(guardFaults({ defaults: { run: { shell: "./x {0}" } } }, job)).toEqual([
      "workflow defaults",
    ]);
    expect(guardFaults({ env: { NODE_OPTIONS: "-r ./x" } }, job)).toEqual(["workflow env"]);
  });

  // A sparse checkout without .nvmrc fails setup-node; one without the tool it runs fails the
  // step. Either is a red run, not a silent pass, but the file it names must move with the tool.
  it("a sparse checkout keeps .nvmrc and every tools/ file the job runs with node", () => {
    let checked = 0;
    for (const { name, job } of workflowJobs()) {
      const steps = job.steps ?? [];
      const spec = steps.map(sparse).find((s) => s !== null);
      if (!spec) continue;
      checked++;
      const files = steps.some(isSetupNode) ? [".nvmrc"] : [];
      for (const s of steps)
        for (const m of (s.run ?? "").matchAll(/\bnode (tools\/\S+)/g)) files.push(m[1] ?? "");
      for (const f of files) expect(`${name} keeps ${f}: ${kept(f, spec)}`).toMatch(/: true$/);
    }
    expect(checked).toBeGreaterThanOrEqual(3); // mutation, pkgbuild and semgrep
  });

  it("reads cone and non-cone sparse checkouts as git does", () => {
    const cone = { paths: ["tools/mutation"], cone: true };
    expect(kept(".nvmrc", cone)).toBe(true);
    expect(kept("tools/mutation/report.ts", cone)).toBe(true);
    expect(kept("tools/repo.mjs", cone)).toBe(true);
    expect(kept("tools/ci/docs-only.mjs", cone)).toBe(false);
    const exact = { paths: ["tools/ci/tree-covered.mjs", ".nvmrc"], cone: false };
    expect(kept(".nvmrc", exact)).toBe(true);
    expect(kept("tools/ci/tree-covered.mjs", exact)).toBe(true);
    expect(kept("tools/ci/docs-only.mjs", exact)).toBe(false);
    expect(kept(".nvmrc", { paths: ["tools/ci/tree-covered.mjs"], cone: false })).toBe(false);
  });
});
