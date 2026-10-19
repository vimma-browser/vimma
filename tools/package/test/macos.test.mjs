import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../test/temp-dir.mjs";
import { jobs, parseWorkflow } from "../../test/workflow-runners.mjs";
import { catalogSummary } from "../macos-icons.mjs";

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

  it("has a build job, a smoke job and an icons job", () => {
    expect([...all.keys()]).toEqual(["build", "smoke", "icons"]);
  });

  // Decision 13: its own workflow, weekly, by hand, and on pull requests that touch it.
  it("runs weekly, by hand and on pull requests that touch the macOS build", () => {
    const on = /** @type {Record<string, any>} */ (doc.on);
    expect(Object.keys(on).sort()).toEqual(["pull_request", "schedule", "workflow_dispatch"]);
    expect(on.schedule).toHaveLength(1);
    expect(on.pull_request.paths.sort()).toEqual([
      ".github/workflows/macos.yml",
      "configs/branding/vimma/**",
      "configs/macos/**",
      "src/browser/branding/vimma/**",
      "tools/package/fetch-rcodesign.sh",
      "tools/package/macos-app-check.sh",
      "tools/package/macos-dmg.sh",
      "tools/package/macos-icons.mjs",
      "tools/package/render-icon.swift",
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

  // Spec macos-homebrew, decision 13, and the bundle id (its open question 4): the built app
  // carries Vimma's asset catalog, not Firefox's, under Vimma's own identifier.
  it("checks the built app's icon catalog and bundle identifier", () => {
    const run = steps(smoke)
      .map((s) => s.run ?? "")
      .join("\n");
    expect(run).toContain('tools/package/macos-app-check.sh "$APP"');
  });

  // Decision 13: actool runs only on a Mac with Xcode, so a Mac regenerates the committed icon
  // files from their sources and fails if they drift. Xcode is pinned, as its actool writes the
  // catalog.
  it("regenerates the icon files on a Mac with a pinned Xcode and fails on drift", () => {
    const icons = all.get("icons") ?? {};
    expect(icons["runs-on"]).toBe("macos-26");
    expect(icons.env?.DEVELOPER_DIR).toMatch(
      /^\/Applications\/Xcode_26\.\d+(\.\d+)?\.app\/Contents\/Developer$/,
    );
    expect(icons["timeout-minutes"]).toBeLessThanOrEqual(15);
    const run = steps(icons)
      .map((s) => s.run ?? "")
      .join("\n");
    expect(run).toContain("node tools/package/macos-icons.mjs --check");
  });

  // The first green cross build's job took 133 minutes (docs/runbook.md, "macOS build").
  it("stops itself at about 1.5 times the measured build, before GitHub's 6-hour job limit", () => {
    expect(build["timeout-minutes"]).toBeGreaterThanOrEqual(133 * 1.4);
    expect(build["timeout-minutes"]).toBeLessThanOrEqual(133 * 1.6);
    expect(smoke["timeout-minutes"]).toBeLessThanOrEqual(30);
  });
});

// Spec macos-homebrew, decisions 12 and 13: macOS shows the Linux artwork. macOS takes the app's
// icon from Assets.car before CFBundleIconFile, and Surfer copies Firefox's unofficial Assets.car
// unless src/ overrides it.
describe("macOS icons", () => {
  const branding = "configs/branding/vimma";
  /** @param {string} path */
  const bytes = (path) => readFileSync(join(repo, path));
  const surfer = JSON.parse(read("surfer.json"));

  it("logo-mac.png is byte-identical to logo.png", () => {
    expect(
      bytes("configs/branding/vimma/logo-mac.png").equals(bytes("configs/branding/vimma/logo.png")),
    ).toBe(true);
  });

  // Surfer's branding step copies each entry of configs/branding/vimma as a file, apart from
  // content/, so any other directory there fails the import on every platform.
  it("keeps configs/branding/vimma flat apart from content/", () => {
    const dir = join(repo, "configs/branding/vimma");
    const dirs = readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
    expect(dirs).toEqual(["content"]);
  });

  it("the Icon Composer source lays the Vimma mark on the brand background, for macOS", () => {
    const icon = JSON.parse(read("configs/macos/AppIcon.icon/icon.json"));
    const layers = icon.groups.flatMap((/** @type {any} */ g) => g.layers);
    expect(layers.map((/** @type {any} */ l) => l["image-name"])).toEqual(["vimma-mark.png"]);
    const [r, g, b] = (surfer.brands.vimma.backgroundColor.match(/[0-9a-f]{2}/gi) ?? []).map(
      (/** @type {string} */ h) => (parseInt(h, 16) / 255).toFixed(5),
    );
    expect(icon.fill).toEqual({ solid: `srgb:${r},${g},${b},1.00000` });
    expect(icon["supported-platforms"].squares).toEqual(["macOS"]);
  });

  it("commits the compiled Assets.car with an AppIcon and no Firefox asset", () => {
    const car = bytes(`${branding}/Assets.car`);
    expect(car.subarray(0, 8).toString("latin1")).toBe("BOMStore");
    expect(car.includes("AppIcon")).toBe(true);
    expect(car.includes("unofficial")).toBe(false);
  });

  it("commits firefox.icns and document.icns with a 1024 px image", () => {
    for (const name of ["firefox.icns", "document.icns"]) {
      const icns = bytes(`${branding}/${name}`);
      expect(icns.subarray(0, 4).toString("latin1"), name).toBe("icns");
      expect(icns.readUInt32BE(4), name).toBe(icns.length);
      expect(icns.includes("ic10"), name).toBe(true);
    }
  });

  // Firefox names the bundle <distribution id>.<MOZ_MACBUNDLE_ID> (toolkit/moz.configure); with
  // Surfer's defaults that is org.mozilla.dev.vimma.browser. The distribution id is set for macOS
  // only, so Services.appinfo.distributionID on Linux is unchanged.
  it("names the macOS app surfer.json's appId, without changing Linux", () => {
    const dist = /^ac_add_options --with-distribution-id=(\S+)$/m.exec(
      read("configs/macos/mozconfig"),
    )?.[1];
    const configure = read("src/browser/branding/vimma/configure.sh");
    const id = /^MOZ_MACBUNDLE_ID="([^"]+)"$/m.exec(configure)?.[1];
    expect(`${dist}.${id}`).toBe(surfer.appId);
    expect(configure).toMatch(
      new RegExp(`^MOZ_APP_DISPLAYNAME="${surfer.brands.vimma.brandFullName}"$`, "m"),
    );
    for (const file of ["configs/linux/mozconfig", "configs/common/mozconfig"]) {
      expect(read(file), file).not.toContain("--with-distribution-id");
    }
  });
});

// Both smoke jobs (macos.yml and release.yml) run it on the app from the dmg, so a release cannot
// publish a dmg that shows Firefox's icon or carries Surfer's bundle identifier.
describe("macos-app-check.sh", () => {
  const CHECK = join(repo, "tools/package/macos-app-check.sh");
  /**
   * @param {{ names: string[], id: string }} app
   */
  function check({ names, id }) {
    const dir = tempDir("vimma-app-check-");
    const assets = [{ AssetStorageVersion: "Xcode" }, ...names.map((Name) => ({ Name }))];
    const assetutil = join(dir, "assetutil");
    writeFileSync(assetutil, `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(assets)}\nEOF\n`);
    const plistbuddy = join(dir, "PlistBuddy");
    writeFileSync(plistbuddy, `#!/bin/sh\necho "$*" > "${dir}/plist-args"\necho ${id}\n`);
    chmodSync(assetutil, 0o755);
    chmodSync(plistbuddy, 0o755);
    const app = join(dir, "Vimma.app");
    mkdirSync(join(app, "Contents/Resources"), { recursive: true });
    const result = spawnSync(CHECK, [app], {
      cwd: repo,
      encoding: "utf8",
      env: { PATH: process.env.PATH, ASSETUTIL: assetutil, PLISTBUDDY: plistbuddy },
    });
    return { ...result, dir };
  }

  it("passes an app with Vimma's AppIcon and surfer.json's appId", () => {
    const result = check({ names: ["AppIcon", "AppIcon/Group"], id: "dev.vimma.browser" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(readFileSync(join(result.dir, "plist-args"), "utf8")).toContain(
      "Print :CFBundleIdentifier",
    );
  });

  it("fails an app that still carries Firefox's unofficial icon", () => {
    const result = check({
      names: ["AppIcon", "AppIcon_Assets/unofficial-1"],
      id: "dev.vimma.browser",
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("unofficial");
  });

  it("fails an app without an AppIcon", () => {
    const result = check({ names: ["Icon"], id: "dev.vimma.browser" });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("AppIcon");
  });

  it("fails an app under Surfer's default bundle identifier", () => {
    const result = check({ names: ["AppIcon"], id: "org.mozilla.dev.vimma.browser" });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("org.mozilla.dev.vimma.browser");
  });
});

// actool names each flattened fallback image with a fresh UUID and renders it to different bytes
// on every run; the layer image, colours and icon stack it compiles from are stable.
describe("macos-icons.mjs catalogSummary", () => {
  /** @param {string} uuid @param {string} digest @param {string} mark */
  const catalog = (uuid, digest, mark) => [
    { AssetStorageVersion: "Xcode 26.6", Timestamp: Number(uuid.length) },
    {
      AssetType: "Icon Image",
      Name: "AppIcon",
      RenditionName: `AppIcon16x16_${uuid}.png`,
      SHA1Digest: digest,
      PixelWidth: 16,
    },
    { AssetType: "Image", Name: "AppIcon_Assets/vimma-mark", SHA1Digest: mark },
  ];

  it("ignores the header and the fallback images' generated names and bytes", () => {
    expect(catalogSummary(catalog("A-1", "AA", "M"))).toBe(
      catalogSummary(catalog("B-22", "BB", "M")),
    );
  });

  it("tells a changed layer image or fallback size apart", () => {
    expect(catalogSummary(catalog("A", "AA", "M"))).not.toBe(
      catalogSummary(catalog("A", "AA", "N")),
    );
    const resized = catalog("A", "AA", "M");
    resized[1].PixelWidth = 32;
    expect(catalogSummary(resized)).not.toBe(catalogSummary(catalog("A", "AA", "M")));
  });
});
