import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Spec package-repositories, "Tests": repos-smoke.sh installs from, upgrades and tampers with
// each repository in containers pinned by digest, on every pull request that changes
// tools/package/ (pkgbuild.yml's repos job), with docker there and podman where a developer
// prefers it.
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const script = read("tools/package/repos-smoke.sh");
const workflow = read(".github/workflows/pkgbuild.yml");

function job(text: string, id: string) {
  const body = text.slice(text.indexOf("\njobs:\n") + 7);
  const parts = body.split(/^ {2}([a-z][a-z0-9-]*):\n/m).slice(1);
  for (let i = 0; i < parts.length; i += 2) if (parts[i] === id) return parts[i + 1] ?? "";
  throw new Error(`no job ${id}`);
}

describe("repos-smoke.sh", () => {
  it("is valid bash", () => {
    const r = spawnSync("bash", ["-n"], { input: script });
    expect(r.status, r.stderr?.toString()).toBe(0);
  });

  it("pins every image by digest, with a fully qualified name podman resolves", () => {
    const images = [...script.matchAll(/^([A-Z]+_IMAGE)=(.*)$/gm)];
    expect(images.map((m) => m[1]).sort()).toEqual([
      "ARCH_IMAGE",
      "BUILDER_IMAGE",
      "DEBIAN_IMAGE",
      "FEDORA_IMAGE",
      "OPENSUSE_IMAGE",
      "UBUNTU_IMAGE",
    ]);
    for (const [, , ref] of images)
      expect(ref).toMatch(/^docker\.io\/[a-z]+\/[a-z]+@sha256:[0-9a-f]{64}$/);
  });

  it("takes the container engine from CONTAINER_ENGINE, docker by default", () => {
    expect(script).toContain("ENGINE=${CONTAINER_ENGINE:-docker}");
    const code = script.replace(/^\s*#.*$/gm, "");
    expect(code).not.toMatch(/\b(?:docker|podman) (?:run|pull|build)\b/);
  });

  it("covers apt, dnf, zypper and pacman, and each kind of refusal", () => {
    for (const client of ["debian", "ubuntu", "fedora", "opensuse", "arch"]) {
      expect(script).toMatch(new RegExp(`\\b${client}:\\$[A-Z]+_IMAGE\\b`));
    }
    for (const what of [
      "tampered InRelease",
      "InRelease signed by another key",
      "tampered .deb",
      "tampered repomd.xml",
      "repomd.xml signed by another key",
      "tampered .rpm",
      ".rpm signed by another key",
      "tampered vimma.db",
      "vimma.db signed by another key",
      "tampered package",
      "package signed by another key",
    ]) {
      expect(script).toContain(`refuse "${what}"`);
    }
  });
});

describe("pkgbuild.yml repos job", () => {
  const repos = job(workflow, "repos");

  it("runs the smoke test and the tool tests with every tool required", () => {
    expect(repos).toContain("run: tools/package/repos-smoke.sh");
    expect(repos).toMatch(/VIMMA_REQUIRE_TOOLS: >-\n\s+gpg,gpgv,sqv,rpm,rpmbuild,rpmsign,/);
    expect(repos).toContain("tools/package/test/openpgp-kms.test.ts");
    expect(repos).toContain("tools/package/test/repos.test.ts");
  });

  it("holds no secret and no KMS access", () => {
    expect(repos).not.toMatch(/secrets\.|id-token|environment:|google-github-actions/);
  });
});
