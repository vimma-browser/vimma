#!/usr/bin/env bash
# Signs the Vimma.app in an ad hoc signed .dmg from macos-dmg.sh with Vimma's Developer ID,
# notarises and staples it, and packs a new .dmg (spec macos-build, decisions 23 to 26). It runs in
# release.yml's macos-notarise job, on Linux, with no engine/ and no mach: the disk images are
# read and written by the Mozilla tools that macos-build's mach bootstrapped, called as
# python/mozbuild/mozpack/dmg.py does on Linux (extract_dmg_contents and create_dmg, Firefox
# 158.0).
#
# Signing follows mach macos-sign with rcodesign (tools/signing/macos/mach_commands.py,
# sign_with_rcodesign) and the release channel's production settings
# (taskcluster/config.yml, mac-signing.hardened-sign-config): one `rcodesign sign` of the app,
# which signs nested code inside-out, with the hardened runtime on each helper and binary, the
# helpers' own entitlements and Vimma's browser.xml on the app (configs/macos/entitlements).
# --for-notarization makes rcodesign refuse anything but a Developer ID certificate with a secure
# timestamp, and sets the runtime flag on every Mach-O the list below does not name.
#
# Usage: tools/package/macos-developer-id.sh <in.dmg> <out.dmg>
#   DMG_TOOLS                  a directory with Mozilla's dmg, hfsplus and newfs_hfs
#   APPLE_P12_FILE             the Developer ID Application certificate and key (PKCS #12)
#   APPLE_P12_PASSWORD_FILE    a file holding its password
#   APPLE_NOTARY_API_KEY_FILE  the App Store Connect API key, as
#                              `rcodesign encode-app-store-connect-api-key` writes it
#   APPLE_TEAM_ID              the team the certificate must belong to
#   RCODESIGN                  rcodesign to run (default: rcodesign on PATH)
# Secrets are read from files, never passed on a command line.
set -euo pipefail

in=${1:?usage: macos-developer-id.sh <in.dmg> <out.dmg>}
out=${2:?usage: macos-developer-id.sh <in.dmg> <out.dmg>}
rcodesign=${RCODESIGN:-rcodesign}
entitlements=$(cd "$(dirname "$0")/../../configs/macos/entitlements" && pwd)

fail() {
  echo "macos-developer-id.sh: $*" >&2
  exit 1
}

for name in DMG_TOOLS APPLE_P12_FILE APPLE_P12_PASSWORD_FILE APPLE_NOTARY_API_KEY_FILE APPLE_TEAM_ID; do
  [ -n "${!name:-}" ] || fail "$name is not set"
done
for name in APPLE_P12_FILE APPLE_P12_PASSWORD_FILE APPLE_NOTARY_API_KEY_FILE; do
  [ -f "${!name}" ] || fail "$name does not name a file"
done
[[ $APPLE_TEAM_ID =~ ^[A-Z0-9]{10}$ ]] || fail "APPLE_TEAM_ID is not a ten-character Apple team ID"
dmg_tool=$DMG_TOOLS/dmg
hfs_tool=$DMG_TOOLS/hfsplus
mkfshfs_tool=$DMG_TOOLS/newfs_hfs
for tool in "$dmg_tool" "$hfs_tool" "$mkfshfs_tool"; do
  [ -x "$tool" ] || fail "DMG_TOOLS has no executable $(basename "$tool")"
done

absolute() { case "$1" in /*) echo "$1" ;; *) echo "$PWD/$1" ;; esac; }
in=$(absolute "$in")
out=$(absolute "$out")

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
volume="$work/volume"
mkdir "$volume"

# Unpack: extract_dmg_contents, then extract_dmg drops the Applications link.
"$dmg_tool" extract "$in" "$work/in.hfs" > /dev/null
"$hfs_tool" "$work/in.hfs" extractall / "$volume"
rm -f "$work/in.hfs"
if [ -L "$volume/ " ]; then rm "$volume/ "; fi

shopt -s nullglob dotglob
apps=("$volume"/*.app)
[ "${#apps[@]}" -eq 1 ] && [ -d "${apps[0]}" ] || fail "$in must hold exactly one .app"
app=${apps[0]}
for art in .DS_Store .background/background.png .VolumeIcon.icns; do
  [ -f "$volume/$art" ] || fail "$in has no $art (macos-dmg.sh keeps the volume's art)"
done
# A stapled ticket means this dmg was signed already: a re-run starts from macos-build's dmg.
[ ! -e "$app/Contents/CodeResources" ] || fail "$in is already notarised and stapled"

# The certificate is a Developer ID Application certificate of Vimma's team.
info=$("$rcodesign" analyze-certificate --p12-file "$APPLE_P12_FILE" \
  --p12-password-file "$APPLE_P12_PASSWORD_FILE")
subject=$(sed -n 's/^Subject CN: *//p' <<< "$info" | head -n 1)
team=$(sed -n 's/^Team ID: *//p' <<< "$info" | head -n 1)
[[ $subject == "Developer ID Application: "* ]] ||
  fail "the certificate is not a Developer ID Application certificate"
[ "$team" = "$APPLE_TEAM_ID" ] || fail "the certificate's team ID is not APPLE_TEAM_ID"

args=(--p12-file "$APPLE_P12_FILE" --p12-password-file "$APPLE_P12_PASSWORD_FILE"
  --for-notarization)
# Each path present, in the order of taskcluster/config.yml's production list; scoped settings
# apply to a nested bundle and everything in it. security-module-helper.app is nightly-only there
# (only-if-milestone-is-nightly), and Vimma builds the release channel.
cd "$app"
for path in Contents/MacOS/plugin-container.app Contents/MacOS/media-plugin-helper.app; do
  [ -e "$path" ] || continue
  args+=(--code-signature-flags "$path:runtime"
    --entitlements-xml-file "$path:$entitlements/$(basename "$path" .app).xml")
done
for path in \
  Contents/MacOS/crashhelper \
  Contents/MacOS/crashreporter.app \
  Contents/MacOS/updater.app/Contents/Frameworks/UpdateSettings.framework \
  Contents/MacOS/updater.app \
  Contents/MacOS/gpu-helper.app \
  Contents/Library/LaunchServices/org.mozilla.updater \
  Contents/Library/LaunchServices/org.mozilla.dmgInstallHelper \
  Contents/MacOS/XUL \
  Contents/MacOS/pingsender \
  Contents/MacOS/nmhproxy \
  Contents/MacOS/*.dylib \
  Contents/Resources/gmp-clearkey/*/*.dylib \
  Contents/Frameworks/ChannelPrefs.framework \
  Contents/MacOS/vimma-ctl; do
  [ -e "$path" ] || continue
  args+=(--code-signature-flags "$path:runtime")
done
cd "$work"
args+=(--code-signature-flags runtime --entitlements-xml-file "$entitlements/browser.xml")

"$rcodesign" sign "${args[@]}" "$app"

# rcodesign zips the bundle, uploads it, waits for Apple's verdict and staples the ticket into
# Contents/CodeResources. The app is notarised rather than the dmg, as Mozilla does
# (taskcluster/kinds/build-mac-notarization), so the installed app carries its own ticket.
"$rcodesign" notary-submit --api-key-file "$APPLE_NOTARY_API_KEY_FILE" \
  --max-wait-seconds 3600 --wait --staple "$app"
[ -f "$app/Contents/CodeResources" ] || fail "no notarisation ticket was stapled to the app"

# Pack: create_dmg on Linux, with the volume's art already in place.
hfs="$work/staged.hfs"
size_kb=$(du -sk "$volume" | cut -f1)
dd if=/dev/zero of="$hfs" bs=1M count=$((size_kb * 102 / 100000)) 2> /dev/null
"$mkfshfs_tool" -v Vimma "$hfs"
"$hfs_tool" "$hfs" symlink "/ " /Applications
"$hfs_tool" "$hfs" attr / C
chmod -R a+rX,a-st,u+w,go-w "$volume"
"$hfs_tool" "$hfs" addall "$volume"
"$dmg_tool" build "$hfs" "$work/out.dmg" > /dev/null
mv "$work/out.dmg" "$out"
