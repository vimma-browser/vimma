import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../test/temp-dir.mjs";
import { versionLine } from "../version-line.mjs";

// The "Smoke check" steps of release.yml and nightly.yml, run as GitHub runs them (`bash -e`)
// against a stub `vimma`. On ubuntu-24.04 AppArmor denies unprivileged user namespaces, and
// Firefox's sandbox writes a diagnostic to stderr when `--version` probes them
// (security/sandbox/linux/SandboxInfo.cpp, SANDBOX_LOG_ERRNO writes to STDERR_FILENO). The step
// must compare stdout alone, and still fail on a wrong version line or a failing binary.
// The check stays inline in the workflows, not in a script: a manual re-run for an existing tag
// runs main's workflow on the tag's checkout, which lacks any script added after the tag.

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const surfer = JSON.parse(readFileSync(join(repo, "surfer.json"), "utf8"));
const line = versionLine(surfer);
const firefox = surfer.version.version;
const tag = `v${surfer.brands.vimma.release.displayVersion}`;
const DIAGNOSTIC = "[157746] Sandbox: CanCreateUserNamespace() unshare(CLONE_NEWPID): EPERM";

/**
 * The run block of the step named `name` in a workflow.
 * @param {string} workflow file name under .github/workflows
 * @param {string} name
 * @returns {string}
 */
function stepScript(workflow, name) {
  const text = readFileSync(join(repo, ".github/workflows", workflow), "utf8");
  const head = `      - name: ${name}\n        run: |\n`;
  const start = text.indexOf(head);
  expect(start, `${workflow}: step ${name}`).toBeGreaterThan(-1);
  const lines = [];
  for (const l of text.slice(start + head.length).split("\n")) {
    if (l !== "" && !l.startsWith("          ")) break;
    lines.push(l.slice(10));
  }
  return lines.join("\n");
}

/**
 * A stub `vimma` at `path` and the files the smoke checks read next to it.
 * @param {string} bin dist/bin directory
 * @param {string} body shell for the stub, run for `vimma --version`
 */
function stub(bin, body) {
  mkdirSync(join(bin, "modules"), { recursive: true });
  writeFileSync(join(bin, "vimma"), `#!/bin/bash\n${body}\n`);
  chmodSync(join(bin, "vimma"), 0o755);
  writeFileSync(join(bin, "application.ini"), `[App]\nVersion=${firefox}\n`);
  writeFileSync(
    join(bin, "modules", "AppConstants.sys.mjs"),
    'MOZ_GOOGLE_SAFEBROWSING_API_KEY: "test-key",\n',
  );
}

/**
 * A working directory with the files of the checkout the steps read.
 * @returns {string}
 */
function workdir() {
  const dir = tempDir("vimma-smoke-");
  // Copies, not symlinks: version-line.mjs runs only when argv[1] is its own (real) path.
  for (const sub of ["tools/release/version-line.mjs", "tools/version-files/version-files.mjs"]) {
    mkdirSync(dirname(join(dir, sub)), { recursive: true });
    cpSync(join(repo, sub), join(dir, sub));
  }
  cpSync(join(repo, "surfer.json"), join(dir, "surfer.json"));
  return dir;
}

/**
 * @param {string} script
 * @param {string} cwd
 * @param {Record<string, string>} env
 */
function run(script, cwd, env) {
  const r = spawnSync("bash", ["-e", "-c", script], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { status: r.status, output: r.stdout + r.stderr };
}

/** @type {Record<string, (body: string) => { status: number | null, output: string, log: string }>} */
const steps = {
  "release.yml build": (body) => {
    const dir = workdir();
    const objdir = join(dir, "obj-release");
    const runner = join(dir, "runner");
    mkdirSync(runner);
    stub(join(objdir, "dist", "bin"), body);
    const r = run(stepScript("release.yml", "Smoke check"), dir, {
      TAG: tag,
      MOZ_OBJDIR: objdir,
      RUNNER_TEMP: runner,
    });
    return { ...r, log: r.output };
  },
  "nightly.yml": (body) => {
    const dir = workdir();
    const log = join(dir, "nightly.log");
    writeFileSync(log, "");
    stub(join(dir, "engine", "obj-x86_64-pc-linux-gnu", "dist", "bin"), body);
    const r = run(stepScript("nightly.yml", "Smoke check"), dir, { LOG: log });
    return { ...r, log: readFileSync(log, "utf8") };
  },
};

describe.each(Object.keys(steps))("the %s smoke check", (id) => {
  const step = steps[id] ?? (() => ({ status: null, output: "", log: "" }));

  it("passes with the sandbox diagnostic on stderr, and keeps it in the log", () => {
    const r = step(`echo '${DIAGNOSTIC}' >&2\necho '${line}'`);
    expect(r.output).not.toContain("::error::");
    expect(r.status).toBe(0);
    expect(r.log).toContain(DIAGNOSTIC);
  });

  it("passes with a clean --version", () => {
    expect(step(`echo '${line}'`).status).toBe(0);
  });

  it("fails on a wrong version line", () => {
    const r = step(`echo '${DIAGNOSTIC}' >&2\necho 'Vimma 0.0.0 · Firefox ${firefox}'`);
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("::error::--version is 'Vimma 0.0.0");
  });

  it("fails on anything else on stdout", () => {
    expect(step(`echo '${DIAGNOSTIC}'\necho '${line}'`).status).not.toBe(0);
  });

  it("fails on no output", () => {
    expect(step(`echo '${DIAGNOSTIC}' >&2`).status).not.toBe(0);
  });

  it("fails when the binary fails, even after printing the right line", () => {
    expect(step(`echo '${line}'\nexit 3`).status).not.toBe(0);
  });

  it("fails when the binary crashes", () => {
    // SIGKILL, not SIGSEGV: a death by signal all the same, but it leaves no core dump for
    // systemd-coredump to journal and desktop crash watchers to announce on every test run.
    expect(step(`echo '${line}'\nkill -KILL $$`).status).not.toBe(0);
  });
});

// Every other `--version` comparison (the .deb, the AppImage, the PKGBUILD on Arch) reads stdout
// alone too: stderr merged into the captured line fails on any runner that prints the diagnostic.
it.each([
  ".github/workflows/release.yml",
  ".github/workflows/nightly.yml",
  "tools/package/arch-smoke.sh",
  "tools/package/rpm-smoke.sh",
])("%s never merges stderr into a captured --version", (file) => {
  const text = readFileSync(join(repo, file), "utf8");
  expect(text).toContain("--version");
  expect(text).not.toMatch(/--version[^\n]*2>&1/);
});
