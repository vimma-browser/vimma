#!/usr/bin/env bash
# Checks a mounted Vimma .dmg shows Vimma's window art and volume icon (spec macos-homebrew,
# decision 14): the volume's .DS_Store, .background/background.png and .VolumeIcon.icns are the
# committed dsstore, background.png and disk.icns, and the volume's root folder has the custom
# icon flag that makes Finder show .VolumeIcon.icns. A build that kept Firefox's unofficial
# branding files, or a repack that dropped them, fails. Run from the repository root on macOS;
# XATTR replaces the system tool in tests.
#
#   tools/package/macos-dmg-check.sh /path/to/mounted/volume
set -euo pipefail
volume="${1:?usage: macos-dmg-check.sh /path/to/mounted/volume}"
xattr="${XATTR:-xattr}"
branding=configs/branding/vimma

failed=0
for pair in .DS_Store:dsstore .background/background.png:background.png .VolumeIcon.icns:disk.icns; do
  name=${pair%%:*}
  committed=$branding/${pair#*:}
  if [ ! -f "$volume/$name" ]; then
    echo "::error::the dmg has no $name"
    failed=1
  elif ! cmp -s "$volume/$name" "$committed"; then
    echo "::error::the dmg's $name is not $committed"
    failed=1
  fi
done

# com.apple.FinderInfo of a folder: its Finder flags are bytes 8 and 9; kHasCustomIcon is 0x0400.
info=$("$xattr" -px com.apple.FinderInfo "$volume" 2> /dev/null | tr -d ' \n' || true)
flags=${info:16:4}
if [ -z "$flags" ] || (((16#$flags & 0x0400) == 0)); then
  echo "::error::the dmg's volume has no custom icon flag, so Finder ignores .VolumeIcon.icns"
  failed=1
fi

[ "$failed" = 0 ] || exit 1
echo "The dmg has Vimma's window art, layout and volume icon"
