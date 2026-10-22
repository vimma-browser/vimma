import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../test/temp-dir.mjs";
import { fakeSign, fakeSignature, withFakeGpgv } from "./fake-gpgv.mjs";

// tools/upstream/source-check.sh: the source check upstream.yml runs on a release and the Beta
// canary runs on a Beta (spec upstream-beta-canary, B3 and Design step 2). The archive is a
// file:// directory laid out as archive.mozilla.org's; no network. The fixture tree does not have
// the files our real patches touch, so the patches fail and the preflight (network) never runs.
// gpgv is a stub (fake-gpgv.mjs): the real signature check is test_verify_sha512.py's.
const SCRIPT = fileURLToPath(new URL("../source-check.sh", import.meta.url));
const TREE = fileURLToPath(new URL("../fixtures/patch-check/tree", import.meta.url));

/**
 * @param {string} version
 * @param {{ sums?: (hash: string, name: string) => string, signature?: "good" | "bad" | "none",
 *   tree?: string }} [opts]
 */
function archive(version, opts = {}) {
  const root = tempDir("source-check-");
  const dir = join(root, "releases", version);
  mkdirSync(join(dir, "source"), { recursive: true });
  const name = `source/firefox-${version}.source.tar.xz`;
  const top = `firefox-${version.replace(/b\d+$/, "")}`;
  const tar = spawnSync(
    "tar",
    [
      "-cJf",
      join(dir, name),
      // bsdtar (macOS) has no --transform; its -s takes the same substitution without the "s".
      ...(process.platform === "darwin"
        ? ["-s", `,^\\.,${top},`]
        : ["--transform", `s,^\\.,${top},`]),
      "-C",
      opts.tree ?? TREE,
      ".",
    ],
    { encoding: "utf8" },
  );
  if (tar.status !== 0) throw new Error(tar.stderr);
  const hash = createHash("sha512")
    .update(readFileSync(join(dir, name)))
    .digest("hex");
  const sums = opts.sums ?? ((/** @type {string} */ h, /** @type {string} */ n) => `${h}  ${n}\n`);
  writeFileSync(join(dir, "SHA512SUMS"), sums(hash, name));
  const signature = opts.signature ?? "good";
  if (signature === "good") fakeSign(join(dir, "SHA512SUMS"));
  if (signature === "bad") {
    // A signature packet over other bytes: gpgv itself answers BADSIG.
    writeFileSync(join(dir, "SHA512SUMS.asc"), fakeSignature("other bytes"));
  }
  const work = join(root, "work");
  mkdirSync(work);
  return { base: `file://${join(root, "releases")}`, work };
}

/** @param {string} version @param {{ base: string, work: string }} where */
function run(version, { base, work }) {
  const output = join(work, "github-output");
  writeFileSync(output, "");
  const env = withFakeGpgv({ ...process.env, MOZILLA_RELEASES: base, GITHUB_OUTPUT: output });
  delete env.GITHUB_STEP_SUMMARY;
  const r = spawnSync("bash", [SCRIPT, version], { cwd: work, env, encoding: "utf8" });
  return { ...r, output: readFileSync(output, "utf8") };
}

describe("source-check.sh", () => {
  it("checks a verified release tarball and reports the patch verdict", () => {
    const where = archive("158.0");
    const r = run("158.0", where);
    expect(r.status, r.stderr).toBe(0);
    expect(r.output).toContain("result=fail");
    const report = JSON.parse(readFileSync(join(where.work, "patch-check.json"), "utf8"));
    expect(report.tree).toBe("releases/mozilla-release");
    expect(readFileSync(join(where.work, "patch-audit.txt"), "utf8")).not.toBe("");
  }, 60_000);

  it("checks a beta tarball the same way", () => {
    const where = archive("159.0b1");
    const r = run("159.0b1", where);
    expect(r.status, r.stderr).toBe(0);
    expect(r.output).toContain("result=fail");
  }, 60_000);

  it("fails on a tarball whose SHA-512 Mozilla did not publish", () => {
    const where = archive("158.0", { sums: (h, n) => `${"0".repeat(128)}  ${n}\n${h}  other\n` });
    const r = run("158.0", where);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/SHA-512 .* does not match/);
    expect(r.output).not.toContain("result=");
  }, 60_000);

  it("the source check fails on a SHA512SUMS whose signature is not good", () => {
    const where = archive("158.0", { signature: "bad" });
    const r = run("158.0", where);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(
      /not signed by Mozilla's release key: gpgv reported BADSIG/,
    );
    expect(r.output).not.toContain("result=");
  }, 60_000);

  it("the source check fails when SHA512SUMS has no signature beside it", () => {
    const where = archive("158.0", { signature: "none" });
    const r = run("158.0", where);
    // Exit 1, as documented: never report on a tarball that could not be verified.
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/SHA512SUMS\.asc/);
    expect(r.output).not.toContain("result=");
  }, 60_000);

  it("writes the pref refresh from the verified tarball's prefs files", () => {
    // Spec upstream-bump-automation, sub-PR 1: a cfr field added upstream.
    const tree = join(tempDir("source-check-tree-"), "tree");
    cpSync(TREE, tree, { recursive: true });
    const ours = readFileSync(
      new URL("../../../src/browser/branding/vimma/pref/firefox-branding.js", import.meta.url),
      "utf8",
    );
    const line = (/** @type {string} */ name) =>
      ours.split("\n").find((l) => l.startsWith(`pref("${name}"`)) ?? "";
    const cfr = line("browser.newtabpage.activity-stream.asrouter.providers.cfr")
      .replace('\\"enabled\\":false', '\\"enabled\\":true')
      .replace('}");', ',\\"frequency\\":2}");');
    mkdirSync(join(tree, "browser/app/profile"), { recursive: true });
    mkdirSync(join(tree, "modules/libpref/init"), { recursive: true });
    writeFileSync(join(tree, "browser/app/profile/firefox.js"), `${cfr}\n`);
    writeFileSync(
      join(tree, "modules/libpref/init/all.js"),
      [4, 5].map((n) => line(`browser.safebrowsing.provider.google${n}.lists`)).join("\n"),
    );
    const where = archive("158.0", { tree });
    const r = run("158.0", where);
    expect(r.status, r.stderr).toBe(0);
    expect(r.output).toContain("prefs=refreshed");
    const patch = readFileSync(join(where.work, "prefs-refresh.patch"), "utf8");
    expect(patch).toContain('\\"frequency\\":2}");');
    expect(patch).toContain("+++ b/src/browser/branding/vimma/pref/firefox-branding.js");
  }, 60_000);

  it("a tarball without the prefs files reports them unresolved, never refreshed", () => {
    const where = archive("158.0");
    const r = run("158.0", where);
    expect(r.status, r.stderr).toBe(0);
    expect(r.output).toContain("prefs=unresolved");
    expect(readFileSync(join(where.work, "prefs-refresh.patch"), "utf8")).toBe("");
  }, 60_000);

  it.each(["", "158", "159.0a1", "158.0;id", "../158.0", "158.0 b1"])(
    "refuses version %j before it reaches a URL",
    (version) => {
      const where = archive("158.0");
      const r = run(version, where);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/not a Firefox release or beta version/);
    },
  );
});
