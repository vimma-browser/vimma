# Spec: popup-blocked

Status: implemented · Area: core (`packages/vimma-core/src/popups.mjs`, `prompt-keys.mjs`,
`picker.mjs`, `statusbar.mjs`, `actions.mjs`, `cmdline.mjs`), host (`host/popup-ops.mjs`,
`host/prompt-keys.mjs`, `VimmaHost`), UI (`ui/picker.mjs`, `ui/statusbar.mjs`) · Upstream patches: none · ADR: none

Issue: [#683](https://github.com/vimma-browser/vimma/issues/683)

## Summary

When a page opens a pop-up without a click, Firefox blocks it and shows a "pop-up blocked" bar
over the page. Its options need the mouse today. Vimma answers the bar as it answers Firefox's
permission prompts: `y` allows pop-ups for the site, `n` blocks them, `Esc` closes the bar, and
the status bar names the keys. `:popups` opens a picker over the bar's other options and over the
site's pop-up permission, so a mistaken `n` can be undone.

## Problem

Vimma's prompt keys (`y`, `n`, `Tab`, `host/prompt-keys.mjs`) answer the doorhanger prompts that
hang from the address bar (`#notification-popup`). The pop-up blocked bar is a different kind of
notification: a per-tab notification bar (`gBrowser.getNotificationBox()`, value
`popup-blocked`). None of Vimma's keys reach it, so allowing or opening a blocked pop-up (a sign-in
window, a payment provider's window) needs the mouse.

## Behaviour

1. While the selected tab's page has the pop-up blocked bar and no permission prompt is open,
   `y` allows pop-ups for the site (Firefox's "Allow pop-ups for <site>", which also opens what
   was blocked and closes the bar), `n` records a block in the site's `popup` permission and
   closes the bar, and `Esc` closes the bar without changing any permission.
   (Since changed: nor while the notice after an add-on install is open, which takes `y` too,
   because one key must never answer two questions; issue #868.)
2. The keys have the permission prompt's guards: `y`, `n` and `Esc` count only once the bar has
   been up for `security.notification_enable_delay` (500 ms by default) with no key pressed in
   between, and any key restarts the wait; a held key never answers. An `Esc` before then stays
   the page's. Focus never moves onto the bar, and `Tab` stays the page's.
3. While typing in a page field, the address bar, a Vimma picker, the command line or a search,
   and in hint, copy and element modes, the keys belong to that input or mode.
4. The status bar shows the bar's cue on the right, in the theme's yellow:
   `pop-up blocked · y allow · n block · Esc close` once the keys count, `pop-up blocked ·
Esc, then y allow · n block` from a field or mode that keeps the keys, and `pop-up blocked`
   while the keys wait. Switching tabs, or panes in a split, shows the cue for the newly selected
   page; closing the bar removes it. (Since changed: the bar names its keys too, in the
   permission prompt's keys line (`PromptKeys`, class `vimma-prompt-keys`) placed beside its
   Options button, with the cue's text without `pop-up blocked`: shown once the keys count and
   hidden, keeping its place, while they wait; hidden from accessibility, since the bar's button
   and message stay its labels; left out in the agent workspace. Because a reminder only in the
   status bar is easy to miss, and the permission prompts already name their keys where the user
   is looking; [#718](https://github.com/vimma-browser/vimma/issues/718).)
5. Without the bar, on a site whose pop-ups were blocked with `n` (or the picker's block row), the
   status bar says `pop-ups blocked · :popups to allow`.
6. `:popups` (`popup_picker`, id `popups.picker`, no default key) opens a picker with these rows:
   - `Allow pop-ups for <site>`: allows the site and opens what it tried to open; left out for
     an allowed site;
   - `Reset pop-ups for <site> to default`: removes the site's `popup` permission; only for a
     blocked site;
   - `Block pop-ups for <site>`: records a block; only for an allowed site;
   - `Go to <address>`: follows the blocked redirect, when there is one;
   - `Open <address>`: one row per blocked pop-up, which opens that one pop-up;
   - `Don't show this message when pop-ups are blocked`: sets
     `privacy.popups.showBrowserMessage` to false and closes the bar; only with something blocked
     and the pref true;
   - `Pop-up settings`: opens `about:preferences` at the pop-up exceptions.
7. The picker is the goto picker's dialog and key machine: `j` / `k` move, `/` filters, `Enter`
   runs the row and closes the picker, `Esc` / `q` close it.
8. With nothing blocked on the selected page and no `popup` permission for its site, the picker
   does not open and the notice says `no pop-ups blocked on this page`.
9. With `dom.disable_open_during_load` locked, the allow, block and reset rows are left out,
   `y` and `n` stay the page's, `Esc` still closes the bar, and the cue names only `Esc close`,
   because Firefox's own options menu hides "Allow pop-ups for <site>" then and a policy-locked
   setting is not the user's to override per site.
10. In a tab of the agent workspace no key answers the bar, the picker does not open and the
    notice says `pop-ups stay blocked in the agent workspace`; nothing is granted or reset. The
    cue there says `pop-up blocked` without keys, and nothing after a block.

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
- `browser/modules/SitePermissions.sys.mjs`: the `popup` permission's default is `BLOCK`
  (`getDefault`, line 1005), and `setForPrincipal` removes a site's permission when asked for its
  default state (line 569), so it cannot record a block for pop-ups. Page Info's "Block" for
  pop-ups (`browser/base/content/pageinfo/permissions.js`, `onRadioClick`) goes through it and
  so only removes an allow. `getForPrincipal` reports a site without a permission as `BLOCK`.
- `notification-message.dismiss()` is the bar's close button: it tells the observer the bar was
  dismissed, so Firefox does not show it again for that page, and changes no permission.
  `toggleAllowPopupsForSite` removes the current notification and fails when there is none.
- `security.notification_enable_delay` arms doorhanger buttons only; the bar has no delay of its
  own (`_initClickJackingProtection` runs only for a notification given `securityDelayMS`).
- In a native split view each pane's browser keeps its own notification box, moved into the
  pane's container (`#insertNotificationBox`); the focused pane is the selected browser.

## Design

`packages/vimma-core/src/prompt-keys.mjs` gains `popupBarKey` and `popupBarHint` beside the
permission prompt's `doorhangerKey` and `doorhangerHint`. `host/prompt-keys.mjs` (`PromptKeys`)
hands a key to the bar when no prompt is open, keeps the bar's arming clock and gives the status
bar its keys line. `packages/vimma-core/src/popups.mjs` turns what the host reads
(`BlockedPopups`: site, pop-up addresses, redirect, locked, bar on, the site's permission) into
picker rows (`PopupItem`, kind `"popup"`), parses a row id back into its action
(`parsePopupId`), and writes the cue (`popupCue`). `host/popup-ops.mjs` reads the selected
browser's blocker and permission, answers the bar, and runs a row. `ui/picker.mjs` adds
`PopupPicker`, the add-on picker's asynchronous loading with a refusal notice;
`ui/statusbar.mjs` passes the cue through and redraws on the events below.

1. **`y`, `n` and `Esc`, because every other browser question in Vimma is answered that way.**
   The permission prompt, the agent question and the security update question all take `y` and
   `n`; a bar that asks the same kind of question takes the same keys, so there is nothing new to
   learn. `Esc` closes the bar because the bar, unlike a doorhanger, has no `Esc` of its own.
   Rejected: a picker key (`ctrl+b shift+o`), because it needs two steps for the common answer
   and a key of its own to remember.
2. **The permission prompt's guards and mechanism.** The keys go through `PromptKeys`, after the
   prompt's own, so the bar and a prompt never both take a key. Firefox gives the bar no arming
   delay, so `PromptKeys` keeps one: from when it first sees the selected page's bar, or from the
   last key in the window, whichever is later, plus `security.notification_enable_delay`. Every
   key counts, with or without a bar, so a key that switches to a tab with a bar starts that
   bar's wait too. A page can raise the bar at any moment; the wait is what keeps a key meant for
   the page from answering it.
3. **`n` records a block in the site's permission.** It writes `DENY_ACTION` to the permission
   manager, the way Firefox's own allow writes `ALLOW_ACTION` (`toggleAllowPopupsForSite`),
   because `SitePermissions` cannot record a pop-up block (Research), and an `n` that recorded
   nothing would be the same as `Esc` and leave the user nothing to undo. Firefox's permission
   reads, Page Info and the exceptions list show it as Block, and it keeps the site blocked
   should the user turn the pop-up blocker off.
4. **A mistaken `n` is undone from `:popups`, because undoing it must not require Firefox's
   settings.** The picker opens without the bar for a site with a `popup` permission; for a
   blocked site it offers allow and reset, for an allowed one block, and the status bar names
   `:popups` while the block holds. Allow without the bar goes through
   `SitePermissions.setForPrincipal` and then unblocks what was blocked, in the order Firefox's
   allow uses, since Firefox's own allow needs the bar; reset is
   `SitePermissions.removeFromPrincipal`. A site permission picker (`:site`,
   [#684](https://github.com/vimma-browser/vimma/issues/684)) will also cover this permission
   once it lands. (Since changed: `:site` landed with a pop-up row, and the bar's `n` and this
   picker's allow, block and reset now write through its `setSitePopups`
   (`host/permission-ops.mjs`, docs/specs/site-permissions.md), because a second writer could
   drift from the first; a block from either picker is the block the other shows and undoes.)
5. **Firefox's own code runs the bar's options.** `y` and the allow row with the bar call the
   observer's `toggleAllowPopupsForSite` with a stand-in event
   `{ originalTarget: { documentGlobal: window } }`; the open, redirect, hide and settings rows
   call the observer's methods and the blocker's `unblockPopup` / `unblockRedirect` with the
   records listed. `Esc` and `n` close the bar with its own `dismiss()`.
6. **The cue follows the selected browser.** The cue reads the selected browser's notification
   box, so it follows tab switches and, in a split, the focused pane, since that pane's browser is
   the selected one. It redraws on `AlertActive`, `DOMUpdateBlockedPopups` and
   `DOMUpdateBlockedRedirect`, on a `click` or `transitionend` whose target is a
   `notification-message`, because removing a notification fires no event of its own, after a
   key answers the bar, and when the keys come to count.
7. **Refused in the agent workspace.** No key answers the bar and the picker does not open in an
   agent-container tab (`WorkspaceStore.isAgentContainer`), because pages there get no
   permissions (`docs/security/12-agents-mcp.md` M10) and allow would grant one. The host checks
   again when a row runs, so that a tab moved into the agent workspace while the picker was open
   grants nothing.
8. **Rows run on the page they were listed for.** The picker closes when the selected tab
   changes, and a row runs only while the browser it was read from is still selected, so that a
   row never acts on another page's blocker.
9. **Nothing to show: a notice.** The picker opens only with rows, because an empty list over
   the page says less than the notice and needs a key to close.

## Security and privacy

The bar's keys and the picker change the `popup` permission only on the user's key, in the
user's own workspaces, behind the permission prompt's arming delay, so a page cannot time a
keypress into an answer. They are chrome-only: no control command or MCP tool reaches them, and
in the agent workspace no key answers the bar and the picker refuses (M10). They read no page
content; the addresses the picker lists are the ones Firefox's menu lists.

A picker row runs only on the page it was listed for: the picker keeps the page's principal when
it opens and refuses a row once the tab's principal differs, because the picker stays open
across a navigation and an allow chosen for one site must not land on the next. A locked
`dom.disable_open_during_load` stops every Vimma path that changes the permission, the keys'
and the rows', down to the host's own `blockSite` and `allowSite`. A block is written with
Firefox's own `Services.perms.addFromPrincipal`; in a private window the permission manager keeps
it for the private session only. See `docs/security/`, prompt keys.

## Tests

- Vitest, `packages/vimma-core/test/prompt-keys.test.mjs`: `popupBarKey` allows, blocks and
  closes only once armed and not on a held key; keys from a field, during a sequence, with no
  bar or in the agent workspace pass; `Tab` passes; a locked pref leaves `y` and `n` alone;
  `popupBarHint` with and without a field, and locked.
- Vitest, `packages/vimma-core/test/popups.test.mjs`: the rows in Firefox's order; the redirect
  row; the allow row left out when locked; no `hide` row with the bar off; no rows when nothing is
  blocked and the site has no permission; allow and reset for a blocked site, block for an
  allowed one, none when locked; rows selected by id and filtered by text; `parsePopupId`; the cue
  with and without keys, after a block and in the agent workspace; the status bar segment;
  `:popups` and no default key.
- Mochitest, `tests/browser/browser_vimma_popups.js` (fixture `file_vimma_popups.html`, which
  opens two pop-ups while it loads): `y` waits for the bar to be armed, a key restarts the wait,
  then `y` allows the site and opens both pop-ups; `n` blocks the site and `Esc` only closes the
  bar; a page field and the command line keep their keys; after `n`, `:popups` opens without the
  bar, allows the site again, blocks it and resets it; nothing blocked gives the notice; the cue
  follows the selected tab and Firefox's close button; the picker lists the bar's options and
  opens one pop-up without granting anything; the hide row turns the bar off, and settings opens
  `about:preferences`; a row chosen after the page navigated to another site grants nothing; with
  the pref locked `y` and `n` change nothing, the host's block writes nothing, and `Esc` closes
  the bar; in the agent workspace no key answers the bar, the picker refuses and a block stays as
  it was. (Since changed: the bar's keys line waits, shows armed with each
  variant of the cue's text, sits beside the bar's button, is hidden from accessibility, and is
  left out in the agent workspace.)

## Docs and changelog

`docs/guide.md`: a "Blocked pop-ups" section with the undo path, a pointer to it from "Answering
a permission prompt", the cues under "Status bar", and `:popups` in the command table.
`docs/bindings.md`, `docs/bindings.json` and the help snapshot list `popup_picker` unbound. The
changelog line comes from the commit.

## Delivery

One pull request: core, host, UI, tests and docs.

## Open questions

None.
