# Spec: agent-modules

Status: draft · Area: `packages/vimma-core/src/` (new `modules.mjs`: `module.toml` parser and
validator, the generated manifest and background script, the permission words, the version
model; new `module-requests.mjs`; `keymap.mjs` and `dispatcher.mjs` for the module layer and
`module.run`; `config.mjs` for `[modules]`; `control.mjs` for the `sandbox` role; `actions.mjs`
for the `:module` commands and, in its own keymap PR, `defaults.mjs` for the request key;
`help.mjs` for the Modules group); `src/browser/base/content/vimma/` (new
`modules/ModuleHost.sys.mjs`, `modules/ModuleStore.sys.mjs`, `modules/ModuleNet.sys.mjs`,
`modules/ModuleSandbox.sys.mjs`, `ui/module-review.mjs`, `ui/module-picker.mjs`;
`host/VimmaHost.sys.mjs`, `host/addon-ops.mjs`, `ctl/VimmaControl.sys.mjs`,
`ctl/agent-commands.mjs`, `vimma.js` for the sandbox flag, `ui/statusbar.mjs`);
`tools/vimma-ctl/` (`vimma-ctl module`, new MCP tools); `tools/security/test/chrome-source.test.mjs`;
`docs/guide.md`, `docs/security.md`, `docs/limits.md`, README · Upstream patches: none ·
ADR: ADR-024, the module format (new, written with delivery PR 1, decision 7); ADR-007 and
ADR-019 gain a consequence line for the `sandbox` role (decision 26)

Issue: [#540](https://github.com/vimma-browser/vimma/issues/540)

Builds on [vimma-mcp](vimma-mcp.md) (the agent role of the control socket, `vimma-ctl mcp`,
the agent workspace), [m5-config-load](m5-config-load.md) (`config.toml`),
[addon-manager](addon-manager.md) and [first-run-setup](first-run-setup.md) (how Vimma treats
add-ons today). This spec's decisions are "D1", "D2" and so on. Engine paths are relative to
`engine/` and were read in Firefox 158.0.1 (`config/milestone.txt`). Vimma paths are under
`src/browser/base/content/vimma/` unless they start with `packages/`, `tools/`, `tests/` or
`docs/`; they were read at commit `2a7a3b2`. Anything not confirmed from source is marked
**unverified**, with the check that settles it.

## Summary

Vimma lets its users build small tools for themselves as easily as they can describe them. The
user presses one key and writes what they miss ("dim everything except the article"); their own
local coding agent writes it as a module, tests it on the live page in a throwaway Vimma
instance, and Vimma shows the change, the permissions in plain words and the test result on one
screen. One `y` loads it, with no restart; "change it to …" refines the same module and shows a
new diff; every version is kept, so a module can be rolled back, switched off or edited by hand.
Requests that are really settings become a reviewed `config.toml` change instead, and Vimma's
own code is never changed at run time. A module that proves generally useful can be offered to
the project as an issue, so that Vimma grows from what its users build, through the project's
own reviewed pipeline.

## Problem

- **A missing feature means waiting or writing an add-on.** Neovim users turn a missing feature
  into a few lines of Lua in their config. A Vimma user who wants "dim everything but the
  article" has no such place: Vimma's `config.toml` holds settings and bindings, never code
  ([security.md](../security.md) F3), and a WebExtension must be signed by Mozilla before a
  release build loads it for good (Research, "Add-on signing").
- **Personal tools should be easy to build.** Most such wishes are small and personal: a page
  tweak, a binding, a floating video, reader-style dimming. A tool for them is worth having only
  if building it takes a sentence and one approval, refining it takes another sentence, and
  managing what one has built is as easy as editing `config.toml`.
- **Generated code is a security problem.** Code an AI writes after reading a web page can be
  steered by that page. Pasting it into a userscript manager, or loading an extension built
  elsewhere, gives it whatever it asks for, with no test, no record of what changed and no way
  back.
- **The project wants to evolve with as little hand work as possible.** Vimma is "built by one
  person with AI coding agents … with a pipeline that tests, rebases on upstream and releases
  without anyone watching" ([plan.md](../../plan.md):3), and its development loop is "you decide
  and review; machines do the rest" (plan.md:193, "What runs without you" at plan.md:203). What
  users build for themselves is a direct signal of what Vimma lacks, but today nothing carries it
  from a user's machine into the project.

## Behaviour

Examples use the default keys. The request key is open question 5; `:module new` works without
it.

### Asking for a tool

1. **One key to describe a tool.** `ctrl+b m` (or `:module new`) opens a prompt over the window:
   `describe a tool:` with room for several lines (`shift+Enter` adds a line, `Enter` sends,
   `Esc` cancels). Below the input one line shows what goes with the request, the address
   itself included: `sends: your text · https://en.wikipedia.org/wiki/Vim (Tab: full address ·
none)`. By default the address is sent without its query and fragment, which can carry
   tokens and search terms; `Tab` cycles to the full address, then to none. In a private window
   or the private workspace the address is never sent and the line says `sends: your text`.
2. **The request waits for the user's own agent.** On `Enter` the request is queued in memory
   and the status bar shows `◆ module: waiting for an agent`. Any coding agent connected through
   `vimma-ctl mcp` (Claude Code, Codex, opencode) picks it up with `vimma_module_requests`
   (Behaviour 13). Vimma starts no agent: the notice says
   `request saved: ask your coding agent to build Vimma's module requests`, and
   `vimma-ctl module requests` prints it for an agent that does not speak MCP. "One key" to
   describe a tool still means a coding agent running in a terminal with `vimma-ctl mcp`
   configured; the guide's setup for agents covers it once, and an agent left running picks up
   later requests without another step.
3. **What is already there is said first.** An agent whose request is served by an existing
   action answers with a config change (Behaviour 4), not a module. "A binding that pops the
   current video into a floating window" is Picture-in-Picture, already the action
   `picture_in_picture` (`packages/vimma-core/src/actions.mjs:204`, `ctrl+}` by default in
   `defaults.mjs:142`), so the proposal is one line under `[keys]`.

### The three tiers

4. **Tier 1, configuration.** A request that is really a setting or a binding ("make `J` scroll
   faster", "bind Picture-in-Picture to `ctrl+b shift+v`") becomes a proposed edit of `config.toml`,
   shown in the review screen as a text diff of the file. `y` writes it (atomically, keeping
   comments and the file's mode, as `:route add` and the setup summary do), and the config
   reloads. Only the keymap and display tables listed in D3 may be proposed.
5. **Tier 2, modules.** Anything that needs code on a page becomes a module (Behaviour 6-12).
6. **Tier 3, Vimma's own code, is never changed at run time.** A request that needs something no
   module may do (a new browser capability, a change to Vimma's chrome, keys outside the module
   layer) is answered `this needs a change to Vimma`, with the agent's one-line reason, and the
   review screen offers to turn it into an issue (Behaviour 24). Nothing is worked around.

### Modules

7. **A module is a folder of plain files**, next to `config.toml`, that the user can read and edit:

   ```
   ~/.config/vimma/modules/dim-article/
     module.toml      # name, description, commands, keys, permissions
     dim.js           # a command's page script (optional)
     dim.css          # a command's style sheet (optional)
     tests/dim.js     # run only in the sandbox (Behaviour 14)
   ```

   ```toml
   name = "dim-article"
   description = "Dim everything except the article"
   api = 1

   [[commands]]
   name = "toggle"
   description = "Dim or undim everything but the article"
   script = "dim.js"
   style = "dim.css"
   keys = ["<leader>d"]

   [permissions]          # all optional; these are the defaults
   sites = []             # match patterns where its keys work; empty: any http(s) page
   theme = false          # true: gets the current theme's colours (Behaviour 12)
   storage = false        # true: keeps data between runs, shared by every workspace
   ```

8. **Default permissions cover the common case.** With no `[permissions]` table, a module's
   command runs only when its key is pressed, only on the page the user is looking at, and may
   read and change that page (a command with only a style sheet changes how it looks); it runs
   on no other tab, never in a private window or the agent workspace, and never on a page with a
   login or payment field. A page tweak, reader-style dimming or a style change needs no further
   thought than the one approval that states this. What such a module could still do is said
   in the same words (Behaviour 16): code or a style sheet on a page can send what the page
   shows to other sites through the page itself, and Vimma blocks only part of that (D21).
9. **A module's keys** live in a module layer between Vimma's defaults and `config.toml`:
   `config.toml` always wins, and a module key that is already bound (by default or by the user)
   is refused at review with the binding it would hide. `ctrl+b ?` lists module keys in a
   "Modules" group, each marked with its module's name. In `config.toml`,
   `[modules.dim-article] keys.toggle = ["<leader>D"]` rebinds or `[]` unbinds.
10. **When a module's key does nothing.** In a private window, an agent-workspace tab, a page
    outside `sites`, a page that is not http or https, or a page that has a password, payment
    card or one-time-code field in any frame, filled or empty, the key runs nothing and the
    notice says why (`dim-article: not run here: this page has a password field`). A module
    that ran stays in the page until it reloads, and activeTab outlives an in-page route change
    and a return from the back-forward cache, so a login form the page shows later is within its
    reach: when a password field appears in a page where a module ran, the status bar says
    `module ran on this page: reload before typing a password`.
11. **Its effect is the page's until it reloads.** A module changes the page it ran on; turning
    the module off or rolling it back stops it from running again but does not undo what it
    already changed in an open page. The notice of `:module off` says `reload pages to undo`.
12. **Theme.** A module with `theme = true` gets the current theme's colours (Tokyo Night,
    an Omarchy theme or `[theme.colors]`) as `#rrggbb` values in `palette.json`, read from its
    own package, and is reloaded when the theme changes.

### The agent loop

13. **The agent's tools.** `vimma-ctl mcp` gains `vimma_module_requests` (the waiting requests,
    each with its text, its address if sent, and, for a refinement, the module's current files),
    `vimma_module_api` (the module format, the permission words and the test API, as text),
    `vimma_module_test` (Behaviour 14), `vimma_module_propose` (the working copy of a module, or a
    `config.toml` edit, is ready for review) and `vimma_module_needs_change` (Behaviour 6). They
    work while MCP is on, as every agent tool does, and none of them reaches a tab.
14. **Testing in a sandbox.** `vimma_module_test` (or `vimma-ctl module test <name> [--url URL]`)
    starts a separate headless Vimma with a new, empty profile, loads the module's working copy
    there, opens the address in that instance (with no cookies or logins of the user's), presses
    each command's key, runs the module's tests, and returns a report: each test's pass or
    failure, the errors its scripts threw, every request its scripts made (blocked ones marked),
    and the time taken. The instance and its profile are deleted when the test ends, at most
    120 s later. The address must be http or https; `file:`, loopback, private, link-local and
    `.local` addresses are refused unless it is the address the request carried from the user's
    page (Behaviour 1), because the agent chooses the address and the sandbox would otherwise
    read local files or the intranet for it.
15. **Proposing.** `vimma_module_propose` makes the module ready for review. Vimma reads the
    working copy itself, checks it (D9), runs nothing, and shows `◆ module ready: ctrl+b m` in
    the status bar. A proposal that fails the checks is refused back to the agent with the
    reasons, and the user sees nothing.

### Review

16. **One screen.** `ctrl+b m` with a proposal waiting (or `:module review`) opens the review
    over the window, in this order:
    1. the module's name, version and, for an update, the version it replaces;
    2. **what it may do**, in words Vimma writes from `module.toml`, never the agent's:
       `When you press <leader>d, it reads and changes the page you are on, and can send what
that page shows to other sites through the page. It never runs in private windows, the
agent workspace or on pages with a login or payment field.`; a permission an update adds is
       marked `new:`;
    3. **the test result**, from the sandbox's report: `tested on en.wikipedia.org (signed out):
3 of 3 passed, no requests to other sites`, or `not tested`;
    4. **the diff**: for an update, the changed hunks of every file against the version in
       force, with `F` showing whole files; for a new module, every file whole; as text, with
       invisible and bidirectional characters, non-ASCII letters in identifiers and lines over
       300 columns marked where they occur (D24);
    5. **the agent's description**, under the label `the agent says`.
17. **Keys.** `j`/`k`, `ctrl+d`/`ctrl+u`, `gg`/`G` scroll, `]f`/`[f` move by file. `y` approves,
    `n` rejects, `c` opens `change it to:` to refine (Behaviour 19), `Esc` closes and keeps the
    proposal waiting. `y` works only once the diff has been shown to its end and after the
    question line's arming delay, re-armed as the question line's is whenever the window is
    activated, deactivated, focused or blurred (security.md M4). This keeps a stray key from
    approving; it does not prove the diff was read, since `G` reaches the end in one key.
18. **Nothing loads without approval.** A module, a new version of one, a hand edit
    (Behaviour 21), a module copied from someone else (Behaviour 22) and a rollback to a version
    with more permissions than the one in force each need a `y` in the review screen, typed on
    the keyboard. No grant, no answer in the agent question line, no MCP call and no key sent
    through the control socket's `full` role (`send-keys`, which otherwise counts as the user,
    security.md §1) approves one.
19. **Fast iteration.** `c` in the review, or `c` on a module in `:modules`, asks
    `change it to:`; the text goes to the agent as a refinement of the same module, with its
    current files. The next proposal is reviewed as a diff against the version in force, and
    the one it replaces is dropped.

### Managing modules

20. **`:modules`** (picker) lists every module: name, version, `on`/`off`, its keys, and
    `changed on disk` when the working copy differs from the version in force. `Enter` shows the
    review screen read-only for the version in force; `x` turns it on or off at once; `c`
    refines; `r` lists its versions and rolls back to one; `e` shows the folder's path and
    copies it; `d` removes it after `remove "dim-article"? y/N`. The command line has
    `:module on|off|remove|rollback <name> [version]`, `:module install <folder>` and
    `:modules off` (none load until `:modules on` or a restart).
21. **Hand editing.** The user edits the working copy with any editor. Vimma notices the change
    (it polls the folder as it polls `config.toml`), and the status bar shows
    `◆ module changed: ctrl+b m`; the change is reviewed like an agent's.
22. **Sharing.** A module is its folder: it can be kept in a dotfile repository with
    `config.toml`, or copied to someone else, whose Vimma reviews it as new
    (`:module install <folder>`), with `written elsewhere` above its permissions.
23. **Versions and safe mode.** Every approved version is kept, numbered (1, 2, 3 …), the last
    ten per module. Vimma loads no module when started in Firefox's troubleshoot mode or with
    `[modules] enabled = false`, and none after `:modules off`; the status bar says
    `modules off` and why.

### Promotion

24. **Offering a module to Vimma, if the user chooses.** `:module promote <name>` (or `p` in
    `:modules`, or the offer after Behaviour 6) shows exactly the issue text Vimma would prefill:
    a title, the request's text, the module's description, its `module.toml`, its permission
    words, its test counts, the Vimma and Firefox versions, and its files when they fit. The
    request's text and any host in it or in `sites` are highlighted for review; page text, page
    addresses and the sandbox report's details are never included. `y` opens GitHub's new-issue
    page with that text in a new tab of the current workspace; nothing reaches GitHub until the
    user submits it there. Files that do not fit are copied to the clipboard as one Markdown
    block, and the notice says so. The issue's title starts with `module:` and its body with a
    line saying that it holds text shaped by web pages and an AI agent (D27).

## Research

### Vimma at `2a7a3b2`

- **No code in config.** `config.toml` is parsed into a closed schema (`TOP_KEYS`,
  `packages/vimma-core/src/config.mjs:167-184`) and never executed (security.md F3). It is read
  from `$XDG_CONFIG_HOME/vimma/config.toml` (`config/ConfigHost.sys.mjs:65-73`) and polled every
  2 s (`:58`). Vimma edits it only through `setTomlKeys` (`packages/vimma-core/src/toml.mjs:487`),
  which keeps comments, and `:route add` (security.md F1).
- **Chrome code never evaluates text.** The test `never builds code from text: no eval, Function
or sandbox evaluation` scans every chrome source for `eval(`, `Function(`, `evalInSandbox` and
  `loadSubScript` (`tools/security/test/chrome-source.test.mjs:57-58`, security.md C2).
- **Add-ons are installed only from the setup page.** The test `installs an add-on only from the
setup page` allows `installTemporaryAddon` and the other install calls only in
  `setup/SetupHost.sys.mjs` (`chrome-source.test.mjs:181-192`, security.md A1). The add-on
  picker lists every extension that is not system, built-in or hidden (security.md A3).
- **Actions are a closed set.** `actions.mjs` is the single source of the dispatcher, config
  validation, `ctrl+b ?` and the bindings docs (`actions.mjs:5-12`). Picture-in-Picture is
  `page.picture_in_picture` (`:204`), run as Firefox's `View:PictureInPicture` command
  (`host/browser-ops.mjs:32`).
- **Agents.** `vimma-ctl mcp` holds an `agent`-role connection (ADR-019); every agent command
  runs through `runAgentCommand` (`ctl/agent-commands.mjs:1348`), which confines it to the agent
  workspace (`isAgentTab`, `:154`; `agentTabs`, `:170`; `findAgentTab`, `:207`). Page text
  reaches the model inside delimiters a page cannot close (`wrapUntrusted`,
  `packages/vimma-core/src/agent.mjs:508`), a mitigation and not a guarantee. `vimma_show` always
  asks (`ALWAYS_ASK`, `agent.mjs:134`). The instructions every MCP agent gets are `INSTRUCTIONS`
  (`tools/vimma-ctl/src/mcp.rs:55`).
- **Sensitive fields.** The actors already tell whether a password, card or one-time-code field
  shows a value (`actors/agent-fields.mjs`, `plainlySensitive` at `:181`, `sensitiveValueShown`
  at `:232`), for agent screenshots (security.md M31).
- **A throwaway instance is what the e2e harness starts.** `tools/e2e/launcher.mjs` makes a new
  profile in a temporary folder (`:137`), sets `vimma.control.enabled` (`:43`) and starts the
  build with `-no-remote -profile` (`:218-219`).
- **Theme.** The palette is parsed and checked as `#rrggbb` values (`parseOmarchyColors`,
  `packages/vimma-core/src/theme.mjs:481`) and turned into CSS custom properties on Vimma's
  chrome (`tokensToCss`, `:939`); page content cannot see those properties.
- **A command-line flag of Vimma's own exists**: `-vimma-reload-theme` (`vimma.js:44`,
  security.md O3).

### Add-on signing and temporary add-ons (Firefox 158.0.1)

- **Release builds require signatures.** `MOZ_REQUIRE_SIGNING` is on for release and beta
  milestones (`toolkit/moz.configure:2008-2022`), and outside automation
  `AddonSettings.REQUIRE_SIGNING` is a constant that no pref changes
  (`toolkit/mozapps/extensions/internal/AddonSettings.sys.mjs:32-34`); an unsigned add-on in a
  normal install location is `appDisabled` (`isUsableAddon`,
  `toolkit/mozapps/extensions/internal/XPIDatabase.sys.mjs:2672-2678`).
- **Temporary add-ons need no signature.** `isCorrectlySigned` is true for the temporary and
  built-in locations (`XPIDatabase.sys.mjs:455-459`).
  `AddonManager.installTemporaryAddon(file)` loads an unpacked folder or an XPI "intended for
  development, the signature is not checked and the add-on does not persist on application
  restart" (`toolkit/mozapps/extensions/internal/XPIInstall.sys.mjs:4824-4851`). An add-on
  already installed with the same ID is replaced: `_activateAddon` updates the old one in place
  (`XPIInstall.sys.mjs:4940-4986`), and the temporary location takes precedence over a
  permanent add-on of that ID (`:4945`). Temporary add-ons are removed at shutdown
  (`cleanupTemporaryAddons`, `toolkit/mozapps/extensions/internal/XPIProvider.sys.mjs:3053`).
- **Temporary add-ons are never privileged on a release build.** An extension is privileged when
  it is signed as privileged or system, built in, or temporary while experiments are enabled
  (`ExtensionData.getIsPrivileged`, `toolkit/components/extensions/Extension.sys.mjs:968-975`).
  Experiments are a constant `false` on a build that requires signing and is not Nightly or
  Developer Edition (`AddonSettings.sys.mjs:103-117`), so a temporary add-on in Vimma is
  unprivileged, and a privileged permission in its manifest is a manifest error
  (`Extension.sys.mjs:2042-2048`). A built-in add-on (`installBuiltinAddon`,
  `XPIInstall.sys.mjs:4865`, a `resource:` URL only) is privileged.
- **Host permissions of a temporary add-on are granted at install**, without Firefox's prompt
  (`Extension.sys.mjs:2010-2014`), so for a temporary add-on Firefox asks nothing: whatever
  approves it has to be Vimma's.
- **Private windows.** An extension gets `internal:privateBrowsingAllowed` automatically only
  when privileged and not temporary, and `incognito: "not_allowed"` removes it
  (`_setupStartupPermissions`, `Extension.sys.mjs:4313-4335`).
- **Troubleshoot mode** is `Services.appinfo.inSafeMode`, which the add-ons manager already reads
  (`toolkit/mozapps/extensions/internal/XPIProvider.sys.mjs:1347`).

### How an extension's code runs on a page

- **Content scripts** run in a `Cu.Sandbox` whose principal is the expanded principal
  `[page, extension]`, with Xray vision of the page (`wantXrays: true`), so page script cannot
  reach into them and they see the page's objects through Xrays
  (`toolkit/components/extensions/ExtensionContent.sys.mjs:1045-1092`). In Manifest V3 their
  `fetch` and `XMLHttpRequest` have the page's own capabilities, and the extension's base CSP is
  enforced on them, with no override (`:1067-1080`).
- **User scripts** (the `userScripts` API, `toolkit/components/extensions/schemas/user_scripts.json`)
  run in a sandbox with only the page's principal (`ExtensionContent.sys.mjs:945-962`). The API
  registers code at run time.
- **Commands and activeTab.** An extension's `commands` are dispatched by
  `ExtensionShortcuts.onCommand(name)` (`toolkit/components/extensions/ExtensionShortcuts.sys.mjs:148-152`,
  `:473`); the `commands` API's listener first grants activeTab on the selected tab and then
  fires `onCommand` (`browser/components/extensions/parent/ext-commands.js:17-21`). That tab is
  `tabTracker.activeTab`, the selected tab of the top window
  (`browser/components/extensions/parent/ext-browser.js:775-781`), not a tab the caller names.
  activeTab is granted for the tab's current inner window
  (`toolkit/components/extensions/parent/ext-tabs-base.js:2177-2190`); it is not cleared when
  the tab navigates, and a document restored from the back-forward cache keeps it (`:2184-2187`),
  as does a page that changes its route in place without a new document.
- **Shortcuts set in about:addons.** "Manage Extension Shortcuts" calls
  `ExtensionShortcuts.updateCommand` (`ExtensionShortcuts.sys.mjs:168`), which builds a key of
  Firefox's own for the command and reports the change (`:209`); `resetCommand` (`:217`) undoes
  it.
- **Which principal a request carries.** For a URL set as an attribute, a content script's
  principal becomes the triggering principal only when the URL is absolute; a relative or
  protocol-relative URL gets the page's principal (`nsContentUtils::GetAttrTriggeringPrincipal`,
  `dom/base/nsContentUtils.cpp:2549-2575`). Markup inserted with `innerHTML` or by the parser,
  a `<script>` element added to the page, a change of `location`, a form submission, an
  `<a ping>` and a style sheet's `url()` load as the page. The MV3 base CSP
  (`script-src 'self' 'wasm-unsafe-eval'`, `modules/libpref/init/all.js:3166`) applies to the
  content script's own sandbox, not to what it adds to the page.
- **Password fields announce themselves.** An `<input type=password>` added to a document fires
  `DOMInputPasswordAdded` or `DOMFormHasPassword` (`dom/html/HTMLInputElement.cpp:4610`), which
  the login manager's actor listens to (`toolkit/modules/ActorManagerParent.sys.mjs:448`).
- **Content scripts and containers.** MV2's `contentScripts.register` takes a `cookieStoreId`
  (`toolkit/components/extensions/schemas/content_scripts.json:75`); MV3's
  `scripting.registerContentScripts` (`RegisteredContentScript`,
  `toolkit/components/extensions/schemas/scripting.json:159`) has no such field.
- **Console attribution.** A console call records the add-on ID of its caller's principal
  (`dom/console/Console.cpp:148-153`), but an expanded principal reports none
  (`caps/ExpandedPrincipal.cpp:124-127`): a content script's console output is not attributable
  to its extension, while its background script's is.

### Prior art

Checked on the products' own pages and the press on 2026-10-25, not by running them:

- **Dia's Skills.** Dia's AI chat "helps you customize the browser's functionality by generating
  simple code", for example HTML and CSS for a reading layout
  ([Design Compass, 2025-06-13](https://designcompass.org/en/2025/06/13/dia-ai-web-browser/)).
  Other sources describe Skills as reusable prompts called with `/name`
  ([Dia's skills gallery](https://www.diabrowser.com/skills/how-to-web)). Neither mentions
  testing, a permission scope, versions or rollback; whether Dia has them is **unverified**.
- **AI extension builders.** Manus's Chrome extension builder turns a description into "a working
  browser tool", "primarily for your personal use"
  ([Manus playbook](https://manus.im/playbook/chrome-extension-builder)). It runs outside the
  browser; how the extension is installed, and whether its permissions are reviewed or it is
  tested, is not stated (**unverified**).
- **Agent browsers and extensions.** Claude in Chrome records steps and saves them as a shortcut
  that the agent runs again, with "ask before acting" and site permissions
  ([Anthropic help](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome),
  [workflows](https://support.claude.com/en/articles/12431227-simplify-your-browsing-experience-with-claude-for-chrome));
  ChatGPT Atlas's agent mode takes actions in the browser and, as reported, cannot run code
  in the browser or install extensions
  ([PureAI, 2025-10-21](https://pureai.com/articles/2025/10/21/openai-launches-chatgpt-atlas.aspx));
  Perplexity Comet's assistant sees the page and navigates on the user's behalf
  ([TechCrunch, 2025-07-09](https://techcrunch.com/2025/07/09/perplexity-launches-comet-an-ai-powered-web-browser/)).
  They repeat tasks with a model; none of these sources describes them building a persistent
  tool of code.
- **Hand-written extension in hackable browsers.** qutebrowser's userscripts are executables of
  any language, given the page's state in environment variables and sending commands back
  through a FIFO, with no permission model described
  ([qutebrowser userscripts](https://qutebrowser.org/doc/userscripts.html)). Nyxt is configured
  and extended in Common Lisp in `~/.config/nyxt`
  ([ArchWiki, Nyxt](https://wiki.archlinux.org/title/Nyxt)). Arc's Boosts customise a site with
  CSS and JavaScript, and Boosts with JavaScript cannot be shared "for security reasons"
  ([Arc help](https://resources.arc.net/hc/en-us/articles/19212718608151-Boosts-Customize-Any-Website),
  [Wikipedia, Arc](<https://en.wikipedia.org/wiki/Arc_(web_browser)>)).

What this design adds to these, as far as the sources above show: the user's own local coding
agent, through MCP (D14); a test on the live page in a sandbox before review (D17-D19); a
permission manifest that Vimma, not the agent, states in words, including what it cannot
prevent, with a new approval whenever an update asks for more (D9, D21, D24); numbered versions,
rollback and a safe mode (D12, D13);
loading and unloading without a restart (D11); and module files that the user can edit by hand,
next to `config.toml` (D10).

## Design

### Data flow

```
ctrl+b m ──▶ request (memory) ──▶ vimma_module_requests ──▶ user's coding agent
                                                              │ writes ~/.config/vimma/modules/<name>/
                                                              │ vimma_module_test ──▶ vimma-ctl starts a
                                                              │     headless Vimma, empty profile, sandbox role
                                                              ▼
                     review screen ◀── Vimma reads and checks the working copy ◀── vimma_module_propose
                         │ y
                         ▼
   <profile>/vimma/modules/<name>/<n>/ (generated manifest + background, files as reviewed, hash)
                         │ AddonManager.installTemporaryAddon
                         ▼
   key in the module layer ──▶ ModuleHost checks the tab ──▶ ExtensionShortcuts.onCommand
                         ──▶ activeTab ──▶ scripting.executeScript / insertCSS on that page
```

### Decisions

1. **Ease of building is a goal of its own, with safety as the constraint** (D1, Behaviour 1, 8,
   17, 19-22), because a tool that takes more effort than its use saves is not built, and an
   unsafe shortcut that is easy will be preferred to a safe path that is not. Each step has one
   key or one sentence: one key to ask, defaults that need no permission choices for the common
   cases, one screen and one `y` to approve, "change it to …" to refine, and plain files to
   list, toggle, edit and share.
2. **Three tiers: configuration, modules, and never Vimma's code** (D2, Behaviour 4-6), so that
   each request takes the least powerful form that serves it. A setting or binding is a
   `config.toml` line that the user can read in full; code on a page is a module with declared
   permissions; changes to Vimma itself go through the project.
3. **Tier 1 proposes only keymap and display settings** (D3, Behaviour 4). An agent may propose
   edits to `[keys]`, `[modal]` and its mode tables, `[unbind]`, `[sites]`, `[panes]`, `[theme]`
   and `[modules.<name>]`, written with `setTomlKeys` and validated by `parseConfig` before the
   diff is shown, so a proposal that would not load is never offered. Within those tables a
   proposal is refused if it binds or unbinds `mcp.answer`, `mcp.command`, `control.command`,
   `firefox.command`, `app.restart` or `workspace.route` (`actions.mjs:129-131`, `:188`, `:191`,
   `:385-387`), or sets a `[modal.*]` value that starts with `:`, because such a value runs any
   command line as if typed ([firefox-keys](firefox-keys.md) decision 5, `actions.mjs:23`), so a
   binding could reach `:control on`, `:mcp on` or `:route add`. Rejected: any table, since an
   agent steered by a page could then propose turning on MCP or full control, moving the
   download quarantine, or turning off update checks (`[mcp]`, `[updates]`, `[agent]`,
   `[modules] enabled`); these stay the user's to type.
4. **The runtime AI never edits Vimma's own code** (D4, Behaviour 6). Rejected: letting the agent
   change Vimma's source and rebuild, because chrome code has full privileges, so no permission
   can be scoped; prompt injection from a page could then steer changes to the browser itself; a
   locally changed build diverges from the signed releases, and the next update overwrites it or
   conflicts with it (security.md B10, UP7); and it needs a rebuild, so it cannot be loaded
   without a restart.
5. **Modules add no capability Vimma does not offer** (D5, Behaviour 6). A request that needs one
   (a new action, chrome UI, keys outside the module layer, another tab, a network host) is
   answered `this needs a change to Vimma` through `vimma_module_needs_change`, and offered as an
   issue (D27), because a workaround (a broader permission, full control, a script that reaches
   further than its manifest says) would turn the permission words into a claim the module does
   not keep. `INSTRUCTIONS` tells MCP agents so.
6. **Promotion is optional and the user's** (D6, Behaviour 24), so that a module that is
   generally useful can reach Vimma the way a popular Neovim plugin moves into core: through the
   project's normal pipeline (a spec, tests written first, a review by a fresh agent, CI, a merge
   by the maintainer and a signed release), never by copying the module's code in unreviewed.
   This is how users' tools feed the project's goal of evolving with little hand work
   (plan.md:3, :193), while each change to Vimma keeps that pipeline's safety properties.
7. **A module is a WebExtension, generated by Vimma from `module.toml`** (D7, Behaviour 7). The
   agent writes `module.toml`, page scripts, style sheets and tests; Vimma generates the
   Manifest V3 `manifest.json` and a fixed background script from them, so the manifest can
   hold nothing outside the module vocabulary, and the module runs on Firefox's own extension
   machinery: content-script isolation with Xrays and an expanded principal, per-tab activeTab,
   permission enforcement, and loading and unloading at run time, all maintained upstream.
   ADR-024 records the format. Rejected:
   - **A Vimma-native module in a `Cu.Sandbox`** with a capability API of Vimma's: Vimma's chrome
     would evaluate generated code (security.md C2, `chrome-source.test.mjs:57-58`, forbids
     `evalInSandbox`), and Vimma would have to rebuild Xray handling, principals, permissions,
     lifecycle and CSP that Firefox already enforces.
   - **A userscript-style content script** (the `userScripts` API): its sandbox has only the
     page's principal, so it is isolated from the page no better than the page itself
     (`ExtensionContent.sys.mjs:945-962`), and the API registers code at run time, so what runs
     need not be what was reviewed.
   - **An arbitrary WebExtension**: its manifest could ask for anything an unprivileged extension
     may (`tabs`, `cookies`, `<all_urls>`, `webRequest`, a background page with network access),
     which no plain-words summary can make safe to approve with one key.
8. **Loaded as a temporary add-on from Vimma's approved copy** (D8). A temporary add-on needs no
   signature (`XPIDatabase.sys.mjs:455-459`) and is never privileged on a release build
   (`Extension.sys.mjs:968-975`, `AddonSettings.sys.mjs:103-117`), so a module cannot request
   privileged permissions or experiment APIs. Temporary add-ons are removed at shutdown
   (`XPIProvider.sys.mjs:3053`), so Vimma installs each enabled module's approved version at
   every start, checking its hash each time (D10). The chrome-source test allows
   `installTemporaryAddon` in one more file, `modules/ModuleHost.sys.mjs`, called only with a
   folder under `<profile>/vimma/modules/`.
   Rejected: building with `MOZ_REQUIRE_SIGNING` off, which would load every unsigned add-on;
   the built-in location, which makes add-ons privileged; signing each module through
   addons.mozilla.org, which sends personal code to Mozilla and needs an account and a wait.
9. **The module vocabulary is small and Vimma states it** (D9, Behaviour 7-8, 16). `module.toml`
   gives a name (lower case, `[a-z0-9-]`, at most 32 characters), a description, `api = 1`, at
   most 16 commands (each with a script and/or a style sheet and keys) and `[permissions]`
   (`sites`, `theme`, `storage`). There is no read-only level for a script: a script on a page
   can both read and change it, and no Firefox API runs one that can only read, so the words say
   what any script may do rather than what the agent says it does. `storage = true` is said as
   `keeps data that every workspace's pages share`, because extension storage is one store for
   the extension, not one per container, so it can carry what it saw in one workspace into
   another.
   The generated manifest has `manifest_version: 3`, `incognito: "not_allowed"`, the ID
   `<name>@modules.vimma`, `permissions` drawn only from `activeTab`, `scripting` and (with
   `storage = true`) `storage`, no `host_permissions`, no `content_scripts`, no web-accessible
   resources, no `externally_connectable`, no popup or options page, and a CSP no looser than
   Firefox's MV3 default. The background script is Vimma's fixed text: on a command it calls
   `scripting.insertCSS` and `scripting.executeScript({ files })` for that command on the tab
   activeTab names, and relays test results (D18); it never calls `commands.update`, and
   content scripts have no `commands` API. Proposals over 256 KiB, with more than 32
   files, with a binary file, a symlink, or a file the manifest does not name are refused, so
   the review shows everything that loads. The permission words are generated from the parsed
   `module.toml` by `vimma-core`, so the agent's text never describes what a module may do.
10. **Two places: the working copy and the approved versions** (D10, Behaviour 7, 20-23). The
    working copy is `~/.config/vimma/modules/<name>/`, beside `config.toml`, because that is
    where users keep and share their configuration (a dotfile repository), and it is what they
    and their agent edit. What loads is an approved version, written by Vimma at approval into
    `<profile>/vimma/modules/<name>/<n>/` from the bytes the review showed (read once, held in
    memory, never re-read from disk between review and copy), with its SHA-256 and permissions
    recorded in `<profile>/vimma/modules.json`. The approved copy's files are mode 0400 in 0500
    folders. Every install checks the files against the recorded hash first: at start, on
    approval, on a rollback and on the theme reload of D23. So a change to the working copy, by
    the user, the agent or anything else, never loads without a review. This does not cover a
    write to the approved copy after it was installed: `scripting.executeScript({ files })` reads
    the file when the command runs, so a process that changes the mode and rewrites a file
    changes what runs until the next install. That process runs as the user (Security and
    privacy, "Tampering on disk"). Rejected: loading the working copy directly, because any
    process could then change code that runs after approval.
11. **Hot-loading and unloading** (D11, Behaviour 11, 18). Approval installs the new version
    with `installTemporaryAddon`, which replaces the version in force of the same ID in place
    (`XPIInstall.sys.mjs:4940-4986`), so that a module is never briefly absent with its keys
    still bound. The ID `<name>@modules.vimma` is Vimma's; a permanent add-on with that ID is
    refused at start and not shadowed, because the temporary location would take precedence
    over it (`:4945`). Turning a module off uninstalls it;
    Firefox's extension shutdown ends its background and its listeners. What a script already
    did to an open page stays until that page reloads (Behaviour 11), because Firefox does not
    undo DOM changes; whether style sheets inserted with `scripting.insertCSS` are removed when
    the extension shuts down is **unverified** (a mochitest that turns a module off and reads the
    page's computed style settles it, and the notice is worded by its result). Whether
    `storage.local` survives a reinstall with the same ID is **unverified** (a mochitest that
    stores, reinstalls and reads); Vimma does not rely on it.
12. **Numbered versions, not Git** (D12, Behaviour 20, 23). Each approval is a full copy under
    the next number, the last ten are kept, and a rollback loads an earlier copy by its recorded
    hash, so that a version is one folder the user can inspect. Git would need a process
    (security.md C2) or a dependency. A rollback to a version whose permissions exceed those in
    force asks in the review screen (Behaviour 18); one to fewer permissions does not.
13. **Safe mode** (D13, Behaviour 23). No module loads in Firefox's troubleshoot mode
    (`Services.appinfo.inSafeMode`), with `[modules] enabled = false`, or after `:modules off`
    until `:modules on` or a restart, so that a module that misbehaves can be stopped without
    knowing which. No crash marker is kept, since no module code runs at start: the background
    script is Vimma's fixed text, and a module's scripts run only on its keys. Rejected: relying
    on troubleshoot mode only, because it also turns off the user's other add-ons and theme.
14. **The user's own coding agent writes modules, through `vimma-ctl mcp`** (D14, Behaviour 2,
    13, 15). Coding agents (Claude Code, Codex, opencode) already write, run and test code, and
    already reach Vimma through `vimma-ctl mcp` (ADR-019); the tools of Behaviour 13 are
    `vimma-ctl` tools that read and write no tab. Vimma's chrome starts no process
    (security.md C2), so it never launches the agent; the request waits until an agent reads it.
    Which agent writes modules is open question 1. Rejected: a hosted generation service, which
    would send the request and the page to a party the user did not choose.
15. **The agent gets the request, and the page's address only if left in** (D15, Behaviour 1).
    It gets the request's text, the address unless `Tab` left it out (never in a private
    window), the module API reference, and for a refinement the module's files. It never gets
    the page's text or a snapshot of its DOM from the user's tab, because that tab is logged in
    and its text would go to the agent's model; the agent fetches the address itself, signed
    out, in the sandbox (D18). A snapshot on request is open question 4.
16. **Requests wait in memory and are listed by any connected agent** (D16). A request is the
    user's own text, so reading it needs no question; it is dropped at quit, when the review
    screen rejects its proposal, and with `:module cancel`. At most 8 wait at once.
17. **The sandbox is a separate headless Vimma with an empty profile** (D17, Behaviour 14),
    started by `vimma-ctl` (a separate program, not chrome code: C2 holds) as the e2e harness
    starts one (`tools/e2e/launcher.mjs:137`, `:218-219`), with `--headless`, `-no-remote`, a new
    profile and the flag `-vimma-module-sandbox`. The module is unapproved, so it must not load
    in the user's own browser, even in the agent workspace: WebExtensions are not confined to a
    container, and a module loaded there would run in every workspace. Rejected: the agent
    workspace, for that reason; an OS container, which would add a dependency and differs per
    platform (open question 8). That Vimma's chrome, its control socket and `drawSnapshot` run
    under `--headless` is **unverified** (the e2e scenario `module-sandbox`, run with
    `--headless`, settles it; until then the sandbox runs under Xvfb as e2e does). The sandbox
    loads only http and https addresses and refuses `file:`; the address `vimma-ctl` is given
    must not be loopback, private (RFC 1918, RFC 4193), link-local or `.local`, unless it is the
    address of the request it tests, which came from the user's own page. `vimma_module_test`
    runs in `vimma-ctl mcp`, outside an agent host's own sandbox, so without this rule an agent
    could have it read local files or intranet pages. The sandbox also cancels requests whose
    resolved address is in those ranges; that the resolved address can be checked before the
    request is sent is **unverified** (a mochitest with a host name that resolves to
    `127.0.0.1` settles it), and without it a name that resolves to a private address after the
    check reaches it. Open question 8 adds an OS sandbox on top.
18. **The sandbox fetches the live page, signed out** (D18, Behaviour 14, 16). The sandbox opens
    the address in its own empty profile, so the page is the live page as a visitor without the
    user's cookies sees it. Tests are scripts in `tests/`, injected only in the sandbox, which
    report through `browser.runtime.sendMessage` to the generated background script, which logs
    each result with the module's add-on ID; a content script's own console output carries no
    add-on ID (`caps/ExpandedPrincipal.cpp:124-127`), its background's does
    (`dom/console/Console.cpp:148-153`). Rejected: a DOM snapshot of the user's tab, because it
    carries the logged-in page to the agent and does not run the page's scripts, so it tests
    less; the user's tab itself, because the module is not approved.
19. **What the test proves, and what it does not** (D19, Behaviour 16). A pass shows that the
    module loads, its commands run on the page as a signed-out visitor sees it, the agent's own
    assertions hold, and which requests its scripts made. It does not show that the module is
    harmless (a module can behave differently on another page, or later), nor that it works on
    the logged-in page. The review says `signed out` and the guide says the rest. Safety rests
    on D9, D20-D24 and the review, never on the test, because the page under test chooses what
    the sandbox sees and can make a module's tests pass.
20. **A module command runs only where the user is, on the user's key** (D20, Behaviour 8, 10).
    The host checks the selected tab before it dispatches: not private, not in the agent
    workspace or its container, an http or https page inside `sites`, and no password, card or
    one-time-code field in any frame, filled or empty (`plainlySensitive`,
    `actors/agent-fields.mjs:181`, asked of every frame as for agent screenshots). The check
    covers empty fields too because a script stays in the page and could read what is typed
    later. Then it calls `ExtensionShortcuts.onCommand`, which grants activeTab on
    `tabTracker.activeTab` (`ext-commands.js:17-21`, `ext-browser.js:775-781`). ModuleHost
    asserts, in the same task and after the grant, that this is the tab and the inner window it
    checked, and revokes activeTab and runs nothing if it is not (a focus change between the
    check and the grant, or a split whose selected pane changed), so the grant never lands on a
    tab that was not checked. activeTab then lasts for that document and is not cleared by an
    in-page route change or a back-forward cache restore (`ext-tabs-base.js:2184-2187`); the
    child watches `DOMInputPasswordAdded` and `DOMFormHasPassword` in a page where a module ran
    and shows Behaviour 10's warning. Left: a module that ran can still read a login form the
    page adds later if the user types before reloading; the guide and the permission words say
    so. The agent workspace is excluded so that what agents read and the gate's checkpoint
    signals (mcp-checkpoints) never depend on which modules are on. A shortcut given to a module
    command in about:addons ("Manage Extension Shortcuts") would run it through Firefox's own key,
    past these checks, so ModuleHost resets every module command's shortcut at install and on
    each change (`resetCommand`, `ExtensionShortcuts.sys.mjs:209-217`). Persistent per-site
    modules, which run on every load, are open question 2.
21. **Network: best effort, and said plainly** (D21, Behaviour 8, 16), because a module that
    reads a page could send what it read to any host, and Vimma cannot stop every way of doing
    so. The generated background makes no request, and content scripts in MV3 have only the
    page's own network capabilities (`ExtensionContent.sys.mjs:1067-1080`). On top,
    `modules/ModuleNet.sys.mjs` observes requests (`http-on-opening-request`) whose triggering
    principal is, or expands to, a module's, and cancels any to a host other than the page's
    own, recording it for the test report and `:modules`. That catches the module's own `fetch`
    and `XMLHttpRequest` and an absolute URL it sets as an attribute. It cannot catch what loads
    as the page (`nsContentUtils.cpp:2549-2575`): a relative or protocol-relative URL, markup
    inserted with `innerHTML`, a `<script>` added to the page (which the MV3 CSP does not stop,
    since it covers only the content script's sandbox, `all.js:3166`), a change of `location`, a
    form submission, an `<a ping>`, and a style sheet's `url()`, including selectors that leak
    attribute values one request at a time. So the permission words for every command say
    `can send what that page shows to other sites through the page`, a style-only command
    included, and the guide lists these paths as known limits, each with a test that records
    the current behaviour. Declared network hosts are open question 3.
22. **Keys in a module layer, run through one action** (D22, Behaviour 9). The dispatcher gains
    one action, `module.run`, whose binding carries `module/command`; module keys compile into a
    layer under `config.toml`'s, so the user's keys always win, and a module key that would
    hide a default or the user's binding is refused at review. `module.run` is one new entry in
    `actions.mjs`, and modules add no others, so `ctrl+b ?`, the bindings docs and config
    validation stay generated from one table; the Modules group in `ctrl+b ?` is built from the
    loaded modules. This changes the dispatcher contract, so ADR-024 covers it. pdf-mode's
    ADR-023 adds keymap contexts to the same files (`keymap.mjs`, `dispatcher.mjs`); whichever
    lands second builds on the other, and the module layer applies in every context.
23. **Theme colours as data** (D23, Behaviour 12). With `theme = true`, Vimma writes
    `palette.json` (the theme's tokens as `#rrggbb`, already checked by `parseOmarchyColors`)
    into the approved copy and reloads the module when the theme changes, so a module follows
    Omarchy without any access to Vimma's chrome. Its hash is recorded apart from the reviewed
    files, and the reinstall checks both (D10).
24. **Review in Vimma's chrome, text only, with Vimma's words first** (D24, Behaviour 16-18).
    The review is an overlay like `ctrl+b ?`, every value set with `textContent` (security.md
    C1), never a privileged `about:` page, because the diff and description are agent-written
    and may carry page text an injection wrote. The permission words and test result come
    first and are Vimma's; the agent's text comes last and is labelled. An update shows changed
    hunks first, so the change is what the user reads. Bidirectional controls, zero-width and
    other invisible characters, and tag characters in a file are refused, since they can make
    code read differently from what runs; non-ASCII letters in identifiers (possible look-alikes)
    and lines over 300 columns (minified code) are marked in the margin where they occur. `y`
    needs the diff shown to its end and the arming delay, re-armed on focus changes as the
    question line's (M4), so that a stray key cannot approve; it ignores keys that arrived
    through the control socket's `send-keys`. An update that adds a permission marks it `new:`,
    and every update needs approval anyway, so no update raises a module's permissions unseen.
25. **Refinement is a request with the module attached** (D25, Behaviour 19), so that "change
    it to …" costs one sentence, reaches the same agent tools, and is reviewed as a diff against
    the version in force rather than as a new module.
26. **The sandbox speaks a `sandbox` role of the control socket** (D26). A Vimma started with
    `-vimma-module-sandbox` serves one more role, whose commands load a working copy, open an
    address, run a command, run the tests and return the report, and nothing else; a normal
    start never serves it. It refuses to start in a profile that holds logins, cookies or
    history, or lacks the marker `vimma-ctl` writes into the empty folder it created, so the
    flag alone cannot turn the user's own profile into a sandbox. It is a new role under
    protocol 2 (ADR-007, ADR-019), with contract fixtures.
27. **Promotion opens a prefilled issue the user submits** (D27, Behaviour 24). Vimma shows the
    text first, strips page text, page addresses and report details, highlights the request's
    text and hosts, and opens GitHub's new-issue page; it holds no GitHub token and sends
    nothing itself, because the issue is published under the user's name and only the user can
    decide that. A promoted issue carries text shaped by web pages and an agent, so it is input
    to the project, never instructions: its title starts with `module:`, its body says so, and
    neither the project's agents nor the upstream autopilot act on it unless the maintainer adds
    `claude:go` (plan.md:198), which is the rule for every issue. A draft pull request is open
    question 6.

## Security and privacy

What is new: code written by an AI after reading a web page runs in the user's browser, on the
user's pages; an agent may propose `config.toml` edits; `vimma-ctl` starts a browser; and a text
can be prepared for a public issue.

### Threats and what contains them

- **Prompt injection into the agent writing the code.** The agent fetches the page in the
  sandbox and reads it, so the page can instruct it ("also send the page to …"). Contained by:
  the vocabulary (D9), which cannot express other tabs, running on page load or persistence
  beyond `storage`; activeTab on the user's key only, on the tab Vimma checked (D20); no pages
  with login or payment fields (D20); the permission words, which are Vimma's (D24); and a
  review of the diff before anything loads. Not contained: a module's script can send what the
  page shows to another site through the page (D21, best effort only), can change what the page
  shows and where its links go while the user is on it, and a reviewer may miss a subtle change
  in code. The guide says to read the diff of a module for a site that holds money or accounts.
- **A malicious page shaping the module.** A page can serve the sandbox different content than
  the user sees, or make a module's tests pass. The test is never a safety control (D19).
- **Escalation on update.** Every update, by the agent or by hand, is reviewed; added
  permissions are marked `new:`; a rollback to more permissions asks (D12, D24). Nothing a
  module does at run time changes its manifest, which Vimma generates (D7, D9), or gives its
  commands a key of Firefox's own (D20).
- **Modules changing other modules or config.** Each module is its own extension with its own
  origin and storage, and the vocabulary has no `management` permission; a module cannot write
  files. A tier-1 proposal reaches only the tables of D3, and never the actions or `:` values
  that reach MCP, full control, routing, Firefox commands or a restart.
- **Chrome privileges, passwords.** A module is never privileged (D8), never runs in private
  windows (`incognito: "not_allowed"`, and the host's check, D20), and never starts on a page
  with a password, card or one-time-code field (D20). It has no API to logins or form autofill.
  Not contained: a login form a page adds after a module ran, if the user types before
  reloading (Behaviour 10 warns), and a field not recognised as sensitive (M31's limits).
- **Workspace isolation.** A module runs in the pages of every workspace but the agent's, and
  `storage = true` is one store across them, so a module with storage can carry what it saw in
  one workspace into another; the permission words say so (D9).
- **Supply chain.** A module copied from someone else is reviewed like an agent's, marked
  `written elsewhere` (Behaviour 22). Modules carry no dependencies: every file the extension
  loads comes from its folder, and the 32-file, 256 KiB cap keeps a review readable. A script
  can still add a remote `<script>` to the page it runs on, which then runs as the page (D21);
  the review shows any URL in the code.
- **Interaction with MCP and grants.** No grant, question-line answer, agent tool or `send-keys`
  key approves a module or a config edit (Behaviour 18); `vimma_keys` cannot press a module key,
  because module keys are not in its whitelist (security.md M16); modules never run in agent
  tabs (D20). The module tools read and write no tab and need MCP on.
- **Tampering on disk.** An agent with a shell is a semi-trusted process
  ([vimma-mcp](vimma-mcp.md), Security, the threat "A local process uses the socket"), not
  malware, so the module files are laid out for it to be confined. It writes only the working
  copies; the approved copies and `modules.json` are in the profile, every install checks the
  hash (D10), and the files are read-only. The guide's "Keeping agents out of your Vimma
  profile" (`docs/guide.md:1754-1773`) denies the agent all of `~/.config/vimma/**`, which on
  Linux also holds the profile; it changes to: the agent may read and write
  `~/.config/vimma/modules/**`, and is denied the profile folders (`~/.config/vimma/vimma/`,
  `~/.vimma/`, `~/Library/Application Support/Vimma/`) and `~/.config/vimma/config.toml`. An
  agent that is not confined that way can rewrite an approved copy after it is installed (D10)
  or its record; that is outside what Vimma can bound (security.md §11).
- **The sandbox.** `vimma-ctl` starts the Vimma binary next to it with fixed arguments and a
  folder it created; the sandbox role exists only in that instance (D26); the instance has no
  cookies, logins or history, loads only http and https, refuses local and private addresses
  the module request did not carry (D17), and is deleted after the test.
- **Promotion.** Nothing is sent by Vimma; the user sees the whole text first and submits on
  GitHub (D27). A promoted issue is untrusted input to the project and is never acted on by its
  agents or autopilot without the maintainer's label.

### What `docs/security.md` must say, with the implementation

A new section after pdf-mode's §18, "19. Modules (`modules/ModuleHost.sys.mjs`)", with rules and
their tests:

- MO1. A module **must** be installed only from an approved copy under
  `<profile>/vimma/modules/`, and **never** from the working copy; every install (at start, on
  approval, on a rollback and on the theme reload) **must** first check the files against the
  SHA-256 recorded at approval. The rule does not cover a write to an installed copy, whose
  files are read when a command runs (D10).
- MO2. A module, version, hand edit, copied module or rollback to more permissions **must not**
  load without `y` typed in the review screen, after the diff was shown to its end and the
  arming delay, re-armed on focus changes; no grant, question-line answer, MCP call, key sent
  by the `full` role's `send-keys` or config value **ever** approves one.
- MO3. The manifest **must** be generated by Vimma from `module.toml`: MV3, `incognito:
"not_allowed"`, permissions only `activeTab`, `scripting` and `storage`, no host permissions,
  content scripts, web-accessible resources, external connections or pages, and a background
  that never calls `commands.update`; a proposal with anything else, a binary file, a symlink,
  an unnamed file, more than 32 files or more than 256 KiB **must** be refused.
- MO4. Modules **must** be installed only with `installTemporaryAddon`, only by
  `ModuleHost.sys.mjs`, and **must** never be privileged; a permanent add-on with a module's ID
  **must** be refused.
- MO5. A module command **must** run only on the user's key through `module.run`, only on the
  tab and document ModuleHost checked and activeTab was granted on, only on an http or https
  page inside its `sites`, and **never** in a private window, an agent-workspace tab or on a
  page with a password, card or one-time-code field; a shortcut set for a module command
  outside Vimma **must** be reset.
- MO6. Requests a module's script makes with its own principal to a host other than the page's
  own **must** be cancelled and recorded. This is best effort: what loads with the page's
  principal is not caught (D21), and the permission words **must** say that every command can
  send what the page shows to other sites.
- MO7. Every update **must** be reviewed, and a permission it adds **must** be marked `new:`.
- MO8. The permission words **must** be generated from the parsed `module.toml`, never taken from
  the agent; all review text **must** be set as text; files with bidirectional controls,
  invisible or tag characters **must** be refused, and non-ASCII identifiers and lines over 300
  columns **must** be marked.
- MO9. No module **must** be loaded in troubleshoot mode, with `[modules] enabled = false`, or
  after `:modules off`.
- MO10. A tier-1 proposal **must** touch only the tables of D3, **must not** bind or unbind
  `mcp.answer`, `mcp.command`, `control.command`, `firefox.command`, `app.restart` or
  `workspace.route`, or set a `:` command value, and **must** parse before it is shown; `y`
  writes it atomically, keeping comments and mode.
- MO11. The `sandbox` role **must** be served only by an instance started with
  `-vimma-module-sandbox` in a profile with `vimma-ctl`'s marker and no logins, cookies or
  history; the sandbox **must** load only http and https, and **must** refuse loopback, private,
  link-local and `.local` addresses other than the request's own.
- MO12. The agent **must not** receive page text or a DOM snapshot of the user's tabs, nor the
  address of a private window's page; the address it gets has no query or fragment unless the
  prompt was switched to send them.
- MO13. Promotion **must** send nothing itself, **must** show its whole text first, and **must
  never** include page text, page addresses or the sandbox report's details; the issue it
  prefills **must** say that it holds untrusted text.
- A1 and the chrome-source test gain the module exception (D8); A3's picker leaves modules out,
  recognised by the temporary install location together with `modules.json`, not by their ID.

### Privacy

The request's text and, unless left out, the page's address go to the user's coding agent and,
through it, to whatever model that agent uses. The sandbox makes signed-out requests to the
page's site from the user's IP address. Nothing else leaves the machine. Modules and their
versions stay in the profile and `~/.config/vimma/modules/`.

## Tests

### Vitest (`packages/vimma-core`)

- `modules.test.mjs`: `module.toml with the defaults gives a command on activeTab`; `the
permission words of every command say it can send what the page shows`; `storage is worded as
shared by every workspace`; `a name outside [a-z0-9-] or over 32 characters is refused`; `the generated manifest
has MV3, incognito not_allowed and only activeTab, scripting and storage`; `no field of
module.toml can add a host permission, content script or page`; `binary files, symlinks,
unnamed files, 33 files and 256 KiB are refused`; `the permission words for each permission
set`; `an update that adds a permission marks it new`; `a rollback to more permissions needs
review, to fewer does not`; `ten versions are kept`.
- `module-requests.test.mjs`: `a private window's request carries no address`; `Tab leaves the
address out`; `at most 8 requests wait`; `a refinement carries the module's files`.
- `keymap.test.mjs`: `module keys sit under config.toml's`; `a module key that hides a binding is
refused`; `[modules.<name>] keys rebinds and [] unbinds`; `module.run carries module/command`.
- `config.test.mjs`: `[modules] enabled parses`; `a tier-1 proposal outside the allowed tables
is refused`; `a tier-1 proposal that does not parse is refused`; `a tier-1 proposal that binds
or unbinds mcp.answer, mcp.command, control.command, firefox.command, app.restart or
workspace.route is refused`; `a tier-1 proposal with a : command value is refused`.
- `help.test.mjs`: `ctrl+b ? lists module keys in a Modules group, marked with the module`
  (Behaviour 9).
- `control-v2.test.mjs`: `the sandbox role's commands, and no other role reaches them`.
- `fuzz/modules.fuzz.test.mjs`: `parsing any module.toml never throws and yields only the
vocabulary`.

### Mochitests (`tests/browser/`)

- `browser_vimma_modules.js` (new): `test_approved_copy_loads_and_the_working_copy_does_not`;
  `test_a_changed_hash_does_not_load`; `test_every_install_checks_the_hash`;
  `test_key_runs_the_command_on_the_selected_tab_only`;
  `test_a_tab_change_between_check_and_grant_runs_nothing`;
  `test_not_in_private_windows_or_agent_tabs`; `test_not_on_a_page_with_an_empty_password_field`;
  `test_a_password_field_added_later_warns`; `test_about_addons_shortcut_is_reset`;
  `test_a_permanent_addon_with_a_module_id_is_refused`; `test_approval_replaces_in_place`;
  `test_outside_sites_runs_nothing`; `test_module_is_never_privileged`;
  `test_hot_load_and_unload_without_restart`; `test_off_and_rollback`;
  `test_safe_mode_and_modules_off_load_none`; `test_theme_change_reloads_palette`;
  `test_addon_picker_leaves_modules_out`.
- `browser_vimma_module_net.js` (new): `test_a_script_fetch_to_another_host_is_cancelled`;
  `test_an_absolute_image_url_to_another_host_is_cancelled`; and the known limits of D21,
  each recording what happens today: `test_limit_relative_url_loads_as_the_page`,
  `test_limit_inner_html_loads_as_the_page`, `test_limit_injected_script_runs_as_the_page`,
  `test_limit_location_form_and_ping`, `test_limit_css_url_and_selector_leak`;
  `test_inserted_css_after_unload` (settles D11's unverified point).
- `browser_vimma_module_review.js` (new): `test_y_needs_the_diff_shown_and_the_delay`;
  `test_focus_changes_rearm_y`; `test_send_keys_never_approves`;
  `test_update_shows_hunks_first`; `test_bidi_and_invisible_characters_are_refused`;
  `test_lookalike_identifiers_and_long_lines_are_marked`;
  `test_permission_words_come_from_module_toml`; `test_review_text_is_never_html`;
  `test_grant_and_question_line_never_approve`; `test_hand_edit_asks_for_review`;
  `test_new_permission_is_marked`; `test_tier1_diff_writes_atomically`;
  `test_promote_shows_text_and_strips_addresses`; `test_promote_marks_the_issue_untrusted`;
  `test_promote_copies_files_that_do_not_fit` (Behaviour 24).
- `browser_vimma_module_sandbox.js` (new): `test_sandbox_refuses_file_and_private_addresses`;
  `test_sandbox_allows_the_requests_own_address`; `test_a_name_resolving_to_loopback_is_cancelled`
  (settles D17's unverified point).
- `browser_vimma_security_invariants.js`: `modules_install_only_from_the_approved_copy`.
- `tools/security/test/chrome-source.test.mjs`: `installs an add-on only from the setup page,
and modules only from ModuleHost`.

### vimma-ctl (`tools/vimma-ctl`)

- `module_tools_are_listed_and_reach_no_tab`; `module_test_starts_vimma_with_fixed_arguments`;
  `module_test_deletes_the_profile`; `sandbox_role_refuses_a_profile_without_the_marker`;
  `module_test_refuses_file_and_private_urls`;
  `instructions_say_needs_change_rather_than_work_around`.

### e2e (`tools/e2e`)

- `module-sandbox`: a fixture page; `vimma-ctl module test` on a fixture module with a passing
  and a failing test and a request to a second host; the report lists both tests and the
  blocked request; run under `--headless` too (settles D17's unverified point).
- `module-loop`: a scripted agent over `vimma-ctl mcp` reads a request, writes a module,
  tests and proposes it; the review is approved with `y`; the key dims the fixture page; `c`
  refines; rollback. Screenshots with the Omarchy theme: the request prompt, the review screen,
  `:modules`.

## Docs and changelog

- `docs/guide.md`: a "Modules" section after "Add-ons": asking for a tool, the three tiers, the
  module folder and `module.toml`, the default permissions and what each permission word means,
  the review screen, refining, `:modules`, hand editing, sharing, versions and rollback, safe
  mode, what the sandbox test shows and does not, promotion; what a module on a page can send
  through the page, and reloading before typing a password where a module ran; "What Vimma
  protects, and what it does not" gains modules; "Keeping agents out of your Vimma profile"
  gets the new deny rules (Security and privacy, "Tampering on disk"); Features at a glance
  gains a line.
- `docs/security.md`: §19 above, with A1, A3 and C2's test updated.
- `docs/limits.md`: the sandbox sees the signed-out page; a module's changes to an open page stay
  until it reloads; modules do not run on page load (open question 2); the network paths
  ModuleNet cannot see (D21); module storage is shared by every workspace.
- README: a line in the feature list.
- `docs/bindings.md`, `docs/bindings.json`, `defaults.toml` and the help snapshot: regenerated in
  each keymap PR.
- `CHANGELOG.md`: added by the maintainer at merge.

## Delivery

Each PR is mergeable and tested on its own, and nothing loads a module before the review
screen exists (MO2). PRs 1, 3, 6 and 8 change `actions.mjs` or `defaults.mjs`, so each is a
keymap PR: one at a time, never alongside another keymap PR, each regenerating the bindings docs
and the help snapshot, with a screenshot of `ctrl+b ?`.

1. `feat(modules): the module format in vimma-core` (D7, D9, D12, D22): ADR-024, `modules.mjs`
   (parser, validator, generated manifest and background, permission words, version model), the
   module layer and `module.run` in `actions.mjs`, the keymap and the dispatcher, with vitest.
   A keymap PR; no user-visible change.
2. `feat(modules): the review screen and approval records` (D24, Behaviour 16-18): the review
   overlay, `ModuleStore` with the approved copies and `modules.json`, with mochitests. It
   approves and records, and loads nothing yet. Security review by a fresh agent.
3. `feat(modules): load approved modules without a restart` (D8, D10, D11, D13, D20, D23):
   `ModuleHost`, `:modules`, `:module on|off|remove|rollback|install`, hand-edit detection,
   sharing, safe mode, the security.md section and the chrome-source change, the guide section,
   mochitests. A keymap PR. From here users can write modules by hand. Security review by a
   fresh agent.
4. `feat(modules): block a module's own requests to other hosts` (D21): `ModuleNet`, the
   known-limit tests, the permission words' network sentence checked against them. Security
   review by a fresh agent.
5. `feat(modules): test a module in a sandbox Vimma` (D17-D19, D26): `-vimma-module-sandbox`,
   the `sandbox` role and its fixtures, `vimma-ctl module test`, the address rules, e2e
   `module-sandbox`. Security review by a fresh agent.
6. `feat(modules): coding agents build modules from a request` (D3, D14-D16, D25): the request
   prompt (`:module new`), the MCP tools, refinement, tier-1 proposals with their denylist,
   `INSTRUCTIONS`, e2e `module-loop`. A keymap PR. Security review by a fresh agent.
7. `feat(modules): offer a module to Vimma as an issue` (D6, D27).
8. `feat(keys): ctrl+b m asks for a tool` (open question 5): one keymap PR.

## Open questions

1. **Which agent writes modules.** (a) The user's own coding agent through `vimma-ctl mcp`
   (D14). (b) The built-in agent ([builtin-agent](builtin-agent.md), #535), which would need
   file and test tools it does not have. (c) Both, (b) later. **Recommendation: (a)**, because
   coding agents already write and test code and connect to Vimma, and giving the built-in
   browsing agent file tools would widen its reach; (c) can follow once the built-in agent
   exists.
2. **Persistent per-site modules.** (a) Only on the user's key (D20) in the first release.
   (b) Also modules that run on every load of declared sites, through host permissions and
   registered content scripts. **Recommendation: (a)**, then (b) in its own spec, because a
   module that runs on load runs in every workspace's container, the agent's included, and
   whether Firefox can confine registered content scripts to containers has not been checked.
   MV2's `contentScripts.register` takes a `cookieStoreId` (`content_scripts.json:75`), but
   MV3's `scripting.registerContentScripts` has none (`scripting.json:159`), so (b) would need
   MV2 or a check of its own in each page.
3. **Declared network hosts.** (a) None: a module reaches only the page's own host (D21).
   (b) `network = ["api.example.com"]`, shown in the permission words, allowed through
   `ModuleNet`. **Recommendation: (a)** for the first release, because every common case of
   D1 needs no network, and (b) needs D21's attribution settled first.
4. **A DOM snapshot of the user's page.** (a) Never (D15). (b) On a key in the request prompt,
   with the text shown before it is sent. **Recommendation: (a)**, because the snapshot carries
   the logged-in page to the agent's model, and the signed-out page in the sandbox serves most
   requests; (b) can be added if logged-in-only pages prove common.
5. **The request key.** (a) `ctrl+b m` (free in `defaults.mjs`; "module"). (b)
   `ctrl+b shift+m`. (c) None, only `:module new`. **Recommendation: (a)**, because one key to
   ask is part of D1 and `m` is free on the prefix layer.
6. **Promotion as a draft pull request.** (a) An issue only (D27). (b) Also a draft pull request
   that the user's agent opens from the user's own fork with `gh`, after the same preview.
   **Recommendation: (a)**, because a pull request implies code ready for review, while a
   promoted module is a reference that the project rebuilds with tests first.
7. **How many versions to keep.** (a) 10. (b) All. (c) A number in `[modules] keep_versions`.
   **Recommendation: (a)**, because modules are small and ten covers a session of refinements;
   (c) if users ask for more.
8. **An OS sandbox around the sandbox instance.** (a) None beyond the empty profile (D17).
   (b) On Linux, run it in a user namespace or a container (bubblewrap, podman) when available.
   **Recommendation: (a)** first, because the instance holds no user data and a container adds a
   dependency per platform; (b) as hardening once the loop is in use. (b) would also close the
   gap D17 leaves, a host name that resolves to a private address, since a network namespace
   can deny the local network outright.
