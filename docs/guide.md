# Vimma user guide

Vimma brings the habits of Vim and tmux to the browser, so you can move through the web the way
you move through your code. This guide walks you through it in the order you will meet it: your
first launch, the two key layers, then tabs, panes, workspaces and the settings that make it
yours.

Vimma is pre-alpha. The guide describes what works now and marks anything that is not available
yet as **planned**. Known gaps are listed in [limits.md](limits.md).

## Features at a glance

What works today, each with the section that explains it:

- **Vim on the page** ([the two layers](#the-two-layers)): `j`/`k`/`h`/`l` scroll, `d`/`u`
  half a page, `gg`/`G` top and bottom, `H`/`L` back and forward; `f` link hints (`gF` in a
  background tab); `F` [element focus](#copying-a-paragraph-element-focus) to copy a paragraph,
  list item or code block with `y`; `/` find as you type, in frames and PDFs too; `v` copy mode
  with Vim motions and `y`; insert mode in text fields, `Esc` to leave; `:` a
  [command line](#the-command-line) with completion and history.
- **tmux for the window** (prefix `ctrl+b`, [keys](#keys)): tabs (`c` new, `n`/`p`, `1..9`,
  found and renamed with [tab search](#tab-search-and-tab-rename)); up to 4 split panes (`v`, `-`,
  `h/j/k/l`, `z` zoom, swap, resize); tiling [layouts](#layouts) (`enter` dwindle, `space`
  cycles tmux's presets); `ctrl+b ?` lists every binding, searchable.
- **[Workspaces](#workspaces):** each one a container with its own logins and cookies, kept
  with its tabs and split layout across restarts; `ctrl+^` goes back to the last one; a
  [private workspace](#private-workspace) (`ctrl+b shift+p`); a [side panel](#side-panel)
  (`ctrl+b b`) that shows marked tabs together as panes.
- **[Every key is yours](#every-key-is-yours):** any binding, the prefix and the leader remap
  in [config.toml](#configtoml), which applies on save; Firefox's own shortcuts are Vimma
  bindings too ([Firefox's own shortcuts](#firefoxs-own-shortcuts)).
- **[Search engines](#search-engines)** and `@aliases` from `config.toml`, such as `@gh vimma`.
- **[Hide the toolbar](#hiding-the-toolbar)** with `ctrl+b u`: the page reaches the top of the
  window, and the address bar comes back when you need it.
- **[Theming](#colours-and-themes):** the bars, Firefox's toolbar, menus, dialogs and settings
  pages, pickers, hints, start page and sidebar follow your desktop theme and change with it, or
  take your own colours.
- **[Accessible](#accessibility):** Vimma's own UI works with a screen reader and meets WCAG AA
  contrast in dark and light themes.
- **[Update checks](#updates)** (from 0.1.2): the status bar says when a newer Vimma exists (red
  for a security release), a short message announces each new version once, a security release
  asks once per session whether to show the update command, and `:update` shows the exact
  commands for how you installed it. The AppImage replaces its own file with a newer release
  checked against the signed update file, and runs it from the next start; once a security
  release is in place it asks once per session to restart, and `:restart` restarts into it.
- **Firefox underneath** ([privacy defaults](#privacy-defaults)): the same user agent and
  [add-on](#add-ons) compatibility as Firefox; no studies, sponsored content or telemetry
  uploads; Safe Browsing on.
- **Scriptable** ([vimma-ctl](#scripting-with-vimma-ctl), shipped and updated with Vimma): a
  token-protected control socket; local AI agents reach one [agent workspace](#agent-workspace)
  through MCP, where they can read, open, scroll and search pages, follow their links, list and
  click their buttons, fill their fields (never a password or card number), take a screenshot,
  read a page's errors and show you a page. An agent asks you first, one answer lets it work
  through its task until it quits, and sending a form or paying asks every time, showing what is
  sent or the total the page states.

## Every key is yours

The keys in this guide are defaults, not decisions. Every binding, the `ctrl+b` prefix and the
`space` leader can be remapped in `~/.config/vimma/config.toml`. The leader has no default
bindings; it is there for your own. These three lines move the prefix to `ctrl+a`, move the
leader to `,`, and add a leader binding (`, n`) for the side panel:

```toml
keys.prefix = "ctrl+a"                           # the prefix, ctrl+b by default as in tmux
modal.leader = ","                               # the leader, space by default as in many Vim setups
keys.toggle_sidebar = ["prefix+b", "<leader>n"]  # side panel: prefix b, and now also leader n
```

Firefox's own keys (`ctrl+t`, `alt+left`, `F5`, `ctrl+plus`, `F12`, …) are Vimma bindings too,
with Firefox's meaning, so they are remapped the same way: `keys.new_tab = ["prefix+c"]` takes
`ctrl+t` away from "New tab" ([Firefox's keys are Vimma bindings](#firefoxs-keys-are-vimma-bindings)).

Save the file and the change applies within 2 seconds, without a restart. [config.toml](#configtoml) has the
details, and [bindings.md](bindings.md) lists every action's config name with its default keys.

## Getting started

### Installing

Each [GitHub Release](https://github.com/vimma-browser/vimma/releases) is titled with both
versions, such as `Vimma 0.5.2 · Firefox 158.0`, and its notes link the Mozilla security
advisories of the Firefox it moves to. It carries, for Linux x86_64 (`X.Y.Z` is the Vimma
version; for a Mac, see [macOS](#macos) below):

| File                              | Install                                                                 |
| --------------------------------- | ----------------------------------------------------------------------- |
| `vimma_X.Y.Z_amd64.deb`           | `sudo apt install ./vimma_X.Y.Z_amd64.deb` (Debian 12+, Ubuntu 22.04+)  |
| `vimma-X.Y.Z-1.x86_64.rpm`        | the commands in [Fedora and openSUSE](#fedora-and-opensuse) below       |
| `vimma-X.Y.Z-x86_64.AppImage`     | `chmod +x vimma-X.Y.Z-x86_64.AppImage && ./vimma-X.Y.Z-x86_64.AppImage` |
| `vimma-X.Y.Z-linux-x86_64.tar.xz` | `tar -xJf vimma-X.Y.Z-linux-x86_64.tar.xz && ./vimma/vimma`             |
| `PKGBUILD` (Arch Linux)           | the command in [Arch Linux](#arch-linux) below                          |

Each of them, and the Mac's `.dmg`, also carries `vimma-ctl`, the client for
[scripting](#scripting-with-vimma-ctl) and [agents](#connecting-an-agents-tool), next to the
`vimma` binary, so updating Vimma updates it too:

| Installed from             | `vimma-ctl` is                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `.deb`, `.rpm`, Arch Linux | on your `PATH`: `/usr/bin/vimma-ctl`                                                                                |
| tarball                    | `vimma/vimma-ctl` next to `vimma/vimma`; link it onto your `PATH`                                                   |
| AppImage                   | a link named `vimma-ctl` to the AppImage runs it: `ln -s ~/Apps/vimma-X.Y.Z-x86_64.AppImage ~/.local/bin/vimma-ctl` |
| Homebrew (macOS)           | on your `PATH`, linked by the cask                                                                                  |
| `.dmg` (macOS)             | `/Applications/Vimma.app/Contents/MacOS/vimma-ctl`                                                                  |

The AppImage keeps its file name when it updates itself (it renames the new one over it), so the
link keeps working.

The `.deb`, the `.rpm` and the Arch Linux package add Vimma to your application menu and offer it for web links,
but never make it your default browser on their own: `xdg-settings set default-web-browser
vimma-vimma.desktop` does that. Next to the files are `SHA256SUMS`, a CycloneDX SBOM
(`vimma-X.Y.Z.cdx.json`) and cosign signatures (`*.sigstore.json`); how to check them is in
[runbook.md](runbook.md#release-packages-releaseyml-spec-m6-packaging) ("Verify a release").

**Updating.** Install the newer release the way you installed this one: on Arch Linux, run the
install command again; otherwise, install the newer `.deb`, `.rpm`, AppImage or
tarball over the old one. From 0.1.2 on, Vimma tells you when a new release is out and shows the
command for your install ([Updates](#updates)); Vimma 0.1.1 never does, so update it this way once.
An AppImage from a release that includes the self-update replaces its own file when a newer
release is out; the next start runs it.

**Building from source.** Follow [CONTRIBUTING.md](../CONTRIBUTING.md#build-and-run): `npm ci`,
`npx surfer download`, `npx surfer bootstrap`, `npm run import`, `npx surfer build`. The first
build takes about 40 minutes on a 16-thread machine and needs about 35 GB of disk space
(`engine/` 27 GB, the sccache compiler cache 6.8 GB, `~/.mozbuild` 3.1 GB, `.surfer/` 0.8 GB).

#### Fedora and openSUSE

One `.rpm` installs on both, and its package manager pulls in the libraries it needs:

```sh
sudo dnf install ./vimma-X.Y.Z-1.x86_64.rpm                           # Fedora
sudo zypper install --allow-unsigned-rpm ./vimma-X.Y.Z-1.x86_64.rpm   # openSUSE
```

It installs to `/usr/lib/vimma`, with `vimma`, `vimma-open` and `vimma-ctl` in `/usr/bin`, as the
`.deb` does.
The package carries no OpenPGP signature, so dnf says it skipped the OpenPGP check and zypper
needs `--allow-unsigned-rpm`. What vouches for it is the release's `SHA256SUMS` and its cosign
signature; check them before installing ("Verify a release" in
[runbook.md](runbook.md#release-packages-releaseyml-spec-m6-packaging)):

```sh
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/vimma-browser/vimma/\.github/workflows/release\.yml@refs/heads/main$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS   # vimma-X.Y.Z-1.x86_64.rpm: OK
```

There is no Vimma repository for dnf or zypper, so `dnf upgrade` and `zypper update` do not
update it: install the newer `.rpm` the same way, or run the command `:update` shows. To remove
it, `sudo dnf remove vimma` or `sudo zypper remove vimma`.

#### macOS

A release may also carry, for Macs with Apple Silicon (M1 or later), `vimma-X.Y.Z-macos-aarch64.dmg`
with its checksum file `SHA256SUMS-macos`. There is no build for Intel Macs. Open the `.dmg` and
drag Vimma into Applications.

**The first open.** A release signed with Vimma's Developer ID and notarised by Apple opens like
any other app: macOS asks only whether to open an app downloaded from the internet. To check
which kind you have, run `spctl --assess -vv /Applications/Vimma.app`; a notarised release prints
`accepted` and `source=Notarized Developer ID`, and its Homebrew cask shows no caveat.

An older release, or a build from a pull request or `macos.yml`, is only ad hoc signed, so the
first time you open it macOS says "Apple could not verify “Vimma” is free of malware". To open
it:

1. Choose **Done** in that dialog, not **Move to Trash**.
2. Open System Settings → Privacy & Security and scroll down to Security.
3. Next to the line saying Vimma was blocked, choose **Open Anyway**, then confirm with your
   password or Touch ID, and choose **Open**.

Since macOS 15, Control-clicking the app and choosing Open no longer gets past this dialog; the
button in System Settings does. macOS remembers the choice for this copy of Vimma; a newer
`.dmg`, or a `brew upgrade`, may ask again.

For such an ad hoc signed build only, the same result in one step from a terminal: this removes
the quarantine flag the download carries, which also switches off macOS's check of this copy, so
use it only on a `.dmg` you downloaded from the release (or verified as below). A notarised
release never needs it.

```sh
xattr -dr com.apple.quarantine /Applications/Vimma.app && open -a Vimma
```

If macOS says the app "is damaged" rather than unverified, the quarantine flag is also the cause,
and the same `xattr` command clears it.

Vimma on a Mac tells you when a newer release is out, as on Linux ([Updates](#updates)); to
update, install the newer `.dmg` over the old one, or run `brew upgrade --cask vimma`. Passkeys
stored in macOS (iCloud Keychain) do not work in Vimma yet, notarised or not. Your profile lives in `~/Library/Application Support/Vimma/`, and
macOS keeps Vimma's window state under its bundle identifier, `dev.vimma.browser`. To
check the `.dmg` before you open it, verify `SHA256SUMS-macos` with cosign as in "Arch Linux"
below (same identity), then run `shasum -a 256 -c --ignore-missing SHA256SUMS-macos`.

**With Homebrew.** The same `.dmg` installs as a cask from Vimma's own tap,
[vimma-browser/homebrew-tap](https://github.com/vimma-browser/homebrew-tap):

```sh
brew install --cask vimma-browser/tap/vimma
```

Homebrew checks the download against the SHA-256 the cask pins, puts Vimma in Applications and
`vimma` on your `PATH`. A notarised release opens at once; an ad hoc signed one still needs
**Open Anyway** on its first open, as in "The first open" above, and `brew info vimma` shows that
note again. The cask comes from the release itself: each
release carries it as `vimma.rb`, listed and signed in `SHA256SUMS-macos`, and the tap gets that
file once the release is published.

| To                                             | Run                                 |
| ---------------------------------------------- | ----------------------------------- |
| Update to the latest release                   | `brew upgrade --cask vimma`         |
| Remove Vimma, keeping your profile             | `brew uninstall --cask vimma`       |
| Remove Vimma and its profile, caches and prefs | `brew uninstall --zap --cask vimma` |

Vimma does not update itself, so `brew upgrade` (or `brew upgrade --cask vimma`) is how a
Homebrew install gets a new release; after an upgrade to an ad hoc signed release, macOS may ask
for **Open Anyway** again.
When a newer release is out, Vimma's [update notice](#updates) says so, and `:update` shows that
command; Vimma counts as a Homebrew install when it runs from `/Applications/Vimma.app` and
`/opt/homebrew/Caskroom/vimma/` exists.
`--zap` deletes `~/Library/Application Support/Vimma/` (every profile), `~/Library/Caches/Vimma/`,
and Vimma's preferences and saved window state in `~/Library`; it leaves your configuration in
`~/.config/vimma/` alone.

#### Arch Linux

Each release carries a `PKGBUILD` for the `vimma-bin` package. It needs no other file: it
downloads the release tarball, checks it against the SHA-256 written into it, and installs Vimma
to `/opt/vimma` with `vimma` and `vimma-open` on your `PATH`, a desktop entry and icons. Run
this as your normal user, from any directory:

```sh
mkdir -p ~/.cache/vimma-build && cd ~/.cache/vimma-build && curl -fLO https://github.com/vimma-browser/vimma/releases/latest/download/PKGBUILD && makepkg -si
```

`makepkg -si` installs the libraries Vimma needs with pacman, asks for your password to install
the package, and refuses to run as root. A first install and every update use the same
command: it builds in `~/.cache/vimma-build`, so it leaves nothing in the directory you run it
from, fetches the newest release's `PKGBUILD` each time, and pacman replaces the installed
version. The folder holds the build files and the last package built (about 450 MB during a
build), and you can delete it at any time. `:update` shows this command when a new release is
out ([Updates](#updates)). `sudo pacman -R vimma-bin` removes Vimma; your profile stays in your
home directory.

A release is built and its files are uploaded before it is published, so a published release
has its `PKGBUILD` from the start. If `curl` prints `curl: (22) The requested URL returned
error: 404`, the files are missing (no release is published yet, or one went out without them);
`curl` then exits, the `PKGBUILD` you already have stays as it was and `makepkg` does not run.
Try again later.

To check the `PKGBUILD` before you build it, download it with the release's checksums and their
signature, verify the signature with [cosign](https://github.com/sigstore/cosign), then the
checksum:

```sh
mkdir -p ~/.cache/vimma-build && cd ~/.cache/vimma-build
base=https://github.com/vimma-browser/vimma/releases/latest/download
curl -fL -O "$base/PKGBUILD" -O "$base/SHA256SUMS" -O "$base/SHA256SUMS.sigstore.json"
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/vimma-browser/vimma/\.github/workflows/release\.yml@refs/heads/main$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS   # PKGBUILD: OK
makepkg -si
```

The `PKGBUILD` pins the SHA-256 of the tarball it downloads, so checking the `PKGBUILD` covers
what it installs. Every Linux file of the release is in `SHA256SUMS`, and the macOS `.dmg` and
Homebrew cask in `SHA256SUMS-macos` ("Verify a release" in
[runbook.md](runbook.md#release-packages-releaseyml-spec-m6-packaging)).

The package marks itself as installed by a package manager (`/opt/vimma/is-packaged-app`), as
Firefox's own distribution packages do; the `.deb`, the `.rpm` and the AppImage carry the same
file in `usr/lib/vimma/`, and only the tarball has none. The file tells Vimma's update check which
commands to show, so a `.deb` is updated with apt and an `.rpm` with dnf or zypper, never by
unpacking a tarball over the files the package manager owns. Like Firefox's packages, a marked install does not show Firefox's warning that "some
security features may offer less protection" when your kernel does not allow unprivileged user
namespaces, which the content sandbox uses. On Ubuntu 24.04 that means the `.deb` and the
AppImage run with a weaker content sandbox without saying so; the tarball still shows the warning
([limits.md](limits.md#platforms-and-packaging)).
There is no AUR package for now. The AUR does not accept new account registrations at the
moment, and a package needs an account to own it, so `vimma-bin` cannot be published there yet.
On Arch, the release's `PKGBUILD` above is the way to install and update Vimma, and `:update`
shows that command. The same package goes to the AUR as `vimma-bin`, for AUR helpers such as
`yay -S vimma-bin`, once registration opens again.

### First launch, with its own profile

Start Vimma from the checkout with `npm start`. It runs your build with a profile of its own,
`~/.cache/vimma-dev-profile`, so your Firefox profile is never touched:

```sh
npm start                   # the full build, or the artifact build if that is all there is
npm start -- --fresh        # a throwaway profile, deleted when Vimma quits
npm start -- --profile DIR  # another persistent profile
```

It will not start a second Vimma on a profile that is already open; switch to that window
instead. The profile's `user.js` gets one line Vimma needs when run from a source checkout
(read access for web pages' sandbox to the checkout's `src/`); your own lines there are kept.

Where Vimma keeps its files on Linux:

| Path                          | What                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `~/.config/vimma/config.toml` | Your config (see [config.toml](#configtoml)). Vimma reads only this file there and never scans the folder. |
| `~/.config/vimma/vimma/`      | Profiles and `profiles.ini`. If `~/.vimma/vimma/` already exists, Firefox's legacy rule uses that instead. |

On macOS, `config.toml` is in the same place, and the profiles and `profiles.ini` are in
`~/Library/Application Support/Vimma/`, where Firefox keeps them on a Mac; `XDG_CONFIG_HOME`
does not move them there.

On a profile's first launch, if `~/.config/vimma/config.toml` does not exist, Vimma creates it
from the same commented template `:config` writes, so it changes nothing until you uncomment a
line, and the status bar says `created ~/.config/vimma/config.toml` once. An existing file, even an
empty one, and the rest of `~/.config/vimma/` (key files, the `vimma/` profiles folder) are left
alone. A file you delete later stays deleted. The packaged builds do the same on their first
launch. Nothing is created when `vimma.config.path` points Vimma at another file.

On first launch you see a calm window: no tab strip, the navigation bar and address bar at the top,
and Vimma's status bar at the bottom, telling you where you are. Press `ctrl+b`, then `?`, to see
every binding.

### First-run setup

The first start of a new profile shows a welcome screen with two buttons: **Set up** (`enter`)
and **Skip** (`esc` or `q`). Skipping changes nothing. Setting up has two steps:

1. **Add-ons.** A short list of content blockers (uBlock Origin, AdGuard AdBlocker, Privacy
   Badger). `/` searches addons.mozilla.org (the request carries only the search terms), `j`/`k`
   move, `space` marks, `enter` goes on. Add-ons run in every workspace, the agent workspace
   too.
2. **Search engine.** `j`/`k` and `enter` choose the default engine.

The summary lists what will happen; `enter` applies it, `esc` goes back. The engine is written
to `config.toml` as `[search] default`, keeping your comments; a file that does not parse is
left alone. Each add-on then shows Firefox's own permission prompt. Nothing changes before the
summary, so closing the tab earlier leaves the profile as it was. The welcome screen appears
only once per profile: after **Skip**, after finishing, or after closing its tab, later starts
never show it again. `:setup` (or the link on about:vimma) opens the setup again.

### The start page

New windows and new tabs open Vimma's start page: the logo, and under it the keys to start
from (`ctrl+b ?` keys, `:` commands, `f` hints, `ctrl+b shift+b` [bookmarks](#bookmarks)) and,
unless the colours are your Omarchy
theme's, `:theme light/dark` to [switch the colours](#colours-and-themes). The address bar is empty and focused, so you can type an
address straight away; click the page to use `:` and the other keys there. At the bottom, a small
line shows which Vimma you run and the Firefox release it is built on (`Vimma X.Y.Z · Firefox
N`). It is a local page (`chrome://browser/content/vimma/start/start.html`); nothing loads
from the network.

To change it back:

- **Home page and new windows:** Settings (`about:preferences#home`) → "Homepage and new
  windows", or set `browser.startup.homepage` in `about:config`. "Restore Defaults" there brings
  the start page back.
- **New tabs:** set `vimma.startpage.newtab` to `false` in `about:config` (applies at once) for
  Firefox's new tab page. Settings' "New tabs" menu does not change Vimma's start page. An
  extension that sets its own new tab page takes precedence.

## The two layers

Vimma splits the keyboard into two layers, as your editor and terminal already do: Vim's modes
for the page, tmux's prefix for the window. One dispatcher sees every key before Firefox does,
in the address bar, on `about:` pages and in the PDF viewer too, so the keys behave the same
everywhere.

- **The prefix layer (tmux).** `ctrl+b` is the prefix, like tmux's default prefix. The next key
  is a command: `ctrl+b ?`
  shows the bindings, `ctrl+b c` opens a tab, `ctrl+b v` splits the pane, and so on.
  The prefix works in every mode and waits for the next key with no timeout. `Esc` cancels it.
- **The modal layer (Vim).** Bare keys act on the page depending on the mode: `j`/`k` scroll
  in `normal` mode, while in `insert` mode (focus in a text field) keys go to the page.
  `visual` is copy mode (caret and selection), `hint` is link hints, `help` the bindings overlay
  and `command` the `:` line, `resize` is resize mode for panes (`ctrl+b r`) and `panel` the side
  panel (`ctrl+b b`).

### Normal and insert mode

Every tab starts in **normal** mode: Vimma's bare keys (the table below) act on the page, and
the page never sees them. This is where you read, scroll and jump. Keys Vimma has no binding for, such as `z` or a site's own `s` or `m`,
still reach the page.

Focusing a text field puts the tab in **insert** mode, so typing works as in Firefox: inputs,
text areas, editable regions (`contenteditable`), ARIA text boxes, code editors (Monaco,
CodeMirror, Ace, ProseMirror, Quill), fields inside web components and inside frames from
other sites. Focusing a checkbox, button or link does not. `Esc` leaves insert: it takes focus
out of the field and the tab is back in normal. `i` enters insert explicitly: it goes back to
the text field you were last in on the page, or the first text field if that one is gone, or, on
a page without one (a game), lets every key through. Insert entered with `i` or `gi` lasts until
`Esc`, even if the page moves focus itself (a file finder jumping to its result list, a dialog
taking focus), so the keys you type keep going to the page. Insert entered by clicking or
tabbing into a field follows the focus: when focus leaves the text fields, the tab is back in
normal. After `Esc`, a page cannot put you back in insert on its own: a dialog that pulls focus
back into its field leaves the tab in normal, and you return to typing with `i`, a click into
the field or `Tab`.

Clicking into a page that is editable as a whole (a `designMode` document, such as some rich
text editors' frames) also enters insert.

Each tab keeps its own mode. Settings (`about:preferences`) and the PDF viewer work the same
way, but Settings focuses its search box when it opens, so it starts in insert: press `Esc`
before `j`/`k`. Pages Vimma does not reach (extension pages, `data:` and `view-source:` pages)
stay in insert, so their keys are untouched. With focus in the address bar or the find bar, keys
belong to that field; only `ctrl+b` sequences are Vimma's there (and, in a `/` search,
`Enter` and `Esc`).

**`I` goes to the address bar** from normal mode, copy mode and the side and bookmarks panels, on
any page Vimma's keys reach (web pages, `about:` pages, Settings, the PDF viewer, the start page,
a frame with focus): it selects the address as `ctrl+l` does, and the status bar says INSERT
while you type there. In a split it is the focused pane's address. An open panel closes first,
and copy mode ends. `Esc` is then Firefox's: the first closes the suggestions list if it shows, the next
(with the address unchanged) puts focus back in the page, in normal mode. In insert mode `I` is
a capital I typed into the field, as in Vim; press `Esc` first.

**Text fields have Vim's editing keys.** In insert mode, and in the address bar, the `:` line, the
find bar and the panels' filters, `ctrl+w` deletes the word before the caret, `ctrl+u`
everything before it on the line, and `ctrl+h` one character, as `Backspace`. They are the
text field's own delete commands, so `ctrl+z` undoes them. A page that handles one of these keys
itself (a web terminal, an editor with its own `ctrl+w`) keeps it: Vimma edits only when the page
left the key alone. In normal mode the keys stay Vimma's (`ctrl+u` scrolls, `ctrl+w h` moves
between panes). `[modal] insert_editing = false` in `config.toml` turns them off; Firefox's own
actions on those keys stay off either way. On macOS, `ctrl+h` is already a backspace in text
fields, so Vimma adds nothing there.

**`Esc` in a text field is Vimma's.** It leaves insert, so the page does not see that `Esc`: a
site's own `Esc` (closing an autocomplete list or a dialog) does not fire from the field. Press
`Esc` again: in normal mode `Esc` has no binding, so it reaches the page (the field no longer
has focus, so the page's document gets it, not the field; a dialog that put focus back into its
field gets it there, and closes).

**A key that starts a sequence passes when nothing in that sequence works yet.** `ctrl+w`
starts the `ctrl+w h/j/k/l`, `H/J/K/L`, `o` and `< > + -` pane keys, which do something only with two panes or
more, so in a window with one pane `ctrl+w` reaches the page (Firefox's own `ctrl+w`, close
tab, is off: [below](#firefoxs-own-shortcuts)). With a split, `ctrl+w` in
normal mode waits for the pane key (`Esc` cancels); close the tab with `x` or `ctrl+b shift+x`. `g` starts `gg`, which works, so `g` is Vimma's: the page does not see it, and `Esc`
cancels it.

**Every default binding runs.** A binding without a working command is never silent: a
`ctrl+b` sequence, or a count followed by a key (`3H`), whose command does not exist shows
"… not implemented yet" in the bottom-right corner for 1.5 s (not while a video or page is
fullscreen); a single key whose command does not exist reaches the page or Firefox, with no
message; and the `ctrl+b ?` overlay dims it.

### Link hints

Link hints let you click without the mouse. `f` puts a short label on everything you could click on
screen: links, buttons, form fields, and elements the page made clickable (ARIA buttons, tabs and
menu entries, elements with a click handler), also inside web components and in frames from other
sites. Each entry of an open menu gets its own label, also when the page puts a click handler on the
list around them. Things off screen, hidden or covered by something else (a fixed header, a cookie
banner) get no label. Type a label to pick its target: a link is followed, a button is pressed, a
text field gets focus and the tab is in insert mode. Labels use the home row (`a s d f g h j k l`),
in reading order: targets near the top get the shortest. As you type, labels that no longer match
disappear. `Backspace` takes back a key and `Esc` leaves hints without doing anything.

`gF` labels links only and opens the one you pick in a new tab in the background, so you stay
on the page and can pick more. (`F` is [element focus](#copying-a-paragraph-element-focus); a
`config.toml` that binds `F = "hint.follow_new_tab"` under `[modal.normal]` keeps background-tab
hints on `F`.)

The labels are drawn by the browser, over the page, not inside it: the page cannot see them,
restyle them or hide them. Apps that draw their own controls on a canvas (Google Docs, Figma,
maps, games) have nothing to label.

### Copying a paragraph (element focus)

`F` (element focus) puts the same labels as link hints on the text on screen instead of on what
you could click: paragraphs, headings, list items, quotes, code blocks, table cells and captions,
also inside web components and in frames from other sites. Each block gets one label, on its first
line on screen: a list item made of two paragraphs gets a label on each paragraph, and a code block
gets one label however its lines are built. Hidden blocks, text fields and blocks covered by something
else get none. Typing, `Backspace` and `Esc` work as they do for link hints.

Typing a label **focuses** its block: the browser draws an outline around it, the status bar
badge says `ELEMENT`, and next to it the bar names the block and its length
(`paragraph · 412 chars`), which a screen reader hears too. Nothing in the page changes while a
block is focused: no selection, no focus, and the page cannot see the outline. The outline follows
the block as the page scrolls.

| Key       | Does                                                                        |
| --------- | --------------------------------------------------------------------------- |
| `y`       | copies the block's text and goes back to normal mode                        |
| `v`       | selects the whole block in [copy mode](#copy-mode), to adjust it before `y` |
| `V`       | the same, line-wise, so `j` and `k` extend it by lines                      |
| `+` / `-` | focuses the block around it (the list around a list item) / back down again |
| `j` / `k` | focuses the next / previous block, scrolling it into view                   |
| `F`       | labels again, to pick another block                                         |
| `Esc`     | back to normal mode, nothing selected; a loading page is not stopped        |

Counts work on `+`, `-`, `j` and `k` (`3j`). Any other binding, a tab switch, a navigation or a
click leaves element focus.

- **Plain text.** `y` copies the block as plain text, as copy mode's `y` copies a selection, and
  says `yanked N chars`. After `v`, `y` gives the same text.
- **Code blocks** copy exactly as shown: indentation, tabs, blank lines and line breaks are kept,
  and line numbers the page marks unselectable are left out.
- **Unselectable text.** When the page marks a whole block unselectable (`user-select: none`),
  `y` copies its text anyway and the notice says so; `v` shows no highlight there.
- **Frames.** Blocks in frames get labels too. `y` copies from a frame without moving focus into
  it; `v` moves focus into the frame, where copy mode then runs. `+` stops at the frame's edge.
- **PDFs.** The PDF viewer has lines, not paragraphs: element focus says
  `no text blocks here (PDF: use v)`, and [copy mode](#copy-mode) copies from a PDF.

Element focus is `F` in normal mode and `:focus_element` on the command line; bind
`focus_element` to another key in [config.toml](#configtoml) under `[modal.normal]`. The keys of
the table are `[modal.element]`'s, and can be rebound there.

### Find

Find works as it does in Vim. `/` opens Firefox's find bar at the foot of the page, empty, and
searches as you type, in frames
from other sites, inside web components and in the PDF viewer too. Matches are highlighted and
counted as in Firefox. The search starts at the top of what you see (or at the selection, if it
is on screen), as Vim's starts at the cursor.

- **Case:** smart case. An all lower-case search ignores case (`word` finds `Word`); one capital
  letter makes it match case (`Word` finds only `Word`). `ctrl+f` uses the same rule.
- **`Enter`** keeps the match selected and closes the bar; you are back in normal mode. A search
  that found nothing goes back to where you were, and the status bar says `not found`.
- **`Esc`** cancels: the bar closes, nothing stays selected and the page scrolls back to where
  it was when you pressed `/`.
- **`n` / `N`** jump to the next / previous match without opening the bar, wrapping at the ends.
  After a search that found nothing they do nothing.
- **`?`** searches backward: it shows matches as you type, as `/` does, and `Enter` lands on the
  last match before where you were. After `?`, `n` goes on backward and `N` forward.
- **A match in a text field** (a site's search box that holds your query) is selected there,
  but the field does not keep the focus: you stay in normal mode and `n` / `N` go on to the
  next match. `i`, a click, or the page itself focusing the field puts you in it, in insert
  mode.

`ctrl+f` still opens Firefox's own find bar, where `Enter` goes to the next match.

### Live grep

`ctrl+b f g` searches the text of every tab in your workspace as you type, as Telescope's
`live_grep` searches files in Neovim. `/` finds text in one page; live grep finds the page.

- **The picker** covers the page area, from below the toolbar (or the window's top when the
  toolbar is hidden) to the status bar. The prompt, titled `Live Grep`, is at the bottom, with
  `matches listed / found` on its right. Results stack above it, the best one next to the prompt
  and marked `>`. Each row shows its window (`w1` is this one), the tab's number (the one
  `ctrl+b 1..9` uses) and title, its host, `:line:`, and the line with the match highlighted. A line is a paragraph, list item, heading or table cell (text after a `<br>`
  or in `pre` text starts a new one), numbered in the page. On the right, `Grep Preview` shows
  the ten lines before and after the selected match, the matched line highlighted; its title
  names the match's window, workspace, tab and host in full. In a window
  narrower than 900 pixels the preview is hidden and the results take the whole width.
- **The query** is a regular expression in JavaScript's syntax (`err(or)?s?\b`, `\d+ ms`), matched
  line by line. Case follows ripgrep's smart case: all lower case ignores case, a capital letter
  matches it. Text that is not a valid expression, such as `c++(`, is searched as typed and the
  prompt says `literal`.
- **Keys.** You type into the prompt. `ctrl+n` / `↓` move down the list, toward the best result,
  `ctrl+p` / `↑` up; `Tab` / `shift+Tab` jump to the next / previous tab's first result.
  `ctrl+d` / `ctrl+u` scroll the preview (without a preview, `ctrl+u` clears the prompt;
  `ctrl+w` and `Backspace` always edit it). `Esc` leaves the prompt for browsing: `j` / `k`,
  `gg` (top) and `G` (the best result), `/` or `i` back to the prompt, and `Esc` or `q` close.
- **`ctrl+space`** keeps the results and filters them by fuzzy matching, as Telescope's refine:
  the prompt says `fuzzy`, and `Esc` goes back to the search.
- **The scope box** above the results says what is being searched, before you type: its title
  names the scope (`Scope: this workspace · ctrl+s`), and a line per window gives its mark, its
  workspaces with their tab counts and how many tabs are not loaded, for example
  `w1 this window: work 12, notes 3 · 15 tabs, 2 not loaded`.
- **`ctrl+s`** widens the search: this workspace → this window (every workspace in it) → all
  windows → all windows and recently closed tabs and windows → back to this workspace. The
  scope starts at this workspace each time live grep opens. `Enter` on a result in another
  window brings that window to the front and selects the match there.
- **Recently closed** tabs and windows are searched by their title and URL only, since Firefox
  keeps no page text for them: at most the 25 tabs and 5 windows Firefox remembers. They are
  listed after the open tabs' results, labelled `closed` or `closed window`; `Enter` reopens the
  tab in this window and goes there, or reopens the window.
- **`Enter`** goes to the result: it selects the tab (and the pane that shows it in a split),
  selects the match with find's highlight and scrolls it to the middle. You are in normal mode;
  `v` starts copy mode with the match selected, so `v` `y` copies it. If the page changed since
  the search, the same match is found again; if it is gone, a notice says
  `match no longer on the page`.
- **`]q` / `[q`** go to the next / previous result of that search afterwards, across tabs (and
  windows, in the wider scopes) and wrapping, as Vim's quickfix list; a notice says where you are (`grep 3/12`). `:grep` alone
  opens live grep again with the last query; `:grep text` opens it with that text.
- **Not searched:** tabs that have not loaded since a restart (they are listed at the far end as
  `not loaded`; `Enter` opens one, so you can search again), form fields, text drawn on a canvas,
  images, closed `<details>`, PDFs, and pages Vimma cannot read (`view-source:`). A page in a
  frame from another site is searched; its rows say `↳ host`.
- **Limits.** A search stops in a page, or in the closed tabs' titles, after a second
  (`timed out`, so a pattern that would backtrack for ever never freezes the page or Vimma), covers at most 100 frames a tab and the first
  million characters of a page (`cut`), and lists at most 2,000 results; a query over 1,000
  characters is not run (`too long`).
- **Private and agent tabs.** From a normal window live grep never sees the
  [private workspace](#private-workspace), open or recently closed, in any scope; in the private
  workspace it sees only private tabs. The [agent workspace](#agent-workspace)'s tabs are
  searched only when the scope includes them (from `this window` on), listed last and marked
  `◇ agent`.
- Page text stays in the page's own process while the picker is open and is dropped when it
  closes; Vimma keeps only the lines it shows, in memory, and never writes them to disk.

### Copy mode

`v` (or `ctrl+b [`, as in tmux) enters copy mode: a caret appears at the start of the first text
you see, or at the selection if one is on screen, and the badge says `VISUAL`. It is Firefox's
caret browsing (`F7`), for this page only, driven by Vim keys:

- **`h` / `l`** move the caret a character, **`j` / `k`** a line, **`w` / `b`** a word (Firefox's
  word steps: `w` stops at the end of a word), **`0` / `$`** to the start / end of the line,
  **`gg` / `G`** to the top / bottom of the page. The page scrolls to keep the caret in view.
- **`e`** goes to the end of the word, **`ge`** to the end of the previous one. **`W` / `B` /
  `E`** are the same for WORDs, which only spaces delimit (`beta.gamma` is one WORD).
  **`^`** goes to the first non-blank character of the line, **`{` / `}`** to the start / end of
  the paragraph (the next one from its edge).
- **`f` / `F`** and a character go to the next / previous one on the line, including it in the
  selection; **`t` / `T`** stop just before it. **`;`** repeats the last of these, **`,`** repeats
  it the other way. The line here is the text between line breaks, even if the page wraps it.
- A count repeats any motion: `3e`, `5j`, `2f,`.
- **`v`** starts a selection at the caret; the motions then extend it. `v` again drops it and
  the caret moves on its own. **`V`** selects whole lines instead: the motions add lines, and
  `V` again drops it (`v` keeps the same text, character by character). **`o`** swaps the ends,
  so the motions move the other one. **`iw`** selects the word at the caret, **`aw`** the word
  and the spaces after it.
- **`ip`** selects the text block the caret is in (the paragraph, heading, list item, quote, code
  block or table cell), as `v` from [element focus](#copying-a-paragraph-element-focus) would.
  **`ap`** does the same, and each further `ap` grows the selection to the block around it: the
  section, then the article. A code block is selected whole from any of its lines. Blocks are the
  page's elements, not blank lines as in Vim.
- **`y`** copies the selection to the clipboard as plain text, says "yanked 12 chars" and goes
  back to normal mode. With nothing selected it says "nothing to yank". **`Y`** copies the whole
  lines the selection (or the caret) is on, then leaves the same way.
- **`Esc`** drops the selection and goes back to normal mode.

**With the mouse.** Selecting text with the mouse in normal mode (dragging, a double click for a
word, a triple click for a paragraph, shift+click) enters copy mode with that selection: the
badge says `VISUAL`, `y` copies it, the motions extend it (a double click on a word, then `e`,
takes the next word too) and `Esc` clears it. A click that selects nothing stays in normal mode,
and so do links, text fields (insert mode, as always), drag and drop, and a page that selects text
by itself. Firefox's own copying keeps working in every mode and in each pane: `ctrl+c`, the
context menu's Copy, and a middle click pasting the mouse selection.

The page gets none of these keys, nor any other plain key while copy mode is on; chords such as
`ctrl+c` or `ctrl+t` still work. In a frame (an embedded video page, a comment widget) copy mode
works once the frame has focus (click it first). Text inside a text field is not reachable: focus
the field and use its own selection.

## Status bar

The status bar is the window's last line, and it is always there, so you never lose track of
where you are. It hides only while a page is in fullscreen, such as a video; browser fullscreen
with `F11` keeps it. From the left:

- the **mode** badge in the mode's colour: `NORMAL` on a page, `INSERT` while a text field has
  focus (or after `i`), `COMMAND` while you type a `:` command or a `/` search, `HELP` while
  the `ctrl+b ?` overlay or tab search is open, `HINT` while link hints are up,
  `VISUAL` in copy mode. Each mode keeps a colour of its own: when a theme gives two modes the
  same colour or nearly (Catppuccin's bright magenta is its magenta, so `ELEMENT` would look like
  `VISUAL`), the later of the two in the order `NORMAL`, `INSERT`, `VISUAL`, `COMMAND`, `HINT`,
  `ELEMENT`, `HELP`, `PANEL`, `RESIZE`, prefix takes a lighter or darker shade of its colour, and
  its text stays readable;
- the **pending keys**, e.g. `prefix` after `ctrl+b`;
- the **workspace**: `● 2:work`, its number in workspace order and its name;
- `tab 2/5`: the selected tab and how many the workspace shows;
- in a split, `pane 2/3`: the focused pane and how many there are; `split 3 hidden` (dim) when
  the workspace's split is kept out of sight while another tab shows alone
  ([below](#picking-a-tab-during-a-split));
- the page **title**, or your rename (`ctrl+b shift+t`);
- on the right, the **search** in this page: `/word [2/5]` (match 2 of 5), or
  `/zzz not found` in red;
- `◇ agent` while a local AI agent is connected ([agent workspace](#agent-workspace)):
  `◇ agent 2?` when 2 of its requests wait for your answer, `◇ agent granted` while it may act
  without asking (`◇ agent 14m` for a grant of minutes with 14 left), and `◇ agent ·` for a
  moment after a request ran;
- `loading` while the page loads, then its **URL** without `https://`;
- with the [toolbar hidden](#hiding-the-toolbar), `not secure` in red for a page Firefox's
  address bar would warn about (an `http:` page keeps its `http://`), `using camera, mic` (or
  screen, location, XR, serial) while the page uses them, and `private` in a private window that
  is not the [private workspace](#private-workspace) (which says `◆ private` already).

On a narrow window the least important parts give way first: the URL is shortened in the middle,
then dropped, then the title is shortened, and so on. The mode badge always stays. Screen
readers announce the mode when it changes, including when focus moves into or out of a text
field, but not every title change.

With the toolbar hidden the URL is the only place the address shows, so it outlasts the title,
a title never takes its place, and in a narrow window it loses its path and then its leftmost
subdomains, never the site's own domain: `…evil.example…`, not `accounts.google.com…`. A blank
page another page opened says so: `about:blank from example.com`.

After `ctrl+b` (or any key that starts a longer sequence) only the pending keys show in the bar;
no list of next keys pops up. To see the bindings, press `ctrl+b ?` (`ctrl+b shift+?` on a
layout where `?` is shifted): the overlay is the one place that lists them.

### Hiding the toolbar

`ctrl+b u` hides Firefox's toolbar, the row with the address bar, the back and reload buttons and the
add-on buttons, in every window, and `ctrl+b u` again brings it back. The page then reaches the
top of the window, with only the status bar below it. The notice says `toolbar hidden` or
`toolbar shown`. `:toolbar` does the same, and `:toolbar show` and `:toolbar hide` set it either
way (a `vimma-ctl` script can set a known state); `Tab` completes the two words. To start every
window with it hidden, put `[ui] toolbar = "hidden"` in [config.toml](#configtoml). A toggle lasts
until a restart or until you edit that line.

- **Typing an address:** `I`, `ctrl+l`, `alt+d`, `F6`, `t`, `ctrl+t`, `ctrl+b c` and a new pane
  all still focus the address bar. A minimal bar then shows over the top of the page: only the URL
  field, with Firefox's suggestions below it. No site identity or buttons around it (the status
  bar names the site), no bookmarks toolbar, no window controls. The page does not move or
  resize.
- **Leaving it:** `Enter` loads the page, puts focus in it and hides the bar. `Esc` works as in
  Firefox (it closes the suggestions, then undoes what you typed), and one more `Esc` puts focus
  back in the page and hides the bar.
- **The whole toolbar:** `ctrl+b u` brings it back, with its buttons; moving the pointer to the
  window's top edge does not. It also shows by itself while an add-on's popup or a panel from one
  of its buttons (downloads, the menu, the extensions menu) is open, so the popup hangs from its
  own button as with the toolbar shown.
- **Permission prompts** (camera, location, notifications) show the whole address bar, without
  the toolbar's buttons: the prompt points at its icon in the address bar, next to the site's
  identity, exactly as with the toolbar shown. Vimma never shows one without saying which site
  asks. Clicking the site's identity there opens its panel.
- **Security in the status bar:** while the toolbar is hidden the status bar says `not secure`
  for a page that is not served over a secure connection, and `private` in a private window
  ([above](#status-bar)).
- **Window controls:** with Firefox's own title bar (close, minimise and maximise buttons in the
  toolbar), they hide with it and show when `ctrl+b u` brings the toolbar back. On a tiling window
  manager such as Omarchy's, which draws no title bar, nothing changes.
- **Left as Firefox has it:** customize mode, pop-up windows (they keep their read-only address
  bar, so a pop-up always says where it comes from), and `F11` and video fullscreen, where
  Firefox's own toolbar rules apply.

#### Answering a permission prompt

When a site asks for your location, camera, microphone or notifications, Firefox's prompt hangs
from the address bar. Whether the toolbar is shown or hidden, you can answer it from the keyboard:

| Key   | What it does                                                                              |
| ----- | ----------------------------------------------------------------------------------------- |
| `y`   | The prompt's main button (Allow).                                                         |
| `n`   | Its other button (Block, or Don't allow).                                                 |
| `Tab` | Moves focus onto its buttons, Block first; then the arrow keys, `Enter` and `Space` work. |
| `Esc` | As in Firefox: the other button (Block).                                                  |

`y` and `n` count only once the prompt has been up for half a second (Firefox's own delay for
these buttons) with no key pressed in between; the line `y allow · n block · Tab buttons` in the
prompt shows when they do. Any key you press meanwhile starts the wait again, so typing that was
meant for the page never answers a prompt. While you type in a text field of the page or the
address bar, `y` and `n` are text, and the line starts with `Esc, then`: `Esc` leaves the field
and keeps the prompt open, and then `y` and `n` answer it. The same holds while one of Vimma's
own pickers, live grep, the command line or a search you are typing is open: what you type is
theirs. In link hints, copy mode and element mode, `y` and `n` stay theirs too (a hint label, the
yank), and the line starts with `Esc, then`: `Esc` leaves the mode, and then `y` and `n` answer
the prompt. Vimma never moves focus onto the prompt. The same keys answer Firefox's
other prompts in that panel, such as "Save password?" (`y` saves, `n` is Not now), and the "Add
<name>?" prompt for installing an add-on, which Firefox opens with focus on the prompt itself.

A site whose login keeps you on the same page leaves focus in its password field, so the "Save
password?" prompt opens with the `Esc, then` line. In the prompt's own username and password
fields, every key is the field's: a `y` or an `n` there is typed, and `Tab` is Firefox's, as
everywhere inside the prompt.

### Colours and themes

The status bar, the command line, the `ctrl+b ?` overlay, the pickers and prompts, link hints,
notices, pane borders and the start page share one theme, and so do Firefox's toolbar, its
address bar and suggestions, and the prompts and panels that hang from it. Out of the box it is Vimma's own,
the palette of [vimma.dev](https://vimma.dev): near-black surfaces, grey-green text, and mint
for the accent, the normal-mode badge and link hints. It has a dark and a light variant, and by
default it follows your system's or Firefox's light or dark setting (`prefers-color-scheme`),
switching the moment that changes, without a reload. Firefox's own focus rings follow the theme
too: the address bar's focus ring and the 3 px border of the focused pane in a split are the
theme's accent (made a shade darker or lighter if it would not stand out at 3:1 against the
colours around it; on Omarchy, the accent your theme gives Kitty's active split and Hyprland's
focused window), and so are the focus rings of Vimma's own side panel, bookmarks panel, pickers and
help overlay. Firefox's own sidebar (history, bookmarks and synced tabs, opened from the toolbar's
sidebar button or the View menu) follows the theme as well: its launcher strip and panel
are on the same surface as Vimma's side panel, with the theme's text, edge and focus colours (the
search box, the open panel's button in the launcher and the lists' scrollbars included), and
an open sidebar recolours with the rest of the window. So do Firefox's other surfaces: the find
bar, the menu bar (`F10`) and every menu, the dialogs a page opens (`alert`, `confirm`,
`prompt`), the print settings, and Firefox's own pages: Settings and its dialogs, Add-ons,
Downloads (`about:downloads`), Troubleshooting (`about:support`), `about:config`,
`about:profiles` and `about:processes`. Their accent (the selected category, checkboxes, main
buttons) is the normal-mode badge's colour. Settings' default-browser card shows its text and
button without Firefox's mascot. With your system's high-contrast setting on, these surfaces keep
Firefox's own high-contrast colours. Pages that Firefox loads in a web content process, such as
`about:logins` and Firefox's error pages, keep Firefox's colours.

The Vimma logo on the start page and on `about:vimma` follows the theme too: the window and the
brushstroke V are the theme's accent colour, and the "imma" lettering is white with a dark theme
and the theme's text colour with a light one. It changes with the rest of the theme, and with
your system's high-contrast setting on it is drawn in the high-contrast text colour. The app
icon and Firefox's About dialog keep the logo's own colours.

**Dark, light or the system's: `:theme`.** The start page says it too:

- `:theme dark` or `:theme light` keeps the built-in palette dark or light whatever the system
  says; `:theme system` follows the system again (the default). Tab completes the three.
- A bare `:theme` switches to the other one of what you see now.
- It applies at once in every window and start page, and Vimma remembers it across restarts
  (in the `vimma.theme.appearance` preference).
- The same in [config.toml](#configtoml) is `[theme] appearance = "dark"` (`"light"`,
  `"system"`). Set there, the file always wins: `:theme` then changes nothing and its notice
  says to change the file.
- `[theme.colors] mode = "dark"` (or `"light"`) also keeps the palette dark or light; it is an
  override on top of any palette, so it wins over `appearance`.
- Web pages follow it too: a site with a dark mode is dark while Vimma shows dark, and light
  while Vimma shows light (`prefers-color-scheme`). With `:theme system` they follow the system,
  as Vimma does. On Omarchy they follow your Omarchy theme's dark or light. Firefox's Settings →
  General → Website appearance, set to Dark or Light, wins over Vimma for web pages; Automatic
  (the default) leaves them to Vimma.

**Picking the built-in palette.** `[theme] name` in [config.toml](#configtoml) chooses it:
`"vimma"` (the default) or `"tokyo-night"`, a Tokyo Night palette that is dark only (so
`appearance` makes no difference to it). `[theme.colors]` changes single colours of either.

```toml
schema = 2

[theme]
name = "tokyo-night"   # or "vimma", the default
appearance = "dark"    # the built-in palette dark, "light", or "system" (the default)
```

**On Omarchy: your Omarchy theme.** On an [Omarchy](https://omarchy.org) system, Vimma takes its
colours from your current Omarchy theme instead, with nothing to set up. When it starts, Vimma
looks once for Omarchy (`~/.local/share/omarchy` or `~/.local/state/omarchy`); anywhere else it
reads nothing and checks nothing, and installing Omarchy later takes effect at the next start.
On Omarchy it reads `~/.local/state/omarchy/current/theme/colors.toml` (and `light.mode`, for a
light theme) and checks it every 2 seconds, so `omarchy-theme-set` (or picking a theme from the
Omarchy menu) recolours every open window and start page within 2 seconds, without a restart.
The Omarchy theme decides whether it is dark or light; `:theme` applies only to the built-in
palette, which Vimma shows when you set `[theme] source = "file"` (or `vimma.theme.source` to
`builtin`). A
theme whose `colors.toml` has only the terminal colours (`accent`, `foreground`, `background`,
`selection_background` and `color0` to `color15`, as older and third-party themes ship it) works
too: Vimma fills in the rest as Omarchy does, so the shades and the bright colours match your
terminal; only the selected-row colour is darkened (or lightened) until its text reads. A
`colors.toml` Vimma cannot read (a value that is not a `#rrggbb` colour, or no `accent`,
`foreground`, `background` or one of the six colours, by name or as `color0` to `color7`) is
ignored: the colours stay as they were, and `about:vimma` and the Browser Console
(`ctrl+shift+j`) say which key is wrong.

```toml
schema = 2

[theme]
source = "file"        # ignore Omarchy; always the built-in palette
```

**Instant theme changes.** On Omarchy, Vimma recolours as soon as `omarchy-theme-set` finishes,
not within 2 seconds, with nothing to set up. When Vimma starts and finds
`~/.config/omarchy/hooks/`, it writes its hook, `vimma-theme-reload.sh`, into
`~/.config/omarchy/hooks/theme-set.d/` (mode 0644). Omarchy runs that hook after every theme
change; it tells each running Vimma to read the theme again, through the same channel a second
`vimma` command uses to reach the running one (no control socket, no `vimma-ctl`). With Vimma
not running, the hook does nothing and starts nothing. Omarchy runs its hooks after it has
restarted the terminals and retinted the other apps, so Vimma changes together with them.

- **Your edits stay yours.** The hook's last line is a checksum. As long as it matches, Vimma
  keeps the file up to date; once you edit the file, Vimma never writes or removes it again.
- **Deleting it sticks.** Vimma writes the hook once; if you delete it, it does not come back.
- **To opt out**, set `vimma.theme.omarchyHook` to `false` in `about:config`: Vimma removes its
  own, unedited hook at once and writes no new one. Set it back to `true` to have it written
  again.
- **By hand:** `vimma -vimma-reload-theme` makes the running Vimma read its theme now. Use it
  only while Vimma is running: if none is, the command starts Vimma. The hook checks first, so
  it never starts one.
- Without D-Bus, the hook falls back to `vimma-ctl reload-theme` when `vimma-ctl` is on your
  `PATH` and the [control socket](#scripting-with-vimma-ctl) is on.

The 2-second check keeps working in every case.

## Keys

[bindings.md](bindings.md) lists the full default keymap. It is generated from the same table
the dispatcher and the `ctrl+b ?` overlay use, so the three always agree. Both show the keys
you press, with your prefix filled in (`ctrl+b b`, not `prefix+b`), under a line that says what
it is (`prefix = ctrl+b`). Once you add a leader binding, it shows the same way (`space n`) and
the line adds `leader = space`. A binding you remap in `config.toml` shows there with your
keys. A `[panel]` after a key means it works only in that mode.

**What works today:**

| Keys                                                                                    | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `j` / `k`, `h` / `l`                                                                    | Normal mode: scroll down / up, left / right by a step. A count repeats: `3j`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `d` / `u`, `ctrl+d` / `ctrl+u`                                                          | Normal mode: scroll half a page down / up, as in Vimium and Vim. `ctrl+e` / `ctrl+y` scroll a step down / up, as `j` / `k`. In insert mode the page gets them; in a text field `ctrl+u` deletes to the line's start.                                                                                                                                                                                                                                                                                                                                                                      |
| `gg` / `G`                                                                              | Normal mode: go to the top / bottom of the page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `H` / `L`, `ctrl+o` / `ctrl+i`, `alt+left` / `alt+right`, `ctrl+[` / `ctrl+]`           | Back / forward in the page's history (in a split, the focused pane's), `ctrl+o` / `ctrl+i` as Vim's jump list. `H`, `L`, `ctrl+o`, `ctrl+i`, `ctrl+[` and `ctrl+]` in normal mode; Firefox's `alt+left` / `alt+right` in every mode, the address bar too. On macOS these two are Firefox's `cmd+left` / `cmd+right` and `cmd+[` / `cmd+]`, in every mode ([On macOS](#on-macos-the-alt-keys-are-cmd-keys)). A count moves that many pages, stopping at the first or last: `3H`.                                                                                                           |
| `r`, `F5`, `ctrl+r`                                                                     | Reloads the page (in a split, the focused pane's); `r` in normal mode, Firefox's `F5` and `ctrl+r` everywhere. In insert mode `H`, `L` and `r` are typed into the field. `ctrl+F5` / `ctrl+shift+r` reload bypassing the cache.                                                                                                                                                                                                                                                                                                                                                           |
| `i`                                                                                     | Normal mode: focus the text field you were last in (else the first) and enter insert mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `gi`                                                                                    | Normal mode: focus the first visible text field, insert mode; `3gi` the third (or the last). With none, it says so and stays normal.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `yy`                                                                                    | Normal mode: copies the page's URL (in a split, the focused pane's); the notice shows it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `p` / `P`                                                                               | Normal mode: opens the clipboard here / in a new tab, as `:open` / `:tabnew`: a URL loads, other text is searched. No `javascript:`, `data:`.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `gu` / `gU`                                                                             | Normal mode: up one level in the URL / to the site's root, without query and hash; `2gu` goes up two. At the top it says so.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `gf`                                                                                    | Normal mode: the page's source in a new tab, as Firefox's `ctrl+u` does. In insert mode `gi`, `yy`, `p`, `P`, `gu`, `gU` and `gf` are typed into the field.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `I`, `ctrl+l`, `alt+d`                                                                  | Focus the address bar with its text selected (in a split, the focused pane's); closes an open panel first. `I` in normal and copy mode, Firefox's `ctrl+l` and `alt+d` everywhere (`ctrl+l` and `cmd+l` on macOS).                                                                                                                                                                                                                                                                                                                                                                        |
| `f` / `gF`                                                                              | Normal mode: link hints. Type a label to follow it, or, with `gF`, to open the link in a background tab. `Backspace` undoes a key, `Esc` cancels.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `F`                                                                                     | Normal mode: element focus ([above](#copying-a-paragraph-element-focus)). Type a label to outline a text block; `y` copies it, `v` selects it in copy mode.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `/` / `?`                                                                               | Normal mode: find in the page (below). `Enter` stays on the match, `Esc` goes back to where you were.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `n` / `N`, `ctrl+g` / `ctrl+shift+g`, `F3` / `shift+F3`                                 | Next / previous match of the last search (`?` reverses them), wrapping around the page; `n` / `N` in normal mode. With Firefox's own find bar open, its search.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `v`, `ctrl+b [`                                                                         | Normal mode: copy mode ([above](#copy-mode)): `h j k l w b e ge W B E 0 ^ $ { } gg G f t F T ; ,` move, `v V o iw aw ip ap` select, `y Y` copy, `Esc` leaves.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `Esc`                                                                                   | Insert mode: leave the text field, back to normal mode. In normal mode the page gets `Esc` first; if it leaves it alone, `Esc` stops a page that is still loading, as Firefox's does.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ctrl+b ?`                                                                              | Opens the bindings overlay over any page, including `about:preferences` and the PDF viewer. Press it again to close.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `/` (in the overlay)                                                                    | Filters the list as you type.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `Esc` or `q` (overlay)                                                                  | Closes the overlay. Focus returns to where it was.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ctrl+b c`, `ctrl+t`, `t`                                                               | Opens a new tab (the start page, address bar focused).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `t` in normal mode.                                                                     |
| `ctrl+b n` / `ctrl+b p`, `ctrl+tab` / `ctrl+shift+tab`, `ctrl+pagedown` / `ctrl+pageup` | Next / previous tab, wrapping around at the ends. Hidden tabs are skipped. `gt` / `gT` in normal mode; `3gt` goes to tab 3.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ctrl+b 1..9`, `alt+1..8`, `alt+9`                                                      | Tab 1 to 9, counting visible tabs (pinned tabs first); Firefox's `alt+9` is the last tab. On macOS Firefox's `cmd+1..8` and `cmd+9` instead. With fewer tabs than N, nothing happens. `ctrl+shift+pageup` / `ctrl+shift+pagedown` move the tab left / right among them.                                                                                                                                                                                                                                                                                                                   |
| `:`                                                                                     | Normal mode: opens the command line at the bottom of the window ([below](#the-command-line)). In a text field `:` is typed.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ctrl+b g`, `ctrl+shift+a`, `b`                                                         | Opens tab search over the page, ready to type (`b` in normal mode; `ctrl+shift+a` is Firefox's tab search key): every tab of every workspace and window, and the recently closed ones ([below](#tab-search-and-tab-rename)).                                                                                                                                                                                                                                                                                                                                                              |
| `ctrl+b f g`                                                                            | Opens [live grep](#live-grep): search the text of the workspace's tabs as you type. `]q` / `[q` in normal mode step through its results afterwards.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ctrl+b shift+t`                                                                        | Renames the tab ([below](#tab-search-and-tab-rename)); an empty name restores the page title.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ctrl+b a`                                                                              | Bookmarks the page; type folders before its title: `work/docs/title` ([below](#bookmarks)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ctrl+b shift+b`                                                                        | Opens or closes the bookmarks panel ([below](#bookmarks)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ctrl+b e`                                                                              | Opens the add-on picker: popups, options, enable/disable, remove, updates ([below](#add-ons)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ctrl+b v` / `ctrl+b -`                                                                 | Splits the pane right / down. The new pane opens a new tab (the start page, address bar focused). At most 4 panes (`[panes] max`); a refused split says why.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ctrl+b h j k l`                                                                        | Focuses the pane left / below / above / right; when several touch, the one used last. `ctrl+w h j k l` in normal mode. The page of that pane gets focus, and the pane a 3 px border in the theme's focus colour.                                                                                                                                                                                                                                                                                                                                                                          |
| `ctrl+b z`, `ctrl+w o`                                                                  | Zooms the pane to the whole window, or back. The other panes' pages pause. A pane focus key unzooms when it moves.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ctrl+b x`                                                                              | Closes the pane; its tab stays open. With one pane it closes the tab, as `ctrl+b shift+x`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ctrl+b shift+h j k l`                                                                  | Swaps the pane with the one left / below / above / right; it keeps focus and its page. `ctrl+w H J K L` in normal mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ctrl+b r`                                                                              | Resize mode ([below](#resize-mode)): `h j k l` move the pane's divider, `Esc` leaves. `ctrl+w < > + -` resize directly in normal mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ctrl+b enter`                                                                          | A new pane along the focused pane's longer side: side by side when it is wide, stacked when it is tall ([Layouts](#layouts)). `[panes] layout = "manual"`: as `ctrl+b v`.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ctrl+b space`                                                                          | Cycles the layout presets, as tmux does; the status bar names the one you get ([Layouts](#layouts)). `:layout tiled` picks one.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ctrl+b shift+x`, `x`, `ctrl+F4`                                                        | Closes the tab, as Firefox's `ctrl+w` did: on a pinned tab it selects the first unpinned tab instead; closing the last tab opens a new tab and keeps the window ([Firefox behaviour Vimma changes](#firefox-behaviour-vimma-changes)). `x` in normal mode. `ctrl+shift+t` reopens the last closed tab, in every mode.                                                                                                                                                                                                                                                                     |
| `ctrl+b` then anything else                                                             | Never leaks to the page. A binding without a command shows "… not implemented yet" for 1.5 s; an unbound key does nothing. Firefox's `ctrl+b` bookmarks sidebar is off.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Firefox's keys                                                                          | Vimma bindings with Firefox's meaning ([below](#firefoxs-keys-are-vimma-bindings)): `ctrl+n` / `ctrl+shift+w` new / close window, `ctrl+shift+n` reopen it, `ctrl+q` quit (Firefox asks first), `ctrl+plus` / `ctrl+minus` / `ctrl+0` page zoom, `F11` full screen, `ctrl+s` save, `ctrl+p` print, `ctrl+m` mute the tab, `alt+home` home page, `ctrl+shift+y` downloads, `ctrl+shift+f` add-ons, `ctrl+shift+h` / `ctrl+shift+o` history / bookmarks (the Library), `ctrl+}` Picture-in-Picture, `ctrl+alt+r` Reader View, `ctrl+shift+s` screenshot, `ctrl+shift+delete` clear history. |
| Developer tools                                                                         | Exactly as in Firefox: `F12` / `ctrl+shift+i` the toolbox, `ctrl+shift+c` Inspector, `ctrl+shift+k` Web Console, `ctrl+shift+z` Debugger (in a text field: redo), `ctrl+shift+e` Network, `shift+F7` Style Editor, `shift+F5` Performance, `shift+F9` Storage, `shift+F12` Accessibility, `ctrl+shift+m` Responsive Design Mode, `ctrl+shift+j` Browser Console, `ctrl+alt+shift+i` Browser Toolbox. Each is an action you can rebind in `[keys]`.                                                                                                                                        |

`p` and `P` read the system clipboard (the one `yy` and copy mode's `y` write). The text is
trimmed and its line breaks become spaces; one word with a scheme, a dot or a port (`https://…`,
`example.com`, `localhost:3000`) loads as a URL, anything else goes to your default search
engine. Text that would load as a `javascript:` or `data:` URL (also behind `view-source:`), or
is longer than 8192 characters, is refused with a notice and nothing opens. `P`'s tab opens in
the current workspace, as `:tabnew`'s does.

While the overlay is open it takes every key, so `ctrl+w` cannot close the tab behind it. Rows
for bindings that do not run are dimmed, under a legend that says so; actions your
`config.toml` rebinds are marked `*`. In normal mode bare digits start a count (`3j`), so a
page's own digit shortcuts need `i` first.

Clicking into a pane focuses it, as `ctrl+b h/j/k/l` would. So does selecting a pane's tab any
other way (tab search, `ctrl+tab`, `alt+1..9`): the status bar's `pane n/m` and the
address bar follow, and a zoom ends, as it does when a pane key moves.

The focused pane has a 3 px border in the theme's focus colour, drawn over the outer edge of its
page so the page does not move or resize when focus does; the other panes keep a thin separator
and are not dimmed. There is no border with one pane, on a zoomed pane, while the split is
hidden, or on a page in fullscreen.

### Picking a tab during a split

Going to a tab that is not in the split (tab search, `ctrl+tab`, `alt+1..9`,
`ctrl+b 1..9`, `ctrl+b n` / `p`, `gt` / `gT`, a click on a tab, the side panel) shows that tab
alone in the whole window, as Firefox's own split view does. The split is not lost: it waits,
hidden, with its panes, sizes and focused pane, and the status bar says `split 3 hidden`. Go to
any of its tabs, by any of the same routes, and the whole split comes back, with that tab's pane
focused. A pinned tab works the same way. While the split is hidden the pane keys act on the tab
you see as on a single pane, and `ctrl+b v` / `-` / `enter` say "the split is hidden: go to one
of its tabs first". The hidden split survives a workspace switch and a restart.

A new tab you open while the split shows (`ctrl+t`, `ctrl+b c`, `t`, `:tabnew`, `P`, a link
opened in a new foreground tab, also with `f`, or a link from another app) opens in the focused
pane instead: the split stays, and the tab that pane showed stays open in the workspace.

A split made outside Vimma (Firefox's own split-view command, an extension, or a restored
Firefox session) becomes the workspace's panes: its tabs side by side in its order, at the
widths Firefox gave them, with the selected tab's pane focused. The pane keys then work on it,
and the workspace keeps it like any other split. If such a split's tabs are in different
workspaces, or the workspace already has a split, Vimma separates its tabs again and the
status bar says why; the tabs stay in their workspaces. Separating a split outside Vimma closes
its panes.

### Resize mode

With two panes or more, `ctrl+b r` enters resize mode and the status bar says `RESIZE`. Each
key moves the focused pane's nearest divider by 5% of its split: `l` (or `→`, `>`) makes the
pane wider, `h` (`←`, `<`) narrower, `j` (`↓`, `+`) taller, `k` (`↑`, `-`) shorter. A count
repeats the step: `4l` is 20%. Growing borrows from the nearest neighbour first, then the next
one; no pane gets smaller than 10% of its split. `Esc`, `Enter` or `q` leave the mode. The
mode is modal like the bindings overlay: the page sees none of its keys, and other keys do
nothing. `ctrl+b` keys still work in it. With one pane, `ctrl+b r` says so and does nothing.

Without the mode, `ctrl+w >`, `ctrl+w <`, `ctrl+w +` and `ctrl+w -` resize by one step in
normal mode (`3 ctrl+w >` by three), as in Vim. A config can rebind the mode's keys in
`[modal.resize]`.

### Layouts

Panes tile as in tmux, with one idea from Hyprland. `ctrl+b enter` is tmux's `split-window`
without a direction to choose: it splits the focused pane along its longer side, so a wide pane
gets a neighbour on its right and a tall one a neighbour below. From one pane, three presses
make a spiral: side by side, then the right half stacked, then its lower quarter side by side.
The new pane opens the start page and has focus; past `[panes] max` it is refused with the usual
notice. `ctrl+b v` and `ctrl+b -` still split right and down.

`ctrl+b space` is tmux's `next-layout`: it rearranges the panes you have into the next preset,
and the status bar shows its name for a moment (`layout: tiled`):

| Preset            | The panes                                                             |
| ----------------- | --------------------------------------------------------------------- |
| `even-horizontal` | all side by side, equal widths                                        |
| `even-vertical`   | all stacked, equal heights                                            |
| `main-vertical`   | the focused pane large on the left, the others stacked on the right   |
| `main-horizontal` | the focused pane large on top, the others side by side below          |
| `tiled`           | a grid: 2×2 at four panes, two over one at three                      |
| `dwindle`         | a spiral: each pane takes half of what is left, along the longer side |

After `dwindle` it starts again at `even-horizontal`. Each workspace remembers the last preset it
used, across a switch and a restart, so `ctrl+b space` goes on from there; splitting, closing,
swapping or resizing panes afterwards keeps that name, as tmux does.

- **Pages stay as they are.** A preset moves the pages you have into new places; none is
  reloaded, and each keeps its scroll position, form text and history.
- **Focus and zoom:** the focused pane keeps focus, and its page has the keys afterwards. A
  zoomed pane is unzoomed first, as in tmux. The main pane of `main-*` is the focused one (tmux
  uses the first): focus a pane and pick `main-vertical` to make it the big one. The other panes
  keep their order after it.
- **Sizes:** presets share space equally, except the main pane, which takes 60%
  (`[panes] main_size`). Resize mode and `ctrl+w < > + -` work on the result as on any split.
- **By name:** `:layout tiled` picks a preset (Tab completes the names), and `:layout` alone is
  `ctrl+b space`. Each preset is also an action to bind in `config.toml`, unbound by default:
  `layout_even_horizontal`, `layout_even_vertical`, `layout_main_vertical`,
  `layout_main_horizontal`, `layout_tiled`, `layout_dwindle`:

  ```toml
  [keys]
  layout_tiled = ["prefix+alt+t"]
  layout_main_vertical = ["prefix+alt+m"]
  ```

- **With one pane** there is nothing to arrange: `ctrl+b space` says so. With more than 10
  panes (`[panes] max` up to 16) the even presets would make panes narrower than a tenth and are
  refused with the reason; `tiled` and `dwindle` always fit.
- **`[panes] layout`** sets what `ctrl+b enter` does: `"dwindle"` (the default) as above, or
  `"manual"`, where it splits right like `ctrl+b v` and the tree changes only the way you say.
  Presets work the same either way.

### Keyboard layouts

A binding names a character, and the character counts, not the keys that type it. On a
Finnish or German layout `{` is `AltGr+7` on Linux and Windows and `Option+shift+8` on a Mac,
and it matches a `{` binding (copy mode's `{` and `}`) the same as on a US layout. Vimma treats
a character typed with AltGr or Option as that character, the way `shift` is already part of
`?` or `G`. A real `alt` chord stays one: `alt+1` is still `alt+1`, and a `ctrl` or `ctrl+alt`
chord on a key that types its own character (`ctrl+w`, `ctrl+alt+]` on a US layout) keeps its
modifiers. Windows' `ctrl+alt` stand-in for AltGr counts as AltGr when it types another
character.

A dead key (`^`, `¨`, `´` on a Finnish layout) types nothing by itself, so it matches no
binding: GTK reports it as `Dead`. Bindings that use one have a second key for those layouts,
such as `ctrl+6` for `ctrl+^` ([Workspaces as Vim buffers](#workspaces-as-vim-buffers)).

## Firefox's own shortcuts

### Firefox's keys are Vimma bindings

The Firefox keys you already know are Vimma's own bindings, with Firefox's meaning: `ctrl+t`,
`ctrl+shift+t`, `ctrl+l`, `F5`, `ctrl+tab`, `alt+1..9`, `ctrl+plus`, `ctrl+q`, `F12` and the
rest ([Keys](#keys) above, every one in [bindings.md](bindings.md#firefoxs-shortcuts)). Each runs
what Firefox's key ran, so nothing you rely on changes, and each is listed in `ctrl+b ?` and
`:map` under its action (`alt+left` under "Go back", next to `H`, `ctrl+o` and `ctrl+[`). A chord
with `ctrl`, `alt` or `meta`, or a function key, works in every mode, as in Firefox: `ctrl+t`
opens a tab from a text field, the address bar, the side panel and the bindings overlay. Two are
normal mode only: `ctrl+[` / `ctrl+]` (back / forward; in a text field they do nothing) and
`Esc` (stop loading; elsewhere `Esc` leaves insert mode and closes things as usual).

Rebind or remove one like any Vimma key, by its action's name in `[keys]`:

```toml
[keys]
new_tab = ["prefix+c"]          # ctrl+t no longer opens a tab (t and ctrl+b c still do)
page_zoom_in = ["ctrl+plus"]    # drops ctrl+= and keeps ctrl+plus
devtools = ["f12"]              # ctrl+shift+i no longer opens the developer tools
```

**The page first, where Firefox let it.** A page that uses one of these keys itself gets it
first, as in Firefox: an editor that saves on `ctrl+s` or zooms on `ctrl+plus`, a web terminal,
`about:preferences`' own `ctrl+f`, the PDF viewer's zoom. Vimma acts only if the page left the
key alone, and a text field's own key wins too: `ctrl+shift+z` in a field redoes and does not
open the Debugger. Firefox's reserved keys stay the browser's whatever the page does, as they
always were: `ctrl+t`, `ctrl+n`, `ctrl+w`, `ctrl+shift+w`, `ctrl+shift+p`, `ctrl+q`, the tab
keys (`ctrl+tab`, `ctrl+pagedown`, `ctrl+F4`) and Vimma's own keys (`ctrl+b`). A site whose
"Override keyboard shortcuts" permission is Block (Page Info, Permissions) gets
none of them first. The rule belongs to the key, not the action: bind `ctrl+s` to something
else and the page still has it first.

A Firefox shortcut on a key Vimma binds is always off, so the two never both run. Every other
Firefox key is a Vimma binding on Firefox's own key too: `ctrl+f` (a second find key, as `/`),
`ctrl+j` (web search), `F7` (caret browsing), `ctrl+shift+b` (bookmarks toolbar) and the rest.
An unbound key does nothing, including the tab keys Firefox handles outside its shortcut lists
(`ctrl+pagedown`, `ctrl+tab`, `ctrl+F4`, `F7`). `shift+esc` (stop loading) works in normal mode
only. Three are left alone: the `alt+letter` keys that open the menu bar's menus stay Firefox's,
and a bare `alt` tap and `'` (quick find for links) do nothing (the `ui.key.menuAccessKeyFocuses`
and `accessibility.typeaheadfind.manual` prefs are `false` in Vimma's defaults).

**Any Firefox command from a key.** `:firefox <id>` runs one of the window's commands or keys by
its id (Tab completes them): `:firefox Tools:Downloads`, `:firefox key_search2`. A value that
starts with `:` in a `[modal.<mode>]` table binds a key to a command line; such bindings are
listed in `ctrl+b ?` under "Commands":

```toml
[modal.normal]
"<C-S-y>" = ":firefox Tools:Downloads"
```

#### On macOS the alt keys are cmd keys

Option types characters on a Mac (Option+1 is `¡`) and moves the caret by word (Option+left),
so the default keys that are `alt` chords on Linux would never run there. On macOS they are
Firefox's own macOS keys instead, the ones a Mac user already knows (written `meta` in
config.toml):

| Action                                      | Linux                    | macOS                                       |
| ------------------------------------------- | ------------------------ | ------------------------------------------- |
| Back / forward (`history_back`, `_forward`) | `alt+left` / `alt+right` | `cmd+left` / `cmd+right`, `cmd+[` / `cmd+]` |
| Tab 1 to 8 (`select_tab_1` … `_8`)          | `alt+1` … `alt+8`        | `cmd+1` … `cmd+8`                           |
| Last tab (`select_last_tab`)                | `alt+9`                  | `cmd+9`                                     |
| Address bar (`focus_urlbar`)                | `ctrl+l`, `alt+d`        | `ctrl+l`, `cmd+l`                           |

`alt+home` (home page) is the same on both, as in Firefox: Option+Home types nothing. Everything
else, `ctrl+b`, `H` / `L` and `ctrl+[` / `ctrl+]` included, is the same as on Linux. As on
Linux, the page and a text field have these keys first: `cmd+left` in a text field or the
address bar moves to the start of the line, and `cmd+[` goes back from there.
[bindings.md](bindings.md#on-macos) lists them, `ctrl+b ?` shows the ones in force, and a
`[keys]` list in config.toml replaces them as it does any default.

**Firefox's other macOS keys** use `cmd` where Linux has `ctrl` (`cmd+t`, `cmd+w`, written
`meta+t` in config.toml), and it has tab keys of its own: `meta+{` and `meta+}` (cmd+shift+[ and
cmd+shift+]), also with `ctrl` (`ctrl+meta+{`, `ctrl+meta+}`), and `alt+meta+left`,
`alt+meta+right`, `alt+meta+up` and `alt+meta+down`. Its sidebar keys use `ctrl`: `ctrl+x` (AI
chatbot), `ctrl+z` (show or hide the sidebar) and `ctrl+u` (open tabs, which stays Vimma's
half-page scroll). The default `disable = "all"` turns the others off, `ctrl+x` and `ctrl+z`
included, as it does Firefox's unbound keys on Linux. Vimma's own keys do
the same things: `ctrl+t` or `t` for a new tab, `x` to close it, and the `cmd+l` and `cmd+1..9`
above. `cmd+q` stays macOS's own quit key, and the Mac menu bar has no `alt` access keys.

To have Firefox's common `cmd` keys back, list them in `enable` (`cmd+t` works there too, and
means `meta+t`); each then runs exactly as in Firefox, and the others stay off:

```toml
schema = 2

[firefox]
enable = [
  "meta+t", "meta+n", "meta+w", # new tab, new window, close tab
  "shift+meta+t",               # restore the last closed tab, window or session
  "meta+r", "meta+f", "meta+g", # reload, find, next match
]
```

In a windowed Mac build a key that is off may still run from the menu bar when it has a menu
item there (`cmd+t` is File > New Tab, `cmd+w` File > Close Tab): macOS's menu bar takes the
item's key from Firefox's shortcut without seeing that it is off. This has not been checked on a
Mac yet.

### Firefox's shortcuts on Vim's keys

Firefox binds some of the keys Vimma and Vim use. So that the two never overlap, those Firefox
shortcuts are off in every mode: in insert mode, in the address bar, and when Vimma lets a key pass
(`ctrl+w` with one pane).

| Key      | Firefox's action, now off | Why it is off                                     | Where it is now                            |
| -------- | ------------------------- | ------------------------------------------------- | ------------------------------------------ |
| `ctrl+w` | close tab                 | `ctrl+w h/j/k/l` panes; delete a word when typing | `x`, `ctrl+b shift+x`, `ctrl+F4`, `:q`     |
| `ctrl+u` | view page source          | half page up; delete to the line's start          | `gf`                                       |
| `ctrl+h` | history sidebar           | backspace when typing                             | `ctrl+shift+h` (the Library's history)     |
| `ctrl+d` | bookmark this page        | half page down                                    | `ctrl+b a`                                 |
| `ctrl+o` | open a file               | history back                                      | `:open file:///path`, the File menu        |
| `ctrl+i` | page info                 | history forward                                   | the page's context menu, View Page Info    |
| `ctrl+k` | web search                | Vim's insert `ctrl+k`, readline's kill to the end | `I`, then type the search                  |
| `ctrl+b` | bookmarks sidebar         | Vimma's prefix                                    | `ctrl+b shift+b` (Vimma's bookmarks panel) |

`ctrl+e` and `ctrl+y` (scroll a step) are on the list too; Firefox binds neither on Linux (its
second web-search key is `ctrl+j` there, and downloads is `ctrl+shift+y`), so nothing changes.
`ctrl+shift+p`, Firefox's "New Private Window", goes to the
[private workspace](#private-workspace) (and opens it if it is not open) instead of a new private
window on every press.

Vimma turns them off at startup by disabling Firefox's own `<key>` elements (in every keyset of
the window, the developer tools' too), with no change to Firefox's code; `about:vimma` lists
the ones that are on (key, Firefox's id, what it does) under "Firefox shortcuts on", and the
chords on a `disable` list that Firefox does not bind. Change the list in `config.toml`:

```toml
schema = 2

[firefox]
disable = ["ctrl+b", "ctrl+d", "ctrl+e", "ctrl+h", "ctrl+i", "ctrl+k", "ctrl+o", "ctrl+u", "ctrl+w", "ctrl+y"]
enable = []
```

- **`disable`** is `"all"` by default: every Firefox shortcut, function and plain keys (`F5`,
  `Esc`) included. A list replaces it: then only the keys on the list are off. A Firefox shortcut on a key Vimma binds
  is off whatever the list says (`disable = []` gives back only the ones Vimma does not bind).
  `"all"` leaves the text keys the field itself runs (`ctrl+c`, `ctrl+v`, `ctrl+z`, `ctrl+a`)
  and the menu bar (`alt+letter`, `F10`).
- **`enable`** gives a key back to Firefox exactly as Firefox runs it: Vimma's default bindings
  on that key go, in every mode (`enable = ["ctrl+j"]`: Firefox's web search; `ctrl+t` keeps
  its other keys). If your own `[keys]` or `[modal.*]` binds the key, that is an error at the
  `enable` line: unbind it or drop it from the list. Enabled keys are listed in `ctrl+b ?` under
  "Firefox (on in config.toml)", and `about:vimma` lists them under "Firefox shortcuts on". An
  enabled key is never the page's first.
- A key must have `ctrl`, `alt` or `meta`, be a function key (`f5`), or be `esc` or `shift+esc`;
  anything else, or a key that does not parse, is an error at its line.

## Workspaces

Workspaces keep the different parts of your day apart. Every tab lives in a workspace, and every
workspace is a Firefox container of its own: a site you are signed in to in one workspace sees
none of its cookies or storage in another. A new
profile has one workspace, `main`, and the empty [agent workspace](#agent-workspace); you make
more as you need them (see [Managing workspaces](#managing-workspaces)).

- `ctrl+b )` / `ctrl+b (` (or `]w` / `[w`, `:wsnext` / `:wsprev`) go to the next / previous workspace in
  workspace order (`[workspaces]` in `config.toml`, then the ones you made), skipping the
  [agent workspace](#agent-workspace), wrapping around, as
  tmux's session keys do, from every mode; `:workspace work` or `:workspace 2` goes to one by
  name or number. The status bar shows where you are (`● 2:work`). `(` and `)` are matched by
  the character they type, not the key: `shift+9` / `shift+0` on a US keyboard, `shift+8` /
  `shift+9` on a Finnish one.
- `ctrl+^` (or `ctrl+6`, `ctrl+b ^`) goes back to the workspace you were in before, and again
  toggles back ([Workspaces as Vim buffers](#workspaces-as-vim-buffers)).
- `ctrl+b w` (or `:workspace` with no name) opens the [workspace picker](#workspace-picker).
- `ctrl+b b` or `:sidebar` opens the [side panel](#side-panel):
  the current workspace's tabs down the left of the window.
- A window shows **one workspace at a time**: the other workspaces' tabs are hidden, not closed.
  Coming back selects the tab you left, and a split comes back with its panes laid out as
  before, the same pane focused and its page ready for keys. Each workspace keeps its own split:
  splitting in one leaves the others' layouts alone. A workspace with no tabs gets a start-page tab when you switch to it.
- `ctrl+b 1..9`, `ctrl+b n` / `p`, `gt`, `ctrl+tab` and closing a tab stay within the
  workspace. Tab search (`ctrl+b g`) is the exception: it lists every workspace's tabs, and other
  windows', and picking one from another workspace switches there.
- **New tabs** (`ctrl+b c`, `t`, `ctrl+t`, a bookmark, a link from another app) open in the
  current workspace and its container. A link opened from a page keeps that page's container
  and so its workspace: opened in the background into another workspace, it waits there, hidden,
  and the status bar says where it went (`opened in "work"`).
- A tab in a container that belongs to no workspace (Firefox's own containers, "no container",
  an extension's) joins the workspace you are in as a `foreign` tab: it does not share that
  workspace's cookies and logins. The workspace picker counts it (`3 tabs, 1 foreign`).
- **Site permissions are per workspace**, like logins: a camera, microphone, location or
  notification permission you give a site in `work` does not apply to the same site in `main`
  or any other workspace (Vimma sets `permissions.isolateBy.userContext`). A permission stored
  without a container applies only to tabs with "no container", so give it again in each
  workspace that needs it. Firefox's Settings → Privacy & Security → Permissions lists a site once for each
  workspace that has a permission for it; the site information panel in the address bar shows
  the tab's own workspace. Firefox's built-in permission for addons.mozilla.org to install
  add-ons applies only outside workspaces, so installing from it asks once more.
- **A restart restores them.** Each window comes back with its workspaces, their tabs, the
  workspace you were in, the tab you had selected in each, every workspace's split panes laid
  out as you left them with the same pane focused, your tab names and each page's scroll position. Tabs of other workspaces are not loaded
  until you first go to them; their scroll position comes back then. The same happens with
  "Restore previous session" and reopening a closed window.
- **Pinned tabs** belong to no workspace and show in every one. Vimma has no key to pin; an
  extension or an old session can still pin.
- Each window has its own current workspace; the workspaces themselves are shared by all
  windows.

### Workspaces as Vim buffers

If you think of a workspace as a Vim buffer, the keys are the ones your fingers already know:

| Vim                      | Vimma                          | What it does                                            |
| ------------------------ | ------------------------------ | ------------------------------------------------------- |
| `ctrl+^`                 | `ctrl+^`, `ctrl+6`, `ctrl+b ^` | Back to the workspace you were in before; toggles.      |
| `]b` / `[b` (unimpaired) | `]w` / `[w`                    | Next / previous workspace, as `ctrl+b )` / `(`.         |
| `:b name`, `:b 2`, `:b#` | `:ws name`, `:ws 2`, `:ws #`   | Go to a workspace by name, number, or the previous one. |
| `:bn` / `:bp`            | `:wn` / `:wp`                  | Next / previous workspace.                              |
| `:bd [name]`             | `:wd [name]`                   | Close this (or the named) workspace; asks `y/N`.        |
| `:badd name`             | `:wa name`                     | New workspace; you switch to it.                        |
| `:ls`                    | `:workspaces`, `ctrl+b w`      | The workspace picker.                                   |

- **The previous workspace** is the one this window showed before the current one, however you
  left it (a key, a command, the picker, or selecting one of its tabs). Pressing `ctrl+^` again
  goes back, so two presses toggle between two workspaces, as Vim's alternate buffer does; tmux
  users can think of it as `prefix+L`, the last session. Each window has its own, it is saved
  with the window's session (a restart or "Restore previous session" brings it back), and a
  window that has shown only one workspace says `no previous workspace in this window`. Closing
  the previous workspace forgets it.
- `ctrl+^` and `ctrl+6` work in normal mode; in a text field they are the page's. `ctrl+b ^`
  and `ctrl+b ctrl+6` work in every mode, insert mode too.
- **`^` as a dead key.** On Finnish, German, French and other layouts `^` is a dead key: it
  waits for the next key to put an accent on. GTK then reports the key as `Dead`, not `^`
  (with or without `ctrl`), so `ctrl+^` and `ctrl+b ^` never arrive. Use `ctrl+6` and
  `ctrl+b ctrl+6` there, as Vim users on those layouts already do. `]` and `[` are `AltGr+9` /
  `AltGr+8` on a Finnish keyboard; `]w` and `[w` match them ([Keyboard layouts](#keyboard-layouts)).
- `]w` and `[w` are normal-mode keys; `]` then waits for the next key, as `g` does.
- `Tab` after `:ws `, `:wd ` or `:wsmove ` completes workspace names.
- Every one of these keys can be changed in `config.toml`: `last_workspace`, `next_workspace`
  and `previous_workspace` under `[keys]`, and `"<C-^>"`, `"<C-6>"`, `"]w"`, `"[w"` under
  `[modal.normal]`. The `ctrl+b ?` overlay shows the keys you have.

### Managing workspaces

| Keys             | Command                          | What it does                                                        |
| ---------------- | -------------------------------- | ------------------------------------------------------------------- |
| `ctrl+b shift+n` | `:wsnew shop`, `:wa shop`        | New workspace, with a container of its own; you switch to it.       |
| `ctrl+b shift+w` | `:wsrename market`               | Rename the current workspace (and its container).                   |
| `ctrl+b shift+d` | `:wsdelete [shop]`, `:wd [shop]` | Close the current (or the named) workspace, after a `y/N` question. |
|                  | `:wsmove work` / `:wsmove 2`     | Move the current tab to another workspace, by name or number.       |
| `ctrl+b shift+p` | `:private`, `:priv`              | Go to the [private workspace](#private-workspace); again goes back. |
|                  | `:private close`                 | Close the private workspace and discard its data, after `y/N`.      |

- The keys open the command line with the command typed for you (`ctrl+b shift+w` with the
  current name to edit).
- **Closing asks first**, at the foot of the window: `y` closes, any other key (`n`, `Esc`,
  `Enter`) keeps it. Closing a workspace you made **deletes its container, and with it its
  cookies, logins and site data**; the question says so. A workspace from `[workspaces]` in
  `config.toml` cannot be deleted while it is listed there: closing it closes its tabs only, and
  it keeps its logins. Renaming one is done in `config.toml` too. The last workspace cannot be closed.
  If the workspace changes between the question and your `y` (say `config.toml` was reloaded),
  nothing is closed. If you renamed its container in Firefox's Settings, its tabs and site data
  are kept, and the status bar says so.
- A workspace name cannot be only digits: in `:wsmove 2` and `:workspace 2` a number means the
  workspace's place in workspace order. `config.toml` can still name one `2` in `[workspaces]`;
  then `2` means that workspace, by name, and the workspace at place 2 is reached by its name.
- **Moving a tab reopens it** in the other workspace's container, as Firefox's "Reopen in
  Container" does: its address, name and mute come along, but not its back/forward history,
  what you typed into forms, its scroll position, or a form submission (the page is loaded
  again, signed in as that workspace). A tab in a split leaves the split first. You stay in the
  workspace you were in.
- **A workspace's container deleted outside Vimma** (Firefox's Settings → Containers, or an
  extension) is replaced at once by a new, empty one: the workspace stays, its new tabs open in
  the new container, and the status bar says so. Its cookies and logins went with the old
  container, so its sites need a new sign-in. Tabs an extension left open in the deleted
  container stay in the workspace, marked `foreign`.
- **Containers turned off** (`privacy.userContext.enabled` = `false` in `about:config`) at
  startup: the status bar shows a lasting error, and Vimma runs without workspaces (tabs open as
  in Firefox, without containers) until you set it back to `true` and restart. Vimma does not
  turn it back on for you.
- **A workspace's container gone at startup** (deleted while Vimma was closed, or its id taken
  by another container) is replaced by a new, empty one, and the status bar shows a lasting
  error naming the workspace until the next start: its sites need a new sign-in.
- **Pinned tabs:** Vimma has no key to pin a tab, and a pinned tab would show in every
  workspace, so a tab pinned by an extension or an imported session is unpinned at once and
  stays in its workspace; the status bar says `unpinned "<title>"`.

### Workspace picker

`ctrl+b w` lists the window's workspaces over the page, in workspace order: each with its number,
its name and how many tabs it has here; the one you are in says `current` and is selected. The
last row is the [private workspace](#private-workspace): `◆ private` with its tab count, or
`new` while it is not open. It shows a count only, never a title or an address.

| Key               | What it does                                                 |
| ----------------- | ------------------------------------------------------------ |
| `j` / `k`, arrows | Move down / up.                                              |
| `/`               | Search: type to filter by name; `Esc` goes back to `j`/`k`.  |
| `Enter`           | Switch to the selected workspace.                            |
| `m`               | Move the current tab to the selected workspace (asks first). |
| `Esc` / `q`       | Close the picker.                                            |

`m` asks `Move this tab to "work"? … y/N` at the foot of the window, because a moved tab is
reopened and loses its back/forward history and form data (see
[Managing workspaces](#managing-workspaces)): `y` moves it, any other key keeps it. If the tab or
the workspace changes before your `y` (another tab selected, the workspace renamed or closed),
nothing is moved. `m` on the workspace the tab is already in says so and asks nothing. To create,
rename or close a workspace, use `ctrl+b shift+n`, `shift+w` and `shift+d`.

`m` on the private row reopens the tab in the private workspace, after
`Reopen this tab in the private workspace? … y/N`. The page is already in your normal history, so
nothing new is recorded; it is Firefox's "Open Link in New Private Window" as a move. A private
tab never moves out: `m` on a normal row from the private workspace, and `:wsmove` there, say
`a private tab cannot leave the private workspace`.

The [agent workspace](#agent-workspace) is the last normal row, `◇ agent`, with its number and
tab count. `m` on it asks
`Move this tab to "agent"? Agents you allow can read it there. It is reopened with the agent's cookies; … y/N`.

### Agent workspace

Every profile has a workspace named `agent`, for local AI agents (Claude Code, Codex CLI,
opencode, GitHub Copilot) to use through `vimma-ctl mcp`. It is a workspace like the others, with a container of
its own, so its cookies and logins are apart from `main`, `work` and the rest. An agent only
ever reaches this workspace, and every request asks you first. To let one in, see
[Connecting an agent's tool](#connecting-an-agents-tool).

- **Made for you.** A new profile gets it after `main`; an existing one at its next start. It
  is cyan, with the fingerprint icon. It has no tabs until you move one in (or an agent opens
  one), so it loads nothing. If you already have a workspace named `agent` (your own, or one in
  `[workspaces]`), that one is used and no second one is made.
- **Not in the cycle.** `ctrl+b )` / `ctrl+b (`, `]w` / `[w`, `:wn` / `:wp` skip it, and the
  `ctrl+^` of another workspace never lands on it. You go there on purpose: the
  [workspace picker](#workspace-picker), where it is the last normal row (`◇ agent`), or
  `:ws agent`. In it, `ctrl+^` goes back to where you came from. It always sorts last, so
  `:ws 1`…`:ws N` keep their places.
- **Emptied, never deleted.** `ctrl+b shift+d` in it asks
  `Close the 2 tabs of "agent"? It stays, with its cookies and logins (:mcp forget clears them). y/N`:
  its tabs close and its container stays. It never counts as the last workspace, so `main` (or
  your last other one) stays too. Renaming it is refused
  (`its name is [mcp] workspace in config.toml`); to use another name, set `[mcp] workspace`.
  The old one then becomes an ordinary workspace.
- **Sharing a tab with an agent is moving it** there (`m` in the picker, or `:wsmove agent`),
  after a `y/N`. The tab is reopened with the agent workspace's cookies, never yours.
- **Links from other apps never open in it.** A link you click in your mail app, chat or terminal
  (through `vimma-open` or `vimma <url>`), a `vimma-ctl open`, a tab sent from your phone, a new
  window and the tab Vimma opens at startup go to the last workspace you used that is not the
  agent's (or your first one), and the window switches there (a sent tab opens in the background,
  and the status bar says `opened in "<workspace>"`). "Open links in the current tab" never replaces
  an agent tab: the link gets a new tab in that workspace. A password-reset or login link is then
  never in reach of an agent. What you open while in the agent workspace (`ctrl+t`, `:open`, the address
  bar, a bookmark) stays there.

| Command          | What it does                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `:mcp`           | Says whether agents are on or off, which workspace is theirs, and how many agents, questions and grants.            |
| `:mcp on`        | Asks `Let local AI agents ask to use the "agent" workspace? Every request asks you first. y/N`, then turns them on. |
| `:mcp off`       | Turns agents off, without a question. Connected agents are disconnected and their grants end.                       |
| `:mcp revoke`    | Ends every grant you gave agents, at once.                                                                          |
| `:mcp forget`    | Asks, then deletes the agent workspace's cookies and site data (its logins). The workspace stays.                   |
| `:mcp log`       | Lists the last 100 agent requests, newest first: time, agent, tool, tab, keys or address, and what came of it.      |
| `ctrl+b shift+a` | Answers the waiting agent request; with none, ends every grant at once.                                             |
| `:control on 15` | Turns full control (`vimma-ctl`) on for 15 minutes, after a `y/N`; `:control off` ends it now.                      |

- When the agent workspace is one of yours rather than one Vimma made, `:mcp on` warns:
  `"agent" is your own workspace (3 tabs, its own logins). Agents will be able to read it. y/N`.
- `:mcp on|off` is remembered in the pref `vimma.mcp.enabled`. `[mcp] enabled` in `config.toml`
  wins over it; then `:mcp on|off` changes nothing and says to edit the file.
- `about:vimma`'s **Agents (MCP)** section shows the switch, full control's state and the agent
  workspace's tab count.

#### Connecting an agent's tool

`vimma-ctl mcp` is the MCP server your agent's tool starts. It speaks MCP over its standard input
and output, connects to Vimma as an agent (never with full control), and offers eleven tools:

| Tool               | What the agent can do                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `vimma_tabs`       | List the agent workspace's tabs: id, address, title, whether it is loading.                              |
| `vimma_read_page`  | Read a tab's text, as Markdown or plain text, marked as untrusted web content.                           |
| `vimma_open`       | Open an http or https address in a new background tab there, or in one of its tabs.                      |
| `vimma_close_tab`  | Close one of its tabs.                                                                                   |
| `vimma_keys`       | Scroll, find text, follow a link, go back and forward or up a level in one of its tabs, with Vimma keys. |
| `vimma_show`       | Show you one of its tabs: your window switches to the agent workspace, and `ctrl+^` brings you back.     |
| `vimma_elements`   | List the buttons, fields and links on screen in one of its tabs, with labels; never a password's value.  |
| `vimma_activate`   | Click a button, link or checkbox from that list; sending a form or paying asks you every time.           |
| `vimma_fill`       | Fill fields from that list, never passwords, card numbers, one-time codes or files.                      |
| `vimma_screenshot` | See what one of its tabs shows, as an image, with that list's labels drawn on it if it asks.             |
| `vimma_console`    | Read one of its tabs' script errors, console errors and warnings, and failed requests.                   |

1. Use the `vimma-ctl` that came with Vimma, so it is updated with it: it is on your `PATH`
   from the `.deb`, the `.rpm`, the Arch Linux package and Homebrew; for the tarball, the
   AppImage and the `.dmg`, see [Installing](#installing) for where it is. With the tarball or
   the `.dmg`, give your tool its full path instead of `vimma-ctl` in the commands below if it
   is not on your `PATH`.
2. In Vimma, `:mcp on` and `y`. Leave full control (`vimma.control.enabled`) off: agents do not
   need it ([why](#what-vimma-protects-and-what-it-does-not)).
3. Add the server to your tool, with one of the commands below. Each was run against the version
   named, on Linux; each tool's `mcp list` then showed the server.

   ```sh
   claude mcp add --transport stdio --scope user vimma -- vimma-ctl mcp
   codex mcp add vimma -- vimma-ctl mcp
   copilot mcp add vimma -- vimma-ctl mcp
   ```

   - **Claude Code** (2.1.287). `--scope user` makes it available in every project; without it,
     only in the current one. A project can also list it in `.mcp.json`, in the format below.
   - **Codex CLI** (0.160.0). The command writes this to `~/.codex/config.toml`, which you can
     also edit by hand:

     ```toml
     [mcp_servers.vimma]
     command = "vimma-ctl"
     args = ["mcp"]
     ```

   - **GitHub Copilot CLI** (1.0.98). The command writes `~/.copilot/mcp-config.json`; `/mcp add`
     inside Copilot does the same. Claude Code's `.mcp.json` and Copilot's file take the same
     entry (Copilot adds `"type": "local"` and `"tools": ["*"]`, which it also accepts missing):

     ```json
     { "mcpServers": { "vimma": { "command": "vimma-ctl", "args": ["mcp"] } } }
     ```

   - **opencode** (1.19.0). `opencode mcp add` asks its questions interactively; or add this to
     `opencode.json` in your project (or `~/.config/opencode/opencode.json` for every project):

     ```json
     { "mcp": { "vimma": { "type": "local", "command": ["vimma-ctl", "mcp"], "enabled": true } } }
     ```

   For a profile other than your default one, the command is `vimma-ctl --profile DIR mcp`.
   `vimma-ctl mcp` takes no other option: it refuses `--timeout` and `--json`, since each call
   waits for your answer.

4. Ask the agent, for example "open https://example.com in Vimma's agent workspace and tell me
   its heading". Each call waits for your answer on the [question line](#answering-an-agent);
   the agent says it is waiting.

- **What the agent gets.** A read comes back as a line saying where the text is from and that it
  is untrusted, then the text between `<untrusted-web-content>` delimiters a page cannot close.
  A denial comes back as `The user denied this request in Vimma.`, and a question nobody
  answers within `[mcp] ask_timeout` (50 s) as `No answer in Vimma within 50 s; treated as
denied.` Codex CLI gives up on a tool call
  after 60 s by default (`tool_timeout_sec`): raise it if
  you raise `ask_timeout`.
- **When it cannot reach Vimma**, the call says what to do: `Vimma is not running…`,
  `MCP is off in Vimma: run :mcp on…`, or `This Vimma is too old for MCP…`. `initialize` and the
  tool list work without Vimma, so the tool shows the server as connected either way.
- **One connection per agent session.** It opens at the agent's first call and stays while the
  session runs; `◇ agent` in the status bar shows it. Grants belong to it: when the session ends
  (or Vimma restarts), they end, and the next session asks again.
- **Cancelling** a call in the agent (`Esc` in Claude Code) takes its question off the line.
- **An older `vimma-ctl`.** A `vimma-ctl` older than Vimma still works, with the tools it knows,
  since Vimma checks every request whichever client sends it. When the agent connects, Vimma
  says so once its first question is answered:
  `vimma-ctl 0.1.7 is older than Vimma 0.1.8: agents get fewer tools until you update it`.
  `vimma-ctl mcp` tells the agent too, in its instructions and at the top of its first answer,
  so neither of you takes a missing tool for one Vimma lacks. A `vimma-ctl` built before releases
  shipped it names no version, and the notice says `vimma-ctl is older than Vimma`. Point your
  tool at the `vimma-ctl` that came with Vimma (step 1) to end it.

#### When to use Playwright instead

Vimma's agent tools are for tasks an agent does for you in your own browser: shopping, filling in
forms, bookings, looking things up. For testing your own site, CI, headless or parallel runs,
scripting a page, intercepting network requests or uploading files, use Playwright or a similar
tool against a throwaway browser profile, never your daily one: a profile driven that way gives
the agent every login and cookie in it, with no question before it sends or pays.

#### Timeouts in agent tools

A call waits for your answer up to `[mcp] ask_timeout` (50 s by default, 10 to 300), and
`vimma-ctl mcp` itself gives up after 310 s. The agent tool has its own limit on a call:

| Tool        | Its limit on a tool call                                                                                                                                                                                                               | What to do                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `MCP_TOOL_TIMEOUT` (about 28 hours unless set), or a server's `timeout` in `.mcp.json` (milliseconds); a stdio server that sends nothing for 30 minutes is cut off. A call still running after two minutes moves to a background task. | Nothing: Vimma answers first.                                                                                                |
| Codex CLI   | `tool_timeout_sec`, 60 s by default.                                                                                                                                                                                                   | If you raise `ask_timeout` past about 55 s, set `tool_timeout_sec` under `[mcp_servers.vimma]` above it (for example `320`). |
| Copilot CLI | `copilot mcp add` takes `--timeout MS`.                                                                                                                                                                                                | If calls end before you can answer, add the server again with `--timeout` above `ask_timeout` (in milliseconds).             |
| opencode    | Its `timeout` setting (5000 ms) covers listing the tools, not tool calls.                                                                                                                                                              | Nothing.                                                                                                                     |

When the agent tool gives up first, Vimma's question may still be on the line; answering it then
does nothing the agent sees.

#### What Vimma protects, and what it does not

Vimma decides what an agent can do **through Vimma**. It does not decide what the agent does
with the rest of your computer.

**Through Vimma, an agent:**

- reaches only the agent workspace's tabs. It cannot list, read or close tabs of your other
  workspaces or private windows, and never sees their cookies or logins: the agent workspace's
  container has its own. A tab you share is reopened there, so the agent gets the page, not
  your session.
- cannot press keys in your window, read Vimma's state, or open a page anywhere else. It
  connects with the agent role only, and `vimma-ctl mcp` never asks for full control.
  `vimma_keys` runs a fixed set of Vimma's page keys in an agent tab
  ([Moving around a page](#moving-around-a-page)), never keys of the page itself.
- asks you for every request, in a line that pages cannot reach or draw on. Only `y`, or a count
  and `a`, allows; no answer within `ask_timeout` denies.
- gets page text and titles marked as untrusted web content, so the model is told that
  instructions inside them are not yours. This lowers the risk of prompt injection; it does not
  remove it.
- is held by limits: 4 waiting requests per agent and 16 in all, 10 opens a minute, 30
  `vimma_keys` calls, 30 `vimma_elements` calls, 30 clicks and fills, 12 screenshots, 30 console reads and 6 `vimma_show` calls a minute, and a minute of silence after three noes
  in a row. Its pages get no permission prompts, pop-ups or other
  apps, and its downloads ask and are kept apart
  ([Downloads from the agent workspace](#downloads-from-the-agent-workspace)).

**What Vimma does not protect:**

- **Grants are wide.** A grant lets that agent use every tool without asking until it ends:
  read, open, press keys, click, fill, take screenshots and download. Only sending a form,
  paying, showing you a page and a dangerous or unscanned download still ask
  ([What a grant covers](#what-a-grant-covers)). A grant given for a read therefore also means
  "let it fetch any address", and an address can carry what the agent has read elsewhere. Every
  call under a grant shows a notice and a row in `:mcp log`, so you can see where it went. A bare
  `a` lasts until the agent quits, which can be hours: give a grant for a task you are watching,
  a count (`15a`) when you want it to lapse by itself, and answer `y` one at a time otherwise.
- **The name is the agent's claim.** `claude-code` in the question is what the agent says it is.
  Grants belong to the connection, not the name, and `:mcp` shows the program that started it.
- **The rest of your computer is the agent tool's matter.** An agent with a shell or file tools
  runs as you. It can read your files, Vimma's profile included (cookies, saved passwords, and
  the control socket's token in `vimma-control.json`), unless its tool stops it. With the token
  and MCP on, it still reaches only the agent role, where every request asks. With full control
  on, the same token would give it your keyboard and every workspace; while MCP is on, each
  full-control connection asks you first, but the safe setting is off. Turn it on only for a
  while (`:control on 15`) when you script Vimma yourself.
- **Malware running as you** can do the same, with or without agents
  ([security model](security.md)).

#### Moving around a page

`vimma_keys` lets an agent scroll an agent tab, search it for a word, follow one of its links, go
back and forward in it, or go up a level of its address, without you switching to it. The question shows the keys as
they will run, `◇ claude-code wants vimma_keys: 2 "Pricing · Example" example.com/pricing  keys:
3j /"pricing"⏎`, and on `y` they run in that tab, in the background: your window keeps its
workspace, tab, focus, find bar and hint mode.

- **The keys it may press** are Vimma's own defaults, whatever your `config.toml` binds: `j`
  `k` `h` `l`, `d` `u` (`ctrl+d` `ctrl+u`, `ctrl+e` `ctrl+y`), `gg` `G`, `H` `L` (`ctrl+o`
  `ctrl+i`, `ctrl+[` `ctrl+]`), `gu` `gU`, `/word⏎` `?word⏎` and `n` `N`, with counts up to
  99, and `f`, at most 32 a call. A match becomes the page's selection, which a `vimma_read_page` then returns.
  `H` and `L` go back and forward only to web pages: an `about:` or `file:` entry the tab had
  before it was the agent's is refused.
- **Links by label.** `f` gives the agent the links on screen, up to 200, each with a hint label,
  its text and its address, marked as untrusted web content; a second call with `fsd` follows
  link `sd`. Labels use Vimma's default hint characters, whatever your `hint_chars`, and last
  two minutes on the page that listed them: after the page changes the agent has to send `f`
  again. The agent's `f` has hints of its own, so your hint mode in the same window is never
  cancelled by it, and only links are listed, never buttons or fields.
- **A follow loads the link's address, it does not click.** The page's own click handlers do
  not run, so a link cannot post a form or start a purchase through `vimma_keys`. Only http and
  https links are followed, only on web pages, and without a referrer. A link to another site (another registrable domain:
  `docs.example.com` is the same site as `example.com`, `example.org` is not) asks you again, as
  a `vimma_open` of its whole address, unless that agent holds a grant; a no stops the call
  there.
- **The keys it never presses:** `ctrl+b` and every binding after it, `:`, tab, workspace,
  window and split keys, `i` and every way into a text field, copy mode, `yy` and `p` (your
  clipboard), `gF` and `gf` (they open tabs), element focus (`F`), `r` (a reload can send a form
  again), and every key of the Browser, Developer tools, Bookmarks, Config, Add-ons, Help and
  Agents groups, `ctrl+b shift+a` included, so an agent never answers its own question. Such a
  call is refused before anything asks you.
- **Nothing reaches the page as a key press.** Each key runs as a Vimma action on the tab, so the
  page sees no keydown, and nothing is ever typed, clicked or submitted.
- **Not while you type there.** A request for the tab in front of you while you are in insert,
  copy or hint mode in it, with its find bar open, or halfway through a key sequence, is denied
  (`in-use`) without a question, and keys stop at the next step if you start using it while they
  run. Watching is fine: in normal mode you see the agent scroll.
- **A grant covers it:** under a grant each call shows
  `claude-code pressed 2j in "Pricing · Example" (grant, 12m left)`; a follow adds
  `claude-code followed a link to docs.example.com in "Pricing · Example"`. At most 30 calls a minute; a follow, `gu`, `gU`, `H` and `L`
  count towards the 10 opens a minute. A find does not run in the tab you are in, since the browser's find would
  put your focus in a text field it matched.
- **`:mcp log`** lists what agents did, asked or under a grant, each follow with the address it
  loaded, so you can check afterwards what a grant let through. It is kept in memory only and cleared by `:mcp off`.

#### Listing a page's buttons and fields

`vimma_elements` lets an agent see what it could act on in an agent tab: the buttons, fields,
links and other clickable elements on screen, each with a hint label. The question names the tab,
`◇ claude-code wants vimma_elements: 2 "Sign up · Example" example.com/signup`, and on `y` the
agent gets the list. Nothing on the page is touched, and your window keeps its workspace, tab,
focus and hint mode.

- **What it lists.** Each element's label, kind (link, button, field, checkbox, radio, select or
  other clickable element) and text; a link's address; a field's type, name, label and current
  value; a checkbox's state; a select's options; and the forms they belong to, with where each
  sends its data. Disabled controls are listed as disabled. Only what is on screen is listed, up
  to 200 elements, as your own hints would show; the agent scrolls with `vimma_keys` for more.
  Everything in it is marked as untrusted web content.
- **Passwords, card numbers and one-time codes are never listed with their value.** A password
  field (also one a "show password" button turned into a text field), a one-time-code field and
  a payment card field are listed as sensitive, with no value, so the agent can tell you what to
  type and where. Card fields are recognised by their `autocomplete` attribute and by the
  heuristics Firefox's form autofill uses, which also catch card forms without the attribute.
- **Labels by the same rules as `f`.** They last two minutes on the page that listed them, and a
  new list or `f` replaces them. `vimma_keys` with `f` and a label from the list follows a link,
  as a load of its address; the label of a button or a field is refused, and so is a link the
  page has replaced since it was listed.
- **A grant covers it:** each call then shows
  `claude-code listed the buttons and fields of "Sign up · Example" (grant, 12m left)`. The list
  holds no page text beyond the elements' own. At most 30 calls a minute; each is in `:mcp log`.

#### Clicking on a page

`vimma_activate` lets an agent click an element of an agent tab by its label from
`vimma_elements`: a button, a link to the same site, a checkbox, a radio button or another
clickable element. The question names the tab and the element,
`◇ claude-code wants vimma_activate: 2 "List · Example" example.com/list  sg button "Add to list"`,
and on `y` the element is clicked in the background: the tab is not selected and nothing in it is
focused. The agent gets the page after the click, whether a new page loaded, and any dialog the
page opened. When no page loaded, it is told which parts of the page changed in place within
about 2 seconds (the clicked element, other listed elements, the page's text, a dialog drawn by
the page), or that nothing did, so that a button that updates a basket in place is not pressed
twice. It gets no page text this way: it calls `vimma_elements` to see what changed. Only the
frame of the clicked element is compared, so a button inside an embedded frame that updates the
page around it reads as no change.

- **A plain click, no user activation.** The page gets the same click your `f` hints give it,
  never a mouse press from the system. It therefore cannot do what needs a real gesture of yours
  from that click: write or read the clipboard, use a passkey or a saved login, or ask for a
  permission.
- **What it does not click.** Text fields and selects (a click there would only move focus
  into the page), file fields (a click would open a file chooser), disabled elements, links to
  another site (the agent follows those with `vimma_keys`, which asks as an open of that site)
  and links that are not web pages. These are refused before you are asked.
- **A form submission asks every time**, also under a grant, with only `y` and `n`, naming where
  the form goes and what it sends
  ([Checkpoints: sending a form and paying](#checkpoints-sending-a-form-and-paying)):
  `▲ claude-code wants to send a form: 2 "Sign up · Example" → POST example.com/api/signup  email "ada@example.com", password •••, + 1 hidden`.
  A `y` sends that one form; it never makes or ends a grant.
- **A click that may pay asks every time** too: on a page that shows a payment card field, or
  on a button that says it pays (`Pay now`, `Place order`, `Vahvista tilaus` and the like),
  even when the button sends no form.
- **A form the page sends by itself after an agent's click is stopped**: the agent is told
  `the page tried to submit a form to example.com; Vimma stopped it`, and asks you properly by
  clicking the form's submit button. Your own submissions in an agent tab, and those of a page
  the agent has not touched, go through. A button whose script sends data without a form (with
  `fetch`) cannot be told apart from any other button by what it sends: under a grant the agent
  can press it unasked, with a notice and a row in `:mcp log`, unless its words or the page's
  card fields say it may pay.
- **Agents cannot answer dialogs.** An `alert`, `confirm` or `prompt` the page opens waits in the
  tab for you; the agent only learns its text, as untrusted content.
- **A grant covers clicks** (not submissions or payments): each shows
  `claude-code clicked button "Add to list" in "List · Example" (grant, 12m left)`. A click that
  loads a page counts as one of the 10 opens a minute, and no click is made while those are used
  up. At most 30 clicks a minute, none while you are typing in the tab, and each is in
  `:mcp log` with the element, a submission with its destination.

#### Filling in a form

`vimma_fill` lets an agent fill fields of an agent tab by their labels from `vimma_elements`:
text fields, text areas, selects (by an option's value or text), checkboxes and radio buttons.
The question names the tab and every field with its value,
`◇ claude-code wants vimma_fill: 2 "Sign up · Example" example.com/signup  sd Email = "ada@example.com"`,
and on `y` the fields are set in the background, in order, as Firefox's own form autofill sets
them: the page gets its `input` and `change` events, nothing in it is focused, and no key is
pressed. The agent learns how many fields were filled and which values the page put back (some
pages react to key presses only, which Vimma never sends).

- **Never your secrets.** Password fields (also one a "show password" button turned into text),
  fields the page draws as dots, one-time codes and payment card fields (by their autocomplete
  name, or because Firefox's form autofill recognises them as card fields) are never filled, and
  neither are file fields: the agent is told to ask you to type or choose those yourself. Hidden,
  disabled and read-only fields and rich text editors are not filled either. These are refused
  before you are asked. A field the page turns into a password or card field after you answered
  stops the fill there.
- **Sending the form asks every time.** With `submit`, the agent asks to fill the fields and
  then send their form, through one of its submit buttons or as its first submit button would;
  that question comes also under a grant, with only `y` and `n`, naming where the form goes, the
  fields it fills and what else the form sends:
  `▲ claude-code wants to send a form: 2 "Sign up · Example" → POST example.com/api/signup  after filling 1 field: sd Email = "ada@example.com"  also plan "pro", password •••, + 1 hidden`.
  When its submit button may pay, it asks as a payment.
  It must show every value whole, or the agent is told to fill first and submit apart. If the
  page puts back a value you were shown, the form is not sent. A form the page sends by itself
  during or after a fill is stopped, as after a click.
- **Nothing hidden in a value.** Values with characters that draw nothing (zero-width spaces,
  direction marks and the like) are refused, so the question shows all a value holds; values
  longer than the line are cut with `…`, and `:mcp log` keeps them whole.
- **A grant covers fills** (not submissions or payments): each shows
  `claude-code filled 2 fields in "Sign up · Example" (grant, 12m left)`, and `:mcp log` keeps
  every value. At most 32 fields a call, 30 clicks and fills a minute, none while you are typing
  in the tab.

#### Seeing a page

`vimma_screenshot` lets an agent see what an agent tab shows, to check the effect of a click or
a fill. The question names the tab,
`◇ claude-code wants vimma_screenshot: 2 "Sign up · Example" example.com/signup`, and on `y`
the agent gets an image of the tab's viewport (what you would see with the tab selected), at
most 1,280 pixels wide, taken in the background: the tab is not selected or shown, and your
window keeps its workspace, tab and mode. With `labels`, the labels of the agent's last
`vimma_elements` list of that page are drawn on it in your theme's hint colours, while the page
has not scrolled since.

- **Not while a secret shows.** While a password field or payment card field on screen, in the
  page or any of its frames, has a value, the screenshot is refused, because a card number shows
  in clear: the agent is told to scroll past it or to ask you. A card number the page copies into
  other text, or draws itself, is not recognised. A page with a frame Vimma cannot check (a
  data: or blob: frame) is refused too.
- **Untrusted, like page text.** The agent is told that text in the image is web content, not
  yours. Only the viewport of an http or https page is captured, never the browser around it,
  another tab, or a settings page or local file opened in the agent workspace.
- **A grant covers screenshots:** each shows
  `claude-code took a screenshot of "Sign up · Example" (grant, 12m left)`. At most 12 a minute.

#### Reading a page's errors

`vimma_console` lets an agent that builds or tests a web app see why a page in the agent
workspace fails. The question names the tab,
`◇ claude-code wants vimma_console: 2 "Sign up · Example" example.com/signup`, and on `y` the
agent gets, newest first:

- the page's script errors and warnings (uncaught exceptions, blocked content, security
  warnings), from the page and each of its frames;
- what the page itself reported with `console.error` and `console.warn` (never `console.log` or
  `console.info`, which are mostly noise);
- the tab's recent failed requests: an HTTP status of 400 or above, or a network error such as
  an unknown host, with the method, address and type of each.

Nothing runs in the page to get them: Vimma reads what Firefox already keeps, and logs failed
requests of agent tabs only while MCP is on, the last 100 per tab, in memory; a tab's log goes
when it closes, and every log goes with `:mcp off`. A console call's text arguments are passed on,
any other argument only as its type (`[object]`). The result gives Vimma's clock, which the agent
can pass back as `since` to see only what a later click or fill caused.

- **Untrusted, like page text.** Messages and addresses are the page's own: they may carry
  instructions, which the agent is told are not yours, or tokens the page put in a URL. Only an
  http or https page's are read.
- **A grant covers console reads:** each shows
  `claude-code read the errors of "Sign up · Example" (grant, 12m left)`. At most 30 a minute.

#### Showing you a page

`vimma_show` lets an agent show you one of its tabs when it wants you to look at a page. The
question names the tab and where it takes you, `◇ claude-code wants vimma_show: 2 "Pricing ·
Example" example.com/pricing (switches you to "agent")`, and on `y` your window switches to the agent workspace with that tab
selected, as `:ws agent` would. The notice says `showing claude-code's tab · ctrl+^ goes back`:
`ctrl+^` returns you to the workspace, tab and split you were in.

- **It asks every time.** No grant covers it, and its question offers only `y` and `n` (`x` is a
  plain no), so an agent cannot switch your view while you read or type something else. Like
  every question, it opens by itself only when you are not typing; otherwise it waits behind
  `◇ agent 1?` for `ctrl+b shift+a`.
- **Only the agent workspace.** It shows one of the agent's own tabs and nothing else, never
  another workspace or a private window.
- **It never raises or activates a window.** In the window that switches, the shown tab has the
  keyboard as after any tab switch. If the tab is in another Vimma window, that window switches
  behind the one you are in, and the notice says `shown in the other window`. When the window
  is in the agent workspace already, only the tab changes, and the notice has no `ctrl+^`: there
  is nowhere else to go back to.
- **At most 6 a minute** per agent; it is in `:mcp log` like every other call.

#### Keeping agents out of your Vimma profile

Vimma's profiles are in `~/.config/vimma/vimma/` (`~/.vimma/vimma/` on older installs;
`~/Library/Application Support/Vimma/` on macOS). Nothing
an agent needs is there: `vimma-ctl mcp` reads the one file it needs itself. Use your agent
tool's settings so its own tools cannot read the folder:

- **Claude Code.** Deny its file tools the folder, and turn on its sandbox for shell commands
  with the same folder denied, in `~/.claude/settings.json`. MCP servers run outside Claude
  Code's sandbox, so `vimma-ctl mcp` still reaches Vimma. On macOS, deny
  `~/Library/Application Support/Vimma` in both lists as well.

  ```json
  {
    "permissions": { "deny": ["Read(~/.config/vimma/**)", "Read(~/.vimma/**)"] },
    "sandbox": {
      "enabled": true,
      "filesystem": { "denyRead": ["~/.config/vimma", "~/.vimma"] }
    }
  }
  ```

- **Codex CLI, Copilot CLI and opencode.** Their documented sandboxes and approval settings
  limit writes, network use and which commands run without asking, not which folders a command
  may read. Keep shell commands on approval (do not let them run unasked), and read the commands
  you approve. Running the agent tool as another user, or in a container without your
  home folder, keeps the profile out of reach entirely; `vimma-ctl mcp` then needs the
  `vimma-control.json` file and the socket's port, so this suits only a setup you build for it.

Claude Code's per-tool permission prompt (and the other tools' approval prompts) may also ask
before an MCP call. That prompt is the agent tool's; Vimma asks either way, and does not count
on it.

#### Ending an agent's access

- `ctrl+b shift+a` with nothing waiting, or `:mcp revoke`: ends every grant now, without a
  second question. The agents stay connected, and their next requests ask.
- `x` on a question: denies everything that agent asked and ignores it until it reconnects.
- `:mcp off`: disconnects every agent and ends their grants; `vimma-ctl mcp` then answers each
  call with `MCP is off in Vimma`.
- `:mcp forget`: deletes the agent workspace's cookies and site data, so any login an agent used
  there is gone. `ctrl+b shift+d` in the workspace closes its tabs.
- Removing the server from your tool (`claude mcp remove vimma`, `codex mcp remove vimma`,
  `copilot mcp remove vimma`, or deleting the entry from `opencode.json`) stops it from starting.

#### Answering an agent

Each request an agent makes appears as one line at the foot of the window, above the status bar:

```
◇ claude-code wants vimma_read_page: 2 "Pull requests · vimma-browser/vimma" github.com/vimma-browser/vimma/pulls   y once · a until it quits · n deny · x mute
```

It names the agent (as the agent calls itself), the tool, and what it touches: the tab's place,
title and address for a read, a close, keys or a show (then the keys as they will run, or the
workspace a show switches you to), the whole address for an open (its host in bold), the number
of agent tabs for the tab list.

| Key                   | Answer                                                                           |
| --------------------- | -------------------------------------------------------------------------------- |
| `y`                   | Allow this request once.                                                         |
| `a`                   | Allow this agent every tool until it quits.                                      |
| a count, then `a`     | Allow this agent every tool for that many minutes only (`15a`).                  |
| `n`, `Esc` or `Enter` | Deny it.                                                                         |
| `x`                   | Deny it and everything else this agent asked, and ignore it until it reconnects. |
| `Backspace`           | Take back a digit of the count.                                                  |

- **Nothing else answers.** Any other key does nothing and the line stays; a key held down from
  before never counts; and for its first second the line takes no key at all (the hint appears
  when it is ready), so a key meant for something else cannot answer it. The second starts
  again whenever the window comes to the front or goes to the back, and with every key you
  press before it is over. A prompt, picker or the command line you open over the line gets
  your keys; the question waits and comes back when it closes. Link hints, copy mode and
  element mode keep their keys the same way (a hint label, `y` to copy): the line waits until
  `Esc` leaves them, also after `ctrl+b shift+a`.
- **It never interrupts your typing.** It opens by itself only when the window is in front,
  focus is not in a text field, you have not pressed a key for 1.5 s, no other prompt,
  picker or panel is open, and you are not in link hints, copy mode or element mode. Otherwise it waits, and the status bar says `◇ agent 1?`; press
  `ctrl+b shift+a` to answer it then. It never takes focus: answer, and you carry on where you
  were. If you click into a text field while it shows, it goes back to waiting.
- **One at a time**, oldest first. An agent may have 4 waiting, and all agents 16. With no
  answer within 50 s (`[mcp] ask_timeout`) the request is denied (`agent request timed out
(denied)`). Three noes in a row from one agent ignore it for a minute.
- **Not in front?** When Vimma's window is not the one you are using, it is marked urgent (on
  Hyprland, the workspace is highlighted) and a desktop notification says, for example,
  `claude-code asks to use Vimma's agent workspace (read a page)`. It carries no address or
  title and no buttons: you answer in Vimma. `[mcp] notify = false` turns the notification off.
- **Grants show.** `◇ agent granted` while an agent may act without asking (`◇ agent 14m` counts
  down a grant of minutes), and each request a grant lets through shows a notice
  (`claude-code read "Pull requests · vimma-browser/vimma" (grant)`). `ctrl+b shift+a` with
  nothing waiting, or `:mcp revoke`, ends them all at once. A grant also ends when the agent
  quits or `:mcp off` runs, and is never written to disk.

#### What a grant covers

One grant covers a task. Answer any request with `a`, and that agent may use every tool until
it quits, without asking: read pages, list tabs, open and close tabs, press keys and follow
links, list a page's buttons and fields, click, fill, take screenshots, read a page's errors and
download. The notice says so:
`claude-code may use the agent workspace until it quits; sending a form or paying still asks (ctrl+b shift+a ends it)`.
Answer `15a` instead to allow it for 15 minutes only; `[mcp] grant_minutes` makes a bare `a` a
grant of that many minutes.
The question's hint leaves that out, so the line stays short; the notice says it the moment you
answer. Requests that wait when you answer run at once.

These still ask under any grant, and your yes allows that one step without making a grant or
ending the one in force:

- **Sending a form and paying**
  ([Checkpoints: sending a form and paying](#checkpoints-sending-a-form-and-paying)): a form
  sends data to a server, where sign-ups, messages and purchases happen, and a payment spends
  your money.
- **Showing you a page** ([Showing you a page](#showing-you-a-page)): it changes what you see.
- **A dangerous or unscanned download**, and a download a page started by itself
  ([Downloads from the agent workspace](#downloads-from-the-agent-workspace)).

A grant belongs to one agent session, the one `vimma-ctl mcp` process your agent tool started:
another agent asks again. If that agent's connection drops (a suspended laptop, Vimma closing an
idle link) and it reconnects within two minutes, it keeps its grant; later, it asks again.

#### Checkpoints: sending a form and paying

Under a grant an agent works through its task without asking, except at two checkpoints: before
it sends a form and before it pays. A checkpoint is one question that shows what the step will
do, answered with one key, after which the agent goes on under the grant it had:

```
▲ claude-code wants to pay: "Vahvista tilaus" on shop.example · the page says "Yhteensä 42,90 €"   y pay · n stop
▲ claude-code wants to send a form: 2 "Sign up · Example" → POST example.com/api/signup  email "ada@example.com", name "Ada", password •••, + 2 hidden   y send it · n stop
```

- **It stands out.** A checkpoint starts with `▲` instead of `◇`, and its `▲` and verb are in
  your theme's warning colour, so it is not taken for a routine question.
- **One key.** `y` runs that one step. `n`, `Esc`, `Enter` or `x` stops it: the agent is told
  no for that step and may go on with others under its grant (`ctrl+b shift+a` ends the grant).
  No count or grant is offered, and neither answer makes, lengthens or ends a grant. Three noes
  in a row ignore the agent for a minute, as for any question.
- **What a payment shows.** The button's text (for a key, such as `H` on a checkout page, the
  keys), the site in bold, and the total the page states, quoted after "the page says". A button
  inside a payment provider's frame of another site names that frame's site, which takes the
  money, then the shop's: `on pay.provider.example (in shop.example)`. The
  amount is the page's own claim: your bank or card statement is what counts. When the page
  states no total, none is shown.
- **What a form shows.** Where it goes, then each field it sends with its value, cut to fit the
  line (`… (3 more)`); a password, payment card or one-time-code field by its name and `•••`,
  never its value; hidden fields (such as anti-forgery tokens) counted, `+ 2 hidden`. A fill
  that sends a form shows the fields it fills, then `also` and the rest. These are the form's
  own fields: a page's script can still add data to the request as it is sent.
- **What counts as paying.** A click, a fill that sends a form, or a key that loads a page (a
  followed link, `gu`, `gU`, `H`, `L`) when the page shows a payment card field, also inside a
  payment provider's frame, or when the button or link says it pays: `pay`, `buy`,
  `place order`, `confirm order`, `complete purchase` and their Finnish, Swedish, German, French
  and Spanish counterparts (`maksa`, `osta`, `tilaa`, `vahvista tilaus`, `betala`, `köp`,
  `jetzt kaufen`, `zahlungspflichtig bestellen`, `payer`, `commander`, `pagar`, `comprar`, …),
  as whole words. A button such as `Buy now` that only leads to a checkout asks too; that costs
  one key. Adding to a basket (`Add to basket`, `Lisää ostoskoriin`) does not ask.
- **What is not recognised.** A page that hides its checkout: no card field on screen and a
  button worded otherwise (`Continue`, an icon with no name). A load of another site is not
  stopped, so a payment provider's or bank's own page, reached through such a button, stops the
  agent only at that page's card fields or pay button. Keep grants short on sites where you
  have a saved card, and read `:mcp log` after a task.
- **Afterwards.** A yes shows `allowed payment on shop.example` or
  `allowed sending the form to example.com` as you answer, before the step runs, a no
  `stopped claude-code's payment on shop.example`, and `:mcp log` marks the row
  `allowed (checkpoint)` or `denied (checkpoint)`. When Vimma is not in front, the desktop
  notification says only `claude-code asks to pay` or `claude-code asks to send a form`, never
  the site or the amount.

#### Full control while agents are on

An agent with a shell can read the control socket's token like any program of yours. So while
agents are on (`:mcp on`), each new `vimma-ctl` connection with full control (keys in your
window, every workspace) asks in the same line:
`◇ vimma-ctl with code 7F3K wants full control (every workspace, not only "agent") — y/N`. `y` lets
that one connection in, `n`, `Esc`, `Enter`, `x` or any other key refuses it, and nothing is
remembered: the next one asks again. The line shows the code `vimma-ctl` printed in your terminal
(`vimma-ctl with code 7F3K wants full control`): answer `y` only if it is the same, since
another program could have asked at the same moment. `vimma-ctl` waits for your answer and says so; if refused, it
prints `full control refused` and exits 4. With agents off, nothing asks.

`:control on 15` turns full control (the pref `vimma.control.enabled`) on for 15 minutes after a
`y/N`, and then off again, even across a restart; `:control off` turns it off now, and `:control`
says whether it is on and how long is left. Turning it on in `about:config` sets no end time.
While agents are on, its question says what a yes gives away: `Turn on full control for 15 min?
It reaches every workspace and tab, not only "agent", and any local AI agent with a shell can use
it. y/N`. Agents do not need full control, and `vimma-ctl mcp` tells them never to ask for it;
an agent that asks you to turn it on, or to run `vimma-ctl send-keys`, is asking for keys in
every workspace.

#### What pages in the agent workspace may do

Pages there run with nobody watching, so they get less than yours:

- **No permission prompts.** A request for your location, notifications, camera, microphone,
  screen, MIDI, persistent storage, the local network and the rest is refused without a prompt.
- **No pop-ups.** `window.open` and links that open a new window or tab do nothing there.
- **No other apps.** A link to `mailto:`, `zoommtg:` or another app's protocol opens nothing.
- **Downloads ask, and are kept apart.** See [Downloads from the agent workspace](#downloads-from-the-agent-workspace).
- If you change `[mcp] workspace`, the new agent workspace's open tabs are reloaded once, so
  these rules apply to the pages already in them.

#### Downloads from the agent workspace

An agent (or a page in the agent workspace) may download files, but each one asks first, in the
same line as every other request:

`◇ claude-code wants vimma_download: "report.pdf" 2.1 MB application/pdf (.pdf) from example.com`

It shows the file's name, its size (or `unknown size`), its type and extension and the site it
comes from, never the full address. `y`, `n`, `x` and a count with `a` work as for any request;
a grant lets that agent's next downloads through without asking. A download
counts as the agent's only when it is the address the agent itself opened (`vimma_open`), right
then. Anything else, such as a page the agent opened downloading something later, says `a page
in the agent workspace wants vimma_download` and takes only `y` or `n`, whatever grants you
gave.

- **Kept apart.** Files are saved only to `~/Downloads/vimma-agent/` (`[mcp] download_dir`),
  never to your Downloads folder, with mode 0600: no one else can read them and nothing can run
  them. Until a file has passed every check it keeps a `.part` name there. The folder itself is
  kept private (mode 0700). It may not be your home folder, your Downloads folder, a hidden folder
  of your home (such as `~/.local/bin`), or `/tmp`, `/var/tmp` or `/dev/shm`. If the folder is not
  yours or cannot be made private, every agent download is refused, with a notice that says
  why.
- **Never opened.** Vimma never opens an agent's download, offers no "open with", and refuses
  to open one from the downloads list later (`agent downloads are never opened by Vimma`). Open
  it yourself from the folder once you trust it.
- **Dangerous files ask with `!`.** Programs and libraries (ELF, Windows and macOS programs,
  also found by their first bytes), scripts (`.sh`, `.py`, `.js`, `.desktop`, a `#!` line …),
  installers and packages (`.deb`, `.rpm`, `.AppImage`, `.flatpak`, `.msi`, `.dmg` …), and
  archives Vimma cannot look inside (`.tar.gz`, `.7z`, `.rar` …) end the question with `— ⚠ a
script` (or what it is). `y` and grants do nothing there: only `!` allows that one file. A
  `.zip` is checked by the entries it lists (it is never unpacked). If one is a dangerous file,
  has an exec bit, is a symbolic link, or would unpack outside its folder (`../`, `/…`), the zip
  asks with `!`. Some dangers show only once the file is in: an ELF named `data.bin`, or a
  program inside what was allowed as a script. Then a second question asks before the file gets
  its name, and `n` deletes it.
- **https only.** A download over plain `http:`, or one a page's script made (`blob:`, `data:`),
  is refused (`refused download "a.txt": not https`).
- **A size cap.** Over `[mcp] download_max_mb` (200 MB by default, 1 to 4096) it is refused, or
  stopped and deleted once it grows past it when the server did not say its size.
- **ClamAV, if you have it** ([below](#virus-scanning-with-clamav)). Each file is scanned
  before it leaves its `.part` name, and a file ClamAV flags is deleted (`deleted download
"a.zip": ClamAV found …`). Sometimes ClamAV fails, takes over five minutes, or cannot look
  inside a file (encrypted, or over its limits). Then the line asks `— ⚠ not scanned: ClamAV
failed; keep it?`: `y` keeps it unscanned, anything else deletes it. The notice says
  `saved "report.pdf" to ~/Downloads/vimma-agent, scanned (ClamAV)`, `not fully scanned (ClamAV)`,
  `scanned with outdated definitions (ClamAV)` or `not scanned`. Vimma has no download reputation service of its own: Firefox's Safe Browsing
  checks downloads only in a build with a Google key.
- **Your own saves are yours.** Save Page (`ctrl+s`), Save Link As and Save Image As in an agent
  tab ask nothing and save where you choose, as in any workspace: an agent cannot press them.

```toml
[mcp]
download_dir = "~/Downloads/vimma-agent"  # ~/… or /…; never ~ or your Downloads folder itself
download_max_mb = 200
clamav_max_age_days = 7   # 1 to 90
```

#### Virus scanning with ClamAV

ClamAV is optional, and Vimma does not ship it. If the system's `clamscan` is installed, Vimma
uses it on every agent download. That means `/usr/bin/clamscan` or `/usr/local/bin/clamscan`,
owned by root, never a copy found on your `PATH`. Without it, the notices say `not scanned`.
Vimma does not update ClamAV or its virus definitions: your system's `freshclam` does.

On Omarchy and Arch Linux:

```sh
sudo pacman -S clamav
sudo freshclam                                   # the first download of the definitions
sudo systemctl enable --now clamav-freshclam     # keeps them up to date
```

On Debian and Ubuntu, install `clamav`; the `clamav-freshclam` service keeps the definitions
current. On Fedora, install `clamav clamav-update` and run `sudo freshclam`.

Vimma checks how old the definitions are. When they are older than
`[mcp] clamav_max_age_days` (7 days by default), a clean scan is not called clean: the line asks
`— ⚠ not scanned: ClamAV's definitions are 30 days old (over [mcp] clamav_max_age_days, 7);
keep it?`, and `y` keeps it with the notice `scanned with outdated definitions (ClamAV)`. If your
mirror updates slowly, raise the key (up to 90). A file ClamAV flags is deleted however old the
definitions are.

`clamscan` loads its whole database for each file, so a scan takes a while and about 1 GB of
memory. If the clamd daemon runs (`sudo systemctl enable --now clamav-daemon` on Debian and
Ubuntu, `clamav-daemon` or `clamd` on others), Vimma asks it through `clamdscan` instead, which
is fast. It does so only when `/etc/clamav/clamd.conf` is root's, clamd listens on a local socket
(`LocalSocket`, no `TCPSocket`) owned by root or `clamav`, and the config has
`AlertEncrypted yes` and `AlertExceedsMax yes`, so clamd reports what it cannot look inside.
Otherwise, or if clamd fails or its definitions are old, Vimma uses `clamscan`.

On macOS the same rules apply. Vimma looks for `clamscan` and `clamdscan` only in `/usr/bin`
and `/usr/local/bin`, owned by root, and for the config only at `/etc/clamav/clamd.conf`.
macOS's own ClamAV account is listed as `_clamav`, not `clamav`, in `/etc/passwd`, so the socket
must be root's. The common installs are
not used: Homebrew (`/opt/homebrew`), MacPorts (`/opt/local`) and the official installer
(`/usr/local/clamav`) put ClamAV elsewhere. So on macOS, ClamAV, and clamd especially, is
usually not used.

### Side panel

`ctrl+b b` or `:sidebar` opens a panel on the left of the window. It is closed when Vimma
starts and stays out of your way until you ask for it. Its head shows the workspace you are
in (`● 2:work`, in the workspace's colour) and the ones `ctrl+b (` and `ctrl+b )` go to; below are
the workspace's tabs, numbered, each with its name (or title) and its site. The tab you are on is
highlighted and its number coloured; a tab playing sound shows `♪`, one from another container
`foreign`.

| Key                     | What it does                                                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `j` / `k`               | Move the highlight down / up.                                                                                                                                                                              |
| `Enter`                 | Go to the highlighted tab and close the panel. With marks, show the marked tabs together ([below](#showing-tabs-together)); with a split, apply your changes to it ([below](#changing-or-ending-a-split)). |
| `1` … `9`               | Go to that row's tab and close the panel.                                                                                                                                                                  |
| `space`                 | Mark the highlighted tab (or unmark it). The highlight stays on it.                                                                                                                                        |
| `V`                     | Start a range: `j` / `k` stretch it, and `V` or `space` marks every row in it.                                                                                                                             |
| `x`                     | Close the highlighted tab; the highlight moves to the next row and the panel stays open, so `x x x` closes three.                                                                                          |
| `m`                     | Move the highlighted tab to another workspace: the workspace picker opens, `Enter` (or `m`) on a workspace asks first, then moves it ([below](#moving-a-tab-from-the-side-panel)).                         |
| `ctrl+shift+t`          | Reopen the last closed tab, as in Firefox.                                                                                                                                                                 |
| `ctrl+b )` / `ctrl+b (` | Switch workspace; the panel stays open and lists that one (its marks are dropped).                                                                                                                         |
| `I`                     | Close the panel and focus the address bar.                                                                                                                                                                 |
| `Esc`                   | End a range; else clear the marks (with a split: put its marks back); else close the panel, and the page has the keys again.                                                                               |
| `ctrl+b b`              | Close the panel.                                                                                                                                                                                           |

Pinned tabs belong to no workspace, so the panel never lists them and `x` never closes one (a
row whose tab was pinned after the panel was drawn says "pinned tab: unpin it to close it"). The panel takes no
count: digits pick rows, so `3x` goes to row 3's tab and closes the panel, and that `x` is then
normal mode's, which closes the tab. In the bookmarks panel `x` does nothing;
`d` deletes a bookmark there.

While it is open, every other plain key is the panel's and never reaches the page; `ctrl+b`
keys and `:` commands still work, and a tab you open meanwhile shows up in the list. The panel
follows the theme as the status bar does, scrollbar included (the theme's muted
colour on the panel's background), and recolours the moment the theme changes. Change its keys under `[modal.panel]` in
`config.toml`; `[keys] toggle_sidebar` changes the keys that open it, and a `<leader>` binding
you add there (`toggle_sidebar = ["prefix+b", "<leader>n"]`) closes it too.

#### Moving a tab from the side panel

`m` moves the highlighted tab, which need not be the one you are on: a tab in the background,
even one not loaded since a restart, moves without being selected first. The panel closes and the
workspace picker opens with the tab's title in its heading (`Move "Docs" to`); `j` / `k` or `/`
choose a workspace and `Enter` or `m` picks it, then the same `Move this tab to "work"? … y/N`
question as the picker's own `m` asks, because the tab is reopened there without its
back/forward history. `Esc` in the picker moves nothing. You stay in the workspace you are in, on
the tab you were on. If the tab closes before your `y`, nothing is moved; on its own workspace,
`m` says so and asks nothing. In the bookmarks panel `m` moves a bookmark to a folder instead.

#### Showing tabs together

Mark the tabs you want side by side, then press `Enter`: they become the panes of this
workspace, replacing its split, and the panel closes. Say you want your editor, the docs and a
preview at once: `ctrl+b b`, `space` on each of the three (`j` / `k` between them), `Enter`.

- **Marking.** `space` marks the highlighted row and leaves the highlight on it; `space` on a
  marked row unmarks it. Move to the next row you want with `j` or `k`, above or below. `V` starts a range as in Vim's line-wise visual mode; `j` / `k` stretch
  it, and `V` or `space` marks the rows in it (`Enter` marks them and goes on). A marked row has
  a `●` before its number and a green bar on its edge; a row in an open range shows `│`. Below
  the head the panel says `3 marked` (or `range: 2 · 3 marked`).
- **Order and focus.** The panes take the panel's order (the tab order), whatever order you
  marked them in. The highlighted row has focus if it is marked, otherwise the first marked one.
  Firefox keeps a split's tabs next to each other in the tab order, so after a split the rows
  you used may sit together.
- **Layout.** The panes are arranged with this workspace's layout: the preset you last picked
  with `ctrl+b space` or `:layout` when its split has one, otherwise `[panes] layout`: with
  `"dwindle"` (the default) two tabs sit side by side, three make `a | b / c`, four the spiral;
  with `"manual"` they sit in a row. A main-* preset makes the focused tab the big pane.
- **What changes.** Tabs that were in the old split and are not marked leave it and stay open as
  ordinary tabs. No page reloads: each keeps its scroll, what you typed and its history.
- **Limits.** Without a split, one mark is just `Enter` on that row. With more marks than
  `[panes] max` (4 by default), the panel says `Show together: at most 4 panes` and changes nothing; the panel stays open with your
  marks so you can drop some. A pinned row cannot be marked.
- **Keys.** Rebind them under `[modal.panel]` with the actions `panel_mark` and
  `panel_visual`, e.g. `m = "panel_mark"`. If you give the leader (`space`) a binding, `space`
  in the panel waits `timeout_ms` for the rest of it before it marks.

#### Changing or ending a split

When the workspace has a split, the panel opens with its panes' tabs already marked, so you see
which tabs they are, and the head says `split: 3 panes`. Change the marks as above and press
`Enter`:

- **Unmark a pane** (`space` on its row) and it leaves the split: the tab stays open, as an
  ordinary tab right after the split in the tab order. Its row shows a dim `○` until you press
  `Enter`, and the head says `split: 3 → 2`. The other panes keep their places and sizes, as
  after `ctrl+b x`.
- **Unmark down to one** (`split: 3 → 1 (unsplit)`) and the split ends: that tab is shown alone
  (or, with the highlight on a pane you just unmarked, that one). Unmark every pane and the split
  ends too, showing the highlighted tab.
- **Mark another tab** and it joins as a pane; the panes are then arranged afresh in the
  workspace's layout, as in [Showing tabs together](#showing-tabs-together). You can unmark one
  and mark another in one go. `[panes] max` still applies.
- **Then `Enter` goes to the highlighted row.** If its tab is in the split, the split shows with
  that pane focused. If it is the pane you just unmarked, that tab shows alone and the rest stay
  a hidden split: three panes, `space` on C, `k` back to C, `Enter`, and C fills the window
  while A and B wait. On any other row the split shows, focused on the pane you were in if you
  kept it, else the first marked one.
- **Nothing changed?** `Enter` just goes to the highlighted tab: a pane's tab shows the split
  focused there; any other tab shows alone and the split waits hidden
  ([Picking a tab during a split](#picking-a-tab-during-a-split)). One `Esc` closes the panel.
  After a change, the first `Esc` puts the split's marks back and the second closes.
- **A hidden split** is listed the same way, its tabs marked, and the head says
  `split: 2 panes (hidden)`.

`ctrl+b )` / `ctrl+b (` with the panel open list the other workspace with its own split marked.
No page reloads.

### Routing: which workspace a link opens in

`[[routes]]` rules in `config.toml` send a site, or every link an app opens, to a workspace
(and its container), as Zen's Space Routing does. Each rule names a `workspace` and what it
matches; the first rule that matches, top to bottom, wins.

```toml
schema = 2

[[routes]]
domain = "github.com"         # github.com and its subdomains (gist.github.com), any port
workspace = "work"

[[routes]]
domain = "*.corp.example"     # only subdomains: jira.corp.example, not corp.example
workspace = "work"

[[routes]]
app = "slack"                 # every link Slack opens
workspace = "work"

[[routes]]
app = "discord"
domain = "youtube.com"        # both must match: YouTube links from Discord
workspace = "personal"

[[routes]]
url = "file:///home/me/notes/"  # a URL prefix: the way to route file:, about: and the like
workspace = "notes"
```

- **`domain`** matches `http` and `https` pages only, on whole labels (`github.com` is not
  `notgithub.com`), whatever the port; Unicode names work written either way
  (`bücher.example` or `xn--bcher-kva.example`), and an IP address matches only itself.
- **`app`** is the name of the program that opened the link, as `vimma-open` sees it (below).
- **Order is the precedence.** Put the rule that matters most first: with `app = "slack"` above
  `domain = "youtube.com"`, a YouTube link from Slack goes to `work`.
- A rule naming a workspace that does not exist is skipped (`:route` says so).

**Where rules apply:** an address you type in the address bar or with `:open` / `:tabnew`, a
bookmark, a link from another app and a new window opened on a URL: what you or Vimma open. A
link a page opens (a click, middle-click, `gF` hints, `target=_blank`, a pop-up) stays in that
page's workspace, because a page could otherwise open any site with another workspace's logins;
when you look at such a tab, the status bar names the workspace its rule would choose and
`:route move` moves it. Opened in front, the tab takes you to its
workspace; opened in the background, it waits there and the status bar says
`opened in "work"`. If you typed the address on an empty new tab, that tab is closed.

**Where they do not:** a page that navigates in its own tab (a click, a redirect, a sign-in
bounce) is never moved, because moving reopens the page and would break the load. The status bar
says `github.com goes to "work" (route 1): :route move` instead; `:route move` moves the tab
there (it loses its back/forward history, as any move does). A container you chose yourself
("Open Link in New Container Tab") is kept. Private windows are never routed.

**By application.** Vimma's packages install `vimma-open` and make it the desktop entry's
command, so when Slack, Discord, a terminal or Neovim opens a link, `vimma-open` looks up which
program asked (through `/proc`, skipping `xdg-open`, `gio` and shells) and tells Vimma. A link
you open from a shell counts as the terminal's. Apps in Flatpak (they go through the desktop
portal), apps started through systemd (`uwsm app`) and links opened while the asking program
has already exited have no app: only `domain` and `url` rules apply to them. To see what an app
is called, run `vimma-open https://example.com` from it, or look at its process name
(`ps -o comm`), lower-cased.

**Commands.**

| Command                         | What it does                                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `:route`                        | Opens `about:vimma`'s Routing section: every rule in force, and which one matches the tab you were on.                     |
| `:route add`, `:route add work` | Adds a `domain` rule for this site (its host without `www.`) to the end of `config.toml`, for this or the named workspace. |
| `:route move`                   | Moves this tab to the workspace its rule names.                                                                            |

`:route add` refuses a site an earlier rule already routes (it names the rule), a `config.toml`
that has errors, and a file without `schema = 2`. It only ever appends to the file.

### Private workspace

The private workspace is a Firefox private window that Vimma treats as a workspace. Everything
a private window promises, it keeps, because it is one: nothing you do there stays on disk.
History, cookies and site storage, the cache, form history, the downloads list and session
restore all forget it, and so do Vimma's own files.

| Keys                             | Command          | What it does                                                               |
| -------------------------------- | ---------------- | -------------------------------------------------------------------------- |
| `ctrl+b shift+p`, `ctrl+shift+p` | `:private`       | Go to the private workspace, opening it if it is not open; in it, go back. |
| `ctrl+b shift+d` (in it)         | `:private close` | Close it after `y/N`; its history, cookies and site data are discarded.    |
| `ctrl+^`, `ctrl+b ^` (in it)     |                  | Back to the workspace you came from, in the window you came from.          |
| `ctrl+b )` / `ctrl+b (` (in it)  |                  | Leave it for your first / last workspace.                                  |
| `ctrl+b w`                       | `:workspaces`    | The picker; the private workspace is its last row.                         |

- **Its own key only.** The private workspace is never a stop on `ctrl+b (` / `ctrl+b )`,
  `]w` / `[w`, `:wn` / `:wp`, nor the `ctrl+^` of a normal window, so cycling never drops you
  into it by accident. From inside it, those keys take you out.
- **In it**, the status bar says `◆ private` (in the theme's magenta), and `ctrl+b b` lists its
  tabs under a `◆ private` head. Splits, hints, find, copy mode, marks in the side panel and the
  command line work as in any workspace; the command line's history there is its own and is
  never written.
- **There is one private workspace.** Every private window is part of it: `ctrl+n` in it, or
  Firefox's "Open Link in New Private Window", makes another, and the key takes you to the most
  recent one. They share one cookie jar, as Firefox's private windows do.
- **Closing it** (`ctrl+b shift+d` or `:wd` in it, or `:private close` anywhere) asks
  `Close the private workspace (5 tabs)? Its history, cookies and site data are discarded. y/N`,
  then closes every private window, pop-ups included (an open sign-in pop-up would otherwise
  keep the data alive), and Firefox discards their data. The windows close as a script closes
  them: your `y` was the question, so Firefox's own warnings do not follow, and a private
  download still in progress is cancelled. Closing a private window with your window manager
  or `ctrl+shift+w` asks nothing; the data goes once the last private window has closed.
- **Add-ons** run there only if you allowed them in private windows (`ctrl+b e`, then `P`).
  Searches use Firefox's private search engine if you set one. Vimma's own keys and pages need
  no add-on.
- **Links from other apps** open in your normal window, as Firefox does, so you leave the
  private workspace to see them (on Hyprland and macOS the normal window swaps back into place;
  the private workspace stays one key away). Routing rules never send a page into or out of it.
- **Scripts:** `vimma-ctl state` in the private workspace says `"private": true` and
  `"workspace": "private"`, and gives every tab's `url` and `title` as `null`; each tab's
  `loading` still says whether its page has finished loading. `vimma-ctl open`
  and `send-keys` act on the focused window, so with the private workspace focused they load
  into it and type there.
- **Diagnostics:** `about:vimma` and `:bug` in a normal window leave private windows out, and
  keys typed in a private window are never added to their key log.
- **What a private window does not hide:** the clipboard (copy mode's `y` copies to the system
  clipboard, as in Firefox). Its window title, which your window manager, its bar and screen
  sharing see, is only `Vimma Private Browsing`, never the page's title (see
  [Privacy defaults](#privacy-defaults)).
- **Permanent private browsing** (`browser.privatebrowsing.autostart`) makes every window
  private, so there is no private workspace: the key and `:private close` say
  `every window is private (permanent private browsing)` and do nothing, and private windows
  behave as in Firefox (no workspaces, no `◆ private`). A policy
  that turns private browsing off makes it say `private browsing is turned off by policy`.

**On Hyprland it takes your Vimma window's place.** Firefox keeps privacy per window, so the
private workspace is a window of its own, but you never see the two side by side: going to it
puts the private window exactly where your Vimma window was (same workspace, same tile, same
size, fullscreen or floating if it was), and the other tiles keep their sizes. Your normal window
waits in a hidden special workspace, `special:vimma`, and comes back in the same place when you
switch back (any of the keys above), when the private window closes (`ctrl+b shift+d`,
`ctrl+shift+w`, `SUPER+W`), or when a link from another app arrives. If Vimma quits or crashes
meanwhile, the next start shows your normal window as usual: nothing about the swap is written
to disk.

- **How:** Vimma talks to Hyprland over Hyprland's own socket (`$XDG_RUNTIME_DIR/hypr/…`), from
  the browser process only, with a fixed set of commands: move, swap, focus, fullscreen state,
  float or tile, exact size and position. They carry only window addresses, workspace numbers
  and sizes, never a page title or URL, and Vimma runs no `hyprctl` and no other program. To
  learn which window is which, a new Vimma window carries a random title (`vimma-` and 32 hex
  digits) for a moment when it opens. Checked with Hyprland 0.56.2 and a Lua config, as
  Omarchy has; older configs use the legacy command names, which Vimma also speaks.
- **Grouped or pinned:** a grouped (`SUPER+G`) or pinned Vimma window is not swapped. The private
  workspace opens beside it in the group, as a group tab, and switching moves the focus.
- **If Hyprland refuses a swap**, Vimma shows your normal window, says
  `private: the window manager refused the swap; showing it as a window`, and opens the private
  workspace as a window of its own until the config is next reloaded. `about:vimma` shows the
  Hyprland version and which placement is in force, or why it is not swapping.
- **On a busy machine** Hyprland can take a moment to see a new window's random title. While
  Vimma waits for it, up to 2 seconds, the fresh private window shows beside your Vimma window
  as a tile titled `vimma-` and 32 hex digits, then takes your window's place.
- **If Hyprland never names a Vimma window** (its random title does not show up within 2
  seconds), that switch shows the private workspace as a window of its own, the Browser
  Console says

  `private: Hyprland did not name the Vimma window; showing it as a window` once, and
  `about:vimma` adds `(last switch: window not named)`. The next switch tries again, waiting
  only half a second so that switches are not held up, until Hyprland names a window again or
  the config is next reloaded.

- **Never stuck:** if a swap cannot be done, for example because you moved the private window
  to a scratchpad, going back brings your normal window out of `special:vimma` to the
  workspace you are on.
- **Opting out:** `[private] placement = "window"` in `config.toml` (below) opens it as a second
  window, as on other systems.

**On macOS it takes your Vimma window's place too.** Going to the private workspace opens the
private window exactly where your Vimma window was (same screen, position and size, and zoomed
if it was zoomed), with macOS's window animations turned off (zooming may still animate), and
hides your normal window. Going back (any of the keys above) shows your normal window where the
private window is now, so if you moved or resized the private window, your normal window takes
that frame. Your normal window comes back in its place
when the private window closes in any way (`ctrl+b shift+d`, `ctrl+shift+w`, `cmd+shift+w`,
`cmd+w` on its last tab, the red close button, File → Close Window), when a link from another
app arrives, and when you pick it from the Window menu or the Dock menu if macOS lists it there.
If Vimma quits or crashes meanwhile, the next start shows your normal window as usual: nothing
about the swap is written to disk.

- **How:** no window manager is involved. Vimma's browser process owns both windows and hides
  and shows them itself, with the same call Firefox uses to hide its windows while it quits.
  Other normal windows stay on screen: the private workspace replaces one window, not the app.
- **Full screen:** a window in full screen (its own Space) is never hidden. From a fullscreen
  window, the private workspace opens in a fullscreen Space of its own, and switching moves
  between the two Spaces, with macOS's animation.
- **If a swap fails**, Vimma shows your normal window, says
  `private: the swap failed; showing it as a window`, and opens the private workspace as a
  window of its own until the config is next reloaded. `about:vimma` says
  `Window manager: none needed (macOS)` and which placement is in force.
- **Opting out:** `[private] placement = "window"` in `config.toml` (below) opens it as a second
  window.

**Elsewhere** (Linux without Hyprland, or `placement = "window"`) it is a second window:
Vimma opens it at the current window's size (and, on X11 and floating window managers, its
position) and focuses it when you switch.

## Bookmarks

Vimma's bookmarks are Firefox's: what you imported, what Sync brings and what the Library shows.
Vimma keeps no list of its own; it gives you keys to reach them.

**One folder per workspace.** Each [workspace](#workspaces) owns a folder in the Bookmarks
Toolbar, named after it: `work`'s bookmarks live in Bookmarks Toolbar → `work`. The folder is
made when you add the workspace's first bookmark, or adopted when a toolbar folder of that name
is already there. Vimma remembers it by its id, not only its name: renaming the workspace
(`:wsrename`) renames the folder, and a folder renamed in the Library stays the workspace's.
A workspace from `config.toml` and one made with `:wsnew` work the same.

**Bookmark a page from anywhere:** `ctrl+b a` (or `:bookmark`). A prompt opens at the foot of
the window with the page's title and the cursor before it, in the current workspace's folder.
Type folders in front of the title, separated by `/`: in `work`, `docs/My page` files the page
in Bookmarks Toolbar → `work` → `docs`, and makes the folders that are not there yet. `Tab`
completes a folder name (again: the next match). `Enter` saves, `Esc` cancels. A path ending in
`/` files the page in that folder under its title. `:bookmark docs/My page` saves at once,
without the prompt. Start a path with `@name/` for another workspace's folder:
`@shop/deals/Cart`; `Tab` after `@` completes workspace names.

If the page is bookmarked already, Vimma says where (`already bookmarked: docs/My page`, or
`@shop/deals/Cart` in another workspace) and the prompt changes to `move/rename:` with that path:
edit it and press `Enter` to move or rename the bookmark, or `Esc` to leave it. A bookmark
outside every workspace folder (in the Menu, Other Bookmarks or loose in the toolbar) is named by
its path from the Menu, and the prompt offers its title alone: `Enter` moves it into this
workspace. Only `http`, `https`, `file` and `about:` pages can be bookmarked this way.

**The bookmarks panel:** `ctrl+b shift+b` or `:bookmarks` opens your
bookmarks on the left, where the side panel opens; one of the two shows at a time. It works
like neo-tree over **the current workspace's folder**: its bookmarks and subfolders are the top
level, with no folder row around them, and the header shows the workspace's name. Switch
workspace and the panel follows. An empty folder shows a note saying what the panel shows,
that `a` adds the current page, and how to see the rest.

Bookmarks outside workspace folders (loose in the toolbar, in the Menu or in Other Bookmarks)
do not show in a workspace's panel. To see them, set `root` in [config.toml](#configtoml):

```toml
schema = 2

[bookmarks]
root = "toolbar"    # the whole Bookmarks Toolbar; "all": every bookmark; default "workspace"
```

With `"toolbar"` the panel is the toolbar's contents, workspace folders and loose bookmarks
alike, and paths count from the toolbar. With `"all"` it is the Bookmarks Menu's folders and
bookmarks, with `toolbar` and `other` (and `mobile`, when you have some) as the first folders,
and paths count from the Menu (start one with `toolbar/` or `other/` for those). A private
window, which has no workspaces, shows the toolbar.

**Deleting a workspace** (`:wsdelete`, `ctrl+b shift+d`) asks `y/N` as usual
([Managing workspaces](#managing-workspaces)); when the workspace has bookmarks, a second question asks what becomes of them: `k` (or `Enter`) keeps its folder in
the toolbar, no longer linked to a workspace; `m` moves them into another workspace's folder (it
names which); `d` deletes them. `Esc` or any other key closes nothing. Nothing is deleted
unless you press `d`.

| Key                     | What it does                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `j` / `k`               | Move down / up.                                                                           |
| `l`                     | Open the folder (again: go into it). On a bookmark: open it in this tab.                  |
| `h`                     | Close the folder; inside one, go to its folder and close that.                            |
| `Enter`                 | Open the bookmark in this tab and close the panel; on a folder, open or close it.         |
| `t`                     | Open the bookmark in a new tab behind this one; the panel stays open for more.            |
| `s` / `S`               | Open it in a new pane right / below (as `ctrl+b v` / `-`, at most 4 panes).               |
| `a`                     | Add this page in the highlighted folder, as a path. As in neo-tree, `a/b/` makes folders. |
| `A`                     | Add a folder there.                                                                       |
| `r`                     | Rename.                                                                                   |
| `m`                     | Move to a folder: type its path (`Tab` completes); `@name/…` is another workspace's.      |
| `d`                     | Delete, after `y/N`. A folder says how many items go with it.                             |
| `y`                     | Copy the bookmark's address.                                                              |
| `/`                     | Filter every bookmark by title, address or folder, letters in order. `Enter` keeps it.    |
| `I`                     | Close the panel and focus the address bar.                                                |
| `Esc`, `ctrl+b shift+b` | Close the panel. With a filter, `Esc` clears it first.                                    |

A bookmark opens in your current workspace's container, and in a private window it stays
private. `javascript:` and `data:` bookmarks (bookmarklets) are listed but do not open from
Vimma: it says so instead, since they would run code in the page. Changes made elsewhere (the
Library, Sync, another window) show in the panel at once. With `root = "all"`, the four top
folders cannot be renamed, moved or deleted. The panel remembers which folders you opened until
Vimma quits.

### Firefox's Bookmarks Toolbar

Firefox's Bookmarks Toolbar, the row of bookmarks under the address bar, is hidden by default,
on the start page and new tabs too, and stays hidden when you import bookmarks from another
browser. Your bookmarks are in the panel (`ctrl+b shift+b`) and in the Bookmarks Toolbar folder
either way: hiding the toolbar hides a view, not a bookmark. A profile that showed the toolbar
before this default has it hidden once, with a notice that says how to bring it back.

- **`:bookmarkstoolbar`** shows or hides it in every window, as Firefox's `ctrl+shift+b` does
  (also a Vimma binding: [Firefox's own shortcuts](#firefoxs-own-shortcuts)).
  `:bookmarkstoolbar show`, `hide` and `newtab` set it either way; `newtab` shows it only on the
  start page and new tabs. `Tab` completes the three words. The notice says
  `bookmarks toolbar shown`, `hidden` or `shown on new tabs`.
- **Firefox's View → Toolbars → Bookmarks Toolbar** menu and the toolbar's context menu work as
  in Firefox. Any of these choices lasts across restarts.
- **[config.toml](#configtoml):** `[ui] bookmarks_toolbar = "shown"`, `"hidden"` or `"newtab"`
  sets it in every window at startup and when you change that line; another change lasts until
  then, and its notice adds `(config.toml sets "…"; until restart)`. Left out, the choices above
  decide.
- **Customize → Restore Defaults** sets Firefox's own default, the toolbar on new tabs;
  `:bookmarkstoolbar hide` hides it again.
- With the [toolbar hidden](#hiding-the-toolbar) (`ctrl+b u`), the bookmarks toolbar hides with
  it.

## Tab search and tab rename

`ctrl+b g` (or `ctrl+shift+a`, `b` in normal mode, or `:ls`) opens tab search over the page, ready to type. It
finds any tab: every workspace of this window, your other windows, and the tabs and windows
you closed recently. The current tab is selected. Like the bindings overlay it takes every key
while open, so nothing reaches the page.

- Type a few letters of the title, URL, rename, workspace or marker. Matches are highlighted,
  best first: the start of a title beats a word inside it, which beats letters spread out.
  Letters with diacritics count as their own letters first (`kä` puts "Käyttäjät" on top), and
  still match without them, lower down (`ka` finds it after "Kalenteri"). Every term must
  match something: `jira 412`, `work mail`. `Backspace`, `ctrl+w` and `ctrl+u` delete a letter,
  a word, everything.
- `ctrl+n` / `ctrl+p` and `Down` / `Up` move; `Tab` / `shift+Tab` jump to the next or previous
  section. Every letter types, `j`, `k` and `q` too.
- `Enter` goes to the selected tab: its window comes to the front and its workspace becomes
  current. On a recently closed tab it reopens it, with its history, in its workspace, and
  goes there; on a closed window it reopens the window.
- `Esc` closes it and focus returns to the page.

`:tabsearch text` (`:ts`, or `:b text` as Vim's buffer command) opens it with the text already
typed.

With nothing typed, the list is in sections, each under a heading such as `work · 12`: this
window's workspaces, the current one first; then each other window's, most recently used first
(`personal · 40 · w2`); then `Recently closed`, newest first, up to 25 tabs and 5 windows (as
many as Firefox keeps). With a query, the best matches come first from every section. Each row
shows the tab's number in its workspace (the one `ctrl+b 1..9` uses), its title or rename, then
in muted text its workspace, its window (`w2`, other windows only) and its markers, and the
site:

| Marker          | Means                                                                 |
| --------------- | --------------------------------------------------------------------- |
| `♪`             | The tab is playing sound (type `playing` to find it).                 |
| `muted`         | The tab is muted.                                                     |
| `pinned`        | The tab is pinned.                                                    |
| `◇` (workspace) | A tab of the [agent workspace](#agent-workspace), listed after yours. |
| `closed`        | Recently closed (`closed window` for a window).                       |

A private window and the normal ones never see each other's tabs, open or closed: tab search
in a normal window lists no private tab, and in the private workspace it lists only private
tabs. Tabs that have not loaded since a restart are listed by their saved title and stay
unloaded. Tab search only finds tabs; to close, move or reorder them, use the
[side panel](#side-panel) (`ctrl+b b`).

`ctrl+b shift+t` opens a one-line prompt at the foot of the window with the tab's current name.
Type a name and press `Enter`; `Esc` cancels. An empty name removes the rename, so the page title
shows again. `:tabrename name` does the same in one step (`:tabrename` alone opens the prompt).
The name replaces the title in the status bar and in tab search and is saved with the session, so
it survives a restart (with Firefox's "Open previous windows and tabs") and undoing a closed tab.
Invisible and direction-changing characters are removed, runs of spaces become one, and a name
is cut at 100 characters.

## Add-ons

Add-ons work as in Firefox. Install them from [addons.mozilla.org](https://addons.mozilla.org)
as usual: the add-on's page, its Add button, Firefox's permission prompt. Vimma never installs
anything by itself. What Vimma adds is keyboard control.

`ctrl+b e` (or `:addons`) opens the add-on picker over the page: every extension you installed,
with its version, whether it is enabled, `private ok` when it may run in private windows, and
`update` when an update is waiting. Firefox's built-in and hidden add-ons, themes and
dictionaries are not listed. Like tab search, it takes every key while open.

| Key            | What it does                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `j` / `k`, `/` | Move; filter by name (`Esc` back to the list).                                                                                  |
| `Enter`        | Opens the add-on's popup (a password manager's vault, uBlock Origin's panel), as clicking its toolbar button would.             |
| `o`            | Opens its options page in a tab; an add-on without one opens its details in `about:addons`.                                     |
| `x`            | Enables or disables it. The picker stays open.                                                                                  |
| `d`            | Removes it, after a `y/N` question. Nothing is removed if the add-on changed (updated, renamed, removed) before your `y`.       |
| `u`            | Checks for an update and says what it found. Vimma does not install it: Firefox does, in the background or from `about:addons`. |
| `P`            | Allows or stops it in private windows (Firefox's "Run in Private Windows").                                                     |
| `Esc` / `q`    | Closes the picker.                                                                                                              |

**Popups.** The popup opens where Firefox opens it: under the add-on's toolbar button, or, for
an add-on in the extensions menu (the puzzle piece), in that menu. With the
[toolbar hidden](#hiding-the-toolbar), the full toolbar shows while the popup is open. Keyboard focus goes into the
popup, so you can type at once (a password manager's search field). Keys there are the popup's,
except Vimma's `ctrl+b` chords; `Esc` closes it and focus returns to the page. An add-on whose
button has no popup runs the button's action instead; one without a button says so.

**`:addon name`** opens one add-on's popup by name: a few letters are enough (`:addon bw` finds
Bitwarden), and `Tab` completes the name. To put an add-on on a key:

- bind `addon_popup` in `config.toml` (`[keys] addon_popup = ["prefix+shift+e"]`): it opens
  `:addon ` on the command line, ready for a name;
- or give the add-on its own shortcut: `about:addons` → the gear menu → Manage Extension
  Shortcuts, "Activate the extension". Vimma lets every chord it does not use through, so that
  shortcut opens the popup directly. Keys cannot carry a name in `config.toml`.

**Add-ons that clash with Vimma.**

- **Vimium, Tridactyl, Surfingkeys** and other keyboard add-ons fight Vimma over the same keys
  and are not needed: Vimma has hints, scrolling, find and the command line built in. Disable
  them with `x`.
- **Container add-ons** (Multi-Account Containers, Temporary Containers) overlap with
  [workspaces](#workspaces), which are containers already. They work, but a tab they open in a
  container of their own belongs to no workspace: it joins the workspace you are in as a
  `foreign` tab, without that workspace's cookies and logins.
- **An extension shortcut on a Vimma key**: Vimma sees the key first, so Vimma's binding wins
  and the add-on never gets it. Remap one side: the add-on's in `about:addons` → Manage Extension
  Shortcuts, or Vimma's in `config.toml`.
- **Sidebar add-ons** (a `sidebar_action`) open in Firefox's own sidebar, through the add-on's
  button or the View menu, not in Vimma's side panel.

## The command line

`:` in normal mode opens a Vim-style command line just above the status bar, for everything
that is quicker to type than to bind. Type a command
and press `Enter`; `Esc` closes it and puts focus back on the page. While it is open nothing you
type reaches the page, and `ctrl+b` sequences still work.

- **Completion.** A list of matching commands and actions, with what each does, follows what you
  type. `Tab` puts the next match on the line, `shift+Tab` the previous; both wrap around.
  Matching also takes letters in order (`scd` finds `scroll_down`).
- **History.** `Up` / `Down` walk the lines you ran before, newest first. With text typed, `Up`
  recalls only lines that start with it, as in Vim. History lasts until Vimma quits; a private
  window keeps its own, forgotten when it closes.
- `:open @` and `Tab` lists the search aliases (`@gh`, `@google`, …) with the engine each one
  searches; the chosen one ends in a space, ready for the words.
- `:open` and `:tabnew` refuse `javascript:` and `data:` URLs (also behind `view-source:`), with a
  message, as `p` does, and so does a bookmark keyword that leads to one (a bookmarklet). The
  line does not open over a fullscreen page.
- **Errors** show under the line, which stays open so you can fix it: `:tabnwe` says
  `not a command: "tabnwe"; did you mean :tabnew?`.
- A command name can be shortened while it stays unique (`:tabr`, `:wsp`), and leading colons
  are fine (`::q`). When the shortened name starts several commands and one of them begins all
  the others, that one wins, as in Vim: `:wor` is `:workspace` (not `:workspaces`), `:bo`
  `:bookmark`. `:wsn` is `:wsnext`, as Vim's `:wsn[ext]`.
- An argument is the rest of the line, as typed. Quotes are removed only when one pair wraps all
  of it: `:tabrename "my  tab"`.

| Command                               | What it does                                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `:open text`                          | As the address bar would: `example.com` a web address, `@gh words` that alias's engine, a bookmark keyword its bookmark, other words a search. |
| `:tabnew`, `:tabnew text`             | Opens a new tab; with text, opens it there (as `:open`).                                                                                       |
| `:q`, `:quit`                         | Closes the pane, as `ctrl+b x`; with one pane the tab, as `x`: a pinned tab is kept and the next one selected.                                 |
| `:map`, `:help`, `:h`                 | Shows every binding (the `ctrl+b ?` overlay).                                                                                                  |
| `:scroll_down`, `:tab.next`…          | Any action by its name in [bindings.md](bindings.md), or by its dotted id. Actions take no argument.                                           |
| `:tabrename [name]`                   | Renames the tab; without a name, opens the rename prompt.                                                                                      |
| `:ls`                                 | Opens [tab search](#tab-search-and-tab-rename).                                                                                                |
| `:tabsearch [text]`, `:ts`, `:b`      | Opens tab search with the text already typed.                                                                                                  |
| `:grep text`, `:grep`                 | Opens [live grep](#live-grep) with that text; alone, with the last query.                                                                      |
| `:vsplit`/`:vs`, `:split`/`:sp`       | Splits the pane right / down, as `ctrl+b v` / `ctrl+b -`.                                                                                      |
| `:layout [name]`                      | Arranges the panes in the named preset ([Layouts](#layouts)); Tab completes the names. Without one, the next preset.                           |
| `:wsnext`/`:wn`, `:wsprev`/`:wp`      | Next / previous workspace, as `ctrl+b )` / `ctrl+b (`.                                                                                         |
| `:workspace name`, `:ws 2`, `:ws #`   | Switches to the workspace with that name, that number in workspace order, or the previous one (`ctrl+^`). `Tab` completes names.               |
| `:workspace`, `:ws`, `:workspaces`    | Opens the workspace picker.                                                                                                                    |
| `:wa name`, `:wd [name]`              | `:wsnew`, `:wsdelete` ([Workspaces as Vim buffers](#workspaces-as-vim-buffers)).                                                               |
| `:private`, `:priv`, `:private close` | Goes to the [private workspace](#private-workspace) and back, as `ctrl+b shift+p`; `close` closes it (asks `y/N`).                             |
| `:sidebar`                            | Opens or closes the side panel, as `ctrl+b b`.                                                                                                 |
| `:route`, `:route add`, `:route move` | Workspace routing rules: list them, add one for this site, move this tab ([Routing](#routing-which-workspace-a-link-opens-in)).                |
| `:bookmarks`                          | Opens or closes the [bookmarks panel](#bookmarks), as `ctrl+b shift+b`.                                                                        |
| `:bookmark [path]`                    | Bookmarks the page under `path` (`work/docs/title`); without one, opens the prompt, as `ctrl+b a`.                                             |
| `:source`                             | Reads `config.toml` now instead of within 2 seconds (see [config.toml](#configtoml)).                                                          |
| `:source path`                        | Loads that TOML file instead of `config.toml` until `config.toml` changes or a plain `:source`.                                                |
| `:config`                             | Opens `config.toml` in a new tab (read-only view); creates it from a commented template when it is missing.                                    |
| `:mcp [on\|off\|revoke\|forget]`      | Agents and the [agent workspace](#agent-workspace): the status, on (asks `y/N`), off, revoke the grants, or forget its logins (asks `y/N`).    |
| `:control [on N\|off]`                | Full control for `vimma-ctl`: the status, on for `N` minutes (asks `y/N`), or off now ([below](#agent-workspace)).                             |
| `:theme [dark\|light\|system]`        | The built-in palette dark, light or as the system is; bare, the other of dark and light (see [Colours](#colours-and-themes)).                  |
| `:about`, `:vimma`                    | Opens [about:vimma](#aboutvimma) in a new tab.                                                                                                 |
| `:addons`                             | Opens the [add-on picker](#add-ons), as `ctrl+b e`.                                                                                            |
| `:addon name`                         | Opens that add-on's popup; `Tab` completes the name ([Add-ons](#add-ons)).                                                                     |
| `:bug`                                | Opens `about:vimma` and copies its redacted report to the clipboard, for a bug report.                                                         |
| `:update`                             | Checks for a newer Vimma now; when there is one, opens `about:vimma`'s Updates section with the exact commands ([Updates](#updates)).          |
| `:restart`                            | Restarts Vimma; tabs come back, and an installed update applies. Asks first while private tabs are open ([Updates](#updates)).                 |

A command whose action has no implementation says so for a moment, as its keys do.

## about:vimma

`about:vimma` (or `:about`) shows what Vimma is doing, as of when the page opened: press `r` or
Refresh for the current state. It is an ordinary page, so `j` / `k` scroll it.

- **Version:** Vimma's version, the Firefox release it is built on, the build ID and the update
  channel.
- **Updates:** whether checks are on, how Vimma was installed, the last check and its result
  (with the reason when the manifest was refused), the newer version if there is one, its
  urgency, the manifest's serial and the key that signed it, and the exact commands to update
  ([Updates](#updates)).
- **Upstream patches:** how many patches to Firefox's own files the build carries, each with its
  hunk count (the fewer, the easier a Firefox update).
- **Modes and keys:** each window's mode, and the last 20 keys Vimma saw with what each did
  (`j → scroll.down`, `pass` when the key went to the page). Letters typed into a text field or
  the command line show as `·`, so nothing you type is kept.
- **Config:** the `config.toml` path, whether it was read, its `schema`, every error with its
  line, and the full binding table with the keys your file changes marked `*`.
- **Theme:** the colour source (`built in`, or `Omarchy`), the theme's name (the Omarchy
  theme's, or the built-in palette's, e.g. `vimma (built in)`), its appearance (`system`,
  `dark` or `light`, where that comes from and how to change it), and on Omarchy the theme
  directory, its `colors.toml` time and why the last theme file was rejected, if one was.
- **Workspaces:** how many there are, and this window's with their tab and pane counts.
- **Control socket:** on or off, and its port. The token is never shown.
- **Agents (MCP):** on or off (and whether `config.toml` or `:mcp on` decides), and the
  [agent workspace](#agent-workspace) with its tab count; never its addresses or titles.

**Copy redacted report** (or `:bug`) copies all of that as text, without the binding table's
defaults, with every URL replaced by `<url>` and your home directory by `~`. It never contains
page titles or addresses.

The licences of Firefox's third-party code are in `about:license`; the third-party code Vimma
adds (the smol-toml TOML parser, BSD-3-Clause) is listed there too, under Vimma. `vimma-ctl` is
one file with Rust's standard library in it, and on Linux musl and LLVM's libunwind too; their
notices are in `vimma-ctl-licenses/` next to it (`/usr/lib/vimma/vimma-ctl-licenses/` from the
`.deb` or `.rpm`), or in `Vimma.app/Contents/Resources/vimma-ctl-licenses/` on a Mac.

## Settings (about:config)

Vimma's own preferences today:

| Preference                 | Default                                | What it does                                                                                                                                                                            |
| -------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vimma.ui.tabstrip.hidden` | `true`                                 | Hides Firefox's tab strip (horizontal, and the vertical tab list). Set `false` to show it again; it applies at once, no restart.                                                        |
| `vimma.ui.toolbar.hidden`  | `false`                                | Hides Firefox's toolbar in every window ([Hiding the toolbar](#hiding-the-toolbar)). `ctrl+b u` and `:toolbar` set it; `[ui] toolbar` sets it at startup. Applies at once.              |
| `vimma.debug.keys`         | unset                                  | Create it as a boolean set to `true` to log every key Vimma sees (`{ key, mods, mode }`) to the Browser Console (`ctrl+shift+j`; enable its Debug filter).                              |
| `vimma.startpage.newtab`   | `true`                                 | New tabs open Vimma's start page (see [The start page](#the-start-page)). Set `false` for Firefox's new tab page; it applies at once, no restart.                                       |
| `vimma.control.enabled`    | `false`                                | Turns on the control socket for `vimma-ctl` and scripts (see [Scripting with vimma-ctl](#scripting-with-vimma-ctl)). Applies at once, no restart.                                       |
| `vimma.theme.source`       | `omarchy`                              | `omarchy` follows your Omarchy theme where Omarchy is installed (see [Colours](#colours-and-themes)); `builtin` forces `[theme] name`'s palette. Applies at once.                       |
| `vimma.theme.appearance`   | `system`                               | What `:theme` sets: the built-in palette `dark`, `light` or as the system is (see [Colours](#colours-and-themes)). `[theme] appearance` in `config.toml` wins over it. Applies at once. |
| `vimma.theme.omarchyPath`  | `~/.local/state/omarchy/current/theme` | The Omarchy theme directory to read `colors.toml` and `light.mode` from. Applies at once.                                                                                               |
| `vimma.theme.omarchyHook`  | `true`                                 | Installs the Omarchy theme-set hook for instant theme changes (see [Colours](#colours-and-themes)). `false` removes Vimma's unedited hook at once.                                      |
| `vimma.config.path`        | unset                                  | A config file to read instead of `$XDG_CONFIG_HOME/vimma/config.toml`. Applies at once.                                                                                                 |
| `vimma.config.pollMs`      | `2000`                                 | How often Vimma checks `config.toml` for a change, in milliseconds. Applies at once.                                                                                                    |

## config.toml

Vimma reads `~/.config/vimma/config.toml` (`$XDG_CONFIG_HOME/vimma/config.toml` when that is
set), and nothing else in that folder. No file means the defaults. Vimma creates it, with every
default commented out under a short header on how to edit it, in two cases: on a profile's first
run, and when you type `:config` (which then opens it in a tab). The folder is created mode 0700
if it is missing, and the file mode 0600, since it can name intranet hosts. An existing file,
even an empty one, is never written; `:route add` only appends to it. A small example:

```toml
schema = 2

[keys]
new_tab = ["prefix+t"]        # replaces ctrl+b c

[modal.normal]
"<leader>ff" = "goto.picker"

[panes]
max = 2

[theme]
source = "file"               # on Omarchy: the built-in Vimma palette instead of its theme
appearance = "dark"           # the built-in palette dark whatever the system says
[theme.colors]
accent = "#ff9e64"
```

- **Notation:** `prefix+t` means the prefix (`[keys] prefix`, default `ctrl+b`), then `t`;
  `<leader>ff` means the leader (`[modal] leader`, default `space`), then `f f`; keys in a
  sequence are separated by spaces. The `ctrl+b ?` overlay, `:map` and `about:vimma` show
  bindings as the keys you press, with your prefix and leader.
- **Reload:** save the file and Vimma picks it up within 2 seconds, in every window, without a
  restart. `:source` reads it at once.
- **Another file:** `:source work.toml` loads that file instead, the same way: whole, over the
  defaults, not merged into `config.toml` (a file is checked as a whole, so two half-configs
  could not be). A relative path is next to `config.toml`; `~`, `$HOME` and `$XDG_CONFIG_HOME`
  expand at its start. It stays in force until `config.toml` changes or you type a plain
  `:source`. A missing or broken file changes nothing and shows its error in the status bar
  under its own name (`work.toml: no such file`, `work.toml:3: …`).
- **Errors:** a file with a mistake is not applied at all: the config you had keeps working,
  and the status bar shows the first mistake in red on the right, with its line, e.g.
  `config.toml:3: keys.new_tabb: unknown action "new_tabb" (did you mean "new_tab"?)` (or
  `3 errors: …`). The Browser Console (`ctrl+shift+j`) lists them all. Fix the file and the
  message goes away at the next check.
- **What applies live:** `[keys]`, `[modal]` (leader, `timeout_ms`, per-mode keys, `hint_chars`)
  and `[unbind]`; `[panes] max` (most panes in a workspace, 1 to 16, default 4; it limits new
  splits), `[panes] layout` (`"dwindle"` or `"manual"`: where `ctrl+b enter` puts a new pane) and
  `[panes] main_size` (the main-\* presets' main pane, 20 to 80%, default 60); `[sites."<host>"] insert` (`auto`, `never` or `always`: whether a text field on that
  site and its subdomains takes insert mode); `[theme]` `source` (`omarchy` or `file`, the
  built-in palette), `name` (`vimma`, the default, or `tokyo-night`: the built-in palette),
  `appearance` (`system`, `dark` or `light`: the built-in palette's; left out, `:theme` sets it),
  `font` and `[theme.colors]` (single colours over either source);
  `[workspaces]` (a new one gets its container at once; one removed from the file stays, as a
  workspace you can close yourself); `[firefox] disable` and `enable` (which of Firefox's own
  shortcuts are off, [above](#firefoxs-own-shortcuts)); `[modal] insert_editing` (`ctrl+w`,
  `ctrl+u`, `ctrl+h` in text fields, default `true`); `[bookmarks] root` (`"workspace"`, the
  default: the current workspace's folder; `"toolbar"`; or `"all"`: what the
  [bookmarks panel](#bookmarks) lists and where paths start); `[private] placement` (`"swap"`, the
  default: on Hyprland and macOS the [private workspace](#private-workspace) takes the Vimma
  window's place;
  `"window"`: it is a window of its own beside it); `[mcp]` (local AI agents:
  `enabled`, which wins over `:mcp on|off`; `workspace`, the [agent workspace](#agent-workspace)'s
  name, default `"agent"`, never `"private"`; `ask_timeout`, 10 to 300 seconds, default 50;
  `grant_minutes`, what a bare `a` allows: 0, the default, until the agent quits, or that many
  minutes, at most `grant_max_minutes`, 1 to 1440, default 480;
  `max_read_chars`, 1,000 to 500,000, default 200,000; `notify`, default `true`;
  `download_dir`, `download_max_mb` and `clamav_max_age_days`, [above](#downloads-from-the-agent-workspace)); `[search]`
  (the default engine and `@aliases`, [below](#search-engines)); `[ui] toolbar` (`"shown"`, the
  default, or `"hidden"`: [Firefox's toolbar](#hiding-the-toolbar) in every window; applied at
  startup and when the line changes, so `ctrl+b u` lasts until then); `[ui] bookmarks_toolbar`
  (`"shown"`, `"hidden"` or `"newtab"`, unset by default: [Firefox's Bookmarks
  Toolbar](#firefoxs-bookmarks-toolbar), hidden unless you show it); `[updates] check`
  (`true`, the default, or `false`: no [update check](#updates) at all).
- **Schema:** `schema = 2` at the top enables `[panes]`, `[sites]`, `[[routes]]`, `[firefox]`,
  `[bookmarks]`, `[private]`, `[mcp]`, `[search]`, `[ui]`, `[updates]`,
  `hint_chars`, `insert_editing`, `[theme] name` and `appearance`. Every key is in the template
  `:config` writes, with its default commented out (the same as
  [`defaults.toml`](../packages/vimma-core/defaults.toml) in the source).

### Search engines

`[search]` sets the default search engine and gives engines short `@aliases`, so the file holds
what Firefox otherwise keeps in Settings → Search:

```toml
[search]
default = "DuckDuckGo"                    # an installed engine's name, or "@alias" of a URL below

[search.aliases]
gh = "https://github.com/search?q=%s"     # a URL with one %s becomes an engine
w = "Wikipedia (en)"                      # an installed engine gets this alias
```

- **Using an alias:** type `@gh vimma` in the address bar, or `:open @gh vimma` (`:tabnew` too), and
  the words go to that engine. Firefox's own aliases (`@google`, `@ddg`, `@wikipedia`) and your
  bookmark keywords work in `:open` the same way. To search the default engine for text that
  starts with `@`, put `? ` before it: `:open ? @gh vimma`.
- **Aliases:** a key is the alias without its `@` (a leading `@` in the key is dropped): a letter
  or digit, then up to 31 of `a-z 0-9 . _ -`, case-insensitive. A URL value must be `https://`
  or `http://` with exactly one `%s`, where the words go; Vimma adds it to Firefox as an engine
  named after its host (`github.com`), with no search suggestions, so nothing is sent before
  `Enter`. An `http://` URL sends your searches unencrypted, and `about:vimma` says so. Any other
  value is an installed engine's name, as Settings → Search lists it; that engine gets the alias,
  and its own keeps working.
- **The default:** `default` names an installed engine, or `"@sx"` for an alias with a URL (a
  SearXNG of your own, say). It applies to the address bar, `:open`, `:tabnew` and `p`/`P`, in
  private windows too unless Firefox's separate private default is on. The file wins: at every
  start and every save Vimma sets it again, so a default chosen in Settings lasts until then.
  Delete the `default` line to choose it in Settings instead.
- **Removing lines** puts back what was there: without `default`, the engine you had before
  becomes the default again (unless you have chosen another one in Settings since); an engine
  Vimma made from a URL is removed, and an installed engine gets its old alias back.
- **Mistakes:** a name that is not installed, or an alias another engine already has, shows in
  the status bar and `about:vimma` like any config error, with its line and a suggestion
  (`config.toml:3: search.default: no search engine named "DuckDuckGoo" (did you mean
"DuckDuckGo"?)`). The rest of the file still applies; only that entry is skipped.

## Scripting with vimma-ctl

`vimma-ctl` drives a running Vimma from a shell, a window-manager binding or a test: it sends
keys, reads the state and opens URLs. It is for when you want your browser to be part of your
scripts. It talks to the browser over a local control socket, which
is **off by default**.

1. Turn the socket on: in `about:config`, set `vimma.control.enabled` to `true`. It starts at
   once and writes `vimma-control.json` into your profile directory. Setting it back to `false`
   stops it and deletes the file.
2. Use the `vimma-ctl` that came with Vimma: [Installing](#installing) says where each package
   puts it. `vimma-ctl --version` names the Vimma version it came with. Building it from source
   is for contributors ([CONTRIBUTING.md](../CONTRIBUTING.md#vimma-ctl-from-source)).
3. Use it:

   ```sh
   vimma-ctl state                    # mode, pending keys, workspace, tabs
   vimma-ctl state --json             # the same, as JSON
   vimma-ctl send-keys "ctrl+b ?"     # typed as if on the keyboard: opens the help overlay
   vimma-ctl send-keys esc
   vimma-ctl open https://example.com # a new tab; only http, https, file and about URLs
   vimma-ctl reload-theme             # read the Omarchy theme now (the hook's fallback)
   vimma-ctl mcp                      # an MCP server for an agent tool (Connecting an agent's tool)
   ```

   It finds your default profile itself, in `~/.config/vimma/vimma/` on Linux and in
   `~/Library/Application Support/Vimma/` on macOS; pass `--profile DIR` (or set
   `VIMMA_PROFILE`) for another one. In Hyprland: `bind = SUPER, slash, exec, vimma-ctl send-keys "ctrl+b ?"`.

   The socket also starts when only agents are on ([`:mcp on`](#agent-workspace)); that side
   is for agents only, so `vimma-ctl` then says the control socket is off until you set
   `vimma.control.enabled` too (or `:control on <minutes>`). With both on, each `vimma-ctl` run
   asks you first in Vimma ([full control while agents are on](#full-control-while-agents-are-on)).
   An older `vimma-ctl` still works with this Vimma.

`send-keys` presses the keys in the most recently focused Vimma window, exactly as typing them
would: Vimma's bindings, Firefox's shortcuts (`ctrl+t`, `ctrl+q`) and the page all see them. Keys
meant for the page reach it only while that window has focus, as with a real keyboard. With the
help overlay open, plain keys go to the overlay, as when typing; chords that work in every mode
(`ctrl+q`, `ctrl+t`) still run.

**Security.** Turning the socket on hands **full control of the browser** to whoever has the
token: they can type into any page (including your logged-in sites), open `about:config` and
change any setting, and quit Vimma. `open` loads with the system principal, like a URL given on
the command line, so it can open local files (`file:`) and privileged pages such as
`about:config`; only `javascript:` and `data:` are refused. Leave the pref off unless you use it.

What keeps others out:

- The socket listens on `127.0.0.1` only, on a random port. Web pages cannot speak to it (they
  cannot read the token, and an HTTP request is rejected).
- A client must send the token from `vimma-control.json`: 256 random bits, new at every start,
  compared in constant time. The file is readable by you alone (mode 0600), and `vimma-ctl`
  refuses a file anyone else can read. Other users on the machine cannot get it; anything
  running as you can, just as it can already read your profile's cookies and history.
- The browser proves it knows the token first: `vimma-ctl` sends only a random nonce, and sends
  the token only after the browser has answered with an HMAC of that nonce made with the token.
  If Vimma crashed and another program took its old port, that program gets the nonce and
  nothing else: no token and no command (`vimma-ctl` exits 4). It can still make `vimma-ctl`
  wait until its timeout.
- A stale file (Vimma crashed or was killed with `kill -9` or `SIGTERM`) is removed at Vimma's
  next start, whether or not the socket is on. Until then, on Linux, `vimma-ctl` sees that the
  process named in it has exited and says Vimma is not running; if that process number has been
  reused, the handshake above still protects you.

Limits against a local denial of service: at most 8 authenticated connections (the next is told
"busy"); at most 2 connections still authenticating, a new one pushing out the oldest, so idle
connections cannot lock `vimma-ctl` out; 5 s to authenticate; an idle connection closes after
60 s; lines over 1 MiB and clients that stop reading are disconnected. These are limits, not a
defence against an active attack: a program of any local user that connects fast enough keeps
pushing `vimma-ctl` out before it authenticates, and any program running as you can keep the 8
slots busy. Turn the pref off to stop either.

## Updates

Vimma 0.1.2 and later tell you when a newer release is out, on Linux x86_64 and on Macs with
Apple Silicon. Vimma notifies you and shows the command; it does not install the update itself,
except as an AppImage, which replaces its own file (below).

**Vimma 0.1.6 on a Mac** shows the notice, but its `:update` shows the Linux tarball command,
which does not apply to a Mac: do not run it. Update with `brew upgrade --cask vimma`, or install
the new `.dmg` over the old one ([macOS](#macos)). Later versions show the right steps.

**Coming from 0.1.1?** Vimma 0.1.1 has no signing key built in, so it refuses every update file
and never shows a notice. Update it once by hand, the way you installed it: the commands are in
the table below and in [Installing](#installing). From 0.1.2 on, the status bar tells you.

Every 12 hours, and a few seconds after startup when the last successful check is older, Vimma
fetches one small signed file from `updates.vimma.dev` that names the newest release of its
update channel. A check that fails is tried again every hour while Vimma runs. Vimma checks the
file's signature against the keys built into Vimma and refuses anything else: a file signed by
another key, one for another channel or platform, or one older than a file it already accepted.
Except for the AppImage, it installs nothing; it tells you.

- **A newer version:** the status bar's right side shows `⇡ 0.3.1 available`, dim. A release that
  carries a Firefox security fix shows `⇡ 0.3.1 security: :update` in the error colour. The
  version you are running is never offered: once it is installed, the notice goes at the next
  start.
- **The first time a version is offered**, a message above the status bar says
  `Vimma 0.3.1 is available · :update shows the command` (or `fixes security issues` for a
  security release) for a few seconds. It takes no focus and no keys, and is not shown again for
  that version, even after a restart.
- **A security release also asks**, once per session:
  `Vimma 0.3.1 fixes security issues. Show the update command? (y/N)`. `y` shows the update steps,
  as `:update` does; `n`, Esc or any other key dismisses it until the next start. The question
  waits until you are not typing in a field, are not in link hints, copy mode or element mode,
  and have not pressed a key for a moment, never takes focus, and is not asked in a private
  window. Keys pressed in its first second are ignored, so a
  key you were already typing, or one a page asked you to press, cannot answer it.
- **The AppImage updates itself.** When a newer release is offered, Vimma downloads the new
  AppImage from the project's GitHub release into a hidden file next to yours, checks its size
  and SHA-512 against the signed file, makes it executable and renames it over yours. The Vimma
  you are running carries on; the next start runs the new version. The status bar then shows
  `⇡ 0.3.1 on restart` (`⇡ 0.3.1 security: :restart` in the error colour for a security
  release), and a message says `Vimma 0.3.1 is installed · restart Vimma to use it`. Vimma
  never restarts by itself. Your file keeps its name, so `vimma-0.1.0-x86_64.AppImage` can hold
  0.3.1; `about:vimma` shows the version that runs. If the AppImage's directory is not writable,
  the download does not match, or it fails, your file stays as it was, `about:vimma` says why,
  `:update` shows the manual steps, and the next check tries again.
- **A security update that is installed asks to restart**, once per session:
  `Security update 0.3.1 is ready. Restart now? Tabs come back. (y/N)`, with
  `Private tabs will close.` before `(y/N)` while the private workspace has tabs, and
  `Tabs will not come back.` in place of `Tabs come back.` when they will not (below). `y` restarts
  Vimma at once, as `:restart` does; `n`, Esc or any other key dismisses it, and a session that
  runs on is asked again 24 hours later. It waits and arms as the question above does, and is not
  asked in a private window. Today this is the AppImage, once it has replaced its file.
- **`:restart`** restarts Vimma. Your workspaces, tabs and panes come back, as after any restart;
  the private workspace's tabs do not, so with private tabs open it asks first:
  `Restart Vimma? 2 private tabs will close. (y/N)`. A page that asks before it is left (unsaved
  input) can stop the restart; Vimma then says `restart cancelled`. The AppImage starts its own
  file again, so a replaced AppImage restarts into the new version: Vimma quits, and a small
  `/bin/sh` script waits for it to exit and starts the AppImage on the same profile, without the
  command-line arguments the old one had. Because that restart is a quit, an AppImage set to
  clear history when it closes (Settings, Privacy & Security) brings no tab back, and
  `:restart` asks `Restart Vimma? Tabs will not come back. (y/N)` first. `:restart` has no
  default key; bind the `restart` action in [config.toml](#configtoml) if you want one.
- **`:update`** checks at once. When a newer version exists it opens `about:vimma` at its
  Updates section, with the exact commands for how you installed Vimma; otherwise it says
  `Vimma 0.1.0 is up to date`, or why the check failed.
- **The commands, by install:** each download fails on an HTTP error and goes over https only,
  and is checked against the SHA-512 the signed file gives for it (`sha512sum -c`) before
  anything is installed or replaced, so a file changed on the release page stops the command.

  | Installed with           | `:update` shows                                                                                                                                                  |
  | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | The release's `PKGBUILD` | `mkdir -p ~/.cache/vimma-build && cd ~/.cache/vimma-build && curl -fLO https://github.com/vimma-browser/vimma/releases/latest/download/PKGBUILD && makepkg -si`  |
  | AUR `vimma-bin`          | `yay -Syu vimma-bin` (or your AUR helper's equivalent); no such package exists yet ([Arch Linux](#arch-linux))                                                   |
  | `.deb`                   | download `vimma_X.Y.Z_amd64.deb`, check it, then `sudo apt install ./vimma_X.Y.Z_amd64.deb`                                                                      |
  | `.rpm`                   | download `vimma-X.Y.Z-1.x86_64.rpm`, check it, then `sudo dnf install` it (Fedora) or `sudo zypper install --allow-unsigned-rpm` it (openSUSE)                   |
  | Tarball                  | quit Vimma, download the tarball, check it, then `tar -xJf` it into the install's parent directory                                                               |
  | AppImage                 | nothing: it replaces its own file (above); if it cannot, download the new AppImage next to yours, check it, and rename it over yours                             |
  | Homebrew (macOS)         | `brew upgrade --cask vimma`                                                                                                                                      |
  | `.dmg` (macOS)           | no command: quit Vimma, download the new `.dmg` from the release page and drag Vimma over the copy in Applications; macOS asks again on [the first open](#macos) |
  | A build from source      | nothing: source builds never check (pull and rebuild)                                                                                                            |

- **What a check sends:** a GET for
  `https://updates.vimma.dev/updates/browser/<target>/<channel>/update.xml`, where the target is
  `Linux_x86_64-gcc3` or, on a Mac, `Darwin_aarch64-gcc3`, with no
  cookies, no referrer, an empty `Accept-Language` and no cache, and follows no redirect. It names
  your platform and update channel and nothing else: no Vimma version, build, language or
  identifier, so every install on a channel asks for the same
  file. The host sees your IP address and the time.
- **Problems:** a host that does not answer (you are offline, or no release is published yet) is
  not shown in the status bar; `about:vimma` has the reason. A file that answers but fails the
  checks three times in a row shows `updates: check failed`, and one that is older than 45 days
  (7 for nightly builds) shows `updates: no news for N days`.
- **Off:** `[updates] check = false` in [config.toml](#configtoml), or `vimma.update.enabled` =
  `false` in `about:config`, stops every request, the message and the question. The status bar
  then shows a dim `updates: off` for a few seconds after startup, once per session, and hides
  it; `about:vimma` says checks are off at any time. A `config.toml` with errors never turns checks back on: its `check = false` still holds, and
  while Vimma runs on its defaults because of the errors, it does not check at all.

## Privacy defaults

Vimma starts quieter than Firefox: no studies, no sponsored content and no telemetry uploads.
None of this is locked; each default can be changed back in `about:config` (search for the
name, then toggle or edit it).

| Off in Vimma                                        | Turn it back on                                                                                                                                                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normandy studies and rollouts                       | `app.normandy.enabled` = `true`, `app.normandy.api_url` = `https://normandy.cdn.mozilla.net/api/v1`                                                                                                   |
| Nimbus studies and rollouts                         | `app.shield.optoutstudies.enabled`, `nimbus.rollouts.enabled` = `true` (studies also need `datareporting.healthreport.uploadEnabled`)                                                                 |
| Sponsored stories and shortcuts on the new tab page | `browser.newtabpage.activity-stream.showSponsored`, `…system.showSponsored`, `…showSponsoredTopSites`, `browser.topsites.contile.enabled`; stories: `…feeds.section.topstories` (or New Tab settings) |
| Sponsored address-bar suggestions                   | Settings: search for "sponsors" and tick "Suggestions from sponsors"                                                                                                                                  |
| Feature and add-on recommendations                  | `browser.newtabpage.activity-stream.asrouter.providers.cfr`: change `"enabled":false` to `true` in its JSON value; then `…asrouter.userprefs.cfr.addons`, `…cfr.features` = `true`                    |
| Mozilla promos (VPN, Relay, Pin, mobile)            | `browser.vpn_promo.enabled`, `browser.promo.relay.enabled`, `browser.promo.pin.enabled`, `browser.preferences.moreFromMozilla`                                                                        |
| Crash reporter                                      | Not built in. A crash leaves a local core dump (`coredumpctl list vimma`). Opt-in reporting to Vimma's own server is planned.                                                                         |
| Page titles in a private window's title             | `privacy.exposeContentTitleInWindow.pbm` = `true` (Vimma's default is `false`: the window manager, its bar and screen sharing see only `Vimma Private Browsing`)                                      |
| Telemetry upload                                    | Not built in (no official telemetry). The data-collection switches in Settings are off to match.                                                                                                      |

Kept as in Firefox: Remote Settings (CRLite certificate revocation, intermediate certificates),
the add-on blocklist, Firefox Sync, add-ons from addons.mozilla.org and their updates, and
Google Safe Browsing (see below). Firefox's app updater is not built into Vimma, and system add-on
updates are off, so neither asks Mozilla's update server for them; Vimma's own
[update check](#updates) asks `updates.vimma.dev` only. The one request Vimma still sends to
Mozilla's update server is for the OpenH264 and Widevine plugins, which video calls and DRM video
need.

Sites see Firefox 158's user agent, with no Vimma token, and add-ons see Firefox's version
(`runtime.getBrowserInfo()`), so Vimma is treated like Firefox. The About dialog shows Vimma's own
version; `vimma --version` and the start page show it with the Firefox release it is built on,
for example `Vimma X.Y.Z · Firefox N`.

### Safe Browsing

Google Safe Browsing is on by default, as in Firefox: Vimma downloads Google's lists of phishing,
malware and unwanted-software sites and warns before you open one. Your browsing stays local:
only when an address matches the local list does Vimma send Google a short hash prefix of it to
confirm.

Firefox's extra download checks (Google's lists of bad and known-good downloads, and its file
reputation service) are open only to Mozilla's own key, so Vimma does not use them: the "Block
dangerous downloads" box adds nothing beyond the site lists
([limits.md](limits.md#privacy-security-and-services)).

To turn Safe Browsing off: Settings → Privacy & Security → untick "Block dangerous
and deceptive content". In `about:config` that is `browser.safebrowsing.phishing.enabled` and
`browser.safebrowsing.malware.enabled` = `false`.

A Vimma you build yourself has Safe Browsing only if you build it with a Google API key
([runbook](runbook.md)). Without one it fetches no lists, and Settings shows the protection off.

Whether or not you use Safe Browsing, [uBlock Origin](https://ublockorigin.com/) from
addons.mozilla.org adds a second line of protection: in its dashboard → Filter lists, keep "uBlock filters
– Badware risks" on and tick the lists under "Malware protection, security" (Online Malicious URL
Blocklist, Phishing URL Blocklist). They block known malware and phishing sites without asking
any server about the pages you visit.

## Firefox behaviour Vimma changes

Vimma changes these Firefox defaults for workspaces; each one can be changed back in
`about:config`:

- **Closing the last tab keeps the window** and opens a new tab in the workspace, so a window
  never closes with other workspaces' tabs in it (`browser.tabs.closeWindowWithLastTab` =
  `false`).
- **No preloaded new tab page** (`browser.newtab.preload` = `false`): Firefox only uses it for
  tabs without a container, and every Vimma tab is in one.
- **Restart restores your session**: tabs, workspaces, pane layouts and scroll positions come
  back (`browser.startup.page` = `3`; Firefox's default `1` opens the home page).
- **Firefox Sync leaves two settings alone**: `browser.startup.page` and
  `privacy.userContext.enabled` (turning containers off deletes every workspace's data).

## Accessibility

Vimma's own parts (the status bar, the `ctrl+b ?` overlay, the pickers, the side and bookmarks
panels, the command line, prompts and notices, the start page and `about:vimma`) work with a
screen reader on top of Firefox's own accessibility support. On Linux that is Orca.

- **What each part says.** The overlay and the pickers are dialogs, their lists listboxes, and
  the bookmarks a tree with levels and open or closed folders; `j`/`k` move the focused row, so
  the screen reader reads each one as you move. Once you mark a tab in the side panel, its rows
  read as checked or not checked, and the count (`2 marked`) is said as it changes. The command
  line is a combobox with its completions, and an error in it is read at once. A `y/N` question
  is an alert dialog that reads the question; a rename prompt reads what it asks for.
- **Focus.** Each overlay, picker, panel and prompt takes focus when it opens and gives it back
  where it was when it closes (to the page you switched to, if you picked a tab).
- **What it announces, and what not.** The status bar is a status bar: your screen reader's
  "read status bar" command reads the mode, tab, title and URL, or move to it as a status
  element. It never announces titles or URLs as they change. It says the mode when it
  changes into normal, insert, visual, hint or resize mode; help, command and panel mode are
  said by the dialog, line or list that takes focus. "Pattern not found" is said once after a
  search. Notices are read politely; errors (a blocked URL, an add-on or bookmark that failed)
  are read at once. The same notice twice in a row is read once.
- **Link hints** are labels drawn over the page, hidden from screen readers; hint mode is
  announced. On a page with a screen reader, its own link navigation may serve better.
- **Contrast.** All text Vimma draws reaches WCAG AA (4.5:1) in both variants of the built-in
  Vimma palette, in the built-in Tokyo Night palette and in light themes: secondary and coloured
  text is darkened or lightened just enough on the theme's backgrounds, so a theme keeps its
  colours where they already read. A `[theme.colors]` foreground you set yourself is used as is,
  with a warning in `about:vimma` when it falls short. Focus rings, and the border of the
  focused pane in a split, reach 3:1 against the chrome around them.
- **Motion.** Nothing in Vimma's own UI animates, so there is nothing for
  `prefers-reduced-motion` to turn off.
- **Every key is remappable** for motor needs: the prefix, the leader and any binding, including
  one-key bindings that avoid chords and the `ctrl+b` prefix altogether. See
  [Every key is yours](#every-key-is-yours) and [config.toml](#configtoml).

## FAQ and troubleshooting

**Vimma says the profile was used by a newer version and refuses to start.** Profiles remember
the version that last used them, and a build refuses a profile that a newer build has used, as
Firefox does. Give each build its own `--profile`, or start with `--allow-downgrade` if you
accept the risk.

**Does Safe Browsing protect me?** Yes, in builds made with a Google API key, where it is on by
default (see [Safe Browsing](#safe-browsing)). A build without a key fetches no phishing or
malware lists; Settings then shows "Block dangerous and deceptive content" unticked, and ticking
it does not help. Mozilla's tracking-protection lists update either way.

**Does Vimma update itself?** No. Install each new release yourself ([Installing](#installing));
from 0.1.2 on, Vimma's update check tells you when one is out and how to install it
([Updates](#updates)). Vimma 0.1.1 shows no notice: update it once by hand.
Vimma notifies you and shows the command; it does not install updates itself.
Firefox's updater is not built into Vimma, so it never asks Mozilla's update server
(`aus5.mozilla.org`) for a Firefox build.

**I want the tab strip back.** Set `vimma.ui.tabstrip.hidden` to `false` in `about:config`.

**The Browser Toolbox (`ctrl+alt+shift+i`) does nothing, and the Browser Console has no input
line.** Vimma ships Firefox's release defaults for the developer tools: the page's own tools work,
but the tools that run code with the browser's full privileges are off. Code typed there can read
every file, cookie and password the browser can, so a page that asks you to paste something into
the console is a scam. To turn them on deliberately, set `devtools.chrome.enabled` and
`devtools.debugger.remote-enabled` to `true` in `about:config`. When you are done, set them back
to `false` and reset `devtools.selfxss.count` (its reset button in `about:config`): opening a
console while they are on turns the paste warning off for good. The Browser Toolbox still asks
before it connects. A build started with `npm start` has them on.

**"List all tabs" is missing.** Firefox shows it only when the tab strip is visible. Show the
strip, or move the "List all tabs" button to the toolbar in customize mode, or use Vimma's
[tab search](#tab-search-and-tab-rename) (`ctrl+b g`).

**I don't see window controls.** On tiling window managers such as Hyprland there are none, as in
Firefox. On GNOME or KDE with client-side decorations they move to the navigation bar.

**Did `ctrl+b` stop opening bookmarks?** Yes, it is Vimma's prefix. `ctrl+b shift+b`
opens Vimma's [bookmarks panel](#bookmarks), and `ctrl+b a` bookmarks the page.
Firefox's Library (`ctrl+shift+o`) still works for the rest.

**A binding says "not implemented yet".** The message is for a binding whose command does not
exist; every default binding has one. The overlay dims such a binding too.

**Does a playing video keep the screen awake?** Yes, while the video's window is visible. On
Linux, Vimma asks the Wayland compositor directly (its idle-inhibit protocol) instead of
Firefox's D-Bus route, which on Hyprland (Omarchy) reports success without stopping the
screensaver. On Hyprland, `hyprctl -j clients | jq '.[] | select(.class|test("vimma")) |
.inhibitingIdle'` prints `true` while it holds. A `MOZ_WAKE_LOCK_TYPE` you export yourself wins
over Vimma's choice.

**Where are crash reports?** Nothing is sent anywhere. Use `coredumpctl list vimma`, then
`coredumpctl info` on the entry.
