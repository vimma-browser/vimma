// update-publish.yml (docs/specs/m6a-updater.md §7; docs/runbook/ci-update-keys-and-update-host.md,
// "Update signing keys and the update host"): a published release gets a signed update manifest on
// updates.vimma.dev.
// The workflow is read as text, as release-workflow.test.ts reads release.yml, and its signing
// step is run here with a stand-in for gcloud that signs the way Cloud KMS's raw PKCS#1 key
// does, so the bytes it writes are checked by the verifier the browser runs.
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../test/temp-dir.ts";
import { haveTool, missingRequired } from "../../package/test/have-tool.ts";
import { testKey } from "../../test/test-keys.ts";
import { IDENTITY_REGEXP } from "../../package/package.ts";
import {
  base64Encode,
  spkiKeyId,
  verifyManifest,
} from "../../../packages/vimma-core/src/updates/updates.mjs";
import { buildManifest, buildNightlyManifest, serialAt } from "../manifest.ts";
import { addSignaturePlaceholder, insertSignature, readMar, verifyMar } from "../mar.ts";

const text = readFileSync(
  new URL("../../../.github/workflows/update-publish.yml", import.meta.url),
  "utf8",
);

/** @returns job id -> its YAML block */
function jobs(): Map<string, string> {
  const body = text.slice(text.indexOf("\njobs:\n") + 7);
  const parts = body.split(/^ {2}([a-z][a-z0-9-]*):\n/m).slice(1);
  const map: Map<string, string> = new Map();
  for (let i = 0; i < parts.length; i += 2) map.set(parts[i] ?? "", parts[i + 1] ?? "");
  return map;
}
const all = jobs();
const job = (id: string) => all.get(id) ?? "";

function condition(block: string) {
  const match = /^ {4}if: (>-\n(?: {6}.*\n)+|.*\n)/m.exec(block);
  return (match?.[1] ?? "").replace(/^>-\n/, "").replace(/\s+/g, " ").trim();
}

/**
 * One step of `block`, from its `- name:` line up to the next step.
 */
function stepOf(block: string, name: string) {
  const start = block.indexOf(`- name: ${name}\n`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = block.slice(start + 1);
  const end = rest.search(/\n {6}- (?:name|uses):/);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The `run:` script of the step called `name`, unindented.
 */
function runOf(block: string, name: string) {
  const step = stepOf(block, name);
  const lines = step.slice(step.indexOf("run: |\n") + 8).split("\n");
  return lines.map((l) => l.replace(/^ {10}/, "")).join("\n");
}

/** The `permissions:` lines of a job, as `name: value`. */
function permissionsOf(block: string) {
  const m = /^ {4}permissions:(?: (\{\})\n|\n((?: {6}.*\n)+))/m.exec(block);
  if (!m) return null;
  if (m[1]) return [];
  return (m[2] ?? "")
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean);
}

/**
 * The flags GitHub runs a job's `run:` steps with: `shell: bash` gives
 * `bash --noprofile --norc -eo pipefail {0}`, and no shell gives `bash -e {0}`, without pipefail.
 */
function githubShell(block: string) {
  return /^ {4}defaults:\n {6}run:\n {8}shell: bash$/m.test(block)
    ? ["--noprofile", "--norc", "-eo", "pipefail"]
    : ["-e"];
}

/** The step of `block` that uses the action `prefix`, up to the next step. */
function stepOfUses(block: string, prefix: string) {
  const start = block.indexOf(`- uses: ${prefix}`);
  expect(start, prefix).toBeGreaterThan(-1);
  const rest = block.slice(start + 1);
  const end = rest.search(/\n {6}- (?:name|uses):/);
  return end === -1 ? rest : rest.slice(0, end);
}
const has = haveTool;
/** GNU tar, which package-sign compares with libarchive's bsdtar. */
const hasGnuTar =
  has("tar") && /GNU tar/.test(spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout ?? "");

const GUARD =
  "github.event_name == 'workflow_dispatch' && github.repository == 'vimma-browser/vimma' && " +
  "github.ref == 'refs/heads/main'";

describe("update-publish.yml", () => {
  it("has the jobs: the release manifest's and repositories', mar-sign, package-sign, the nightly manifest's, failure", () => {
    expect([...all.keys()]).toEqual([
      "start",
      "prepare",
      "sign",
      "repo-prepare",
      "repo-sign",
      "publish",
      "mar-sign",
      "package-sign",
      "nightly-prepare",
      "nightly-sign",
      "nightly-publish",
      "failure",
    ]);
  });

  it("runs when a release is published, or by hand; never on a push or a pull request", () => {
    const on = text.slice(text.indexOf("\non:\n"), text.indexOf("\npermissions:"));
    // `released`: a release published as a full release, or a pre-release promoted to one;
    // never a pre-release (which `published` would also start).
    expect(on).toMatch(/^ {2}release:\n {4}types: \[released\]$/m);
    expect(on).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(on).not.toMatch(/pull_request|push:|schedule|workflow_run/);
    for (const input of ["tag", "offer", "target", "dry_run"]) {
      expect(on).toContain(`\n      ${input}:\n`);
    }
  });

  // Spec macos-homebrew, decision 16: one manifest per build target, the same jobs for each.
  it("takes the target as a choice, linux unless asked, and derives every per-target name", () => {
    const on = text.slice(text.indexOf("\n      target:\n"), text.indexOf("\n      dry_run:\n"));
    expect(on).toContain("type: choice");
    expect(on).toContain("options: [linux, macos]");
    expect(on).toContain("default: linux");
    expect(text).toContain("\n  TARGET_OS: ${{ inputs.target || 'linux' }}\n");
    expect(text).toContain(
      "\n  BUILD_TARGET: ${{ inputs.target == 'macos' && 'Darwin_aarch64-gcc3' || 'Linux_x86_64-gcc3' }}\n",
    );
    expect(text).toContain(
      "\n  SUMS: ${{ inputs.target == 'macos' && 'SHA256SUMS-macos' || 'SHA256SUMS' }}\n",
    );
    // Every path and check reads BUILD_TARGET; no step names a target of its own.
    expect(text.split("Linux_x86_64-gcc3").length - 1).toBe(1);
    expect(text.split("Darwin_aarch64-gcc3").length - 1).toBe(1);
    const check = runOf(job("prepare"), "Check the inputs");
    expect(check).toContain('case "$TARGET_OS" in');
    expect(check).toContain("linux|macos) ;;");
  });

  it("builds a macOS manifest on macOS (hdiutil reads the app's build ID), signs on Linux", () => {
    // A one-leg matrix, so that the runner check
    // (docs/security/14-build-and-release-supply-chain.md, B5) sees every runner it can take; the
    // exclude drops the other target's.
    expect(job("prepare")).toContain(
      "\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n" +
        "        os: [ubuntu-24.04, macos-15]\n        exclude:\n" +
        "          - os: ${{ inputs.target == 'macos' && 'ubuntu-24.04' || 'macos-15' }}\n",
    );
    expect(job("sign")).toContain("\n    runs-on: ubuntu-24.04\n");
    expect(job("publish")).toContain("\n    runs-on: ubuntu-24.04\n");
  });

  it("downloads the target's files and sums, and passes the target to manifest.ts", () => {
    for (const id of ["prepare", "publish"]) {
      const run = runOf(job(id), "Download the release's files");
      expect(run, id).toContain('macos) files=("vimma-$v-macos-aarch64.dmg") ;;');
      expect(run, id).toContain(
        'linux) files=("vimma-$v-linux-x86_64.tar.xz" "vimma-$v-x86_64.AppImage" "vimma_${v}_amd64.deb" "vimma-$v-1.x86_64.rpm") ;;',
      );
    }
    expect(runOf(job("prepare"), "Download the release's files")).toContain(
      'for f in "$SUMS" "${files[@]}"; do',
    );
    expect(runOf(job("prepare"), "Verify the release's signature")).toContain(
      '--bundle "assets/$SUMS.sigstore.json"',
    );
    expect(runOf(job("prepare"), "The published manifest")).toContain(
      "path=updates/browser/$BUILD_TARGET/vimma/update.xml",
    );
    const build = runOf(job("prepare"), "Build the manifest");
    expect(build.split('--target "$TARGET_OS"').length - 1).toBe(2);
    const verify = runOf(job("publish"), "Verify the signed manifest");
    expect(verify.split('--target "$TARGET_OS"').length - 1).toBe(2);
    const push = runOf(job("publish"), "Push to vimma-updates");
    expect(push.split('--target "$TARGET_OS"').length - 1).toBe(2);
    expect(push).toContain("dest=updates/public/updates/browser/$BUILD_TARGET/vimma/update.xml");
    expect(push).toContain("git add public/updates/browser/$BUILD_TARGET/vimma/update.xml");
    expect(runOf(job("publish"), "Wait until the update host serves it")).toContain(
      "url=https://updates.vimma.dev/updates/browser/$BUILD_TARGET/vimma/update.xml",
    );
    expect(runOf(job("sign"), "Check what is about to be signed")).toContain(
      `grep -Eqx "<updates vimmaChannel=\\"vimma\\" vimmaTarget=\\"$BUILD_TARGET\\" vimmaSerial=\\"[0-9]{14}\\">"`,
    );
  });

  it("a published release whose .dmg is already there starts the macOS manifest too", () => {
    const run = runOf(job("start"), "Start the manifest run on main");
    expect(run).toContain('"https://api.github.com/repos/$GITHUB_REPOSITORY/releases/tags/$TAG"');
    expect(run).toContain(
      'if [ "$code" = 200 ] && jq -e --arg f "vimma-${TAG#v}-macos-aarch64.dmg" \\',
    );
    expect(run).toContain(
      'gh workflow run update-publish.yml --repo "$GITHUB_REPOSITORY" --ref main -f tag="$TAG" -f target=macos',
    );
  });

  it("grants nothing by default, and each job only what it needs", () => {
    expect(text).toMatch(/^permissions: \{\}$/m);
    expect(permissionsOf(job("start"))).toEqual(["actions: write", "contents: read"]);
    expect(permissionsOf(job("prepare"))).toEqual(["contents: read", "pull-requests: read"]);
    expect(permissionsOf(job("sign"))).toEqual(["id-token: write"]);
    expect(permissionsOf(job("repo-prepare"))).toEqual(["contents: read"]);
    expect(permissionsOf(job("repo-sign"))).toEqual(["id-token: write"]);
    expect(permissionsOf(job("publish"))).toEqual(["contents: read"]);
    expect(permissionsOf(job("mar-sign"))).toEqual(["id-token: write"]);
    expect(permissionsOf(job("package-sign"))).toEqual(["id-token: write"]);
    expect(permissionsOf(job("nightly-prepare"))).toEqual(["contents: read"]);
    expect(permissionsOf(job("nightly-sign"))).toEqual(["id-token: write"]);
    expect(permissionsOf(job("nightly-publish"))).toEqual(["contents: read"]);
    expect(permissionsOf(job("failure"))).toEqual(["issues: write"]);
  });

  // The two signing jobs: the manifest's and the MAR's. Both are this file's, so Google Cloud's
  // job_workflow_ref condition (update-publish.yml at refs/heads/main) admits both and nothing
  // else.
  it("only sign, mar-sign and nightly-sign mint an OIDC token or name the signing environment", () => {
    const signers = ["sign", "mar-sign", "nightly-sign"];
    for (const [id, block] of all) {
      // The package key's job, with its own environment: the tests below.
      if (id === "repo-sign" || id === "package-sign") continue;
      expect(block.includes("id-token"), id).toBe(signers.includes(id));
      expect(block.includes("update-signing"), id).toBe(signers.includes(id));
      expect(block.includes("GCP_"), id).toBe(signers.includes(id));
    }
    for (const id of signers) expect(job(id)).toMatch(/^ {4}environment: update-signing$/m);
  });

  // Spec package-repositories, decisions 15 and 16: the repositories' jobs run in the run on
  // main that signs the Linux release's manifest, and only while PACKAGE_REPOS_ENABLED is true.
  it("repo-prepare and repo-sign run in the Linux release's run on main, only with PACKAGE_REPOS_ENABLED", () => {
    const want =
      `${GUARD} && (vars.UPDATES_ENABLED == 'true' || inputs.dry_run) && ` +
      "vars.PACKAGE_REPOS_ENABLED == 'true' && inputs.target != 'macos' && inputs.offer != 'nothing' && " +
      "!inputs.mar && startsWith(github.workflow_ref, 'vimma-browser/vimma/.github/workflows/update-publish.yml@')";
    expect(condition(job("repo-prepare"))).toBe(want);
    expect(condition(job("repo-sign"))).toBe(want);
    expect(job("repo-prepare")).toMatch(/^ {4}needs: prepare$/m);
    expect(job("repo-sign")).toMatch(/^ {4}needs: repo-prepare$/m);
    // The metadata comes from this run's repo-prepare, never another run's.
    const download = stepOfUses(job("repo-sign"), "actions/download-artifact@");
    expect(download).toContain("name: repos-unsigned");
    expect(download).not.toMatch(/run-id|github-token|repository:/);
  });

  it("nothing is signed while PACKAGE_REPOS_ENABLED is not true", () => {
    for (const [id, block] of all) {
      if (block.includes("environment: package-signing")) {
        expect(condition(block), id).toContain("vars.PACKAGE_REPOS_ENABLED == 'true'");
      }
    }
    expect(condition(job("repo-prepare"))).toContain("vars.PACKAGE_REPOS_ENABLED == 'true'");
  });

  it("repo-prepare stops with what to do while the certificate is not committed", () => {
    const run = runOf(job("repo-prepare"), "The committed certificate");
    const dir = tempDir("vimma-repo-cert-");
    const attempt = () =>
      spawnSync("bash", [...githubShell(job("repo-prepare")), "-c", run], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, CERT: "configs/package-signing/vimma-packages.asc" },
      });
    const missing = attempt();
    expect(missing.status).toBe(1);
    expect(missing.stdout).toMatch(
      /^::error::configs\/package-signing\/vimma-packages\.asc is missing: .*docs\/runbook\/ci-update-keys-and-update-host\.md.*PACKAGE_REPOS_ENABLED/m,
    );
    mkdirSync(join(dir, "configs/package-signing"), { recursive: true });
    writeFileSync(join(dir, "configs/package-signing/vimma-packages.asc"), "not a key\n");
    expect(attempt().stdout).toContain("is not an armoured OpenPGP certificate");
    writeFileSync(
      join(dir, "configs/package-signing/vimma-packages.asc"),
      "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nAAAA\n-----END PGP PUBLIC KEY BLOCK-----\n",
    );
    expect(attempt().status).toBe(0);
    // Before anything else of the job, and before repo-sign could start.
    expect(job("repo-prepare").indexOf("- name: The committed certificate")).toBeLessThan(
      job("repo-prepare").indexOf("- name: The releases the repositories keep"),
    );
  });

  it("repo-prepare checks each kept release against its cosign-signed SHA256SUMS and the packages' signatures", () => {
    const block = job("repo-prepare");
    const keep = runOf(block, "The releases the repositories keep");
    expect(keep).toContain(
      'gh api "repos/$GITHUB_REPOSITORY/releases?per_page=100" > releases.json',
    );
    expect(keep).toContain(
      'node tools/package/repos.ts select --releases releases.json --tag "$TAG" > tags',
    );
    expect(keep).toContain("compare/$sha...refs/heads/main");
    const sums = runOf(block, "Check the files against each release's signed SHA256SUMS");
    expect(sums).toContain(
      "--certificate-identity-regexp '^https://github\\.com/vimma-browser/vimma/\\.github/workflows/release\\.yml@refs/heads/main$'",
    );
    const sigs = runOf(block, "Check the packages' signatures against the committed certificate");
    expect(sigs).toContain(`rpmkeys --dbpath "$db" --define '_pkgverify_level all' --checksig`);
    expect(sigs).toContain('gpgv --keyring "$db/keyring.gpg"');
    const build = runOf(block, "Build the metadata");
    expect(build).toContain('node tools/package/repos.ts build --out repos --cert "$CERT"');
    expect(build).toContain(
      'node tools/package/repos.ts verify --tree repos --cert "$CERT" --releases releases.json',
    );
    expect(block.indexOf("Check the files against each release's signed SHA256SUMS")).toBeLessThan(
      block.indexOf("- name: Build the metadata"),
    );
    expect(block).not.toMatch(/id-token|environment:|secrets\./);
  });

  it("repo-sign uses the package-signing environment and runs only the signer and repos.ts's checks", () => {
    const block = job("repo-sign");
    expect(block).toMatch(/^ {4}environment: package-signing$/m);
    expect(block).not.toMatch(/update-signing|GCP_KMS_KEY_VERSION|update-primary|vimma-updates/);
    expect(block).toContain("KEY_VERSION: ${{ vars.GCP_PACKAGE_KEY_VERSION }}");
    // One checkout: the signer, repos.ts, the certificate and .nvmrc from main, nothing else.
    const checkout = stepOfUses(block, "actions/checkout@");
    expect(checkout).toMatch(
      / {8}with:\n {10}persist-credentials: false\n {10}sparse-checkout-cone-mode: false\n {10}sparse-checkout: \|\n {12}\/\.nvmrc\n {12}\/tools\/package\/openpgp-kms\.ts\n {12}\/tools\/package\/repos\.ts\n {12}\/configs\/package-signing\/vimma-packages\.asc\n?$/,
    );
    expect(block.split("actions/checkout@").length - 1).toBe(1);
    expect(runOf(block, "The signer, the checks and the certificate are main's")).toContain(
      '[ "$files" = ".nvmrc configs/package-signing/vimma-packages.asc tools/package/openpgp-kms.ts tools/package/repos.ts " ]',
    );
    // Node runs the signer and repos.ts's select and verify, and nothing else.
    expect(block).not.toMatch(/\bnpm\b|\bnpx\b/);
    const nodeLines = block.split("\n").filter((l) => /\bnode\b/.test(l) && !/^\s*#/.test(l));
    expect(nodeLines.length).toBeGreaterThan(0);
    for (const line of nodeLines) {
      expect(line).toMatch(
        /node-version-file: \.nvmrc|setup-node@|^ *node "\$REPOS" (?:select|verify) |^ *sign\(\) \{ node "\$SIGNER" sign /,
      );
    }
    expect(block).toContain("SIGNER: tools/package/openpgp-kms.ts");
    expect(block).toContain("REPOS: tools/package/repos.ts");
    expect(block).toContain("CERT: configs/package-signing/vimma-packages.asc");
    expect(block.indexOf("uses: actions/checkout@")).toBeLessThan(
      block.indexOf("name: repos-unsigned"),
    );
  });

  it("repo-sign checks the metadata against the releases it chooses itself before KMS signs", () => {
    const block = job("repo-sign");
    const check = runOf(block, "Check the metadata against the releases");
    // The releases from GitHub's list and their SHA256SUMS from GitHub, never from repo-prepare.
    expect(check).toContain(
      'gh api "repos/$GITHUB_REPOSITORY/releases?per_page=100" > releases.json',
    );
    expect(check).toContain('node "$REPOS" select --releases releases.json --tag "$TAG" > tags');
    expect(check).toContain(
      'curl -fsSL --proto =https --retry 3 -o "sums/$tag" "https://github.com/$GITHUB_REPOSITORY/releases/download/$tag/SHA256SUMS"',
    );
    expect(check).toContain(
      'node "$REPOS" verify --tree tree --cert "$CERT" --releases releases.json --regzip-pacman "${args[@]}"',
    );
    expect(block.indexOf("- name: Check the metadata against the releases")).toBeLessThan(
      block.indexOf("uses: google-github-actions/auth@"),
    );
    // Each SHA256SUMS this job reads is release.yml's: anyone with contents: write could
    // replace a release file, but not sign it as release.yml on main (B10).
    expect(check).toContain(
      'curl -fsSL --proto =https --retry 3 -o "sums/$tag.sigstore.json" "https://github.com/$GITHUB_REPOSITORY/releases/download/$tag/SHA256SUMS.sigstore.json"',
    );
    expect(check).toContain('cosign verify-blob --bundle "sums/$tag.sigstore.json"');
    expect(check).toContain(
      "--certificate-identity-regexp '^https://github\\.com/vimma-browser/vimma/\\.github/workflows/release\\.yml@refs/heads/main$'",
    );
    expect(check.indexOf("cosign verify-blob")).toBeLessThan(check.indexOf('node "$REPOS" verify'));
    expect(block.indexOf("uses: sigstore/cosign-installer@")).toBeGreaterThan(-1);
    expect(block.indexOf("uses: sigstore/cosign-installer@")).toBeLessThan(
      block.indexOf("- name: Check the metadata against the releases"),
    );
    const sign = runOf(block, "Sign the metadata with Cloud KMS");
    expect(sign).toContain(
      'sign() { node "$SIGNER" sign --key-version "$KEY_VERSION" --cert "$CERT" --format "$1" --in "tree/$2" --out "tree/$3"; }',
    );
    for (const line of [
      "sign cleartext apt/Release apt/InRelease",
      "sign armor rpm/repodata/repomd.xml rpm/repodata/repomd.xml.asc",
      "sign binary arch/x86_64/vimma.db arch/x86_64/vimma.db.sig",
      "sign binary arch/x86_64/vimma.files arch/x86_64/vimma.files.sig",
    ]) {
      expect(sign.split("\n")).toContain(line);
    }
    const after = runOf(block, "Check the signatures against the committed certificate");
    expect(after).toContain('gpgv --keyring "$db/keyring.gpg" tree/apt/InRelease');
    expect(after).toContain(
      'gpgv --keyring "$db/keyring.gpg" tree/rpm/repodata/repomd.xml.asc tree/rpm/repodata/repomd.xml',
    );
    expect(after).toContain(
      'gpgv --keyring "$db/keyring.gpg" tree/arch/x86_64/vimma.db.sig tree/arch/x86_64/vimma.db',
    );
    expect(after).toContain(
      'gpgv --keyring "$db/keyring.gpg" tree/arch/x86_64/vimma.files.sig tree/arch/x86_64/vimma.files',
    );
    expect(after).toContain(
      'node "$REPOS" verify --signed --tree tree --cert "$CERT" --releases releases.json "${args[@]}"',
    );
    const upload = block.slice(block.indexOf("name: repos-signed"));
    expect(upload).toMatch(/^name: repos-signed\n {10}path: tree\n {10}retention-days: 1/);
  });

  // Spec package-repositories, decision 3: the package key is used only through its own
  // environment, and its key version names its own ring and key.
  it("repo-sign takes only a version of the vimma-packages/package-signing key", () => {
    const run = runOf(job("repo-sign"), "The project of the key");
    const project = (version: string) =>
      spawnSync("bash", ["-e", "-c", run], {
        encoding: "utf8",
        env: { ...process.env, KEY_VERSION: version, GITHUB_OUTPUT: "/dev/null" },
      }).status;
    expect(
      project(
        "projects/vimma-p/locations/europe-north1/keyRings/vimma-packages/cryptoKeys/package-signing/cryptoKeyVersions/1",
      ),
    ).toBe(0);
    expect(
      project(
        "projects/vimma-p/locations/europe-north1/keyRings/vimma-updates/cryptoKeys/update-primary/cryptoKeyVersions/1",
      ),
    ).toBe(1);
  });

  // The signer talks to a fake KMS only in its own tests (openpgp-kms.test.ts); here it must
  // reach Cloud KMS itself.
  it("no job sets KMS_ENDPOINT", () => {
    expect(text).not.toContain("KMS_ENDPOINT");
  });

  it("the repositories' jobs, and publish's steps for them, run with pipefail", () => {
    for (const id of ["repo-prepare", "repo-sign"]) {
      expect(githubShell(job(id)), id).toContain("pipefail");
    }
    for (const name of [
      "Check the signed package repositories",
      "Push to vimma-updates",
      "Wait until the update host serves the package repositories",
    ]) {
      expect(stepOf(job("publish"), name), name).toMatch(/^ {8}shell: bash$/m);
    }
  });

  it("publish waits for repo-sign while the repositories are on, and runs without it otherwise", () => {
    const block = job("publish");
    expect(block).toMatch(/^ {4}needs: \[sign, repo-sign\]$/m);
    expect(condition(block)).toMatch(
      new RegExp(
        "^!cancelled\\(\\) && needs\\.sign\\.result == 'success' && " +
          "\\(needs\\.repo-sign\\.result == 'success' \\|\\| vars\\.PACKAGE_REPOS_ENABLED != 'true' \\|\\| " +
          "inputs\\.target == 'macos' \\|\\| inputs\\.offer == 'nothing'\\) && " +
          GUARD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ),
    );
    expect(job("failure")).toMatch(
      /^ {4}needs: \[start, prepare, sign, repo-prepare, repo-sign, publish\]$/m,
    );
  });

  // Spec package-repositories, decision 6: what the host serves as the key is the committed one.
  it("the host's key equals the committed key", () => {
    const block = job("publish");
    const check = runOf(block, "Check the signed package repositories");
    // repos.ts verify compares vimma-packages.asc, the .sources file's inline key and
    // repomd.xml.key with the committed certificate, byte for byte.
    expect(check).toContain(
      'node tools/package/repos.ts verify --signed --tree repos --cert "$CERT" --releases releases.json "${args[@]}"',
    );
    // As repo-sign: GitHub's SHA256SUMS only under release.yml's cosign signature.
    expect(check).toContain('cosign verify-blob --bundle "sums/$tag.sigstore.json"');
    expect(check.indexOf("cosign verify-blob")).toBeLessThan(check.indexOf("repos.ts verify"));
    expect(block.indexOf("uses: sigstore/cosign-installer@")).toBeLessThan(
      block.indexOf("- name: Check the signed package repositories"),
    );
    for (const sig of [
      "repos/apt/InRelease",
      "repos/rpm/repodata/repomd.xml.asc repos/rpm/repodata/repomd.xml",
      "repos/arch/x86_64/vimma.db.sig repos/arch/x86_64/vimma.db",
      "repos/arch/x86_64/vimma.files.sig repos/arch/x86_64/vimma.files",
    ]) {
      expect(check).toContain(`gpgv --keyring "$db/keyring.gpg" ${sig}`);
    }
    expect(block.indexOf("- name: Check the signed package repositories")).toBeLessThan(
      block.indexOf("- name: Push to vimma-updates"),
    );
    const served = runOf(block, "Wait until the update host serves the package repositories");
    expect(served).toContain("host=https://updates.vimma.dev\n");
    expect(served).toContain('-o served-key.asc "$host/vimma-packages.asc"');
    expect(served).toContain('cmp -s "$CERT" served-key.asc');
    // Every kind of package path redirects to its release file: the newest .deb and .rpm, the
    // pacman package and its .sig.
    for (const path of [
      '"apt/pool/$tag/vimma_${v}_amd64.deb"',
      '"rpm/packages/$tag/vimma-$v-1.x86_64.rpm"',
      '"arch/x86_64/vimma-bin-$v-1-x86_64.pkg.tar.zst"',
      '"arch/x86_64/vimma-bin-$v-1-x86_64.pkg.tar.zst.sig"',
    ]) {
      expect(served).toContain(path);
    }
    expect(served).toContain(
      '[ "$to" = "302 https://github.com/$GITHUB_REPOSITORY/releases/download/$tag/${path##*/}" ]',
    );
  });

  it("publish pushes the metadata in the manifest's commit", () => {
    const run = runOf(job("publish"), "Push to vimma-updates");
    const part = run.slice(run.indexOf('if [ "$PACKAGE_REPOS" = true ]; then\n'));
    expect(part.length).toBeLessThan(run.length);
    const dir = tempDir("vimma-push-repos-");
    const git = (args: string[], cwd: string) =>
      execFileSync("git", args, {
        cwd,
        stdio: "pipe",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: dir,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.invalid",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.invalid",
        },
      }).toString();
    git(["init", "-q", "--bare", "-b", "main", "origin.git"], dir);
    git(["clone", "-q", "origin.git", "updates"], dir);
    const put = (path: string, content: string) => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content);
    };
    // What the host has: an older release's repodata, under names this build no longer writes.
    const u = join(dir, "updates/public");
    put(join(u, "_headers"), "/updates/*\n  Cache-Control: no-cache\n");
    put(join(u, "rpm/repodata/old-primary.xml.gz"), "old");
    put(join(u, "apt/InRelease"), "old");
    git(["add", "-A"], join(dir, "updates"));
    git(["commit", "-q", "-m", "seed"], join(dir, "updates"));
    git(["push", "-q", "origin", "HEAD:main"], join(dir, "updates"));
    // This run's manifest, copied in before this part, and the signed tree.
    const manifest = "public/updates/browser/Linux_x86_64-gcc3/vimma/update.xml";
    put(join(dir, "updates", manifest), "<updates/>\n");
    const r = join(dir, "repos");
    for (const f of [
      "apt/InRelease",
      "apt/Release",
      "rpm/repodata/new-primary.xml.gz",
      "arch/x86_64/vimma.db",
      "vimma-packages.asc",
      "_redirects",
      "_headers",
    ]) {
      put(join(r, f), `new ${f}\n`);
    }
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", part], {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: dir,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
        PACKAGE_REPOS: "true",
        BUILD_TARGET: "Linux_x86_64-gcc3",
        message: "vimma 0.3.1: update manifest, serial 1",
      },
    });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const log = git(["log", "--format=%s", "main"], join(dir, "origin.git")).trim().split("\n");
    expect(log).toEqual(["vimma 0.3.1: update manifest, serial 1; package repositories", "seed"]);
    const files = git(["ls-tree", "-r", "--name-only", "main"], join(dir, "origin.git"))
      .trim()
      .split("\n")
      .sort();
    expect(files).toEqual(
      [
        manifest,
        "public/_headers",
        "public/_redirects",
        "public/apt/InRelease",
        "public/apt/Release",
        "public/arch/x86_64/vimma.db",
        "public/rpm/repodata/new-primary.xml.gz",
        "public/vimma-packages.asc",
      ].sort(),
    );
    expect(git(["show", "main:public/_headers"], join(dir, "origin.git"))).toBe("new _headers\n");
  });

  it("package-sign and repo-sign alone name the package-signing environment, with an OIDC token", () => {
    const packageJobs = ["package-sign", "repo-sign"];
    for (const [id, block] of all) {
      // repo-prepare names the certificate's path, configs/package-signing/, never the environment.
      expect(/environment: package-signing|vars\.GCP_PACKAGE_KEY_VERSION/.test(block), id).toBe(
        packageJobs.includes(id),
      );
    }
    for (const id of packageJobs) {
      expect(job(id), id).toMatch(/^ {4}environment: package-signing$/m);
      expect(job(id), id).toContain("id-token: write");
      expect(job(id), id).not.toContain("update-signing");
    }
  });

  // Spec package-repositories, decision 3: the key version must name the package key's ring and
  // key, so a variable that names the update key fails before any signing.
  it("package-sign takes only a version of the vimma-packages/package-signing key", () => {
    const run = runOf(job("package-sign"), "The project of the key");
    const project = (version: string) =>
      spawnSync("bash", ["-e", "-c", run], {
        encoding: "utf8",
        env: { ...process.env, KEY_VERSION: version, GITHUB_OUTPUT: "/dev/null" },
      }).status;
    expect(
      project(
        "projects/vimma-p/locations/europe-north1/keyRings/vimma-packages/cryptoKeys/package-signing/cryptoKeyVersions/1",
      ),
    ).toBe(0);
    expect(
      project(
        "projects/vimma-p/locations/europe-north1/keyRings/vimma-updates/cryptoKeys/update-primary/cryptoKeyVersions/1",
      ),
    ).toBe(1);
  });

  it("package-sign uses the package-signing environment and runs only the signer", () => {
    const block = job("package-sign");
    expect(condition(block)).toBe(
      "inputs.packages && !inputs.mar && github.repository == 'vimma-browser/vimma' && " +
        "github.ref == 'refs/heads/main' && vars.PACKAGE_REPOS_ENABLED == 'true' && " +
        "github.workflow_ref == 'vimma-browser/vimma/.github/workflows/release.yml@refs/heads/main'",
    );
    // One checkout: the signer, the certificate and .nvmrc from main, nothing else.
    const checkout = block.slice(block.indexOf("uses: actions/checkout@"));
    expect(checkout.slice(0, checkout.indexOf("\n      - "))).toMatch(
      / {8}with:\n {10}persist-credentials: false\n {10}sparse-checkout-cone-mode: false\n {10}sparse-checkout: \|\n {12}\/\.nvmrc\n {12}\/tools\/package\/openpgp-kms\.ts\n {12}\/configs\/package-signing\/vimma-packages\.asc\n$/,
    );
    expect(block.split("actions/checkout@").length - 1).toBe(1);
    expect(runOf(block, "The signer and the certificate are main's")).toContain(
      '[ "$files" = ".nvmrc configs/package-signing/vimma-packages.asc tools/package/openpgp-kms.ts " ]',
    );
    // Node runs the signer and nothing else: every node command line is the signer's.
    expect(block).not.toMatch(/\bnpm\b|\bnpx\b/);
    const nodeLines = block.split("\n").filter((l) => /\bnode\b/.test(l) && !/^\s*#/.test(l));
    for (const line of nodeLines) {
      expect(line).toMatch(
        /node-version-file: \.nvmrc|node=\$\(command -v node\)|\/usr\/bin\/env env \$node \$root\/\$SIGNER sign |^ *node "\$SIGNER" sign |setup-node@|for word in "\$node" "\$root" "\$KEY_VERSION"; do$/,
      );
    }
    expect(block).toContain("SIGNER: tools/package/openpgp-kms.ts");
    expect(block).toContain("CERT: configs/package-signing/vimma-packages.asc");
    // The checkout runs first: it cleans the workspace, which then holds only main's three
    // files when the signer's check runs, and the artifact after it.
    expect(block.indexOf("uses: actions/checkout@")).toBeLessThan(
      block.indexOf("name: packages-unsigned"),
    );
    const sign = runOf(block, "Sign the .rpm and the pacman package with Cloud KMS");
    expect(sign).toContain('(cd "$work" && rpmsign --addsign --define "_gpg_name Vimma packages"');
    // One definition for rpm 4.18 (an exec'd word list) and rpm 6.0 (a parametric macro).
    expect(sign).toContain(
      '--define "__gpg_sign_cmd() /usr/bin/env env $node $root/$SIGNER sign --key-version $KEY_VERSION --cert $root/$CERT --format binary --in %{?1:%{shescape:%{1}}}%{!?1:-} --out %{?2:%{shescape:%{2}}}%{!?2:%{shescape:%{__signature_filename}}}"',
    );
    expect(sign).toContain('[ "$(ls -A "$work")" = "$RPM" ]');
    expect(sign).toContain(
      'node "$SIGNER" sign --key-version "$KEY_VERSION" --cert "$CERT" --format binary \\\n  --in "in/$PKG" --out "out/$PKG.sig"',
    );
    const check = runOf(block, "Check the signatures against the committed certificate");
    expect(check).toContain(
      `rpmkeys --dbpath "$db" --define '_pkgverify_level all' --checksig "out/$RPM"`,
    );
    expect(check).toContain('gpgv --keyring "$db/keyring.gpg" "out/$PKG.sig" "in/$PKG"');
    expect(block.indexOf("- name: Check the files to sign")).toBeLessThan(
      block.indexOf("uses: google-github-actions/auth@"),
    );
  });

  // pkgbuild.yml's repos job installs these and requires them, so the archive checks run there.
  it("has every tool VIMMA_REQUIRE_TOOLS names", () => {
    expect(missingRequired(["zstd", "bsdtar"])).toEqual([]);
  });

  describe.skipIf(!has("zstd") || !has("bsdtar") || !hasGnuTar)(
    "with zstd, bsdtar and GNU tar",
    () => {
      it("package-sign signs only the caller's tag's .rpm and pacman package", () => {
        const run = runOf(job("package-sign"), "Check the files to sign");
        const rpm = "vimma-0.3.1-1.x86_64.rpm";
        const pkg = "vimma-bin-0.3.1-1-x86_64.pkg.tar.zst";
        const attempt = (files: Record<string, Buffer | string>, tag = "v0.3.1") => {
          const dir = tempDir("vimma-package-sign-");
          mkdirSync(join(dir, "in"));
          for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, "in", f), c);
          return spawnSync("bash", [...githubShell(job("package-sign")), "-c", run], {
            cwd: dir,
            encoding: "utf8",
            env: { ...process.env, CALLER_TAG: tag, GITHUB_ENV: join(dir, "env") },
          });
        };
        /** A zstd tar of these entries, in this order, as makepkg writes a package. */
        const pacman = (entries: string[]) => {
          const dir = tempDir("vimma-pkg-");
          for (const e of entries) {
            mkdirSync(join(dir, e, ".."), { recursive: true });
            writeFileSync(join(dir, e), e);
          }
          return execFileSync("sh", ["-c", `tar -cf - ${entries.join(" ")} | zstd -q -c`], {
            cwd: dir,
          });
        };
        const rpmBytes = Buffer.from([0xed, 0xab, 0xee, 0xdb, 1, 2]);
        const pkgBytes = pacman([".BUILDINFO", ".MTREE", ".PKGINFO", "opt/vimma/vimma"]);
        const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
        const good = {
          [rpm]: rpmBytes,
          [pkg]: pkgBytes,
          SHA256SUMS: `${sha(rpmBytes)}  ${rpm}\n`,
        };
        const ok = attempt(good);
        expect(ok.status, ok.stderr + ok.stdout).toBe(0);
        expect(attempt(good, "v0.3.1-rc1").stdout).toContain("is not a vX.Y.Z release tag");
        expect(attempt(good, "v0.3.2").stdout).toContain("packages-unsigned holds");
        expect(attempt({ ...good, extra: "x" }).stdout).toContain("packages-unsigned holds");
        expect(attempt({ ...good, [rpm]: Buffer.from("not an rpm") }).stdout).toContain(
          "is not an rpm",
        );
        expect(attempt({ ...good, [pkg]: Buffer.from("not zstd") }).stdout).toContain(
          "is not zstd",
        );
        // A zstd file that is not a pacman package: .PKGINFO missing, or after the package's files.
        for (const entries of [
          [".BUILDINFO", ".MTREE", "opt/vimma/vimma"],
          ["opt/vimma/vimma", ".PKGINFO"],
        ]) {
          expect(attempt({ ...good, [pkg]: pacman(entries) }).stdout, entries.join(" ")).toContain(
            "is not a pacman package",
          );
        }
        expect(attempt({ ...good, SHA256SUMS: `${"0".repeat(64)}  ${rpm}\n` }).stdout).toContain(
          "does not list",
        );
      });

      // A tar header for `name`, and a pax extended header: enough to write the archives a
      // compromised build could send, which GNU tar and libarchive (pacman's reader) may list
      // differently, or which hide entries behind an entry whose size the pax header overrides.
      const tarHeader = (name: string, size: number, type: string) => {
        const h = Buffer.alloc(512);
        h.write(name, 0, "utf8");
        h.write("0000644\0", 100);
        h.write("0000000\0", 108);
        h.write("0000000\0", 116);
        h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
        h.write("00000000000\0", 136);
        h.write("        ", 148);
        h.write(type, 156);
        h.write("ustar\0", 257);
        h.write("00", 263);
        let sum = 0;
        for (const b of h) sum += b;
        h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
        return h;
      };
      const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
      const entry = (name: string, content: string, type = "0") =>
        Buffer.concat([
          tarHeader(name, Buffer.byteLength(content), type),
          pad(Buffer.from(content)),
        ]);
      const paxHeader = (size: string) => {
        const rec = ` size=${size}\n`;
        let len = rec.length + 1;
        while (String(len).length + rec.length !== len) len = String(len).length + rec.length;
        const body = Buffer.from(`${len}${rec}`);
        return Buffer.concat([tarHeader("PaxHeader", body.length, "x"), pad(body)]);
      };
      const zstd = (tar: Buffer) => execFileSync("zstd", ["-q", "-c"], { input: tar });
      const lead = Buffer.concat([
        entry(".BUILDINFO", "b\n"),
        entry(".MTREE", "m\n"),
        entry(".PKGINFO", "pkgname = vimma-bin\n"),
      ]);
      const end = Buffer.alloc(1024);

      it("package-sign refuses a pacman package whose tar readers could disagree", () => {
        const run = runOf(job("package-sign"), "Check the files to sign");
        const rpm = "vimma-0.3.1-1.x86_64.rpm";
        const pkg = "vimma-bin-0.3.1-1-x86_64.pkg.tar.zst";
        const rpmBytes = Buffer.from([0xed, 0xab, 0xee, 0xdb, 1, 2]);
        const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
        const attempt = (tar: Buffer) => {
          const dir = tempDir("vimma-package-sign-tar-");
          mkdirSync(join(dir, "in"));
          writeFileSync(join(dir, "in", rpm), rpmBytes);
          writeFileSync(join(dir, "in", pkg), zstd(tar));
          writeFileSync(join(dir, "in", "SHA256SUMS"), `${sha(rpmBytes)}  ${rpm}\n`);
          return spawnSync("bash", [...githubShell(job("package-sign")), "-c", run], {
            cwd: dir,
            encoding: "utf8",
            env: { ...process.env, CALLER_TAG: "v0.3.1", GITHUB_ENV: join(dir, "env") },
          });
        };
        const ok = attempt(Buffer.concat([lead, entry("opt/vimma/vimma", "vimma\n"), end]));
        expect(ok.status, ok.stderr + ok.stdout).toBe(0);
        // A pax size record before a ustar entry whose own size covers a second .PKGINFO and an
        // .INSTALL: a reader that trusts the ustar size never sees them, pacman does.
        const data = Buffer.from("vimma\n");
        const hidden = Buffer.concat([
          entry(".PKGINFO", "pkgname = evil\n"),
          entry(".INSTALL", "post_install() { id; }\n"),
        ]);
        const smuggled = Buffer.concat([
          lead,
          paxHeader(String(data.length)),
          tarHeader("opt/vimma/vimma", 512 + hidden.length, "0"),
          pad(data),
          hidden,
          end,
        ]);
        const r = attempt(smuggled);
        expect(r.status).not.toBe(0);
        expect(r.stdout).toContain("lists a name twice");
        // The same with an .INSTALL alone hidden: a metadata file after the package's files.
        const installOnly = Buffer.concat([
          lead,
          paxHeader(String(data.length)),
          tarHeader("opt/vimma/vimma", 512 + 1024, "0"),
          pad(data),
          entry(".INSTALL", "post_install() { id; }\n"),
          end,
        ]);
        expect(attempt(installOnly).stdout).toContain("is not a pacman package");
        // A pax size GNU tar refuses and libarchive reads: the two lists differ.
        const malformed = Buffer.concat([
          lead,
          paxHeader(` ${data.length}`),
          tarHeader("opt/vimma/vimma", 512 + hidden.length, "0"),
          pad(data),
          hidden,
          end,
        ]);
        expect(attempt(malformed).stdout).toMatch(/GNU tar|libarchive/);
        // Entry types other than a file, a directory or a symlink: a hard link and a FIFO.
        for (const type of ["1", "6"]) {
          const odd = Buffer.concat([lead, entry("opt/vimma/x", "", type), end]);
          expect(attempt(odd).stdout, type).toContain("entry types");
        }
      });
    },
  );

  // Spec package-repositories, decision 9: signing rewrites only the .rpm's signature header.
  it("package-sign's check stops on an unreadable payload or a changed header, with pipefail", () => {
    const block = job("package-sign");
    expect(githubShell(block)).toContain("pipefail");
    const run = runOf(block, "Check the signatures against the committed certificate");
    const attempt = (signed: string) => {
      const dir = tempDir("vimma-package-check-");
      const bin = join(dir, "bin");
      for (const d of ["in", "out", bin]) mkdirSync(d.startsWith("/") ? d : join(dir, d));
      writeFileSync(join(dir, "in", "p.rpm"), "header\npayload\n");
      writeFileSync(join(dir, "out", "p.rpm"), signed);
      writeFileSync(join(dir, "cert.asc"), "certificate");
      const stub = (name: string, body: string) =>
        writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
      stub("rpmkeys", "exit 0");
      stub("gpg", "cat > /dev/null");
      stub("gpgv", "exit 0");
      // rpm2cpio gives the payload, then fails on a file marked corrupt, as a cut-short read.
      stub("rpm2cpio", 'tail -n +2 "$1"; head -n 1 "$1" | grep -q corrupt && exit 1; exit 0');
      // SHA256HEADER: the header line without its signature; an unknown tag prints nothing.
      stub(
        "rpm",
        [
          'f=${!#}; h=$(head -n 1 "$f" | sed "s/ signed//; s/ corrupt//")',
          'q=$(printf "%s" "$*" | sed -n "s/.*--qf \\([^ ]*\\).*/\\1/p")',
          'out=${q//"%{NEVRA}"/vimma-0.3.1-1.x86_64}',
          'out=${out//"%{SHA256HEADER}"/$(printf %s "$h" | sha256sum | cut -c1-64)}',
          'case $out in *"%{"*) echo "error: unknown tag" >&2 ;; *) printf "%s" "$out" ;; esac',
        ].join("\n"),
      );
      return spawnSync("bash", [...githubShell(block), "-c", run], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          RPM: "p.rpm",
          PKG: "p.pkg",
          CERT: "cert.asc",
          // The step's mktemp -d, inside the test's own dir, which is removed with it.
          TMPDIR: dir,
        },
      });
    };
    const ok = attempt("header signed\npayload\n");
    expect(ok.status, ok.stderr + ok.stdout).toBe(0);
    expect(attempt("header signed corrupt\npayload\n").status).not.toBe(0);
    expect(attempt("header signed\nother payload\n").stdout).toContain("payload or name");
    expect(attempt("another header signed\npayload\n").stdout).toContain("header");
  });

  it("package-sign writes SHA256SUMS: package's, the signed .rpm's line, the two new files", () => {
    const run = runOf(job("package-sign"), "Write SHA256SUMS");
    const dir = tempDir("vimma-package-sums-");
    const rpm = "vimma-0.3.1-1.x86_64.rpm";
    const pkg = "vimma-bin-0.3.1-1-x86_64.pkg.tar.zst";
    const sum = (c: string) => createHash("sha256").update(c).digest("hex");
    mkdirSync(join(dir, "in"));
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "in", pkg), "pacman");
    writeFileSync(
      join(dir, "in", "SHA256SUMS"),
      `${sum("unsigned")}  ${rpm}\n${sum("t")}  vimma-0.3.1-linux-x86_64.tar.xz\n`,
    );
    writeFileSync(join(dir, "out", rpm), "signed");
    writeFileSync(join(dir, "out", `${pkg}.sig`), "sig");
    const r = spawnSync("bash", [...githubShell(job("package-sign")), "-c", run], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, RPM: rpm, PKG: pkg },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(dir, "out", "SHA256SUMS"), "utf8")).toBe(
      `${sum("signed")}  ${rpm}\n${sum("t")}  vimma-0.3.1-linux-x86_64.tar.xz\n` +
        `${sum("pacman")}  ${pkg}\n${sum("sig")}  ${pkg}.sig\n`,
    );
    expect(job("package-sign")).toMatch(
      / {10}name: packages-signed\n {10}path: \|\n {12}out\/\$\{\{ env\.RPM \}\}\n {12}out\/\$\{\{ env\.PKG \}\}\.sig\n {12}out\/SHA256SUMS\n/,
    );
  });

  it("a call receives the deploy key only by name, optional, and only nightly.yml's manifest passes it", () => {
    const call = /^ {2}workflow_call:\n((?: {4}.*\n)+)/m.exec(text)?.[1] ?? "";
    expect(call).toMatch(
      /^ {4}secrets:\n {6}UPDATES_DEPLOY_KEY:\n(?: {8}description: .*\n)? {8}required: false\n/m,
    );
    expect(call.match(/^ {6}[A-Z_]+:$/gm)).toEqual(["      UPDATES_DEPLOY_KEY:"]);
    const callers = readdirSync(new URL("../../../.github/workflows/", import.meta.url))
      .filter((f) => f !== "update-publish.yml")
      .map((f) => readFileSync(new URL(`../../../.github/workflows/${f}`, import.meta.url), "utf8"))
      .join("\n");
    expect(callers).not.toMatch(/secrets: inherit/);
    expect(callers.match(/UPDATES_DEPLOY_KEY:/g)).toEqual(["UPDATES_DEPLOY_KEY:"]);
    expect(callers).toContain("UPDATES_DEPLOY_KEY: ${{ secrets.UPDATES_DEPLOY_KEY }}");
  });

  it("the deploy key lives in its own environment and reaches only the push steps", () => {
    const pushers = ["publish", "nightly-publish"];
    for (const [id, block] of all) {
      expect(block.includes("UPDATES_DEPLOY_KEY"), id).toBe(pushers.includes(id));
    }
    for (const id of pushers) {
      const publish = job(id);
      expect(publish, id).toMatch(/^ {4}environment: update-publish$/m);
      const uses = publish.split("secrets.UPDATES_DEPLOY_KEY").length - 1;
      // One in the job's "is it set" flag, one in the push step's env.
      expect(uses, id).toBe(2);
      expect(stepOf(publish, "Push to vimma-updates"), id).toContain(
        "DEPLOY_KEY: ${{ secrets.UPDATES_DEPLOY_KEY }}",
      );
      expect(publish, id).toContain(
        "UPDATES_DEPLOY_KEY_SET: ${{ secrets.UPDATES_DEPLOY_KEY != '' }}",
      );
    }
  });

  // Spec package-repositories, decisions 2 and 3: the update key and the package key each have
  // an environment that their IAM binding names, and a job reaches only its own.
  it("no job in update-signing names the package key, and no job in package-signing names the update key", () => {
    let update = 0;
    let packages = 0;
    for (const [id, block] of all) {
      if (block.includes("environment: update-signing")) {
        update += 1;
        expect(block, id).not.toMatch(/GCP_PACKAGE_KEY_VERSION|vimma-packages|package-signing/);
        expect(block, id).toContain("vars.GCP_KMS_KEY_VERSION");
      }
      if (block.includes("environment: package-signing")) {
        packages += 1;
        expect(block, id).not.toMatch(/GCP_KMS_KEY_VERSION|update-primary|update-signing/);
        expect(block, id).toContain("KEY_VERSION: ${{ vars.GCP_PACKAGE_KEY_VERSION }}");
      }
    }
    expect(update).toBeGreaterThanOrEqual(3);
    expect(packages).toBe(2);
  });

  it.each(["sign", "mar-sign", "nightly-sign"])(
    "the signing job %s runs no repository code: no checkout, no node, no npm",
    (id) => {
      const sign = job(id);
      expect(sign).not.toMatch(/GCP_PACKAGE_KEY_VERSION|package-signing|vimma-packages/);
      expect(sign).not.toContain("actions/checkout");
      expect(sign).not.toMatch(/\bnode\b|\bnpm\b|\bnpx\b|setup-node/);
    },
  );

  it("no job installs dependencies, and no checkout keeps a token in .git/config", () => {
    expect(text).not.toMatch(/npm (?:ci|install)|npx /);
    const checkouts = text.split("uses: actions/checkout@").slice(1);
    // prepare and publish, repo-prepare and repo-sign's signer, nightly-prepare and
    // nightly-publish, and package-sign's signer.
    expect(checkouts.length).toBe(7);
    for (const c of checkouts) {
      expect(c).toMatch(
        /^\S+ # v[\d.]+\n {8}with:\n(?: {10}.*\n)*? {10}persist-credentials: false\n/,
      );
    }
  });

  it("every action is pinned by a full commit SHA, google-github-actions/auth among them", () => {
    const uses = [...text.matchAll(/^\s+(?:- )?uses: (\S+)/gm)].map((m) => m[1] ?? "");
    for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    expect(uses).toContain("google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093");
  });

  it("a published release only starts the run on main, and only with UPDATES_ENABLED", () => {
    const start = job("start");
    expect(condition(start)).toBe(
      "github.event_name == 'release' && github.repository == 'vimma-browser/vimma'",
    );
    const run = runOf(start, "Start the manifest run on main");
    expect(run).toContain('if [ "$UPDATES_ENABLED" != true ]; then');
    expect(run).toContain(
      'gh workflow run update-publish.yml --repo "$GITHUB_REPOSITORY" --ref main -f tag="$TAG"',
    );
    expect(start).not.toContain("actions/checkout");
  });

  it.each(["prepare", "sign", "repo-prepare", "repo-sign", "publish"])(
    "%s runs only by hand on main, here, and with UPDATES_ENABLED or as a dry run",
    (id) => {
      const cond = condition(job(id));
      expect(cond).toContain(GUARD);
      expect(cond).toContain("(vars.UPDATES_ENABLED == 'true' || inputs.dry_run)");
      // In release.yml's call, event_name is the caller's workflow_dispatch: never a manifest.
      // workflow_ref is the caller's in a call, so it tells a call from a run of this file even
      // when a call passes an empty `mar`.
      expect(cond).toMatch(
        / && !inputs\.mar && startsWith\(github\.workflow_ref, 'vimma-browser\/vimma\/\.github\/workflows\/update-publish\.yml@'\)$/,
      );
    },
  );

  it("is called by release.yml and nightly.yml alone, and mar-sign signs only for those two", () => {
    const on = text.slice(text.indexOf("\non:\n"), text.indexOf("\npermissions:"));
    expect(on).toMatch(
      /^ {2}workflow_call:\n {4}inputs:\n {6}mar:\n {8}description: .+\n {8}required: false\n {8}type: string\n {8}default: ""\n {6}nightly:\n {8}description: .+\n {8}required: false\n {8}type: string\n {8}default: ""\n {6}packages:\n {8}description: .+\n {8}required: false\n {8}type: boolean\n {8}default: false\n(?: {4}#.*\n)* {4}secrets:\n/m,
    );
    // The nightly's call needs NIGHTLY_RELEASE_ENABLED too: until public nightly releases, no
    // nightly MAR is signed (spec m6a-updater, decision 42).
    expect(condition(job("mar-sign"))).toBe(
      "inputs.mar != '' && github.repository == 'vimma-browser/vimma' && " +
        "github.ref == 'refs/heads/main' && vars.UPDATES_ENABLED == 'true' && " +
        "(github.workflow_ref == 'vimma-browser/vimma/.github/workflows/release.yml@refs/heads/main' || " +
        "(github.workflow_ref == 'vimma-browser/vimma/.github/workflows/nightly.yml@refs/heads/main' && " +
        "vars.NIGHTLY_RELEASE_ENABLED == 'true'))",
    );
    // The channel comes from who called, never from an input.
    expect(job("mar-sign")).toContain("CALLER: ${{ github.workflow_ref }}");
    expect(condition(job("failure"))).toContain(
      "!inputs.mar && startsWith(github.workflow_ref, 'vimma-browser/vimma/.github/workflows/update-publish.yml@')",
    );
    const callers = readdirSync(new URL("../../../.github/workflows/", import.meta.url)).filter(
      (f) =>
        readFileSync(new URL(`../../../.github/workflows/${f}`, import.meta.url), "utf8").includes(
          "uses: ./.github/workflows/update-publish.yml",
        ),
    );
    expect(callers).toEqual(["nightly.yml", "release.yml"]);
  });

  it.each(["nightly-prepare", "nightly-sign", "nightly-publish"])(
    "%s runs only in nightly.yml's call on main, with UPDATES_ENABLED and NIGHTLY_RELEASE_ENABLED",
    (id) => {
      expect(condition(job(id))).toBe(
        "inputs.nightly != '' && !inputs.mar && github.repository == 'vimma-browser/vimma' && " +
          "github.ref == 'refs/heads/main' && vars.UPDATES_ENABLED == 'true' && " +
          "vars.NIGHTLY_RELEASE_ENABLED == 'true' && " +
          "github.workflow_ref == 'vimma-browser/vimma/.github/workflows/nightly.yml@refs/heads/main'",
      );
      expect(job(id)).toContain("BUILD_ID: ${{ inputs.nightly }}");
    },
  );

  it("nightly-sign runs after nightly-prepare, and nightly-publish after it", () => {
    expect(job("nightly-sign")).toMatch(/^ {4}needs: nightly-prepare$/m);
    expect(job("nightly-publish")).toMatch(/^ {4}needs: nightly-sign$/m);
    expect(job("nightly-sign")).toMatch(/^ {4}environment: update-signing$/m);
    expect(job("nightly-prepare")).not.toMatch(/environment:|secrets\./);
  });

  it("nightly-prepare reads the public nightly pre-release and its nightly.yml signature", () => {
    const prepare = job("nightly-prepare");
    const state = runOf(prepare, "The nightly release is a public pre-release");
    expect(state).toContain("gh release view nightly");
    expect(state).toContain('[ "$state" = "false true" ]');
    const download = runOf(prepare, "Download the nightly's files");
    expect(download).toContain(
      'base="https://github.com/$GITHUB_REPOSITORY/releases/download/nightly"',
    );
    expect(download).toContain("curl -fsSL --proto =https");
    for (const f of [
      "SHA256SUMS",
      "SHA256SUMS.sigstore.json",
      "vimma-nightly-$BUILD_ID-linux-x86_64.tar.xz",
      "vimma-nightly-$BUILD_ID-linux-x86_64.complete.mar",
    ]) {
      expect(download).toContain(f);
    }
    // nightly.yml's identity, never release.yml's: a nightly's sums never pass as a release's,
    // and the release's never as a nightly's.
    const verify = stepOf(prepare, "Verify the nightly's signature");
    expect(verify).toContain(
      "--certificate-identity-regexp '^https://github\\.com/vimma-browser/vimma/\\.github/workflows/nightly\\.yml@refs/heads/main$'",
    );
    expect(verify).toContain(
      "--certificate-oidc-issuer https://token.actions.githubusercontent.com",
    );
    expect(verify).not.toContain("release");
    expect(stepOf(job("prepare"), "Verify the release's signature")).not.toContain("nightly");
  });

  it("nightly-prepare checks the MAR's channel and builds the nightly channel's manifest", () => {
    const prepare = job("nightly-prepare");
    const mar = runOf(prepare, "The MAR is the nightly channel's, signed by the update key");
    expect(mar).toContain("node tools/update/mar.ts verify");
    expect(mar).toContain("--channel vimma-nightly");
    expect(mar).toContain(
      "--cert configs/updater/primary.der --cert configs/updater/secondary.der",
    );
    const published = runOf(prepare, "The published nightly manifest");
    expect(published).toContain("path=updates/browser/$BUILD_TARGET/vimma-nightly/update.xml");
    const build = runOf(prepare, "Build the nightly manifest");
    expect(build).toContain(
      'node tools/update/manifest.ts build --channel nightly --build-id "$BUILD_ID" --version "$version"',
    );
    expect(prepare.indexOf("- name: Verify the nightly's signature")).toBeLessThan(
      prepare.indexOf("- name: Build the nightly manifest"),
    );
    expect(prepare).toContain("name: nightly-manifest-body");
  });

  it("nightly-publish checks the signed file, then pushes only the nightly channel's path", () => {
    const publish = job("nightly-publish");
    const verify = runOf(publish, "Verify the signed manifest");
    expect(verify).toContain(
      'node tools/update/manifest.ts verify --channel nightly --signed signed/update.xml --build-id "$BUILD_ID" --version "$version" --assets assets',
    );
    expect(verify).toContain("openssl dgst -sha384 -verify pinned.pem");
    const download = runOf(publish, "Download the nightly's files");
    expect(download).toContain(
      'base="https://github.com/$GITHUB_REPOSITORY/releases/download/nightly"',
    );
    const push = runOf(publish, "Push to vimma-updates");
    expect(push).toContain(
      "dest=updates/public/updates/browser/$BUILD_TARGET/vimma-nightly/update.xml",
    );
    expect(push).not.toMatch(/\/vimma\/update\.xml/);
    expect(push).toContain("StrictHostKeyChecking=yes");
    expect(push).toContain("--channel nightly");
    expect(push).toContain('--published "$dest"');
    expect(publish).not.toMatch(/--force|--mirror|\+HEAD|\+refs|push -f/);
    expect(publish.indexOf("- name: Verify the signed manifest")).toBeLessThan(
      publish.indexOf("- name: Push to vimma-updates"),
    );
    const wait = runOf(publish, "Wait until the update host serves it");
    expect(wait).toContain(
      "url=https://updates.vimma.dev/updates/browser/$BUILD_TARGET/vimma-nightly/update.xml",
    );
    const missing = stepOf(publish, "No deploy key");
    expect(missing).toContain("if: env.UPDATES_DEPLOY_KEY_SET != 'true'");
    expect(missing).toContain("exit 1");
  });

  it("the release jobs never write the nightly path, nor the nightly jobs the release path", () => {
    for (const id of ["prepare", "sign", "publish"]) {
      expect(job(id), id).not.toContain("vimma-nightly/update.xml");
    }
    for (const id of ["nightly-prepare", "nightly-sign", "nightly-publish"]) {
      expect(job(id), id).not.toMatch(/\$BUILD_TARGET\/vimma\/|Linux_x86_64-gcc3\/vimma\//);
    }
  });

  it("keeps the nightly's signed manifest only a day", () => {
    const sign = job("nightly-sign");
    expect(sign.slice(sign.indexOf("name: nightly-manifest-signed"))).toMatch(
      /retention-days: 1(?: #.*)?\n/,
    );
  });

  it("downloads the MAR SHA256SUMS lists, and the one the signed manifest offers", () => {
    const prepare = runOf(job("prepare"), "Download the release's files");
    expect(prepare).toContain('mar="vimma-$v-linux-x86_64.complete.mar"');
    expect(prepare).toContain(
      `if [ "$TARGET_OS" = linux ] && awk -v f="$mar" '$2 == f { found = 1 } END { exit !found }' "$SUMS"; then`,
    );
    const publish = runOf(job("publish"), "Download the release's files");
    expect(publish).toContain(
      `if grep -q '<patch ' signed/update.xml; then files+=("vimma-$v-linux-x86_64.complete.mar"); fi`,
    );
    const publishJob = job("publish");
    expect(publishJob.indexOf("name: manifest-signed")).toBeLessThan(
      publishJob.indexOf("- name: Download the release's files"),
    );
  });

  it("keeps the signed MAR as long as release.yml's own artifacts", () => {
    const sign = job("mar-sign");
    expect(sign.slice(sign.indexOf("name: mar-signed"))).toMatch(/retention-days: 7(?: #.*)?\n/);
  });

  it("keeps the signed manifest only a day: a dry run's signature is real", () => {
    const sign = job("sign");
    expect(sign.slice(sign.indexOf("name: manifest-signed"))).toMatch(
      /retention-days: 1(?: #.*)?\n/,
    );
  });

  it("checks tags with a whole-string match, and the version as a fixed string", () => {
    expect(text).not.toMatch(/echo "\$TAG" \| grep/);
    expect(text).toContain("[[ $TAG =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]");
    expect(runOf(job("sign"), "Check what is about to be signed")).toContain(
      String.raw`grep -qF " displayVersion=\"${"$"}{TAG#v}\" "`,
    );
  });

  it("runs one manifest per target at a time, never cancelling one half done", () => {
    // Per event: the release event's run, which only starts another, never waits behind or
    // displaces a signing run. Per target: GitHub keeps one pending run per group, so a Linux
    // and a macOS run started together must not replace each other. release.yml's call (with
    // `mar`) signs for its own run, so it has a group of its own and never waits behind, or
    // replaces, a manifest run; a manifest run's group is the same as before the call existed.
    expect(text).toContain(
      "\nconcurrency:\n  group: ${{ !startsWith(github.workflow_ref, 'vimma-browser/vimma/.github/workflows/update-publish.yml@') && " +
        "format('update-publish-call-{0}{1}', github.run_id, inputs.packages && '-packages' || '') || " +
        "format('update-publish-{0}-{1}', github.event_name, inputs.target || 'linux') }}\n" +
        "  cancel-in-progress: false\n",
    );
  });

  it("checks that the release is published, not a pre-release, and on main", () => {
    const run = runOf(job("prepare"), "The release is published and its tag is on main");
    expect(run).toContain("isDraft");
    expect(run).toContain("isPrerelease");
    expect(run).toContain(
      'gh api "repos/$GITHUB_REPOSITORY/compare/$sha...refs/heads/main" --jq .status',
    );
  });

  it("downloads the files from the public URLs, which a draft does not have, with curl -f", () => {
    for (const id of ["prepare", "publish"]) {
      const run = runOf(job(id), "Download the release's files");
      expect(run, id).toContain(
        'base="https://github.com/$GITHUB_REPOSITORY/releases/download/$TAG"',
      );
      expect(run, id).toContain("curl -fsSL --proto =https");
    }
  });

  it("checks SHA256SUMS against release.yml's signature, and refuses an unsigned release", () => {
    const step = stepOf(job("prepare"), "Verify the release's signature");
    expect(step).not.toContain("SIGNING_ENABLED");
    expect(job("prepare")).not.toMatch(/if: .*SIGNING_ENABLED/);
    const download = runOf(job("prepare"), "Download the release's files");
    expect(download).toContain('"$base/$SUMS.sigstore.json"');
    expect(download).not.toContain("SIGNING_ENABLED");
    expect(step).toContain(`--certificate-identity-regexp '${IDENTITY_REGEXP}'`);
    expect(step).toContain("--certificate-oidc-issuer https://token.actions.githubusercontent.com");
  });

  it("the publish job verifies with the browser's verifier and with openssl before any push", () => {
    const publish = job("publish");
    const verify = runOf(publish, "Verify the signed manifest");
    expect(verify).toContain("node tools/update/manifest.ts verify");
    expect(verify).toContain("openssl dgst -sha384 -verify pinned.pem");
    expect(publish.indexOf("- name: Verify the signed manifest")).toBeLessThan(
      publish.indexOf("- name: Push to vimma-updates"),
    );
  });

  it("a dry run or UPDATES_ENABLED unset stops with a notice; enabled without the key fails", () => {
    const publish = job("publish");
    const skip = stepOf(publish, "Without UPDATES_ENABLED, or in a dry run, push nothing");
    expect(skip).toContain("if: vars.UPDATES_ENABLED != 'true' || inputs.dry_run");
    expect(skip).toContain("::notice::");
    const missing = stepOf(publish, "Enabled, but no deploy key");
    expect(missing).toContain(
      "if: env.UPDATES_DEPLOY_KEY_SET != 'true' && vars.UPDATES_ENABLED == 'true' && !inputs.dry_run",
    );
    expect(missing).toContain("::error::");
    expect(missing).toContain("exit 1");
    for (const name of ["Push to vimma-updates", "Wait until the update host serves it"]) {
      expect(stepOf(publish, name)).toContain(
        "if: env.UPDATES_DEPLOY_KEY_SET == 'true' && vars.UPDATES_ENABLED == 'true' && !inputs.dry_run",
      );
    }
  });

  it("pushes one commit naming the version to main, never forced, to a pinned host key", () => {
    const run = runOf(job("publish"), "Push to vimma-updates");
    expect(run).toContain("StrictHostKeyChecking=yes");
    expect(run).toContain("node tools/update/manifest.ts verify");
    expect(run).toContain('commit -q -m "$message"');
    expect(run).toMatch(/message="vimma \$version: update manifest, serial \$serial"/);
    const pushes = run
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /\bpush\b/.test(l) && !l.startsWith("echo"));
    // The other target's run may push between the clone and this push; it changes another
    // file, so a rebase onto it keeps this commit as it was checked.
    expect(pushes).toEqual(["if git push origin HEAD:main; then break; fi"]);
    expect(run).toContain("git pull -q --rebase origin main");
    expect(job("publish")).not.toMatch(/--force|--mirror|\+HEAD|\+refs|push -f/);
    expect(job("publish")).toContain(
      "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
    );
  });

  // #530: the Linux and macOS runs of a release push within seconds of each other, so the
  // retry is the common path. Git may not guess an identity (a hosted runner's has no name), so
  // the step's env must give the rebase one, as it gives the commit.
  it("a push the other target's run beat rebases and lands, with no git identity configured", () => {
    const step = stepOf(job("publish"), "Push to vimma-updates");
    const stepEnv: Record<string, string> = {};
    for (const m of step.matchAll(/^ {10}(GIT_[A-Z_]+): (.+)$/gm)) {
      stepEnv[m[1] ?? ""] = (m[2] ?? "").replace(/^"(.*)"$/, "$1");
    }
    const run = runOf(job("publish"), "Push to vimma-updates");
    const tail = run.slice(run.indexOf("cd updates\n"));
    const dir = tempDir("vimma-push-");
    const file = "public/updates/browser/Linux_x86_64-gcc3/vimma/update.xml";
    const rival = "public/updates/browser/Darwin_aarch64-gcc3/vimma/update.xml";
    const home = join(dir, "home");
    mkdirSync(home);
    const who = {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    };
    const base = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.useConfigOnly",
      GIT_CONFIG_VALUE_0: "true",
      GIT_CONFIG_KEY_1: "init.defaultBranch",
      GIT_CONFIG_VALUE_1: "main",
    };
    const git = (args: string[], cwd: string, env: Record<string, string> = { ...base, ...who }) =>
      execFileSync("git", args, { cwd, env, stdio: "pipe" });
    git(["init", "-q", "--bare", "origin.git"], dir);
    git(["clone", "-q", "origin.git", "seed"], dir);
    mkdirSync(join(dir, "seed", "public"), { recursive: true });
    writeFileSync(join(dir, "seed", "public", "README"), "seed\n");
    git(["add", "."], join(dir, "seed"));
    git(["commit", "-q", "-m", "seed"], join(dir, "seed"));
    git(["push", "-q", "origin", "HEAD:main"], join(dir, "seed"));
    git(["clone", "-q", "--branch", "main", "origin.git", "updates"], dir);
    // The other target's run pushes after this run's clone.
    mkdirSync(join(dir, "seed", rival, ".."), { recursive: true });
    writeFileSync(join(dir, "seed", rival), "<updates/>\n");
    git(["add", "."], join(dir, "seed"));
    git(["commit", "-q", "-m", "macos manifest"], join(dir, "seed"));
    git(["push", "-q", "origin", "HEAD:main"], join(dir, "seed"));
    mkdirSync(join(dir, "updates", file, ".."), { recursive: true });
    writeFileSync(join(dir, "updates", file), "<updates/>\n");

    const result = spawnSync("bash", ["-e", "-c", tail], {
      cwd: dir,
      env: {
        ...base,
        ...stepEnv,
        BUILD_TARGET: "Linux_x86_64-gcc3",
        message: "vimma 0.1.8: update manifest, serial 1",
      },
      encoding: "utf8",
    });
    expect(result.stderr).not.toMatch(/ident|identity/i);
    expect(result.status, result.stderr).toBe(0);
    const log = git(["log", "--format=%s|%an|%cn", "main"], join(dir, "origin.git"))
      .toString()
      .trim()
      .split("\n");
    expect(log).toEqual([
      "vimma 0.1.8: update manifest, serial 1|github-actions[bot]|github-actions[bot]",
      "macos manifest|t|t",
      "seed|t|t",
    ]);
  });

  it("the failure issue says how to re-run", () => {
    const failure = job("failure");
    expect(condition(failure)).toContain("failure()");
    expect(failure).toContain(
      "gh workflow run update-publish.yml -f tag=$TAG -f target=$TARGET_OS",
    );
  });
});

// The sign job runs on ubuntu-24.04 only, and its steps rely on GNU coreutils (`date -d`, an
// unpadded `wc -c`): under BSD tools every step fails, so the refusals would pass for nothing.
describe.skipIf(process.platform !== "linux")("the signing job's steps, run", () => {
  /**
   * A directory holding the prepare job's artifact and a stand-in `gcloud` that signs the way
   * RSA_SIGN_RAW_PKCS1_4096 does: PKCS#1 v1.5 type-1 padding over the bytes it is sent.
   */
  function setUp(body: string) {
    const dir = tempDir("vimma-sign-");
    const pair = testKey("a");
    writeFileSync(join(dir, "kms.key"), pair.privateKey.export({ type: "pkcs8", format: "pem" }));
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "out", "update.xml.body"), body);
    writeFileSync(
      join(dir, "bin", "gcloud"),
      `#!/bin/sh
set -e
args="$*"
arg() { printf '%s\\n' "$args" | sed -n "s/.*$1 \\([^ ]*\\).*/\\1/p"; }
case "$args" in
  "kms asymmetric-sign --version $KEY_VERSION "*)
    node -e 'const c = require("node:crypto"), fs = require("node:fs");
      const [, key, input, output] = process.argv;
      fs.writeFileSync(output, c.privateEncrypt(
        { key: fs.readFileSync(key), padding: c.constants.RSA_PKCS1_PADDING }, fs.readFileSync(input)));' \\
      "$FAKE_KMS_KEY" "$(arg --input-file)" "$(arg --signature-file)" ;;
  "kms keys versions get-public-key $KEY_VERSION "*)
    openssl pkey -in "$FAKE_KMS_KEY" -pubout -out "$(arg --output-file)" ;;
  *) echo "unexpected gcloud $args" >&2; exit 2 ;;
esac
`,
      { mode: 0o755 },
    );
    const der = new Uint8Array(pair.publicKey.export({ type: "spki", format: "der" }));
    return { dir, der };
  }

  /**
   * @param id the job
   */
  const run = (dir: string, name: string, env: Record<string, string>, id: string = "sign") =>
    spawnSync("bash", ["-e", "-o", "pipefail", "-c", runOf(job(id), name)], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        KEY_VERSION: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
        FAKE_KMS_KEY: join(dir, "kms.key"),
        GITHUB_OUTPUT: join(dir, "github-output"),
        BUILD_TARGET: "Linux_x86_64-gcc3",
        ...env,
      },
    });

  const offerBody = () =>
    buildManifest({
      serial: serialAt(new Date()),
      update: {
        appVersion: "158.0",
        buildId: "20261016111135",
        displayVersion: "0.3.1",
        urgency: "normal",
        advisories: [],
        assets: {
          tarball: { size: 1, sha512: "a".repeat(128) },
          appimage: { size: 2, sha512: "b".repeat(128) },
          deb: { size: 3, sha512: "c".repeat(128) },
          rpm: { size: 4, sha512: "d".repeat(128) },
        },
      },
    });

  const macOffer = () => ({
    appVersion: "158.0",
    buildId: "20261019132138",
    displayVersion: "0.3.1",
    urgency: "normal" as const,
    advisories: [],
    assets: { dmg: { size: 4, sha512: "d".repeat(128) } },
  });

  it("signs the body so that the browser's verifier accepts it under the KMS key", async () => {
    const body = offerBody();
    const { dir, der } = setUp(body);
    const check = run(dir, "Check what is about to be signed", { TAG: "v0.3.1", OFFER: "release" });
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
    const signed = run(dir, "Sign with Cloud KMS", {});
    expect(signed.stderr).not.toMatch(/error/i);
    expect(signed.status).toBe(0);
    const out = readFileSync(join(dir, "out", "update.xml"), "utf8");
    const subtle = globalThis.crypto.subtle;
    const pin = {
      id: await spkiKeyId(subtle, der),
      slot: "primary" as const,
      spki: base64Encode(der),
    };
    expect(await verifyManifest(out, [pin], subtle)).toEqual({
      ok: true,
      body,
      key: { id: pin.id, slot: "primary" },
    });
  }, 60_000);

  it.each([
    ["a body already carrying a signature", (b) => b + "<!-- vimma-signature v1 -->\n", "release"],
    [
      "another channel",
      (b) => b.replace('vimmaChannel="vimma"', 'vimmaChannel="vimma-nightly"'),
      "release",
    ],
    [
      "another version than the tag",
      (b) => b.replace('displayVersion="0.3.1"', 'displayVersion="0.3.2"'),
      "release",
    ],
    ["an offer when nothing was asked for", (b) => b, "nothing"],
    [
      "a serial far ahead of the clock",
      (b) => b.replace(/vimmaSerial="\d{14}"/, 'vimmaSerial="29990101000000"'),
      "release",
    ],
    [
      "a serial from long ago",
      (b) => b.replace(/vimmaSerial="\d{14}"/, 'vimmaSerial="20200101000000"'),
      "release",
    ],
    ["text after </updates>", (b) => b + "<!-- x -->", "release"],
    [
      "more than 64 KiB",
      (b) => b.replace("</updates>", `<!-- ${"x".repeat(70_000)} -->\n</updates>`),
      "release",
    ],
    // GNU grep may end a line at a NUL byte in a file it takes for binary, so a line check alone
    // would pass either half.
    [
      "a nightly root hidden before a NUL byte",
      (b) =>
        b.replace(
          "<updates ",
          '<updates vimmaChannel="vimma-nightly" vimmaTarget="Linux_x86_64-gcc3" vimmaSerial="20261112000000">\0<updates ',
        ),
      "release",
      /not printable ASCII/,
    ],
    [
      "a root for another target hidden before a NUL byte",
      (b) =>
        b.replace(
          "<updates ",
          '<updates vimmaChannel="vimma" vimmaTarget="Darwin_aarch64-gcc3" vimmaSerial="20261112000000">\0<updates ',
        ),
      "release",
      /not printable ASCII/,
    ],
    [
      "another tarball hidden after a NUL byte",
      (b) =>
        b.replace(
          /(<vimmaTarball [^\n]*\/>)\n/,
          `$1\0<vimmaTarball size="1" hashFunction="sha512" hashValue="${"f".repeat(128)}" URL="https://example.com/x.tar.xz"/>\n`,
        ),
      "release",
      /not printable ASCII/,
    ],
    [
      "a byte that is not ASCII",
      (b) => b.replace("</updates>", "<!-- \u00e9 -->\n</updates>"),
      "release",
      /not printable ASCII/,
    ],
    [
      "a carriage return",
      (b) => b.replace("  </update>\n", "  </update>\r\n"),
      "release",
      /not printable ASCII/,
    ],
    [
      "a body that does not end with a newline",
      (b) => b.replace(/\n$/, ""),
      "release",
      /does not end with a newline/,
    ],
  ] as [string, (body: string) => string, string, RegExp?][])(
    "refuses to sign %s",
    (_name, change, offer, error = /::error::/) => {
      const { dir } = setUp(change(offerBody()));
      const check = run(dir, "Check what is about to be signed", { TAG: "v0.3.1", OFFER: offer });
      expect(check.status).not.toBe(0);
      expect(check.stdout + check.stderr).toMatch(error);
    },
    60_000,
  );

  it("checks a macOS body against the macOS target, and refuses a Linux one there", () => {
    const mac = buildManifest({
      serial: serialAt(new Date()),
      update: { ...macOffer(), displayVersion: "0.3.1" },
      os: "macos",
    });
    const env = { TAG: "v0.3.1", OFFER: "release", BUILD_TARGET: "Darwin_aarch64-gcc3" };
    expect(run(setUp(mac).dir, "Check what is about to be signed", env).status).toBe(0);
    expect(run(setUp(offerBody()).dir, "Check what is about to be signed", env).status).not.toBe(0);
    expect(
      run(setUp(mac).dir, "Check what is about to be signed", {
        ...env,
        BUILD_TARGET: "Linux_x86_64-gcc3",
      }).status,
    ).not.toBe(0);
  }, 60_000);

  const MAR_URL =
    "https://github.com/vimma-browser/vimma/releases/download/v0.3.1/vimma-0.3.1-linux-x86_64.complete.mar";
  const withPatch = (url: string = MAR_URL) =>
    offerBody().replace(
      "    <vimmaTarball ",
      `    <patch type="complete" size="5" hashFunction="sha512" hashValue="${"e".repeat(128)}" URL="${url}"/>\n    <vimmaTarball `,
    );

  it("signs a body whose <patch> is the tag's MAR", () => {
    const { dir } = setUp(withPatch());
    const check = run(dir, "Check what is about to be signed", {
      TAG: "v0.3.1",
      OFFER: "release",
      TARGET_OS: "linux",
    });
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
  }, 60_000);

  it.each([
    [
      "at another URL",
      () => withPatch("https://example.com/vimma-0.3.1-linux-x86_64.complete.mar"),
    ],
    ["for another tag", () => withPatch(MAR_URL.replaceAll("0.3.1", "0.3.0"))],
    [
      "twice",
      () =>
        withPatch().replace(
          "  </update>",
          `${withPatch()
            .split("\n")
            .find((l) => l.includes("<patch "))}\n  </update>`,
        ),
    ],
  ])(
    "refuses a <patch> %s",
    (_name, body) => {
      const { dir } = setUp(body());
      const check = run(dir, "Check what is about to be signed", {
        TAG: "v0.3.1",
        OFFER: "release",
        TARGET_OS: "linux",
      });
      expect(check.status).not.toBe(0);
    },
    60_000,
  );

  it("refuses a <patch> in the macOS manifest", () => {
    const mac = buildManifest({
      serial: serialAt(new Date()),
      update: { ...macOffer(), displayVersion: "0.3.1" },
      os: "macos",
    }).replace(
      "    <vimmaDmg ",
      `    <patch type="complete" size="5" hashFunction="sha512" hashValue="${"e".repeat(128)}" URL="${MAR_URL}"/>\n    <vimmaDmg `,
    );
    const env = {
      TAG: "v0.3.1",
      OFFER: "release",
      TARGET_OS: "macos",
      BUILD_TARGET: "Darwin_aarch64-gcc3",
    };
    expect(run(setUp(mac).dir, "Check what is about to be signed", env).status).not.toBe(0);
  }, 60_000);

  it("signs an empty manifest when nothing is offered", () => {
    const { dir } = setUp(buildManifest({ serial: serialAt(new Date()), update: null }));
    const check = run(dir, "Check what is about to be signed", { TAG: "", OFFER: "nothing" });
    expect(check.status).toBe(0);
  }, 60_000);

  // nightly-sign: the same signing steps, with a check of its own that admits exactly the body
  // buildNightlyManifest writes for the build nightly.yml asked for, and nothing else.
  const BUILD_ID = "20261112030512";
  const NIGHTLY_DL = "https://github.com/vimma-browser/vimma/releases/download/nightly";
  const nightlyBody = () =>
    buildNightlyManifest({
      serial: serialAt(new Date()),
      update: {
        appVersion: "160.0",
        buildId: BUILD_ID,
        version: "0.1.18",
        tarball: { size: 1, sha512: "a".repeat(128) },
        mar: { size: 5, sha512: "e".repeat(128) },
      },
    });

  it("nightly-sign signs the nightly's body so that the browser's verifier accepts it", async () => {
    const body = nightlyBody();
    const { dir, der } = setUp(body);
    const check = run(dir, "Check what is about to be signed", { BUILD_ID }, "nightly-sign");
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
    const signed = run(dir, "Sign with Cloud KMS", {}, "nightly-sign");
    expect(signed.stderr).not.toMatch(/error/i);
    expect(signed.status).toBe(0);
    const out = readFileSync(join(dir, "out", "update.xml"), "utf8");
    const subtle = globalThis.crypto.subtle;
    const pin = {
      id: await spkiKeyId(subtle, der),
      slot: "primary" as const,
      spki: base64Encode(der),
    };
    expect(await verifyManifest(out, [pin], subtle)).toEqual({
      ok: true,
      body,
      key: { id: pin.id, slot: "primary" },
    });
  }, 60_000);

  it.each([
    ["a release manifest", () => offerBody(), {}],
    ["another build than the one asked for", () => nightlyBody(), { BUILD_ID: "20261112035959" }],
    ["a build ID that is not one", () => nightlyBody(), { BUILD_ID: "2026111203051" }],
    [
      "the release channel",
      () => nightlyBody().replace('vimmaChannel="vimma-nightly"', 'vimmaChannel="vimma"'),
      {},
    ],
    ["another target", () => nightlyBody().replace("Linux_x86_64-gcc3", "Darwin_aarch64-gcc3"), {}],
    [
      "a <patch> at a release's URL",
      () =>
        nightlyBody().replace(
          `${NIGHTLY_DL}/vimma-nightly-${BUILD_ID}-linux-x86_64.complete.mar`,
          "https://github.com/vimma-browser/vimma/releases/download/v0.1.18/vimma-0.1.18-linux-x86_64.complete.mar",
        ),
      {},
    ],
    [
      "a tarball at another URL",
      () =>
        nightlyBody().replace(`${NIGHTLY_DL}/vimma-nightly-`, "https://example.com/vimma-nightly-"),
      {},
    ],
    [
      "a security urgency",
      () => nightlyBody().replace('vimmaUrgency="normal"', 'vimmaUrgency="security"'),
      {},
    ],
    [
      "a version that is not the build's",
      () => nightlyBody().replace(`-nightly.${BUILD_ID}"`, '-nightly.20261111030000"'),
      {},
    ],
    [
      "another element",
      () =>
        nightlyBody().replace(
          "  </update>",
          `    <vimmaDeb size="1" hashFunction="sha512" hashValue="${"c".repeat(128)}" URL="${NIGHTLY_DL}/x.deb"/>\n  </update>`,
        ),
      {},
    ],
    ["no offer", () => buildNightlyManifest({ serial: serialAt(new Date()), update: null }), {}],
    [
      "a body already carrying a signature",
      () => nightlyBody() + "<!-- vimma-signature v1 -->\n",
      {},
    ],
    [
      "a serial from long ago",
      () => nightlyBody().replace(/vimmaSerial="\d{14}"/, 'vimmaSerial="20200101000000"'),
      {},
    ],
    [
      "a serial far ahead of the clock",
      () => nightlyBody().replace(/vimmaSerial="\d{14}"/, 'vimmaSerial="29990101000000"'),
      {},
    ],
    // GNU grep may end a line at a NUL byte in a file it takes for binary, so `grep -x` alone
    // would pass either half.
    [
      "a release-channel root hidden before a NUL byte",
      () =>
        nightlyBody().replace(
          "<updates ",
          '<updates vimmaChannel="vimma" vimmaTarget="Linux_x86_64-gcc3" vimmaSerial="20261112000000">\0<updates ',
        ),
      {},
      /not printable ASCII/,
    ],
    [
      "another tarball hidden after a NUL byte",
      () =>
        nightlyBody().replace(
          'linux-x86_64.tar.xz"/>\n',
          `linux-x86_64.tar.xz"/>\0<vimmaTarball size="1" hashFunction="sha512" hashValue="${"f".repeat(128)}" URL="https://example.com/x.tar.xz"/>\n`,
        ),
      {},
      /not printable ASCII/,
    ],
    [
      "a byte that is not ASCII",
      () => nightlyBody().replace("</updates>", "<!-- \u00e9 --></updates>"),
      {},
      /not printable ASCII/,
    ],
    [
      "a carriage return",
      () => nightlyBody().replace("  </update>\n", "  </update>\r\n"),
      {},
      /not printable ASCII/,
    ],
    [
      "a body that does not end with a newline",
      () => nightlyBody().replace(/\n$/, ""),
      {},
      /does not end with a newline/,
    ],
    ["text after the last line", () => nightlyBody() + "<!-- x -->", {}],
  ])(
    "nightly-sign refuses to sign %s",
    (_name, body, env, error = /::error::/) => {
      const { dir } = setUp(body());
      const check = run(
        dir,
        "Check what is about to be signed",
        { BUILD_ID, ...env },
        "nightly-sign",
      );
      expect(check.status).not.toBe(0);
      expect(check.stdout + check.stderr).toMatch(error);
    },
    60_000,
  );

  it("nightly-sign's byte check is sign's, the same shell text", () => {
    const byteCheck = (id: string) => {
      const step = runOf(job(id), "Check what is about to be signed");
      const start = step.indexOf("# Printable ASCII and newlines only");
      const end = step.indexOf("does not end with a newline");
      expect(start, id).toBeGreaterThan(-1);
      expect(end, id).toBeGreaterThan(start);
      return step.slice(start, step.indexOf("\n", end));
    };
    expect(byteCheck("nightly-sign")).toBe(byteCheck("sign"));
    expect(byteCheck("sign")).toContain('[ "$rc" = 1 ]');
  });

  it("sign, the release's check, refuses the nightly's body", () => {
    const { dir } = setUp(nightlyBody());
    const check = run(dir, "Check what is about to be signed", {
      TAG: "v0.1.18",
      OFFER: "release",
    });
    expect(check.status).not.toBe(0);
  }, 60_000);
});

// mar-sign, run with the same stand-in for gcloud: the placeholder MAR release.yml's package job
// builds (tools/update/mar.ts, from a MAR Mozilla's own `mar` made) comes out signed so that the
// updater's check accepts it under the KMS key.
describe.skipIf(process.platform !== "linux")("the MAR signing job's steps, run", () => {
  const NAME = "vimma-0.3.1-linux-x86_64.complete.mar";
  const NIGHTLY_NAME = "vimma-nightly-20261112030512-linux-x86_64.complete.mar";
  const RELEASE_CALLER = "vimma-browser/vimma/.github/workflows/release.yml@refs/heads/main";
  const NIGHTLY_CALLER = "vimma-browser/vimma/.github/workflows/nightly.yml@refs/heads/main";
  const fixture = () => readFileSync(new URL("fixtures/mar/unsigned.mar", import.meta.url));

  function setUp(mar: Buffer) {
    const dir = tempDir("vimma-mar-sign-");
    const pair = testKey("a");
    writeFileSync(join(dir, "kms.key"), pair.privateKey.export({ type: "pkcs8", format: "pem" }));
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "in"));
    writeFileSync(join(dir, "in", NAME), mar);
    writeFileSync(
      join(dir, "bin", "gcloud"),
      `#!/bin/sh
set -e
args="$*"
arg() { printf '%s\\n' "$args" | sed -n "s/.*$1 \\([^ ]*\\).*/\\1/p"; }
case "$args" in
  "kms asymmetric-sign --version $KEY_VERSION "*)
    node -e 'const c = require("node:crypto"), fs = require("node:fs");
      const [, key, input, output] = process.argv;
      fs.writeFileSync(output, c.privateEncrypt(
        { key: fs.readFileSync(key), padding: c.constants.RSA_PKCS1_PADDING }, fs.readFileSync(input)));' \\
      "$FAKE_KMS_KEY" "$(arg --input-file)" "$(arg --signature-file)" ;;
  "kms keys versions get-public-key $KEY_VERSION "*)
    openssl pkey -in "$FAKE_KMS_KEY" -pubout -out "$(arg --output-file)" ;;
  *) echo "unexpected gcloud $args" >&2; exit 2 ;;
esac
`,
      { mode: 0o755 },
    );
    return { dir, publicKey: pair.publicKey };
  }

  const run = (dir: string, name: string, env: Record<string, string> = {}) =>
    spawnSync("bash", ["-e", "-o", "pipefail", "-c", runOf(job("mar-sign"), name)], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        KEY_VERSION: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1",
        FAKE_KMS_KEY: join(dir, "kms.key"),
        GITHUB_OUTPUT: join(dir, "github-output"),
        MAR: NAME,
        CALLER_TAG: "v0.3.1",
        CALLER: RELEASE_CALLER,
        ...env,
      },
    });

  it("signs the placeholder so that the updater's check accepts it under the KMS key", () => {
    const placeholder = addSignaturePlaceholder(fixture());
    const { dir, publicKey } = setUp(placeholder);
    const check = run(dir, "Check the MAR placeholder");
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
    expect(check.stdout).toContain("channel vimma");
    const signed = run(dir, "Sign the MAR with Cloud KMS");
    expect(signed.stderr).not.toMatch(/error/i);
    expect(signed.status).toBe(0);
    const out = readFileSync(join(dir, "out", NAME));
    expect(verifyMar(out, [publicKey], { channel: "vimma", productVersion: "159.0.1" })).toEqual({
      channel: "vimma",
      productVersion: "159.0.1",
      entries: 3,
    });
    // Only the signature bytes changed: what signmar -s would have written.
    expect(insertSignature(placeholder, out.subarray(28, 540)).equals(out)).toBe(true);
  }, 60_000);

  const changed = (change: (b: Buffer) => Buffer) =>
    change(Buffer.from(addSignaturePlaceholder(fixture())));

  it.each([
    ["an unsigned MAR (no placeholder)", () => fixture(), {}],
    ["a MAR already signed", () => changed((b) => (b.fill(7, 28, 540), b)), {}],
    ["another channel", () => changed((b) => (b.write("vimmb", 552, "latin1"), b)), {}],
    ["a channel with a space", () => changed((b) => (b.write("vi ma", 552, "latin1"), b)), {}],
    [
      "a product information block too short for its channel",
      () => changed((b) => (b.writeUInt32BE(10, 544), b)),
      {},
    ],
    ["no MAR at all", () => Buffer.from("XAR1".padEnd(1000, "x")), {}],
    [
      "a size field that is not the file's",
      () => changed((b) => (b.writeBigUInt64BE(1n, 8), b)),
      {},
    ],
    ["another algorithm", () => changed((b) => (b.writeUInt32BE(1, 20), b)), {}],
    [
      "a name that is not the tag's MAR",
      () => addSignaturePlaceholder(fixture()),
      { MAR: "vimma-0.3.2-linux-x86_64.complete.mar" },
    ],
    [
      "a caller tag that is not vX.Y.Z",
      () => addSignaturePlaceholder(fixture()),
      { CALLER_TAG: "main" },
    ],
  ] as [string, () => Buffer, Record<string, string>][])(
    "refuses to sign %s",
    (_name, mar, env) => {
      const { dir } = setUp(mar());
      if (env.MAR) writeFileSync(join(dir, "in", env.MAR), readFileSync(join(dir, "in", NAME)));
      const check = run(dir, "Check the MAR placeholder", env);
      expect(check.status).not.toBe(0);
      expect(check.stdout + check.stderr).toMatch(/::error::/);
    },
    60_000,
  );

  /**
   * The unsigned MAR with its product information block naming `channel`: the MAR Mozilla's
   * `mar -H <channel>` writes for the same files, rebuilt here since the fixture names `vimma`.
   */
  function withChannel(buf: Buffer, channel: string) {
    const mar = readMar(buf);
    const product = Buffer.from(`${channel}\0${mar.productVersion}\0`, "latin1");
    const block = Buffer.alloc(8);
    block.writeUInt32BE(8 + product.length, 0);
    block.writeUInt32BE(1, 4);
    const contents: Buffer[] = [];
    const index: Buffer[] = [];
    let at = 24 + 8 + product.length;
    for (const e of mar.entries) {
      const entry = Buffer.alloc(12);
      entry.writeUInt32BE(at, 0);
      entry.writeUInt32BE(e.size, 4);
      entry.writeUInt32BE(buf.readUInt32BE(e.offsetAt + 8), 8);
      index.push(entry, Buffer.from(`${e.name}\0`, "utf8"));
      contents.push(buf.subarray(e.offset, e.offset + e.size));
      at += e.size;
    }
    const indexBytes = Buffer.concat(index);
    const header = Buffer.alloc(24);
    header.write("MAR1", 0, "latin1");
    header.writeUInt32BE(at, 4);
    header.writeBigUInt64BE(BigInt(at + 4 + indexBytes.length), 8);
    header.writeUInt32BE(0, 16);
    header.writeUInt32BE(1, 20);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(indexBytes.length);
    return Buffer.concat([header, block, product, ...contents, length, indexBytes]);
  }

  it("signs a nightly's MAR for nightly.yml on main, on the nightly channel", () => {
    const placeholder = addSignaturePlaceholder(withChannel(fixture(), "vimma-nightly"));
    const { dir, publicKey } = setUp(placeholder);
    writeFileSync(join(dir, "in", NIGHTLY_NAME), placeholder);
    const env = { CALLER: NIGHTLY_CALLER, CALLER_TAG: "", MAR: NIGHTLY_NAME };
    const check = run(dir, "Check the MAR placeholder", env);
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
    expect(check.stdout).toContain("channel vimma-nightly");
    const signed = run(dir, "Sign the MAR with Cloud KMS", env);
    expect(signed.status).toBe(0);
    const out = readFileSync(join(dir, "out", NIGHTLY_NAME));
    expect(
      verifyMar(out, [publicKey], { channel: "vimma-nightly", productVersion: "159.0.1" }),
    ).toMatchObject({ channel: "vimma-nightly" });
    // Under the release channel the same signed MAR is refused: error 22 in the updater.
    expect(() =>
      verifyMar(out, [publicKey], { channel: "vimma", productVersion: "159.0.1" }),
    ).toThrow(/channel/);
  }, 60_000);

  it.each([
    [
      "a release-channel MAR for nightly.yml",
      () => addSignaturePlaceholder(fixture()),
      { CALLER: NIGHTLY_CALLER, CALLER_TAG: "", MAR: NIGHTLY_NAME },
    ],
    [
      "a nightly-channel MAR for release.yml",
      () => addSignaturePlaceholder(withChannel(fixture(), "vimma-nightly")),
      {},
    ],
    [
      "a release's MAR name for nightly.yml",
      () => addSignaturePlaceholder(withChannel(fixture(), "vimma-nightly")),
      { CALLER: NIGHTLY_CALLER, CALLER_TAG: "" },
    ],
    [
      "a nightly's MAR name for release.yml",
      () => addSignaturePlaceholder(fixture()),
      { MAR: NIGHTLY_NAME },
    ],
    [
      "a channel that only starts with the nightly's",
      () => addSignaturePlaceholder(withChannel(fixture(), "vimma-nightlyx")),
      { CALLER: NIGHTLY_CALLER, CALLER_TAG: "", MAR: NIGHTLY_NAME },
    ],
    [
      "nightly.yml on another branch",
      () => addSignaturePlaceholder(withChannel(fixture(), "vimma-nightly")),
      {
        CALLER: "vimma-browser/vimma/.github/workflows/nightly.yml@refs/heads/feature",
        CALLER_TAG: "",
        MAR: NIGHTLY_NAME,
      },
    ],
    [
      "another workflow on main",
      () => addSignaturePlaceholder(fixture()),
      { CALLER: "vimma-browser/vimma/.github/workflows/ci.yml@refs/heads/main" },
    ],
  ])(
    "refuses to sign %s",
    (_name, mar, env) => {
      const { dir } = setUp(mar());
      writeFileSync(join(dir, "in", NIGHTLY_NAME), readFileSync(join(dir, "in", NAME)));
      const check = run(dir, "Check the MAR placeholder", env);
      expect(check.status).not.toBe(0);
      expect(check.stdout + check.stderr).toMatch(/::error::/);
    },
    60_000,
  );

  it("the checked offsets are the ones mar.ts reads", () => {
    const mar = readMar(addSignaturePlaceholder(fixture()));
    expect(mar.signatures).toEqual([{ algorithm: 2, offset: 28, length: 512 }]);
  });
});

describe("tools/update/manifest.ts verify (the CLI the publish job runs)", () => {
  it("refuses a manifest no pinned key signed, and says why", () => {
    const dir = tempDir("vimma-verify-");
    const body = buildManifest({ serial: "20261028041207", update: null });
    writeFileSync(
      join(dir, "update.xml"),
      body + "<!-- vimma-signature v1 key=00000000 sig=AAAA -->\n",
    );
    const r = spawnSync(
      "node",
      [
        new URL("../manifest.ts", import.meta.url).pathname,
        "verify",
        "--signed",
        join(dir, "update.xml"),
        "--offer",
        "nothing",
      ],
      { encoding: "utf8" },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/signature/);
  });

  it("pem prints the pinned primary for openssl", () => {
    const pem = execFileSync("node", [new URL("../manifest.ts", import.meta.url).pathname, "pem"], {
      encoding: "utf8",
    });
    expect(pem).toMatch(/^-----BEGIN PUBLIC KEY-----\n/);
  });
});
