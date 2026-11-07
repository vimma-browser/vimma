# Spec: page-suggestions

Status: accepted · Area: `packages/vimma-core/src/suggestions.mjs` (new), `actions.mjs`,
`defaults.mjs`, `keymap.mjs`, `firefox-keys.mjs`; `actors/VimmaChild.sys.mjs`,
`actors/VimmaActors.sys.mjs`, `actors/enter-key.mjs`; `host/VimmaHost.sys.mjs` · Upstream
patches: none · ADR: none

Issue: [#837](https://github.com/vimma-browser/vimma/issues/837)

## Summary

In insert mode, while the focused field on a web page shows a suggestion list, `ctrl+n` moves
down the list and `ctrl+p` moves up it, as Vim's insert-mode completion keys do. The keys reach
the page as real `ArrowDown` and `ArrowUp` presses, so the site's own code moves its highlight
and fills the field. New window moves from `ctrl+n` to `ctrl+b shift+c`, so that a key pressed
while typing no longer opens a window.

## Problem

A search field's suggestion list (a search engine's completions, a shop's product matches, an
address form's street names) is picked today with the arrow keys or the mouse. `Tab` does not
help: most sites move focus to the next control on `Tab`. Vimma's insert mode binds only `Esc`
(`packages/vimma-core/src/defaults.mjs`, `modal.insert`), and the Vim-style keys for a list
already have other meanings there: `ctrl+n` is `new_window` and `ctrl+p` is `print_page`
(`defaults.mjs`, `[keys]`). A user who reaches for `ctrl+n` out of habit from Vim, or from
Vimma's own pickers (live grep and tab search move with `ctrl+n` / `ctrl+p`,
[live-grep](live-grep.md), [tab-search](tab-search.md)), opens a new window in the middle of
typing a query.

## Behaviour

1. **Down and up the list.** In insert mode, in a page, while the focused field's suggestion
   list is open (decision 4), `ctrl+n` **must** press `ArrowDown` and `ctrl+p` **must** press
   `ArrowUp` in that field, once per key press, including key repeat. The presses are trusted
   key events, so the page handles them as a keyboard's arrow keys: its highlight moves and, on
   most sites, the field shows the highlighted suggestion.
2. **The page goes first.** A page that handles `ctrl+n` or `ctrl+p` itself (calls
   `preventDefault` on it) keeps the key, and Vimma presses no arrow key.
3. **Without a list.** With no suggestion list open, `ctrl+n` reaches the page and does nothing
   else, and `ctrl+p` prints as it does today. The same holds in a field whose list was closed
   by `Esc` from the page or by the page itself.
4. **Firefox's own popup.** The list Firefox draws for an `<input list>` with a `<datalist>`, and
   for form history, counts as an open list while it shows: `ctrl+n` and `ctrl+p` move its
   selection as `ArrowDown` and `ArrowUp` do. They do not open it; `ArrowDown` still does.
5. **Frames.** A field in a frame, including a frame from another site, behaves the same: the
   press goes to the focused frame.
6. **Other modes and fields.** Normal, visual and the other modes are unchanged. Chrome fields
   (the address bar, the `:` line, Vimma's pickers) keep their own keys; this spec is about pages.
7. **New window.** `new_window` is `ctrl+b shift+c`. `ctrl+n` opens no window in any mode.
8. **Remapping.** Both actions, `suggestion_next` and `suggestion_prev`, and `new_window` are
   bindings like any other: `[modal.insert]` and `[unbind] insert` change the suggestion keys,
   `[keys] new_window` changes the window key, and `ctrl+b ?` lists all three.

## Research

- **Arrow keys today.** Vimma's insert mode passes `ArrowDown` and `ArrowUp` to the page
  (`modal.insert` binds only `Esc`). Checked on the artifact build of Firefox 159.0.1 (lane
  artifact build, headless) with a temporary mochitest and a local page: a field with
  `role="combobox"`, `aria-expanded`, `aria-controls` naming a `role="listbox"`, and a keydown
  handler that moves `aria-activedescendant`. With the field focused (insert mode by focus),
  `EventUtils.synthesizeKey("KEY_ArrowDown")` twice and `KEY_ArrowUp` once in the browser window
  moved the page's highlight to the second and back to the first option, and the page recorded
  each event as trusted. On the same page an `<input list>` with a two-option `<datalist>`:
  `ArrowDown` opened `#PopupAutoComplete`, two more `ArrowDown` presses selected rows 0 and 1,
  and `Enter` filled the field with the second option. So the arrow keys work; no bug precedes
  this feature. Not checked: a live search engine's page, because this machine must not load
  sites protected by bot detection.
- **Trusted keys from the parent.** A `TextInputProcessor` marks every key event it dispatches as
  trusted (`dom/base/TextInputProcessor.cpp:1092-1099`, `KeydownInternal` sets
  `mFlags.mIsTrusted = true`, Firefox 159.0.1). A processor cannot begin a transaction while the
  widget is dispatching another key (`widget/TextEventDispatcher.cpp:58`,
  `BeginInputTransactionInternal`), so a press waits until the current key's dispatch is over.
  Vimma already presses keys this way: `ctrl+j` and `ctrl+m` press `Enter` in a field
  (`actors/enter-key.mjs`, `pressEnterLater`; [key-handling-batch](key-handling-batch.md) § 2)
  and the control socket's `send-keys` presses chords (`ctl/VimmaControl.sys.mjs`,
  `pressChords`). A key pressed in the parent window goes to the focused element, which for a
  page is the `<browser>` and then the page's focused frame, as a keyboard's key does.
- **Not in the content process.** A processor in the content process gets no native key
  bindings for the keypress: `BrowserParent::RecvRequestNativeKeyBindings` answers only under
  automation (`dom/ipc/BrowserParent.cpp:1834-1840`, `xpc::IsInAutomation()`). Script-made
  `KeyboardEvent`s are untrusted, and Firefox's form autocomplete listens to trusted key events
  only (`toolkit/components/satchel/nsFormFillController.cpp:821`, the `keydown` listener added
  with `TrustedEventsAtCapture()`). `nsIDOMWindowUtils.sendNativeKeyEvent`
  (`dom/interfaces/base/nsIDOMWindowUtils.idl:421-426`) takes a platform key code and native
  layout, fires asynchronously and is documented for tests.
- **Firefox's autocomplete popup.** The `<datalist>` and form-history list is the chrome panel
  `#PopupAutoComplete` (`browser/base/content/main-popupset.inc.xhtml:204-214`), driven from the
  content process by `nsFormFillController`, whose `keydown` handler sends `ArrowUp`,
  `ArrowDown`, `PageUp`, `PageDown`, `ArrowLeft` and `ArrowRight` to the autocomplete controller
  (`nsFormFillController.cpp:956`, `KeyDown`; `:1026-1067`, `HandleKeyNavigation`). The frame's
  `AutoComplete` actor child (registered for all frames,
  `toolkit/modules/ActorManagerParent.sys.mjs:180-203`)
  knows whether its popup is open (`toolkit/actors/AutoCompleteChild.sys.mjs:109-111`,
  `popupOpen`, set by `AutoComplete:PopupOpened` and `AutoComplete:PopupClosed`, `:47-57`).
- **ARIA combobox.** In ARIA 1.2 the focused text field carries `role="combobox"`,
  `aria-expanded` and `aria-controls` naming its popup; the ARIA 1.1 pattern puts
  `role="combobox"` on a wrapper with `aria-owns` and the text field inside it, and some sites
  mark only `aria-autocomplete` and `aria-controls` on a plain text box. In every pattern
  `ArrowDown` moves to the next suggestion and `ArrowUp` to the previous one (WAI-ARIA Authoring
  Practices, Combobox Pattern, keyboard interaction; read for this spec, not versioned).
- **Vimma's page-first keys.** A binding on a chord marked P in the Firefox key inventory waits
  for the page and acts on the keypress the page left alone, through the page's reply event for
  a remote page (`requestReplyFromRemoteContent`) and a bubble listener for a parent-process
  page ([firefox-keys](firefox-keys.md) decision 6; `host/VimmaHost.sys.mjs`, `_onKeyPress`,
  `_runAfterPage`). `ctrl+p` is P (`packages/vimma-core/src/firefox-keys.mjs`, the `printKb`
  row); `ctrl+n` is V, consumed on keydown (the `key_newNavigator` row).
- **macOS.** Cocoa binds `ctrl+n` and `ctrl+p` to `moveDown:` and `moveUp:` in text fields
  (`widget/cocoa/NativeKeyBindings.mm:447-460`), an editor command, not an arrow key event, so a
  page's list does not move on them today. Not run on macOS for this spec.

## Design

**Detection, in the content actor and core.** On a `Vimma:SuggestionsOpen` query, the child of
the focused frame (`actors/VimmaChild.sys.mjs`) describes its focused element (through shadow
roots, as `focusin` reports do) as plain data: its `role`, `aria-expanded`,
`aria-autocomplete`, the elements its `aria-controls` and `aria-owns` name (each with its role,
whether it is rendered, `checkVisibility()`, and whether it has a `role="option"` descendant),
the same for its nearest `role="combobox"` ancestor, and whether the frame's `AutoComplete`
actor reports its popup open. Core's `suggestionListOpen(snapshot)` (`suggestions.mjs`, pure)
decides from that data. The child answers with the boolean.

**Keys, in the host.** The two actions are page-first in insert mode. The host lets the key go
to the page; when the page leaves it alone (`_runAfterPage`), the action's content runner asks
the focused frame's actor whether a list is open. Core's `suggestionStep(action, listOpen)`
returns the key to press (`ArrowDown` or `ArrowUp`) or "fall back". A press goes through
`pressKeyLater(win, key, stillFocused)`, the generalised `pressEnterLater` of
`actors/enter-key.mjs`, after the current dispatch and only if the same `<browser>` and frame
still have focus. A fallback runs the chord's own `[keys]` binding for insert mode, if any
(`fallback(mode, seq)`, new on the keymap `compileKeymap` returns): `print_page` for `ctrl+p`;
nothing for `ctrl+n` once `new_window` has moved.

Decisions:

1. **`ctrl+n` and `ctrl+p`.** The default keys are `[modal.insert] "<C-n>" =
"page.suggestion_next"` and `"<C-p>" = "page.suggestion_prev"`, because they are Vim's
   insert-mode completion keys (`i_CTRL-N`, `i_CTRL-P`), Vimma's own pickers already move with
   them, and they stay on the home row. Rejected: `Tab` and `shift+Tab`, because a page uses
   `Tab` to move focus and a form would lose it; `ctrl+j` and `ctrl+k`, because `ctrl+j` is
   `Enter` in a text field (key-handling-batch § 2).
2. **Trusted arrow presses from the parent.** The keys reach the page as `ArrowDown` and
   `ArrowUp` pressed by a `TextInputProcessor` in the parent process, because only trusted keys
   drive every list: a page's own `keydown` handler sees what a keyboard sends, Firefox's form
   autocomplete listens to trusted keys only, and the parent's processor is the path that
   already delivers `ctrl+j`'s `Enter` and the control socket's `send-keys`. Rejected: moving
   the highlight or filling the field from Vimma's actor, because every site keeps its own list
   state and would not see the change; a processor in the content process, because it gets no
   native key bindings outside automation; `sendNativeKeyEvent`, because it depends on the
   platform's key codes and layout and fires asynchronously. The press carries no modifier,
   because the processor keeps its own modifier state, as for `Enter`.
3. **The page goes first.** The two actions wait for the page and act only on a keypress it left
   alone, as `ctrl+w` and `ctrl+j` do in a text field (key-handling-batch § 2), because some web
   apps handle `ctrl+n` and `ctrl+p` in their own lists, and moving the list a second time would
   skip a row. The cost is one round trip to the content process before the arrow key, which
   typing by hand does not notice.
4. **What counts as an open list.** `suggestionListOpen` is true when any of these holds, so
   that the three common markups and Firefox's own popup all count:
   - the focused element, or its nearest `role="combobox"` ancestor, has `role="combobox"` and
     `aria-expanded="true"`, and, when its `aria-controls` or `aria-owns` names elements, at
     least one of them is rendered and visible;
   - the focused element has `aria-autocomplete` of `list` or `both`, or an `aria-controls` or
     `aria-owns`, naming a rendered, visible `role="listbox"` that holds at least one
     `role="option"`;
   - the focused frame's `AutoComplete` actor reports its popup open (decision 5).

   The visibility check is there because sites often leave `aria-expanded="true"` on a field
   whose list they have hidden; `ctrl+p` would then not print. The popup's role is not checked in
   the first case, because the combobox pattern defines `ArrowDown` for every popup kind
   (listbox, grid, tree, dialog), so an arrow press is what the page expects. Rejected: watching
   the field with a `MutationObserver` and keeping the state in the parent, because it costs a
   listener on every page for a question asked only on these two keys, and its state can be
   stale when the key arrives.

5. **Firefox's own popup counts, but is not opened.** The `<datalist>` and form-history popup is
   an open list while it shows, because the same arrow keys move it and a user cannot tell it
   from a page's list. `ctrl+n` does not open it, because with no list open `ctrl+n` belongs to
   the page (decision 6), and `ArrowDown` already opens it.
6. **Without a list, the chord's other meaning.** With no list open the action falls back to the
   chord's `[keys]` binding in insert mode, because `ctrl+p` keeps printing (a print dialog is
   harmless and closes with `Esc`) and a user who binds `ctrl+n` in `[keys]` keeps that binding
   outside a list. Without such a binding the key has already reached the page, which is all
   that happens. The fallback runs straight away, without a second page-first round trip, since
   the page already had the key.
7. **`new_window` moves to `ctrl+b shift+c`.** Because opening a window by accident while typing
   is disruptive and `ctrl+n` now has a Vim meaning in insert mode. `ctrl+b shift+c` is free and
   sits next to `ctrl+b c` (new tab) as tmux's prefix keys do; `ctrl+b shift+n` is taken by
   `new_workspace`. `ctrl+n` has no Vimma binding in normal or the other modes after the move,
   so there it reaches the page.
8. **Firefox's `ctrl+n` stays off.** Firefox's `key_newNavigator` stays disabled whatever
   `[firefox] disable` says, because `ctrl+n` is still a Vimma binding in insert mode and a
   bound chord is off in every mode ([firefox-keys](firefox-keys.md) decision 2), so no key
   opens a window unasked. `[firefox] enable = ["ctrl+n"]` gives Firefox's own new window back
   and drops the default `suggestion_next` binding on that chord too, because the user asked for
   the key as Firefox runs it and two meanings on one key are what decision 2 forbids; the core
   check that drops a modal default on `enable` (`keymap.mjs`) counts the suggestion actions as
   that chord's own. A `[modal.insert]` binding the user wrote on the chord is an error at the
   `enable` line, as for any user binding.
9. **No feature flag.** The feature lands whole in one pull request (sub-PR 1) and the keymap
   change in the next, and each is complete and releasable on its own, so `main` needs no
   `vimma.feature.*` pref. Until sub-PR 2, the fallback keeps `ctrl+n` opening a window outside
   a list.
10. **IME.** While an input method composes, the processor gets no transaction and nothing is
    pressed, because the keys belong to the input method then, as for `Enter`.

## Security and privacy

No new surface. The parent presses an arrow key only in the page and frame that had focus when
the user pressed `ctrl+n` or `ctrl+p`, and only if they still have focus. The query to the
child returns one boolean computed from the page's own attributes, so a page can at most make
`ctrl+n` an arrow press in itself, which it can already do by handling `ctrl+n`. The control
socket, MCP, the agent gate and the agent's keys are unchanged.

## Tests

Vitest (`packages/vimma-core/src/suggestions.test.mjs`, `keymap.test.mjs`,
`defaults.test.mjs`):

- `suggestionListOpen`: ARIA 1.2 combobox expanded with a visible popup → true; expanded with
  its named popup hidden → false; collapsed → false; ARIA 1.1 wrapper with `aria-owns` → true;
  a text box with `aria-autocomplete="list"` and a visible listbox with options → true; a
  listbox with no options → false; the AutoComplete popup open → true; a plain input → false.
- `suggestionStep`: next with a list → `ArrowDown`, prev → `ArrowUp`, either without a list →
  fallback.
- The keymap's `fallback`: `ctrl+p` in insert → `print_page`; `ctrl+n` in insert → none after
  sub-PR 2.
- `[firefox] enable = ["ctrl+n"]` drops the default `suggestion_next` binding; a user's
  `[modal.insert] "<C-n>"` with that enable is an error.
- Sub-PR 2: `new_window` is `prefix+shift+c`; no default binding on `ctrl+n` outside insert.

Mochitest (`tests/browser/browser_vimma_page_suggestions.js`, with
`file_vimma_suggest_combobox.html` and `file_vimma_suggest_datalist.html`):

- ARIA combobox: typing opens the list; `ctrl+n` twice and `ctrl+p` once move the highlight to
  option 2 and back to 1, and the page records trusted `ArrowDown`, `ArrowDown`, `ArrowUp`.
- The same in a cross-origin frame.
- A page that calls `preventDefault` on `ctrl+n` gets no `ArrowDown`.
- No list open: the page receives `ctrl+n` and no `ArrowDown`; `ctrl+p` runs `print_page`
  (the host's print runner replaced by a recorder for the test, so no print dialog opens).
- `aria-expanded="true"` with the named listbox hidden: no `ArrowDown`.
- `<datalist>`: `ArrowDown` opens `#PopupAutoComplete`, `ctrl+n` twice selects rows 0 and 1,
  `ctrl+p` row 0, `Enter` fills the field; with the popup closed, `ctrl+n` does not open it.
- Normal mode: `ctrl+n` and `ctrl+p` press no arrow key.

Sub-PR 2 updates the help overlay snapshot and the bindings docs, with a `ctrl+b ?` screenshot.

## Docs and changelog

- `docs/guide.md`, "Normal and insert mode": a paragraph on `ctrl+n` / `ctrl+p` in a page's
  suggestion list, that the page goes first and that both keys can be remapped in
  `config.toml`. The Keys table and "Firefox's keys are Vimma bindings": `ctrl+b shift+c` new
  window, and `ctrl+n` no longer opening one (sub-PR 2). "PDF viewer": the sentence on `ctrl+n`
  opening a window (sub-PR 2).
- `docs/bindings.md`, `docs/bindings.json`, `defaults.toml` regenerated (`npm run gen-docs`) in
  each sub-PR.
- `docs/specs/firefox-keys.md` (implemented, frozen): a `(Since changed: …)` note at the
  `ctrl+n` row (sub-PR 2).
- Changelog lines come from the commit subjects: "move through a page's suggestion list with
  ctrl+n and ctrl+p" (sub-PR 1) and "open a new window with ctrl+b shift+c instead of ctrl+n"
  (sub-PR 2).

## Delivery

1. **Sub-PR 1: the insert-mode keys.** Core `suggestions.mjs`, the two actions and their
   `[modal.insert]` defaults, the keymap's `fallback`, the `[firefox] enable` rule; the child's
   `Vimma:SuggestionsOpen`, `pressKeyLater`, the host's page-first handling; vitest and the
   mochitest; the guide paragraph; bindings docs. This spec's status note becomes "sub-PR 1
   built". `Part of #837`.
2. **Sub-PR 2: `new_window` on `ctrl+b shift+c`.** A keymap change on its own, as
   [AGENTS.md](../../AGENTS.md) requires: `defaults.mjs`, the bindings docs, the help snapshot,
   the guide's key lines, the firefox-keys note, a `ctrl+b ?` screenshot. Status `implemented`.
   `Closes #837`.

## Open questions

None. The one question this feature could have raised, whether the arrow keys already reach a
page's list in insert mode, is answered in Research: they do.
