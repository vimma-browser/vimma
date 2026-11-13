// The CLI's guard: baselines change only in a reviewed commit, never from a CI run.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../test/temp-dir.mjs";
import { E2E_FONTCONFIG } from "../launcher.mjs";
import { defined } from "../../test/defined.ts";

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

// Spec macos-build, sub-PR 4: macOS runs the scenarios headless, where there is no framebuffer
// to capture, so a screenshot step is reported as skipped and no baseline is read or written.
describe("npm run e2e -- --headless", () => {
  it("skips a screenshot step and passes, with no baseline or output written", () => {
    const dir = tempDir("e2e-headless-");
    const scenarios = join(dir, "scenarios");
    mkdirSync(scenarios);
    writeFileSync(
      join(scenarios, "m0-headless-shot.json"),
      JSON.stringify({
        name: "m0-headless-shot",
        description: "x",
        timeoutSeconds: 20,
        steps: [{ screenshot: "m0-headless-shot" }],
      }),
    );
    // Answers state, and quits the fake browser on send-keys as ctrl+q does: the quit
    // observers remove the discovery file, then the browser exits.
    const ctl = join(dir, "vimma-ctl");
    writeFileSync(
      ctl,
      [
        "#!/bin/sh",
        'case "$5" in',
        '  state) echo \'{"mode":"normal"}\' ;;',
        '  send-keys) f="$2/vimma-control.json"',
        '    pid=$(sed -n \'s/.*"pid":\\([0-9]*\\).*/\\1/p\' "$f"); rm -f "$f"; kill "$pid" ;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const fakeBrowser = fileURLToPath(new URL("./fixtures/fake-browser.mjs", import.meta.url));
    const shots = join(dir, "shots");
    const out = join(dir, "o");
    const r = spawnSync(
      process.execPath,
      [
        CLI,
        ...["--scenarios", scenarios, "--baselines", shots, "--out", out, "--headless"],
        ...["--build", fakeBrowser, "--vimma-ctl", ctl, "--discovery-timeout", "10"],
      ],
      { encoding: "utf8", env: { ...process.env, CI: "true" }, timeout: 60_000 },
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/screenshot m0-headless-shot: skipped/);
    expect(existsSync(shots) || existsSync(out)).toBe(false);
  }, 70_000);
});

// Issue #944: the scenarios' browser renders with the vendored fonts on Linux, so a local run
// compares with CI's baselines; the CLI is what hands launch() that fontconfig file.
describe("npm run e2e: the scenarios' fonts", () => {
  it("starts the browser with the vendored fontconfig file on Linux, none on macOS", () => {
    const dir = tempDir("e2e-fonts-");
    const scenarios = join(dir, "scenarios");
    mkdirSync(scenarios);
    writeFileSync(
      join(scenarios, "m0-fonts.json"),
      JSON.stringify({
        name: "m0-fonts",
        description: "x",
        timeoutSeconds: 20,
        steps: [{ "wait-for-state": { mode: "normal" } }],
      }),
    );
    const ctl = join(dir, "vimma-ctl");
    writeFileSync(
      ctl,
      [
        "#!/bin/sh",
        'case "$5" in',
        '  state) echo \'{"mode":"normal"}\' ;;',
        '  send-keys) f="$2/vimma-control.json"',
        '    pid=$(sed -n \'s/.*"pid":\\([0-9]*\\).*/\\1/p\' "$f"); rm -f "$f"; kill "$pid" ;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const fakeBrowser = fileURLToPath(new URL("./fixtures/fake-browser.mjs", import.meta.url));
    // --keep leaves the profile (with the fake browser's record of its env) in TMPDIR, and the
    // run folder in XDG_RUNTIME_DIR: both inside this test's temp dir, removed with it.
    const tmp = join(dir, "tmp");
    const run = join(dir, "run");
    mkdirSync(tmp);
    mkdirSync(run, { mode: 0o700 });
    const r = spawnSync(
      process.execPath,
      [
        CLI,
        ...["--scenarios", scenarios, "--baselines", join(dir, "shots"), "--out", join(dir, "o")],
        ...["--headless", "--keep"],
        ...["--build", fakeBrowser, "--vimma-ctl", ctl, "--discovery-timeout", "10"],
      ],
      {
        encoding: "utf8",
        env: { ...process.env, CI: "true", TMPDIR: tmp, XDG_RUNTIME_DIR: run },
        timeout: 60_000,
      },
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const [profile] = readdirSync(tmp).filter((f) => f.startsWith("vimma-e2e-profile-"));
    const seen = JSON.parse(
      readFileSync(join(tmp, defined(profile, "a profile"), "fake-browser.json"), "utf8"),
    );
    expect(seen.env.FONTCONFIG_FILE).toBe(
      process.platform === "darwin" ? undefined : E2E_FONTCONFIG,
    );
  }, 70_000);
});
