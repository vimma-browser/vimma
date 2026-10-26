#!/usr/bin/env bash
# Signs Vimma.app with Vimma's Developer ID, notarises it and staples the ticket (spec macos-build,
# decisions 23 to 25). It runs in release.yml's macos-notarise job, the only job with the Apple
# secrets, and runs rcodesign (pinned by fetch-rcodesign.sh) and standard system tools only:
# nothing the build handed over. The app came from macos-unpack as data, so every symlink in it
# must stay inside it before rcodesign reads a credential.
#
# Signing follows mach macos-sign with rcodesign (tools/signing/macos/mach_commands.py,
# sign_with_rcodesign) and the release channel's production settings (taskcluster/config.yml,
# mac-signing.hardened-sign-config, Firefox 158.0): one `rcodesign sign` of the app, which signs
# nested code inside-out, with the hardened runtime on each helper and binary, the helpers' own
# entitlements and Vimma's browser.xml on the app (configs/macos/entitlements). --for-notarization
# makes rcodesign refuse anything but a Developer ID certificate with a secure timestamp, and sets
# the runtime flag on every Mach-O the list below does not name.
#
# Usage: tools/package/macos-sign-app.sh <Vimma.app>
#   APPLE_P12_FILE             the Developer ID Application certificate and key (PKCS #12)
#   APPLE_P12_PASSWORD_FILE    a file holding its password
#   APPLE_NOTARY_API_KEY_FILE  the App Store Connect API key, as
#                              `rcodesign encode-app-store-connect-api-key` writes it
#   APPLE_TEAM_ID              the team the certificate must belong to
#   RCODESIGN                  rcodesign to run (default: rcodesign on PATH)
# Secrets are read from files, never passed on a command line.
set -euo pipefail

app=${1:?usage: macos-sign-app.sh <Vimma.app>}
rcodesign=${RCODESIGN:-rcodesign}
entitlements=$(cd "$(dirname "$0")/../../configs/macos/entitlements" && pwd)

fail() {
  echo "macos-sign-app.sh: $*" >&2
  exit 1
}

for name in APPLE_P12_FILE APPLE_P12_PASSWORD_FILE APPLE_NOTARY_API_KEY_FILE APPLE_TEAM_ID; do
  [ -n "${!name:-}" ] || fail "$name is not set"
done
for name in APPLE_P12_FILE APPLE_P12_PASSWORD_FILE APPLE_NOTARY_API_KEY_FILE; do
  [ -f "${!name}" ] || fail "$name does not name a file"
done
[[ $APPLE_TEAM_ID =~ ^[A-Z0-9]{10}$ ]] || fail "APPLE_TEAM_ID is not a ten-character Apple team ID"
[ -d "$app/Contents" ] || fail "$app is not an app bundle"
app=$(cd "$app" && pwd)
# A stapled ticket means this app was signed already: a re-run starts from macos-build's dmg.
[ ! -e "$app/Contents/CodeResources" ] || fail "$app is already notarised and stapled"

# True when the symlink at app-relative path $1 points outside the app: an absolute target, or a
# relative one whose `..` climb above the app's root. Each link is checked, so a chain of links
# that each stay inside cannot leave it.
escapes() {
  local rel=$1 target depth=0 part
  target=$(readlink "$app/$rel")
  case $target in /*) return 0 ;; esac
  local -a parts
  IFS=/ read -r -a parts <<< "$(dirname "$rel")/$target"
  for part in "${parts[@]}"; do
    case $part in
      "" | .) ;;
      ..)
        depth=$((depth - 1))
        [ "$depth" -ge 0 ] || return 0
        ;;
      *) depth=$((depth + 1)) ;;
    esac
  done
  return 1
}
while IFS= read -r -d '' link; do
  link=${link#./}
  if escapes "$link"; then fail "symlink $link points outside the app"; fi
done < <(cd "$app" && find . -type l -print0)

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
shopt -s nullglob
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
cd /
args+=(--code-signature-flags runtime --entitlements-xml-file "$entitlements/browser.xml")

"$rcodesign" sign "${args[@]}" "$app"

# rcodesign zips the bundle, uploads it, waits for Apple's verdict and staples the ticket into
# Contents/CodeResources. The app is notarised rather than the dmg, as Mozilla does
# (taskcluster/kinds/build-mac-notarization), so the installed app carries its own ticket.
"$rcodesign" notary-submit --api-key-file "$APPLE_NOTARY_API_KEY_FILE" \
  --max-wait-seconds 3600 --wait --staple "$app"
[ -f "$app/Contents/CodeResources" ] || fail "no notarisation ticket was stapled to the app"
