// update-publish.yml (docs/specs/m6a-updater.md §7; docs/runbook.md, "Update signing keys and
// the update host"): a published release gets a signed update manifest on updates.vimma.dev.
// The workflow is read as text, as release-workflow.test.mjs reads release.yml, and its signing
// step is run here with a stand-in for gcloud that signs the way Cloud KMS's raw PKCS#1 key
// does, so the bytes it writes are checked by the verifier the browser runs.
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../test/temp-dir.mjs";
import { IDENTITY_REGEXP } from "../../package/package.mjs";
import {
  base64Encode,
  spkiKeyId,
  verifyManifest,
} from "../../../packages/vimma-core/src/updates.mjs";
import { buildManifest, serialAt } from "../manifest.mjs";

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
  it("has the jobs: start on publish, then prepare, sign, publish and the failure report", () => {
    expect([...all.keys()]).toEqual(["start", "prepare", "sign", "publish", "failure"]);
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
        'linux) files=("vimma-$v-linux-x86_64.tar.xz" "vimma-$v-x86_64.AppImage" "vimma_${v}_amd64.deb") ;;',
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
    expect(run).toContain(
      'if curl -fsSIL --proto =https -o /dev/null "https://github.com/$GITHUB_REPOSITORY/releases/download/$TAG/vimma-${TAG#v}-macos-aarch64.dmg"; then',
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
    expect(permissionsOf(job("failure"))).toEqual(["issues: write"]);
  });

  it("only sign mints an OIDC token, and only sign names the signing environment", () => {
    for (const [id, block] of all) {
      expect(block.includes("id-token"), id).toBe(id === "sign");
      expect(block.includes("update-signing"), id).toBe(id === "sign");
      expect(block.includes("GCP_"), id).toBe(id === "sign");
    }
    expect(job("sign")).toMatch(/^ {4}environment: update-signing$/m);
  });

  it("the deploy key lives in its own environment and reaches only the push step", () => {
    for (const [id, block] of all) {
      expect(block.includes("UPDATES_DEPLOY_KEY"), id).toBe(id === "publish");
    }
    const publish = job("publish");
    expect(publish).toMatch(/^ {4}environment: update-publish$/m);
    const uses = publish.split("secrets.UPDATES_DEPLOY_KEY").length - 1;
    // One in the job's "is it set" flag, one in the push step's env.
    expect(uses).toBe(2);
    expect(stepOf(publish, "Push to vimma-updates")).toContain(
      "DEPLOY_KEY: ${{ secrets.UPDATES_DEPLOY_KEY }}",
    );
    expect(publish).toContain("UPDATES_DEPLOY_KEY_SET: ${{ secrets.UPDATES_DEPLOY_KEY != '' }}");
  });

  it("the signing job runs no repository code: no checkout, no node, no npm", () => {
    const sign = job("sign");
    expect(sign).not.toContain("actions/checkout");
    expect(sign).not.toMatch(/\bnode\b|\bnpm\b|\bnpx\b|setup-node/);
  });

  it("no job installs dependencies, and no checkout keeps a token in .git/config", () => {
    expect(text).not.toMatch(/npm (?:ci|install)|npx /);
    const checkouts = text.split("uses: actions/checkout@").slice(1);
    expect(checkouts.length).toBe(2);
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
    },
  );

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
    // and a macOS run started together must not replace each other.
    expect(text).toMatch(
      /^concurrency:\n {2}group: update-publish-\$\{\{ github\.event_name \}\}-\$\{\{ inputs\.target \|\| 'linux' \}\}\n {2}cancel-in-progress: false$/m,
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
   */
  const run = (dir, name, env) =>
    spawnSync("bash", ["-e", "-o", "pipefail", "-c", runOf(job("sign"), name)], {
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
    const pin = { id: await spkiKeyId(subtle, der), slot: "primary", spki: base64Encode(der) };
    expect(await verifyManifest(out, [/** @type {const} */ (pin)], subtle)).toEqual({
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
    [
      "more than 64 KiB",
      (b) => b.replace("</updates>", `<!-- ${"x".repeat(70_000)} -->\n</updates>`),
      "release",
    ],
  ])(
    "refuses to sign %s",
    (_name, change, offer) => {
      const { dir } = setUp(change(offerBody()));
      const check = run(dir, "Check what is about to be signed", { TAG: "v0.3.1", OFFER: offer });
      expect(check.status).not.toBe(0);
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

  it("signs an empty manifest when nothing is offered", () => {
    const { dir } = setUp(buildManifest({ serial: serialAt(new Date()), update: null }));
    const check = run(dir, "Check what is about to be signed", { TAG: "", OFFER: "nothing" });
    expect(check.status).toBe(0);
  }, 60_000);
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
