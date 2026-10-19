#!/bin/bash
# Checks the Homebrew cask on a Mac (spec macos-homebrew, decision 9), as a user's Homebrew reads
# it: from a tap. The cask goes into a throwaway local tap, vimma-check/local, which is removed
# again at the end.
#
#   tools/package/cask-check.sh <vimma.rb>
#       brew style and brew audit --cask --strict. The audit stays offline: its online checks,
#       which download the dmg and query GitHub, are not asked for. brew style installs its
#       RuboCop gems from RubyGems on its first run on a machine.
#   tools/package/cask-check.sh <vimma.rb> <dmg>
#       also installs the cask with the dmg placed in Homebrew's download cache, so brew fetches
#       nothing but still checks the dmg against the cask's sha256; checks the installed app's
#       signature, its bundle identifier and the `vimma` link; then uninstalls with --zap and
#       checks the zap paths are gone and ~/.config/vimma is not. release.yml's macos-smoke job
#       runs this on the release's dmg before anything is signed. GitHub Actions only: --zap
#       deletes ~/Library/Application Support/Vimma, which on a developer's Mac is their profile.
#   tools/package/cask-check.sh --stub
#       renders a cask for a stub app (a shell script for `vimma`) in a dmg made here, then runs
#       the install check; pkgbuild.yml runs this on pull requests, so a broken cask fails before
#       a release.
set -euo pipefail

TAP=vimma-check/local
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)

die() {
  echo "cask-check: $*" >&2
  exit 1
}

if [ "${1:-}" = "--stub" ] || [ $# = 2 ]; then
  [ "${GITHUB_ACTIONS:-}" = true ] || {
    echo "cask-check: installing runs on GitHub Actions only: --zap deletes ~/Library/Application Support/Vimma" >&2
    exit 2
  }
fi

work=$(mktemp -d)
cleanup() {
  brew untap --force "$TAP" > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

id=$(node -p 'require(process.argv[1]).appId' "$repo/surfer.json")

if [ "${1:-}" = "--stub" ]; then
  app="$work/stage/Vimma.app"
  mkdir -p "$app/Contents/MacOS"
  printf '#!/bin/sh\necho stub\n' > "$app/Contents/MacOS/vimma"
  chmod 755 "$app/Contents/MacOS/vimma"
  plist="$app/Contents/Info.plist"
  plutil -create xml1 "$plist"
  plutil -insert CFBundleExecutable -string vimma "$plist"
  plutil -insert CFBundleIdentifier -string "$id" "$plist"
  plutil -insert CFBundleName -string Vimma "$plist"
  plutil -insert CFBundlePackageType -string APPL "$plist"
  codesign --sign - --force "$app"
  dmg="$work/vimma-macos-aarch64.dmg"
  hdiutil create -quiet -volname Vimma -srcfolder "$work/stage" -format UDZO "$dmg"
  cask="$work/vimma.rb"
  node "$repo/tools/package/cask.mjs" --dmg "$dmg" --out "$cask"
else
  [ $# = 1 ] || [ $# = 2 ] || die "usage: cask-check.sh <vimma.rb> [<dmg>] | --stub"
  cask=$1
  dmg=${2:-}
fi
[ -f "$cask" ] || die "no cask at $cask"

export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1
brew --version
brew untap --force "$TAP" > /dev/null 2>&1 || true
brew tap-new --no-git "$TAP" > /dev/null
mkdir -p "$(brew --repo "$TAP")/Casks"
cp "$cask" "$(brew --repo "$TAP")/Casks/vimma.rb"

brew style "$TAP/vimma"
brew audit --cask --strict "$TAP/vimma"
[ -n "$dmg" ] || exit 0

APP=/Applications/Vimma.app
[ ! -e "$APP" ] || die "$APP exists already"
cache=$(brew --cache --cask "$TAP/vimma")
mkdir -p "$(dirname "$cache")"
cp "$dmg" "$cache"
brew install --cask "$TAP/vimma"

test -d "$APP" || die "brew installed no $APP"
codesign --verify --deep --strict "$APP"
installed=$(plutil -extract CFBundleIdentifier raw "$APP/Contents/Info.plist")
[ "$installed" = "$id" ] || die "the app's bundle identifier is $installed, the cask quits and zaps $id"
[ "$(readlink "$(brew --prefix)/bin/vimma")" = "$APP/Contents/MacOS/vimma" ] \
  || die "$(brew --prefix)/bin/vimma does not link to $APP/Contents/MacOS/vimma"

zapped=(
  "$HOME/Library/Application Support/Vimma"
  "$HOME/Library/Caches/Vimma"
  "$HOME/Library/Preferences/$id.plist"
  "$HOME/Library/Saved Application State/$id.savedState"
)
mkdir -p "${zapped[0]}" "${zapped[1]}" "${zapped[3]}" "$HOME/.config/vimma"
touch "${zapped[2]}" "$HOME/.config/vimma/cask-check"
brew uninstall --zap --cask "$TAP/vimma"
[ ! -e "$APP" ] || die "brew uninstall left $APP"
[ ! -e "$(brew --prefix)/bin/vimma" ] || die "brew uninstall left $(brew --prefix)/bin/vimma"
for path in "${zapped[@]}"; do
  [ ! -e "$path" ] || die "--zap left $path"
done
test -f "$HOME/.config/vimma/cask-check" || die "--zap removed ~/.config/vimma"
rm "$HOME/.config/vimma/cask-check"
echo "cask-check: the cask installs $APP, links vimma, and uninstalls with --zap"
