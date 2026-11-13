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
// only shrinks, as each area's move adds the step.
const WORKFLOWS = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));

const RUNNER_NODE = [
  "dependabot-automerge.yml classify",
  "key-guard.yml key-guard",
  "upstream-beta.yml detect",
  "upstream-beta.yml render",
  "upstream-merge.yml merge",
  "upstream.yml detect",
  "upstream.yml drift",
  "upstream.yml patch-issue",
  "upstream.yml publish",
  "upstream.yml track",
];

// Jobs that set up `node-version: 22` rather than .nvmrc's version: the newest 22.x that the
// runner's tool cache or the version manifest has, not the pinned one. Their tools move with the
// last group (#946), which pins them first.
const MAJOR_ONLY = [
  "macos.yml smoke",
  "release.yml ctl",
  "release.yml macos-ctl",
  "release.yml macos-smoke",
  "release.yml mar",
  "release.yml package",
];

// Steps that print a command for a person to run rather than run it.
const PRINTS_ONLY = ["fuzz.yml report"];

type Step = { uses?: string; run?: string; if?: string; with?: Record<string, unknown> };
type Job = { steps?: Step[] };

function workflowJobs(): { name: string; job: Job }[] {
  const out: { name: string; job: Job }[] = [];
  for (const file of readdirSync(WORKFLOWS)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()) {
    const doc = load(readFileSync(WORKFLOWS + file, "utf8"), { schema: CORE_SCHEMA }) as {
      jobs: Record<string, Job>;
    };
    for (const [id, job] of Object.entries(doc.jobs)) out.push({ name: `${file} ${id}`, job });
  }
  return out;
}

/** A shell line that starts Node: `node`, `npm` or `npx` as a command, not inside a word. */
const RUNS_NODE = /(?:^|[\s;&|(`])(?:node|npm|npx)\s/;

function runsNode(step: Step): boolean {
  return (step.run ?? "")
    .split("\n")
    .some((line) => !line.trim().startsWith("#") && RUNS_NODE.test(line));
}

const isAnySetupNode = (s: Step) => (s.uses ?? "").startsWith("actions/setup-node@");
const isSetupNode = (s: Step) => isAnySetupNode(s) && s.with?.["node-version-file"] === ".nvmrc";

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
    expect(onRunnerNode()).toEqual(RUNNER_NODE);
  });

  it("every setup-node step takes .nvmrc's version, but in the listed jobs", () => {
    const loose = workflowJobs()
      .filter(({ job }) => (job.steps ?? []).some((s) => isAnySetupNode(s) && !isSetupNode(s)))
      .map(({ name }) => name)
      .sort();
    expect(loose).toEqual(MAJOR_ONLY);
  });

  it("the command a step only prints is still not run on the runner's Node", () => {
    const fuzz = workflowJobs().find(({ name }) => name === PRINTS_ONLY[0])?.job.steps ?? [];
    const lines = fuzz.flatMap((s) => (s.run ?? "").split("\n")).filter((l) => RUNS_NODE.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.trim()).toMatch(/^echo "/);
  });

  // A setup-node step that skips while the Node step after it runs leaves that step on the
  // runner's Node again.
  it("the setup-node step before a job's first Node step runs whenever that step runs", () => {
    for (const { name, job } of workflowJobs()) {
      const steps = job.steps ?? [];
      const first = steps.findIndex(runsNode);
      const setup = steps.findIndex(isAnySetupNode);
      if (first < 0 || setup < 0 || setup > first) continue;
      const cond = steps[setup]?.if;
      if (cond !== undefined) expect(`${name}: ${cond}`).toBe(`${name}: ${steps[first]?.if}`);
    }
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
