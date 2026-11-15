## 15. Live grep (`host/grep.mjs`, `actors/VimmaChild.sys.mjs`, `actors/grep-matcher.mjs`)

`ctrl+b f g` searches the text of the tabs in its scope: the parent sends the query to each
frame's own content process, which builds a text model of its own document on the page's thread,
matches the query in that process's worker thread, and answers with the matching lines. The
widest scope adds recently closed tabs and windows, whose titles and URLs (Firefox keeps no page
text for them) are matched in a worker thread of the parent process.
Spec: [live-grep](../specs/live-grep.md).

**Reach:** only you, with the key or `:grep`. No control-socket command reaches it, so neither
`vimma-ctl` nor an agent connection can run it or read its results (S7). Each frame answers from
its own document only, and no page receives another page's text. Three things are exposed, and
accepted because Firefox's own find bar exposes the same:

- **The query** goes to the content process of every frame in scope, third-party iframes
  included, from the `this window` scope on the agent workspace's tabs, and from the
  `all windows` scope the tabs of your other windows on the same side of the private line. A
  compromised content process can read it.
- **A jump** selects the match as find does: the chosen page sees the selection
  (`getSelection()`, `selectionchange`) and the focus it gets.
- **Building the text model** runs on the page's main thread, so a page can see that it was
  searched from the time it takes.

Rules:

- L1. Live grep **must** search only windows on its own side of the private line, and other
  windows only once the scope is widened to them: a normal window **never** searches or lists a
  private tab, open or recently closed, and a private window **never** lists a normal tab, open
  or recently closed, nor a closed normal window. A window SessionStore does not track yet is
  skipped, not searched.
  [`private_tabs_never_reach_a_normal_window_and_back`](../../tests/browser/browser_vimma_live_grep_windows.js),
  [`all_windows_searches_the_other_windows_and_enter_goes_there`](../../tests/browser/browser_vimma_live_grep_windows.js),
  [`a_window_sessionstore_does_not_track_is_skipped`](../../tests/browser/browser_vimma_live_grep_windows.js)
- L2. A frame's reply comes from a content process that may be compromised: the parent **must**
  copy it field by field, cut to the limits (100 listed and 1,000 counted matches a frame, lines
  of 162 characters, 21 preview lines of 302 characters, a preview's match within its line),
  and drop a malformed one.
  [`a good reply is copied`](../../packages/vimma-core/test/grep.test.mjs),
  [`drops %j`](../../packages/vimma-core/test/grep.test.mjs),
  [`cuts overlong contexts and too many matches`](../../packages/vimma-core/test/grep.test.mjs),
  [`a reply's timedOut and cut flags are kept as booleans`](../../packages/vimma-core/test/grep.test.mjs),
  [`parsePreviewReply checks and cuts the preview`](../../packages/vimma-core/test/grep.test.mjs),
  [`parsePreviewReply clips the match to its line`](../../packages/vimma-core/test/grep.test.mjs)
- L3. Rows, the preview and its title **must** show page text, titles and URLs, recently closed
  ones included, as text nodes and `<mark>` elements made in chrome, **never** parsed as HTML
  (C1).
  [`page_text_with_markup_stays_text`](../../tests/browser/browser_vimma_live_grep.js),
  [`never parses strings as HTML: page titles, add-on and bookmark names stay text`](../../tools/security/test/chrome-source.test.ts)
- L4. The agent workspace's tabs **must** be searched only when the scope includes them, and
  their results **must** be marked as the agent's, so an agent's page is never taken for yours;
  a recently closed tab or window is the agent's when the tab its row shows was in the agent
  workspace's container.
  [`agent_tabs_only_in_window_scope_marked_and_last`](../../tests/browser/browser_vimma_live_grep_windows.js),
  [`agent workspace rows are marked and come last`](../../packages/vimma-core/test/grep.test.mjs),
  [`a closed window takes the agent marking of the tab it shows`](../../packages/vimma-core/test/grep.test.mjs)
- L5. Page text **must not** outlive the picker: when it closes, every frame the query was sent
  to is told to drop its text model, its observer and its worker, whether or not it answered;
  the parent keeps no rows; the grep list holds only the lines it shows, in memory, never on
  disk or in the session store, and drops a tab's lines when the tab or its window closes, and
  stops watching a closed window. The recently closed titles and URLs a search sends to the
  parent's worker are held under one key a picker session and dropped when the picker closes.
  A `]q`/`[q` step that ends after the picker opened again leaves its frame to that search,
  which tells it to drop its text when it closes.
  [`closing_tells_every_searched_frame_to_drop_its_text`](../../tests/browser/browser_vimma_live_grep.js),
  [`a_step_that_ends_after_grep_reopens_leaves_the_new_search_alone`](../../tests/browser/browser_vimma_live_grep.js),
  [`a_step_whose_tab_switch_ends_after_grep_reopens_stops_there`](../../tests/browser/browser_vimma_live_grep.js),
  [`a_reply_held_past_close_still_gets_grep_end`](../../tests/browser/browser_vimma_live_grep.js),
  [`the_grep_list_steps_with_bracket_q_and_grep_resumes`](../../tests/browser/browser_vimma_live_grep.js),
  [`pruneGrepList drops a closed tab's rows and keeps its place`](../../packages/vimma-core/test/grep.test.mjs),
  [`the_grep_list_drops_a_closed_windows_lines`](../../tests/browser/browser_vimma_live_grep_windows.js),
  [`the_closed_titles_have_one_matcher_key_until_close`](../../tests/browser/browser_vimma_live_grep_windows.js)
- L6. A regular expression **must** run on page text only in a worker thread of the page's
  content process (one a process, shared by its frames), and on recently closed titles and URLs
  only in a worker thread of the parent process, line by line, and a query **must** be stopped
  when it has run for 1 second, answering `timed out`; a frame's newer query replaces its older
  one, as a picker session's newer closed query replaces its older one, and a frame drops a
  query older than one it has seen in this picker session. A backtracking pattern therefore
  costs at most a second of one worker thread a query, and neither the page nor the browser's
  own window stops responding. A query over 1,000 characters is not sent.
  [`a_frame_answers_timed_out_within_its_budget`](../../tests/browser/browser_vimma_live_grep.js),
  [`a_catastrophic_pattern_never_freezes_the_page`](../../tests/browser/browser_vimma_live_grep.js),
  [`a_frame_drops_an_older_query`](../../tests/browser/browser_vimma_live_grep.js),
  [`grep_end_resets_the_frames_generation`](../../tests/browser/browser_vimma_live_grep.js),
  [`one_worker_a_process_and_none_for_a_blank_frame`](../../tests/browser/browser_vimma_live_grep.js),
  [`an_over_long_query_says_so_and_is_not_sent`](../../tests/browser/browser_vimma_live_grep.js),
  [`a_catastrophic_pattern_on_closed_titles_never_freezes_the_browser`](../../tests/browser/browser_vimma_live_grep_windows.js),
  [`a match never spans two lines`](../../packages/vimma-core/test/grep.test.mjs)
- L7. A page **must not** be able to make the parent hold an unbounded search: at most 100
  frames are searched in a tab, and at most 2,000 matches are held, those of the replies first
  in the list, the last that fits cut to fill the 2,000; the rest keep only their counts. At
  most 25 recently closed tabs and 5 closed windows of at most 20 tabs each, each title and URL
  cut to 1,000 characters, are matched, one match a title or URL so that no entry can use up
  the count for the rest. A row's host is cut to 64 characters, and a URL without a host gives
  none, never the URL; a tab's title is cut to 300 characters.
  [`frames_past_the_cap_are_not_searched`](../../tests/browser/browser_vimma_live_grep.js),
  [`matches are kept until 2,000 are held; past that only counts`](../../packages/vimma-core/test/grep.test.mjs),
  [`the last reply that fits only in part is cut, so exactly 2,000 are held`](../../packages/vimma-core/test/grep.test.mjs),
  [`newest first, at most 25 tabs and 5 windows, as Firefox keeps`](../../packages/vimma-core/test/grep.test.mjs),
  [`a closed window's tabs past 20 and fields past 1,000 characters are not matched`](../../packages/vimma-core/test/grep.test.mjs),
  [`one closed title matching a thousand times cannot crowd out the rest`](../../packages/vimma-core/test/grep.test.mjs),
  [`a host-less URL gives no host, and a closed row's URL and host are cut`](../../packages/vimma-core/test/grep.test.mjs),
  [`a better-ranked reply that arrives last still keeps its matches`](../../packages/vimma-core/test/grep.test.mjs)
- L8. A jump, from the picker or `]q` / `[q`, **must** go only to the document that was searched:
  a frame that has navigated since gets nothing, and the notice says the match is gone.
  [`a_jump_never_reaches_a_document_the_frame_navigated_to`](../../tests/browser/browser_vimma_live_grep.js)
