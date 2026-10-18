# Spec: first-run-setup

Status: accepted · Area: core (`packages/vimma-core/src/setup.mjs`, new; `toml.mjs`,
`actions.mjs`, `cmdline.mjs`), chrome (`src/browser/base/content/vimma/setup/`, new: `setup.html`,
`setup.mjs`, `SetupHost.sys.mjs`; `config/ConfigHost.sys.mjs`, `about/AboutVimma.sys.mjs`,
`jar.mn`), theme (`src/browser/themes/shared/vimma/setup.css`, new) · Upstream patches: none ·
ADR: none

Issue: [#378](https://github.com/vimma-browser/vimma/issues/378)

## Summary

On the first run of a new profile, Vimma shows a short welcome screen with its logo that asks
whether to set things up now. `enter` starts a setup with two steps: add the add-ons the user
usually runs, and choose the default search engine. `esc` skips and leaves nothing configured. The chosen engine is written to
`config.toml`, which stays the source of truth for Vimma's settings.
Every step is optional and driven from the keyboard, and the setup can be opened again later.

## Problem

A new profile starts with no add-ons and with the search engine that Firefox's search
configuration picks for the region and locale. A content blocker and a familiar search engine
are what most people set up first. Today that means addons.mozilla.org (AMO) in a tab, Firefox's
install and permission prompts, and the search section of Settings, or learning the `[search]`
section of `config.toml` before the browser is usable. Vimma disables Firefox's own onboarding
(below), so nothing points the user at either.

## Behaviour

1. On the first start of a profile, the first window shows the welcome screen: the Vimma logo,
   a one-line tagline and two buttons, **Set up** (`enter`, focused) and **Skip** (`esc`). A
   later start of the same profile **must not** show it again, whether the user set up,
   skipped or closed it.
2. **Skip**, `esc` or `q` on the welcome screen closes it and leaves the start page; nothing is
   configured. The setup steps start only after **Set up**. On any later step, `esc` or `q`
   (outside a text field) or the **Skip** button leaves the same way. Skipping **must not**
   change any pref, engine, add-on or `config.toml`, apart from recording that the setup was
   offered.
3. Step 1, add-ons. The curated list is shown first; each add-on has its name, author, a
   one-line summary and its user count. `/` focuses the search field and `enter` in it searches
   AMO; the results replace the list, and an empty search brings the curated list back. `j`/`k`
   move, `space` marks or unmarks, `esc` in the field returns to the list. `enter` on the list
   goes to step 2. Marking installs nothing.
4. Step 2, search engine. The engines installed in the profile, the current default marked
   (the `[search] default` of `config.toml` when it names one).
   `j`/`k` move, `enter` chooses and goes to the summary.
5. Summary. What will happen: the add-ons to install, the engine to set. `enter` applies,
   `esc` goes back. `config.toml` is written first (decision 9), then each add-on then shows Firefox's standard permission prompt; declining it
   skips that add-on only. The page reports each result (installed, declined, failed) and
   closes with `enter`. When `config.toml` does not parse, the summary shows a notice naming the
   file and line, writes nothing to it and still installs the add-ons.
6. Nothing is applied before the summary is confirmed. Closing the tab or the window at any
   earlier point **must** leave the profile as it was.
7. Offline, or when AMO does not answer within 10 s, step 1 shows the curated list with a
   one-line notice that search is unavailable, and step 2 works as usual.
8. `:setup` opens the setup again in a new tab, starting at the welcome screen; about:vimma
   links to it.
   No key is bound by default.
9. The welcome screen and the steps follow Vimma's theme (Omarchy colours when `vimma.theme.source` is `omarchy`,
   otherwise the light or dark built-in theme), like the start page.
10. Neither the control socket nor an MCP agent can open, read or drive the page.

## Research

All Firefox paths are in Vimma's engine tree at Firefox 158.0 (`surfer.json`,
`engine/config/milestone.txt`).

- **Firefox's onboarding is off.** `src/browser/branding/vimma/pref/firefox-branding.js` sets
  `startup.homepage_welcome_url` and `startup.homepage_override_url` to `""`, which
  `browser/components/BrowserContentHandler.sys.mjs:868` reads to choose the first-run page.
  `browser.aboutwelcome.enabled` stays `true` (`browser/app/profile/firefox.js:2209`), but with
  an empty welcome URL about:welcome is never opened. Vimma has no welcome screen of its own;
  new windows and tabs show the start page (`start/StartPage.sys.mjs`, spec
  [start-page](start-page.md)).
- **Vimma already detects a profile's first run.** `config/ConfigHost.sys.mjs` keeps
  `vimma.config.firstRunDone` (line 50) and skips its first-run work when another config file is
  in force, when that pref is set, or when `Cu.isInAutomation` is true (`firstRunBlocked`).
- **Search engine.** `[search] default` in `config.toml` is applied by
  `search/SearchHost.sys.mjs` with `SearchService.setDefault(engine, CHANGE_REASON.USER)`
  (`toolkit/components/search/SearchService.sys.mjs:193`). The file wins on every apply, so a
  default set elsewhere lasts until the next start or edit of the file while `default` is set
  (spec [search-engines](search-engines.md), decision 7). Without `default`, the profile's
  choice stands. The engines Firefox ships for the user's region and locale come from
  `getAppProvidedEngines()` (line 466); all visible engines, including add-on and user ones,
  from `getVisibleEngines()` (line 445). The commented template in
  `packages/vimma-core/src/defaults.mjs` shows `[search] default = "DuckDuckGo"`.
- **Add-on signing.** `toolkit/moz.configure:2011-2022` turns `MOZ_REQUIRE_SIGNING` on for
  release and beta milestones; Vimma builds the 158.0 release milestone, so signatures are
  required and `toolkit/mozapps/extensions/internal/AddonSettings.sys.mjs:32` makes
  `REQUIRE_SIGNING` a constant outside automation (`xpinstall.signatures.required` cannot turn
  it off). AMO-hosted files are signed by Mozilla's root and install, as the guide's add-on
  section relies on (`docs/guide.md`, "Add-ons").
- **Installing from AMO.** `AddonManager.getInstallForURL(url, options)`
  (`toolkit/mozapps/extensions/AddonManager.sys.mjs:1787`) takes a `hash` option, and
  `installAddonFromAOM(browser, uri, install)` (line 2631) checks enterprise policy and then
  sends `webextension-permission-prompt` (line 3418), which `browser/modules/ExtensionsUI.sys.mjs`
  (lines 73, 212) turns into Firefox's standard permission doorhanger. This is the path
  about:addons' discovery pane uses.
- **AMO's search API.** `GET https://addons.mozilla.org/api/v5/addons/search/?q=<terms>&app=firefox&type=extension&sort=users`
  needs no key or account. Checked against the live API: each result has `guid`, `slug`,
  `name`, `summary`, `authors`, `average_daily_users`, `promoted` (for example
  `{"category": "recommended"}`) and `current_version.file` with `url` (an `.xpi` on
  addons.mozilla.org) and `hash` (`sha256:…`). Firefox itself uses the v4 and v5 API for add-on
  metadata (`extensions.getAddons.get.url` and `extensions.getAddons.browserMappings.url` in
  `browser/app/profile/firefox.js:40,45`).
- **Curated candidates.** Checked on AMO's `api/v5/addons/addon/<slug>/`: uBlock Origin
  (`uBlock0@raymondhill.net`), AdGuard AdBlocker (`adguardadblocker@adguard.com`) and Privacy
  Badger (`jid1-MnnxcxisBPnSXQ@jetpack`) are all "Recommended" for Firefox.
- **Vimma's network stance.** Vimma uploads no telemetry (`docs/security.md` P1). Requests to
  AMO for add-ons and their updates are kept as in Firefox (`docs/guide.md`, privacy table).
- **Vimma never installs add-ons today.** `docs/security.md` A1, enforced by
  `never installs an add-on` in `tools/security/test/chrome-source.test.mjs`, which fails on
  any `getInstallForURL` or `installAddonFromAOM` in Vimma's chrome code.

## Design

`setup.html` is a chrome page in the parent process, like the start page, registered as
`about:vimma-setup` the way `about/AboutVimma.sys.mjs` registers about:vimma. `setup.mjs` draws
it and handles its keys; `SetupHost.sys.mjs` does the AMO requests, the installs and the search
change. `packages/vimma-core/src/setup.mjs` holds the pure parts: the step state machine, the
curated table, validating and filtering AMO results, and the summary plan.

1. **Shown once per profile.** A pref `vimma.setup.offered` is set when the page is first
   opened, before any step, so a crash or a closed window never shows it twice. It is skipped
   under `Cu.isInAutomation` and when `vimma.config.path` is set, as `ConfigHost`'s first run
   is, so that tests and managed setups start clean.
2. **Nothing applies before the summary.** Steps only collect choices; the summary applies them,
   so that skipping or closing at any point leaves nothing half-configured. Rejected: applying
   each step as it is left, because a later `esc` would then leave part of the setup done.
3. **Add-ons install through Firefox's AMO path.** `getInstallForURL(file.url, { hash })`
   followed by `installAddonFromAOM`, so that signature checks, enterprise policy and the
   standard permission prompt are Firefox's own and unchanged. Each install waits for the
   previous one, so that one prompt is shown at a time.
4. **AMO results are filtered.** A result is offered only if its `type` is `extension`, its file
   URL is `https` on `addons.mozilla.org`, and it has a `sha256` hash, so that the install can
   only fetch a file AMO signed and named. Add-ons already installed are shown as such and
   cannot be marked.
5. **Search engines offered.** Step 2 lists `getVisibleEngines()`, the app-provided engines for
   the user's region first, because those are the engines the build ships and the user can
   pick without adding anything.

6. **Add-ons come from a live AMO search, with the curated list first.** Step 1 opens on the
   curated list and searches AMO's public API on `enter`; offline or after a 10 s timeout it
   keeps the curated list. Because the API needs no key and returns the signed file's URL and
   hash, any AMO add-on is reachable at the cost of one request per search, and the curated list
   keeps the step useful before anything is typed and without a network. Rejected: the curated
   list only, because any other add-on would still need AMO in a tab; AMO search only, because
   the step would be an empty screen until something is typed.
7. **A welcome screen asks first; the setup is opt-in.** The first run shows only the welcome
   screen, and the steps start after **Set up**, so that a user who wants to browse at once
   leaves with one key and nothing changed, and the first thing a new profile shows is Vimma
   itself rather than a form. Rejected: opening step 1 directly, because it asks for choices
   before the user has agreed to make any; showing nothing and naming `:setup` on the start
   page, because most users would never find it.

8. **A Vimma page in the first tab.** The welcome screen and the steps are one Vimma page,
   `about:vimma-setup`, opened as the first window's first tab with the start page behind it,
   because a tab is closed the usual way, gets the page keys users already know, follows Vimma's
   theme and can be opened again by URL. Rejected: Firefox's about:welcome, because its layout,
   keys and theme are Firefox's and it would have to be re-enabled (Research); an overlay over
   the start page, because it needs its own focus and dismissal rules.
9. **Choices are stored in `config.toml`.** The search engine, and any later setting the setup
   offers, is written to `config.toml` (`[search] default`), and the change is applied through
   `ConfigHost.reload()`, the path `:source` and `:route add` use, because the file is the
   source of truth for Vimma's settings and a default set only through
   `SearchService.setDefault` would be overridden by a `[search] default` already in the file
   (Research). Rejected: `SearchService.setDefault` only, because the file and the browser would
   then disagree; both, because the reload already applies the file.
10. **`config.toml` is edited in place, key by key.** A pure function in
    `packages/vimma-core/src/toml.mjs`, `setTomlKeys(text, edits)`, returns the new text or an
    error, because the edit can then be tested without a browser. smol-toml, vendored for
    parsing, has no comment-preserving writer, so the edit works on lines: it parses the text
    first (`parseToml`) and returns an error on a parse error; it finds the key's line with
    `locateKeys` and replaces only its value; a key that is missing goes after the last key of
    its table, and a missing table is appended at the end. Every other line, comment, blank
    line and the order of keys stays byte for byte, and the result is parsed again and must hold
    the new values and otherwise equal the old parse. A key that is not a plain one-line
    `key = value` in a `[table]` (a dotted key, an inline table, a multi-line value) is reported
    as an error, not rewritten, because the line edit cannot place it safely. No new dependency
    is needed. Rejected: re-serialising the parsed file, because comments and order would be
    lost.
11. **The write is atomic and never clobbers.** `SetupHost` reads the file, applies
    `setTomlKeys`, writes a temporary file created 0600 in the same folder and renames it over
    `config.toml`, as `VimmaControl`'s `writeDiscovery` does, so a crash leaves the old or the
    new file and never a partial one. The file's mode is kept. When the file is absent it is
    created as `createFromTemplate` does (0600 in a 0700 folder) with the setup's keys set in
    the template. A parse error, a key it cannot place, or a file changed between read and
    rename (its modification time is compared) writes nothing and shows a notice, because a
    broken or concurrently edited file is the user's to fix. When `vimma.config.path` names
    another file, that file is the one edited.
12. **Add-ons stay profile-wide and are not recorded.** Installed add-ons belong to the
    profile, as in Firefox, and nothing about them goes into `config.toml` or a pref, because
    add-ons are not Vimma settings and Firefox already keeps the list; a record would go stale
    as soon as an add-on is removed in about:addons.
13. **Curated list: uBlock Origin, AdGuard AdBlocker and Privacy Badger.** The table pins their
    GUIDs and slugs (Research), because all three are AMO "Recommended" content blockers and
    anything else is one search away. Rejected: uBlock Origin only, because it leaves no
    choice; adding password managers, because the list is about content blocking.
14. **Run again with `:setup` or from about:vimma.** `:setup` opens the page in a new tab and
    about:vimma links to it; no key is bound, because neither changes the default keys.

### Welcome screen

- **Layout.** One centred column on the page background: the logo mark and wordmark from the
  start page (`src/browser/base/content/vimma/start/vimma-logo-mark.png` and
  `vimma-logo-wordmark.png`, drawn as CSS masks by `src/browser/themes/shared/vimma/logo.css`
  so they take the theme's foreground colour), a one-line tagline under it, then the two
  buttons side by side with their keys shown (`enter` **Set up**, `esc` **Skip**). Reusing
  the start page's assets and mask keeps the logo identical across Vimma's pages and
  correctly coloured in every theme without new image files.
- **Logo size.** The mark at 96 px high, the wordmark beside it at the same height, because the
  screen holds nothing else to compete with and the start page's smaller logo would look lost
  in an empty window; it scales down with the window below 480 px wide.
- **Typography and colour.** Theme variables only (`setup.css` uses the same custom properties
  as `start.css`), so Omarchy, light and dark need no per-theme rules. The tagline is muted
  text; the focused button uses the accent colour.
- **Motion.** At most one short fade-in (150 ms) of the column on open, and none under
  `prefers-reduced-motion: reduce`, because the screen should feel calm and nothing on it moves
  afterwards.
- **Keyboard first.** **Set up** has focus on open, so `enter` and `esc` work without a click;
  both buttons are also reachable with `tab` and the mouse.

### Workspaces, containers and agents

Add-ons are installed per profile, not per workspace or container: an add-on installed here
runs in every workspace, including the agent workspace. Step 1 says so. The setup records
nothing about them (decision 12). The
search engine is likewise one default for the profile.

## Security and privacy

- **Only AMO, only signed.** Installs come only from the curated table or AMO search results
  that pass decision 4; signatures stay required by the build (Research). The curated table
  pins each add-on's GUID and slug, and an AMO answer whose `guid` differs for that slug is
  dropped.
- **Explicit consent, twice.** Nothing installs without the user marking it, confirming the
  summary and accepting Firefox's permission prompt. Vimma **must not** answer the prompt.
- **Network.** The welcome screen sends nothing. Opening step 1 sends one request to
  `addons.mozilla.org` for the curated entries' current files, and each search sends one more
  (decision 6). The request carries
  the search terms and nothing about the profile. The page says so before the first search.
  Offline, step 1 falls back as in behaviour 7 and nothing is retried in the background.
- **No agent or socket reach.** The control socket gets no command for the setup, the agent
  role's `open` **must** refuse `about:vimma-setup`, and the page acts only on trusted key and
  click events, so that no agent can install an add-on.
- **A1 changes.** `docs/security.md` A1 ("Vimma never installs an add-on") becomes: Vimma
  installs an add-on only from the setup page, from AMO, after the summary and Firefox's
  permission prompt. The `never installs an add-on` source test gets one allowed file,
  `setup/SetupHost.sys.mjs`. The implementing PR for installs updates `docs/security.md` and
  gets a review by a fresh agent before merging.
- **Writing a user file.** `docs/security.md` F1 ("an existing file is never overwritten")
  becomes: Vimma changes an existing config.toml only from `:route add` (append) and the setup
  summary (decisions 10 and 11), never on a parse error, atomically and keeping the file's
  mode. The implementing PR for the config write updates F1 with links to its tests and gets a
  review by a fresh agent before merging.

## Tests

vitest, `packages/vimma-core/test/toml.test.mjs` (`setTomlKeys`):

- `replaces only the value of an existing key, keeping comments and order`
- `adds a missing key after the last key of its table`
- `appends a missing table at the end`
- `a parse error returns an error and no text`
- `a dotted key, inline table or multi-line value is an error`
- `the result parses to the old file plus the new values`
- `a trailing comment on the edited line is kept`

vitest, `packages/vimma-core/test/setup.test.mjs`:

- `skip from any step plans nothing`
- `the summary lists marked add-ons and the chosen engine`
- `an AMO result off addons.mozilla.org or without a sha256 hash is dropped`
- `a curated slug answered with another guid is dropped`
- `installed add-ons cannot be marked`
- `the step keys move, mark and go back`

Mochitest, `tests/browser/browser_vimma_setup.js`:

- `first_run_shows_welcome_once`
- `welcome_skip_changes_nothing`
- `welcome_enter_starts_the_setup`
- `search_results_replace_the_curated_list`
- `automation_and_config_path_skip_setup`
- `esc_changes_no_pref_engine_or_addon`
- `closing_before_summary_changes_nothing`
- `summary_sets_the_default_engine`
- `summary_writes_search_default_and_reloads`
- `summary_creates_a_private_config_toml_when_absent`
- `summary_keeps_comments_and_mode_of_config_toml`
- `summary_writes_nothing_on_a_parse_error`
- `install_shows_the_permission_prompt` (AMO answered by a local test server, signing in
  automation as Firefox's own add-on tests do)
- `offline_shows_the_curated_list`
- `agent_role_cannot_open_setup`
- `colon_setup_opens_the_page`

e2e: `setup-page` scenario, screenshots of the welcome screen and of each step with the Omarchy
and light themes. The welcome screenshots are checked by eye for the logo's colour and size, the
tagline, the focused **Set up** button and the key hints in both themes before the baselines
are accepted; a run with `prefers-reduced-motion: reduce` checks that the screen appears without
the fade.

## Docs and changelog

- `docs/guide.md`: a "First run" section, `:setup` in the command list, the add-on section.
- `docs/security.md`: A1 and F1 as above.
- `CHANGELOG.md`: "Added: a skippable first-run setup for add-ons and the default search engine
  (`:setup`)".

## Delivery

1. `setTomlKeys` in `toml.mjs` with its vitest tests (decision 10); no user-visible change.
2. The page with the welcome screen, `vimma.setup.offered`, the search step, the summary with
   the atomic `config.toml` write (decision 11), `:setup` and the about:vimma link; step 1
   absent; `docs/security.md` F1; security review.
3. Step 1 with the curated list and installs; `docs/security.md` A1; security review.
4. AMO search in step 1 (decision 6).

## Open questions

None.
