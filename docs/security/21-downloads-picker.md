## 21. Downloads picker (`host/download-ops.mjs`)

`ctrl+b d` (or `:downloads`) opens a picker over the window's downloads, where one key opens a
file, opens it in the system's app, shows it in its folder, copies its link or path, opens the
page it came from, pauses, resumes, cancels or retries a download, removes it from the list,
deletes its file, allows or removes a blocked download through Firefox's own dialog, or opens
Firefox's full downloads view. It lists files on your disk and
hands them to the OS, so these rules keep it to Firefox's own download code and out of an
agent's reach. Spec: [downloads](../specs/downloads.md).

**Reach:** only you, with `ctrl+b d`, `:downloads` or a key you bind. No control-socket or MCP
command reaches it, and an agent's keys are a fixed list without it (S7, M16). A `full`-role
connection holds your token and can press `ctrl+b d` as your keyboard can (§1). It shows what
Firefox's panel and Library show already, and stores nothing of its own. File names and
referring pages are chosen by the sites the files came from.

- D1. A row's file name, host, verdict and path **must** be set as text (C1), and a row **must**
  show the host a download came from, **never** its URL, so a token in a download link is not on
  screen; a download with no file path is named by its URL's last path segment or host. `y`
  copies the full link only on request.
  [`test_names_with_html_stay_text`](../../tests/browser/browser_vimma_downloads.js),
  [`a row shows the host, never the URL`](../../packages/vimma-core/test/downloads.test.mjs),
  [`a download with no file path is named by its URL's last segment, never the URL`](../../packages/vimma-core/test/downloads.test.mjs)
- D2. A private window **must** list only its own private session's downloads, and a normal
  window **never** a private one; the status bar's segment counts the same way. A private
  download is gone with its session, as in Firefox.
  [`test_a_private_window_lists_only_private_downloads`](../../tests/browser/browser_vimma_downloads.js),
  [`test_a_private_window_counts_only_its_private_downloads`](../../tests/browser/browser_vimma_downloads.js)
- D3. A download Firefox blocked by a verdict **must** be released only through Firefox's own
  dialog, `DownloadsCommon.confirmUnblockDownload` with the `chooseUnblock` type, opened by `!`
  with the picker closed first: that dialog words the warning by verdict, its default button
  (`Enter`) removes the file, and `Esc` cancels. Vimma **must never** use `chooseOpen`, whose
  default opens the file, and an allow **must** open nothing: a download whose question was
  answered "open" is released without opening, and the file is opened afterwards only with `o`,
  through Firefox's executable prompt. `!` **must** do nothing with
  `browser.safebrowsing.allowOverride` off, for a `Malware` verdict (which can only be removed,
  as in Firefox's Library), for an agent download (D4), or without blocked data. `Enter` on a
  blocked row **must** only show Firefox's reason and the keys that apply. The dialog's answer
  **must** act only on the download asked about, as in D5: if its state, data or file changed,
  or `allowOverride` was turned off, before the answer, nothing is done. Removing (`d`) and
  deleting (`shift+d`) blocked data **must** confirm the block (`Download.confirmBlock`), as
  Firefox's own remove does, and a content-analysis `Malware` download **must never** be removed
  or deleted from the picker, because the scanner, not the user, owns it. Firefox's dialog keeps
  Vimma's dialog keys (firefox-dialogs): `y` runs its first button, "Allow download", only once
  the keys are armed after `security.notification_enable_delay` with no key in between, so a key
  typed on into the dialog cannot allow it.
  [`test_a_blocked_download_unblocks_only_through_firefoxs_dialog`](../../tests/browser/browser_vimma_downloads.js),
  [`test_enter_in_firefoxs_unblock_dialog_never_reaches_the_picker`](../../tests/browser/browser_vimma_downloads.js),
  [`test_enter_on_a_blocked_download_says_why_and_the_keys`](../../tests/browser/browser_vimma_downloads.js),
  [`test_no_unblock_when_allowOverride_is_false`](../../tests/browser/browser_vimma_downloads.js),
  [`test_a_malware_verdict_can_only_be_removed`](../../tests/browser/browser_vimma_downloads.js),
  [`test_a_content_analysis_malware_verdict_cannot_be_unblocked_removed_or_deleted`](../../tests/browser/browser_vimma_downloads.js),
  [`test_d_on_a_blocked_download_deletes_its_data`](../../tests/browser/browser_vimma_downloads.js),
  [`test_D_on_a_blocked_download_confirms_the_block`](../../tests/browser/browser_vimma_downloads.js),
  [`unblock needs blocked data and allowOverride`](../../packages/vimma-core/test/downloads.test.mjs),
  [`a Malware verdict refuses !`](../../packages/vimma-core/test/downloads.test.mjs),
  [`a content-analysis Malware verdict refuses !, d and shift+d`](../../packages/vimma-core/test/downloads.test.mjs),
  [`an answer in Firefox's unblock dialog stands only while it still applies`](../../packages/vimma-core/test/downloads.test.mjs)
- D4. An agent download (M11's test: its container, its tab's container, or a path in the
  quarantine folder) **must never** be opened, opened in the system's app, retried, allowed or
  followed to its referring page from the picker, because its file is admitted only under M12
  and its page was chosen by the agent; `o` is refused twice, by the picker and by M12's
  `launchDownload` override. Showing it in its folder, copying its link or path and removing it
  stay. A history entry with no file path is **never** retried from the picker either, because
  without its folder it cannot be told apart from an agent download. For any download, `u`
  **must** open only an `http:` or `https:` page, never a script,
  `data:` or `file:` address a page chose as its referrer, and **must** open it in the
  download's own container (the window's non-agent one for a history entry), **never** the agent
  workspace's, even with that workspace on screen: the full referrer may carry a token. The
  picker asks M11's test through `host/host-services.mjs`, because `ctl/` sits above the host
  (ADR-026): `vimma.js` provides it there before the first window's host starts, and once it is
  provided nothing can replace it, because the registry is frozen and refuses a second value. Its
  check that the caller is `vimma.js` only catches mistakes: code that already runs with the
  system principal can run under that file name. Asked before it is provided, every download
  counts as an agent's. The registry has no observer topic, control-socket command or agent
  command, and pages cannot load chrome modules.
  [`test_the_picker_never_opens_an_agent_download`](../../tests/browser/browser_vimma_downloads.js),
  [`test_vimma_js_provided_every_service_before_the_window_started`](../../tests/browser/browser_vimma_host_services.js),
  [`test_only_vimma_js_provides_and_nothing_swaps_a_service`](../../tests/browser/browser_vimma_host_services.js),
  [`test_code_named_vimma_js_still_cannot_replace_a_service`](../../tests/browser/browser_vimma_host_services.js),
  [`test_before_it_is_provided_each_service_does_the_least`](../../tests/browser/browser_vimma_host_services.js),
  [`test_the_question_then_yes_saves_to_the_quarantine_0600_unopened`](../../tests/browser/browser_vimma_mcp_downloads.js),
  [`test_u_opens_the_referring_page`](../../tests/browser/browser_vimma_downloads.js),
  [`an agent download refuses o, shift+o, u, r and !`](../../packages/vimma-core/test/downloads.test.mjs),
  [`the keys that apply follow isCommandEnabled for each state`](../../packages/vimma-core/test/downloads.test.mjs)
- D5. `shift+d` (delete the file) and `c` (cancel, which removes the partial data) **must** ask
  `y/N` first, and the picker **must** close before the question shows, because an open picker
  takes every key first and a `y` meant for the question would otherwise reach it. A yes **must**
  act only on the download asked about: if it left the list, changed state, or its file moved or
  went before the answer, nothing is done and the notice says so. Both run through Firefox's own
  commands (`Download.cancel` and `removePartialData`, `DownloadsCommon.deleteDownloadFiles`);
  `d` removes only the list and history entry, keeps the file, and does not ask, as in Firefox.
  [`test_cancel_asks_and_removes_the_partial_file`](../../tests/browser/browser_vimma_downloads.js),
  [`test_D_asks_and_deletes_the_file`](../../tests/browser/browser_vimma_downloads.js),
  [`test_the_y_answer_goes_to_the_question_never_to_the_picker`](../../tests/browser/browser_vimma_downloads.js),
  [`test_an_answer_does_nothing_if_the_download_changed`](../../tests/browser/browser_vimma_downloads.js),
  [`shift+d and c need a y/N; d does not`](../../packages/vimma-core/test/downloads.test.mjs),
  [`a yes stands only for the download asked about (docs/security/21-downloads-picker.md D5)`](../../packages/vimma-core/test/downloads.test.mjs)
- D6. No agent role **may** reach the picker or the downloads list: `downloads.picker` is not
  one of `vimma_keys`' actions, no control or MCP command lists or opens a download, and no
  `ctl/` or `agent/` module imports the picker's ops.
  [`downloads.picker is not an agent key action (docs/specs/downloads.md decision 16)`](../../packages/vimma-core/test/agent-keys.test.mjs),
  [`opens and reveals downloads only through Firefox's Download, from download-ops`](../../tools/security/test/chrome-source.test.ts)
