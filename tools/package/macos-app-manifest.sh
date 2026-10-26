#!/usr/bin/env bash
# Prints a manifest of Vimma.app: one line per entry, `<type> <x|-> <sha256|-> <path>`, sorted
# bytewise by path, where type is f (file) or d (directory), x marks an entry the running user,
# who owns the extracted files, may execute, and the hash is the file's SHA-256 (spec
# macos-build, decision 23). macos-build writes it for the app mach built and macos-dmg.sh signed
# ad hoc; macos-notarise recomputes it from the app macos-unpack hands over and refuses a
# difference before any credential exists, so the disk-image tools cannot change the app unseen.
# Both lists come from the same release run: this guards against the unpack tools, not against a
# compromised build.
#
# Vimma.app has no symbolic link (an installed Vimma.app on Firefox 158.0.1 has none), so a link,
# the app being a link, or a name with a newline is refused rather than listed. It uses bash,
# find, sort and sha256sum only, so it can run where the signing secrets are.
#
#   tools/package/macos-app-manifest.sh path/to/Vimma.app > vimma-app.manifest
set -euo pipefail
app=${1:?usage: macos-app-manifest.sh path/to/Vimma.app}

fail() {
  echo "macos-app-manifest.sh: $*" >&2
  exit 1
}

[ ! -L "$app" ] || fail "$app is a symlink"
[ -d "$app" ] || fail "$app is not a directory"
links=$(find "$app" -type l -print -quit)
[ -z "$links" ] || fail "a symlink is in the app: $links"
other=$(find "$app" ! -type f ! -type d -print -quit)
[ -z "$other" ] || fail "an entry that is neither a file nor a directory is in the app: $other"

cd "$app"
while IFS= read -r -d '' path; do
  path=${path#./}
  case $path in *$'\n'*) fail "a name with a newline is in the app" ;; esac
  if [ -x "$path" ]; then x=x; else x=-; fi
  if [ -d "$path" ]; then
    echo "d $x - $path"
  else
    sum=$(sha256sum < "$path")
    echo "f $x ${sum%% *} $path"
  fi
done < <(find . -mindepth 1 -print0) | LC_ALL=C sort -t " " -k 4
