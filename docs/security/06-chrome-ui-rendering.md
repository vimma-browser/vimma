## 6. Chrome UI rendering

Vimma's status bar, pickers, side panel and overlays run with full browser privileges and show
text that pages, add-ons and bookmarks choose.

- C1. Page titles, add-on names, bookmark titles and the downloads picker's file names, hosts,
  verdicts and paths (D1) **must** be set as text (`textContent`), **never** parsed as HTML.
  [`page_titles_with_html_stay_text`](../../tests/browser/browser_vimma_security_invariants.js),
  [`names_with_html_are_text`](../../tests/browser/browser_vimma_addons.js),
  [`test_names_with_html_stay_text`](../../tests/browser/browser_vimma_downloads.js),
  [`toggles_in_the_side_panels_slot_one_panel_at_a_time`](../../tests/browser/browser_vimma_bookmarks.js),
  [`never parses strings as HTML: page titles, add-on and bookmark names stay text`](../../tools/security/test/chrome-source.test.ts)
- C2. Chrome code **never** builds code from text (`eval`, `Function`) and **never** starts a
  process, with three exceptions. First, the system's ClamAV scanners, `clamscan` (only
  `/usr/bin/clamscan` or `/usr/local/bin/clamscan`) and `clamdscan` (only `/usr/bin/clamdscan`
  or `/usr/local/bin/clamdscan`), never from a `PATH` search, and only a regular file another
  user (root) owns that the user cannot write, in a folder the user cannot write. They run in
  one call with arguments from three fixed builders (the scan, clamd's scan with `--fdpass`, and
  `--version`), the path after `--` and no shell, on an agent download in the quarantine folder
  (M13; [vimma-mcp](../specs/vimma-mcp.md) decisions 31 g, 43-45). Second, an AppImage's restart
  (UP11): `/bin/sh` (an absolute path) with one fixed script that waits for Vimma's own process
  to exit and then runs `$APPIMAGE` with no arguments, the process id and the path passed as
  positional parameters the script **never** reads as shell text, started from one call site
  only once a quit can no longer be cancelled. Third, an agent CLI the built-in agent runs
  (M55; [builtin-agent-cli](../specs/builtin-agent-cli.md) C2, C4): only the program at the path
  picked in setup, checked before each run, with arguments from one fixed builder
  per CLI, the task on its standard input, no shell, and only when the user sends a task in the
  chat window; its `--version` is the only other call, with that fixed argument, while setup
  lists what a search of `PATH` found, and, for a CLI that has no flag to leave out its other
  MCP servers (Codex), one fixed listing of them (`codex mcp list --json`) right before the
  run, from the same checked path, with no shell and no standard input. Opening a download or
  showing it in its folder hands a file to the OS too: chrome code **must** ask Firefox for it
  only through `DownloadsCommon.openDownload` and `Download.showContainingDirectory`, only from
  `host/download-ops.mjs`, and only on a key the user pressed in the downloads picker (§21), so
  Firefox's executable prompt and Vimma's agent-download rule (M12, the `launchDownload`
  override) are always on the way; it **never** calls `nsIFile.launch`, `nsIFile.reveal`,
  `DownloadUIHelper.loadFileIn`, `launchFile`, the external protocol service or
  `DownloadIntegration.launchDownload` itself, but the agent override's delegation to Firefox's
  own. Chrome code **never** calls
  native code, with one exception: the owner and mode of a file, read through js-ctypes for
  clamd's socket (M13) and for the agent CLI's checks (M55: the program, `vimma-ctl`, the run
  folder and every folder above each), read with `statx(2)` from `libc.so.6` on Linux and `lstat(2)` from
  `/usr/lib/libSystem.B.dylib` on macOS (`lstat` on arm64, `lstat$INODE64` on x86_64, the same
  144-byte `struct stat`), neither following a symlink, and one link's target for those
  checks, read with `readlink(2)` from the same library, because nsIFile follows a chain of links
  to its end and hides the links between. libSystem is opened by its absolute path,
  which dyld resolves from its shared cache, because for a bare name dyld also searches the
  working directory of a process without the hardened runtime, so a library planted where Vimma
  starts would be loaded. Any other system or architecture, a failed call or a struct of
  another size gives no owner, so clamd is not used and an agent CLI is refused. [`never builds code from text: no eval, Function or sandbox evaluation`](../../tools/security/test/chrome-source.test.ts),
  [`never starts a process, but ClamAV, an AppImage's restart and an agent CLI`](../../tools/security/test/chrome-source.test.ts),
  [`starts an agent CLI only from its checked path, with fixed arguments and no shell`](../../tools/security/test/chrome-source.test.ts),
  [`restarts an AppImage through one fixed script, with its path never shell text`](../../tools/security/test/chrome-source.test.ts),
  [`/bin/sh runs a fixed script; the pid and the path are arguments, never script text`](../../packages/vimma-core/test/restart.test.mjs),
  [`starts the AppImage only once the old process has exited, with no arguments`](../../packages/vimma-core/test/restart.test.mjs),
  [`never calls native code, but statx, lstat or readlink for a file's owner, mode or link`](../../tools/security/test/chrome-source.test.ts),
  [`opens and reveals downloads only through Firefox's Download, from download-ops`](../../tools/security/test/chrome-source.test.ts),
  [`test_enter_and_o_open_through_launchDownload`](../../tests/browser/browser_vimma_downloads.js),
  [`test_an_executable_asks_firefoxs_prompt_first`](../../tests/browser/browser_vimma_downloads.js)
- C3. With Firefox's toolbar hidden ([toolbar-toggle](../specs/toolbar-toggle.md)), the status bar
  is the only origin indicator: the page reaches the window's top, so there is no line of death.
- The status bar **must** always show the selected page's real address with its registrable
  domain whole: truncation **never** cuts inside it (the path, then the leftmost labels go
  first), also for a `blob:` or `view-source:` address (the origin it carries), and **never**
  in the middle of an address without a host. A page title **never** takes the address's
  place. The bar's order is: the mode's one-column short form, then the error, `not secure`,
  `private` and in-use cues, then the address, then the rest (the mode's full word, the title,
  the tab position, the workspace). The address takes room only from what comes after it: it
  is cut to `…<domain>…` while the rest gives way, and cut further, its domain's end as the
  last resort, rather than push a cue or the mode's short form off the bar. An about:blank a page opened or controls **must** read
  `about:blank from <the origin that wrote it>`, never nothing.
  [`the URL keeps its registrable domain while the toolbar is hidden`](../../packages/vimma-core/test/statusbar.test.mjs),
  [`the_status_bar_keeps_the_registrable_domain`](../../tests/browser/browser_vimma_toolbar.js),
  [`an_about_blank_a_page_wrote_says_so`](../../tests/browser/browser_vimma_toolbar.js),
  [`a_blob_page_shows_its_origin`](../../tests/browser/browser_vimma_toolbar.js),
  [`an_about_blank_names_its_writer_after_the_opener_leaves`](../../tests/browser/browser_vimma_toolbar.js),
  [`the security cues outrank the kept URL`](../../packages/vimma-core/test/statusbar.test.mjs)
- It **must** say `not secure` wherever Firefox's address bar would warn (plain http, a
  certificate error page or exception, mixed content), read from the browser's security state,
  never from the hidden address bar, and `private` in a private window.
  [`securityFromState`](../../packages/vimma-core/test/statusbar.test.mjs),
  [`not_secure_comes_from_the_browser_state`](../../tests/browser/browser_vimma_toolbar.js),
  [`the_status_bar_says_not_secure_and_private`](../../tests/browser/browser_vimma_toolbar.js)
- It **must** say which devices the selected page uses (camera, microphone, screen, location,
  XR, serial; `paused` where Firefox says so), the cues the hidden address bar and tab strip
  carried. It does not cover background tabs or the other pane of a split (only the selected
  tab is read, and the tab strip is hidden), nor Firefox's camera and microphone grace period
  after a stream ends; on Linux the desktop's global WebRTC indicator still shows background
  capture.
  [`sharing: devices in use while the toolbar is hidden`](../../packages/vimma-core/test/statusbar.test.mjs),
  [`the_status_bar_shows_camera_and_mic_in_use`](../../tests/browser/browser_vimma_toolbar.js)
- A permission prompt **must** hang from its own icon in the address bar, next to the site's
  identity and address, as with the toolbar shown (the prompt bar), and **never** open
  unanchored: if its icon cannot be revealed, the toolbar comes back first. The minimal bar for
  typing an address shows no identity; the status bar above is the origin indicator then. Pop-up
  windows **must** keep their read-only address bar.
  [`a_permission_prompt_hangs_from_its_icon`](../../tests/browser/browser_vimma_toolbar.js),
  [`the_identity_panel_shows_the_site_identity`](../../tests/browser/browser_vimma_toolbar.js),
  [`a_failed_reveal_for_a_prompt_shows_the_toolbar`](../../tests/browser/browser_vimma_toolbar.js),
  [`exclusions`](../../tests/browser/browser_vimma_toolbar.js)
- Vimma's keys for a permission prompt (`y`, `n`, `Tab`; toolbar shown or hidden) **must
  not** answer it before it has shown for `security.notification_enable_delay` with no key in
  between (any key restarts the wait), **never** from a text field (the page's, the chrome's,
  or the prompt's own, such as the password prompt's username), **never** while one of
  Vimma's own surfaces holds the keyboard (a picker, live grep, the command line, a search being
  typed, the other prompts), **never** in hint, copy or element mode (a label typed from any
  `[modal] hint_chars`, the yank: a page can time a prompt to the mode; `Esc` leaves it, and
  then `y` answers), nor while link labels or a focused block are still on screen after a
  prompt took focus (the next key ends them), so `y` and `n` answer a prompt only in normal and
  resize mode or with focus on the prompt itself, and go through Firefox's own buttons, so
  Firefox's click delay still applies. The wait counts from Firefox's own time for the prompt (`timeShown`), which Firefox moves later on its own (for example when the panel
  moves or resizes, the window is activated or another prompt takes the panel), so an armed key
  never meets a button Firefox's delay still refuses. Vimma **never** gives the prompt focus;
  `Tab` focuses the secondary (Block) button first. A prompt Firefox itself opens with focus on
  its panel (the add-on install prompt, `autofocus` in ExtensionsUI) takes the keys from there,
  under the same delay; no text field has focus then.
  The notice after an add-on install ("<name> was added", Firefox's app menu notification)
  takes `y` (OK) and `p` (its "Pin extension to toolbar" checkbox) under the same rules, and
  `Tab` focuses that checkbox; `n` stays Vimma's, since the notice has no second button.
  Firefox gives that notice no delay of its own, so the wait counts from when Vimma sees it
  shown, filled with another add-on's notice in place, or the window activated, or from the
  last key, and it starts again when the checkbox appears or goes and when a permission prompt
  over it closes. A page cannot raise the notice: it follows only an add-on install or enable
  answered in Firefox's own install prompt or add-ons manager. It grants nothing: `p` moves the
  add-on's button between the toolbar and the extensions menu, and private-window access is
  asked in the install prompt, not here. No other notice of that panel takes the keys (the
  update notices' main button restarts the browser).
  [`doorhangerKey`](../../packages/vimma-core/test/prompt-keys.test.mjs),
  [`permission_prompts_answer_y_and_n`](../../tests/browser/browser_vimma_toolbar.js),
  [`prompt_keys_arm_on_firefoxs_own_delay`](../../tests/browser/browser_vimma_toolbar.js),
  [`prompt_keys_leave_live_grep_and_find_their_keys`](../../tests/browser/browser_vimma_toolbar.js),
  [`KEY_KEEPING_MODES`](../../packages/vimma-core/test/modes.test.mjs),
  [`prompt_keys_leave_hint_copy_and_element_mode_their_keys`](../../tests/browser/browser_vimma_toolbar.js),
  [`the_addon_install_prompt_answers_y_and_n`](../../tests/browser/browser_vimma_toolbar.js),
  [`the_addon_installed_notice_answers_p_and_y`](../../tests/browser/browser_vimma_toolbar.js),
  [`the_prompts_own_fields_take_their_keys`](../../tests/browser/browser_vimma_password_prompt.js)
- Firefox's pop-up blocked bar takes the same keys (`y` allows the site, `n` blocks it, `Esc`
  closes the bar; docs/specs/popup-blocked.md) under the same rules. They count only from the
  later of the moment Vimma first sees the bar and the last key pressed in the window, plus
  `security.notification_enable_delay` (0.5 s by default), so any key restarts the wait, and a
  held (repeated) key never answers. They **never** answer from a text field, while a picker,
  the command line or a search holds the keyboard, or in hint, copy or element mode, and
  **never** while a permission prompt or the add-on installed notice is open, whose keys come
  first; Vimma never moves focus onto the bar. In the agent workspace no key answers the bar and `:popups` refuses, and
  `runPopupRow` checks again when a row runs, so neither the keys nor any row (allow, block,
  reset, open, redirect, hide, settings) does anything there (M10). A row runs only on the
  page it was listed for: the picker keeps the page's principal when it opens and refuses a row
  once the tab's principal differs, so a navigation under the open picker cannot land Allow on
  another site. With `dom.disable_open_during_load` locked, `y` and `n` stay the page's and no
  Vimma path writes the site's permission (the keys, the rows and `setSitePopups`, the site
  permissions picker's writer, §19), as Firefox's own menu hides its allow. Allow goes through Firefox's own
  `toggleAllowPopupsForSite` or `SitePermissions`; Block is stored with Firefox's own
  `Services.perms.addFromPrincipal` (SitePermissions removes a block instead of recording it),
  which keeps it for the private session only in a private window (PermissionManager forces
  `EXPIRE_SESSION` for private principals).
  [`popupBarKey`](../../packages/vimma-core/test/prompt-keys.test.mjs),
  [`y_answers_only_once_the_bar_is_armed_and_allows_the_site`](../../tests/browser/browser_vimma_popups.js),
  [`n_blocks_the_site_and_esc_only_closes_the_bar`](../../tests/browser/browser_vimma_popups.js),
  [`keys_typed_in_a_field_or_the_command_line_are_theirs`](../../tests/browser/browser_vimma_popups.js),
  [`a_row_never_lands_on_a_site_the_page_navigated_to`](../../tests/browser/browser_vimma_popups.js),
  [`a_locked_popup_pref_leaves_the_site_permission_alone`](../../tests/browser/browser_vimma_popups.js),
  [`the_agent_workspace_refuses_and_grants_nothing`](../../tests/browser/browser_vimma_popups.js)
- Firefox's dialogs over a tab or the window (`commonDialog.xhtml`: leave page, a page's
  `alert`, `confirm` and `prompt`, a sign-in; docs/specs/firefox-dialogs.md) take `y` (the
  main button) and `n` (the button `Esc` runs) under the same wait: from the later of the
  moment the dialog's frame loaded and the last key typed in it, plus
  `security.notification_enable_delay`; a key before then, or held, is swallowed and answers
  nothing. They **never** answer from the dialog's own text fields, and press Firefox's own
  buttons, so a button Firefox keeps disabled stays so. A page can open a dialog under a typing
  hand; the wait is what keeps that typing from answering it.
  [`dialogKey`](../../packages/vimma-core/test/prompt-keys.test.mjs),
  [`leave_page_n_stays_y_leaves`](../../tests/browser/browser_vimma_dialog_keys.js),
  [`prompt_field_types`](../../tests/browser/browser_vimma_dialog_keys.js)
- The external protocol questions over a tab (`permissionDialog.xhtml`, "Allow this site to
  open the link with ...?", and `appChooser.xhtml`, the application list) take the same keys
  under the same wait: `y` opens another application, so a page that follows a link under a
  typing hand must not get that typing as an answer. The wait for every one of these dialogs
  starts again when `SubDialog` shows the frame (`dialogopen`), so it counts only time on
  screen. `y` **also** waits for Firefox's own guard where Firefox applies it (the permission
  question always; the application list when the permission question was skipped), the main
  button it keeps disabled until the dialog's window has had focus for
  `security.dialog_enable_delay` (`EnableDelayHelper`): it is swallowed, never queued, while the
  button is disabled. Only `SubDialog` frames (`.dialogFrame`) are taken. `n` (Cancel) opens nothing. A checkbox ("Always allow") is not a text
  field, so the keys answer from it, and the box's state is the user's, never changed by them.
  [`protocol_permission_n_cancels_y_opens`](../../tests/browser/browser_vimma_dialog_keys.js),
  [`protocol_app_chooser`](../../tests/browser/browser_vimma_dialog_keys.js)
- The download question (`unknownContentType.xhtml`, a window of its own opened over the
  browser window) takes the same keys under the same wait, from the window's `load` and again
  each time it becomes the active window: `y`
  presses OK, which saves the file or opens it with an application, so it **also** waits for
  the OK button Firefox keeps disabled (`EnableDelayHelper`), and `n` cancels the download.
  Only a window whose opener is the browser window and whose document is the download question
  is taken; its keys are read in that window, never from a page.
  [`download_n_cancels_y_saves`](../../tests/browser/browser_vimma_dialog_keys.js)
- Accepted, low: a page can time a reveal under the pointer (a permission request shows the
  prompt bar, a download the full toolbar); there is no hover reveal. See the spec's Security
  section.
- C4. Vimma's start page stands in for Firefox's `about:home`, `about:newtab` and `about:welcome`
  modules in the parent process (`start/StartPage.sys.mjs`): while `vimma.startpage.newtab` is
  on, these loads are the chrome start page in the parent, and the stand-in's flags have no
  `URI_SAFE_FOR_UNTRUSTED_CONTENT`, child-process or `MAKE_LINKABLE` flag, so the web can neither
  load nor link to it. Turned off, it hands loads to Firefox's module and its flags. Once it has
  handed out Firefox's page, it **keeps** Firefox's module and flags, whatever the pref, until
  the last privilegedabout process it saw start (`ipc:content-created`) ends
  (`ipc:content-shutdown`): the parent checks every principal that process sends against the
  about: module's flags of that moment and kills the process on a mismatch (#950). Nothing else
  clears that: not the end of another content process, and not "no privilegedabout process is
  alive", since a process still launching is not listed yet. Nor does the end of the last one
  while one of Firefox's channels it handed out is still loading (#984): the parent opens a
  document channel as it creates it, keeps it suspended while it picks and launches the page's
  process, and lets it finish only after that process is alive (`ipc:content-created` comes
  first), so a page still on its way to a process holds the latch until a privilegedabout
  process ends after it arrives. Finished channels hold nothing, so the start page still comes
  back. Page loads that web content starts cannot reach these modules (no `MAKE_LINKABLE`), and
  a channel only ever keeps the latch, never clears it. The stand-in only ever falls back to
  Firefox's own module, never the other way round while Firefox's page may live. **⚠ limit:**
  this rests on the channel staying pending until its process is noted, which is how
  `DocumentLoadListener` and `ContentParent` work today (not tested with a real launch racing a
  process's end; the test stands in a suspended channel). If that changed, both orderings it
  covers would come back: a page in a new process without the latch, killed the next time the
  pref is turned on, and a load picked after the last process ended reading the start page's
  flags, which puts Firefox's page in the parent, where it does not work and the web cannot
  reach it. Firefox keeps one privilegedabout process alive, so either needs that process to
  crash or the keep-alive pref set to 0.
  [`typed_firefox_pages_open_the_start_page`](../../tests/browser/browser_vimma_firefox_surfaces_trim.js),
  [`firefox_flags_stay_until_a_privilegedabout_process_ends`](../../tests/browser/browser_vimma_firefox_page_process.js),
  [`firefox_flags_stay_while_its_page_is_on_its_way`](../../tests/browser/browser_vimma_firefox_page_process.js),
  [`turning_the_start_page_on_keeps_firefox_new_tab_alive`](../../tests/browser/browser_vimma_firefox_page_process.js)
