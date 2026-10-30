# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer. Changes that are not released yet are listed under `[Unreleased]`, written by hand. Each release's entry gives those lines first (`-` items), then the list release-please writes from the Conventional Commits on `main` (`*` items) ([docs/runbook.md](docs/runbook.md), Releases).

## [Unreleased]

### Added

- Vimma's own agent runs Claude Code: in the chat window, `Esc`, `m`, then `add: agent CLI (Claude Code)` finds the `claude` on your `PATH`, and tasks you write in Vimma run on Claude Code's own login and plan, with no API key and no terminal. In the browser it reaches only the agent workspace, through the same tools, grants and checkpoints as any agent; its own shell, file and web tools stay under its own settings, and the window lists them and marks each use. The picker lists Claude Code's models (`sonnet`, `opus`, `haiku`, its default, or another by name) to switch with `Enter` or keep with `D`; the cost Claude Code reports stays on the task's last line as its estimate. Agent CLIs are on by default; `vimma.agent.cli.enabled` in `about:config` turns them off.
- Link hints: in `gF`'s hints, typing the label's last character in upper case (`sD` instead of `sd`) opens the link in a new tab and switches to it; lower case still opens it in the background. Shift (or Caps Lock) on that last key no longer opens in the background as it did before. While `gF`'s labels are up, the status bar shows both choices with a label you can type, such as `sd background · sD go there`. A new action, `follow_link_new_tab_fg` (`hint.follow_new_tab_fg`), starts hints that always switch; it has no default key and can be bound in `config.toml`. The help overlay and its snapshots list the new action as unbound, and the new e2e baseline `follow-link-switch-hints` shows the status bar in `gF`'s hint mode.

## [0.1.12](https://github.com/vimma-browser/vimma/compare/v0.1.11...v0.1.12) · Firefox 159.0 (2026-10-30)


### Added

- Vimma's own agent: `ctrl+b i` (or `:agent`) opens a chat window where you write a task, watch every step in a plain-text transcript, add instructions or stop it. It runs a model you pick, a local one (Ollama, LM Studio, the llama.cpp server) or a hosted one (Anthropic, or an OpenAI-compatible endpoint, with its API key kept encrypted in login storage). Models are set up in the window's picker, which also switches a conversation's model, or under `[agent]` and `[[agent.providers]]` in `config.toml`, where `local_only`, `max_running` and `keep_days` also live; a refused `config.toml` is named in the window. The agent works only in the agent workspace, through the same tools, grants and checkpoints as an MCP agent. Sending with `Enter` lets the conversation act without asking at each step, `ctrl+Enter` asks at every step, and sending a form or paying always asks in the window. Several conversations run at once, each on its own tabs, with step and token limits, and they are kept across restarts, encrypted, without the page text they read. The help overlay and its snapshots list the new key, `agent_chat` in the Agents group.
- Agents (MCP): `vimma_open`, `vimma_activate` and `vimma_fill` take `elements: true` and return the page's element list with the step, so an action and the next look are one call. Screenshots default to at most 1024 px, PNG or JPEG, whichever is smaller; `full: true` gives the full-size image.

* **agent:** a local model prunes older results rarely, a hosted one at 6 ([#632](https://github.com/vimma-browser/vimma/issues/632)) ([cfa6793](https://github.com/vimma-browser/vimma/commit/cfa6793ad2e091478af8bd980881b2cbad189d3e))
* **agent:** a model loop and provider adapters in vimma-core ([#585](https://github.com/vimma-browser/vimma/issues/585)) ([b013457](https://github.com/vimma-browser/vimma/commit/b013457abc8b50710c7dd6fd3e9359f2fc9ed8da))
* **agent:** a model test bench on a local fixture shop ([#590](https://github.com/vimma-browser/vimma/issues/590)) ([3bceaaf](https://github.com/vimma-browser/vimma/commit/3bceaafab142c3e7dd970cbe8cd6cb23fc4e1204))
* **agent:** conversations kept across restarts ([#620](https://github.com/vimma-browser/vimma/issues/620)) ([b8aa1c3](https://github.com/vimma-browser/vimma/commit/b8aa1c33000494f25963a86aaa8dbb5ddff6b6d9))
* **agent:** older page content leaves the agent's context ([#629](https://github.com/vimma-browser/vimma/issues/629)) ([9646b31](https://github.com/vimma-browser/vimma/commit/9646b3113b7ea5cc7f690b82e2888e8241fb1f26))
* **agent:** switch the chat window model from its picker ([#644](https://github.com/vimma-browser/vimma/issues/644)) ([b7ca66c](https://github.com/vimma-browser/vimma/commit/b7ca66ca1c7dcaa4d896a888bc15282c29ffe56d))
* **agent:** the built-in agent's gate connections, providers and key storage ([#595](https://github.com/vimma-browser/vimma/issues/595)) ([b72f466](https://github.com/vimma-browser/vimma/commit/b72f466f9bfb9366e1f3ed9c4a8b188011388b62))
* **agent:** the chat window ([#608](https://github.com/vimma-browser/vimma/issues/608)) ([140968e](https://github.com/vimma-browser/vimma/commit/140968efeff4b78d08d1acf89542461b120ac736))
* **ctl:** one-time tickets bind a vimma-ctl connection to a conversation ([#633](https://github.com/vimma-browser/vimma/issues/633)) ([fcc7efb](https://github.com/vimma-browser/vimma/commit/fcc7efbe2f76bd89d40e35126034a77b3ff44c9c))
* **keys:** a key opens the agent chat window ([adbe2e2](https://github.com/vimma-browser/vimma/commit/adbe2e2796220a354d5176e83c58f4f832e0e854))
* **mcp:** agents open a site's search results by url ([#616](https://github.com/vimma-browser/vimma/issues/616)) ([5301d81](https://github.com/vimma-browser/vimma/commit/5301d81b3e032c3b2f276ffc73ff67528cd9faca))
* **mcp:** compact element lists ([#621](https://github.com/vimma-browser/vimma/issues/621)) ([16df595](https://github.com/vimma-browser/vimma/commit/16df595a6bbbc6bbdb2ceb77c7897c3fc4a6d375))
* **mcp:** steps return the page's element list; smaller screenshots ([#588](https://github.com/vimma-browser/vimma/issues/588)) ([af4dca5](https://github.com/vimma-browser/vimma/commit/af4dca5164bf43efcd886a6134efba5a47274aa0)), closes [#584](https://github.com/vimma-browser/vimma/issues/584)


### Fixed

- Agents (MCP): pages that send a `Cross-Origin-Opener-Policy` header open in agent tabs instead of failing with `NS_ERROR_DOM_COOP_FAILED`. Agent tabs keep their pop-up sandbox; such pages lose only `crossOriginIsolated` there ([docs/limits.md](docs/limits.md)).
- Agents (MCP): a step that lands on Firefox's error page is reported to the agent as an error naming the reason, instead of a success with an empty element list, so an agent no longer opens the same failing page again and again.
- Workspaces: tab search and the side panel no longer lose a window's tabs after the last window is closed and a new one opened (on macOS, from the Dock), or after a session restore that stops partway; until a restart they listed one tab while the status bar counted them all. The `:bug` report now shows the open tabs beside the workspaces' count and names a restore that never finished.

* **agent:** agent tabs load pages that send an opener policy ([#645](https://github.com/vimma-browser/vimma/issues/645)) ([f6cd389](https://github.com/vimma-browser/vimma/commit/f6cd38943e3cc87fbe6ae70e7d38ce4c2ab7992b)), closes [#640](https://github.com/vimma-browser/vimma/issues/640)
* **agent:** an open that ends on firefox's error page is an error naming it ([#651](https://github.com/vimma-browser/vimma/issues/651)) ([5f9710b](https://github.com/vimma-browser/vimma/commit/5f9710bfc04acc47c0380e6a0e2bc7ee470c3d1e)), closes [#643](https://github.com/vimma-browser/vimma/issues/643)
* **agent:** the api key field never reveals the key ([#627](https://github.com/vimma-browser/vimma/issues/627)) ([1ac8c22](https://github.com/vimma-browser/vimma/commit/1ac8c22c54a719bc5726373b603b0549535220b8))
* **agent:** the chat header says "asks every step" only after ctrl+enter ([#641](https://github.com/vimma-browser/vimma/issues/641)) ([846e2db](https://github.com/vimma-browser/vimma/commit/846e2db2c5e1e4830d50520ba17a528a5a03abd6)), closes [#535](https://github.com/vimma-browser/vimma/issues/535)
* **agent:** the chat window names a refused config.toml instead of "no model set up" ([#642](https://github.com/vimma-browser/vimma/issues/642)) ([20a341a](https://github.com/vimma-browser/vimma/commit/20a341a1d9b42b06b20315ad4d024f46070fcaab)), closes [#639](https://github.com/vimma-browser/vimma/issues/639)
* **mcp:** a rate refusal names its limit and when the next call is allowed ([#594](https://github.com/vimma-browser/vimma/issues/594)) ([522071d](https://github.com/vimma-browser/vimma/commit/522071de086f09f84f19e0cf6016ef7c6bf26333)), closes [#592](https://github.com/vimma-browser/vimma/issues/592)
* **mcp:** element labels last while their page and element do ([#593](https://github.com/vimma-browser/vimma/issues/593)) ([1a5fb29](https://github.com/vimma-browser/vimma/commit/1a5fb29be709fd7810faf86f0f4535f9d07c8fde)), closes [#591](https://github.com/vimma-browser/vimma/issues/591)
* **workspaces:** the tab list survives a restore that never finishes ([#631](https://github.com/vimma-browser/vimma/issues/631)) ([d6544b3](https://github.com/vimma-browser/vimma/commit/d6544b39c76e23c362c9e44c6d12bd88dcf01b24)), closes [#630](https://github.com/vimma-browser/vimma/issues/630) [#546](https://github.com/vimma-browser/vimma/issues/546)


### Changed

- Agents (MCP): a label from `vimma_elements` stays valid for as long as its page and element do, instead of expiring after 120 seconds, so a slow model's clicks and fills are no longer refused; labels drawn on a screenshot still expire after 120 seconds.
- Agents (MCP): element lists are shorter. The explanation that every list repeated is in the `vimma_elements` description, sent once, and a list of a page on a site already listed leaves out the elements identical to the earlier list and names their labels, which still work (`full: true` lists every element). `vimma_elements`, and `elements: true` on `vimma_open`, `vimma_activate` and `vimma_fill`, take `query` and `kinds` filters.
- Agents (MCP): an agent over a per-minute limit is told which limit it hit, that no question is waiting, and how long to wait, instead of a message saying questions are waiting.
- Agents (MCP): clicks and fills wait only while the page is busy instead of a fixed second; a fill without a submit returns at once, and a page counts as ready before its slow images finish. Sending a form or paying is caught exactly as before.

* **mcp:** agent clicks and fills wait only while the page is busy ([#582](https://github.com/vimma-browser/vimma/issues/582)) ([6f858f1](https://github.com/vimma-browser/vimma/commit/6f858f12a965d30e15b7e805ec46036046351fd0)), closes [#579](https://github.com/vimma-browser/vimma/issues/579)

## [0.1.11](https://github.com/vimma-browser/vimma/compare/v0.1.10...v0.1.11) · Firefox 159.0 (2026-10-28)


### Added

- Control socket: `vimma-ctl state` reports a `loading` flag for each tab, true while the tab is busy, a document is loading, or a new window has not yet started to load its first page. It names no page, so a private window's tabs carry it too.

* **mcp:** one approval lasts the agent's whole session ([#581](https://github.com/vimma-browser/vimma/issues/581)) ([796a266](https://github.com/vimma-browser/vimma/commit/796a266844bd440b7a68976822fe97e1fbec66af)), closes [#578](https://github.com/vimma-browser/vimma/issues/578)


### Fixed

- macOS: back, forward, the tab digits and the address bar have Firefox's macOS keys, `cmd+left` / `cmd+right` and `cmd+[` / `cmd+]`, `cmd+1` to `cmd+9` and `cmd+l`, in place of the Linux defaults `alt+left`, `alt+right`, `alt+1` to `alt+9` and `alt+d`, which never ran on a Mac because Option types characters there. Linux keeps its keys. A new help snapshot holds the macOS keymap, and the `defaults.toml` snapshot lists the macOS keys as comments under `[keys]`.
- Find: on Firefox 160, `n` and `N` in a PDF keep the find bar closed, so the focus stays on the page and the next `N` moves to the previous match instead of typing into the bar.
- Updates: an installed release no longer offers itself as a security update. Release builds now keep one build ID from the binary to the packaged `application.ini`, and Vimma never offers the version it runs, dropping a saved offer of it at startup.
- Private windows: closing a private window in any way brings the normal window back on the closed window's workspace. When Hyprland reported the close before the window's unload ran, the normal window could land on the active workspace instead.
- Workspaces: a workspace could lose its tab list (tab search and the side panel showing one "New Tab") while its tabs stayed open, when a restore into the window ended with a workspace rebuild that failed partway. The rebuild now replaces the window's model only once it is complete, a failed one keeps the current model, and selecting a tab the model does not know puts it back.
- Releases: publishing a release now starts the Homebrew tap update whenever the macOS cask is already on the release, so `brew upgrade --cask vimma` finds new releases. Releases 0.1.9 and 0.1.10 had missed the tap because their macOS files reached the draft before it was published; 0.1.10 was pushed to the tap by hand.
- Releases: publishing a release now tells vimma.dev at once, so the site no longer waits for its scheduled sync to show it. The workflow authenticates as the GitHub App `vimma-site-dispatch`; the token secret it used before was never set, so no release or bindings change had reached the site.

* **e2e:** m3-private-workspace waits for the private start page to load ([#568](https://github.com/vimma-browser/vimma/issues/568)) ([5897b09](https://github.com/vimma-browser/vimma/commit/5897b09d814320734a02f58d1280ca30db9e9d1c)), closes [#567](https://github.com/vimma-browser/vimma/issues/567)
* **find:** n and N in a pdf keep the find bar closed on firefox 160 ([#560](https://github.com/vimma-browser/vimma/issues/560)) ([a1f5be8](https://github.com/vimma-browser/vimma/commit/a1f5be87131e4a64ceaf048b834bb5a5560fc12b)), closes [#548](https://github.com/vimma-browser/vimma/issues/548)
* **grep:** a step that ends after grep reopens leaves the new search alone ([71c0117](https://github.com/vimma-browser/vimma/commit/71c01175f3030ccf5701a173d3a524fffc1075dc))
* **keys:** the default alt keys are firefox's cmd keys on macos ([50f067c](https://github.com/vimma-browser/vimma/commit/50f067cb882a080fa3d33d0a6f717402861d5cd2))
* **private:** a close read before the unload brings the normal window back to its workspace ([#559](https://github.com/vimma-browser/vimma/issues/559)) ([33ecab0](https://github.com/vimma-browser/vimma/commit/33ecab02f0ce1d5a684bbc921bfb55315cb0345f)), closes [#554](https://github.com/vimma-browser/vimma/issues/554)
* **private:** a close read during the swap back keeps the record its rescue needs ([#571](https://github.com/vimma-browser/vimma/issues/571)) ([8fbcd35](https://github.com/vimma-browser/vimma/commit/8fbcd3591ee7bf49ce9b3be8dd867d3f9435054b)), closes [#570](https://github.com/vimma-browser/vimma/issues/570)
* **release:** start the homebrew tap update when a release is published ([#553](https://github.com/vimma-browser/vimma/issues/553)) ([49061ab](https://github.com/vimma-browser/vimma/commit/49061ab31b59bf44498c1fb05facf365f1f577c0))
* **update-publish:** give the manifest push's rebase a git identity ([7afddf3](https://github.com/vimma-browser/vimma/commit/7afddf3ed8d4ae5a984ba22fd936e185c7b2b446)), closes [#530](https://github.com/vimma-browser/vimma/issues/530)
* **update-publish:** give the manifest push's rebase a git identity ([#558](https://github.com/vimma-browser/vimma/issues/558)) ([7afddf3](https://github.com/vimma-browser/vimma/commit/7afddf3ed8d4ae5a984ba22fd936e185c7b2b446))
* **updates:** a release no longer offers itself as an update ([#565](https://github.com/vimma-browser/vimma/issues/565)) ([ab0525b](https://github.com/vimma-browser/vimma/commit/ab0525b62bb8ee695268c7d237283d00d835cb63)), closes [#563](https://github.com/vimma-browser/vimma/issues/563)
* **workspaces:** a failed rebuild keeps the window's tabs ([#547](https://github.com/vimma-browser/vimma/issues/547)) ([273946d](https://github.com/vimma-browser/vimma/commit/273946d0e3dec010610a0aa16b1aae11c8135dcf)), closes [#546](https://github.com/vimma-browser/vimma/issues/546)

## [0.1.10](https://github.com/vimma-browser/vimma/compare/v0.1.9...v0.1.10) · Firefox 159.0 (2026-10-27)


### Changed

- Keys: on Firefox 159, `ctrl+shift+a` is Firefox's tab search key, so it opens Vimma's tab search (as `ctrl+b g` does), and the add-ons manager moves to Firefox's new `ctrl+shift+f`. The help and `defaults.toml` snapshots change with the two keys.
- Tests: the `m3-private-workspace` e2e baseline is redrawn from the current start page, which now shows the bookmarks hint and the running Vimma and Firefox versions. The old image dated from Vimma 0.1.2 on Firefox 158, and the longer `0.1.10` version string pushed the difference past the 0.5 % limit.

* Firefox 159.0 ([MFSA 2026-118](https://www.mozilla.org/en-US/security/advisories/mfsa2026-118/)) ([#550](https://github.com/vimma-browser/vimma/issues/550)) ([d48d3f3](https://github.com/vimma-browser/vimma/commit/d48d3f3cbefbdbf35dfcc564888d962caa72b1a7))

## [0.1.9](https://github.com/vimma-browser/vimma/compare/v0.1.8...v0.1.9) · Firefox 158.0.1 (2026-10-23)


### Added

- Agents (MCP): sending a form and paying are checkpoints. Under any grant they ask with `y` and `n` only, marked `▲` in the theme's warning colour, and the agent goes on under its grant after either answer. A step pays when the page shows a payment card field (also in a payment provider's frame) or the pressed button or followed link says it pays (`Pay now`, `Place order`, `Vahvista tilaus`, … in six languages), also a button that sends no form; its question names the button, the site and the total the page states (`▲ claude-code wants to pay: "Vahvista tilaus" on shop.example · the page says "Yhteensä 42,90 €"`), and a button in a payment provider's frame of another site names that site, then the shop's (`on pay.provider.example (in shop.example)`). A form's question lists each field it sends with its value, a password as `•••`, hidden fields counted. A yes shows `allowed payment on shop.example` or `allowed sending the form to example.com`. The grant's hint is `y once · 10a 10 min · n deny · x mute`, so that a usual question fits one line at 1,280 pixels, and the grant's notice says that sending a form or paying still asks. The e2e baselines `m0-mcp-stdio-question`, `m0-mcp-drive-keys-question`, `m0-mcp-forms-fill-question` and `m0-mcp-forms-submit-question` change with the shorter hint and the form question, and `m0-mcp-checkpoints-basket-ran`, `m0-mcp-checkpoints-pay-question`, `m0-mcp-checkpoints-card-question`, `m0-mcp-checkpoints-hosted-question` (a payment provider's pay button in a frame of another site) and `m0-mcp-checkpoints-hosted-allowed` (the notice at its yes) are new.
- Releases: `vimma-ctl` ships in every package (the tarball, the AppImage, the `.deb`, the `.rpm`, the PKGBUILD and the macOS app with its Homebrew cask), so each update replaces it together with Vimma. A `vimma-ctl` older than Vimma keeps the tools it knows: `vimma-ctl mcp` tells the agent it is older, and Vimma shows a one-line notice once per client and version.
- Release packages carry the licence notices of what vimma-ctl links (Rust's standard library, musl, LLVM's libunwind) in `vimma-ctl-licenses/`, and the release SBOM lists vimma-ctl with them.

* **mcp:** paying and sending a form are checkpoints ([#522](https://github.com/vimma-browser/vimma/issues/522)) ([c2dadf6](https://github.com/vimma-browser/vimma/commit/c2dadf62faede2bdf84a1c7fccb335d62490f950)), closes [#508](https://github.com/vimma-browser/vimma/issues/508)
* **release:** packages carry vimma-ctl's licence notices and the sbom lists it ([#528](https://github.com/vimma-browser/vimma/issues/528)) ([5e26f06](https://github.com/vimma-browser/vimma/commit/5e26f0681fcc29323ca4aed8aba65033fe4c6643))
* **release:** ship vimma-ctl in every package, and an older vimma-ctl says it is older ([#517](https://github.com/vimma-browser/vimma/issues/517)) ([5741ea7](https://github.com/vimma-browser/vimma/commit/5741ea7b000f9d46f9f54ec286e4765981a3de06))


### Fixed

* **mcp:** a one-line grant hint, an honest yes notice and a framed pay button's site ([#526](https://github.com/vimma-browser/vimma/issues/526)) ([cd5d275](https://github.com/vimma-browser/vimma/commit/cd5d275642f453248c35e16088ad3a3357f0f52c)), closes [#525](https://github.com/vimma-browser/vimma/issues/525)

## [0.1.8](https://github.com/vimma-browser/vimma/compare/v0.1.7...v0.1.8) · Firefox 158.0.1 (2026-10-22)


### Added

- macOS: the private workspace takes the Vimma window's place, as on Hyprland: the private window opens at the normal window's frame with window animations turned off and the normal window is hidden until you switch back, close the private window or open a link from another app. A window in full screen is never hidden; `[private] placement = "window"` opts out. The `defaults.toml` snapshot's `[private]` comment names macOS.
- Agents (MCP): one answer covers a task. `10a` lets that agent use every tool for 10 minutes, not only the one it asked about; sending a form, showing a page and a dangerous or unscanned download still ask. The question's hint reads `y once · 10a 10 min, all but forms · n deny · x mute`, the grant's notice names what still asks and that `ctrl+b shift+a` ends it, and `ctrl+b shift+a` with nothing waiting now ends every grant at once. The e2e baselines `m0-mcp-stdio-question`, `m0-mcp-drive-keys-question` and `m0-mcp-forms-fill-question` change with the hint.

* **keys:** a firefox key inventory for macos ([f46e554](https://github.com/vimma-browser/vimma/commit/f46e554e3b077f26aed7800697eaddde73a487c9))
* **mcp:** one grant covers every agent tool of its connection ([#515](https://github.com/vimma-browser/vimma/issues/515)) ([e4273b9](https://github.com/vimma-browser/vimma/commit/e4273b903138c46402cba24a2b887df050bbb032))
* **private:** swap in place on macos ([202e260](https://github.com/vimma-browser/vimma/commit/202e2603622fd93199e317c380d1f3aa253f7167))


### Fixed

* **keys:** hint, copy and element mode keep y and n from a waiting question ([#521](https://github.com/vimma-browser/vimma/issues/521)) ([423b0c0](https://github.com/vimma-browser/vimma/commit/423b0c03fc13360c9eb81a61ac577c13ae5ccb73)), closes [#495](https://github.com/vimma-browser/vimma/issues/495)
* **mcp:** agent clicks, fills and lists no longer race a busy content process ([df1c20c](https://github.com/vimma-browser/vimma/commit/df1c20c7692910b55d6480ecc130ae660e906e3e))
* **mcp:** an agent step's load wait passes over an initial about:blank ([#520](https://github.com/vimma-browser/vimma/issues/520)) ([fc39dfd](https://github.com/vimma-browser/vimma/commit/fc39dfde27ddd9b1e498f7ec5c02fbcf363c26c5))
* **mcp:** read clamd's socket owner on macOS with lstat ([d83cdc2](https://github.com/vimma-browser/vimma/commit/d83cdc2c6208ad753227dfd267169248db1242ce))
* **mcp:** the child's submit-check test hook works only in automation ([947178f](https://github.com/vimma-browser/vimma/commit/947178f802a8d8eac813412b4b8cbecbf8f3f34f))
* **mcp:** vimma_activate says what a click changed in place ([#514](https://github.com/vimma-browser/vimma/issues/514)) ([c39fc4b](https://github.com/vimma-browser/vimma/commit/c39fc4b5b7146b4f6ecb4c046818494d73238783)), closes [#510](https://github.com/vimma-browser/vimma/issues/510) [#513](https://github.com/vimma-browser/vimma/issues/513)
* **update:** check the shape of github's responses before reading labels ([#519](https://github.com/vimma-browser/vimma/issues/519)) ([27b58a1](https://github.com/vimma-browser/vimma/commit/27b58a1fba2e0f9cd6bd092d4b23075eff0ae5ac))
* **update:** retry transient gh failures when reading commit labels ([50a061b](https://github.com/vimma-browser/vimma/commit/50a061b4a7e38e7896c5f40164a336863a1b656f))

## [0.1.7](https://github.com/vimma-browser/vimma/compare/v0.1.6...v0.1.7) · Firefox 158.0.1 (2026-10-22)


### Added

- `:restart` restarts Vimma with its tabs, asking first while private tabs are open; an AppImage restarts into the file it replaced. Once a security update is installed, Vimma asks once per session, and again a day later, `Security update 0.3.1 is ready. Restart now? Tabs come back. (y/N)`, and its status-bar segment reads `⇡ 0.3.1 security: :restart`. The help snapshot gains the unbound `restart` row.
- Element focus: a text block chosen with `:focus_element` (or a key bound to `focus_element`) is in the new `ELEMENT` mode, where `y` copies it, `v` / `V` select it in copy mode, `+` / `-` and `j` / `k` move the focus and `F` picks another block. The help and `defaults.toml` snapshots gain the `[modal.element]` keys and the full `focus_element` description.
- Agents (MCP): `vimma_show` lets an agent show you one of the agent workspace's tabs. It asks every time, with only `y` and `n`; on `y` the window that holds the tab switches to the agent workspace with that tab selected, never raising or focusing a window, and `ctrl+^` brings you back to your workspace and split. The e2e baselines `m0-mcp-drive-keys-question` and `m0-mcp-drive-shown` are new, from the `m0-mcp-drive` scenario that drives the real `vimma-ctl mcp` through `vimma_keys` and `vimma_show`.
- Copy mode: `ip` selects the text block around the caret, the one element focus would select, and `ap` grows the selection to the block around it on each press. The help and `defaults.toml` snapshots gain the two keys.
- e2e baselines `m0-mcp-forms-fill-question` and `m0-mcp-forms-submit-question` (scenario `m0-mcp-forms`): the question line asking to fill two fields of a sign-up form, and the question asking to submit it, as the real `vimma-ctl mcp` lists the form, is refused its password field, fills it, takes a labelled screenshot, submits it and reads the failed request that follows.
- e2e baselines `element-hints.png`, `element-focus.png` and `element-visual.png` (scenario `issue-213-element-focus`): `F`'s labels on an article's text blocks, a focused paragraph with its outline and `ELEMENT` badge, and that paragraph selected in copy mode.
- The AppImage updates itself: it replaces its own file with a newer release checked against the signed update file, and runs it from the next start.
- Agents (MCP): `vimma_keys` scrolls, finds and goes back or forward in an agent tab without bringing it to the front, from a fixed set of Vimma's default keys; it asks first, shows the keys it will run, and `:mcp log` lists the last 100 agent calls.
- Agents (MCP): `vimma_keys` lists an agent tab's visible links by hint label and follows one in the same tab, never as a click and with no referrer; a link to another site asks first unless the agent holds an open grant.
- Updates: with update checks off, a dim `updates: off` segment shows for a few seconds at startup, once per session.
- Agents (MCP): `vimma_elements` lists the buttons, fields and links on screen in an agent tab by hint label; password, one-time-code and payment card fields are marked sensitive and never show a value.
- Agents (MCP): `vimma_activate` clicks buttons, links and checkboxes in an agent tab by hint label, in the background and without user activation; a form submission asks every time, and one a page makes by itself after an agent's click is stopped.
- Agents (MCP): `vimma_fill` fills form fields in an agent tab, never passwords, payment card, one-time-code or file fields; a fill that submits asks every time and shows every value.
- Agents (MCP): `vimma_screenshot` shows an agent tab as an image, taken in the background, with its `vimma_elements` labels drawn on it if asked; it is never taken while a password, one-time-code or card field on screen has a value.
- Agents (MCP): `vimma_console` reads an agent tab's script errors, console errors and warnings, and failed requests, without running page code.
- Packaging: an `.rpm` for Fedora and openSUSE, installed and checked with dnf and zypper; `:update` shows the dnf and zypper commands for it.
- Split panes: the focused pane has a 3 px border in the theme's focus colour (on Omarchy, the theme's accent) on all four edges, drawn over the edge of its page so pages never move or resize when focus does; unfocused panes are not dimmed, and there is no border with one pane, on a zoomed pane, while the split is hidden or in fullscreen. The e2e baseline `m4-split-panes` was re-recorded, since its focused pane now shows the border, and the baselines `issue-362-pane-focus-highlight-2` and `-3` are new.

* **bookmarks:** firefox's bookmarks toolbar hidden by default ([#438](https://github.com/vimma-browser/vimma/issues/438)) ([3e5fed1](https://github.com/vimma-browser/vimma/commit/3e5fed1f29b96bcd42ec80d93a7786f89cef2122)), closes [#214](https://github.com/vimma-browser/vimma/issues/214)
* **copy:** ip and ap select the block around the caret ([#451](https://github.com/vimma-browser/vimma/issues/451)) ([ed08a47](https://github.com/vimma-browser/vimma/commit/ed08a47b8203dd9dfe91a7a0c83de65a396246b0))
* **element:** focus a block, then v selects it and y copies it ([#449](https://github.com/vimma-browser/vimma/issues/449)) ([375684a](https://github.com/vimma-browser/vimma/commit/375684a7f7d134a319a978d8661f98c9c4383c8c)), closes [#213](https://github.com/vimma-browser/vimma/issues/213)
* **hints:** text blocks as hint targets ([#447](https://github.com/vimma-browser/vimma/issues/447)) ([7643f5a](https://github.com/vimma-browser/vimma/commit/7643f5ac61b1a5dae576ab770b44f816069fbc43)), closes [#213](https://github.com/vimma-browser/vimma/issues/213)
* **keys:** `F` starts element focus, `gF` opens a link in the background ([#453](https://github.com/vimma-browser/vimma/issues/453)) ([775b45f](https://github.com/vimma-browser/vimma/commit/775b45f416de5152be09ca06c3a7e3c30d3c2aa4)), closes [#213](https://github.com/vimma-browser/vimma/issues/213)
* **mcp:** full control says it reaches beyond the agent workspace ([#441](https://github.com/vimma-browser/vimma/issues/441)) ([b3bd8f9](https://github.com/vimma-browser/vimma/commit/b3bd8f93c9284c933524d897b8dc52f343700cd0))
* **mcp:** vimma_activate clicks by hint label ([#472](https://github.com/vimma-browser/vimma/issues/472)) ([5a15c32](https://github.com/vimma-browser/vimma/commit/5a15c32613b797a585f0759a8737d5e03cf81ad4))
* **mcp:** vimma_console reads a page's errors and failed requests ([#482](https://github.com/vimma-browser/vimma/issues/482)) ([14af7d0](https://github.com/vimma-browser/vimma/commit/14af7d0dcb966dfd7caf4a75877a4f5f6203836c))
* **mcp:** vimma_elements lists a page's buttons and fields by hint label ([#471](https://github.com/vimma-browser/vimma/issues/471)) ([dcb7487](https://github.com/vimma-browser/vimma/commit/dcb7487dc02fd5df2e48a7178a8cc86172d9c56b))
* **mcp:** vimma_fill fills fields, never passwords or payment fields ([#474](https://github.com/vimma-browser/vimma/issues/474)) ([7f536ac](https://github.com/vimma-browser/vimma/commit/7f536acac02058c87e3f2408deb57df5466ea269))
* **mcp:** vimma_keys follows links by hint label ([#455](https://github.com/vimma-browser/vimma/issues/455)) ([0c3c401](https://github.com/vimma-browser/vimma/commit/0c3c4011476023add114fe7df98e0ef6b87c559f))
* **mcp:** vimma_keys scrolls, finds and goes back in an agent tab ([#450](https://github.com/vimma-browser/vimma/issues/450)) ([b596440](https://github.com/vimma-browser/vimma/commit/b596440b145b83675296b3b681214d5369cebc4f))
* **mcp:** vimma_screenshot shows an agent tab ([#480](https://github.com/vimma-browser/vimma/issues/480)) ([7215505](https://github.com/vimma-browser/vimma/commit/72155051bfaec7571c9c90929d053367f6376ce6))
* **mcp:** vimma_show brings the agent workspace to the front ([#459](https://github.com/vimma-browser/vimma/issues/459)) ([5af9cf4](https://github.com/vimma-browser/vimma/commit/5af9cf4b02438603aec7bd148509ef3bc250d172))
* **packaging:** an .rpm for fedora and opensuse ([#448](https://github.com/vimma-browser/vimma/issues/448)) ([0d76cfa](https://github.com/vimma-browser/vimma/commit/0d76cfaac0977e8d89fc40906c0d9a47123f342e)), closes [#294](https://github.com/vimma-browser/vimma/issues/294)
* **sites:** a snapshot gate that replays recorded pages offline on every pull request ([#446](https://github.com/vimma-browser/vimma/issues/446)) ([dd71c74](https://github.com/vimma-browser/vimma/commit/dd71c74ab5e496dc2d942b1983b04fc668e8e4d4))
* **sites:** night-to-night diff, a rolling site-compat issue and one retry of blocked sites ([#437](https://github.com/vimma-browser/vimma/issues/437)) ([a0247d4](https://github.com/vimma-browser/vimma/commit/a0247d4cf8a1f1561b0012eeb17f5362f05c62fb))
* **split:** a 3 px border in the theme's focus colour marks the focused pane ([#431](https://github.com/vimma-browser/vimma/issues/431)) ([5a7203f](https://github.com/vimma-browser/vimma/commit/5a7203feacf77e6da0d5b3e207640a2901f241fc)), closes [#362](https://github.com/vimma-browser/vimma/issues/362)
* **updates:** :restart, and an installed security update asks to restart ([#454](https://github.com/vimma-browser/vimma/issues/454)) ([660af98](https://github.com/vimma-browser/vimma/commit/660af9844bed58673dbda8d65a6430fb50317de3))
* **updates:** the appimage replaces its own file with a verified newer release ([#430](https://github.com/vimma-browser/vimma/issues/430)) ([d20bc3b](https://github.com/vimma-browser/vimma/commit/d20bc3b7784d555ccf58148f68d7ebacb2a2775a))
* **updates:** update notices on macos ([620fdef](https://github.com/vimma-browser/vimma/commit/620fdefef059e75386bb2be9ffb9720e3fef21ba)), closes [#393](https://github.com/vimma-browser/vimma/issues/393)
* **updates:** with checks off, updates: off shows for a few seconds at startup ([#457](https://github.com/vimma-browser/vimma/issues/457)) ([09a15c2](https://github.com/vimma-browser/vimma/commit/09a15c273ab193f4634f3990e79f0d7859ce647e))


### Fixed

- Link hints: every entry of an open dropdown menu gets a label, also when the page puts a click handler on the list around them.
- Save-password prompt: its own fields keep the keys you type, and when focus is in a page field the keys line says to press Esc first, then `y` or `n`.
- Workspaces: keys typed right after switching to a workspace whose start page is still loading reach Vimma instead of being lost.
- Find: when a page focuses its search field after a find matched in it, Vimma enters insert mode (YouTube, Google, DuckDuckGo).
- Copy mode: `}` and `{` step over a paragraph's invisible source white space, so `}` at the end of a paragraph moves into the list that follows it.

* **build:** npm run build runs surfer build under a python mach supports ([#460](https://github.com/vimma-browser/vimma/issues/460)) ([a84946d](https://github.com/vimma-browser/vimma/commit/a84946d6c690dacaaf24141e67f8c55f6ee8f448)), closes [#458](https://github.com/vimma-browser/vimma/issues/458)
* **commitlint:** skip dependabot commits that write bump in lower case ([#421](https://github.com/vimma-browser/vimma/issues/421)) ([0ee6c71](https://github.com/vimma-browser/vimma/commit/0ee6c71155b68f10898227827c53e8db19cfdd64))
* **copy:** { and } step past a paragraph's source white space ([#463](https://github.com/vimma-browser/vimma/issues/463)) ([60c463c](https://github.com/vimma-browser/vimma/commit/60c463c6935d8a514b15b2425bb81d103b256b16)), closes [#461](https://github.com/vimma-browser/vimma/issues/461)
* **find:** a page's own focus on a field a find matched in enters insert mode ([#445](https://github.com/vimma-browser/vimma/issues/445)) ([3300eb9](https://github.com/vimma-browser/vimma/commit/3300eb98b7808d5ad2f0beb7b8f31773142f03b2)), closes [#442](https://github.com/vimma-browser/vimma/issues/442)
* **hints:** every entry of an open dropdown menu gets a label ([#428](https://github.com/vimma-browser/vimma/issues/428)) ([c03bb0b](https://github.com/vimma-browser/vimma/commit/c03bb0b358fddfdce882328a482df75a5eddca56)), closes [#329](https://github.com/vimma-browser/vimma/issues/329)
* **macos:** platform fallbacks ([#414](https://github.com/vimma-browser/vimma/issues/414)) ([4304712](https://github.com/vimma-browser/vimma/commit/430471269d7c3cdcf0c04d1f46b54d01e30b9e9e))
* **mochitest:** run mach with a python inside the range mach supports ([#436](https://github.com/vimma-browser/vimma/issues/436)) ([190739c](https://github.com/vimma-browser/vimma/commit/190739c0e71c3bb9138f0c018934b61761b4281b)), closes [#435](https://github.com/vimma-browser/vimma/issues/435)
* **private:** the swap waits up to 2 s for hyprland to name a starting window ([0820c9e](https://github.com/vimma-browser/vimma/commit/0820c9e1a06e6d633d1d7e24a5d4d2b2c9f95b0c))
* **prompts:** the password prompt's fields keep their keys, and the keys line says esc first ([#432](https://github.com/vimma-browser/vimma/issues/432)) ([35d017f](https://github.com/vimma-browser/vimma/commit/35d017ff78e9eab48ca9d7252badbd61fe1a4f60))
* **prompts:** y and n typed into live grep or a search no longer answer a permission prompt ([#491](https://github.com/vimma-browser/vimma/issues/491)) ([0f1c26d](https://github.com/vimma-browser/vimma/commit/0f1c26d4cc34691c30d772dea88ef1f447f49453))
* **theme:** every mode badge keeps a colour of its own under any theme ([#464](https://github.com/vimma-browser/vimma/issues/464)) ([3792de4](https://github.com/vimma-browser/vimma/commit/3792de4067bbe7da2994f3b005be571375412d95)), closes [#462](https://github.com/vimma-browser/vimma/issues/462)
* **workspaces:** keys typed while a new start page loads reach vimma ([#417](https://github.com/vimma-browser/vimma/issues/417)) ([3ce256c](https://github.com/vimma-browser/vimma/commit/3ce256c8d09191d381f7b9cb09790a2c29219f08)), closes [#388](https://github.com/vimma-browser/vimma/issues/388)


### Changed

- `F` now starts element focus; background-tab link hints moved to `gF` (a `config.toml` that binds `F` keeps it). The help and `defaults.toml` snapshots show `F` on `focus_element` and `gF` on `follow_link_new_tab`.
- Firefox's Bookmarks Toolbar is hidden by default, also on the start page and after an import; `ctrl+b shift+b` opens your bookmarks, the start page names it, and `:bookmarkstoolbar [show|hide|newtab]`, `ctrl+shift+b` or `[ui] bookmarks_toolbar` brings the toolbar back. A profile that showed it has it hidden once, with a notice. The `defaults.toml` snapshot gains the commented `[ui] bookmarks_toolbar` line.
- While agents are on, full control's questions say that it reaches every workspace, not only the agent workspace, and `vimma-ctl mcp` tells agents never to ask for it.
- Themes: mode badges keep distinct colours when a theme maps two palette slots to one colour; under Catppuccin the `ELEMENT` and `HINT` badges get a shade of their own, and every badge keeps AA text contrast.

* Firefox 158.0.1 ([MFSA 2026-111](https://www.mozilla.org/en-US/security/advisories/mfsa2026-111/)) ([#425](https://github.com/vimma-browser/vimma/issues/425)) ([7748419](https://github.com/vimma-browser/vimma/commit/7748419063371dd7b8878f2d4b36e46c198572b7))

## [0.1.6](https://github.com/vimma-browser/vimma/compare/v0.1.5...v0.1.6) · Firefox 158.0 (2026-10-19)


### Added

- Releases: a macOS `.dmg` for Apple Silicon, ad hoc signed, with its own `SHA256SUMS-macos` and cosign signatures, joins a release when the repository variable `MACOS_RELEASE_ENABLED` is set. It shows Vimma's icon, as do the documents it opens, and its bundle identifier is `dev.vimma.browser`. It is not notarised yet, so macOS asks once before it first opens; the guide's macOS section says how.
- Keys: every Firefox shortcut is now a Vimma binding on Firefox's own key (`ctrl+j`, `ctrl+shift+b`, `ctrl+shift+d`, `F7`, `shift+esc` in normal mode, the sidebar keys and more), listed in `ctrl+b ?` and rebindable; `ctrl+f` is a second find key. `[firefox] disable` now defaults to `"all"`, so Firefox's own shortcuts are off and only Vimma's bindings run; `enable` gives one back. The `defaults.toml` and help snapshots gain the new rows and the new `[firefox]` default.

* **keymap:** bind the rest of Firefox's keys on Firefox's chords ([#352](https://github.com/vimma-browser/vimma/issues/352)) ([256c52c](https://github.com/vimma-browser/vimma/commit/256c52c85162eb9b4be3d4db4ae6745ff4a53016)), closes [#234](https://github.com/vimma-browser/vimma/issues/234)
* **macos:** vimma's app icon and the dev.vimma.browser bundle id ([783c0ed](https://github.com/vimma-browser/vimma/commit/783c0ed6d439fbddf320d6bea9a6ed9cc15ec449))
* **release:** publish the homebrew cask to vimma-browser/homebrew-tap ([bbceb78](https://github.com/vimma-browser/vimma/commit/bbceb7852fe78d724d9a4dbe968906f0e014bcb9))
* **setup:** add a skippable first-run setup for add-ons and search ([#392](https://github.com/vimma-browser/vimma/issues/392)) ([e0a0e2b](https://github.com/vimma-browser/vimma/commit/e0a0e2b9127a4f8da5c8da568902b9216f1bdc04)), closes [#378](https://github.com/vimma-browser/vimma/issues/378)
* **upstream:** auto-merge a green version-only firefox bump ([#383](https://github.com/vimma-browser/vimma/issues/383)) ([8cdc0d2](https://github.com/vimma-browser/vimma/commit/8cdc0d21c8da2dc3c247dc848615829c52a22f84))
* **upstream:** open a triage issue when patches do not apply ([#390](https://github.com/vimma-browser/vimma/issues/390)) ([4d2212a](https://github.com/vimma-browser/vimma/commit/4d2212a78e41e5b2e7aa6b4cd1e43a554e3dcb1f)), closes [#259](https://github.com/vimma-browser/vimma/issues/259)
* **upstream:** re-export patches that need only fuzz in the bump ([#380](https://github.com/vimma-browser/vimma/issues/380)) ([35085f0](https://github.com/vimma-browser/vimma/commit/35085f0e63736b9389ddda53fe2f303bfe1db5b8))
* **upstream:** refresh copied upstream prefs in the bump commit ([#377](https://github.com/vimma-browser/vimma/issues/377)) ([507582f](https://github.com/vimma-browser/vimma/commit/507582f0ef0800d1ed8fa66154ab1a9bcae645e3))
* **workspaces:** m in the side panel moves that row's tab to a workspace ([#376](https://github.com/vimma-browser/vimma/issues/376)) ([dc2d40d](https://github.com/vimma-browser/vimma/commit/dc2d40d304b0808316c128e20bd922f4e7f3a49a)), closes [#260](https://github.com/vimma-browser/vimma/issues/260)
* **workspaces:** unpin pinned tabs and show lost containers in the status bar ([#370](https://github.com/vimma-browser/vimma/issues/370)) ([25314f2](https://github.com/vimma-browser/vimma/commit/25314f2c989340ebc9e64fb93784ac1bf1f44b7c))


### Fixed

* **ci:** skip key-guard on a merged pull request ([#359](https://github.com/vimma-browser/vimma/issues/359)) ([be72ef7](https://github.com/vimma-browser/vimma/commit/be72ef765f532837f1bee56cf234808e495b16c7)), closes [#357](https://github.com/vimma-browser/vimma/issues/357)
* **grep:** keep a reopened grep's frames when an earlier jump ends late ([#402](https://github.com/vimma-browser/vimma/issues/402)) ([a6197ce](https://github.com/vimma-browser/vimma/commit/a6197ce2ef3399a711c0d448314bcf94c0dfa457)), closes [#401](https://github.com/vimma-browser/vimma/issues/401)
* **keys:** ctrl+shift+z opens the debugger on a plain page ([#400](https://github.com/vimma-browser/vimma/issues/400)) ([5b01dfe](https://github.com/vimma-browser/vimma/commit/5b01dfe23461758d42e83fd5baaf3593ef4f7d91)), closes [#371](https://github.com/vimma-browser/vimma/issues/371)
* **prompt-keys:** answer the add-on install prompt with y and n ([#365](https://github.com/vimma-browser/vimma/issues/365)) ([83b6049](https://github.com/vimma-browser/vimma/commit/83b6049b60b9c4ef4e4c676ecfafbfe46a72d6a2)), closes [#323](https://github.com/vimma-browser/vimma/issues/323)

## [0.1.5](https://github.com/vimma-browser/vimma/compare/v0.1.4...v0.1.5) · Firefox 158.0 (2026-10-17)


### Added

- Agent downloads: a ClamAV scan with definitions older than `[mcp] clamav_max_age_days` (default 7) is never reported clean, and clamd is used through `clamdscan` when it can be trusted, with `clamscan` as the fallback. The `defaults.toml` snapshot gains the new key.

* **mcp:** clamav definitions age and clamdscan ([#355](https://github.com/vimma-browser/vimma/issues/355)) ([9b1d74b](https://github.com/vimma-browser/vimma/commit/9b1d74b08c2f3be4d3684456e3ad82fda93277e0)), closes [#232](https://github.com/vimma-browser/vimma/issues/232)


### Fixed

* **bench:** measure the baseline commit in the same run, sample by sample ([#356](https://github.com/vimma-browser/vimma/issues/356)) ([c86bbfb](https://github.com/vimma-browser/vimma/commit/c86bbfbba54a27fd48f9b78f1de3e1c421411b4e)), closes [#342](https://github.com/vimma-browser/vimma/issues/342)
* **keys:** keep a capital letter whose lower case is two characters as typed ([#349](https://github.com/vimma-browser/vimma/issues/349)) ([8d17eb0](https://github.com/vimma-browser/vimma/commit/8d17eb0ef4fa04c8903406a7ee290ab6d53ff438)), closes [#313](https://github.com/vimma-browser/vimma/issues/313)
* **prompt-keys:** arm y and n on firefox's own prompt delay, and fix two test races ([#346](https://github.com/vimma-browser/vimma/issues/346)) ([d100a04](https://github.com/vimma-browser/vimma/commit/d100a04c37135c7647c1e7b07c85dcfd829bd405)), closes [#334](https://github.com/vimma-browser/vimma/issues/334) [#307](https://github.com/vimma-browser/vimma/issues/307)

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
