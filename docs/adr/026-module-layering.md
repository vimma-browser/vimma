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

Measured on the tree before this decision, counting every way one module reaches another:

- Among eager imports (those the module loader follows when the importer loads) there was one
  cycle: `host/native-swap.mjs` and `host/private-swap.mjs` imported each other, for one helper.
- Every folder-level cycle closed through a lazy import (a `defineESModuleGetters` map, or
  `ChromeUtils.importESModule` inside a function) or through a module of a lower folder that
  imports the host eagerly while the host reaches it lazily: `actors/VimmaParent.sys.mjs`,
  `agent/AgentChat.sys.mjs`, `ui/agent-chat.mjs`. The code had already been bent to avoid load
  order failures; the direction was never written down.
- The real needs were few and repeated: the host shows the agent gate's state, runs a handful of
  `:` commands that belong to `config/` or `agent/`, and records keys for `about:vimma`; the
  agent chat window, built by the host, drives the agent; the parent actor hands page reports to
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
   means loaded with the importer (a declaration, or `importESModule` outside any function); lazy
   means loaded on first use. A lazy import of a higher layer breaks the rule as an eager one
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
   cycle and on a folder without a `README.md`. The list only shrinks.

6. **Each folder has a `README.md`**: what it owns, its entry points, what it may import under
   this record, and the walkthrough or spec that explains it. `jar.mn` names every file it
   packages, so a README is never shipped.

## Exceptions

Seventeen imports break the layers on the day of this record, listed one by one in `layers.ts`.
Two stay; the others go in follow-up pull requests of issue #936, each without a change in
behaviour.

- **Stays: the parent actor imports the host** (`actors/VimmaParent.sys.mjs` →
  `host/VimmaHost.sys.mjs` and `host/pdf-ops.mjs`, eager). Page reports (focus, clicks, text
  blocks, the PDF viewer's state) reach the host here. Firefox constructs a parent actor from its
  module URL, so no Vimma caller can pass the host in: the actor is an entry point, as `vimma.js`
  is. A slot the host fills at startup would hide the same dependency in mutable state that an
  early report could find empty.
- **Goes: the host reads the agent gate** (`host/VimmaHost.sys.mjs` and `host/agent-ui.mjs`
  eager, `host/mcp-ops.mjs` lazy → `ctl/AgentGate.sys.mjs`). The `:mcp log` picker, the agent
  line and `:mcp revoke` show and act on the gate's questions, grants and log. That state is
  something the host shows, so it moves below the host, with `mcp-ops.mjs` and
  `control-ops.mjs`; `ctl/` keeps the socket. It crosses a security boundary, so it is reviewed
  on its own against `docs/security.md`.
- **Goes: two modules live in the wrong folder.** `host/VimmaHost.sys.mjs` records each key in
  `about/key-log.mjs` for `about:vimma`; the log moves to `host/`, which writes it.
  `workspaces/WindowWorkspaces.sys.mjs` saves and restores tab labels from `host/tab-labels.mjs`;
  the labels move to `workspaces/`, which saves the rest of the snapshot. Both moves change a
  `chrome://` URL that mochitests import, so each comes with its test edits in its own pull
  request.
- **Goes: the host runs commands of higher folders** (lazy: `host/VimmaHost.sys.mjs`,
  `host/agent-chat-ops.mjs` and `host/agent-ui.mjs` → `agent/AgentChat.sys.mjs`;
  `host/download-ops.mjs` → `ctl/AgentDownloads.sys.mjs`; `host/route-ops.mjs` →
  `config/ConfigHost.sys.mjs`). The agent line follows conversations, `:agent give` hands a tab
  over, the downloads picker marks an agent's downloads, `:route add` writes `config.toml`. The
  higher folder hands the host an interface object at startup instead (decision 4).
- **Goes: the agent chat window drives the agent** (lazy: `ui/agent-chat.mjs` →
  `agent/AgentChat.sys.mjs`, `agent/AgentCli.sys.mjs`, `agent/AgentKeys.sys.mjs`,
  `config/ConfigHost.sys.mjs`, `host/mcp-ops.mjs`). The host builds the window, so it passes the
  agent's services in, as it is passed to `runners.mjs`.

The eager cycle between `host/native-swap.mjs` and `host/private-swap.mjs` is gone: `startedUp`,
the one function `native-swap.mjs` took from `private-swap.mjs`, moved to `native-swap.mjs` beside
`isBrowserWindow`, and `private-swap.mjs` re-exports both, so every importer is unchanged.

## Reasoning

- **The order follows what the code already does.** Every folder-level cycle was already
  closed by a lazy import or by an eager import of the host from below; the layers put each
  folder where its eager imports already point, so seventeen imports break the rule, not
  hundreds.
- **Front doors above the host.** `config/`, `ctl/` and `agent/` drive the host on behalf of a
  file, a socket client or a model, and import it eagerly in dozens of places; the host reaches
  them in a handful, lazily. Putting them below the host would invert the many edges to save
  the few.
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
- **Breaking every cycle in one change**: the gate's move crosses a security boundary and the
  registrations change startup order; each needs its own review and its own proof that nothing
  changed.

## Consequences

- A new import between folders either follows the layers or adds a line to
  `tools/layering/layers.ts` with its reason, which review sees.
- A new folder under `vimma/` needs a layer in `layers.ts`, a row in this record's table and a
  `README.md`.
- Moving code to the folder that owns it can change a `chrome://` URL that tests import; such a
  move updates those imports.
