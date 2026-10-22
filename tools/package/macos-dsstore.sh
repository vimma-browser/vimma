#!/usr/bin/env bash
# Writes configs/branding/vimma/dsstore, the .DS_Store that lays out the mounted dmg's Finder
# window (spec macos-homebrew, decision 14): its size, the background picture, the icon size and
# where Vimma.app and the Applications link sit, from DMG_LAYOUT in tools/package/macos-icons.mjs.
# Finder is the only writer of the format that macOS documents nothing about, so Finder writes
# it: this makes a read-write disk image named Vimma with the committed background.png, lays its
# window out through AppleScript and copies the .DS_Store Finder saves. Firefox's own dsstore is
# made the same way. Its alias to the background names the volume and the path on it, which
# match the dmg make_dmg packs (--volume-name Vimma).
#
# Needs macOS with a logged-in Finder, and asks once to let the terminal control Finder. Not
# reproducible byte for byte, since Finder records dates and the image's location, so the file
# is committed and tools/package/test/macos.test.mjs checks what it says.
#
#   tools/package/macos-dsstore.sh            write configs/branding/vimma/dsstore
#   tools/package/macos-dsstore.sh --out FILE write FILE instead
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
out=$repo/configs/branding/vimma/dsstore
if [ "${1:-}" = --out ]; then out=${2:?usage: macos-dsstore.sh [--out FILE]}; fi
volume=/Volumes/Vimma

[ "$(uname -s)" = Darwin ] || { echo "macos-dsstore.sh needs macOS and Finder" >&2; exit 1; }
if [ -e "$volume" ]; then
  echo "macos-dsstore.sh: $volume is mounted; eject it first" >&2
  exit 1
fi

layout=$(cd "$repo" && node --input-type=module -e '
  import { DMG_LAYOUT as l } from "./tools/package/macos-icons.mjs";
  const [app, link] = [l.icons["Vimma.app"], l.icons[" "]];
  console.log([l.window.width, l.window.height, l.iconSize, ...app, ...link].join(" "));')
read -r width height icon app_x app_y link_x link_y <<< "$layout"

# In the system temp dir, so the path Finder records names no home directory.
work=$(mktemp -d "${TMPDIR:-/tmp}/vimma-dsstore.XXXXXX")
attached=
cleanup() {
  if [ -n "$attached" ]; then hdiutil detach -quiet "$volume" || hdiutil detach -force -quiet "$volume"; fi
  rm -rf "$work"
}
trap cleanup EXIT

stage=$work/stage
mkdir -p "$stage/Vimma.app/Contents" "$stage/.background"
ln -s /Applications "$stage/ "
cp "$repo/configs/branding/vimma/background.png" "$stage/.background/background.png"
cp "$repo/configs/branding/vimma/disk.icns" "$stage/.VolumeIcon.icns"
hdiutil create -quiet -srcfolder "$stage" -volname Vimma -fs HFS+ -format UDRW -ov "$work/rw.dmg"
hdiutil attach -quiet -noautoopen -mountpoint "$volume" "$work/rw.dmg"
attached=1

# The bounds are the background's size, and Finder stores them as given (WindowBounds 640 x 400).
# Whether Finder reads them as the frame or the content is not known: on macOS 27.0.1 the open
# window keeps the last Finder window's frame (System Events reports it unchanged), so it could
# not be measured.
osascript - "$width" "$height" "$icon" "$app_x" "$app_y" "$link_x" "$link_y" << 'EOF'
on run argv
  set {w, h, iconSize, appX, appY, linkX, linkY} to argv
  tell application "Finder"
    tell disk "Vimma"
      open
      -- the window ignores a size set before it has opened
      delay 1
      set current view of container window to icon view
      set toolbar visible of container window to false
      set statusbar visible of container window to false
      set the bounds of container window to {200, 120, 200 + w, 120 + h}
      set options to the icon view options of container window
      set arrangement of options to not arranged
      set icon size of options to iconSize
      set text size of options to 12
      set shows item info of options to false
      set shows icon preview of options to true
      set background picture of options to file ".background:background.png"
      set position of item "Vimma.app" of container window to {appX, appY}
      set position of item " " of container window to {linkX, linkY}
      close
      open
      update without registering applications
      delay 2
      close
    end tell
  end tell
end run
EOF

# Finder writes .DS_Store when the window closes, not always at once.
for _ in $(seq 1 30); do
  [ -s "$volume/.DS_Store" ] && break
  sleep 1
done
[ -s "$volume/.DS_Store" ] || { echo "macos-dsstore.sh: Finder wrote no .DS_Store" >&2; exit 1; }
sleep 2
cp "$volume/.DS_Store" "$out"
echo "wrote $out"
