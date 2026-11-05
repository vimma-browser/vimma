// docs/specs/m6a-updater.md §7, sub-PR 4: release.yml and nightly.yml build Firefox's updater in
// (VIMMA_UPDATES=1) and check what they packaged with tools/update/check-build.mjs; a release
// also ships a complete MAR, signed by update-publish.yml's mar-sign job (the one place the
// update key signs), checked with the committed certificates and Mozilla's signmar, and listed
// in SHA256SUMS, which release.yml's cosign signature covers. The nightly builds its MAR too, as
// a check of the release's MAR step, and neither signs nor uploads it until public nightly
// releases start (decision 23). The workflows are read as text, as release-workflow.test.mjs
// reads release.yml.
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../test/temp-dir.mjs";

/** @param {string} name */
const workflow = (name) =>
  readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), "utf8");

/**
 * @param {string} text
 * @returns {Map<string, string>} job id -> its YAML block
 */
function jobsOf(text) {
  const body = text.slice(text.indexOf("\njobs:\n") + 7);
  const parts = body.split(/^ {2}([a-z][a-z0-9-]*):\n/m).slice(1);
  /** @type {Map<string, string>} */
  const map = new Map();
  for (let i = 0; i < parts.length; i += 2) map.set(parts[i] ?? "", parts[i + 1] ?? "");
  return map;
}

/** @param {string} block */
function condition(block) {
  const match = /^ {4}if: (>-\n(?: {6}.*\n)+|.*\n)/m.exec(block);
  return (match?.[1] ?? "").replace(/^>-\n/, "").replace(/\s+/g, " ").trim();
}

/**
 * One step of `block`, from its `- name:` line up to the next step.
 * @param {string} block
 * @param {string} name
 */
function stepOf(block, name) {
  const start = block.indexOf(`- name: ${name}\n`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = block.slice(start + 1);
  const end = rest.search(/\n {6}- (?:name|uses):/);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * @param {string} block
 * @param {string} name
 */
function runOf(block, name) {
  const step = stepOf(block, name);
  const lines = step.slice(step.indexOf("run: |\n") + 8).split("\n");
  while (lines.length > 0 && /^ {6}#|^\s*$/.test(lines.at(-1) ?? "")) lines.pop();
  return lines.map((l) => l.replace(/^ {10}/, "")).join("\n");
}

/** The `permissions:` lines of a job. @param {string} block */
function permissionsOf(block) {
  const m = /^ {4}permissions:\n((?: {6}.*\n)+)/m.exec(block);
  return (m?.[1] ?? "")
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean);
}

const GUARD =
  "vars.RELEASE_ENABLED == 'true' && github.repository == 'vimma-browser/vimma' && " +
  "github.ref == 'refs/heads/main'";
/** A job after the MAR's: it runs when the MAR is in, or when update notices are off. */
const MAR_DONE =
  "(needs.mar.result == 'success' || (needs.mar.result == 'skipped' && vars.UPDATES_ENABLED != 'true'))";

describe("release.yml: the updater and the complete MAR", () => {
  const all = jobsOf(workflow("release.yml"));
  const job = (/** @type {string} */ id) => all.get(id) ?? "";

  it("builds Firefox's updater in, for every mach call of the Linux build", () => {
    expect(job("build")).toMatch(/^ {4}env:\n(?: {6}#.*\n)* {6}VIMMA_UPDATES: "1"\n/m);
    // The Mac build is updated by Homebrew or its own manifest notice (spec macos-homebrew).
    expect(job("macos-build")).not.toContain("VIMMA_UPDATES");
  });

  it("hands this build's MAR tools to the later jobs, and nothing that holds a secret", () => {
    const run = runOf(job("build"), "MAR tools for the package and mar jobs");
    for (const tool of [
      '"$MOZ_OBJDIR/dist/host/bin/mar"',
      "engine/tools/update-packaging/make_full_update.sh",
      "engine/tools/update-packaging/common.sh",
      '"$MOZ_OBJDIR/dist/bin/signmar"',
      "engine/toolkit/mozapps/update/updater/*.der mar-tools/mozilla-certs/",
    ]) {
      expect(run).toContain(tool);
    }
    expect(run).not.toMatch(/safebrowsing|SAFEBROWSING/);
    const build = job("build");
    expect(build.indexOf("- name: MAR tools for the package and mar jobs")).toBeGreaterThan(
      build.indexOf("- name: Delete the Safe Browsing key file"),
    );
    expect(build).toContain("name: mar-tools\n");
  });

  it("package checks the release tarball's updater, whether or not updates are on", () => {
    const step = stepOf(job("package"), "Check the updater in the release tarball");
    expect(step).not.toMatch(/^ {8}if:/m);
    expect(step).toContain(
      'node tools/update/check-build.mjs "$unpacked/vimma" --mozilla-certs mar-tools/mozilla-certs',
    );
    expect(step).toContain('tar -xJf "dist/vimma-${TAG#v}-linux-x86_64.tar.xz" -C "$unpacked"');
  });

  it("package builds the MAR from the release tarball, for the release channel, unsigned", () => {
    const step = stepOf(job("package"), "Build the complete MAR (unsigned, with its placeholder)");
    expect(step).toContain("if: vars.UPDATES_ENABLED == 'true'");
    const run = runOf(job("package"), "Build the complete MAR (unsigned, with its placeholder)");
    expect(run).toContain('mar="vimma-${TAG#v}-linux-x86_64.complete.mar"');
    expect(run).toContain(
      'node tools/update/mar.mjs build --tarball "dist/vimma-${TAG#v}-linux-x86_64.tar.xz" --tools mar-tools --channel vimma --out "mar/$mar"',
    );
    expect(run).toContain('echo "mar=$mar" >> "$GITHUB_OUTPUT"');
    expect(job("package")).toMatch(
      /^ {4}outputs:\n {6}mar: \$\{\{ steps\.mar\.outputs\.mar \}\}$/m,
    );
    expect(job("package")).toContain("name: mar-unsigned\n");
    // The MAR is not in dist/ yet: SHA256SUMS lists it only once it is signed and checked.
    expect(run).not.toContain("dist/$mar");
  });

  it("mar-sign calls update-publish.yml, the one workflow the key signs for", () => {
    const block = job("mar-sign");
    expect(block).toMatch(/^ {4}needs: package$/m);
    expect(condition(block)).toBe(`${GUARD} && vars.UPDATES_ENABLED == 'true'`);
    expect(permissionsOf(block)[0]).toBe("id-token: write");
    expect(block).toMatch(/^ {4}uses: \.\/\.github\/workflows\/update-publish\.yml$/m);
    expect(block).toMatch(/^ {4}with:\n {6}mar: \$\{\{ needs\.package\.outputs\.mar \}\}$/m);
    expect(block).not.toMatch(/secrets|environment:/);
  });

  // GitHub refuses a call whose jobs ask for more than the caller allows, skipped jobs included
  // (docs.github.com, "Reusing workflows", access and permissions), so the caller's permissions
  // are the union of what update-publish.yml's jobs ask for; each job still gets only its own.
  it("mar-sign's permissions are the ceiling update-publish.yml's jobs need, no more", () => {
    const called = jobsOf(workflow("update-publish.yml"));
    /** @type {Set<string>} */
    const union = new Set();
    for (const block of called.values()) for (const p of permissionsOf(block)) union.add(p);
    expect(new Set(permissionsOf(job("mar-sign")))).toEqual(union);
    expect(permissionsOf(called.get("mar-sign") ?? "")).toEqual(["id-token: write"]);
    expect([...union].sort()).toEqual([
      "actions: write",
      "contents: read",
      "id-token: write",
      "issues: write",
      "pull-requests: read",
    ]);
  });

  it("mar fails, loudly, when the MAR was not signed, so a release never stops silently", () => {
    const block = job("mar");
    expect(condition(block)).toBe(
      `always() && ${GUARD} && vars.UPDATES_ENABLED == 'true' && needs.package.result == 'success'`,
    );
    expect(block).toContain("MAR_SIGN: ${{ needs.mar-sign.result }}");
    const run = runOf(block, "The MAR was signed");
    for (const [result, status] of [
      ["success", 0],
      ["skipped", 1],
      ["failure", 1],
      ["cancelled", 1],
    ]) {
      const r = spawnSync("bash", ["-e", "-c", run], {
        encoding: "utf8",
        env: { ...process.env, MAR_SIGN: String(result) },
      });
      expect(r.status, String(result)).toBe(status);
    }
    expect(block.indexOf("- name: The MAR was signed")).toBeLessThan(
      block.indexOf("uses: actions/checkout@"),
    );
  });

  it("mar checks the signed MAR with no secret: same content, the certificates, signmar", () => {
    const block = job("mar");
    expect(block).toMatch(/^ {4}needs: \[build, package, mar-sign\]$/m);
    expect(permissionsOf(block)).toEqual(["contents: read"]);
    expect(block).not.toMatch(/environment:|secrets\.|id-token/);
    expect(block).toContain("ref: ${{ needs.build.outputs.sha }}");
    const run = runOf(block, "Check the signed MAR");
    expect(run).toContain(
      'node tools/update/mar.mjs same-content --placeholder "mar-unsigned/$MAR" --signed "mar-signed/$MAR"',
    );
    expect(run).toContain(
      'node tools/update/mar.mjs verify --mar "mar-signed/$MAR" --cert configs/updater/primary.der --cert configs/updater/secondary.der --channel vimma --product-version "$firefox"',
    );
    expect(run).toMatch(/mar-tools\/signmar -d "sql:\$db" -n primary -v "mar-signed\/\$MAR"/);
    expect(run).toMatch(/mar-tools\/signmar -d "sql:\$db" -n secondary -v "mar-signed\/\$MAR"/);
    expect(run.indexOf("same-content")).toBeLessThan(run.indexOf("signmar -d"));
    expect(block).toContain("name: release-mar\n");
  });

  it("lists the MAR in SHA256SUMS, sorted by name as package.mjs writes it", () => {
    const run = runOf(job("mar"), "Add the MAR to SHA256SUMS");
    const dir = tempDir("vimma-mar-sums-");
    for (const d of ["dist", "mar-signed"]) mkdirSync(join(dir, d));
    const files = { "vimma-0.3.1-linux-x86_64.tar.xz": "t", "vimma-0.3.1-x86_64.AppImage": "a" };
    const sum = (/** @type {string} */ s) => createHash("sha256").update(s).digest("hex");
    for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, "dist", f), c);
    writeFileSync(
      join(dir, "dist", "SHA256SUMS"),
      Object.entries(files)
        .map(([f, c]) => `${sum(c)}  ${f}\n`)
        .join(""),
    );
    const mar = "vimma-0.3.1-linux-x86_64.complete.mar";
    writeFileSync(join(dir, "mar-signed", mar), "MAR1 signed");
    const r = spawnSync("bash", ["-e", "-o", "pipefail", "-c", run], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, MAR: mar },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(dir, "release-mar", "SHA256SUMS"), "utf8")).toBe(
      `${sum("MAR1 signed")}  ${mar}\n${sum("t")}  vimma-0.3.1-linux-x86_64.tar.xz\n${sum("a")}  vimma-0.3.1-x86_64.AppImage\n`,
    );
    expect(readFileSync(join(dir, "release-mar", mar), "utf8")).toBe("MAR1 signed");
    // The release artifact with release-mar over it, as sign and publish download them.
    execFileSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: join(dir, "dist"), stdio: "pipe" });
  });

  it("cosign signs the MAR with the other assets, after it is checked", () => {
    const block = job("sign");
    expect(block).toMatch(/^ {4}needs: \[package, mar\]$/m);
    const cond = condition(block);
    expect(cond).toContain("always() && ");
    expect(cond).toContain(GUARD);
    expect(cond).toContain("vars.SIGNING_ENABLED == 'true'");
    expect(cond).toContain("needs.package.result == 'success'");
    expect(cond).toContain(MAR_DONE);
    const download = block.slice(block.indexOf("name: release-mar") - 200);
    expect(download).toContain("if: needs.mar.result == 'success'");
    expect(block.indexOf("name: release\n")).toBeLessThan(block.indexOf("name: release-mar\n"));
    expect(runOf(block, "Sign every asset")).toContain("for f in dist/vimma* ");
  });

  it("publish uploads the MAR and the new SHA256SUMS, never a release that lost its MAR", () => {
    const block = job("publish");
    expect(block).toMatch(/^ {4}needs: \[build, package, mar, sign\]$/m);
    expect(condition(block)).toContain(MAR_DONE);
    const download = block.slice(block.indexOf("name: release-mar") - 200);
    expect(download).toContain("if: needs.mar.result == 'success'");
    expect(block.indexOf("name: release\n")).toBeLessThan(block.indexOf("name: release-mar\n"));
  });

  it("a failed MAR job opens the release-failure issue", () => {
    const needs = /^ {4}needs:\n((?: {6}- .*\n)+)/m.exec(job("failure"))?.[1] ?? "";
    expect(needs).toContain("      - mar-sign\n");
    expect(needs).toContain("      - mar\n");
  });
});

describe("nightly.yml: the updater, its channel, and the MAR step", () => {
  const text = workflow("nightly.yml");
  const build = jobsOf(text).get("build") ?? "";

  it("builds Firefox's updater in", () => {
    expect(build).toMatch(/^ {4}env:\n(?: {6}.*\n)*? {6}VIMMA_UPDATES: "1"\n/m);
  });

  it("packages for the nightly channel and checks the updater before the upload", () => {
    const run = runOf(build, "Nightly update channel, and the updater checked");
    expect(run).toContain(
      'node tools/update/channel.mjs --tarball "$tarball" --channel vimma-nightly --out "$tarball.new"',
    );
    expect(run).toContain(
      'node tools/update/check-build.mjs "$unpacked/vimma" --channel vimma-nightly',
    );
    const at = (/** @type {string} */ name) => build.indexOf(`- name: ${name}\n`);
    expect(at("Nightly update channel, and the updater checked")).toBeGreaterThan(at("Package"));
    expect(at("Nightly update channel, and the updater checked")).toBeLessThan(
      at("Upload the package"),
    );
  });

  it("runs the release's MAR step for the nightly channel, and keeps no MAR", () => {
    const run = runOf(build, "Complete MAR (a check of the release's MAR step; not kept)");
    expect(run).toContain("--channel vimma-nightly");
    expect(run).toContain("node tools/update/mar.mjs build");
    expect(run).toContain('--out "$RUNNER_TEMP/nightly.complete.mar"');
    expect(run).not.toMatch(/--out "?dist/);
    // No signature until public nightly releases (decision 23): no key, no environment.
    expect(text).not.toMatch(/update-signing|id-token|update-publish\.yml/);
  });
});
