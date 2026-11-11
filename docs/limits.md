# Known limits

What does not work in Vimma today, and the workaround where there is one. How things work is in
the [user guide](guide.md); planned work is on the
[roadmap board](https://github.com/orgs/vimma-browser/projects/1).

## Features

- Pages that take keys outside a text field (games, Google Docs, Figma) lose their plain keys
  and digits to normal mode. Press `i` to pass every key to the page until `Esc`.
- Extension pages (`moz-extension:`), `data:` and `blob:` pages have no Vim keys;
  the prefix and chords such as `ctrl+t` still work.
- Link hints label only real elements: canvas apps (Google Docs, Figma, maps, games) get no
  hints.
- Cookie banners from TrustArc set their categories with a slider (required, functional,
  advertising): `f` labels its handle, but a label picks no level. Press `Tab` until the handle
  has focus, then the arrow keys move it, and `f` reaches "Submit Preferences".
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

## PDF viewer

- Marks (`m`, `'`) and the jump list inside a PDF last until Vimma quits; they are not saved
  across restarts.
- Pages keep the document's colours: there is no recolouring for a dark theme.
- No SyncTeX: neither forward search from an editor nor `ctrl`+click back to the source.
- pdf.js's sidebar does not show, so its page thumbnails and its attachments and layers views
  are not reachable; Vimma's outline (`Tab`) is the outline, and an attachment entry in it is not
  opened.
- While a PDF is still downloading, the viewer's toolbar shows Firefox's colours; it takes the
  theme once pdf.js has the document.
- A PDF opened from a `blob:` or `data:` address (a site's in-page "open PDF" button often
  makes one) has Vimma's prefix keys but none of the PDF keys, the page count or the outline;
  download it and open the file.
- A PDF that a page shows inside itself (in a frame, `<embed>` or `<object>`) keeps the page's
  keys; open the PDF in its own tab.

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
  sandboxed apps, from apps that open links through the desktop portal (Ghostty's link clicks
  on Linux), from apps started through systemd (`uwsm app`), or from a program that has exited
  before its link arrives. Behind a tmux, zellij or detached herdr server, the names end at the
  multiplexer: a rule for the terminal behind it does not match. On macOS, app rules do not
  apply yet.

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
  (default 8; lower it on a small screen) in a workspace.

## Privacy, security and services

- Only the AppImage and the tarball (from 0.1.16) update themselves. The `.deb`, the `.rpm`, the
  Arch package and macOS only notify: they show the new version and the command for your install.
  The tarball's updater downloads complete updates only (no partial MARs).
- No download reputation: Google's download lists and file checks are open only to Mozilla's own
  key, so "Block dangerous downloads" adds nothing beyond the Safe Browsing site lists.
- No crash reporter: Vimma sends nothing; a crash leaves whatever record the system keeps (a core
  dump where systemd-coredump keeps them, a `.ips` report on macOS).

## Agents (MCP)

- An MCP agent (`vimma-ctl mcp`) reaches only the agent workspace: it cannot see or act on tabs
  in your other workspaces or in private windows. Full control (`:control on`) is a wider grant: a
  program that can read Vimma's control token reaches every workspace, and while MCP is on Vimma
  asks you before each such connection
  ([security model](security.md#1-control-socket-ctlvimmacontrolsysmjs)).
- Pages in the agent workspace open no pop-up, so a page loaded over HTTP there loses its
  `Cross-Origin-Opener-Policy`, which Firefox refuses in such a tab. A page that also sends
  `Cross-Origin-Embedder-Policy` is not cross-origin isolated there: it has no `SharedArrayBuffer`.
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
- A grant covers every agent tool for its minutes, but for the checkpoints: paying, and sending a
  form with text or personal details (free text, a name, an email address, a phone number, an
  address, a birth date, a username or organisation, a password, a payment card or one-time-code
  field, or a file), or one whose fields Vimma cannot read whole. A click that sends a form of only
  the page's own values (hidden fields, numbers, dates, checkboxes, choices from its lists, none of
  them personal details) runs under the grant, whatever that does on the server, such as deleting or
  unsubscribing; a fill that sends a form always asks. Not free text: a search field
  (`type=search`), a number, date or other non-text field that is not a personal detail, whatever
  value the agent fills in, and a short number typed into a text field (up to three digits, with
  decimals, such as a quantity, but also a three-digit code). Text a page's script copies into
  hidden fields before the click is not seen either. `a always here` on a form's question lets the
  same button on the same site send without asking until the grant ends, whatever text or personal
  details its later forms send (a payment, a password, card, one-time-code or file field, a form
  with more than 64 fields besides hidden ones, a value too long for Vimma to read whole (over 1024
  characters), or a form whose fields Vimma could not read still asks).
  Paying is recognised by a payment card field the page shows, in any frame, or by the pressed
  button's or followed link's words (a fixed list in six languages). A checkout that shows neither,
  such as a one-button checkout whose button is an icon with no name or says `Continue`, runs
  unasked under a grant, and so does a load of a payment provider's or bank's site from such a
  button, up to that site's own card fields or pay button
  ([checkpoints](guide.md#checkpoints-sending-a-form-and-paying)). A button whose script sends data
  without a form, and whose words do not say it pays, is an ordinary click. The total a payment's
  question quotes is what the page states.
- Each agent tool's own approvals, sandbox and timeouts are its own; Vimma neither reads nor
  changes them. What an agent does outside Vimma, with its shell and files, is up to that tool
  ([what Vimma protects](guide.md#what-vimma-protects-and-what-it-does-not)).

## Vimma's own agent

- The [model bench](agent-bench.md) is all Vimma says about models, and none of the local models
  it ran on a laptop CPU completed its shopping tasks. Whether a local model calls tools well
  depends on the model and the server running it.
- A local address may itself forward to a hosted model: the window says `stays on this machine`
  only for a local server's model picked in the window, and `local endpoint` for an address
  typed by hand.
- Token counts are the provider's; a server that reports none is estimated from the characters
  sent. Cost is shown, and `max_cost` applies, only for a provider with `price_in` and
  `price_out` in `config.toml`, in whatever currency those are.
- Conversations share the agent workspace's cookies and logins with each other and with MCP
  agents; only their tabs are apart.
- A stored reply may quote page text, since the agent writes its replies from what it read.
- Without a desktop keyring, stored conversations and API keys are protected as Firefox's saved
  passwords are: by a primary password if one is set, otherwise readable by anything that can
  read the profile.
- The window does not open in a private window.
- The window runs Claude Code, Codex and Gemini CLI (checked with Claude Code 2.1.303, Codex
  0.163.0 and Gemini CLI 0.66.0); opencode is not offered: opencode 2.0.32 cannot be limited to
  Vimma's tools alone.
- Gemini CLI saves each task's conversation, page text included, in its own folder
  (`~/.gemini/tmp`), with no setting to stop it. Vimma deletes it when the task ends, but until
  then it is on disk, unencrypted, and a crash or a power cut leaves it there until the next
  start of Vimma (on macOS, which Vimma cannot ask whether a process is gone, until a start a
  day after the task). A `projects.json` that is a link is not edited: Vimma's tasks stay
  listed in it, without their folders. Vimma relies on Gemini CLI's own layout of that folder (0.66.0): a version that
  saves elsewhere keeps its files until Vimma knows of it.
- Gemini CLI does not report an MCP server that did not start: a task whose `vimma-ctl` failed
  runs without the browser's tools, and no message says why. It reports neither its tools nor a
  cost, and cannot take a message during a task, as Codex.
- Codex reports neither its tools nor its sandbox, so the window says only that its tools are
  `as its configuration allows`, and it reports no refusal of its own commands, so a command its
  sandbox stopped still shows as run. It reports no cost.
- Codex cannot take a message during a task: one sent then starts the next task once this one is
  done, and is dropped, with a notice, if the task is stopped, fails or meets a limit.
- Vimma turns off each MCP server Codex's configuration lists, its apps and plugins (its
  browser and computer-use tools among them), and its install of a skill's MCP server, for each
  run. A Codex version that adds another
  way in would keep it until Vimma knows of it; a call it reports to another server ends the
  run.
- Codex's ticket is in its own process's environment: its commands get it set empty, but the
  `notify` and `hooks` programs of its configuration, and another process of yours reading
  `/proc`, could read it while the task runs. It reaches only what
  the conversation does.
- An agent CLI keeps the shell, file and web tools its own settings allow. They are outside
  Vimma's gate: Vimma shows each use but does not approve, refuse or confine it.
- Vimma cannot see where an agent CLI sends the page text it reads, so `local_only` refuses
  every agent CLI.
- The cost an agent CLI reports is its own estimate, at list prices even on a plan, and
  `max_cost` does not apply to it.
- A shell command an agent CLI started may outlive a stop, since Vimma stops the CLI's own
  process and not the commands it started.
- An agent CLI runs in a folder in `$XDG_RUNTIME_DIR`, a small in-memory file system, so a CLI
  that writes large files there can fill it. Where Vimma falls back to
  `~/.cache/vimma-agent-cli`, the instruction files in your home folder apply to every run, as they do to the CLI in a terminal.
- The models the picker lists for an agent CLI are Vimma's own list, not the CLI's: a model the
  CLI no longer takes fails when a task starts, with the CLI's own error.
- An agent CLI needs the `vimma-ctl` beside Vimma's binary, which every release has; a build
  from source names its own in `vimma.agent.cli.vimmaCtl`.

## Compatibility and versions

- Add-ons see the browser name `Vimma` (`runtime.getBrowserInfo().name`), not `Firefox`.
- A Firefox backup cannot be restored into Vimma: Firefox's backup service refuses a different
  app.
- The import wizard's Firefox entry lists only Vimma's own other profiles, not Firefox's, so
  Firefox's data comes over through Sync or exported files
  ([Moving over](guide.md#moving-over-from-firefox-or-chrome)).
- On Linux, the import wizard cannot decrypt the passwords of Chrome and other Chromium-based
  browsers; export them to a CSV file and import that in `about:logins`.

## Platforms and packaging

- Vimma is released for Linux x86_64 and for macOS on Apple Silicon. There is no Intel Mac,
  universal or Windows build.
- On macOS, passkeys stored in macOS (iCloud Keychain) do not work (issue #544). Releases 0.1.10
  and earlier, and every CI test build, are ad hoc signed rather than notarised: macOS asks
  once, under Privacy & Security, before such a `.dmg` first opens. Vimma on macOS shows update
  notices but does not update itself: run `brew upgrade --cask vimma` or install
  the newer `.dmg` by hand.
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
- On the `.deb`, the `.rpm` and the Arch package, Settings' Make default button registers a desktop
  entry of its own that skips `vimma-open`, so routing rules by app do not apply to links, and
  Settings says Vimma is not the default browser even after `xdg-settings` made it one (issue
  #855). Use `xdg-settings` ([Making Vimma your default browser](guide.md#making-vimma-your-default-browser)).
- On Omarchy, `xdg-settings set default-web-browser` fails unless `BROWSER` and
  `XDG_CURRENT_DESKTOP` are cleared for it, Settings always says Vimma is not the default, and a
  link from another app may not raise Vimma's window, since Omarchy's launcher looks for a window
  named after the command it ran (issue #855).
- The Flatpak (`dev.vimma.browser`) is not on Flathub yet (issue #465). Once it is:
  - Links from other apps are not routed by app: its desktop entry runs `vimma` without
    `vimma-open`, whose look-up of the app that asked ends at Flatpak's own processes inside the
    sandbox. `domain` and `url` routing rules still apply.
  - The Omarchy hook is not installed (the sandbox cannot reach `~/.config/omarchy/hooks`), so
    a new theme reaches Vimma within 2 seconds, when it next reads the theme (read-only), not
    as soon as `omarchy-theme-set` finishes.
  - Its profile and `config.toml` are under `~/.var/app/dev.vimma.browser/`, apart from any
    other install's `~/.config/vimma`.
  - It shows the update notice with `flatpak update dev.vimma.browser` even when a software
    centre updates it on its own, and Flathub builds a release some hours after it is out.
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
