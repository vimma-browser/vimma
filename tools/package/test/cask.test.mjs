import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../test/temp-dir.mjs";
import { cask } from "../cask.mjs";

// Spec macos-homebrew, decisions 4 to 9: the Homebrew cask, a release asset that homebrew.yml
// pushes to vimma-browser/homebrew-tap as Casks/vimma.rb.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const surfer = JSON.parse(readFileSync(join(repo, "surfer.json"), "utf8"));
const VERSION = surfer.brands.vimma.release.displayVersion;
const SHA = "a".repeat(64);
const input = { version: "0.1.6", dmgSha256: SHA, repo: "vimma-browser/vimma" };

describe("cask", () => {
  const text = cask(input);

  it("names the release dmg for the version and pins its sha256", () => {
    expect(text).toMatch(/^cask "vimma" do\n/);
    expect(text).toContain('  version "0.1.6"\n');
    expect(text).toContain(`  sha256 "${SHA}"\n`);
    expect(text).toContain(
      '  url "https://github.com/vimma-browser/vimma/releases/download/v#{version}/vimma-#{version}-macos-aarch64.dmg"\n',
    );
  });

  it("refuses a pre-release, a version that is not SemVer, and a bad sha256", () => {
    expect(() => cask({ ...input, version: "0.1.6-rc.1" })).toThrow(/pre-release/);
    expect(() => cask({ ...input, version: '0.1.6"' })).toThrow(/version/);
    expect(() => cask({ ...input, dmgSha256: "A".repeat(64) })).toThrow(/sha256/);
    expect(() => cask({ ...input, dmgSha256: "a".repeat(63) })).toThrow(/sha256/);
  });

  it.each(["vimma", 'evil/repo"', "a/b c", "owner/name#{x}"])("refuses repo %j", (bad) => {
    expect(() => cask({ ...input, repo: bad })).toThrow(/owner\/name/);
  });

  it("declares arm64, the minimum macOS, the app and the vimma binary, and no flight blocks", () => {
    expect(text).toContain("  depends_on arch: :arm64\n");
    expect(text).toContain("  depends_on macos: :sequoia\n");
    expect(text).toContain('  app "Vimma.app"\n');
    expect(text).toContain('  binary "#{appdir}/Vimma.app/Contents/MacOS/vimma"\n');
    // vimma-ctl ships inside the app (spec ship-vimma-ctl) and goes on the PATH beside vimma
    expect(text).toContain('  binary "#{appdir}/Vimma.app/Contents/MacOS/vimma-ctl"\n');
    // Vimma has no macOS updater, so brew upgrade replaces the app (decision 7)
    expect(text).not.toMatch(/auto_updates true/);
    expect(text).not.toMatch(/preflight|postflight|installer |script:/);
    expect(text).toContain("  livecheck do\n    url :url\n    strategy :github_latest\n  end\n");
  });

  // The bundle identifier is surfer.json's appId (spec macos-homebrew, open question 4).
  it("quits and zaps by surfer.json's bundle identifier", () => {
    const id = surfer.appId;
    expect(id).toBe("dev.vimma.browser");
    expect(text).toContain(`  uninstall quit: "${id}"\n`);
    expect(text).toContain(`"~/Library/Preferences/${id}.plist"`);
    expect(text).toContain(`"~/Library/Saved Application State/${id}.savedState"`);
  });

  it("zaps Application Support and Caches, never ~/.config/vimma", () => {
    const zap = text.slice(text.indexOf("  zap trash: ["), text.indexOf("  ]\n") + 4);
    expect(zap).toContain('"~/Library/Application Support/Vimma"');
    expect(zap).toContain('"~/Library/Caches/Vimma"');
    expect(text).not.toContain(".config");
  });

  // Homebrew deprecates --no-quarantine as a circumvention of macOS security (Research).
  it("caveats point to Open Anyway, never to xattr or --no-quarantine", () => {
    const caveats = text.slice(text.indexOf("  caveats <<~EOS\n"));
    expect(caveats).toContain("Open Anyway");
    expect(caveats).toContain("Privacy & Security");
    expect(text).not.toMatch(/xattr|quarantine/);
  });

  // Spec macos-build, sub-PR 7: a notarised app opens like any other, so its cask needs no note.
  it("a notarised release's cask has no caveats and is otherwise the same", () => {
    const notarised = cask({ ...input, notarised: true });
    expect(notarised).not.toMatch(/caveats|Open Anyway|notarised/);
    expect(notarised).toBe(text.slice(0, text.indexOf("\n  caveats <<~EOS\n")) + "end\n");
  });
});

describe("cask.mjs", () => {
  const script = join(repo, "tools/package/cask.mjs");
  /** @param {string[]} args */
  const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

  it("writes the cask for surfer.json's version with the dmg's SHA-256", () => {
    const dir = tempDir("vimma-cask-");
    const dmg = join(dir, "vimma.dmg");
    writeFileSync(dmg, "not really a dmg\n");
    const out = join(dir, "vimma.rb");
    const result = run(["--tag", `v${VERSION}`, "--dmg", dmg, "--out", out]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const sha = createHash("sha256").update("not really a dmg\n").digest("hex");
    expect(readFileSync(out, "utf8")).toBe(
      cask({ version: VERSION, dmgSha256: sha, repo: "vimma-browser/vimma" }),
    );
  });

  it("--notarised writes the cask without caveats", () => {
    const dir = tempDir("vimma-cask-");
    const dmg = join(dir, "vimma.dmg");
    writeFileSync(dmg, "signed dmg\n");
    const out = join(dir, "vimma.rb");
    const result = run(["--notarised", "--tag", `v${VERSION}`, "--dmg", dmg, "--out", out]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const sha = createHash("sha256").update("signed dmg\n").digest("hex");
    expect(readFileSync(out, "utf8")).toBe(
      cask({ version: VERSION, dmgSha256: sha, repo: "vimma-browser/vimma", notarised: true }),
    );
  });

  it("refuses a tag that is not surfer.json's version", () => {
    const dir = tempDir("vimma-cask-");
    const dmg = join(dir, "vimma.dmg");
    writeFileSync(dmg, "x");
    const result = run(["--tag", "v0.0.0", "--dmg", dmg, "--out", join(dir, "vimma.rb")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/does not match/);
  });
});

// The script brew runs on a Mac: release.yml's macos-smoke and pkgbuild.yml's cask job.
describe("cask-check.sh", () => {
  const path = join(repo, "tools/package/cask-check.sh");
  const script = readFileSync(path, "utf8");

  it("checks the cask with brew style and an offline brew audit --cask --strict", () => {
    expect(script).toContain('brew style "$TAP/vimma"');
    expect(script).toContain('brew audit --cask --strict "$TAP/vimma"');
    expect(script).not.toMatch(/--online|--signing|--new/);
  });

  // An install places the dmg in Homebrew's download cache, so brew fetches nothing and still
  // checks the cask's sha256 against it; --zap then removes Vimma's profiles.
  it("installs from the download cache, then uninstalls with --zap", () => {
    expect(script).toContain('cache=$(brew --cache --cask "$TAP/vimma")');
    expect(script).toContain('brew install --cask "$TAP/vimma"');
    expect(script).toContain('brew uninstall --zap --cask "$TAP/vimma"');
    // the installed app keeps its signature, and `vimma` on the PATH is its binary
    expect(script).toContain('codesign --verify --deep --strict "$APP"');
    expect(script).toContain(
      '[ "$(readlink "$(brew --prefix)/bin/vimma")" = "$APP/Contents/MacOS/vimma" ]',
    );
    expect(script).toContain(
      '[ "$(readlink "$(brew --prefix)/bin/vimma-ctl")" = "$APP/Contents/MacOS/vimma-ctl" ]',
    );
  });

  // --zap deletes ~/Library/Application Support/Vimma: on a developer's Mac, that is their profile.
  it("refuses to install outside GitHub Actions", () => {
    const dir = tempDir("vimma-cask-check-");
    const rb = join(dir, "vimma.rb");
    writeFileSync(rb, cask(input));
    const result = spawnSync("bash", [path, rb, join(dir, "vimma.dmg")], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: dir },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/GitHub Actions/);
  });
});

// As pkgbuild.yml's arch job builds the PKGBUILD from a stub tarball, its cask job checks the
// cask and installs a stub dmg through it on a hosted Mac whenever the packaging code changes.
describe("pkgbuild.yml", () => {
  const file = readFileSync(join(repo, ".github/workflows/pkgbuild.yml"), "utf8");
  const block = file.slice(file.indexOf("\n  cask:\n"));

  it("checks the cask with a stub dmg on a hosted Mac", () => {
    expect(block).toMatch(/^ {4}runs-on: macos-15$/m);
    expect(block).toMatch(/^ {8}run: tools\/package\/cask-check\.sh --stub$/m);
    expect(block).toMatch(/persist-credentials: false/);
  });
});
