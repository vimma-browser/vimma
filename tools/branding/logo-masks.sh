#!/usr/bin/env bash
# Derives the two mask images that Vimma's pages paint the logo through (spec start-page, "Logo
# colours"): vimma-logo-mark.png (the window+V and the brushstroke V, filled with the theme's
# accent) and vimma-logo-wordmark.png ("imma", white under a dark theme and the text colour under
# a light one). Source: the transparent logo, src/browser/base/content/vimma/start/vimma-logo.png.
#
# Each output is white with only an alpha channel that matters (CSS mask-image reads alpha):
#   coverage = source alpha * brightness, where brightness = max(R,G,B) normalised to the aqua's
#   0.95. The logo was keyed off a near-black background, so its dark streaks and edges are
#   partly transparent already and partly dark colour; folding brightness into coverage keeps the
#   brush texture on any background, and drops the near-black translucent pane fill, which is not
#   a theme colour.
#   part = HSV saturation: below 0.15 is the white wordmark, above 0.30 the aqua mark, a ramp
#   between, so the anti-aliased edges are split smoothly (the two parts never touch).
# Both are cropped to the artwork's box (349x287 at +83+114, with a 2 px margin) so CSS can
# size them without padding. It also writes vimma-glyph.svg, the mark as a one-colour icon
# (context-fill) for Firefox's places that show its glyph (spec firefox-surfaces-trim, decision 9):
# the window+V of the mark mask (without the separate brushstroke V, which turns to noise at 16 px)
# downscaled to 96 px and embedded, since an SVG image cannot load other files.
# Needs ImageMagick (magick). Re-run after replacing the logo, and
# commit the outputs.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
dir="$root/src/browser/base/content/vimma/start"
src="$dir/vimma-logo.png"
crop="353x291+81+112"

value='min(1, max(r, max(g, b)) / 0.95)'
sat='(max(r, max(g, b)) > 0.004 ? (max(r, max(g, b)) - min(r, min(g, b))) / max(r, max(g, b)) : 0)'
mark="min(1, max(0, ($sat - 0.15) / 0.15))"

# $1: output; $2: the part's weight (0..1) as an -fx expression.
render() {
  magick "$src" \( +clone -alpha extract \) \
    \( -clone 0 -alpha off -fx "$value * ($2)" \) \
    -delete 0 -compose multiply -composite \
    \( +clone -fill white -colorize 100 \) +swap -alpha off -compose copy_opacity -composite \
    -crop "$crop" +repage -strip -define png:exclude-chunks=date,time "$1"
}

render "$dir/vimma-logo-mark.png" "$mark"
render "$dir/vimma-logo-wordmark.png" "1 - $mark"

glyph="$root/src/browser/themes/shared/vimma/vimma-glyph.svg"
png="$(mktemp --suffix=.png)"
trap 'rm -f "$png"' EXIT
magick "$dir/vimma-logo-mark.png" -crop 260x200+50+0 +repage -trim +repage -resize 96x96 -strip \
  -define png:color-type=4 -define png:exclude-chunks=date,time "$png"
read -r w h <<<"$(magick identify -format '%w %h' "$png")"
{
  echo '<!-- This Source Code Form is subject to the terms of the Mozilla Public'
  echo '   - License, v. 2.0. If a copy of the MPL was not distributed with this'
  echo '   - file, You can obtain one at http://mozilla.org/MPL/2.0/. -->'
  echo '<!-- The Vimma mark in one colour (context-fill). Rendered by tools/branding/logo-masks.sh. -->'
  echo '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="16" height="16">'
  echo '  <mask id="m" style="mask-type: alpha">'
  echo "    <image x=\"$(((96 - w) / 2))\" y=\"$(((96 - h) / 2))\" width=\"$w\" height=\"$h\" href=\"data:image/png;base64,$(base64 -w0 "$png")\"/>"
  echo '  </mask>'
  echo '  <rect width="96" height="96" fill="context-fill" mask="url(#m)"/>'
  echo '</svg>'
} >"$glyph"
