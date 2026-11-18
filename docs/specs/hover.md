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
   always does), and a second `Esc` stops a loading page as before. Another hover, leaving the
   page (also into the back-forward cache), a switch to another tab, workspace or split pane,
   the page replacing the hovered element, and moving the real mouse end it too; scrolling and
   page reflows do not.
4. As a Vimma user, the hover changes nothing else: no focus, no selection, no click, no user
   activation.
5. As an agent, `vimma_hover { tab, label }` hovers an element of my last `vimma_elements` list
   in a tab of the agent workspace, in the background, and returns what changed on the page;
   with `elements: true` it also returns the new list, revealed controls included, so the next
   call is the `vimma_activate` of one of them.
6. As an agent, `vimma_hover { tab, release: true }` ends my hover in that tab; my next
   `vimma_hover` in the tab moves it. A navigation (into the back-forward cache too), the page
   replacing the element, the tab leaving the agent workspace, the user starting to use the tab
   and the end of my connection end it.
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
  - It holds while the page scrolls (Manual experiments, C2) and in a background tab
    (experiment G). A new document has no locks (experiment H with a lock), but a page kept in
    the **back-forward cache** keeps its elements and so its locks: going back to it showed the
    row still hovered and still locked (experiment X1). A lock also survives the element's
    removal and re-insertion, and is dropped when the element is adopted into another
    document, because it is set without a transfer function (`Element.cpp:693`) and adoption
    removes such properties (`TransferOrRemoveAllPropertiesFor`, `dom/base/nsINode.cpp:4353`;
    experiment X3).
  - Checked on the other places `:hover` reaches (experiment X3): locking the flattened-tree
    chain from an element in an open or a closed shadow root, or from a slotted element,
    passes through the `slot` and the shadow host, and `:host(:hover)` rules apply; a lock on
    an `<iframe>` element applies the parent page's `iframe:hover` rule. A lock on a `<label>`
    does not hover its control (a real pointer does: experiment X3), so Vimma locks the control
    itself.
- **A real, synthesized mouse move.** `window.synthesizeMouseEvent(type, x, y, data, options)`
  (`dom/webidl/Window.webidl:648-651`, `[ChromeOnly]`; it replaced
  `nsIDOMWindowUtils.sendMouseEvent`) builds a widget event and, with `toWindow: true`, hands it
  to `PresShell::HandleEvent` (`dom/base/nsContentUtils.cpp:10431-10595`, `:10571-10577`), so the
  state manager handles it like a real move. Checked (experiment F): a `mousemove` at a row's
  text sets `:hover` on it and its ancestors and fires `pointerover`, `pointerenter`,
  `pointermove`, `mouseover`, `mouseenter` and `mousemove`, in that order, all trusted
  (experiment X3). The same move over a `<label>` hovers its control, over a shadow tree's
  content hovers its host, and over a same-origin or a cross-origin `<iframe>` hovers the
  `<iframe>` element in the parent page and sends it trusted `mouseover` and `mouseenter`
  (X3, X4). Not checked: whether such a move reaches the inside of an out-of-process frame;
  the lab's synthesized moves hovered the `<iframe>` element but not the subframe's content
  (X4), and the design does not depend on it. What that implies:
  - The move is recorded as the pointer's position (`PresShell::RecordPointerLocation`,
    `PresShell.cpp:7089-7106`; only a move with the synthesized _reason_ is skipped, `:7103`), and
    after every scroll and reflow Firefox synthesizes a move at that position
    (`PresShell::SynthesizeMouseMove`, `:5963`, pref `layout.reflow.synthMouseMove`, default
    true, `modules/libpref/init/StaticPrefList.yaml:11893-11896`). The hover therefore follows
    the **position**, not the element: scrolling by one row moved `:hover` to the next row
    (experiment F2), and after a reload the new page's element at that spot was hovered
    (experiment H after a native move), as a resting mouse would.
  - The moves Firefox synthesizes there (built with `WidgetMouseEvent::eSynthesized`,
    `PresShell.cpp:6155-6157`) send a trusted `mouseover` (and `mouseout`) when another element
    comes under the resting pointer, but **no** DOM `mousemove` or `pointermove`: with the
    pointer resting over the page, a lock that made the page reflow, a scroll that brought an
    `<iframe>` under the pointer and a reflow under it produced one trusted `mouseover` on the
    `<iframe>` and no `mousemove` at all, at an unchanged `screenX` / `screenY`, and the locked
    row stayed hovered (experiments X2, X2B, X2C).
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

### Vimma (`origin/main` at `0b6d9c3e`)

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
  `config/defaults.mjs:406`); `gh` and `zh` are unbound in normal mode; `z` is a prefix only in the
  PDF viewer's `[modal.pdf]` table (`zz`, `zZ`, `z0`, `defaults.mjs:356-358`).

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

Two throwaway mochitests (not committed) on the lane's artifact build of Firefox 160.0.1, under
Xvfb with a throwaway profile. The first (A-H) used a fixture of two rows styled
`.row:hover .gear { display: inline }` and a `div` that opens on a `mouseenter` listener; the
second (X1-X4) added an open and a closed shadow root with a slot, a `<label>` with its
`<input>`, a same-origin and a cross-origin `<iframe>` styled `iframe:hover`, and system-group
listeners for `mousemove`, `pointermove` and `mouseover`:

| Step                                                                                             | Result                                                                                                                                           |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. Actor dispatches `mouseover` and `mouseenter` on the row's text                               | gear hidden; the row's listener saw `mouseover` trusted                                                                                          |
| B. `addPseudoClassLock(text, ":hover")`                                                          | gear hidden; `row.matches(":hover")` false                                                                                                       |
| C. Lock the text and every flattened-tree ancestor                                               | gear shown; the page's `querySelectorAll(":hover")` is `html, body, div#row, span#name`                                                          |
| C2. Scroll the page by 2,000 px                                                                  | gear still shown                                                                                                                                 |
| D. Remove each lock                                                                              | gear hidden                                                                                                                                      |
| E. Untrusted `mouseenter` through the page's `dispatchEvent`                                     | the `mouseenter` menu opened; a `mouseover` there was `isTrusted: false`                                                                         |
| F. `synthesizeMouseEvent("mousemove")` at the text, `toWindow: true`                             | gear shown; trusted `pointerover`, `pointerenter`, `mouseover`, `mouseenter`, `mousemove` (the fixture did not listen for `pointermove`; X3 did) |
| F2. Scroll by one row                                                                            | `:hover` moved to the second row                                                                                                                 |
| F4. `synthesizeMouseEvent("mouseout")`                                                           | no row hovered                                                                                                                                   |
| G. In a background tab (`document.hidden`): the native move, then locks                          | both set `:hover`; the gear rendered                                                                                                             |
| H. Reload after locks only / after a native move with no `mouseout`                              | no hover / the element at the old position hovered                                                                                               |
| X1. Lock, navigate to a page that keeps it in the back-forward cache, go back                    | same document; row still `:hover`, still locked, gear shown                                                                                      |
| X2. Pointer resting over the page; lock (reflow), scroll 40 px, insert 100 px above              | no DOM `mousemove` after the first; row stays hovered                                                                                            |
| X2C. Pointer resting on a label; lock; scroll an `<iframe>` under it; insert 200 px above        | one trusted `mouseover` on the `<iframe>`, no `mousemove` or `pointermove`; row stays hovered                                                    |
| X3. Native move over the row, a `<label>`, a shadow host, a same-origin and a cross-origin frame | pointerover, pointerenter, pointermove, mouseover, mouseenter, mousemove; control, host and `<iframe>` hovered                                   |
| X3. Locks from shadow content, a slotted element, a closed root, a `<label>`, an `<iframe>`      | chain passes slot and host; `:host(:hover)` and `iframe:hover` apply; the label's control is not hovered                                         |
| X3. Lock twice (Vimma, DevTools), remove once                                                    | no lock left                                                                                                                                     |
| X3. Remove and re-insert a locked element; adopt it into a same-origin frame                     | lock kept; lock gone                                                                                                                             |
| X4. Parent-process move over a cross-origin `<iframe>`                                           | `<iframe>` element hovered; the subframe's row not (see Research)                                                                                |

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
   `VimmaChild` and `agent-page.mjs`, both restricted as the press is):
   - locks `:hover` on the element, on each flattened-tree ancestor (`flattenedTreeParentNode`,
     the walk `UpdateAncestorState` makes) and on the control of each `<label>` among them, so
     `:hover` matches exactly the elements a real pointer there would make match (Research);
   - skips any element that already has a `:hover` lock (`hasPseudoClassLock`), and remembers
     the elements it locked, by weak reference, so that its release clears only its own locks
     and never a DevTools "force element state" set before the hover. The other orders cannot
     be told apart, because a lock is one bit per state, not a count (experiment X3): a
     DevTools lock added on an element Vimma already locked is cleared by Vimma's release, and
     DevTools' "clear" removes Vimma's lock while Vimma still reports the hover. Both are
     accepted as Limits, since they need DevTools open on the same element and the same state;
     DevTools' `:hov` panel may also show Vimma's locks as forced states;
   - dispatches, in the order a pointer entering the element gives them (experiments F and X3):
     `pointerover` on the element, `pointerenter` on each newly hovered element from the outermost
     down, `pointermove` on the element, then `mouseover` on the element, `mouseenter` likewise,
     then `mousemove` on the element. Every event is built with the page's constructor
     (`PointerEvent` or `MouseEvent`) at the centre of the element's first visible box (the point
     `#press` uses) as `clientX` / `clientY`, with `buttons: 0`, `button: 0`, `view` the element's
     window, `composed: true`, `bubbles` and `cancelable` as the event type defines them,
     `relatedTarget` the previously hovered element when it is in the same document, else `null`
     (React derives `onMouseEnter` from `mouseover`'s `relatedTarget`), and for the pointer events
     `pointerType: "mouse"`, `pointerId: 1` and `isPrimary: true`, because menu libraries ignore
     pointer events of other types and open sub-menus on `pointermove`. Elements that were already
     hovered by the previous hover (the common ancestors) get no enter event, as with a real move;
   - in a frame, has the child of each ancestor frame lock the `<iframe>` element's chain in its
     own document, since a real hover in a subdocument hovers its embedder too (decision 12).

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

3. **Trusted for the user, untrusted for an agent, decided by the message.** The two paths are
   separate operations on separate messages, as a click's are (`Vimma:ActivateHint` versus
   `Vimma:AgentElement`, M26), so that the trust follows from which message arrived and never
   from a flag in its data:
   - **The user's hover** is `Vimma:Hover` (`hover`, `release`), which the parent sends only for a
     hint label typed in chrome, for `hover.release` and for the release triggers of decision 5. Its
     handler in `VimmaChild` calls `actors/hover.mjs` with trusted dispatch: the events come from
     the actor, which makes them trusted (`EventDispatcher.cpp:1491-1504`), as a real pointer's are
     and as the user's `f` already does.
   - **An agent's hover** is an op of `Vimma:AgentElement` (`hover`, `hover-release`), which
     the parent sends only from `agent-hover` after the gate. `AgentPage` (`agent-page.mjs`)
     handles it and dispatches the events through `dispatchAsPage` (`page-events.mjs`),
     untrusted, exactly as M26 requires for an agent's `mouseover`. `hover.mjs` takes the
     dispatch function as an argument from its two callers; it has no trust option of its own.
   - **The embedder relay** (decision 2) carries no events and so no trust (decision 12).

   Consequences:
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

5. **How long the user's hover holds.** It does not time out, because a revealed menu is often
   read slowly, and a hover that vanished after a delay would make `f` race it. Whether a click
   releases it is open question 4. Each of these **must** release it, for the reason given:
   - **`Esc`** in normal mode, after the page had the key and left it alone: `resolveEscape`
     gains a `hovering` input and, while a hover is held, returns `hover.release` instead of
     `page.stop`, keeping `afterPage` and `blur`, so `Esc` stays one key that also takes focus
     off a link or button, the first `Esc` ends the hover and the second stops a loading page.
     A page that consumes the key (a script menu that closes itself and calls
     `preventDefault`) gets no after-page action from Vimma, as today, so the hover holds and a
     second `Esc` releases it.
   - **The next `hint.hover`** in the same tab, which moves the hover (the release and the new
     hover share their common ancestors, as a real move does: decision 2).
   - **Every `pagehide`** of the hovered document or of a document of its embedder chain,
     `persisted` or not: the child removes its own locks there and dispatches no leave events,
     since the page is going away. Reason: a document kept in the back-forward cache keeps its
     elements and so its locks (experiment X1); without this, going back would show a hover
     that no key could end.
   - **The selected tab changing**, by a tab switch, a workspace switch or focus moving to
     another split pane, because the status segment (decision 8) follows the selected tab, and
     a hover the user cannot see, or sees in a pane with no segment, would come back
     unexplained. Rejected for split panes: keeping the hover and showing a segment per pane,
     because the status bar shows one tab.
   - **The tab moving to another window**: the hover is released before the tab is adopted,
     because chrome's per-tab hover state lives in the old window's state.
   - **A real mouse move**: a trusted `mousemove` that the actor did not dispatch, seen by the
     child's system-group listener, whose `screenX` / `screenY` differ from those of the last
     trusted `mousemove` the child saw. Firefox's own moves after a scroll or reflow send no
     DOM `mousemove`, and repeat the recorded position anyway (Research; experiments X2, X2C),
     so `j` with the mouse resting over the page, or the reflow the hover itself causes, never
     releases it. Reason: the user has taken the pointer, and two hovered elements would
     confuse both them and the page.
   - **The element leaving its place** (decision 13).
   - **`:hover_release`** (`hover.release`, config name `hover_release`, unbound), for configs
     and the command line.

   When no child can report, chrome clears its per-tab hover state (what `resolveEscape` and
   the status bar read) itself: the tab discarded or closed, its content process ending, and
   the actor's `didDestroy`; the page's locks go with its process or document there. A window
   closing is the same case for each of its tabs.

6. **Release mirrors the hover.** The child removes its own locks (decision 2) and dispatches,
   with the same trust as the hover, `pointerout`, `pointerleave` (innermost first), `mouseout`
   and `mouseleave` on the elements that stop being hovered, so that script menus close as they
   would when the mouse leaves. A user's release over a link clears the link preview. An element
   the page removed in the meantime gets no events, but its own lock is still removed, because
   the lock is a property of the element that survives removal and re-insertion (experiment
   X3), and a framework that re-inserts or recycles the node would otherwise show a hover
   nobody holds; its ancestors still in the document get their events. The embedder chain
   (decision 12) is unlocked in the same release.

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
   - a hover of the element already hovered (by this connection or, for `;h`, by the user)
     sends no enter or leave events and changes no lock: only one `pointermove` and one
     `mousemove`, as a mouse moved within the element would. This makes a repeated call leave
     the page as the first one did, which the idempotent annotation claims, even on a page whose
     `mouseenter` toggles state;
   - annotations: not read-only, **not destructive**, idempotent (above), open-world, because a
     hover changes what the page shows but sends nothing a click would;
   - it is gated, asked, granted, rate-limited and logged as `vimma_activate` is (open
     question 5): `AGENT_TOOLS` gains `agent-hover: vimma_hover`; it shares `ACT_RATE`; it is
     denied with `in-use` while the user is using the tab (F27), before the question, after the
     yes and before the hover; each call is a `:mcp log` row naming the element; a navigation
     the page starts during the step takes an `OPEN_RATE` slot and a form submission the page
     tries is stopped (F11, F16), as after a click;
   - the hover is the connection's: it is released by its next `vimma_hover` in the tab,
     `release: true`, every `pagehide` (the back-forward cache included, decision 5), the
     element leaving its place (decision 13), the tab leaving the agent workspace, being
     discarded or closed, its content process ending, the user starting to use the tab, and the
     end of the connection. A later `vimma_activate` does not release it (open question 4);
   - existing grants cover it: since one grant covers every grantable tool of its connection
     (mcp-grants G1), a grant given before `vimma_hover` existed lets that connection hover
     without a new question once Vimma has the tool. This is accepted because a hover does a
     subset of what an untrusted click's events do (Security), and the changelog line of sub-PR
     2 says so.

10. **What `vimma_elements` lists for a hover.** `vimma_elements` lists what can be clicked, as
    today. A new `kinds` value `hover` asks also for the hover-only targets of decision 4
    (listener elements, `title`, `aria-haspopup`, text blocks), with the kind `hover`, so the
    default list does not grow by every paragraph on screen for every task (open question 6).
    `vimma_hover` accepts a label of either kind.

11. **No new Firefox patch.** `InspectorUtils` and `flattenedTreeParentNode` are available to
    the content actor as chrome code, and the events are ordinary DOM events, so the feature
    needs no change to Firefox.

12. **Frames: the embedder chain gets locks only, through a relay keyed by browsing context.**
    When the hovered element is in a subframe, the subframe's child reports the hover to its
    parent actor, and the parent sends `Vimma:HoverEmbedder` (`lock` or `release`) to the actor
    of the subframe's parent window global, naming only the subframe's browsing context id,
    which the parent takes from the actor that reported (`this.browsingContext` of the
    `JSWindowActorParent`), never from data the subframe sent. The embedding child resolves
    the id with `BrowsingContext.get`, checks that its `parent` is its own browsing context and
    that its `embedderElement` is in its own document, and locks that `<iframe>` element and
    its flattened-tree ancestors as decision 2 does, remembering them as part of the same
    hover; then it relays further up the same way. Reasons and details:
    - A real pointer over a subframe hovers the `<iframe>` element too: in process through the
      parent document's state manager (`NotifyMouseOver` uses `GetInProcessParentDocument`,
      `EventStateManager.cpp:5697-5711`), and out of process because the parent process's hit
      test puts the pointer over the `<iframe>` element in the embedder's own document
      (experiments X3 and X4 checked both).
    - The embedder chain gets **no events**, only locks. A real pointer would also send it
      `mouseover` and `mouseenter`, but pages rarely act on hovering their own `<iframe>`, and
      without events the relay carries no trust choice that a compromised subframe could
      influence; the subframe's page still gets the full event sequence of its path.
    - The embedder locks are released with the hover, on the subframe's `pagehide` (the parent
      sees the subframe's actor go and relays a release), when the `<iframe>` element leaves
      its document (decision 13), and on the embedder's own `pagehide` (decision 5).

13. **The hovered element leaving its place ends the hover.** The child watches the hovered
    element with a `MutationObserver` on its document (`childList`, `subtree`) and, on any
    mutation batch, checks that the element is still connected, in the same document, and
    that its flattened-tree ancestor chain is the one it locked. When not, it releases the
    whole hover (decision 6) and reports it, so that the status bar and an agent's `changed`
    never claim a hover that no longer exists. This covers:
    - a framework re-render that **replaces** the node (the new node has no lock), and a
      virtualized list that **recycles** it (Discord's channel list reuses row nodes on scroll,
      so the same node may now show another row);
    - a node **moved** to new ancestors (the old ones stay locked, the new ones are not);
    - a node **adopted** into another document: the lock property is not transferred, since it
      is set without a transfer function (`Element.cpp:693`) and adoption removes such
      properties (`TransferOrRemoveAllPropertiesFor`, `dom/base/nsINode.cpp:4353`; checked in
      experiment X3), while the embedder locks would remain.
      Rejected: re-locking the new node, because Vimma cannot tell that a new node is "the same"
      element, and a recycled node is another one.

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
  over the page, both elements match `:hover` until it moves (which releases Vimma's, decision
  5).
- DevTools: a `:hover` forced on an element after Vimma locked it is cleared by Vimma's
  release; DevTools' "clear" removes Vimma's lock while the status bar still shows the hover;
  the `:hov` panel may list Vimma's locks (decision 2).
- A hovered element that the page replaces, recycles, moves or adopts ends the hover (decision
  13): in a virtualized list, scrolling far enough to recycle the hovered row ends it.
- The embedder chain of a hovered subframe gets `:hover` but no events (decision 12).
- `vimma_screenshot` of an agent tab shows the locked hover state, so an agent can see what a
  hover revealed; the tool's description and the instructions sentence say so.

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
  already tell (M26). Vimma removes only locks it added, so a DevTools forced state set before
  the hover survives; the reverse orders are a Limit (decision 2).
- **Messages** (decision 3). `Vimma:Hover` (`hover`, `release`) is the user's only: the parent
  sends it for a hint label typed in chrome, `hover.release` and the release triggers, and its
  handler dispatches trusted events. An agent's hover is the `hover` and `hover-release` ops of
  `Vimma:AgentElement`, sent only from `agent-hover` after the gate and handled by `AgentPage`
  (`agent-page.mjs`) with `dispatchAsPage`; no message data chooses the trust, so an agent can
  never reach the trusted path. `Vimma:HoverEmbedder` carries no events and names the subframe
  by the browsing context the parent took from the reporting actor, which the embedding child
  checks is its own child frame (decision 12), so a subframe cannot make its embedder lock an
  element of its choosing. A page can send none of these messages. Each child acts only for the
  current hint `gen` or the connection's current list, only in the frame asked, and refuses
  malformed data, as `Vimma:ActivateHint` and `Vimma:AgentElement` do.
- **Speculative connections.** A trusted `mouseover` on a link reaches
  `nsDocShell::OnOverLink`, which on an `http:` page (and on an `https:` page only with
  `network.predictor.enable-hover-on-ssl`, default `false`,
  `modules/libpref/init/StaticPrefList.yaml:15497-15500`) opens a speculative connection to the
  link's host before setting the link status (`docshell/base/nsDocShell.cpp:12809-12822`). The
  user's hover can therefore make a DNS lookup and a connection to the hovered link's host, as
  a real mouse and the user's `f` already do. An agent's hover, untrusted, never reaches it
  (`CheckHandleEventForLinksPrecondition`).
- **Grants.** Existing grants cover `vimma_hover` once it exists (decision 9, mcp-grants G1),
  which is accepted because it is a subset of a click's untrusted events.
- **No ghost locks.** A lock is a property of the element and survives the back-forward cache,
  removal and re-insertion (experiments X1 and X3), so every way a hover ends removes Vimma's
  locks itself (decisions 5, 6, 12 and 13), the back-forward cache included; and chrome's
  per-tab hover state is cleared when no child can report (a crash, a discarded tab, the
  actor's `didDestroy`).
- **Agent tabs only.** `agent-hover` acts only in a tab that passes `isAgentTab`, before the
  question, after the yes and before the hover (F27); the user's hover works in any tab.
- **Read surface.** The element's text in the status bar and in the `:mcp log` row is page text
  already readable with `vimma_read_page`; it is shown as untrusted text.
- **docs/security/12-agents-mcp.md** gains a rule (the next number, M64) with sub-PR 2:
  - an agent's hover **must** be the `hover` op of `Vimma:AgentElement`, handled by `AgentPage`
    with untrusted events through `dispatchAsPage`, never `Vimma:Hover`, never input through
    `window.synthesizeMouseEvent`, `nsIDOMWindowUtils` or the widget, and never wrapped in
    `setHandlingUserInput` or `asUserGesture`;
  - it locks `:hover` only on an element of the connection's current list, its flattened-tree
    ancestors, the controls of `<label>`s among them and its embedder chain, only in agent
    tabs, and Vimma removes only the locks it added;
  - the embedder relay names the subframe by the browsing context of the reporting actor,
    checked by the embedding child, never by data from the subframe;
  - it is released on every `pagehide`, the back-forward cache included, on the element leaving
    its place, on the tab leaving the agent workspace, on the user starting to use the tab, and
    on the connection's end;
  - it is denied while the user uses the tab and shares `ACT_RATE`; existing grants cover it.

  Sub-PR 2 gets a fresh security review.

## Tests

Written first; red pasted, then green.

- **Vitest (core)**:
  - `hints.test.ts`: `hint.hover` accepted by `startHints`; `parseHintReply` takes `kind:
"hover"` with each sub-kind and refuses an unknown one; ordering of overlapping hover
    targets.
  - `escape.test.ts`: in normal mode with `hovering: true`, `Esc` resolves to `hover.release`
    with `afterPage` and `blur`; without it, `page.stop` as today; a pending key still cancels
    first. (That a page which consumes `Esc` keeps the hover is a mochitest, 5.)
  - `statusbar.test.ts`: the `hover · <text>` and `agent hover · <text>` segments, truncation
    at 40 columns, control characters dropped, and that the segment gives way before the URL;
    the live-region text "hovering <text>" for a hover and none for a release.
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
  2. `test_hover_runs_script_menus`: a `mouseenter` menu, a React-style `mouseover` menu and a
     `pointermove` sub-menu that ignores other pointer types open; the page's listeners see
     `pointerover`, `pointerenter`, `mouseover`, `mouseenter`, `pointermove`, `mousemove` in
     that order, trusted, with `pointerType: "mouse"`, `isPrimary`, the element's centre and
     `relatedTarget` the previous hover target. Hovering the same element again sends only
     `pointermove` and `mousemove`.
  3. `test_hover_then_f_follows_a_revealed_control`: after the hover, `f` labels the gear and
     its label clicks it; the row is still hovered after the click (or released, per open
     question 4).
  4. `test_hover_holds_while_scrolling`: with the pointer resting over the page (a synthesized
     `mousemove` before the hover), `j` scrolls by a row and the same row stays hovered; the
     hover's own reflow (the gear appearing) and a page reflow under the pointer do not
     release it.
  5. `test_hover_release`: each of these removes `:hover`, fires the leave events (none for a
     `pagehide`) and clears the status segment: `Esc` (page loading: not stopped; a second `Esc`
     stops it; focus is blurred), another hover, a navigation, a tab switch, a workspace
     switch, focus moving to another split pane, the tab moving to another window, a real
     mouse move to another point, and `:hover_release`. A page that consumes `Esc` keeps the
     hover and a second `Esc` releases it. A discarded tab and a crashed content process
     (`BrowserTestUtils.crashFrame`) clear the status segment and `resolveEscape`'s
     `hovering`.
  6. `test_hover_bfcache`: hover, navigate to a page that keeps the first in the back-forward
     cache, go back (`pageshow` with `persisted`): the row does not match `:hover`, has no lock,
     and the status bar shows no hover; the same in a frame, for the embedder chain.
  7. `test_hover_target_leaves`: the page replaces the hovered node, recycles it into another
     row, moves it under another parent, and adopts it into a same-origin frame: each ends the
     hover, no element keeps a Vimma lock, and the status segment goes.
  8. `test_hover_changes_nothing_else`: no focus, no selection, no click, and
     `navigator.userActivation.hasBeenActive` stays false.
  9. `test_hover_keeps_devtools_locks`: an element locked by `InspectorUtils` before the hover
     keeps its lock after the release.
  10. `test_hover_link_preview`: a user hover on a link shows its URL in the link preview and
      the release clears it.
  11. `test_hover_shadow_dom_and_labels`: a target in an open and in a closed shadow root and a
      slotted element hover their host (`:host(:hover)` applies); hovering a `<label>` hovers
      its control.
  12. `test_hover_in_frames`: in a same-origin and in a cross-origin frame, the frame's element
      and the `<iframe>` element's chain in the top document match `:hover`, the `<iframe>`
      gets no events, and both are released; removing the `<iframe>` and the subframe's
      `pagehide` release the embedder locks.
  13. `test_hover_malformed_messages`: `Vimma:Hover` with a stale `gen`, an unknown `op`, a
      frame not asked, `null` is refused; `Vimma:HoverEmbedder` naming a browsing context that
      is not the receiver's child frame is refused.

  Mutation checks to run and paste with sub-PR 1: ancestor locks off (test 1 fails), the
  `hasPseudoClassLock` check off (test 9 fails), the trusted dispatch swapped for
  `dispatchAsPage` (test 10 fails), the `pagehide` release off (test 6 fails), the
  synthesized-move filter off (test 4 fails).

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
  6. `test_agent_hover_release`: `release: true`, the next hover, a navigation, a return
     through the back-forward cache (no lock left), the tab leaving the agent workspace and the
     connection's end release it.
  7. `test_agent_hover_rate`: hovers and clicks share 30 a minute.
  8. `test_agent_hover_is_a_separate_message`: an agent's hover arrives as
     `Vimma:AgentElement` and never sends `Vimma:Hover`; its embedder relay locks only the
     reporting frame's `<iframe>`.
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
  - "Added: `vimma_hover`, an agent tool that hovers an element in the agent workspace; a
    grant an agent already holds covers it."
  - With sub-PR 3: "Added: `;h` hovers an element."
  - "Added: e2e baseline `hover.png`."

## Delivery

| #   | PR                                                      | Contents                                                                                                                                                                                                                                                         | Size     |
| --- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | `feat(hints): hover an element with a hint`             | `hint.hover` and `hover.release`, **unbound** (reachable as `:hover_element` and through config); `collectTargets` `hover` option; `actors/hover.mjs` (locks, events, frames, release); `Vimma:Hover`; `Esc`, status segment, release triggers. Mochitests 1-13. | M (~800) |
| 2   | `feat(mcp): vimma_hover hovers an element for an agent` | `agent-hover`, `vimma_hover`, `vimma_elements` kind `hover`, gate, rate, `in-use`, log; M64; instructions; agent mochitests 1-8. Fresh security review.                                                                                                          | M (~700) |
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
   - `zh`: free in normal mode, but it would sit beside the PDF viewer's `z` prefix (`zz`, `zZ`,
     `z0` in `[modal.pdf]`); no mnemonic.
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
