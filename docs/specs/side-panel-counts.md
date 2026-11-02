# Spec: side-panel-counts

Status: implemented · Area: `packages/vimma-core/src/sidepanel.mjs`, `bookmarks.mjs`,
`modes.mjs`, `actions.mjs`, `defaults.mjs`, `config.mjs`; `ui/side-panel.mjs`,
`ui/bookmarks-panel.mjs`, `host/VimmaHost.sys.mjs`, `config/ConfigHost.sys.mjs`,
`side-panel.css` · Upstream patches: none · ADR: none

Issue: [#721](https://github.com/vimma-browser/vimma/issues/721)

## Summary

The side panel (`ctrl+b b`) and the bookmarks panel (`ctrl+b shift+b`) take Vim's counts and
jumps: `4j` and `3k` move several rows, `gg` and `G` go to the ends, `12G` and `12 Enter` reach
row 12, and `ctrl+d` / `ctrl+u` move half a screen. A `[panel] numbers` option shows each row's
distance from the highlight, as Vim's `relativenumber` does, so the count can be read off the
list. A long workspace no longer needs a row of `j` presses.

## Problem

In both panels `j` and `k` move one row at a time, and `1` to `9` reach only the first nine
rows. With twenty tabs in a workspace, row 15 is fourteen `j` presses away, or a trip out of the
panel to `15gt`. The panel is not a count mode, so `4j` moves one row and `4` alone jumps to row 4. A bookmark tree has the same trouble with deep or long folders, and has no number keys at
all.

## Behaviour

1. As a Vimma user in the side panel, `4j` moves the highlight down four rows and `3k` up three,
   stopping at the first and last row. The status bar shows the count while it waits.
2. `gg` goes to the first row and `G` to the last. `12G` goes to row 12, or the last row when
   there are fewer.
3. `4 Enter` goes to row 4's tab and closes the panel, as `4` did before. With no row 4 it says
   `no tab 4 in <workspace>` and stays open.
4. `ctrl+d` / `ctrl+u` move the highlight down / up by half the rows shown; `5 ctrl+d` moves
   five rows.
5. A count before a key that changes something (`x`, `space`, `V`, `m`, and in the bookmarks
   panel `d`, `y`, `l`, `t`, `s`, `a`, `r`) is dropped: the key acts once.
6. In the bookmarks panel `j`, `k`, `gg`, `G`, `ctrl+d` and `ctrl+u` work as above, and `3h`
   goes up three folder levels, closing each. `4G` and `4 Enter` ignore the count.
7. `[panel] numbers` in `config.toml` (schema 2) is `"absolute"` (the default), `"relative"` or
   `"hybrid"`. With `"relative"` the highlighted row shows `0` and every other row its distance
   from it; with `"hybrid"` the highlighted row shows its own number. It applies on save, the
   next time a panel draws.
8. The bookmarks panel shows no numbers with `"absolute"`, and the distance from the highlight
   with `"relative"` or `"hybrid"`.

## Research

All references are to `main` at 2692b02b.

- The dispatcher reads a digit as a count only in a mode of `COUNT_MODES`
  (`packages/vimma-core/src/modes.mjs:31`) and only when that digit is not bound in the mode
  (`packages/vimma-core/src/dispatcher.mjs:117-120`). Adding `panel` to the set and unbinding
  `1`–`9` from `[modal.panel]` is all the key side needs; a user who binds
  `"1" = "panel_select_1"` again gets the old key back, because a bound digit is never a count.
  `0` never starts a count, as in Vim.
- The host already passes the whole action, `count` included, to the panel
  (`panelAction` in `host/VimmaHost.sys.mjs`), so the panels see `action.count` without host
  changes beyond registering the new action ids.
- Vim: `{count}j`, `gg`, `G`, `{count}G` (line N, clamped to the last), `CTRL-D` (half a
  window, or `count` lines, which then become the new scroll amount), and `number` plus
  `relativenumber` for hybrid numbers. neo-tree and ranger take the same counts on `j` and `k`.
- Outside the panel, `ctrl+b 1`–`9`, `alt+1`–`8` (`cmd+` on macOS) and `{N}gt` reach tab N by
  its absolute position, which is the number each side panel row shows.

## Design

`panelMove(action, selected, length, { nthLast })` in `sidepanel.mjs` is the one place moves are
computed: it takes `panel.down`, `panel.up`, `panel.first`, `panel.last`, `panel.half_down` and
`panel.half_up` with the action's `count` and `page`, and returns the new row, clamped. Both
`panelKey` and `bookmarksKey` call it. The UI adds `page`, half the rows the list shows
(`rowsShown` in `ui/side-panel.mjs`), to each action. `rowNumber(numbers, i, selected)` gives the
label for a row. `PanelNumbers` in `ui/side-panel.mjs` holds the configured style; `ConfigHost`
sets it on each config load and both panels read it when they draw.

1. **A digit is a count.** In the panel `4` waits for `j`, `k`, `G` or `Enter`, because that is
   how every count works in Vim and in Vimma's normal mode, and `4 Enter` keeps the old jump one
   key longer. Rejected: keep `1`–`9` as instant jumps and take a count only after a pause,
   because the pause makes every jump slower and a count typed quickly would jump instead.
2. **`gg` and `G`.** They go to the first and last row, as in Vim and neo-tree. Rejected: `g` /
   `G` alone, because `gg` is what Vim's hands already know.
3. **`{N}G` and `{N} Enter` count from 1 in the tabs panel.** `{N}G` clamps to the last row as
   Vim does; `{N} Enter` refuses past the end with `no tab N in <workspace>`, because `Enter`
   leaves the panel and should not land on a tab you did not name.
4. **A count acts once on everything else.** `3x` closes one tab and `3d` asks about one
   bookmark, because a count that fans out over destructive keys turns one slip into several
   closed tabs. Rejected: Vim's `3x` closing three, because the panel has no undo for it.
5. **`{N}h` goes up N levels.** In the bookmarks panel `h` closes or goes to the parent, so a
   count repeats it, stopping at the top. `{N}l` stays single, because opening N levels deep has
   no single path.
6. **`[panel] numbers` with `"absolute"` as the default.** Absolute numbers match `ctrl+b N`,
   `alt+N` and `{N}gt` outside the panel. Relative and hybrid are options for people who prefer
   to read off counts. Rejected: hybrid as the default, because the numbers would no longer
   match the keys outside the panel.
7. **The bookmarks tree shows distances, not row numbers.** Its rows shift as folders open and
   close, so an absolute number would name a different bookmark a moment later. It shows no
   numbers by default, distances with `"relative"` or `"hybrid"` (`0` on the highlighted row),
   and `{N}G` and `{N} Enter` ignore the count.
8. **`ctrl+d` / `ctrl+u` move half the rows shown.** As on a page, and a count moves exactly N
   rows. Vim also keeps that N for later presses; the panel does not, because it forgets the
   count the moment it closes.
9. **No feature flag.** The issue suggested `vimma.feature.panel-counts` until the feature is
   complete; it lands whole in one pull request, so per CONTRIBUTING it needs no pref.

## Security and privacy

No new surface: the keys move a highlight in Vimma's own chrome lists, and the new option is a
choice of labels.

## Tests

- vitest (`packages/vimma-core/test/sidepanel.test.mjs`): digits are counts in the keymap
  (`4 j`, `3 k`, `1 2 shift+g`, `3 enter`); `gg`, `G`, `ctrl+d`, `ctrl+u` map to the new
  actions; "counts and jumps" over twelve tabs; `rowNumber` for each style.
- vitest (`bookmarks.test.mjs`): "bookmarksKey counts and jumps": counts on `j`/`k`, `gg`, `G`,
  `G` and `Enter` ignore a count, half moves, `2h`, a count before `d`/`y`/`l`/`t` acts once.
- vitest (`config-v2.test.mjs`): "[panel] numbers" accepts the three values and rejects others
  with a suggestion.
- mochitest (`browser_vimma_side_panel.js`): `a_count_and_enter_select_that_row_and_a_missing_one_says_so`,
  `counts_gg_and_G_move_the_highlight_past_row_nine`,
  `relative_and_hybrid_numbers_count_from_the_highlight`.
- mochitest (`browser_vimma_bookmarks.js`): `counts_gg_G_and_relative_numbers_in_the_tree`.

## Docs and changelog

`docs/guide.md`: "Side panel" (keys, counts, row numbers), "Bookmarks" (keys and numbers), the
`config.toml` list and "Features at a glance". `docs/bindings.md`, `docs/bindings.json` and
`defaults.toml` are regenerated. Changelog: "Side and bookmarks panels: counts (`4j`, `3k`),
`gg`, `G`, `12G` and `ctrl+d`/`ctrl+u`; `[panel] numbers` for relative row numbers. Digits in
the side panel are now counts: `4 Enter` goes to row 4."

## Delivery

One pull request: core, host wiring, both panels, docs and tests.

## Open questions

None. Stepping through bookmark filter matches with `n` / `N` is a separate follow-up.
