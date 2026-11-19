# Spec: content-color-scheme

Status: implemented · Area: `packages/vimma-core/src/theme.mjs` (`themeStylesheet`,
`tokensToCss`), `src/browser/themes/shared/vimma/firefox-chrome.css` · Upstream patches: none ·
ADR: none

Builds on [theme-appearance](theme-appearance.md) and [m5-omarchy-theme](m5-omarchy-theme.md),
which are implemented and unchanged by this spec except where they say so.

## Summary

Web pages see the colour scheme Vimma shows. While Vimma's theme follows the system, pages follow
the system, as in Firefox. When the theme is fixed dark or light (`:theme dark`, `:theme light`,
`[theme] appearance`, `[theme.colors] mode`, or an Omarchy theme, which is always one of the
two), a page's `prefers-color-scheme` is that scheme too. Firefox's own Settings → Website
appearance still decides when it is set to Dark or Light.

## Problem

Vimma colours its own chrome from the theme's `--vimma-color-scheme`, but web pages took their
`prefers-color-scheme` only from Firefox's content preferences, which follow the system. So:

- `:theme light` on a dark desktop turned the status bar, toolbar and menus light while every
  site with a dark mode stayed dark; `:theme dark` on a light desktop did the reverse.
- On Omarchy, a dark Omarchy theme with no desktop portal answering (or a portal that reports a
  different scheme) gave dark chrome around light pages, and a light theme the reverse.

## Behaviour

1. With the built-in palette following the system (`appearance` `system`, the default), a page's
   `prefers-color-scheme` is the system's and changes with it, live.
2. With `:theme dark` or `:theme light` (or `[theme] appearance`), a page sees that scheme,
   whatever the system's. A tab opened afterwards sees it too; an open page switches without a
   reload. `:theme system` hands pages back to the system.
3. With an Omarchy theme showing, a page sees the theme's mode: dark for a theme with
   `mode = "dark"`, light for one with `mode = "light"` or a `light.mode` file.
4. `[theme.colors] mode` pins the chrome's scheme (theme-appearance B2), and so pins the pages'.
5. Firefox's Settings → General → Website appearance set to Dark or Light
   (`layout.css.prefers-color-scheme.content-override` `0` or `1`) wins over all of the above.
   Set back to Automatic (`2`, the default), the rules above apply again, live.
6. Under forced colours (a high-contrast system setting), Firefox's own choice stands.

## Research

Checked against the Firefox 158.0 source in `engine/`:

- A top-level page's `prefers-color-scheme` is, first, an override set on its browsing context
  (DevTools' simulation), then its embedder's preferred scheme
  (`layout/base/nsPresContext.cpp:948-956`, `RecomputeBrowsingContextDependentData`, and
  `dom/base/Document.cpp:21237-21250`, `Document::PreferredColorScheme`), and only without either
  the content preference (`layout/style/PreferenceSheet.cpp:213-223`).
- The embedder's preferred scheme comes from the `<browser>` element's own `color-scheme`
  (`layout/generic/nsSubDocumentFrame.cpp:747-772`, `MaybeUpdateEmbedderColorScheme`, which runs
  whenever that element's style changes). Firefox sets it for tab browsers to
  `env(-moz-content-preferred-color-scheme)`
  (`browser/themes/shared/tabbrowser/content-area.css:384-386`), the content preference, so a
  page follows Settings → Website appearance (`content-override`), then
  `browser.theme.content-theme`, then the system (`PreferenceSheet.cpp:141-150`).
- `browser.theme.content-theme` is written by `LightweightThemeConsumer` on every theme update
  (`toolkit/modules/LightweightThemeConsumer.sys.mjs:494-536`): `2` (system) for the default
  theme. A value Vimma wrote there would be overwritten at the next update.
- Chrome style sheets can test an integer pref with `@media -moz-pref("name", value)`
  (`servo/components/style/queries/condition.rs:611-655`), and the query is re-evaluated when the
  pref changes (`layout/style/GeckoBindings.cpp:1604-1653`, a pref callback per queried pref).
- Without a desktop portal (Xvfb, CI), the GTK widget code takes the system scheme from
  `ui.systemUsesDarkTheme` (`widget/gtk/nsLookAndFeel.cpp:1732-1745`); the tests use it.

## Design

The token sheet `ui/theme-host.mjs` injects into every window gains one token,
`--vimma-content-color-scheme`, present only when the theme's scheme is fixed. A rule in
`firefox-chrome.css` (loaded into every window by `ThemeHost.init`) sets the tab browsers'
`color-scheme` to it, falling back to Firefox's own value when it is absent:

```css
@media -moz-pref("layout.css.prefers-color-scheme.content-override", 2) and (not (forced-colors)) {
  #tabbrowser-tabpanels browser[type="content"]:not([smartwindow-content]) {
    color-scheme: var(
      --vimma-content-color-scheme,
      env(-moz-content-preferred-color-scheme)
    ) !important;
  }
}
```

Decisions:

1. **Vimma's fixed scheme wins over the system for pages.** When the theme is fixed dark or
   light, pages get that scheme, because a fixed appearance is a setting for the whole window, and
   a light page inside dark chrome (or the reverse) is what fixing it is meant to avoid. On Omarchy,
   `omarchy-theme-set` sets the desktop's scheme from the same theme, so the two agree whenever
   the portal answers; where it does not, the theme on screen is the better guide. Rejected:
   leaving pages on the system's scheme, because `:theme` then changes only half the window.
2. **Firefox's Website appearance wins over Vimma when set to Dark or Light**, because it is the
   one setting that is only about web pages, so setting it is the more specific choice. Its
   Automatic value hands the decision to Vimma, as it hands it to the Firefox theme in Firefox.
3. **A theme that follows the system sets nothing**, so the built-in palette in its default
   `system` appearance leaves pages exactly as Firefox has them, including a Firefox theme's own
   content scheme (`content-theme`).
4. **Through the `<browser>` element's `color-scheme`, not a pref**, because it applies live in
   every window, needs no script, and writes nothing to the profile. Rejected:
   `browser.theme.content-theme`, because `LightweightThemeConsumer` overwrites it on every theme
   update and it would stay in `prefs.js` after the theme changed; `content-override`, because it
   is the user's own Settings choice; `BrowsingContext.prefersColorSchemeOverride`, because it
   is the DevTools simulation and outranks Settings, so it would break decision 2.
5. **The token comes from core's `themeStylesheet`**, which already knows whether the sheet is
   fixed (one block) or adaptive (a light block under `@media`), so the host needs no new state.
   `tokensToCss` accepts it only as `dark` or `light`, as it does `--vimma-color-scheme`.
6. **Forced colours keep Firefox's choice**, because Firefox then derives the scheme from the
   forced background (`PreferenceSheet.cpp:208-214`), and overriding it could put dark text on a
   dark forced background.

## Security and privacy

No new surface. The token is a fixed keyword (`dark` or `light`) produced by core and validated
by `tokensToCss`; nothing a page can set reaches it. A page learns its colour scheme through
`prefers-color-scheme` as it does in Firefox; it can now differ from the system's when the user
fixed it, which tells a site no more than the scheme itself.

## Tests

- **Vitest** (`theme.test.mjs`): a fixed appearance (`dark`, `light`), a light
  Omarchy theme and a pinned `[theme.colors] mode` emit `--vimma-content-color-scheme` with the
  theme's mode; the adaptive built-in (`system`, absent, the Omarchy fallback) does not;
  `tokensToCss` rejects any value other than `dark` or `light`.
- **Mochitest** `browser_vimma_content_color_scheme.js`: on a page styled by
  `prefers-color-scheme`, checked by `matchMedia` and by the page's computed background: the
  system's dark and light pass through; `:theme light` on a dark system and `:theme dark` on a
  light one reach the open page and a new tab, and `:theme system` hands it back;
  `[theme] appearance = "light"` does the same; a dark Omarchy theme on a light system and a
  light one (`light.mode`) on a dark system reach the page; Website appearance Light wins over
  `:theme dark`, Dark over `:theme light`, and Automatic restores Vimma's choice.
- **Screenshots** (artifact build, Xvfb, Omarchy theme prefs, Website appearance Automatic): a
  page styled by `prefers-color-scheme` under the maintainer's dark Omarchy theme with the system
  light (dark page), and under Omarchy's `catppuccin-latte` with the system dark (light page).

## Docs and changelog

- `docs/guide.md`, Colours and themes: web pages follow the theme's dark or light, and
  Website appearance overrides it.
- `CHANGELOG.md`: a `fix(theme)` line.

## Delivery

One PR: the token, the rule, the tests and the guide.

## Open questions

None.
