<p align="center">
  <img src="docs/assets/vimma-social.png" alt="Vimma, Vim and Tmux inspired: a keyboard-first browser for people who live in the terminal. vimma.dev, for Linux and macOS." width="800">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MPL--2.0-123532?labelColor=071011" alt="MPL-2.0 licence" /></a>
  <a href="https://github.com/vimma-browser/vimma/stargazers"><img src="https://img.shields.io/github/stars/vimma-browser/vimma?labelColor=071011&color=123532&logo=github" alt="GitHub stars" /></a>
  <a href="https://github.com/vimma-browser/vimma/actions/workflows/ci.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/vimma-browser/vimma/ci.yml?branch=main&label=ci&labelColor=071011&color=123532" alt="CI status on main" /></a>
  <a href="surfer.json"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fvimma-browser%2Fvimma%2Fmain%2Fsurfer.json&query=%24.version.version&label=firefox&labelColor=071011&color=123532&logo=firefoxbrowser" alt="Firefox version Vimma is built on" /></a>
  <a href="https://github.com/vimma-browser/vimma/releases/latest"><img src="https://img.shields.io/github/v/release/vimma-browser/vimma?label=release&labelColor=071011&color=2cf5d2" alt="Latest release" /></a>
  <a href="https://github.com/vimma-browser/vimma/releases"><img src="https://img.shields.io/github/downloads/vimma-browser/vimma/total?labelColor=071011&color=123532" alt="Total downloads" /></a>
</p>

# Vimma

**A keyboard-first browser for people who live in Vim and tmux.** You already have the muscle
memory; Vimma puts it to work on the web. Bare keys drive the page, `ctrl+b` drives tabs, panes
and workspaces, and your hands never leave the keyboard.

- **Vim on the page:** `j`/`k` to scroll, `f` for link hints, `/` to find, `:` for commands, and
  `Esc` to get back to normal mode. Copy a paragraph, list item or code block in three keys: `F`,
  its label, then `y` (or `v` to adjust it first).
- **tmux for the window:** `ctrl+b`, tmux's default prefix, then `c` for a new tab, `v` to split,
  `w` to switch workspace. If your fingers know tmux, they already know Vimma.
- **Every key is yours:** every binding, the prefix and the leader can be remapped in
  `config.toml`, Firefox's own keys too: every Firefox shortcut is a Vimma binding with
  Firefox's meaning, listed in `ctrl+b ?`, and `:firefox <id>` runs any other Firefox command.
- **Local AI agents, kept apart:** Claude Code, Codex, opencode and Copilot reach Vimma through
  MCP (`vimma-ctl mcp`), only in an agent workspace with its own cookies. An agent asks you
  first, and one answer (`a`) lets an agent work through its task until it quits. There
  they read and open pages, scroll, search and follow links with Vimma's own keys, click buttons
  and fill forms by hint label (never a password or payment card field), see a page as a
  screenshot, read its errors, and show you a page when they want you to look at it. Sending a
  form and paying are checkpoints, asked every time under any grant: the question shows what the
  form sends, or the button, the site and the total the page states.
- **An agent of its own:** `ctrl+b i` opens a chat window where you write a task and watch every
  step, with a local model (Ollama, LM Studio, llama.cpp), a hosted one by API key, or the
  Claude Code you already have, on its own login and plan. It works only in the agent
  workspace, through the same tools and checkpoints as an MCP agent; several conversations can
  run at once, and they are kept, encrypted, without the page text they read.

## Install

Vimma runs on Linux x86_64 and on macOS 15 or later with Apple Silicon. Download the files from the
[latest release](https://github.com/vimma-browser/vimma/releases/latest).

**Arch Linux:** run this as your normal user (not root), from any directory. It builds in
`~/.cache/vimma-build`, and the same command updates Vimma.

```sh
mkdir -p ~/.cache/vimma-build && cd ~/.cache/vimma-build && curl -fLO https://github.com/vimma-browser/vimma/releases/latest/download/PKGBUILD && makepkg -si
```

**macOS, with Homebrew:** install from Vimma's own tap; `brew upgrade --cask vimma` updates it.

```sh
brew install --cask vimma-browser/tap/vimma
```

A release that is not notarised (the guide says how to tell) makes macOS block the first open
("Apple could not verify “Vimma”"): choose **Done**, then in System Settings → Privacy & Security
choose **Open Anyway** next to Vimma. Without Homebrew, open `vimma-X.Y.Z-macos-aarch64.dmg` and drag Vimma to Applications.
The guide's [macOS](docs/guide.md#macos) section has the steps and a one-line terminal
alternative.

**Debian 12+, Ubuntu 22.04+:** download `vimma_X.Y.Z_amd64.deb`, then
`sudo apt install ./vimma_X.Y.Z_amd64.deb`.

**Fedora, openSUSE:** download `vimma-X.Y.Z-1.x86_64.rpm`, then
`sudo dnf install ./vimma-X.Y.Z-1.x86_64.rpm` on Fedora, or
`sudo zypper install --allow-unsigned-rpm ./vimma-X.Y.Z-1.x86_64.rpm` on openSUSE. The package
carries no OpenPGP signature; check it with `SHA256SUMS` and cosign instead, as the guide shows.

**Any other distribution:** download `vimma-X.Y.Z-x86_64.AppImage`, then
`chmod +x vimma-X.Y.Z-x86_64.AppImage && ./vimma-X.Y.Z-x86_64.AppImage`.

`X.Y.Z` is the Vimma version. To update, install the newer release the same way. From 0.1.2 on,
the status bar says when a new release is out and `:update` shows the command for your install;
Vimma 0.1.1 does not, so update it once by hand
([Updates](docs/guide.md#updates)). The guide's [Installing](docs/guide.md#installing) section has the tarball
and how to verify a download with `sha256sum` and cosign.

## Why

The browser is the one daily tool that ignores Vim and tmux habits. Vimma brings them to a Firefox
base you can trust: sites and add-ons work as they do in Firefox, with quieter privacy defaults.
Each workspace is a container of its own, so work logins stay out of personal ones, and the
window can follow your desktop theme. [See everything it does](docs/guide.md#features-at-a-glance).

## The name

_Vimma_ is Finnish for a burst of eager, focused energy, as in _työvimma_, a spell of work where
the hours slip by. It also happens to start with _Vim_.

## Status

Early, for Linux x86_64 and macOS on Apple Silicon. Releases are on
[GitHub Releases](https://github.com/vimma-browser/vimma/releases), with a tarball, an AppImage, a
`.deb`, an `.rpm` for Fedora and openSUSE and an Arch Linux `PKGBUILD`, and a macOS `.dmg` that also installs as a Homebrew cask
([Install](#install)). Each carries `vimma-ctl`, the client for scripts and agents, so it updates
with the browser ([where it is](docs/guide.md#installing)); you can also
[build Vimma from source](CONTRIBUTING.md#build-and-run). Update notices are live: Vimma 0.1.2 and
later check a signed update file every 12 hours and show a newer release in the status bar. The
AppImage, from the first release that includes its self-update, then replaces its own file with
the newer release once its size and SHA-512 match the signed file, and the next start runs it.
The other packages notify only; installing the update is up to you. Vimma's chat window runs
Claude Code from 0.1.13, on its own login
([quick start](docs/guide.md#using-an-agent-cli-in-the-chat-window)); Codex follows.

Roadmap: <https://github.com/orgs/vimma-browser/projects/1>

AI coding agents working on this repository follow [AGENTS.md](AGENTS.md); contributors read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening issues or pull requests.
<!-- process-wording: points coding agents at their rules file -->

## Licence

[MPL-2.0](LICENSE), like Firefox; the vendored [smol-toml](https://github.com/squirrelchat/smol-toml) parser is BSD-3-Clause ([ADR-012](docs/adr/012-toml-parser-smol-toml.md)).

## Acknowledgements

[Vim](https://www.vim.org/) and [tmux](https://github.com/tmux/tmux), the models; [Firefox](https://www.mozilla.org/firefox/), underneath; [Surfer](https://github.com/zen-browser/surfer) and [Zen Browser](https://zen-browser.app/), the toolchain; [Herdr](https://herdr.dev/), the `[keys]` syntax; [Omarchy](https://omarchy.org/), the themes; [Tridactyl](https://github.com/tridactyl/tridactyl) and [Vimium](https://github.com/philc/vimium), prior art.
