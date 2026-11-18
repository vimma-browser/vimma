# Spec: hover

Status: draft · Area: `packages/vimma-core/src/page/hints.mjs`, `keys/actions.mjs`,
`keys/escape.mjs`, `config/defaults.mjs`, `ui/statusbar.mjs`, `control/control.mjs`,
`agent/agent.mjs`; `actors/hint-collect.mjs`, `actors/hover.mjs` (new), `actors/page-events.mjs`,
`actors/VimmaChild.sys.mjs`, `actors/VimmaActors.sys.mjs`, `actors/agent-page.mjs`;
`host/VimmaHost.sys.mjs`, `host/runners.mjs`; `ctl/agent-commands.mjs`;
`tools/vimma-ctl/src/mcp/` · Upstream patches: none · ADR: none. Builds on
[m1-hints](m1-hints.md), [element-focus](element-focus.md) (text blocks as hint targets) and
[mcp-forms](mcp-forms.md) (`vimma_elements`, `vimma_activate`).

Issue: [#1330](https://github.com/vimma-browser/vimma/issues/1330)

## Summary

A hint mode that **hovers** the element whose label is typed, as a mouse resting on it would: the
page shows what it shows only under the pointer (a channel's settings gear, a table row's
actions, a drop-down menu, a card's buttons), and the hover holds until `Esc`, another hover or
a navigation, so `f` can then follow what appeared. Agents get the same through a `vimma_hover`
tool, so a control that only appears on hover can be listed with `vimma_elements` and clicked
with `vimma_activate`.

## Problem

Many sites draw controls only while the pointer is over a part of the page. Discord shows a
channel's gear and invite buttons only on a hovered channel row; Gmail, GitHub and most admin
interfaces show a row's actions on hover; navigation bars open their sub-menus on hover. Without
a mouse, these controls do not exist for Vimma: `f` labels only what is rendered, and an agent's
`vimma_elements` lists only what is on screen. A keyboard user has to reach for the mouse, and an
agent cannot do the task at all.

Sending the page a `mouseover` is not enough. The commonest way to reveal such controls is a CSS
rule such as `.row:hover .gear { display: inline }`, and `:hover` follows the real pointer only:
an event a script or Vimma dispatches does not set it (Research).

## Behaviour

1. As a Vimma user, `;h` (open question 1) puts a label on every element on screen that can be
   hovered (decision 4), with `f`'s look, characters, `Backspace` and `Esc`. Typing a label
   hovers that element: the page shows its hover state as if the mouse rested on it, and the
   status bar shows `hover` and the element's text.
2. As a Vimma user, with an element hovered, `f` labels what the hover revealed, and following
   one clicks it; the hover holds through that click (open question 4).
3. As a Vimma user, `Esc` in normal mode ends the hover (after the page had the key, as `Esc`
   always does), and a second `Esc` stops a loading page as before. Another hover, a navigation
   of the page, a switch to another tab and moving the real mouse over the page end it too.
4. As a Vimma user, the hover changes nothing else: no focus, no selection, no click, no user
   activation.
5. As an agent, `vimma_hover { tab, label }` hovers an element of my last `vimma_elements` list
   in a tab of the agent workspace, in the background, and returns what changed on the page;
   with `elements: true` it also returns the new list, revealed controls included, so the next
   call is the `vimma_activate` of one of them.
6. As an agent, `vimma_hover { tab, release: true }` ends my hover in that tab; my next
   `vimma_hover` in the tab moves it. A navigation, the tab leaving the agent workspace, the user
   starting to use the tab and the end of my connection end it.
7. As a Vimma user watching the agent workspace, an agent's hover is never shown in my own
   window's link preview, gives the page no user activation, and is refused while I am using the
   tab, as an agent's click is.

## Research

### Firefox (checked against Firefox 160.0.1, `engine/`)

- **Who sets `:hover`.** `:hover` matches the element state `ElementState::HOVER`. Only the event
  state manager sets it: `EventStateManager::NotifyMouseOver` calls
  `SetContentState(aContent, ElementState::HOVER)` (`dom/events/EventStateManager.cpp:5664-5724`),
  which `GenerateMouseEnterExit` runs (`:6015`) from `PreHandleEvent` for a widget `eMouseMove`
  (`:1265-1288`). `SetContentState` then walks the **flattened tree** from the new hovered
  element up to the common ancestor with the old one, setting or clearing the state on each
  element, and on the control of each `<label>` on the way (`UpdateAncestorState`,
  `:6812-6860`, `GetFlattenedTreeParent` at `:6814`, `GetLabelTarget` at `:6823`). A hovered
  element therefore makes all its ancestors, shadow hosts and slots included, match `:hover`,
  and a hovered subdocument makes its `<iframe>` element and that element's ancestors match too
  (`NotifyMouseOver` notifies the parent document's state manager, `:5697-5711`).
- **Dispatched events do not set it.** `EventTarget.dispatchEvent` goes through
  `EventDispatcher::DispatchDOMEvent` and never through `PresShell::HandleEvent`, so
  `PreHandleEvent` (`layout/base/PresShell.cpp:9338`) and the code above never see it. Checked:
  a `mouseover` and a `mouseenter` dispatched by the content actor (and so trusted, below) on a
  row's text leave `.row:hover .gear` hidden (Manual experiments, A).
- **Pseudo-class locks.** `InspectorUtils.addPseudoClassLock(element, ":hover", enabled = true)`
  and `removePseudoClassLock`, `hasPseudoClassLock`, `clearPseudoClassLocks`
  (`dom/chrome-webidl/InspectorUtils.webidl:75-80`) exist for DevTools' "force element state".
  `InspectorUtils` is exposed only to chrome callers
  (`[Func="nsContentUtils::IsCallerChromeOrFuzzingEnabled"]`, `InspectorUtils.webidl:11`); a page
  cannot call it. The lock is stored on the element (`Element::LockStyleStates`,
  `dom/base/Element.cpp:676-698`, a property holding a set of locked states and their values)
  and changes the element's **style state** (`Element::StyleState`, `dom/base/Element.h:404-410`),
  which selector matching reads (`state_internal`, `servo/components/style/gecko/wrapper.rs:781-789`).
  - It locks **one element**; ancestors are not touched. DevTools locks the ancestors itself when
    asked (`addPseudoClassLock` with `parents`, `devtools/server/actors/inspector/walker.js:1411-1437`).
    Checked: a lock on a row's text alone leaves `.row:hover .gear` hidden; locking the text and
    each flattened-tree ancestor shows it (Manual experiments, B and C).
  - It is seen by the page's own selector matching: `row.matches(":hover")` and
    `document.querySelectorAll(":hover")` called by the page include the locked elements
    (Manual experiments, C).
  - It sends no event and runs no page code: `LockStyleStates` only calls
    `PresShell::ElementStateChanged` under a script blocker (`Element.cpp:667-674`).
  - It is one bit per state, not a count: `removePseudoClassLock` clears it whoever set it
    (`Element.cpp:700-715`), so a DevTools lock on the same element would be cleared by Vimma's
    release unless Vimma checks `hasPseudoClassLock` first.
  - It holds while the page scrolls (Manual experiments, C2), in a background tab
    (experiment G), and dies with its element: a new document has no locks (experiment H with a
    lock).
- **A real, synthesized mouse move.** `window.synthesizeMouseEvent(type, x, y, data, options)`
  (`dom/webidl/Window.webidl:648-651`, `[ChromeOnly]`; it replaced
  `nsIDOMWindowUtils.sendMouseEvent`) builds a widget event and, with `toWindow: true`, hands it
  to `PresShell::HandleEvent` (`dom/base/nsContentUtils.cpp:10431-10595`, `:10571-10577`), so the
  state manager handles it like a real move. Checked (experiment F): a `mousemove` at a row's
  text sets `:hover` on it and its ancestors and fires `pointerover`, `pointerenter`,
  `mouseover`, `mouseenter` and `mousemove`, all trusted. What that implies:
  - The move is recorded as the pointer's position (`PresShell::RecordPointerLocation`,
    `PresShell.cpp:7089-7106`; only a move with the synthesized _reason_ is skipped, `:7103`), and
    after every scroll and reflow Firefox synthesizes a move at that position
    (`PresShell::SynthesizeMouseMove`, `:5963`, pref `layout.reflow.synthMouseMove`, default
    true, `modules/libpref/init/StaticPrefList.yaml:11893-11896`). The hover therefore follows
    the **position**, not the element: scrolling by one row moved `:hover` to the next row
    (experiment F2), and after a reload the new page's element at that spot was hovered
    (experiment H after a native move), as a resting mouse would.
  - The position is fake while the real pointer is elsewhere: the next real move anywhere over
    the content replaces it. Ending the hover means synthesizing a `mouseout`, an
    `eMouseExitFromWidget` (`nsContentUtils.cpp:10476-10478`; experiment F4).
  - It works in a background tab too (experiment G). It is input through the widget path, which
    security.md M26 forbids for an agent ("with no event through `nsIDOMWindowUtils` or the
    widget").
- **Hover gives no activation.** Transient user activation comes only from
  `EventStateManager::NotifyTargetUserActivation`, for a `mousedown` or `pointerdown`
  (`EventStateManager.cpp:1251-1258`); the "handling user input" state only for trusted
  `mousedown`, `mouseup`, `pointerdown`, `pointerup`, a click, keys and touches
  (`UserActivation::IsUserInteractionEvent`, `dom/base/UserActivation.cpp:89-118`). No hover
  event is in either list, trusted or not, so a hover can never open a pop-up, use the
  clipboard or request a permission.
- **Trusted versus untrusted hover events.** An event the system-principal actor dispatches is
  trusted (`EventDispatcher::DispatchDOMEvent` stamps it with
  `nsContentUtils::LegacyIsCallerChromeOrNativeCode()`, `dom/events/EventDispatcher.cpp:1491-1504`;
  experiment A logged `mouseover:true`). A trusted `mouseover` on a link puts its URL in the
  window's link preview (`Element::GetEventTargetParentForLinks`, `dom/base/Element.cpp:4744-4810`);
  an untrusted one does not (`CheckHandleEventForLinksPrecondition`, `:4727-4742`). Dispatched
  through the page's own `dispatchEvent` with Xrays waived (`actors/page-events.mjs`), the
  events are untrusted, and a page's `mouseenter` listener still runs on them (experiment E).
- **Firefox's own tooltips** (an element's `title`) follow the real pointer through the content
  tooltip listener; a lock shows none. Not built on: the element's `title` is in its label text
  for the agent, and in the status bar for the user (decision 8).

### Vimma (`origin/main` at `2fbe2165`)

- **Hints.** `HINT_ACTIONS` (`packages/vimma-core/src/page/hints.mjs:56-63`) is the closed list
  of hint actions, run by `host._startHints` (`host/runners.mjs:748-753`); `_hintKey` selects a
  target and sends `Vimma:ActivateHint`, or for `hint.element` focuses a block
  (`host/VimmaHost.sys.mjs:2056-2089`). Collection is `collectTargets(win, { linksOnly, blocks,
disabled })` (`actors/hint-collect.mjs:355`): strong targets by tag, declared ones by role and
  `onclick`, inferred ones by focusability or a `click` / `mousedown` listener
  (`LISTENER_TYPES`, `:94`, read with `Services.els.hasListenersFor`, `:383`), or text blocks
  with `blocks: true`; each kept target passes `unoccluded`, a hit test at its centre and four
  inner corners (`:198-213`). Reply kinds are `link`, `input`, `click` and `block`
  (`hints.mjs:299`).
- **The press.** `#press` in `actors/VimmaChild.sys.mjs:1018-1050` dispatches `mouseover`,
  `mousedown` and `mouseup` and calls `click()`. For the user's hints the events come from the
  actor and are trusted, and `#leaveLink` clears the link preview a trusted `mouseover` set
  (`:1060-1070`); for an agent they go through `dispatchAsPage`
  (`actors/page-events.mjs:27-42`) and are untrusted. Only the user's hint wraps the press in
  `asUserGesture` (`VimmaChild.sys.mjs:1000`).
- **Agent rules.** security.md M26 (`docs/security/12-agents-mcp.md:821-860`): an agent's mouse
  events are untrusted, nothing goes through `nsIDOMWindowUtils` or the widget, and Vimma never
  gives an agent tab's document user activation. mcp-forms F27: a tab the user is using denies
  `vimma_activate` and `vimma_fill` with `in-use`. `ACT_RATE`, 30 a minute per connection, is
  shared by `agent-activate` and `agent-fill` (`packages/vimma-core/src/agent/agent.mjs:174-178`).
  `AGENT_TOOLS` maps control commands to tool names (`agent.mjs:116-129`); since
  [mcp-grants](mcp-grants.md) G1 one grant covers every grantable tool of a connection.
- **Esc.** In normal mode `Esc` goes to the page first and, if the page leaves it alone, runs
  `page.stop` (`packages/vimma-core/src/keys/escape.mjs:42-52`, firefox-keys decision 7).
- **Free keys.** In normal mode `;` is unbound (it is `caret.find_repeat` in copy mode only,
  `config/defaults.mjs:406`); `gh` and `zh` are unbound, and `z` is already a prefix (`zz`,
  `zZ`, `z0`, `defaults.mjs:356-358`).

### Prior art (default branches, read on 2026-11-18)

- **qutebrowser** (`a2a9c9dd88`): `;h` is `hint all hover`
  (`qutebrowser/config/configdata.yml:3728`). `AbstractWebElement.hover`
  (`qutebrowser/browser/webelem.py:440-445`) sends a Qt `MouseMove` event to the view at the
  element's position: a real move, with the position semantics above. It is released by the
  next real mouse move.
- **Vimium** (`4046615ae4`): link hints with `action=hover`, no default key
  (`background_scripts/all_commands.js:192`); `HoverMode` dispatches `mouseover` and dispatches
  `mouseout` when the mode exits on `Esc` (`content_scripts/link_hints.js:1673-1680`,
  `lib/dom_utils.js:395-479`). Its events come from a content script and are untrusted, so
  CSS `:hover` reveals do not work.
- **Surfingkeys** (`05638d1d17`): `ctrl+h` "Mouse over elements" dispatches `mouseover` (or a
  native move in its own browser build), `ctrl+j` "Mouse out elements"
  (`src/content_scripts/common/default.js:498-510`).
- **Tridactyl** (`a296f0728d`): no hover hint mode in `src/excmds.ts`.
- **Element focus** ([element-focus](element-focus.md)) is the nearest Vimma feature: a hint mode
  with a chrome-side result that the page does not see. Hover differs in that its whole point is
  to change what the page shows.

### Manual experiments

A throwaway mochitest (not committed) on the lane's artifact build of Firefox 160.0.1, with a
fixture of two rows styled `.row:hover .gear { display: inline }` and a `div` that opens on a
`mouseenter` listener:

| Step                                                                    | Result                                                                                    |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| A. Actor dispatches `mouseover` and `mouseenter` on the row's text      | gear hidden; the row's listener saw `mouseover` trusted                                   |
| B. `addPseudoClassLock(text, ":hover")`                                 | gear hidden; `row.matches(":hover")` false                                                |
| C. Lock the text and every flattened-tree ancestor                      | gear shown; the page's `querySelectorAll(":hover")` is `html, body, div#row, span#name`   |
| C2. Scroll the page by 2,000 px                                         | gear still shown                                                                          |
| D. Remove each lock                                                     | gear hidden                                                                               |
| E. Untrusted `mouseenter` through the page's `dispatchEvent`            | the `mouseenter` menu opened; a `mouseover` there was `isTrusted: false`                  |
| F. `synthesizeMouseEvent("mousemove")` at the text, `toWindow: true`    | gear shown; trusted `pointerover`, `pointerenter`, `mouseover`, `mouseenter`, `mousemove` |
| F2. Scroll by one row                                                   | `:hover` moved to the second row                                                          |
| F4. `synthesizeMouseEvent("mouseout")`                                  | no row hovered                                                                            |
| G. In a background tab (`document.hidden`): the native move, then locks | both set `:hover`; the gear rendered                                                      |
| H. Reload after locks only / after a native move with no `mouseout`     | no hover / the element at the old position hovered                                        |

## Design

### Decisions

1. **A hint mode, sibling of `f` and `F`.** Choosing what to hover is pointing at something on
   screen, which hints already do; `hint.hover` ("Hover an element: show what the page shows
   under the mouse", config name `hover_element`, group "Hints") joins `HINT_ACTIONS` and reuses
   the collection, labels, overlay, `Backspace`, `Esc` and buffered keys whole, so it costs one
   collection option and one selection case. Only `_hintKey`'s `select` case differs: it sends
   `Vimma:Hover` instead of `Vimma:ActivateHint`. Rejected: a hover command over the focused
   element only, because nothing gives a keyboard user focus on a non-focusable row.

2. **The hover is a pseudo-class lock on the element and its ancestors, with the pointer
   events a mouse would send.** The child (new `actors/hover.mjs`, imported only by
   `VimmaChild`):
   - locks `:hover` on the element, on each flattened-tree ancestor (`flattenedTreeParentNode`,
     the walk `UpdateAncestorState` makes) and on the control of each `<label>` among them, so
     `:hover` matches exactly the elements a real pointer there would make match (Research);
   - skips any element that already has a `:hover` lock (`hasPseudoClassLock`), and remembers
     the elements it locked, by weak reference, so that its release clears only its own locks
     and never DevTools' "force element state";
   - dispatches, in the order a pointer entering the element gives them (experiment F):
     `pointerover` on the element, `pointerenter` on each newly hovered element from the
     outermost down, `mouseover` on the element, `mouseenter` likewise, then one `mousemove` on
     the element, at the centre of its first visible box (the point `#press` uses), with
     `buttons: 0`. Elements that were already hovered by the previous hover (the common
     ancestors) get no enter event, as with a real move;
   - in a frame, asks the child of each ancestor frame to lock the `<iframe>` element's chain in
     its own document, since a real hover in a subdocument hovers its embedder too
     (`EventStateManager.cpp:5697-5711`); the parent actor relays this, as it relays hint
     frames.

   Reasons: the lock follows the element and not a screen position, so scrolling with `j` to
   read what the hover revealed keeps it (experiment C2), where a synthesized move would hand
   the hover to whatever scrolled under the old point (experiment F2); it holds in a background
   tab, which an agent's tab always is; it is released exactly, by reference; and it is the same
   mechanism for the user and for an agent, who differ only in the trust of the events
   (decision 3). The events are what scripts that open menus listen for (React's
   `onMouseEnter` is built on `mouseover` / `mouseout`, jQuery's `hover` on `mouseenter` /
   `mouseleave`); the lock is what CSS reveals need. Rejected:
   - events alone (Vimium, Surfingkeys): CSS `:hover` reveals, the commonest kind, stay hidden
     (experiment A);
   - the lock on the element alone: an ancestor's `:hover` rule never matches (experiment B);
   - a synthesized native move (`window.synthesizeMouseEvent`, qutebrowser's approach) for the
     user: it gives a faithful hover, with Firefox's own `title` tooltips and the CSS cursor, but
     it hovers a screen position, so the first scroll or a page reflow moves it to another
     element and a reload hovers whatever lands there (experiments F2, H); ending it needs a
     synthetic widget exit; and it could not serve agents, whom M26 keeps off the widget path,
     so the two paths would behave differently on the same page.

3. **Trusted for the user, untrusted for an agent.** The user's hover dispatches its events from
   the actor, which makes them trusted (`EventDispatcher.cpp:1491-1504`), as a real pointer's
   are and as the user's `f` already does; an agent's hover dispatches them through
   `dispatchAsPage` (`page-events.mjs`), untrusted, exactly as M26 requires for an agent's
   `mouseover`. Consequences:
   - a user's hover over a link shows its URL in the window's link preview, as a mouse would,
     and the release clears it with `#leaveLink`'s call; an agent's never sets the preview;
   - a page that acts only on a trusted `mouseover` ignores an agent's hover events, but CSS
     reveals still work for it, because the lock does not depend on events;
   - neither path gives user activation or "handling user input" (Research: no hover event
     counts), so neither wraps the hover in `asUserGesture`.

4. **What can be hovered.** `collectTargets` gains a `hover: true` option whose targets are:
   - every target `f` labels (links, buttons, fields, declared and inferred clickables),
     because a hovered link or button is the commonest hover target (menus, link previews);
   - elements with a hover listener, read as `click` listeners are today: `mouseover`,
     `mouseenter`, `pointerover` and `pointerenter` (`Services.els.hasListenersFor`), plus
     `[title]` and `[aria-haspopup]`, because these declare that hovering does something;
   - text blocks, as `F` collects them (element-focus decision 3), so that a row whose controls
     appear through a CSS `:hover` rule, which no listener or attribute announces, can be
     hovered through its text: the ancestor locks of decision 2 reach the row (open question 3);
   - "innermost wins" across the three: a block or a listener element that holds another hover
     target gets no label of its own, so a paragraph with a link gets the link's label only.
     The caps, frames, frame timeout and occlusion check are `f`'s. The reply kind is `hover`
     with a sub-kind `link`, `click`, `input`, `listener` or `block`, checked by
     `parseHintReply`.

5. **How long the user's hover holds.** Until one of these, each of which releases it:
   - `Esc` in normal mode, after the page had the key and left it alone: `resolveEscape` gains a
     `hovering` input and returns `hover.release` instead of `page.stop` while a hover is held,
     so the first `Esc` ends the hover and the second stops a loading page. The page sees that
     `Esc` first, so a hover menu that closes on `Esc` closes itself;
   - the next `hint.hover` in the same tab (the release and the new hover share their common
     ancestors, as a real move does: decision 2);
   - the page's `pagehide` (a navigation, a reload, the back-forward cache): its locks die with
     its elements (experiment H), and the child forgets them;
   - a switch to another tab, or the tab's window closing, because a hover the user can no
     longer see would come back unexplained;
   - a real mouse move over the page: the child's system-group `mousemove` listener releases the
     hover on a trusted move that the actor did not dispatch, because the user has taken the
     pointer and two hovered elements would confuse both them and the page;
   - `:hover_release` (`hover.release`, config name `hover_release`, unbound), for configs and
     the command line.
     It does **not** time out, because a revealed menu is often read slowly, and a hover that
     vanished after a delay would make `f` race it. Whether a click releases it is open
     question 4.

6. **Release mirrors the hover.** The child removes its own locks (decision 2) and dispatches,
   with the same trust as the hover, `pointerout`, `pointerleave` (innermost first), `mouseout`
   and `mouseleave` on the elements that stop being hovered, so that script menus close as they
   would when the mouse leaves. A user's release over a link clears the link preview. An element
   the page removed in the meantime gets no events; its ancestors still in the document do.

7. **No new mode.** After a label is chosen Vimma returns to normal mode with the hover held,
   rather than entering a `HOVER` mode, because every normal-mode key must keep working on the
   hovered page: `f` to follow what appeared, `j` / `k` to scroll it into view, `F` and `y` to
   copy it, `/` to find in it. A mode would have to rebind or pass through all of them, and the
   badge already says `NORMAL`. The hover is per tab; one hover at a time per tab, the user's
   and an agent's included: a new one from either replaces the other.

8. **The status bar says it.** While the selected tab holds a hover, the status bar shows a
   segment `hover · <text>`, where the text is the element's accessible name, else its text
   content, else its `title`, cut at 40 columns, as untrusted page text (no markup, control
   characters dropped). For an agent's hover the segment reads `agent hover · <text>`. The
   segment has a low priority in `fitStatus`, so it gives way before the URL. It goes when the
   hover is released. A polite live-region message says "hovering <text>" ([m7-a11y](m7-a11y.md)).

9. **Agents: a `vimma_hover` tool** (control command `agent-hover`), recommended over
   `hover: true` on `vimma_activate` (open question 2):
   - `vimma_hover { tab, label, elements?, query?, kinds? }` hovers an element of the
     connection's current `vimma_elements` list in that tab; `vimma_hover { tab, release: true }`
     releases. `label` and `release` are mutually exclusive, and one is required;
   - the element must still be the one listed and on an http or https page (as F8-F10);
     nothing else is refused: hovering a field, a file input, a disabled control or a link to
     another site does none of what makes clicking them dangerous;
   - the step waits for the page to settle and returns `changed` exactly as `vimma_activate`
     does (mcp-forms F11 and its later notes), and with `elements: true` the new element list,
     so one call reveals and lists;
   - annotations: not read-only, **not destructive**, idempotent (hovering the same element
     twice leaves the same state), open-world, because a hover changes what the page shows but
     sends nothing a click would;
   - it is gated, asked, granted, rate-limited and logged as `vimma_activate` is (open
     question 5): `AGENT_TOOLS` gains `agent-hover: vimma_hover`; it shares `ACT_RATE`; it is
     denied with `in-use` while the user is using the tab (F27), before the question, after the
     yes and before the hover; each call is a `:mcp log` row naming the element; a navigation
     the page starts during the step takes an `OPEN_RATE` slot and a form submission the page
     tries is stopped (F11, F16), as after a click;
   - the hover is the connection's: it is released by its next `vimma_hover` in the tab,
     `release: true`, `pagehide`, the tab leaving the agent workspace, the user starting to
     use the tab, and the end of the connection. A later `vimma_activate` does not release it
     (open question 4).

10. **What `vimma_elements` lists for a hover.** `vimma_elements` lists what can be clicked, as
    today. A new `kinds` value `hover` asks also for the hover-only targets of decision 4
    (listener elements, `title`, `aria-haspopup`, text blocks), with the kind `hover`, so the
    default list does not grow by every paragraph on screen for every task (open question 6).
    `vimma_hover` accepts a label of either kind.

11. **No new Firefox patch.** `InspectorUtils` and `flattenedTreeParentNode` are available to
    the content actor as chrome code, and the events are ordinary DOM events, so the feature
    needs no change to Firefox.

### Limits

- A page that checks `isTrusted` on hover events ignores an agent's hover events; its CSS
  reveals still work.
- Firefox's own `title` tooltip does not appear for a locked hover; the status bar shows the
  hovered element's text instead (decision 8).
- The CSS `cursor` does not change, since the real pointer has not moved.
- A page that reads the pointer position (`mousemove` coordinates over time, canvas apps,
  drag-to-reveal) sees one `mousemove` at the element's centre and nothing more.
- Only one element is hovered at a time per tab; hovering through nested menus is one hover
  per level, each replacing the last (a sub-menu stays open when its item is inside the
  hovered parent, as it is in most menus, because the ancestors keep `:hover`).
- `:hover` on the real pointer's element still follows the real pointer: if the mouse rests
  over the page, both elements match `:hover` until it moves (which releases Vimma's).

### Out of scope

- Hovering at an arbitrary point, or dragging.
- Long-press and `contextmenu` (a right click is a separate feature).
- Showing Firefox's `title` tooltip in chrome.

## Security and privacy

What a hover can do, and why nothing new becomes reachable:

- **No activation, no user input state.** No hover event gives transient activation or
  "handling user input", trusted or not (Research). A hover cannot open a window, use the
  clipboard, request credentials, enter fullscreen or start audible media. Pop-ups are refused in
  agent tabs by their sandbox flags anyway (M10).
- **A subset of what a click already does.** An agent's `vimma_activate` already dispatches an
  untrusted `mouseover` on any element of its list (M26). `vimma_hover` adds `pointerover`,
  `pointerenter`, `mouseenter`, `mousemove` and their leave counterparts, all untrusted (events
  a page's own script can dispatch on itself), and the `:hover` lock, which changes only style
  and runs no page code (`Element.cpp:667-674`). Every control a hover reveals is still reached
  only through `vimma_elements` and `vimma_activate`, with all their checks: submissions and
  payments are asked (F15, checkpoints), fields are filled only through `vimma_fill`, cross-site
  links are followed only through `vimma_keys`.
- **Page handlers.** A page's hover handlers run, as they would for a mouse: they may fetch
  (prefetch on hover), render menus, or navigate. A navigation during the step counts in
  `OPEN_RATE`; a form submission is stopped by the `DOMFormBeforeSubmit` guard (F16) as after a
  click; a request the page sends with `fetch` from a hover handler cannot be told from the
  page's own timers, as with a click (mcp-forms F17). The step is rate-limited with clicks
  (`ACT_RATE`), so a grant cannot loop hovers faster than clicks.
- **Menus and pop-ups.** Hover menus are page DOM. A hover cannot open a Firefox menu, a
  `<select>` list, a file chooser, a permission prompt or a dialog: those need a click or
  activation.
- **The user's window.** An agent's untrusted `mouseover` never sets the link preview in the
  user's window (`CheckHandleEventForLinksPrecondition`), and the agent's hover is refused while
  the user uses the tab, and released when the user starts to, so it never fights the user's
  own pointer. A user's hover, being trusted, may set the preview, and its release clears it.
- **Locks are chrome-only and Vimma's own.** A page cannot add, remove or query a lock
  (`InspectorUtils` is chrome-only); it sees only that some elements match `:hover` without a
  pointer, which together with untrusted events tells it an agent is acting, which it can
  already tell (M26). Vimma removes only locks it added, so DevTools' forced states survive.
- **Messages.** `Vimma:Hover` (`hover`, `release`, `embedder`) is sent only by the parent: for
  the user from the hint keys typed in chrome, for an agent from `agent-hover` after the gate.
  The child acts only for the current hint `gen` and only in the frame asked, and refuses
  malformed data, as `Vimma:ActivateHint` and `Vimma:AgentElement` do. An agent's hover reaches
  the child through `AgentPage` (`agent-page.mjs`), never through the user's message, so it can
  never take the trusted path.
- **Agent tabs only.** `agent-hover` acts only in a tab that passes `isAgentTab`, before the
  question, after the yes and before the hover (F27); the user's hover works in any tab.
- **Read surface.** The element's text in the status bar and in the `:mcp log` row is page text
  already readable with `vimma_read_page`; it is shown as untrusted text.
- **docs/security/12-agents-mcp.md** gains a rule (the next number, M64) with sub-PR 2: an
  agent's hover is the child's untrusted events through `dispatchAsPage` plus `:hover` locks it
  owns, never input through `window.synthesizeMouseEvent`, `nsIDOMWindowUtils` or the widget,
  never with user activation; it is denied while the user uses the tab and released when they
  start; it shares `ACT_RATE`. Sub-PR 2 gets a fresh security review.

## Tests

Written first; red pasted, then green.

- **Vitest (core)**:
  - `hints.test.ts`: `hint.hover` accepted by `startHints`; `parseHintReply` takes `kind:
"hover"` with each sub-kind and refuses an unknown one; ordering of overlapping hover
    targets.
  - `escape.test.ts`: in normal mode with `hovering: true`, `Esc` resolves to `hover.release`
    with `afterPage`; without it, `page.stop` as today.
  - `statusbar.test.ts`: the `hover · <text>` and `agent hover · <text>` segments, truncation
    at 40 columns, control characters dropped, and that the segment gives way before the URL.
  - `actions.test.ts` / `defaults.test.ts`: `hint.hover` and `hover.release` exist in "Hints";
    in the keymap sub-PR, `;h` reaches `hint.hover` and collides with no default, Firefox's
    keys included.
  - `control-v2.test.ts`: `agent-hover` arguments: `tab` with `label` or `release: true`, never
    both, never neither; `elements`, `query`, `kinds` as for `agent-activate`; extra fields
    refused. `agent.test.ts`: `AGENT_TOOLS` maps `agent-hover`; it shares `ACT_RATE` with
    `agent-activate` and `agent-fill`.
- **Rust** (`tools/vimma-ctl`): the `vimma_hover` tool in the fixture with its annotations;
  argument mapping; `unknown-command` from an older Vimma worded as "update Vimma".
- **Mochitests** (`tests/browser/browser_vimma_hover.js`, fixtures `file_vimma_hover.html`,
  `file_vimma_hover_frame.html`):
  1. `test_hover_reveals_css_hover_controls`: a row styled `.row:hover .gear`; `;h` and the
     text's label shows the gear; `row.matches(":hover")` is true in the page.
  2. `test_hover_runs_script_menus`: a `mouseenter` menu and a React-style `mouseover` menu
     open; the page's listeners see `pointerover`, `pointerenter`, `mouseover`, `mouseenter`,
     `mousemove` in that order, trusted.
  3. `test_hover_then_f_follows_a_revealed_control`: after the hover, `f` labels the gear and
     its label clicks it; the row is still hovered after the click (or released, per open
     question 4).
  4. `test_hover_holds_while_scrolling`: `j` scrolls by a row and the same row stays hovered.
  5. `test_hover_release`: each of `Esc` (page loading: not stopped; a second `Esc` stops it),
     another hover, navigation, tab switch, a synthesized real mouse move, and
     `:hover_release` removes `:hover`, fires the leave events and clears the status segment.
  6. `test_hover_changes_nothing_else`: no focus, no selection, no click, and
     `navigator.userActivation.hasBeenActive` stays false.
  7. `test_hover_keeps_devtools_locks`: an element locked by `InspectorUtils` before the hover
     keeps its lock after the release.
  8. `test_hover_link_preview`: a user hover on a link shows its URL in the link preview and the
     release clears it.
  9. `test_hover_shadow_dom_and_labels`: a target in an open and in a closed shadow root hovers
     its host and slots; hovering a `<label>` hovers its control.
  10. `test_hover_in_a_cross_origin_frame`: the frame's element and the `<iframe>` element's
      chain in the top document match `:hover`; both are released.
  11. `test_hover_malformed_messages`: `Vimma:Hover` with a stale `gen`, an unknown `op`, a frame
      not asked, `null` is refused.
  12. Mutation checks to run and paste: ancestor locks off (test 1 fails), the
      `hasPseudoClassLock` check off (test 7 fails), the trusted dispatch swapped for
      `dispatchAsPage` (test 8 fails).
- **Mochitests, agent** (`tests/browser/browser_vimma_mcp_hover.js`):
  1. `test_agent_hover_reveals_and_lists`: `agent-hover` with `elements: true` on a background
     agent tab returns `changed` and a list holding the revealed gear; `agent-activate` clicks it.
  2. `test_agent_hover_events_are_untrusted`: the page sees every hover and leave event
     `isTrusted: false`; the link preview of the user's window is unchanged.
  3. `test_agent_hover_no_activation`: `hasBeenActive` stays false; nothing is focused; the tab
     is never selected.
  4. `test_agent_hover_in_use`: denied with `in-use` while the user uses the tab; a held hover
     is released when the user starts.
  5. `test_agent_hover_only_agent_tabs_and_web_pages`: refused outside the agent workspace and
     on a non-http(s) page.
  6. `test_agent_hover_release`: `release: true`, the next hover, navigation and the
     connection's end release it.
  7. `test_agent_hover_rate`: hovers and clicks share 30 a minute.
- **e2e** (`tests/e2e/scenarios/hover.json`): `;h`, a label, then a screenshot with the revealed
  control and the status segment (`hover.png`), in the stock theme and the Omarchy theme.

## Docs and changelog

- `docs/guide.md`: a "Hovering an element" section after "Link hints": the key, what can be
  hovered, `f` after a hover, what releases it, the status segment, the limits.
- `docs/bindings.md`, `docs/bindings.json`, `defaults.toml`: `npm run gen-docs` (sub-PRs 1 and
  3).
- `docs/limits.md`: the Limits above.
- `docs/security/12-agents-mcp.md`: rule M64 and the tool's line in the tool summary (sub-PR 2).
- MCP server instructions (`tools/vimma-ctl/src/mcp/instructions.rs`), one sentence: a button
  that shows only under the mouse is revealed with `vimma_hover`, then listed and clicked; then
  `npm run gen-agent-tools`.
- CHANGELOG `[Unreleased]`, suggested:
  - "Added: hover an element with a hint (`:hover_element`), so controls that a page shows only
    under the mouse can be followed with `f`."
  - "Added: `vimma_hover`, an agent tool that hovers an element in the agent workspace."
  - With sub-PR 3: "Added: `;h` hovers an element."
  - "Added: e2e baseline `hover.png`."

## Delivery

| #   | PR                                                      | Contents                                                                                                                                                                                                                                                         | Size     |
| --- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | `feat(hints): hover an element with a hint`             | `hint.hover` and `hover.release`, **unbound** (reachable as `:hover_element` and through config); `collectTargets` `hover` option; `actors/hover.mjs` (locks, events, frames, release); `Vimma:Hover`; `Esc`, status segment, release triggers. Mochitests 1-12. | M (~800) |
| 2   | `feat(mcp): vimma_hover hovers an element for an agent` | `agent-hover`, `vimma_hover`, `vimma_elements` kind `hover`, gate, rate, `in-use`, log; M64; instructions; agent mochitests 1-7. Fresh security review.                                                                                                          | M (~700) |
| 3   | `feat(keys): ;h hovers an element` (keymap PR)          | The default key from open question 1; gen-docs, help snapshot, `defaults.toml`; e2e scenario and baseline; guide.                                                                                                                                                | S (~150) |

Sub-PR 1 needs no feature flag, because its action is unbound and complete when it lands, as
element-focus's first sub-PR was. Sub-PR 2 is security-sensitive (MCP and the agent gate) and
stops at ready for the maintainer as a new agent capability. Sub-PR 3 changes the default keymap
and lands alone, when no other keymap pull request is open.

## Open questions

1. **The default key.** Options:
   - `;h`: qutebrowser's key for the same thing; `;` is unbound in normal mode and would become
     a prefix for later hint variants (Tridactyl's `;` family). Two keys for a rare action.
   - `gh`: free and short; Vim's `gh` (select mode) has no meaning in Vimma; weak mnemonic
     beside `gf`, `gF`, `gi`, `gu`.
   - `zh`: `z` is already a prefix (PDF zoom); no mnemonic.
   - None: `:hover_element` only, and users bind it.

   Recommendation: `;h`, because it is the established key in the one browser that hovers with
   a hint, and the `;` prefix leaves room for related hint actions.

2. **The agent surface.** `vimma_hover` (decision 9), or `hover: true` on `vimma_activate`. A
   flag keeps the tool list short, but `vimma_activate` is annotated destructive, refuses fields,
   file inputs and cross-site links that a hover may touch safely, and its submit and payment
   questions mean nothing for a hover; the model would also read "activate" as "click".
   Recommendation: a separate `vimma_hover`, because its refusals, annotations and release differ
   from a click's.

3. **Text blocks as hover targets.** Including `F`'s blocks (decision 4) lets a CSS-only hover
   row be hovered through its text, at the cost of more labels on text-heavy pages. Leaving them
   out keeps `;h`'s labels close to `f`'s but misses rows that are neither clickable nor
   listened to. Recommendation: include them, with innermost-wins against the other targets, so
   a link inside a block keeps one label.

4. **Does a click release the hover?** Options: (a) no: the hover holds through `f` and
   `vimma_activate`, as a mouse that clicks stays where it is, and a menu opened from a revealed
   button stays anchored to it; (b) yes, after the click has run, so a hover never outlives the
   action it was for. Recommendation: (a), because a revealed control often opens a second level
   (a gear opens a menu) that would close with the hover, and a mouse behaves that way.

5. **How an agent's hover is asked.** Options: (a) as `vimma_activate`: asked until the user
   allows the session or a grant covers it, rate-shared with clicks; (b) never asked, as the
   read-only tools, since it sends nothing; (c) asked every time. Recommendation: (a), because a
   hover runs page handlers and can make the page fetch or navigate, like a click without its
   activation, and the user should see an agent start acting on a page the same way.

6. **What `vimma_elements` lists.** Options: (a) a `hover` kind on request (decision 10);
   (b) always list hover-only targets; (c) list none, and let `vimma_hover` take only clickable
   labels. Recommendation: (a), because hover-only targets are many on text pages, every list
   costs the agent's context, and the agent asks for them when the task needs a hover.
