#!/usr/bin/env bash
# Renders the brand images Surfer needs (spec m0-branding) from the Vimma mark,
# docs/assets/vimma-mark.png: the window+V cropped from the owner's square logo (y9Fu1.jpg),
# its near-black background keyed out with a soft alpha ramp, centred on a transparent 512 square:
#   magick SRC \( +clone -fill 'rgb(3,3,5)' -colorize 100 \) -compose difference -composite \
#     -colorspace gray -level 2.5%,11% ALPHA     # then SRC + ALPHA via copy_opacity,
#   -crop 470x367+284+228 +repage -background none -gravity center -extent 512x512
# then laid over a solid dark window, so the icon reads on light desktops too (the key leaves the
# panes see-through): roundrectangle 30,81 481,419 20,20 in rgb(8,12,16), its lower pane
# (y >= 283) rgb(14,18,26); the corners outside the frame stay transparent. The mark, like the
# other logo images in docs/assets/ and vimma/start/vimma-logo.png, was then turned from mint to
# aqua with `magick IN -modulate 100,100,111.1 OUT` (a 20 degree hue turn).
# Needs ImageMagick (magick). Re-run after replacing the mark or document-pdf.svg, and commit
# the outputs.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
mark="$root/docs/assets/vimma-mark.png"
dir="$root/configs/branding/vimma"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$dir"

png() { magick "$mark" -filter Lanczos -resize "$1x$1" -strip "$2"; }

# An SVG that carries the mark as an embedded PNG (the hicolor scalable icon and
# chrome://branding/content/about-logo.svg). $1: output; $2: comment.
svg() {
  png 512 "$tmp/svg.png"
  {
    echo '<!-- This Source Code Form is subject to the terms of the Mozilla Public'
    echo '   - License, v. 2.0. If a copy of the MPL was not distributed with this'
    echo '   - file, You can obtain one at http://mozilla.org/MPL/2.0/. -->'
    echo "<!-- vimma-mark: $2 Rendered by tools/branding/render.sh. -->"
    echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">'
    printf '  <image width="512" height="512" href="data:image/png;base64,%s"/>\n' \
      "$(base64 -w0 "$tmp/svg.png")"
    echo '</svg>'
  } >"$1"
}

# Linux icons (Surfer copies logoN.png to defaultN.png) and the about-logo source.
for s in 16 22 24 32 48 64 128 256 512; do png "$s" "logo$s.png"; done
png 1024 logo.png
png 1024 logo-mac.png
svg logo.svg "the window+V mark (docs/assets/vimma-mark.png)."

# Windows icons Surfer requires (the Linux build packages document.ico too).
for s in 16 32 48 64 256; do png "$s" "$tmp/i$s.png"; done
magick "$tmp"/i{16,32,48,256}.png firefox.ico
magick "$tmp"/i{16,32,48,64,256}.png firefox64.ico
rsvg-convert -w 16 -h 16 document-pdf.svg -o "$tmp/d16.png"
rsvg-convert -w 32 -h 32 document-pdf.svg -o "$tmp/d32.png"
magick "$tmp"/d16.png "$tmp"/d32.png document.ico

# chrome://branding/content/ overrides, so no file from browser/branding/unofficial is shown on Linux.
cp logo.svg content/about-logo.svg
cp wordmark.svg content/about-wordmark.svg
cp wordmark.svg content/firefox-wordmark.svg
cp document-pdf.svg content/document_pdf.svg
png 192 content/about-logo-private.png
png 384 content/about-logo-private@2x.png
png 200 "$tmp/about-logo.png"
magick -size 300x236 xc:'#071011' "$tmp/about-logo.png" -gravity center -composite content/about.png

# Strip timestamps so re-running does not churn the committed PNGs.
for f in logo*.png content/*.png; do magick "$f" -strip -define png:exclude-chunks=date,time "$f"; done
