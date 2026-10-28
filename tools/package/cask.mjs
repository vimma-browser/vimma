#!/usr/bin/env node
/**
 * The Homebrew cask for a release's macOS .dmg (spec macos-homebrew, decisions 4 to 9). release.yml's
 * macos-build job writes it beside the dmg as the release asset `vimma.rb`, listed in
 * SHA256SUMS-macos; homebrew.yml pushes the published release's copy to vimma-browser/homebrew-tap
 * as Casks/vimma.rb, so users install with `brew install --cask vimma-browser/tap/vimma`.
 *
 * Usage:
 *   node tools/package/cask.mjs --dmg <vimma-X.Y.Z-macos-aarch64.dmg> --out <vimma.rb>
 *     [--tag vX.Y.Z] [--repo vimma-browser/vimma] [--notarised]
 * The version is surfer.json brands.vimma.release.displayVersion; --tag must be exactly v<that>.
 * --notarised is for a dmg that macos-pack packed after macos-notarise signed its app with Vimma's
 * Developer ID: macOS opens that
 * app without asking, so the cask has no caveats (spec macos-build, decision 23).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { REPO } from "../repo.mjs";
import { releaseVersion, sha256File } from "./package.mjs";

const SURFER = JSON.parse(readFileSync(new URL("../../surfer.json", import.meta.url), "utf8"));

/**
 * The app's bundle identifier, surfer.json's appId (spec macos-homebrew, open question 4):
 * `uninstall quit:` and the zap paths name it.
 */
const BUNDLE_ID = (() => {
  const id = SURFER.appId;
  if (typeof id !== "string" || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(id)) {
    throw new Error(`surfer.json appId is not a bundle identifier: ${String(id)}`);
  }
  return id;
})();

/** The note an ad hoc signed release's cask shows, since Gatekeeper refuses its first open. */
const ADHOC_CAVEATS = `
  caveats <<~EOS
    Vimma is not notarised by Apple yet, so macOS will not open it the first time.
    Open it once, then go to System Settings → Privacy & Security, choose
    Open Anyway next to Vimma, and confirm. macOS may ask again after an upgrade.
  EOS
`;

/**
 * @typedef {{ version: string, dmgSha256: string, repo: string, notarised?: boolean }} CaskInput
 */

/**
 * The cask text. Each value goes into a Ruby string, so only a release version, a lowercase
 * SHA-256 and a GitHub `owner/name` pass. Releases only: release.yml accepts vX.Y.Z tags, and
 * the tap, like the AUR, gets no pre-release.
 * @param {CaskInput} input
 * @returns {string}
 */
export function cask({ version, dmgSha256, repo, notarised = false }) {
  if (/^\d+\.\d+\.\d+-/.test(version)) {
    throw new Error(`cask: ${version} is a pre-release; releases only`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`cask: version must be X.Y.Z, got: ${JSON.stringify(version)}`);
  }
  if (!/^[0-9a-f]{64}$/.test(dmgSha256)) {
    throw new Error(
      `cask: sha256 must be 64 lowercase hex digits, got: ${JSON.stringify(dmgSha256)}`,
    );
  }
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error(`cask: repo must be owner/name, got: ${JSON.stringify(repo)}`);
  }
  return `cask "vimma" do
  version "${version}"
  sha256 "${dmgSha256}"

  url "https://github.com/${repo}/releases/download/v#{version}/vimma-#{version}-macos-aarch64.dmg"
  name "Vimma"
  desc "Keyboard-first web browser built on Firefox"
  homepage "https://github.com/${repo}"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64
  depends_on macos: :sequoia

  app "Vimma.app"
  binary "#{appdir}/Vimma.app/Contents/MacOS/vimma"
  binary "#{appdir}/Vimma.app/Contents/MacOS/vimma-ctl"

  uninstall quit: "${BUNDLE_ID}"

  zap trash: [
    "~/Library/Application Support/Vimma",
    "~/Library/Caches/Vimma",
    "~/Library/Preferences/${BUNDLE_ID}.plist",
    "~/Library/Saved Application State/${BUNDLE_ID}.savedState",
  ]
${notarised ? "" : ADHOC_CAVEATS}end
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      dmg: { type: "string" },
      out: { type: "string" },
      tag: { type: "string" },
      repo: { type: "string", default: REPO },
      notarised: { type: "boolean", default: false },
    },
  });
  try {
    if (!values.dmg || !values.out) throw new Error("usage: cask.mjs --dmg <file> --out <file>");
    const version = releaseVersion(SURFER, values.tag);
    const text = cask({
      version,
      dmgSha256: sha256File(values.dmg),
      repo: values.repo,
      notarised: values.notarised,
    });
    writeFileSync(values.out, text);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
