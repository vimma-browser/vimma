# ADR-026: The folders under `vimma/` form layers, checked by `npm run layering`

- Status: Accepted
- Date: 2026-11-13
- Extends: [ADR-005](005-pure-core-package.md) ("`vimma-core` is a pure ES module package"), from
  core to every folder of `src/browser/base/content/vimma/`

## Context

ADR-005 keeps `packages/vimma-core` free of Firefox, and eslint enforces it. Nothing ordered the
chrome folders around it: `host/` imported `actors/`, `agent/`, `ctl/`, `config/`, `ui/`,
`workspaces/`, `about/` and others, and most of those imported `host/` back, so a change to the
host could reach almost any folder and no folder could be read without the rest (issue #936).

Measured on the tree before this decision, counting every way one module reaches another, at
two levels:

- **Between modules**, among eager imports (those the module loader follows when the importer
  loads), there was one cycle: `host/native-swap.mjs` and `host/private-swap.mjs` imported each
  other, for one helper. Every other loop between modules closes through a lazy import (a
  `defineESModuleGetters` map, or `ChromeUtils.importESModule` inside a function): the code had
  already been bent to avoid load-order failures.
- **Between folders**, eager imports alone still form one cycle, through `host/`: the host
  imports `about/key-log.mjs` and `about/` imports the host; the host imports
  `ctl/AgentGate.sys.mjs` (from `VimmaHost.sys.mjs` and `agent-ui.mjs`) and `ctl/` imports the
  host; `workspaces/WindowWorkspaces.sys.mjs` imports `host/tab-labels.mjs` while the host
  imports `workspaces/`; `actors/VimmaParent.sys.mjs` imports the host while the host imports
  `actors/`; and `config/` joins through `host/` → `about/` → `config/` → `host/`. Each of these
  loops closes through one of the exceptions below, so the folder cycle goes with them.
- The real needs were few and repeated: the host shows the agent gate's state, runs a handful of
  `:` commands that belong to `config/` or `agent/`, and records keys for `about:vimma`; the
  agent chat window (`ui/agent-chat.mjs`, which the host imports eagerly to build it) reaches
  the agent, `config/` and the host's MCP state lazily; the parent actor hands page reports to
  the host.

eslint's `no-restricted-imports` sees only `import` declarations. Most of these edges are
`chrome://browser/content/vimma/…` strings passed to `ChromeUtils.importESModule` or to a lazy
getter map, which it cannot see.

## Decision

1. **Each folder has a layer.** A module may import modules of its own folder and of any folder
   in a lower layer. Folders of the same layer do not import each other.

   | Layer | Folders                                         | Role                                                                             |
   | ----- | ----------------------------------------------- | -------------------------------------------------------------------------------- |
   | 0     | `core/`                                         | Pure logic, no Firefox (ADR-005).                                                |
   | 1     | `services/` `search/` `updates/` `split/` `ui/` | Leaves: one job each, on core alone. `ui/` builds widgets and takes callbacks.   |
   | 2     | `workspaces/` `actors/`                         | Browser state (workspaces, containers, pane trees) and the bridge to pages.      |
   | 3     | `host/`                                         | The orchestrator: keys in, actions applied to the window.                        |
   | 4     | `config/` `ctl/`                                | Front doors that drive the host from outside: `config.toml`, the control socket. |
   | 5     | `agent/`                                        | The built-in agent, a client of the control commands (ADR-023).                  |
   | 6     | `about/` `setup/` `start/` `omarchy/`           | Pages and hooks, which read or set up everything below them.                     |
   | 7     | `vimma.js`                                      | The window script that wires everything at startup.                              |

   `licence/` holds pages only and imports nothing.

2. **Every import counts, eager or lazy.** An edge is any string that names a Vimma module: an
   `import` or `export … from` declaration, `ChromeUtils.importESModule`, a
   `defineESModuleGetters` map, `import()`, an actor's `esModuleURI` or a worker's URL. Eager
   means loaded while the importer evaluates (a declaration, or `importESModule` outside any
   function, in a function called on the spot, in a static block or a static field); lazy means
   loaded later (inside a function, a method or an instance field's initialiser). A lazy import of a higher layer breaks the rule as an eager one
   does, because laziness changes when a module loads, not what depends on what: a host that
   reaches `config/` lazily still cannot work without it, and if a lazy import were allowed, any
   upward import could be made legal by moving it into a getter. Type-only references (`@import`
   and `import("…")` in JSDoc) are comments that load nothing, and do not count.

3. **No eager import cycle, anywhere, with no exceptions.** Two modules that load each other at
   any distance depend on evaluation order: whichever loads second sees the other half-built.
   This holds inside a folder too.

4. **A lower layer reaches a higher one without importing it**, in one of three ways:
   - **A topic.** The lower module announces a change with `Services.obs.notifyObservers`, and
     the higher one observes it: `CONFIG_RELOAD_TOPIC`, `MCP_CHANGED_TOPIC` and the workspace
     store's `CHANGED_TOPIC` work this way. Use it when nothing needs an answer.
   - **A callback passed in.** The higher module hands a function down when it builds or starts
     the lower one: `ui/` widgets take their actions this way.
   - **An interface object passed in.** The higher module hands itself, or an object of the
     functions the lower one needs, as an argument: `host/runners.mjs` builds the action tables
     from the host it is given and never imports it (#941).

5. **The exceptions are listed, one import each.** `tools/layering/layers.ts` holds the layers
   and the imports that break them today, each with its importer, the imported module, its kind
   and its reason. `npm run layering` (in `npm run lint`, and its own step in `ci.yml`) parses
   every tracked module of `vimma/` and fails on an upward import the list does not hold, on a
   list entry whose import is gone or is now allowed, on an entry without a reason, on an eager
   cycle and on a folder without a `README.md`. Each entry says whether it stays or goes, and
   one that goes names the issue that removes it. A test pins the number of entries, so the
   list grows only with an amendment to this record. (Since changed: the last entry went with
   issue #936, and the list stays empty. `npm run layering` refuses any entry, whatever its
   reason or fate, and its test expects none: a new upward import reaches the higher folder as
   decision 4 says. Admitting one would change this decision, the check and its test, not a
   list.)

   A specifier the check cannot read is an error too: `import()`, `importESModule` or a getter
   map whose specifier is not a fixed string (a template literal with `${}`, a `+` chain, a
   variable), and a string that holds only part of a Vimma module URL. A `moz-src:///` URL into
   `vimma/` counts as its `chrome://` twin, and a page's `<script src>` and `<link href>` count as
   eager imports.

6. **Each folder has a `README.md`**: what it owns, its entry points, what it may import under
   this record, and the walkthrough or spec that explains it. `jar.mn` names every file it
   packages, so a README is never shipped.

## Exceptions

Seventeen imports break the layers on the day of this record, listed one by one in `layers.ts`
with why each cannot be avoided yet. All of them go, in follow-up pull requests of issue #936,
each without a change in behaviour:

- **The parent actor imports the host** (`actors/VimmaParent.sys.mjs` →
  `host/VimmaHost.sys.mjs` and `host/pdf-ops.mjs`, eager). Page reports (focus, clicks, text
  blocks, the PDF viewer's state) reach the host here. The parent actor only forwards them, so it
  belongs in `host/`, which may import `actors/`: `VimmaActors.register()` takes the parent's
  URL from `vimma.js` instead of building it from its own folder, and the child stays in
  `actors/`. This also ends the `actors/` ↔ `host/` folder loop. It changes how the actor is
  registered and `docs/security.md` section 13 names the file, so it gets a security review.
  (Since changed: done. The parent actor is `host/VimmaParent.sys.mjs`, its code unchanged but
  for three import paths. `vimma.js` passes its URL to `VimmaActors.register(parentURI)`, which
  registers the pair with the same options as before; `actors/` names no `host/` module, and
  `actors/` is out of the eager folder cycle.)
- **The host reads the agent gate** (`host/VimmaHost.sys.mjs` and `host/agent-ui.mjs` eager,
  `host/mcp-ops.mjs` lazy → `ctl/AgentGate.sys.mjs`). The `:mcp log` picker, the agent line and
  `:mcp revoke` show and act on the gate's questions, grants and log. That state is something
  the host shows, so it moves into a folder of its own with `mcp-ops.mjs` and `control-ops.mjs`,
  in a new layer between `workspaces/`/`actors/` and `host/` (it imports `workspaces/`, so it
  cannot share their layer); `ctl/` keeps the socket and the commands. It crosses a security
  boundary, so it is reviewed on its own against `docs/security.md`.
  (Since changed: done, without a new folder. The gate is `host/AgentGate.sys.mjs`, its code
  unchanged but for one import path (`../host/mcp-ops.mjs` became `./mcp-ops.mjs`). The planned
  folder was to hold the gate with `mcp-ops.mjs` and `control-ops.mjs`, and those two already
  live in `host/`; the gate imports only `core/` and `mcp-ops.mjs`, so `host/` already is that
  folder. `ctl/` and `agent/`, above it, import the gate downwards, and `mcp-ops.mjs` still loads
  it lazily, since the gate imports `mcp-ops.mjs` eagerly. Every caller reaches the same module
  as before under its new URL; what each can call is unchanged, and who may import it is narrower
  than before. In `ctl/`, any `ctl/` module and anything in layers 5 and up could import the gate,
  and three named `host/` modules through their exceptions; in `host/` the layers alone would let
  every host module and every folder above import it, so `RESTRICTED` in
  `tools/layering/layers.ts` lists exactly its seven importers of today (`host/VimmaHost.sys.mjs`,
  `host/agent-ui.mjs`, `host/mcp-ops.mjs`, `ctl/VimmaControl.sys.mjs`, `ctl/agent-commands.mjs`,
  `ctl/AgentDownloads.sys.mjs`, `agent/AgentChat.sys.mjs`). `npm run layering` fails on any other
  importer, eager or lazy; on a listed one that stops importing it; on a module that hands it
  on; and on an added line of a Firefox patch that names it. A new caller of the gate is a
  security review, then a line there; it is a rule on importers, not a layering exception. What
  the check cannot see is a function that calls the gate for someone else (an exported wrapper,
  a callback or a listener handed out, `host-services.mjs`): that is what the security review of
  a change to a listed importer must look for. The list is empty, and with it
  the eager folder cycle: no two folders import each other eagerly.) (Since changed, issue
  #1012: the importer rule is a set of allow-lists, each the one form the tree uses, so that
  a new form fails until it is reviewed; widening a list is a change to
  `tools/layering/` that needs a fresh security review. `docs/security.md` section 12
  lists what is checked, each item with its test: the load positions of the modules (fixed
  `.mjs` or `.js` URLs, no options, the gate only by its exact URL, in no worker, and only from
  a listed module), `ChromeUtils` and the loader only in their direct forms, the gate's file name
  only in a listed module's exact URLs, the hand-ons of a module that holds the gate (followed
  through aliases resolved by scope, and through the value of an assignment), the elements,
  URLs and policies of the pages, `jar.mn`, `vimma/moz.build` and the file types under `vimma/`
  as they are today, the added lines of Firefox patches, and vimma-core's reflective globals.
  "Limits of the check" says what each leaves to review.)
- **Two modules live in the wrong folder.** `host/VimmaHost.sys.mjs` records each key in
  `about/key-log.mjs` for `about:vimma`; the log moves to `host/`, which writes it.
  `workspaces/WindowWorkspaces.sys.mjs` saves and restores tab labels from `host/tab-labels.mjs`;
  the labels move to `workspaces/`, which saves the rest of the snapshot. Both moves change a
  `chrome://` URL that mochitests import, so each comes with its test edits in its own pull
  request. (Since changed: both moves are done; the key log is `host/key-log.mjs` and the labels
  are `workspaces/tab-labels.mjs`.)
- **The host runs commands of higher folders** (lazy: `host/VimmaHost.sys.mjs`,
  `host/agent-chat-ops.mjs` and `host/agent-ui.mjs` → `agent/AgentChat.sys.mjs`;
  `host/download-ops.mjs` → `ctl/AgentDownloads.sys.mjs`; `host/route-ops.mjs` →
  `config/ConfigHost.sys.mjs`). The agent line follows conversations, `:agent give` hands a tab
  over, the downloads picker marks an agent's downloads, `:route add` writes `config.toml` and
  reports the result. The higher folder hands the host an interface object at startup instead
  (decision 4). (Since changed: done. `host/host-services.mjs` holds the three services the host
  runs, `agentChat`, `isAgentDownload` and `addRoute`, and the host calls them through
  `HostServices`. `vimma.js`, the window script, which may import every folder, provides them with
  `HostServices.provide` before it starts the first window's host. A service is provided once
  and never replaced (a second window's `vimma.js` hands over the same ones), which is the
  guarantee; a check on the caller's file name catches a mistaken caller. One asked for before
  it is provided gives the answer that does the least: every download counts as an agent's,
  there are no conversations, and `config.toml` is not written.
  A registry rather than arguments to `VimmaHost.init`, because the five calls sit in four
  modules that the host reaches on different paths, and threading the services through each
  would change their signatures for no gain in what they depend on.)
- **The agent chat window drives the agent** (lazy: `ui/agent-chat.mjs` →
  `agent/AgentChat.sys.mjs`, `agent/AgentCli.sys.mjs`, `agent/AgentKeys.sys.mjs`,
  `config/ConfigHost.sys.mjs`, `host/mcp-ops.mjs`). The host builds the window, so it passes the
  agent's services in, as it is passed to `runners.mjs`. (Since changed: done.
  `AgentChatWindow` takes a third argument, the agent's services: the conversations, the agent
  CLIs, the API keys, `config.toml`'s refusal, setup's write to `config.toml` and the `[agent]`
  providers. The host hands it `CHAT_SERVICES` (`host/agent-chat-ops.mjs`), which reads each one
  when the window calls: `[agent]` from `host/mcp-ops.mjs`, the rest from `HostServices`, which
  gained `agentCli`, `agentKeys`, `configRefused` and `addAgentProvider` beside `agentChat`, on
  the same terms. Only `host/` imports the registry, so it does not become a lookup for every
  folder. The object services are served narrowed to the members the host and the window use
  (`AgentKeys` to `hint`, `set` and `delete`, `AgentCli` to setup's four): the registry never
  hands out the call that returns a key, starts a CLI or issues a conversation's ticket. Asked
  for before it is provided, no agent CLI is offered, no key is known or stored, `config.toml`
  counts as refused and is not written.
  `ui/agent-chat.mjs` imports nothing from `agent/`, `config/` or `host/`.)

The eager cycle between `host/native-swap.mjs` and `host/private-swap.mjs` is gone: `startedUp`,
the one function `native-swap.mjs` took from `private-swap.mjs`, moved to `native-swap.mjs` beside
`isBrowserWindow`, and `private-swap.mjs` re-exports both, so every importer is unchanged.

## Reasoning

- **The order follows what the code already does.** The layers put each folder where most of
  its imports already point, so 17 of about 500 imports break the rule, and each of them is a
  piece of code in a folder other than the one that owns it.
- **Front doors above the host.** `config/`, `ctl/` and `agent/` drive the host on behalf of a
  file, a socket client or a model: they import `host/` in 14 eager imports, from 14 different
  modules. The host reaches them in 8 imports, 2 of them eager (`VimmaHost.sys.mjs` and
  `agent-ui.mjs` → `ctl/AgentGate.sys.mjs`). Putting them below the host would invert the many
  edges to save the few.
- **`ui/` is a leaf.** Its widgets render and call back; only the agent chat window reaches up,
  and that is listed. (Since changed: the window no longer reaches up; the host passes it what
  it uses.)
- **Checked by a script, not eslint.** The edges are strings in calls and object literals, so
  the check parses each module with espree (the parser eslint uses) and walks it. A script also
  sees the whole tree at once, which a stale-entry check needs and a per-file lint rule cannot.

## Alternatives rejected

- **eslint `no-restricted-imports` per folder**: blind to `ChromeUtils.importESModule` and
  lazy getter maps, which carry most of the upward edges.
- **Allowing lazy upward imports**: the rule would forbid nothing that a getter cannot hide.
- **Allowing exceptions per folder pair**: a second upward import from the same folder would pass
  unseen; the list names each module.
- **Keeping the parent actor in `actors/` as a permanent exception**: it only forwards reports
  to `VimmaHost` and `PdfOps`, and the one thing that pins it to `actors/` is the URL
  `VimmaActors.register()` builds, which `vimma.js` can pass in. A permanent exception would
  keep the `actors/` ↔ `host/` loop for no gain.
- **A folder of its own, in a layer between `workspaces/`/`actors/` and `host/`, for the gate**
  (the plan above): the gate imports `host/mcp-ops.mjs` for `[mcp]`, so the folder needed
  `mcp-ops.mjs` and `control-ops.mjs` too. That moves three modules instead of one, changes the
  `chrome://` URL that 32 more test files import, and renumbers `host/` and every layer above it,
  for the same direction the move into `host/` gives.
- **Handing the gate to the host through `host/host-services.mjs`**, as the agent's commands are:
  no file moves, but the agent line's listener, `:mcp revoke` and `:mcp log` would reach the gate
  through a service `vimma.js` provides at startup. One that is missing must give the answer that
  does the least, and for the agent line that is no listener: questions nobody sees, each waiting
  out its timeout. A module import fails at load instead, which is louder.
- **Breaking every cycle in one change**: the gate's move crosses a security boundary and the
  registrations change startup order; each needs its own review and its own proof that nothing
  changed.

## Limits of the check

- A function passed as a callback and called while the module evaluates (an `importESModule`
  inside a `forEach` at module level) is read as lazy, so an eager cycle through it is not
  reported. Only a function called on the spot counts as eager.
- An inline `<script>` in a page is not read; the check refuses one, so code that imports must
  live in a module file.
- A module's folder is read from its URL, which is its source path only while `jar.mn`
  packages each module under its own path; the check fails on a `jar.mn` line that does not.
- A string that names `vimma.js` outside a load position (as `host/host-services.mjs` names
  its one expected caller) is not an edge: a classic script at the top of `vimma/` cannot be
  imported by any module, so its URL is text, as a page's is. Passed to `importESModule` or
  `import()`, it is still an edge.
- Strings built at run time from parts the check cannot see (a value read from a pref or a
  file) are not import specifiers it can read; it refuses every non-fixed specifier where a
  module is loaded, whatever it starts with, and ignores other computed strings. A load
  position is an `import` or `export … from` declaration, `import()`, a direct
  `ChromeUtils.importESModule(…)` or `….defineESModuleGetters(…)` call, or the first argument of
  `new Worker`, `ChromeWorker` or `SharedWorker` (by name or as a member, as
  `globalThis.ChromeWorker`), which may also be a name whose one declaration
  is a `const` with a fixed string. Any other mention of either loader's name, in an identifier,
  a string or a template string, is refused, and `ChromeUtils` itself may appear only as
  `ChromeUtils.<name>`. Reflection that does not name `ChromeUtils` or a worker constructor (`globalThis[k]`
  with a key built at run time), `Services.scriptloader.loadSubScript` with a built URL (it runs a classic
  script, which cannot hold `import` declarations), and loaders Firefox no longer has
  (`Cu.import`) are not read; a review of the module that adds one looks for it.
- Code run from a string (`eval`, `new Function`, or `Function` reached without its name, as
  `(() => {}).constructor.constructor`) is not read. Firefox refuses `eval` in system-principal
  code by default; a module the list does not hold still fails if such a string names the
  gate's file, and a change to a listed importer that adds one is for its review. Comments are
  not read either: they run nothing.
- A Vimma module's file is reachable by more than its `chrome://` URL: `browser.manifest` maps
  `chrome://browser/content/` to `chrome/browser/content/browser/` of the app's `omni.ja`,
  which `resource:///` and `resource://app/` name too (and `resource://gre/` in an unpackaged
  build). The module loader accepts `resource://` and keys each module by its URL, so such a
  URL would load a second copy of the module with its own state; for the agent gate, its own
  questions and grants. The check refuses any string whose path holds `content/browser/vimma`,
  with a scheme or without one (a tail a root is joined to). A `chrome://` or relative URL of
  the gate with a query, a fragment, an escape or a `//` loads a second copy too, so the gate is
  named only by its exact URL or a plain relative path, and never in a worker, which has its own
  global. An options argument or import attributes on any Vimma module are refused: an option
  such as `{ global: "devtools" }` loads the module and everything it imports, the gate
  included, a second time. `moz-src:///` maps only the files a `moz.build` lists in
  `MOZ_SRC_FILES`, which Vimma's are not, so it does not reach the gate; the exact-URL rule
  refuses it all the same.
- Other ways to give a Vimma file a second URL are allow-lists of what the tree has. `jar.mn`
  may hold only blank lines, comments (`#` and a space, or `#` alone), one `browser.jar:` header, entries of
  the form `target (source)` with no `.` or `..` segment, and `%` lines that override one `.svg`
  image with another outside `content/vimma/`; a preprocessor directive (`#include`, `#ifdef`,
  `#filter`), a preprocessed (`*`) entry or any other line is refused. A script or page (`.mjs`,
  `.js`, `.html`, `.xhtml`), and any file taken from `vimma/`, is packaged only as
  `content/browser/vimma/<its path>`. `vimma/moz.build` must have its shape of today line by
  line: comments, blank lines, and `JAR_MANIFESTS` or `BROWSER_CHROME_MANIFESTS` `+=` a list of
  plain strings, on one line or one string to a line. A specifier where a module loads must
  name a `.mjs` or `.js` file, in lower case, so a packaged file of another type (the theme
  hook's `.sh`) is not loaded unread. Every file git tracks under `vimma/` must be of a type on
  the check's list (`.mjs`, `.js`, `.html`, `.md`, `.png`, `.sh`, with `jar.mn` and `moz.build`
  only at the top), in lower case: a new type needs a reader first.
- The hand-on rule follows holders by name: a name that holds the gate in one scope is taken
  to hold it in every scope, which can only add errors. Whether an assignment is an alias or a
  store is decided by scope: an assignment to a name that resolves to no declaration in scope
  is a store on the shared global and fails. The value of an assignment (`(gate ??= …)`) is
  followed like the gate unless the statement around it throws it away. What a call of the
  gate returns, what one of its getters returns (some are shared objects: a waiting question's
  `label`, the connections' labels, the log's rows, issue #1018), and what a function that
  calls the gate does for its own caller, are not followed; the security review of a listed
  importer judges those.
- A string, template string or regular expression literal that names the gate's file fails in
  a module the list does not hold, and anywhere in the text of a page, matched on its letters
  and digits alone after escapes and references are decoded, so that an escape, a control
  character or punctuation between them does not hide it. One built from smaller pieces
  (`"Agent" + "Gate.sys.mjs"`) does not, and needs a load position the check refuses, or
  `eval`.
- A page is read whole: an attribute value across lines is one URL (a URL parser drops the line
  breaks), numeric references and the five named ones are decoded, and an attribute given twice
  in one tag is refused, since the parser keeps the first copy. It must keep to what the pages
  use today: the elements of today's pages; a script only `type="module"` with the `src` of a
  Vimma module and no inline code; a link only to one of today's stylesheets; a meta only
  `charset="utf-8"`, the colour scheme, or one of today's two Content-Security-Policy values
  (`about.html`'s adds `connect-src chrome:`); exactly one such policy, in the head and before the
  first script or stylesheet, in a page that has either, since a meta policy governs only what
  loads after it and Firefox applies one only in the head (`HTMLMetaElement`); an `<a href>` only an about: page or a fragment; no other element with a URL attribute; no
  `on…` attribute, `srcdoc` or `<base>`; and no named reference but `&amp;`, `&quot;`, `&apos;`,
  `&lt;`, `&gt;`.
- Every file the check reads (modules, pages, `jar.mn`, `vimma/moz.build`, vimma-core's sources,
  the Firefox patches) goes through one read that refuses a byte order mark, a NUL byte or bytes
  that are not UTF-8: the check reads UTF-8, and a page saved as UTF-16 would show it no tags at
  all while the parser, sniffing the mark, reads them. Such a file is reported by name and not
  parsed, so the reason shows instead of a parser error.
- Theme files that `jar.mn` packages from outside `vimma/` (its `skin/classic/browser/vimma/`
  entries, stylesheets and images such as an `.svg`) are not read; an SVG opened as a document
  can run script, so a change to one is for review.
- `core/` is a copy of `packages/vimma-core/src`, which eslint keeps pure (ADR-005: no
  Firefox URL in an `import` declaration, no Firefox global by name). The layering check reads
  those sources too and refuses what eslint lets through: `import()`, `globalThis`, `eval`,
  `Function`, and the gate's file name in any string. `Function` reached without its name
  (`.constructor.constructor`) is not seen there either.
- A Firefox patch is text in many languages, so its added lines are read as text, one at a
  time, with JavaScript escapes (`\x47`, `\u0047`, `\u{47}`, octal `\101`) and `%` escapes
  decoded, numeric and the five named references decoded, other named references, CDATA
  markers, tabs, line breaks and every remaining backslash dropped. A line fails on the gate's
  file name, matched on its letters and digits alone, on a path holding
  `content/browser/vimma` (a manifest line that maps a new root onto Vimma's files), on an
  options argument next to a Vimma URL, on a URL that reaches the gate, and on a URL that stops
  before it names a file inside a Vimma root: a Vimma folder's URL, or a cut-off start of
  `chrome://browser/content/vimma/` or of a `resource://` root, such as
  `"chrome://browser/content/" + …` or `` `chrome://browser/content/vimma/${dir}/…` ``. In a
  build file named by the hunk's `+++` header (`moz.build`, a `.mozbuild`, a `.mn`, a
  `.manifest`), a line that names `content/vimma` fails unless it is one of the four
  `browser/base/moz.build` adds today, in a hunk of that file (the folder in `DIRS`, the three licence pages). A URL
  assembled from pieces that are none of these (a name split across two lines, a URL rewritten
  with `.replace`, a scheme split as `chrome:/` + `/…`, a value read at run time), and a build
  file the hunk does not name, are left to the review every new patch gets with its line in
  ADR-003's register.
- What only a build or a browser run would show (how the jar packager, the preprocessor or the
  module loader of a later Firefox treat a form the check reads as harmless) is not checked
  here; the rules follow the forms Firefox reads today, and a Firefox update that changes one
  is reviewed against this list.
- An edge must name a module that exists: one git tracks and `jar.mn` packages by name, so a
  mistyped `chrome://` URL (such as the parent actor's, which `vimma.js` passes to
  `VimmaActors.register`) fails the check rather than the run. `core/` is not checked (a
  git-ignored copy, packaged by a wildcard), nor is a folder prefix, which names no file.

## Consequences

- A new import between folders follows the layers. Adding an exception instead means a line in
  `tools/layering/layers.ts`, raising the pinned count in its test, and an amendment to this
  record that says why the import cannot be avoided. (Since changed: the list is empty and the
  check refuses any entry, so an exception would mean changing `exceptionErrors` in
  `tools/layering/layer-rules.ts`, its test and decision 5.)
- A new importer of the agent gate (`host/AgentGate.sys.mjs`) fails `npm run layering` even where
  the layers allow it: it needs a security review against `docs/security.md` section 12, then a
  line in `RESTRICTED` (`tools/layering/layers.ts`) and in its test.
- A new folder under `vimma/` needs a layer in `layers.ts`, a row in this record's table and a
  `README.md`.
- Moving code to the folder that owns it can change a `chrome://` URL that tests import; such a
  move updates those imports.
