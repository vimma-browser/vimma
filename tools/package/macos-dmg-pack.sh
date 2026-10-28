#!/usr/bin/env bash
# Packs a volume directory, the signed and stapled Vimma.app with the window art that
# macos-dmg-unpack.sh kept, into a .dmg (spec macos-build, decisions 23 and 28). It runs in
# release.yml's macos-pack job, which holds no secret, with the Mozilla disk-image tools that
# macos-build's mach bootstrapped, called as python/mozbuild/mozpack/dmg.py's create_dmg does on
# Linux (Firefox 158.0).
#
# Usage: tools/package/macos-dmg-pack.sh <volume-dir> <out.dmg>
#   DMG_TOOLS  a directory with Mozilla's dmg, hfsplus and newfs_hfs
set -euo pipefail

volume=${1:?usage: macos-dmg-pack.sh <volume-dir> <out.dmg>}
out=${2:?usage: macos-dmg-pack.sh <volume-dir> <out.dmg>}

fail() {
  echo "macos-dmg-pack.sh: $*" >&2
  exit 1
}

[ -n "${DMG_TOOLS:-}" ] || fail "DMG_TOOLS is not set"
for tool in dmg hfsplus newfs_hfs; do
  [ -x "$DMG_TOOLS/$tool" ] || fail "DMG_TOOLS has no executable $tool"
done
[ -d "$volume/Vimma.app" ] || fail "$volume has no Vimma.app"
[ -f "$volume/Vimma.app/Contents/CodeResources" ] ||
  fail "Vimma.app has no stapled notarisation ticket; macos-notarise signs it first"
for art in .DS_Store .background/background.png .VolumeIcon.icns; do
  [ -f "$volume/$art" ] || fail "$volume has no $art"
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
hfs="$work/staged.hfs"
size_kb=$(du -sk "$volume" | cut -f1)
dd if=/dev/zero of="$hfs" bs=1M count=$((size_kb * 102 / 100000)) 2> /dev/null
"$DMG_TOOLS/newfs_hfs" -v Vimma "$hfs"
"$DMG_TOOLS/hfsplus" "$hfs" symlink "/ " /Applications
"$DMG_TOOLS/hfsplus" "$hfs" attr / C
chmod -R a+rX,a-st,u+w,go-w "$volume"
"$DMG_TOOLS/hfsplus" "$hfs" addall "$volume"
"$DMG_TOOLS/dmg" build "$hfs" "$work/out.dmg" > /dev/null
mv "$work/out.dmg" "$out"
