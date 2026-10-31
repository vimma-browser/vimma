# Spec: downloads

Status: draft · Area: `packages/vimma-core/src/` (new `downloads.mjs`; `picker.mjs`,
`statusbar.mjs`, `actions.mjs`, `defaults.mjs`, `cmdline.mjs`); `src/browser/base/content/vimma/`
(new `host/download-ops.mjs`; `ui/picker.mjs`, `ui/statusbar.mjs`, `host/VimmaHost.sys.mjs`);
`src/browser/branding/vimma/pref/firefox-branding.js`; generated `docs/bindings.md`,
`docs/bindings.json`, `packages/vimma-core/defaults.toml` · Upstream patches: none · ADR: none.
No new dependency.

Issue: [#618](https://github.com/vimma-browser/vimma/issues/618)

Builds on [addon-manager](addon-manager.md) (a picker whose rows carry their own keys),
[tab-search](tab-search.md) (the picker and its sections), [m2-core-logic](m2-core-logic.md) (the
status bar's segments), [toolbar-toggle](toolbar-toggle.md) (the hidden toolbar),
[private-workspace](private-workspace.md), [firefox-keys](firefox-keys.md) and
[vimma-mcp](vimma-mcp.md) (decision 31: downloads from the agent workspace). Vimma paths were
checked on `main` at a109596 and are under `src/browser/base/content/vimma/` unless they start with
`packages/`, `docs/`, `tests/`, `tools/` or `src/browser/branding/`. Engine paths are relative to
`engine/` and were read in Firefox 158.0.1, the engine tree available when the spec was written;
`main` builds Firefox 159.0 (`surfer.json`), and the implementing pull requests re-check each cited
line against it.

## Summary

`ctrl+b d` opens a downloads picker over the page: the recent downloads of this window's kind
(normal or private), newest first, with live progress, and one key per action (open, show in
folder, pause, resume, cancel, retry, copy the link or the path, remove, delete the file). A
segment on the status bar shows downloads in progress and says when one finished, failed or was
blocked, so Firefox's downloads panel no longer has to drop the hidden toolbar over the page.
Every action goes through Firefox's own download code, so its executable prompt, its blocked-download
dialog and Vimma's agent-download rules hold unchanged. Agents get no new access.

## Problem

Firefox's downloads UI is built for the mouse, and Vimma's hidden toolbar makes it awkward:

- The only keyboard way to the downloads today is `ctrl+shift+y` (`downloads`, `browser.downloads`
  in `packages/vimma-core/src/actions.mjs`), which runs Firefox's `Tools:Downloads`
  (`host/browser-ops.mjs`). In a normal window that opens the Library, a separate window
  (`browser/base/content/browser-commands.js:582-588`); in a private window, `about:downloads` in a
  new tab. Neither has Vimma's keys: picking a row and acting on it needs the arrow keys and the
  context-menu key, or the mouse.
- With `browser.download.alwaysOpenPanel` at Firefox's default `true`
  (`browser/app/profile/firefox.js:959`), the first download of a burst opens the downloads panel
  (`browser/components/downloads/DownloadsCommon.sys.mjs:1031-1078`). The panel hangs from the
  toolbar's downloads button, so with the toolbar hidden Vimma shows the whole toolbar while the
  panel is open (`ui/toolbar.mjs`, the panel reason; guide, "Hiding the toolbar"). The page jumps
  down under the toolbar for a download the reader did not ask to look at.
- Later downloads of the burst only animate the downloads button
  (`DownloadsCommon.sys.mjs:1061-1070`), which is not on screen while the toolbar is hidden. A
  download that finishes, fails or is blocked leaves no trace in Vimma's own UI.
- A file that was just downloaded has no keyboard path to "open it" or "show it in its folder"
  without opening the Library.

## Behaviour

1. As a Vimma user, `ctrl+b d` (or `:downloads`) opens the downloads picker over the page. `Esc` or
   `q` closes it. Like the other pickers, it takes every key while open, `ctrl+b` included, so a
   second `ctrl+b d` does not close it.
2. As a Vimma user in a normal window, the picker lists this profile's downloads, newest first:
   those of this session and, after them, the newest from history, up to 100 rows in all. Two
   sections, `active` (in progress, paused, blocked) and `recent` (the rest), as tab search shows
   its sections.
3. As a Vimma user in a private window (the private workspace included), the picker lists only
   that private session's downloads, and a normal window's picker never lists a private one.
4. As a Vimma user, each row shows the file's name, then its state as a word (`42%`, `paused`,
   `done`, `failed`, `canceled`, `blocked`, `missing`), its size or progress
   (`3.1 / 7.4 MB · 1.2 MB/s · 0:35 left`), the site it came from (its host only) and when it
   finished. A download from another workspace's container names that workspace; one from the
   agent workspace carries the agent glyph `◇`.
5. As a Vimma user with the picker open, progress, state and new downloads update in place, and
   the highlighted row stays on the same download.
6. As a Vimma user, `/` filters the rows by name, host, state word and workspace name with the
   pickers' fuzzy matcher; `Esc` returns to the list.
7. As a Vimma user, the keys in the picker act on the highlighted download (table below). A key
   that does not apply to the download's state does nothing and says why in the notice line
   (`not finished yet`, `the file is missing`).
8. As a Vimma user, `shift+d` (delete the file) and `c` (cancel) ask `y/N` first; nothing else
   asks Vimma's own question. `shift+d`, `c` and `!` close the picker before their question or
   dialog shows, so the answer goes to the question and never to the picker.
9. As a Vimma user, opening a finished program or script shows Firefox's own "this file is
   executable" prompt first, as Firefox does from its panel; opening a file Firefox shows itself
   (a PDF, an image) opens it in a tab.
10. As a Vimma user, a download Firefox blocked by a verdict (an `http:` file from an `https:`
    page, a content-analysis verdict, or a Safe Browsing verdict in a build that has one) is listed
    as `blocked` with Firefox's reason. `Enter` on it shows the reason and the keys that apply; `!`
    opens Firefox's own dialog to allow or remove it, whose default button removes the file and
    whose `Esc` cancels. An allowed file is opened with `o` afterwards, never from the dialog. `!`
    does nothing, and says why, when `browser.safebrowsing.allowOverride` is `false` or the verdict
    is `Malware`; for a `Malware` verdict from content analysis `d` and `shift+d` do nothing
    either, as Firefox's panel offers neither remove nor delete there. Downloads Firefox blocked because one page started too many are not listed:
    Firefox's panel shows them (Behaviour 14).
11. As a Vimma user, a download from the agent workspace is never opened from the picker: `o` and
    `Enter` say `agent downloads are never opened by Vimma`, as Firefox's own panel already does
    in Vimma. `shift+o`, `u`, `!` and `r` do nothing on it and say why. `s`, `y`, `shift+y`, `d` and
    `shift+d` work.
12. As a Vimma user, while a download runs the status bar shows `↓ 42%` (`↓ 3 · 42%` for three,
    `↓ 3` while no size is known, `↓ paused` when all are paused). After the last one ends it
    shows `↓ done` for 10 seconds, and `↓ failed` or `↓ blocked` until the picker is next opened in
    that window. `failed` and `blocked` are in the error colour.
13. As a screen-reader user, a download that finishes, fails or is blocked is announced once in
    the status bar's live region (`download finished: report.pdf`), and the segment's text says
    `downloading 42%` rather than the arrow.
14. As a Vimma user, starting a download no longer opens Firefox's downloads panel or shows the
    hidden toolbar, the first download of a new profile included. A download Firefox blocks still
    opens the panel, with the toolbar, as in Firefox, because that panel is Firefox's warning. The
    toolbar's downloads button and its panel still work when the toolbar is shown (`ctrl+b u`).
15. As a Vimma user, `shift+l` in the picker opens Firefox's full downloads view (the Library, or
    `about:downloads` in a private window), as `ctrl+shift+y` does.
16. As a Vimma user on macOS, `ctrl+b d` and every picker key are the same as on Linux; "show in
    folder" shows the file in Finder.
17. As an agent, `vimma_keys` cannot open the picker or act on a download, and no MCP tool lists
    or opens downloads.

| Key        | Applies to                                                                          | Does                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `ctrl+b d` | anywhere (`downloads_picker`, `:downloads`)                                         | opens the picker                                                                                                                 |
| `j` / `k`  | the list                                                                            | move                                                                                                                             |
| `/`        | the list                                                                            | filter (`Esc` back to the list)                                                                                                  |
| `Enter`    | any                                                                                 | the state's default: open (done), resume (paused), retry (failed, canceled), the reason and keys (blocked); in progress: nothing |
| `o`        | done, file present                                                                  | open the file, as Firefox would                                                                                                  |
| `shift+o`  | done, a type Firefox shows itself (PDF)                                             | open it in the system's app instead                                                                                              |
| `s`        | file or `.part` present                                                             | show it in its folder (Finder on macOS)                                                                                          |
| `y`        | any                                                                                 | copy the download's link                                                                                                         |
| `shift+y`  | file present                                                                        | copy the file's path                                                                                                             |
| `p`        | in progress, or paused                                                              | pause or resume                                                                                                                  |
| `c`        | in progress, or paused                                                              | cancel, after `y/N`; the partial file is removed                                                                                 |
| `r`        | failed, canceled                                                                    | retry                                                                                                                            |
| `u`        | a download with a referring page                                                    | open the page it came from in a new tab                                                                                          |
| `d`        | stopped (done, failed, canceled, blocked); not a content-analysis `Malware` verdict | remove from the list and from history; the file stays, but blocked data is deleted                                               |
| `shift+d`  | file, `.part` or blocked data present; not a content-analysis `Malware` verdict     | delete the file, after `y/N`                                                                                                     |
| `!`        | blocked, with data kept; not a `Malware` verdict                                    | Firefox's dialog: allow or remove                                                                                                |
| `shift+l`  | any                                                                                 | Firefox's full downloads view (`downloads`)                                                                                      |
| `Esc`, `q` | the list                                                                            | close                                                                                                                            |

Upper-case keys are written `shift+o`, `shift+y`, `shift+d` and `shift+l`, as the add-on picker's
`shift+p` is (core `picker.mjs`, `ADDON_KEYS`). These keys work in the picker's browse mode; after
`/` every key types into the filter. `Enter` gains each state's action in the sub-PR that adds that
action (Delivery). No config key is added.

## Research

**Firefox 158.0.1.**

- **Lists.** `Downloads.getList(Downloads.PUBLIC | PRIVATE | ALL)`
  (`toolkit/components/downloads/Downloads.sys.mjs:153`) gives the session's downloads.
  `DownloadHistory.getList({ type, maxHistoryResults })`
  (`toolkit/components/downloads/DownloadHistory.sys.mjs:63`) gives a list of the session's
  downloads followed by those in Places history, which is what the Library shows. Firefox's own
  views choose by window: `DownloadsCommon.getData(window, history, privateAll, limited)`
  (`browser/components/downloads/DownloadsCommon.sys.mjs:227-246`) returns the private session
  list for a private window, and otherwise the public session list (the panel,
  `content/downloads.js:116`) or the history list (the Library, `content/allDownloadsView.js:240`;
  the public type at `DownloadsCommon.sys.mjs:839`, `:852`). A list takes views with
  `onDownloadAdded`, `onDownloadChanged` and `onDownloadRemoved`.
- **What survives a restart.** Only downloads in progress, paused or blocked are written to the
  session store (`DownloadIntegration.sys.mjs:247`, `shouldPersistDownload`); a finished one
  remains only as Places history. History keeps the state, the end time, the size and the
  verdict (`DownloadHistory.sys.mjs:125-155`), not the container: `source.userContextId` is
  serialised for a session download only (`DownloadCore.sys.mjs:1796`).
- **States.** `DownloadsCommon.stateOfDownload` (`DownloadsCommon.sys.mjs:315`) maps a download to
  not started, downloading, finished, failed, canceled, paused, blocked by parental controls,
  dirty (blocked by a verdict), blocked by policy, or blocked by content analysis
  (`:149-157`).
- **Actions.** The panel and the Library share one command set,
  `browser/components/downloads/DownloadsViewUI.sys.mjs:1159-1290`, each enabled by
  `isCommandEnabled` (`:1097-1145`): `cancel` (cancels, then `removePartialData`), `pauseResume`,
  `retry` (`download.start()`), `open` and `openInSystemViewer` (both
  `DownloadsCommon.openDownload`, `DownloadsCommon.sys.mjs:606`, which is `download.launch`; the
  second with `useSystemDefault: true`; `DownloadsViewUI.sys.mjs:1172-1176`, `:1233-1239`), `show`
  (`DownloadsCommon.showDownloadedFile`, `DownloadsViewUI.sys.mjs:1192-1195`: `nsIFile.reveal`,
  falling back to `showDirectory` on the parent folder, `DownloadsCommon.sys.mjs:620-660`, called
  directly, not through `DownloadIntegration`),
  `openReferrer`,
  `delete` (`DownloadsCommon.deleteDownload`, `:356`: removes the Places entry and the list
  entry, and confirms the block of blocked data), `deleteFile`
  (`DownloadsCommon.deleteDownloadFiles`, `:388`, whose history handling follows
  `browser.download.clearHistoryOnDelete`, default `0`, `firefox.js:966`), `copyDownloadLink`
  (`DownloadsCommon.sys.mjs:472`, the original URL), `alwaysOpenSimilarFiles` and
  `alwaysOpenInSystemViewer` (which change the stored handler of the file's MIME type). The
  default action by state is `currentDefaultCommandName` (`DownloadsViewUI.sys.mjs:1070`): open
  when finished, retry when failed or canceled, resume when paused, the blocked subview when
  blocked, none while downloading.
- **Opening.** `Download.launch` (`DownloadCore.sys.mjs:907`) calls
  `DownloadIntegration.launchDownload` (`DownloadIntegration.sys.mjs:799`). It asks
  `confirmLaunchExecutable` before launching any file `nsIFile.isExecutable()` reports, except a
  Windows `.exe` and extensions exempted by policy (`:813-837`), and states that the check lives
  there "so that add-ons cannot forget to do this check". A type Firefox views itself goes to
  `DownloadUIHelper.loadFileIn` with the download's container and private flag (`:912`); anything
  else to the MIME service's default application, then `nsIFile.launch`. Because
  `DownloadIntegration` is an integration point, Vimma's `ctl/AgentDownloads.sys.mjs`
  (`launchDownload`, line 867) already refuses every agent download there, from any UI.
- **Showing in the folder.** `Download.showContainingDirectory` (`DownloadCore.sys.mjs:934`) calls
  `DownloadIntegration.showContainingDirectory` (`:1001`): `nsIFile.reveal`, else launch the parent
  folder, else hand the folder's `file:` URL to the OS. On Linux `reveal`
  (`xpcom/io/nsLocalFileUnix.cpp:2391`) goes to `nsGIOService::RevealFile`
  (`toolkit/system/gnome/nsGIOService.cpp:1172`): the desktop portal's `OpenDirectory` when
  portals are in use (Flatpak), else the folder's default application, else the
  `org.freedesktop.FileManager1` `ShowItems` D-Bus call. It returns success before the D-Bus call
  answers, so a desktop without a file manager (a bare Hyprland) shows nothing and reports no
  error. On macOS `reveal` is `NSWorkspace selectFile` (`xpcom/io/CocoaFileUtils.mm:24`), which
  shows the file selected in Finder.
- **After a download, by platform.** `DownloadPlatform::DownloadDone`
  (`toolkit/components/downloads/DownloadPlatform.cpp`): on Linux a non-private download is added
  to GTK's recent files when `browser.download.manager.addToRecentDocs` is on (`:144-157`); on
  macOS the Dock's downloads stack is notified (`:190-195`) and a non-private download gets its
  origin and quarantine metadata (`:205-219`), so Gatekeeper checks it when it is opened through
  Launch Services. A private download on macOS gets no quarantine flag.
- **Blocked downloads.** A verdict is one of `Malware`, `PotentiallyUnwanted`, `Insecure`,
  `Uncommon`, `DownloadSpam` (`DownloadCore.sys.mjs:2128-2132`). `Insecure` comes from
  `dom.block_download_insecure` (default `true`, `modules/libpref/init/StaticPrefList.yaml:2718`)
  when the mixed-content check flags the download, an `http:` file from an `https:` page
  (`dom/security/nsContentSecurityUtils.cpp:2278-2285`), and is attached as the download's
  verdict in `DownloadLegacy.sys.mjs:406-416`;
  `DownloadSpam` from `DownloadSpamProtection.sys.mjs`. The others need Safe Browsing's download
  reputation, which Vimma's builds do not have (`docs/limits.md`, "Privacy, security and
  services"). A blocked download with `hasBlockedData` keeps its bytes in a temporary file;
  `Download.unblock` (`DownloadCore.sys.mjs:715`) releases them and `confirmBlock` (`:846`)
  deletes them. The panel's blocked subview offers unblock (or unblock and open) and remove
  (`content/downloads.js:1740-1777`), hiding unblock when `browser.safebrowsing.allowOverride` is
  `false` (default `true`, `modules/libpref/init/all.js:3377`); the Library offers the same
  through `DownloadsCommon.confirmUnblockDownload` (`DownloadsCommon.sys.mjs:691`), a modal
  `confirmEx` dialog in three types (`allDownloadsView.js:107-118`): `unblock` (default: cancel),
  `chooseUnblock` (allow or remove; default: remove) and `chooseOpen` (open or remove; default:
  open, `DownloadsCommon.sys.mjs:721-729`). Its cancel button is always the one `Esc` answers. For
  a `Malware` verdict the Library offers only removal (`DownloadsViewUI.sys.mjs:813-833`), while
  the panel's subview offers allow and remove.
  `isCommandEnabled` allows every unblock command only with `hasBlockedData` and
  `allowOverride` (`DownloadsViewUI.sys.mjs:1109-1114`).
- **When the panel opens by itself.** `_notifyDownloadEvent` (`DownloadsCommon.sys.mjs:1031-1078`)
  returns early, animating the button only, when the event is not `error` and the panel was shown
  before (`browser.download.panel.shown`, default `false`, `firefox.js:939`) and
  `browser.download.alwaysOpenPanel` does not ask for it (`:1056-1068`). So a profile's first
  download opens the panel whatever `alwaysOpenPanel` says, and an `error` event opens it always.
  `onDownloadAdded` sends `error` for every download blocked by a reputation or content-analysis
  verdict (`:917-921`), `Insecure` included. A download blocked as spam opens the panel when no
  other download is running (`DownloadSpamProtection.sys.mjs:126-140`).
- **Spam lists.** Downloads blocked because a page started too many are `DownloadSpam` objects in
  a per-window `DownloadList` (`DownloadSpamProtection.sys.mjs`, `spamList`, `getSpamListForWindow`
  and `register(view, window)`, `:245-290`), not in `Downloads.getList` or `DownloadHistory`. Such an
  item stands for a URL and a count, not a file.
- **Content-analysis verdicts.** A download blocked by content analysis with a `Malware` verdict
  has its own state, `DOWNLOAD_BLOCKED_CONTENT_ANALYSIS` (`DownloadsCommon.sys.mjs:330-340`); any
  other content-analysis verdict is `DOWNLOAD_DIRTY`. For that state the panel's subview hides
  unblock and delete (`content/downloads.js:1748-1755`), and its context menu hides "Remove From
  History" (`DownloadsViewUI.sys.mjs:213-221`, which lists every stopped state but that one).
  Remove would not keep the data anyway: `DownloadsCommon.deleteDownload` runs `confirmBlock` on a
  download with blocked data, which deletes its bytes, and
  `respondToContentAnalysisWarnWithBlock` on a content-analysis block without them
  (`DownloadsCommon.sys.mjs:356-374`).
  `confirmUnblockDownload` words its message by verdict and by whether reputation or content
  analysis blocked it (`DownloadsCommon.sys.mjs:736-748`).
- **Keys.** Firefox's `key_openDownloads` is `ctrl+shift+y` on Linux and `cmd+j` on macOS
  (`browser/base/content/browser-sets.inc.xhtml:179-186`,
  `browser/locales/en-US/browser/browserSets.ftl:59-63`). Vimma binds the Linux chord as
  `downloads` (`packages/vimma-core/src/defaults.mjs`) and lists `cmd+j` as Firefox's on macOS
  (`packages/vimma-core/src/firefox-keys.mjs`, `MAC_CHANGES`).

**Vimma today.**

- The pickers (`ui/picker.mjs`, core `picker.mjs`) are one modal `<dialog>` and one pure key
  machine (`pickerKey`) for tab search, the workspace picker and the add-on picker; the add-on
  picker's rows carry their own keys in browse mode, and `/` switches to typing a filter
  ([addon-manager](addon-manager.md) decision 2). The side-panel slot holds the tabs panel or the
  bookmarks panel, one at a time ([bookmarks](bookmarks.md) decision 3).
- `ui/rename-prompt.mjs` has the `y/N` question (`ask`) that the add-on picker's remove and
  `:wsdelete` use.
- The status bar is pure data in core `statusbar.mjs`: segments with a priority, fitted to the
  width by `fitStatus`; its live region announces through `statusAnnouncement`.
- Prefixed keys free in the default keymap (`docs/bindings.md`): `ctrl+b` followed by `d`, `i`,
  `m`, `o`, `q`, `s`, `t` or `y`, among others.
- `vimma_keys` runs only the action ids on `AGENT_KEY_ACTIONS`
  (`packages/vimma-core/src/agent-keys.mjs:24`), a fixed allow list.
- `tools/security/test/chrome-source.test.mjs` (lines 65-71) holds rule C2: Vimma's chrome code
  contains no `Subprocess`, `nsIProcess`, `.launch()` or `.reveal()` outside the ClamAV scan and
  the AppImage restart.
- Zen Browser's components were not available locally, so its downloads UI was not checked.

## Design

A new core module, `downloads.mjs`, turns a download's fields into a row, a state, the keys that
apply and the status-bar segment. A host module, `host/download-ops.mjs`, owns the window's
download list view and runs each action through Firefox's own objects. The picker gains a
`download` item kind.

1. **A picker, not the side panel or a page.** The downloads view is the picker dialog, because
   acting on a download is a short visit (open the file just fetched, retry one, clear one), which
   is how the add-on picker and tab search are used; its filter and key machine already exist;
   and it covers the page only while open. Watching progress while reading is the status bar's
   job (decision 9). Rejected: the side-panel slot, because it takes width from the page for as
   long as it is open and closes the tabs or bookmarks panel that shares the slot; Vimma keys on
   `about:downloads`, because it is a page in a tab that joins a workspace, and keys there would
   need a content-side actor in a privileged page for what the picker does in chrome; the status
   bar alone, because it cannot act.
2. **`ctrl+b d` and `:downloads`.** A new action `downloads_picker`, id `downloads.picker`,
   description "Downloads picker: open, show in folder, pause, retry, remove", in the Browser group
   next to `downloads`, default `prefix+d`, so that the key is the feature's initial and sits with
   the other pickers on the prefix (`ctrl+b g`, `ctrl+b w`, `ctrl+b e`). The command line gets
   `:downloads`. `ctrl+shift+y` keeps Firefox's meaning (the Library), because Vimma binds
   Firefox's chords with Firefox's meaning ([firefox-keys](firefox-keys.md)); `shift+l` in the picker
   reaches the same view. The key is the same on macOS, since the prefix is `ctrl+b` there too and
   `MAC_KEYS` changes only `alt` chords. tmux uses `prefix d` to detach a client, which has no
   meaning in a browser.
3. **The list follows Firefox's choice by window.** A normal window lists
   `DownloadHistory.getList({ type: Downloads.PUBLIC, maxHistoryResults: 100 })`, the Library's
   source, so that a file downloaded before a restart is still one key away; a private window lists
   `Downloads.getList(Downloads.PRIVATE)`, as Firefox's panel does there, so that no private
   download reaches a normal window and none outlives its session. The cap of 100 keeps the
   picker's DOM and its filter fast; `shift+l` opens the Library for the rest. Rows are ordered by start
   time, newest first, in two sections: `active` (downloading, paused, blocked with data kept) and
   `recent` (everything else).
4. **One list for every workspace.** The picker is not filtered by workspace, because Firefox
   keeps one downloads list per profile, and history entries carry no container, so a filter would
   drop every download from before the session. A session download from another workspace's
   container shows that workspace's name, and the filter matches it. The agent workspace's
   downloads are listed with `◇`, since they are on the user's disk and the user may need to find
   or delete them.
5. **Every action is Firefox's.** `host/download-ops.mjs` calls the same functions as Firefox's
   panel: `DownloadsCommon.openDownload` for both opens (with `useSystemDefault: true` for
   `shift+o`), `Download.showContainingDirectory` for `s`, `Download.start`, `Download.cancel`,
   `Download.removePartialData`, `DownloadsCommon.deleteDownload`,
   `DownloadsCommon.deleteDownloadFiles` (with `browser.download.clearHistoryOnDelete`),
   `DownloadsCommon.copyDownloadLink` and `DownloadsCommon.confirmUnblockDownload`. Which keys
   apply to a state follows `isCommandEnabled`, re-implemented as a pure table in core
   `downloadKeys` and tested against the same cases. So the executable prompt, the private and
   container flags of a file opened in a tab, Gatekeeper on macOS, and Vimma's refusal to open an
   agent download (`ctl/AgentDownloads.sys.mjs`, `launchDownload`) hold in the picker without
   being re-implemented. For `s`, Vimma uses `Download.showContainingDirectory` rather than the
   panel's `DownloadsCommon.showDownloadedFile`, because it has the same fallbacks (`reveal`, then
   the parent folder, then the OS's `file:` handler) and goes through `DownloadIntegration`, so a
   test's `Integration.downloads` override can record it instead of reaching the OS. Vimma never
   calls `nsIFile.launch`, `nsIFile.reveal`, `DownloadUIHelper.loadFileIn` or
   `DownloadIntegration.launchDownload` itself, except the agent override's delegation to the base
   (`ctl/AgentDownloads.sys.mjs`, `base.launchDownload`) (rule C2).
6. **`shift+d` and `c` ask; nothing else does.** Deleting a file and cancelling a download (which
   removes its partial data) ask `y/N` with `RenamePrompt.ask`, because they cannot be undone and a
   single key in a list is easier to hit by mistake than Firefox's context-menu item. The picker
   closes before the question shows, as the add-on picker closes before its remove question
   (`host/VimmaHost.sys.mjs`, the `remove` case), because an open picker takes every key first
   (`VimmaHost.sys.mjs`, "A picker takes every key"), so the `y` would otherwise reach the picker.
   `!` closes it before Firefox's dialog for the same reason. `d` removes
   only the list and history entry and keeps a downloaded file, so it does not ask, as in Firefox.
   On a blocked download it also deletes the blocked data, as Firefox's remove does (Research),
   which leaves nothing the user could have kept without `!`. The
   answer stands for the download that was asked about: if it changed state before `y`
   (finished, removed elsewhere), nothing happens and the notice says so, as the add-on picker's
   remove does.
7. **Blocked downloads keep Firefox's dialog.** `!` calls
   `DownloadsCommon.confirmUnblockDownload` with the verdict, both `becauseBlockedByReputationCheck`
   and `becauseBlockedByContentAnalysis` (the dialog words its message by them), and the dialog type
   `chooseUnblock`, and runs what it returns (`unblock` or `confirmBlock`), so that a blocked
   download is released only through Firefox's own warning, in Firefox's wording. Vimma always
   uses `chooseUnblock`, whose default button removes the file, and never `chooseOpen`, whose
   default opens it, so that `!` followed by a habitual `Enter` cannot run a blocked file; opening
   it is a separate `o`. `!` is offered only with `hasBlockedData`,
   `browser.safebrowsing.allowOverride` on, a verdict other than `Malware`, and not for an agent
   download. A `Malware` verdict can only be removed, as in the Library
   (`DownloadsViewUI.sys.mjs:813-833`), because a file a scanner calls malware is the one case where
   a keyboard path to "allow" adds risk and no use; the panel's subview would allow it, and open
   question 8 asks whether to follow the panel instead. For a content-analysis `Malware` verdict
   `d` and `shift+d` are refused too, as Firefox's panel offers neither remove nor delete for that
   state (Research), because the content-analysis agent, not the user, owns that file, and both
   keys would run `confirmBlock` on it.
   `Enter` on a blocked row never unblocks: it puts the verdict's text and the applicable keys in
   the notice line. `shift+d` on a blocked row runs `confirmBlock` after `y/N`. Rejected: a Vimma
   question in the notice line in place of Firefox's dialog, because it would be a second wording
   of a security warning to keep in step with Firefox's; one key to unblock, because Firefox never
   releases a blocked file in one step.
8. **Agent downloads stay under the agent rules.** In the picker, an agent download (by the test
   `ctl/AgentDownloads.sys.mjs` already uses: its container, its tab's container, or a path in the
   quarantine folder) refuses `o`, `shift+o`, `Enter`'s open, `r` and `!` with the existing notice,
   because [vimma-mcp](vimma-mcp.md) decision 31 owns how such a file is admitted and
   docs/security.md M12 says it is never opened by Vimma. It refuses `u` too, because the referring
   page was chosen by the agent, and opening it would load that page in the user's workspace and
   container, with the user's cookies. The refusal of `o` is checked twice: by the picker, so the
   key says why at once, and by the `launchDownload` override, which stays the rule.
9. **A `downloads` segment on the status bar.** Core `downloadSegment(summary)` turns the window's
   list (Firefox's `DownloadsCommon.summarizeDownloads` fields: count, paused, percent, time left)
   into a right-side segment: `↓ 42%`, `↓ 3 · 42%`, `↓ 3`, `↓ paused`; then `↓ done` for 10
   seconds, because a finished download needs no action and the bar's width is shared with the URL
   and the title; and `↓ failed` or `↓ blocked` until the picker is next opened in that window, as
   Firefox's indicator keeps its attention until the panel opens, because those wait to be seen
   (open question 5 asks whether `done` should stay as long). Progress and `done` are dim (`--vimma-fg-dim`, priority 6.5,
   so they give way before the title); `failed` and `blocked` use `--vimma-text-error` and
   priority 3, so they outlast the title, because a blocked file waits for a decision. The arrow
   is never the only carrier: the segment's accessible text is `downloading 42%`, `download
blocked`, and so on, and the end of each download is announced once (m7-a11y: no meaning by
   colour or glyph alone). A private window's segment counts its private downloads only.
10. **Firefox's panel stops opening for ordinary downloads.** Vimma sets
    `browser.download.alwaysOpenPanel` to `false` and `browser.download.panel.shown` to `true` in
    `firefox-branding.js` (the second already since
    [#677](https://github.com/vimma-browser/vimma/issues/677), with no panel for a download Firefox
    opens in a tab of its own, because that panel took focus from the PDF it opened), because with
    the toolbar hidden the panel brings the whole toolbar over the page for every first download
    of a burst, and the status-bar segment now carries that news;
    both are needed, since a profile whose panel never showed opens it on its first download
    whatever `alwaysOpenPanel` says (Research). A blocked download (an `error` event, or a spam
    block with no other download running) still opens the panel, because that panel is Firefox's
    warning about a file it refused, and a warning that pushes the toolbar over the page once is
    better than one the reader misses; stopping it would need an upstream patch to
    `_notifyDownloadEvent` and `DownloadSpamProtection`, with a line in [ADR-003](../adr/003-own-files-minimal-patches.md), for no gain in
    safety. The downloads button and its panel stay, so a user with the toolbar shown
    keeps Firefox's UI, and the pref can be set back in `about:config`. Rejected: removing the
    button or the panel, because they are the mouse path and cost nothing while hidden; flipping
    the pref only while the toolbar is hidden, because a pref that changes with the UI state would
    be overwritten by and overwrite the user's own setting.
11. **The picker never opens by itself.** A new download does not open the picker or a notice,
    because the picker takes every key and would swallow what the user is typing; the status bar
    shows the download (decision 9).
12. **Live updates, rate-limited.** While the picker is open, `host/download-ops.mjs` is a view
    on the window's list. State changes and additions re-render at once; progress re-renders at
    most once a second per row, so that a fast download does not rebuild the DOM on every chunk and
    a screen reader is not flooded. Rows are keyed by a per-session id the host gives each
    `Download` object (a `WeakMap`), so the highlight stays on its download when rows move. The
    view is removed on close, and the status-bar segment uses a second view for the life of the
    window.
13. **Rows are text.** Names, hosts, verdict texts and paths are set with `textContent` and never
    parsed as HTML (rule C1), because a file name and a referrer are chosen by the page. The row
    shows the host, never the full URL, as the agent's download question does, so that a token in
    a download link is not on screen; `y` copies the full link on request.
14. **`shift+y` copies the path.** The file's path is copied as text, because "show in folder" depends
    on a file manager that a tiling desktop may not run (Research: on Linux `reveal` reports
    success even when nothing opens), and a terminal user can paste the path instead.
15. **macOS and Linux differ only where Firefox does.** `s` says `shown in Finder` on macOS and
    `asked the file manager to show it` on Linux, because only macOS confirms that something
    showed. Opening uses Launch Services on macOS (Gatekeeper checks a quarantined file there) and
    GIO's default application on Linux. No Vimma code is platform-specific beyond that wording.
16. **No new socket or MCP surface.** The control socket gets no downloads command, and no MCP tool
    lists or acts on downloads, because the downloads list spans every workspace and names files on
    the user's disk, which an agent confined to its workspace must not read. `downloads.picker` and
    every picker key stay off `AGENT_KEY_ACTIONS`, so `vimma_keys` and the built-in agent cannot
    reach them. A `full`-role connection's `send-keys` can press `ctrl+b d` and the picker's keys,
    as it can every key, because that role is treated as the user (docs/security.md, §1).
17. **Not in this feature.** "Always open similar files" and "always use the system viewer"
    (they change the stored handler of a MIME type, so a later download of that type opens by
    itself; Settings → Applications and `about:downloads` keep them); clearing the whole list;
    dragging a file out; choosing an app to open with; multi-select. Each can be its own change.
18. **Spam blocks are not listed.** The picker does not show the downloads Firefox blocked because
    one page started too many, because they live in a per-window spam list, not in the downloads
    lists, and stand for a URL and a count, with no file to open, show or delete. Firefox's panel
    opens for them (decision 10) and keeps its own allow and remove buttons there. Rejected:
    registering the picker as a view of that list, because every key but `!` would need a spam-only
    meaning for a case Firefox's panel already covers.

## Security and privacy

The picker adds a keyboard path to actions Firefox's panel already offers to the same person, and
every action runs through the same Firefox code (decision 5), so no check is bypassed: Firefox's
executable prompt, its blocked-download dialog and `allowOverride`, Gatekeeper on macOS, and Vimma's
agent-download rules M11-M13 all apply. What changes:

- **Rule C2 gains a third exception.** Opening a download and showing it in its folder hand a file
  to the OS, which is starting a process in C2's sense. `docs/security.md` C2 gets: chrome code may
  ask Firefox to open a download or show it in its folder only through
  `DownloadsCommon.openDownload` and `Download.showContainingDirectory`, only from
  `host/download-ops.mjs`, and only on a key the user pressed in the picker. The chrome-source test
  gets a second pattern for every call that hands a file to the OS or opens it: `.launch(` (any
  arguments), `.reveal(`, `openDownload(`, `showDownloadedFile(`, `showDirectory(`,
  `launchDownload(`, `loadFileIn(`, `launchWithFile(` and `showContainingDirectory(`. It allows
  `openDownload(` and `showContainingDirectory(` in `host/download-ops.mjs` only, and, by file and
  exact text, the three matches already on `main` at a109596: the agent override's definition
  `launchDownload(download, options) {` and its delegation `base.launchDownload(download, options)`
  in `ctl/AgentDownloads.sys.mjs` (lines 867 and 873), and the toolbar's own method call
  `this.reveal(shown);` in `ui/toolbar.mjs` (line 190), which is not `nsIFile.reveal`. A grep of
  `src/browser/base/content/vimma/` and `packages/vimma-core/src/` for every listed pattern finds
  those three and nothing else.
- **A new section, "Downloads picker"**, with rules D1-D6: names, hosts, verdicts and paths are
  text (D1, also listed under C1); a private window lists only its private downloads and a normal
  window never one (D2); a blocked download is released only through
  `confirmUnblockDownload` with the `chooseUnblock` dialog, never with `allowOverride` off, never
  for a `Malware` verdict, and never for an agent download, and a content-analysis `Malware`
  download is never removed or deleted from the picker (D3); an agent download is never opened, opened in the system
  app, retried, unblocked or followed to its referring page from the picker (D4, beside M12);
  `shift+d` and `c` ask first with the picker closed, and act only on the download asked about
  (D5); no agent role reaches
  the picker or the list (D6, beside M16).
- **Privacy.** The rows show the host, not the URL (decision 13). The status-bar segment shows
  counts and a percentage, never a file name. A private download is visible only in its own
  window and is gone with the session, as in Firefox.

The change touches neither the control socket nor the agent gate's code, but it adds rules to
docs/security.md and widens C2, so each sub-PR that changes those rules gets a review by a fresh
agent before it merges.

## Tests

Written first and seen to fail.

**vitest, `packages/vimma-core`:**

- `downloads.test.mjs`: `the state of a download follows Firefox's stateOfDownload`;
  `a row shows name, state word, progress, host and end time`;
  `progress reads 3.1 / 7.4 MB · 1.2 MB/s · 0:35 left`; `an unknown size shows bytes so far`;
  `a row shows the host, never the URL`; `another workspace's download names it`;
  `an agent download carries the agent glyph`; `sections: active then recent, newest first`;
  `the list is capped at 100 rows`; `the keys that apply follow isCommandEnabled for each state`;
  `Enter is open, resume, retry, the reason or nothing by state`;
  `unblock needs blocked data and allowOverride`; `a Malware verdict refuses !`;
  `a content-analysis Malware verdict refuses !, d and shift+d`;
  `d on blocked data is offered with the data deleted, as Firefox's remove`;
  `an agent download refuses o, shift+o, u, r and !`;
  `shift+d and c need a y/N; d does not`; `the filter matches name, host, state and workspace`;
  `the segment shows one, several, unknown size and paused`;
  `done goes after 10 seconds; failed and blocked stay until the picker is opened`;
  `failed and blocked outrank the title; progress gives way first`;
  `the segment's accessible text has no arrow`; `each end is announced once`.
- `picker.test.mjs`: `a download row's keys give a download effect; / types them`;
  `shift+d, c and ! close the picker before their effect`;
  `the highlight stays on its download when rows move`.
- `actions.test.mjs`: `downloads_picker is downloads.picker, in Browser, on prefix+d`.
- `agent-keys.test.mjs`: `downloads.picker is not an agent key action`.
- `cmdline.test.mjs`: `:downloads runs downloads.picker`.
- `help.test.mjs` snapshot: the new row.
- `tools/security/test/chrome-source.test.mjs`:
  `opens and reveals downloads only through Firefox's Download, from download-ops`.

**mochitest, `tests/browser/browser_vimma_downloads.js`** (a slow `.sjs` serves the files; the
test registers an `Integration.downloads` override that records `launchFile`,
`confirmLaunchExecutable` and `showContainingDirectory` instead of reaching the OS; `o` and `s`
reach those through `DownloadsCommon.openDownload` and `Download.showContainingDirectory`):

- `test_ctrl_b_d_opens_the_picker_and_esc_closes_it`
- `test_lists_session_then_history_newest_first`
- `test_progress_updates_live_and_the_highlight_stays`
- `test_enter_and_o_open_through_launchDownload`
- `test_an_executable_asks_firefoxs_prompt_first`
- `test_a_pdf_opens_in_a_tab_and_O_uses_the_system_app`
- `test_s_shows_the_file_in_its_folder`
- `test_pause_resume_and_retry`
- `test_cancel_asks_and_removes_the_partial_file`
- `test_d_removes_the_entry_and_keeps_the_file`
- `test_D_asks_and_deletes_the_file`
- `test_an_answer_does_nothing_if_the_download_changed`
- `test_the_y_answer_goes_to_the_question_never_to_the_picker`
- `test_enter_in_firefoxs_unblock_dialog_never_reaches_the_picker`
- `test_y_copies_the_link_and_Y_the_path`
- `test_u_opens_the_referring_page`
- `test_a_blocked_download_unblocks_only_through_firefoxs_dialog`
- `test_no_unblock_when_allowOverride_is_false`
- `test_a_malware_verdict_can_only_be_removed`
- `test_a_content_analysis_malware_verdict_cannot_be_unblocked_removed_or_deleted`
- `test_d_on_a_blocked_download_deletes_its_data`
- `test_spam_blocks_are_not_listed`
- `test_names_with_html_stay_text`
- `test_L_opens_firefoxs_downloads_view`
- `test_the_status_bar_shows_progress_then_done_failed_or_blocked`
- `test_starting_a_download_opens_no_panel_and_keeps_the_toolbar_hidden`
- `test_a_new_profiles_first_download_opens_no_panel`
- `test_a_blocked_download_still_opens_firefoxs_panel`
- `test_a_second_ctrl_b_d_does_not_close_the_picker`

In `browser_vimma_private_workspace.js`: `test_a_private_window_lists_only_private_downloads` and
`test_a_normal_window_never_lists_a_private_download`. In `browser_vimma_mcp_downloads.js`:
`test_the_picker_never_opens_an_agent_download`,
`test_the_picker_never_opens_an_agent_downloads_referring_page` and `test_vimma_keys_cannot_open_the_downloads_picker`.

**e2e:** a scenario `downloads-picker.json` that starts a slow download from a fixture page under
the Omarchy theme, saves baselines of the status bar's `↓` segment and of the open picker, and
checks the row's progress changes between two frames. The keymap sub-PR also screenshots the
`ctrl+b ?` overlay with the new row.

## Docs and changelog

- `docs/guide.md`: a new section "Downloads" after "Add-ons" (the picker, its keys, blocked
  downloads, agent downloads, macOS and Linux differences, `shift+y` on a desktop without a file
  manager); "Status bar" (the `↓` segment); "Hiding the toolbar" (the panel no longer opens by
  itself, except for a blocked download); "Firefox behaviour Vimma changes"
  (`browser.download.alwaysOpenPanel`, `browser.download.panel.shown`); the Features at
  a glance list.
- `docs/bindings.md`, `docs/bindings.json` and `packages/vimma-core/defaults.toml` regenerated with
  `npm run gen-docs`; the help snapshot updated.
- `docs/security.md`: C2 and the new section (Security and privacy above).
- `CHANGELOG.md` `[Unreleased]`, one line per user-visible sub-PR: "Status bar shows downloads in
  progress and finished, failed or blocked ones; Firefox's downloads panel no longer opens by
  itself for an ordinary download", "`ctrl+b d` opens a downloads picker", "the downloads picker can pause, resume, cancel,
  retry, remove and delete", "the downloads picker shows blocked downloads and allows them through
  Firefox's dialog".

## Delivery

Each sub-PR is mergeable and tested on its own; only sub-PR 3 changes the keymap.

1. **`feat(core): downloads rows, keys and status segment`.** Core `downloads.mjs` and its vitest:
   states, rows, the key table, the segment. No user-visible change, so no guide or changelog line.
2. **`feat(statusbar): show downloads in the status bar`.** The status-bar segment for downloads in
   progress and paused, with its view in `host/download-ops.mjs`; `browser.download.alwaysOpenPanel`
   off (`browser.download.panel.shown` is already on, since
   [#677](https://github.com/vimma-browser/vimma/issues/677)); mochitests for the segment and the
   three panel cases; guide "Status bar", "Hiding the toolbar" and "Firefox behaviour Vimma
   changes". The end states (`done`, `failed`, `blocked`) and their announcements wait for
   sub-PR 3, because two of them clear only when the picker opens.
3. **`feat(downloads): ctrl+b d opens a downloads picker`.** The action, `:downloads`, the picker
   kind with listing, live updates, filter, `o`, `shift+o`, `s`, `y`, `shift+y`, `u`, `shift+l`,
   and `Enter` as open; the segment's end states and announcements; the agent and private tests; C2 widened and the new docs/security.md section with D1, D2, D4 and
   D6, reviewed by a fresh agent. Regenerates the bindings docs and the help snapshot, with the
   `ctrl+b ?` screenshot and the e2e baselines.
4. **`feat(downloads): pause, resume, cancel, retry, remove and delete`.** `p`, `c`, `r`, `d`,
   `shift+d` with the `y/N` questions (the picker closed first) and rule D5; `Enter` gains resume and
   retry.
5. **`feat(downloads): blocked downloads in the picker`.** The `blocked` state, `Enter`'s reason,
   `!` through Firefox's dialog, `shift+d` on blocked data, the `Malware` and content-analysis
   refusals, rule D3 (reviewed by a fresh agent). Sets this
   spec to `implemented` and closes the issue.

## Open questions

1. **Where the view lives.** (a) A picker over the page (decision 1). (b) A panel in the side-panel
   slot, which can stay open beside the page to watch progress, at the cost of page width and of
   closing the tabs or bookmarks panel. (c) Vimma keys on `about:downloads`, which shows the full
   history in a tab but needs a content-side actor in a privileged page and adds a tab to a
   workspace. (d) The status-bar segment only, with Firefox's views for every action.
   **Recommendation: (a)**, because downloads are a short visit, the picker's key machine and filter
   exist, and the status bar covers watching.
2. **The entry key.** (a) `ctrl+b d`, the initial, free in the default keymap; tmux's detach has
   no browser meaning. (b) `ctrl+b y`, after Firefox's `ctrl+shift+y`. (c) Rebind `ctrl+shift+y` to
   the picker and leave the Library to `shift+l` and `:firefox Tools:Downloads`, which breaks the rule that
   Firefox's chords keep Firefox's meaning. **Recommendation: (a)**, because it is easy to remember
   and keeps Firefox's chord as Firefox's.
3. **Which downloads one window lists.** (a) Every download of the profile (of the private
   session in a private window), with another workspace's name on its rows (decision 4). (b) Only
   the current workspace's, with a key to show all, which can only work for this session's
   downloads, since history keeps no container. **Recommendation: (a)**, because a filter that
   silently drops every download from before a restart would be wrong more often than useful.
4. **Opening a viewable file downloaded in another workspace.** Firefox opens a PDF or an image
   in a tab of the download's container (`DownloadIntegration.sys.mjs:912`), and Vimma's routing
   puts such a tab in the workspace that owns the container, hidden, with an `opened in "work"`
   notice. (a) Keep that. (b) Switch to that workspace and tab after the open, so that `o` shows
   the file. (c) Open it in the current workspace, which needs Vimma's own `loadFileIn` in place of
   `launchDownload` and so would bypass the integration point where the agent rule lives.
   **Recommendation: (b)**, because the key asks to see the file, and the container only decides
   where it opens, not whether it is seen.
5. **How long `↓ done` stays.** (a) Until the picker is opened in that window, as Firefox's
   indicator keeps its attention until the panel opens. (b) 10 seconds, for `done` only, with
   `failed` and `blocked` kept until the picker opens (decision 9). (c) No `done` at all, only
   progress and problems. **Recommendation: (b)**, because a finished download
   needs no action, the bar's width is shared with the URL and title, and a problem still waits to
   be seen.
6. **"Always open similar files".** (a) Left out of the picker; Settings and `about:downloads`
   keep it (decision 17). (b) A key, `a`, that toggles it for the highlighted file's type, as
   Firefox's context menu does for a finished file it does not view itself.
   **Recommendation: (a)**, because one key in a list would make later downloads of that type open
   by themselves, a lasting change that deserves Firefox's settings page.
7. **Exposure to scripts.** (a) None beyond `send-keys` (decision 16). (b) A read-only
   `vimma-ctl downloads` for the `full` role, listing names, states and paths as JSON for scripts
   and status bars outside the browser. (c) An MCP tool listing the agent workspace's own downloads
   so that an agent can find the file it fetched. **Recommendation: (a)** for this feature, because
   (b) is a new socket command that needs its own protocol and security rules, and (c) widens what an
   agent can read, which needs a design of its own; either can be its own issue.
8. **Allowing a `Malware` verdict.** (a) Removal only, as Firefox's Library offers for every
   `Malware` verdict (decision 7). (b) `!` as for other verdicts, through the same `chooseUnblock`
   dialog, as Firefox's panel offers for a reputation `Malware` verdict (not for a content-analysis
   one). **Recommendation: (a)**, because a file a scanner names as malware has no safe reason to
   be allowed from a keyboard list, a user who must keep it can still allow it in Firefox's panel
   or Library, and the stricter of Firefox's two UIs is the one a security rule can rest on.
