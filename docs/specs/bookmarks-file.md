# Spec: bookmarks-file

Status: draft · Area: `packages/vimma-core/src/` (new `config/bookmarks-file.mjs`: parse, validate,
model, three-way diff and line edits of `bookmarks.toml`; `config/config.mjs` for
`[bookmarks] write_back` and the inline tables; `config/defaults.mjs` for the template line;
`ui/bookmarks.mjs` for the panel's write path); `src/browser/base/content/vimma/` (new
`bookmarks/BookmarksFile.sys.mjs`: the poll, the Places mirror and the write-back;
`config/ConfigHost.sys.mjs` for the shared edit queue; `host/bookmark-ops.mjs` and
`host/bookmark-actions.mjs`, which write through the file when a folder is mirrored);
`docs/guide.md`, `docs/security/08-config-toml.md` · Upstream patches: none · ADR: none

Issue: [#1286](https://github.com/vimma-browser/vimma/issues/1286)

Builds on [bookmarks](bookmarks.md) (the panel, quick add, paths and the per-workspace folders;
its decisions are "bookmarks decision N" here), [bookmarklets](bookmarklets.md) and
[m5-config-load](m5-config-load.md) (how `config.toml` is read). This spec's own decisions are
"D1", "D2" and so on. Engine paths are relative to `engine/` and were read in Firefox 160.0.1
(`config/milestone.txt`). Vimma paths are under `src/browser/base/content/vimma/` unless they
start with `packages/`, `tests/` or `docs/`; they were read at commit `a256d9dd`.

## Summary

Vimma reads bookmarks from `bookmarks.toml`, a plain file beside `config.toml`, with one table
per workspace and one line per bookmark. Vimma mirrors the file into each workspace's bookmark
folder in Firefox's bookmark store (Places), so the bookmarks panel, address bar suggestions,
the Library and Firefox Sync keep working. Changes made in Vimma, and by default changes from
the Library, an import or Sync, are written back to the file. A user can then keep all of
Vimma's configuration, bookmarks included, in a git repository, and keep the bookmarks private
while sharing `config.toml`.

## Problem

Vimma keeps its keys, workspaces, routes and theme in `config.toml`, a text file that people
keep in a dotfiles repository and carry between machines. Bookmarks are the one part of a
Vimma setup that lives only in the profile's `places.sqlite` (bookmarks decision 1):

- A new machine gets `config.toml` from git in seconds, but its bookmarks only through Firefox
  Sync (a Mozilla account) or an HTML export and import by hand.
- A change of bookmarks has no history: there is no diff to review, no commit to revert, and
  no way to see what a Sync or an import changed.
- A bookmark cannot be written as text, so a set of work links cannot be shared with a team
  the way a `config.toml` snippet can.

## Behaviour

Terms: a **bookmarks file** is `bookmarks.toml`, or the `[bookmarks.<name>]` tables in
`config.toml` when there is no `bookmarks.toml` (D2). A **table** is one `[bookmarks.<name>]`
table. A **mirrored folder** is the Places folder of a table (D6); everything below it is
mirrored too. An **outside change** is a change to a mirrored folder that Vimma's own keys and
commands did not make: the Library, Firefox's bookmark menus and star, an import, a restore, a
Sync.

### The file

1. `bookmarks.toml` is read from the folder that holds `config.toml`'s path
   (`$XDG_CONFIG_HOME/vimma/` or `~/.config/vimma/`, or the folder of the `vimma.config.path`
   pref), whatever `config.toml` itself is or links to. No file and no inline table means no
   mirror: bookmarks work exactly as before this spec.
2. The file holds only `[bookmarks.<name>]` tables. Each line in a table is one bookmark:
   the key is the bookmark's path inside the workspace's folder, read with quick add's path
   rules (bookmarks decision 5: `/` separates folders, `\/` is a slash in a name, `\\` a
   backslash, segments are trimmed, empty ones dropped); the value is its URL.

   ```toml
   [bookmarks.work]
   "docs/Vimma guide" = "https://vimma.dev/docs"
   "docs/Firefox source" = "https://searchfox.org/"
   "Calendar" = "https://calendar.example.com/"
   "archive/" = ""                       # an empty folder

   [bookmarks."my shop"]
   "Cart" = "https://shop.example/cart"
   ```

   A key that ends in `/` is a folder with nothing in it yet; its value **must** be `""`. A
   table name is a workspace name, checked as one (1 to 32 characters, no control characters,
   `config.mjs` `MAX_WORKSPACE_NAME`); one that needs quotes in TOML (spaces, dots) is quoted.
   Folder names in the file match exactly, unlike quick add's case-insensitive fallback, so
   that `Docs/` and `docs/` are two folders in the file as they are in Places.

3. Order: within each folder, items are in file order, and a folder sits among its siblings at
   the place of its first line. The panel, the Library and the bookmark menus show that order.
4. Errors, each with its line, in the status bar as `bookmarks.toml:<line>: <message>` and all
   in the Browser Console, as `config.toml`'s errors are shown (guide, "config.toml",
   **Errors**):
   - the file does not parse as TOML;
   - a top-level key other than `bookmarks`, or a value under `[bookmarks]` that is not a table;
   - a value that is not a string (a number, an array, an inline table, a nested table);
   - an empty path, a folder key whose value is not `""`, or a bookmark key ending in `/`;
   - a path segment longer than 4,096 characters, Places' title limit
     (`DB_TITLE_LENGTH_MAX`, `toolkit/components/places/PlacesUtils.sys.mjs:162`, `:215`);
   - a URL that is not absolute (`URL.canParse` fails), longer than 65,536 characters, or a
     `data:` URL;
   - two lines with the same path in one table (TOML itself refuses two equal keys; two keys
     that differ only in escapes or spaces but read as the same path are refused by Vimma);
   - a file larger than 4 MiB.

   A file with an error is not applied at all (as `config.toml`): Places keeps what it has,
   and both directions pause (D9).

   A URL is compared by its parsed form (`new URL(value).href`, which is what Places stores),
   so `https://searchfox.org` in the file and `https://searchfox.org/` in Places are the same
   bookmark, and the line is never rewritten for that difference alone (D5).

5. A `javascript:` URL is valid in the file. While `[bookmarks] bookmarklets` is `"none"` (the
   default), the mirror does not add it to Places, does not change or remove a `javascript:`
   bookmark Places already has at that path, and the status bar says once per load
   `bookmarks.toml:<line>: bookmarklet not added (bookmarklets = "none")` (D13).
6. An edit of the file, by hand or by `git pull`, applies within about 3 seconds in every
   window, with no restart and no command: the panel, if open, shows the new tree at once.
   `:source` reads `bookmarks.toml` at once along with `config.toml`. `:source <file>` loads
   only that config file; it does not change which bookmarks file is read, and
   `[bookmarks.<name>]` tables in that file are ignored with a warning, so that a config tried
   out with `:source` never changes bookmarks.
   Every load that deletes bookmarks says how many in the status bar
   (`bookmarks.toml: 3 bookmarks removed from work`), even under Behaviour 7's limits, so that a
   stale editor buffer saved over a write-back (Behaviour 13) does not delete in silence.
7. A load that would delete more than 20 bookmarks, or more than half of a table's bookmarks
   when that is at least 5 (an emptied or truncated file, a removed table), asks first in the
   most recently used window:
   `bookmarks.toml removes 34 bookmarks from work, docs: delete them? y/N`. `y` applies the
   file. `n`, `Esc` or no answer within 60 seconds applies nothing, keeps Places as it is, and
   pauses both directions until the file changes again; the status bar says so. The same
   question guards the other direction (Behaviour 13). The question is asked outside the
   edit queue (D11), and the run is computed again after a `y`, so that a waiting question
   never holds up other edits of `config.toml`.
8. When both `bookmarks.toml` and `[bookmarks.<name>]` tables in `config.toml` exist,
   `bookmarks.toml` is the bookmarks file and the tables in `config.toml` are ignored, with a
   warning at their first line:
   `config.toml:<line>: bookmarks.work ignored: bookmarks.toml is the bookmarks file` (D2).
   The rest of `config.toml` applies. In `config.toml`, a workspace named `root`,
   `bookmarklets` or `write_back` cannot have an inline table, because those names are the
   `[bookmarks]` settings; its table goes in `bookmarks.toml`, and the error says so.

### Settings

9. `[bookmarks] write_back` in `config.toml` (schema 2) sets which changes reach the file:

   | Value             | Vimma's keys and commands           | Outside changes (Library, import, Sync) |
   | ----------------- | ----------------------------------- | --------------------------------------- |
   | `"all"` (default) | written to the file                 | written to the file                     |
   | `"vimma"`         | written to the file                 | put back from the file, with a notice   |
   | `"none"`          | refused in mirrored folders, notice | put back from the file, with a notice   |

   Any other value is a config error with the closest valid value, as for `root`. It applies
   live. The setting lives in `config.toml`, not in `bookmarks.toml`, so that a shared or pulled
   bookmarks file cannot turn write-back on or off (D12).

### Vimma's own changes

10. With `write_back` `"all"` or `"vimma"`, every bookmark change Vimma makes in a mirrored
    folder is an edit of the bookmarks file first and of Places after it: quick add
    (`ctrl+b a`, `:bookmark`), the panel's `a`, `A`, `r`, `m` and `d`, the `move/rename:`
    prompt of an already bookmarked page, `:wsrename` (the table's header is renamed) and
    `:wsdelete`'s `m` and `d` answers (bookmarks decision 12: lines move to the other table,
    or the table goes). The edit keeps every other line, comment and blank line of the file
    byte for byte (D10). A new bookmark is written after the last line of its folder, or at
    the end of the table for a new folder. A change in a folder that is not mirrored (the
    Menu, Other Bookmarks, loose in the toolbar, a workspace without a table) goes to Places
    only, as today.
11. With `write_back = "none"`, those keys refuse in a mirrored folder with
    `bookmarks.toml is read-only (write_back = "none")`, and change nothing. `:wsrename` still
    renames the workspace; its folder keeps the table's name and stays linked by its guid
    (bookmarks decision 11). `:wsdelete`'s bookmark question offers only `k`.
12. In a private window, a change to a mirrored folder refuses with
    `bookmarks.toml is not written from a private window`, whatever `write_back` says.
    Opening, filtering and copying work as before.

### Outside changes

13. With `"all"`, an outside change to a mirrored folder (an add, a removal, a move into, out
    of or within it, a new title, a new URL) is written to the file about one second after the
    last change of its burst, as one edit. A Sync that brings 40 bookmarks writes one edit. A
    burst that would remove more lines than Behaviour 7's limits asks first:
    `Sync removes 34 bookmarks from work: remove them from bookmarks.toml? y/N`; `n` puts them
    back into Places from the file.
14. With `"vimma"` or `"none"`, an outside change is put back from the file about one second
    after its burst, and the status bar says once per burst
    `bookmarks.toml: Firefox change to work put back (write_back = "vimma")` (or `Sync`,
    `import`, `restore`; `Firefox` stands for every `DEFAULT`-source change: the Library, the
    star, the menus, an add-on). A put-back is itself a change Sync uploads, so other devices
    get the file's state too (D8).
15. A bookmark whose title is empty is written with its URL as its name (bookmarks' "A missing
    title falls back to the URL"), and a title with spaces at either end is trimmed; Places
    then gets the written name, so that both sides agree. A second bookmark with the path of
    an existing line in the same table is written as `<title> (2)` (then `(3)`, …), and Places
    gets that title too, with a notice, because a TOML table cannot hold one key twice. Two
    folders with one title in one parent are treated the same way: the second becomes
    `<title> (2)`.
16. Separators, tags and keywords in a mirrored folder are left as they are: they are not
    written to the file, and a load never removes them (D16).

### Export

17. `:bookmarks export` writes a new `bookmarks.toml` from Places: one table per workspace that
    has a linked folder (bookmarks decision 11), in the order the workspace picker lists them,
    each with that folder's contents in Places order, then opens it in a tab as `:config`
    does. It writes nothing and says `bookmarks.toml exists; :bookmarks export! replaces it`
    when the file is there. `:bookmarks export!` replaces it after a y/N. Bookmarks outside
    workspace folders are not exported, and the notice says how many were left out. A
    `javascript:` bookmark is exported whatever `bookmarklets` says (it is the user's own); a
    `data:` bookmark is left out and counted. `:bookmarks` with no argument still toggles the
    panel; `Tab` completes `export` and `forget`.
18. A table added by hand for a workspace whose folder already has bookmarks takes the
    folder over at its first load as a merge (D7): with `"all"` or `"vimma"`, the folder's
    bookmarks that the table lacks are written to the end of the table, and nothing is
    deleted; with `"none"`, the load asks y/N before it deletes any of them, whatever their
    number.
19. `:bookmarks forget` drops the base (D4) and stops the mirror until the bookmarks file
    exists again; Places keeps every bookmark it has. It is the way out of the pause a missing
    file causes (D9), for a user who no longer wants the file. Deleting `bookmarks.toml` while
    inline tables exist is also a missing file, not a switch to the inline tables, until
    `:bookmarks forget`; removing the last inline table from `config.toml` is a removal of its
    bookmarks, under Behaviour 7's question.
20. The mirrored folder itself (the workspace's folder at the toolbar's top) follows
    `write_back` like its contents. Renamed in the Library: under `"all"` the table's header is
    renamed; under `"vimma"` and `"none"` the name is put back. Moved elsewhere or deleted:
    under `"all"` it is a removal of the table and its bookmarks, asked as in Behaviour 13;
    under `"vimma"` and `"none"` a moved folder is moved back to the toolbar's top and a
    deleted one is made again from the file.

### Unchanged

21. Bookmarks outside every mirrored folder (the Menu, Other Bookmarks, mobile, loose in the
    toolbar, and the folders of workspaces without a table) are never read, written or changed
    by this feature. Places' daily bookmark backups stay on. `[bookmarks] root` still chooses
    what the panel lists; mirrored folders behave the same under every `root`.

## Research

### Places (Firefox 160.0.1)

- **Change sources.** Every bookmark write takes a `source`, forwarded to observers:
  `PlacesUtils.bookmarks.SOURCES` is `DEFAULT`, `SYNC`, `IMPORT`,
  `SYNC_REPARENT_REMOVED_FOLDER_CHILDREN`, `RESTORE` and `RESTORE_ON_STARTUP`
  (`toolkit/components/places/Bookmarks.sys.mjs:108-115`, values 0, 1, 2, 4, 5, 6 in
  `toolkit/components/places/nsINavBookmarksService.idl:66-71`). Each `PlacesBookmark` event
  (`bookmark-added`, `-removed`, `-moved`, `-title-changed`, `-url-changed`, `-guid-changed`,
  …) carries `guid`, `parentGuid`, `url`, `isTagging` and that `source`
  (`dom/chrome-webidl/PlacesEvent.webidl:162-218`).
- **Who uses which source.** The Library, the star, Firefox's menus and Vimma's own
  `host/bookmark-ops.mjs` pass no source, so `DEFAULT` (`Bookmarks.sys.mjs:308`, `:749`). A JSON
  or HTML import passes `IMPORT`, and a replacing restore `RESTORE`
  (`toolkit/components/places/BookmarkJSONUtils.sys.mjs:55-60`, `:98-103`,
  `BookmarkHTMLUtils.sys.mjs:107-112`). Sync's merge notifies every change with `SYNC`
  (`toolkit/components/places/SyncedBookmarksMirror.sys.mjs:2393`, `:2417`, `:2434`, `:2462`,
  `:2478`, `:2497`), all at once after the merge (`:580-588`,
  `BookmarkObserverRecorder.notifyAll`). The startup restore, when Places' database status is
  `DATABASE_STATUS_CREATE` or `DATABASE_STATUS_CORRUPT` and a JSON backup exists, replaces every
  bookmark with `RESTORE_ON_STARTUP`
  (`browser/components/places/PlacesBrowserStartup.sys.mjs:95-111`, `:159-167`; the statuses in
  `toolkit/components/places/nsINavHistoryService.idl:983-1003`, where `UPGRADED` and `LOCKED`
  are not new databases). Places' browser start-up notifies `places-browser-init-complete` when
  it is done, restore included (`:104`, `:280`, `:326`). `DEFAULT` therefore cannot tell Vimma's
  own write from the Library's: Vimma must know its own writes by other means (D5).
- **Sync uploads non-Sync changes.** A write with any source but `SYNC` bumps the item's sync
  change counter, so Sync uploads it (`toolkit/components/places/PlacesSyncUtils.sys.mjs:1253-1257`,
  "Don't bump the change counter when applying changes made by Sync, to avoid sync loops").
  The mirror's writes use `DEFAULT`, so that a file edit reaches the user's other devices.
- **Sync's merge and local changes.** Sync merges the local and remote trees and aborts with
  `MergeConflictError` when "the local tree changed during the merge"
  (`SyncedBookmarksMirror.sys.mjs:1431-1441`); the bookmarks engine then logs "will retry
  later" and returns (`services/sync/modules/engines/bookmarks.sys.mjs:421-425`). A local
  write during a merge delays that sync; it is not lost. The merger dedupes a local item that
  is not yet on the server against a remote item with the same content in the same folder
  (`third_party/rust/dogear/src/merge.rs:67-73`, `:525-533`), changing the local guid and
  notifying `bookmark-guid-changed` (`SyncedBookmarksMirror.sys.mjs:2408`). A workspace folder
  made on a new machine by the mirror can so take the guid of the same folder from another
  device.
- **Keeping guids.** `PlacesUtils.bookmarks.update` changes a bookmark's URL, title, parent and
  index in place; only `type` and `dateAdded` are immutable (`Bookmarks.sys.mjs:719-738`). A URL
  change moves the URL's keyword with it (`:976-981`, `keywords.reassign`). `reorder` sets a
  folder's order from a list of guids and appends children not in the list after them in their
  order (`:1800-1823`). `insertTree` inserts a whole subtree in one transaction and one
  notification batch, appending to the parent and ignoring the children's indices
  (`:405-431`). A removal removes a keyword whose URL is no longer
  bookmarked (`:2899-2901`).
- **Backups.** Firefox writes a JSON backup of all bookmarks at most once a day, after 8
  minutes of idle (`PlacesBrowserStartup.sys.mjs:28-31`, `:287-299`), keeping
  `browser.bookmarks.max_backups` (15, `browser/app/profile/firefox.js:1287`). Vimma does not
  change that pref.
- **Bookmarked `javascript:` and `data:` run from Firefox's UI.** `PlacesUIUtils.checkURLSecurity`
  lets a `javascript:` or `data:` URL load only from a node that is a bookmark
  (`browser/components/places/PlacesUIUtils.sys.mjs:659-675`). So a bookmark the mirror puts
  into Places runs when clicked in the Library or in Firefox's Bookmarks Toolbar, whatever
  Vimma's `[bookmarks] bookmarklets` says; that setting governs only Vimma's own keys
  ([bookmarklets](bookmarklets.md)).

### Vimma at `a256d9dd`

- `config/ConfigHost.sys.mjs` polls `config.toml`'s mtime and size every 2 seconds
  (`DEFAULT_POLL_MS`, the `vimma.config.pollMs` pref; `stat`, `startTimer`), since Firefox has
  no portable file watcher. Reads run one at a time (`poll`, `exclusive`).
- `rewriteConfig(compute)` is the one way Vimma edits `config.toml`: edits queue one behind
  the other (`rewriteQueue`); the new text goes through a temporary file created empty, given
  the file's permissions (0600 for a new file, `FILE_MODE`) and renamed over the file, or over
  the target of a symlinked `config.toml`; nothing is written when the file changed while it
  was edited; then the file is read again.
- `setTomlKeys(text, edits)` (`packages/vimma-core/src/config/toml.mjs`) edits one line per key,
  keeps every other byte, and checks that the edited text parses to the old document plus the
  new values, refusing the edit otherwise. It sets only bare keys (`BARE`,
  `/^[A-Za-z0-9_-]+$/`) in a top-level `[table]`, and cannot remove, rename or reorder a key or
  edit a dotted header such as `[bookmarks.work]`. The bookmarks writer needs those operations
  (D10).
- `parseToml` returns plain objects (`toml.mjs:53`). JavaScript lists an object's integer-like
  keys first, in numeric order (ECMA-262, OrdinaryOwnPropertyKeys), so a bookmark titled
  `2024` would move to the top if order were read from the object. `locateKeys` gives every
  key's line (`toml.mjs:180`), which gives file order.
- `config.mjs` refuses any key under `[bookmarks]` except `root` and `bookmarklets` today, so
  an older Vimma rejects a `config.toml` with an inline `[bookmarks.work]` table as a whole.
- The panel and quick add write Places directly (`host/bookmark-ops.mjs`), and a workspace's
  folder is the one its definition stores by guid, else the first top-level toolbar folder of
  its name (`workspaceFolderGuid`, `packages/vimma-core/src/ui/bookmarks.mjs:235`).

### Prior art

- **Firefox's `bookmarks.html` and JSON backups** are whole-tree snapshots with ids and
  timestamps on every line, so every save rewrites the file and a diff is noise; restoring one
  replaces everything.
- **qutebrowser** keeps bookmarks in `~/.config/qutebrowser/bookmarks/urls` (one `URL title`
  per line) and quickmarks in `quickmarks`, read at start and written on change; there is no
  folder structure and no sync. Not checked against a particular version; from its
  documentation.
- **Floccus** (a browser add-on) syncs bookmarks to a file or server in a two-way sync with a
  stored last-synced tree, the same three-way approach as D4. Not checked in source.

## Design

### Data flow

```text
bookmarks.toml ──poll (2 s) + settle (0.5 s)──▶ parse ─▶ model ─┐
        ▲                                                       ├─ 3-way diff (base) ─▶ Places ops (source DEFAULT)
        │                                                       │
        └── line edits ◀─ model ◀─ 3-way diff (base) ◀─ Places tree of mirrored folders
                                          ▲
                Places observer (burst + 1 s) ┘          Vimma's keys: model edit ─▶ file ─▶ Places
```

One module, `bookmarks/BookmarksFile.sys.mjs`, one per app like `ConfigHost`, owns the poll,
the Places listener and the queue. vimma-core's `config/bookmarks-file.mjs` does everything
that is not I/O: parse and validate, the model, the three-way diff, and the line edits.

### Decisions

1. **D1. A file beside config.toml, by presence.** Vimma reads `bookmarks.toml` from
   `config.toml`'s folder, and the feature is on when that file or an inline table exists,
   because a dotfiles repository already holds that folder, and a separate file can stay out of
   a shared repository (in `.gitignore`, or in a private one) while `config.toml` is published.
   A switch such as `[bookmarks] file = true` was rejected because the file's presence already
   says it, and without a file every profile behaves exactly as before. The folder is that of
   `config.toml`'s path, not of a symlink's target, so that a `stow`-style folder of links
   finds `bookmarks.toml` beside its link.
2. **D2. bookmarks.toml wins over inline tables, as a whole.** Inline `[bookmarks.<name>]`
   tables in `config.toml` serve a small setup with one file, but when `bookmarks.toml` exists
   it is the only bookmarks file, and inline tables are ignored with a warning, so that each
   bookmark has one place to be written back to and a reader never has to merge two files in
   their head. Rejected: merging per table (a workspace from either file), because the same
   table in both files would need a precedence rule, write-back would have to pick a file per
   table, and moving a table between files would delete and re-add its bookmarks; and making
   inline tables an error, because a config error stops the whole `config.toml` from applying
   (m5-config-load), which is too much for a bookmarks question. The guide recommends
   `bookmarks.toml`, also because an older Vimma refuses a `config.toml` that has inline tables
   (Research).
3. **D3. One line per bookmark, path = URL, in file order.** The format is quick add's path as
   the key and the URL as the value, so that the file reads like the paths a user types, a
   change is a one-line diff, and a conflict in git is a conflict on that line. The file holds
   no guid, date or id, so that the same bookmarks give the same file on every machine. File
   order is panel order because a list that is reordered by every save is a noisy diff. The
   writer writes LF line ends in a new file, keeps the line ends of an existing one (as
   `setTomlKeys` does), and always writes a key as a quoted basic string, so that a line does
   not change form when a title gains a space. A path's `\/` is written `"a\\/b"`, since TOML
   has no `\/` escape. Rejected: one table per folder (`[bookmarks.work.docs]`), because a
   folder's bookmarks would then be split from its siblings by headers and moving a bookmark
   would move it between tables; an array of tables per bookmark (`[[bookmarks.work]]`), because
   it takes three lines per bookmark. The inline-table value
   (`"Guide" = { url = "…", keyword = "g" }`) is reserved: a table value is an error today, so
   that a later spec can add it without changing the meaning of a valid file.
4. **D4. A three-way diff against a stored base.** The mirror stores the **base**: the model
   both sides last agreed on, with each line's Places guid, in `<profile>/vimma-bookmarks.json`
   (written through a temporary file and a rename), along with the SHA-256 of the file text it
   came from. Every run (a file change, a Places burst, startup, the end of a pause) compares
   the file with the base and Places with the base, and applies each side's changes to the
   other. So a change on one side is never mistaken for a deletion on the other, and changes
   made while Vimma was not running (a `git pull` before start) or while a pause held (D9) are
   merged, not lost. A file line is matched to a base entry by table and path, else by URL when
   one base entry in that table has it: same path and new URL is a URL change, same URL and
   new path is a move or rename, so the guid is kept (`PlacesUtils.bookmarks.update`, Research)
   and with it the keyword, Sync's record and the history of visits. A line whose path and URL
   both changed matches no base entry and is a removal plus an addition: the old bookmark's
   keyword goes when its URL is no longer bookmarked (Research). Rejected: a two-way
   compare of file and Places without a base, because it cannot tell an addition on one side
   from a deletion on the other; guids in the file, because they differ per profile and would
   make every machine's file different.
5. **D5. No loops: compare, then act.** Neither direction acts when both sides already equal
   the base. A run that Vimma's own write starts ends with all three equal, so the poll that
   sees the new mtime finds the text's hash equal to the base's and stops, and the Places events
   of the mirror's own writes find Places equal to the base and stop. While the mirror applies,
   events do not start a burst of their own; instead every apply ends with one more compare of
   Places and the base, so that a Library or Sync change that landed during the apply is handled
   then and not left until some later trigger. Values are compared normalised: URLs by `href`,
   titles trimmed and cut to Places' 4,096 characters, so that a difference Places itself makes
   never looks like a change. Rejected: telling Vimma's writes apart by `source`, because the
   Library writes with the same `DEFAULT` source (Research); writing with `SYNC`, because Sync
   would then never upload them.
6. **D6. A table is a workspace's folder.** A table's folder is, in order: the folder the base
   stores for it, wherever it is now (Behaviour 20 says what happens when it left the toolbar's
   top); the folder linked to the workspace of
   that name (bookmarks decision 11); the first top-level toolbar folder of that name; else a
   new folder made at the end of the toolbar's top. A table whose workspace does not exist yet
   still gets its folder, so that a workspace made later, or on another machine, adopts it by
   name. The folder's title is the table's name. A `bookmark-guid-changed` event for the folder
   (Sync's dedupe, Research) updates the base, so that a folder deduped against another
   device's stays mirrored.
7. **D7. Taking over a folder merges.** The first load of a table whose folder already has
   bookmarks writes the folder's extra bookmarks to the table (under `"all"` and `"vimma"`)
   instead of deleting them, because a user who adds `[bookmarks.work]` with one line wants
   that line added, not thirty bookmarks removed. Under `"none"` the file cannot be written, so
   the load asks before it deletes any. A shared file can adopt a personal folder this way: a
   team's `[bookmarks.work]` takes over the user's own `work` folder, and under `"all"` its
   personal bookmarks are then written into the team file; the guide says so (Security and
   privacy).
8. **D8. write_back sets who may change the file; "all" is the default.** The default writes
   every change, Sync's included, so that the file and the Firefox UI never disagree, and
   bookmarks synced from another device appear in `git diff`. `"vimma"` keeps the file under
   the user's own hand and Vimma's keys and treats the rest of Firefox as a viewer; `"none"`
   makes the file the only way to change these bookmarks. Putting a change back is a Places
   write with `DEFAULT`, which Sync uploads (Research), so under `"vimma"` and `"none"` the
   file's state spreads to every synced device. Two devices with different files under
   `"vimma"` or `"none"` therefore put each other's changes back at every sync; the guide says
   so, and Open question 2 asks whether to stop it.
9. **D9. Never write over a broken file; pause both ways.** While the bookmarks file has an
   error (Behaviour 4), Vimma neither writes the file nor applies it, and outside changes stay
   in Places only, because an edit computed from a file Vimma cannot read could drop what the
   user is in the middle of writing, and an apply of a half-written file (a `git checkout`
   writes in place) would delete bookmarks. The status bar keeps the error with its line until
   the file reads again; then one three-way run (D4) merges what changed on both sides
   meanwhile. A file that is missing after it existed is a pause too
   (`bookmarks.toml is missing; bookmarks paused`), not "delete every mirrored bookmark", until
   `:bookmarks forget` drops the base and turns the mirror off, so that a moved or renamed file
   never empties the folders.
10. **D10. A line writer for bookmarks, verified like setTomlKeys.** vimma-core gains
    `editBookmarkLines(text, ops)` with the operations the feature needs: add a line after a
    given line or at a table's end, remove a line, replace a line's key or value, move a line,
    add a table at the end, rename a table's header and remove a table with its lines.
    Comments on their own lines and blank lines stay where they are; a removed line takes its
    trailing comment with it. After the edit, the text is parsed again and must equal the
    expected model, order included, or the edit is refused with an error and nothing is
    written, as `setTomlKeys` refuses an edit its line scan got wrong. Rejected: serialising
    the whole model, because it would drop the user's comments and layout; extending
    `setTomlKeys`, because its contract (set scalar keys in a top-level table) is what keeps
    it small and verified, and bookmarks need removal and order.
11. **D11. One queue for both files.** Every edit of `config.toml` (`rewriteConfig`) and of the
    bookmarks file, and every apply to Places, runs in one queue in `ConfigHost`, so that an
    edit of an inline table and an edit of another `config.toml` line never read the same text,
    and an apply never reads a file mid-edit. A y/N question (D14) is never asked inside the
    queue: the run leaves the queue, asks, and is computed again inside it after a `y`, so a
    question left open for 60 seconds holds nothing up. The queue's task for a file edit ends
    before the edit's re-read is queued, so that `rewriteConfig`'s own read after a write
    (`ConfigHost.sys.mjs`, `rewriteConfigNow`) cannot wait on itself. Each edit goes through a
    0600 temporary file renamed over the file or its symlink's target, keeps an existing file's
    mode, checks that the file did not change meanwhile (else it retries once from the new text,
    then reports), and records the new text's hash in the base before the poll can see it.
12. **D12. Settings stay in config.toml.** `write_back`, `bookmarklets` and `root` are read only
    from `config.toml`; `bookmarks.toml` has no settings, so that a bookmarks file from someone
    else (a team's shared links, a pulled dotfiles repository) cannot allow bookmarklets or
    turn write-back on. A `[bookmarks]` key that is not a table in `bookmarks.toml` is an error.
13. **D13. Bookmarklets and `data:` from a file.** The mirror adds a `javascript:` line to Places
    only while `bookmarklets` is `"user"` or `"agent"`, and never adds a `data:` URL, because a
    bookmark in Places runs from Firefox's own Library and toolbar whatever Vimma's setting is
    (Research). A file pulled from someone else's repository must not be able to plant a script
    that runs on the user's pages with one click. With `"none"`, existing `javascript:`
    bookmarks in Places are not touched, so that turning the setting down never deletes the
    user's own bookmarklets. `data:` is refused at every level, as in
    [bookmarklets](bookmarklets.md) B5.
14. **D14. A large deletion asks, both ways.** More than 20 bookmarks, or more than half of a
    table's when that is at least 5, removed by one run asks y/N first, because the usual cause
    is an accident (a truncated file, a bad merge, an emptied Sync account), and Places' backup
    is a day old at worst. The limits let ordinary cleanup of a few bookmarks through without a
    question. Places' own backups stay on as the last resort.
15. **D15. Debounce and settle.** A file change is applied once its mtime and size are the same
    at two reads 0.5 s apart, so that a file written in several steps is read once. Places
    changes are written one second after the last event of a burst, so that a Sync batch or a
    Library drag of many items is one file edit. Rejected: a longer window, because a user who
    adds a bookmark and opens the file expects to see it.
16. **D16. Only bookmarks and folders.** Separators, tags and keywords are not in the file and a
    run never removes or moves them: the order a run passes to `reorder` lists every child of
    the folder, separators included at their place after the bookmark they followed, because
    `reorder` would otherwise append them at the end (Research); a run that inserts with
    `insertTree` calls `reorder` after it, since `insertTree` appends. Tags
    are stored outside the mirrored folders, and keywords follow their URL. They are out of
    scope because each needs syntax of its own (the reserved inline-table value, D3). Toolbar
    and menu layout, and every folder outside the mirrored ones, are unchanged (Behaviour 21).
17. **D17. Startup and restores.** At startup the mirror runs once, after the first window
    and after `places-browser-init-complete`, without blocking either, so that Firefox's own
    startup restore (a `replace`, Research) cannot erase the mirror's first apply or reach the
    file as a mass deletion. When Places made a new database at this start
    (`PlacesUtils.history.databaseStatus` is `DATABASE_STATUS_CREATE` or
    `DATABASE_STATUS_CORRUPT`; Firefox may then have restored a day-old backup), the file wins
    without a three-way merge, because the backup is older than the file. `UPGRADED` and
    `LOCKED` are not new databases and take the usual three-way run. Changes with
    `RESTORE_ON_STARTUP` are never written back. A `RESTORE` the user starts in
    the Library is an outside change like any other, under the large-deletion question.
18. **D18. File-first for Vimma's keys.** Under `"all"` and `"vimma"`, Vimma's keys compute the
    new model, write the file, then apply to Places, so that a write that fails (a parse error,
    a file changed meanwhile, a full disk) leaves Places untouched and the two never diverge, and
    so that `"vimma"` needs no way to tell Vimma's Places writes from the Library's (D5).
    Rejected: keeping the Places writes of `host/bookmark-ops.mjs` and writing the file from
    their events, because under `"vimma"` those events look the same as the Library's.

### Sync and file edits racing

Sync applies a merge with `SYNC`-source writes and fails it with `MergeConflictError` if local
bookmarks changed during the merge, retrying at the next sync (Research). Vimma's runs are
serialised in one queue (D11), each starting from what Places and the file hold at that moment:

- **A file edit lands while Sync merges.** The mirror's writes make Sync's merge fail; Sync
  retries later and uploads the file's changes as local changes. Nothing is lost.
- **Sync lands while the mirror applies a file edit.** A mirror write that fails because Sync
  removed or moved its target ends the run; the run starts again from the new Places state
  (once), so Sync's changes become the Places side of the three-way diff. A second failure
  pauses both ways with a notice, until the next file change or Places burst.
- **Both changed the same bookmark.** The file's change wins and the Places side is put back
  to it, because the file is the source of truth; under `"all"` the notice names the
  bookmark (`bookmarks.toml kept work/docs/Guide; Sync's change put back`). A removal on one
  side and a change on the other keeps the bookmark with the change, so that nothing the user
  just edited disappears.
- **Sync and git carrying the same file between two machines.** Under `"all"`, machine B's
  write-back writes the change Sync brought from machine A, and B's `git pull` of A's commit
  then finds a local change to `bookmarks.toml` and refuses to merge. The guide recommends one
  carrier for mirrored folders: git (Sync then carries the rest of the profile, or bookmarks
  under `"vimma"`) or Sync (the file then serves as a readable history on one machine). Open
  question 3.

## Security and privacy

- **A file that may end up in git.** URLs often carry tokens (`?token=`, a session id, a
  password in `user:pass@`). The guide's section warns, in its first paragraph, that every URL
  in a mirrored folder is written to `bookmarks.toml` and so to every commit and remote that
  holds it, and suggests a private repository or `.gitignore`. Vimma does not strip query
  strings, because a bookmark is the URL the user saved.
- **A shared file adopting a personal folder.** A team file's table named like one of the
  user's own folders takes that folder over (D7), and under `"all"` writes the user's
  bookmarks from it into the team file. The guide warns: give shared tables names of their
  own, or use `"vimma"` with a shared file.
- **Mode 0600.** A `bookmarks.toml` Vimma creates (only `:bookmarks export` creates one;
  write-back under inline tables edits `config.toml`) is mode 0600 in a 0700 folder, and an
  edit keeps an existing file's mode (D11), as for `config.toml`
  (`docs/security/08-config-toml.md` F1).
- **Someone else's bookmarks file.** It cannot run code: values are URLs, never evaluated; it
  cannot change settings (D12); `javascript:` lines are not added while `bookmarklets` is
  `"none"`, the default, and `data:` never (D13). With `bookmarklets = "user"` or `"agent"`, the
  guide warns that a pulled file's bookmarklets then reach Places and Firefox's Library, and
  with `"agent"` also an agent's `vimma_bookmarklet` (asked every time,
  `docs/security/12-agents-mcp.md` M63). A file cannot reach folders outside its tables: a table
  names a folder at the toolbar's top and paths cannot climb (`..` is a name, bookmarks decision
  5).
- **Size and parse safety.** A file over 4 MiB is refused before it is parsed, and parsing uses
  `parseToml`, which bounds nesting at 32 levels and never throws (security 08 F5). Paths and
  table names are kept in `Map`s, never looked up as object members, so a title such as
  `__proto__` or `constructor` is an ordinary title.
- **Agents.** No control-socket or MCP command reads or writes the bookmarks file. The agent
  role's `vimma_keys` cannot reach the prefix, `:` or the panel (mcp-drive D9), so an agent
  cannot run `ctrl+b a`, `:bookmark` or `:bookmarks export`. `vimma_bookmarklet` runs only a
  stored bookmarklet as before. The `full` role and `vimma-ctl send-keys` act as the user, as
  for every other key ([trust boundaries](../security/11-out-of-scope-and-trust-boundaries.md)).
  A page in the agent workspace cannot change bookmarks.
- **Private windows** never write the file (Behaviour 12), so that nothing done in private
  browsing reaches a file that may be committed.
- **Places' backups** stay on and unchanged, so a bad file or a bad merge can be undone from
  the Library's Restore menu.
- `docs/security/08-config-toml.md` gains, with the implementation: the file's mode; no write on
  a parse error; the edit verified before it is written; settings only in `config.toml`; the
  `javascript:` and `data:` rules; and that agents cannot reach it, each with its test.

## Tests

Written first and seen to fail.

### Vitest (`packages/vimma-core/test/bookmarks-file.test.ts`)

- `parses tables into ordered models, integer-like titles keep their line order`
- `reads paths with quick add's rules: escapes, trimming, empty segments dropped`
- `a folder key needs "" and a bookmark key cannot end in /`
- `refuses data: URLs, relative URLs, non-string values, inline tables and nested tables at their line`
- `refuses two keys that read as the same path`
- `refuses a file over 4 MiB without parsing it`
- `refuses a path segment over 4,096 characters and a table name that is not a workspace name`
- `refuses an inline table named root, bookmarklets or write_back, pointing at bookmarks.toml`
- `titles __proto__ and constructor are ordinary titles`
- `urls compare by href: a missing trailing slash is no change`
- `folder names match exactly; Docs and docs are two folders`
- `refuses keys other than [bookmarks.<name>] tables in bookmarks.toml`
- `javascript: lines are skipped below bookmarklets = "user", and Places' own are kept`
- `inline tables in config.toml are ignored with a warning when bookmarks.toml exists`
- `config: write_back accepts all, vimma and none, defaults to all, suggests the closest`
- `diff: an addition on one side is not a deletion on the other (three-way)`
- `diff: same path, new URL keeps the guid; same URL, new path keeps the guid`
- `diff: path and URL both changed is a removal and an addition`
- `diff: the reorder list keeps separators after the bookmark they followed`
- `diff: an empty title is written as the URL; outer spaces are trimmed`
- `diff: two folders of one title in one parent become title and title (2)`
- `diff: a renamed, moved or deleted mirrored folder per write_back`
- `diff: both sides changed one bookmark, the file wins; removed and changed keeps it`
- `diff: equal sides produce no operations` (the loop guard, D5)
- `diff: a folder sits at its first line; interleaved lines keep folder contents together`
- `diff: separators, tags and keywords are never in the operations`
- `diff: counts deletions against the large-deletion limits (20, half of at least 5)`
- `adoption merges a folder's extra bookmarks into the table; under none it asks`
- `table to folder resolution: base guid, linked workspace, name at the toolbar's top, new`
- `editBookmarkLines keeps every other byte, comments and CRLF line ends`
- `editBookmarkLines adds after a folder's last line, removes, renames, moves, renames a header`
- `editBookmarkLines writes keys as quoted basic strings, \/ as \\/, DEL escaped`
- `editBookmarkLines refuses an edit whose result does not parse to the expected model`
- `duplicate titles in one folder are written with (2), (3)`
- `export: one table per linked workspace, data: left out and counted`
- A fuzz test in `test/fuzz/`: `parse never throws and an accepted file holds only valid lines`,
  and `editBookmarkLines on any parsed file either refuses or yields the expected model`.

### Mochitests (`tests/browser/browser_vimma_bookmarks_file.js`)

- `a_file_is_mirrored_into_the_workspace_folder_in_order`
- `bookmarks_toml_is_read_beside_the_config_path_pref_and_beside_a_symlinked_config_toml`
- `source_reads_bookmarks_toml_and_source_file_ignores_its_bookmark_tables`
- `write_back_applies_live`
- `a_url_without_its_trailing_slash_is_not_put_back_or_rewritten`
- `an_edit_of_the_file_applies_live_and_keeps_guids`
- `the_mirror_writes_nothing_back_after_its_own_apply` (no second file write, no second apply)
- `a_broken_file_pauses_both_ways_and_names_the_line`
- `a_missing_file_pauses_and_bookmarks_forget_turns_the_mirror_off`
- `a_large_deletion_asks_and_n_applies_nothing`
- `an_unanswered_question_applies_nothing_after_60_seconds_and_blocks_no_config_edit`
- `a_small_deletion_from_the_file_says_how_many`
- `quick_add_writes_the_file_first_and_keeps_its_comments`
- `panel_rename_move_delete_write_the_file`
- `wsrename_renames_the_table_header`
- `move_rename_prompt_of_a_bookmarked_page_writes_the_file`
- `wsdelete_m_and_d_move_or_remove_the_table_and_none_offers_only_k`
- `a_library_change_during_an_apply_is_handled_by_the_closing_compare`
- `a_renamed_moved_or_deleted_workspace_folder_follows_write_back`
- `a_file_changed_during_an_edit_is_retried_once`
- `write_back_none_refuses_vimma_keys_and_puts_library_changes_back`
- `write_back_vimma_puts_library_changes_back_with_a_notice`
- `write_back_all_writes_a_library_change_after_one_second`
- `a_sync_source_burst_is_one_file_edit` (bookmarks inserted with `SOURCES.SYNC` in one batch)
- `a_sync_removal_of_many_asks_and_n_puts_them_back`
- `a_guid_change_of_the_folder_keeps_it_mirrored`
- `the_first_run_waits_for_places_browser_init_and_a_new_database_takes_the_file`
- `separators_keep_their_place_through_a_reorder`
- `a_private_window_does_not_write_the_file`
- `javascript_lines_wait_for_bookmarklets_and_data_lines_never_reach_places`
- `bookmarks_outside_mirrored_folders_are_untouched` (Menu, Other Bookmarks, a loose toolbar
  bookmark, a workspace without a table, separators and tags)
- `a_created_file_is_0600_and_an_edited_file_keeps_its_mode_and_symlink`
- `config_and_bookmarks_edits_are_serialised` (an inline-table edit and `:siteunbind --save` at
  once both land)
- `export_refuses_an_existing_file_and_export_bang_replaces_it_after_yes`
- `5000_bookmarks_load_and_a_one_line_edit_apply_within_budget` (budget measured and recorded
  when the test is written)

The `vimma_keys` refusal of the prefix and `:` is already tested
(`packages/vimma-core/test/agent-keys.test.ts`); no new e2e test, because the mochitests reach
Places, the file and the windows directly.

## Docs and changelog

- `docs/guide.md`: a new "### Bookmarks in a file" under "## Bookmarks", with the privacy
  warning first, the format, `write_back`, export, what Sync does, the one-carrier advice, and
  recovery (Library → Restore); "## config.toml" gains `[bookmarks] write_back` in **What
  applies live** and a line saying `bookmarks.toml` is the one other file Vimma reads in that
  folder; the "Bookmarks" intro's "Vimma keeps no list of its own" sentence gets the exception.
- `docs/security/08-config-toml.md`: the rules listed under Security and privacy.
- `packages/vimma-core/defaults.toml` and the `:config` template: the commented
  `# write_back = "all"` line.
- `docs/specs/bookmarks.md`: a "Since changed" note at decision 1 pointing here, with the last
  delivery PR.
- `CHANGELOG.md` `[Unreleased]`, with the PR that makes it usable (slice 1):
  "**bookmarks:** keep bookmarks in bookmarks.toml beside config.toml, one table per
  workspace, mirrored into Firefox's bookmarks and reloaded live" and, with later slices, one
  line each for write-back and `:bookmarks export`.

## Delivery

Each slice is one PR with its tests, docs and changelog line, mergeable alone.

1. **Read-only mirror.** vimma-core parse, validate, model and three-way diff; the base;
   `BookmarksFile.sys.mjs` with the poll, the settle, the apply to Places, the pause on errors
   and a missing file, the large-deletion question, the first-load question of Behaviour 18,
   the `javascript:`/`data:` rules, inline tables and D2, startup (D17), and the Places
   listener with its debounce, used here only to put outside changes back. Vimma's keys refuse
   in mirrored folders, which with the put-back is `write_back = "none"`'s behaviour; the key
   itself comes in slice 2.
2. **Vimma's write-back.** `editBookmarkLines`, the shared queue in `ConfigHost` (D11), the
   file-first path for quick add, the panel, `:wsrename` and `:wsdelete`, adoption (D7),
   duplicates, private windows; `[bookmarks] write_back` with `"vimma"` (the default for this
   slice) and `"none"`.
3. **Outside write-back.** Writing outside changes to the file through the slice 1 listener,
   the three-way merge of outside changes, guid changes, Sync's large deletions;
   `write_back = "all"`, which becomes the default, said in its changelog line.
4. **Export.** `:bookmarks export` and `export!`, `:bookmarks forget`, `Tab` completion, the
   guide's migration steps.

## Open questions

1. **Duplicate titles in one folder.** Firefox allows two bookmarks with the same title in a
   folder; a TOML table cannot hold one key twice.
   - (a) Write the second as `Title (2)` and rename it in Places to match (Behaviour 15).
     Simple, one line per bookmark; changes a title the user did not touch.
   - (b) Allow an array value, `"Title" = ["https://a", "https://b"]`. Keeps titles; a second
     syntax, and moving one of the two is a two-line diff.
   - Recommendation: (a), because duplicates are rare and usually an accident, and the notice
     says what changed.
2. **Two devices putting each other's changes back.** Under `"vimma"` or `"none"`, two devices
   with different files revert each other at every sync (D8).
   - (a) Document it only.
   - (b) Stop putting back a bookmark that was put back three times in ten minutes, pause both
     ways for that table, and say so in the status bar.
   - Recommendation: (b), because a silent tug of war uploads a change at every sync and the
     user cannot see why their edit keeps vanishing.
3. **Sync and git both carrying mirrored folders.** Under `"all"`, a change synced from another
   machine is also written to this machine's file, so `git pull` of the same change refuses
   (Design, "Sync and file edits racing").
   - (a) Document it: use one carrier.
   - (b) Add `write_back = "vimma+sync"`: Sync's changes stay in Places only and are put back
     from the file on the next file change. Works with both carriers; a fourth value, and
     Places and the file disagree between pulls.
   - (c) Let the write-back skip a change whose result already matches the file at
     `git`'s `HEAD` of the upstream branch. Precise; Vimma would have to read git state.
   - Recommendation: (a) for now, because (b) and (c) add states the user must understand, and
     the guide's advice covers the common setups.
4. **Empty folders.** A folder with nothing in it has no bookmark line to carry it.
   - (a) A key ending in `/` with the value `""` (Behaviour 2), written only while the folder is
     empty.
   - (b) Not in the file: the mirror removes an empty mirrored folder, and the panel's `A` warns
     that the folder lasts only until the next load.
   - Recommendation: (a), because `A` in the panel and `foo/bar/` in quick add make folders on
     purpose, and (a) reads like quick add's trailing `/`.
