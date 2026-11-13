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
   list grows only with an amendment to this record.

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
- **The host reads the agent gate** (`host/VimmaHost.sys.mjs` and `host/agent-ui.mjs` eager,
  `host/mcp-ops.mjs` lazy → `ctl/AgentGate.sys.mjs`). The `:mcp log` picker, the agent line and
  `:mcp revoke` show and act on the gate's questions, grants and log. That state is something
  the host shows, so it moves into a folder of its own with `mcp-ops.mjs` and `control-ops.mjs`,
  in a new layer between `workspaces/`/`actors/` and `host/` (it imports `workspaces/`, so it
  cannot share their layer); `ctl/` keeps the socket and the commands. It crosses a security
  boundary, so it is reviewed on its own against `docs/security.md`.
- **Two modules live in the wrong folder.** `host/VimmaHost.sys.mjs` records each key in
  `about/key-log.mjs` for `about:vimma`; the log moves to `host/`, which writes it.
  `workspaces/WindowWorkspaces.sys.mjs` saves and restores tab labels from `host/tab-labels.mjs`;
  the labels move to `workspaces/`, which saves the rest of the snapshot. Both moves change a
  `chrome://` URL that mochitests import, so each comes with its test edits in its own pull
  request.
- **The host runs commands of higher folders** (lazy: `host/VimmaHost.sys.mjs`,
  `host/agent-chat-ops.mjs` and `host/agent-ui.mjs` → `agent/AgentChat.sys.mjs`;
  `host/download-ops.mjs` → `ctl/AgentDownloads.sys.mjs`; `host/route-ops.mjs` →
  `config/ConfigHost.sys.mjs`). The agent line follows conversations, `:agent give` hands a tab
  over, the downloads picker marks an agent's downloads, `:route add` writes `config.toml` and
  reports the result. The higher folder hands the host an interface object at startup instead
  (decision 4).
- **The agent chat window drives the agent** (lazy: `ui/agent-chat.mjs` →
  `agent/AgentChat.sys.mjs`, `agent/AgentCli.sys.mjs`, `agent/AgentKeys.sys.mjs`,
  `config/ConfigHost.sys.mjs`, `host/mcp-ops.mjs`). The host builds the window, so it passes the
  agent's services in, as it is passed to `runners.mjs`.

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
  and that is listed.
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
- Strings built at run time from parts the check cannot see (a value read from a pref or a
  file) are not import specifiers it can read; it refuses non-fixed specifiers where modules
  are loaded, and ignores other computed strings.

## Consequences

- A new import between folders follows the layers. Adding an exception instead means a line in
  `tools/layering/layers.ts`, raising the pinned count in its test, and an amendment to this
  record that says why the import cannot be avoided.
- A new folder under `vimma/` needs a layer in `layers.ts`, a row in this record's table and a
  `README.md`.
- Moving code to the folder that owns it can change a `chrome://` URL that tests import; such a
  move updates those imports.
