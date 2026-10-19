import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../test/temp-dir.mjs";
import { jobs, parseWorkflow } from "../../test/workflow-runners.mjs";

// Spec macos-build, sub-PRs 3 and 4: an arm64 macOS build cross-compiled on a GitHub-hosted Linux
// runner, ad hoc signed with rcodesign, packed as a .dmg and checked on a hosted Mac.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
/** @param {string} path */
const read = (path) => readFileSync(join(repo, path), "utf8");
const SCRIPT = join(repo, "tools/package/macos-dmg.sh");

describe("configs/*/mozconfig", () => {
  // Decision 3: arm64 only. configs/macos/mozconfig is read only when Surfer builds for darwin,
  // so the target cannot reach the Linux build.
  it("the macOS mozconfig targets arm64 macOS", () => {
    expect(read("configs/macos/mozconfig")).toMatch(
      /^ac_add_options --target=aarch64-apple-darwin$/m,
    );
  });

  it("the Linux and common mozconfigs name no target", () => {
    for (const file of ["configs/linux/mozconfig", "configs/common/mozconfig"]) {
      expect(read(file), file).not.toMatch(/--target=/);
    }
  });
});

describe("fetch-rcodesign.sh", () => {
  const script = read("tools/package/fetch-rcodesign.sh");

  it("pins one rcodesign release and its SHA-256, checked before the file is used", () => {
    expect(script).toMatch(/^RCODESIGN_RELEASE=\d+\.\d+\.\d+$/m);
    expect(script).toMatch(/^RCODESIGN_SHA256=[0-9a-f]{64}$/m);
    expect(script).toContain("sha256sum --check");
    expect(script).toContain(
      "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F",
    );
    expect(script.indexOf("sha256sum --check")).toBeLessThan(script.indexOf("tar "));
  });
});

/**
 * A stub `mach` and `rcodesign` in `dir`, logging their arguments to `dir/log`. `apps` is how many
 * .app bundles the stub unpack_dmg writes.
 * @param {string} dir
 * @param {{ apps?: number, signFails?: boolean }} [options]
 */
function stubs(dir, { apps = 1, signFails = false } = {}) {
  const log = join(dir, "log");
  const mach = join(dir, "mach");
  writeFileSync(
    mach,
    `#!/bin/sh
echo "mach $*" >> "${log}"
case "$3" in
  mozbuild.action.unpack_dmg)
    for name in $(seq 1 ${apps}); do
      [ "$name" = 1 ] && name=Vimma || name="Other$name"
      mkdir -p "$5/$name.app/Contents/MacOS"
    done
    ;;
  mozbuild.action.make_dmg) for last; do :; done; echo dmg > "$last" ;;
esac
`,
  );
  const rcodesign = join(dir, "rcodesign");
  writeFileSync(
    rcodesign,
    `#!/bin/sh\necho "rcodesign $*" >> "${log}"\n${signFails ? "exit 3\n" : ""}`,
  );
  chmodSync(mach, 0o755);
  chmodSync(rcodesign, 0o755);
  return { log, mach, rcodesign };
}

/**
 * @param {string} dir
 * @param {{ mach: string, rcodesign: string }} tools
 */
function sign(dir, { mach, rcodesign }) {
  const tmp = join(dir, "tmp");
  mkdirSync(tmp);
  const result = spawnSync(SCRIPT, [join(dir, "in.dmg"), join(dir, "out/Vimma.dmg")], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, MACH: mach, RCODESIGN: rcodesign, TMPDIR: tmp },
  });
  return { ...result, tmp };
}

describe("macos-dmg.sh", () => {
  it("unpacks the dmg, ad hoc signs the one app in it and packs a new dmg", () => {
    const dir = tempDir("vimma-macos-dmg-");
    const tools = stubs(dir);
    mkdirSync(join(dir, "out"));
    const { status, stderr, tmp } = sign(dir, tools);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    const lines = readFileSync(tools.log, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    const unpack = /^mach python -m mozbuild\.action\.unpack_dmg (\S+) (\S+)$/.exec(lines[0] ?? "");
    expect(unpack?.[1]).toBe(join(dir, "in.dmg"));
    const staged = unpack?.[2] ?? "";
    // ad hoc: no certificate, no entitlements, no hardened runtime (decision 10)
    expect(lines[1]).toBe(`rcodesign sign ${staged}/Vimma.app`);
    expect(lines[2]).toBe(
      `mach python -m mozbuild.action.make_dmg --volume-name Vimma ${staged} ` +
        join(dir, "out/Vimma.dmg"),
    );
    expect(readFileSync(join(dir, "out/Vimma.dmg"), "utf8")).toBe("dmg\n");
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("refuses a dmg without exactly one app", () => {
    for (const apps of [0, 2]) {
      const dir = tempDir("vimma-macos-dmg-");
      const tools = stubs(dir, { apps });
      mkdirSync(join(dir, "out"));
      const { status, stderr, tmp } = sign(dir, tools);
      expect(status, `${apps} apps`).not.toBe(0);
      expect(stderr).toMatch(/exactly one \.app/);
      expect(readFileSync(tools.log, "utf8")).not.toMatch(/rcodesign|make_dmg/);
      expect(readdirSync(tmp)).toEqual([]);
    }
  });

  it("writes no dmg when signing fails", () => {
    const dir = tempDir("vimma-macos-dmg-");
    const tools = stubs(dir, { signFails: true });
    mkdirSync(join(dir, "out"));
    const { status, tmp } = sign(dir, tools);
    expect(status).not.toBe(0);
    expect(existsSync(join(dir, "out/Vimma.dmg"))).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  });
});

describe("macos.yml", () => {
  const text = read(".github/workflows/macos.yml");
  const doc = parseWorkflow(text);
  const all = jobs(text);
  const build = all.get("build") ?? {};
  const smoke = all.get("smoke") ?? {};
  /** @param {Record<string, unknown>} job */
  const steps = (job) =>
    /** @type {Array<Record<string, any>>} */ (Array.isArray(job.steps) ? job.steps : []);
  /** @param {Record<string, unknown>} job @param {string} name */
  const step = (job, name) => steps(job).find((s) => String(s.name ?? "").startsWith(name)) ?? {};
  /** @param {Record<string, unknown>} job @param {string} needle */
  const index = (job, needle) => {
    const i = steps(job).findIndex((s) => JSON.stringify(s).includes(needle));
    expect(i, needle).toBeGreaterThan(-1);
    return i;
  };

  it("has a build job and a smoke job", () => {
    expect([...all.keys()]).toEqual(["build", "smoke"]);
  });

  // Decision 13: its own workflow, weekly, by hand, and on pull requests that touch it.
  it("runs weekly, by hand and on pull requests that touch the macOS build", () => {
    const on = /** @type {Record<string, any>} */ (doc.on);
    expect(Object.keys(on).sort()).toEqual(["pull_request", "schedule", "workflow_dispatch"]);
    expect(on.schedule).toHaveLength(1);
    expect(on.pull_request.paths.sort()).toEqual([
      ".github/workflows/macos.yml",
      "configs/macos/**",
      "tools/package/fetch-rcodesign.sh",
      "tools/package/macos-dmg.sh",
    ]);
  });

  it("no release or nightly workflow calls it, so it cannot block a Linux build", () => {
    for (const name of ["nightly.yml", "release.yml"]) {
      expect(read(`.github/workflows/${name}`), name).not.toContain("macos.yml");
    }
    expect(text).not.toContain("workflow_call");
  });

  // Decision 14 and docs/security.md, B6: test builds are keyless; nothing here holds a secret.
  it("reads no secret, deploys to no environment and only reads the repository", () => {
    expect(doc.permissions).toEqual({});
    expect(text).not.toMatch(/secrets\.|github\.token|GH_TOKEN/);
    for (const [id, job] of all) {
      expect(job.environment, id).toBeUndefined();
      expect(job.permissions, id).toEqual({ contents: "read" });
    }
  });

  it("pins every action by commit", () => {
    const uses = [...all.values()].flatMap((j) =>
      steps(j)
        .map((s) => s.uses)
        .filter(Boolean),
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });

  // Decision 5: cross-compiled on a standard hosted Linux runner, never on a Mac.
  it("builds for darwin on ubuntu-24.04, then signs and packs the dmg", () => {
    expect(build["runs-on"]).toBe("ubuntu-24.04");
    const surfer = step(build, "Build");
    expect(surfer.env).toEqual({ SURFER_PLATFORM: "darwin" });
    expect(surfer.run).toContain("npx --no -- surfer build");
    // the runner's rustc has only its own target's std; configure fails without this one
    expect(index(build, "rustup target add aarch64-apple-darwin")).toBeGreaterThan(-1);
    expect(index(build, "rustup target add aarch64-apple-darwin")).toBeLessThan(
      index(build, "npx --no -- surfer build"),
    );
    const pack = index(build, "./mach package");
    expect(index(build, "tools/package/fetch-rcodesign.sh")).toBeLessThan(pack + 2);
    expect(index(build, "tools/package/macos-dmg.sh")).toBeGreaterThan(pack);
    expect(JSON.stringify(build)).not.toContain("SAFEBROWSING");
  });

  // Decision 15: the artifact carries both versions.
  it("uploads the dmg as vimma-<vimma>-firefox-<firefox>-macos-aarch64", () => {
    const upload = steps(build).find((s) => String(s.uses).startsWith("actions/upload-artifact@"));
    expect(upload?.with?.name).toBe(
      "vimma-${{ steps.version.outputs.vimma }}-firefox-${{ steps.version.outputs.firefox }}" +
        "-macos-aarch64",
    );
    expect(upload?.with?.["if-no-files-found"]).toBe("error");
    expect(build.outputs).toEqual({ artifact: expect.stringContaining("steps.version.outputs") });
  });

  // Decision 8 and sub-PR 4: a hosted Mac runs what was built.
  it("smokes the dmg on a hosted Mac: signature, version line, a headless page", () => {
    expect(smoke.needs).toBe("build");
    expect(smoke["runs-on"]).toBe("macos-15");
    const download = steps(smoke).find((s) =>
      String(s.uses).startsWith("actions/download-artifact@"),
    );
    expect(download?.with?.name).toBe("${{ needs.build.outputs.artifact }}");
    const run = steps(smoke)
      .map((s) => s.run ?? "")
      .join("\n");
    expect(run).toContain("hdiutil attach");
    expect(run).toContain("codesign --verify --deep --strict");
    expect(run).toContain("node tools/release/version-line.mjs");
    expect(run).toContain("--screenshot");
  });

  it("stops itself before GitHub's 6-hour job limit", () => {
    expect(build["timeout-minutes"]).toBeGreaterThan(0);
    expect(build["timeout-minutes"]).toBeLessThanOrEqual(345);
    expect(smoke["timeout-minutes"]).toBeLessThanOrEqual(30);
  });
});
