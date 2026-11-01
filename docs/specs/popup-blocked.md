# Spec: popup-blocked

Status: implemented · Area: core (`packages/vimma-core/src/popups.mjs`, `picker.mjs`,
`statusbar.mjs`, `actions.mjs`, `defaults.mjs`, `cmdline.mjs`), host (`host/popup-ops.mjs`,
`VimmaHost`), UI (`ui/picker.mjs`, `ui/statusbar.mjs`) · Upstream patches: none · ADR: none

Issue: [#683](https://github.com/vimma-browser/vimma/issues/683)

## Summary

When a page opens a pop-up without a click, Firefox blocks it and shows a "pop-up blocked" bar
over the page. Its options (allow the site, open one pop-up, stop showing the bar, settings) need
the mouse today. Vimma adds a status bar cue while the bar is up and a picker, `ctrl+b shift+o`
or `:popups`, over the same options, run through Firefox's own code.

## Problem

Vimma's prompt keys (`y`, `n`, `Tab`, `host/prompt-keys.mjs`) answer the doorhanger prompts that
hang from the address bar (`#notification-popup`). The pop-up blocked bar is a different kind of
notification: a per-tab notification bar (`gBrowser.getNotificationBox()`, value
`popup-blocked`). None of Vimma's keys reach it, so allowing or opening a blocked pop-up (a sign-in
window, a payment provider's window) needs the mouse.

## Behaviour

1. While the selected tab's page has the pop-up blocked bar, the status bar shows
   `pop-up blocked · ctrl+b shift+o` on the right, in the theme's yellow. The key named is the
   first one bound to `popup_picker`; with none bound, the cue says `:popups`. Switching tabs,
   or panes in a split, shows the cue for the newly selected page; closing the bar removes it.
2. `ctrl+b shift+o` (`popup_picker`, id `popups.picker`) and `:popups` open a picker with these
   rows, in the order of Firefox's options menu:
   - `Allow pop-ups for <site>`: grants the site the `popup` permission and opens what it tried
     to open;
   - `Go to <address>`: follows the blocked redirect, when there is one;
   - `Open <address>`: one row per blocked pop-up, which opens that one pop-up;
   - `Don't show this message when pop-ups are blocked`: sets
     `privacy.popups.showBrowserMessage` to false and closes the bar; left out when it is false;
   - `Pop-up settings`: opens `about:preferences` at the pop-up exceptions.
3. The picker is the goto picker's dialog and key machine: `j` / `k` move, `/` filters, `Enter`
   runs the row and closes the picker, `Esc` / `q` close it.
4. With nothing blocked on the selected page, the picker does not open and the notice says
   `no pop-ups blocked on this page`.
5. With `dom.disable_open_during_load` locked, the allow row is left out.
6. In a tab of the agent workspace, the picker does not open and the notice says
   `pop-ups stay blocked in the agent workspace`; nothing is granted. The cue there says
   `pop-up blocked` without a key.

## Research

Checked against Firefox 159.0 (`surfer.json`), in `engine/`:

- `browser/modules/PopupAndRedirectBlockerObserver.sys.mjs` shows the bar
  (`appendNotification("popup-blocked", …)`, line 130) only for the selected browser, when
  `privacy.popups.showBrowserMessage` is true and the user has not dismissed it for that page
  (`hasBeenDismissed()`). Its options menu (`#blockedPopupOptions`,
  `browser/base/content/main-popupset.inc.xhtml:668`) is filled in `onPopupShowing` (line 151):
  the allow item, hidden when `dom.disable_open_during_load` is locked and named with the
  principal's `displayHost` (or the address for pages without a host); one item per blocked
  redirect and per blocked pop-up. Its commands are `toggleAllowPopupsForSite`,
  `editPopupSettings` and `dontShowMessage`, which read only `event.originalTarget.documentGlobal`
  from their event, and `showBlockedPopup` / `navigateToBlockedRedirect`, which call the
  blocker's `unblockPopup` / `unblockRedirect`.
- `toolkit/actors/PopupAndRedirectBlockingParent.sys.mjs`, available as
  `browser.popupAndRedirectBlocker`: `getBlockedPopups()` (line 106) and `getBlockedRedirect()`
  (line 137) return the records the menu is built from (browsing context, inner window id,
  report index, address); `unblockPopup` (line 164) and `unblockRedirect` (line 174) open one.
- `toolkit/content/widgets/notificationbox.js`: a shown notification fires `AlertActive` (line
  286, bubbles); a removed one fires no event, and leaves `allNotifications` at once and the DOM
  after its closing transition. `Tabbrowser.readNotificationBox(browser)` (line 1406) reads a
  browser's box without creating one.
- In a native split view each pane's browser keeps its own notification box, moved into the
  pane's container (`#insertNotificationBox`); the focused pane is the selected browser.

## Design

`packages/vimma-core/src/popups.mjs` turns what the host reads (`BlockedPopups`: site, pop-up
addresses, redirect, locked, bar on) into picker rows (`PopupItem`, kind `"popup"`), parses a row
id back into its action (`parsePopupId`), and writes the cue (`popupCue`). `host/popup-ops.mjs`
reads the selected browser's blocker, keeps Firefox's records for the rows it listed, and runs a
row through the observer or the blocker. `ui/picker.mjs` adds `PopupPicker`, the add-on picker's
asynchronous loading with a refusal notice; `ui/statusbar.mjs` passes the cue through and
redraws on the events below.

1. **Keys: `ctrl+b shift+o` and `:popups`.** The default key is `prefix+shift+o`, because the
   status bar cue then names a key the user can press at once, and it was free in `defaults.mjs`;
   `prefix+p` is `previous_tab`. Rejected: `:popups` only, because a cue naming a command is
   slower to act on and a bar that needs answering is common on sign-in pages.
2. **Firefox's own code runs every row.** The picker calls the observer's methods with a
   stand-in event `{ originalTarget: { documentGlobal: window } }` and the blocker's
   `unblockPopup` / `unblockRedirect` with the records it listed, so that allowing, opening and
   the locked-pref check behave exactly as the bar's menu, and follow Firefox when it changes
   them. Rejected: writing the permission with `Services.perms` directly, because it would
   duplicate Firefox's order of unblocking pop-ups before the redirect.
3. **Not `y` / `n`.** The bar gets no bare-key answer, because Firefox arms doorhanger buttons
   only after `security.notification_enable_delay` and gives the bar no such delay: a page can
   raise it at any moment, and a key meant for the page would answer it. A picker needs two
   deliberate steps.
4. **The cue follows the selected browser.** The cue reads the selected browser's notification
   box, so it follows tab switches and, in a split, the focused pane, since that pane's browser is
   the selected one. It redraws on `AlertActive`, `DOMUpdateBlockedPopups` and
   `DOMUpdateBlockedRedirect`, and on a `click` or `transitionend` whose target is a
   `notification-message`, because removing a notification fires no event of its own.
5. **Refused in the agent workspace.** The picker does not open in an agent-container tab
   (`WorkspaceStore.isAgentContainer`), because pages there get no permissions
   (`docs/security.md` M10) and the allow row would grant one. The host checks again when a row
   runs, so that a tab moved into the agent workspace while the picker was open grants nothing.
6. **Rows run on the page they were listed for.** The picker closes when the selected tab
   changes, and a row runs only while the browser it was read from is still selected, so that a
   row never acts on another page's blocker.
7. **Nothing blocked: a notice.** The picker opens only with rows, because an empty list over
   the page says less than the notice and needs a key to close.

## Security and privacy

The picker grants the `popup` permission only on the user's key, through the same code as the
bar's menu, in the user's own workspaces. It is chrome-only: no control command or MCP tool
reaches it, and it refuses in the agent workspace (M10). It reads no page content; the addresses
it lists are the ones Firefox's menu lists.

## Tests

- Vitest, `packages/vimma-core/test/popups.test.mjs`: the rows in Firefox's order; the redirect
  row; the allow row left out when locked; no `hide` row with the bar off; no rows when nothing is
  blocked; rows selected by id and filtered by text; `parsePopupId`; the cue with a key, without
  one and in the agent workspace; the status bar segment; the default key and `:popups`.
- Mochitest, `tests/browser/browser_vimma_popups.js` (fixture `file_vimma_popups.html`, which
  opens two pop-ups while it loads): nothing blocked gives the notice; the cue follows the
  selected tab and Firefox's close button; the picker lists the bar's options and opens one
  pop-up without granting anything; `:popups` opens it; allow grants the permission and opens
  both pop-ups; the hide row turns the bar off, and settings opens `about:preferences`; the agent
  workspace refuses and grants nothing.

## Docs and changelog

`docs/guide.md`: a "Blocked pop-ups" section, the cue under "Status bar", `ctrl+b shift+o` in the
key table and `:popups` in the command table. `docs/bindings.md`, `docs/bindings.json` and
`defaults.toml` are regenerated. The changelog line comes from the commit.

## Delivery

One pull request: core, host, UI, tests and docs.

## Open questions

None.
