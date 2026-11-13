# Fonts for the e2e screenshots

The e2e harness (`tools/e2e/launcher.mjs`) starts a scenario's browser with `FONTCONFIG_FILE`
set to `fonts.conf` in this folder, so on Linux every scenario renders with the fonts here only,
drawn with the hinting and antialiasing settings of CI's ubuntu-24.04. The baselines in
`tests/e2e/baselines/` come from CI, and with the fonts pinned a local run on any Linux
distribution compares with them without installing a font package (issue #944). macOS runs the
scenarios headless and takes no screenshots, so it does not use this folder.

## Which fonts, and why

- **DejaVu Sans, Sans Mono and Serif 2.37**, regular and bold: what `sans-serif`, `monospace`
  and `serif` resolve to on CI. Sans is Firefox's UI font (GTK's "Sans") and the fixture pages';
  Sans Mono is Vimma's UI font (`var(--vimma-font, monospace)`); Serif is for a page that names
  no font (Firefox's `font.default` is serif).
- **Liberation Sans 2.1.5**, regular: CI has `fonts-liberation`, and fontconfig maps Helvetica
  and Arial to it there. The PDF fixture's text is in the standard Helvetica, which pdf.js
  draws with that system font.

Nothing on screen is italic, so no italic face is kept; Firefox would synthesise one. Emoji come
from Twemoji Mozilla, which Firefox bundles in `dist/bin/fonts/` and adds to fontconfig's set
itself (CI's runner also has Noto Color Emoji, which Firefox prefers there); no baseline shows an
emoji.

## Sources

The files are unchanged copies from the upstream releases, the versions Ubuntu 24.04 and Arch
ship:

- DejaVu: `dejavu-fonts-ttf-2.37.tar.bz2` from
  `https://github.com/dejavu-fonts/dejavu-fonts/releases/tag/version_2_37`, SHA-256
  `fa9ca4d13871dd122f61258a80d01751d603b4d3ee14095d65453b4e846e17d7`, the same bytes as the
  SourceForge mirror (`https://sourceforge.net/projects/dejavu/files/dejavu/2.37/`). Ubuntu
  (`fonts-dejavu-core`, `fonts-dejavu-mono` 2.37-8) builds its files from the same source with
  its own FontForge: its Latin glyphs and every advance width are the release's, and the other
  glyphs differ only by repeated outline points.
- Liberation: `liberation-fonts-ttf-2.1.5.tar.gz`, linked from
  `https://github.com/liberationfonts/liberation-fonts/releases/tag/2.1.5`
  (`https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-2.1.5.tar.gz`),
  SHA-256 `7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0`. Ubuntu's
  `fonts-liberation` 2.1.5-3 differs in one glyph outline (U+25D5).

| File                         | SHA-256                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| `DejaVuSans.ttf`             | `7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954` |
| `DejaVuSans-Bold.ttf`        | `e6476c1b80502924294eed40894c5b18e06c181444ca953e5334262df9c27724` |
| `DejaVuSansMono.ttf`         | `b4a6c3e4faab8773f4ff761d56451646409f29abedd68f05d38c2df667d3c582` |
| `DejaVuSansMono-Bold.ttf`    | `bce60f1b4421acd9ea51ba6623d7024ecbe6817a953e3654df62a5e6bdf8f769` |
| `DejaVuSerif.ttf`            | `42d1edeb7952f31b1f96d767ed7030b08a39e0c372b0071641518864e2bffb51` |
| `DejaVuSerif-Bold.ttf`       | `c47b5527bcdc8dcf9ea8c77054454c5a884beaca2f44851a2a823ee639cbf07f` |
| `LiberationSans-Regular.ttf` | `76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8` |

`tools/e2e/test/fonts.test.mjs` checks each file against this table.

## Licences

The files are used by the test harness only and are not part of any Vimma package.

- `DejaVu-LICENSE` is the DejaVu release's licence file (SPDX
  `Bitstream-Vera AND LicenseRef-Public-Domain`): the Bitstream Vera licence, the Arev fonts'
  licence (the same terms) for the glyphs taken from Arev, and the DejaVu changes in the public
  domain. It allows copying and redistributing the fonts with that notice.
- `Liberation-LICENSE` is the Liberation release's licence file, the SIL Open Font License 1.1
  (`OFL-1.1`), which allows redistributing the fonts with the licence, bundled with other
  software.

## Updating

Download the new release, check its checksum against a second source (a mirror or a
distribution's package), replace the files, update the table, run
`npm test -- tools/e2e/test/fonts.test.mjs`, then the e2e scenarios against CI's baselines.
