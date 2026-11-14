/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_SCHEMA, load } from "js-yaml";
import { describe, expect, it } from "vitest";

// ADR-025, Consequences: a job that runs `node`, `npm` or `npx` before any actions/setup-node with
// .nvmrc runs on the runner image's own Node, which this repository does not choose and which may
// be older than 22.18, where a .ts tool fails with ERR_UNKNOWN_FILE_EXTENSION. Such a job gets the
// step before its tool can move (#946). RUNNER_NODE lists the jobs that still lack it; the list
// only shrinks, as each area's move adds the step. A `run:` step's text is read, and so is every
// tools/**/*.sh wrapper it names and every wrapper those name: a job that reaches node through a
// script counts as running node. None of these jobs may reach a .ts file, through a wrapper or
// through a .mjs that imports one.
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const WORKFLOWS = join(REPO, ".github/workflows/");

const RUNNER_NODE = [
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

// Jobs whose setup-node runs before a guard (the docs-only classifier, tree-covered), before a
// tool that holds a write token, or before a tool whose answer a job with a write token acts on
// (dependabot-automerge classify, run from the base commit), with no npm install after it.
// actions/setup-node caches automatically when package.json names npm in packageManager or
// devEngines.packageManager (package-manager-cache, true by default), which would read the
// checkout's package.json and .npmrc before the guard, restore ~/.npm and save a cache in the
// post step. Each says package-manager-cache: false, so that a field added to package.json later
// changes nothing here.
const NO_AUTO_CACHE = [
  "ci.yml covered",
  "dependabot-automerge.yml classify",
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

// What a guard job may hold. Each list allows; anything else is refused, not judged: a `run:`
// step of any kind before the guard (a script from the checkout, make, corepack, pnpm, bun, an
// absolute path to node), an action other than the checkout or a checkout not pinned by commit, a
// checkout input that starts a program from the checkout (lfs reads its .lfsconfig, submodules
// fetch what its .gitmodules names), a `shell:` or `working-directory:` on the guard step, and
// environment such as NODE_OPTIONS or BASH_ENV, which make the guard's own node or bash load a
// file from the checkout. Job keys such as container, services, defaults, env or
// continue-on-error, and a workflow's defaults or env, change how every step runs or what its
// failure means, the guard's included.
const BEFORE_GUARD_KEYS = ["name", "id", "if", "uses", "with"];
const CHECKOUT = /^actions\/checkout@[0-9a-f]{40}$/;
const CHECKOUT_INPUTS = ["fetch-depth", "persist-credentials"];
const GUARD_KEYS = ["name", "id", "if", "env", "run"];
// BASE must be the base commit: the guard is read from it.
const GUARD_ENV: Record<string, string> = {
  BASE: "${{ github.event.pull_request.base.sha }}",
  HEAD: "${{ github.event.pull_request.head.sha }}",
  PR_LABELS: "${{ toJSON(github.event.pull_request.labels.*.name) }}",
};
const JOB_KEYS = [
  "name",
  "needs",
  "if",
  "runs-on",
  "timeout-minutes",
  "permissions",
  "outputs",
  "concurrency",
  "steps",
];
const WORKFLOW_KEYS = ["name", "run-name", "on", "permissions", "concurrency", "jobs"];

// The guard steps' exact text. The tests of docs-only.mjs and key-guard.mjs check that each step
// contains its `git show "$BASE:…"` line, which a command appended after it would still pass.
// key-guard.yml cannot change without the key-rotation-approved label anyway (B1); its text is
// pinned here too, so that every guard is held to the same rule.
const DOCS_ONLY_GUARD = `if git show "$BASE:tools/ci/docs-only.mjs" > "$RUNNER_TEMP/docs-only.mjs"; then
  node "$RUNNER_TEMP/docs-only.mjs" --event pull_request --base "$BASE" --head "$HEAD"
else
  echo "No classifier on the base: running everything"
fi
`;
const KEY_GUARD = `guard="$RUNNER_TEMP/key-guard.mjs"
git cat-file -e "$BASE^{commit}" || exit 2
if git cat-file -e "$BASE:tools/ci/key-guard.mjs"; then
  git show "$BASE:tools/ci/key-guard.mjs" > "$guard"
else
  echo "No key guard on the base: running the pull request's copy"
  cp tools/ci/key-guard.mjs "$guard"
fi
node "$guard" --base "$BASE" --head "$HEAD"
`;
const GUARD_RUNS = [DOCS_ONLY_GUARD, KEY_GUARD];

const extra = (o: object | undefined, allowed: string[]) =>
  Object.keys(o ?? {}).filter((k) => !allowed.includes(k));

/** What a job runs before, or around, its guard from the base; empty when the guard runs first. */
function guardFaults(workflow: object, job: Job): string[] {
  const steps = (job.steps ?? []) as (Step & Record<string, unknown>)[];
  const guards = steps.filter(runsBaseGuard);
  if (guards.length === 0) return ["no guard from the base"];
  const faults: string[] = [];
  // A second step with the guard's pattern could pose as the guard and run anything.
  if (guards.length !== 1) faults.push(`guard steps: ${guards.length}`);
  const guard = steps.findIndex(runsBaseGuard);
  const runs = steps.slice(0, guard + 1).filter((s) => "run" in s).length;
  if (runs !== 1) faults.push(`run steps up to the guard: ${runs}`);
  for (const k of extra(workflow, WORKFLOW_KEYS)) faults.push(`workflow ${k}`);
  for (const k of extra(job, JOB_KEYS)) faults.push(`job ${k}`);
  steps.slice(0, guard).forEach((s, i) => {
    if (!CHECKOUT.test(s.uses ?? ""))
      faults.push(`step ${i}: ${(s.uses ?? s.run ?? "").split("\n")[0]}`);
    for (const k of extra(s, BEFORE_GUARD_KEYS)) faults.push(`step ${i} ${k}`);
    for (const k of extra(s.with, CHECKOUT_INPUTS)) faults.push(`step ${i} with ${k}`);
  });
  const g = steps[guard] as Record<string, unknown>;
  for (const k of extra(g, GUARD_KEYS)) faults.push(`guard ${k}`);
  if (!GUARD_RUNS.includes(String(g.run))) faults.push("guard run: not the pinned text");
  for (const [k, v] of Object.entries((g.env as Record<string, unknown> | undefined) ?? {}))
    if (GUARD_ENV[k] !== v) faults.push(`guard env ${k}`);
  return faults;
}

/** A shell line that starts Node: `node`, `npm` or `npx` as a command, not inside a word. */
const RUNS_NODE = /(?:^|[\s;&|(`])(?:node|npm|npx)(?:\s|$)/;

/** A repository file's text, or null when there is none (the tests pass their own files). */
type ReadFile = (path: string) => string | null;
const readRepoFile: ReadFile = (path) => {
  const file = join(REPO, path);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
};

const codeLines = (text: string) => text.split("\n").filter((l) => !l.trim().startsWith("#"));

// A path a shell text names: from the repository root (a workflow step's working directory) or
// from the script's own directory ($here, ${here}, $(dirname "$0"), the form the wrappers use).
const SCRIPT_DIR = String.raw`(?:\$here|\$\{here\}|\$\(dirname "\$0"\)|\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\))/`;
const named = (ext: string) =>
  new RegExp(String.raw`(${SCRIPT_DIR}|\btools/)([\w./-]+?\.(?:${ext}))\b`, "g");
const WRAPPER = named("sh|bash");
const RUNS_NODE_FILE = /(?:^|[\s;&|(`])node\s/;
const SCRIPT_FILE = named("mjs|js|cjs|mts|ts");

/** The repository paths a shell text names with `pattern`, resolved against its script's directory. */
function paths(text: string, dir: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const line of codeLines(text))
    for (const m of line.matchAll(pattern)) {
      const [, from = "", rest = ""] = m;
      out.push(normalize(from === "tools/" ? `tools/${rest}` : join(dir, rest)));
    }
  return out;
}

/** The shell texts a step runs: its `run:` text and each tools wrapper it reaches, with their directories. */
function shellTexts(step: Step, read: ReadFile = readRepoFile): { text: string; dir: string }[] {
  const out = [{ text: step.run ?? "", dir: "." }];
  const seen = new Set<string>();
  for (let i = 0; i < out.length; i++) {
    const { text, dir } = out[i] as { text: string; dir: string };
    for (const path of paths(text, dir, WRAPPER)) {
      if (seen.has(path)) continue;
      seen.add(path);
      const script = read(path);
      // A path inside a container (/repo/tools/…) or in a temporary directory is not one of ours.
      if (script !== null) out.push({ text: script, dir: dirname(path) });
    }
  }
  return out;
}

function runsNode(step: Step, read: ReadFile = readRepoFile): boolean {
  return shellTexts(step, read).some(({ text }) =>
    codeLines(text).some((line) => RUNS_NODE.test(line)),
  );
}

// A relative static import or re-export, or a dynamic import of a literal path.
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;

/** The .ts files a step reaches: run by node directly, or imported by a .mjs or .js it runs. */
function tsReached(step: Step, read: ReadFile = readRepoFile): string[] {
  const files: string[] = [];
  for (const { text, dir } of shellTexts(step, read))
    // Every script a node line names, its arguments included: a wider net than needed.
    for (const line of codeLines(text).filter((l) => RUNS_NODE_FILE.test(l)))
      files.push(...paths(line, dir, SCRIPT_FILE));
  const seen = new Set<string>();
  const ts: string[] = [];
  while (files.length) {
    const file = files.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (/\.m?ts$/.test(file)) ts.push(file);
    const source = read(file);
    if (source === null) continue;
    for (const m of source.matchAll(IMPORT)) files.push(normalize(join(dirname(file), m[1] ?? "")));
  }
  return ts.sort();
}

const isAnySetupNode = (s: Step) => (s.uses ?? "").startsWith("actions/setup-node@");
// With both inputs, setup-node takes `node-version` and only warns, so .nvmrc must stand alone.
const isSetupNode = (s: Step) =>
  isAnySetupNode(s) &&
  s.with?.["node-version-file"] === ".nvmrc" &&
  s.with?.["node-version"] === undefined;

/** Whether a job's first Node step comes before any setup-node step. */
function onRunnerNodeJob(job: Job, read: ReadFile = readRepoFile): boolean {
  const steps = job.steps ?? [];
  const first = steps.findIndex((s) => runsNode(s, read));
  const setup = steps.findIndex(isAnySetupNode);
  return first >= 0 && (setup < 0 || setup > first);
}

/** The jobs whose first Node step comes before any setup-node step. */
function onRunnerNode(): string[] {
  return workflowJobs()
    .filter(({ name, job }) => !PRINTS_ONLY.includes(name) && onRunnerNodeJob(job))
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

  // A job left on the runner's Node fails at once on a .ts tool (ERR_UNKNOWN_FILE_EXTENSION before
  // 22.18), whether a step runs it, a wrapper does, or a .mjs it runs imports it.
  it("no job left on the runner's Node reaches a .ts file", () => {
    const reached = workflowJobs()
      .filter(({ name }) => RUNNER_NODE.includes(name) || BASE_GUARDS.includes(name))
      .map(({ name, job }) => [name, (job.steps ?? []).flatMap((s) => tsReached(s))] as const)
      .filter(([, ts]) => ts.length);
    expect(Object.fromEntries(reached)).toEqual({});
  });

  const WRAPPED: Record<string, string> = {
    "tools/x/check.sh": 'here=$(cd "$(dirname "$0")" && pwd)\nbash "$here/inner.sh" "$1"\n',
    "tools/x/inner.sh": '# node is named in a comment only\nnode "$here/tool.ts" --out x\n',
    "tools/x/quiet.sh": "# node tools/x/tool.ts\nprintf ok\n",
    "tools/x/pre.sh": 'node "$(dirname "$0")/pre.mjs"\n',
    "tools/x/pre.mjs": 'import { a } from "../y/build.mjs";\nexport { b } from "./b.mjs";\n',
    "tools/x/b.mjs": "export const b = 1;\n",
    "tools/y/build.mjs": 'import { c } from "./c.ts";\nexport const a = c;\n',
    "tools/y/c.ts": "export const c = 1;\n",
  };
  const readWrapped: ReadFile = (path) => WRAPPED[path] ?? null;
  const checkout = { uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" };
  const setupNode = { uses: "actions/setup-node@0", with: { "node-version-file": ".nvmrc" } };

  it("follows a tools/**/*.sh wrapper, and the wrappers it runs, to the node it starts", () => {
    const wrapped = { run: 'tools/x/check.sh "$VERSION"' };
    expect(runsNode(wrapped, readWrapped)).toBe(true);
    expect(runsNode({ run: "bash tools/x/quiet.sh" }, readWrapped)).toBe(false);
    expect(runsNode({ run: "tools/x/missing.sh" }, readWrapped)).toBe(false);
    expect(onRunnerNodeJob({ steps: [checkout, wrapped] }, readWrapped)).toBe(true);
    expect(onRunnerNodeJob({ steps: [checkout, setupNode, wrapped] }, readWrapped)).toBe(false);
    expect(tsReached(wrapped, readWrapped)).toEqual(["tools/x/tool.ts"]);
  });

  it("follows a .mjs a step runs through its relative imports to a .ts", () => {
    expect(tsReached({ run: "tools/x/pre.sh" }, readWrapped)).toEqual(["tools/y/c.ts"]);
    expect(tsReached({ run: "node tools/x/b.mjs" }, readWrapped)).toEqual([]);
    expect(tsReached({ run: "node --test tools/y/c.ts" }, readWrapped)).toEqual(["tools/y/c.ts"]);
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
      const first = steps.findIndex((s) => runsNode(s));
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
    expect(
      Object.fromEntries(Object.entries(faults).filter(([, f]) => f.length)),
      "docs/security/14-build-and-release-supply-chain.md B18: only actions/checkout, pinned by commit, with fetch-depth and " +
        "persist-credentials, may come before the guard, and the guard step keeps its pinned " +
        "text and env; move any other step after it",
    ).toEqual({});
  });

  const GUARD = {
    name: "guard",
    env: { BASE: GUARD_ENV.BASE, HEAD: GUARD_ENV.HEAD },
    run: DOCS_ONLY_GUARD,
  };
  const CHECKOUT = {
    uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    with: { "persist-credentials": false },
  };
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
    [
      "a decoy guard",
      { steps: [CHECKOUT, { run: 'git show "$BASE:tools/x"; make' }, GUARD] },
      "guard steps",
    ],
    [
      "a command after the guard's text",
      { steps: [CHECKOUT, { ...GUARD, run: `${DOCS_ONLY_GUARD}make\n` }] },
      "guard run",
    ],
    [
      "BASE taken from the head",
      { steps: [CHECKOUT, { ...GUARD, env: { ...GUARD.env, BASE: GUARD_ENV.HEAD } }] },
      "guard env BASE",
    ],
    [
      "a checkout pinned by tag",
      { steps: [{ ...CHECKOUT, uses: "actions/checkout@v4" }, GUARD] },
      "step 0: actions/checkout@v4",
    ],
    [
      "continue-on-error",
      { "continue-on-error": true, steps: [CHECKOUT, GUARD] },
      "job continue-on-error",
    ],
    ["a merge key", { "<<": { env: { A: "1" } }, steps: [CHECKOUT, GUARD] }, "job <<"],
  ])("refuses %s before or around a guard from the base", (_, job, fault) => {
    expect(guardFaults({}, job as Job).join("; ")).toContain(fault);
  });

  it("refuses a workflow-level defaults or env in a guard's workflow", () => {
    const job = { steps: [CHECKOUT, GUARD] };
    expect(guardFaults({}, job)).toEqual([]);
    expect(guardFaults({ name: "n", on: "pull_request", jobs: {} }, job)).toEqual([]);
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
