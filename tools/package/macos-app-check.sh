#!/usr/bin/env bash
# Checks a built Vimma.app shows Vimma's icon and carries Vimma's bundle identifier (spec
# macos-homebrew, decision 13 and open question 4). macOS draws the AppIcon from Assets.car; a
# build that kept Firefox's unofficial catalog would show its globe. Run from the repository root
# on macOS; ASSETUTIL and PLISTBUDDY replace the system tools in tests.
#
#   tools/package/macos-app-check.sh path/to/Vimma.app
set -euo pipefail
app="${1:?usage: macos-app-check.sh path/to/Vimma.app}"
assetutil="${ASSETUTIL:-assetutil}"
plistbuddy="${PLISTBUDDY:-/usr/libexec/PlistBuddy}"

names=$("$assetutil" --info "$app/Contents/Resources/Assets.car" |
  node -e 'const a = JSON.parse(require("fs").readFileSync(0, "utf8")).slice(1);
    console.log(a.map((x) => x.Name ?? "").join("\n"))')
if grep -q unofficial <<< "$names"; then
  echo "::error::Assets.car carries Firefox's unofficial icon: $(grep unofficial <<< "$names" | tr '\n' ' ')"
  exit 1
fi
grep -qx AppIcon <<< "$names" || { echo "::error::Assets.car has no AppIcon"; exit 1; }

id=$("$plistbuddy" -c "Print :CFBundleIdentifier" "$app/Contents/Info.plist")
expected=$(node -p 'require("./surfer.json").appId')
[ "$id" = "$expected" ] || { echo "::error::CFBundleIdentifier is $id, want $expected"; exit 1; }
echo "Assets.car has Vimma's AppIcon; CFBundleIdentifier is $id"
