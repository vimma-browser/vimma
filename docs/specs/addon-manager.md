# Spec: addon-manager

Status: implemented · Area: core (`packages/vimma-core/src/addons.mjs`, `picker.mjs`,
`cmdline.mjs`, `actions.mjs`, `defaults.mjs`), host (`host/addon-ops.mjs`, `VimmaHost`), UI
(`ui/picker.mjs`, `ui/cmdline.mjs`)

## User story

As a Vimma user with add-ons from AMO (a password manager, uBlock Origin) I open an add-on's
popup from the keyboard, and manage my add-ons (options, enable/disable, remove, updates,
private windows) without the mouse or about:addons.

## Decisions

1. **Keys.** `ctrl+b e` (`addon_picker`, id `addons.picker`) and `:addons` open the add-on
   picker. `prefix+e` was free in `defaults.mjs` (checked 2026-10-10), so it is the default.
   `:addon <name>` (`addon_popup`, id `addons.popup`) opens one add-on's popup; it has no
   default key.
2. **The picker reuses the goto/workspace picker**: the `GotoPicker` dialog, core picker
   matching (`filterItems`, `scoreField`), the same key machine (`pickerKey`) and
   `picker.css` with its theme tokens. A new item kind `"addon"` matches by name only. Its own
   keys in browse mode (`/` search mode types them): `o`, `x`, `d`, `u`, `shift+p` give an
   `addon` effect with the op; Enter gives `select`.
3. **What is listed** (core `addonItems`): `AddonManager.getAddonsByTypes(["extension"])`
   (grepped in `toolkit/mozapps/extensions/AddonManager.sys.mjs`), minus every add-on that is
   `isSystem`, `isBuiltin` or `hidden` (about:addons' own `!addon.hidden` filter, in
   `content/aboutaddons.mjs`; measured: Form Autofill, New Tab, Picture-in-Picture, WebCompat
   and the other built-ins are all three). Themes, dictionaries, language packs and site
   permissions are other types and never listed. Sorted by name (case-insensitive), then id.
4. **A row**: the name (fuzzy highlight), then `version · enabled|disabled`, `· private ok`
   when the add-on may run in private windows, `· update` when an update is waiting
   (`AddonManager.getAllInstalls()` with this add-on as `existingAddon`, or `pendingUpgrade`).
   Private access is Firefox's `internal:privateBrowsingAllowed` permission
   (`ExtensionPermissions.get`, as about:addons' `isAllowedInPrivateBrowsing`); an add-on with
   `incognito: "not_allowed"` is never "private ok". Every name is set with `textContent`.
5. **Popups (Enter, `:addon`) go through Firefox's own keyboard path**:
   `gUnifiedExtensions.browserActionFor(policy).triggerAction(window)`, the same call an
   extension's `_execute_action` / `_execute_browser_action` shortcut makes
   (`ExtensionShortcuts.sys.mjs`). It opens the popup as a click on the toolbar button would,
   or, without a popup, fires `browserAction.onClicked` (the add-on's "command"). When the
   button lives in the Unified Extensions panel (the default for new add-ons; Vimma keeps
   Firefox's nav bar and its puzzle button), `openPopup` opens that panel first and the popup
   anchors there; on the nav bar it anchors on the button. Measured: focus lands in the popup's
   browser (`ExtensionPopups.sys.mjs` sends `Extension:GrabFocus` once positioned); Esc closes
   the panel (a XUL panel's own Esc) and focus returns to the page. Keys in the popup are the
   popup's: it is a `<browser>` without Vimma's actor, so the host treats it as insert mode
   (only global chords such as `ctrl+b` stay Vimma's). No browser action at all: the notice
   says `<name>: no popup or button`. A disabled add-on:
   `<name> is disabled (x in ctrl+b e enables it)`.
6. **Options (`o`)**: an add-on with an options page (`optionsURL`, from `options_ui`) opens it
   in a tab with `switchToTabHavingURI` (a tab already showing it is selected), as about:addons'
   `openOptionsInTab`. Deviation: an inline (`open_in_tab: false`) options page opens in a tab
   too, not inside about:addons, so Vimma's keys work on it. Without an options page:
   about:addons' details view for the add-on (`BrowserAddonUI.manageAddon`). The picker closes.
7. **Enable / disable (`x`)**: `addon.enable()` / `addon.disable()`, only with
   `PERM_CAN_ENABLE` / `PERM_CAN_DISABLE` (a policy-locked add-on refuses with a notice). The
   picker stays open and its rows refresh.
8. **Remove (`d`)** asks first with the y/N prompt (`RenamePrompt.ask`), after closing the
   picker, as workspace delete does: `remove "<name>" <version>? (y/N)`. The yes stands for the
   add-on as asked about (stale-answer guard, as `closeWorkspace`): if by the `y` it is gone, or
   its name or version changed, nothing is removed and the notice says so. Without
   `PERM_CAN_UNINSTALL` it refuses before asking. Removal is `addon.uninstall()`.
9. **Updates (`u`)**: `addon.findUpdates(listener, AddonManager.UPDATE_WHEN_USER_REQUESTED)`;
   the notice says `checking for updates…`, then `<name>: no update`,
   `<name>: update <version> available (install: about:addons)` or
   `<name>: update check failed`. Deviation: Vimma only checks, it never installs the found
   update itself, because an update that asks for new permissions must go through Firefox's own
   prompt (about:addons attaches it with `attachUpdateHandler`); Firefox's background updates
   and about:addons install it. The row shows `update` meanwhile. Without
   `PERM_CAN_UPGRADE` (a temporary add-on, one without an update URL) the notice says
   `<name>: updates are not checked`.
10. **Private windows (`shift+p`)**: add or remove `internal:privateBrowsingAllowed` with
    `ExtensionPermissions.add/remove` and reload the add-on if active, exactly as about:addons'
    "Run in Private Windows" radio (`components/addon-card.mjs`). Only with
    `PERM_CAN_CHANGE_PRIVATEBROWSING_ACCESS`; otherwise a notice (`not_allowed` add-ons, policy).
11. **`:addon <name>`**: fuzzy name matching with the picker's `scoreField` over the listed
    (not system, not hidden) add-ons, the best match wins; none: `no add-on matches "<name>"`.
    Tab completes the argument with add-on names (core `completeCommandLine` gains argument
    completion for commands that declare a completer; the host passes the names, which an
    AddonManager listener started at the first window keeps current, so they are in before
    the first Tab; a candidate shows the name, its value is the whole line). Without a
    name (the `addon_popup` key) it opens `:addon ` on the command line, as `open_url` does.
12. **Binding one add-on to a key.** Keymap actions carry no free-text argument (a `[keys]`
    value names an action; only `:` commands take text), and building a new mechanism for it is
    out of scope. The closest working ways: bind `addon_popup` to a key (it opens `:addon `,
    type a few letters, Tab, Enter), or give the add-on's own "Activate the extension" shortcut
    a key in about:addons → Manage Extension Shortcuts, which is the same `triggerAction` call.
    Vimma lets every chord it has no binding for through, so such a shortcut works as in
    Firefox; a chord Vimma binds wins.
13. **Safety.** Vimma never installs an add-on: installing stays AMO's page plus Firefox's
    permission prompt. Removing always asks. The picker never lists or acts on system, built-in
    or hidden add-ons, and every op looks the add-on up again by id through the same filter
    (`:addon` cannot reach a hidden one either). Every op is a chrome action run from Vimma's
    key handler or command line; nothing is reachable from page content (no actor message, no
    control-socket command). Names render with `textContent` only.

## Keys

| Key                   | Does                                                  |
| --------------------- | ----------------------------------------------------- |
| `ctrl+b e`, `:addons` | open the add-on picker                                |
| `j` / `k`, `/`        | move, filter                                          |
| `Enter`               | open the add-on's popup (or run its button's command) |
| `o`                   | options page in a tab, or its about:addons details    |
| `x`                   | enable / disable                                      |
| `d`                   | remove, after y/N                                     |
| `u`                   | check for updates; the result in the notice           |
| `shift+p`             | toggle "run in private windows"                       |
| `Esc` / `q`           | close                                                 |
| `:addon <name>`       | open that add-on's popup (Tab completes names)        |

## Edge cases

- No add-ons: the picker opens with one row, `No add-ons installed. Get them at addons.mozilla.org.`
- An add-on removed or disabled elsewhere while the picker is open: ops look it up by id
  again; gone: `that add-on is gone`.
- Enter on a disabled add-on: notice, nothing opens. `triggerAction` closes a popup already
  open for that add-on (as its shortcut does).
- `openPopup` refuses a window that is not the active one (Firefox's own guard): `:addon` runs
  only from a focused window's key handler, so this does not arise.
- A popup whose add-on is disabled for the current tab (`browserAction.disable(tabId)`):
  Firefox opens nothing, as a click would.
- Names with markup (`<b>x</b>`) or very long names: text only; CSS ellipsis as other rows.
- Private window: the picker works (add-ons are app-wide); an options page of an add-on not
  allowed in private windows does not load there (Firefox's own rule).

## Tests (written first)

- Vitest `packages/vimma-core/test/addons.test.mjs`: filtering (system, built-in, hidden,
  sort), row text, best-match for `:addon`, the stale-answer check; `picker.test.mjs`: the
  addon keys' effects and name-only matching; `cmdline.test.mjs`: `:addon`/`:addons` parsing and
  argument completion.
- Mochitest `tests/browser/browser_vimma_addons.js`, three extensions installed from inline
  XPIs (`ExtensionTestUtils.loadExtension` with `useAddonManager: "permanent"`): one with a
  popup, one with `options_ui`, one with neither. The picker lists them and no system add-on;
  Enter opens the popup with focus inside, Esc closes it and focus returns to the page; `o`
  opens the options; `x` toggles; `d` + `y` removes, `d` + `n` keeps, the guard refuses a
  changed add-on; `shift+p` toggles private access; `u` reports a result; `:addon name` opens
  the popup; an HTML name renders as text.

## Out of scope

Installing add-ons, themes and dictionaries, sidebar actions (`sidebar_action`, Firefox's own
sidebar), page actions, an add-on's context-menu entries, extension shortcuts editing, a
per-add-on key binding mechanism in config.toml, installing a found update.

## Settled

- **Red** (2026-10-10): Vitest `Cannot find module '../src/addons.mjs'` (no tests ran); the
  mochitest, against the build without the host and UI changes, 12 failures, e.g.
  `lists_extensions_but_not_system_ones - ctrl+b e opens the add-on picker - timed out after
100 tries` and `colon_addon_opens_a_popup_with_tab_completion - Tab completes the add-on's
name - timed out`.
- **Green:** Vitest 21/21 in `addons.test.mjs` (2056 in all); the mochitest 77/77, and 14
  repeats on two busy CPUs 1078/1078; the whole `tests/browser/` suite 3479/3479 on the
  artifact build.
- Found on the way: `ExtensionPermissions.add/remove` write `data_collection` into the object
  they are given, so a frozen permissions object throws; each call gets a new one. The first
  `:addon` Tab came before AddonManager answered, so the names listener starts with the window.
- **Mutation check:** without the version comparison in core `addonChanged`, Vitest fails
  (`changed: gone, renamed or another version`) and so does the mochitest
  (`a_stale_yes_removes_nothing - the guard refuses - timed out`); reverted.
- The `help.test.mjs` and `defaults.test.mjs` snapshots gain the Add-ons rows and
  `addon_picker = ["prefix+e"]` only. The Add-ons group is last in the bindings overlay, so the
  e2e help screenshot's first screen keeps its rows.
