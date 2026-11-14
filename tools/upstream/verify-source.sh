#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Checks the Firefox source tarball a local `npx surfer download` left in .surfer/engine/ against
# Mozilla's signed SHA512SUMS (verify-sha512.py, ADR-021,
# docs/security/14-build-and-release-supply-chain.md B1), and records the verified version and hash
# in engine/.git/vimma-source-verified. Surfer checks no
# hash or signature, and a contributor's engine/ keeps Surfer's git history, which lanes and
# restore-patched rely on, so local setup keeps `surfer download` and verifies afterwards; CI and
# the builds use firefox-source.sh, which verifies before extracting.
#
#   npm run verify-source      from the repository root, after `npx surfer download`
#   verify-source.sh --require  the first step of `npm run import`: refuses an engine/ that was
#                               not verified for surfer.json's version; offline, reads no tarball
#
# The record lives in engine/.git so that it goes when `surfer download --force` deletes
# engine/, survives the `git clean` a lane runs on its copy (tools/lanes/lanes.ts), and is
# copied with engine/ into a lane. firefox-source.sh writes the same record for CI and builds.
# It is a guard against building a download nobody verified, not against someone who can write
# to engine/: they could change the source itself.
#
# Exit status: 0 signed and matching (--require: engine/ verified); 1 SHA512SUMS is not signed by
# Mozilla's release key, or the tarball's SHA-512 does not match it (--require: engine/ missing or
# not verified for this version); 2 no tarball, a bad version, or the check could not run.
# MOZILLA_RELEASES overrides the archive's releases/ URL (tests use a file:// directory).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
[ -f surfer.json ] || {
  echo "verify-source: run from the repository root (no surfer.json here)" >&2
  exit 2
}
version=$(node -p 'require("./surfer.json").version.version')
# The version reaches a URL and file names: only digits, dots and a Beta's bN.
if ! [[ $version =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ || $version =~ ^[0-9]+\.0b[0-9]+$ ]]; then
  echo "verify-source: surfer.json's version is not a Firefox release or Beta: '$version'" >&2
  exit 2
fi
record=engine/.git/vimma-source-verified
if [ "${1:-}" = --require ]; then
  [ -d engine/.git ] || {
    echo "verify-source: no engine/; run \`npx surfer download && npm run verify-source\` first" >&2
    exit 1
  }
  verified=$(cut -d' ' -f1 "$record" 2>/dev/null || true)
  [ "$verified" = "$version" ] || {
    echo "verify-source: engine/ is not verified for Firefox $version" \
      "(${verified:-never verified}); run \`npm run verify-source\`" >&2
    exit 1
  }
  exit 0
fi
base="${MOZILLA_RELEASES:-https://archive.mozilla.org/pub/firefox/releases}/$version"
name="source/firefox-$version.source.tar.xz"
tarball=".surfer/engine/firefox-$version.source.tar.xz"
[ -f "$tarball" ] || {
  echo "verify-source: no $tarball; run \`npx surfer download\` first" >&2
  exit 2
}

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
curl -fsSL --retry 3 "$base/SHA512SUMS" -o "$scratch/SHA512SUMS" || exit 2
curl -fsSL --retry 3 "$base/SHA512SUMS.asc" -o "$scratch/SHA512SUMS.asc" || exit 2
sha512sum "$tarball" > "$scratch/tarball.sha512"
python3 "$here/verify-sha512.py" --sums "$scratch/SHA512SUMS" \
  --signature "$scratch/SHA512SUMS.asc" --name "$name" --actual "$scratch/tarball.sha512"
if [ -d engine/.git ]; then
  echo "$version $(cut -d' ' -f1 "$scratch/tarball.sha512")" > "$record"
  echo "verify-source: recorded in $record"
else
  echo "verify-source: no engine/ yet; run this again after \`npx surfer download\`" >&2
fi
