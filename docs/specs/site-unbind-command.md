# Spec: site-unbind-command

Status: implemented · Area: core (`packages/vimma-core/src/keys/site-keys.mjs`,
`config/site-edit.mjs`, `keys/keymap.mjs`, `keys/cmdline.mjs`, `keys/actions.mjs`), host
(`host/site-keys-ops.mjs`, `host/VimmaHost.sys.mjs`, `config/ConfigHost.sys.mjs`) · Upstream
patches: none · ADR: none

Issue: [#1258](https://github.com/vimma-browser/vimma/issues/1258)

## Summary

`:siteunbind <key> …` gives keys to the selected tab's site from inside the browser, as
[site-unbind](site-unbind.md)'s `[sites."<host>"] unbind` does from `config.toml`: until Vimma
restarts, or with `--save` for good, written into `config.toml`. `:sitebind <key> …` gives them
back to Vimma, and `:sitebind --delete <key> …` also removes them from `config.toml`.
`:siteunbind` alone lists the site's keys.

## Problem

A site's keys are set in `config.toml` only. Someone on GitHub who finds that `t` opens a tab
instead of GitHub's file finder has to open the file, find or write the site's table and save
it, before the key works. Trying a key for a while, on one site, should not need an edit.

## Behaviour

1. As a Vimma user on `https://github.com/...`, `:siteunbind t ctrl+k` makes `t` and `ctrl+k`
   reach GitHub's page on `github.com` and its subdomains, in normal and insert mode, exactly as
   `[sites."github.com"] unbind = ["t", "ctrl+k"]` would, until Vimma restarts. The notice says
   `github.com: t · ctrl+k go to the page (until restart)`. `config.toml` is not touched.
2. `:siteunbind --save t` writes `t` into `[sites."github.com"] unbind` in `config.toml` and
   reads the file again; the notice ends `(saved to config.toml)`. The rest of the file keeps its
   lines, comments and layout byte for byte.
3. `:sitebind t` ends a key given until restart. A key `config.toml` lists stays the page's, and
   the notice says how to remove it: `t is saved for github.com: :sitebind --delete t`.
4. `:sitebind --delete t` removes `t` from the keys until restart and from `config.toml`
   (`(removed from config.toml)`). A list left empty loses its `unbind` line, and a table left
   with only blank lines loses its header.
5. `:siteunbind` without keys lists the site's keys, those until restart and those saved marked
   apart: `github.com: t · ctrl+k go to the page until restart; g saved in config.toml`.
6. Each argument is one key written as in `config.toml` (`t`, `T`, `ctrl+k`, `<C-k>`, `space`,
   `,`, `<leader>`); a sequence is several arguments. An argument that is not one key refuses the
   whole line, naming it, with a hint where the reading is plain:
   `:siteunbind: gc is not one key (did you mean g c?)`. `esc` and the prefix are refused with
   the reasons `config.toml` gives.
7. A page without a host (about:, file:, data:, an extension's page) and the PDF viewer refuse
   the commands. In a private window `--save` is refused; the keys until restart work there.
8. `config.toml` changes only with `--save` or `--delete`. A file with errors is never written:
   the command says `config.toml has errors; fix them first (:config)` with the first error.
9. The AI agent cannot run either command.

## Research

- [site-unbind](site-unbind.md): the keymap compiles `[sites]` into per-site tries
  (`keys/keymap.mjs` `compileKeymap`, `trie`, `site`) and checks each entry there.
- `:route add` (`host/route-ops.mjs`, [workspace-routing](workspace-routing.md)) and the built-in
  agent's setup (`ConfigHost.addAgentProvider`, [builtin-agent](builtin-agent.md)) already write
  `config.toml` from a command, through `HostServices` (ADR-026): the host may not import
  `config/`.
- `setTomlKeys` (`config/toml.mjs`) edits scalar keys of top-level tables line by line and
  checks the result by parsing it again; it does not edit arrays or quoted table names.
- `vimma_keys` runs only a fixed list of action ids and refuses `:` (`agent/agent-keys.mjs`
  `AGENT_KEY_ACTIONS`, `REASONS`; security.md M16).
- Firefox's `nsIURI.host` throws for URIs without a host and is empty for `file:`; Vimma's
  `pageSite` already treats both as no site (`host/VimmaHost.sys.mjs`).

## Design

Core reads the arguments (`parseSiteKeysCommand`), picks the table (`siteTableFor`), keeps the
keys until restart (`createTemporarySiteUnbinds`) and edits the text (`editSiteUnbindText`). The
host keeps one list of keys until restart for every window (`host/site-keys-ops.mjs`), and
`VimmaHost` compiles it into the keymap in force with `withSiteUnbinds`; a reload of
`config.toml` compiles it again over the new file. `ConfigHost.editSiteUnbind` reads, edits and
writes `config.toml`.

1. **Two commands, temporary by default,** so that trying a key costs nothing: a key given by
   mistake ends at the next restart, and a permanent change is one word (`--save`) away.
   Rejected: saving by default, because a test of one key would leave lines in the user's file.
2. **One key per argument, read by the same function as `config.toml`** (`readSiteKey`), so that
   the command and the file accept and refuse the same keys for the same reasons. `gc` is
   refused rather than read as `g c`, because a typed `gc` might mean a key the notation has no
   name for, and a guess would give the page a key the user did not name. The hint is shown for
   up to three keys, because `comma` read as five keys is no plausible meaning.
3. **Keys are listed one by one, separated by `·`,** so that `ctrl+k` and `g c` read as keys
   and never run together with the words around them.
4. **The keys until restart join the keymap as `[sites]` entries,** compiled by the same code
   (`withSiteUnbinds`), so that they follow every rule of [site-unbind](site-unbind.md) (one
   table per site, the first key of a sequence, insert mode, the PDF viewer). Rejected: a second
   check in the dispatcher, because two lookups could disagree.
5. **The site is the selected tab's http or https host,** because those are the pages a
   `[sites]` table matches (`pageSite`). about:, file: and data: pages have no host to name,
   and the PDF viewer keeps Vimma's keys (site-unbind decision 2), so a key given there would
   seem to do nothing.
6. **The keys until restart live in memory only,** for every window, so that a restart ends
   them and nothing about them is written to disk.
7. **`:sitebind` ends only the keys until restart; `--delete` also edits the file,** so that
   `config.toml` changes only when a command says `--save` or `--delete`. The notice names a
   saved key and the command that removes it, so a key that stays the page's is never a
   surprise.
8. **`:siteunbind` alone lists,** marking keys until restart apart from saved ones, because the
   two end differently.
9. **Tab completion:** `:siteunbind` completes `--save`; `:sitebind` completes `--delete` and the
   site's keys, those until restart first. Completion fills the first argument only, as for the
   other commands (`completeCommandLine`).
10. **The table is the most specific `[sites]` table that matches the host,** among the file's
    and those the command made, so that a key joins the rule that applies on the page; with
    none, the host without a leading `www.`, so that `www.reddit.com` and `old.reddit.com`
    share it. Rejected: always the full host, because `[sites."www.github.com"]` would replace a
    `[sites."github.com"]` table on `www` (site-unbind decision 4).
11. **The file is edited line by line and checked,** because a TOML writer would drop the
    user's comments: a missing table is appended, an existing table gets an `unbind` line after
    its keys, a list gets keys appended in its own layout (one line, or one key a line), and a
    key leaves the list with its comma. The result must parse to the old file with only that
    list changed, and must load; otherwise nothing is written. A key the list has in another
    spelling (`<C-k>` for `ctrl+k`) counts as there. A table written another way (dotted keys,
    an inline table) is left to the user, with a message saying so. The write goes through a
    temporary file renamed over the file, as the agent setup's does, so a crash never leaves
    half a file and a symlinked `config.toml` stays a link.
12. **A private window does not save,** because a private window leaves no trace on disk and the
    site's name would be one. The keys until restart are allowed there, as they stay in memory.
13. **No default key.** Both actions (`site_unbind`, `site_bind`) are unbound; a user can bind
    them in `[keys]`.

## Security and privacy

`config.toml` sets which keys Vimma has; these commands change that for one site, and `--save`
and `--delete` write the file, so only the user may run them. They are commands of the `:` line
and two unbound actions: `vimma_keys` refuses `:` and runs neither action (they are not on its
list, and their group, Config, is the user's), and the built-in agent has the same tools, so no
agent reaches them. No page or content-process message reaches the keymap: the site is the
selected tab's top document host, read in the parent. `esc` and the prefix stay Vimma's. The
write never happens to a file with errors, and is checked to change nothing but the one list.
[security/13-page-modes.md](../security/13-page-modes.md) K13 states this.

## Tests

- vitest, `packages/vimma-core/test/site-keys.test.ts`: the commands and their completion; the
  arguments (canonical keys once each, `--save` and `--delete`, the `gc` hint, notation errors,
  `esc` and the prefix, a remapped prefix); the site (`siteOfUrl`, `siteTableFor`); the keys
  until restart (`withSiteUnbinds`, remove); every message; the agent's refusal of both actions
  and of `:`; the file edit (a missing table, an existing table, an existing one-line and
  multi-line list, another spelling, nothing new, removal and dropped lines and tables, a
  missing file, a file with errors, a table written another way, other quoting, CRLF, IPv6).
- mochitest, `browser_vimma_site_unbind_command.js`:
  `siteunbind_gives_a_key_until_restart_and_sitebind_takes_it_back`,
  `a_bad_argument_is_refused_and_nothing_changes`, `a_page_without_a_site_is_refused`,
  `save_writes_config_toml_and_delete_removes_it`, `a_config_toml_with_errors_is_never_written`,
  `a_private_window_does_not_save`; `browser_vimma_host_services.js` for the new service.

## Docs and changelog

- `docs/guide.md`: "Keys a site keeps" and the command list.
- `docs/bindings.md`: the two actions, regenerated.
- `docs/security/13-page-modes.md`: K13.
- [site-unbind](site-unbind.md): a "Since changed" note.
- The changelog line comes from the commit subject.

## Delivery

One pull request.

## Open questions

None.
