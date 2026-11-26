import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { jobs } from "./workflow-runners.ts";

// The macOS mochitest job in e2e.yml (docs/runbook/ci-macos-mochitests.md). As one job, its green
// runs took 35 to 44 minutes in November 2026 on a shared 3-vCPU runner whose speed varies by
// 1.3 to 1.5 times between runs, which left every test close to its limits. It now runs as two
// parallel shards, split by file on the measured times (tools/mochitest-shards.ts, issue #1569),
// and, like macos.yml's build, each shard stops at about 1.5 times its measured run.
const TEXT = readFileSync(new URL("../../.github/workflows/e2e.yml", import.meta.url), "utf8");
const SHARD_MINUTES = 24.5;

const mac = () => jobs(TEXT).get("mochitest-macos") ?? {};

describe("the macOS mochitest job in e2e.yml", () => {
  it("runs as two shards, each to the end even when the other fails", () => {
    const strategy = (mac().strategy ?? {}) as Record<string, unknown>;
    expect(strategy["fail-fast"]).toBe(false);
    expect(strategy.matrix).toEqual({ shard: [1, 2] });
    expect(mac().name).toBe("mochitest (artifact build, macOS, shard ${{ matrix.shard }}/2)");
  });

  it("stops each shard at about 1.5 times its measured run", () => {
    expect(mac()["timeout-minutes"]).toBeGreaterThanOrEqual(SHARD_MINUTES * 1.4);
    expect(mac()["timeout-minutes"]).toBeLessThanOrEqual(SHARD_MINUTES * 1.6);
  });

  it("runs its own shard's files and uploads its logs under its own name", () => {
    const steps = (mac().steps ?? []) as Record<string, unknown>[];
    const run = steps.map((s) => String(s.run ?? "")).find((r) => r.includes("npm run mochitest"));
    expect(run).toContain('"--shard=$SHARD/2"');
    expect(run).not.toContain("tests/browser/");
    const mochitest = steps.find((s) => String(s.run ?? "").includes("npm run mochitest")) ?? {};
    expect(mochitest.env).toEqual({ SHARD: "${{ matrix.shard }}" });
    const upload = steps.find((s) => String(s.uses ?? "").startsWith("actions/upload-artifact@"));
    expect((upload?.with as Record<string, unknown> | undefined)?.name).toBe(
      "mochitest-macos-logs-${{ matrix.shard }}",
    );
  });
});
