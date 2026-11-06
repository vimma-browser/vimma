# Spec: key-handling-batch

Status: implemented · Area: core (`keys.mjs`, `firefox-keys.mjs`, `config.mjs`,
`defaults.mjs`, `actions.mjs`, `sidepanel.mjs`, `editable.mjs`), host (`VimmaHost`,
`host/firefox-keys.mjs`, `host/edit-keys.mjs`, `host/tab-ops.mjs`), actors (`VimmaChild`,
`VimmaActors`), UI (`ui/side-panel.mjs`), about:vimma

Four key changes in one PR: Firefox's own shortcuts stop overlapping Vimma's keys, Vim's
text-field editing keys, layout-proof matching of Option/AltGr characters, and `x` in the side
panel.

## Goal

- Firefox's default shortcuts that overlap Vimma's keys are removed.
- Text fields: `ctrl+w` deletes the previous word, `ctrl+u` to the start of the line, `ctrl+h` is
  backspace, on by default, with a config option to turn them off.
- Option/AltGr: on macOS, Option-composed characters (`{` `}` `[` `]` `$` `@` `|` `~` on Finnish
  layouts) arrive with altKey, so `{` does not match a `{` binding; Windows AltGr arrives as
  ctrl+alt.
- `x` in the side panel closes the selected tab; the panel stays open.

## 1. Firefox's own shortcuts

**What is off by default** (grepped: `browser/base/content/browser-sets.inc.xhtml`,
`#mainKeyset`, the letters from `browser/locales/en-US`, Firefox 157.0.1, Linux):

| Chord    | `<key>` id               | Firefox's action              | Vimma's use                                    |
| -------- | ------------------------ | ----------------------------- | ---------------------------------------------- |
| `ctrl+b` | `viewBookmarksSidebarKb` | bookmarks sidebar             | the prefix                                     |
| `ctrl+d` | `addBookmarkAsKb`        | bookmark dialog               | half page down                                 |
| `ctrl+h` | `key_gotoHistory`        | history sidebar               | backspace in text fields                       |
| `ctrl+i` | `key_viewInfo`           | Page Info                     | history forward                                |
| `ctrl+k` | `key_search`             | web search (focus the search) | Vim's insert `ctrl+k` (digraph); readline kill |
| `ctrl+o` | `openFileKb`             | Open File                     | history back                                   |
| `ctrl+u` | `key_viewSource`         | view source                   | half page up; delete to line start             |
| `ctrl+w` | `key_close`              | close tab (reserved)          | `ctrl+w h/j/k/l` panes; delete word            |

`ctrl+e` and `ctrl+y` are in the default list too (scroll a line): on Linux Firefox binds neither
(`key_search2` is `ctrl+j` on Linux, `ctrl+e` on Windows and macOS; downloads is
`ctrl+shift+y` on GNOME), so they match nothing there and about:vimma says so. `ctrl+j` stays.

**How.** Our own code, no patch: `host/firefox-keys.mjs` sets `disabled="true"` on the matching
`<key>` elements of `#mainKeyset` (since firefox-keys sub-PR 1, of every keyset of the window)
at window init and after every config change, and marks them `vimma-disabled` so it only ever
re-enables its own. `dom/events/GlobalKeyListener.cpp` reads `disabled` at key time
(`CanHandle` → `KeyElementIsDisabled`), so the change is live; a disabled key is no longer
reserved either, so the page gets the chord. The letters come from Fluent
(`data-l10n-id`), maybe after our init, and other locales may use other letters: a
MutationObserver on the keyset re-applies when a `key`, `keycode`, `modifiers` or `disabled`
attribute changes (Firefox flips `disabled` itself on some keys). Matching is by chord, from
the element's own `key`/`keycode`/`modifiers` (`accel` is ctrl, meta on macOS). VimmaHost starts in
browser.xhtml's `<head>`, before `#mainKeyset` is parsed, so the first pass runs at
`DOMContentLoaded`.

**Kept** (not overlapping): `ctrl+t`, `ctrl+n`, `ctrl+shift+t`, `ctrl+l`, `ctrl+f`, `ctrl+tab`,
`alt+1..9`, `ctrl+q`, and every other `#mainKeyset` key. Since [firefox-keys](firefox-keys.md)
sub-PR 1, Vimma binds most of these itself, and a chord Vimma binds is always off as a Firefox
shortcut.

**Config** (schema 2):

```toml
[firefox]
disable = ["ctrl+b", "ctrl+d", "ctrl+e", "ctrl+h", "ctrl+i", "ctrl+k", "ctrl+o", "ctrl+u", "ctrl+w", "ctrl+y"]
enable = []
```

- `disable` is `"all"` or a list of chords (Herdr notation, canonicalised). A list replaces the
  default list. `"all"`: every `#mainKeyset` shortcut that has ctrl, alt or meta (accel), except
  `ctrl+q` (quit; `cmd+q` on macOS) and the `internal` text keys (copy, paste, undo: the editor
  runs those, not the keyset). Plain keys stay (F5, F11, F3, Esc stop, Delete, Backspace,
  shift+Esc), and so do keys outside `#mainKeyset`: tab switching (`ctrl+tab`,
  `ctrl+pagedown`, handled by tabbrowser's keydown) and the devtools keyset.
- `enable` is a list of chords that stay Firefox's whatever `disable` says.
- Errors: not a string or a list; a string other than "all"; a key that does not parse
  (`unknown key`); a chord without ctrl, alt or meta that is not a function key ("Firefox's
  shortcuts have ctrl, alt or meta"). The whole file is refused as for any error.
- about:vimma's "Firefox shortcuts" section lists each one off (chord, id, command) and the listed
  chords that match no Firefox shortcut; `:bug`'s report counts them.

**Edge cases.** A chord Vimma consumes was never Firefox's anyway; the list matters for the keys
Vimma passes (insert mode, chrome text fields, one pane for `ctrl+w`, about: pages without our
actor). `ctrl+w` with one pane now reaches the page instead of closing the tab: close a tab with
`x`, `ctrl+b shift+x` or `:q`. On macOS `accel` is cmd, so `ctrl+…` matches only the
`modifiers="control"` keys there.

## 2. Vim editing keys in text fields

| Key      | Command (editor's own, undoable) |
| -------- | -------------------------------- |
| `ctrl+w` | `cmd_deleteWordBackward`         |
| `ctrl+u` | `cmd_deleteToBeginningOfLine`    |
| `ctrl+h` | `cmd_deleteCharBackward`         |

`[modal] insert_editing = true` (schema 2, default on). Exactly these chords, no shift, alt or
meta. A binding in the mode wins (a user's `[modal.insert] "<C-w>"`), and so does a Firefox
shortcut the config re-enables for that chord.

- **Chrome text fields** (URL bar, `:` line, help and bookmark filters, find bar, prompts): when
  the dispatcher passes the chord and the focused element (through shadow roots) is editable
  (core `isEditable`), the host runs the command through
  `document.commandDispatcher.getControllerForCommand` and consumes the key.
- **Pages** (inputs, textareas, contenteditable, in any frame): the page goes first, so a web
  terminal or an editor that takes `ctrl+w` keeps it. In insert mode the host lets the key pass
  and asks for Firefox's reply event (`requestReplyFromRemoteContent`, as Tabbrowser does for its
  tab keys); on the reply, if the page did not prevent it, it sends `Vimma:Edit` to the focused
  frame's actor, whose child runs `docShell.doCommand` when its focused element is editable. A
  parent-process page (Settings, the start page) has no reply: the host acts in its own
  system-group bubble listener after the page. Reply events no longer re-enter the dispatcher
  (`_onKeyDown` ignores `isReplyEventFromRemoteContent`).
- **Normal mode is untouched**: `ctrl+w h/j/k/l` and `ctrl+u` are dispatched as before; a text
  field focused in normal mode (a page's autofocus) gets no editing, since only insert mode asks
  for the reply.
- **macOS**: Cocoa's own bindings already make `ctrl+h` a backspace in text fields, so Vimma does
  not add a second one there.

(Since changed: `ctrl+j` and `ctrl+m` are `Enter` in text fields, as Vim's `i_CTRL-J` and
`i_CTRL-M` begin a new line and its command line's `c_CTRL-J` and `c_CTRL-M` run the command,
under the same `insert_editing`, the same page-first rule and the same Firefox-shortcut rule.
Decisions:

- Enter is a key press, not an editor command, because Enter means something different in each
  field (a new line, a form's implicit submit, a page's own `keydown` handler, the address bar's
  load, the `:` line's run) and only a real Enter gets all of them. A `KeyboardEvent` made by
  script is untrusted: a form does not submit and the editor adds no line.
- The parent presses it, through a `TextInputProcessor` (`actors/enter-key.mjs`), the trusted
  path the control socket's `send-keys` already uses, because a processor in the content
  process cannot dispatch the `keypress`: its edit commands come from the parent, which
  `BrowserParent::RecvRequestNativeKeyBindings` answers only under automation. Firefox routes
  the Enter to the focused field, in chrome or in a page's focused frame, as a keyboard's. The
  content actor's `Vimma:Edit` keeps taking only the three editor commands.
- The processor has its own modifier state, so the Enter carries no `ctrl`, because ctrl+Enter
  is another key (the address bar completes `www.` and `.com`). It is pressed after the current
  key's dispatch, because a processor cannot begin a transaction on a widget mid-dispatch, and
  only if the field (chrome), or the page and its focused frame (content), still has focus
  then; a page's reply acts only on the `<browser>` it came from, because a busy page's late
  reply would otherwise press Enter in the tab focused since. While an IME
  composes, the processor gets no transaction and nothing is pressed. In a page the Enter waits
  for the page's reply, as `ctrl+w` does, so keys sent faster than that round trip (a script
  driving the control socket) can land before it; typing by hand does not.
- In the modes that type into a text field (insert, command, help), a default `[keys]` binding
  on a text-field key is not bound, because `ctrl+j` (`web_search`) and `ctrl+m` (`mute_tab`)
  carry Firefox's meaning and would otherwise always win over the field's key. They stay bound in
  normal, visual and panel mode, because those modes' keys are not typing: the side panel's
  `ctrl+m` still mutes, so its filters get no Enter from these keys. A `[keys]` binding the user added, or a `[modal.*]` binding,
  still wins; a `[keys]` line that repeats the default (a copied `defaults.toml`) counts as the
  default, so `parseConfig(defaults.toml)` stays the default keymap. `insert_editing = false`
  keeps every binding.)

## 3. Option / AltGr characters

`chordFromEvent` folds a character composed with Option or AltGr into the plain character, as
shift is already folded for printable characters:

- `getModifierState("AltGraph")` true (GTK sets it for ISO_Level3_Shift, the AltGr key, and
  reports `altKey` false: `widget/gtk/nsGtkKeyUtils.cpp`, `ComputeKeyModifiers`; Windows sets it
  for a real AltGr and then reports neither ctrl nor alt: `widget/windows/KeyboardLayout.cpp`,
  `ModifierKeyState::Update`; macOS sets it with every Option press:
  `widget/cocoa/nsCocoaUtils.mm`, `ModifiersForEvent`), or ctrl and alt together (Windows'
  left ctrl + alt emulation of AltGr), or alt where `getModifierState` is missing;
- and the key is one printable character that differs from what its physical key (`code`) types
  on a US layout at the same shift state (`Digit7` types `7`, or `&` with shift).

Then alt is dropped, and ctrl too when ctrl and alt were both down. So Finnish AltGr+7 is `{`,
AltGr+4 is `$` (US shift+4 is also `$`, but shift is up), Mac Option+shift+8 is `{`. A genuine
`alt+1` (Digit1 typing `1`), `ctrl+alt+]` on a US layout and every ctrl+letter chord keep their
modifiers. Alt alone with `AltGraph` false (Linux, Windows) is always a genuine alt chord.

## 4. `x` in the side panel

- `[modal.panel] "x" = "panel.close_tab"` (`panel_close_tab`): closes the selected row's tab with
  Firefox's `removeTab`; the selection moves to the next row (the previous one at the end) and the
  panel stays open, so `x x x` closes three.
- A pinned tab is not closed: the notice says "pinned tab: unpin it to close it". Pinned tabs
  belong to no workspace (limits.md), so the panel never lists one; the guard covers a row pinned
  since the last render, and `closeTabById` refuses a pinned tab too.
- Counts: panel mode has none (`COUNT_MODES` is normal, visual, resize, and `1`..`9` select a row),
  so `3x` selects row 3 (which goes to its tab and closes the panel), and the `x` is then normal
  mode's `tab.close`, which closes that tab. Noted in limits.md.
- `ctrl+shift+t` reopens the last closed tab (`restore_tab`, Firefox's
  `History:RestoreLastClosedTabOrWindowOrSession` command). This batch bound it as
  `[modal.panel] "<C-S-t>" = "tab.restore"`, since panel mode consumes every other key;
  [firefox-keys](firefox-keys.md) sub-PR 1 replaced that with a global `[keys]` binding.
- The bookmarks panel shares the mode: `x` does nothing there (`d` deletes).

## Tests

Vitest: `keys.test.mjs` (Option/AltGr cases), `firefox-keys.test.mjs` (chords of `<key>`
elements, the plan for default, list, "all", enable), `config-v2.test.mjs` (`[firefox]`,
`insert_editing`), `sidepanel.test.mjs` (`panel.close_tab`). Mochitests:
`browser_vimma_firefox_keys.js`, `browser_vimma_edit_keys.js`, `browser_vimma_side_panel.js`.
