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
- Element focus follows the page's elements: a page that draws several paragraphs as one
  element with line breaks gets one label for all of them (focus it, then `v` and copy-mode
  motions narrow the selection), and text drawn on a canvas gets none. The PDF viewer gets no
  labels: copy mode copies from a PDF.
- Element focus holds one block at a time; several blocks are one copy-mode selection (`v` on the
  first, then `}`).
- A focused block's outline follows scrolls and resizes, in the page and in the frames around
  it. When the page moves the block some other way (content loading above it, an animation), the
  outline stays where it was until the next `+`, `-`, `j` or `k`.
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
- In the private workspace, Firefox does not open its "Save password?" prompt: as in any private
  window, it shows only the key icon in the address bar, so `y` and `n` have no prompt to
  answer. With the toolbar hidden the icon is out of sight too; show the toolbar (`ctrl+b u`)
  and click the key icon to save the password.
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
- `vimma_fill` knows a one-time-code field by its `autocomplete="one-time-code"` only, and a
  password field by its type (or a past type, or dots drawn by the page): a text field merely
  labelled "Password" or "Code" is filled like any other, with its value shown in the question.
- `vimma_screenshot` captures the viewport only, never the whole page. It is refused while a
  password or payment card field on screen has a value, but a card number the page copies into
  other text, or draws on a canvas, is not recognised, nor one the user or the page shows only
  for the moment of the drawing. A page with a data: or blob: frame, which Vimma cannot check, is never captured.
  Only http and https pages are captured.
- `vimma_console` returns what Firefox still keeps: the last 250 console messages of any kind
  per content process, shared with the other tabs of the same site, and the last 1,000 console
  calls per page, so on a busy page older ones may be gone. It reads at most 100 frames of a
  page. A request blocked
  before it is sent (by the page's content security policy, CORS or mixed-content rules) is
  reported as a script error, not as a failed request; request and response bodies and headers
  are never read. A page can empty its own console calls with `console.clear()`, and a frame
  Vimma's actor does not cover (a data: or blob: document) adds only what Firefox logged for it
  in the parent process.
- The agent's name in a question (`claude-code`) is what the agent says it is; Vimma cannot check
  it. Grants belong to the connection, and `:mcp` shows the program that started it.
- A grant covers every agent tool for its minutes, but for the checkpoints: sending a form and
  paying. Paying is recognised by a payment card field the page shows, in any frame, or by the
  pressed button's or followed link's words (a fixed list in six languages). A checkout that
  shows neither, such as a one-button checkout whose button is an icon with no name or says
  `Continue`, runs unasked under a grant, and so does a load of a payment provider's or bank's
  site from such a button, up to that site's own card fields or pay button
  ([checkpoints](guide.md#checkpoints-sending-a-form-and-paying)). A button whose script sends
  data without a form, and whose words do not say it pays, is an ordinary click. The total a
  payment's question quotes is what the page states.
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
- A macOS release is signed with Vimma's Developer ID and notarised only once the release
  workflow's signing is switched on; before that, and in every CI test build, the `.dmg` is ad
  hoc signed and macOS asks once, under Privacy & Security, before it first opens. Passkeys
  stored in macOS do not work in either (issue #544).
  It has no update notices (no update manifest exists for macOS): install a newer `.dmg` by hand.
- Finder on recent macOS (checked on 27.0.1) opens the mounted `.dmg`'s window at the frame of
  the last Finder window and ignores the size the `.dmg` stores, as it does for Firefox's: a
  small last window can cut off the Applications link, and a large one shows blank space past
  the background.
- On macOS, Omarchy theming and the Omarchy hook do nothing.
- On macOS, the normal window hidden while the private workspace is shown still runs its pages
  (audio keeps playing), and scripts still see it: `vimma-ctl state` lists both windows. A
  window in full screen is never hidden, so from full screen the private workspace is a
  fullscreen Space of its own and switching moves between Spaces.
- The AUR package `vimma-bin` is not published yet; use the release's `PKGBUILD`.
- The `.rpm` has no OpenPGP signature and there is no dnf or zypper repository for it: zypper
  installs it only with `--allow-unsigned-rpm`, `SHA256SUMS` and its cosign signature are what
  vouch for it, and `dnf upgrade` or `zypper update` never update it.
- The `.deb`, the `.rpm`, the AppImage and the Arch package mark themselves as package-manager installs, so,
  like Firefox's own packages, they do not warn when the kernel blocks the unprivileged user
  namespaces the content sandbox uses (as Ubuntu 24.04's AppArmor policy does for the AppImage
  and the `.deb`). The sandbox is then weaker without saying so; the tarball still warns.
- The AppImage updates itself by replacing its own file, which keeps its old name
  (`vimma-0.1.0-x86_64.AppImage` can hold 0.3.1); about:vimma shows the real version. A
  directory Vimma cannot write, or an AppImage run from a copy that `--appimage-extract` made,
  gets the manual steps instead. The new version runs from the next start, or after `:restart`;
  Vimma never restarts by itself.
- An AppImage's `:restart` is a quit and a new start of the AppImage: it drops the old process's
  command-line arguments, brings no tab back when history is cleared on close (it asks first),
  and starts nothing when Vimma runs as a systemd service unit that stops its leftover
  processes on exit (a scope, as app launchers use, is fine).
