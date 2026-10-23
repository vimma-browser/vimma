#!/bin/bash
# Installs the release .rpm on Fedora with dnf and on openSUSE with zypper, as a user would with
#   sudo dnf install ./vimma-X.Y.Z-1.x86_64.rpm
#   sudo zypper install --allow-unsigned-rpm ./vimma-X.Y.Z-1.x86_64.rpm
# (spec rpm-package), each in a container pinned by digest.
#
#   tools/package/rpm-smoke.sh <dist-dir> <expected `vimma --version` line>
#       dist-dir holds package.mjs's output with exactly one vimma-*.x86_64.rpm. release.yml's
#       package job runs this on the release build.
#   tools/package/rpm-smoke.sh --stub
#       packages a stub tarball (shell scripts for `vimma` and `vimma-ctl`) first; pkgbuild.yml
#       runs this on pull requests, so a broken .rpm fails before a release. Needs rpmbuild on the host.
#
# Needs docker on the host. Checks, on each distribution: the package manager resolves every
# requirement and installs the .rpm; `vimma --version` prints the expected line, and vimma-ctl on
# PATH names the same Vimma version;
# /usr/lib/vimma/is-packaged-app says vimma-package=rpm; vimma-open is the repository's launcher
# byte for byte; the desktop file passes desktop-file-validate; rpm -V finds every file as
# packaged; for a real build (not --stub), Vimma starts headless and takes a screenshot, so the
# requirements rpmbuild found are enough; and rpm -e removes everything it installed.
set -euo pipefail

# fedora:44 and opensuse/leap:16.0 as published on 2026-10-21. Each run installs the current
# packages of that release from its repositories, so an older digest still resolves against them.
FEDORA_IMAGE=fedora@sha256:43b29f65a41eb9c35e1cd5323e3bdf3b655c2357a9f4f1ff2f9c2798e5045d80
OPENSUSE_IMAGE=opensuse/leap@sha256:5e54545c0726b48ed1c86253f6ad3da65886cd4c447123b8019569de4c157c76
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)

if [ "${1:-}" = "--inside" ]; then
  distro=$2
  expected=$3
  real=$4
  shopt -s nullglob
  rpms=(/dist/vimma-*.x86_64.rpm)
  [ "${#rpms[@]}" = 1 ] || { echo "rpm-smoke: want one vimma-*.x86_64.rpm in dist, found ${#rpms[@]}"; exit 1; }
  rpm=${rpms[0]}
  case "$distro" in
    fedora) dnf install -y "$rpm" desktop-file-utils diffutils ;;
    opensuse) zypper --non-interactive install --allow-unsigned-rpm "$rpm" desktop-file-utils diffutils ;;
    *) echo "rpm-smoke: unknown distribution $distro"; exit 1 ;;
  esac

  rpm -qi vimma
  version=$(vimma --version)
  [ "$version" = "$expected" ] || { echo "rpm-smoke: $distro: vimma --version is '$version', want '$expected'"; exit 1; }
  # vimma-ctl ships with the browser and carries its version (spec ship-vimma-ctl).
  release=${expected#Vimma }
  release=${release%% *}
  ctl=$(vimma-ctl --version)
  case "$ctl" in "vimma-ctl $release "*) ;; *) echo "rpm-smoke: $distro: vimma-ctl --version is '$ctl', want vimma-ctl $release"; exit 1 ;; esac
  marker=$(cat /usr/lib/vimma/is-packaged-app)
  [ "$marker" = "vimma-package=rpm" ] || { echo "rpm-smoke: $distro: is-packaged-app says '$marker'"; exit 1; }
  test -x /usr/bin/vimma-open
  cmp /usr/lib/vimma/vimma-open /repo/tools/package/vimma-open.sh
  desktop-file-validate /usr/share/applications/vimma-vimma.desktop
  test -f /usr/share/icons/hicolor/128x128/apps/vimma.png
  rpm -V vimma
  if [ "$real" = 1 ]; then
    # As the .deb smoke in release.yml: the first run creates the profile, since --screenshot on
    # a fresh profile races the bookmarks import (docs/runbook.md, Smoke check).
    p=$(mktemp -d)
    timeout 30 vimma --headless --no-remote --profile "$p" about:blank || true
    timeout 60 vimma --headless --no-remote --profile "$p" --screenshot /tmp/shot.png "data:text/html,<h1>ok</h1>"
    test -s /tmp/shot.png
  fi
  rpm -e vimma
  test ! -e /usr/lib/vimma
  test ! -e /usr/bin/vimma
  test ! -e /usr/bin/vimma-ctl
  echo "rpm-smoke: $distro: OK: $version, $marker"
  exit 0
fi

work=""
real=1
if [ "${1:-}" = "--stub" ]; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  expected=$(node "$repo/tools/release/version-line.mjs")
  app="$work/stub/vimma"
  mkdir -p "$app"
  printf '#!/bin/sh\necho "%s"\n' "$expected" > "$app/vimma"
  chmod 755 "$app/vimma"
  printf '[App]\nVendor=Vimma\nName=Vimma\nRemotingName=vimma-vimma\n' > "$app/application.ini"
  tar -cJf "$work/vimma-stub.en-US.linux-x86_64.tar.xz" -C "$work/stub" vimma
  release=$(echo "$expected" | sed 's/^Vimma \([^ ]*\) .*/\1/')
  printf '#!/bin/sh\necho "vimma-ctl %s (protocol 2)"\n' "$release" > "$work/vimma-ctl"
  chmod 755 "$work/vimma-ctl"
  node "$here/package.mjs" --tarball "$work/vimma-stub.en-US.linux-x86_64.tar.xz" \
    --ctl "$work/vimma-ctl" --out "$work/dist" --maintainer 'Vimma CI <ci@example.invalid>' --no-deb
  dist="$work/dist"
  real=0
else
  dist=$(cd "${1:?usage: rpm-smoke.sh <dist-dir> <version line> | --stub}" && pwd)
  expected=${2:?usage: rpm-smoke.sh <dist-dir> <version line>}
fi

for distro in fedora opensuse; do
  case "$distro" in
    fedora) image=$FEDORA_IMAGE ;;
    opensuse) image=$OPENSUSE_IMAGE ;;
  esac
  docker run --rm -v "$dist:/dist:ro" -v "$repo:/repo:ro" "$image" \
    bash /repo/tools/package/rpm-smoke.sh --inside "$distro" "$expected" "$real"
done
