# Spec: site-unbind

Status: implemented · Area: core (`packages/vimma-core/src/keys/keymap.mjs`,
`keys/dispatcher.mjs`, `keys/editable.mjs`, `config/config.mjs`, `config/defaults.mjs`), host
(`host/VimmaHost.sys.mjs`) · Upstream patches: none · ADR: none

Issue: [#1224](https://github.com/vimma-browser/vimma/issues/1224)

## Summary

`[sites."<host>"] unbind = ["t", "ctrl+k"]` in `config.toml` gives those keys to the page on that
site and its subdomains: Vimma does not act on them there, and every other binding keeps working.
A site with its own keyboard shortcuts (GitHub's `t` file finder, Gmail's `c`, Slack's `ctrl+k`)
keeps them, without turning Vimma off for the whole site.

## Problem

Today a key is either Vimma's everywhere or, with `[unbind]`, nowhere. On GitHub, `t` opens
GitHub's file finder, but in Vimma's normal mode it opens a new tab, so the page never sees it.
The only ways around it are `i` before each such key (insert mode passes keys to the page), or
unbinding `t` on every site.

## Behaviour

1. As a Vimma user with `[sites."github.com"] unbind = ["t"]`, pressing `t` on
   `https://github.com/...` or `https://gist.github.com/...` in normal mode reaches the page and
   opens no tab. On every other site `t` opens a tab, and on GitHub every other key (`j`, `gt`,
   `ctrl+b c`) is still Vimma's.
2. An entry is one key in the notation `[keys]` uses (`"t"`, `"T"`, `"ctrl+k"`, `"<C-k>"`,
   `"space"`, `"<leader>"`). Unbinding a key that starts longer sequences takes all of them on
   that site: `unbind = ["g"]` gives `g` to the page, and `gg`, `gt` and `gT` are off there.
3. The entries apply in normal mode and in insert mode, while keyboard focus is in the page. They
   do not apply in Vimma's own modes and surfaces (the side panel, the `:` line, hints, copy mode,
   the help overlay, pickers, the agent question), in the address bar, or in the PDF viewer.
4. `esc` and the prefix (`ctrl+b`, or the chord `[keys] prefix` sets) cannot be unbound on a
   site, alone or as the start of a sequence (`"prefix+c"`): each is an error at its line.
5. An entry that is not one key (`"gt"`, `"ctrl+x c"`), does not parse, or is not a string is an
   error at its line with the reason; a value that is not a list says what it got. A key bound to
   nothing is accepted and does nothing.
6. `unbind` sits beside `insert` in the same table; the two are independent. The table for the
   most specific matching host is the site's whole rule, as for `insert` today: a
   `[sites."gist.github.com"]` table replaces `github.com`'s for gist, so a key unbound on
   `github.com` and wanted on gist too is listed in both.
7. The change applies live when `config.toml` is saved, like `[unbind]`.

## Research

- Vimium's per-site exclusion rules pair a URL pattern with keys that go to the page, as
  [#1224](https://github.com/vimma-browser/vimma/issues/1224) describes them; Vimium's source was
  not checked for this spec, and nothing in the design depends on its details.
- Vimma's sites rule (`keys/editable.mjs` `matchSiteRule`, [m1-core-logic](m1-core-logic.md)):
  a domain matches the host and its subdomains on label boundaries, IP literals match only
  exactly, and the longest match wins. The host reads the host from the `<browser>`'s
  `currentURI`, the top document's address (`host/VimmaHost.sys.mjs` `siteInsert`).
- The dispatcher (`keys/dispatcher.mjs`) walks one trie per mode and keymap context, recomputed
  only when the mode or context changes; the bench gates its per-key cost
  (`docs/runbook/`).
- Pressing the first key of a sequence consumes it before the second is known
  (`VimmaHost.sys.mjs` `_dispatch`, case `pending`), so the page can never get the second key of
  a two-key binding on its own.

## Design

`compileKeymap` reads `sites` (`{ "<host>": { unbind?: string[] } }`) beside `[unbind]`. For
each table it parses the entries into chords and checks them (behaviour 4 and 5). The keymap gets
`site(host)`, which returns the matching table's host as written (`matchSiteRule`) when some
table unbinds anything, else `null`, and `trie(mode, context, site)`, which for normal and insert
mode in the page context returns that mode's trie without the bindings whose first key is
unbound there; it builds each such trie once, on first use. The dispatcher takes the site as a
fourth argument and, as for a mode or context change, drops a pending sequence when it changes.
The host passes `keymap.site(host)` of the focused `<browser>`'s `currentURI` on every key, and
`null` when focus is not in a page.

1. **An entry is one key, and it takes every binding that starts with it,** because the point is
   that the page receives the key: a first key Vimma kept would never reach the page, and the
   second key of a sequence cannot reach it either, since Vimma consumes the first. Rejected:
   sequences (`"gt"`), because unbinding `gt` while keeping `gg` would still swallow `g`, and the
   `t` would reach neither Vimma nor the page.
2. **Normal and insert mode, in the page, not the PDF viewer,** because those are the modes in
   which a key goes to the page. In insert mode it matters for chords (`ctrl+k` in a site's text
   field); plain keys already reach the page there. Vimma's own modes and surfaces own their keys
   and the page never sees them, so an entry there would only break Vimma. The PDF viewer is
   Firefox's viewer rather than the site's page, so its `[modal.pdf]` keys stay. Rejected: a
   `mode` per entry, because no request needs a site to change Vimma's own surfaces and it would
   repeat `[unbind]`'s per-mode lists.
3. **`esc` and the prefix stay Vimma's on every site,** because `esc` is the way out of insert
   mode and out of a pending key, and the prefix reaches every other command (`ctrl+b ?`,
   `ctrl+b :`, the side panel); a site holding either would leave the user without a way back.
   The prefix is the layer every mode and context keeps ([pdf-mode](pdf-mode.md) decision 5).
   Rejected: allowing them with a warning, because a page that has `esc` keeps the user in
   insert mode with no key that leaves it.
4. **The most specific table is the whole rule,** as for `insert` since
   [m1-core-logic](m1-core-logic.md): one lookup decides both keys, and a table means the same
   thing whichever keys it sets. Rejected: inheriting `unbind` from a parent domain's table,
   because then `insert` and `unbind` would follow two different rules, and an empty table could
   no longer reset a subdomain to the defaults.
5. **The keymap resolves the site,** not the host's `[sites]` insert rules, so that the tries and
   the host match come from the same compiled config: a keymap and a rule list from two different
   reloads can never disagree. The keymap keeps every table, including those without `unbind`,
   because of decision 4.
6. **Tries built on first use per site,** because a config with many sites should not build two
   tries per site at every reload, and the per-key cost stays one host lookup and a `Map` read.
   `site(host)` returns `null` at once when no table unbinds a key, so a config without `unbind`
   costs nothing per key.
7. **The help overlay and `:map` keep showing the keymap without site rules,** because they list
   the configuration, not one page's view of it, and a list that changed with the selected tab
   would hide bindings. The `[sites]` tables are in `config.toml` for reading.
8. **Firefox's shortcuts stay off on an unbound chord,** because the keymap still binds the chord
   ([firefox-keys](firefox-keys.md) decision 2): on that site the page gets the key and Firefox
   does not act on it, which is what the entry asks for.

## Security and privacy

Only `config.toml` sets which keys are unbound on which site: `compileKeymap` reads them from the
file, and no message from a page or content process reaches the keymap. A page decides only its
own address, which the user sees, and the match uses the top document's host
(`<browser>.currentURI`), so a frame from another site inside an allowed page receives the key
only if it has focus in that page, as it would in insert mode. `esc` and the prefix cannot be
given to a page (decision 3). The agent question, Firefox's permission prompts, the update
question and the pickers take their keys before the keymap, so a site entry cannot reach them.
[security/13-page-modes.md](../security/13-page-modes.md) K11 states this.

## Tests

- vitest, `packages/vimma-core/test/site-unbind.test.ts`: a site's unbound key is off in its
  normal and insert tries and on elsewhere; a key that starts sequences takes them all; a
  subdomain matches and a more specific table replaces the parent's; IP literals match exactly;
  the pdf context and Vimma's own modes keep their keys; `site()` is `null` without entries; the
  dispatcher drops a pending key when the site changes; `esc`, the prefix (alone, starting a
  sequence, and remapped), a sequence, a bad key, a non-list and a non-string are errors at their line;
  `unknown key` suggests `unbind`; the defaults file shows a commented example.
- mochitest, `browser_vimma_site_unbind.js` (fixture `file_vimma_site_unbind.html`):
  `a_site_unbound_key_reaches_the_page` (`t` reaches the page on example.com and opens no tab,
  `x` and `j` stay Vimma's), `the_same_key_is_vimmas_on_another_site` (example.org),
  `a_site_unbound_chord_reaches_a_field_in_insert_mode`, `esc_still_leaves_insert`.

## Docs and changelog

- `docs/guide.md`: "Keys a site keeps" under Keys, and the `[sites]` line of the config.toml
  reference.
- `defaults.toml` and the template `:config` writes: a commented `unbind` example under
  `[sites]`.
- `docs/security/13-page-modes.md`: K11.
- The changelog line comes from the commit subject.

## Delivery

One pull request.

## Open questions

None.
