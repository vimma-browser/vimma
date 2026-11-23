#!/bin/bash
# The signed package repositories end to end (spec package-repositories, "Tests"): with a
# throwaway key in the signer, builds two stub versions of each package, builds and signs each
# repository with repos.ts and openpgp-kms.ts, serves it over local HTTP with the update host's
# redirects (repos-serve.ts), and on Debian and Ubuntu (apt), Fedora (dnf), openSUSE (zypper)
# and Arch Linux (pacman), each in a container pinned by digest:
#   - sets the repository up as the guide says, installs the older version and upgrades to the
#     newer, every package (and pacman's .sig) downloaded through a 302 redirect;
#   - refuses tampered metadata, metadata signed by another key, a tampered package, and (rpm
#     and pacman, whose packages carry their own signature) a package signed by another key.
#
#   tools/package/repos-smoke.sh
#
# Needs bash, Node 22.18 or later (for repos-serve.ts) and a container engine on the host:
# CONTAINER_ENGINE, docker by default, or podman (rootless works). Everything else runs in
# containers. pkgbuild.yml's repos job runs it on every pull request that changes
# tools/package/.
set -euo pipefail

# Images pinned by digest. node:22-bookworm is the builder: Debian 12's rpm 4.18 (as Ubuntu
# 24.04's, which release.yml signs with), apt-utils, createrepo-c, repo-add, gpgv and sqv, and a
# Node that runs the .ts tools. debian:trixie (apt 3.0, which verifies with sqv) and
# ubuntu:24.04 (apt 2.7, gpgv) as published on 2026-11-20; fedora:44, opensuse/leap:16.0 and
# archlinux:base-devel as rpm-smoke.sh and arch-smoke.sh pin them.
BUILDER_IMAGE=docker.io/library/node@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb
DEBIAN_IMAGE=docker.io/library/debian@sha256:9c6e381421d0f48d1b8133e573f33c185ee16cbf505eda9c4a8a4791b25ea8a6
UBUNTU_IMAGE=docker.io/library/ubuntu@sha256:9c7f200c07e3d4a03e7249d2c16bf66a51120fb876aa2242cf31451412543289
FEDORA_IMAGE=docker.io/library/fedora@sha256:43b29f65a41eb9c35e1cd5323e3bdf3b655c2357a9f4f1ff2f9c2798e5045d80
OPENSUSE_IMAGE=docker.io/opensuse/leap@sha256:5e54545c0726b48ed1c86253f6ad3da65886cd4c447123b8019569de4c157c76
ARCH_IMAGE=docker.io/library/archlinux@sha256:061679925e5d5028f2df9395d441ce6c4b9accf0157ff3486c06b6962e014ef1
ENGINE=${CONTAINER_ENGINE:-docker}
PORT=${REPOS_SMOKE_PORT:-18770}
OLD=0.0.1
NEW=0.0.2
# One tree, and one server, per case. archold is the pacman repository before the upgrade;
# keyswap is a host that serves another key, with metadata and packages signed by it.
VARIANTS="good archold badmeta otherkey badpkg pkgkey nodbsig keyswap"
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)

fail() {
  echo "repos-smoke: $*" >&2
  exit 1
}

port_of() {
  local i=0 v
  for v in $VARIANTS; do
    [ "$v" = "$1" ] && { echo $((PORT + i)); return; }
    i=$((i + 1))
  done
  fail "no variant $1"
}

# A command that must fail; its last lines show why, and must match the pattern given.
refuse() {
  local what=$1 pattern=$2 out
  shift 2
  # progress bars redraw with carriage returns: one message per line
  if out=$("$@" 2>&1 | tr '\r' '\n'; exit "${PIPESTATUS[0]}"); then
    echo "$out" | tail -n 20
    fail "$DISTRO: $what: accepted"
  fi
  local why
  why=$(echo "$out" | grep -E -m 1 "$pattern") || {
    echo "$out" | tail -n 20
    fail "$DISTRO: $what: refused, but not with /$pattern/"
  }
  echo "repos-smoke: $DISTRO: $what: refused: ${why#"${why%%[![:space:]]*}"}"
}

# The package's request went through the host's redirect.
redirected() {
  grep -q -E "^GET $2 302 http://127\.0\.0\.1:[0-9]+/download/" "/w/logs/$1.log" || {
    cat "/w/logs/$1.log"
    fail "$DISTRO: no redirect for $2 in the $1 server's log"
  }
}

# --- Inside the builder ------------------------------------------------------------------------

builder() {
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends rpm createrepo-c apt-utils sqv gpgv gpg \
    pacman-package-manager makepkg libarchive-tools zstd > /dev/null
  local signer=/repo/tools/package/openpgp-kms.ts k=/w/keys v
  mkdir -p "$k"
  # Throwaway keys; "other" stands for any key the user did not trust.
  node -e '
    const { generateKeyPairSync } = require("node:crypto");
    const { writeFileSync } = require("node:fs");
    for (const name of ["good", "other"]) {
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 4096 });
      writeFileSync(`${process.argv[1]}/${name}.pem`, privateKey.export({ type: "pkcs8", format: "pem" }));
    }' "$k"
  for v in good other; do
    node "$signer" certify --local-key "$k/$v.pem" --created 2026-11-01T00:00:00Z \
      --user-id 'Vimma packages <packages@vimma.dev>' --out "$k/$v.asc" > "$k/$v.fpr"
    gpg --batch --quiet --dearmor --output "$k/$v.gpg" "$k/$v.asc"
  done
  sign() { # key format in out
    node "$signer" sign --local-key "$k/$1.pem" --cert "$k/$1.asc" --format "$2" --in "$3" --out "$4"
    if [ "$2" != cleartext ]; then
      gpgv --quiet --keyring "$k/$1.gpg" "$4" "$3" 2> /dev/null
      sqv --keyring "$k/$1.asc" "$4" "$3" > /dev/null
    else
      gpgv --quiet --keyring "$k/$1.gpg" "$4" 2> /dev/null
    fi
  }

  for v in $OLD $NEW; do
    local s=/w/stage/$v r=/w/releases/good/v$v o=/w/releases/other/v$v
    mkdir -p "$s/deb/DEBIAN" "$s/deb/usr/bin" "$s/rpm/SPECS" "$r" "$o"
    printf '#!/bin/sh\necho "Vimma %s"\n' "$v" > "$s/deb/usr/bin/vimma"
    chmod 755 "$s/deb/usr/bin/vimma"
    printf 'Package: vimma\nVersion: %s\nArchitecture: amd64\nMaintainer: Vimma CI <ci@example.invalid>\nDescription: repository smoke-test stub\n' \
      "$v" > "$s/deb/DEBIAN/control"
    dpkg-deb --root-owner-group --build "$s/deb" "$r/vimma_${v}_amd64.deb" > /dev/null
    cp "$r/vimma_${v}_amd64.deb" "$o/"
    cat > "$s/rpm/SPECS/vimma.spec" << EOF
Name: vimma
Version: $v
Release: 1
Summary: repository smoke-test stub
License: MPL-2.0
AutoReqProv: no
%description
stub
%install
mkdir -p %{buildroot}/usr/bin
printf '#!/bin/sh\necho "Vimma %%s"\n' "$v" > %{buildroot}/usr/bin/vimma
chmod 755 %{buildroot}/usr/bin/vimma
%files
/usr/bin/vimma
EOF
    rpmbuild --quiet --define "_topdir $s/rpm" --target x86_64 -bb "$s/rpm/SPECS/vimma.spec" 2> /dev/null
    local rpmfile=vimma-$v-1.x86_64.rpm key
    for key in good other; do
      local dest=$r
      [ "$key" = other ] && dest=$o
      cp "$s/rpm/RPMS/x86_64/$rpmfile" "$dest/$rpmfile"
      # The release job's form (decision 9): rpmsign runs the signer with the header on stdin.
      # One form for rpm 4.18 and 6.0, as openpgp-kms.test.ts explains.
      rpmsign --define "_gpg_name Vimma packages" \
        --define "__gpg_sign_cmd() /usr/bin/env env $(command -v node) $signer sign --local-key $k/$key.pem --cert $k/$key.asc --format binary --in %{?1:%{shescape:%{1}}}%{!?1:-} --out %{?2:%{shescape:%{2}}}%{!?2:%{shescape:%{__signature_filename}}}" \
        --addsign "$dest/$rpmfile" > /dev/null
    done
    local pkg=vimma-bin-$v-1-x86_64.pkg.tar.zst
    cp "/w/stubs/$pkg" "$r/$pkg"
    cp "/w/stubs/$pkg" "$o/$pkg"
    sign good binary "$r/$pkg" "$r/$pkg.sig"
    sign other binary "$o/$pkg" "$o/$pkg.sig"
  done
  local db=/w/rpmdb
  mkdir -p "$db"
  rpm --dbpath "$db" --import "$k/good.asc"
  rpm --dbpath "$db" -K "/w/releases/good/v$NEW/vimma-$NEW-1.x86_64.rpm"

  for v in $VARIANTS; do
    local p tree=/w/trees/$v releases=good args=() published=good
    p=$(port_of "$v")
    case "$v" in pkgkey) releases=other ;; keyswap) releases=other published=other ;; esac
    args=(--release "v$OLD=/w/releases/$releases/v$OLD")
    [ "$v" = archold ] || args+=(--release "v$NEW=/w/releases/$releases/v$NEW")
    node /repo/tools/package/repos.ts build --out "$tree" --cert "$k/$published.asc" "${args[@]}" \
      --base-url "http://127.0.0.1:$p" --download-base "http://127.0.0.1:$p/download"
    local key=good
    case "$v" in otherkey | keyswap) key=other ;; esac
    sign "$key" cleartext "$tree/apt/Release" "$tree/apt/InRelease"
    sign "$key" armor "$tree/rpm/repodata/repomd.xml" "$tree/rpm/repodata/repomd.xml.asc"
    sign "$key" binary "$tree/arch/x86_64/vimma.db" "$tree/arch/x86_64/vimma.db.sig"
    sign "$key" binary "$tree/arch/x86_64/vimma.files" "$tree/arch/x86_64/vimma.files.sig"
    # GitHub's own hop: /download/<tag>/<file> redirects again, as github.com does to
    # release-assets.githubusercontent.com, to a URL whose last segment is not the file's name
    # (pacman then asks the repository's Server for a package's .sig: Research).
    local tag f
    for tag in "v$OLD" "v$NEW"; do
      [ "$v" = archold ] && [ "$tag" = "v$NEW" ] && continue
      for f in "/w/releases/$releases/$tag"/*; do
        mkdir -p "$tree/assets/$tag/${f##*/}"
        cp "$f" "$tree/assets/$tag/${f##*/}/blob"
      done
    done
    echo "/download/:tag/:file http://127.0.0.1:$p/assets/:tag/:file/blob 302" >> "$tree/_redirects"
    case "$v" in
      badmeta)
        # each signed file changed after signing
        sed -i 's/^Label: Vimma$/Label: Vimmb/' "$tree/apt/InRelease"
        sed -i 's|<revision>|<revision>1|' "$tree/rpm/repodata/repomd.xml"
        printf '\0' >> "$tree/arch/x86_64/vimma.db"
        ;;
      badpkg)
        # one bit of every package flipped, its size and signature unchanged, so the checksum in
        # the signed metadata and the package's own signature are what refuse it
        for f in "$tree"/assets/*/vimma*/blob; do
          case "$f" in
            *.sig/blob) ;;
            *) node -e 'const fs = require("node:fs"); const b = fs.readFileSync(process.argv[1]);
                 b[b.length >> 1] ^= 1; fs.writeFileSync(process.argv[1], b);' "$f" ;;
          esac
        done
        ;;
      nodbsig)
        # an unsigned pacman database: an observation, see pacman_client
        rm "$tree/arch/x86_64/vimma.db.sig" "$tree/arch/x86_64/vimma.files.sig"
        ;;
    esac
  done
  grep -q '^Label: Vimmb$' /w/trees/badmeta/apt/InRelease
  echo "repos-smoke: builder: OK: $(cat "$k/good.fpr"), $(rpm --version), $(sqv --version)"
}

# --- Inside the Arch image: stub pacman packages -----------------------------------------------

arch_stubs() {
  useradd -m builder
  local v d
  for v in $OLD $NEW; do
    d=/home/builder/v$v
    install -d -o builder "$d"
    cat > "$d/PKGBUILD" << EOF
pkgname=vimma-bin
pkgver=$v
pkgrel=1
pkgdesc='repository smoke-test stub'
arch=(x86_64)
url=https://github.com/vimma-browser/vimma
license=(MPL-2.0)
options=(!debug !strip)
package() {
  install -d "\$pkgdir/usr/bin"
  printf '#!/bin/sh\necho "Vimma %s"\n' "\$pkgver" > "\$pkgdir/usr/bin/vimma"
  chmod 755 "\$pkgdir/usr/bin/vimma"
}
EOF
    (cd "$d" && sudo -u builder makepkg --nodeps --noconfirm > /dev/null)
    mkdir -p /w/stubs
    cp "$d/vimma-bin-$v-1-x86_64.pkg.tar.zst" /w/stubs/
  done
}

# --- Inside each client ------------------------------------------------------------------------

apt_client() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends curl ca-certificates > /dev/null
  # From here on the only source is Vimma's, so nothing else is fetched.
  rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*
  rm -rf /var/lib/apt/lists/*
  echo "repos-smoke: $DISTRO: $(apt-get --version | head -n 1)"
  setup() {
    rm -f /etc/apt/sources.list.d/vimma.sources
    rm -rf /var/lib/apt/lists/*
    apt-get clean
    curl -fsSL "http://127.0.0.1:$(port_of "$1")/apt/vimma.sources" |
      tee /etc/apt/sources.list.d/vimma.sources > /dev/null
  }
  setup good
  apt-get update
  apt-get install -y "vimma=$OLD"
  [ "$(vimma)" = "Vimma $OLD" ] || fail "$DISTRO: vimma prints '$(vimma)'"
  apt-get upgrade -y
  [ "$(vimma)" = "Vimma $NEW" ] || fail "$DISTRO: after upgrade, vimma prints '$(vimma)'"
  redirected good "/apt/pool/v$OLD/vimma_${OLD}_amd64.deb"
  redirected good "/apt/pool/v$NEW/vimma_${NEW}_amd64.deb"
  echo "repos-smoke: $DISTRO: install $OLD and upgrade to $NEW through the redirect: OK"
  apt-get purge -y -qq vimma > /dev/null

  setup badmeta
  refuse "tampered InRelease" 'BADSIG|manipulated' \
    sh -c 'apt-get update && apt-get install -y vimma'
  setup otherkey
  refuse "InRelease signed by another key" 'NO_PUBKEY|Missing key' \
    sh -c 'apt-get update && apt-get install -y vimma'
  setup badpkg
  refuse "tampered .deb" 'Hash Sum mismatch|[Hh]ashes do not match' \
    sh -c 'apt-get update && apt-get install -y vimma'
  ! command -v vimma > /dev/null || fail "$DISTRO: vimma is installed after a refusal"
  echo "repos-smoke: $DISTRO: OK"
}

rpm_client() {
  local up
  if [ "$DISTRO" = fedora ]; then
    dnf -q -y install 'dnf5-command(config-manager)' > /dev/null
    rm -f /etc/yum.repos.d/*.repo
    echo "repos-smoke: $DISTRO: dnf $(dnf --version | head -n 1), $(rpm --version)"
  else
    # repositories and the services that would add them back on a refresh
    rm -f /etc/zypp/repos.d/* /etc/zypp/services.d/*
    echo "repos-smoke: $DISTRO: $(zypper --version), $(rpm --version)"
  fi
  setup() {
    local url
    url="http://127.0.0.1:$(port_of "$1")/rpm/vimma.repo"
    if [ "$DISTRO" = fedora ]; then
      rm -f /etc/yum.repos.d/vimma.repo
      dnf -q clean all > /dev/null
      dnf config-manager addrepo --from-repofile="$url"
      # Vimma's update hint looks for this file (spec decision 18)
      test -f /etc/yum.repos.d/vimma.repo || fail "$DISTRO: dnf did not write /etc/yum.repos.d/vimma.repo"
    else
      zypper --non-interactive --quiet removerepo vimma > /dev/null 2>&1 || true
      zypper --non-interactive --quiet clean --all > /dev/null
      # --refresh and --gpgcheck-strict: zypper's autorefresh and pkg_gpgcheck, which the .repo
      # file cannot carry (repos.ts, rpmRepo)
      zypper --non-interactive addrepo --refresh --gpgcheck-strict "$url"
      # zypper names the file after the .repo file's section id, which repos.ts keeps [vimma],
      # and Vimma's update hint looks for it (spec decision 18)
      test -f /etc/zypp/repos.d/vimma.repo || fail "$DISTRO: zypper did not write /etc/zypp/repos.d/vimma.repo"
      cat /etc/zypp/repos.d/vimma.repo
    fi
    # forget a key a previous case trusted
    rpm -q gpg-pubkey > /dev/null 2>&1 && rpm -e --allmatches gpg-pubkey
    return 0
  }
  install_cmd() {
    # dnf -y and zypper --gpg-auto-import-keys stand for the user accepting the key's
    # fingerprint at the prompt.
    if [ "$DISTRO" = fedora ]; then echo "dnf -y install vimma$1"
    else echo "zypper --non-interactive --gpg-auto-import-keys install vimma$1"; fi
  }
  setup good
  if [ "$DISTRO" = fedora ]; then
    dnf -y install "vimma-$OLD"
    up="dnf -y upgrade vimma"
  else
    zypper --non-interactive --gpg-auto-import-keys refresh
    zypper --non-interactive install "vimma=$OLD"
    up="zypper --non-interactive up vimma"
  fi
  [ "$(vimma)" = "Vimma $OLD" ] || fail "$DISTRO: vimma prints '$(vimma)'"
  rpm -q --qf '%{SIGPGP:pgpsig}\n' vimma
  $up
  [ "$(vimma)" = "Vimma $NEW" ] || fail "$DISTRO: after upgrade, vimma prints '$(vimma)'"
  redirected good "/rpm/packages/v$OLD/vimma-$OLD-1.x86_64.rpm"
  redirected good "/rpm/packages/v$NEW/vimma-$NEW-1.x86_64.rpm"
  echo "repos-smoke: $DISTRO: install $OLD and upgrade to $NEW through the redirect: OK"
  rpm -e vimma

  local sig='[Ss]ignature verification failed|[Ss]ignature.*(invalid|failed|bad)|NOKEY|not signed|OpenPGP check|[Uu]nknown key|GPG check FAILED|signature verification error'
  setup badmeta
  refuse "tampered repomd.xml" "$sig" $(install_cmd "")
  setup otherkey
  refuse "repomd.xml signed by another key" "$sig" $(install_cmd "")
  setup badpkg
  refuse "tampered .rpm" "$sig|[Cc]hecksum|[Dd]igest" $(install_cmd "")
  setup pkgkey
  refuse ".rpm signed by another key" "$sig" $(install_cmd "")
  ! command -v vimma > /dev/null || fail "$DISTRO: vimma is installed after a refusal"

  # A host that turns on its users: after they trusted the good key and installed, it serves
  # another key, with metadata and packages signed by it. The upgrade runs as a user's would,
  # with no automatic key import (dnf answers no; zypper does not trust a new key unasked).
  setup good
  if [ "$DISTRO" = fedora ]; then dnf -y install "vimma-$OLD"
  else
    zypper --non-interactive --gpg-auto-import-keys refresh
    zypper --non-interactive install "vimma=$OLD"
  fi
  local repofile=/etc/zypp/repos.d/vimma.repo
  [ "$DISTRO" = fedora ] && repofile=/etc/yum.repos.d/vimma.repo
  sed -i "s|127.0.0.1:$(port_of good)/|127.0.0.1:$(port_of keyswap)/|g" "$repofile"
  if [ "$DISTRO" = fedora ]; then
    # dnf skips a repository whose repomd.xml fails its check and exits 0 ("Nothing to do"),
    # so the refusal is the message and the version left installed (checked below)
    local out why
    out=$(dnf --assumeno --refresh upgrade vimma 2>&1 | tr '\r' '\n') || true
    why=$(echo "$out" | grep -E -m 1 "$sig") || {
      echo "$out" | tail -n 20
      fail "$DISTRO: a host that switched to another key: not refused"
    }
    echo "repos-smoke: $DISTRO: a host that switched to another key: refused: ${why#"${why%%[![:space:]]*}"}"
  else
    refuse "a host that switched to another key" "$sig" zypper --non-interactive up vimma
  fi
  [ "$(vimma)" = "Vimma $OLD" ] || fail "$DISTRO: vimma changed to '$(vimma)' after a refusal"
  rpm -e vimma
  echo "repos-smoke: $DISTRO: OK"
}

pacman_client() {
  echo "repos-smoke: $DISTRO: $(pacman --version | grep -o 'Pacman v[0-9.]*')"
  pacman-key --init > /dev/null 2>&1
  # From here on the only repository is Vimma's: drop core and extra (and their Include lines).
  sed -i '/^\[core\]/,/^$/d; /^\[extra\]/,/^$/d; /^\[multilib\]/,/^$/d' /etc/pacman.conf
  grep -n '^\[' /etc/pacman.conf
  curl -fsSL "http://127.0.0.1:$(port_of good)/vimma-packages.asc" | pacman-key --add -
  pacman-key --lsign-key "$FINGERPRINT"
  # shellcheck disable=SC2016 # $arch is pacman's own
  printf '\n[vimma]\nServer = http://127.0.0.1:%s/arch/$arch\n' "$(port_of archold)" >> /etc/pacman.conf
  server() {
    sed -i "s|^Server = http://127.0.0.1:[0-9]*/|Server = http://127.0.0.1:$(port_of "$1")/|" /etc/pacman.conf
    # and no package a previous case left in the cache, which pacman would install from there
    rm -f /var/lib/pacman/sync/vimma.* /var/cache/pacman/pkg/vimma-bin-*
  }
  pacman -Sy --noconfirm vimma-bin
  [ "$(vimma)" = "Vimma $OLD" ] || fail "$DISTRO: vimma prints '$(vimma)'"
  server good
  pacman -Syu --noconfirm
  [ "$(vimma)" = "Vimma $NEW" ] || fail "$DISTRO: after upgrade, vimma prints '$(vimma)'"
  redirected archold "/arch/x86_64/vimma-bin-$OLD-1-x86_64.pkg.tar.zst"
  redirected archold "/arch/x86_64/vimma-bin-$OLD-1-x86_64.pkg.tar.zst.sig"
  redirected good "/arch/x86_64/vimma-bin-$NEW-1-x86_64.pkg.tar.zst"
  redirected good "/arch/x86_64/vimma-bin-$NEW-1-x86_64.pkg.tar.zst.sig"
  echo "repos-smoke: $DISTRO: install $OLD and upgrade to $NEW through the redirect: OK"
  pacman -R --noconfirm vimma-bin > /dev/null

  server badmeta
  refuse "tampered vimma.db" 'invalid or corrupted database|signature .* is invalid' pacman -Sy --noconfirm vimma-bin
  server otherkey
  refuse "vimma.db signed by another key" 'invalid or corrupted database|unknown trust|is unknown|could not be looked up' pacman -Sy --noconfirm vimma-bin
  server badpkg
  refuse "tampered package" 'invalid or corrupted package|signature .* is invalid' pacman -Sy --noconfirm vimma-bin
  server pkgkey
  refuse "package signed by another key" 'invalid or corrupted package|unknown trust|is unknown|could not be looked up' pacman -Sy --noconfirm vimma-bin
  ! command -v vimma > /dev/null || fail "$DISTRO: vimma is installed after a refusal"

  # Not a requirement of the design: pacman's default SigLevel (Required DatabaseOptional)
  # accepts a database with no signature; the package signatures are still required.
  server nodbsig
  if pacman -Sy --noconfirm vimma-bin > /tmp/nodbsig.log 2>&1; then
    echo "repos-smoke: $DISTRO: observed: an unsigned vimma.db is accepted under the default SigLevel"
  else
    echo "repos-smoke: $DISTRO: observed: an unsigned vimma.db is refused under the default SigLevel"
  fi
  echo "repos-smoke: $DISTRO: OK"
}

if [ "${1:-}" = "--inside" ]; then
  DISTRO=$2
  case "$DISTRO" in
    builder) builder ;;
    arch-stubs) arch_stubs ;;
    debian | ubuntu) apt_client ;;
    fedora | opensuse) rpm_client ;;
    arch) pacman_client ;;
    cleanup) rm -rf /w/* ;;
    *) fail "unknown step $DISTRO" ;;
  esac
  exit 0
fi

# --- On the host -------------------------------------------------------------------------------

command -v "$ENGINE" > /dev/null || fail "no $ENGINE (set CONTAINER_ENGINE)"
# REPOS_SMOKE_WORK=<dir> keeps the built trees there and reuses them on the next run.
work=${REPOS_SMOKE_WORK:-$(mktemp -d)}
mkdir -p "$work"
work=$(cd "$work" && pwd)
pids=()
in_container() { # image step [run options]
  local image=$1 step=$2
  shift 2
  "$ENGINE" run --rm --network host "$@" -e REPOS_SMOKE_PORT="$PORT" \
    -e FINGERPRINT="${FINGERPRINT:-}" -v "$work:/w" -v "$repo:/repo:ro" "$image" \
    bash /repo/tools/package/repos-smoke.sh --inside "$step"
}
cleanup() {
  local pid
  for pid in "${pids[@]}"; do kill "$pid" 2> /dev/null || true; done
  # Files a container wrote may belong to its root: remove them from a container too.
  [ -z "${REPOS_SMOKE_WORK:-}" ] || return 0
  in_container "$BUILDER_IMAGE" cleanup > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

if [ ! -f "$work/keys/good.fpr" ]; then
  in_container "$ARCH_IMAGE" arch-stubs
  in_container "$BUILDER_IMAGE" builder
fi
FINGERPRINT=$(tr -d '\n' < "$work/keys/good.fpr")

rm -rf "$work/logs"
mkdir -p "$work/logs"
for v in $VARIANTS; do
  node "$here/repos-serve.ts" --dir "$work/trees/$v" --port "$(port_of "$v")" \
    --log "$work/logs/$v.log" > /dev/null &
  pids+=($!)
done
for v in $VARIANTS; do
  for _ in $(seq 50); do
    node -e 'fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' \
      "http://127.0.0.1:$(port_of "$v")/vimma-packages.asc" && continue 2
    sleep 0.2
  done
  fail "the $v server did not start"
done

status=0
for client in debian:$DEBIAN_IMAGE ubuntu:$UBUNTU_IMAGE fedora:$FEDORA_IMAGE \
  opensuse:$OPENSUSE_IMAGE arch:$ARCH_IMAGE; do
  name=${client%%:*}
  # REPOS_SMOKE_ONLY="fedora arch" runs only those clients, when working on one of them.
  case " ${REPOS_SMOKE_ONLY:-$name} " in *" $name "*) ;; *) continue ;; esac
  if ! in_container "${client#*:}" "$name"; then
    echo "repos-smoke: $name: FAILED"
    status=1
  fi
done
[ "$status" = 0 ] || fail "a client failed"
echo "repos-smoke: OK: apt (Debian, Ubuntu), dnf (Fedora), zypper (openSUSE), pacman (Arch)"
