#!/bin/bash
# Builds and installs the release PKGBUILD on Arch Linux, as a user would with
#   mkdir -p ~/.cache/vimma-build && cd ~/.cache/vimma-build &&
#   curl -fLO …/releases/latest/download/PKGBUILD && makepkg -si
# (spec m6-packaging, "Arch Linux without the AUR"), against the tarball in a local directory
# served over HTTP instead of the GitHub Release, which does not exist yet when this runs.
#
#   tools/package/arch-smoke.sh <dist-dir> <expected `vimma --version` line>
#       dist-dir holds package.mjs's output: PKGBUILD, SRCINFO and vimma-X.Y.Z-linux-x86_64.tar.xz.
#       release.yml's package job runs this on the release build.
#   tools/package/arch-smoke.sh --stub
#       packages a stub tarball (shell scripts for `vimma` and `vimma-ctl`) first; pkgbuild.yml
#       runs this on pull requests, so a broken PKGBUILD fails before a release.
#
# Needs docker and python3 on the host. Checks: makepkg --printsrcinfo equals SRCINFO; makepkg -si
# downloads the tarball, verifies its SHA-256 and installs; `vimma --version` prints the expected
# line; vimma-ctl on PATH names the same Vimma version; /opt/vimma/is-packaged-app says
# vimma-package=pkgbuild-release; vimma-open is the repository's launcher byte for byte; the
# desktop file passes desktop-file-validate; and, for a real build (not
# --stub), Vimma starts headless and takes a screenshot, so the PKGBUILD's depends are enough.
set -euo pipefail

# archlinux:base-devel as published on 2026-10-12. The run updates the system with pacman first,
# so an older digest still tests against current Arch packages.
IMAGE=archlinux@sha256:061679925e5d5028f2df9395d441ce6c4b9accf0157ff3486c06b6962e014ef1
PORT=${ARCH_SMOKE_PORT:-18765}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)

if [ "${1:-}" = "--inside" ]; then
  expected=$2
  real=$3
  pacman -Sy --noconfirm --needed archlinux-keyring > /dev/null
  pacman -Su --noconfirm --needed desktop-file-utils > /dev/null
  useradd -m builder
  echo 'builder ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/builder
  build=/home/builder/build
  install -d -o builder "$build"
  install -o builder -m 644 /dist/PKGBUILD "$build/PKGBUILD"

  cd "$build"
  sudo -u builder makepkg --printsrcinfo > srcinfo.printed
  diff -u /dist/SRCINFO srcinfo.printed || { echo "arch-smoke: SRCINFO differs from makepkg --printsrcinfo"; exit 1; }

  # Only the download URL changes; the pinned SHA-256 stays, so makepkg still verifies the bytes.
  # shellcheck disable=SC2016 # ${pkgver} is the PKGBUILD's own, matched literally
  pattern='https://github\.com/[^/]*/[^/]*/releases/download/v\${pkgver}/'
  [ "$(grep -c "$pattern" PKGBUILD)" = 1 ] || { echo "arch-smoke: no single release URL in PKGBUILD"; exit 1; }
  sed -i "s|$pattern|http://127.0.0.1:$PORT/|" PKGBUILD

  sudo -u builder makepkg -si --noconfirm

  pacman -Qi vimma-bin
  version=$(vimma --version)
  [ "$version" = "$expected" ] || { echo "arch-smoke: vimma --version is '$version', want '$expected'"; exit 1; }
  # vimma-ctl ships with the browser and carries its version (spec ship-vimma-ctl).
  release=${expected#Vimma }
  release=${release%% *}
  ctl=$(vimma-ctl --version)
  case "$ctl" in "vimma-ctl $release "*) ;; *) echo "arch-smoke: vimma-ctl --version is '$ctl', want vimma-ctl $release"; exit 1 ;; esac
  marker=$(cat /opt/vimma/is-packaged-app)
  [ "$marker" = "vimma-package=pkgbuild-release" ] || { echo "arch-smoke: is-packaged-app says '$marker'"; exit 1; }
  test -x /usr/bin/vimma-open
  cmp /opt/vimma/vimma-open /repo/tools/package/vimma-open.sh
  desktop-file-validate /usr/share/applications/vimma-vimma.desktop
  test -f /usr/share/icons/hicolor/128x128/apps/vimma.png
  if [ "$real" = 1 ]; then
    # As the .deb smoke in release.yml: the first run creates the profile, since --screenshot on
    # a fresh profile races the bookmarks import (docs/runbook.md, Smoke check).
    sudo -u builder mkdir /home/builder/p
    sudo -u builder timeout 30 vimma --headless --no-remote --profile /home/builder/p about:blank || true
    sudo -u builder timeout 60 vimma --headless --no-remote --profile /home/builder/p \
      --screenshot /home/builder/shot.png "data:text/html,<h1>ok</h1>"
    test -s /home/builder/shot.png
  fi
  echo "arch-smoke: OK: $version, $marker"
  exit 0
fi

work=""
real=1
if [ "${1:-}" = "--stub" ]; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  expected=$(node "$repo/tools/release/version-line.mjs")
  app="$work/stub/vimma"
  mkdir -p "$app/browser/chrome/icons/default"
  printf '#!/bin/sh\necho "%s"\n' "$expected" > "$app/vimma"
  chmod 755 "$app/vimma"
  printf '[App]\nVendor=Vimma\nName=Vimma\nRemotingName=vimma-vimma\n' > "$app/application.ini"
  for size in 16 32 48 64 128; do
    cp "$repo/configs/branding/vimma/logo$size.png" "$app/browser/chrome/icons/default/default$size.png"
  done
  tar -cJf "$work/vimma-stub.en-US.linux-x86_64.tar.xz" -C "$work/stub" vimma
  release=$(echo "$expected" | sed 's/^Vimma \([^ ]*\) .*/\1/')
  printf '#!/bin/sh\necho "vimma-ctl %s (protocol 2)"\n' "$release" > "$work/vimma-ctl"
  chmod 755 "$work/vimma-ctl"
  node "$here/package.mjs" --tarball "$work/vimma-stub.en-US.linux-x86_64.tar.xz" \
    --ctl "$work/vimma-ctl" --out "$work/dist" --maintainer 'Vimma CI <ci@example.invalid>' \
    --no-deb --no-rpm
  dist="$work/dist"
  real=0
else
  dist=$(cd "${1:?usage: arch-smoke.sh <dist-dir> <version line> | --stub}" && pwd)
  expected=${2:?usage: arch-smoke.sh <dist-dir> <version line>}
fi
[ -f "$dist/PKGBUILD" ] || { echo "arch-smoke: $dist has no PKGBUILD (a pre-release?)"; exit 1; }

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$dist" > /dev/null 2>&1 &
server=$!
trap 'kill "$server" 2> /dev/null || true; [ -z "$work" ] || rm -rf "$work"' EXIT

docker run --rm --network host -e ARCH_SMOKE_PORT="$PORT" \
  -v "$dist:/dist:ro" -v "$repo:/repo:ro" "$IMAGE" \
  bash /repo/tools/package/arch-smoke.sh --inside "$expected" "$real"
