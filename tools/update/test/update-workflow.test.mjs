// update-publish.yml (docs/specs/m6a-updater.md §7; docs/runbook.md, "Update signing keys and
// the update host"): a published release gets a signed update manifest on updates.vimma.dev.
// The workflow is read as text, as release-workflow.test.mjs reads release.yml, and its signing
// step is run here with a stand-in for gcloud that signs the way Cloud KMS's raw PKCS#1 key
// does, so the bytes it writes are checked by the verifier the browser runs.
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../test/temp-dir.mjs";
import { IDENTITY_REGEXP } from "../../package/package.mjs";
import {
  base64Encode,
  spkiKeyId,
  verifyManifest,
} from "../../../packages/vimma-core/src/updates/updates.mjs";
import { buildManifest, buildNightlyManifest, serialAt } from "../manifest.mjs";
import { addSignaturePlaceholder, insertSignature, readMar, verifyMar } from "../mar.mjs";

const text = readFileSync(
  new URL("../../../.github/workflows/update-publish.yml", import.meta.url),
  "utf8",
);

/** @returns {Map<string, string>} job id -> its YAML block */
function jobs() {
  const body = text.slice(text.indexOf("\njobs:\n") + 7);
  const parts = body.split(/^ {2}([a-z][a-z0-9-]*):\n/m).slice(1);
  /** @type {Map<string, string>} */
  const map = new Map();
  for (let i = 0; i < parts.length; i += 2) map.set(parts[i] ?? "", parts[i + 1] ?? "");
  return map;
}
const all = jobs();
/** @param {string} id */
const job = (id) => all.get(id) ?? "";

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
 * The `run:` script of the step called `name`, unindented.
 * @param {string} block
 * @param {string} name
 */
function runOf(block, name) {
  const step = stepOf(block, name);
  const lines = step.slice(step.indexOf("run: |\n") + 8).split("\n");
  return lines.map((l) => l.replace(/^ {10}/, "")).join("\n");
}

/** The `permissions:` lines of a job, as `name: value`. @param {string} block */
function permissionsOf(block) {
  const m = /^ {4}permissions:(?: (\{\})\n|\n((?: {6}.*\n)+))/m.exec(block);
  if (!m) return null;
  if (m[1]) return [];
  return (m[2] ?? "")
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean);
}

const GUARD =
  "github.event_name == 'workflow_dispatch' && github.repository == 'vimma-browser/vimma' && " +
  "github.ref == 'refs/heads/main'";

describe("update-publish.yml", () => {
  it("has the jobs: the release manifest's, mar-sign, the nightly manifest's, failure", () => {
    expect([...all.keys()]).toEqual([
      "start",
      "prepare",
      "sign",
      "publish",
      "mar-sign",
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
    // A one-leg matrix, so that the runner check (docs/security.md, B5) sees every runner it
    // can take; the exclude drops the other target's.
    expect(job("prepare")).toContain(
      "\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n" +
        "        os: [ubuntu-24.04, macos-15]\n        exclude:\n" +
        "          - os: ${{ inputs.target == 'macos' && 'ubuntu-24.04' || 'macos-15' }}\n",
    );
    expect(job("sign")).toContain("\n    runs-on: ubuntu-24.04\n");
    expect(job("publish")).toContain("\n    runs-on: ubuntu-24.04\n");
  });

  it("downloads the target's files and sums, and passes the target to manifest.mjs", () => {
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
    expect(permissionsOf(job("start"))).toEqual(["actions: write"]);
    expect(permissionsOf(job("prepare"))).toEqual(["contents: read", "pull-requests: read"]);
    expect(permissionsOf(job("sign"))).toEqual(["id-token: write"]);
    expect(permissionsOf(job("publish"))).toEqual(["contents: read"]);
    expect(permissionsOf(job("mar-sign"))).toEqual(["id-token: write"]);
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
      expect(block.includes("id-token"), id).toBe(signers.includes(id));
      expect(block.includes("update-signing"), id).toBe(signers.includes(id));
      expect(block.includes("GCP_"), id).toBe(signers.includes(id));
    }
    for (const id of signers) expect(job(id)).toMatch(/^ {4}environment: update-signing$/m);
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

  it.each(["sign", "mar-sign", "nightly-sign"])(
    "the signing job %s runs no repository code: no checkout, no node, no npm",
    (id) => {
      const sign = job(id);
      expect(sign).not.toContain("actions/checkout");
      expect(sign).not.toMatch(/\bnode\b|\bnpm\b|\bnpx\b|setup-node/);
    },
  );

  it("no job installs dependencies, and no checkout keeps a token in .git/config", () => {
    expect(text).not.toMatch(/npm (?:ci|install)|npx /);
    const checkouts = text.split("uses: actions/checkout@").slice(1);
    // prepare and publish, nightly-prepare and nightly-publish.
    expect(checkouts.length).toBe(4);
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

  it.each(["prepare", "sign", "publish"])(
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
      /^ {2}workflow_call:\n {4}inputs:\n {6}mar:\n {8}description: .+\n {8}required: false\n {8}type: string\n {8}default: ""\n {6}nightly:\n {8}description: .+\n {8}required: false\n {8}type: string\n {8}default: ""\n(?: {4}#.*\n)* {4}secrets:\n/m,
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
    expect(mar).toContain("node tools/update/mar.mjs verify");
    expect(mar).toContain("--channel vimma-nightly");
    expect(mar).toContain(
      "--cert configs/updater/primary.der --cert configs/updater/secondary.der",
    );
    const published = runOf(prepare, "The published nightly manifest");
    expect(published).toContain("path=updates/browser/$BUILD_TARGET/vimma-nightly/update.xml");
    const build = runOf(prepare, "Build the nightly manifest");
    expect(build).toContain(
      'node tools/update/manifest.mjs build --channel nightly --build-id "$BUILD_ID" --version "$version"',
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
      'node tools/update/manifest.mjs verify --channel nightly --signed signed/update.xml --build-id "$BUILD_ID" --version "$version" --assets assets',
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
        "format('update-publish-call-{0}', github.run_id) || " +
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
    expect(verify).toContain("node tools/update/manifest.mjs verify");
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
    expect(run).toContain("node tools/update/manifest.mjs verify");
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
    /** @type {Record<string, string>} */
    const stepEnv = {};
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
    /** @param {string[]} args @param {string} cwd @param {Record<string, string>} [env] */
    const git = (args, cwd, env = { ...base, ...who }) =>
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
   * @param {string} body
   */
  function setUp(body) {
    const dir = tempDir("vimma-sign-");
    const pair = generateKeyPairSync("rsa", { modulusLength: 4096 });
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
   * @param {string} dir
   * @param {string} name
   * @param {Record<string, string>} env
   * @param {string} [id] the job
   */
  const run = (dir, name, env, id = "sign") =>
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
    urgency: /** @type {const} */ ("normal"),
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
      slot: /** @type {const} */ ("primary"),
      spki: base64Encode(der),
    };
    expect(await verifyManifest(out, [pin], subtle)).toEqual({
      ok: true,
      body,
      key: { id: pin.id, slot: "primary" },
    });
  }, 60_000);

  it.each(
    /** @type {[string, (body: string) => string, string, RegExp?][]} */ ([
      [
        "a body already carrying a signature",
        (b) => b + "<!-- vimma-signature v1 -->\n",
        "release",
      ],
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
    ]),
  )(
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
  const withPatch = (/** @type {string} */ url = MAR_URL) =>
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
      slot: /** @type {const} */ ("primary"),
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
    /** @param {string} id */
    const byteCheck = (id) => {
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
// builds (tools/update/mar.mjs, from a MAR Mozilla's own `mar` made) comes out signed so that the
// updater's check accepts it under the KMS key.
describe.skipIf(process.platform !== "linux")("the MAR signing job's steps, run", () => {
  const NAME = "vimma-0.3.1-linux-x86_64.complete.mar";
  const NIGHTLY_NAME = "vimma-nightly-20261112030512-linux-x86_64.complete.mar";
  const RELEASE_CALLER = "vimma-browser/vimma/.github/workflows/release.yml@refs/heads/main";
  const NIGHTLY_CALLER = "vimma-browser/vimma/.github/workflows/nightly.yml@refs/heads/main";
  const fixture = () => readFileSync(new URL("fixtures/mar/unsigned.mar", import.meta.url));

  /** @param {Buffer} mar */
  function setUp(mar) {
    const dir = tempDir("vimma-mar-sign-");
    const pair = generateKeyPairSync("rsa", { modulusLength: 4096 });
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

  /**
   * @param {string} dir
   * @param {string} name
   * @param {Record<string, string>} [env]
   */
  const run = (dir, name, env = {}) =>
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

  /** @param {(b: Buffer) => Buffer} change */
  const changed = (change) => change(Buffer.from(addSignaturePlaceholder(fixture())));

  it.each(
    /** @type {[string, () => Buffer, Record<string, string>][]} */ ([
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
    ]),
  )(
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
   * @param {Buffer} buf
   * @param {string} channel
   */
  function withChannel(buf, channel) {
    const mar = readMar(buf);
    const product = Buffer.from(`${channel}\0${mar.productVersion}\0`, "latin1");
    const block = Buffer.alloc(8);
    block.writeUInt32BE(8 + product.length, 0);
    block.writeUInt32BE(1, 4);
    /** @type {Buffer[]} */
    const contents = [];
    /** @type {Buffer[]} */
    const index = [];
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

  it("the checked offsets are the ones mar.mjs reads", () => {
    const mar = readMar(addSignaturePlaceholder(fixture()));
    expect(mar.signatures).toEqual([{ algorithm: 2, offset: 28, length: 512 }]);
  });
});

describe("tools/update/manifest.mjs verify (the CLI the publish job runs)", () => {
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
        new URL("../manifest.mjs", import.meta.url).pathname,
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
    const pem = execFileSync(
      "node",
      [new URL("../manifest.mjs", import.meta.url).pathname, "pem"],
      {
        encoding: "utf8",
      },
    );
    expect(pem).toMatch(/^-----BEGIN PUBLIC KEY-----\n/);
  });
});
