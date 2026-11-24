# Spec: copy-link-url

Status: accepted · Area: core (`packages/vimma-core/src/keys/actions.mjs`,
`packages/vimma-core/src/config/defaults.mjs`, `packages/vimma-core/src/agent/agent-keys.mjs`),
actors (`actors/caret.mjs`, `actors/VimmaChild.sys.mjs`, `actors/VimmaActors.sys.mjs`, a new
`actors/link-at.mjs`), chrome (`host/copy-mode.mjs`, `host/element-focus.mjs`) · Upstream
patches: none · ADR: none

Issue: [#1531](https://github.com/vimma-browser/vimma/issues/1531)

## Summary

A new action, `yank_link`, copies the URL of the link under the caret or the selection in copy
mode, of the focused block in element mode, and of the link a find (`/word` `Enter`) landed on, on the key `gy` in all three modes.
The URL copied is the link's resolved, absolute address, the one a click would load. It closes
the gap between moving to a link by keys and copying where it points, which today needs a
second, separate pass with hints.

## Problem

Copy mode (`v`) and find (`/`) put the caret or the selection on a link's text, but the only copy
key there, `y`, copies the visible text. To copy the link's address the user has to leave copy
mode and pick the same link again with hints, and on web pages that hint action has no key:
`copy_link_target` (`hint.copy_target`) is bound only in the PDF viewer, as `c`
(`packages/vimma-core/src/config/defaults.mjs`, the `pdf` table).

Examples:

- A search result page: `/vimma` `Enter` lands on the result's title, which is a link. Its address
  is needed in the clipboard to paste into a chat. Today: `Esc`, then hints, which have
  no key for "copy" on a web page.
- An article with a list of references: the user selects the list with `v` and `ap` and wants
  the addresses of the links in it, not their titles.
- A paragraph focused with `F` (element focus) contains one link; `y` copies the paragraph's
  text, and nothing copies the link.

## Behaviour

1. In copy mode with no selection (a bare caret), `yank_link` copies the URL of the link that
   contains the caret. The caret is "in" a link when the selection's focus point is inside the
   link's subtree.
2. In copy mode with a selection, `yank_link` copies the URLs of the links the selection is
   inside or overlaps: a link that contains the whole selection, and every link the selection's
   range intersects, even partly.
3. In element mode, `yank_link` copies the URLs of the focused block: the block itself or the
   link around it when it is inside one, and otherwise every link inside the block.
4. In normal mode, `yank_link` copies the URL of the focused link (after `/word` `Enter` on a
   link's text, Firefox's find has focused that link, see Research; or after `Tab`), else the
   URLs of the links around or in the selection on screen, as in copy mode, else it says
   `no link here`. It never starts hints. Copy mode entered with `v` after a find starts with the
   match selected, so `v` `gy` copies the same link.
5. The URL is the link's resolved, absolute `href`: a relative `href="/a?b=1"` on
   `https://example.org/x/` copies `https://example.org/a?b=1`, and a `<base href>` is applied.
   It is copied to the clipboard as plain text.
6. One URL copied: the status bar says `yanked <url>`, as `yy` and `c` do. Several: they are
   copied one per line, each once, in document order, and the status bar says `yanked 3 links`.
   No link: the status bar says `no link here`, and nothing is copied (the clipboard keeps what
   it had).
7. Copy mode and element mode end when something was copied, as after `y`; with nothing copied
   they stay, with the caret, the selection or the focused block where it was.
8. A `javascript:` link is never copied; when it was the only link, the status bar says
   `link runs a script: not copied`. Decision 5.
9. A `data:` URL is copied like any other while it fits the length cap; one over the cap is
   skipped, and when it was the only link the status bar says `link too long to copy`.
   Decision 6.
10. In a frame, `yank_link` sees the links of the frame copy mode works in, resolved against that
    frame's own address and base. Links in a frame nested inside the selection are not included.
11. In the PDF viewer, a link is the PDF's link annotation drawn over the text the caret or the
    selection is in. An external link copies its URL; an internal link (to a page of the same
    PDF) copies the PDF's URL with the fragment that reopens that place, as `c` does.
12. A count before the key is ignored: `3gy` copies what `gy` copies.
13. The default key is `gy` in the `normal`, `visual` and `element` tables. Every key can be
    remapped in `config.toml`: the action is `yank_link`.

## Research

Checked against the engine tree of Firefox 160.0.1 (`surfer.json`), and Vimma's `main`.

- **Copy mode works in one frame.** `actors/caret.mjs` runs copy mode on the focused frame's
  selection (its header comment); `yank` replies with `sel.toString()` and leaves copy mode
  (`caret.mjs`, `case "yank"`). The host copies the reply with `nsIClipboardHelper.copyString`
  and says `yanked N chars` (`host/copy-mode.mjs`, `yank` and `yankedText`). Entering copy mode
  keeps a selection that is on screen (`caret.mjs`, `case "enter"`), so `v` after a find starts
  with the match selected.
- **Copy-mode keys.** The `visual` table binds `y` (`selection.yank`) and `Y`
  (`selection.yank_lines`), and two-key sequences starting with `g`: `gg` and `ge`
  (`defaults.mjs`). The dispatcher treats a key that is both bound and the start of a longer
  binding as ambiguous and waits `timeout_ms` before running it
  (`packages/vimma-core/src/keys/dispatcher.mjs`, `ambiguous`), so a new `yl` would delay every
  `y`. In normal mode `y` is only a prefix (`yy`), and `gy` is free in normal, visual and element
  mode.
- **The hint action.** `hint.copy_target` collects `a[href]` links with their `href` (the
  resolved absolute URL; `actors/hint-collect.mjs`, capped at `HINT_REPLY_MAX_HREF`, 8192
  characters, `packages/vimma-core/src/page/hints.mjs`). The parent re-parses the reply with
  `URL.parse` after `stripInvisible` and copies it with the notice `yanked <url>`
  (`host/VimmaHost.sys.mjs`, `_linkTarget`). It copies a `javascript:` URL as it is.
- **Find focuses the matched link.** When a match is selected, `nsTypeAheadFind` moves focus to
  the caret with `MOVEFOCUS_CARET` and keeps the element it focused as `mFoundLink`
  (`toolkit/components/typeaheadfind/nsTypeAheadFind.cpp:511-516`); the focus manager picks the
  focusable link around the selection (`dom/base/nsFocusManager.cpp:3859-3863`,
  `GetFocusInSelection` at 5322). On close, `Finder.focusContent` focuses `foundLink` again
  unless a listener's `shouldFocusContent` returns false
  (`toolkit/modules/Finder.sys.mjs:479-510`). Vimma's find returns false only while it suppresses
  focus for `Esc` (`host/find.mjs`, `#watch`), so after `/word` `Enter` on a link's text the
  link has focus and the match stays selected (m1-find, "`Enter`").
- **`javascript:` on paste.** Firefox's address bar removes a `javascript:` scheme from pasted
  text (`browser/components/urlbar/content/UrlbarShared.mjs:1040`,
  `stripUnsafeProtocolOnPaste`), so such a URL pasted there opens nothing.
- **PDF links.** pdf.js draws each link as an `<a>` inside a `section.linkAnnotation` in the
  annotation layer (`toolkit/components/pdfjs/content/build/pdf.mjs:18084-18116`), a sibling
  subtree of the text layer the caret moves in. A text selection is therefore never inside a PDF
  link's element, and the link has to be found by where it is drawn.
- **Agents.** `vimma_keys` refuses actions that touch the clipboard, by id, with "the clipboard
  is the user's" (`packages/vimma-core/src/agent/agent-keys.mjs`, `REASONS`).
- Other keyboard browsers, checked from their documentation, not run: Vimium's `yf` and
  Tridactyl's `;y` copy a link's URL through hints; neither has a caret-mode key for it.

## Design

1. **One action for every mode.** `yank_link` (id `link.yank`) is a single action bound in the
   `visual`, `element` and `normal` tables; the host runs it on what the
   mode points at. Reason: one name to learn and to remap, and the help overlay lists it once.
   Rejected: one action per mode (`selection.yank_link`, `element.yank_link`), because the
   behaviour is the same and only the target differs, as it is for `y`'s two actions only
   because their text differs.
2. **The child finds the links; the parent checks and copies.** A new `link_urls` copy-mode
   operation in `actors/caret.mjs` (and an element-focus counterpart) returns the URLs, in
   document order, from a shared `actors/link-at.mjs`: for a collapsed selection,
   `closest(":any-link")` from the focus node (crossing out of a shadow root to its host); for a
   range, that same ancestor of the common ancestor, then every `:any-link` element the range
   intersects (`Range.intersectsNode`). An HTML link's URL is its `href` property, which the
   document has already resolved; an SVG link's is `new URL(attribute, node.baseURI)`. Reason:
   only the content process sees the DOM, and the parent already treats replies as untrusted
   (Security and privacy).
3. **Deduplicated, capped.** The same URL appears once, at its first place. At most 100 links,
   each at most 8192 characters (`HINT_REPLY_MAX_HREF`), are returned. Reason: a selection over
   a navigation menu repeats links, and the caps bound the reply as the hint reply's are bounded.
4. **Plain text through the clipboard helper.** The parent copies with
   `nsIClipboardHelper.copyString`, as `y`, `yy` and `c` do, with no HTML flavour. Reason: a URL
   is pasted into an address bar, a terminal or a chat, where plain text is what is wanted.
5. **`javascript:` is not copied.** A `javascript:` link is dropped from the result. Reason: it is
   a script, not an address; Firefox's address bar strips the scheme on paste (Research), and
   pasted anywhere else it hands over the page's script under a link's name. Rejected: copying
   it as `c` does today, because the action promises an address the user can open.
6. **`data:` and other schemes are copied within the cap.** `data:`, `blob:`, `mailto:`, `tel:`,
   `about:` and `file:` URLs are copied as the URL parser writes them, and one longer than 8192
   characters is skipped. Reason: they are what the link points at, and a user who selected them
   asked for them; the cap keeps a page from filling the clipboard with megabytes.
7. **The message says what was copied.** `yanked <url>` for one link, `yanked N links` for
   several, `no link here`, `link runs a script: not copied` and `link too long to copy`.
   Reason: the first matches `yy` and `c`; the others tell why the clipboard did not change.
8. **PDF links by position.** In the PDF viewer the child takes the link annotations whose
   rectangle intersects one of the selection's client rectangles (for a caret, its own
   rectangle), in the annotation layer's order, and resolves an internal link as `c` does.
   Reason: pdf.js keeps links outside the text layer (Research), so the DOM test of decision 2
   finds none.
9. **The focused frame only.** The operation runs in the frame copy mode or element focus runs
   in. Reason: copy mode is already per frame (m1-copy-mode, "Limits"); a selection cannot span
   frames, so a nested frame's links are not under it.
10. **Count ignored.** The action does not take a count. Reason: there is no meaning for "copy
    the link three times", and repeating it would only repeat the message.

11. **The key is `gy`.** It is bound in `visual`, `element` and `normal`. Reason: `g` already
    starts `gg` and `ge` in copy mode, so nothing waits on a new key, while `yl` would make every
    `y` wait `timeout_ms`, since `y` alone is bound (Research); it keeps Vim's `y` and `Y`, and
    `gy` has no Vim meaning that muscle memory would fight. Rejected: `gY`, a shifted key for
    the common case, and moving `Y`'s `yank_lines`.
12. **Copy mode ends when something was copied, and stays otherwise.** Reason: a copy finishes
    the task as `y` does, while `no link here` means the caret is in the wrong place and the
    next step is to move it. Element mode follows the same rule, for the same reason. Rejected:
    always ending, as `y` does, which throws the caret away on a miss, and never ending, which
    leaves the user to press `Esc` after every copy.
13. **Several links: all of them**, one per line, deduplicated, in document order, with
    `yanked N links`. Reason: a selection is a range picked on purpose, and collecting the links
    of a list or a paragraph is what a range over several links is for; one link is still one
    key away by moving the caret onto it with no selection. Rejected: the first link only, which
    drops the others without saying so, and hints over the selected links, which add a mode to
    a one-key action.
14. **`gy` in normal mode too, with no hint fallback.** It copies the focused link, else the
    links around or in the selection on screen, else says `no link here`. Reason: after `/word`
    `Enter` the link already has focus and one key should be enough, the same key in both modes
    is one thing to learn, and a key that sometimes copies and sometimes opens hints is harder to
    predict. A hint key for `copy_link_target` on web pages (Vimium's `yf`) is a separate change.
15. **`gy` in element mode too.** Reason: element focus exists to copy from a block without a
    selection, and the action is the same one. Rejected: leaving it out, which makes the user
    press `v` first.

## Security and privacy

- **Content replies are untrusted.** The list comes from a content process, which may be
  compromised. The parent **must** accept only an array of at most 100 strings of at most 8192
  characters, drop anything else, remove control and format characters (`stripInvisible`), keep
  only what `URL.parse` accepts and write each URL as the parser serialises it, and drop
  `javascript:` again, as `_linkTarget` does for hints (docs/security/20-pdf-viewer.md). The
  implementing pull request adds these items to `docs/security/13-page-modes.md` with their
  tests and gets a fresh review.
- **Only the user's key copies.** The action runs on a key the user pressed; a page cannot start
  it or learn that it ran, because the clipboard write happens in the parent.
- **Agents.** `link.yank` joins the clipboard actions that `vimma_keys` refuses
  (`agent-keys.mjs`, "the clipboard is the user's"), because an agent must not write the user's
  clipboard.
- **What is copied.** A page chooses its links' addresses, and with several links the status bar
  shows only their number. That is the same trust as `y` on page text: the range was selected by hand,
  and the clipboard holds exactly the addresses of the links in it.

## Tests

Vitest (`packages/vimma-core`):

- `yank_link is bound to gy in normal, visual and element mode`.
- `the help overlay lists yank_link once, under Copy mode` (help snapshot).
- `vimma_keys refuses link.yank because the clipboard is the user's`.

Mochitest (`tests/browser/browser_vimma_copy_link.js`, new):

- `caret_inside_a_link_copies_its_absolute_url` (relative `href`, a `<base href>`).
- `caret_outside_any_link_says_no_link_here_and_keeps_the_clipboard`.
- `selection_inside_one_link_copies_that_link`.
- `selection_over_part_of_a_link_copies_it`.
- `selection_over_several_links_copies_them` (deduplicated, document order).
- `javascript_link_is_not_copied`.
- `data_url_over_the_cap_is_skipped`.
- `copy_mode_ends_after_copying_and_stays_on_no_link`.
- `in_a_frame_the_frame_base_resolves_the_url`.
- `after_find_enter_on_a_link_v_then_gy_copies_it`.
- `element_mode_copies_the_focused_link_or_the_links_inside_the_block`.
- `pdf_external_link_under_the_selection_is_copied` and
  `pdf_internal_link_copies_the_url_with_its_fragment`.
- `a_malformed_or_oversized_reply_copies_nothing` (the parent's checks).
- `normal_mode_gy_after_find_copies_the_focused_link`.

E2e (`tests/e2e`): one scenario, `/` to a link's text, `Enter`, `v`, `gy`, then `p` opens the
copied URL in the tab.

## Docs and changelog

- `docs/guide.md`, "Copy mode": a bullet for `gy`; "Find": a sentence on copying the link a
  search landed on; "Copying a paragraph (element focus)": `gy` beside `y`.
- `docs/bindings.md`, `docs/bindings.json`, `defaults.toml`: regenerated (`npm run gen-docs`).
- `CHANGELOG.md` (from the commit): `feat(copy-mode): copy the URL of the link under the caret or
the selection with gy`.

## Delivery

One pull request: the action and its keys, the child operation, the parent's checks, element
mode, the PDF viewer, docs and the security items. It changes the keymap, so it runs alone
among keymap changes, and it adds a default key, so the maintainer merges it.
