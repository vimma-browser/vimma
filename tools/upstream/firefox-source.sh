#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Materialises a verified engine/ for a build: the only way nightly.yml, release.yml, e2e.yml and
# sites.yml get Firefox source (spec build-supply-chain, decisions 3 to 5, rules B1 and B2).
#
#   tools/upstream/firefox-source.sh      run from the repository root
#
# It deletes engine/, objdir and all, without asking. It is for CI's fresh runners; on a
# developer's machine use `npx surfer download` (docs/runbook/first-firefox-build.md, "First Firefox
# build").
#
# Reads the Firefox version from surfer.json, downloads the source tarball to the path Surfer
# reads (.surfer/engine/) when it is not there, and checks it against Mozilla's SHA512SUMS, whose
# signature must be good by Mozilla's pinned release key (verify-sha512.py, ADR-021), whether the
# tarball was downloaded now or found on disk. Only then does it delete engine/ and let Surfer
# extract the verified file (CI_SKIP_INIT=1: no 4.7 GB git commit), and `git init` an empty
# repository so `surfer import` applies patches inside engine/. Nothing is trusted by label: no
# engine/ is ever reused.
#
# Exit status (engine/ is untouched unless it is 0):
#   0  engine/ extracted from a verified tarball
#   1  SHA512SUMS is not signed by Mozilla's release key, or the tarball's SHA-512 differs from
#      it (the tarball is deleted)
#   2  usage; a version that is not a release or Beta; a version.candidate in surfer.json; a
#      SHA512SUMS that does not list the tarball; or a check that could not run, such as no gpgv
#      (the tarball is kept)
#   other  a download or extraction failure
# MOZILLA_RELEASES overrides the archive's releases/ URL (tests use a file:// directory).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
[ -f surfer.json ] || {
  echo "firefox-source: run from the repository root (no surfer.json here)" >&2
  exit 2
}
version=$(node -p 'require("./surfer.json").version.version')
# With a candidate, Surfer extracts firefox-<candidate> from candidates/, downloaded with no hash
# check, instead of the file verified here: never build from it.
candidate=$(node -p 'require("./surfer.json").version.candidate ?? ""')
if [ -n "$candidate" ]; then
  echo "firefox-source: surfer.json has version.candidate '$candidate'; Surfer would fetch an" \
    "unverified candidate tarball. Remove it to build the verified release." >&2
  exit 2
fi
# The version reaches a URL and file names: only digits, dots and a Beta's bN.
if ! [[ $version =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ || $version =~ ^[0-9]+\.0b[0-9]+$ ]]; then
  echo "firefox-source: surfer.json's version is not a Firefox release or Beta: '$version'" >&2
  exit 2
fi
base="${MOZILLA_RELEASES:-https://archive.mozilla.org/pub/firefox/releases}/$version"
name="source/firefox-$version.source.tar.xz"
tarball=".surfer/engine/firefox-$version.source.tar.xz"

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

if [ ! -f "$tarball" ]; then
  mkdir -p "$(dirname "$tarball")"
  # Into a temporary name first, so an interrupted download never looks like a cached tarball.
  curl -fsSL --retry 3 "$base/$name" -o "$tarball.part"
  mv "$tarball.part" "$tarball"
fi

curl -fsSL --retry 3 "$base/SHA512SUMS" -o "$scratch/SHA512SUMS"
curl -fsSL --retry 3 "$base/SHA512SUMS.asc" -o "$scratch/SHA512SUMS.asc"
sha512sum "$tarball" > "$scratch/tarball.sha512"
status=0
python3 "$here/verify-sha512.py" --sums "$scratch/SHA512SUMS" \
  --signature "$scratch/SHA512SUMS.asc" --name "$name" --actual "$scratch/tarball.sha512" ||
  status=$?
case "$status" in
  0) ;;
  1)
    echo "::error::SHA-512 of $tarball does not match a SHA512SUMS signed by Mozilla's release key ($base); engine/ left untouched"
    # Never kept: a later run downloads afresh instead of failing on the same file forever.
    rm -f "$tarball"
    exit 1
    ;;
  *)
    echo "::error::$base/SHA512SUMS does not list $name, or could not be checked; engine/ left untouched"
    exit 2
    ;;
esac

rm -rf engine
CI_SKIP_INIT=1 npx --no -- surfer download
git init -q engine
# What `npm run import` checks before building (verify-source.sh --require): this engine/ was
# extracted from a tarball verified for this version.
echo "$version $(cut -d' ' -f1 "$scratch/tarball.sha512")" > engine/.git/vimma-source-verified
echo "firefox-source: engine/ extracted from the verified $name"
