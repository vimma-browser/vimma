# Spec: webauthn-prompts

Status: implemented · Area: core (`packages/vimma-core/src/keys/prompt-keys.mjs`), host
(`host/prompt-keys.mjs`) · Upstream patches: none · ADR: none

Issue: [#1544](https://github.com/vimma-browser/vimma/issues/1544)

## Summary

Firefox asks about passkeys and security keys (WebAuthn) in prompts that hang from the address
bar: "touch your security key", the list of passkeys to sign in with, the question whether a site
may see the key's make and model, and notices when something is wrong. Vimma's `y` and `n` reached
these prompts as they reach every prompt in that panel, but pressed the wrong buttons: these
prompts make Cancel their main button, so `y` cancelled and `n` did nothing. Now `n` presses the
button `Esc` runs (Cancel) and `y` the answer that goes ahead, the keys line names exactly those
keys, and a prompt with several passkeys names the way into its list.

## Problem

[toolbar-toggle](toolbar-toggle.md) decision 11a gives every prompt in Firefox's doorhanger panel
`y` for the main button and `n` for the secondary one, because a permission prompt's main button
is Allow and its secondary one Block, the button `Esc` runs. Firefox's WebAuthn prompts break that
assumption (Research): their main button is Cancel. Before this change:

- "Touch your security key" read `y cancel · Tab buttons`: `y` cancelled, `n` was swallowed.
- Choosing a passkey read `y cancel · n <first passkey> · Tab buttons`: `y` cancelled and `n`
  signed in, the opposite of every other prompt.
- The notices (no device, PIN not set, too many tries) read `y cancel`, and `n` did nothing.
- The other passkeys, in the list behind the first passkey's button, had no mention.

## Behaviour

1. In a WebAuthn prompt whose `Esc` runs its main button (`escAction: "buttoncommand"`), `n`
   must press the main button (Cancel) and `y` the secondary one, when it shows. A prompt
   without a secondary button gives `y` no button: `y` is swallowed while the prompt is open,
   as `n` already is in a permission prompt without one.
2. In a WebAuthn prompt that shows Cancel alone with Firefox's default `Esc` (the notices), `n`
   must press Cancel and `y` must press nothing.
3. Every other prompt keeps decision 11a: `y` the main button, `n` the secondary one. The
   WebAuthn prompts with two answers (the attestation question, Allow and Block; a related
   site's passkey, Continue and Cancel) are among them, since their main button goes ahead.
4. The keys line names the buttons `y` and `n` press, and leaves out a key with no button:
   `n cancel · Tab buttons`, `y <passkey> · n cancel · Tab buttons`.
5. When `y`'s button carries a list of more answers (the other passkeys, behind the button's
   dropmarker), the line ends in `Tab, ↓ more` instead of `Tab buttons`. `Tab` moves focus onto
   that button (it comes first in the prompt), and Firefox's own keys do the rest: `↓` opens the
   list, the arrow keys move through it and `Enter` chooses.
6. Every guard of decision 11a still applies: the arming delay, never from a field, never during
   a key sequence or in a mode that keeps the keys.
7. The PIN entry is a tab dialog with a password field, which
   [firefox-dialogs](firefox-dialogs.md) already answers: every key is the PIN's, `y` and `n`
   included, and the line names `Enter` and `Esc`.
8. The prompts and the passkey list follow the theme through the rules every doorhanger and
   menu already takes (`panel[type="arrow"]` in `firefox-toolbar.css`, `menupopup` in
   `firefox-chrome.css`); nothing in them is specific to WebAuthn.

## Research

Checked against Firefox 161.0 (`surfer.json`, the engine tree `engine/`).

- Every WebAuthn prompt but the PIN entry is a `PopupNotifications.show` with a popupid starting
  `webauthn-prompt-` (`engine/toolkit/modules/WebAuthnPromptHelper.sys.mjs`, `show_formatted_msg`;
  `engine/dom/webauthn/WebAuthnRelatedOriginFetcher.sys.mjs` for
  `webauthn-prompt-related-origin-request`). The prompts are:
  - `presence` ("Touch your security key"): Cancel as main action, no secondary, `escAction:
"buttoncommand"`.
  - `select-sign-result` (choose a passkey): Cancel as main action, one secondary action per
    passkey, `escAction: "buttoncommand"`.
  - `register-direct` (attestation): Allow as main action, Block as secondary, default `Esc`.
  - `alreadyRegistered`, `selectDevice`, `pinAuthBlocked`, `uvBlocked`, `deviceBlocked`,
    `pinNotSet`, `uvInvalid` (`show_info`, and the uv-invalid branch of `observe`): Cancel as main
    action, no secondary, default `Esc`.
  - `related-origin-request`: Continue as main action, Cancel as secondary, default `Esc`.
- The PIN entry (`pin-required`, `pin-invalid`) is `Services.prompt.promptPasswordBC` with
  `MODAL_TYPE_TAB` (`prompt_for_password`): a commonDialog over the tab.
- `PopupNotifications.show` makes `secondarybuttoncommand` the default `escAction`
  (`engine/toolkit/modules/PopupNotifications.sys.mjs`, `show`). With no secondary action, `Esc`
  then runs no callback and only removes the prompt (`_onButtonEvent`), so a notice's request
  stays open until the site's timeout; its Cancel button ends it.
  `escAction: "buttoncommand"` is used by the WebAuthn prompts alone in the front end (a search
  of `browser/` and `toolkit/`).
- With two or more secondary actions, the first is the secondary button and the others are
  menuitems in the button's list, and the prompt loses `dropmarkerhidden`
  (`PopupNotifications._refreshPanel`). The secondary button comes first in the footer
  (`toolkit/content/widgets/popupnotification.js`, `markup`); `↓` on it opens the list
  (its `keydown` listener).
- Only Firefox's authenticator-rs code sends `webauthn-prompt`
  (`engine/dom/webauthn/authrs_bridge/src/lib.rs`). On macOS, the platform API
  (`MacOSWebAuthnService.mm`) draws the system's own windows instead, and only with the
  `com.apple.developer.web-browser.public-key-credential` entitlement, which Vimma's macOS build
  does not have (issue #544); without it Firefox falls back to authenticator-rs and these
  prompts. Neither path draws a QR code in Firefox's chrome: a QR code for a phone comes from the
  operating system or from the site's own page.

- In a build, the prompts' panel and the passkey list's surface take the theme's colours, in the
  built-in theme and in an Omarchy theme (computed `--panel-background-color` and the list's
  `content` part), and the list's active row is the theme's selection.

## Design

`doorhangerButtons` (`core/prompt-keys.mjs`) takes the prompt's popupid, its `escAction` and
whether its secondary button shows, and returns which button `y` and `n` press. `PromptKeys`
(`host/prompt-keys.mjs`) asks it for both the click and the keys line; `doorhangerHint` leaves
out a key with no button and takes `more` for the list.

1. **`n` is the button `Esc` runs.** It is the safe answer in every Firefox prompt and dialog
   Vimma answers ([firefox-dialogs](firefox-dialogs.md)), so the rule keeps one meaning for `n`
   across them; `y` is then the other answer, the one that goes ahead.
   Rejected: keeping `y` as the main button, because it made `y` cancel a sign-in.
2. **Keyed on `escAction`, then on the popupid.** `escAction` states which button `Esc` runs,
   so a prompt that sets it is read from Firefox's own data. The notices leave it at the default
   while showing Cancel alone, so they are recognised by the `webauthn-prompt-` prefix, which
   every WebAuthn prompt carries, and by their missing secondary button.
   Rejected: a list of the WebAuthn popupids, because Firefox adds notices over time and a
   prefix reaches a new one.
3. **`n` presses Cancel in a notice, not Firefox's `Esc`.** `Esc` only hides a notice and leaves
   the site's request waiting (Research), so `n` ends it as the button the notice shows does.
4. **The list stays Firefox's.** `Tab` and `↓` reach it with Firefox's own menu keys, so the
   other passkeys need no second list drawn by Vimma; the line says how to reach it.
   Rejected: digits for the passkeys, because the list's names are not visible until it opens,
   and a number would pick a passkey the user cannot see.
5. **No theme rules of its own.** The prompts are doorhangers and their list a `menupopup`, both
   of which already take the theme's tokens, so a WebAuthn rule would only duplicate them.

## Security and privacy

`y` and `n` still click the prompt's own buttons after Firefox's delay, with Firefox's check in
`_onButtonEvent` on top; no button is pressed that a mouse click could not press. The change
makes `y` the answer that signs in or registers, so the guards of decision 11a matter for it as
they do for Allow: a page raising a WebAuthn prompt while the user types never gets `y` from that
typing. `docs/security/` describes the prompt keys' guards; they are unchanged.

## Tests

- vitest, `packages/vimma-core/test/prompt-keys.test.ts`: `doorhangerButtons` (permission
  prompts, prompts whose `Esc` runs the main button, notices with Cancel alone, WebAuthn prompts
  with two answers) and `doorhangerHint` without a `y` button and with `more`.
- mochitest, `tests/browser/browser_vimma_webauthn_prompts.js`, with Firefox's virtual
  authenticator (`nsIWebAuthnService.addVirtualAuthenticator`) or, for "touch your security key",
  USB tokens on and none plugged in; the notices and the PIN entry are raised through Firefox's own
  `webauthn-prompt` observer with a transaction id that is not live, because the virtual
  authenticator turns down an excluded passkey without a notice that stays up: `touch_your_key_answers_n_and_not_y`,
  `choosing_a_passkey_from_the_keyboard`, `the_passkey_notices_cancel_with_n`,
  `the_attestation_question_answers_y_and_n`, `the_pin_entry_keeps_its_letters`.

## Docs and changelog

`docs/guide.md`: "Passkeys and security keys" under "Answering a permission prompt". The
changelog line comes from the commit.

## Delivery

One pull request.

## Open questions

None.
