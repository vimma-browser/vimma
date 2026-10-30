# Spec: follow-link-switch

Status: implemented · Area: `packages/vimma-core/src/` (`hints.mjs`, `actions.mjs`, `agent-keys.mjs`,
`statusbar.mjs`); `src/browser/base/content/vimma/` (`host/VimmaHost.sys.mjs`,
`actors/VimmaActors.sys.mjs`, `ui/statusbar.mjs`); generated `docs/bindings.md`,
`docs/bindings.json`, `packages/vimma-core/defaults.toml` · Upstream patches: none · ADR: none.
No new dependency.

Issue: [#533](https://github.com/vimma-browser/vimma/issues/533)

Builds on [m1-hints](m1-hints.md) (hint mode), [element-focus](element-focus.md) (decision 2: `F`
is element focus and background-tab hints moved to `gF`), [m3-workspaces](m3-workspaces.md),
[side-panel-unsplit](side-panel-unsplit.md) (decision 22: a new foreground tab opens in the
focused pane), [private-workspace](private-workspace.md), [vimma-mcp](vimma-mcp.md) (decision 10:
agent opens never switch) and [mcp-drive](mcp-drive.md) (decisions 9 and 12: the agent's
`vimma_keys` and its `f`). Vimma paths were checked on `main` at 9ce3e9a3 and are under
`src/browser/base/content/vimma/` unless they start with `packages/`, `docs/` or `tests/`. Engine
paths are relative to `engine/` and were read in Firefox 158.0.1 (`surfer.json`).

## Summary

In `gF`'s hint mode, typing the last character of a label in upper case (with Shift) opens the link
in a new tab and switches to it; lower case keeps today's behaviour, a new tab in the background.
The status bar shows both outcomes while the labels are up, for example `sd background · sD go
there`. A new action, `follow_link_new_tab_fg` (`hint.follow_new_tab_fg`), starts hints that always
switch; it has no default key and can be bound in `config.toml`. The agent's `f` gets no switching
variant.

## Problem

Vimma has two ways to follow a link from the keyboard: `f` follows it in the current tab, and `gF`
opens it in a new tab in the background. Nothing opens a link in a new tab and goes to it, which is
what a reader wants when a link is worth reading now but the current page is worth keeping:

- Reading a linked article in its own tab takes `gF`, the label, then `gt` (or tab search) to reach
  the tab. `gt` goes to the next tab in the strip, which is the new one only while
  `browser.tabs.insertRelatedAfterCurrent` places it there.
- `f` on the link reads it at once but replaces the current page, so the two pages cannot be kept
  open side by side, and returning means `H`.
- Firefox's own mouse gesture for this (`ctrl+shift+click`) has no keyboard equivalent in Vimma.

## Behaviour

1. As a Vimma user in `gF`'s hint mode, typing a label whose last character is lower case (`sd`)
   opens the link in a new tab in the background, as today; the current tab stays selected.
2. As a Vimma user in `gF`'s hint mode, typing a label whose last character is upper case (`sD`,
   or `SD` with Shift held throughout) opens the link in a new tab and selects that tab. The case
   of the characters before the last one does not matter: they only narrow the labels, as today.
3. As a Vimma user, while `gF`'s labels are up, the status bar shows `<label> background · <LABEL>
go there` beside the `HINT` badge, where `<label>` is the first label still on screen and
   `<LABEL>` is the same label with its last character in upper case (`sd background · sD go
there`). It follows what is typed: after `s`, it names the first label that starts with `s`.
4. As a Vimma user who binds `follow_link_new_tab_fg` (for example
   `[modal.normal] "<leader>F" = "hint.follow_new_tab_fg"`), its hint mode labels links as `gF`
   does, and every label opens its link in a new tab and selects it, whatever the case typed. The
   status bar shows `<label> go there`.
5. As a Vimma user in a split, a link opened with switching takes the focused pane, as every new
   foreground tab does there, and the old tab stays open.
6. As a Vimma user, the new tab is in the same window, container and workspace as the tab the link
   was on, and placed as Firefox places a related tab. Closing it with `x` returns to the tab the
   link was on.
7. As a Vimma user in the private workspace, the new tab is a private tab in the same private
   window, as with `gF` today.
8. As an agent driving its tab with `vimma_keys`, `f<label>` follows a link in the agent's tab as
   today and `hint.follow_new_tab_fg` is refused with the reason `hint.follow_new_tab` has; an
   upper-case character after `f` is not part of a label.
9. As a screen-reader user, starting `gF` announces `hint mode` and then how to choose the outcome,
   and the status bar's text can be read on demand while the labels are up.
10. As a Vimma user, `browser.tabs.loadInBackground` changes neither outcome: the case typed
    decides.

| Key or action                             | Where                   | Does                                       |
| ----------------------------------------- | ----------------------- | ------------------------------------------ |
| `gF` (`follow_link_new_tab`), unchanged   | normal mode             | starts hints on links                      |
| label, last character lower case          | `gF`'s hint mode        | opens the link in a background tab (today) |
| label, last character upper case          | `gF`'s hint mode        | opens the link in a new tab, switches      |
| `follow_link_new_tab_fg` (no default key) | normal mode, once bound | starts hints on links that always switch   |
| label, either case                        | that action's hint mode | opens the link in a new tab, switches      |
| `Backspace`, `Esc`                        | either hint mode        | unchanged                                  |

No config key is added. `[modal] hint_chars` is unchanged.

## Research

**Vimma today.**

- `gF` is bound to `hint.follow_new_tab` (`packages/vimma-core/src/defaults.mjs`, `[modal.normal]`
  table) and named `follow_link_new_tab` in the Hints group (`packages/vimma-core/src/actions.mjs`).
  `gf` is `page.view_source` and `gt` / `gT` are `tab.next` / `tab.previous` in the same table.
- Hint mode's keys are handled by the pure `hintKey` (`packages/vimma-core/src/hints.mjs:170`). It
  ignores ctrl, alt and meta chords, and matches `chord.key` against the charset. It ignores
  `chord.shift`: a letter arrives lower case with `shift` set, Caps Lock included
  (`hints.mjs:178`, and `normaliseKey` in `packages/vimma-core/src/keys.mjs:119`, which reads an
  upper-case letter as its lower case with shift). So today `sD` in `gF`'s hint mode selects `sd`
  and opens it in the background. A non-letter carries its shift in the character (`keys.mjs:122`):
  Shift with `;` arrives as `:` on a US layout, which no label contains.
- `[modal] hint_chars` must be at least two distinct characters, none upper case or whitespace
  (`checkChars`, `hints.mjs:55`; the config error, `packages/vimma-core/src/config.mjs:395`). It may
  contain digits and punctuation.
- On a select, the host (`host/VimmaHost.sys.mjs:2502`, `_hintKey`) calls
  `VimmaActors.openInBackground` for `hint.follow_new_tab` (`actors/VimmaActors.sys.mjs:960`). That
  opens only `http:`, `https:` and `file:` links of the document that was collected, after
  `checkLoadURIWithPrincipal` with the page's principal, through `openLinkIn(url, "tab", {
inBackground: true, relatedToCurrent: true, userContextId: <the tab's> })` in the window of the
  hinted browser, with the page's principals and a referrer.
- A new tab joins the workspace that owns its container, else the active one
  (`workspaces/WindowWorkspaces.sys.mjs:788`, `#adopt`). A foreground open, whose `TabOpen` and
  `TabSelect` come in the same task, is never hidden first. In a split, such a tab replaces the
  focused pane's tab (`split/PaneView.mjs:624`, `#onTabSelect`, side-panel-unsplit decision 22),
  while a tab selected later, in another task, is a pick: it shows alone and the split is kept as a
  hidden view (decision 21).
- The agent's keymap (`packages/vimma-core/src/agent-keys.mjs:91`) refuses `hint.follow_new_tab`
  ("it opens a tab; vimma_open does that, asked"), and an agent label is read only over the default
  lower-case characters (`agent-keys.mjs:313`), whatever the user's `hint_chars`.
- The status bar already shows a segment beside the mode badge in element mode (`paragraph · 412
chars`, `packages/vimma-core/src/statusbar.mjs:358`), and its polite live region says each new
  mode once (`statusAnnouncement`, `statusbar.mjs:774`). Hint labels are `aria-hidden`; the status
  bar says "hint mode" ([m7-a11y](m7-a11y.md), the table of surfaces).
- Unbound actions are listed in the `ctrl+b ?` overlay as `(unbound)`
  (`packages/vimma-core/src/help.mjs:178`).

**Firefox 158.0.1.**

- `openLinkIn`'s `inBackground`, when explicitly true or false, decides whether the new tab is
  selected; only when it is not passed does `browser.tabs.loadInBackground` decide
  (`browser/modules/URILoadingHelper.sys.mjs:409`, `toolkit/modules/BrowserUtils.sys.mjs:681`). The
  pref defaults to `true` (`modules/libpref/init/StaticPrefList.yaml:2156`). Vimma does not set it.
- `addTab` gives a foreground tab the selected tab as its owner
  (`browser/components/tabbrowser/Tabbrowser.sys.mjs:3748`); with
  `browser.tabs.selectOwnerOnClose` (default `true`, `browser/app/profile/firefox.js:1154`) closing
  the tab selects its owner again (`Tabbrowser.sys.mjs:7084`).
- A related tab goes after the opener and its earlier related tabs when
  `browser.tabs.insertRelatedAfterCurrent` is true (`Tabbrowser.sys.mjs:5394`).
- Vimma's hunk in `addTab` gives a tab opened without a container the opener's
  (`Tabbrowser.sys.mjs:3776`); `openInBackground` passes the container explicitly anyway.

**Other keyboard browsers.** Checked in their sources on GitHub on the dates of the commits named.

- Vimium 2.4.2 (`philc/vimium` at `5aa29614`): `f` opens in the current tab and `F` in a new
  background tab (`background_scripts/commands.js:437`). "Open a link in a new tab & switch to it",
  `LinkHints.activateModeToOpenInNewForegroundTab`, exists with no default key
  (`background_scripts/all_commands.js:206`). In hint mode, holding a modifier changes the outcome
  until it is released: Shift flips between the current tab and a new background tab, and Control
  between a new background tab and a new foreground tab (`content_scripts/link_hints.js:529`).
- qutebrowser 3.7.0 (`qutebrowser/qutebrowser` at `9f6e2998`): hint targets `tab-fg` and `tab-bg`
  open in a new foreground or background tab, and `tab` follows the `tabs.background` setting
  (`qutebrowser/browser/hints.py:210` and `:676`). They are separate bindings (`;f` and `;b`,
  `qutebrowser/config/configdata.yml:3726`); no modifier on a label changes the target.

## Design

`hintKey` reports whether the select should switch; the host opens the tab in the foreground or
the background accordingly; the status bar shows the choice.

1. **Upper case on the last key of a `gF` label switches to the new tab.** In
   `hint.follow_new_tab`'s hint mode, the key that completes a label selects it as today, and the
   select switches when that key is an upper-case letter (`chord.shift` on a letter), so that both
   outcomes come from one hint session and no new key has to be learned. Only the last key counts,
   because it is the one that acts: the keys before it only narrow, and Shift held through the
   whole label also ends upper case. The idea of a modifier choosing the foreground is familiar from
   Vimium, whose held Control does it (Research); Vimma reads the case of the typed character
   instead of a held modifier because hint keys already arrive as chords with their shift folded
   into letters (`keys.mjs:119`), and Shift is the modifier a label character can carry. Rejected:
   a second key after the label (`Enter` to switch), because a label selects on its last character
   and waiting for another key would slow down every background open; a held Control, as Vimium
   does, because a ctrl chord in hint mode is ignored today and Control with a home-row letter
   collides with Firefox and Vimma bindings (`ctrl+d`, `ctrl+f`, `ctrl+l`).
2. **A switching action with no default key.** `follow_link_new_tab_fg`, id
   `hint.follow_new_tab_fg`, description "Follow link in new tab and switch to it", joins the Hints
   group. Its hint mode labels links only, as `hint.follow_new_tab` does, and every select
   switches, whatever the case. It is unbound by default, because the obvious keys are taken (`gf`
   is view source, `gt` and `gT` are Vim's tab keys, `F` is element focus) and the keymap is
   customizable by design; Vimium ships its equivalent unbound for the same reason (Research). The
   `_fg` suffix follows Vimium's "foreground tab" and qutebrowser's `tab-fg`.
3. **`hintKey` returns the decision, the host acts on it.** The `select` result gains
   `switch: boolean`: true for `hint.follow_new_tab_fg`, true for `hint.follow_new_tab` when the
   completing chord is a letter with `shift`, false otherwise. `hint.follow` and `hint.element` keep
   ignoring case, so `f` and `F` behave as today. Keeping the rule in `vimma-core` makes it a pure
   function tested in vitest, as the rest of hint mode is.
4. **A foreground open is one `openLinkIn` call with `inBackground: false`.**
   `VimmaActors.openInBackground` becomes `openInNewTab(browser, target, { background })`, with the
   same scheme, document and principal checks, and passes `inBackground: background`. The tab is
   opened in the foreground, not opened in the background and selected afterwards, because Vimma's
   workspaces and panes recognise a new foreground tab by its `TabOpen` and `TabSelect` coming in
   one task (Research): opened that way it takes the focused pane in a split and is never hidden
   first, as a `ctrl+shift+click` foreground open is; selected later it would be a pick that hides
   the split. `addTab` then makes the hinted tab its owner, so closing the new tab returns to it.
5. **`browser.tabs.loadInBackground` does not apply.** Vimma passes `inBackground` explicitly in
   both cases, so the pref changes neither outcome, because the case of the last key already
   states the outcome; the pref is the default for opens that carry no such choice. Rejected: following
   the pref for lower case, as qutebrowser's `tab` target does, because then `gF`'s documented
   meaning would depend on a pref the user may have set for mouse clicks.
6. **The new tab stays where `gF`'s tab goes today.** Same window as the hinted browser, the hinted
   tab's container (`userContextId`), `relatedToCurrent: true`, the page's principals and referrer.
   So it joins the workspace that shows the hinted tab, and the switch never changes workspace or
   window, because the user's own key opened it from a page they are looking at. In a private
   window the tab is private (`openLinkIn` in that window), as `gF`'s is today, so a private link
   never reaches a normal window.
7. **The agent gets no switching variant.** `hint.follow_new_tab_fg` joins `hint.follow_new_tab`'s
   entry in the agent keymap's refusals (`agent-keys.mjs:91`), with the same reason, because an
   agent's opens never switch, route or steal focus (vimma-mcp decision 10) and `vimma_open` is how
   it opens a tab. The agent's `f<label>` keeps reading labels over the default lower-case
   characters only, so an upper-case character after it is the next key, never part of a label.
   The user's own `gF` in an agent tab works as anywhere: the new tab takes the agent tab's
   container and stays in the agent workspace, as its background open does today; switching to it
   adds no reach, since the agent could already read that tab.
8. **The status bar names both outcomes.** While `gF`'s labels are up, a `hint` segment follows
   the mode badge: `<label> background · <LABEL> go there`, where `<label>` is the first label still
   on screen and `<LABEL>` the same label with its last character upper-cased, so that the rule is
   shown with a key the user can type now rather than described. For `hint.follow_new_tab_fg` it is
   `<label> go there`. The wording follows the bar's other key hints (`y show · n or Esc: not this
session`, `packages/vimma-core/src/update-notices.mjs:18`): a key, then what it does, joined by
   `·`. The segment has the element segment's priority and colour (`--vimma-fg-bright`), and is
   cut at its end on a narrow bar, so the background half, which is today's behaviour, is the last
   to go. `f` and `F` get no segment, since their outcome does not depend on case.
9. **Accessible without the labels.** The labels stay `aria-hidden`. When `gF`'s hint mode starts,
   the live region says `hint mode` as today and then `new tab: lower case opens in the background,
upper case goes there` (for the switching action, `new tab: goes there`), once per hint session,
   because a screen-reader user cannot see the segment change. The segment is text in the bar's
   `role=status` element, so it is read on demand. No colour carries meaning.
10. **A label whose last character has no upper case opens in the background.** `hint_chars` may
    hold digits and punctuation (`"1234567890"`, `"asdf;"`), whose Shift types another
    character. Such a label cannot switch, and the status bar shows only the background half
    while the first label on screen is one of them, because that keeps every config valid and
    adds no key, and the bindable `follow_link_new_tab_fg` covers those charsets. Rejected:
    refusing those characters in `hint_chars`, which would turn valid configs, `f`'s included,
    into config errors; a toggle key in `gF`'s hint mode, which is one more key to learn; and
    reading the shifted character from the physical key on a US layout (`keys.mjs:344`), which
    is wrong on other layouts.
11. **Caps Lock switches like Shift.** The typed character decides, so with Caps Lock on every
    `gF` follow switches, because one rule then holds for every key, as Vimma's keymap already
    reads a Caps Lock letter as its shifted key, and the status bar shows the outcome before the
    last key. Rejected: only a held Shift, which needs the key event's `shiftKey` carried into
    hint mode beside the chord.
12. **`f` gets no Shift variant.** `f` keeps ignoring case, because `f` also labels buttons and
    fields, which open no tab, and `gF` already covers links. Rejected: Shift on `f`'s last
    label character opening a new background tab, as Vimium's held Shift does.

## Security and privacy

No new surface. The switching open runs the same checks as `gF`'s background open: only `http:`,
`https:` and `file:` links of the document that was collected, `checkLoadURIWithPrincipal` with the
page's principal, the page as triggering principal, and the hinted tab's container. Selecting the
tab changes only which tab is shown, in the window and workspace already shown. An agent cannot
reach it: the new action is refused in `vimma_keys`, and agent labels stay lower case (decision 7).
`docs/security.md` needs no change, because no control-socket, MCP or content-actor message
changes.

## Tests

Written first and seen to fail.

**vitest, `packages/vimma-core`:**

- `hints.test.mjs`: `an upper-case last key in gF's hints selects with switch`;
  `a lower-case last key in gF's hints selects without switch`;
  `only the last key's case counts` (`Sd` does not switch, `sD` does);
  `the switching action's hints switch in either case`;
  `f's and F's hints ignore case and never switch`;
  `a last key without upper case does not switch` (charset `"asdf;"`, label ending in `;`);
  `HINT_ACTIONS lists hint.follow_new_tab_fg`.
- `actions.test.mjs`: `follow_link_new_tab_fg is hint.follow_new_tab_fg, in Hints, unbound`.
- `agent-keys.test.mjs`: `hint.follow_new_tab_fg is refused with hint.follow_new_tab's reason`;
  `an upper-case character after f is not part of the label`.
- `statusbar.test.mjs`: `gF's hint mode shows the background and go-there keys`;
  `the switching action's hint mode shows only go there`;
  `the hint segment follows the typed prefix`; `the hint segment is cut at its end`;
  `starting gF's hints announces both outcomes once`.
- `help.test.mjs` snapshot: the new row, `(unbound)`.

**mochitest, `tests/browser/browser_vimma_hints.js`:**

- `gF_with_an_upper_case_last_key_opens_and_selects_the_tab`: the new tab is selected, in the
  hinted tab's container, after it in the strip, and `x` returns to the hinted tab.
- `gF_ignores_loadInBackground`: with `browser.tabs.loadInBackground` set to `false`, lower case
  still opens in the background; set to `true`, upper case still switches.
- `the_switching_action_selects_the_tab_in_either_case`.
- `the_status_bar_shows_both_outcomes_in_gF` and that the segment is gone when hint mode ends.
- In `browser_vimma_side_panel_unsplit.js`:
  `a_switching_follow_in_a_split_takes_the_focused_pane`.
- In `browser_vimma_private_workspace.js`: `a_switching_follow_in_a_private_window_stays_private`.

**e2e:** a scenario `issue-533-follow-link-switch.json` that starts `gF` on a fixture page under the
Omarchy theme and saves a baseline of the status bar with the `hint` segment, then types an
upper-case last key and checks that the new tab is selected. The keymap PR also screenshots the
`ctrl+b ?` overlay with the new row.

## Docs and changelog

- `docs/guide.md`: "Link hints" (the paragraph on `gF`: upper case on the last key goes to the new
  tab; the switching action and how to bind it), "Status bar" (the `hint` segment), and the key
  table's `f` / `gF` row.
- `docs/bindings.md`, `docs/bindings.json` and `packages/vimma-core/defaults.toml` regenerated with
  `npm run gen-docs`; the help snapshot updated.
- `CHANGELOG.md` `[Unreleased]`: "`gF` with an upper-case last key opens the link in a new tab and
  switches to it; new unbound action `follow_link_new_tab_fg`". The note that Shift on the last key
  in `gF` no longer opens in the background goes in the same line, because it changes what that
  key did before.

## Delivery

One pull request, `feat(hints): gF with an upper-case last key opens the link and goes there`,
because the rule, the action, the status bar and the docs are one user-visible change and
the keymap rule allows one keymap change per pull request: it adds an action, so it regenerates the
bindings docs and the help snapshot, and its description carries the `ctrl+b ?` screenshot and the
e2e baseline. It sets this spec to `implemented` and closes the issue.

## Open questions

None. The three questions of the draft are decisions 10 to 12.
