# Spec: close-active-tab

Status: implemented · Area: `packages/vimma-core/src/keys/actions.mjs`,
`packages/vimma-core/src/ui/sidepanel.mjs`; `host/runners.mjs`, `ui/side-panel.mjs` · Upstream
patches: none · ADR: none

Issue: [#1223](https://github.com/vimma-browser/vimma/issues/1223)

## Summary

A key that closes the tab the window shows works from every mode a user can be typing or
browsing in. In a text field, a `[modal.insert]` binding of `tab.close` closes the tab instead of
editing the field. In the side panel, the new action `panel.close_active_tab` closes the tab the
window shows, not the highlighted row's, and the panel stays open. Neither has a default key:
`ctrl+w` stays Vim's delete-word key in text fields and the pane prefix in normal mode.

## Problem

Firefox's `ctrl+w` closes the tab from anywhere. In Vimma it is off by default
([firefox-keys](firefox-keys.md)): `ctrl+w h/j/k/l` are the pane keys in normal mode, and in text
fields `ctrl+w` deletes the word before the caret ([key-handling-batch](key-handling-batch.md)
§ 2). A user who wants one key that closes the current tab everywhere has two partial routes:

- `[firefox] enable = ["ctrl+w"]` gives the key back to Firefox. It works in a text field, but
  not in the side panel, which takes every key.
- `[modal.panel] "<C-w>" = "panel.close_tab"` works in the side panel, but closes the
  highlighted row's tab, which is not the tab the window shows once `j` or `k` moved the
  highlight; and with Firefox's key off, nothing closes the tab from a text field.

## Behaviour

1. As a Vimma user with `[modal.insert] "<C-w>" = "tab.close"`, `ctrl+w` in a page's text field,
   the address bar or another chrome field closes the selected tab, as Firefox's `ctrl+w` does;
   the field is not edited.
2. Without that binding, `ctrl+w` in a text field deletes the word before the caret, as before.
3. As a Vimma user with `[modal.panel] "<C-w>" = "panel.close_active_tab"`, `ctrl+w` in the side
   panel closes the tab the window shows (in a split, the focused pane's tab). The panel stays open and keeps focus. The highlight
   stays on its row; when it was on the closed tab's row, it moves to the next row (the one
   before, at the end), as `x` moves it. When the shown tab is pinned, it closes nothing and says
   `pinned tab: unpin it to close it`.
4. A key a page dispatches itself never runs either binding.

## Research

All references are to `main` at c15c0b70 and Firefox 160.0.

- Any action can be bound in any `[modal.<mode>]` table: `compileKeymap` resolves each value
  with `resolveActionName` and checks only the mode name (`packages/vimma-core/src/keys/keymap.mjs`,
  the `[modal.<mode>]` layer). There is no list of actions allowed per mode. A `[modal.insert]`
  binding wins over the text-field keys, which act only on a chord the dispatcher passes
  (key-handling-batch § 2).
- Firefox's `ctrl+w` row in the inventory has `first: "V"` (`firefox-keys.mjs`, `key_close`):
  Firefox reserves the key, so no page sees it before the browser, and Vimma's `_pageFirst`
  returns false for it. A binding on it runs on keydown, in a text field too.
- `tab.close` runs `closeTab(win)` (`host/tab-ops.mjs`), which removes `gBrowser.selectedTab`
  and refuses a pinned tab by selecting the first unpinned one.
- Pinned tabs are in no workspace: `WindowWorkspaces` returns early from its `TabSelect` handler
  for a pinned tab, so selecting one leaves the workspace's active tab on the last unpinned tab
  selected. A window with workspaces unpins a pinned tab (m3-workspaces decision 11) unless
  `unpinsPinnedTabs` is off.
- Panel mode is modal (`VimmaHost._dispatch`): an unbound key in help, hint, resize, panel or
  index mode is consumed, so it reaches neither Firefox nor the page behind the panel. An
  enabled Firefox key is unbound in Vimma's keymap (firefox-keys decision 9), so the side panel
  consumes it.
- The host's key listener is a capture-phase `keydown` listener on the browser window
  (`VimmaHost.sys.mjs`, `addEventListener("keydown", …, true)`). On a chrome window the default
  for `wantsUntrusted` is false (`dom/base/nsGlobalWindowInner.cpp`,
  `ComputeDefaultWantsUntrusted` returns `!IsChromeDoc`), so a `KeyboardEvent` made by a page's
  script never reaches it; a remote page's events do not leave its content process at all.

## Decisions

1. **A new action, `panel_close_active_tab` (`panel.close_active_tab`), with no default key.**
   `panel.close_tab` keeps closing the highlighted row's tab, because `x x x` in the panel relies
   on that. The new action has no default key, because the panel's plain keys are its navigation
   and `ctrl+w` is the pane prefix in normal mode and a text-field key in insert mode; changing
   a default key is a decision of its own.
2. **It closes the shown tab's row and keeps the highlight where the user put it**, because the
   point of the action is that the highlight does not choose the tab. The shown tab is the one
   the window shows (in a split, the focused pane's tab). The host names it by its row
   (`shown` in the panel action), not by the workspace's active tab, because a pinned tab is in
   no workspace (`WindowWorkspaces` ignores its selection), so the model's active tab is then the
   last unpinned tab shown, which must not close. A shown tab with no row is a pinned one: the
   action is refused with `x`'s notice and the panel is left as it is. When the highlight is on
   the shown tab's row it moves to the next row (the one before, at the end), as `x` does, so
   that the refresh after the close finds a row; elsewhere it stays on its own tab. A count is
   dropped ([side-panel-counts](side-panel-counts.md) decision 4).
3. **Without the side panel it is `tab.close`**, because there is no row to keep: in the bookmarks
   panel, which shares panel mode and lists no tabs, and from a global `[keys]` chord in another
   mode. So `[keys] panel_close_active_tab = "ctrl+alt+w"` is one key that closes the tab the
   window shows from every mode.
4. **`tab.close` in `[modal.insert]` needs no change and no allowlist**, because the keymap takes
   any action in any mode table (Research). This spec documents the binding and tests it, so
   that it stays supported. It runs on keydown, before the page, as Firefox's reserved `ctrl+w`
   does: a web terminal or editor that handles `ctrl+w` itself does not get it while the binding
   is there.
5. **Only the user's key closes a tab**, because a page that could close its own tab or another
   by dispatching a key would turn a typing field into a trap. Both bindings run through the
   dispatcher from the window's trusted `keydown` (Research), the same path as every other
   binding, so no new message or listener is added
   ([security](../security/13-page-modes.md) K12).
6. **Firefox's enabled `ctrl+w` stays off in the side panel**, because panel mode is modal by
   design ([m3-workspaces](m3-workspaces.md) sub-spec 6, key-handling-batch § 4): no key reaches
   Firefox or the page behind an open panel, as with the help overlay. Letting enabled chords
   through modal modes would change [firefox-keys](firefox-keys.md) decision 9 for every mode and
   chord, so it is not part of this change. The binding in decision 1 covers the panel instead;
   `[firefox] enable = ["ctrl+w"]` together with a `ctrl+w` binding stays a config error
   (firefox-keys decision 9), so a user picks bindings, not the Firefox key.

The configuration that closes the shown tab with `ctrl+w` in a text field and in the side panel,
leaving the normal-mode pane keys as they are:

```toml
[modal.insert]
"<C-w>" = "tab.close"

[modal.panel]
"<C-w>" = "panel.close_active_tab"
```

## Tests

- Vitest: `keymap.test.ts` ("closing the active tab from insert mode and the side panel": the
  defaults leave `ctrl+w` unbound in insert and panel mode; `[modal.insert]` and `[modal.panel]`
  bindings; a `[keys]` chord in every mode), `sidepanel.test.ts` (`panel.close_active_tab`: the
  active row closes, the shown tab the host names closes, a shown tab with no row is refused, the
  highlight stays or moves, pinned, empty workspace, a count).
- Mochitest: `browser_vimma_close_active_tab.js` (a `[modal.insert]` binding closes the tab from a
  page's field; the page's own `ctrl+w` closes nothing; without the binding `ctrl+w` deletes a
  word; in the side panel the action closes the shown tab and keeps the panel and its highlight;
  with a pinned tab shown it closes nothing; outside the panel it is `tab.close`).
