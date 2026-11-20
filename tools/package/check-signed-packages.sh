#!/bin/bash
# Checks what update-publish.yml's package-sign job returned (spec package-repositories,
# decisions 9 and 10), with no secret, before release.yml lists it:
#
#   tools/package/check-signed-packages.sh <tag> <dist-dir> <signed-dir> <certificate>
#       dist-dir holds package's release files: the unsigned .rpm, the pacman package and the
#       SHA256SUMS that lists the .rpm. signed-dir holds package-sign's output and nothing else:
#       the signed .rpm, the pacman package's detached signature and the new SHA256SUMS.
#       certificate is the committed OpenPGP certificate of the package key.
#
# Checks: signed-dir holds exactly those three regular files; the .rpm's signature verifies under
# the certificate (rpmkeys, every digest and signature required) and its payload and name are the
# unsigned one's, so signing changed only its header; the pacman package's signature verifies
# with gpgv under the certificate; and the new SHA256SUMS is package's with the .rpm's line
# replaced and lines for the pacman package and its signature added, sorted by name as
# package.ts and release.yml's mar job write it, and nothing else. Needs rpm, gpg and gpgv.
set -euo pipefail

tag=${1:?usage: check-signed-packages.sh <tag> <dist-dir> <signed-dir> <certificate>}
dist=${2:?}
signed=${3:?}
cert=${4:?}

fail() {
  echo "check-signed-packages: $*" >&2
  exit 1
}

[[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "'$tag' is not a vX.Y.Z release tag"
v=${tag#v}
rpm="vimma-$v-1.x86_64.rpm"
pkg="vimma-bin-$v-1-x86_64.pkg.tar.zst"

[ -f "$cert" ] && [ ! -L "$cert" ] || fail "no certificate $cert (the package key's, committed)"
for f in "$dist/$rpm" "$dist/$pkg" "$dist/SHA256SUMS"; do
  [ -f "$f" ] && [ ! -L "$f" ] || fail "no file $f"
done
want=$(printf '%s\n' "$rpm" "$pkg.sig" SHA256SUMS | LC_ALL=C sort)
have=$(cd "$signed" && find . -mindepth 1 -printf '%P\n' | LC_ALL=C sort)
[ "$have" = "$want" ] || fail "package-sign returned $(echo "$have" | tr '\n' ' '), want $(echo "$want" | tr '\n' ' ')"
for f in "$rpm" "$pkg.sig" SHA256SUMS; do
  [ -f "$signed/$f" ] && [ ! -L "$signed/$f" ] || fail "$f is not a regular file"
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# The .rpm: signed by the certificate's key, with nothing but the header changed.
rpmkeys --dbpath "$work/rpmdb" --import "$cert"
rpmkeys --dbpath "$work/rpmdb" --define '_pkgverify_level all' --checksig "$signed/$rpm" \
  || fail "$rpm: no valid signature by the package key"
payload() { rpm -qp --nosignature --qf '%{PAYLOADDIGEST} %{NEVRA}' "$1"; }
[ "$(payload "$dist/$rpm")" = "$(payload "$signed/$rpm")" ] \
  || fail "$rpm: the signed package's payload or name is not the built one's"

# The pacman package's detached signature.
gpg --batch --quiet --dearmor < "$cert" > "$work/keyring.gpg"
gpgv --keyring "$work/keyring.gpg" "$signed/$pkg.sig" "$dist/$pkg" \
  || fail "$pkg.sig: no valid signature by the package key"

# SHA256SUMS: package's, with the signed .rpm and the two new files.
[ "$(awk -v f="$rpm" '$2 == f' "$dist/SHA256SUMS" | wc -l)" = 1 ] \
  || fail "package's SHA256SUMS does not list $rpm once"
[ -z "$(awk -v f="$pkg" -v s="$pkg.sig" '$2 == f || $2 == s' "$dist/SHA256SUMS")" ] \
  || fail "package's SHA256SUMS already lists the pacman package"
{
  awk -v f="$rpm" '$2 != f' "$dist/SHA256SUMS"
  (cd "$signed" && sha256sum "$rpm" "$pkg.sig")
  (cd "$dist" && sha256sum "$pkg")
} | LC_ALL=C sort -k 2 > "$work/SHA256SUMS"
cmp -s "$work/SHA256SUMS" "$signed/SHA256SUMS" || {
  diff -u "$work/SHA256SUMS" "$signed/SHA256SUMS" >&2 || true
  fail "package-sign's SHA256SUMS is not package's with the signed packages"
}
echo "check-signed-packages: $rpm and $pkg are signed by the package key; SHA256SUMS lists them"
