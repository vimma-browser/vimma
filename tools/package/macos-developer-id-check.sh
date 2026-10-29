#!/usr/bin/env bash
# Checks, on a Mac, a Vimma.app from a Developer ID release (spec macos-build, decision 23): a
# strict deep verify; a Developer ID Application signature with a secure timestamp and the hardened
# runtime, on the app and on its nested code, all of Vimma's team (EXPECTED_TEAM_ID, from the
# repository variable MACOS_TEAM_ID); Gatekeeper accepting it as notarised; and a stapled ticket. release.yml's macos-smoke runs it when MACOS_SIGNING is developer-id; an ad
# hoc build fails it. Prints the team ID, which every copy of the signature carries anyway.
#
#   tools/package/macos-developer-id-check.sh path/to/Vimma.app
# CODESIGN, SPCTL and XCRUN replace the system tools in tests.
set -euo pipefail
app="${1:?usage: macos-developer-id-check.sh path/to/Vimma.app}"
codesign="${CODESIGN:-codesign}"
spctl="${SPCTL:-spctl}"
xcrun="${XCRUN:-xcrun}"

fail() {
  echo "::error::$*" >&2
  exit 1
}

expected_team=${EXPECTED_TEAM_ID:-}
[[ $expected_team =~ ^[A-Z0-9]{10}$ ]] ||
  fail "EXPECTED_TEAM_ID (the repository variable MACOS_TEAM_ID) is not a ten-character team ID"

"$codesign" --verify --deep --strict --verbose=2 "$app" ||
  fail "codesign --verify --deep --strict fails"

# The signature's team, from `codesign -dvv` (which prints to stderr), after checking it is a
# Developer ID Application signature with a secure timestamp and the runtime flag.
signed_team() {
  local path=$1 info team
  info=$("$codesign" -dvv "$path" 2>&1)
  team=$(sed -n 's/^TeamIdentifier=//p' <<< "$info")
  [[ $team =~ ^[A-Z0-9]{10}$ ]] || fail "$path has no team: it is not signed with a Developer ID"
  grep -qx "Authority=Developer ID Application: .* ($team)" <<< "$info" ||
    fail "$path is not signed by a Developer ID Application certificate of team $team"
  grep -qx "Authority=Developer ID Certification Authority" <<< "$info" ||
    fail "$path is not signed under Apple's Developer ID Certification Authority"
  grep -q '^CodeDirectory .* flags=0x[0-9a-f]*([^)]*runtime' <<< "$info" ||
    fail "$path does not run under the hardened runtime"
  grep -q '^Timestamp=' <<< "$info" || fail "$path has no secure timestamp"
  echo "$team"
}

team=$(signed_team "$app")
# Gatekeeper accepts any team's notarised app; only Vimma's team's is Vimma.
[ "$team" = "$expected_team" ] || fail "the app is signed by team $team, not EXPECTED_TEAM_ID"
for nested in \
  Contents/MacOS/vimma-ctl \
  Contents/MacOS/plugin-container.app \
  Contents/MacOS/media-plugin-helper.app \
  Contents/MacOS/XUL; do
  [ -e "$app/$nested" ] || continue
  nested_team=$(signed_team "$app/$nested")
  [ "$nested_team" = "$team" ] || fail "$nested is signed by team $nested_team, the app by $team"
done

assessment=$("$spctl" --assess --type execute -vv "$app" 2>&1) ||
  fail "Gatekeeper rejects the app: $assessment"
grep -qx "source=Notarized Developer ID" <<< "$assessment" ||
  fail "Gatekeeper accepts the app, but not as Notarized Developer ID: $assessment"

"$xcrun" stapler validate "$app" || fail "the app has no valid stapled notarisation ticket"

echo "Developer ID of team $team, hardened runtime, notarised and stapled; Gatekeeper accepts it"
