# Spec: split-from-lone-tab

Status: implemented · Area: core (`packages/vimma-core/src/splits.mjs`), host
(`split/PaneView.mjs`, `host/pane-ops.mjs`) · Upstream patches: none · ADR: none

Issue: [#1215](https://github.com/vimma-browser/vimma/issues/1215)

## Summary

On a tab shown alone while the workspace keeps hidden splits, the split keys start a new split
from that tab instead of being refused. The hidden splits stay as they were and `]s`, `[s` and
`ctrl+b S` still reach them. This changes [multiple-splits](multiple-splits.md) behaviour 4 and
decisions 3 and 4.

## Problem

A workspace holds several splits ([multiple-splits](multiple-splits.md)). Picking a tab outside
every split shows it alone and hides the split that was shown. On that lone tab, `ctrl+b v`,
`ctrl+b -` and `ctrl+b enter` were refused with
`split S1 is hidden: ]s or ctrl+b S to go back, or mark tabs in ctrl+b b for a new split`. The
only way to put the lone tab beside another page was to open the side panel, mark the tab and a
second one, and press `Enter`; a lone tab could not be split with a new empty pane in one step.

Example: tab 1 shows `google | github` (S1), tab 2 `wikipedia` alone. `ctrl+b v` on `wikipedia`
gave the refusal. Now it gives S2, `wikipedia | new tab`, with the new pane focused, and S1 waits
hidden.

## Behaviour

1. As a Vimma user on a tab shown alone while the workspace has at least one split, `ctrl+b v`,
   `ctrl+b -`, `ctrl+b enter`, `:vsplit` and `:split` make that tab and a new pane on the start
   page a new split. It takes the lowest free number and shows at once with the new pane
   focused, as a split made from the side panel's marks does (multiple-splits behaviour 5). The
   split shown before stays hidden, unchanged; `]s`, `[s`, `ctrl+b S` and any of its tabs bring
   it back.
2. As a Vimma user in the bookmarks panel on a lone tab, `s` and `S` (open in a new pane right or
   below) do the same, with the bookmark loaded in the new pane.
3. As a Vimma user with `[panes] max_splits` splits already, the key is refused with
   `new split: at most 9 splits in a workspace` (`at most 1 split in a workspace` for 1), no tab
   opens and nothing changes. From the split keys the notice stays until the next key; from the
   bookmarks panel it is the panel's usual short notice.
4. Splitting a tab while a split shows, or in a workspace without splits, is unchanged.
5. The private workspace and the agent workspace behave the same. The new split is saved and
   restored like any other (multiple-splits behaviour 10).

## Research

All references are to `main` at bb96d512.

- `PaneView.split` and `PaneView.newPane` returned the refusal while `PaneView.hidden` was true
  (`src/browser/base/content/vimma/split/PaneView.mjs`); core's `hiddenSplitRefusal` gave its
  text (`packages/vimma-core/src/panes/splits.mjs`). `host/pane-ops.mjs` kept that notice on
  screen until the next key (`untilKey`).
- `newSplit` in `splits.mjs` makes a split of marked tabs with the lowest free number; at
  `max` 1 it replaces the one split instead of refusing.
- The bookmarks panel's `s` / `S` call `splitPane` and show its refusal with the panel's own
  notice (`src/browser/base/content/vimma/host/bookmark-actions.mjs`, `openBookmark`).
- `PaneView.split` opens the new tab with `gBrowser.addTrustedTab` in the window of the selected
  tab; a private workspace is its own private window, so the new tab is private there.

## Design

### Decisions

1. **The lone tab is split into a new split**, because a user pressing `ctrl+b v` on a tab shown
   alone wants that tab beside a new page, and with several splits per workspace nothing is lost:
   the hidden split keeps its tree, sizes and focus, and `]s` or `ctrl+b S` bring it back.
   Rejected: a config option to keep the refusal, because the refusal guarded a single hidden
   split when a workspace could hold only one, and an option would keep two behaviours to test.
2. **One core function, `addSplit(splits, panes, { max })`**, adds a tree as a new split with the
   lowest free number, shown, so that numbering, colours, the side panel, the status bar and the
   snapshot work unchanged. The host builds the tree with the same `split` it uses for one pane.
   `splitLimitRefusal` checks the limit first, so that a refused key opens no tab.
3. **`max_splits = 1` refuses the key**, because a key is easier to press by mistake than a set
   of marks, so a key never ends the hidden split. The side panel's marks keep replacing the one
   split at 1 (multiple-splits decision 7), since marking is a deliberate edit.
4. **The limit's refusal from a split key stays until the next key**, because the 1.5 s notice
   is easily missed. It reuses multiple-splits behaviour 5's text, so both ways to a new split
   refuse alike. The bookmarks panel keeps its own short notice, because the panel is closed by
   then and its notices are all short.
5. **`hiddenSplitRefusal` is removed**, because nothing shows it any more.

## Security and privacy

- The new pane's tab opens in the lone tab's own window, so a private tab and a normal tab are
  never in one split; the mochitest checks that the new tab in the private workspace is private.
- The agent's `vimma_keys` refuses every `pane.*` action (`agent-keys.mjs`), so an agent cannot
  start a split this way. `vimma-ctl state` gains no field.

## Tests

- `packages/vimma-core/test/splits.test.ts`: `addSplit` takes the next free number, reuses the
  lowest, keeps the hidden splits, refuses at `max` and at `max` 1 with the limit's text, and
  rejects a one-pane tree or a tab of another split.
- `tests/browser/browser_vimma_split_lone_tab.js`: `ctrl+b v` starts S2 with the new pane
  focused and `]s` goes back to S1; `ctrl+b -`, `ctrl+b enter` and `:split` each start a split;
  at `max_splits` the refusal stays after 2 s, goes on the next key and no tab opens; the private
  workspace does the same with a private tab; a session restore keeps both splits and the one
  shown.

## Docs and changelog

- `docs/guide.md`: "Picking a tab during a split" and "Several splits".
- [multiple-splits](multiple-splits.md) and [side-panel-unsplit](side-panel-unsplit.md):
  `Since changed` notes pointing here.
- `docs/architecture/workspaces-and-panes.md`: the split view.

## Delivery

One pull request: core, host, tests and docs together.

## Open questions

None.
