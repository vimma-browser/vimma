#!/usr/bin/env bash
# Unpacks the ad hoc signed .dmg from macos-dmg.sh into a directory: Vimma.app and the volume's
# window art, without the Applications link (spec macos-build, decisions 23 and 28). It runs in
# release.yml's macos-unpack job, which holds no secret, with the Mozilla disk-image tools that
# macos-build's mach bootstrapped, called as python/mozbuild/mozpack/dmg.py does on Linux
# (extract_dmg_contents and extract_dmg, Firefox 158.0).
#
# Usage: tools/package/macos-dmg-unpack.sh <in.dmg> <volume-dir>
#   DMG_TOOLS  a directory with Mozilla's dmg and hfsplus
set -euo pipefail

in=${1:?usage: macos-dmg-unpack.sh <in.dmg> <volume-dir>}
volume=${2:?usage: macos-dmg-unpack.sh <in.dmg> <volume-dir>}

fail() {
  echo "macos-dmg-unpack.sh: $*" >&2
  exit 1
}

[ -n "${DMG_TOOLS:-}" ] || fail "DMG_TOOLS is not set"
for tool in dmg hfsplus; do
  [ -x "$DMG_TOOLS/$tool" ] || fail "DMG_TOOLS has no executable $tool"
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$volume"

"$DMG_TOOLS/dmg" extract "$in" "$work/in.hfs" > /dev/null
"$DMG_TOOLS/hfsplus" "$work/in.hfs" extractall / "$volume"
if [ -L "$volume/ " ]; then rm "$volume/ "; fi

[ -d "$volume/Vimma.app" ] || fail "$in has no Vimma.app"
for art in .DS_Store .background/background.png .VolumeIcon.icns; do
  [ -f "$volume/$art" ] || fail "$in has no $art (macos-dmg.sh keeps the volume's art)"
done
# A stapled ticket means this dmg was signed already: a re-run starts from macos-build's dmg.
[ ! -e "$volume/Vimma.app/Contents/CodeResources" ] || fail "$in is already notarised and stapled"
