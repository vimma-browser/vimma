# Spec: new-tab-in-split

Status: implemented · Area: core (`packages/vimma-core/src/panes.mjs`, `config.mjs`,
`defaults.mjs`), host (`split/PaneView.mjs`, `config/ConfigHost.sys.mjs`) · Upstream patches:
none · ADR: none

Issue: [#1059](https://github.com/vimma-browser/vimma/issues/1059)

## Summary

A new tab opened while a split shows now shows alone, right after the split's tabs, and the split
waits hidden with its panes, sizes and focused pane. Before, the new tab took the focused pane's
place and the page that pane showed left the split. `[panes] new_tab = "pane"` in `config.toml`
keeps the old behaviour.

## Problem

A split is usually set up so its pages give each other context: an editor beside its docs, two
pages to compare. Pressing `ctrl+t` in such a split replaced the focused pane's page with the new
tab, and the page it showed moved out of the split into a tab of its own. Getting the split back
meant marking the tabs again in the side panel. A new tab is a new piece of work, and the split
it was opened from should stay as it was.

Example: tabs `wiki`, `google | youtube` (a split, `youtube` focused), `github`. `ctrl+t` gave
`wiki`, `google | new tab`, `youtube`, `github`. Now it gives `wiki`, `google | youtube` (hidden),
`new tab` (shown), `github`.

## Behaviour

1. As a Vimma user in a split, a new foreground tab (`ctrl+t`, `ctrl+b c`, `t`, `:tabnew`, `P`, a
   link opened in a new foreground tab, also with `f` and `gF`, a link from another app, and
   `vimma-ctl open`) shows alone, and the split waits hidden, unchanged: the same panes, sizes,
   zoom and focused pane. `]s`, `ctrl+b S` or selecting any of its tabs brings it back whole.
2. As a Vimma user, the new tab sits right after the split's tabs in the tab strip and the side
   panel. A tab opened from a link on one of the split's pages goes where Firefox puts a tab opened
   from a link: after the split, following the tabs already opened from that page. A tab that
   comes with its own place keeps it: a closed tab reopened with `ctrl+shift+t` goes back to its
   old index.
3. As a Vimma user who sets `[panes] new_tab = "pane"`, a new foreground tab opens in the focused
   pane instead, as before: the split stays, and the tab that pane showed stays open in the
   workspace.
4. A pinned new tab, a new tab of another workspace, and a new tab while the split is already
   hidden behave as before under both values: the split stays as it is (hidden, or parked with
   its workspace).
5. `[panes] new_tab` accepts `"alone"` (the default) and `"pane"`; any other value is an error at
   its line with the nearest name, and a value that is not a string says what it got. It applies
   live, like the other `[panes]` keys.

## Research

- Firefox 160.0, `browser/components/tabbrowser/Tabbrowser.sys.mjs` `#insertTabAtIndex`: a tab
  opened with an opener (a link) and `browser.tabs.insertRelatedAfterCurrent` (default `true`)
  goes after the opener, chained after the tabs already opened from it; when the opener is in a
  split view, after the split's wrapper (`previousTab.splitview`). A tab with no opener
  (`ctrl+t`, `BrowserCommands.openTab`; `openTrustedLinkIn` for `P`; `gBrowser.addTab` for
  `vimma-ctl open`) goes to the end of the tab strip, since `browser.tabs.insertAfterCurrent`
  defaults to `false`.
- The same file, `#moveTabNextTo`: moving a tab after a tab of a split view moves it after the
  split's wrapper (`targetElement.splitview`), so `moveTabAfter(tab, lastSplitTab)` never puts the
  tab inside the split.
- `split/PaneView.mjs` tells a new foreground tab from a pick by its `TabOpen` coming just before
  its `TabSelect`, in the same task (side-panel-unsplit decision 22); every route in behaviour 1
  ends in that pair, so one rule covers them all.

## Design

Core's `pickTab` (what selecting a tab does to the shown view) takes the option: with a new tab
(`opened`) that may join while the view shows, `newTab: "pane"` returns `"replace"` (the focused
pane's tab replaced, as before) and `"alone"` returns `"beside"`, the view hidden as it was.
`PaneView` keeps `newTab`, set from the config by `ConfigHost`'s `applyToWindow` as `max` and
`maxSplits` are, and on `"beside"` moves a tab without an opener right after the split's last tab
before it reconciles.

1. **Alone is the default.** A new tab shows alone and the split waits hidden, because a split
   is arranged on purpose and a new tab is separate work; this is also what Firefox's own split
   view does when another tab is selected (`tabsplitview.mjs` `#suspend`). Rejected: keeping
   `"pane"` as the default, because it breaks up the split on every `ctrl+t`, and restoring the
   split takes several keys.
2. **Every new foreground tab follows the option, links and links from other apps included.**
   One rule is easier to predict than a list of exceptions, and the routes cannot be told apart
   where the decision is made (side-panel-unsplit decision 22 relies on the same event pair for
   all of them). A link opened in a new tab from a page in a pane would, under `"pane"`, replace
   the page that holds the link; shown alone, the page and its split stay a key away. Rejected:
   links into the focused pane and keys alone, because the same `ctrl+click` would then do
   something different from `ctrl+t` followed by pasting the address.
3. **The new tab goes right after the split's tabs**, so it sits next to the work it came from, in
   the tab strip, in the side panel and for `gt` / `gT` and `alt+1..9`, and `gT` from it shows the
   split again. A tab opened from a link keeps Firefox's placement (after the split already, and
   after earlier tabs from the same page), so that several links opened from one page keep their
   order. Only a tab Firefox put at the end of the strip is moved, since that is Firefox's place
   for a tab with no index and no opener; a tab given its own index keeps it (SessionStore's
   `undoCloseTab` passes the closed tab's old index, and `browser.tabs.insertAfterCurrent`
   places new tabs after the current one), so the move never undoes a place that was set on
   purpose. Rejected: the end of the tab strip (Firefox's place for `ctrl+t`), because with several
   splits and many tabs the new tab ends up far from the split it belongs with.
4. **The option is `[panes] new_tab`, with `"alone"` and `"pane"`.** It sits with the other split
   settings in `[panes]`, its values name what the new tab does, and it is validated like
   `[panes] layout`: a string from a fixed list, the nearest name suggested. Rejected: a boolean
   (`new_tab_in_pane = true`), because a value list can grow (for example a new split) without a
   second key.
5. **A pinned tab and a hidden split are unchanged.** A pinned tab cannot join a split, so it
   already showed alone; while the split is hidden a new tab already showed alone. Neither needs
   the option.

## Security and privacy

No new surface: the option changes only which tab of the shown workspace is on screen and where
a new tab sits in the tab strip. A tab of another workspace is still never put beside or into the
split (`PaneView.accepts`), and moving a tab in the tab strip does not change its container, so
workspace routing (docs/security/02-workspace-routing.md) and links from other apps
(docs/security/07-omarchy-hook-and-vimma-open.md) are unaffected.

## Tests

- vitest, `packages/vimma-core/test/panes.test.ts`, "hidden views and pickTab": a new
  foreground tab shows alone and the view waits hidden by default; with `new_tab = "pane"` it
  replaces the focused pane's tab; a picked tab is not a new tab under either value; a pinned new
  tab hides the view; nothing changes outside a hidden view.
- vitest, `packages/vimma-core/test/config-v2.test.ts`, `[panes] new_tab`: the default, both
  values, a wrong value and a wrong type, a near miss of the key; the defaults file lists it.
- mochitest, `browser_vimma_config.js` `panes_new_tab_reaches_the_pane_view`: the key applies
  live and its default comes back without the file.
- mochitest, `browser_vimma_pane_workspaces.js`
  `a_tab_picked_from_outside_the_split_shows_alone_and_the_split_waits`: a new foreground tab
  shows alone right after the split, the split hidden with its panes and focus, and a split tab
  brings it back; with `"pane"` the new tab takes the focused pane.
- mochitest, `browser_vimma_side_panel_unsplit.js`:
  `a_switching_follow_in_a_split_shows_alone_beside_it` and
  `a_switching_follow_with_new_tab_pane_takes_the_focused_pane`;
  `a_reopened_tab_keeps_its_place_during_a_split`.
- e2e: `m4-split-panes`, `issue-362-pane-focus-highlight` and `m3-restart-restore` fill a new
  pane with `vimma-ctl open`, so they run with `tests/e2e/fixtures/new-tab-pane.toml`
  (`new_tab = "pane"`).

## Docs and changelog

`docs/guide.md`: "Picking a tab during a split" (the new-tab paragraph), "Several splits"
(starting another split from a new tab) and "config.toml" (the key). The changelog line comes
from the commit subject.

## Delivery

One pull request.

## Open questions

None.
