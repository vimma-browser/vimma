#!/bin/sh
# Ad hoc signs the app in a .dmg from `mach package` and packs it again (spec macos-build,
# decisions 7 and 10). `rcodesign sign` with no certificate, entitlements or hardened runtime:
# entitlements apply only under the hardened runtime, which an ad hoc build does not need; the
# Developer ID build brings both. mach's own unpack_dmg and make_dmg do the disk images, with the
# tools --enable-bootstrap fetched, so this runs the same on Linux and on a Mac.
# Usage: tools/package/macos-dmg.sh <in.dmg> <out.dmg>
#   MACH       mach to run (default: engine/mach); MOZ_OBJDIR as for the build
#   RCODESIGN  rcodesign to run (default: rcodesign on PATH)
#   VIMMA_CTL  a vimma-ctl built for the Mac, put next to vimma in Contents/MacOS before signing
#              (spec ship-vimma-ctl); release.yml sets it, the weekly macOS build does not
set -eu

in=${1:?usage: macos-dmg.sh <in.dmg> <out.dmg>}
out=${2:?usage: macos-dmg.sh <in.dmg> <out.dmg>}
mach=${MACH:-$(dirname "$0")/../../engine/mach}
rcodesign=${RCODESIGN:-rcodesign}

absolute() { case "$1" in /*) echo "$1" ;; *) echo "$PWD/$1" ;; esac; }
in=$(absolute "$in")
out=$(absolute "$out")

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
staged="$work/dmg"

"$mach" python -m mozbuild.action.unpack_dmg "$in" "$staged"

set -- "$staged"/*.app
if [ "$#" -ne 1 ] || [ ! -d "$1" ]; then
  echo "macos-dmg.sh: $in must hold exactly one .app" >&2
  exit 1
fi
app=$1

# The window art and volume icon (spec macos-homebrew, decision 14). mach package puts them on the
# volume from the branding directory (toolkit/moz.configure, MOZ_PACKAGE_EXTRA_ARGS); unpack_dmg
# copies the volume's hidden files into $staged and make_dmg packs them again with the app, so a
# dmg without them would be repacked without them.
for art in .DS_Store .background/background.png .VolumeIcon.icns; do
  if [ ! -f "$staged/$art" ]; then
    echo "macos-dmg.sh: $in has no $art; mach package puts it there from the branding directory" >&2
    exit 1
  fi
done

if [ -n "${VIMMA_CTL:-}" ]; then
  [ -f "$VIMMA_CTL" ] && [ -x "$VIMMA_CTL" ] || {
    echo "macos-dmg.sh: VIMMA_CTL=$VIMMA_CTL is not an executable file" >&2
    exit 1
  }
  cp "$VIMMA_CTL" "$app/Contents/MacOS/vimma-ctl"
  chmod 755 "$app/Contents/MacOS/vimma-ctl"
  # Nested code is signed before the bundle that seals it, as codesign --verify --deep expects.
  "$rcodesign" sign "$app/Contents/MacOS/vimma-ctl"
fi

# A disk image mounted on a Mac leaves Finder attributes that a strict verify rejects.
if command -v xattr > /dev/null 2>&1; then xattr -cr "$app"; fi

"$rcodesign" sign "$app"
"$mach" python -m mozbuild.action.make_dmg --volume-name Vimma "$staged" "$out"
