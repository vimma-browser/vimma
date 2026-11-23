# Spec: notification-bars

Status: implemented · Area: core (`packages/vimma-core/src/keys/prompt-keys.mjs`), host
(`host/prompt-keys.mjs`, `host/popup-ops.mjs`) · Upstream patches: none · ADR: none

Issue: [#1473](https://github.com/vimma-browser/vimma/issues/1473)

## Summary

Firefox shows notification bars over a page for many reasons: a private window's "Site looks
broken? Reload the page to temporarily lower your tracking protection", a crashed plugin, a
redirect it stopped. Apart from the pop-up blocked bar, these bars needed the mouse in Vimma.
Now `Tab` moves focus onto the bar's buttons, where Firefox's own `Tab`, `Enter` and `Space`
work, and `Esc` closes the bar, with the guards the pop-up blocked bar already has.

## Problem

Vimma answers the pop-up blocked bar with `y`, `n` and `Esc` (`docs/specs/popup-blocked.md`).
Every other bar in a tab's notification box had no key: the bar takes no focus, Vimma's normal
mode sends `Tab` to the page, and Firefox gives bars no `Esc`. The only keyboard path was
`ctrl+l` followed by `Tab` from the address bar, which nothing names. A private window shows the
reduced-protection bar after a reload on a page whose trackers were blocked, so the bar comes up
on ordinary sites and stays until it is clicked.

## Behaviour

1. While the selected page (in a split, the focused pane's) shows a notification bar other than
   the pop-up blocked bar, and no permission prompt is open, `Tab` must move focus onto the bar's
   first button, or onto its close button when it has no other. From there Firefox's own `Tab`
   moves between the bar's buttons and `Enter` or `Space` presses one.
2. `Esc` must close the bar as its close button does: Firefox runs the bar's "dismissed"
   callback and none of its buttons. With focus on one of the bar's buttons, `Esc` closes the bar
   at once. A bar without a close button leaves `Esc` alone.
3. Both keys have the pop-up blocked bar's guards: they count only once the bar has been up for
   `security.notification_enable_delay` (500 ms by default) with no key pressed in between, and
   any key restarts the wait; a held key never answers. They also wait while Firefox's own delay
   on the bar's buttons runs again after the window regains focus. A key that does not count
   stays the page's.
4. An armed bar takes `Esc` before the page and before `stop_loading`, and `Tab` before the
   page's focus navigation, until the bar is closed. The reduced-protection bar comes up right
   after a reload, so an `Esc` meant to stop that load closes the bar instead; a second `Esc`
   reaches the page.
5. While typing in a page field, the address bar, a Vimma picker, the command line or a search,
   and in hint, copy and element modes, the keys are theirs. With focus on the bar, every key but
   `Esc` is Firefox's.
6. The bar names its keys in the permission prompt's keys line beside its buttons:
   `Tab buttons · Esc close`, `Tab buttons` for a bar without a close button, and
   `Esc, then Tab buttons` from a field or a mode that keeps the keys, and
   `Enter press · Esc close` with focus on the bar. It shows once the keys count and is hidden,
   keeping its place, while they wait.
7. In the agent workspace no key answers a bar, as for the pop-up blocked bar, also with focus
   on the bar.
8. The pop-up blocked bar keeps its own keys; with both bars on a page, it is the one answered.

## Research

Checked against Firefox 160 (`surfer.json`).

- The bar in the report is `ReducedProtectionNotification`
  (`engine/browser/modules/ReducedProtectionNotification.sys.mjs:122-199`): it is appended to the
  tab's notification box with the value `reduced-protection-reload`, two buttons ("Don't show
  again", "Reload") and a close button, in private windows only, after a reload from the browser
  UI on a page whose trackers were blocked.
- `appendNotification` (`engine/toolkit/content/widgets/notificationbox.js:145`) takes a
  `dismissable` argument, true by default, that gives the bar its close button; `dismiss()`
  (`:628`) runs the bar's `eventCallback("dismissed")` and closes it. The box's
  `currentNotification` is the bar shown last, on top of the others (set at `:369`, and after a
  close the last of `allNotifications`, `:381-383`).
- The bar's buttons are `<button>`s in its light DOM, in `buttonContainer`. Its clickjacking
  delay disables them for `security.notification_enable_delay` when the bar shows and again
  whenever the window regains focus (`_startClickJackingDelay`, `:652-700`); a disabled button
  takes no focus, so `Tab` waits while any button is disabled.
- Focus on a bar button is outside any `<browser>`, so `VimmaHost._mode` reports insert mode and
  Firefox's own `Tab`, `Enter` and `Space` reach the button.
- In a test build, `ctrl+l` and then `Tab` reached the bar's buttons and its close button;
  `Esc` in normal mode did nothing.

## Design

`PromptKeys` (`host/prompt-keys.mjs`) already watches the selected page's pop-up blocked bar: its
clock, the keys line in the bar and the status bar redraw when the line arms. `pageBar`
(`host/popup-ops.mjs`) now returns the pop-up blocked bar, else the box's `currentNotification`,
and `PromptKeys` hands a key for any other bar to `barKey` (`core/prompt-keys.mjs`), which returns
`focus`, `close` or `pass`; `barHint` words the line.

1. **Tab and Esc, not y and n.** Another bar's buttons are whatever the feature behind it chose
   ("Reload" here lowers tracking protection), so a letter cannot name a safe answer for every
   bar; focus on the buttons lets the user read them and press one with Firefox's own keys.
   Rejected: `y` for the first button, because the order carries no meaning across bars.
2. **Tab moves focus onto the bar.** The pop-up blocked bar keeps `Tab` for the page because `y`,
   `n` and `:popups` reach all of its options. Another bar has no other route, and the
   permission prompts already use `Tab buttons`, so the same key means the same thing on every
   browser question. Rejected: a new action with a default key, because a key would be one more
   to learn for the same reach, and the keymap stays as it is.
3. **The pop-up bar's guards.** The same clock and the same exemptions keep typing meant for the
   page from reaching a bar that a page can raise just as a key is pressed. With focus on the bar
   they do not apply to `Esc`, because only the user's own `Tab` puts focus there.
4. **No status bar cue.** The bar names its keys where the user is looking, and its own message
   says what it is; a cue for every kind of bar would crowd the status bar.
5. **Only the tab's own bars.** The window's global notification box (above the toolbars) is
   left as it is, because its bars are about the browser rather than the page being read,
   and a page's keys reaching them would be a surprise.

## Security and privacy

No new surface: the keys focus or close a bar in the user's own window, and every button is
still pressed by the user with Firefox's own keys. The agent workspace is left out, as for the
pop-up blocked bar, so no key from that workspace's pages acts on a bar.

## Tests

- vitest, `packages/vimma-core/test/prompt-keys.test.ts`: `barKey` (Tab focuses, Esc closes,
  guards, focus on the bar, a bar without a close button, a bar without buttons, other keys
  pass) and `barHint`.
- mochitest, `tests/browser/browser_vimma_notification_bars.js`:
  `tab_moves_focus_onto_the_buttons_where_enter_runs_one`,
  `esc_on_a_focused_button_closes_the_bar`, `esc_closes_the_bar_only_once_it_is_armed`,
  `tab_waits_while_firefox_restarts_the_bars_own_delay`,
  `the_popup_blocked_bar_keeps_its_keys_beside_another_bar`,
  `keys_typed_in_a_field_are_the_fields`, `a_bar_without_a_close_button_takes_only_tab`.
- `tests/browser/browser_vimma_popups.js` keeps the pop-up blocked bar's keys unchanged.

## Docs and changelog

`docs/guide.md`: "Other notification bars" under "Blocked pop-ups", and a pointer from
"Answering a permission prompt". The changelog line comes from the commit.

## Delivery

One pull request.

## Open questions

None.
