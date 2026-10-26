// The CLI's guard: baselines change only in a reviewed commit, never from a CI run.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../test/temp-dir.mjs";

const CLI = fileURLToPath(new URL("../e2e.mjs", import.meta.url));
// macOS has no /bin/false or /bin/true, only /usr/bin's.
const BIN = process.platform === "darwin" ? "/usr/bin" : "/bin";

describe("npm run e2e", () => {
  it("refuses --update-baselines when CI is set (exit 2, before launching anything)", () => {
    const r = spawnSync(process.execPath, [CLI, "--update-baselines", "--filter", "no-such"], {
      encoding: "utf8",
      env: { ...process.env, CI: "true" },
      timeout: 30_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--update-baselines is refused in CI/);
  });
});

// Spec upstream-beta-canary, decision 4: in e2e.yml's Beta mode the scenarios' failures go into
// suite-results.json through this file. A browser that exits at once is a real launch failure.
describe("npm run e2e -- --report-json", () => {
  it("--report-json writes each failed scenario with its error", () => {
    const dir = tempDir("e2e-report-");
    const scenarios = join(dir, "scenarios");
    mkdirSync(scenarios);
    const step = { "wait-for-state": { mode: "insert" } };
    writeFileSync(
      join(scenarios, "m0-beta-launch.json"),
      JSON.stringify({
        name: "m0-beta-launch",
        description: "x",
        timeoutSeconds: 5,
        steps: [step],
      }),
    );
    writeFileSync(
      join(scenarios, "m0-beta-later.json"),
      JSON.stringify({
        name: "m0-beta-later",
        description: "x",
        pending: "not yet",
        steps: [step],
      }),
    );
    const out = join(dir, "report.json");
    const r = spawnSync(
      process.execPath,
      [
        CLI,
        ...["--scenarios", scenarios, "--baselines", join(dir, "shots"), "--out", join(dir, "o")],
        ...["--build", `${BIN}/false`, "--vimma-ctl", `${BIN}/true`, "--discovery-timeout", "1"],
        ...["--report-json", out],
      ],
      { encoding: "utf8", env: { ...process.env, DISPLAY: ":0" }, timeout: 30_000 },
    );
    expect(r.status, r.stderr).toBe(1);
    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(report.passed).toBe(0);
    expect(report.pending).toEqual([{ name: "m0-beta-later", reason: "not yet" }]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].name).toBe("m0-beta-launch");
    expect(report.failed[0].status).toBe("fail");
    expect(report.failed[0].error).toMatch(/^launch: /);
  });

  it("--report-json needs a path", () => {
    const r = spawnSync(process.execPath, [CLI, "--report-json", ""], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--report-json/);
  });
});
