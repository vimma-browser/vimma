# Spec: bookmark-open

Status: implemented · Area: `packages/vimma-core/src/ui/bookmark-open.mjs`, `ui/bookmarks.mjs`,
`ui/picker.mjs`, `keys/actions.mjs`, `keys/cmdline.mjs`; `src/browser/base/content/vimma/`
(`host/bookmark-actions.mjs`, `host/bookmark-ops.mjs`, `host/runners.mjs`,
`host/window-state.mjs`, `host/VimmaHost.sys.mjs`, `ui/picker.mjs`) · Upstream patches: none ·
ADR: none

Issue: [#1219](https://github.com/vimma-browser/vimma/issues/1219)

Builds on [bookmarks](bookmarks.md), [bookmarklets](bookmarklets.md) (its decision B10 reserved
this entry point) and [tab-search](tab-search.md) (the picker it reuses).

## Summary

`:bookmarkopen [title]` opens one of your bookmarks by its title, in the current tab, as `Enter`
in the bookmarks panel does; `:bookmarktab [title]` opens it in a new tab. A title that exactly
one bookmark has opens at once, so a key can be bound to a bookmark
(`"<M-g>" = ":bookmarkopen 'Google Shopping'"`). A partial title, or a title several bookmarks
share, opens a picker with the text already typed; no title opens the picker over every
bookmark. A bookmarklet opened this way follows `[bookmarks] bookmarklets` exactly as in the
panel.

## Problem

Reaching a bookmark from the keyboard takes `ctrl+b shift+b`, then moving or filtering to it, and
the panel shows only the current workspace's folder by default. A bookmark used many times a day
cannot be bound to a key, and a bookmarklet, which a user runs on many pages, has no quicker
route than the panel either.

## Behaviour

1. `:bookmarkopen` with a title that exactly one bookmark has, ignoring case and outer spaces,
   opens that bookmark in the current tab and closes the bookmarks panel if it is open.
   `:bookmarktab` opens it in a new tab and selects that tab. An untitled bookmark is never
   opened this way; it is listed in the picker under its URL.
2. With a title that only part of a title matches, or that several bookmarks share, a picker
   titled "Bookmarks" opens with the title as its query. Typing narrows it from the first key,
   `ctrl+n` / `ctrl+p` and the arrows move, `Enter` opens the selected bookmark as in 1, `Esc`
   closes. (Since changed: the query keeps a quoted trailing space, so
   `:bookmarkopen 'work '` followed by `s` searches `work s`, two words, rather than `works`;
   outer spaces still do not count for the exact title in 1.)
3. Without a title, the picker opens over every bookmark.
4. A title nothing matches says `bookmark: none matches "<title>"`; with no bookmarks at all,
   `bookmark: none saved yet`.
5. A bookmarklet opened with `:bookmarkopen` runs in the current page when
   `[bookmarks] bookmarklets` is `"user"` or `"agent"`, and refuses as in the panel otherwise.
   `:bookmarktab` refuses a bookmarklet with
   `a bookmarklet runs in this page: :bookmarkopen runs it`.
6. Quoting works as for every command (`:bookmarkopen 'Google Shopping'`), so a `:` binding in
   `config.toml` can name a title with spaces. The actions `open_bookmark` and
   `open_bookmark_tab` exist for `[keys]` and have no default key.

## Research

Checked against Firefox 160.0 as imported by `npm run import`.

- **Opening in a tab.** The panel opens a bookmark with `openTrustedLinkIn(url, where, params)`
  (`engine/browser/base/content/utilityOverlay.js:118`, which calls
  `URILoadingHelper.openTrustedLinkIn`). For `"tab"`, `params.inBackground`
  (`engine/browser/modules/URILoadingHelper.sys.mjs:411`) decides whether the new tab is
  selected, read through `BrowserUtils.willLoadInBackground` (`:579`); passing `false` selects
  it.
- **Reading every bookmark.** Core `fromPlaces(places, "all")`
  (`packages/vimma-core/src/ui/bookmarks.mjs`) already builds the whole tree from
  `PlacesUtils.promiseBookmarksTree("")` for the panel's `root = "all"`: the Menu, with the
  toolbar, Other Bookmarks and (when not empty) mobile roots as its first folders.
- **Pickers.** `GotoPicker` (`src/browser/base/content/vimma/ui/picker.mjs`) and core
  `pickerKey` / `filterItems` (`packages/vimma-core/src/ui/picker.mjs`) are shared by every
  picker; tab search's "type from the first key" is core `openPicker`'s `typeFirst`.

## Design

1. **Every bookmark, whatever the panel's root.** The command reads the whole of Places (core
   `fromPlaces(…, "all")`): the toolbar, Other Bookmarks, mobile and the Menu. The panel shows
   one workspace's folder by default because it is a tree to browse and file into; a title is a
   name the user already knows, so it must find the bookmark wherever it is filed. Each row
   shows its folders (`toolbar/work`, `menu/Recipes`), so two bookmarks with one title in
   different workspaces are told apart. Reason for not following
   `[bookmarks] root`: a key bound to a bookmark would then work in one workspace and not in
   another.
2. **One exact title opens; anything else asks.** The title is compared with each bookmark's
   stored title in Unicode NFC, in lower case, after trimming; an untitled bookmark has none to
   compare, so neither its URL nor the `(untitled bookmarklet)` placeholder opens it directly.
   Exactly one equal title opens at once,
   because that is what a key bound to a bookmark needs. A partial title opens the picker even
   when one bookmark matches it, because a fuzzy match can be a bookmark the user did not mean,
   and a bookmarklet would then run on the page; a shared title opens the picker so the user
   chooses between them. Rejected: opening the best fuzzy match, for the same reason.
3. **`:bookmarktab` opens in front.** The new tab is selected, as `:tabnew`'s is, because a
   command typed to open a page means to look at it; the panel's `t` opens in the background
   because the panel stays open for more. The tab is opened with `openTrustedLinkIn(url, "tab")`
   as the panel's `t` does, so the workspace's container and routing apply in the same way.
4. **The picker is the pickers' machinery.** `BookmarkPicker` in `ui/picker.mjs` is a
   `GotoPicker` with its own look, rows from core `bookmarkOpenItems` and core `pickerKey`, so
   its keys, focus and styling are those of every other picker. It types from the first key and
   keeps only the rows around the selection in the DOM (core `rowRange`), as tab search does,
   because a profile can hold thousands of bookmarks. A row matches by its title first, then the
   host, then its folders (core `matchItem`).
5. **The panel's own path decides and opens.** The command and the picker's `Enter` call
   `openUserBookmark(ctx, guid, where)` in `host/bookmark-actions.mjs` (bookmarklets B10) with
   the bookmark's Places guid. It reads the bookmark again by its guid, decides with core
   `bookmarkletDecision` as the user at the level in force (bookmarklets B6), and opens it or runs
   it with `runBookmarklet` (B8, B9). So `[bookmarks] bookmarklets`, the web-page check and the
   refusal of `data:` and other schemes apply unchanged, and cannot drift from the panel's.
6. **Typed text only chooses, and the choice is checked again.** The title is compared with
   stored titles and is never loaded, so `:bookmarkopen javascript:…` or a URL never opens
   directly (bookmarklets B17, security.md U8). A bookmarklet's row says `bookmarklet` and an
   untitled one shows `(untitled bookmarklet)`, never its script, because a script in the list
   would be noise and could be long; an untitled web bookmark's URL is cut to 200 code points
   on its row. Before opening, the bookmark is read again by its guid (B10), and two checks
   follow, so that what runs is what the user saw: if its URL changed since it was listed (Sync
   or another window edited it while the picker was open), it is refused with `bookmark: it changed since it was listed: pick it again`; and a
   bookmarklet runs only if the selected tab and its URL are still those the command was given
   on, or `bookmark: the page changed: run it again`, as the agent path re-checks after its
   question (B15). The picker closes when the selected tab changes. A web bookmark has no page
   check: it loads in the tab selected when it opens, as the panel's `Enter` does, because loading
   a page the user saved runs no script in the page they were on.
7. **The refusal names the command.** `bookmarkletDecision` takes `from: "panel" | "command"`
   only to word the new-tab refusal: the panel's says `Enter runs it`, the command's says
   `:bookmarkopen runs it`, because each names the way that works where the user is.
8. **Names.** `:bookmarkopen` and `:bookmarktab` follow the command line's one-word names
   (`:tabnew`, `:bookmarkstoolbar`); the action names `open_bookmark` and `open_bookmark_tab`
   follow `add_bookmark`. Two commands rather than a `!` form, because no command takes `!`
   and Vim's `!` means "force", not "in a new tab". No short alias, because `:bo` and `:boo`
   already abbreviate `:bookmark` and must keep doing so; `Tab` completes the names, and
   `:bookmarko` is enough to type. No default key, because which bookmarks deserve a key is
   the user's choice, made with a `:` binding.
9. **The picker opens only if nothing else took the keys.** Reading every bookmark is
   asynchronous; if the command line, a prompt, the help or another picker opened meanwhile,
   the bookmark picker stays shut, because keys go to the surface already open and a dialog
   shown over it would not receive them.

## Security and privacy

- No new way to run script: the command reaches `openUserBookmark`, the panel's path, and only
  with the guid of a stored bookmark the user named or picked; the level, the web-page check and
  the principal are bookmarklets B6 to B9 unchanged. A bookmarklet still never runs in a new tab.
- Agents cannot run it: `vimma_keys` runs only its whitelist of actions (mcp-drive D9), which has
  no command line, and no agent command or tool reaches `bookmark.open`. Full control
  (`:control on`) can already press the panel's keys.
- A `:` binding in `config.toml` can run a bookmarklet by its title when pressed, at `"user"`
  or `"agent"`. That is the user's own file naming the user's own saved bookmarklet, the same
  choice as pressing `Enter` on it in the panel.
- Agent workspace: run in a tab of the agent workspace, `:bookmarkopen` loads the bookmark (or
  runs the bookmarklet) in that tab, as the panel's `Enter` does there, so agents can read that
  page, and a bookmark URL that carries a token or login becomes readable by them. The control
  socket's `open` moves a page out of an agent tab for that reason (vimma-mcp decision 42). Here
  it is accepted, because the user selected that tab and named that bookmark at the keyboard.
- Accepted race, as bookmarklets "Security and privacy" describes: the page check reads the
  parent's view of the tab (`currentURI`), which can lag a same-site navigation for a moment.
- Rules: security.md U3, U8 and M63.

## Tests

- Vitest `packages/vimma-core/test/bookmark-open.test.ts`: the rows (tree order, folder paths,
  host, a bookmarklet's row without its script, a long untitled URL cut, the listed kind); what
  a title does (none, exact in any case, partial, shared, nothing, typed URL or script, untitled
  bookmarks only through the picker); the picker's matching and keys over bookmark rows; the
  commands and actions, with `:bo` still `:bookmark`; a `:` binding with a quoted title; the
  command's refusal wording in `bookmarkletDecision`; that `vimma_keys` cannot reach them.
- Mochitest `tests/browser/browser_vimma_bookmark_open.js`: an exact title opens in this tab and
  closes the bookmarks panel; `:bookmarktab` opens a new tab in front, from a title and from its
  picker; several matches open the picker with the query and `Enter` opens the row; a shared
  title asks; no title lists every bookmark; typed text and a typed script never open or run; a
  bookmarklet refuses at `"none"` and runs at `"user"` from the command and from the picker;
  `:bookmarktab` refuses a bookmarklet; a row that became a bookmarklet while listed is
  refused; a page that changed under the picker runs nothing.

## Docs and changelog

- `docs/guide.md`: "Bookmarks", opening a bookmark by its title, and binding a key to one.
- `docs/bindings.md`, `docs/bindings.json`: the two actions (`npm run gen-docs`).
- security.md U3, U8 and M63 name the commands.
- CHANGELOG (from the commit): `feat(bookmarks): open a bookmark by its title with
:bookmarkopen and :bookmarktab, with a picker for several matches`.

## Delivery

One pull request: core, the host, the picker, docs.

## Open questions

None.
