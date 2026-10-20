#!/bin/sh
# Downloads rcodesign (apple-codesign, MPL-2.0), pinned by release and SHA-256, for the ad hoc
# signature of the macOS build (spec macos-build, decision 10). A build tool: nothing of it ships
# in the .dmg. Renovate does not track it: bump the release and checksum together, from the
# release page's asset digests
# (gh release view apple-codesign/<version> -R indygreg/apple-platform-rs --json assets).
# Usage: tools/package/fetch-rcodesign.sh <dir>   -> <dir>/rcodesign (Linux x86_64)
set -eu

RCODESIGN_RELEASE=0.29.0
RCODESIGN_SHA256=dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002

dir=${1:?usage: fetch-rcodesign.sh <dir>}
mkdir -p "$dir"
name="apple-codesign-${RCODESIGN_RELEASE}-x86_64-unknown-linux-musl"
url="https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F${RCODESIGN_RELEASE}/${name}.tar.gz"

curl --fail --silent --show-error --location --retry 3 --output "$dir/$name.tar.gz.part" "$url"
echo "$RCODESIGN_SHA256  $dir/$name.tar.gz.part" | sha256sum --check --quiet
tar -xzf "$dir/$name.tar.gz.part" -C "$dir" "$name/rcodesign"
mv "$dir/$name/rcodesign" "$dir/rcodesign"
rmdir "$dir/$name"
rm "$dir/$name.tar.gz.part"
chmod 755 "$dir/rcodesign"
"$dir/rcodesign" --version
