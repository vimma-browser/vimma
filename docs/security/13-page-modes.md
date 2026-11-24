## 13. Page modes (`host/VimmaParent.sys.mjs`, `host/VimmaHost.sys.mjs`, `host/edit-keys.mjs`)

Whether a key is Vimma's or the page's depends on the tab's mode, which the content actor's focus
reports move. Specs: [m1-actor-insert-scroll](../specs/m1-actor-insert-scroll.md),
[insert-focus](../specs/insert-focus.md).

**Reach:** pages, through focus changes in their own frames.

- K1. Only the frame that has focus **may** report focus for a tab, and a report that is not a
  well-formed descriptor **must** be dropped; a report changes only its own tab's mode.
  [`only_the_focused_frame_may_report`](../../tests/browser/browser_vimma_insert_scroll.js),
  [`malformed_descriptors_are_dropped`](../../tests/browser/browser_vimma_insert_scroll.js)
- K2. After `i` or `gi`, a page **must not** turn the user's keys into Vimma commands by moving
  focus: only `Esc` or another top document ends that insert (a page restored from the
  back-forward cache is the same document).
  [`after_i_the_page_moving_focus_off_the_field_keeps_insert`](../../tests/browser/browser_vimma_insert_focus.js),
  [`after_i_the_page_blurring_the_field_keeps_insert`](../../tests/browser/browser_vimma_insert_focus.js),
  [`after_gi_the_page_moving_focus_off_the_field_keeps_insert`](../../tests/browser/browser_vimma_insert_focus.js),
  [`explicit_insert_ends_with_the_page`](../../tests/browser/browser_vimma_insert_focus.js)
- K3. `i` **must** focus only a field of its own tab: the field the user last used, asked of the
  frame and document that reported it (still in the tab, not discarded, same inner window), which
  focuses only a connected, visible, editable element of that document; otherwise the top frame's
  first field.
  [`i_focuses_the_field_last_used_in_a_cross_origin_frame`](../../tests/browser/browser_vimma_insert_focus.js),
  [`i_falls_back_to_the_first_field_when_the_last_frame_navigated`](../../tests/browser/browser_vimma_insert_focus.js),
  [`i_falls_back_to_the_first_field_when_the_last_is_gone`](../../tests/browser/browser_vimma_insert_focus.js)
- K4. After `Esc`, a page **must not** put the tab back in insert by focusing a field other than
  while it handles the user's input, and a focus report sent before the `Esc` **must not** undo
  it; only the user's next action (a click, a key the page gets, `i`, `gi`, a hint) or another
  top document ends this. A key the user pressed after `Esc`, that a page in a content process
  handled before the blur arrived, keeps the focus it gave (insert-focus behaviour 8), and its
  focus is reported under the same rule. This holds for an uncompromised content process: a report's `user` and
  `gen` fields and `Vimma:Click` come from the content process, so a compromised one can do what
  K1 allows, no more.
  [`after_esc_a_page_refocusing_its_field_stays_in_normal`](../../tests/browser/browser_vimma_insert_focus.js),
  [`after_esc_on_a_trapping_page_i_click_and_tab_enter_insert`](../../tests/browser/browser_vimma_insert_focus.js),
  [`esc_right_after_tab_into_a_cross_origin_frame_stays_in_normal`](../../tests/browser/browser_vimma_insert_focus.js),
  [`tab_right_after_esc_on_a_busy_page_keeps_its_focus`](../../tests/browser/browser_vimma_insert_focus.js),
  [`tab_right_before_esc_on_a_busy_page_is_blurred`](../../tests/browser/browser_vimma_insert_focus.js),
  [`a_key_right_after_esc_on_a_busy_page_still_blurs`](../../tests/browser/browser_vimma_insert_focus.js)
- K5. Vim's text-field keys ([key-handling-batch](../specs/key-handling-batch.md) § 2) **must**
  act only on a key the user pressed, in insert mode or in a focused chrome field, and in a page
  only after the page left the key alone. `ctrl+j` and `ctrl+m` press a trusted `Enter` from the
  parent (`actors/enter-key.mjs`, a `TextInputProcessor`), which Firefox routes to the focused
  element as a keyboard's `Enter`: it carries no modifier, it is pressed only while the same
  chrome field, or the same `<browser>` and frame, still has focus, a page's reply acts only on
  the `<browser>` it came from (a late reply never edits the tab or pane focused since), and no
  message from a content process can ask for it. The content actor's `Vimma:Edit` **must** run only the three editor commands
  (`INSERT_EDIT_COMMANDS`), never Enter. A compromised content process that claims insert mode
  (K1) gets an `Enter` in place of its own `ctrl+j`, which it could synthesize itself. In insert
  mode `ctrl+j` is also a suggestion key (K6): its `Enter` comes from that key's fallback, after
  the page's reply to the keypress, under K6's checks (and, at the press, still insert mode and
  still the frame that was asked whether its list is open), and never also from the keydown's reply,
  so one `ctrl+j` presses at most one key.
  [`Enter is no editor command: the content actor never takes it`](../../packages/vimma-core/test/editable.test.ts),
  [`a_page_that_takes_ctrl_j_keeps_it`](../../tests/browser/browser_vimma_edit_keys.js),
  [`a_late_reply_presses_no_enter_in_another_tab`](../../tests/browser/browser_vimma_edit_keys.js),
  [`ctrl_j_m_submit_a_single_line_inputs_form_with_a_trusted_enter`](../../tests/browser/browser_vimma_edit_keys.js)

- K6. `ctrl+n` and `ctrl+p`, and `ctrl+j` and `ctrl+k` beside them, in a page's suggestion list
  ([page-suggestions](../specs/page-suggestions.md)) **must** press `ArrowDown` or `ArrowUp` only
  for a key the user pressed in insert mode, only after the page left it alone, only in the
  `<browser>` the key went to, and only in the frame focused when the page's reply arrives and
  still focused, in the same mode, at the press: a page's late reply neither presses a key in,
  nor runs the chord's other binding for, the tab or pane focused since, and `Esc` meanwhile
  stops both. The key comes from the parent's `TextInputProcessor` (`actors/enter-key.mjs`, as
  for K5's `Enter`), carries no modifier, and is the page's: Vimma's own key handling skips it,
  so it neither completes a Vimma sequence nor runs a binding on an arrow key. The focused frame's actor answers `Vimma:SuggestionsOpen` with one
  boolean computed from its page's own attributes; the parent treats anything but `true` as
  "no list", and no message from a content process can ask for a key. A page, or a compromised
  content process, can at most turn the user's own `ctrl+n` into an arrow key in itself, which it
  could do by handling `ctrl+n`. On macOS, where the focused field would run Cocoa's own
  `ctrl+n` or `ctrl+p` on the keypress, the parent marks the keypress of a suggestion key it sends
  to the page, and the frame's actor keeps a trusted, marked keypress from the field while that
  same test says a list is open: a page can at most keep the user's own key from moving the caret
  in its own field, which it could also do by handling the key. The mark is a chrome-only event
  flag, which page script can neither set nor read; the actor only stops the keypress on its way
  to the field, and neither prevents its default nor makes a key; and the parent reads no mark
  back from a reply. In the address bar the keys press `ArrowDown` or `ArrowUp` only while its
  results show and its field has focus, checked again at the press; the results are Firefox's
  own chrome, so no page takes part in that decision.
  [`suggestionListOpen`](../../packages/vimma-core/test/suggestions.test.ts),
  [`ctrl_n_p_and_ctrl_j_k_move_an_aria_combobox`](../../tests/browser/browser_vimma_page_suggestions.js),
  [`with_no_list_open_ctrl_j_is_enter_and_ctrl_k_is_the_pages`](../../tests/browser/browser_vimma_page_suggestions.js),
  [`the_suggestion_keys_move_the_address_bars_results`](../../tests/browser/browser_vimma_page_suggestions.js),
  [`a_pressed_arrow_key_runs_no_vimma_binding`](../../tests/browser/browser_vimma_page_suggestions.js),
  [`a_page_that_takes_ctrl_n_keeps_it`](../../tests/browser/browser_vimma_page_suggestions.js),
  [`a_late_reply_presses_no_arrow_key_in_another_tab`](../../tests/browser/browser_vimma_page_suggestions.js),
  [`a_hidden_list_left_aria_expanded_is_not_open`](../../tests/browser/browser_vimma_page_suggestions.js),
  [`the_caret_stays_where_it_was_in_an_open_list`](../../tests/browser/browser_vimma_page_suggestions.js),
  [`the_caret_stays_where_it_was_in_an_open_contenteditable_list`](../../tests/browser/browser_vimma_page_suggestions.js)
- K7. The content actor **must** attach only to http, https, file, `about:` and `view-source:`
  documents and Vimma's start page (`VimmaActors.register`); `moz-extension:`, `data:`, `blob:` and
  `chrome:` documents get none and stay in insert, though their `view-source:` forms match. A
  `view-source:` document is Firefox's own rendering of a source as inert markup: no page script
  runs in it, web content cannot navigate to `view-source:` (`URI_DANGEROUS_TO_LOAD`), and it is
  never framed. It loads in the process its inner URI's origin selects: a web page's source in
  that site's process, the source of a parent-process `about:` or `chrome:` page in the parent,
  where the actor already runs for `about:` pages and the start page. Its replies go through the
  same parent checks (K1, `parseHintReply`, `parseGrepReply`). Agents gain no reach from it: the
  agent tools open only http and https (M6), and the document's principal keeps the
  `view-source:` scheme, so every agent check for an http or https page refuses on it.
  [`j_k_G_and_gg_scroll_the_source`](../../tests/browser/browser_vimma_view_source.js),
  [`f_labels_the_link_in_the_source_and_follows_it`](../../tests/browser/browser_vimma_view_source.js),
  [`the_actor_reaches_settings_and_the_pdf_viewer_but_not_data_urls`](../../tests/browser/browser_vimma_insert_scroll.js)
- K8. The scroll keys' target **must** be chosen within the frame's own document, its shadow
  trees included, and a page **must not** be able to make that choice slow: the search of a
  fixed layer over the page (a cookie banner's settings) reads at most 10,000 elements, and a
  layer with nothing to scroll is not searched again for a second. A layer with nothing to scroll
  leaves the keys to the page.
  [`j_scrolls_the_cookie_settings_list_not_the_page_behind`](../../tests/browser/browser_vimma_insert_scroll.js),
  [`j_scrolls_the_page_past_a_fixed_element_that_is_no_scrolling_layer`](../../tests/browser/browser_vimma_insert_scroll.js)
- K9. A normal tab **must** have the actor's parent side (`host/VimmaParent.sys.mjs`), where
  content-process messages enter the parent process: without it every page report would be
  dropped in silence. It loads from the URL `vimma.js` hands `VimmaActors.register`, which
  **must** refuse, before registering anything, a URL that is not a `host/` system module, and
  `npm run layering` fails on a URL in the tree that names no tracked, packaged module.
  [`a_tabs_focus_report_reaches_the_host_through_the_parent_actor`](../../tests/browser/browser_vimma_security_invariants.js),
  [`the_parent_actors_url_is_checked_before_it_is_registered`](../../tests/browser/browser_vimma_security_invariants.js)
- K10. The scroll step a `Vimma:Scroll` message carries (`[scroll] step`) **must** be checked
  again in the child: only an integer from 1 to 2000 CSS pixels is taken, anything else scrolls
  by the default 60.
  [`the_child_ignores_a_step_config_toml_could_not_set`](../../tests/browser/browser_vimma_scroll_step.js)
- K11. Which keys a site keeps (`[sites."<host>"] unbind`, [site-unbind](../specs/site-unbind.md))
  **must** come only from `config.toml` or the user's `:siteunbind` (K13): the keymap compiles
  them, and no page or content-process message reaches it. The site is the focused `<browser>`'s top document host, and `esc` and the
  prefix **must not** be given to a page.
  [`a_site_unbound_key_reaches_the_page`](../../tests/browser/browser_vimma_site_unbind.js),
  [`the_same_key_is_vimmas_on_another_site`](../../tests/browser/browser_vimma_site_unbind.js),
  [`esc_still_leaves_insert`](../../tests/browser/browser_vimma_site_unbind.js),
  [`a remapped prefix is the one kept`](../../packages/vimma-core/test/site-unbind.test.ts)
- K12. A binding that closes a tab from a text field (`[modal.insert] "<C-w>" = "tab.close"`) or
  from the side panel (`panel.close_active_tab`, [close-active-tab](../specs/close-active-tab.md))
  **must** run only for a key the user pressed: it goes through the dispatcher from the window's
  capture-phase `keydown` listener, and no message from a content process can ask for it. A
  remote page's own key events stay in its content process (process separation), and a page in
  the parent process cannot reach the listener either, because on a chrome window
  `addEventListener` defaults `wantsUntrusted` to false. A page's own `ctrl+w`, dispatched at its
  focused field, closes nothing.
  [`a_ctrl_w_the_page_dispatches_closes_nothing`](../../tests/browser/browser_vimma_close_active_tab.js)
- K13. `:siteunbind` and `:sitebind` ([site-unbind-command](../specs/site-unbind-command.md))
  change which keys a site keeps, and with `--save` or `--delete` write `config.toml`, so they
  **must** run only from the user's `:` line or the user's own binding: `vimma_keys` refuses `:`
  and runs neither action (`site.unbind`, `site.bind`), and no page or content-process message
  reaches them or the keys they set. `esc` and the prefix **must not** be given to a page, as
  in K11. The write **must not** touch a `config.toml` with errors, and **must** change nothing
  in it but the one `unbind` list (or the table that list empties): the result is parsed again
  and compared before it is written, through a temporary file renamed over it. A private window
  **must not** save a site to the file; `:sitebind --delete` there may only remove keys from a
  table the file already has, so no host it visits reaches the disk. Keys given until restart
  from a private window stay in memory and apply in every window until restart. The table is
  named after the page's host, which a link chooses, so keys given until restart **must** apply
  to a table of any name, one named like an Object member (`__proto__`, a page at
  `http://__proto__/`) included, and **must not** change a prototype.
  [`neither action is a vimma_keys action, and the : line is refused`](../../packages/vimma-core/test/site-keys.test.ts),
  [`a file with errors is refused, never rewritten`](../../packages/vimma-core/test/site-keys.test.ts),
  [`a_bad_argument_is_refused_and_nothing_changes`](../../tests/browser/browser_vimma_site_unbind_command.js),
  [`a_config_toml_with_errors_is_never_written`](../../tests/browser/browser_vimma_site_unbind_command.js),
  [`a_private_window_does_not_save`](../../tests/browser/browser_vimma_site_unbind_command.js),
  [`a table named __proto__, constructor or toString gets its keys until restart`](../../packages/vimma-core/test/keymap-edges.test.ts)
