# Known limits

What does not work in Vimma today, and the workaround where there is one. How things work is in
the [user guide](guide.md); planned work is on the
[roadmap board](https://github.com/orgs/vimma-browser/projects/1).

## Features

- Pages that take keys outside a text field (games, Google Docs, Figma) lose their plain keys
  and digits to normal mode. Press `i` to pass every key to the page until `Esc`.
- Extension pages (`moz-extension:`), `data:`, `view-source:` and `blob:` pages have no Vim keys;
  the prefix and chords such as `ctrl+t` still work.
- Link hints label only real elements: canvas apps (Google Docs, Figma, maps, games) get no
  hints.
- The command line has no `:set`, ranges or counts, and does not complete URLs. Its history lasts
  until Vimma quits.
- Firefox's shortcuts on keys Vimma uses (`ctrl+w`, `ctrl+u`, `ctrl+h`, `ctrl+d`, `ctrl+o`,
  `ctrl+i`, `ctrl+k`, `ctrl+b`) are off; the guide lists
  [where each one is now](guide.md#firefoxs-shortcuts-on-vims-keys).

## Find

- In the PDF viewer, `/`, `n` and `N` work, but the status bar shows no match count.

## Copy mode

- Copy mode works in the frame that has focus (click a frame first) and the caret does not move
  from one frame into another.
- `w` and `b` are Firefox's word steps: `w` stops at the end of a word, not at the start of the
  next. `e`, `W`, `B` and `E` behave as in Vim.
- Text inside text fields is not part of the page's selection: focus the field and use
  `ctrl+c`.

## Tabs and window

- Firefox's "List all tabs" is unavailable while the tab strip is hidden; tab search
  (`ctrl+b g`) lists every tab instead.
- Showing the tab strip again has no Settings switch: set `vimma.ui.tabstrip.hidden` to `false`
  in `about:config`.

## Workspaces (by design)

- A workspace's container keeps cookies, site data and site permissions apart. History,
  bookmarks, saved passwords, form history and the downloads list are shared by every workspace:
  the address bar suggests other workspaces' history, and a saved password autofills in all of
  them.
- Tabs in hidden workspaces keep running and playing audio; Vimma does not unload them.
- A tab that shares your camera, microphone or screen cannot be hidden, so it stays visible in
  other workspaces while it shares.
- Extensions that hide or show tabs (`tabs.hide`) conflict with workspaces.
- There is one [private workspace](guide.md#private-workspace), and it is a second window, not a
  part of the Vimma window. On Hyprland Vimma hides it in `special:vimma` when you are not using
  it, but `hyprctl clients` and other tools still see both windows. Links from other apps never
  open in it.
- [Routing rules](guide.md#routing-which-workspace-a-link-opens-in) do not move a page's own
  navigation or the links a page opens. App rules do not recognise links from Flatpak or other
  sandboxed apps, or from apps started through systemd (`uwsm app`).

## Bookmarks

- Tags, keywords, separators, sorting and editing a bookmark's address need Firefox's Library
  (`ctrl+shift+o`).
- Bookmarklets (`javascript:` and `data:` bookmarks) are listed but do not open from Vimma.

## Add-ons

- Only toolbar-button popups open from Vimma. Address-bar buttons, sidebars and an add-on's
  context-menu entries need Firefox's own UI.
- An add-on's shortcut on a key Vimma binds never reaches the add-on; rebind one of the two.

## Panes

- Panes are resized from the keyboard only: dividers cannot be dragged, and tabs cannot be
  dropped onto a pane.
- A pinned tab cannot be shown in a pane; Vimma unpins a tab before it joins a split.
- Every visible pane's page stays live and uses memory and CPU, up to `[panes] max` panes
  (default 4) in a workspace.

## Privacy, security and services

- Vimma's update check only notifies: it shows the new version and the command for your install,
  and installs nothing itself.
- No download reputation: Google's download lists and file checks are open only to Mozilla's own
  key, so "Block dangerous downloads" adds nothing beyond the Safe Browsing site lists.
- No crash reporter: a crash leaves only the system's local core dump.

## Agents (MCP)

- Agents can list, read, open and close tabs of the agent workspace, and download through it.
  They cannot press keys, click, fill forms or take screenshots.
- The agent's name in a question (`claude-code`) is what the agent says it is; Vimma cannot check
  it. Grants belong to the connection, and `:mcp` shows the program that started it.
- Each agent tool's own approvals, sandbox and timeouts are its own; Vimma neither reads nor
  changes them. What an agent does outside Vimma, with its shell and files, is up to that tool
  ([what Vimma protects](guide.md#what-vimma-protects-and-what-it-does-not)).

## Compatibility and versions

- Add-ons see the browser name `Vimma` (`runtime.getBrowserInfo().name`), not `Firefox`.
- A Firefox backup cannot be restored into Vimma: Firefox's backup service refuses a different
  app.

## Platforms and packaging

- Vimma is released for Linux x86_64, and for macOS on Apple Silicon once the macOS release jobs
  are switched on. There is no Intel Mac, universal or Windows build.
- The macOS `.dmg` is ad hoc signed, not notarised, until Vimma has an Apple Developer ID:
  macOS asks once, under Privacy & Security, before it first opens, and passkeys do not work.
  It has no update notices (no update manifest exists for macOS): install a newer `.dmg` by hand.
- The mounted macOS `.dmg` is a plain Finder window, without a background or a volume icon
  (spec macos-homebrew, decision 14).
- On macOS, Omarchy theming, the Omarchy hook and the Hyprland private-window swap do nothing.
- The AUR package `vimma-bin` is not published yet; use the release's `PKGBUILD`.
- The `.deb`, the AppImage and the Arch package mark themselves as package-manager installs, so,
  like Firefox's own packages, they do not warn when the kernel blocks the unprivileged user
  namespaces the content sandbox uses (as Ubuntu 24.04's AppArmor policy does for the AppImage
  and the `.deb`). The sandbox is then weaker without saying so; the tarball still warns.
