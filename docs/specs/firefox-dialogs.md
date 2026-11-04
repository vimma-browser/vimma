# Spec: firefox-dialogs

Status: implemented · Area: core (`packages/vimma-core/src/prompt-keys.mjs`), host
(`host/dialog-keys.mjs`, `host/prompt-keys.mjs`) · Upstream patches: none · ADR: none

## Summary

Firefox's dialogs over a page or over the window ("This page is asking you to confirm that you
want to leave", a page's `alert`, `confirm` and `prompt`, a sign-in, Firefox's own yes-or-no
questions) are answered from the keyboard as Vimma's other browser questions are: `y` runs the
dialog's main button and `n` the button `Esc` runs, the safe choice. A line inside the dialog
names the keys, after its own buttons, once they count.

## Problem

Vimma answers Firefox's permission prompts (`docs/specs/toolbar-toggle.md` decision 11a) and its
pop-up blocked bar (`docs/specs/popup-blocked.md`) with `y` and `n`, and names the keys inside
each. Firefox's dialogs had only Firefox's own keys (`Enter` for the default button, `Esc` for
cancel, `Tab` between buttons) and nothing that named them. The leave-page dialog is the sharpest
case: Firefox makes "Leave page" its default button, so `Enter` loses unsaved changes, and
nothing in the dialog says which key keeps them.

## Behaviour

1. While one of Firefox's dialogs built on `commonDialog.xhtml` is open over a tab or over the
   window, `y` must press its main button (Leave page, OK, Yes) and `n` its cancel button (Stay
   on page, Cancel, No), the one `Esc` already presses.
2. The keys have the permission prompt's guards: they count only once the dialog has been up for
   `security.notification_enable_delay` (500 ms by default) with no key typed in it in between,
   and any key typed in it restarts the wait; a held key never answers. A key that does not yet
   count is swallowed, so it reaches neither the dialog nor Vimma's bindings.
3. In the dialog's own text fields (a page's `prompt`, a sign-in's user name and password) `y`
   and `n` are text. A dialog without a cancel button (an `alert`) leaves `n` alone.
4. `Esc`, `Enter`, `Tab` and the dialog's other buttons (the PDF viewer's "Don't save") stay
   Firefox's.
5. A line at the foot of the dialog's text names the keys after its buttons, lower case, such as
   `y leave page · n stay on page`, `y ok · n cancel` or `y ok`; a dialog with a text field says
   `Enter ok · Esc cancel`. It shows once the keys count and is hidden, keeping its place, while
   they wait. It is hidden from accessibility, because the buttons stay the dialog's labels. It
   is drawn in the command line's hint look (Vimma's monospace font, the theme's dim text) and
   follows the theme.

## Research

Checked against Firefox 159.0.1 (`surfer.json`), in `engine/`:

- The leave-page dialog is `PromptCollection.asyncBeforeUnloadCheck`
  (`browser/components/prompts/PromptCollection.sys.mjs:71`): a `confirmEx` with "Leave page" as
  button 0 and "Stay on page" as button 1, and `BUTTON_POS_0_DEFAULT`, so `Enter` leaves. The PDF
  viewer's variant adds "Don't save" as button 2; the new-profile page's has its own labels.
- Content prompts open in the tab's `TabDialogBox` (`browser/actors/PromptParent.sys.mjs:222`),
  and window prompts in the window's `gDialogBox` (`toolkit/components/prompts/src/
Prompter.sys.mjs:1244`). Both are `commonDialog.xhtml` in a `SubDialog` frame of the browser
  window.
- `commonDialog.js` builds the dialog on its document's `DOMContentLoaded` (line 183): the main
  button is `getButton("accept")` and the cancel button `getButton("cancel")` (lines 101-102),
  labelled before the first `await` in `CommonDialog.onLoad`. `SubDialog` listens for
  `DOMFrameContentLoaded` and `keydown` on the browser window in the capture phase
  (`toolkit/modules/SubDialog.sys.mjs:819`, `830`): both reach the window from inside the
  dialog's frame, after the dialog's own `DOMContentLoaded` and before `SubDialog` measures the
  frame on `load`.
- `CommonDialog` disables the buttons for a while when asked to (`enableDelay`,
  `CommonDialog.sys.mjs:204`); a click on a disabled button does nothing.
- Other dialogs are not `commonDialog.xhtml` and are outside this spec (Design 6): the external
  protocol question (`toolkit/mozapps/handling/permissionDialog.xhtml`, opened by
  `ContentDispatchChooser.sys.mjs`) and the download question
  (`toolkit/mozapps/downloads/unknownContentType.xhtml`, a window of its own,
  `HelperAppDlg.sys.mjs:176`).

## Design

`packages/vimma-core/src/prompt-keys.mjs` gains `dialogKey` and `dialogHint` beside the
permission prompt's and the pop-up bar's. `host/dialog-keys.mjs` (`DialogKeys`) adds the keys
line when a dialog frame loads in the window, keeps each dialog's arming clock and answers its
keys; `PromptKeys` (`host/prompt-keys.mjs`), which VimmaHost already hands every keydown first,
hands it a key typed in one of the window's dialogs. No upstream file changes.

1. **One scheme for every question Vimma or Firefox asks: `y` for the action, `n` and `Esc` for
   the safe choice, and the keys named inside the question, because a key that answers one kind
   of question should answer every kind.** The audit below lists each question and how it
   follows the scheme.
2. **`n` stays on the page, because it is the answer that loses nothing.** `n` presses the
   button Firefox gives `Esc`, which in every dialog Firefox builds is the one that changes
   nothing (Stay on page, Cancel, No); a page left by mistake is one key away, unsaved changes
   left behind are gone. `y` presses the main button, as it does in a permission prompt. Firefox's
   `Enter` (Leave page) is left as Firefox has it, because remapping a key Firefox users already
   know would surprise them more than it protects them; the line names `y` and `n`, not `Enter`.
3. **The permission prompt's guards, because a dialog can open under a typing hand.** A page
   can call `confirm` or navigate away at any moment, and `n` and `y` are common letters, so the
   keys wait for `security.notification_enable_delay` from when the dialog opened or the last key
   typed in it, whichever is later. The wait is the permission prompt's pref, not
   `security.dialog_enable_delay` (1 s), because these are the same keys with the same risk and a
   different wait for each would be harder to learn.
4. **Text fields keep their letters; the line names `Enter` and `Esc` there, because a `y` or an
   `n` in a field is text and the dialog's own keys are what answers it.**
5. **The line follows the theme without the window's sheets, because the dialog's document
   takes none of them and its CSP refuses a `<style>`.** The line's look is set through its
   `style` (CSSOM, which the CSP allows) from the theme's tokens, which `theme-host.mjs` gives the
   dialog's document, with `monospace` and `GrayText` as fallbacks. It is inserted when the frame
   loads, before `SubDialog` measures it, so the dialog opens at its final size, and it keeps its
   place while hidden so the dialog does not change size under the reader.
6. **Questions that are not `commonDialog.xhtml` are left as Firefox has them, because each is
   built differently and needs its own change.** The external protocol question and the download
   question keep `Enter`, `Esc` and `Tab`.

### Audit of questions

| Question                                                        | Keys                                    | Named inside                           |
| --------------------------------------------------------------- | --------------------------------------- | -------------------------------------- |
| Leave page (beforeunload), a page's `alert` and `confirm`       | `y`, `n` (this spec), `Esc`, `Enter`    | yes (this spec)                        |
| A page's `prompt`, HTTP sign-in                                 | `Enter`, `Esc` (text field)             | yes, `Enter ok · Esc cancel`           |
| Firefox's yes-or-no questions over the window (caret browsing)  | `y`, `n` (this spec), `Esc`, `Enter`    | yes (this spec)                        |
| Permission prompts, Save password, add-on install (doorhangers) | `y`, `n`, `Tab`, `Esc` (toolbar-toggle) | yes, `y allow · n block · Tab buttons` |
| Pop-up blocked bar                                              | `y`, `n`, `Esc` (popup-blocked)         | yes, beside its button                 |
| Agent question line                                             | `y`, `n`, `Esc`, `Enter`, `a`, `x`      | yes (vimma-mcp decision 13)            |
| Vimma's `y/N` questions (restart, update, close a workspace)    | `y`; any other key, `Esc` included, no  | yes, `(y/N)` in the question           |
| Site permissions picker (`:site`)                               | picker keys (`j`, `k`, `Enter`, `Esc`)  | yes, picker hint                       |
| External protocol question, download question                   | `Enter`, `Esc`, `Tab` (Firefox's)       | no (Design 6)                          |

The agent question keeps `a` (always for this site) and `x` (mute), because they answer
questions a yes or a no cannot; Vimma's `y/N` questions keep their Vim-style `(y/N)` suffix,
because it names the default and every key but `y` is already the safe answer.

## Security and privacy

The keys only press a button the user could press with `Enter`, `Esc` or the mouse, behind the
permission prompt's arming delay, so a page cannot time a keypress into an answer. They are
chrome-only: no control command or MCP tool reaches them. The line is inserted as text, never
markup; its text comes from Firefox's own button labels.

## Tests

- Vitest, `packages/vimma-core/test/prompt-keys.test.mjs`: `dialogKey` accepts and cancels only
  once armed and not on a held key; text fields, a key sequence and other keys pass; an alert
  leaves `n` alone. `dialogHint` with two buttons, one, and a text field.
- Mochitest, `tests/browser/browser_vimma_dialog_keys.js`: the leave-page dialog's line waits
  and then names `y leave page · n stay on page`; `n` keeps the tab, `y` before the dialog is
  armed and after a key typed through it does nothing, and an armed `y` closes the tab; a page's
  `confirm` returns true for `y` and false for `n`; an alert names only `y`; a `prompt` names
  `Enter` and `Esc` and takes `y` and `n` as text; a window dialog answers both keys.

## Docs and changelog

`docs/guide.md`, "Answering a dialog". Changelog: dialogs such as "Leave page?" answer to `y`
and `n` and name the keys.

## Delivery

One pull request.
