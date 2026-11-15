import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { coreFiles } from "../mutation/shard.ts";

// The weekly mutation run (mutation.yml, spec ci-quality-gates, #975). Text checks, like
// full-build-workflows.test.ts: no YAML dependency.
const text = readFileSync(new URL("../../.github/workflows/mutation.yml", import.meta.url), "utf8");

/** The YAML block of job `id` (up to the next job at the same indent). */
function job(id: string) {
  const body = text.slice(text.indexOf("\njobs:\n") + 7);
  const parts = body.split(/^ {2}([a-z][a-z0-9-]*):\n/m).slice(1);
  for (let i = 0; i < parts.length; i += 2) if (parts[i] === id) return parts[i + 1] ?? "";
  throw new Error(`no job ${id}`);
}

describe("mutation.yml", () => {
  // Repository code (npm ci, Stryker, the tests, merge.ts, report.ts) never runs beside a token:
  // only the step that lists and downloads the previous run's artifacts (actions: read) and the
  // step that runs gh on the tracking issue (issues: write) get GH_TOKEN.
  it("gives GH_TOKEN only to the previous-results step and the issue step", () => {
    const holders = [];
    for (const id of ["stryker", "report"]) {
      const block = job(id);
      const head = block.slice(0, block.indexOf("\n    steps:\n"));
      if (/^ +GH_TOKEN:/m.test(head)) holders.push(`${id}: every step`);
      const steps = block.split(/\n(?= {6}- )/).slice(1);
      for (const step of steps.filter((s) => /^ +GH_TOKEN:/m.test(s))) {
        holders.push(`${id}: ${/- (?:name|uses): (.*)/.exec(step)?.[1]}`);
        expect(step, "a token step runs no repository code").not.toMatch(/\bnode |\bnpm |npx /);
      }
    }
    expect(holders).toEqual([
      "stryker: Previous run's results (incremental mode)",
      "report: Create, update or close the tracking issue",
    ]);
    expect(text).toMatch(/^permissions: \{\}$/m);
  });

  it("runs every shard to the end, the same count everywhere", () => {
    const block = job("stryker");
    expect(block).toMatch(/^ {6}fail-fast: false\b/m);
    const shards = /^ {8}shard: \[([\d, ]+)\]$/m.exec(block)?.[1]?.split(", ").map(Number) ?? [];
    const count = Number(/^ {6}MUTATION_SHARDS: (\d+)$/m.exec(block)?.[1]);
    expect(shards).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    expect(block).toContain(`(shard \${{ matrix.shard }} of ${count})`);
    // Every shard has a file to mutate: an empty shard would make Stryker mutate nothing.
    expect(coreFiles(new URL("../../", import.meta.url).pathname).length).toBeGreaterThan(count);
  });
});
