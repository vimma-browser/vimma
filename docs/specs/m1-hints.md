# Spec: m1-hints

Status: implemented · Milestone: M1 · Area: actors
(`src/browser/base/content/vimma/actors/`), host (`host/VimmaHost.sys.mjs`), ui
(`ui/hint-overlay.mjs`). Builds on [m1-actor-insert-scroll](m1-actor-insert-scroll.md) (the
actor pair) and [m1-core-logic](m1-core-logic.md) § Hints (labels, order, keys).

## User story

As a user, `f` puts a short label on everything I could click in the page on screen. Typing a
label follows the link, presses the button, or focuses the text field (and I am in insert).
`F` does the same for links only and opens the link in a new tab in the background. `Backspace`
takes back a key and `Esc` leaves hint mode. The page cannot tell that hints were shown.

## Scope

- `actors/hint-collect.mjs`: target collection in one frame (content process).
- `actors/VimmaChild.sys.mjs`: `Vimma:CollectHints` and `Vimma:ActivateHint`.
- `actors/VimmaActors.sys.mjs`: `collectHints` (merges frames), `activateHint`,
  `openInBackground`, `cancelHints`.
- `packages/vimma-core/src/hints.mjs`: `parseHintReply` and `HINT_REPLY_MAX_*`, the strict
  check of a collection reply (unit tests in `test/hints.test.mjs`).
- `ui/hint-overlay.mjs`, `themes/shared/vimma/hints.css`: labels drawn in chrome.
- `host/VimmaHost.sys.mjs`: `hint.follow` (`f`), `hint.follow_new_tab` (`F`), `hint.cancel`
  (`Esc`, the dispatcher's `hint` mode); every other key in hint mode goes to core `hintKey`.
- Charset `asdfghjkl` (core `DEFAULT_HINT_CHARS`); `[modal] hint_chars` waited for config (M5),
  which now hands it to the host (`VimmaHost` `settings.hintChars`).

## Tests (written first)

`tests/browser/browser_vimma_hints.js`, fixtures `file_vimma_hints.html` (every kind of
target, a link under a fixed header, links below the fold, an open shadow root),
`file_vimma_hints_frame.html` (cross-origin iframe from `example.org`) and
`file_vimma_hints_many.html` (2,000 links, `?dense` puts all of them in the viewport):

- `f` labels the 10 visible targets, one label each, prefix-free, all drawn in chrome; the
  covered link, the off-screen ones, plain text and a `visibility: hidden` link get none.
- A label follows the link (the location changes); one in the cross-origin frame navigates the
  frame only; one in a shadow root follows too.
- A label on a button or on a span with a click listener clicks it; mode stays normal.
- A label on an input focuses it and the tab enters insert (`j` then types).
- `F` labels the 6 links only; a label opens a background tab with that URL, in the same
  container, and the tab itself stays.
- Typing the first key of the two-key labels leaves only those; `Backspace` brings all back;
  `Esc` removes the labels, mode is normal, and the page saw none of the keys.
- A MutationObserver in the page (document and shadow root, subtree, attributes) records
  nothing through `f`, a filter key and `Esc`; nothing with `vimma` in its id or class.
- `f` on a page with no targets stays in normal and the next key reaches the page.
- A cross-origin frame whose process spins for 3 s does not hold up the labels: they show in
  about 200 ms (assert < 1,500 ms) without the framed link, and a label still follows.
- At 150 % page zoom each label's chrome-space left and top match its target's content rect
  times 1.5 (within 1.5 px).
- Two windows collecting at once both get their targets (the live collection is per window).
- 2,000 links: collection round trip under 1,000 ms all on screen and 250 ms down a long page
  (generous, against an order-of-magnitude regression; numbers under Performance), drawing the
  labels under 1,000 ms, all drawn, at most 4 keys each.

Red: before the implementation, all 10 tasks failed (`VimmaHost._hints is not a function`).
Mutation check: with the occlusion check off in `hint-collect.mjs`, the first task fails
(`11 == 10`, `covered has no label - "s" == "undefined"`) and so does `F` (`7 == 6`);
reverted.

Hardening. Red: the busy frame held the labels for 2,942 ms and they
included its link (`10 == 9`); two windows collecting at once voided the first
(`the first window got its targets - 0 == 10`); `parseHintReply` accepted duplicate frame ids
and a negative `ms`. The zoom task passed at once, so it was mutation-checked: without
`* zoom` in `hint-overlay.mjs` it fails (`button: label left - 92.7 <= 1.5`, three more);
reverted.

## Settled (2026-10-09, from the engine tree, Vimium and Tridactyl)

- **Collection in the child, per frame.** Each frame's `VimmaChild` collects in its own
  document, starting from one hit test over the viewport: `windowUtils.nodesFromRect` (an
  area version of `elementsFromPoint`). For event delivery every painted frame gets an item of
  its own, so each box's element is in the list, and the list is not retargeted, so elements in
  open and closed shadow roots are too. Off-screen, `display: none`, `visibility: hidden`,
  scrolled-away and `pointer-events: none` elements never reach the costlier checks. The first
  version walked every element of the document and its shadow roots; on a long page with 91 of
  2,000 links on screen the child went from about 25 ms to 2 ms idle. Candidates among the
  elements on screen:
  - _By what they are_ (the vocabulary of Vimium's `LocalHints` clickable check and Tridactyl's
    `HINTTAGS_selectors`; no code copied): `a[href]`, `button`, `input` (not hidden), `select`,
    `textarea`, `summary`, contenteditable roots.
  - _By behaviour_: `label`, `[onclick]`, `[onmousedown]`, `[tabindex]` ≥ 0, ARIA widget roles
    (`button`, `link`, `checkbox`, `radio`, `switch`, `tab`, `menuitem*`, `option`,
    `treeitem`, `combobox`, `textbox`, `searchbox`), and any element with a `click` or
    `mousedown` listener. Extensions cannot see listeners (Tridactyl wraps `addEventListener`
    in the page to find them); our privileged child asks `Services.els.hasListenersFor`
    (nsIEventListenerService, as devtools' event collector does), so nothing is injected into
    the page. `html` and `body` are never targets (React and jQuery delegate there). A
    behaviour target inside another target is dropped (a link's inner span), and a label whose
    control is itself shown is dropped (one hint per control). (Since changed: an element that
    is a target only by a listener or a non-negative `tabindex` gets no label when it holds a
    target its markup declares (a role, `label`, `onclick` or `onmousedown`), and does not hide
    those, so a menu's item list with a click listener no longer swallows its entries (#329);
    described in `actors/hint-collect.mjs`.)
  - Not used: `cursor: pointer`. It needs a computed style for every element on screen, which
    is a large share of the budget with 2,000 on screen; left out of the prototype, so
    delegated click handlers without a role stay unhinted (Limits).
- **Visible and in the viewport.** On screen per the hit test above; not `disabled`; the
  first client rect that meets the viewport (an inline link that wraps gets its first line on
  screen), clipped to it; and not covered: `elementFromPoint` (on the element's own document or
  shadow root) at the centre and at four inner corners must hit the element or a descendant. A
  fixed header, a cookie banner or a modal covers what is under it. The area hit test cannot
  replace this: with `onlyVisible` it drops an item only when one opaque item covers the whole
  queried area (`nsDisplayList.cpp`, `mHitOccludingItem`), so for the viewport it drops nothing.
- **Frames.** The child reports its visible `<iframe>`/`<frame>` elements as
  `{ browsingContext id, content-box rect }`. The parent queries those frames' children (in
  their own processes for cross-origin frames), offsets their rects by the frame's origin and
  clips them to the frame's visible rect. So same-origin and cross-origin frames work alike, up
  to 8 levels deep and 64 frames per document, each frame at most once. A subframe that has
  not answered in 150 ms (`vimma.hints.frameTimeoutMs`) is left out and the others' labels
  show: a busy or hung frame process (a 3 s loop, tested) no longer holds hint mode, and the
  keys typed meanwhile, for seconds. The top frame gets 2 s. The live collection is per window,
  so `f` in one window does not void another window's collection in flight.
- **Rendering in chrome.** The labels are a `<div id="vimma-hints">` appended to the tab's
  `.browserStack` (a XUL stack, so the layer covers exactly the `<browser>`, also in split
  view), `pointer-events: none`, `overflow: hidden`. Rects go from content to chrome CSS pixels
  by the browser's `fullZoom`, read in the parent. The page cannot see, style, move or remove
  the labels, and a MutationObserver sees nothing (tested). A shadow-root overlay injected into
  the page was the alternative: the page can detect it (layout, `elementFromPoint`, focus)
  and break it with its own CSS (`all: initial` on `*`, `z-index` wars); we drop it.
  Colours: `--vimma-hint-bg` / `--vimma-hint-fg` (m5-core-config-and-theme) with Tokyo Night's
  yellow as the fallback until M5 sets the tokens.
- **Messages.** `Vimma:CollectHints { gen, linksOnly }` → `{ targets: [{ id, rect, kind,
href? }], frames: [{ id, rect }], ms }`, and `Vimma:ActivateHint { gen, id }`. Both are
  queries the parent sends to a frame it chose; the child never starts a hint message, so the
  focused-frame rule of focus reports (m1-actor-insert-scroll) has no counterpart here: each
  reply comes from the frame that was asked. The parent runs every reply through core
  `parseHintReply` (`hints.mjs`, the counterpart of `parseDescriptor`), which returns a fresh
  copy with only the known fields or null, and never throws: caps of 5,000 targets, 64 frames
  and 8 KiB per href (`HINT_REPLY_MAX_*`, which the child also applies to its own reply, so a
  page with 65 frames loses its 65th, not all of them), unique non-negative integer ids,
  finite rects with positive size and coordinates under 10^6, `kind` in
  `link`/`input`/`click`, `href` a string (an SVG `<a>` sends none). A null reply drops that
  frame. A reported frame id is taken only when that `BrowsingContext`'s parent is the frame
  that reported it. Labels are made in the parent; content supplies only rects, so the worst a
  page can do is put labels in odd places inside its own content area. An activation goes to
  the target's frame only if that frame still has the same `WindowGlobalParent` as at
  collection; the child acts only if `gen` is its last collection's, and forgets the
  collection after one activation.
- **Activation in the child.** A text field (core `isEditable`, the same rules as insert)
  gets `focus()`, and the actor's `focusin` report enters insert. A `select` gets focus and
  `showPicker()` (which may need activation; Limits). Anything else gets `mouseover`,
  `mousedown`, `mouseup` (created by privileged code, so trusted) and `click()`, whose
  activation behaviour follows links (SVG elements, which have no `click()`, get a click
  event). `windowUtils.sendMouseEvent` would be a real pointer
  click, but Firefox 157 no longer has it outside tests.
- **`F`.** Links only (`a[href]`). The parent opens `href` with `openLinkIn(url, "tab",
{ inBackground: true })`, as the context menu's "Open Link in New Tab" does: the frame's
  document principal triggers the load, after `checkLoadURIWithPrincipal`, so a page cannot
  open what it could not link to; `http:`, `https:` and `file:` only (not `blob:`, `data:` or
  `javascript:`); same container
  (`userContextId`) as the tab; the frame's URL as referrer. Background always: plan §2 says
  "in new tab", and Tridactyl's `F` (`hint -b`) opens in the background too, so several links
  can be collected without leaving the page.
- **Host.** `f`/`F` set hint mode at once and keep keys typed while the children collect,
  then replay them. With no targets, back to normal (the status bar will say "no links", M2).
  Hint mode is modal: every key is a label key or ignored, never the page's. Another binding
  (a `ctrl+b` sequence) leaves hint mode first. A tab switch, a window resize, a mouse click in
  chrome or focus leaving the page leaves hint mode.
- **Performance** (lane, 16 threads, headless, 2026-10-09; the machine shared with other
  lanes' builds, load average 12-22, so only same-run comparisons mean much). Child time /
  round-trip median over 5 runs, 2,000-link fixture:

  | Case                  | Idle          | Two busy CPUs (`taskset -c 0,1`, 4 spinning loops)   |
  | --------------------- | ------------- | ---------------------------------------------------- |
  | 91 of 2,000 on screen | 1.4 / 3 ms    | 3-28 / 10-29 ms (first version: 51-99 / 53-112 ms)   |
  | 2,000 all on screen   | 30 / 40-48 ms | 74-280 / 95-400 ms (first version: 65-126 / 108-251) |
  | Drawing 2,000 labels  | 17-21 ms      | 170-350 ms                                           |
  | Drawing 91 labels     | 1.5 ms        | 8-25 ms                                              |

  So the 50 ms target holds for a screenful of links even under load. 2,000 hintable targets
  all on screen is the extreme case: the cost is per target (a client rect and an
  `elementFromPoint` each, about 10 µs idle through privileged wrappers), and it stays at
  about 30 ms idle, several times that on a starved CPU. Labels are plain text until a key is
  typed, and the layer has `contain: strict`.

## Limits

- Labels are drawn for the layout at `f`: a page that scrolls or moves itself while they show
  leaves them stale (a key or `Esc` still works on the targets).
- Delegated click handlers on elements with no role, tabindex or listener of their own (some
  React apps) get no hint; no `cursor: pointer` heuristic.
- Canvas and WebGL apps (Google Docs, Figma, maps, games) draw their own controls: there are no
  elements to hint.
- Image-map `<area>` links get no hint (no box of their own).
- Frames inside a CSS-transformed or zoomed `<iframe>` get misplaced labels (offsets assume no
  transform); a frame covered by a fixed element in its parent is clipped, not occlusion-checked.
- A `select` may not open from a hint (no user activation for `showPicker`); it has focus, so
  `Alt+Down` opens it.
- Pinch zoom (the visual viewport) is not accounted for.
- A frame that takes more than 150 ms to answer (a busy page, a slow process) gets no labels
  that time; press `f` again once it is idle.
- `F` opens `http:`, `https:` and `file:` links only: `blob:` links (downloads made by the page)
  need `f`.
- With thousands of targets on screen, labels take a few hundred ms on a starved CPU.

## Out of scope

Yank-link and focus-input hint modes, `[modal] hint_chars` (M5 config, since built), the "no links"
notice (M2 status bar), hints in pages without our actor (extension pages, `data:`).
