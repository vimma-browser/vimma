# Spec: firefox-surfaces-theme

Status: implemented · Area: `ui/theme-host.mjs`,
`browser/themes/shared/vimma/firefox-chrome.css` (new),
`browser/themes/shared/vimma/firefox-pages.css` (new), `vimma/jar.mn`,
`tests/browser/browser_vimma_firefox_surfaces_theme.js` (new), `tools/test/chrome-css.test.mjs` ·
Upstream patches: none · ADR: none

Issue: [#227](https://github.com/vimma-browser/vimma/issues/227)

## Summary

The Firefox surfaces Vimma shows besides the toolbar follow the Vimma theme: the find bar, the
menu bar and every menu, the dialogs a page or Firefox opens, the print settings, and Firefox's
own privileged pages (Settings, Add-ons, Downloads, Troubleshooting, `about:config`,
`about:profiles`, `about:processes`). Under a dark Omarchy theme they no longer show Firefox's
light colours. It builds on [toolbar-toggle](toolbar-toggle.md) decision 21, which themed the
navigation toolbar, the URL bar and its suggestions and the arrow panels (permission prompts,
the downloads panel).

## Problem

With Vimma's theme dark, these Firefox surfaces stayed light (Firefox 158.0, the built-in Firefox
colours with the GTK Adwaita light theme):

- the find bar at the bottom of the page (`/` search);
- the menu bar (`F10`) and its menus, the page's context menu and every other XUL menu;
- a page's `alert()`, `confirm()` and `prompt()` dialog over the tab, and prompts that open as a
  window of their own (the "close tabs?" confirmation);
- `about:preferences` (with Firefox's mascot in its default-browser card), `about:addons`,
  `about:downloads`, `about:support`, `about:config`, `about:profiles`, `about:processes`, the
  dialogs Settings opens, and the print settings beside the print preview.

Their accent was Firefox's violet, not the theme's.

## Behaviour

1. The find bar is on `--vimma-bg-dark` with `--vimma-fg` text, its field on `--vimma-bg`, its
   border `--vimma-muted`, in the theme's colour scheme. (Since changed: the bar `/` opens is a
   floating prompt framed in `--vimma-muted` on every side, [m1-find](m1-find.md).)
2. Every `menupopup` (context menus, the menu bar's menus, the toolbar's drop-downs) is on
   `--vimma-bg-dark` with `--vimma-fg` text and a `--vimma-muted` border and separators; the
   active item is `--vimma-selection` with `--vimma-fg-bright` text; disabled items are
   `--vimma-fg-dim`. A page's `<select>` drop-down keeps the page's colours.
3. The menu bar is on `--vimma-bg-dark` with `--vimma-fg` text; the open menu is underlined in
   `--vimma-focus`.
4. A prompt over a tab, a prompt in a window of its own, and the dialogs Settings opens are on
   `--vimma-bg-dark` with `--vimma-fg` text; the main button is `--vimma-mode-normal` with
   `--vimma-mode-normal-fg` text, the others the text colour tinted.
   (Since changed: the import wizard Settings shows for Import browser data is such a dialog,
   bordered `--vimma-muted`; its list of browsers has a menu's surface, text and border
   (behaviour 2), the chosen browser on `--vimma-selection` with `--vimma-fg-bright`, and a
   hovered entry tinted with the text colour so that it stays apart from the chosen one. A
   hovered or pressed button that is not the main one is the text colour tinted on every page
   and dialog, where Nova tints it violet. The wizard in a window of its own (at startup or a
   profile refresh) and in Firefox View keeps Firefox's colours, as those documents are not
   themed. Issue [#905](https://github.com/vimma-browser/vimma/issues/905).)
5. Firefox's privileged pages listed in Summary, and the print settings, are on `--vimma-bg`,
   their cards on `--vimma-bg-dark` bordered `--vimma-muted`, their text `--vimma-fg` and
   `--vimma-fg-dim`, their links `--vimma-text-accent`, their accent (the selected category,
   checkboxes, toggles, primary buttons, the selected row) `--vimma-mode-normal` with
   `--vimma-mode-normal-fg` text. Every design token not mapped takes its light or dark value
   from the theme's colour scheme.
6. Settings' default-browser card shows its text and button without Firefox's mascot.
7. All of it follows a theme change (`omarchy-theme-set`, `:theme`) without reopening the surface.
8. With the system's high-contrast setting on (`prefers-contrast` or `forced-colors`), every
   surface keeps Firefox's own high-contrast colours.
9. Pages Firefox loads in a web content process (`about:logins`, `about:newtab`, error pages)
   and web pages are not touched.

## Research

Checked against the Firefox 158.0 source in `engine/` (`surfer.json`).

- The find bar paints `var(--toolbar-background-color)` and its field
  `var(--toolbar-field-background-color)`, with `-moz-dialogtext` text and, without Nova,
  `-moz-dialog` (`toolkit/themes/shared/findbar.css:27`, `:28`, `:32`). It is in the browser
  window's document, so a window author sheet reaches it.
- Menus take `--panel-background-color: Menu` and `--panel-text-color: MenuText`
  (`toolkit/themes/shared/popup.css:15-16`); the active item is `-moz-menuhover` with
  `-moz-menuhovertext` (`toolkit/themes/shared/menu.css:280-281`); on Linux the open menu bar
  item is underlined `AccentColor` (`menu.css:215`). The arrow panels are themed by
  `firefox-toolbar.css` already.
- The design-system tokens are declared on `:root` (and anonymous-content hosts) only, inside
  cascade layers, many as `light-dark()` pairs
  (`toolkit/themes/shared/design-system/dist/tokens-shared.css:8-11`, `tokens-brand.css`), so
  an unlayered author sheet on `:root` overrides them and shadow trees inherit the result.
  In-content pages read them through `toolkit/themes/shared/in-content/common-shared.css`: the
  primary button (`:265-271`) and the selected list row, `--color-accent-primary-selected` with
  `--text-color-accent-primary-selected` (`:769-773`).
- The privileged pages load in the parent process with the system principal: their about:
  entries have `IS_SECURE_CHROME_UI` and no `URI_MUST_LOAD_IN_CHILD`
  (`browser/components/about/AboutRedirector.cpp:68`, `:104`, `:137`;
  `docshell/base/nsAboutRedirector.cpp:97`, `:107`, `:179`, `:197`, `:207`). The window's sheets
  do not reach their documents, and their CSP refuses a `data:` style element, as for the
  sidebar's documents ([firefox-sidebar-theme](firefox-sidebar-theme.md)).
- A prompt over a tab, the print settings and Settings' dialogs are documents in a SubDialog
  `browser.dialogFrame`; SubDialog sets `subdialog` on the document's root after it loads
  (`toolkit/modules/SubDialog.sys.mjs:382`). A dialog with `subdialog` draws in-content buttons
  (`toolkit/content/widgets/dialog.js:56`); in a window of its own it draws native buttons from
  `button.css` (`dialog.js:82`) inside the `<dialog>`'s shadow root.
- The default-browser card is a `moz-promo` whose image is
  `chrome://global/skin/illustrations/kit-concerned.svg` or `kit-happy.svg`
  (`browser/components/preferences/main.js:469`, `:491`); its image box is
  `width: var(--promo-image-size)` (`toolkit/content/widgets/moz-promo/moz-promo.css:57`).
- With the system high-contrast setting (`ui.useAccessibilityTheme`), chrome documents and these
  pages match `prefers-contrast` (`layout/style/nsMediaFeatures.cpp:323-344`); content documents
  also match `forced-colors`.

## Design

`ThemeHost` (`ui/theme-host.mjs`) loads one more window sheet, `firefox-chrome.css`, next to
`firefox-toolbar.css`, and gives Firefox's own pages and dialogs the token sheet, `focus.css` and
`firefox-pages.css` as author sheets, as it does for the sidebar's documents. Both sheets point
Firefox's tokens at Vimma's inside `@media not ((prefers-contrast) or (forced-colors))`.

1. **Tokens, not per-element rules.** The sheets set Firefox's own tokens (`--toolbar-*`,
   `--panel-*`, the design-system tokens) and the colour scheme, and set a property directly only
   where Firefox paints a system colour (`-moz-dialog`, `-moz-menuhover`), because every widget
   reading a token then follows, including ones added in later Firefox versions. Rejected: rules
   per page and widget, because they break with each Firefox redesign.
2. **The colour scheme follows the theme.** Each surface gets `color-scheme:
var(--vimma-color-scheme)`, so that every token left unmapped takes its own light or dark
   value. Rejected: mapping every token, because most only need the right scheme.
3. **Surfaces as Vimma lays them out.** Pages are on `--vimma-bg` with cards on
   `--vimma-bg-dark`, as `about:vimma` is; dialogs, menus and the find bar are on
   `--vimma-bg-dark`, as the pickers and the status bar are, so the dialog stands off the page
   behind it.
4. **The accent is the normal-mode badge's pair.** `--color-accent-primary` and the primary
   button are `--vimma-mode-normal` with `--vimma-mode-normal-fg` text, as the arrow panels'
   main buttons are (`firefox-toolbar.css`), because that pair is chosen to be readable. Links
   are `--vimma-text-accent`, a text token whose contrast is checked.
5. **Which documents.** A document gets `firefox-pages.css` when it has the system principal and
   is (a) one of the parent-process about: pages listed in `THEMED_PAGES` in a `<browser>` of a
   themed window, (b) in a SubDialog frame of a themed window or of a themed page, or (c)
   `commonDialog.xhtml` in a window of its own while a window is themed. They are found through
   `document-element-inserted`, before they are styled, as the sidebar's documents are. The
   system-principal check is there so that no web page is ever touched. Rejected: every
   system-principal document, because DevTools and other chrome documents have their own
   themes.
6. **The mascot is hidden, not replaced.** `moz-promo` cards whose image is a
   `illustrations/kit-*` file get `--promo-image-size: 0`, because the image is Mozilla's
   branding and the card reads the same without it. Rejected: a Vimma image in its place,
   because the `src` is set in the card's shadow root and only a patch to `main.js` could change
   it.
7. **Native dialog buttons get an adopted sheet.** A prompt in a window of its own draws native
   buttons in the `<dialog>`'s shadow root, where `::part(dialog-button)` cannot select the
   default one, so one sheet is adopted into that shadow root (as the sidebar's trees get one)
   with the tinted and primary looks. It is decided by the window having no embedder, because
   the `subdialog` attribute arrives only after the document loads. (Since changed: the import
   wizard's list of browsers is a XUL `<panel>` in the `<migration-wizard>`'s shadow root, which
   the wizard's own sheet fills with the system's `Menu` colour, so a sheet is adopted into that
   shadow root as well, when the wizard asks for its state (`MigrationWizard:RequestState`),
   before its dialog shows. Issue [#905](https://github.com/vimma-browser/vimma/issues/905).)
8. **`<select>` drop-downs keep the page's colours.** `#ContentSelectDropdown > menupopup` is
   excluded, because it belongs to the page and Firefox fills it from the `<select>`'s own
   styles.
9. **Content-process pages are out of reach.** `about:logins`, `about:newtab` and error pages
   load in a content process, where `ThemeHost` has no document to attach to. Theming them
   needs a content actor and is not part of this spec.

## Security and privacy

No new surface: the change adds CSS to documents of Firefox's own front end, through the same
`windowUtils.loadSheetUsingURIString` author sheets used for the sidebar. No script runs in those
documents and nothing is read from them. The system-principal check keeps web pages out.
(Since changed: each themed page's window has one capturing `MigrationWizard:RequestState`
listener, added from the parent's own code, that reads only the event target's local name and
shadow root and adopts a constant sheet into a `<migration-wizard>`'s shadow root; it parses no
page content and restyles none of the wizard's status, error or permission messages. Issue
[#905](https://github.com/vimma-browser/vimma/issues/905).)

## Tests

- `tests/browser/browser_vimma_firefox_surfaces_theme.js`, `firefox_surfaces_follow_the_theme`:
  in the built-in palette dark and light and in a base-only Omarchy theme, the find bar
  (computed and painted, from a `drawSnapshot`), a menu and its active item, the menu bar, a
  tab-modal and a window-modal alert, and `about:preferences`, `about:addons`,
  `about:downloads`, `about:support`, `about:config` (tokens, text, and the canvas painted from
  a `drawSnapshot`), and the hidden mascot.
- Same file, `high_contrast_keeps_firefox_colours`: with `ui.useAccessibilityTheme` the find bar
  and `about:preferences` keep Firefox's colours.
- `tests/browser/browser_vimma_firefox_wizard_theme.js` (since added, #905): the import wizard's
  dialog, text, buttons, checkboxes and list of browsers in the same three themes and after it
  is reopened, and Firefox's colours with high contrast. The wizard reads only Firefox's test
  migrator.
- `tools/test/chrome-css.test.mjs`: every Firefox text-colour token the sheets set
  (`--*text-color*`, `--*link-color*`, `--*icon-color*`, `--*icon-fill*`) is set to a Vimma
  text token whose contrast `packages/vimma-core/test/a11y.test.mjs` checks.

## Docs and changelog

- `docs/guide.md`, "Colours and themes" and "Features at a glance": the surfaces that follow the
  theme, the hidden mascot, high contrast, and the content-process pages that do not.
- `CHANGELOG.md` [Unreleased]: Firefox's find bar, menus, dialogs and settings pages follow the
  theme.

## Delivery

One PR: the two sheets, the `ThemeHost` changes, the tests and the guide.

## Open questions

None.
