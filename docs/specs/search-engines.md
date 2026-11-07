# Spec: search-engines

Status: implemented · Milestone: after M6a or alongside it, independent of it; no keymap
change · Area: `packages/vimma-core/src/search.mjs` (new), `config.mjs`, `defaults.mjs`,
`cmdline.mjs`; `search/SearchHost.sys.mjs` (new), `config/ConfigHost.sys.mjs`,
`host/tab-ops.mjs`, `host/VimmaHost.sys.mjs`, `about/AboutVimma.sys.mjs`, `jar.mn`. No upstream
patch.

## Goal

Set the default search engine, and use another engine for one search by typing an alias such as
`@google`, as Zen allows. Vimma does this with a `[search]` section in
`config.toml` with `default = "DuckDuckGo"` and `[search.aliases]` mapping short aliases to
installed engine names or to custom URL templates with `%s`
(`gh = "https://github.com/search?q=%s"`); `@alias query` works in Firefox's URL bar and in
Vimma's `:open` / `:tabnew`, and the aliases show in `:open` completion.

## User stories

- As a user, `[search] default = "DuckDuckGo"` makes DuckDuckGo the engine my searches go to,
  from the URL bar, `:open`, `:tabnew` and `p` / `P`, and the change applies within 2 seconds
  of saving, like the rest of `config.toml`.
- As a user, `[search.aliases] gh = "https://github.com/search?q=%s"` lets me type
  `@gh vimma` in the URL bar, or `:open @gh vimma`, and land on GitHub's results for "vimma".
- As a user, `[search.aliases] w = "Wikipedia (en)"` gives an engine I already have a short
  alias (`@w cats`); Firefox's own `@google`, `@ddg`, `@wikipedia` keep working everywhere,
  `:open` included.
- As a user, typing `:open @` and Tab lists the aliases I can use, with the engine each one
  searches.
- As a user, a typo (`default = "DuckDuckGoo"`) shows in the status bar and in `about:vimma`
  with its line, like any other config mistake, with "did you mean "DuckDuckGo"?", and the
  rest of my config still applies.
- As a user, deleting the `[search]` section gives me back what I had before: the engine I
  used before Vimma changed it, and no engines Vimma added.

## Research

All of this was read in this repo's `engine/` tree (the Firefox the build uses) and checked by
running it, not recalled.

- **Does `:open @google cats` work today? No.** `openUrl` (`host/tab-ops.mjs`) calls
  `openTrustedLinkIn(text, where, { allowThirdPartyFixup: true })`; `URILoadingHelper`'s
  `openInCurrentTab` turns that into `LOAD_FLAGS_ALLOW_THIRD_PARTY_FIXUP` and
  `LOAD_FLAGS_FIXUP_SCHEME_TYPOS`, and docshell runs `URIFixup.getFixupURIInfo` with
  `FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP`. `@google cats` has no scheme and no valid host, so
  `keywordURIFixup` calls `keywordToURI`, which has no alias step at all: it takes
  `SearchService.defaultEngine` (or `defaultPrivateEngine`) and submits the whole string.
  Verified with the build's own xpcshell (`obj-artifact`, search service initialised on a fresh
  profile, default Google):
  `"@google cats" -> https://www.google.com/search?client=firefox-b-d&q=%40google+cats`,
  `keywordAsSent: "@google cats"`; `@wikipedia cats` likewise goes to Google with the literal
  `@wikipedia`. So today `:open @google cats` searches the default engine for the text
  "@google cats". The installed engines there were Google (`@google`), Bing
  (`@bing`), DuckDuckGo (`@duckduckgo`, `@ddg`), Perplexity (`@perplexity`) and Wikipedia (en)
  (`@wikipedia`).
- **The URL bar** resolves aliases before fixup. `UrlbarProviderTokenAliasEngines` handles a
  search string starting with `@` (the list is `UrlbarSearchUtils.tokenAliasEngines()`: every
  engine alias starting with `@`, and `_aliasesForEngine` adds `@` to an alias without one), and
  enters search mode for that engine; `UrlbarProviderAliasEngines` makes any engine alias,
  `@` or not, the heuristic result. On Enter, `UrlbarUtils.getShortcutOrURIAndPostData(text)`
  splits off the first word, asks `SearchService.getEngineByAlias(word)` (case-insensitive over
  `engine.aliases`), and returns `engine.getSubmission(rest)`'s URL and POST data; failing that
  it looks the word up as a **Places bookmark keyword** (`PlacesUtils.keywords.fetch`) and
  substitutes `%s` (`KeywordUtils.parseUrlAndPostData`), with `mayInheritPrincipal` true.
- **Engines** (`toolkit/components/search`): `engine.aliases` is the user alias
  (`engine.alias`, one string, settable, persisted, what about:preferences calls "Keyword")
  plus the engine's defined aliases (`@google` for app-provided ones).
  `SearchService.addUserEngine({ name, url, alias, method, suggestUrl })` creates a `UserSearchEngine`
  (`loadPath "[user]"`, persisted in `search.json.mozlz4`, listed in about:preferences#search,
  removable there); `url` contains `{searchTerms}`; `UserSearchEngine.rename()` and
  `changeUrl()` edit one in place. `setDefault(engine, CHANGE_REASON.USER)` sets the default;
  `setDefaultPrivate` exists, and private windows use the normal default unless
  `browser.search.separatePrivateDefault.enabled` (false by default, `all.js`). Changes are
  announced on `browser-search-engine-modified` (`engine-added`, `engine-removed`,
  `engine-default`, …). `keywordToURI` only lets http(s) submissions through ("for security
  reasons").
- **Prior art for "set from a file":** the enterprise policy `SearchEngines`
  (`Policies.sys.mjs`) adds engines as `PolicySearchEngine`s at search init, `Remove`s by name,
  and sets `Default` with `SearchService.getEngineByName` + `setDefault(…, ENTERPRISE)`, wrapped
  in `runOncePerModification` so a user's later choice in Settings sticks until the policy value
  changes; a name it cannot find is a `reportFailure`, not a crash. Policy engines are not
  reachable from our code (`#addPolicyEngine` is private), so Vimma uses `addUserEngine`.
- **Zen** (no source checkout here; read from the installed Zen 1.23.1b, Firefox 157.0.1,
  `~/Downloads/zen`, by unpacking its `omni.ja`): its `UrlbarProviderTokenAliasEngines`,
  `UrlbarProviderAliasEngines`, `UrlbarSearchUtils` and `SearchService` contain no Zen code, so
  `@google cats` in Zen is Firefox's stock search mode. Zen sets the default engine in its
  welcome flow (`ZenWelcome.mjs`, `ZenSearchEngineStore.setDefaultEngine` →
  `SearchService.setDefault(engine, CHANGE_REASON.USER)`), hides the one-off buttons
  (`zen.urlbar.hide-one-offs`), and has no config file for engines: aliases and custom engines
  are about:preferences#search. What Zen offers is therefore Firefox's feature; Vimma
  has it already in the URL bar, and this spec adds the config file and `:open`.
- **Vimma today:**
  - `:open` / `:tabnew` (`page.open` / `tab.new` with text) go through `openOrSay` →
    `openUrl`. `p` / `P` classify the clipboard (`pageurl.mjs`) and send a search as
    `? text` so URIFixup searches it with the default engine. `t` (`tab.new`) and the start
    page use Firefox's URL bar. `vimma-ctl open` accepts only a valid http(s)/file/about URL.
  - Config: `config.mjs` validates a whole file purely (`reloadConfig`; applied whole or not at
    all), errors carry `path` and a line from `locateKeys`, `formatConfigError` makes
    `config.toml:3: path: message (did you mean "…"?)`, `ConfigHost` hands them to the status bar
    and `about:vimma`. Schema is 2; keys added since the bump (`[bookmarks]`, `[theme] name`)
    are listed in `SCHEMA_2_KEYS` without a new migration. `ConfigHost.apply` hands each part
    to its owner (`ThemeHost.setConfig`, `WorkspaceRouter.setRoutes`, …) on every change; the
    poll is every 2 s.
  - Completion: `completeCommandLine` completes a command's argument from `args` the host
    passes (`addon`, `workspace`) via `ARGUMENT_KINDS`; `:open` completes nothing today.
  - `:bookmark @name/` uses `@` for a workspace; that is `:bookmark`'s argument only, so no
    clash with `:open @gh`.

## Decisions

1. **Config shape** (schema 2, added to `TOP_KEYS` and `SCHEMA_2_KEYS`; no migration, no
   schema bump, as `[bookmarks]` did):

   ```toml
   [search]
   default = "DuckDuckGo"            # an installed engine's name, or "@alias" of a template below

   [search.aliases]
   gh = "https://github.com/search?q=%s"   # a custom engine: https:// or http:// with one %s
   w = "Wikipedia (en)"                     # an installed engine gets this alias
   ```

   Both keys are optional; the section absent means Vimma does nothing to search.

2. **Core validation** (`search.mjs`, pure, called by `config.mjs`; these errors are file
   errors, atomic like all others):
   - `[search]` allows only `default` and `aliases`; unknown keys get the usual "did you mean".
   - Alias keys: one optional leading `@` is dropped, then lowercased; must match
     `^[a-z0-9][a-z0-9._-]{0,31}$`. Two keys equal after that (`gh`, `"@GH"`) is an error.
     The alias you type is always `@` + key.
   - A value containing `://` is a template: it must start with `https://` or `http://`,
     contain `%s` exactly once, and parse with `new URL` once `%s` is replaced; anything else
     (`javascript:`, `file:`, no `%s`) is "must be an https:// or http:// URL with one %s, or
     an installed engine's name". `%s` becomes Firefox's `{searchTerms}`, so encoding is
     Firefox's (UTF-8, `+` for spaces), as for its own engines.
   - Any other value is an engine name: 1 to 100 characters, no control characters. Two
     aliases naming the same engine (case-insensitive) is an error: a Firefox engine has one
     user alias.
   - `default`: an engine name, or `@key` of an alias whose value is a template (so a SearXNG
     can be the default); `@key` of an unknown or non-template alias is an error.
   - `resolveSearch(config.search)` returns the default and the aliases sorted by alias, each
     either `{ alias, kind: "engine", name }` or `{ alias, kind: "template", url, host }`.
     `planSearch(previous, next, installed)` is the pure reconcile: given what Vimma applied
     last (decision 6), the new config and the installed engines
     (`{ id, name, aliases, hidden, managed }`), it returns the steps (create, update, remove,
     set alias, restore alias, set default, restore default) and the problems known only now
     (decision 9). Core imports nothing from Firefox.
3. **Custom templates become real Firefox engines.** For the URL bar to know `@gh`, it must be
   an engine's alias, so the host calls
   `SearchService.addUserEngine({ name, url, alias: "@gh" })` with no `suggestUrl` (decision 10). The name is the template's host (`github.com`); if
   another engine already has that name, `github.com (@gh)`. Vimma keeps such engines in step
   with the file: a changed template is `changeUrl`, a changed host is `rename`, a removed alias
   removes the engine. They show in about:preferences#search like any engine you added; an edit
   made there is overwritten at the next apply (the file wins, decision 7).
4. **Aliases on installed engines** set `engine.alias = "@w"` (the user alias; defined aliases
   like `@wikipedia` stay). The previous user alias is recorded and put back when the line goes.
   Aliases are stored with the `@`, so a bare word (`gh foo`) is never taken from the default
   engine: Firefox treats a non-`@` alias as a bare keyword too (`UrlbarProviderAliasEngines`).
5. **`:open` / `:tabnew` resolve aliases and bookmark keywords as the URL bar does.**
   A new async `openTyped` (`tab-ops.mjs`), used by `:open` and `:tabnew` only, calls
   `UrlbarUtils.getShortcutOrURIAndPostData(text)` after the `refusedScheme` check; `openUrl`
   stays synchronous for the opens that must not expand aliases (`p` / `P`, Vimma's own
   pages). When that returns a different URL (an engine alias, Vimma's or Firefox's own
   `@google`, or a Places bookmark keyword), Vimma checks the result with `refusedScheme`
   again (a keyword bookmarklet is a `javascript:` URL; refused with "blocked: javascript:
   and data: URLs can't be opened from the command line"), then
   `openTrustedLinkIn(url, where, { postData, inBackground: false })` without fixup. Otherwise
   it is today's path unchanged. Using Firefox's own function keeps one rule for both places
   and needs no alias table at run time. `mayInheritPrincipal` is ignored (we load with the
   system principal and never inherit). POST engines work: `postData` is passed through.
   `:open @gh` with no words opens the engine's empty search, as Firefox does. To search the
   default engine for a literal `@gh foo`, type `:open ? @gh foo` (URIFixup's `?` prefix).
   `p` / `P` do **not** expand aliases: clipboard text is data, not a command, and already goes
   as `? text`. `vimma-ctl open` is unchanged (URLs only).
6. **State Vimma keeps** in one pref, `vimma.search.applied` (JSON, per profile): the ids of
   engines it created with their alias; for each installed engine it gave an alias, the alias
   it set and the one it replaced; and, when it set the default, the engine id it set and the
   id that was default before. It is written after each successful apply. Each profile
   reconciles itself against the shared `config.toml`.
7. **When it applies, and who wins.** On the first window's config apply after
   `SearchService.init()` resolves, on every change of the file (poll, `:source`), and when
   engines change (`browser-search-engine-modified` `engine-added` / `engine-removed`, debounced
   500 ms, so an add-on's engine that loads late can be named). Each time, the file wins: if
   `default` is set and the default is not that engine, Vimma sets it
   (`CHANGE_REASON.USER`); a choice made in Settings therefore lasts until the next start or the
   next edit of the file. This is deliberate (a dotfile is the source of truth, as for
   `[theme]`); the guide says to delete `default` to manage it in Settings. Vimma does not
   fight Settings live: it does not observe `engine-default` and set it back.
8. **Removing lines.** `default` removed: the default goes back to the recorded previous
   engine, only if the current default is still the one Vimma set (a choice made in Settings
   since then is kept) and the previous engine still exists; else Firefox's choice stands.
   An alias removed: Vimma's engine is removed (`removeEngine`), or the installed engine's
   user alias is put back, if it is still the one Vimma set. The whole section removed: all of
   that. With no `[search]` and no recorded state, Vimma never touches search.
9. **Errors known only at apply time** (they depend on the profile's engines, so core cannot
   see them while reading the file): an engine name not installed or hidden ("no search engine
   named "DuckDuckGoo" (did you mean "DuckDuckGo"?)", suggestion by `closest` over the
   installed names; a hidden one says "is removed in Settings: Restore Default Search Engines
   there"), and an alias already used by an engine Vimma does not manage ("@google is already
   Google's alias"). They are `ConfigError`s with the path (`search.default`,
   `search.aliases.gh`) and a line from `locateKeys` over the same text, shown in the status
   bar and `about:vimma` as `config.toml:4: search.default: …`. Deviation from "whole or
   nothing": the rest of the file is already applied; only the failing entry is skipped (the
   previous default stays). They clear at the next apply that does not raise them.
10. **Privacy.** Engines Vimma creates have no suggestion URL, so typing `@gh foo` in the URL
    bar sends nothing until Enter; installed engines keep Firefox's suggestion settings
    (`browser.search.suggest.enabled`), unchanged. `:open` completion is local (decision 11)
    and never fetches suggestions. An `http://` template is accepted (a SearXNG on the LAN) but
    `about:vimma` marks it "queries sent unencrypted".
    (Since changed, issue #822: own pages first, because a Vimma user revisits their own pages
    more than they search; capped so search suggestions stay a few keys away. The address bar
    lists the matching open tabs, bookmarks and history before the engine's suggestions
    (`browser.urlbar.showSearchSuggestionsFirst` false in `firefox-branding.js`); Firefox's
    order put them after the suggestions, and `tab` stops on each row and on its menu button,
    so reaching a known page took many presses. With the pages first they get 4 of the 9 rows
    under the first one and the suggestions 5 (`UrlbarPrefs-sys-mjs.patch`, flex 4:5 instead of
    Firefox's 2:1), so the first suggestion is at most 8 presses of `tab` away; either side
    still fills the rows the other leaves empty, and the list keeps Firefox's 10 rows. The
    order stays the user's, in Settings > Search. The pages' group is headed Vimma instead of "Firefox Suggest"
    (`browser-ftl.patch`, ADR-003), so the list does not name Firefox; Settings keeps "Firefox
    Suggest" where it names Mozilla's service. Test: `browser_vimma_urlbar_suggestions.js`.)
    (Since changed, issue #822: `tab` skips each row's "…" result-menu button
    (`browser.urlbar.resultMenu.keyboardAccessible` false in `firefox-branding.js`), because
    Vimma is keyboard-first and the row menu is rarely needed; the first suggestion goes from 8
    presses of `tab` to 5, one per page row and then the suggestion. The menu stays on the mouse
    and right-click, `shift+delete` still removes the selected history row, and the menu's
    "Skip this menu when using the tab key" item turns the stop back on. Test:
    `browser_vimma_urlbar_suggestions.js`.)
    (Since changed, issue #834: Settings no longer says "Firefox Suggest" either; Vimma's generated
    `brandings.ftl` names the feature "Address Bar Suggestions", because Vimma ships it as its own
    feature; [firefox-surfaces-trim](firefox-surfaces-trim.md), decision 14.)
11. **Completion.** `ARGUMENT_KINDS` gains `open` and `tabnew` with names from
    `args.search`: the host passes every alias starting with `@` (Vimma's and Firefox's, from
    `UrlbarSearchUtils.tokenAliasEngines()`) with its engine's name as the description. It
    completes only while the argument is one word starting with `@`; the chosen candidate
    ends in a space (`open @gh `) so the words follow. Anything else completes nothing, as
    today.
12. **Private windows.** Aliases are the same (an explicit choice of engine). `default` sets
    the normal default only; with Firefox's separate private default off (the default) private
    windows use it too; with it on, the private default is left to Settings.
13. **Global, not per workspace.** One `[search]` for the profile, as Firefox has one default.
    A per-workspace default (`[workspaces.Work] search = "Kagi"`, used by `:open` and the URL
    bar in that workspace's tabs) is a later option and needs the URL bar's
    `keywordToURI` path to know the workspace; out of scope.
14. **about:vimma** gains a "Search" line: the default and whether it came from the config,
    each alias that applied with its engine, and the errors of decision 9. An alias the apply
    skipped (decision 9) shows only as its error, so the list never names an alias that does not
    work.
15. **Template and defaults.** `formatConfigTemplate` gains a commented `[search]` block (the
    example above, all commented) so the first-run file changes nothing; `defaults.toml` and the
    `defaults.test.mjs.snap` snapshot change for it (a changelog line says so).
16. **No upstream patch.** Everything is reachable from our modules: `SearchService`
    (`moz-src:///toolkit/components/search/SearchService.sys.mjs`) and `UrlbarUtils`
    (`moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs`). The new folder needs a line in
    our own `vimma/jar.mn` only.

## Sub-specs / acceptance

1. **Core** (`search.mjs`, `config.mjs`, `cmdline.mjs`, `defaults.mjs`): decisions 1, 2, 11, 15.
   Done when the Vitest cases below pass and `defaults.toml` is regenerated.
2. **Host** (`search/SearchHost.sys.mjs`, wired from `ConfigHost.apply` like `ThemeHost`):
   decisions 3, 4, 6 to 10, 12, 14. Done when `browser_vimma_search.js` passes.
3. **`:open` / `:tabnew`** (`tab-ops.mjs`, `VimmaHost.openOrSay`): decision 5. Done when the
   `:open` cases of `browser_vimma_search.js` and the existing `browser_vimma_cmdline.js` pass.
4. **Docs:** `docs/guide.md` gains a "Search engines" subsection under config.toml (the shape,
   `@alias` in the URL bar and `:open`, bookmark keywords, `? ` for a literal `@`, "the file
   wins; delete `default` to use Settings", what removing lines restores), the `[search]` key in
   "What applies live" and "Schema", and a `:open` line in "The command line". README's feature
   list gains "search engines and `@aliases` from config.toml". The maintainer adds the
   CHANGELOG [Unreleased] line at merge.

## Test plan

- **Vitest** `search.test.mjs` (written first, red pasted): alias normalisation (`gh`, `"@gh"`,
  `GH`; duplicates after it; bad characters, 33 characters); templates (one `%s`, none, two,
  `javascript:%s`, `file:///%s`, `ftp://`, an unparsable URL, `http://` accepted; `%s` →
  `{searchTerms}`; the host as name); engine names (empty, 101 characters, control
  characters, two aliases to one engine case-insensitively); `default` as a name, as `@key` of
  a template, as `@key` of an engine alias or unknown key (errors); unknown `[search]` keys
  with a suggestion; schema 1 file with `[search]` → "is new in schema 2"; error lines located.
  `planSearch`: first apply creates, sets aliases and default and records the previous ones;
  same config again → no steps; template changed → update, host changed → rename; alias
  removed → remove / restore; `default` removed with the default unchanged → restore, changed
  in Settings since → keep, previous engine gone → keep; name not installed / hidden → problem
  with suggestion; alias taken by an unmanaged engine → problem; a managed engine deleted in
  Settings → created again. `completeCommandLine("open @g", { args: { search } })` lists `@gh`
  and `@google` with descriptions; `open @gh foo` and `open example.com` complete nothing.
  `config.test.mjs` / `defaults.test.mjs`: the template block, snapshot re-recorded.
- **Mochitest** `tests/browser/browser_vimma_search.js` (listed in `browser.toml`; red before
  the host code, pasted): with a test config through `vimma.config.path` and a local
  `http://mochi.test` template, and a test engine added with `addUserEngine` standing in for
  "installed":
  - `default` sets `SearchService.defaultEngine`; `:open plain words` loads that engine's URL;
    removing the line restores the previous default; a default changed with `setDefault`
    between two applies is kept when the line is removed.
  - `[search.aliases]` creates the engine with alias `@t`, no suggest URL; it is gone after the
    line is removed; an installed engine gets `@w` and gets its old alias back.
  - `:open @t cats` and `:tabnew @t cats` load the template with `cats`; `:open @google cats`
    (a built-in alias) is covered by an add-on test engine with the defined alias `@vext`,
    since a mochitest may not connect to google.com; a POST test engine receives the body;
    `:open ? @t cats` searches the default engine for "@t cats".
  - A bookmark keyword `k` with `%s` works from `:open k x`; a keyword bookmarklet
    `javascript:` is refused with the notice.
  - URL bar: typing `@t cats` and Enter in `gURLBar` (`UrlbarTestUtils`) loads the template.
  - An unknown engine name shows `config.toml:N: search.default: …` in the status bar and in
    `about:vimma`, the rest of the config (a `[keys]` change in the same file) applies, and
    fixing it clears the error at the next poll.
  - A private window: `:open @t cats` works; `default` applies when the separate private
    default is off.
- **e2e:** none. The control socket cannot type into the URL bar, and `vimma-ctl open` takes URLs
  only; the mochitest covers both paths in the real browser.

## Out of scope

Per-workspace defaults (decision 13); a separate private default key; a table form for templates
(`{ url, name, post, suggest }`) for POST or suggestions from custom engines; importing Zen's or
Firefox's existing engines into `config.toml`; hiding or removing app-provided engines from the
file (the policy's `Remove`).

## Decided questions

1. **The file wins at every start** (decision 7), because `config.toml` is the source of truth.
2. **Private browsing's default** is not a separate `[search] private` key. Vimma's private
   workspace ([private-workspace](private-workspace.md)) lives in a private window, so decision
   12 covers it.
