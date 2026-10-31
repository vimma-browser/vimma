# Spec: start-page

Status: implemented · Area: UI (`src/browser/base/content/vimma/start/`,
`src/browser/themes/shared/vimma/start.css`)

## User story

As a Vimma user, a new window and a new tab show a Vimma start page: the mint brushstroke logo
centred, and one line under it with the keys to start from (`ctrl+b ?` keys · `:` commands ·
`f` hints). The URL bar is empty and focused, so I can type an address at once; and from the page
itself `:` and `ctrl+b ?` work as on any page. It renders at once and has nothing to scroll.

As a Vimma user, the start page also tells me which Vimma I run, and on which Firefox: a quiet line
at the bottom, `Vimma 0.1.0 · Firefox 157.0.1`, smaller than the key hint, with the Firefox part
quieter still.

## Scope

- **Asset.** The Vimma logo (`Mint Brushstroke V Browser Logo.png`, 1254×1254), resized to 512 px
  and stripped of metadata with ImageMagick (`magick … -strip -resize 512x512`), 82 KB, at
  `vimma/start/vimma-logo.png`. `docs/assets/vimma-logo.png` (the README's) stays. The page
  no longer shows that file itself: it is the source of the two masks below.
- **Logo colours.** The logo is drawn in the theme's colours: the window+V mark and the
  brushstroke V in `--vimma-accent`, the "imma" wordmark white under a dark theme and
  `--vimma-fg` under a light one. White is the artwork's own colour and reads on every dark
  background; on a light background it would vanish, and the text colour is the theme's choice
  for legible text there. The markup is `<div class="vimma-logo" role="img" aria-label="Vimma">`
  with two `aria-hidden` spans, each a box filled with one colour through a CSS `mask-image`
  (`themes/shared/vimma/logo.css`, `chrome://browser/skin/vimma/logo.css`). The masks,
  `vimma/start/vimma-logo-mark.png` and `vimma/start/vimma-logo-wordmark.png` (353×291, cropped to
  the artwork), come from `vimma-logo.png` with `tools/branding/logo-masks.sh` (ImageMagick): the
  parts are split by HSV saturation (the mint is saturated, the wordmark white), and coverage is
  the source alpha times brightness, so the brush texture survives on any background. Masks
  instead of recoloured copies of the image: a theme can have any accent, and the colour is a CSS
  value, so the theme host's live rewrite of the tokens recolours the logo with no script (an
  Omarchy theme change, `:theme`, `[theme] appearance`). Dark or light is
  `--vimma-color-scheme`, the signal the content colour scheme and every other surface use,
  through `light-dark()` with `color-scheme` set on the logo. The dark tile the logo had under a
  light theme, for its white wordmark, is gone. With forced colours both parts are `CanvasText`
  (`forced-color-adjust: none`, or the backgrounds would be forced to `Canvas` and the logo would
  vanish). Gecko supports unprefixed `mask-image` (Firefox 53), so no `-webkit-` form is needed.
  about:vimma shows the same logo at the head of the page, 3 rem tall, with `img-src chrome:`
  added to its CSP for the masks. The app icons (`configs/branding/vimma/logo*.png`) keep their
  fixed colours, and so does Firefox's About dialog: it is a window of its own that the theme
  host does not reach, its logo a background image in `aboutDialog.css`; masking it would need
  the theme host to theme that window first.
  (Since changed: the brand moved from mint to aqua, `#2cf5d2`. `vimma-logo.png` is the same
  artwork with its hue turned 20 degrees (`magick … -modulate 100,100,111.1`), which keeps each
  pixel's brightness and HSV saturation, so `logo-masks.sh` derives byte-identical masks and the
  page itself does not change; the app icons and the About dialog show the aqua logo.)
- **The page:** `chrome://browser/content/vimma/start/start.html`, registered in our `jar.mn`.
  Mechanism chosen after grepping the engine: Firefox's own blank new tab and blank home page are
  the chrome page `chrome://browser/content/blanktab.html` (`AboutNewTabRedirector`,
  `HomePage.get`, `home-startup.mjs`), so a chrome page in a tab is a supported path. An
  `about:vimma-start` would need an `AboutRedirector` patch or a runtime `nsIAboutModule`
  registration, and a `resource:` page cannot use our chrome theme module. It loads in the parent
  process, with a CSP that allows only `chrome:` scripts and images, and `chrome:` or inline
  styles. Its one script (`start.mjs`) sets the theme tokens from `core/theme.mjs` as the status
  bar does; `start.css` (`chrome://browser/skin/vimma/start.css`) falls back to the same built-in
  values, so the first paint has them. Logo `27.6vmin` wide (the artwork's share of the 40vmin
  square the padded image filled); hint in
  `--vimma-fg-dim` with the keys in `--vimma-fg`; background `--vimma-bg`. No animation.
- **Version line:** a `<footer>` under `<main>`, `position: fixed` at the bottom centre, so the logo
  and hint stay where they were and nothing scrolls. `start.mjs` fills in `#vimma-version` from
  `AppConstants.MOZ_APP_VERSION_DISPLAY` and `#firefox-version` from `Services.appinfo.version`;
  nothing is hardcoded. Per spec m0-app-version these are `surfer.json`'s
  `brands.vimma.release.displayVersion` (`tools/version-files` writes it to `version_display.txt`,
  configure's `MOZ_APP_VERSION_DISPLAY`, what `vimma --version` prints) and its `version.version`
  (`MOZ_APP_VERSION`, the Firefox version). Text in `--vimma-fg-dim` (a text token, readable on
  every surface; no opacity), `0.75rem` for the line and `0.9em` for the Firefox part. Plain text,
  so a screen reader reads it in the footer landmark.
- **Home page:** default pref `browser.startup.homepage` in `firefox-branding.js`. New windows
  open it while `browser.startup.page` is 1 (Firefox's default) or 3 (M3's session restore,
  `BrowserContentHandler.getNewWindowArgs`); at startup it shows with 1, or when nothing is
  restored. Settings → Home changes it, and "Restore Defaults" brings ours back.
- **New tab:** `AboutNewTab.newTabURL` is in memory only, so `start/StartPage.sys.mjs` sets it
  once per app (from `vimma.js`) while the pref `vimma.startpage.newtab` (default `true`) is on,
  and resets it live when the pref goes `false`. It never replaces an extension's override
  (`newTabURLOverridden` with another URL); when that extension goes, `newtab-url-changed`
  brings ours back. Private windows get it too (Firefox uses an overridden new-tab URL there).
- **URL bar:** the page is `BROWSER_NEW_TAB_URL`, so `isInitialPage` and `isBlankPageURL` treat
  it as Firefox's new tab: empty URL bar, focused on open. `StartPage.init` also adds it to each
  window's `gInitialPages` for a home page opened with the new-tab override off.
- **Vimma keys:** the content actor's `matches` include the page's URL, so it is in normal mode
  (without the actor the host keeps a page in insert, and `:` would not open the command line).
  `f` finds nothing to label; `j`/`k` have nothing to scroll.
- **No upstream patch.**

## Tests (written first)

`tests/browser/browser_vimma_start_page.js`:

- A new tab (`BrowserCommands.openTab`) loads the start page; the logo is there with a size and
  the accessible name `Vimma`; the hint is there; the URL bar is focused and empty; typing
  a URL and Enter navigates.
- The default home page is the start page, and with `browser.startup.page` = 1 a new window
  opens it with an empty URL bar.
- On the page, normal mode: `:` opens the command line, `ctrl+b ?` the help overlay.
- The footer says `Vimma <MOZ_APP_VERSION_DISPLAY> · Firefox <appinfo.version>`, the two differ,
  it is in the hint's colour, smaller than the hint (the Firefox part smaller still), below the
  logo and in view, and the page still does not scroll. Red before the version line:
  `start.mjs has filled in the version` timed out.

- The logo has no background in either scheme (no tile, no box).

`tests/browser/browser_vimma_logo_theme.js` (Logo colours), on the start page and about:vimma:
under a dark theme the mark's computed `background-color` is the theme's accent (and the page's
`--vimma-accent`) and the wordmark's is white; switched live to a light theme, the mark is the
new accent and the wordmark the theme's `--vimma-fg`; back to dark, white again. Both parts are
masked by their PNGs, the logo is `role="img"` named `Vimma` with its parts hidden. With
`browser.display.document_color_use` = 2 (forced colours) both parts are `CanvasText`. Red before
the change: `the page has the logo - timed out` on both pages.

Red before the implementation: `"about:newtab" == "chrome://browser/content/vimma/start/start.html"`
and a timeout waiting for the new tab. Mutation check: without the actor match, the keys task fails
(`"insert" == "normal"`, `: opens the command line`); reverted.

## Settled

- `browser.startup.page` stayed Firefox's 1 until M3 set it to 3.
- Settings → Home's "New tabs" menu (`browser.newtabpage.enabled`) does not change our override;
  `vimma.startpage.newtab` = `false` gives Firefox's new tab back (guide).
