## 4. Opening URLs from untrusted text

The clipboard, bookmarks and the command line can hold text someone else wrote. Pages also send
link targets for hints, which chrome must treat as untrusted.

- U1. `p`/`P` **never** open `javascript:` or `data:` URLs, however disguised (case, tabs,
  newlines, `view-source:`).
  [`p_and_shift_p_refuse_javascript_and_data_urls`](../../tests/browser/browser_vimma_normal_extras.js),
  [`refuses %j`](../../packages/vimma-core/test/pageurl.test.mjs)
- U2. Clipboard text over 8,192 characters **must** be refused, not truncated.
  [`text over the cap is refused, not truncated`](../../packages/vimma-core/test/pageurl.test.mjs)
- U3. Bookmarks **must** open only http, https, file and about URLs (bookmarklets are listed but
  never run).
  [`javascript_and_data_bookmarks_refuse_with_a_notice`](../../tests/browser/browser_vimma_bookmarks.js),
  [`a javascript: bookmark is listed but refuses to open`](../../packages/vimma-core/test/bookmarks.test.mjs)
- U4. `:open` and `:tabnew` **never** open `javascript:` or `data:` URLs, however disguised (case,
  tabs, newlines, leading controls, `view-source:`)
  ([#98](https://github.com/vimma-browser/vimma/issues/98)). No length cap applies to text typed there.
  A search alias or bookmark keyword at the start resolves as the URL bar resolves it
  (`UrlbarUtils.getShortcutOrURIAndPostData`), and the URL it resolves to is checked again, so a
  keyword bookmarklet is refused; the bookmark's principal is never inherited. Other schemes a
  keyword resolves to (`file:`, `about:`) load as they would if typed: there is no allowlist like
  the bookmarks panel's. The query goes to the tab it was typed in (or a new tab in its
  container), even when the workspace changes while the keyword is looked up.
  [`javascript_urls_are_blocked_with_a_notice`](../../tests/browser/browser_vimma_cmdline.js),
  [`data_urls_are_blocked_with_a_notice`](../../tests/browser/browser_vimma_cmdline.js),
  [`bookmark_keywords_work_and_refused_ones_never_run`](../../tests/browser/browser_vimma_search.js),
  [`a_keyword_page_never_inherits_the_current_page`](../../tests/browser/browser_vimma_search.js),
  [`a_workspace_switch_during_the_lookup_keeps_the_query_where_it_was_typed`](../../tests/browser/browser_vimma_search.js)
- U5. Every Vimma open of text with the system principal (`p`, `P`, `:open`, `:tabnew`) **must**
  refuse those schemes through one shared check (`refusedScheme`, `core/pageurl.mjs`); bookmarks
  and the socket's `open` go further and allow only http, https, file and about.
  [`refuses %j as %s`](../../packages/vimma-core/test/pageurl.test.mjs),
  [`lets %j through`](../../packages/vimma-core/test/pageurl.test.mjs)
- U6. Hint replies from a page **must** be capped (5,000 targets, 64 frames, 8 KiB links) and
  copied field by field before chrome uses them.
  [`the caps are 5,000 targets, 64 frames and 8 KiB hrefs`](../../packages/vimma-core/test/hints.test.mjs),
  [`a well-formed reply → a fresh copy with only the known fields`](../../packages/vimma-core/test/hints.test.mjs)
  A text block target ([element-focus](../specs/element-focus.md)) **must** carry a kind from the
  closed list and a finite, bounded, non-empty box, and no link. A reply **must** hold only the
  kind of target its collection asked for: a block in an `f`, `gF` or `hint.follow_new_tab_fg` reply, or a link or control in
  an element-focus reply, refuses the whole reply, so a block is never followed.
  [`a block target needs a kind from the closed list and a finite box`](../../packages/vimma-core/test/hints.test.mjs),
  [`only a block target carries a blockKind or a box`](../../packages/vimma-core/test/hints.test.mjs),
  [`a reply holds only the kind of target its collection asked for`](../../packages/vimma-core/test/hints.test.mjs)
  A focused block stays in its frame's actor: each `Vimma:Block` op is answered only for the
  collection the block came from and only by the frame that holds it, except `frame`, which the
  frames around it answer with the viewport of the next frame in (a rect that only places the
  outline, which is clipped to the browser). Each reply **must** be
  checked field by field before chrome uses it (a kind from the closed list, a bounded length and
  box, at most 16 Mi characters of text for `y`, which goes to the clipboard and nowhere else).
  The scroll reports that move the outline are heard only from the block's frame and the frames
  around it, with the documents they had when the block was chosen.
  [`%s: a kind from the closed list, a length and a box`](../../packages/vimma-core/test/hints.test.mjs),
  [`yank: the text, and whether the page marks it unselectable`](../../packages/vimma-core/test/hints.test.mjs),
  [`malformed_block_messages_are_refused`](../../tests/browser/browser_vimma_element.js)
- U7. Text pasted on the command line **must** be read in bounded time: a megabyte never
  freezes the window.
  [`a pasted megabyte is parsed and completed in bounded time`](../../packages/vimma-core/test/fuzz/cmdline.fuzz.test.mjs),
  [`parseCommandLine never throws, and a run names a real action`](../../packages/vimma-core/test/fuzz/cmdline.fuzz.test.mjs)
