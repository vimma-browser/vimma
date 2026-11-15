/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CORE_SCHEMA, load } from "js-yaml";
import { describe, expect, it } from "vitest";

// actions/checkout writes the job's token into .git/config unless `persist-credentials: false`,
// and every later step of the job can read it there: in a job a pull request starts, that is the
// pull request's own `npm ci`, scripts and tests. A read-only token still reads the repository
// and its API as the workflow, so no such job keeps it
// (docs/security/14-build-and-release-supply-chain.md, B19). A workflow counts when an event that a
// pull request or a comment on one can start runs it (pull_request*, merge_group, issue_comment,
// workflow_run), or when such a workflow calls it.
const WORKFLOWS = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));
const REACHING = /^(?:pull_request.*|merge_group|issue_comment|workflow_run)$/;

// Checkouts that keep the token, each with its reason. The list only shrinks. Each entry names
// the job that must run before it and that job's condition, which the test below checks.
const KEEPS_CREDENTIALS: Record<string, { reason: string; needs: string; if: RegExp }> = {
  // It pushes the claude/spec-* branch with the checkout's credentials. It runs only after
  // `spec`, which runs only on an `issues` event (the claude:go label), never a pull request's.
  "claude.yml spec-pr": {
    reason: "pushes a branch, on an issues event only",
    needs: "spec",
    if: /^github\.event_name == 'issues' &&/,
  },
};

type Step = { uses?: string; with?: Record<string, unknown> };
type Job = { uses?: string; needs?: string | string[]; if?: string; steps?: Step[] };
type Workflow = { on: unknown; jobs: Record<string, Job> };

function triggers(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  return Object.keys((on as object | null) ?? {});
}

/** The checkouts that keep the token, as "<file> <job>", in the workflows a pull request runs. */
function keptCredentials(workflows: Record<string, Workflow>): string[] {
  const reached = new Set(
    Object.keys(workflows).filter((f) => triggers(workflows[f]?.on).some((t) => REACHING.test(t))),
  );
  // A reusable workflow runs with its caller's event: follow `uses: ./.github/workflows/<file>`.
  for (let grew = true; grew;) {
    grew = false;
    for (const f of [...reached])
      for (const job of Object.values(workflows[f]?.jobs ?? {})) {
        const called = /^\.\/\.github\/workflows\/([^@]+)$/.exec(job.uses ?? "")?.[1];
        if (called && called in workflows && !reached.has(called)) {
          reached.add(called);
          grew = true;
        }
      }
  }
  const out: string[] = [];
  for (const f of [...reached].sort())
    for (const [id, job] of Object.entries(workflows[f]?.jobs ?? {}))
      for (const s of job.steps ?? [])
        if (
          (s.uses ?? "").startsWith("actions/checkout@") &&
          s.with?.["persist-credentials"] !== false
        )
          out.push(`${f} ${id}`);
  return [...new Set(out)];
}

function repoWorkflows(): Record<string, Workflow> {
  const out: Record<string, Workflow> = {};
  for (const f of readdirSync(WORKFLOWS).filter((n) => /\.ya?ml$/.test(n)))
    out[f] = load(readFileSync(WORKFLOWS + f, "utf8"), { schema: CORE_SCHEMA }) as Workflow;
  return out;
}

describe("checkout credentials in the jobs a pull request runs", () => {
  it("every checkout a pull request runs sets persist-credentials: false, but the listed ones", () => {
    expect(
      keptCredentials(repoWorkflows()),
      "add persist-credentials: false to the checkout, or list the job in KEEPS_CREDENTIALS " +
        "with its reason (docs/security/14-build-and-release-supply-chain.md B19)",
    ).toEqual(Object.keys(KEEPS_CREDENTIALS).sort());
  });

  it("a listed checkout runs only after a job that no pull request event starts", () => {
    const workflows = repoWorkflows();
    for (const [name, { needs, if: cond }] of Object.entries(KEEPS_CREDENTIALS)) {
      const [file = "", id = ""] = name.split(" ");
      const jobs = workflows[file]?.jobs ?? {};
      expect([jobs[id]?.needs].flat(), name).toEqual([needs]);
      expect(jobs[needs]?.if?.trim(), name).toMatch(cond);
    }
  });

  const checkout = (w?: Record<string, unknown>): Job => ({
    steps: [{ uses: "actions/checkout@0", ...(w ? { with: w } : {}) }],
  });
  it.each([
    ["no inputs", { on: "pull_request", jobs: { a: checkout() } }, ["w.yml a"]],
    [
      "true",
      { on: ["pull_request"], jobs: { a: checkout({ "persist-credentials": true }) } },
      ["w.yml a"],
    ],
    [
      "the string false",
      {
        on: { pull_request_target: {} },
        jobs: { a: checkout({ "persist-credentials": "false" }) },
      },
      ["w.yml a"],
    ],
    [
      "false",
      { on: { pull_request: null }, jobs: { a: checkout({ "persist-credentials": false }) } },
      [],
    ],
    ["a push-only workflow", { on: { push: {} }, jobs: { a: checkout() } }, []],
    ["no inputs, on merge_group", { on: ["merge_group"], jobs: { a: checkout() } }, ["w.yml a"]],
    [
      "no inputs, on issue_comment",
      { on: { issue_comment: {} }, jobs: { a: checkout() } },
      ["w.yml a"],
    ],
    [
      "no inputs, on workflow_run",
      { on: { workflow_run: {} }, jobs: { a: checkout() } },
      ["w.yml a"],
    ],
  ])("reads a checkout with %s", (_, workflow, kept) => {
    expect(keptCredentials({ "w.yml": workflow as Workflow })).toEqual(kept);
  });

  it("follows a reusable workflow that a pull request workflow calls", () => {
    const called: Workflow = { on: { workflow_call: {} }, jobs: { b: checkout() } };
    const caller: Workflow = {
      on: "pull_request",
      jobs: { a: { uses: "./.github/workflows/c.yml" } },
    };
    expect(keptCredentials({ "c.yml": called, "p.yml": caller })).toEqual(["c.yml b"]);
    expect(keptCredentials({ "c.yml": called })).toEqual([]);
  });
});
