# Spec: m1-find

Status: implemented · Milestone: M1 (prototype slice) · Area: host
(`src/browser/base/content/vimma/host/find.mjs`), actors, core (`find.mjs`, `statusbar.mjs`)

## User story

As a user, in normal mode `/` lets me type a search and see the page jump to the first match
as I type, in every frame and in PDFs, as Firefox's find does. `Enter` leaves me on the match in
normal mode; `Esc` takes me back to where I was. `n` and `N` jump to the next and previous
match, wrapping at the ends; `?` searches backward. An all lower-case search ignores case, one
with a capital matches case (Vim's smartcase). The status bar shows `/word [2/5]`, or
`/word not found`.

## Bindings (plan §2, `defaults.mjs`)

`[modal.normal]`: `/` `find.forward`, `?` `find.backward`, `n` `find.next`, `N`
`find.previous` (action names `find_forward`, `find_backward`, `find_next`, `find_previous` in
`actions.mjs`). `?` is help only after the prefix (`ctrl+b ?`) and inside help (`/` filters), so
the bare `?` is free for find. Plan §2: "Search in page — `/ ? n N`".

## Approach: Firefox's find bar is the input

Decided: drive Firefox's own find bar (`toolkit/content/widgets/findbar.js`) and finder
(`FinderParent.sys.mjs` → `FinderChild` → `Finder.sys.mjs` → `nsITypeAheadFind`), visible and
not restyled, rather than our own input calling `browser.finder`:

- It already searches out-of-process frames (FinderParent walks every browsing context), open
  and closed shadow roots and editable fields, highlights, scrolls the match into view and
  counts matches (`onMatchesCountResult`).
- pdf.js takes over the find bar's events (`PdfJsParent` listens for `find`/`findagain` on the
  bar and cancels them), so the PDF viewer works through the same bar with no code of ours.
- Our own input would have to rebuild typeahead-as-you-type, IME composition, the
  "not found" state, pdf.js's protocol and the bar's accessibility.

What Vimma adds (`host/find.mjs`, class `Find`, one per window, created by `VimmaHost.init`):

- **`/` and `?`** (`CONTENT_RUNNERS`, so they run only on a page with our actor, like
  scrolling): remember the page's scroll position (`Vimma:ScrollPosition`), anchor the search
  (below), `gBrowser.getFindBar(tab)`, then `findbar.open()` and focus its field, empty. Not
  `startFind()`: its prefill with the page's selection arrives asynchronously and takes focus
  back into the bar after `Enter` (it did, in pdf.js). (Since changed: `/` or `?` while the
  tab's search is still open but the focus has left its field, after a click on the page, used
  to do nothing; it now focuses the field again with its text selected, keeping where the search
  started and taking the key's direction; `Find.start` in `host/find.mjs` and `docs/guide.md`,
  "Find".)
- **Keys typed while Firefox creates the bar** (one animation frame on first use per tab) are
  buffered and put into the field, then an `input` event runs the bar's own search; `Enter` and
  `Esc` in that window are queued or cancel. So `/word<Enter>` typed at full speed works and no
  key reaches the page.
- **`Enter`** (keydown in the window's capture phase, before the bar sees it, while the bar's
  field has focus): waits for the result of the incremental search (at most 1 s), then closes
  the bar. Found: the match stays selected (Firefox turns the find selection into a normal
  one) and focus returns to the page. Not found: like `Esc`, but the status bar keeps
  `/word not found`. Waiting matters: Firefox reopens the bar on a failed search it is told of.
- **`Esc`**: unselect (before `close()`, which forgets the frame of the match), close without
  focusing the matched link (a finder listener's `shouldFocusContent` returns false), focus the
  page, scroll back, re-anchor.
- **`n` / `N`**: `browser.finder.findAgain(query, backward)` with `caseSensitive` set by
  smartcase; in pdf.js, `findbar.onFindAgainCommand()` (its `findagain` event). After a search
  that found nothing in this page they do nothing (Firefox's F3 would reopen the bar).
- **A match in a text field** (#164): Firefox's finder focuses the field it matched in (the
  find bar's close, `Finder.focusContent`; and `n` while the page has focus, nsTypeAheadFind
  itself). The child actor recognises that focus (no user input is being handled and the
  frame's finder has the field as `foundEditable`; not one the actor gives itself for `i` or a
  hint), sends no focus report, and after the finder's task blurs the field, restores the match
  as its selection (the close collapses it) and shows it as the find's ATTENTION selection. So
  the tab stays in normal mode, no key types into the field, and `n` goes on from the match.
  The finder focuses the field at most once per find step (a search, `n`, `N`), and its
  `foundEditable` names the field until the next one, so the actor counts only the first focus
  of a step as the find's (#442): the host sends every frame `Vimma:FindStep` before each step,
  and a later focus in the same field (the page's own script) is reported, so it enters insert.
- **Status**: a finder result listener per tab records `{ query, backward, current, total,
limit, notFound }`; `VimmaHost.status(win).find` returns it for the selected tab while its
  URL is the one searched, and `mode: "command"` while a search is typed (Vim's command-line
  mode). `ui/statusbar.mjs` passes it to core's `statusSegments` (`find` segment, right side).

## Tests (written first)

- `packages/vimma-core/test/find.test.mjs`: smartcase table and property (a lower-cased query
  is never case-sensitive); `findStatusText` (`/word [2/5]`, `?word [1/3]`, `/w`, `/e [>1000]`,
  `/zzz not found`); the status bar's `find` segment (absent without a find, right side before
  the URL, error colour when not found).
- `tests/browser/browser_vimma_find.js` with `file_vimma_find.html` ("word" ×3 and "Word" once,
  a 3000 px gap after the first, a same-origin and a cross-origin frame from
  `file_vimma_find_frame.html`):
  - `/word` `Enter` from a scroll position with the first "word" above the viewport selects the
    first match below the top; `n`, `n`, `n` (wraps to the first), `N` (wraps to the last),
    `N`; 4 matches counted; the bar closed, focus on the page, normal mode; the page saw none of
    the keys (head.js `recordPageKeys` / `focusContent` / sentinel `z`).
  - `?word` `Enter` with the third match at the viewport top lands on the second; `n` goes on
    backward, `N` forward.
  - Smartcase: `/Word` selects only "Word" (1 match, `n` stays); `/word` counts 4.
  - `Esc` after the incremental search scrolled far: back to 0, nothing selected, no find in the
    status bar, `COMMAND` while typing, none of the keys reached the page.
  - `/mango` is found in the cross-origin frame, `/kiwi` in the same-origin one.
  - `/zzzqqq` `Enter`: the status bar's segment reads `/zzzqqq not found`; the page does not
    move; `n` and `N` are consumed, do not reopen the bar, move or select anything.
  - The PDF viewer: `/e` `Enter` selects pdf.js's first match, `n` the second, `N` the first.
- `browser_vimma_help_overlay.js` `tab_select_resets_a_pending_prefix` pressed a bare `?` to
  prove the prefix was reset after a tab switch, expecting the page to get it. `?` is now find:
  the test asserts the find bar opened and help did not (the same claim, through `?`'s new
  binding), then `Esc`, and that the page saw neither key.

## Settled (2026-10-09)

- **Find bar, not our own input** (above). It stays visible at the foot of the page with its
  match count and "Phrase not found"; restyling it is M5's theme work.
- **Smartcase** for `/`, `?`, `n`, `N` and `ctrl+f` alike: `accessibility.typeaheadfind.casesensitive`
  defaults to 2, the bar's "auto" mode (`str != str.toLowerCase()`, the same test as core's
  `isCaseSensitive`), in `firefox-branding.js`; a user value in `about:config` wins. The bar
  sends pdf.js `caseSensitive: true` in that mode (`!!2`), so a capture listener on the window
  rewrites the event's `detail.caseSensitive` by smartcase before PdfJsParent forwards it.
- **Where a search starts: the cursor, i.e. the viewport.** Firefox's first search in a page
  starts at the first _rendered_ match from the document start (`nsTypeAheadFind`'s
  `IsRangeRendered` ignores the viewport clip), and a search that extends the previous text
  continues from the previous search's start. Vim starts at the cursor; Vimma's cursor is the
  viewport. Before each `/`/`?` (and after `Esc`) the actor (`Vimma:FindAnchor`) keeps a
  selection that is on screen (an accepted match), else collapses the caret at the viewport's
  top-left (`caretPositionFromPoint(1, 1)`, skipped when unscrolled or an element has focus),
  then resets the frame's typeahead buffer with a search for U+FFFF, which cannot match:
  with a non-empty, unrelated buffer `nsTypeAheadFind` starts at the selection. This calls
  `FinderChild.finder._fastFind` (Firefox has no API for a start point); it is the only private
  member read in content.
- **`Enter` keeps the finder's frame.** `findbar.close()` clears FinderParent's
  `_lastFoundBrowsingContext`, after which `findAgain` restarts as a new forward search from
  the top frame (`doFind`), so `N` right after `Enter` went forward and `n` could repeat the
  match. The host saves and restores that field around `close()`.
- **`?`** searches forward as you type (Firefox's incremental find has no backward mode) and
  `Enter` steps back once (`findAgain(query, true)`): the first match after the cursor, then the
  one before it, is the last match before the cursor, and Firefox's wrapping covers "none
  before". `n`/`N` follow the search's direction, as Vim.
- **`Esc`** (Vim with `incsearch`): back where the search started, nothing selected, the
  cancelled text forgotten (`n` repeats the last accepted search). The highlight goes with the
  bar: Firefox's "Highlight All" is the bar's own setting.
- **Not found**: `Enter` returns to where the search started, the status bar keeps
  `/word not found` (red) and `n`/`N` do nothing until the next search; Vimma does not use
  Firefox's "reopen the bar" behaviour.
- **Status bar, not the find UI** (#34 merged): `find: { query, backward, current, total,
limit, notFound }` in `VimmaHost.status()`; the segment is `/word [2/5]`, `/w` until counted,
  `/e [>1000]` over the count limit, priority 3 on the right before the URL. While typing the
  mode badge says `COMMAND`; dispatch itself stays in `insert` (focus is in a chrome field), so
  `command`'s keymap (the `:` line's `command.cancel`) is untouched.
- **Host changes are additive:** a `find` field in `WindowState`, four `CONTENT_RUNNERS`, one
  early return in `_onKeyDown` (only with no pending prefix, so `ctrl+b` sequences still work in
  the bar), and `status()`'s extra field. Actor: `Vimma:ScrollPosition`, `Vimma:ScrollTo`,
  `Vimma:FindAnchor`. No upstream patch, no new dependency.

## Limits

- `?` previews forward while typing; `Enter` then steps back (above).
- `Esc` restores the top page's scroll, not a frame's or pdf.js's inner viewer's.
- pdf.js reports its match count to the find bar only, so the status bar shows no count for a
  PDF.
- A count before `n` (`3n`) searches once. `N` right after `Esc` or a reload searches forward
  once (the finder has no previous match).
- A fixed header at the viewport's top-left makes the search start at the header's place in
  the document.

## Verification

- Red (core): `find.test.mjs` failed to import `../src/find.mjs`; with it, "status bar find
  segment … on the right" failed (`expected [ [ 'mode', 'left' ], …(3) ] to deeply equal
[ [ 'mode', 'left' ], …(4) ]`). Green: 1056/1056, then 1382 passed (all packages).
- Red (browser, no host code): 19 passed / 12 failed, e.g. `/word Enter selects the first match
below the top - "" == "w2:word"`, `a match in the cross-origin frame - "" == "text:mango"`,
  `the status says not found - timed out`, `pdf.js selects the first match - timed out`.
- Along the way: Firefox's own `ctrl+f` from the same scroll position selected `w1` (the
  document's first match), which led to the anchor; counts were lost when `Enter` closed the bar
  before the count came back (now re-requested after closing); a count of 0 from an interrupted
  count turned matches into "not found" (counts no longer decide that); the bar's prefill took
  focus after `Enter` in pdf.js (now `open()`, no prefill); pdf.js's debounced search was
  dropped by closing the bar (now `findagain` on `Enter`).
- Green: `browser_vimma_find.js` 57/0; `--repeat=9` pinned to two CPUs (`taskset -c 0,1`)
  513/0. Full `tests/browser/` on the artifact build: 868/0. After merging main (link hints #37, the split and workspace planners), by
  hand with rerere off (`VimmaChild` and the docs kept both sides): 1065/0. Again after the `:` command line,
  the control server and the which-key removal: 1425/0.
- Mutation: without `VimmaActors.findAnchor(browser)` in `start()`, "/word Enter selects the
  first match below the top" fails with `"w1:word" == "w2:word"` (and the `n`/`N` and `?`
  steps after it); reverted.
