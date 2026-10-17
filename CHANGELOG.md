# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer. From the first release on, release-please writes each release's entry from the Conventional Commits on `main` ([docs/runbook.md](docs/runbook.md), Releases).

## [0.1.5](https://github.com/vimma-browser/vimma/compare/v0.1.4...v0.1.5) · Firefox 158.0 (2026-10-17)


### Added

* **mcp:** clamav definitions age and clamdscan ([#355](https://github.com/vimma-browser/vimma/issues/355)) ([9b1d74b](https://github.com/vimma-browser/vimma/commit/9b1d74b08c2f3be4d3684456e3ad82fda93277e0)), closes [#232](https://github.com/vimma-browser/vimma/issues/232)


### Fixed

* **keys:** keep a capital letter whose lower case is two characters as typed ([#349](https://github.com/vimma-browser/vimma/issues/349)) ([8d17eb0](https://github.com/vimma-browser/vimma/commit/8d17eb0ef4fa04c8903406a7ee290ab6d53ff438)), closes [#313](https://github.com/vimma-browser/vimma/issues/313)
* **prompt-keys:** arm y and n on firefox's own prompt delay, and fix two test races ([#346](https://github.com/vimma-browser/vimma/issues/346)) ([d100a04](https://github.com/vimma-browser/vimma/commit/d100a04c37135c7647c1e7b07c85dcfd829bd405)), closes [#334](https://github.com/vimma-browser/vimma/issues/334) [#307](https://github.com/vimma-browser/vimma/issues/307)

## [Unreleased]

### Added

- Agent downloads: a ClamAV scan with definitions older than `[mcp] clamav_max_age_days` (default 7) is never reported clean, and clamd is used through `clamdscan` when it can be trusted, with `clamscan` as the fallback. The `defaults.toml` snapshot gains the new key.

## [0.1.4](https://github.com/vimma-browser/vimma/compare/v0.1.3...v0.1.4) · Firefox 158.0 (2026-10-17)


### Fixed

* **panel:** space marks a row and leaves the highlight on it ([#340](https://github.com/vimma-browser/vimma/issues/340)) ([c24ac76](https://github.com/vimma-browser/vimma/commit/c24ac76d9e4af30a3ee9ad37bcc81c25cf84cc73))

## [0.1.3](https://github.com/vimma-browser/vimma/compare/v0.1.2...v0.1.3) · Firefox 158.0 (2026-10-17)


### Added

* **theme:** the vimma logo follows the theme's colours ([#338](https://github.com/vimma-browser/vimma/issues/338)) ([ea67716](https://github.com/vimma-browser/vimma/commit/ea67716008d553270244fbe19f8da78990d2520e))
* **updates:** announce new versions once and ask about security updates per session ([#337](https://github.com/vimma-browser/vimma/issues/337)) ([2941983](https://github.com/vimma-browser/vimma/commit/29419831ab6927e3e59c3d345bd7e80d2cf51eb2)), closes [#336](https://github.com/vimma-browser/vimma/issues/336)


### Fixed

* **install:** build the arch linux package in ~/.cache/vimma-build from any directory ([#333](https://github.com/vimma-browser/vimma/issues/333)) ([e4135c5](https://github.com/vimma-browser/vimma/commit/e4135c535cf8375d28b5059971bf71f46a231ec0))

## [0.1.2](https://github.com/vimma-browser/vimma/compare/v0.1.1...v0.1.2) · Firefox 158.0 (2026-10-16)


### Added

* **promo:** record tab search, live grep and the private workspace ([#328](https://github.com/vimma-browser/vimma/issues/328)) ([6ea7509](https://github.com/vimma-browser/vimma/commit/6ea75092bc7d98b48a57122f691072f1b74e76ed))
* **updates:** pin the primary update key ([#315](https://github.com/vimma-browser/vimma/issues/315)) ([2b99fb9](https://github.com/vimma-browser/vimma/commit/2b99fb9cc79a829b32ae5278283db6b5efb9b8e2))
* **updates:** sign and publish the update manifest when a release is published ([#327](https://github.com/vimma-browser/vimma/issues/327)) ([afd32bf](https://github.com/vimma-browser/vimma/commit/afd32bf1e88447ebb99428f01baa746344135e61))


### Fixed

* **package:** mark the .deb and the AppImage as package installs ([#322](https://github.com/vimma-browser/vimma/issues/322)) ([86ebabc](https://github.com/vimma-browser/vimma/commit/86ebabc56df42a15de134066c311691bae3b59ee))
* **release:** compare only stdout in the --version smoke checks ([#317](https://github.com/vimma-browser/vimma/issues/317)) ([1886493](https://github.com/vimma-browser/vimma/commit/188649323d50508f9916dbb1c689f370076f54a2))
* **release:** release-title keeps a draft release on its tag ([#311](https://github.com/vimma-browser/vimma/issues/311)) ([0427489](https://github.com/vimma-browser/vimma/commit/0427489c1e26757940a6043c35a36decb3f096f3))
* **security:** ship release firefox's devtools defaults ([#318](https://github.com/vimma-browser/vimma/issues/318)) ([798896b](https://github.com/vimma-browser/vimma/commit/798896b30798b21c200107a00d490fd4a71b999e))
* **theme:** web pages follow the dark or light vimma shows ([#324](https://github.com/vimma-browser/vimma/issues/324)) ([80b5bdb](https://github.com/vimma-browser/vimma/commit/80b5bdb889104cd67d7847bfd1d3bff3b72ce2ac))
* **workspaces:** links from other apps never open in the agent workspace ([#320](https://github.com/vimma-browser/vimma/issues/320)) ([8deab37](https://github.com/vimma-browser/vimma/commit/8deab3794889626f50676fce806a5e7faaff01e0))

## [0.1.1](https://github.com/vimma-browser/vimma/releases/tag/v0.1.1) · Firefox 158.0 (2026-10-16)

The first release. The in-app updater is included but not active yet: there is no update host and no signing key, so Vimma does not tell you about new releases. Until it is, update by installing the newer release the way you installed this one: on Arch Linux, run `curl -fLO https://github.com/vimma-browser/vimma/releases/latest/download/PKGBUILD && makepkg -si` again in the same directory; otherwise install the newer `.deb`, AppImage or tarball.

### Added

- Update checks: every 12 hours Vimma fetches a signed manifest from `updates.vimma.dev` and, when a newer release exists, the status bar says `⇡ 0.3.1 available` (red, `⇡ 0.3.1 security: :update`, for a Firefox security release). `:update` checks at once and opens about:vimma's new Updates section with the exact commands for how Vimma was installed (the release's PKGBUILD, AUR, `.deb`, tarball or AppImage). The request is anonymous and names only the platform and the update channel; `[updates] check = false` or `vimma.update.enabled` = `false` turns it off. Nothing is installed yet, and no update host or signing key exists yet, so the check is not active. The help-text and `defaults.toml` snapshots gained the unbound `check_updates` and `[updates]`.
- Arch Linux: each release carries a vimma-bin PKGBUILD; `curl -fLO https://github.com/vimma-browser/vimma/releases/latest/download/PKGBUILD && makepkg -si` installs or updates Vimma without the AUR (#300).
- Live grep: `ctrl+b f g` searches the text of every tab in your workspace as you type, like Telescope's `live_grep`: the `Live Grep` prompt at the bottom, the results above it with the best one next to it, and a preview of the lines around the selected match on the right. The query is a regular expression with ripgrep's smart case (text that is not one is searched as typed); a scope box says which windows, workspaces and tabs are searched, every row names its window, tab and host, and `ctrl+s` widens the search from the workspace to the window, to every window, and to the titles and URLs of recently closed tabs and windows (`Enter` reopens one); `ctrl+space` refines the results fuzzily. `Enter` selects the tab and the match in normal mode, `]q` / `[q` step through the results afterwards, and `:grep text` opens it with that text, `:grep` with the last query. Tabs not loaded since a restart are listed, never loaded; private tabs never reach a normal window. The help-text and `defaults.toml` snapshots gained `live_grep`, `grep_next`, `grep_previous` and `grep_resume`, and the e2e baselines `live-grep` and `live-grep-jump` are new.
- Tab search: `ctrl+b g` (`b`, `:ls`) opens ready to type and finds tabs in every workspace and window and recently closed tabs and windows; rows show workspace, window, audio and agent markers, and `:tabsearch text` (`:ts`, `:b`) opens it with text typed. The help-text snapshot changed with the action's new description.
- `ctrl+b u`, `:toolbar [show|hide]` and `[ui] toolbar = "hidden"` hide Firefox's toolbar in every window: the page reaches the top of the window. Focusing the address bar (`I`, `ctrl+l`, `F6`, a new tab) shows a minimal bar over the page with only the URL field, and `Enter` or `Esc` hides it again; a permission prompt or the site's identity panel shows the whole address bar and hangs from its icon as with the toolbar shown; the full toolbar shows while an add-on popup or a toolbar panel is open, and `ctrl+b u` brings it back otherwise; the status bar says `not secure` and `private` meanwhile. Shown or hidden, the toolbar, its URL field and suggestions and the prompts and panels hanging from it follow Vimma's theme, and a permission prompt answers `y` (allow) and `n` (block) once armed, `Tab` moving onto its buttons. The account panel no longer offers "Get Vimma for Android or iOS", an app that does not exist. The help-text and `defaults.toml` snapshots gained the three actions and `[ui]`; the e2e baselines `toolbar-hidden` and `toolbar-minimal` are new, and `m0-happy-path-help`, `m0-mcp-stdio-question`, `m0-mcp-stdio-grant`, `m3-private-workspace` and `m4-split-panes` show the themed toolbar.
- Search engines in `config.toml`: `[search] default` sets the default engine and `[search.aliases]` gives `@aliases` (`gh = "https://github.com/search?q=%s"` makes an engine; `w = "Wikipedia (en)"` names an installed one), for the URL bar, `:open` and `:tabnew`; `:open @` completes them, and `:open` also resolves Firefox's own aliases and bookmark keywords (a keyword bookmarklet is refused). The file wins at every start; removing a line restores the previous default and aliases. Unknown engines and taken aliases show as config errors with their line, and about:vimma gains a Search section. The `defaults.toml` snapshot gained a commented `[search]` block.
- Agents (MCP): `vimma-ctl mcp` is the MCP server that Claude Code, Codex, opencode and Copilot start (`claude mcp add --transport stdio vimma -- vimma-ctl mcp`, then `:mcp on` in Vimma). It speaks MCP 2025-06-18, 2025-11-25 and 2026-07-28 over stdio and offers `vimma_tabs`, `vimma_read_page`, `vimma_open` and `vimma_close_tab`, which reach only the agent workspace and each wait for your answer on the question line. Page text comes back marked as untrusted; a denial, an unanswered question, MCP off or Vimma not running comes back as a tool error that says what to do; cancelling a call in the agent takes its question off the line (the new control-protocol command `agent-cancel`). The e2e baselines `m0-mcp-stdio-question` and `m0-mcp-stdio-grant` are new.
- Agents (MCP): downloads from the agent workspace work again, safely. Each asks first in the agent question line with the file's name, size, type and site (never the address), and a `vimma_download` grant covers that agent's next ones; files go only to `~/Downloads/vimma-agent/` (`[mcp] download_dir`) with mode 0600, are never opened by Vimma, and keep a `.part` name until checked. Executables, scripts, installers, archives Vimma cannot look inside and zips holding any of them need `!` for that one file; plain `http:` and files over `[mcp] download_max_mb` (200 MB) are refused; with the system's ClamAV (`/usr/bin/clamscan`, optional, not bundled) each file is scanned first, keeping one ClamAV could not fully scan is asked, and the notice says scanned or not scanned. A grant covers only the agent's own opened download, never what its pages download later; zips holding executables, links or paths outside their folder need `!`; the quarantine folder must be a private folder of yours. Your own Save Page in an agent tab saves where you choose, unasked. `vimma-ctl` now prints its full-control code only after sending it. The `defaults.toml` snapshot gained `download_dir` and `download_max_mb`.
- Agents (MCP): an agent's request now asks in one line at the foot of the window (`y` once, `15a` for 15 minutes, `n`, `x` to deny and mute), armed after a second, never while you type or with focus in a field, and never taking focus; otherwise it waits as `◇ agent 1?` in the status bar for `ctrl+b shift+a`. `◇ agent 14m` counts a grant down, calls under a grant show a notice, and a window not in front is marked urgent with a desktop notification that has no address and no buttons. While agents are on, each new `vimma-ctl` connection asks `vimma-ctl wants full control — y/N` first, and `:control on <minutes>` turns full control on for a while. Pages in the agent workspace get no permission prompt (location, notifications, camera, microphone, screen and the rest are refused) and open no pop-up. The help-text and `defaults.toml` snapshots gained `agent_prompt` on `ctrl+b shift+a` and the unbound `control_command`.
- Agent workspace: every profile has an empty `agent` workspace (cyan, its own container and logins), made at its next start, for local AI agents to use once `vimma-ctl mcp` lands. `ctrl+b ( )`, `]w` / `[w`, `:wn` / `:wp` and `ctrl+^` skip it; the workspace picker lists it last as `◇ agent`. Closing it only empties it, renaming it is refused, `:mcp forget` clears its logins after y/N, and moving a tab there warns that agents can read it. `:mcp on|off` (with y/N) and the validated `[mcp]` table in `config.toml` (schema 2) set whether agents may ask; about:vimma shows it. The help-text snapshot gained the unbound `mcp_command` action in a new Agents group, and the `defaults.toml` snapshot the `[mcp]` section.
- Theme: `:theme dark`, `:theme light` and `:theme system` (or `[theme] appearance` in `config.toml`, which wins) keep the built-in palette dark or light or have it follow the system, live and across restarts; the start page and `about:vimma` say how. Off Omarchy, Vimma no longer looks for Omarchy: it checks once at startup, and without it there is no theme poll, no hook check and no Omarchy wording. The help-text and `defaults.toml` snapshots gained the action and the `appearance` comment.
- Firefox's keys are Vimma bindings with Firefox's meaning: `ctrl+t`, `ctrl+shift+t`, `ctrl+l`, `alt+left` / `alt+right`, `F5`, `ctrl+tab`, `alt+1..9`, `ctrl+plus` / `ctrl+minus` / `ctrl+0`, `ctrl+n`, `ctrl+q` (Firefox still asks first), `F11`, `ctrl+s`, `ctrl+p`, the Library keys and the DevTools keys, 37 new actions in the new Browser and Developer tools groups and in Tabs (`restore_tab` moves there). `ctrl+b ?`, `:map` and `docs/bindings.md` list them with Vimma's keys (`alt+left` under "Go back", next to `H`, `ctrl+o` and `ctrl+[`), `[keys]` rebinds them by name, and a page that uses one itself (an editor's `ctrl+s`) still gets it first, as in Firefox; Firefox's own shortcut on a key Vimma binds is off. `docs/bindings.md` gains a generated "Firefox's shortcuts" table. The help-text and `defaults.toml` snapshots changed with the new keys, and the e2e baseline `m0-happy-path-help` was re-recorded: the bindings overlay lists Firefox's keys (ctrl+t, alt+1..9, ctrl+tab …) next to Vimma's.
- `docs/bindings.json` is generated with `docs/bindings.md` from the same source, and vimma.dev is told when the default bindings change, so its `?` overlay lists every Vimma binding (#154).
- The start page shows Vimma's version and the Firefox release it is built on, read from the build (#159).
- Private workspace on Hyprland: going to it puts the private window exactly where the Vimma window was (same workspace, tile, size, fullscreen or floating) and hides the normal window in `special:vimma` until you switch back, close the private window, or a link from another app arrives. Vimma talks to Hyprland's socket with a fixed command set and sends no titles or URLs; `[private] placement = "window"` keeps it a separate window. Private windows' titles no longer include the page title (`privacy.exposeContentTitleInWindow.pbm` = `false`). The `defaults.toml` snapshot gained the `[private]` section.
- Side panel: with a split, the panel opens with the panes' tabs marked. Unmark one and `Enter` takes it out of the split (it stays open, right after the split) while the other panes keep their sizes; unmark down to one to end the split; mark another tab to add it. `Enter` then goes to the highlighted row: unmark pane C and press `Enter` on C, and C shows alone while the others wait as a hidden split. Going to any tab outside a split (the picker, `ctrl+tab`, `alt+1..9`, `ctrl+b n`/`p`, a click, the panel) now shows it alone and keeps the split hidden, as Firefox's split view does, instead of putting it in the focused pane; going to one of the split's tabs brings it back whole, also after a workspace switch or a restart, and the status bar says `split 3 hidden` meanwhile. A new tab (`ctrl+t`, a link) still opens in the focused pane. The help-text snapshot changed with the new `Enter` and `Esc` descriptions.
- Private workspace: `ctrl+b shift+p` (or `ctrl+shift+p`, `:private`) goes to Firefox's private window as if it were one more workspace, and back. It is never a stop on `ctrl+b (` / `)`; the workspace picker lists it last with a tab count only; `m` moves a tab in after y/N; `ctrl+b shift+d` there closes every private window, pop-ups included, and discards its data. `vimma-ctl state` withholds its URLs and titles. The help-text and `defaults.toml` snapshots gained the key, and the e2e baseline `m3-private-workspace` is new.
- Vimma's own palette from vimma.dev, mint on green-black, is the built-in theme, light or dark as the system is, and switches live. Omarchy themes are unchanged; `[theme] name = "tokyo-night"` brings back the old palette. The e2e baselines `m0-happy-path-help` and `m4-split-panes` and the `defaults.toml` snapshot changed for it.
- Side panel: mark tabs with `space` or a `V` range, and `Enter` shows them together as panes in the workspace's layout (dwindle by default) without reloading them; past `[panes] max` it refuses and changes nothing. The help-text and `defaults.toml` snapshots gained the two new keys.
- `about:license` lists the smol-toml TOML parser's BSD-3-Clause notice under Vimma, so release builds carry it (#16).
- Bookmarks per workspace: each workspace has its own folder in the Bookmarks Toolbar, and the bookmarks panel shows only the current workspace's bookmarks, following you as you switch. `ctrl+b a` and `:bookmark` file there, `@name/` targets another workspace, and renaming or deleting a workspace renames its folder or asks what to do with its bookmarks. `[bookmarks] root = "workspace" | "toolbar" | "all"` picks the view.
- Accessibility: pickers and panels expose the selected row to screen readers, bookmarks are a tree, prompts are dialogs, notices are announced once, and panels give focus back when they close. Text colours meet WCAG AA in the built-in dark and light themes. The help-overlay screenshot baseline was re-recorded for the new colours.
- Tiling layouts: `ctrl+b enter` opens a pane split along the focused pane's longer side (dwindle), and `ctrl+b space` or `:layout` cycles tmux's presets (even-horizontal, even-vertical, main-vertical, main-horizontal, tiled) and dwindle without reloading any page. `[panes] layout` and `main_size` in `config.toml` set the defaults; each workspace keeps its layout across switches and restarts. The help-text and `defaults.toml` snapshots changed with the new keys and options.
- Workspaces work like Vim buffers: `ctrl+^` (or `ctrl+6`, since `^` is a dead key on Finnish layouts) and `ctrl+b ^` flip to the previous workspace, `]w` / `[w` step through them, and `:ws`, `:wn`, `:wp`, `:wd`, `:wa`, `:workspaces` and `:ws #` mirror the buffer commands. A command abbreviation now runs when it begins every other match (`:wor` is `:workspace`).
- `ctrl+b e` or `:addons` opens a keyboard add-on manager: `Enter` opens an add-on's popup with focus inside it, `o` its options, `x` turns it on or off, `d` removes it after y/N, `u` checks for updates and `shift+p` allows it in private windows; `:addon <name>` opens one popup directly. System and hidden add-ons are never listed.
- In text fields `ctrl+w` deletes the previous word, `ctrl+u` deletes to the start of the line and `ctrl+h` deletes a character, as in Vim, and `ctrl+z` undoes them (`[modal] insert_editing = false` turns this off).
- `x` in the side panel closes the selected tab and keeps the panel open; pinned tabs are left alone.
- The browser builds as Vimma: `vimma --version` prints `Vimma 0.1.0 · Firefox 158.0`, and the window title, brand strings, app name and vendor say Vimma. The app icon is the window-and-V mark from the Vimma logo, on a dark window that reads on light and dark desktops; the start page shows the full logo, transparent, with a dark tile under light themes.
- `ctrl+b ?` opens a bindings overlay over any page, including `about:preferences` and the PDF viewer. `/` filters it, `Esc` or `q` closes it and focus returns to where it was. A bare `ctrl+b` waits for the next key without a timeout.
- Firefox's tab strip is hidden by default. Set `vimma.ui.tabstrip.hidden` to `false` in `about:config` to show it again, without a restart. Firefox's tab keys and the window controls keep working.
- Key capture across the whole window, including `about:` pages, the URL bar and the PDF viewer. Set `vimma.debug.keys` to log each key to the console.
- `vimma-core`: tmux-style prefix and Vim key notation, the closed action set, the default keymap, a keymap compiler with "did you mean" suggestions, and a dispatcher with counts, timeouts and replay. `docs/bindings.md` and `defaults.toml` are generated from it (`npm run gen-docs`).
- Help-text and `defaults.toml` snapshots recorded for the first time.
- `vimma-core`: `config.toml` schema v1 validation with `file:line` errors and suggestions, schema migrations, keeping the last good config on error, and theme tokens from Omarchy's `colors.toml`, `[theme.colors]` or the built-in Tokyo Night.
- Artifact builds (`tools/artifact-build`, `npm run mochitest -- --artifact`): test the front end on Mozilla's binaries for the same release, locally and on every PR.
- A tmux-style prefix layer: `ctrl+b` (tmux's default prefix), then a key, works in every mode. `ctrl+b c`, `n`/`p`, `1`-`9` and `shift+x` open, cycle, pick and close tabs; `t`, `x`, `gt` and `gT` do the same in normal mode.
- Vim keys on pages: `j`/`k`/`h`/`l` with counts, `d`/`u` and `ctrl+d`/`ctrl+u` (half a page), `ctrl+e`/`ctrl+y`, `gg`/`G`; focusing a text field enters insert mode and `Esc` leaves it, `i` and `gi` focus the first field. Keys Vimma does not bind still reach the page.
- `H`/`L` (or Vim's `ctrl+o`/`ctrl+i`) go back and forward and `r` reloads, in the focused pane; `yy` copies the page URL, `p`/`P` open the clipboard here or in a new tab, `gu`/`gU` go up a level or to the site's root, and `gf` shows the page source.
- Link hints: `f` labels every link, button and field on screen, also in frames and web components, and `F` opens a link in a background tab. The labels are drawn by the browser, so pages cannot see or restyle them.
- Vim-style find: `/` and `?` search forward and backward with smartcase, `n`/`N` repeat, and the status bar shows the match count.
- Copy mode: `v` or `ctrl+b [` puts a caret on the page; Vim motions (`w`, `e`, `f`/`t`, `{`/`}`, counts), `v`/`V` selections, `iw`/`aw` and `y`/`Y` copy text. Selecting text with the mouse enters copy mode too.
- An always-visible status bar on the window's last line: mode, pending keys, workspace, `tab n/N`, panes, title or tab name, search, loading and URL.
- A Vim-style command line on `:`, with completion, history (a private window keeps its own), errors with "did you mean" and commands such as `:open`, `:tabnew`, `:q`, `:ls`, `:tabrename` and any action by name.
- `ctrl+b g` (or `b`) opens a fuzzy goto picker of the window's tabs, and `ctrl+b shift+t` names a tab; the name shows in the status bar and picker and survives a restart.
- Workspaces, each a Firefox container of its own, so a login in one is invisible in another: `ctrl+b (`/`ctrl+b )` switch (tmux's session keys, from every mode), `ctrl+b shift+n`/`shift+w`/`shift+d` (or `:wsnew`, `:wsrename`, `:wsdelete`) create, rename and delete, `:wsmove` moves a tab, and the `ctrl+b w` picker shows tab counts and moves tabs. New tabs and windows open in the current workspace, and a restart restores every workspace, its tabs, panes and tab names.
- `I` (shift+i) jumps to the address bar with the address selected, from normal and copy mode or with a panel open, for the focused pane; in a text field it still types `I`.
- An on-demand side panel (`ctrl+b b` or `:sidebar`) lists the current workspace's tabs; `j`/`k`, `Enter` or `1`-`9` pick one.
- Routing: `[[routes]]` in `config.toml` sends a domain, URL prefix or the app that opened a link (via `vimma-open`) to a workspace; `:route` lists, adds and moves.
- Split panes on Firefox's split view, up to 4 per workspace (`[panes] max`): `ctrl+b v`/`-` split, `ctrl+b h/j/k/l` (or `ctrl+w h/j/k/l`) move focus, `ctrl+b z` zooms, `ctrl+b x` closes a pane, `ctrl+b shift+h/j/k/l` swap and `ctrl+b r` enters a resize mode. Each workspace keeps its own split, and a split made outside Vimma becomes panes.
- Bookmarks: `ctrl+b a` (or `:bookmark`) files the page under a folder path from anywhere, and `ctrl+b shift+b` or `:bookmarks` opens a neo-tree style bookmarks panel to open, add, rename, move and delete.
- A Vimma start page for new windows and tabs, with the Vimma logo and a key hint, themed and local. `vimma.startpage.newtab` turns it off for new tabs.
- Vimma loads `~/.config/vimma/config.toml` and reloads it within 2 s in every window, without a restart. Every key, the prefix and the leader can be remapped there. A broken file keeps the last good config and shows `config.toml:LINE` in the status bar; `:source` reloads now, `:source <path>` loads another file and `:config` opens the file. On first run Vimma creates a commented `config.toml` (mode 0600) and never overwrites it.
- Vimma follows your current Omarchy theme live: the status bar, command line, overlay, pickers, hints, panes and start page take its colours, and a theme-set hook Vimma installs recolours them as soon as the theme changes. `vimma.theme.source = builtin` keeps Tokyo Night.
- `about:vimma` (or `:about`) shows versions, upstream patches, modes and recent keys (typed text masked), config errors, theme, workspaces and the control socket; `:bug` copies a redacted report.
- `vimma-ctl`, a Rust command-line client for a local control socket that is off by default (`vimma.control.enabled`): `send-keys`, `state`, `open` and `reload-theme`.
- `npm start` runs your build with its own dev profile, and a socket-driven end-to-end test suite runs under Xvfb.

### Changed

- Firefox's find bar, menus, dialogs (page alerts, prompts, print settings) and its own pages (Settings, Add-ons, Downloads, Troubleshooting, about:config) follow the Vimma/Omarchy theme; Settings no longer shows Firefox's mascot (#305).
- Nightly builds are a 7-day workflow artifact instead of a public pre-release until the first release; the build job holds no write token (#292).
- Release and nightly builds run on GitHub-hosted runners from a freshly downloaded, checksum-verified Firefox source (#286).
- Surfer is pinned and never auto-merged, npm install scripts are off, and no workflow can target a self-hosted runner (#280).
- Repository links, update URLs and the release signing identity point at vimma-browser/vimma (#278).
- Firefox 158.0 ([MFSA 2026-106](https://www.mozilla.org/en-US/security/advisories/mfsa2026-106/)).
- The e2e baseline `m0-happy-path-help` was re-recorded on Firefox 158.0, which antialiases the bindings overlay's text slightly differently (1.26 % of pixels, every row in place) and draws its scrollbar thumb 3 px shorter; nothing else in the screenshot changed.
- `vimma --version` prints Vimma's version and the Firefox release it is built on (`Vimma 0.1.0 · Firefox 158.0`) instead of `Vimma Vimma 0.1.0`.
- Firefox's own shortcuts that overlap Vimma or Vim are off: `ctrl+w` (close tab), `ctrl+u` (page source), `ctrl+h` (history), `ctrl+d` (bookmark dialog), `ctrl+o` (open file), `ctrl+i` (page info), `ctrl+k` (web search) and `ctrl+b` (bookmarks sidebar). `[firefox] disable = "all" | [...]` and `enable = [...]` in `config.toml` change the set; `about:vimma` lists what is off. The help-text and `defaults.toml` snapshots changed with the new keys and options.
- Characters typed with AltGr (Linux, Windows) or Option (macOS), such as `{`, `}` and `$` on Finnish layouts, match their bindings.
- `ctrl+b ?`, `:map` and `about:vimma` list the keys you press (`ctrl+b b`, `ctrl+b shift+x`, `ctrl+w h`) instead of config notation (`prefix+b`), following a remapped prefix or leader; the legend names the leader only when a binding uses it. The help-text snapshot changed to match.
- Workspaces switch with `ctrl+b (` / `ctrl+b )` instead of `ctrl+u` / `ctrl+i`, which are Vim's half-page-up and jump-forward keys in normal mode now; `ctrl+o` there goes back instead of opening a file (the File menu and `:open` still do). The help-text and `defaults.toml` snapshots changed with the defaults: the workspace, scroll and history rows list the new keys.
- Project renamed from vimux to Vimma: `packages/vimma-core`, `src/browser/base/content/vimma/`, `~/.config/vimma/config.toml`. The `defaults.toml` snapshot changed only in its generator-path comment.
- `ctrl+b` no longer opens Firefox's bookmarks sidebar. It is Vimma's tmux-style prefix key; `ctrl+b shift+b` opens Vimma's bookmarks panel.
- `vimma-core` vendors smol-toml 1.9.0 (BSD-3-Clause) as its TOML parser: source in the repo, not an npm dependency ([ADR-012](docs/adr/012-toml-parser-smol-toml.md)).
- `defaults.toml` snapshot changed: it gains the commented `[workspaces]`, `[theme]` and `[theme.colors]` sections of schema v1; bindings unchanged.
- Help-text and `defaults.toml` snapshots changed: they gain the bookmark bindings (`ctrl+b a`, `ctrl+b shift+b`, `<leader>b` and the panel's neo-tree keys); no other row moved ([bookmarks](docs/specs/bookmarks.md)).
- The leader has no default bindings: `space n` and `space b` no longer open the side panel and the bookmarks panel (`ctrl+b b` and `ctrl+b shift+b` do). Help-text and `defaults.toml` snapshots changed: `toggle_sidebar` and `toggle_bookmarks` lose `<leader>n` and `<leader>b`; no other row moved. The leader itself stays, for bindings you add in `config.toml`.
- Closing the last tab keeps the window open with a new tab, startup restores the previous session, and the new-tab page is no longer preloaded. Each can be changed back in `about:config`.
- Config schema 2 adds `[panes] max`, `[modal] hint_chars`, `[sites."host"] insert` and `[[routes]]`; a schema 1 file migrates as is.

### Fixed

- `Esc` leaves insert mode on pages that put focus back into a field, and right after `Tab` into a frame from another site (#301).
- about:vimma's Search line no longer lists a search alias that config.toml names but Vimma could not apply (#297).
- A find match in a text field no longer loses its highlight colour when the find bar closes under load (#285).
- Insert mode: after `i` or `gi`, a page that moves focus itself (a file finder jumping to its result list, a dialog taking focus) no longer drops the tab back to normal mode, so the keys you type keep going to the page instead of running Vimma commands; only `Esc` or a new page ends it. `i` now goes back to the text field you were last in on the page, and falls back to the first one (#165). The help-text snapshot changed with `i`'s new description.
- Omarchy themes whose `colors.toml` has only the terminal colours (accent, foreground, background, color0–color15, such as Event Horizon) are no longer rejected: Vimma derives the rest as Omarchy does (#266).
- A find whose match is in a text field (`/` then Enter) keeps the match highlighted the way Firefox's find bar does, instead of showing it greyed out (#270).
- The e2e baseline `m3-private-workspace` was re-recorded: it predated the start page's version footer (#159) and `:theme` hint (#173), and the scenario now opens the private window only once the search service is ready, so its URL bar always names the default engine ("Search with Google or enter address" and its icon) instead of sometimes showing the engine-less placeholder and magnifier (#236).
- Opening external-protocol links and download prompts no longer fails on Firefox 158.
- Split panes keep pages exactly at their pane edges on Firefox 158.
- The side panel no longer names the agent workspace as the `ctrl+b (` / `ctrl+b )` target, in a normal or a private window.
- A megabyte-long unknown key or value in `config.toml` no longer stalls the "did you mean" suggestion (#196).
- Keys typed right after switching to a workspace whose start page is still being restored are no longer lost: focus waits on the window until the page has loaded (#140).
- Private workspace on Hyprland: Vimma listens to Hyprland's events again even when a switch happens just as Hyprland closes the event socket (#163).
- On Hyprland the private workspace now really takes the Vimma window's place (a new private window used to be shown beside it); a swap that cannot name the window says so once in the console and in `about:vimma` (#160).
- A key name with a bracket or a quote in `config.toml` is reported as an error instead of crashing the config reload (#134).
- Find: a match in a page's search box (YouTube, DuckDuckGo) no longer switches the tab to insert mode; `n` / `N` keep stepping through matches (#164).
- A playing video keeps the screen awake on Wayland: Vimma sets Firefox's own `MOZ_WAKE_LOCK_TYPE=WaylandIdleInhibit` at startup on Linux unless one is exported, since the portal path inhibited nothing on Hyprland (#153).
- The side panel's scrollbar takes the theme's colours instead of Firefox's white track; the bookmarks panel's too (#146).
- Firefox's own sidebar (history, bookmarks, synced tabs and the launcher strip) follows the theme, live, with the theme's focus ring instead of Firefox's blue (#148).
- The address bar's focus ring, the focused pane's outline in a split and other focus rings in the browser's own UI take the theme's accent instead of Firefox's blue, a shade darker or lighter where the accent would miss 3:1 contrast.
- Vimma's side panel, bookmarks panel, pickers and help overlay draw their focus ring in the theme accent instead of Firefox's blue. The e2e baseline `m0-happy-path-help` changed for the help overlay's ring.
- `npm run import` no longer fails after a patch changes: it restores the Firefox files our patches touch before re-applying them. `tools/relocate-checkout.mjs` repairs a checkout that was moved.
- Switching workspaces with `ctrl+b (`, `ctrl+b )` or `:workspace` no longer shows "no workspaces in this window" after a successful switch.
- Sites see Firefox's user agent (`… Gecko/20100101 Firefox/158.0`), not `Vimma/0.1.0`.
- Everything that asks for the Firefox version (webcompat interventions, add-on updates, Remote Settings and Nimbus targeting, backups) gets Firefox's (158.0). `--version` shows Vimma's 0.1.0 with the Firefox version, and the About dialog shows Vimma's 0.1.0.
- Startup no longer throws in BrowserGlue, so `about:home` and `about:newtab` load again.
- The build stops with "run 'npm run import'" when the version files are missing, instead of silently building as 0.1.0 everywhere.
- The `ctrl+b ?` overlay takes the theme's colours instead of staying white under a dark theme.

### Security

- The Firefox source is accepted only when Mozilla's release key signed its SHA512SUMS; `npm run verify-source` checks a local download (#289).
- A quarterly audit checks every change to Firefox's own code against its register entry, size budget and review date, and opens an issue with the report.
- Firefox security updates on autopilot: every 4 hours CI checks Mozilla's releases and advisories, opens a tracking issue, verifies the source, checks the patches, runs every test suite and opens the update pull request. A security release left unshipped for 3 days fails CI and opens an issue.
- Every parser of outside input (control protocol, `config.toml`, routing rules, key notation, the command line, Omarchy theme files, `vimma-ctl`) is fuzzed in CI and nightly. Fuzzing found and fixed unbounded TOML nesting, `constructor`-named keys crashing a reload, a slow IPv6 pattern, an 8 s freeze on a huge `:` paste and a malformed control message wedging its connection.
- Vimma does not join Mozilla's studies, experiments or rollouts (Normandy, Nimbus) and shows no sponsored stories, shortcuts or address-bar suggestions, remote recommendations or Mozilla promos. Each default can be turned back on in `about:config`.
- Builds have no crash reporter and no official telemetry, so nothing is sent to Mozilla. A crash leaves a local core dump.
- Remote Settings (CRLite certificate revocation, intermediates), the add-on blocklist, Sync and AMO add-on updates stay as in Firefox. Safe Browsing's phishing, malware and unwanted-software lists are on in builds made with a Google API key (the nightly); a keyless build shows the protection as off ([docs/limits.md](docs/limits.md)).
- The control socket listens on `127.0.0.1` only and is off by default. Clients need a 256-bit token from a file only you can read, the browser proves it holds the token before the client sends it, and connection, size and idle limits apply. `open` refuses `javascript:` and `data:`.
- Routing never acts on a link a page opens or a page's own navigation, so a page cannot open a site with another workspace's logins.
- Every way Vimma opens a URL (`:open`, `:tabnew`, `p`/`P`, bookmarks, the control socket) refuses `javascript:` and `data:`, also behind `view-source:`.
- [docs/security.md](docs/security.md) states what each risky part may and must never do, every rule linked to the test that enforces it, and CI fails if a linked test disappears. [SECURITY.md](SECURITY.md) explains how to report a vulnerability privately.
- Deleting a workspace asks first and clears its container's site data; a container deleted outside Vimma is replaced at once, so new tabs never land in the default container.
- Semgrep and CodeQL scan every PR, and a PR that adds a high-severity CodeQL alert cannot merge. CodeQL's first scan found 15 alerts; 14 were fixed (regex backtracking replaced by linear scans, file races, Markdown escaping in generated docs) and one was a false positive.
- Dependencies are kept current: Dependabot proposes updates weekly, and security, patch and minor updates merge on their own once every required check passes. The build tools' outdated `sharp` and `qs` were lifted past their advisories.

### Removed

- Firefox's app updater: Vimma no longer asks Mozilla's update server for app or system add-on updates, and About and Settings show no update button. Add-on updates from addons.mozilla.org stay on.
