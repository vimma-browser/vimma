#!/usr/bin/env node
/**
 * The Homebrew cask for a release's macOS .dmg (spec macos-homebrew, decisions 4 to 9). release.yml's
 * macos-build job writes it beside the dmg as the release asset `vimma.rb`, listed in
 * SHA256SUMS-macos; homebrew.yml pushes the published release's copy to vimma-browser/homebrew-tap
 * as Casks/vimma.rb, so users install with `brew install --cask vimma-browser/tap/vimma`.
 *
 * Usage:
 *   node tools/package/cask.mjs --dmg <vimma-X.Y.Z-macos-aarch64.dmg> --out <vimma.rb>
 *     [--tag vX.Y.Z] [--repo vimma-browser/vimma]
 * The version is surfer.json brands.vimma.release.displayVersion; --tag must be exactly v<that>.
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

/**
 * @typedef {{ version: string, dmgSha256: string, repo: string }} CaskInput
 */

/**
 * The cask text. Each value goes into a Ruby string, so only a release version, a lowercase
 * SHA-256 and a GitHub `owner/name` pass. Releases only: release.yml accepts vX.Y.Z tags, and
 * the tap, like the AUR, gets no pre-release.
 * @param {CaskInput} input
 * @returns {string}
 */
export function cask({ version, dmgSha256, repo }) {
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

  uninstall quit: "${BUNDLE_ID}"

  zap trash: [
    "~/Library/Application Support/Vimma",
    "~/Library/Caches/Vimma",
    "~/Library/Preferences/${BUNDLE_ID}.plist",
    "~/Library/Saved Application State/${BUNDLE_ID}.savedState",
  ]

  caveats <<~EOS
    Vimma is not notarised by Apple yet, so macOS will not open it the first time.
    Open it once, then go to System Settings → Privacy & Security, choose
    Open Anyway next to Vimma, and confirm. macOS may ask again after an upgrade.
  EOS
end
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      dmg: { type: "string" },
      out: { type: "string" },
      tag: { type: "string" },
      repo: { type: "string", default: REPO },
    },
  });
  try {
    if (!values.dmg || !values.out) throw new Error("usage: cask.mjs --dmg <file> --out <file>");
    const version = releaseVersion(SURFER, values.tag);
    const text = cask({ version, dmgSha256: sha256File(values.dmg), repo: values.repo });
    writeFileSync(values.out, text);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
