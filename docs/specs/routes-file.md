# Spec: routes-file

Status: implemented · Area: `packages/vimma-core/src/` (new `config/routes-file.mjs`: parse and
validate `routes.toml`, which file's rules are in force, the routes cache, and `:route add`'s
text for it; `config/config.mjs` for leaving out `config.toml`'s routes while `routes.toml` is
in force; `config/routes.mjs` for the appended block; `config/defaults.mjs` for the template's
routes comment); `src/browser/base/content/vimma/` (`config/ConfigHost.sys.mjs`: the poll, the
last good routes, `:route add`'s write; `workspaces/WorkspaceRouter.sys.mjs` for the cache;
`host/route-ops.mjs` for the message; `about/AboutVimma.sys.mjs` and `about/about.mjs` for each
rule's file and line); `docs/guide.md`; `docs/security/02-workspace-routing.md`,
`08-config-toml.md`, `12-agents-mcp.md` · Upstream patches: none · ADR: none

Issue: [#1444](https://github.com/vimma-browser/vimma/issues/1444)

Builds on [workspace-routing](workspace-routing.md) (the `[[routes]]` rules, `:route` and
`:route add`), [app-routes](app-routes.md) (`app` rules and `[routing] default_workspace`),
[m5-config-load](m5-config-load.md) (how `config.toml` is read) and
[bookmarks-file](bookmarks-file.md) (a file beside `config.toml`; its decisions are
"bookmarks-file DN" here). Engine paths are relative to `engine/` and were read in Firefox
160.0.1 (`config/milestone.txt`). Vimma paths are under `src/browser/base/content/vimma/` unless
they start with `packages/`, `tests/` or `docs/`; they were read at commit `a15af8e4`.

## Summary

Vimma reads `[[routes]]` rules and `[routing]` from `routes.toml`, a file beside `config.toml`,
when that file exists. `:route add` appends to whichever file holds the routes. A user can then
publish or share `config.toml` while keeping the list of sites and apps they route, which
changes often and says which services they use, in a private file.

## Problem

`[[routes]]` rules live in `config.toml` today, and `:route add` appends each new rule there
(`ConfigHost.sys.mjs` `appendRoute`). Two kinds of content then share one file:

- `config.toml` is mostly stable settings (keys, theme, workspaces) that people keep in a
  dotfiles repository, often public, and carry between machines.
- The routes are personal data that grows with every `:route add`: which sites a user signs in
  to for work, which chat and mail programs they run. A public dotfiles repository publishes
  them with the keys.

Bookmarks have `bookmarks.toml` for the same reason (bookmarks-file D1). Routes cannot go there,
because that file holds only `[bookmarks.<name>]` tables, and `config.toml` has no include
mechanism, so the only way to separate them today is to generate `config.toml` from pieces with
a script of one's own.

## Behaviour

Terms: the **routes file** is `routes.toml` when it exists, else `config.toml`. The **rules in
force** are the `[[routes]]` rules routing uses (`WorkspaceRouter.routes`).

### The file

1. `routes.toml` is read from the folder that holds `config.toml`'s path
   (`$XDG_CONFIG_HOME/vimma/` or `~/.config/vimma/`, or the folder of the `vimma.config.path`
   pref), whatever `config.toml` itself is or links to. It is in use when it exists; no setting
   turns it on. Vimma never creates it.
2. It holds `[[routes]]` tables, read with exactly the keys, values and validation they have in
   `config.toml` (`validateRoutes`, `resolveRoutes` in `config/routes.mjs`), and may hold a
   `[routing]` table with `default_workspace`. Any other top-level key is an error at its line:
   `routes.toml:<line>: <key>: routes.toml holds only [[routes]] and [routing]`. Only a regular
   file, or a symbolic link to one, is read: a FIFO, a folder or a link to nothing is an error
   (`not a regular file; not read`, `cannot be read`) and is never opened, so it cannot block
   the reads of `config.toml`. A file larger than 1 MiB is an error. An empty file is valid and
   has no rules.

   ```toml
   [routing]
   default_workspace = "personal"

   [[routes]]
   domain = "github.com"
   workspace = "work"

   [[routes]]
   app = "slack"
   workspace = "work"
   ```

3. When `routes.toml` exists, its `[[routes]]` are the rules in force and `config.toml`'s
   `[[routes]]` (tables or an inline `routes = [...]` array) are ignored, with one warning at
   their first line:
   `config.toml:<line>: routes ignored: routes.toml is the routes file`. They are not
   validated, since they do not apply; the rest of `config.toml` applies. Routes from both files
   are never merged.
4. When `routes.toml` exists, it owns all of `[routing]`: `config.toml`'s `[routing]` is left
   out, and a `default_workspace` there is ignored with a warning at its line:
   `config.toml:<line>: routing.default_workspace ignored: routes.toml is the routes file`.
   Without a `default_workspace` in `routes.toml`, none is set.
5. Errors in `routes.toml` show in the status bar as `routes.toml:<line>: <message>` and in the
   Browser Console, as `config.toml`'s are shown (`formatConfigError`). A file with an error is
   not applied at all: the rules and default workspace in force stay those of the last good read
   of `routes.toml`, while `config.toml` applies as usual. At a cold start, the last good read is
   the rules cached in the pref `vimma.routes.cache` (and `vimma.routes.defaultWorkspace`) when
   the cache says they came from `routes.toml`. When there is no such read, no rule applies
   until one succeeds: `config.toml`'s rules are not taken in its place, because the user has
   said they are not the routes file.
6. A missing `routes.toml` (never there, or deleted) makes `config.toml` the routes file again
   at the next read: its `[[routes]]` and `[routing]` apply as they did before this spec. A
   `git checkout` or similar that removes the file for a moment can therefore apply
   `config.toml`'s rules until the next read after it is back (one poll, 2 s by default).
7. An edit of `routes.toml`, by hand or by `git pull`, applies within about 2 seconds with no
   restart: it is checked on `config.toml`'s poll (`vimma.config.pollMs`, 2,000 ms by default),
   by the same stat signature. `:source` reads it at once along with `config.toml`.
   `:source <file>` loads that file as the config; `routes.toml` beside `config.toml`'s path is
   still the routes file when it exists, and the sourced file's `[[routes]]` and
   `default_workspace` are then ignored with the warnings of Behaviours 3 and 4; without
   `routes.toml`, the sourced file's rules apply, as today.

### `:route add`

8. `:route add [workspace]` appends its `domain` rule to the routes file: `routes.toml` when it
   exists, else `config.toml` (created from the template when missing, as today). The message
   names the file: `added: github.com → "work" (routes.toml)`. It never creates `routes.toml`
   and never moves rules between the files.
9. The rule is written through `ConfigHost`'s atomic writer (`writeFileNow`): a temporary file
   with the file's mode, renamed over the file or over the target of a symlinked file. Nothing
   is written when the file changed while the rule was computed
   (`<path> changed meanwhile; nothing written`). The appended block uses the file's line
   endings: a file with CRLF gets CRLF.
10. `:route add` refuses, with nothing written, when the routes file does not load now
    (`routes.toml does not parse now; fix it first`, or
    `config.toml does not parse now; fix it first (:config shows it)`) or would not with the
    rule. When the file cannot be written (a `config.toml` linked into a read-only store), it
    says so with the lines to add by hand:
    `:route add: cannot write config.toml (read-only?); add by hand: [[routes]] / domain = "github.com" / workspace = "work"`.
11. `:route add` is still reachable only from Vimma's own command line in a window with
    workspaces: a private window has none (`WindowWorkspaces` skips it,
    `workspaces/WindowWorkspaces.sys.mjs` line 318) and says `no workspaces in this window`; the
    control socket's agent role has no command for it (`AGENT_COMMANDS`,
    `packages/vimma-core/src/control/control.mjs`), and `agent-keys` cannot reach it
    (`AGENT_KEY_ACTIONS`, `packages/vimma-core/src/agent/agent-keys.mjs`, has no
    `workspace.route`). Neither can write `routes.toml` or `config.toml`.

### Showing the rules

12. about:vimma's Routing section (`:route`) shows each rule's file and line beside its number
    (`3 · routes.toml:12`), and with no rules says `No [[routes]] in routes.toml.` or
    `No [[routes]] in config.toml.`, naming the routes file. `:route add`'s "already goes to"
    message keeps naming the rule by its number.

## Research

Vimma at `a15af8e4`:

- `config/ConfigHost.sys.mjs`: `configPath()` gives `config.toml`'s path; `check()` stats it on
  a timer (`POLL_PREF` `vimma.config.pollMs`, `DEFAULT_POLL_MS` 2,000) and applies it whole with
  `reloadConfig`, keeping the last good config on an error (security 08 F2). `appendRoute`
  appends `appendRouteText`'s block to `config.toml` in place (`IOUtils.writeUTF8` with
  `mode: "append"`), or creates the file from the template, inside the one edit queue `edits`
  (bookmarks-file D11). `writeFileNow` is the atomic writer: a temporary file in the target's
  folder, given the file's mode before any text, a check that the file did not change
  meanwhile, then a rename, following a symlinked file to its target. `bookmarks.toml` is
  located the same way this spec locates `routes.toml` (`BookmarksFile.sys.mjs`,
  bookmarks-file Behaviour 1), and is read only when it is a regular file of up to 4 MiB.
- `workspaces/WorkspaceRouter.sys.mjs` lines 58 to 65: `vimma.routes.cache` and
  `vimma.routes.defaultWorkspace` keep the rules in force across restarts, so a cold start
  routes before `config.toml` is read.
- `packages/vimma-core/src/config/config.mjs`: `parseConfig` validates `[[routes]]` through
  `validateRoutes` (line 465) and `mergeWithDefaults` resolves them (`resolveRoutes`, line 1260)
  next to `routing.defaultWorkspace` (line 1261). `appendRouteText` (line 1453) refuses a file
  that does not parse now, or would not with the rule, and an inline `routes = [...]`; it writes
  `\n` line endings whatever the file uses.
- `host/route-ops.mjs` `addRoute` checks the rules in force for an earlier rule for the domain,
  then calls `HostServices.addRoute`, filled by `vimma.js` with `ConfigHost.addRoute` (security
  08 F4), and says `added: <domain> → "<workspace>" (config.toml)`.
- `about/AboutVimma.sys.mjs` `routesOf` lists `WorkspaceRouter.routes`; `about/about.mjs` shows
  `No [[routes]] in config.toml.` when there are none.
- bookmarks-file D9: a broken `bookmarks.toml` pauses the mirror both ways, and a missing one
  turns the file mirror off rather than falling back to inline tables that a move left behind.

## Design

Core gains `config/routes-file.mjs`:

- `parseRoutesFile(text)` → `{ routes, defaultWorkspace, lines, errors }`, with errors at their
  lines; it reuses `validateRoutes` and `resolveRoutes`, so both files accept exactly the same
  rules, and a `validateRouting` beside them in `config/routes.mjs`.
- `inlineRoutes(text)` → the first line of `config.toml`'s `[[routes]]` and of its
  `default_workspace`, for the warnings of Behaviours 3 and 4.
- `routesInForce({ config, configText, file })` → the rules, their file and lines, the default
  workspace and the warnings, from `routes.toml` when it exists, else from the config in force.
- `appendRouteFileText(text, rule)` → the block to append to `routes.toml`, or a refusal; the
  block comes from `routeBlockFor` in `config/routes.mjs`, which `appendRouteText` uses too, in
  the file's line endings.
- `formatRoutesCache(routes, file)` and `parseRoutesCache(text)` → the cache's text with the
  file its rules came from; an older cache, a bare array, holds `config.toml`'s rules.

`parseConfig` and `reloadConfig` take a `routesFile: boolean` option: when true,
`config.toml`'s `routes` and `routing` are left out before validation, so a stale rule there can
neither apply nor block the rest of the file. ConfigHost combines the config in force with the
last good `parseRoutesFile` result before handing it to `WorkspaceRouter`.

### Decisions

1. **A file beside config.toml, by presence.** Vimma reads `routes.toml` from the folder of
   `config.toml`'s path, not of a symlink's target, and uses it when it exists, as bookmarks-file
   D1 does for `bookmarks.toml`, because a dotfiles repository already holds that folder, a
   `stow`-style folder of links finds the file beside its link, and a file of its own can stay
   out of a shared repository (in `.gitignore`, or in a private one). A switch such as
   `[routing] file = true` was rejected, because the file's presence already says it and every
   profile without the file behaves exactly as before.
2. **One routes file, never merged.** When `routes.toml` exists it is the only source of rules,
   and `config.toml`'s `[[routes]]` are ignored with a warning at their first line, because
   rules match first-rule-first and their order across two files would be ambiguous: neither
   "config.toml first" nor "routes.toml first" is what every reader expects, and `:route add`
   would have to pick a file to append to. Rejected: an error for rules in both files, because
   a config error stops the whole `config.toml` from applying (m5-config-load), which is too much
   for a routing question; merging, for the reason above.
3. **routes.toml owns all of [routing].** Once `routes.toml` exists, `[routing]` is read only
   from it, and `config.toml`'s `default_workspace` is ignored with a warning, with no fallback,
   because `default_workspace` is routing data of the same kind as the rules (which workspace
   links from other programs open in, so which logins they meet), and one file deciding all of
   routing is simpler to read and to reason about than a per-key precedence. Rejected: taking
   `config.toml`'s value when `routes.toml` sets none, because a stale value left behind in
   `config.toml` would then keep applying unnoticed, against decision 2.
4. **The same rules, the same validation.** `routes.toml`'s tables are read by the same
   `validateRoutes` and `resolveRoutes`, so that moving a rule between files never changes what
   it means, and every routing guarantee (security 02 R6 to R10, 12 M24) holds whichever file
   holds it. Other top-level keys are errors rather than ignored, so that a setting pasted into
   the wrong file is noticed instead of silently doing nothing. Only a regular file of up to
   1 MiB is read, as for `bookmarks.toml`, because a FIFO would block the read, and with it every
   later read of `config.toml`, and the limit bounds the parse on the main thread; a file of a
   thousand rules is under 100 KiB.
5. **A broken routes.toml keeps the last good routes, the cache included.** A file with an
   error keeps the rules of the last good read of `routes.toml` while the rest of `config.toml`
   applies, because a typo in a rule should neither drop every rule (links would open in the
   wrong workspace, with its cookies) nor hold back an unrelated change to keys or theme. This
   is security 08 F2 applied to the routes file on its own. The routes cache records which file
   its rules came from, so that a cold start with a `routes.toml` broken since the last session
   keeps that file's last good rules rather than none. Falling back to `config.toml`'s rules was
   rejected, because they may be stale copies the user meant to retire.
6. **A missing routes.toml falls back to config.toml.** Deleting `routes.toml` makes
   `config.toml` the routes file again at the next read, because absence is how the user turns
   the feature off (decision 1), and an inline setup with one file must keep working. This
   differs from `bookmarks.toml`, whose absence turns its mirror off (bookmarks-file D9),
   because routing has no second state to pause: a link must open somewhere, and the rules of
   `config.toml` are the ones the user last kept there. The cost is that a moment without the
   file (a `git checkout` that removes it and puts it back) can apply `config.toml`'s rules for
   one poll; the guide says to remove or comment out the rules in `config.toml` once they are
   moved.
7. **:route add appends to the routes file only.** `:route add` appends to `routes.toml` when
   it exists and to `config.toml` otherwise, never creates `routes.toml` and never moves rules,
   so that every `:route add` changes exactly one file and needs no two-file write, and a
   `config.toml` that is a read-only link (a generated store) only refuses the one rule, with the
   lines to add by hand, instead of blocking a move. Creating `routes.toml` on the first
   `:route add` was rejected, because it would have to move `config.toml`'s rules (decision 2),
   which needs a write of both files that a read-only `config.toml` refuses and a crash can
   split. Users create `routes.toml` themselves, and the guide gives the steps.
8. **Written by the atomic writer.** `:route add` writes through `writeFileNow`, not an append
   in place, so that a file an editor saved while the rule was computed is never written over,
   a crash never leaves half a rule, and a symlinked file stays a link. The block keeps the
   file's line endings, so that a CRLF file does not end with mixed line endings.
9. **No migration command.** There is no `:route move-file` or similar, because moving the rules
   is a cut and paste between two files that a command would add a name, help text and tests
   for without saving the user a step; the warnings of Behaviours 3 and 4 name anything left
   behind.
10. **Live reload on config.toml's poll.** `routes.toml` is checked on the same 2 s timer as
    `config.toml`, by its stat signature, and `:source` reads it, because a second timer would
    double the wakeups for no gain, and a user who edits either file expects the same delay.
11. **`:source <file>` keeps routes.toml.** A sourced file does not replace `routes.toml` when
    it exists, because the routes file is located by `config.toml`'s path (decision 1), and a
    config tried out with `:source` should not change where links open; without `routes.toml`
    the sourced file's rules apply, as they do today.
12. **No general include mechanism.** `config.toml` gets no `include = [...]`, because an
    include loses the per-file precedence decision 2 relies on (which file wins for a key would
    depend on include order), and `:route add` and the setup page need a single, known file to
    write each value to. A named file per kind of data, as `bookmarks.toml` and `routes.toml`,
    keeps both.
13. **about:vimma shows each rule's file.** The Routing section names each rule's file and line,
    because with two possible files the next question after "which rule matched" is "where is
    it", and the warning of Behaviour 3 alone does not say which file a rule in force came from.
14. **One pull request, no feature flag.** The feature is delivered in one pull request, so
    `main` never holds half of it and no `vimma.feature.<name>` flag is needed
    (`CONTRIBUTING.md`, "Unfinished features").

## Security and privacy

`routes.toml` decides which workspace, and so which container and cookies, a site or another
program's link opens in. It carries exactly the trust of `config.toml`: a local file the user
creates, edits or pulls from a repository of their own. A pulled `routes.toml` can send a site
to another workspace as a pulled `config.toml` can today; the guide says so. It adds no new
reach: nothing in it is executed (08 F3), and every value is validated as in `config.toml`
(decision 4).

- The agent guarantees hold whichever file holds the rules: a rule naming the agent workspace
  never applies to a link from another program (02 R8), `default_workspace` never picks the
  agent workspace (02 R9), and a tab the user did not open inside the agent workspace never takes
  its container (12 M24). Their tests gain a case with the rule in `routes.toml`.
- `:route add` is the only writer, reachable only from Vimma's command line in a non-private
  window (Behaviour 11); a page, the agent role and the built-in agent cannot write either file.
  It writes one file, atomically, never over a file changed meanwhile, and never creates
  `routes.toml` (decisions 7 and 8).
- A read or a write of `routes.toml` never ends `:mcp off`'s hold (12 M64), since `routes.toml`
  holds no `[mcp]` setting and the hold is not tied to any file read.

Security pages updated in the implementing pull request:

- `docs/security/08-config-toml.md`: F1 (`:route add` appends to the routes file through
  `writeFileNow`; Vimma never creates `routes.toml`), F2 (a broken `routes.toml` keeps the last
  good routes, the cache included), F4 (`:route add` writes one file, each value one escaped
  string, nothing over a file changed meanwhile, the lines to add by hand when it cannot write),
  and F9 for `routes.toml` itself (location, allowed tables, regular files only, trust as
  `config.toml`).
- `docs/security/02-workspace-routing.md`: R4 (a name selects only a workspace that a rule in
  the routes file names) and R9 (`default_workspace` from the routes file), and the section's
  opening line naming `routes.toml`.
- `docs/security/12-agents-mcp.md`: M64 (a write by `:route add` to `routes.toml` or
  `config.toml` never ends the hold) and M24's list (a `[[routes]]` rule in either file).

## Tests

Written first and seen to fail.

### Vitest

`packages/vimma-core/test/routes-file.test.ts`:

- `parseRoutesFile reads [[routes]] and [routing] as config.toml does` (B2, D4)
- `parseRoutesFile refuses another top-level key at its line` (B2)
- `parseRoutesFile refuses a file over 1 MiB` (B2)
- `an empty routes.toml has no rules` (B2)
- `parseConfig with routesFile leaves out routes, even invalid ones`, and
  `it leaves out config.toml's [routing] too, even an invalid one` (B3, B4)
- `inlineRoutes finds [[routes]], an inline routes array and default_workspace` (B3, B4)
- `routes.toml owns [routing]: config.toml's default_workspace never applies` (B4, D3)
- `a routes.toml never read well yet applies no rule, never config.toml's` (B5)
- `appendRouteFileText appends a quoted block and refuses a broken file` (B8, B10)
- `appendRouteFileText keeps a CRLF file's line endings` (B9, D8)
- `the routes cache (vimma.routes.cache)`: its file, an older bare array, anything else (B5, D5)

`packages/vimma-core/test/routes.test.ts`: `appendRouteText keeps a CRLF file's line endings`
(B9, D8). `fuzz/routes.fuzz.test.ts`:
`:route add into routes.toml writes the domain and workspace as given, or refuses (F4)`.

### Mochitests

In `tests/browser/browser_vimma_routes_file.js`:

- `routes_toml_rules_apply_and_config_toml_rules_are_ignored_with_a_warning` (B1, B3, B4)
- `routes_toml_is_found_beside_a_symlinked_config_toml` (B1, D1)
- `a_broken_routes_toml_keeps_the_last_good_routes_and_config_toml_applies` (B5)
- `a_routes_toml_never_read_well_applies_no_rule` (B5)
- `a_fifo_or_a_dangling_link_named_routes_toml_is_an_error` (B2, D4)
- `a_broken_routes_toml_at_start_keeps_the_cached_routes_toml_rules` (B5, D5)
- `a_symlinked_routes_toml_is_followed_and_a_large_one_refused` (B2)
- `deleting_routes_toml_brings_back_config_toml_rules` (B6)
- `an_edit_of_routes_toml_applies_on_the_poll_and_on_source` (B7)
- `source_file_keeps_routes_toml` (B7, D11)
- `route_add_appends_to_the_routes_file_and_names_it` (B8)
- `route_add_refuses_a_broken_routes_toml` (B10)
- `route_add_writes_nothing_over_a_file_changed_meanwhile` (B9, D8)
- `route_add_to_a_read_only_config_toml_says_what_to_add_by_hand` (B10, D7)
- `route_add_in_a_private_window_writes_nothing` (B11)
- `about_vimma_shows_each_rules_file_and_line` (B12)

In existing files:

- `browser_vimma_agent_outside_opens.js`:
  `a_routes_toml_rule_naming_the_agent_workspace_is_not_followed_from_outside` (02 R8, 12 M24),
  `a_routes_toml_default_workspace_naming_the_agent_workspace_is_passed_over` (02 R9).
- `browser_vimma_mcp.js`: `mcp_off_survives_a_route_add_to_either_file` (12 M64).
- `browser_vimma_security_invariants.js` and `browser_vimma_workspace_routes.js`: the existing
  `:route add` tasks expect the result `{ added: "config.toml" }`.

## Docs and changelog

- `docs/guide.md`, "Routing: which workspace a link opens in": a "Routes in a file" part: where
  `routes.toml` goes, that it replaces `config.toml`'s rules and `[routing]` as a whole, that
  `:route add` appends to the routes file and never creates `routes.toml`, what a missing file
  does, that a pulled `routes.toml` carries the same trust as a pulled `config.toml`, and the
  steps to move by hand (create `routes.toml` beside `config.toml`, cut the `[[routes]]` tables
  and `[routing]` into it in the same order, save both; the status bar shows anything left
  behind) and back.
- `docs/guide.md`, "config.toml" → "Workspaces and routing", through the template's comment in
  `config/defaults.mjs` (`npm run gen-docs`): the rules may live in `routes.toml` instead.
- `CHANGELOG.md` (from the commit):
  `feat(routing): keep [[routes]] in routes.toml beside config.toml`.

## Delivery

One pull request (decision 14): core module and tests, ConfigHost's read and write, the
about:vimma column, the guide and the three security pages. It sets this spec to `implemented`
and closes #1444.

## Open questions

None: the questions the issue raised are answered in Design.
