# Spec: first-run-setup

Status: draft · Area: core (`packages/vimma-core/src/setup.mjs`, new; `actions.mjs`,
`cmdline.mjs`), chrome (`src/browser/base/content/vimma/setup/`, new: `setup.html`,
`setup.mjs`, `SetupHost.sys.mjs`; `config/ConfigHost.sys.mjs`, `about/AboutVimma.sys.mjs`,
`jar.mn`), theme (`src/browser/themes/shared/vimma/setup.css`, new) · Upstream patches: none ·
ADR: none

Issue: [#378](https://github.com/vimma-browser/vimma/issues/378)

## Summary

On the first run of a new profile, Vimma offers a short setup page with two steps: add the
add-ons the user usually runs, and choose the default search engine. Every step is optional and
driven from the keyboard; `esc` leaves at once and changes nothing. The same page can be opened
again later.

## Problem

A new profile starts with no add-ons and with the search engine that Firefox's search
configuration picks for the region and locale. A content blocker and a familiar search engine
are what most people set up first. Today that means addons.mozilla.org (AMO) in a tab, Firefox's
install and permission prompts, and the search section of Settings, or learning the `[search]`
section of `config.toml` before the browser is usable. Vimma disables Firefox's own onboarding
(below), so nothing points the user at either.

## Behaviour

1. On the first start of a profile, the first window opens the setup page in its first tab. A
   later start of the same profile **must not** open it again, whether the user finished or
   skipped it.
2. The page **must** be skippable at once: `esc` or `q` on any step, or the **Skip** button,
   closes the tab and leaves the start page. Skipping **must not** change any pref, engine or
   add-on, apart from recording that the setup was offered.
3. Step 1, add-ons. A list of add-ons, each with its name, author, a one-line summary and its
   user count. `j`/`k` move, `space` marks or unmarks, `/` focuses the search field, `enter`
   in the field searches, `esc` in the field returns to the list. `enter` on the list goes to
   step 2. Marking installs nothing.
4. Step 2, search engine. The engines installed in the profile, the current default marked.
   `j`/`k` move, `enter` chooses and goes to the summary.
5. Summary. What will happen: the add-ons to install, the engine to set. `enter` applies,
   `esc` goes back. Each add-on then shows Firefox's standard permission prompt; declining it
   skips that add-on only. The page reports each result (installed, declined, failed) and
   closes with `enter`.
6. Nothing is applied before the summary is confirmed. Closing the tab or the window at any
   earlier point **must** leave the profile as it was.
7. Offline, or when AMO does not answer within 10 s, step 1 shows the curated list with a
   one-line notice, and step 2 works as usual.
8. `:setup` opens the page again in a new tab, with the same steps; about:vimma links to it.
   No key is bound by default.
9. The page follows Vimma's theme (Omarchy colours when `vimma.theme.source` is `omarchy`,
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

Pending the answers in Open questions: where add-ons come from (1), where the engine choice is
stored (2), how the page appears (3), the curated list (4) and how the setup is re-run (5).

### Workspaces, containers and agents

Add-ons are installed per profile, not per workspace or container: an add-on installed here
runs in every workspace, including the agent workspace. The setup page says so on step 1. The
search engine is likewise one default for the profile.

## Security and privacy

- **Only AMO, only signed.** Installs come only from the curated table or AMO search results
  that pass decision 4; signatures stay required by the build (Research). The curated table
  pins each add-on's GUID and slug, and an AMO answer whose `guid` differs for that slug is
  dropped.
- **Explicit consent, twice.** Nothing installs without the user marking it, confirming the
  summary and accepting Firefox's permission prompt. Vimma **must not** answer the prompt.
- **Network.** Opening step 1 sends one request to `addons.mozilla.org` for the curated
  entries' current files (option (a) of question 1 adds one per search). The request carries
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

## Tests

vitest, `packages/vimma-core/test/setup.test.mjs`:

- `skip from any step plans nothing`
- `the summary lists marked add-ons and the chosen engine`
- `an AMO result off addons.mozilla.org or without a sha256 hash is dropped`
- `a curated slug answered with another guid is dropped`
- `installed add-ons cannot be marked`
- `the step keys move, mark and go back`

Mochitest, `tests/browser/browser_vimma_setup.js`:

- `first_run_opens_setup_once`
- `automation_and_config_path_skip_setup`
- `esc_changes_no_pref_engine_or_addon`
- `closing_before_summary_changes_nothing`
- `summary_sets_the_default_engine`
- `install_shows_the_permission_prompt` (AMO answered by a local test server, signing in
  automation as Firefox's own add-on tests do)
- `offline_shows_the_curated_list`
- `agent_role_cannot_open_setup`
- `colon_setup_opens_the_page`

e2e: `setup-page` scenario, screenshots of each step with the Omarchy and light themes.

## Docs and changelog

- `docs/guide.md`: a "First run" section, `:setup` in the command list, the add-on section.
- `docs/security.md`: A1 as above.
- `CHANGELOG.md`: "Added: a skippable first-run setup for add-ons and the default search engine
  (`:setup`)".

## Delivery

1. The page, `vimma.setup.offered`, the search step, the summary and `:setup`; step 1 absent.
2. Step 1 with the curated list and installs; `docs/security.md` A1; security review.
3. AMO search in step 1 (if question 1 keeps it).

## Open questions

1. **Where do add-ons come from?** (a) A live AMO search, with the curated list shown before
   anything is typed and as the offline fallback: any add-on is reachable; one request per
   search. (b) The curated list only: no search requests; anything else still needs AMO in a
   tab. (c) AMO search only: no list to maintain; an empty screen until something is typed.
   Recommendation: (a), because the public API needs no key and returns the signed file's URL
   and hash, so the search is feasible and costs little.
2. **Where is the search engine choice stored?** (a) `SearchService.setDefault` only, as a
   choice in Settings would be; `config.toml` is never written, and a `[search] default` in it
   still wins. (b) Written as `[search] default` into `config.toml`: the file stays the source
   of truth, but Vimma edits a file the user may manage elsewhere. (c) Both. Recommendation:
   (a), because Vimma does not edit an existing `config.toml` (`docs/security.md` F1).
3. **How does the setup appear on first run?** (a) As the first window's first tab, with the
   start page behind it. (b) As an overlay on the start page. (c) Not shown; the start page
   names `:setup`. Recommendation: (a), because a tab is closed the usual way, gets the page keys users
   already know and can be opened again by URL; an overlay needs its own focus and dismissal rules.
4. **Which add-ons are on the curated list?** (a) uBlock Origin only. (b) uBlock Origin,
   AdGuard AdBlocker and Privacy Badger, all AMO "Recommended". (c) (b) plus password managers
   such as Bitwarden. Recommendation: (b), because the list is about content blocking and
   anything else is one search away.
5. **How is the setup run again?** (a) A `:setup` command, no key. (b) A link in about:vimma.
   (c) Both. Recommendation: (c), because neither changes the default keys.
