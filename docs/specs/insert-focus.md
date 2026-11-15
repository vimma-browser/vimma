# Spec: insert-focus

Status: implemented · Area: `host/VimmaHost.sys.mjs`, `host/page-ops.mjs`,
`actors/VimmaActors.sys.mjs`, `host/VimmaParent.sys.mjs`, `actors/VimmaChild.sys.mjs` · Upstream
patches: none · ADR: none

Issues: [#165](https://github.com/vimma-browser/vimma/issues/165),
[#298](https://github.com/vimma-browser/vimma/issues/298) (the follow-up below),
[#850](https://github.com/vimma-browser/vimma/issues/850) (the second follow-up)

## Summary

Insert mode entered with `i` or `gi` now lasts until `Esc`, whatever the page does with focus, so
keys typed into a page never turn into Vimma commands halfway through. `i` goes back to the text
field the user was last in on the page, and only falls back to the page's first field when there
is none. Insert entered by focusing a field keeps following the focus as before.

## Problem

Until this change, every focus report from the page decided the tab's mode, including after an
explicit `i` ([m1-actor-insert-scroll](m1-actor-insert-scroll.md), "Per-browser mode").

- A page that moves focus itself ends insert. GitHub's "Go to file" box moves focus to its result
  list while the user types; YouTube's consent dialog takes focus on load. The focus report then
  put the tab back in normal mode, and the keys that followed ran as Vimma commands: `t` opened a
  tab, `j` scrolled. The site-compat suite's shortcut probe opened stray tabs this way
  ([site-compat](site-compat.md), "Implementation log (sub-PR 1)").
- A page that blurs its field (to show a menu, or after a submit) ends insert the same way.
- `i` always focused the page's first text field. A user who was typing in a comment box, pressed
  `Esc` to scroll, and pressed `i` to continue was put in the search box at the top instead.

## Behaviour

1. **Explicit insert.** `i` (`mode.insert`) and `gi` (`page.focus_input`, when a field took
   focus) enter _explicit insert_. While the tab's top document is the one it was entered on, a
   focus change in the page **must not** end it: focus moving to a non-editable element, to the
   document body, or into another frame leaves the tab in insert, and every key reaches the page.
2. **Leaving it.** `Esc` ends explicit insert as it ends any insert (`mode.normal`: the field is
   blurred and the tab is in normal mode). A new top document in the tab (a navigation or a
   reload) ends its hold: the first focus report from the new document decides the mode by the
   usual rules. A same-document navigation (`history.pushState`) keeps it, and so does going
   back to the same document restored from the back-forward cache, since that keeps its inner
   window.
3. **`i` goes back to the last field.** `i` focuses the text field that last took focus in the
   tab, if its frame still shows the same document and the field is still connected, visible and
   editable,
   including a field in a cross-origin frame and a contenteditable editor. Otherwise it focuses
   the page's first visible text field, as before. With neither, it is the pass-through insert of
   [m1-actor-insert-scroll](m1-actor-insert-scroll.md).
4. **Focus insert is unchanged.** Insert entered by focusing a field (a click, `Tab`, a page's
   `autofocus`) follows the focus: a page moving focus from one field to another keeps insert,
   and focus moving to a button, a link or the body returns to normal. (Since changed: after
   `Esc`, a focus the page's script makes on its own no longer enters insert; see "Follow-up:
   Esc holds against the page".)
5. `gi` keeps its count: `gi` focuses the first field, `3gi` the third
   ([m1-actor-insert-scroll](m1-actor-insert-scroll.md), "Follow-up: normal-mode extras").

## Research

- **Vim.** `gi` "Insert[s] text in the same position as where Insert mode was stopped last time in
  the current buffer" (`:help gi`, `runtime/doc/insert.txt:1953-1955`, Neovim 0.12.5, read
  locally). Insert mode in Vim ends only on `Esc` (or `ctrl+c`, `ctrl+[`); nothing in the buffer
  ends it for the user.
- **Vimium** (philc/vimium at `5aa29614bf`, after v2.4.2, read with `gh api`): `i` is
  `enterInsertMode`, "Enter insert mode" (`background_scripts/all_commands.js:150-154`), which
  focuses nothing and passes keys to the page; it exits on `Esc` and when a focusable element takes
  focus (`exitOnFocus: true`, `content_scripts/mode_normal.js:208-212`), after which the
  permanent, focus-tracking insert mode takes over (`content_scripts/mode_insert.js:8-10`). `gi`
  is `focusInput`, "Focus the first text input on the page" (`all_commands.js:182-186`).
- **Firefox.** A `WindowGlobalParent` is "a handle in the parent process to a specific
  nsGlobalWindowInner object" (`dom/ipc/WindowGlobalParent.h:70-72`, Firefox 158.0); its
  `innerWindowId` (`dom/chrome-webidl/WindowGlobalActors.webidl:19`) therefore changes with each
  new document in the browsing context and stays the same across `history.pushState`.
- **Vimma.** The child reports `focusin` for the focused element and `recheck` on a `focusout`
  with no related target (`actors/VimmaChild.sys.mjs`, `handleEvent`); the parent takes reports
  only from `Services.focus.focusedContentBrowsingContext` (`actors/VimmaParent.sys.mjs`; since
  changed: `host/VimmaParent.sys.mjs`, ADR-026).

## Design

The host keeps, per tab `<browser>`, the top document's `innerWindowId` at the moment explicit
insert began (`explicitInsert`, a `WeakMap`). `onFocusReport` returns early while the tab is in
insert and that ID is still the top's current one. Every change to a mode other than insert goes
through `setBrowserMode`, which drops the entry, so `Esc`, copy mode and any later normal mode end
it in one place.

For `i`, the child keeps a `WeakRef` to the editable element that last took focus in its document
(not one focused by Firefox's find, [m1-find](m1-find.md)). The host keeps, per tab, the
`BrowsingContext` whose report last named an editable element on `focusin`, with its document's
`innerWindowId`. `i` asks that frame,
if it is not discarded, belongs to the tab and still shows that document, to focus its field (`Vimma:FocusLast`, a query
that answers whether the field took focus); on `false` or an error it sends `Vimma:FocusInput`
to the top frame, as before.

1. **Explicit insert ends only on `Esc` or a new document.** Keys typed after `i` stay the page's,
   because pressing `i` means the next keys are meant for the page, and a page moving focus is the
   page's business, not a request to leave. Rejected: following the focus as Vimium's `i` does
   (exit when an element takes focus, then let the focus-tracking mode decide), because that is
   the behaviour that sent GitHub keystrokes to Vimma; it works in Vimium only because Vimium
   then re-enters insert for the new element when it is editable, which a result list is not.
2. **A new top document ends the hold.** The first focus report from a new document decides the
   mode by the usual rules, so that a search submitted from insert lands in normal mode on the
   result page, where `j` scrolls. The document's `innerWindowId` is the boundary, so a
   single-page app's own navigation, which keeps the document, keeps insert as typing continues.
3. **`gi` is explicit too,** because it is the same request (type into the page) with a choice
   of field, and a page moving focus after `gi` breaks it the same way.
4. **`i` returns to the last field.** The field the user last typed in is the one Vim's `gi`
   would return to and the one a user coming back from scrolling expects, so `i` resumes typing
   there; the first field remains the fallback, so `i` on a fresh page does what it did. The
   choice lives in the frame that owns the field, since only its child can reach the element,
   and in the parent, since only the parent knows which frame that was. Rejected: `i` as a pure
   pass-through that focuses nothing (Vimium's `i`), because on the common page with a search
   box or form it would need a second step to start typing; a per-site pass-through for sites
   with single-key shortcuts is site-compat's open question 3.
5. **Focus insert keeps following the focus,** because a user who clicked into a field and then
   lost it to the page (a submit, a dialog) expects Vimma's keys back without pressing `Esc`, as
   before this change.
6. **One place drops the hold.** `setBrowserMode` drops the explicit entry on any change to a mode
   other than insert, so that no path to normal mode (copy mode's exit, a key runner, a tab's
   mode reset) can leave a stale hold that would swallow a later focus report.

## Security and privacy

A page cannot enter explicit insert: only the parent's key handling runs `mode.insert` and
`page.focus_input`. A page cannot end it either, which is the point: before this change a page
could turn the user's next keys into Vimma commands by moving focus at the right moment. The new
`Vimma:FocusLast` message carries no data and goes only to a frame of the same tab that has
reported focus, and only while that frame still shows the document that reported it (the
host keeps the frame's inner window ID with it), so a frame that has since loaded another site's
page is not asked; the worst a compromised frame can do is focus an element of its own. The frame
check of [m1-actor-insert-scroll](m1-actor-insert-scroll.md) ("only the focused frame may
report") still guards which frame is remembered. Rules K2 and K3 in
[docs/security/13-page-modes.md](../security/13-page-modes.md) hold this with tests.

## Tests

`tests/browser/browser_vimma_insert_focus.js`, fixtures `file_vimma_insert_focus.html` (a page
whose script focuses its result list when "go" is typed), `file_vimma_insert_autofocus.html` (a
login form with `autofocus` that moves to the password on `Enter`) and `file_vimma_frame.html`
(cross-origin):

- Behaviour 1: `after_i_the_page_moving_focus_off_the_field_keeps_insert` (the page gets `t` and
  `j`, no tab opens, nothing scrolls; `Esc` then `j` scrolls),
  `after_i_the_page_blurring_the_field_keeps_insert`,
  `after_i_on_a_page_with_no_field_a_page_focus_keeps_insert`,
  `after_gi_the_page_moving_focus_off_the_field_keeps_insert`.
- Behaviour 2: `explicit_insert_ends_with_the_page`.
- Behaviour 3: `i_focuses_the_field_last_used`, `i_focuses_the_editor_last_used`,
  `i_focuses_the_field_last_used_in_a_cross_origin_frame`,
  `i_falls_back_to_the_first_field_when_the_last_is_gone`,
  `i_falls_back_to_the_first_field_when_the_last_frame_navigated`; the first-field case stays in
  `browser_vimma_insert_scroll.js` (`i_focuses_the_first_input_and_enters_insert`).
- Behaviour 4: `an_autofocused_login_form_opens_in_insert_and_enter_keeps_it`,
  `a_page_moving_focus_from_a_field_to_a_button_leaves_insert`, and the focus cases of
  `browser_vimma_insert_scroll.js`.

The behaviour 1 and 3 tests failed before the change (the page lost `t` and `j`, `t` opened a tab,
`i` focused `#first`); the behaviour 2 and 4 tests guard what already held.

## Docs and changelog

- `docs/guide.md`, "Normal and insert mode" and the key table's `i` row: `i` returns to the last
  field; insert from `i` or `gi` lasts until `Esc`.
- `docs/security/13-page-modes.md`: a section for page modes, rules K1 to K3.
- `CHANGELOG.md`: a Fixed line, added by the maintainer at merge time.

## Delivery

One pull request, closing #165.

## Follow-up: Esc holds against the page

Two cases let `Esc` fail to leave insert ([#298](https://github.com/vimma-browser/vimma/issues/298)),
both against the principle that `Esc` always gets the user out
([m1-core-logic](m1-core-logic.md), "As a user, `Esc` always does the one obvious thing").

### Problem

- **A page that puts focus back.** A modal dialog that traps focus refocuses its field when
  focus leaves the dialog, a task after the blur. `Esc` set normal mode and blurred the field;
  the page focused it again, and that focus report entered focus insert (behaviour 4). Every
  `Esc` repeated this, so the user could not reach normal mode, and because `Esc` in insert is
  Vimma's, the page never saw an `Esc` and its dialog never closed.
- **A late report from a frame.** `Tab` from a field into a cross-origin frame's field, then
  `Esc` at once: the frame's focus report for the `Tab` reached the parent after the `Esc`, and
  entered insert again. Until the blur's own report followed, the next key went to the page; when
  the blur had gone to the other document, nothing followed and the tab stayed in insert.

### Behaviour

6. **After `Esc`, the page cannot put the tab back in insert by itself.** While the top document
   on which `Esc` left insert is shown, a focus the page's script makes on its own (a focus trap,
   a timer, a field focused after a network reply) leaves the tab in normal mode, even when it
   lands in a text field. The user's next action on the page ends this: a click anywhere in it
   (also into the field the page already focused, or on an element that takes no focus), `Tab`
   or any other key the page gets, `i`, `gi`, a hint on a field. A new top document ends it too. A second `Esc`, in normal mode, reaches the page first
   ([firefox-keys](firefox-keys.md) decision 6), so a dialog that closes on `Esc` closes.
   (Since changed: when the page leaves that `Esc` alone, Vimma also blurs the page's focused
   element and holds the tab in normal as after the first `Esc`; [m1-core-logic](m1-core-logic.md),
   § Esc.)
7. **A report sent before `Esc` does not undo it.** A focus report that a document sent before
   the `Esc`'s blur reached it, or that a frame sent for focus the user moved before the `Esc`
   (a `Tab` into a cross-origin frame), does not enter insert after that `Esc`.

### Research

- **Firefox.** `nsIDOMWindowUtils.isHandlingUserInput` "Returns true if a user input is being
  handled" (`dom/interfaces/base/nsIDOMWindowUtils.idl:1766-1770`, Firefox 158.0); the child
  already uses it to tell the finder's focus from the user's ([m1-find](m1-find.md), #164). A
  page's script that focuses from a timer or from its `focusout` handler runs outside any input
  event, and so does the focus that Vimma's `Vimma:Blur` causes, since it arrives as an IPC
  message.
- **Firefox.** `Tab` into an out-of-process frame does not run in the frame's process as input:
  the embedding document's process asks the parent (`PBrowserBridge` `NavigateByKey`,
  `dom/ipc/PBrowserBridge.ipdl:107`), which sends the frame's process `NavigateByKey`
  (`dom/ipc/BrowserParent.cpp:3802-3803`), and the frame focuses its first field from that
  message. In a mochitest on Firefox 158.0 the frame's focus report for that `Tab` had
  `isHandlingUserInput` false, and it reached the parent after an `Esc` sent right after the
  `Tab` (`esc_right_after_tab_into_a_cross_origin_frame_stays_in_normal`, which failed 8 of 8
  runs before this change).
- **Firefox.** Messages from one content process to the parent arrive in the order sent, and a
  `JSWindowActor` message to a frame arrives after the input events the parent forwarded to that
  process before it. So a report that a document sent before it handled `Vimma:Blur` reaches the
  parent before that blur's own reports, and possibly after the `Esc`.
- **Firefox.** `Node.flattenedTreeParentNode` is chrome-only (`dom/webidl/Node.webidl:111-112`)
  and walks the flattened tree, so it reaches a text field from the anonymous editor a click
  inside the field lands on, which `Node.contains` does not.

### Design

- **The hold.** `mode.normal` (Esc) records, per tab `<browser>`, the top document's
  `innerWindowId` (`escapeHold`). While it matches, `onFocusReport` drops a `focusin` report
  that is not the user's. A report is the user's when the child sends it while
  `isHandlingUserInput` is true or while it is focusing for a Vimma key (`i`, `gi`, a hint), and
  says so in its `user` field. Such a report ends the hold, as does any keydown the host lets
  through to the page in that tab (not consumed), entering insert (`setBrowserMode`), and a new
  top document. `recheck` reports are not dropped; they can only give normal after `Esc`.
- **A click on the focused field.** The child's `mousedown` handler reports `focusin` for the
  focused element when it is editable and the click is inside it (in the flattened tree), since
  a click on a field that already has focus fires no focus event and would otherwise leave the
  user in normal mode with no way to start typing by clicking.
- **Any other click.** For every other trusted `mousedown`, the child sends `Vimma:Click`, which
  carries no data and is taken only from the focused frame (as `Vimma:Focus` is); the host ends
  the hold. A click on an element that takes no focus (a toolbar item that prevents its
  `mousedown`, a `div` with a click handler) sends no focus report of its own, and a field the
  page focuses after it, from a timer or a network reply, is the user's doing.
- **Blur generations.** Each `Esc` blur carries a generation (`Vimma:Blur { gen }`, counted per
  tab, so that a content process cannot count the `Esc` presses of other tabs). The child keeps the last one it handled and sends it in every report. The host
  keeps, per tab, the document the blur went to (its `innerWindowId`) and the generation, and
  drops a report from that document with an older one.

### Decisions

7. **After `Esc`, only the user's focus enters insert,** because a page that answers a blur by
   focusing again is not the user asking to type, and following it made `Esc` useless there. A
   page that focuses a field because the user acted (a click, a key it handles, `Tab`) still
   enters insert, so ordinary sites behave as before. Rejected: ignoring every focus after `Esc`
   until `i`, because a user who clicks a field or tabs into one expects to type there, and
   because a page's own search shortcut (a key Vimma has no binding for) would no longer type.
   Rejected: limiting the hold to a time window after `Esc`, because a focus trap refocuses
   whenever focus leaves, at any time, and a window would only move the failure.
8. **A key the page gets ends the hold, in the parent,** because a frame in another process
   handles `Tab` from an IPC message, not as input, so its report cannot say it was the user's;
   the host sees every key before the page and knows that the user acted. Keys Vimma consumes
   (`j`, a count, `Esc` in insert) do not end it on their keydown. Their `keyup` still reaches the
   page as user input (Firefox treats a `keyup` other than `Esc` as such), so a page that focuses
   a field on `keyup` ends the hold: that focus answers the user's key, which is the rule.
9. **A click on the field the page focused enters insert,** because after behaviour 6 that field
   can hold focus in normal mode, and clicking a field is the plainest way to say "type here".
10. **Reports carry the blur generation they have seen,** because the parent cannot otherwise
    tell a report sent before the blur from one sent after it: both come from the same frame
    and the same document. The document's `innerWindowId` scopes the generation, so a frame
    that loads a new document (whose actor starts at 0) is not taken as stale. Rejected:
    ignoring every report until the blur's answer comes back, because a blur sent to a document
    that no longer has focus has no report to wait for, and a timeout would drop the user's
    real next focus.
11. **The second `Esc` is the page's,** because in normal mode `Esc` reaches the page first
    (firefox-keys decision 6): with the hold, a focus-trapping dialog behaves like any other, and
    the user closes it with `Esc` `Esc`. Rejected: passing the first `Esc` in insert to the page
    as well, because a page that handles `Esc` in its field (an autocomplete list) would then
    see it and Vimma would also leave insert, doing two things for one key.

### Security and privacy

The new report fields (`user`, `gen`) come from a content process, which may be compromised. A
forged `user: true` or a high `gen` lets a report do what any report could before this change
(enter insert in its own tab, K1); they can only narrow what a report does after `Esc`. `Vimma:Click`
carries no data and only ends the hold, which a forged `user: true` could do as well. A page
cannot set the hold, and ends it only by focusing while it handles the user's input. Rule K4 in
[docs/security/13-page-modes.md](../security/13-page-modes.md) holds behaviour 6 with tests.

### Tests

`tests/browser/browser_vimma_insert_focus.js`, fixtures `file_vimma_insert_trap.html` (a modal
`<dialog>` whose script refocuses its field when focus leaves the dialog; `Esc` closes it) and
`file_vimma_insert_tab_frame.html` (a field, then a cross-origin frame with a field):

- Behaviour 6: `after_esc_a_page_refocusing_its_field_stays_in_normal` (`j` is Vimma's, the second
  `Esc` closes the dialog), `after_esc_on_a_trapping_page_i_click_and_tab_enter_insert`,
  `after_esc_tab_into_a_cross_origin_frame_enters_insert` (a scripted focus stays normal, `Tab`
  into the frame enters insert), `a_page_focusing_a_field_after_a_click_on_no_control_enters_insert`,
  and `a_page_focusing_a_field_after_a_click_enters_insert` (guards what held).
- Behaviour 7: `esc_right_after_tab_into_a_cross_origin_frame_stays_in_normal` (the tab's mode
  changes only once after `Esc`).

All but the guard failed before the change; under CPU load (two CPUs, four busy loops) the tests
failed 8 of 8 runs before and passed 12 of 12 after.

### Docs and changelog

- `docs/guide.md`, "Normal and insert mode": a page cannot pull the tab back into insert after
  `Esc`; a dialog that keeps focus closes with a second `Esc`.
- `docs/security/13-page-modes.md`: rule K4.
- `CHANGELOG.md`: a Fixed line, added by the maintainer at merge time.

## Follow-up: a key right after Esc

`Tab` pressed right after `Esc` sometimes lost its focus
([#850](https://github.com/vimma-browser/vimma/issues/850)): the button it focused was blurred at
once, and nothing in the page had focus. `esc_in_normal_mode_blurs_what_tab_focused` failed this
way in CI, and 3 of 10 runs under CPU load on Firefox 160.0.

### Problem

`Esc` in insert is Vimma's: the parent sets normal mode and sends `Vimma:Blur` to the focused
frame, and the page never sees the `Esc`. A key the user presses next goes to the page as input.
When the page's process is busy, both wait there, and the process handles the key first: `Tab`
moves focus to the next element, then the late blur takes that focus away. A user on a busy page
who presses `Esc` then `Tab` sees no focus at all.

### Behaviour

8. **A key after `Esc` keeps the focus it gave.** In a page of a content process, a key the user
   presses after `Esc` in insert, and that the page gets, keeps its effect on focus even when the
   page handles it before `Esc`'s blur arrives: the element it focused stays focused, and its
   focus decides the mode by the usual rules (behaviours 4 and 6). A key pressed before `Esc`
   does not: the blur takes the focus it gave, as before. Keys that move focus away and back
   (`Tab`, then `shift+Tab`) leave it where it was, and the blur takes it. `Esc` in normal mode
   blurs once the page has had it ([m1-core-logic](m1-core-logic.md), § Esc), after the keys
   typed meanwhile, which it still blurs as before.

### Research

- **Firefox.** A key event for a remote page is sent with input priority (`[Priority=input]
async RealKeyEvent`, `dom/ipc/PBrowser.ipdl:782-783`, Firefox 160.0, chosen by
  `BrowserParent::SendRealKeyEvent` when input priority is on, `dom/ipc/BrowserParent.cpp:2107-2111`),
  and a `JSWindowActor` message with normal priority. The content process usually runs input
  tasks first (not always: `xpcom/threads/InputTaskManager.cpp:61-79` puts input below normal
  tasks while the refresh driver waits for its next tick), so a key the parent sends after a
  message can run before it. In a mochitest on Firefox 160.0, a page busy for half a second
  when `Esc` and `Tab` arrived handled the `Tab` before `Vimma:Blur` every time
  (`tab_right_after_esc_on_a_busy_page_keeps_its_focus`).
- **Firefox.** `Esc` that Vimma consumes in the parent (`preventDefault` from chrome) is not sent
  to the page at all (`WidgetEvent::PreventDefault` calls `StopCrossProcessForwarding`,
  `widget/BasicEvents.h:196-211`), so the page cannot tell where the `Esc` was among its keys.
- **Firefox.** A page of the parent process (the start page, `about:` pages such as
  about:preferences) gets its keys in the same process, between chrome's capture and bubble
  listeners, and native handlers there (a `<select>`'s arrow keys) prevent them as chrome would,
  so the parent cannot count them as a remote page gets them.

### Design

- **The parent counts the keys it lets through.** In the system group's bubble, after every
  chrome handler, a keydown that chrome did not prevent goes on to the focused remote
  `<browser>`. The host counts it for the focused frame's document (`VimmaActors.keySent`, per
  `WindowGlobalParent`). `Vimma:Blur` carries that count (`keys`) and starts it again. A document
  of the parent process gets no count and no `keys`.
- **The page counts the keys it gets.** The child listens to trusted `keydown` in the capture
  phase, outside the page, without creating the actor. It counts them since its last blur, and
  keeps for the last 16 the element that had focus when each arrived.
- **The blur compares.** The keys beyond the blur's `keys` came after it was asked for. If there
  is one and the focus has changed since the first of them arrived, the child does not blur; it
  sends a `focusin` report for the focused element with the blur's generation, so the mode follows
  the focus that key gave. Otherwise, or with no `keys`, it blurs as before. Either way it starts
  its count again from nothing.

### Decisions

12. **Keys are counted on both sides,** because the page never sees the `Esc` that Vimma took,
    and only the parent knows which of the page's keys came before it. Rejected: blurring only
    the element focused when the `Esc` arrived, because that `Esc` never arrives. Rejected:
    blurring only the element the parent last heard of, because a `Tab` just before `Esc`, whose
    report is still on its way, would then keep its focus in normal mode. Rejected: holding the
    keys typed after `Esc` until the blur is done and pressing them again, because a replayed key
    must carry its modifiers, composition and `keyup` as the user typed them. Rejected: waiting in
    the test for the blur before pressing `Tab`, because a user on a busy page meets the same
    race.
13. **Every count error must make the parent's count the larger,** because then the blur only
    falls back to what it did before this change (a lost `Tab` focus), while a larger count in the
    page would keep a field focused in normal mode after a plain `Tab` then `Esc`. So the page
    starts its count from nothing at every blur, and a page of the parent process, whose keys
    the parent cannot count as the page gets them, gets no count. The parent counts more for a
    key Firefox reserves (`ctrl+t`), which chrome does not prevent but never passes on, and when
    keys go to another frame than the one the blur goes to. The page can count more for at most
    the next blur when the parent's focused frame is behind the page's (focus moved between
    frames of one process, a navigation about to commit).
14. **Only `Esc` in insert,** because in normal mode `Esc` reaches the page first and the blur
    is asked for when the page's answer comes back, after the keys typed meanwhile have been
    counted as before it. Those still lose their focus to a late blur, as before this change.

### Security and privacy

The child keeps no key, only a count and up to 16 weak references to elements of its own
document, until its next blur. It counts trusted keydowns only, from a listener outside the page,
so a page can neither add to the count nor hide a key from it; by moving focus between its own
frames it can at most make a frame count more for one blur, which keeps the focus that frame has
in normal mode. The `keys` field goes from the parent to the child; a compromised content process
could skip any blur already, so the field gives it nothing. A kept focus decides the mode through
an ordinary focus report under rules K1 and K4 in
[docs/security/13-page-modes.md](../security/13-page-modes.md): a page's own
focus after `Esc` stays in normal unless a key the page got ended the hold, as before.

### Tests

`tests/browser/browser_vimma_insert_focus.js`, with the page's process kept busy for half a second
so that the keys and the blur wait there together:

- `tab_right_after_esc_on_a_busy_page_keeps_its_focus` (failed every run before the change),
- `tab_right_before_esc_on_a_busy_page_is_blurred` and
  `a_key_right_after_esc_on_a_busy_page_still_blurs` (guards: a key before `Esc`, and a key after
  it that moves no focus). The first checks only a run in which the page had the `Tab` before the
  blur.

### Docs and changelog

- `docs/security/13-page-modes.md`: rule K4 names the three tests.
- `CHANGELOG.md`: a Fixed line, added by the maintainer at merge time.

## Open questions

None.
