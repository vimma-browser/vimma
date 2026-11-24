# Spec: scroll area

Status: implemented · Area: `packages/vimma-core/src/page/scroll-areas.mjs` (new),
`keys/actions.mjs`, `config/defaults.mjs`, `ui/statusbar.mjs`; `actors/page-scroll.mjs`,
`actors/hint-collect.mjs`, `actors/VimmaChild.sys.mjs`, `actors/VimmaActors.sys.mjs`;
`host/scroll-area-ops.mjs` (new), `host/runners.mjs`, `host/VimmaHost.sys.mjs`,
`host/VimmaParent.sys.mjs`; `ui/hint-overlay.mjs`, `themes/shared/vimma/hints.css` · Upstream
patches: none · ADR: none. Changes the scroll target rule of
[m1-actor-insert-scroll](m1-actor-insert-scroll.md).

Issue: [#1526](https://github.com/vimma-browser/vimma/issues/1526)

## Summary

Pages built from several scrolling panels (Confluence's page tree beside the page, mail clients,
chat apps, documentation sites with a scrolling sidebar) get a way to choose which panel the
scroll keys move. `gs` moves the scroll keys to the next scroll area and `gS` to the previous one,
with a count picking the Nth; a click, or a link followed with `f`, picks the area under it. The
chosen area is outlined for a moment, and the status bar says `scroll area` while the keys move
an area other than the page's own.

## Problem

The scroll target was fixed by a rule ([m1-actor-insert-scroll](m1-actor-insert-scroll.md),
"Scrolling"): the scroller around the focused element, else a fixed layer over the page, else the
document, else the largest visible scrollable element. In a page of panels nothing takes focus,
so the largest panel always won: on Confluence, `j` scrolled the page and nothing reached the
page tree. A mouse click on the tree did not help either, because a click on plain text moves no
focus.

## Behaviour

1. `gs` (`scroll.area_next`) moves the scroll keys to the next scroll area in reading order, and
   from the last back to the first; with two areas, it switches between them. `gS`
   (`scroll.area_prev`) goes the other way. A count picks the Nth area from the first, whichever
   the key: `2gs` is the second area. A count past the last area changes nothing.
2. Every scroll key follows the chosen area: `j`, `k`, `h`, `l`, `d`, `u`, `ctrl+d`, `ctrl+u`,
   `ctrl+e`, `ctrl+y`, `gg` and `G`. On an axis the area cannot scroll, the nearest scroller
   around it that can takes the key, else the default rule.
3. A user's click, and a link followed with `f`, make the scroll area under that point the
   target: the nearest area around it (decision 2), else the page. A click in a smaller
   scroller, such as a code block, leaves the keys on the area around it. An agent's click (MCP
   `vimma_activate`, the built-in agent) does not move the target.
4. The chosen area stays the target until another `gs` or `gS`, a click elsewhere, a new
   document, or the area leaving the page; then the default rule applies again.
5. The chosen area gets a two-pixel outline in the theme's accent for 600 ms, drawn in chrome
   over the page.
6. The status bar shows `scroll area`, in the theme's accent, while the scroll keys move an area
   that `gs` or a click chose and that is not the one the default rule would pick in the top
   document. An area in a frame always shows it.
7. An area inside a frame, same-origin or cross-origin, is cycled too, and choosing it moves
   focus into that frame; choosing an area of the top document takes focus back there.
8. `gs` and `gS` are normal-mode bindings, remappable in `config.toml` like every key.

## Research

- **How Firefox finds what a wheel scrolls.** `EventStateManager::ComputeScrollTargetAndMayAdjustWheelEvent`
  (`engine/dom/events/EventStateManager.cpp`, about line 3605, Firefox 160.0.1) walks up from
  the frame under the pointer to the nearest scroll container whose available directions include
  the wheel's (`GetAvailableScrollingDirectionsForUserInputEvents`) and which can still scroll
  that way (`WheelHandlingUtils::CanScrollOn`), then continues in the parent document
  (`GetCrossDocParentFrameInProcess`). A click picks its area the same way: the nearest ancestor
  that scrolls on either axis, through shadow hosts, then the document.
- **What can scroll.** An element scrolls when `scrollTopMax` or `scrollLeftMax`
  (`Element::ScrollTopMax`, `engine/dom/base/Element.cpp`, line 1043) is above 0 and its
  computed overflow on that axis is `auto`, `scroll` or `overlay`; the document's scroller when
  the page is not scroll-locked. This is `canScroll` in `actors/page-scroll.mjs`, which the
  default rule already used.
- **Other tools.** Vimium scrolls the element the last click landed in, which needs no key;
  Surfingkeys has `;fs`, hints over the scrollable elements. Both are taken from their
  documentation; neither was checked against a particular version's source for this spec.

## Design

1. **`gs` cycles forward and `gS` back, with a count picking the Nth area.** One key switches
   between the two areas most such pages have, and `gs` reads as "go to scroll area"; Vim's own
   `gs` (sleep) has no use in a browser. Rejected: `]a` / `[a` like the other bracket pairs,
   because two keys apart for a toggle is slower and the bracket pairs move between items, not
   targets. Rejected: hints over the areas (Surfingkeys' `;fs`), because with two areas one key
   press is quicker than reading a label; hints can follow if pages with many areas turn out to
   be common.
2. **An area is the document's scroller and every visible element that can scroll and shows at
   least a tenth of the viewport.** A smaller scroller (a code block in the text, a short list) is
   not a panel, and cycling through it would slow every `gs`. A nested scroller with the same box
   as an area around it is left out, because two areas on one box would look like a key press
   that did nothing. The search reads at most 10,000 elements and keeps at most 32 areas per
   frame, so a page cannot make `gs` slow.
3. **Reading order: left to right, then top to bottom, and a containing area before the ones
   inside it.** Panels are laid out side by side, so the order matches what the user sees, and a
   count names the same area each time.
4. **Every scroll key follows the chosen area.** A target that only some keys followed would
   surprise; `gg` and `G` on the tree are as useful as `j`.
5. **A user's click and `f` move the target; an agent's click does not.** A click is how a mouse
   user says which panel they read, so the keys follow it as Vimium's do. The content actor
   takes only a trusted `mousedown` (`VimmaChild`, `mousedown`): a real click, and `f`, whose
   press this actor dispatches from system code. An agent's press is dispatched as the page's own
   script would and is untrusted (`#press`), so an agent never changes where the user's keys
   scroll. The area is the nearest one around the click by decision 2, not the nearest scroller,
   so that a click in a code block or a tab strip does not leave the keys there. It is decided
   after the mousedown's own focus change, since the default rule starts from the focused
   element. A click on the area the default rule picks in the top document clears the choice,
   and so does a click that focused a smaller scroller inside the area (a list box, a widget
   with `tabindex`), so that the default rule (with its focused-element and layer steps) applies
   again; every such click is reported to the parent, so that it also ends a choice held in
   another frame. The actor's `mousedown` listener is registered with `createActor: false`
   (`VimmaActors.register`), so a click in a frame whose actor was never created (one never
   focused) neither picks an area there nor ends another frame's choice; that click focuses the
   frame, and the scroll keys then go to it first anyway.
6. **The choice lives in the frame's `PageScroll`, and the parent keeps only whether there is
   one.** `PageScroll.target` tries the chosen area first; it holds the element weakly and drops
   it once it leaves the document, so nothing in the parent goes stale with the page; an area
   that left the page is noticed at the next scroll key or `gs`, so the marker may show until
   then. The parent (`host/scroll-area-ops.mjs`) keeps, per tab, which document holds a choice,
   for the status bar marker, and forgets it when that document is hidden (`pagehide`, which
   also covers a document kept in the back-forward cache) or goes away. The scroll keys typed
   after `gs` wait for it, and every frame's answer is bounded by the hint collection's
   timeouts, so a frame that does not answer cannot hold them.
7. **Frames through each frame's actor.** The parent asks each frame's actor for its areas and
   its visible subframes (`Vimma:ScrollAreas`), offsets and clips them by the frame rects their
   embedders report, as the link hints do, and orders all of them in the top frame's pixels.
   Choosing an area of a subframe focuses that frame's window, so that the scroll keys, which go
   to the focused frame first, reach it; choosing one of the top document blurs the frame
   element that holds focus. An area in a frame always counts as chosen and shows the marker,
   because the keys reach it only through that frame's focus, which the page or a click can
   move, and the marker says why `j` moves the frame. Cross-origin frames work the same, since every step is the frame's
   own actor.
8. **The outline and the marker are drawn in chrome, in the theme's accent.** The outline is a
   layer beside the hint labels (`ui/hint-overlay.mjs`), so the page can neither see nor restyle
   it, styled with `--vimma-accent` and the background halo the element-focus ring uses, so it
   shows on light and dark pages and follows the Omarchy theme. It goes after 600 ms, because it
   only says where the keys went. The marker is a status bar segment in `--vimma-accent` that
   gives way before the title and the URL, like the hover segment.

## Security and privacy

Two new content-actor messages carry data to the parent, and both are checked there (security
[13](../security/13-page-modes.md), K15). `Vimma:ScrollAreas` replies with rects and booleans
that core `parseScrollAreasReply` copies and caps; a malformed reply drops that frame's areas.
Areas with the same box count once, and which area is chosen is the parent's own record, so a
frame can neither stack copies of a box in the cycle nor claim a choice it does not hold.
`Vimma:ScrollAreaChosen` carries one boolean and changes only its own tab: its status bar
marker, and the choice another document of the tab holds, which a click in any frame ends; only
that document's existing actor is told, so a click messages no other frame. A compromised content
process can at most move where the scroll keys scroll in its own tab, which it could already do
by moving focus, end the user's choice there, or show the marker while nothing is chosen. A
hostile frame can put its own areas, within its visible rect, in the `gs` cycle, and gets focus
when the user's `gs` lands on one, as a click in it would give it. An agent's click never moves the target (decision 5). No
page content reaches the status bar: the marker is a fixed text.

## Tests

- vitest `packages/vimma-core/test/scroll-areas.test.ts`: the reply checks and caps; reading
  order and the tenth-of-the-viewport rule; the current area; `gs`, `gS` and a count; the
  bindings; the status bar segment.
- mochitest `tests/browser/browser_vimma_scroll_area.js` on a two-panel fixture laid out as
  Confluence's (`file_vimma_scroll_area.html`): `j_scrolls_the_larger_panel_and_gs_moves_it_to_the_other`,
  `gS_goes_back_and_a_count_picks_the_nth_area`, `every_scroll_key_follows_the_chosen_area`,
  `a_click_in_a_panel_makes_it_the_target`,
  `a_click_in_a_scroller_too_small_to_be_an_area_keeps_the_page`,
  `a_click_that_focuses_a_small_scroller_keeps_the_keys_on_it`,
  `a_click_messages_no_frame_but_the_one_holding_a_choice`,
  `a_frame_that_never_answers_does_not_hold_the_scroll_keys`,
  `a_frame_that_never_answers_the_pick_does_not_hold_the_scroll_keys`,
  `a_click_the_page_dispatches_does_not_move_the_target`,
  `an_agents_click_in_a_panel_does_not_move_the_target`, `leaving_the_page_ends_the_marker`,
  `a_new_document_starts_from_the_default_rule`, `gs_outlines_the_chosen_area_briefly_in_chrome`,
  `gs_reaches_a_cross_origin_frames_document_and_focuses_it`.

## Docs and changelog

`docs/guide.md` gets a section, "Pages with several scrolling panels", with the keys and the
click rule; "Features at a glance" names
them. `docs/bindings.md`, `docs/bindings.json` and `defaults.toml` are regenerated. The changelog
line comes from the commit (`feat(scroll): ...`).

## Delivery

One pull request: core, the content actor, the host, the docs and the tests together, because
the keys do nothing without the actor's side and the actor's side has no caller without the
keys.

## Open questions

None.
