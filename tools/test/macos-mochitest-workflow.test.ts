import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { jobs } from "./workflow-runners.ts";

// The macOS mochitest job in e2e.yml (docs/runbook/ci-macos-mochitests.md). Its green runs took
// 35 to 44 minutes in November 2026, and a run that passed every file was cancelled at its old
// 45-minute limit (#1546). Like macos.yml's build, it stops at about 1.5 times the measured job.
const TEXT = readFileSync(new URL("../../.github/workflows/e2e.yml", import.meta.url), "utf8");

describe("the macOS mochitest job in e2e.yml", () => {
  it("stops itself at about 1.5 times the measured 44-minute job", () => {
    const job = jobs(TEXT).get("mochitest-macos") ?? {};
    expect(job["timeout-minutes"]).toBeGreaterThanOrEqual(44 * 1.4);
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(44 * 1.6);
  });
});
