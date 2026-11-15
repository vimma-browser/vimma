# Spec: m1-copy-mode

Status: implemented · Milestone: M1 · Area: actors
(`src/browser/base/content/vimma/actors/`), host (`host/`). Builds on
[m1-actor-insert-scroll](m1-actor-insert-scroll.md) (the actor pair, focused-frame messages),
[m1-core-logic](m1-core-logic.md) (`visual` mode, `escape.mjs`) and [m1-hints](m1-hints.md)
(strict checks of content replies). Completes plan §6's M1 row.

## User story

As a user, `v` (or `ctrl+b [`, tmux's copy mode) puts a caret at the top of what I see, or at
the selection if one is on screen, and the badge says `VISUAL`. `h j k l w b 0 $ gg G` move it
and the page scrolls to follow. `v` starts a selection at the caret that the motions extend
(`v` again drops it). `y` copies the selection as plain text, says "yanked N chars" and I am
back in normal mode. `Esc` drops the selection and leaves. The page sees none of these keys.

## Bindings (plan §2, actions.mjs, defaults.mjs)

Plan §2 binds copy mode to `prefix+[` and `v`; `[modal.visual]` had `h j k l w b y` and `Esc`.
This spec adds `0` / `$` (line start / end), `gg` / `G` (top / bottom of the page) and `v`
(`selection.toggle`) to `[modal.visual]`, with their actions in the "Copy mode" group. Plan §2
lists no other yank key: `yy` (yank the URL) was not bound, so in normal mode `y` reached the
page as any unbound key. (m1-actor-insert-scroll's normal-mode extras later bound `yy`, making
`y` a normal-mode prefix.)

## Scope

- `actors/caret.mjs`: one frame's copy mode (`Caret`) and `isCaretMessage`, the strict check.
- `actors/VimmaChild.sys.mjs`: `Vimma:Caret` (`{ op, count? }`), refused unless the frame's
  document has focus.
- `actors/VimmaActors.sys.mjs`: `caret(browser, op, count)`, sent to the focused frame only
  (`framesFor(browser)[0]`); a reply of the wrong type is a failure.
- `host/copy-mode.mjs`: the runners (`mode.visual`, `caret.*`, `selection.toggle`,
  `selection.yank`), spread into `CONTENT_RUNNERS`; the clipboard write
  (`nsIClipboardHelper.copyString`, plain text) is in the parent.
- `host/VimmaHost.sys.mjs` (small, additive): page mode `visual`; `mode.normal` asks the frame
  to leave first; plain keys that pass in `visual` are consumed; a focus report keeps `visual`
  unless a text field takes focus (insert).

## Tests (written first)

`tests/browser/browser_vimma_copy_mode.js`, fixtures `file_vimma_copy.html` (known lines at the
top, a cross-origin frame, a last line 3000 px down) and `file_vimma_copy_frame.html`:

- `v` places an enabled caret (`nsISelectionController.getCaretEnabled`) at offset 0 of the
  first line; the status mode is `visual`.
- `l h w $ 0 j k` move the selection's focus (offsets and nodes asserted); `G` reaches the last
  line and scrolls the page; `gg` comes back.
- `v w l` selects exactly `"alpha "`; `y` puts it on the clipboard
  (`SimpleTest.promiseClipboardChange`), returns to normal and says "yanked 6 chars".
- `v` again collapses the selection, motions move a bare caret; `ctrl+b [` enters too; `Esc`
  clears the selection and disables the caret; `y` with nothing selected leaves the clipboard
  and says "nothing to yank".
- Plain keys in copy mode (`l x z q`) never reach the page; after `Esc` they do.
- In a focused cross-origin iframe the caret, selection and yank work in that frame and leave
  the top frame's selection alone.
- Malformed `Vimma:Caret` messages (`null`, a string, `constructor`, `__proto__`, count `0`,
  `1.5`, `"2"`) and an `enter` to an unfocused frame are refused.

Core: `dispatcher.test.mjs` "copy mode keys" (`v 0 $ gg G y` in visual, a count on `w`).
Mutation check: dropping the consume of passing keys in `visual` fails "the page gets no keys"
(`["x","z","q","z"]` vs `["z"]`); reverted.

## Vim motions, selection keys and mouse selection (2026-10-10)

Added to `[modal.visual]` (actions in "Copy mode"; none clashes: normal mode's `f`/`F`/`t` are
hints and tab keys in another table, and `{ } ^ ; , o V Y e E W B` were unbound in `visual`):
`e`, `ge`, `W`, `B`, `E`, `^`, `{`, `}`, `f`/`F`/`t`/`T` + a character, `;`, `,`, `V`, `o`, `iw`,
`aw`, `Y`. Counts apply to every motion (the dispatcher already counted in `visual`). A
selection the user makes with the mouse in normal mode enters copy mode with it.

Tests: core `motions.test.mjs` (targets per motion, counts, line limits of `f`/`t`, `;`/`,`,
`iw`/`aw`) and `dispatcher.test.mjs` "copy mode: Vim motions…" (the keys, `f` waiting for its
character, a count kept across it, Esc/named keys/chords cancelling it, `f f`).
`browser_vimma_copy_motions.js` asserts the selected string for each motion, `V`, `o` (both
kinds), `iw`/`aw` and `Y`, and that malformed find messages are refused.
`browser_vimma_copy_mouse.js`: drag, double and triple click enter `VISUAL`; `y`, `ctrl+c`, the
context menu's Copy and the primary selection copy it; `e` extends it, `Esc` clears it; a plain
click, a link, a script's selection (also from a click handler) and a drag in a text field do
not enter; the same in the second of two split panes. Mutation check: dropping the
`sel.isCollapsed` guard of the selection listener fails "a plain click: normal" (`visual`), the
link click and the click-handler case; reverted.

## Settled (2026-10-09, from the engine tree)

- **Caret API.** Firefox's caret browsing (F7) sets `accessibility.browsewithcaret`, and
  `nsFocusManager::UpdateCaret` then enables the PresShell caret on focus changes. Copy mode
  leaves the pref alone and calls the same `nsISelectionController` (the frame's docShell, as
  `ViewSourcePageChild` gets it): `setCaretEnabled`, `setCaretVisibilityDuringSelection`,
  `characterMove`, `wordMove`, `lineMove`, `intraLineMove`, `completeMove`, with `extend` while
  selecting. A focus change turns the caret off (`UpdateCaret` with the pref off), so each motion
  enables it again.
- **Scrolling.** The moves scroll their nearest scrollable; after each, the focus region is
  scrolled into view (`scrollSelectionIntoView`, `SELECTION_FOCUS_REGION`, synchronous).
- **`w` / `b`** are Firefox's word motions (`layout.word_select.*`): on Linux `w` stops at the
  end of a word, not at the start of the next one as Vim's does.
- **Leaving** (`Esc`, `y`) collapses the selection to the caret, so a later `v` or `/` starts
  there, and disables the caret.
- **Keys.** Plain keys are consumed in copy mode; chords with `ctrl`, `alt` or `meta` stay
  Firefox's (`ctrl+c` copies the selection, `ctrl+t` opens a tab).
- **A page that navigated** has a new actor with copy mode off: the next motion is refused and
  the tab goes back to normal (that key does nothing).
- **Counts** repeat a motion, at most 1000 steps.

## Settled (2026-10-10: Vim motions, mouse selection)

- **Two kinds of motion.** Layout motions stay `nsISelectionController`'s: `{` / `}` are
  `paragraphMove` (from a paragraph's edge it does not move, so a `characterMove` steps over the
  edge first), `^` is `intraLineMove` then the text rule. Vim's text motions (`e ge W B E ^ f t F T
iw aw`) are pure functions in core `motions.mjs` over a flat string; `actors/text-model.mjs`
  builds it from the rendered text nodes around the caret (TreeWalker, `checkVisibility`, no
  `script`/`style`/`select`/`textarea`), with U+2029 between blocks (`display` other than
  `inline`, `contents`, `ruby*`) and `\n` for `<br>`, keeping each node's length so an index maps
  back to (node, offset). Collapsible white space has its line breaks and tabs read as spaces.
  The target is set with `Selection.extend` / `collapse`.
- **Caret, not cursor.** Vim's cursor is on a character and its selection includes it; the caret
  is between two. Motions that Vim ends on a character (`e`, `ge`, `E`, `f`, `T`) end after it,
  the others before it, so `v e y` yanks the word and `v f , y` the comma as Vim's would. `t` and
  `T` skip a match right next to the caret, so `;` after them moves on.
- **`f` waits in the dispatcher.** An action with `takesChar` (ActionDef) is not emitted at its
  key: the dispatcher returns `pending` (no timeout: `ambiguous()` is false) and the next key is
  its character, whatever it is bound to (`f f`); Esc, a named key or a chord cancels. The action
  carries `char`; the host keeps the last find for `;` and `,` (core `repeatFind`) and sends
  `{ op: "find_forward", char }`; `isCaretMessage` wants one code point there and no `char`
  elsewhere.
- **`V`** keeps the anchor's and the focus's visual lines (`intraLineMove` both ways from each
  point); after any motion the focus's line is measured again and the selection set from the
  anchor line's start to its end (down) or from its end to its start (up), with
  `setBaseAndExtent`. `o` swaps the two lines; `v` in `V` keeps the text, character-wise.
  `Y` sets the selection to the whole lines of its two ends and copies `Selection.toString()`
  (the plain-text serializer: `\n` between blocks and at `<br>`, white space as rendered).
- **`y` keeps leaving copy mode**, as this spec's user story says; so does `Y`.
- **Mouse selection.** The child adds an `nsISelectionListener` (Selection's chrome-only
  `addSelectionListener`) to its document's selection. Firefox ends every mouse selection
  (drag, double or triple click, shift+click) with a `MOUSEUP_REASON` notification when its drag
  state ends (`nsFrameSelection::SetDragState`); a script's change carries `JS_REASON`, a key's
  `KEYPRESS_REASON`. On `MOUSEUP_REASON` without `JS_REASON`, with a non-collapsed selection, no
  `dragstart` since the last mousedown and nothing editable focused, it sends
  `Vimma:MouseSelection`; the parent takes it from the focused frame only, as focus reports, and
  the host runs `mode.visual` unless the tab is in insert mode. `enter` keeps a selection on
  screen, so copy mode starts with it. A text field's selection is its own, never the document's.
  A plain click also ends with `MOUSEUP_REASON` (collapsed): the guard on `isCollapsed` is what
  keeps it in normal mode (the mutation check).
- **Primary selection.** `AutoCopyListener` copies the selection to the X primary selection on
  `MOUSEUP_REASON`, `KEYPRESS_REASON` or `SELECTALL_REASON` but never on `JS_REASON`, so the text
  motions (Selection API) do not update it; mouse and layout motions do. Left as a limit.

## Limits

- Copy mode works in the frame that has focus. A cross-origin frame needs focus first (a click,
  or a hint on something in it); the caret does not move from one frame into another.
- `w` is Firefox's word motion, not Vim's (above); `e`, `W`, `B`, `E` are Vim's.
- The text motions see a window of text around the caret (2000 characters each way plus 64 per
  count step) and no shadow roots or frames; `f`/`t` search between line breaks, not the
  wrapped line. `V` takes visual lines, ambiguous at a soft wrap. `iw`/`aw` always select the
  word at the caret (no growing, no count); `Y` adds no trailing line break. The primary
  selection does not follow the text motions (above).
- The text inside `<input>` and `<textarea>` is not part of the page's selection (a text control
  is its own editor): to copy from a field, focus it (insert mode) and use `ctrl+c`.
- `y` copies plain text only; no HTML flavour.
- Clicking into a text field during copy mode enters insert, as in normal mode.

## Out of scope

Yank shortcuts not in plan §2 (`yy` URL, since added by m1-actor-insert-scroll; `yf` link),
registers, search inside copy mode (`/` there is unbound), copy mode in pages without our actor,
Vim's other text objects (`is`, `ip`, `i(`…).
