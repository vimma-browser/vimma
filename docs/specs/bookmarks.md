# Spec: bookmarks

Status: implemented · Area: core (`packages/vimma-core/src/bookmarks.mjs`), UI
(`ui/bookmarks-panel.mjs`, `side-panel.css`), host (`host/bookmark-ops.mjs`,
`host/bookmark-actions.mjs`, `VimmaHost`)

## User story

As a Vimma user I open my bookmarks the way I open the side panel, with a keybind variation
(`ctrl+b shift+b`), and work them like neo-tree in my Neovim (`<space>n`): `j`/`k`,
`h`/`l` to fold, `a` to add with `/` for folders. From any page `ctrl+b a` bookmarks it: I type
`work/docs/My page` and it is filed under `work/docs`, the folders made as needed.

## Decisions

1. **Storage: Firefox's Places** (`PlacesUtils.bookmarks`, `PlacesUtils.promiseBookmarksTree`,
   `PlacesUtils.observers`; grepped in `toolkit/components/places/`). Existing bookmarks,
   import/export, the Library and Sync keep working; Vimma keeps no bookmark store of its own.
2. **One tree, rooted at the Bookmarks Toolbar** (`[bookmarks] root = "toolbar"`; the default
   until decision 11). Its top level is the toolbar folder's own children, at depth 0
   (`aria-level` 1); no row stands for the toolbar itself, and the header says "Bookmarks
   Toolbar". Paths (quick add, `a`, `A`, `m`, Tab completion) are relative to the toolbar. The
   Menu, Other Bookmarks and mobile are not listed; a bookmark there that quick add finds is
   named by its path from the Menu and offered at the toolbar's top by its title. An empty
   toolbar shows an empty state (not a row) saying the panel shows the Bookmarks Toolbar, that
   `a` adds the current page, and how to set `root = "all"`.
   `root = "all"` (schema 2; anything else is a config error) is the earlier tree, **rooted at
   the Bookmarks Menu**: its top level lists, in this order, the folders `toolbar` (Bookmarks
   Toolbar), `other` (Other Bookmarks), `mobile` (only when it has something), then the Menu's
   own children. A path is relative to the Menu, and its first segment may name `toolbar`,
   `other` or `mobile` (an alias wins over a Menu folder of that name). The four roots cannot
   be renamed, moved or deleted. Changing `root` re-reads an open panel. Either way,
   separators are not listed and tags are not shown.
3. **Same slot as the side panel, the same modal mode.** The bookmarks panel is its own box
   (`#vimma-bookmarks`) built by the side panel's helpers, styled by `side-panel.css` and the
   theme tokens, first child of `#browser`. Opening one panel closes the other. Both run in
   `panel` mode: `j`, `k`, `Enter`, `Esc` (`panel.*`) go to whichever is open, and the bookmark
   keys are `[modal.panel]` bindings to `bookmarks.*` actions, which do nothing in the tabs
   panel. Deviation from "reuse where you can": no new mode, so `<leader>` bindings, the
   status-bar badge, `Esc` handling and the help overlay's `[panel]` tag need no change.
4. **Prompts reuse the rename prompt** (`ui/rename-prompt.mjs`): it gains a general
   `prompt({ label, value, caret, complete, submit })` with Tab completion; `d` uses its y/N
   `ask`. While the prompt is open the host is in `insert` (it checks the prompt before the
   panel), so keys type into it even with a panel open.
5. **Paths** (core `parseBookmarkPath`): segments split on `/`, trimmed, empty ones dropped; `\/` is a
   slash inside a name, `\\` a backslash. No `..`. A trailing `/` means "folders only":
   - panel `a` follows neo-tree: `foo/bar/` creates folders and no bookmark;
   - quick add (`ctrl+b a`, `:bookmark`) files the page in that folder under its title.
     Folder names match exactly, else case-insensitively when one folder matches.
6. **Opening.** Only `http:`, `https:`, `file:` and `about:` URLs open (core `isOpenable`).
   `javascript:`, `data:` and anything else are listed but refuse with a notice: a bookmarklet
   would run with the page's rights from a key in chrome. Loads go through
   `openTrustedLinkIn` in the panel's own window: a new tab takes the current workspace's
   container (the m3 routing patch), a current-tab load stays in the tab's container, and a
   private window's load is private (no history). `Enter` / `l` open in this tab and close the
   panel; `t` opens a background tab and keeps the panel open, so several can be opened;
   `s` / `S` split through `PaneView.split` (refused at `[panes] max`, 4 by default) and load the
   bookmark in the new pane, closing the panel. (Since changed: `[panes] max` defaults to 8
   (#691).)
7. **Quick add.** Only a page whose URL is openable can be bookmarked (not the start page).
   Already bookmarked (Places' most recently changed bookmark for the URL): the notice says
   `already bookmarked: <path>` and the prompt becomes `move/rename:` prefilled with that path;
   `Enter` moves and renames that bookmark (no duplicate), `Esc` leaves it. `:bookmark path`
   skips the prompt for a new bookmark. The panel's `a` is an explicit "add here" and does not
   check (Firefox allows several bookmarks of one page).
8. **Live updates.** While open, the panel listens to `bookmark-added`, `-removed`, `-moved`,
   `-title-changed`, `-url-changed` and reloads the tree once per burst (one refresh tick);
   expanded folders, the filter and the highlighted item (by guid) survive. The listener is
   removed on close.
9. **Rendering.** Text only (`textContent`); a title is never parsed as HTML. At most
   `RENDER_CAP` (100) rows are in the DOM: a window that slides with the highlight, with
   "… N more" rows above and below. Moving within the window only flips `aria-selected`.
10. **Filter** (`/`): an input in the panel's head. Typing filters every bookmark (not folders)
    by title, URL and folder path with the pickers' fuzzy matcher (core `scoreField`), best
    first, as a flat list showing each folder path. `Enter` keeps the filter and returns the
    keys to the list; `Esc` clears it. With a filter in force, `Esc` in the list clears it
    first, and a second `Esc` closes.

11. **A folder per workspace** (`[bookmarks] root = "workspace"`, the default). Each workspace
    owns a folder at the top of the Bookmarks Toolbar, named after
    it. The panel's tree is the current workspace's folder: its children at depth 0
    (`aria-level` 1), no row for the folder or the toolbar, the workspace's name in the header;
    a workspace switch while open re-reads it afresh. Quick add, `a`, `A`, `m` and Tab
    completion work from that folder; `@name/` at a path's start is workspace `name`'s folder
    (`\@` a plain `@`), and Tab after `@` completes workspace names. The folder is made on the
    first add (core `workspaceTree` gives a pending guid until then). The link is the folder's
    Places guid, stored as the definition's `bookmarksFolder`; without one (or when that folder
    left the toolbar's top), the first top-level toolbar folder of the workspace's name is
    adopted and linked (`workspaceFolderGuid`). `:wsrename` renames the folder; a folder
    renamed elsewhere stays linked. Bookmarks loose in the toolbar, in the Menu or in Other
    Bookmarks do not show in a workspace's panel: `root = "toolbar"` (decision 2) or `"all"`
    shows them, as the empty state says. A window without workspaces (private, containers off)
    gets the toolbar. Config and runtime workspaces behave alike; opening keeps decision 6.
12. **Deleting a workspace with bookmarks.** After yes to `:wsdelete` of a runtime workspace
    whose folder has items, a second question (`choose` on the rename prompt): `k` or `Enter`
    keeps the folder (the default, unlinked from any workspace), `m` moves its contents into
    the first other workspace's folder (named in the question) and removes the emptied folder,
    `d` deletes the folder and its bookmarks; `Esc` or any other key closes nothing. Each answer
    stands only for the workspace, its folder and the target as asked about (the y/N guard's
    pattern); the workspace is closed first and its bookmarks change only once that succeeded.
    A config workspace's close keeps its folder and asks nothing more.

## Keys

| Key                    | Action                                                       |
| ---------------------- | ------------------------------------------------------------ |
| `ctrl+b shift+b`       | open / close the bookmarks panel (`:bookmarks`)              |
| `ctrl+b a`             | bookmark this page (`:bookmark [path]`)                      |
| `j` / `k`              | move                                                         |
| `h`                    | close the folder, or go to the parent folder and close it    |
| `l`                    | open the folder (again: to its first item); a bookmark opens |
| `Enter`                | open in this tab; on a folder, open / close it               |
| `t`                    | open in a new background tab, panel stays                    |
| `s` / `S`              | open in a split right / below                                |
| `a`                    | add the current page here, as a path (neo-tree `a`)          |
| `A`                    | add a folder here                                            |
| `r`                    | rename                                                       |
| `m`                    | move to a folder (prompt with completion)                    |
| `d`                    | delete after `y/N` (a folder says how many items go)         |
| `y`                    | copy the URL                                                 |
| `/`                    | filter                                                       |
| `Esc`, the toggle keys | close (`Esc` clears a filter first)                          |

"Here" is the highlighted folder, or the highlighted bookmark's folder; at the top level, the
workspace's folder (the toolbar with `root = "toolbar"`, the Menu with `root = "all"`). Digits (`panel.select`) do nothing in the bookmarks panel.

## Edge cases

- Empty path, or only slashes, refuses (`bookmark: empty name`). A missing title falls back to
  the URL.
- Moving a folder into itself or below itself refuses. Renaming to an empty name refuses.
- A bookmark deleted elsewhere while highlighted: the highlight goes to the row now at its
  place. A folder deleted elsewhere drops from the expanded set.
- A window with no workspaces (private) still has bookmarks; nothing there depends on them.
- Prompts closed by focus moving elsewhere cancel, as the rename prompt does.

## Tests (written first)

- Vitest `packages/vimma-core/test/bookmarks.test.mjs`: path parsing and formatting, the Places
  tree to ours, flattening with expansion, filtering, folder resolution and completion,
  `isOpenable`, the key machine, the render window.
- Mochitest `tests/browser/browser_vimma_bookmarks.js`: toggling (both keys, one panel at a
  time, Esc), quick add with nested folders and Tab completion, already-bookmarked, every panel
  key, opening into the workspace's container, refusing `javascript:`, live updates and the
  observer removed on close, a private window's load leaving no history, text-only rendering,
  and 2,000 bookmarks (DOM rows capped, open and move timed).

## Out of scope

Tags, keywords, separators, drag and drop, sorting, the bookmarks toolbar's visibility,
multi-select, opening a whole folder, undo (Firefox's Library has it), editing a URL.

## Settled

- **Red** (2026-10-10): Vitest `Failed to load url ../src/bookmarks.mjs` (no tests ran); the
  mochitest, 13 failures, e.g. `ctrl+b shift+b opens the bookmarks panel - timed out after 100
tries` and `ctrl+b a opens the prompt - timed out`.
- **Green:** Vitest 47/47 in `bookmarks.test.mjs` (1793 in all); the mochitest 112/112, and 14
  repeats on two busy CPUs 1568/1568 (the first repeat run found only that the panel's
  remembered folders leaked into the next run; the cleanup now resets them). Measured on the
  2,000 bookmarks: open 52 ms, expand 4 ms, 150 × `j` 28 ms, typing a 9-letter filter 279 ms
  (idle); at most 100 rows in the DOM.
- **Mutation check:** without the `isOpenable` check in core `openEffect`, Vitest fails
  (`a javascript: bookmark is listed but refuses to open`) and so does the mochitest
  (`KEY_Enter refuses - timed out`); reverted.
- The `help.test.mjs` and `defaults.toml` snapshots gain the Bookmarks rows only; the action
  names stay within the old column width so no other row moved.
- **Leader default removed** (2026-10-10): the leader has no default bindings, so
  `toggle_bookmarks` is `ctrl+b shift+b` only and `space b` does nothing by default. The leader
  option and `<leader>` bindings in `[keys]` stay for users to add. The bookmarks tests press
  `ctrl+b shift+b` where they pressed `space b`; the assertions are unchanged.
- **Toolbar root** (2026-10-10): the bookmarks panel shows only the contents of the Bookmarks
  Toolbar. The panel, quick add and paths are rooted at the Bookmarks Toolbar folder
  (decision 2), with no wrapper row; `[bookmarks] root = "all"` keeps the Menu tree. Red: Vitest
  12 failures (`rootLabel is not a function`, `expected 'menu________' to be 'toolbar_____'`,
  `[bookmarks] root` unknown key); the mochitest 21 (`only the Bookmarks Toolbar's contents, at
the top - ["toolbar","other","In the menu"]`, `Tab completes the folder name - "work/doQuick"`).
  Green: Vitest 2,441; the bookmarks mochitest 154/154 with `browser_vimma_a11y.js`. The fixture
  moved from the Menu to the toolbar, the menu and Other Bookmarks hold one bookmark each, and
  the assertions that named the old root (the top-level titles, `menu/…` and `other/…` paths, the
  `toolbar/` completion, root folders refusing) now assert the toolbar view, the old ones under
  `root = "all"`. `browser_vimma_a11y.js` gives the empty test toolbar a folder to show.
  Mutation check: with core `fromPlaces` ignoring `"toolbar"`, 5 Vitest tests fail; reverted.
  The `defaults.toml` snapshot gains the `[bookmarks]` section only.
- **A folder per workspace** (2026-10-10): decisions 11 and 12, on top of the
  toolbar root, which stays as `root = "toolbar"`; the default is now `"workspace"`. Red: Vitest
  11 failures (`withBookmarksFolder is not a function`, `workspaceFolderGuid is not a function`,
  …) and the config tests' new default; the new mochitest `browser_vimma_bookmarks_workspaces.js`
  9 against the toolbar-root build (`main's folder is listed - timed out`,
  `first.setBookmarksFolder is not a function`). Green: Vitest 2,479; the bookmarks, workspace
  and a11y mochitests 404/404, and 9 repeats of both bookmarks files on two CPUs clean.
  `browser_vimma_bookmarks.js` now sets `root = "toolbar"` at its start (it is that view's test)
  and `browser_vimma_a11y.js` gives the workspace's folder a subfolder to show; their assertions
  are unchanged. Mutation check: with core `workspaceFolderGuid` ignoring the stored guid,
  Vitest fails (`found by its stored guid first`) and so does the mochitest (`a rename … keeps
the link: still market's - timed out`); reverted. The `defaults.toml` snapshot's
  `[bookmarks] root` becomes `"workspace"`.
