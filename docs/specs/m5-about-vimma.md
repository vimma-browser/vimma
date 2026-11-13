# Spec: m5-about-vimma

Status: implemented · Milestone: M5 · Area: `src/browser/base/content/vimma/about/`
(new), `config/ConfigHost.sys.mjs`, `ui/theme-host.mjs`, `host/VimmaHost.sys.mjs` (two lines),
`core/cmdline.mjs`, `core/report.mjs` (new), `tools/version-files/`

Plan §4 ("Operate: about:vimma shows mode, last 20 key events, active overrides, config errors,
upstream Firefox version and patch count; `:bug` writes a redacted report") and §6 (M5:
"errors in status bar + about:vimma").

## User stories

- As a user, `about:vimma` (typed, or `:about` / `:vimma`) shows Vimma's and Firefox's versions,
  the build ID and channel, the upstream patches the build carries, each window's mode, the last
  20 keys and what each did, my config file's state and errors with file:line, the bindings with
  my overrides marked, the theme source and its last error, my workspaces with tab and pane
  counts, and whether the control socket is on. It is read-only; `r` (page reload) or Refresh
  reads everything again; `j` / `k` scroll it.
- As a user filing a bug, `:bug` copies the same as text, without URLs, page titles or paths
  under my home directory, so I can paste it into an issue.

## Design

- **The URL.** Firefox's about: pages are a C++ table (`AboutRedirector.cpp`); adding to it needs
  a patch. Instead `about/AboutVimma.sys.mjs` registers an `nsIAboutModule` factory for
  `@mozilla.org/network/protocol/about;1?what=vimma` through the component registrar at runtime,
  as `BrowserTestUtils.registerAboutPage` does (`testing/mochitest/BrowserTestUtils/content/
content-about-page-utils.js`), once per process from `vimma.js`. **No upstream patch.**
  `newChannel` opens `chrome://browser/content/vimma/about/about.html` with the caller's load
  info and sets `originalURI`, so the URL bar keeps `about:vimma`. Flags: `ALLOW_SCRIPT |
IS_SECURE_CHROME_UI`; no `URI_*_IN_CHILD` flag, so it loads in the parent process with the
  system principal its chrome channel carries (as about:preferences does); no
  `URI_SAFE_FOR_UNTRUSTED_CONTENT`, so web pages cannot link to it. Only the parent registers
  it: content processes never resolve it.
- **The page.** `about.html` (CSP: chrome: scripts, styles and fetches only) and `about.mjs`
  call `AboutVimma.collect(window)` and render with `textContent` only (config errors and
  workspace names are the user's text). Theme tokens through `ThemeHost.attachDocument`, as the
  start page. The content actor's `about:*` match puts it in normal mode, so `j` / `k` / `gg`
  work and `r` is `page.reload`, which re-reads everything.
- **Sections** (`AboutData`, typed in `AboutVimma.sys.mjs`):
  - Version: `MOZ_APP_VERSION_DISPLAY`, `appinfo.version`, `appinfo.appBuildID`,
    `MOZ_UPDATE_CHANNEL`.
  - Upstream patches: `chrome://browser/content/vimma/about/patches.json`, written by
    `tools/version-files/version-files.mjs` (`patchManifest`: every `src/**/*.patch`, sorted, with
    its `@@ -` hunk count) into the git-ignored `src/browser/config/vimma/` during `npm run
import`, and packaged by `jar.mn`. So the list is the one the build was imported from.
    `tools/upstream/patch-audit.py` stays the full audit (sizes, ADR-003 register).
  - Modes: `VimmaHost.status(win).mode` for each window (`BrowserWindowTracker`).
  - Last key events: `about/key-log.mjs`, a 20-entry ring buffer. The host's `_dispatch` records
    each key with core's `describeOutcome` (the action id, `pass`, `cancel`, `…` pending); a
    replayed key is recorded once, by the dispatch that handles it. A plain key in insert or
    command mode is stored as `·`, never as typed. The host change is one import and one line.
    (Since changed: the log is `host/key-log.mjs`, in the folder of the host that writes it,
    ADR-026.)
  - Config: `ConfigHost.path`, `ConfigHost.file` (new: `pending`, `missing`, `read`), the schema
    of the config in force, `ConfigHost.errors` through `formatConfigError` (file:line), and
    core's `bindingTable(ConfigHost.keymap)` (new accessor) with overridden rows marked `*`.
  - Theme: `ThemeHost.status` (new): the source, the Omarchy directory, the last check's state
    (`pending`, `builtin`, `missing`, `loaded`, `rejected`), the `colors.toml` mtime, the last
    rejected file's errors and the applied theme's warnings; plus Omarchy's `theme.name`, the
    theme directory's sibling.
  - Workspaces: the store's count; this window's workspaces from `WindowWorkspaces.model` with
    tab counts, and panes from `PaneViews` (the shown tree, or the parked one).
  - Control socket: `vimma.control.enabled` and `VimmaControl.port`. The token is never read.
- **`:bug`.** `:about` (alias `:vimma`) and `:bug` are `tab.new` with fixed text (a new
  `CommandDef.text`), so they need no new action and no host runner: `about:vimma` and
  `about:vimma#bug`. On `#bug` the page copies `AboutVimma.report(data)` with
  `nsIClipboardHelper`: plain text, the binding table reduced to the overrides, through core's
  `redactReport` (every `scheme://…` becomes `<url>`, `$HOME` becomes `~`). The page has a
  "Copy redacted report" button for the same.

## Tests (written first)

`tests/browser/browser_vimma_about.js`: the URL opens the page (URL kept, title); the versions,
build ID and channel; the patch count equals the number of `src/**/*.patch` in the checkout
(found through the test file's symlink) with one row each; `:about` opens and selects it; a broken
temp config shows its path and `path:4` with the key; a good one shows `loaded`, schema 2 and one
overridden row; the workspace count and the last three keys after `j k j` on a page
(`j → scroll.down`…) and the window's mode; with the control socket on, its port shows and the
token (from the discovery file) is nowhere in the page's HTML; `:bug` puts a report on the
clipboard with the Firefox version and no `$HOME/` path or URL; `j` / `k` scroll the page.
Vitest: `report.test.mjs` (redaction, outcomes), `cmdline.test.mjs` (`:about`, `:vimma`, `:bug`,
no argument), `version-files.test.mjs` (`patchManifest` on fixtures and on the repository).

Red: the mochitest timed out in its first task (`about:vimma` unknown; "The window unloaded while
we were waiting for the browser to load"); vitest `Cannot find module '../src/report.mjs'`,
`:about` → `{ kind: "error" … }`, `patchManifest` not a function. Green: 41 checks in the
mochitest, the whole `tests/browser/` suite (2120 passed, 0 failed). Mutation check: rendering the
patch count + 1 fails `the patch count is the number of src/**/*.patch - "11" == "10"`; reverted.

## Limits

- Read when opened; not live (`r` or Refresh). Registered by the first window's `vimma.js`: a
  session restore that loads an `about:vimma` tab before that shows an error page until reloaded.
- The key log sees what `_dispatch` sees: keys the goto picker, the `/` search input and the help
  filter take never reach it; an ambiguous key resolved by its timeout shows as `…`.
- `:bug` copies to the clipboard; it writes no file and opens no issue. Workspace names stay in
  the report (they are the user's labels, not page titles).
- `patches.json` is as of the last `npm run import`; a build imported without it says so in the
  section.
