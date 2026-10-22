#!/bin/bash
# Builds Vimma's Flatpak with flatpak-builder from a release tarball, installs it and runs it
# (spec flatpak), in a Fedora container, as Flathub's builder would build the manifest.
#
#   tools/package/flatpak-smoke.sh --stub
#       packages a stub tarball (a shell script for `vimma`); flatpak.yml runs this on pull
#       requests that change the packaging, so a broken manifest fails before a release.
#   tools/package/flatpak-smoke.sh --release <tag> <tarball sha256> <expected version line>
#       builds from the published release's download URL, pinned to the SHA-256 that
#       flatpak.yml checked against the release's SHA256SUMS; also starts Vimma headless and
#       takes a screenshot, so the runtime has every library Vimma needs.
#
# Needs docker and node on the host; the container runs privileged, since flatpak-builder and
# `flatpak run` sandbox with bubblewrap. Checks: the build and install succeed; `flatpak run
# dev.vimma.browser --version` prints the expected line on stdout (stderr carries Firefox's
# sandbox diagnostics); /app/lib/vimma/is-packaged-app says vimma-package=flatpak; the exported
# desktop file passes desktop-file-validate and the metainfo appstreamcli validate.
set -euo pipefail

# fedora:44 as published on 2026-10-19. The run installs current Fedora packages, so the digest
# fixes only the base image.
IMAGE=fedora@sha256:43b29f65a41eb9c35e1cd5323e3bdf3b655c2357a9f4f1ff2f9c2798e5045d80
RUNTIME=25.08
# Flathub's org.freedesktop.Platform and org.freedesktop.Sdk 25.08 builds of 2026-10-13
# (flatpak remote-info flathub runtime/org.freedesktop.Platform/x86_64/25.08).
PLATFORM_COMMIT=b7aba340fd291e08bf26442d43a0e4adb6733da5a06d47ff4296a964af40cc8a
SDK_COMMIT=18fa1be304b09e42dd3606f6d933e2d6a27513dd3aeee1203b2b58d59ad3db71
APP=dev.vimma.browser
here=$(cd "$(dirname "$0")" && pwd)

if [ "${1:-}" = "--inside" ]; then
  # Installs flatpak and runtimes system-wide: only in the container this script starts.
  [ "${VIMMA_FLATPAK_CONTAINER:-}" = 1 ] || { echo "flatpak-smoke: --inside runs only in its container"; exit 2; }
  expected=$2
  real=$3
  dnf -q install -y flatpak flatpak-builder desktop-file-utils appstream > /dev/null
  rpm -q flatpak flatpak-builder
  flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
  # --no-related: no GL, codec or locale extensions, which are not pinned and not needed here.
  flatpak install -y --noninteractive --no-related flathub \
    "org.freedesktop.Platform//$RUNTIME" "org.freedesktop.Sdk//$RUNTIME" > /dev/null
  flatpak update -y --noninteractive --commit="$PLATFORM_COMMIT" "org.freedesktop.Platform//$RUNTIME" > /dev/null
  flatpak update -y --noninteractive --commit="$SDK_COMMIT" "org.freedesktop.Sdk//$RUNTIME" > /dev/null
  pinned() {
    local got
    got=$(flatpak info --show-commit "$1")
    [ "$got" = "$2" ] || { echo "flatpak-smoke: $1 is at $got, want $2"; exit 1; }
  }
  pinned "org.freedesktop.Platform//$RUNTIME" "$PLATFORM_COMMIT"
  pinned "org.freedesktop.Sdk//$RUNTIME" "$SDK_COMMIT"

  # rofiles-fuse needs /dev/fuse, which the container lacks; it only guards against hard-link
  # edits of the cache, which a one-shot build has no use for.
  flatpak-builder --install --force-clean --disable-rofiles-fuse --state-dir=/tmp/state \
    /tmp/build "/manifest/$APP.json"

  version=$(flatpak run dev.vimma.browser --version 2> /dev/null)
  [ "$version" = "$expected" ] || { echo "flatpak-smoke: --version is '$version', want '$expected'"; exit 1; }
  marker=$(flatpak run --command=cat "$APP" /app/lib/vimma/is-packaged-app)
  [ "$marker" = "vimma-package=flatpak" ] || { echo "flatpak-smoke: is-packaged-app says '$marker'"; exit 1; }
  exports=/var/lib/flatpak/exports/share
  desktop-file-validate "$exports/applications/$APP.desktop"
  grep -qx "Exec=/usr/bin/flatpak run --branch=master --arch=x86_64 --command=vimma --file-forwarding $APP @@u %u @@" \
    "$exports/applications/$APP.desktop" \
    || { echo "flatpak-smoke: the exported desktop file does not run vimma through flatpak"; exit 1; }
  test -f "$exports/icons/hicolor/512x512/apps/$APP.png"
  test -f "$exports/icons/hicolor/128x128/apps/$APP.png"
  appstreamcli validate --no-net "/var/lib/flatpak/app/$APP/current/active/files/share/metainfo/$APP.metainfo.xml"
  if [ "$real" = 1 ]; then
    # As the .deb smoke in release.yml: the first run creates the profile, since --screenshot on
    # a fresh profile races the bookmarks import (docs/runbook.md, Smoke check). Killing
    # `flatpak run` leaves the sandboxed Vimma running, so it is stopped with flatpak kill.
    data=/root/.var/app/$APP
    mkdir -p "$data/p"
    timeout 30 flatpak run "$APP" --headless --no-remote --profile "$data/p" about:blank || true
    flatpak kill "$APP" 2> /dev/null || true
    timeout 60 flatpak run "$APP" --headless --no-remote --profile "$data/p" \
      --screenshot "$data/shot.png" "data:text/html,<h1>ok</h1>"
    test -s "$data/shot.png"
  fi
  echo "flatpak-smoke: OK: $version, $marker"
  exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
today=$(date -u +%F)
case "${1:-}" in
  --stub)
    version=$(node -p 'require(process.argv[1]).brands.vimma.release.displayVersion' "$here/../../surfer.json")
    expected=$(node "$here/../release/version-line.mjs")
    app="$work/stub/vimma"
    mkdir -p "$app/browser/chrome/icons/default"
    printf '#!/bin/sh\necho "%s"\n' "$expected" > "$app/vimma"
    chmod 755 "$app/vimma"
    printf '[App]\nVendor=Vimma\nName=Vimma\nRemotingName=vimma-vimma\n' > "$app/application.ini"
    for size in 16 32 48 64 128; do
      cp "$here/../../configs/branding/vimma/logo$size.png" "$app/browser/chrome/icons/default/default$size.png"
    done
    tar -cJf "$work/stub.tar.xz" -C "$work/stub" vimma
    node "$here/flatpak.mjs" --out "$work/manifest" --version "$version" --date "$today" \
      --tarball "$work/stub.tar.xz" > /dev/null
    real=0
    ;;
  --release)
    tag=${2:?usage: flatpak-smoke.sh --release <tag> <sha256> <version line>}
    sha=${3:?usage: flatpak-smoke.sh --release <tag> <sha256> <version line>}
    expected=${4:?usage: flatpak-smoke.sh --release <tag> <sha256> <version line>}
    echo "$tag" | grep -Eqx 'v[0-9]+\.[0-9]+\.[0-9]+' || { echo "flatpak-smoke: '$tag' is not vX.Y.Z"; exit 2; }
    node "$here/flatpak.mjs" --out "$work/manifest" --version "${tag#v}" --date "$today" \
      --sha256 "$sha" > /dev/null
    real=1
    ;;
  *)
    echo "usage: flatpak-smoke.sh --stub | --release <tag> <sha256> <version line>"
    exit 2
    ;;
esac

docker run --rm --privileged -e VIMMA_FLATPAK_CONTAINER=1 \
  -v "$work/manifest:/manifest:ro" -v "$here/flatpak-smoke.sh:/flatpak-smoke.sh:ro" "$IMAGE" \
  bash /flatpak-smoke.sh --inside "$expected" "$real"
