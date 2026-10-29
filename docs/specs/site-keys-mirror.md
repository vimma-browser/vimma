# Spec: site-keys-mirror

Status: implemented · Area: `packages/vimma-core/src/help.mjs`, `tools/gen-docs.mjs`,
`docs/bindings.json` (new, generated), `.github/workflows/site-dispatch.yml` (new). No upstream
patch. The website half lives in vimma-browser/vimma-site.

## Goal

vimma.dev's `?` overlay shows only some of Vimma's keys to a visitor who is not running Vimma. It
should mirror every available binding, read from the same source as the default `config.toml`, so it
cannot fall behind the browser.

## User stories

- As a visitor to vimma.dev who has not installed Vimma, `?` shows every default binding,
  grouped as Vimma's own `ctrl+b ?` groups them, under the site's own keys.
- As the maintainer, a change to the default keymap reaches vimma.dev without anyone copying
  Markdown by hand: the site gets a pull request with the new bindings.

## Decisions

1. **A machine-readable file next to bindings.md.** `npm run gen-docs` also writes
   `docs/bindings.json`. `defaults.toml` holds only action names and keys (no groups, no
   descriptions), so the site reads this file instead, which is built from the same
   `compileKeymap()` and `bindingTable()` as `defaults.toml`, `bindings.md` and the `ctrl+b ?`
   overlay. It cannot disagree with them.
2. **Shape** (`bindingsJson(keymap)` in `help.mjs`, pure):

   ```json
   {
     "version": 1,
     "generated": "… by npm run gen-docs; do not edit.",
     "prefix": "ctrl+b",
     "legend": "prefix = ctrl+b",
     "modes": ["normal", "insert", "…"],
     "groups": [
       {
         "name": "Help",
         "actions": [
           {
             "name": "help_close",
             "description": "Close the bindings overlay",
             "keys": [{ "keys": "esc", "chords": ["esc"], "mode": "help" }]
           }
         ]
       }
     ]
   }
   ```

   Groups and actions keep `ACTIONS` order, which is the overlay's order. `keys` is what a user
   presses (`keymap.keysFor`), split into `chords` on spaces (`ctrl+b shift+t` is two chords;
   `gt` is one run of plain keys, as the overlay shows it). `mode` is present only on a binding
   limited to one mode (`esc [help]`). An action with no default key has `keys: []`. The commit
   is not in the file: the consumer records which commit it fetched. `version` changes only when
   the shape does.

3. **Kept current by a test.** The Vitest check that the committed `defaults.toml` matches
   `formatDefaultsToml()` gets a sibling: the committed `bindings.json`, parsed, equals
   `bindingsJson(compileKeymap())`. Comparing parsed values lets prettier format the file.
4. **Telling the site.** `.github/workflows/site-dispatch.yml` runs on a push to `main` that
   changes `docs/bindings.json` (and by hand), and sends a `repository_dispatch`
   (`event_type: vimma-bindings`, `client_payload.sha`) to vimma-browser/vimma-site with `gh api`. It
   authenticates as the org's GitHub App vimma-site-dispatch, installed on vimma-browser/vimma-site
   only with "Contents: read and write" (the dispatch endpoint requires it): the variable
   `SITE_DISPATCH_APP_ID` (client ID) and the secret `SITE_DISPATCH_APP_KEY` (private key), from
   which GitHub's `actions/create-github-app-token` mints a one-hour token for that repository
   alone. Without the variable the job logs a notice and succeeds, so main does not go red before
   it is set. No third-party action; `actions/checkout` is not needed. (Since changed: the key is
   a secret of the `site-dispatch` environment, which only `main` may deploy to, and a published
   release only starts `site-dispatch.yml` on `main` with `release=true`, because a tag's copy of
   the file could otherwise read the key and push to vimma-site's auto-merging release-sync
   branches; docs/security.md, B15. Without the variable or the key the run now fails instead
   of logging a notice, because a skipped dispatch left the site on an old release unnoticed.)
5. **The site** (vimma-browser/vimma-site) fetches `docs/bindings.json` at a fixed commit from
   `raw.githubusercontent.com`, commits it with the commit it came from, and builds both its
   keys page and its `?` overlay from it. Its own workflow answers the dispatch with a pull
   request.

## Test plan

- `packages/vimma-core/test/help.test.mjs`: `bindingsJson` keeps group and action order, one
  entry per action; keys equal `bindingTable`'s, with the mode split off; chords split on
  spaces; follows a remapped prefix.
- `packages/vimma-core/test/defaults.test.mjs`: the committed `docs/bindings.json` is up to date.

## Out of scope

- The site's rendering (vimma-site's own PR).
- Mirroring a user's own `config.toml`: the site shows defaults only.
