# Spec: m2-statusbar-whichkey

Status: implemented · Milestone: M2 · Area: UI (`src/browser/base/content/vimma/ui/`,
`src/browser/themes/shared/vimma/`)

## User story

As a user, a one-line status bar at the foot of every window always shows my mode, the keys I
have pressed so far, `tab 2/5`, the tab's title (my rename once tab rename lands), its URL and
whether it is loading. On a narrow window it shortens the least important parts first and the
mode badge stays. After `ctrl+b` a which-key strip above the bar lists every key I can press
next with what it does; keys whose action is not built yet are greyed. It disappears when the
sequence completes, is cancelled, or I press `Esc`.

## Scope

- `ui/statusbar.mjs` (`StatusBar`, one per window, started by `VimmaHost.init` after the keys,
  in a `try`/`catch` like `TabStrip`): renders `renderStatusBar()` from vimma-core
  (`statusbar.mjs`, widths in `textwidth.mjs` columns) into `#vimma-statusbar`, and
  `whichKey()` into `#vimma-whichkey`.
- `browser/themes/shared/vimma/statusbar.css`, registered in our `jar.mn` as
  `chrome://browser/skin/vimma/statusbar.css` (as m0-help-overlay did).
- Theme tokens: until M5 wires the Omarchy adapter, `resolveTheme()` of the built-in theme
  (Tokyo Night, font `monospace`) through `tokensToCss()`, loaded once per window as an author
  sheet. Both elements colour themselves only from `--vimma-*` tokens.
- Host seam (additive, small): `VimmaHost.status(win)` → `{ mode, pending }`,
  `VimmaHost.onStateChange(win, fn)` → unsubscribe, and `VimmaHost.runnable()` → `RUNNABLE`
  (m2-tab-keys: `RUNNERS` ∪ `CONTENT_RUNNERS`, the help overlay's set too). The host emits after
  every keydown it sees, after a timeout flush (`_run`, then `_emit`), after a cancel/reset, and
  from `VimmaHost.onModeChange(browser, mode)` (m1-actor-insert-scroll) for the window owning
  the browser, so a focus report from a page moves the badge with no key pressed.
- Live updates: `TabSelect`, `TabOpen`, `TabClose`, `TabMove`, `TabAttrModified` (title, busy),
  the tabbrowser's location change (`onLocationChange` on the selected browser), host state
  changes, focus changes, and the bar's own size (`ResizeObserver`).

## Tests (write first)

`tests/browser/browser_vimma_statusbar.js`:

- The bar is visible at the bottom of the window, below `#browser`, with the mode badge.
- Mode: the host's mode (`NORMAL` on a page), `HELP` while `ctrl+b ?` is open, back after `Esc`.
  The badge's background is `--vimma-mode-<mode>`.
- Focusing a page input with no key pressed tells the host's listeners and shows `INSERT`, and
  the live region announces it; `Esc` brings back `NORMAL`.
- A font change at the same bar size (only the probe resizes) re-fits the segments.
- The not-implemented notice (m2-tab-keys) sits above the bar and is hidden while the strip is
  open.
- `tab n/N` after opening tabs and selecting another one.
- The title after a page loads, and the URL without its scheme.
- Width fitting: in a bar narrower than the content, the URL is dropped first and the mode stays.
- Fullscreen: DOM fullscreen hides the bar and `#browser` reaches the window bottom; on exit the
  bar and the layout come back.
- Browser fullscreen (`window.fullScreen`, as F11) keeps the bar.
- Accessibility: `role=status` with live updates only for the mode.

`tests/browser/browser_vimma_whichkey.js`:

- `ctrl+b` shows the strip and the `pending` segment `prefix` in the bar; it lists `c` with
  `new_tab`'s description and `?`.
- Greying follows `VimmaHost.runnable()` (`RUNNABLE`, the help overlay's source): `?` is
  runnable, every entry outside the set is greyed.
- A strip clipped by its max-height shows `…N more`, N being the entries outside it; none when
  everything fits.
- The strip hides after the second key, and after `Esc`.
- Nothing pending: no strip.

## Out of scope

Workspace, pane and config-error segments (M3, M4, M5 supply the inputs; core already renders
them); the Omarchy adapter and live theme switching (M5); tab rename itself (its own M2 spec);
screenshot baselines (the e2e harness).

## Settled (2026-10-09, from the engine tree)

- **Which-key strip dropped (2026-10-09).** The help overlay already lists every binding, so only
  `prefix+?` shows the bindings; `ctrl+b` alone shows just the pending keys in the bar. The strip,
  its CSS, `vimma-whichkey-open`, `VimmaHost.runnable()` and core's `whichkey.mjs` are removed;
  the notice hides when the overlay opens. The strip notes below are history.

- **Placement.** `#vimma-statusbar` is appended to the chrome `<body>` right after `#browser`.
  The body is a flex column (`browser-shared.css`), so the bar is the window's last row, under the
  sidebar and the content, and outside `#tabbrowser-tabbox`. Nothing upstream positions against
  it: the find bar, the devtools toolbox and M4's split view all live inside `#tabbrowser-tabpanels`
  and simply get one line less. No upstream patch. Customize mode (`:root[customizing]`) hides
  it, since `#browser` is replaced by the customization container there.
- **Which-key strip** is a child of the bar, `position: absolute; bottom: 100%`: it overlays the
  bottom of the content instead of resizing `#browser`, so a prefix press never reflows the page
  or changes `innerHeight`.
- **Fullscreen.** DOM fullscreen (`:root[inDOMFullscreen]`, a video or a page's
  `requestFullscreen`) hides the bar: the page asked for the whole screen and Firefox hides all its
  chrome there. Browser fullscreen (F11, `:root[inFullscreen]` alone) keeps it: it is the one line
  Vimma promises is always visible, and the toolbox already auto-hides. Kiosk mode follows F11.
- **Width.** Columns = `floor(bar content width / one monospace column)`, with the column
  measured from a hidden 10-character probe in the bar's font. The ResizeObserver watches the
  probe as well as the bar, so a font change (M5's `[theme] font`, zoom) re-measures even when
  the bar keeps its size. The font is `var(--vimma-font, monospace)`; M5's `[theme] font` replaces
  the token. The budget subtracts one column for each badge's padding (`0 0.5ch` both sides).
  The bar never wraps (`white-space: pre`, `overflow: clip`) even if a font draws a wide
  character wider than two columns.
- **Performance.** Every trigger only marks the bar dirty; one `requestAnimationFrame` renders.
  The width comes from `ResizeObserver` (no layout read in the render path), and the DOM is
  rebuilt only when the fitted segments differ from the last render. A keypress therefore costs
  the core calls and, while a sequence is pending, the strip. The strip's "…N more" hint reads
  layout only when its content or size changes (a rAF after a rebuild, and its ResizeObserver).
- **Bottom UI.** `statusbar.css` sets `--vimma-statusbar-height` on the root (20px; 0 in DOM
  fullscreen and customize mode). The notice (`notice.css`) sits that far plus 0.5rem above the
  window bottom, and hides while the root has `vimma-whichkey-open` (set by the strip), so the
  two never overlap.
- **Accessibility.** The bar is `role="status"` with `aria-live="off"`, so title and URL changes
  are not announced; a visually hidden child with `aria-live="polite"` holds the mode name and
  changes only when the mode does. The strip is plain text with
  `aria-label="Next keys"`; greyed entries carry `aria-disabled="true"`.
- **Runnable set.** `VimmaHost.runnable()` returns `RUNNABLE` from m2-tab-keys, the one set
  the help overlay dims by and the notice checks; there is no other definition.
- **Mode.** The bar shows `status(win).mode`: the focused page's mode (m1-actor-insert-scroll),
  `help` with the overlay open, `insert` in chrome fields. `onModeChange` finds the window with
  `browser.ownerDocument.defaultView`: `ownerGlobal` is the inner window, a different object
  from the WindowProxy `init()` keys its state by, so it never matched.
- **Title and URL.** Title is the browser's `contentTitle`, else the tab's label (lazy tabs,
  `New Tab`); the URL is `Services.io.createExposableURI(uri).displaySpec` (no credentials, IDN
  shown decoded), none for `about:blank`. Loading is the tab's `busy` attribute; Firefox exposes
  no page-load fraction, so the segment reads `loading`.
- **Tab labels.** `StatusBar` takes a `labelFor(tab)` option (default: none), which the tab
  rename spec fills from its label store; core's `displayLabel` already prefers it.
- **Typecheck.** `tools/sync-core.mjs` (Since changed: `sync-core.ts`, ADR-025) now also copies the
  vendored `smol-toml.d.mts` into the chrome copy of core (jar.mn packs only `*.mjs`), since
  `ui/statusbar.mjs` is the first chrome module to import `theme.mjs`, which reaches the vendored
  TOML parser.
- **Hardening (after #32 and #28 merged):** red for the new tests: 7 unexpected (no emit on
  a focus report, no re-measure on a font change, notice over the bar and the strip, no clipped
  hint). Green: both files 80/0.
- **Verified (artifact lane, first round):** red: 16 unexpected (no `#vimma-statusbar`, no
  `VimmaHost.status`/`runnable`, no strip). Green: both files 69/0; full `tests/browser/` 513
  expected, 0 unexpected, 2 skipped (artifact). Mutation: fitting to `columns + 40` instead of
  `columns - badges` fails "title fits in the narrow bar" (504 <= 209.8); reverted. The first
  version of that test only checked that the URL dropped, which the mutation survived.
