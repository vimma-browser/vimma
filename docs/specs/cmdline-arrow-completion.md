# Spec: cmdline-arrow-completion

Status: implemented · Area: `packages/vimma-core/src/keys/cmdline.mjs` (`cmdlineArrow`),
`ui/cmdline.mjs` · Upstream patches: none · ADR: none

Issue: [#1222](https://github.com/vimma-browser/vimma/issues/1222)

Changes the `Up` / `Down` keys of [m1-cmdline](m1-cmdline.md), whose completion list and history
it builds on.

## Summary

Once something is typed on the `:` command line and the completion list shows, `Down` moves into
the list and selects its first match, as `Tab` does; then `Up` / `Down` move in it as
`shift+Tab` / `Tab`. Typing more refines the list. On an empty line `Up` / `Down` still walk the
command history.

## Problem

The list under the typed text looks like a menu, and every other list in Vimma (the pickers, the
address bar's suggestions) is walked with the arrow keys. On the command line the arrows only
walked history, so a user had to know that `Tab` was the way into the list.

## Behaviour

1. With text typed (anything but colons and spaces) and the list showing matches, `Down` puts
   the first match on the line and marks it in the list, as `Tab` does.
2. In the list, `Down` moves to the next match and wraps from the last to the first, as `Tab`;
   `Up` moves to the previous one.
3. `Up` on the first match leaves the list: the line goes back to the text as typed, no row is
   selected, and the list shows that text's matches again.
4. Typing (or deleting) while a match is selected ends the selection, and the list follows the
   new text; `Down` enters it again.
5. `Up` with typed text, before the list is entered, recalls the newest earlier line starting with
   that text, as before (Vim's prefix search).
6. On an empty line, and on typed text with no matches, `Up` / `Down` walk history as before.
7. After `Up` has recalled a line from history, `Down` walks history back towards the draft, even
   though the recalled line shows its own matches. Any edit ends the history walk, and `Down` then
   enters the list.
8. `Tab` and `shift+Tab` are unchanged: both wrap at either end, and `Up` / `Down` continue from
   wherever `Tab` left the selection.

## Research

- `ui/cmdline.mjs` (before this change): the input's own `keydown` sent `ArrowUp` / `ArrowDown`
  to core's `historyPrevious` / `historyNext` and `Tab` / `shift+Tab` to `complete(±1)`, which
  wraps; the list is shown by `refreshList` whenever the line has a word.
- The pickers (`packages/vimma-core/src/ui/picker.mjs`, `pickerKey`) move with `down` / `up` and
  stop at the ends.
- Vim's wildmenu returns to the typed text after the last match, and Firefox's address bar
  returns to it past either end of its suggestions.

## Design

`cmdlineArrow(state, direction)` in core decides what one arrow does from plain data: the line,
how many matches the list shows, the selected row (while a `Tab` or arrow cycle runs) and whether
a history line is being shown. It returns `history`, `select` (an index) or `leave`. The UI runs
`complete(direction)` for `select`, which `Tab` already used, so the list, `aria-selected` and
`aria-activedescendant` stay in one place; for `leave` it puts back the text saved when the cycle
began.

1. **`Down` enters the list only with typed text.** On an empty line the list is hidden and
   `Up` / `Down` keep their history meaning, because that is what Vim users expect there and the
   issue asks for nothing else. Rejected: arrows always in the list, which would remove history
   recall by arrow altogether.
2. **`Up` before the list keeps the prefix search.** `scr` `Up` recalling `scroll_top` is
   documented behaviour (guide, m1-cmdline) and does not conflict: entering the list needs
   `Down` only. Rejected: `Up` into the list's last match, as the address bar does, because it
   would take prefix search away.
3. **`Up` on the first match leaves the list.** It gives the arrows a way out back to the typed
   text, which wrapping to the last match would not, and a further `Up` is then the prefix
   search of point 2. Rejected: wrapping, as `shift+Tab` does, because there would be no way
   back to the typed text but deleting.
4. **`Down` on the last match wraps to the first, as `Tab`.** The issue asks for the arrows to
   act as `Tab`. Rejected: stopping, as the pickers do, because the pickers have no `Tab` cycle
   to match, and a stop at the end is a dead key here.
5. **A recalled history line keeps `Down` in history.** Without this, `Up` `Down` on an empty
   line would recall a line and then jump into its matches instead of going back.

## Security and privacy

No new surface: the keys only change which text, from core's candidates or the history the line
already had, is put on the line. Nothing reaches the page (the mochitest checks it).

## Tests

- vitest, `packages/vimma-core/test/cmdline.test.ts`, "Up / Down: the completion list or
  history": each point above as a case of `cmdlineArrow`.
- mochitest, `tests/browser/browser_vimma_cmdline_arrows.js`:
  `down_enters_the_list_and_arrows_move_in_it` (1, 2, 3, wrap, no key reaches the page),
  `typing_after_down_refines_the_list` (4),
  `history_keeps_up_and_down_on_an_empty_line_and_while_recalled` (5, 6, 7).
- The existing `browser_vimma_cmdline.js` tasks `tab_completes_and_cycles` and
  `up_recalls_the_previous_command` cover 8 and 5 unchanged.

## Docs and changelog

`docs/guide.md`, "The command line": the Completion and History items. CHANGELOG, Unreleased:
"`Down` on the command line moves into the completion list once something is typed; `Up` and
`Down` then move in it."

## Delivery

One pull request (#1222).

## Open questions

None.
