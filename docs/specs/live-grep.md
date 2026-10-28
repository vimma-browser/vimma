# Spec: live-grep

Status: implemented · Area: `packages/vimma-core/src/` (`grep.mjs` new, `actions.mjs`, `defaults.mjs`,
`cmdline.mjs`); `src/browser/base/content/vimma/` (`actors/text-model.mjs`,
`actors/VimmaChild.sys.mjs`, `actors/VimmaActors.sys.mjs`, `actors/grep-worker.mjs` new,
`host/grep.mjs` new,
`host/VimmaHost.sys.mjs`, `ui/grep.mjs` new); `src/browser/themes/shared/vimma/grep.css` new ·
Upstream patches: none · ADR: none. No new dependency.

Issue: [#241](https://github.com/vimma-browser/vimma/issues/241)

Builds on [m1-find](m1-find.md) (`/`, smartcase), [m1-copy-mode](m1-copy-mode.md) (the caret
and `v`), [m2-picker-rename](m2-picker-rename.md) (the picker dialog and its core state
machine), [m3-workspaces](m3-workspaces.md), [m4-split-panes](m4-split-panes.md) (a selected
tab focuses its pane), [private-workspace](private-workspace.md) (the private workspace is its
own window), [vimma-mcp](vimma-mcp.md) (the agent workspace) and [tab-search](tab-search.md),
whose decision 13 leaves searching page content to a later spec; this is that spec. Vimma paths
are checked on main at 3397774 and are under `src/browser/base/content/vimma/` unless they start
with `packages/`, `src/browser/themes/`, `docs/`, `tests/` or `tools/`. Engine paths are
relative to `engine/` and checked against Firefox 158.0 (`engine/config/milestone.txt`).

## Summary

Live grep searches the text of every loaded tab in the current workspace as you type and lists
each match with its window, tab and line of context, beside a preview of the surrounding text.
`ctrl+s` widens the search to the window, to every window, and to the titles and URLs of
recently closed tabs and windows, and a scope box always says what is being searched.
`Enter` goes to the tab, scrolls to the match and selects it. It is modelled on Telescope's
`live_grep` in Neovim: a prompt, a results list, a preview, smart case and regular expressions,
and a result list to step through afterwards with `]q` and `[q`. A Vimma user with many tabs
open finds the page that said something without remembering which page it was.

## Problem

Vimma finds tabs by title and URL (the goto picker, and tab search once it is built), and finds
text inside one page (`/`). Nothing finds text across pages:

- Reading documentation in ten tabs, a user remembers a sentence about `max_tabs_undo` but not
  which tab it was in. Today they press `/max_tabs` in each tab in turn.
- A user comparing three pull requests wants every place `TODO` appears, across the three pages,
  in one list to step through.
- An error message seen in one of several CI log tabs has to be found again after switching
  away.

Firefox has no cross-tab text search either: the find bar works on one tab, and the URL bar's
`%` mode matches titles and URLs only (tab-search, Research).

## Behaviour

1. As a Vimma user with twelve tabs in `work`, `ctrl+b f g` and `retry budget` list every line
   containing those words in those tabs, each row naming its tab by number and title, and the
   list updates as I type. The current tab's matches are among them. The prompt is at the
   bottom, the best result next to it, and a preview on the right, as in Telescope.
2. As a Vimma user, `Enter` on a result selects that tab (switching to the pane that shows it,
   if the workspace is split), scrolls the match to the middle of the view and selects it with
   the find highlight. I am in normal mode, and `v` starts copy mode with the match selected.
3. As a Vimma user, an all lower-case query ignores case and a query with a capital letter
   matches case, as `/` and ripgrep's `--smart-case` do. `err(or)?s?\b` is a regular
   expression; a query that is not a valid expression, such as `c++(`, is searched literally and
   the prompt says `literal`.
4. As a Vimma user, the preview beside the list shows the selected match's surrounding lines with
   the matched line highlighted and the match marked; `ctrl+d` / `ctrl+u` scroll it. In a
   window narrower than 900 pixels the preview is hidden.
5. As a Vimma user, after I jump to a result, `]q` and `[q` go to the next and previous result of
   that search, across tabs, without reopening the list; `:grep` with no text reopens the list
   with the last query.
6. As a Vimma user with tabs that have not loaded since a restart, those tabs are listed at the
   far end of the results as `not loaded`, and `Enter` on one opens it. Live grep never loads a tab by itself.
7. As a Vimma user, a scope box above the results names the scope and lists what it covers,
   window by window: `w1 this window: work 12, notes 3 · 15 tabs, 2 not loaded`. `ctrl+s`
   widens the search from the workspace to every workspace of this window, to every window, and
   to every window plus recently closed tabs and windows, then back to the workspace.
8. As a user of the private workspace, live grep in a normal window never searches or shows a
   private tab, open or recently closed, in any scope, and live grep in a private window
   searches only private windows.
9. As a Vimma user running an agent, the agent workspace's tabs are searched only when the
   scope includes them, and their results are marked `◇ agent`.
10. As a screen-reader user, the list is a listbox whose options name the line, the tab, its
    host, its workspace and, for another window, that window, and the number of matches is
    announced as I type.
11. As a Vimma user with several windows, each result names its window (`w1`, `w2`), its tab and
    its host, and `Enter` on a result in another window brings that window to the front and
    selects the match there.
12. As a Vimma user who closed a tab a minute ago, the widest scope lists it as `closed` when its
    title or URL matches, and `Enter` reopens it and goes there; a closed window is listed as
    `closed window` and `Enter` reopens the window.

Keys and commands added:

| Key or command                 | Where       | Does                                                        |
| ------------------------------ | ----------- | ----------------------------------------------------------- |
| `ctrl+b f g`, `:grep text`     | everywhere  | `live_grep`: opens live grep, empty or with the text        |
| `:grep`                        | everywhere  | `grep_resume`: opens live grep with the last query, re-run  |
| `]q` / `[q`                    | normal mode | `grep_next` / `grep_previous`: the next / previous result   |
| typing                         | in the list | edits the query (search mode, the mode it opens in)         |
| `ctrl+n` / `ctrl+p`, `↓` / `↑` | in the list | move down / up the list (down is toward the best result)    |
| `Tab` / `shift+tab`            | in the list | the next / previous tab's first result                      |
| `Enter`                        | in the list | goes to the result                                          |
| `ctrl+d` / `ctrl+u`            | in the list | scrolls the preview down / up                               |
| `ctrl+s`                       | in the list | cycles the scope: workspace → window → all windows → closed |
| `ctrl+space`                   | in the list | keeps these results and filters them fuzzily                |
| `Esc`                          | in the list | search mode → browse mode (`j`/`k`, `gg`/`G`); again closes |

No config key is added. `keys.live_grep`, `keys.grep_next`, `keys.grep_previous` and
`keys.grep_resume` are configurable as every action is (firefox-keys).

## Research

### Telescope `live_grep` (the model)

The reference setup is a Neovim 0.12.5 configuration with telescope.nvim at tag `0.1.5`
(commit d909568, checked in an installed copy of the plugin), mapped as
`<leader>fg` to `builtin.live_grep` with no options and no `defaults` override, beside
`<C-p>` for `find_files`. Line numbers below are in that tag.

- **Separate pickers.** Finding files by name (`find_files`) and finding text in them
  (`live_grep`) are two pickers on two keys.
- **Layout.** The default `layout_strategy` is `horizontal` (`lua/telescope/config.lua:182-183`):
  80 % by 90 % of the editor, the prompt at the bottom, the results above it, the preview on the
  right (`:80-85`). The preview takes 40 % of the width below 150 columns, else 80 or 120
  columns (`lua/telescope/pickers/layout_strategies.lua:321-329`), and is hidden below 120
  columns (`preview_cutoff`). `sorting_strategy` is `descending` (`config.lua:145-146`), so the
  best result sits next to the prompt. The picker opens in insert mode (`initial_mode`,
  `:269-270`).
- **Matching.** Each keystroke runs `rg --color=never --no-heading --with-filename
--line-number --column --smart-case -- <prompt>` (`config.lua:622-623`;
  `lua/telescope/builtin/__files.lua:136-150`) and nothing for an empty prompt (`:137-139`). The
  prompt is a ripgrep regular expression. Smart case, in ripgrep 15.2.0's `rg --help`: case
  insensitive when the pattern has at least one literal character and none of its literals is
  upper case (`a\w` has the literal `a`; `\w` alone has none). The sorter is
  `highlighter_only` (`__files.lua:159`): results keep ripgrep's order, by file, and the match
  is highlighted.
- **Rows** are `path:line:column:text`, flat, one per matching line; the file name repeats on
  every row of that file. `max_results` and `grep_open_files` (search only the files open in
  buffers, `:98-101`) are options; the reference setup sets neither.
- **Fuzzy refine.** `ctrl+space` (`__files.lua:161`, `actions.to_fuzzy_refine` in
  `lua/telescope/actions/init.lua:1290`) freezes the current results and filters them with the
  fuzzy sorter.
- **Keys** (`lua/telescope/mappings.lua:135-199`). Insert mode: `ctrl+n`/`ctrl+p` and
  `↓`/`↑` move, `Enter` opens, `ctrl+x`/`ctrl+v`/`ctrl+t` open in a split or tab, `ctrl+u`/
  `ctrl+d` scroll the preview, `PageUp`/`PageDown` scroll the results, `Tab`/`shift+tab` toggle a
  multi-selection, `ctrl+q` sends every result to the quickfix list and opens it, `alt+q` sends
  the selected ones, `ctrl+c` closes. `Esc` leaves insert mode for the picker's normal mode,
  where `j`/`k`, `gg`/`G`, `H`/`M`/`L` move and `Esc` closes.
- **After the picker** Vim's quickfix list holds the results; `:cnext`/`:cprevious` step
  through them.

What Vimma takes: a picker of its own, opened ready to type; Telescope's layout, with the prompt
at the bottom, the results above it and the best result next to the prompt, and a preview on
the right, hidden when the window is narrow; regular expressions with ripgrep's smart case;
results in source order with the match highlighted; the same moving, preview-scrolling, refine
and `Esc` keys; and a list of results to step through afterwards. What Vimma changes: a row
names its tab by number and a shortened title instead of a path, because a page title is far
longer than a path; and `Tab` jumps to the next tab's results instead of building a
multi-selection (decision 9).

### Vimma today

- **Pickers.** The goto picker (`goto_picker`, `prefix+g`, `defaults.mjs:106`; `b` in normal
  mode) and the workspace picker (`prefix+w`) share one `<dialog>` in the chrome document
  (`ui/picker.mjs`, look `GOTO` at `:45`) and one core state machine
  (`packages/vimma-core/src/picker.mjs`: `openPicker` `:413`, `setPickerItems` `:433`, which keeps
  the selection when the items change, `pickerKey` `:506`). Search mode edits the query
  (`backspace`, `ctrl+u` clears, `ctrl+w` deletes a word, `:552-557`); `Esc` there goes to browse
  mode, where `j`/`k`, `left`/`right` (sections), `/` and `Esc`/`q` (close, `:538`) work. Matches
  are highlighted with `<mark>` built from text (`ui/picker.mjs:224`). The list is a
  `role=listbox` with `role=option` rows (`:214-215`). Core matching is fuzzy over item fields
  and runs in the parent; it is not a text search.
- **Tab search** ([tab-search](tab-search.md), issue #215) grows the goto picker into one list
  of every tab, every window and recently closed, matched on title, URL and rename, on the goto
  picker's key `ctrl+b g`. Its decision 13 puts page content out of scope, because Firefox has
  no index of it and loading lazy tabs to search them breaks its decision 9.
- **Find** (`/`, `?`, `n`, `N`; `defaults.mjs:186-189`) drives Firefox's find bar and finder
  (m1-find), with smartcase from `isCaseSensitive` (`packages/vimma-core/src/find.mjs:24`:
  `query !== query.toLowerCase()`). It searches one tab.
- **Page text with positions.** `actors/text-model.mjs` flattens a document's rendered text into
  one string, node by node in document order, so that a string index maps back to a DOM point
  (`pointAt`); a block boundary adds `BLOCK` and a `<br>` adds `"\n"`, and `script`, `style`,
  `noscript`, `template`, `select`, `textarea` and `head` are skipped (`SKIP`, `:20`), as are
  elements that fail `checkVisibility()`. Copy mode builds it around the caret with a reach
  limit (`textAround`, `:74`). It uses a `TreeWalker`, which does not enter shadow roots.
- **Actors.** `VimmaChild` is registered with `allFrames: true` and
  `matches: ["http://*/*", "https://*/*", "file:///*", "about:*", <start page>]`
  (`actors/VimmaActors.sys.mjs:114-133`), so every same- and cross-origin frame of those pages
  has its own child. Messages are handled in `VimmaChild.receiveMessage`
  (`actors/VimmaChild.sys.mjs:344`).
- **The agent read path.** `agent-read` reads a page with Firefox's `PageExtractor` actor
  (`ctl/agent-commands.mjs:316-345`; vimma-mcp, Research), and loads a lazy tab first with
  `gBrowser.insertBrowser` and `browser.loadURI` (`loadedPage`, `:241-255`), which is acceptable
  for an agent's own tabs but replaces a restored tab's pending session.
- **Copy mode.** `v` / `prefix+[` (`defaults.mjs:150`, `:192`) enter it; the caret's `enter`
  keeps a selection that is on screen and starts selecting from it (`actors/caret.mjs:180-193`).
  So a selected match becomes copy mode's selection with no extra code.
- **Hints** use the label characters `asdfghjkl` (`packages/vimma-core/src/hints.mjs:44`). In a
  picker those letters type into the query, so pickers number their rows instead; the tab
  number in the goto picker is the same number as `ctrl+b 1..9` and the status bar.
- **Splits.** Selecting a tab that is in a pane focuses that pane, whatever selected it
  (m4-split-panes decision 1 and 4; guide "Picking a tab during a split").
- **Keys.** Prefix keys in use (`defaults.mjs`):
  `( ) ? [ ^ a b c ctrl+6 e enter g h j k l minus n p r space v w x z` and
  `shift+a b d h j k l n p t w x`; the find group `f` (live grep's `f g`, decision 2) and
  toolbar-toggle's `u` claim two more. `prefix+/` is free, and no spec, open
  pull request or open issue claims it. In normal mode `]w`/`[w` step workspaces
  (`:202-203`); `]q` and `[q` are free. No `:grep` command exists (`cmdline.mjs:60-150`). tmux
  3.7c's default `prefix` table has no `/` (its `f` is `find-window`, `man tmux`).
- **Three-key sequences.** `compileKeymap` builds one trie per mode and walks every chord of a
  binding, however many (`packages/vimma-core/src/keymap.mjs:263-277`), so `prefix+f g` is a
  three-chord path `ctrl+b`, `f`, `g`. A node may have children and no action: normal mode's `y`
  is one today (`packages/vimma-core/test/keymap.test.mjs:139-143`). The dispatcher returns
  pending at such a node (`dispatcher.mjs:138-141`), arms no timeout because the node has no
  action of its own (`ambiguous`, `:174`), and cancels on a key with no child (`:123-136`).
  Checked on main at 7280cd5 by compiling two three-chord user keys under `prefix+f`: both ran
  their actions, `ctrl+b f x` cancelled and `ctrl+b g` still ran `goto_picker`. No default
  binding had three chords before live grep, so no test covered one.
- **Telescope's keys.** telescope.nvim's README (v0.2.1) suggests `<leader>ff` for
  `find_files`, `<leader>fg` for `live_grep`, `<leader>fb` for `buffers` and `<leader>fh` for
  `help_tags`: one `f` group for its finders.

### Firefox (checked against 158.0)

- **`PageExtractor`** (`toolkit/components/pageextractor/`) returns a page's text for Firefox's
  AI features, including open and closed shadow roots (`DOMExtractor.sys.mjs:763-765`,
  `openOrClosedShadowRoot`) and PDFs through pdf.js (`PageExtractorParent.sys.mjs:155-170`). It
  returns a string only (`PageExtractor.d.ts`, `ExtractionResult`), with no way back to DOM
  positions, its actor matches http, https, file, `moz-extension`, `data:text/html` and
  `about:reader` but no other `about:` page (`toolkit/modules/ActorManagerParent.sys.mjs:496-512`),
  and `removeBoilerplate` drops page parts on purpose.
- **The finder.** `nsIFind` (`@mozilla.org/embedcomp/rangefind;1`) finds a literal string and
  returns DOM ranges; `FinderIterator._iterateDocument` wraps it
  (`toolkit/modules/FinderIterator.sys.mjs:730-770`) with case, whole-word and diacritics
  options and no regular expressions. `Finder.requestMatchesCount(word, { contextRange })`
  returns per-match context snippets (`FinderIterator.sys.mjs:382-450`, `_extractSnippet`;
  `Finder.sys.mjs:626-660`); Firefox's page assistant uses it with `contextRange: 30`
  (`browser/components/genai/content/page-assist.mjs:269-280`). It takes its case setting from
  the tab's shared `nsITypeAheadFind` (`Finder.sys.mjs:627`) and reports to the tab's find-bar
  listeners, so using it for grep would change and depend on that tab's find bar.
- **Frames.** `FinderParent.gatherBrowsingContexts` walks a browser's browsing contexts and
  skips those under a hidden embedder (`toolkit/modules/FinderParent.sys.mjs:138-150`;
  `BrowsingContext.isUnderHiddenEmbedderElement`, `dom/chrome-webidl/BrowsingContext.webidl:498`).
  `getAllBrowsingContextsInSubtree()` (`:92`) lists them in one call.
- **Selecting and scrolling to a match** as find does: find sets the selection, switches the
  display to `SELECTION_ATTENTION` (the find colour) and scrolls the selection to the vertical
  centre (`toolkit/components/typeaheadfind/nsTypeAheadFind.cpp:518-545`). From script the same
  is `nsISelectionController.setDisplaySelection(SELECTION_ATTENTION)` and
  `scrollSelectionIntoView(SELECTION_NORMAL, SELECTION_WHOLE_SELECTION, SCROLL_VERTICAL_CENTER)`
  (`dom/base/nsISelectionController.idl:82`, `:128-154`). Find also opens closed `<details>` and
  `hidden=until-found` ancestors (`AncestorRevealingAlgorithm`, same lines), which has no script
  API.
- **Lazy, pending and discarded tabs.** A tab restored by SessionStore starts with a lazy
  browser and no `linkedPanel` (`browser/components/tabbrowser/Tabbrowser.sys.mjs:3136`,
  `#createLazyBrowser`; `browser.sessionstore.restore_tabs_lazily` true,
  `browser/app/profile/firefox.js:3001`). `discardBrowser` resets a tab to the same lazy state
  and removes `linkedpanel` (`Tabbrowser.sys.mjs:3400-3470`). A tab with a browser that has not
  restored carries `pending` (`browser/components/sessionstore/SessionStore.sys.mjs:3016`).
  SessionStore restores a pending tab when it is selected (`#onTabSelect` →
  `#maybeRestoreTabContent`, `SessionStore.sys.mjs:3228-3255`; `restore_on_demand` true,
  `firefox.js:1616`); `#restoreTabContent` (`:6674`) is private. `gBrowser.insertBrowser`
  (`Tabbrowser.sys.mjs:3245`) creates the browser but does not restore its content. Firefox
  therefore has no public way to load a pending background tab with its session history short
  of selecting it. SessionStore keeps no page text: it saves history entries, form data and
  scroll positions, and no module in `browser/components/sessionstore/` reads `textContent` or `innerText`.
- **PDFs.** pdf.js renders a text layer only for pages near the view; its whole text comes from
  `PdfJsParent.getTextContent()` (`toolkit/components/pdfjs/content/PdfJsParent.sys.mjs:400`),
  which `PageExtractor` uses. Find in a PDF is pdf.js's own, through the find bar's events
  (m1-find, Research).
- **`about:` pages** that load in the parent process (`about:preferences`, `about:addons`) are
  matched by Vimma's actor (`about:*`) and searchable the same way. `view-source:` and
  `moz-extension:` pages are not matched.
- **Recently closed tabs and windows** (`browser/components/sessionstore/SessionStore.sys.mjs`).
  `getClosedTabDataForWindow(win)` (`:4013`) returns a window's closed tabs, each with
  `closedId`, `title`, `closedAt` and the saved `state`; `getClosedTabData` (`:4036`) gathers
  them from every window of one privateness. `getClosedWindowData()` (`:4630`) returns closed
  windows with their tabs' states. A saved history entry holds the URL and title only
  (`toolkit/modules/sessionstore/SessionHistory.sys.mjs:154`), with form data and scroll
  positions beside it, and no module in `browser/components/sessionstore/` reads `textContent`
  or `innerText`: a closed tab's page text is gone. A private tab closed in a normal window is
  not saved (`:2954-2957`), and a closed window is saved only when it is not private
  (`:2015`, `:2036`), so Firefox keeps no closed private window.
  `undoCloseById(id, includePrivate, targetWindow)` (`:4957`) reopens a closed tab into the
  target window, where `undoCloseTab` selects it (`:4337`), or reopens a closed window. Firefox
  keeps 25 closed tabs and 5 closed windows by default (`browser.sessionstore.max_tabs_undo`,
  `max_windows_undo`, `browser/app/profile/firefox.js:1599`, `:1603`).
- **Other windows.** `BrowserWindowTracker.orderedWindows`
  (`browser/modules/BrowserWindowTracker.sys.mjs:448`) lists browser windows most recently used
  first. Tab search uses that order and marks another window's rows `w2`, `w3` (tab-search
  decision 4). A tab's `linkedPanel` id carries its window's outer window id
  (`browser/components/tabbrowser/Tabbrowser.sys.mjs:9657-9663`) and Vimma's own tab ids are
  UUIDs, so a tab id names one tab across windows.
- **A modal dialog's place.** `dialog:modal` is fixed with `inset-block: 0` and `dialog` has
  `margin: auto` (`layout/style/res/html.css:895-925`), so a modal dialog of fixed height is
  centred in the whole window. The page area is `gBrowser.tabbox` (`#tabbrowser-tabbox`); with
  Firefox's navigation toolbar hidden (toolbar-toggle) it starts at the window's top.

## Design

Data flow: `ctrl+b f g` opens the grep picker (`ui/grep.mjs`). Each query change, debounced, goes
to the host (`host/grep.mjs`), which sends `Vimma:Grep { gen, query }` to every frame of every
loaded tab in scope. Each frame's `VimmaChild` builds (or reuses) the frame's text model,
matches the query with the pure `grep.mjs` from core, and returns the matches with their line of
context. The parent checks each reply with core `parseGrepReply`, merges the replies in tab
order and hands them to the picker as they arrive; stale generations are dropped. Moving the
selection asks the frame for the lines around the match (`Vimma:GrepPreview`). `Enter` selects
the tab and sends `Vimma:GrepJump { gen, match }` to the frame, which selects and scrolls to the
match.

1. **A picker of its own, next to tab search.** Live grep is a second picker on its own key,
   not a mode of tab search. Telescope keeps `find_files` and `live_grep` apart for the same
   reason: one finds a thing by its name and answers at once from memory; the other reads
   content, answers in a stream, has a preview and leaves a result list. Mixing them would make
   tab search slower and its rows ambiguous; a mode key (`ctrl+g`) in one dialog was rejected
   for that reason and because the keys would mean different things per mode. Live grep shares
   the pickers' stylesheet tokens and the core picker's fuzzy matcher (for refine, decision 3),
   with its own dialog, state machine and keys.
2. **Keys: `ctrl+b f` is the find group.** `prefix+f` is a group: a prefix with no action of
   its own that waits for a third key, as `y` waits in normal mode. `live_grep` (`grep.open`) is
   `prefix+f g` and `:grep [text]`, after Telescope's suggested `<leader>fg`, so a Neovim user's
   habit carries over, and one group leaves room for more finders (`f h`, `f b`) without
   spending further prefix keys. The keymap already supports it: bindings may have three chords
   and a node may have no action (Research, "Three-key sequences"). Tab search keeps the goto
   picker's `ctrl+b g` and takes no key in the group (tab-search decision 2), so the group holds
   live grep alone for now. The alternatives were weaker: `prefix+/` pairs with `/` but starts
   no group; `prefix+shift+f` is slower to press; no default key hides the feature. `prefix+/`
   stays unbound. `:grep` is Vim's command for the same job; with text it opens with that
   query (`live_grep`), alone it reopens the last query and re-runs it (`grep_resume`,
   `grep.resume`, Telescope's `resume`, with no default key). The key opens the picker empty,
   as Telescope's `<leader>fg` does, so a new search never starts from an old query. `grep_next`
   and `grep_previous` (`grep.next`, `grep.previous`) are `]q` and `[q`, Vim-unimpaired's
   quickfix keys, next to Vimma's `]w`/`[w`.
3. **Matching: ripgrep's rules.** The query is a JavaScript regular expression with the `u`
   flag, matched per line, as Telescope's `live_grep` passes the prompt to ripgrep. Smart case
   follows ripgrep: case is ignored when the query has at least one literal character and no
   upper-case literal, so `\w+Error` matches case and `a\w` does not; this differs from `/`'s
   rule only for queries with escapes. A query that does not compile is matched literally and
   the prompt shows `literal`, so `c++(` and `what?(` find what they say rather than an error;
   this fallback is why plain literal matching with a key for expressions was not chosen, as it
   would differ from the Neovim picker for little gain. Fuzzy matching of words was rejected
   because it floods the list on large pages and cannot express an exact phrase. An empty query
   lists nothing. `ctrl+space` keeps the current results and switches the prompt to filtering
   them with the core picker's fuzzy matcher, as Telescope's `to_fuzzy_refine` does; `Esc`
   there goes back to the grep query. JavaScript's syntax covers what ripgrep users type
   (classes, `\b`, `\d`, `\w`, alternation, groups, quantifiers); ripgrep's own flags syntax
   was not checked against it, and the guide says the syntax is JavaScript's.
4. **Lines.** A page has no lines, so a line is a run of the text model between block
   boundaries and `<br>` (a paragraph, list item, table cell or heading), and `pre` text keeps
   its own line breaks. A run with nothing but white space (the space between two blocks in the
   markup) is not a line: it is never matched, numbered or shown in the preview. Collapsible
   white space reads as layout shows it: a run is one space, and a line starts without one, so
   a query with one space finds text that the markup wraps over several source lines; the model
   keeps each character's offset in its text node, so a jump still selects the page's own text.
   Lines are
   numbered from 1 in document order, per frame. Matching per
   line keeps a match from spanning two paragraphs and bounds a regular expression's work to
   one line. A row shows the line cut to 160 characters around the match (up to 60 before it),
   with an ellipsis where cut. Each match of a line is its own result.
5. **Layout: Telescope's.** The dialog takes 80 % of the window's width and 90 % of its height,
   Telescope's `horizontal` layout. On the left, a scope box (decision 10), a "Results" box and
   a "Live Grep" prompt box;
   on the right, when the dialog is at least 900 CSS pixels wide, a "Grep Preview" box taking
   40 % of the width (Telescope's proportion and, in pixels, its narrow-window cutoff). Each box
   has its title on its top border, as Telescope draws them. The prompt line reads `> query`,
   and on its right the flags that apply (`literal`, `fuzzy`, `timed out`, `cut`, `too long`)
   and the count `n / m`: `n` results listed out of `m` matches found. The results
   are listed bottom up: the best result sits next to the prompt, marked `>`, and further
   results stack above it, as Telescope's `descending` sorting does. Live grep follows
   Telescope rather than Vimma's other pickers, which keep their prompt at the top, because the
   picker is modelled on it and a Neovim user's eye goes to the bottom for it; one layout for
   every Vimma picker was the alternative, and the keys, which muscle memory relies on, are the
   same either way.

   The dialog's height is the page area's, from where the page starts to where it ends above
   the status bar, so it starts below the toolbar when the toolbar is shown and at the window's
   top when it is hidden. A dialog centred in the whole window at 90 % of its height, as at
   first, left a gap above it whenever the toolbar was hidden, because the page then starts at
   the top and the gap was the toolbar's height. A row reads, in one line:
   - its window's mark, `w1` for this window and `w2`, `w3` for the others, most recently used
     first, as tab search marks them, so a row says where it is even in the widest scope;
   - the tab's number in its workspace (the number `ctrl+b 1..9` and the status bar use);
   - the tab's title cut to 24 characters, then its host, then `:line:`, the line number in its
     frame. The host is cut to 64 characters and is empty for a URL without one (`about:`,
     `data:`, `file:`), never the URL itself, because a page can make a URL a megabyte long;
   - the line, with its match in `<mark>`, starting at most 16 characters before the match so
     that the match stays in view in a narrow list; prefixed `↳ host` when the match is in a
     frame from another site, and `◇ agent` for an agent workspace tab (decision 13).

   "Best" is source order: results in the workspace's tab order (in wider scopes, window by
   window, this one first, and workspace by workspace, the agent workspace last), then recently
   closed matches, then not-loaded tabs; matches in document order, the top frame before its
   subframes, as ripgrep's rows come by file. The order is stable as replies arrive: a reply
   from a later tab never moves an earlier tab's rows. Until the user moves the selection it is
   the best result, whichever that is once more tabs answer; once moved, it stays on its result
   while rows arrive. Tabs with no match get no row.

6. **The preview** shows the selected match's line with the ten lines before and after it,
   from the frame's text model (`Vimma:GrepPreview`), with the matched line highlighted, the
   match marked, and the line scrolled to the middle. `ctrl+d`/`ctrl+u` scroll it half a pane,
   as Telescope's insert-mode keys do; with the preview shown, clearing the query is `ctrl+w`
   word by word or `backspace`, and without it (a narrow dialog) `ctrl+u` clears as in other
   pickers. It is text, not a picture of the page: a background tab is not painted (vimma-mcp,
   Research), so a picture would mean switching tabs while browsing results, and text is
   enough to recognise the place. No preview, with the context line alone, was the simpler
   alternative; Telescope's preview is what makes a result recognisable before the jump. The
   preview box's title names the selected result's place, `w2 · work · 4 Retries · docs.test`,
   in full where the row has to cut it, so that the place of a result is never in doubt. A
   closed row's preview is built in chrome from its title and URL, says that only those are
   searched, and says what `Enter` does.
7. **Jump.** `Enter` closes the picker, selects the tab (`gBrowser.selectedTab`, which switches
   workspace and focuses the tab's pane, m4-split-panes decision 4), then asks the frame to
   select the match range, set the display to `SELECTION_ATTENTION` and scroll it to the
   vertical centre, as find does. When the tab was not selected, the parent first waits for
   Firefox's `TabSwitchDone` (`browser/components/tabbrowser/AsyncTabSwitcher.sys.mjs:347`, at
   most a second) and the frame for its next animation frame, so the page is shown at its
   own size before the match is scrolled to its middle. Focus goes to the page (to the frame,
   for a match in a subframe) and the mode is normal. `v` then enters copy mode with the match selected
   (`caret.mjs:180-193`); `y` copies it. Entering copy mode directly was rejected because `j`
   and `k` would then move the caret instead of scrolling, which surprises after a jump. If the
   page changed since the search, the frame matches the query again and takes the match with
   the same ordinal and text, else the nearest one with the same text; if none is left, the tab
   is selected and a notice says `match no longer on the page`. A frame that has navigated since
   the search (its `currentWindowGlobal` is not the one searched) gets no jump at all, and the
   same notice shows: the new document was never searched and must not receive the query or a
   selection. `n`/`N` keep stepping through
   the `/` query; they do not take the grep query, as in Vim, and a regular expression cannot be
   handed to Firefox's find anyway.
8. **The result list.** Jumping from the picker keeps that search's results in the window as
   its grep list, as Vim's `:grep` fills the quickfix list. `]q`/`[q` go to the next/previous
   result, across tabs, wrapping at the ends, and a notice says `grep 4/37`. A result whose tab
   has closed is skipped. `:grep` alone reopens the picker with that query, re-run. The list
   lives in memory for the window and is dropped when the window closes; it is not saved with
   the session. Sending results to the list only on request (`ctrl+q`, as Telescope) was
   rejected because `]q` and `[q` cost nothing until used; no list at all would mean reopening
   the picker for every next result. (Since changed: a step that is still waiting for its tab
   switch or its frame when the picker opens again stops there. It neither selects its match
   nor tells the frame to drop its text, because that frame now belongs to the new search, and
   its `Vimma:GrepEnd` stopped that search's running query, which then listed nothing; see
   `host/grep.mjs`, `step`.)
9. **Keys in the picker.** Search mode (the mode it opens in) types into the query; browse mode
   comes with `Esc`, as in Telescope and every Vimma picker. Moving keys follow the screen, as
   in Telescope: `ctrl+n`, `↓` (and `j` in browse mode) move down, toward the prompt and the
   best result; `ctrl+p`, `↑` (and `k`) move up. In both modes: those keys, `Enter`,
   `ctrl+d`/`ctrl+u` (decision 6), `ctrl+s` (scope), `ctrl+space` (refine), and
   `Tab`/`shift+tab`, which go to the first result of the next/previous tab, as tab search's
   sections do. Browse mode adds `gg` (top) and `G` (bottom, the best result), `/` or `i` back
   to typing, and `Esc`/`q` to close. Telescope's `Tab` multi-selection and `ctrl+q` are not
   taken, because every result goes to the grep list (decision 8). `ctrl+v`/`ctrl+x` (open in a
   split) are not taken either: the result is an existing tab, and showing it beside another
   changes the workspace's split, which "Show together" in the side panel already does
   deliberately. These are picker keys, not keymap bindings, as `j` and `/` in the goto picker
   are.
10. **Scope.** The current workspace by default, because a workspace is a task and the tabs of
    that task are where the text is expected. `ctrl+s` cycles to `this window` (every workspace
    of this window, the agent workspace last), `all windows` (every browser window on the same
    side of the private line, this one first, then the others most recently used first) and
    `all windows + closed` (those, and the titles and URLs of recently closed tabs and windows,
    decision 18), then back. The order goes from narrow to wide so that each press adds to what
    is searched and the next result list holds the last one. The scope resets to the workspace
    each time the picker opens, so a search never starts wider than the task. Searching every
    window by default was rejected because it mixes tasks and windows the user did not mean, and
    a fixed workspace scope because the text a user remembers is often in another window. The
    current-tab scope of the first version was dropped, because `/` already searches the
    current tab and the cycle stays four presses long.

    A scope box above the results always shows what is searched, because a list of matches does
    not show the tabs that had none, and a user who cannot see the scope cannot tell a missing
    result from a tab outside it. Its title on its border names the scope and the key,
    `Scope: all windows · ctrl+s`; a line per window gives its mark, its workspaces with their
    tab counts and its totals (`w1 this window: work 12, notes 3 · 15 tabs, 2 not loaded`,
    `w2: personal · 5 tabs`); past five windows the rest are summed in one line, so that the box
    stays a few lines high. In the widest scope a last line says what recently closed holds and
    that only titles and URLs are searched there. The box is shown before anything is typed.
    Showing the scope only as a word in the prompt, as at first, was rejected because the word
    did not say which windows and tabs it covered.

11. **Not-loaded tabs are listed, not loaded.** A tab with no `linkedPanel` (lazy or discarded)
    or with `pending` has no content to search. Each gets one row at the far end of the
    results, `not loaded` and its title and host; `Enter` on one selects it, which loads it, and
    the user can grep again. Loading them for the search was rejected: Firefox restores a
    pending tab only when it is selected (Research), so loading means selecting every tab in
    turn or replacing its pending session with a fresh load that drops its back history, and
    either costs memory and network for a query. SessionStore has no saved text to search
    instead.
12. **What is searched in a frame.** The rendered text the text model collects: text nodes in
    flat-tree order (open and closed shadow roots through `openOrClosedShadowRoot`, as
    `PageExtractor` does, and slotted content where its slot is), skipping `SKIP` elements and
    elements that fail `checkVisibility()`, through a new `textOfDocument(win, cap)` beside
    `textAround`. Not searched: form field values, text drawn on a canvas, images, closed
    `<details>` and `hidden=until-found` content (not rendered, and Vimma cannot reveal them as
    find does), PDFs (pdf.js renders only the pages near the view and finds through its own
    find bar events, so a jump would need a second path; a later change can add them through
    `PdfJsParent.getTextContent()`), and pages Vimma's actor does not match (`view-source:`,
    `moz-extension:`). Every frame is asked separately through
    `getAllBrowsingContextsInSubtree()`, skipping those under a hidden embedder as
    `FinderParent` does, so cross-site frames in other processes are searched by their own
    child.
13. **Private and agent workspaces.** Live grep never crosses the private line, because the
    private workspace's pages must not reach a normal window's list, or the other way. A normal
    window's widest scopes take only normal windows, and their recently closed tabs and windows;
    a private window's take only private windows and their closed tabs (Firefox keeps no closed
    private window, Research), as tab search decision 5 does. The agent workspace is searched
    only when the scope includes it (from `this window` on, or the workspace scope when the
    agent workspace is current); its rows, closed ones included, are marked `◇ agent` in the
    agent's colour and sort last, as in tab search decision 6, so that an agent's pages are
    never taken for the user's own.
14. **Performance and bounds.**
    - A query is sent 80 ms after the last keystroke. Each send carries a generation number;
      replies for an older generation are dropped, and a frame drops a query older than one it
      has already seen. Generations count per window, so a frame forgets the last one it saw
      when the picker closes (`Vimma:GrepEnd`), and a tab moved to another window is searched
      again from there.
    - Matching runs in the content processes, one per site, so tabs search in parallel and the
      parent only merges. At most 8 tabs are asked at a time; a frame that has not answered in
      2,000 ms is left out and the prompt says `timed out`. Up to 200 tabs and 100 frames a tab
      are searched; past that the prompt says `cut`, as it does for a page whose text was cut.
    - In a frame, the text model is built on the page's thread (it reads the DOM), and the
      regular expression runs in a `ChromeWorker` (`actors/grep-worker.mjs`). Each content
      process has one worker, shared by its frames that are being searched
      (`actors/grep-matcher.mjs`): it holds each frame's text by key and runs one query at a
      time. One worker a process was chosen over one a frame because a page with 100 frames
      would otherwise start 100 threads, each with its own copy of the core modules; a small
      pool was not needed, because a query takes milliseconds and the budget bounds the slow
      one. A frame whose text is blank is answered without the worker. A query that runs for
      1 second is stopped by terminating the worker, and its frame answers `timed out`; a
      frame's newer query replaces its queued or running one. The next query starts a new
      worker, which gets the frames' texts again; the worker ends when the picker closes and
      no frame holds text in it. JavaScript's regular expressions
      backtrack, and SpiderMonkey sets no time limit on chrome script
      (`dom.max_chrome_script_run_time` is 0 in `modules/libpref/init/StaticPrefList.yaml`), so
      without the worker a pattern such as `(a+)+b` on a long line of `a`s would freeze every
      page of that process. A per-line time check was rejected because one `exec` call cannot
      be interrupted.
    - A query over 1,000 characters is not sent; the prompt says `too long`.
    - A frame's model is cut at 1,000,000 characters. A frame lists at most 100 matches and
      counts to 1,000; the list holds at most 2,000 rows, and once the parent holds 2,000
      matches for a search it keeps the matches of the replies that rank first in the list
      (tab order, then frame order) and only the counts of the rest, whatever order the
      replies arrive in. The last reply that fits only in part keeps its first matches, so
      that exactly 2,000 are held; stopping before it would leave the list short of what it
      can show. Telescope has no such
      caps by default; a page can be far larger than a source file, and a rendered list of
      thousands of rows does not help a keyboard user, who narrows by typing.
    - The frame caches its text model while the picker is open and drops it, its observer and
      its worker when the picker closes (`Vimma:GrepEnd`). Every frame the query was sent to
      gets `Vimma:GrepEnd`, whether or not it answered in time. A `MutationObserver` on the
      document marks the model stale; it is rebuilt at the next query, not on each mutation. A
      navigation creates a new document and actor, so nothing survives it.
    - Recently closed titles and URLs are matched in the parent process, in a worker of its own
      through the same `actors/grep-matcher.mjs`, with the same 1-second budget, because a
      title is page-controlled text and a backtracking pattern on it would otherwise freeze the
      browser's own window. At most 25 closed tabs and 5 closed windows (20 tabs each), as
      Firefox keeps, are matched, each title and URL cut to 1,000 characters, and only the first
      match of each title or URL is taken, so that one title full of matches cannot use up the
      count and hide the entries after it. A picker session sends them under one key, so a
      newer query replaces the older one in the worker instead of queueing behind it, and
      closing the picker drops them. A window SessionStore does not track yet (one that has only
      just opened) is skipped, because SessionStore throws for it and it has nothing closed.
    - Budget, measured in a test: matching a query against 1,000,000 characters under 50 ms.
    - The parent holds only what it shows: a context line per listed match (at most 160
      characters) and the preview's lines. Page text is not written anywhere.
15. **Accessibility.** The list is a `role=listbox` with `role=option` rows, each option's
    accessible name holding the line, the tab's title, its host and its workspace
    (`retry budget is 3, Retries – docs, docs.test, work`), and `window 2` for another window,
    because the window and host are what the row shows; a closed row's name says
    `recently closed tab` or `recently closed window`; a polite live region announces
    `37 matches in 6 tabs` or `no matches` after results settle; the preview is a
    `role=region` named "Grep Preview" and the scope box one named "Scope". The `literal` and
    `fuzzy` flags and the `closed` label are words, not colours, so that they read without
    colour vision.
16. **Theme.** Existing tokens only, so that live grep follows the Omarchy theme as the other
    pickers do and adds nothing a theme must define: box borders `--vimma-muted`, box
    titles `--vimma-text-accent`, window marks, tab titles, hosts, URLs, the scope lines and line
    numbers `--vimma-fg-dim`,
    `<mark>` as in the goto picker, the `>` marker and the selected row as the goto picker's
    selected row, the agent marker `--vimma-text-cyan`, and in the preview the matched line
    with `--vimma-selection`. No new token.
17. **Out of scope**, each for the reason given where it is decided or because nothing asks for
    it yet: the page text of closed tabs (SessionStore keeps none, Research); history and
    bookmarks content; PDFs (decision 12); replacing text; Telescope's split and tab openers
    (decision 9); an agent or `vimma-ctl` command for grep, so that an agent never reads pages
    outside its workspace; search inside form fields.
18. **Recently closed tabs and windows.** The widest scope adds them because a page closed a
    minute ago is often the one the user remembers, and tab search already lists them. Firefox
    keeps no page text for them (Research), so they match on their title and URL only, with the
    same query rules as page text, and the scope box says so. A closed tab is one row labelled
    `closed`, its title and URL with the match marked and its window's mark; a closed window is
    one row labelled `closed window`, showing the first of its tabs that matches. They come
    after the open tabs' matches, newest first, the agent's last. `Enter` reopens the tab in
    this window and selects it (`undoCloseById`, as tab search does), or reopens the window and
    brings it to the front. An entry restored or dropped since the search reopens nothing, and a
    notice says `no longer in recently closed`, so that `Enter` never fails silently. A closed
    window's row is the agent's when the tab it shows was in the agent workspace's container,
    so that an agent's closed page is marked as an open one is (decision 13). A key of its own for reopening was rejected because `Enter` already
    means "go there", and a closed tab has nowhere else to go. They never enter the grep list,
    because `]q` must not reopen a tab the user did not pick.

## Security and privacy

Live grep is chrome UI reading text the user's own pages already show. It adds no
control-socket command, so neither `vimma-ctl` nor an agent connection can run it or read its
results. Container isolation is unchanged: the parent sends the query to each in-scope frame's
own content process, which answers from its own document; no page receives another page's text.
Three things are exposed, as Firefox's find bar exposes them: the query reaches every frame in
scope, third-party iframes, agent tabs (from the window scope on) and the user's other windows
(from the all-windows scope on) included, so a compromised content process can read it; a jump selects the match, which the page can read; and building the text
model runs on the page's thread, so a page can tell from timing that it was searched.

Page text is untrusted: rows and the preview are built from text nodes and `<mark>` elements
created in chrome, never from markup, so a page cannot inject content into the picker. Every
reply is checked and capped in the parent (core `parseGrepReply`, `parsePreviewReply`), at most
100 frames a tab are searched and at most 2,000 matches are kept, so a page with thousands of
frames cannot make the parent hold an unbounded search. The private boundary holds in every
scope: other windows are taken only on the same side of the private line, and recently closed
data only from those windows (decision 13); a test pins both directions in each scope. Agent tabs are marked so their content is
never taken for the user's own. A jump goes only to the document that was searched (decision 7).
Nothing is written to disk: the text model lives in the content process while the picker is
open and is dropped by every frame the query reached, the parent keeps only context lines and
the grep list in memory, drops a closed tab's lines, and none of it goes into the session store.
A regular expression runs in a worker that is stopped after 1 second (decision 14), in the
page's content process for page text and in the parent process for recently closed titles and
URLs, so a pathological pattern costs at most that, in one worker thread, and never freezes a
page or the browser's own window. Recently closed tabs and windows come from SessionStore, which
holds their titles and URLs in memory already; live grep keeps no copy after the search.
[security.md §15](../security.md) lists the rules (L1 to L8) and their tests.

## Tests

Written first and seen to fail.

### Vitest (`packages/vimma-core/test/`)

- `grep.test.mjs` (new, pure):
  - `parseQuery`: smart case per ripgrep (`foo` ignores case, `Foo` matches it, `a\w` ignores,
    `\w+Error` matches, `\p{Lu}x` ignores, `\w+` with no literal matches); an invalid
    expression gives a literal query flagged `literal`; an empty query gives none.
  - `grepText(text, query, caps)`: lines split at `BLOCK` and `"\n"`; matches with start, end,
    line and ordinal; blank lines neither matched nor numbered; the context cut to 160
    characters around the match; the per-frame cap of 100 listed and 1,000 counted;
    zero-length matches (`^`, `\b`) do not loop and are not listed.
  - `previewLines`: the ten lines before and after a match, the matched line's index and the
    match's range in it, fewer at the start and end of the text, blank lines left out.
  - `parseGrepReply`: a reply from a content process is copied field by field; wrong types,
    overlong lines and too many matches drop the reply or are cut.
  - `grepRows`: rows in tab order whatever order replies arrive in; frames in their order; the
    agent workspace's rows last; not-loaded rows at the far end; the 2,000-row cap.
  - `holdReplies`: at most 2,000 matches kept, those of the best-ranked replies even when
    they arrive last, the last reply that fits in part cut to fill the 2,000; the rest keep
    only their counts; `stepGrepList`: `[q` from a closed
    row goes to the last row;
    `parseGrepReply` keeps `timedOut` and `cut` as booleans; `parsePreviewReply` clips the
    match to its line; `pruneGrepList` drops a closed tab's rows and keeps the place.
  - the grep list: `stepGrepList` order across tabs, wrapping, skipping closed tabs; the
    notice text `grep 4/37`.
  - picker keys (`grepPickerKey`): `ctrl+n`/`↓`/`j` move toward the best result and
    `ctrl+p`/`↑`/`k` away from it; `gg`/`G`; `Tab`/`shift+tab` go to the next/previous tab's
    first result; `ctrl+s` cycles the scope; `ctrl+space` enters refine and `Esc` leaves it;
    `ctrl+u` scrolls with a preview and clears without one; `Esc` search → browse → close;
    the best result stays selected as rows arrive until the selection moves.
  - `grepRows`: rows carry their window mark and host; closed rows come after open matches and
    before not-loaded tabs.
  - `grepClosed`, `closedSearchText`, `closedRows`: a title or URL match is a closed row with the
    match marked; smart case and the literal fallback apply; a closed window matches through its
    tabs and shows the first that matches; newest first, at most 25 tabs and 5 windows; the
    agent's last, a closed window marked the agent's by the tab it shows. `closedPreview` names
    the row and what `Enter` does. A host-less URL gives no host; a closed window's tabs past 20
    and fields past 1,000 characters are not matched; one title with a thousand matches does
    not hide the entries after it.
  - `grepScopeText`: one workspace; windows grouped with their workspaces and counts, the agent
    marked; the closed line; past five windows one summed line; no tabs.
  - `ctrl+s` cycles workspace → window → all windows → closed → workspace.
  - bench: `grepText` over 1,000,000 characters under 50 ms.
- `keymap.test.mjs`: the `prefix+f` node has no action and has the child `g`; `ctrl+b f g`
  dispatches `live_grep` and `ctrl+b f` followed by an unbound key cancels.
- `actions.test.mjs`, `defaults.test.mjs`, `cmdline.test.mjs`, `help.test.mjs`: `live_grep` on
  `prefix+f g`, `grep_next`/`grep_previous` on `]q`/`[q`, `:grep [text]`; the help rows. The
  help snapshot is re-recorded with a changelog line; `docs/bindings.md`, `bindings.json` and
  `defaults.toml` are regenerated.

### Mochitests (`tests/browser/`)

- `browser_vimma_live_grep.js` (new):
  - Three fixture tabs in one workspace and one in another: `ctrl+b f g`, `needle` lists the
    matches of the three in tab order, the first tab's first match next to the prompt; the
    fourth appears after `ctrl+s` (window scope); the scope box names each scope as `ctrl+s`
    cycles through all four and back.
  - The scope box lists this window, its workspaces and tab counts before anything is typed,
    and sits above the results.
  - A row shows its window mark, tab and host; the preview's title names the result's place.
  - A second normal window: the all-windows scope lists its match after this window's, marked
    `w2`, and `Enter` brings that window to the front with the match selected.
  - A closed tab and a closed window match on their titles in the closed scope (never in
    narrower scopes, and never on the closed page's text), labelled `closed` and
    `closed window`; `Enter` reopens the tab and selects it, and reopens the window.
  - A catastrophic pattern against a closed tab's title answers `timed out` within the budget
    and the next query finds the title.
  - The closed titles are held in the parent's worker under one key while the picker is open,
    and under none once it closes.
  - `Enter` on a closed row whose entry is gone since the search says so and reopens nothing.
  - A grep list reaching two windows: closing the other drops its lines and stops watching it;
    `]q` then says `grep 1/1`.
  - A window SessionStore throws for is skipped, and the closed scope still lists the rest.
  - Closed rows, their preview and the preview's title show markup in titles as text.
  - The dialog starts where the page area starts, and moves up with it when the navigation
    toolbar is collapsed.
  - `Enter` on the second tab's match selects that tab, the selection is the match text, the
    display is `SELECTION_ATTENTION`, the match is within the viewport's middle third, and the
    mode is normal; `v` then enters copy mode with that selection.
  - A match in a cross-site iframe (a second origin in the test server) is listed with `↳ host`
    and the jump selects it in the frame.
  - A match inside an open and inside a closed shadow root is listed and jumps there.
  - Smart case and the regular expression: `Needle` and `nee+dle` against fixture text; `c++(`
    shows `literal` and finds the literal text.
  - A lazy tab (never selected) is listed as `not loaded` and is still unloaded after the
    search; `Enter` on it selects it.
  - The page changes after the search (a script removes the first match): the jump takes the
    remaining match; with none left the notice says so.
  - `]q`/`[q` after a jump go to the next/previous result across tabs and wrap; closing a tab
    skips its results; `:grep` alone reopens with the query.
  - A split workspace: `Enter` on a result in a pane's tab focuses that pane.
  - The preview shows the lines around the selected match with the matched line marked, and
    is hidden in a dialog narrower than 900 pixels.
  - Stale generations: replies to an older query never appear after a newer query's results.
  - A private window: grep there lists only its own tabs and its own closed tab in every
    scope, and none of the normal window's closed tabs or windows; grep in the normal window
    lists none of the private ones, open or closed, in any scope, also after the private window
    has closed.
  - An agent workspace tab's results appear only from the window scope on, marked `◇ agent`,
    last.
  - Accessibility: option names hold the line, the tab's title, its host and its workspace;
    the live region says `N matches in M tabs` or `no matches`.
  - Page text and a title with markup show as text; no page element reaches the picker or the
    preview.
  - Closing the picker tells every searched frame to drop its text model, also a frame whose
    answer was still on its way when the picker closed.
  - A tab with 150 frames: 100 frames are searched and the prompt says `cut`.
  - `]q` to a frame that has navigated since the search: nothing is selected there and the
    notice says the match is gone.
  - A query over 1,000 characters says `too long` and asks no frame.
  - A catastrophic pattern (`(a+)+b`) against a line of 40 `a`s: the prompt says `timed out`
    within the budget, the page still answers, and the next query finds its match; sent to
    the frame alone, it is answered `timedOut` within 1.5 seconds.
  - A frame drops a query with an older generation than one it has seen, and forgets the
    generation at `Vimma:GrepEnd`.
  - A page with three frames and a blank one: one worker in the process, holding four texts,
    and none after the picker closes.
  - Closing a tab removes its lines from the grep list.

### e2e (`tests/e2e/scenarios/`, Xvfb) and screenshots

- New scenario `issue-241-live-grep.json`: one workspace with fixture tabs from
  `tests/e2e/fixtures/`;
  `ctrl+b f g`, type `needle`; screenshot `live-grep.png` with the preview, then `Enter` and
  screenshot `live-grep-jump.png` with the selected match. Checked first with the real Omarchy
  theme (`vimma.theme.source=omarchy`) and recorded in the default theme as new baselines, with
  the changelog line "baselines for live grep".
- The `ctrl+b ?` overlay, filtered to `grep`, is checked in a screenshot with the new rows.

## Docs and changelog

- **`docs/guide.md`**: a new section "Live grep" after "Find": opening it, the query syntax
  (JavaScript regular expressions, ripgrep's smart case, the literal fallback, refine), the
  layout and preview, the keys, scope, the jump and copy mode, the grep list and `]q`/`[q`, what
  is not searched (not-loaded tabs, form fields, canvases, closed `<details>`, PDFs), the scope
  box and the four scopes, recently closed tabs and windows, and the private and agent rules. Rows for `ctrl+b f g`, `]q`, `[q` in the keys table, and `:grep` in
  "The command line".
- **README**: a feature line, "live grep: search the text of every tab in your workspace and jump
  to the match, like Telescope's `live_grep`".
- **`docs/security.md`**: §15, rules L1 to L8: the grep messages between the parent and content
  processes, what the parent accepts from a reply, the private and agent boundaries, and the
  worker that matches recently closed titles and URLs, each with its test.
- **`docs/bindings.md`, `bindings.json`, `defaults.toml`**: regenerated with `npm run gen-docs`.
- **`CHANGELOG.md` [Unreleased]**: "Live grep: `ctrl+b f g` and `:grep` search the text of the
  tabs in your workspace and jump to a match; `]q` and `[q` step through the results", and a
  line for the help snapshot and the new baselines.

## Delivery

One pull request, `feat(grep): live grep across the workspace's tabs, on ctrl+b f g`, with every
decision above, its tests, the e2e scenario and the docs. The parts are not useful on their own
(a search without its key, or a key without its preview), and one pull request needs no feature
pref to hide a half-built picker. It adds default keys, so it is a keymap pull request and waits
its turn in the keymap queue (one keymap pull request at a time). It adds the first three-chord
default binding and, with it, the keymap test that `prefix+f` is a group with no action of its
own. It is checked in e2e screenshots with the Omarchy theme before review.

## Open questions

None. Every question is answered in Design: a picker of its own (decision 1), ripgrep's
matching (decision 3), Telescope's layout with the prompt at the bottom (decision 5), the
preview (decision 6), the jump (decision 7), the result list (decision 8), the scope and the
scope box (decision 10) and recently closed tabs and windows (decision 18).
