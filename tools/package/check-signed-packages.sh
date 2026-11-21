#!/bin/bash
# Checks what update-publish.yml's package-sign job returned (spec package-repositories,
# decisions 9 and 10), with no secret, before release.yml lists it:
#
#   tools/package/check-signed-packages.sh <tag> <dist-dir> <unsigned-dir> <signed-dir> <certificate>
#       dist-dir holds the release artifact: the unsigned .rpm and the SHA256SUMS that lists it,
#       and no pacman package, which reaches the release only after this check. unsigned-dir
#       holds package's packages-unsigned artifact: the same .rpm, the pacman package and that
#       SHA256SUMS. signed-dir holds package-sign's output and nothing else: the signed .rpm, the
#       pacman package's detached signature and the new SHA256SUMS. certificate is the committed
#       OpenPGP certificate of the package key.
#
# Checks: the release artifact holds no pacman package, and packages-unsigned's .rpm and
# SHA256SUMS are the release artifact's; signed-dir holds exactly those three regular files; the
# .rpm's signature verifies under the certificate (rpmkeys, every digest and signature required),
# its payload (rpm2cpio) and name are the unsigned one's, and so is its main header's digest
# (SHA256HEADER), so signing changed only its signature header; the pacman package's signature
# verifies with gpgv under the certificate; and the new SHA256SUMS is package's with the .rpm's
# line replaced and lines for the pacman package and its signature added, sorted by name as
# package.ts and release.yml's mar job write it, and nothing else. Needs rpm (rpmkeys, rpm2cpio),
# gpg and gpgv.
set -euo pipefail
# A failed read inside $(...) must stop the script too (bash 4.4).
shopt -s inherit_errexit

usage="usage: check-signed-packages.sh <tag> <dist-dir> <unsigned-dir> <signed-dir> <certificate>"
tag=${1:?$usage}
dist=${2:?$usage}
unsigned=${3:?$usage}
signed=${4:?$usage}
cert=${5:?$usage}

fail() {
  echo "check-signed-packages: $*" >&2
  exit 1
}

[[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "'$tag' is not a vX.Y.Z release tag"
v=${tag#v}
rpm="vimma-$v-1.x86_64.rpm"
pkg="vimma-bin-$v-1-x86_64.pkg.tar.zst"

[ -f "$cert" ] && [ ! -L "$cert" ] || fail "no certificate $cert (the package key's, committed)"
for f in "$dist/$rpm" "$dist/SHA256SUMS" "$unsigned/$rpm" "$unsigned/$pkg" "$unsigned/SHA256SUMS"; do
  [ -f "$f" ] && [ ! -L "$f" ] || fail "no file $f"
done
for f in "$dist"/*.pkg.tar.zst*; do
  [ ! -e "$f" ] || fail "the release artifact holds a pacman package, $f"
done
cmp -s "$dist/$rpm" "$unsigned/$rpm" && cmp -s "$dist/SHA256SUMS" "$unsigned/SHA256SUMS" \
  || fail "packages-unsigned's .rpm or SHA256SUMS is not the release artifact's"
want=$(printf '%s\n' "$rpm" "$pkg.sig" SHA256SUMS | LC_ALL=C sort)
have=$(ls -A "$signed" | LC_ALL=C sort)
[ "$have" = "$want" ] || fail "package-sign returned $(echo "$have" | tr '\n' ' '), want $(echo "$want" | tr '\n' ' ')"
for f in "$rpm" "$pkg.sig" SHA256SUMS; do
  [ -f "$signed/$f" ] && [ ! -L "$signed/$f" ] || fail "$f is not a regular file"
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# The .rpm: signed by the certificate's key, with nothing but the signature header changed.
rpmkeys --dbpath "$work/rpmdb" --import "$cert"
rpmkeys --dbpath "$work/rpmdb" --define '_pkgverify_level all' --checksig "$signed/$rpm" \
  || fail "$rpm: no valid signature by the package key"
# The payload's own bytes, through rpm2cpio, rather than a payload tag: rpm 6.0 renamed
# PAYLOADDIGEST, and a query of an unknown tag prints nothing and still exits 0, which would make
# two unreadable packages look the same. SHA256HEADER is the main header's digest, which signing
# leaves alone on rpm 4.18 and 6.0; empty, it proves nothing.
payload() {
  local digest name
  digest=$(rpm2cpio "$1" | sha256sum | cut -c1-64)
  name=$(rpm -qp --nosignature --qf '%{NEVRA}' "$1")
  [ -n "$name" ] || fail "$1: rpm reads no name"
  echo "$digest $name"
}
header() {
  local digest
  digest=$(rpm -qp --nosignature --qf '%{SHA256HEADER}' "$1")
  [[ $digest =~ ^[0-9a-f]{64}$ ]] || fail "$1: rpm reads no header digest"
  echo "$digest"
}
built=$(payload "$dist/$rpm")
signed_payload=$(payload "$signed/$rpm")
[ "$built" = "$signed_payload" ] \
  || fail "$rpm: the signed package's payload or name is not the built one's"
built_header=$(header "$dist/$rpm")
signed_header=$(header "$signed/$rpm")
[ "$built_header" = "$signed_header" ] \
  || fail "$rpm: the signed package's main header is not the built one's"

# The pacman package's detached signature.
gpg --batch --quiet --dearmor < "$cert" > "$work/keyring.gpg"
gpgv --keyring "$work/keyring.gpg" "$signed/$pkg.sig" "$unsigned/$pkg" \
  || fail "$pkg.sig: no valid signature by the package key"

# SHA256SUMS: package's, with the signed .rpm and the two new files.
[ "$(awk -v f="$rpm" '$2 == f' "$dist/SHA256SUMS" | wc -l)" = 1 ] \
  || fail "package's SHA256SUMS does not list $rpm once"
[ -z "$(awk -v f="$pkg" -v s="$pkg.sig" '$2 == f || $2 == s' "$dist/SHA256SUMS")" ] \
  || fail "package's SHA256SUMS already lists the pacman package"
{
  awk -v f="$rpm" '$2 != f' "$dist/SHA256SUMS"
  (cd "$signed" && sha256sum "$rpm" "$pkg.sig")
  (cd "$unsigned" && sha256sum "$pkg")
} | LC_ALL=C sort -k 2 > "$work/SHA256SUMS"
cmp -s "$work/SHA256SUMS" "$signed/SHA256SUMS" || {
  diff -u "$work/SHA256SUMS" "$signed/SHA256SUMS" >&2 || true
  fail "package-sign's SHA256SUMS is not package's with the signed packages"
}
echo "check-signed-packages: $rpm and $pkg are signed by the package key; SHA256SUMS lists them"
