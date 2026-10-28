# Spec: update-notices

Status: implemented · Area: `packages/vimma-core/src/update-notices.mjs` (new),
`updates/VimmaUpdates.sys.mjs`, `host/update-ui.mjs` (new), `host/VimmaHost.sys.mjs`,
`ui/agent-prompt.mjs`, `ui/notice.mjs`, `jar.mn` · Upstream patches: none · ADR: none

Issue: [#336](https://github.com/vimma-browser/vimma/issues/336)

Engine paths are relative to `engine/` and were checked against Firefox 158.0
(`config/milestone.txt`).

## Summary

An offered update reaches the user without a modal window and without taking focus or keys. A
start checks a few seconds after the first window is ready when a check is due; the first time a
version is offered, a short message names it and `:update`; a security update also asks once per
session, `Vimma 0.1.3 fixes security issues. Show the update command? (y/N)`. The status bar's
update segment (spec [m6a-updater](m6a-updater.md) §5) stays the lasting reminder.

## Problem

- The status-bar segment `⇡ 0.1.3 available` is easy to miss: it appears without anything
  drawing the eye to it, and it looks the same on the first day and the tenth.
- A security release is shown in the error colour, but nothing asks the user to act on it.
- A check due at startup ran 30 seconds after the update module loaded, and a failed attempt
  counted as a check: a start while offline put the next attempt 12 hours away.

## Behaviour

1. **Startup check.** When the last check that got a verified answer is older than
   `app.update.interval` (43200 s, 12 hours), or there has been none, Vimma checks 5 seconds
   after the first window's delayed startup. A check that got no answer (host unreachable) does
   not count, but no attempt follows within 10 minutes of the last one, except on `:update`.
2. **One-time message.** The first time an offer for a version is seen, the focused browser
   window shows `Vimma 0.1.3 is available · :update shows the command` for 6 seconds in the
   notice area above the status bar; for a security release
   `Vimma 0.1.3 fixes security issues · :update shows the command`. It never takes focus. It is shown once per version, across
   restarts (the pref `vimma.update.announced`); a newer version is announced again. With no
   browser window focused, or a page in DOM full screen, it waits.
3. **Security question.** An offer with `vimmaUrgency="security"` asks, once per session and
   version, `Vimma 0.1.3 fixes security issues. Show the update command? (y/N)` on a line at
   the window's foot, in `--vimma-text-error`.
   - `y` opens about:vimma's Updates section, what `:update` opens. `n`, Esc, Enter and any
     other key dismiss it for the session. Chords with ctrl, alt or meta, and the rest of a
     `ctrl+b` sequence, go to the bindings as usual.
   - It opens by itself only in a focused normal (non-private) window, out of insert mode, after
     1,500 ms without a key, with no picker, prompt, panel, command line, agent question or
     Firefox permission prompt open,
     and not over a page in DOM full screen. Otherwise it waits.
   - It never takes focus. Focus moving into a field, or a picker or prompt opening over it,
     closes it back to waiting.
   - When it opens, the message is hidden, since the question says the same and the two would
     overlap at the window's foot.
   - Keys count only once it is armed, `security.dialog_enable_delay` (1,000 ms) after it
     appears or after its window comes to the front or leaves it. A key before that is ignored
     and starts the delay again; a held key never answers.
4. **Off.** With `[updates] check = false`, `vimma.update.enabled` = `false`, or in a build run
   from its objdir, there is no startup check, no message and no question.

## Research

- **When the first window is ready.** `gBrowserInit._delayedStartup` notifies
  `browser-delayed-startup-finished` with the window
  (`browser/base/content/browser-init.js:749`), after the window has painted and session
  restore has started. Firefox's own first update check waits `app.update.timerFirstInterval`,
  30,000 ms (`browser/app/profile/firefox.js:102`), counted from the update timer's start.
- **Arming delays.** Firefox's security dialogs enable their buttons
  `security.dialog_enable_delay` after they appear, 1,000 ms by default
  (`modules/libpref/init/all.js:1734`; read by `PromptUtils.sys.mjs:132`). Doorhangers use
  `security.notification_enable_delay`, 500 ms (`modules/libpref/init/StaticPrefList.yaml:19109`).
- **Vimma's existing lines.** The agent question (`ui/agent-prompt.mjs`, `host/agent-ui.mjs`;
  spec [vimma-mcp](vimma-mcp.md) decisions 13 and 14) is a line that never takes focus, gets its
  keys from VimmaHost's capture listener, opens by itself only under `mayOpenByItself`
  (`packages/vimma-core/src/agent-prompt.mjs`) and arms after `security.dialog_enable_delay`.
  The `y/N` questions of `ui/rename-prompt.mjs` (closing a workspace, `:private close`) focus
  an input instead, because each one follows the key that opened it. The notice (`ui/notice.mjs`) is a
  popover that never takes focus and is read by screen readers through live regions.

## Design

`packages/vimma-core/src/update-notices.mjs` holds the rules as pure functions: `checkDue`,
`announcement`, `shouldAsk`, `securityQuestion` and `questionAnswer`.
`updates/VimmaUpdates.sys.mjs` keeps `okAt`, the time of the last check with a verified answer,
next to `checkedAt` in the saved result (`vimma.update.last`), and runs `checkDue` at startup and
on its hourly timer. A result saved before `okAt` existed takes its `checkedAt` when its outcome
was `current` or `offer`. Once the install type is known, VimmaUpdates tells its listeners, so
the status bar and the notices can show a saved offer without waiting for a check.
`host/update-ui.mjs` listens to VimmaUpdates and to each window VimmaHost registers, shows the
message, and runs the question line, an `AgentPrompt` with its own id (`vimma-update-prompt`) and
colour. VimmaHost hands it each keydown after the agent question and before the bindings.

1. **The startup check waits for the first window's delayed startup, plus 5 seconds**, so that
   it does not compete with the first paint and session restore, and still runs while the user
   is at the window. Rejected: Firefox's 30 seconds from module load, because a user who starts
   Vimma to check something may have closed it again; at once on load, because it would race
   the first paint for the network and the main thread.
2. **Only a check with a verified answer resets the interval**, so that a start while offline
   or a host outage does not postpone the next check by 12 hours. A failed attempt is not
   repeated within 10 minutes, so that restarting Vimma in a loop sends no burst of requests;
   the hourly timer retries in a running session. A refused manifest does not count either,
   because the next one may be valid; three refusals in a row therefore show
   `updates: check failed` after about three hours instead of 36, which is intended, since a
   feed that keeps failing verification is worth knowing about sooner. A last good check in the
   future (the clock was set back) makes a check due, so that a wrong clock never stops checks.
   No check runs before config.toml has been read, because its `[updates] check = false` is not
   known until then; a check due earlier runs once it is read, and an unreadable file holds
   checks off.
3. **The message is the existing notice, shown for 6 seconds**, because it is already the place
   where Vimma says things without taking focus, and screen readers hear it. Six seconds is long
   enough to read a line of about 60 characters and short enough not to linger. Rejected: the
   command line, because showing text there would put Vimma in command mode and take keys; a
   desktop notification, because it reaches outside Vimma for something that is not urgent.
4. **The message is shown once per version, remembered across restarts** in
   `vimma.update.announced`, because a message repeated at every start is noise that trains
   users to ignore it, and the status-bar segment already reminds them. It waits for a focused
   window, so that a message shown while the user is in another application is not lost.
5. **The security question uses the agent question's line, not the `y/N` prompt that takes
   focus**, because it appears without a key from the user, at a moment the user did not choose:
   a line that took focus could take the next keys meant for a page. The line's guards
   (`mayOpenByItself`) are the agent question's for the same reason.
6. **The question waits until the user is out of insert mode, rather than being dropped**,
   because a security update should still be asked about once, and waiting costs nothing: the
   segment shows meanwhile. Showing it in insert mode was rejected, because the line would take
   keys typed into a field. Focus moving into a field closes it back to waiting.
7. **Keys count only after `security.dialog_enable_delay`, and a key before then restarts it**,
   so that a page cannot have the user answer it by asking them to press `y` just as it appears
   (the same concern as Firefox's security dialogs and issue
   [#323](https://github.com/vimma-browser/vimma/issues/323)). The 1,000 ms dialog delay is used
   rather than the 500 ms doorhanger delay, so that both of Vimma's self-opening lines arm alike.
8. **Any key but `y` dismisses the question for the session**, as in every `y/N` in Vimma,
   because a question that ignored keys would block the user until they found the right one. A
   key that arrives while focus is in a field, while another overlay or a Firefox permission
   prompt is open, or while a page is in DOM full screen (where the line is hidden) is not the
   question's: the line closes back to waiting and the key goes on, so that a key is never read
   as an answer to a question the user cannot see or did not mean.
   (Since changed: hint, copy and element mode keep their keys the same way, because a hint label
   and the yank type `y`; issue #495, `keysHeld` in `host/VimmaHost.sys.mjs`.)
   `y` only opens the steps: Vimma installs nothing (m6a-updater decision 11).
9. **Once per session and version**, because the red segment stays and the steps need the user
   to act outside Vimma (a terminal, a package manager); asking again in the same session would
   be a nag. A newer urgent version is a new question. The 24-hour re-ask of the staged-update
   question (m6a-updater Behaviour 6, decision 21) belongs to restarting into a staged update,
   which Vimma cannot do yet.
10. **No question in a private window**, so that a private session is never interrupted by a
    question it does not need: the private workspace is short-lived, and the next normal window
    asks. The message may show there, because it carries nothing about the session and takes no
    keys.
11. **`[updates] check = false` turns off the message and the question too**, because a user who
    turned checks off has said they handle updates themselves, and an offer saved before the
    switch was set is no longer current.

## Security and privacy

- No new request: the startup check is the same anonymous GET (`docs/security.md` UP3), and the
  10-minute floor keeps restarts from multiplying it.
- The question opens only about:vimma; it installs nothing and runs no command.
- A page cannot answer the question: it never has focus, it does not open while a field has it,
  and keys before the arming delay are ignored (`docs/security.md` UP9).
- The new pref `vimma.update.announced` holds a version string and is read only to compare it.

## Tests

- Vitest `packages/vimma-core/test/update-notices.test.mjs`: `checkDue` (never checked, fresh,
  stale, a failed attempt and the 10-minute floor, the clock set back, the one-hour floor, off
  and source builds); `announcement` (new version, security wording, the same version, a newer
  one, no offer, off); `shouldAsk` (urgent, asked already, a newer urgent version, ordinary,
  off, source, private); the question text and `questionAnswer`.
- Mochitest `tests/browser/browser_vimma_update_notices.js`:
  `startup_checks_when_due_and_not_when_fresh`, `a_new_version_is_announced_once`,
  `a_security_update_asks_once_per_session` (keys within the delay ignored, `n` dismisses, not
  asked again), `y_shows_the_update_steps_and_esc_dismisses`,
  `the_question_waits_while_the_user_types`, `early_and_held_keys_never_answer`,
  `another_window_in_front_arms_it_again`, `the_question_waits_for_an_open_overlay`,
  `closing_the_window_hands_the_question_on`, `a_pref_of_the_wrong_type_breaks_nothing`,
  `no_question_in_a_private_window`, `nothing_at_all_with_checks_off`.

## Docs and changelog

- `docs/guide.md`, Updates: the startup check, the message and the security question.
- `docs/security.md` §16: UP4 covers the message and the question; UP9 is new.
- `CHANGELOG.md`: one line under Added.

## Delivery

One pull request: the core rules, the host, the tests and the docs.

## Open questions

None.
