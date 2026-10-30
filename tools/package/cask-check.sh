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
#       signature, its bundle identifier and the `vimma` and `vimma-ctl` links; then uninstalls
#       with --zap and
#       checks the zap paths are gone and ~/.config/vimma is not. release.yml's macos-smoke job
#       runs this on the release's dmg before anything is signed. GitHub Actions only: --zap
#       deletes ~/Library/Application Support/Vimma, which on a developer's Mac is their profile.
#   tools/package/cask-check.sh --stub
#       renders a cask for a stub app (shell scripts for `vimma` and `vimma-ctl`) in a dmg made
#       here, then runs
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

# Homebrew 6.0 and later refuse to load a cask from a third-party tap that is not trusted, and
# brew audit loads it. Only the one cask in the throwaway tap is trusted; tap trust stays on for
# everything else. The trust is kept in Homebrew's trust.json, apart from the tap, so untapping
# leaves it: the cleanup removes it with `brew untrust`. An older Homebrew has no `brew trust`
# and no such check.
# The whole list is read before it is searched: a `grep -q` would stop reading at `trust`, and
# brew, killed by SIGPIPE writing the rest, would make the pipeline fail under pipefail.
has_trust() {
  local commands
  commands=$(brew commands --quiet 2> /dev/null) || return 1
  grep -qx trust <<< "$commands"
}

work=$(mktemp -d)
cleanup() {
  if has_trust; then
    brew untrust --cask "$TAP/vimma" > /dev/null 2>&1 || true
  fi
  brew untap --force "$TAP" > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

id=$(node -p 'require(process.argv[1]).appId' "$repo/surfer.json")

if [ "${1:-}" = "--stub" ]; then
  app="$work/stage/Vimma.app"
  mkdir -p "$app/Contents/MacOS"
  printf '#!/bin/sh\necho stub\n' > "$app/Contents/MacOS/vimma"
  printf '#!/bin/sh\necho stub\n' > "$app/Contents/MacOS/vimma-ctl"
  chmod 755 "$app/Contents/MacOS/vimma" "$app/Contents/MacOS/vimma-ctl"
  plist="$app/Contents/Info.plist"
  plutil -create xml1 "$plist"
  plutil -insert CFBundleExecutable -string vimma "$plist"
  plutil -insert CFBundleIdentifier -string "$id" "$plist"
  plutil -insert CFBundleName -string Vimma "$plist"
  plutil -insert CFBundlePackageType -string APPL "$plist"
  # Nested code first: a strict verify refuses an app whose vimma-ctl is unsigned.
  codesign --sign - --force "$app/Contents/MacOS/vimma-ctl"
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
if has_trust; then
  brew trust --cask "$TAP/vimma"
fi

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
[ "$(readlink "$(brew --prefix)/bin/vimma-ctl")" = "$APP/Contents/MacOS/vimma-ctl" ] \
  || die "$(brew --prefix)/bin/vimma-ctl does not link to $APP/Contents/MacOS/vimma-ctl"

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
[ ! -e "$(brew --prefix)/bin/vimma-ctl" ] || die "brew uninstall left $(brew --prefix)/bin/vimma-ctl"
for path in "${zapped[@]}"; do
  [ ! -e "$path" ] || die "--zap left $path"
done
test -f "$HOME/.config/vimma/cask-check" || die "--zap removed ~/.config/vimma"
rm "$HOME/.config/vimma/cask-check"
echo "cask-check: the cask installs $APP, links vimma and vimma-ctl, and uninstalls with --zap"
