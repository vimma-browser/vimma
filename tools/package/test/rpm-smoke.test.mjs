import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Spec rpm-package: the .rpm is installed with dnf on Fedora and with zypper on openSUSE, in
// containers pinned by digest, on every pull request that changes the packaging code (a stub
// tarball, pkgbuild.yml) and on the release build before anything is signed (release.yml).
const read = (/** @type {string} */ path) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const script = read("tools/package/rpm-smoke.sh");

/**
 * A job's YAML block.
 * @param {string} text
 * @param {string} id
 */
function job(text, id) {
  const body = text.slice(text.indexOf("\njobs:\n") + 7);
  const parts = body.split(/^ {2}([a-z][a-z0-9-]*):\n/m).slice(1);
  for (let i = 0; i < parts.length; i += 2) if (parts[i] === id) return parts[i + 1] ?? "";
  throw new Error(`no job ${id}`);
}

describe("rpm-smoke.sh", () => {
  it("is valid bash", () => {
    const r = spawnSync("bash", ["-n"], { input: script });
    expect(r.status, r.stderr?.toString()).toBe(0);
  });

  it("pins a Fedora and an openSUSE image by digest", () => {
    expect(script).toMatch(/^FEDORA_IMAGE=fedora@sha256:[0-9a-f]{64}$/m);
    expect(script).toMatch(/^OPENSUSE_IMAGE=opensuse\/leap@sha256:[0-9a-f]{64}$/m);
    const code = script.replace(/^\s*#.*$/gm, "");
    expect(code).not.toMatch(/(?:fedora|opensuse\/[a-z]+):[a-z0-9.]+/);
    expect(code).toMatch(/docker run --rm .* "\$image" \\\n/);
  });

  it("installs with each distribution's own package manager, resolving the requirements", () => {
    expect(script).toContain("dnf install -y");
    // zypper refuses an unsigned package unless told; the release's cosign signature covers it.
    expect(script).toContain("zypper --non-interactive install --allow-unsigned-rpm");
  });

  it("checks the version line, the marker, the launcher, the desktop file and rpm -V", () => {
    expect(script).toContain("version=$(vimma --version)");
    expect(script).toContain('[ "$version" = "$expected" ]');
    expect(script).toContain('[ "$marker" = "vimma-package=rpm" ]');
    expect(script).toContain("cmp /usr/lib/vimma/vimma-open /repo/tools/package/vimma-open.sh");
    expect(script).toContain("desktop-file-validate /usr/share/applications/vimma-vimma.desktop");
    expect(script).toContain("rpm -V vimma");
  });

  it("starts a real build headless and takes a screenshot, then removes the package cleanly", () => {
    expect(script).toMatch(/--headless --no-remote --profile "\$p" --screenshot/);
    expect(script).toContain("rpm -e vimma");
    expect(script).toContain("test ! -e /usr/lib/vimma");
  });

  it("packages a stub tarball with --stub, without the .deb", () => {
    expect(script).toMatch(/package\.mjs" --tarball .* --no-deb/s);
  });
});

describe("release.yml runs it on the release build", () => {
  const release = read(".github/workflows/release.yml");
  const pkg = job(release, "package");

  it("installs rpmbuild from Ubuntu's archive with the other packaging tools", () => {
    expect(pkg).toMatch(/sudo apt-get install -y -q desktop-file-utils rpm\n/);
  });

  it("smoke-tests the .rpm on Fedora and openSUSE before the files are uploaded for signing", () => {
    const run = 'tools/package/rpm-smoke.sh dist "$(node tools/release/version-line.mjs)"';
    expect(pkg).toContain(run);
    expect(pkg.indexOf(run)).toBeLessThan(pkg.indexOf("actions/upload-artifact"));
  });

  it("signs and uploads the .rpm with the other vimma* assets", () => {
    expect(job(release, "sign")).toContain("for f in dist/vimma* ");
    expect(job(release, "publish")).toContain('gh release upload "$TAG" dist/vimma* ');
  });
});

describe("pkgbuild.yml runs it on a stub", () => {
  const block = job(read(".github/workflows/pkgbuild.yml"), "rpm");

  it("installs rpmbuild and runs the stub smoke test on a hosted Ubuntu runner", () => {
    expect(block).toMatch(/^ {4}runs-on: ubuntu-24\.04$/m);
    expect(block).toContain("sudo apt-get install -y -q rpm");
    expect(block).toMatch(/^ {8}run: tools\/package\/rpm-smoke\.sh --stub$/m);
    expect(block).toMatch(/persist-credentials: false/);
  });
});
