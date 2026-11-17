## 4. Opening URLs from untrusted text

The clipboard, bookmarks and the command line can hold text someone else wrote. Pages also send
link targets for hints, which chrome must treat as untrusted.

- U1. `p`/`P` **never** open `javascript:` or `data:` URLs, however disguised (case, tabs,
  newlines, `view-source:`).
  [`p_and_shift_p_refuse_javascript_and_data_urls`](../../tests/browser/browser_vimma_normal_extras.js),
  [`refuses %j`](../../packages/vimma-core/test/pageurl.test.ts)
- U2. Clipboard text over 8,192 characters **must** be refused, not truncated.
  [`text over the cap is refused, not truncated`](../../packages/vimma-core/test/pageurl.test.ts)
- U3. Bookmarks **must** open only http, https, file and about URLs. A bookmarklet (a stored
  bookmark whose URL is `javascript:`) is listed and **never** runs unless the config key
  `[bookmarks] bookmarklets` is `"user"` or `"agent"` (U8); then it runs only when you pick it in
  the bookmarks panel (`Enter` or `l`) or name it with `:bookmarkopen` (one exact title, or
  `Enter` in its picker; [bookmark-open](../specs/bookmark-open.md)), both through the panel's
  `openUserBookmark`, only in the current tab's http, https or file page, in that
  page's own global with the page's principal (the load Firefox makes for a picked bookmarklet,
  [bookmarklets](../specs/bookmarklets.md) B8), **never** with the system principal and never in a
  new tab or pane. A `data:` bookmark and every other scheme **never** open, at any level.
  [`javascript_and_data_bookmarks_refuse_with_a_notice`](../../tests/browser/browser_vimma_bookmarks.js),
  [`a javascript: bookmark is listed but refuses to open`](../../packages/vimma-core/test/bookmarks.test.ts),
  [`none_refuses_from_the_panel`](../../tests/browser/browser_vimma_bookmarklets.js),
  [`user_runs_from_the_panel_in_the_pages_principal`](../../tests/browser/browser_vimma_bookmarklets.js),
  [`user_t_s_and_S_refuse`](../../tests/browser/browser_vimma_bookmarklets.js),
  [`user_runs_only_on_web_pages`](../../tests/browser/browser_vimma_bookmarklets.js),
  [`a_bookmarklet_follows_the_level`](../../tests/browser/browser_vimma_bookmark_open.js),
  [`bookmarktab_refuses_a_bookmarklet`](../../tests/browser/browser_vimma_bookmark_open.js),
  [`a_row_that_changed_is_refused`](../../tests/browser/browser_vimma_bookmark_open.js),
  [`a_page_that_changed_runs_nothing`](../../tests/browser/browser_vimma_bookmark_open.js),
  [`data_bookmarks_refuse_at_every_level`](../../tests/browser/browser_vimma_bookmarklets.js),
  [`a bookmarklet at %s, by the %s, %s → %j`](../../packages/vimma-core/test/bookmarklets.test.ts),
  [`data: and other schemes refuse at every level, for anyone, anywhere`](../../packages/vimma-core/test/bookmarklets.test.ts)
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
  [`refuses %j as %s`](../../packages/vimma-core/test/pageurl.test.ts),
  [`lets %j through`](../../packages/vimma-core/test/pageurl.test.ts)
- U6. Hint replies from a page **must** be capped (5,000 targets, 64 frames, 8 KiB links) and
  copied field by field before chrome uses them.
  [`the caps are 5,000 targets, 64 frames and 8 KiB hrefs`](../../packages/vimma-core/test/hints.test.ts),
  [`a well-formed reply → a fresh copy with only the known fields`](../../packages/vimma-core/test/hints.test.ts)
  A text block target ([element-focus](../specs/element-focus.md)) **must** carry a kind from the
  closed list and a finite, bounded, non-empty box, and no link. A reply **must** hold only the
  kind of target its collection asked for: a block in an `f`, `gF` or `hint.follow_new_tab_fg` reply, or a link or control in
  an element-focus reply, refuses the whole reply, so a block is never followed.
  [`a block target needs a kind from the closed list and a finite box`](../../packages/vimma-core/test/hints.test.ts),
  [`only a block target carries a blockKind or a box`](../../packages/vimma-core/test/hints.test.ts),
  [`a reply holds only the kind of target its collection asked for`](../../packages/vimma-core/test/hints.test.ts)
  A focused block stays in its frame's actor: each `Vimma:Block` op is answered only for the
  collection the block came from and only by the frame that holds it, except `frame`, which the
  frames around it answer with the viewport of the next frame in (a rect that only places the
  outline, which is clipped to the browser). Each reply **must** be
  checked field by field before chrome uses it (a kind from the closed list, a bounded length and
  box, at most 16 Mi characters of text for `y`, which goes to the clipboard and nowhere else).
  The scroll reports that move the outline are heard only from the block's frame and the frames
  around it, with the documents they had when the block was chosen.
  [`%s: a kind from the closed list, a length and a box`](../../packages/vimma-core/test/hints.test.ts),
  [`yank: the text, and whether the page marks it unselectable`](../../packages/vimma-core/test/hints.test.ts),
  [`malformed_block_messages_are_refused`](../../tests/browser/browser_vimma_element.js)
- U7. Text pasted on the command line **must** be read in bounded time: a megabyte never
  freezes the window.
  [`a pasted megabyte is parsed and completed in bounded time`](../../packages/vimma-core/test/fuzz/cmdline.fuzz.test.ts),
  [`parseCommandLine never throws, and a run names a real action`](../../packages/vimma-core/test/fuzz/cmdline.fuzz.test.ts)
- U8. Who may run a bookmarklet (`[bookmarks] bookmarklets`: `"none"`, the default, `"user"` or
  `"agent"`) **must** come only from config.toml: no pref, command, control-socket message, agent
  tool or page changes it, and any other value is a config error. At every level, typed or sent
  text **never** runs script: `p`, `P`, `:open`, `:tabnew`, a keyword bookmarklet (`:open k x`,
  whose `%s` would put typed words into the script), the socket's `open` (S10), `vimma_open` and
  a follow stay refused as in U1, U4, U5, M6 and M18, whatever the level; the setting is read
  only by the bookmarks panel (and `:bookmarkopen` / `:bookmarktab`, whose text is only compared
  with stored titles and never loaded; an untitled bookmark is reached only through the picker)
  and `agent-bookmarklet`. Only a stored bookmark's URL,
  unchanged, ever runs.
  [`typed_and_keyword_bookmarklets_refuse_at_every_level`](../../tests/browser/browser_vimma_bookmarklets.js),
  [`typed_text_never_opens_or_runs`](../../tests/browser/browser_vimma_bookmark_open.js),
  [`the typed text is only compared with titles: a URL or script typed matches nothing`](../../packages/vimma-core/test/bookmark-open.test.ts),
  [`p_and_shift_p_refuse_javascript_and_data_urls`](../../tests/browser/browser_vimma_normal_extras.js),
  [`javascript_urls_are_blocked_with_a_notice`](../../tests/browser/browser_vimma_cmdline.js),
  [`bookmark_keywords_work_and_refused_ones_never_run`](../../tests/browser/browser_vimma_search.js),
  [`test_server_checks_the_scheme_itself`](../../tests/browser/browser_vimma_control.js),
  [`test_agent_open_is_background_and_checked`](../../tests/browser/browser_vimma_mcp_agent.js),
  [`test_follow_refuses_javascript_and_data_hrefs`](../../tests/browser/browser_vimma_mcp_follow.js),
  [`another value is an error, with the nearest name when one is close`](../../packages/vimma-core/test/bookmarklets.test.ts),
  [`defaults to "none"`](../../packages/vimma-core/test/bookmarklets.test.ts)
