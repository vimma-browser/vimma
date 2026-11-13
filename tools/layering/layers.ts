/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The layers of src/browser/base/content/vimma/ and the imports that break them, as
// docs/adr/026-module-layering.md decides. layering.ts checks the tree against both.

import type { Exception } from "./layering.ts";

/**
 * Each folder's layer, 0 at the bottom. A module may import its own folder and any folder of a
 * lower layer; folders of the same layer do not import each other.
 */
export const LAYERS: Record<string, number> = {
  // Pure logic, no Firefox (ADR-005).
  core: 0,
  // Leaves: one job each, built on core alone.
  services: 1,
  search: 1,
  updates: 1,
  split: 1,
  ui: 1,
  // Browser state and the page bridge.
  workspaces: 2,
  actors: 2,
  // The orchestrator: keys in, actions applied to the window.
  host: 3,
  // Front doors that drive the host from outside: config.toml, the control socket.
  config: 4,
  ctl: 4,
  // The built-in agent, a client of the control commands.
  agent: 5,
  // Pages and hooks.
  about: 6,
  setup: 6,
  start: 6,
  omarchy: 6,
  // vimma.js, the window script that wires everything.
  "(root)": 7,
};

/**
 * Imports that break the layers today, each named by importer, imported module and kind. The
 * list only shrinks: a new upward import fails the check, and so does an entry whose import is
 * gone. ADR-026, "Exceptions", says which stay and how the others go.
 */
export const EXCEPTIONS: Exception[] = [
  // Stays: Firefox, not Vimma, constructs a JSWindowActorParent from its module URL, so there is
  // no caller to pass the host in; the parent actor is an entry point into Vimma, as vimma.js is.
  {
    from: "actors/VimmaParent.sys.mjs",
    to: "host/VimmaHost.sys.mjs",
    kind: "eager",
    reason: "the parent actor hands focus, click and block reports from pages to the host",
  },
  {
    from: "actors/VimmaParent.sys.mjs",
    to: "host/pdf-ops.mjs",
    kind: "eager",
    reason: "the parent actor hands the PDF viewer's state and outline to the host's PDF code",
  },

  // Goes by moving the gate's state below the host (issue #936 follow-up, with a security
  // review: docs/security.md section on the agent gate).
  {
    from: "host/VimmaHost.sys.mjs",
    to: "ctl/AgentGate.sys.mjs",
    kind: "eager",
    reason: "the :mcp log picker lists the agent gate's log",
  },
  {
    from: "host/agent-ui.mjs",
    to: "ctl/AgentGate.sys.mjs",
    kind: "eager",
    reason: "the agent line shows the gate's waiting questions and grants, and answers them",
  },
  {
    from: "host/mcp-ops.mjs",
    to: "ctl/AgentGate.sys.mjs",
    kind: "lazy",
    reason: ":mcp revoke and :mcp log act on the agent gate",
  },

  // Goes by moving the module to the folder that owns it; the chrome:// URL changes, and
  // mochitests import it by that URL.
  {
    from: "host/VimmaHost.sys.mjs",
    to: "about/key-log.mjs",
    kind: "eager",
    reason: "the host records each key it dispatches in about:vimma's key log",
  },
  {
    from: "workspaces/WindowWorkspaces.sys.mjs",
    to: "host/tab-labels.mjs",
    kind: "eager",
    reason: "the workspace snapshot saves and restores tab labels, which live in host/",
  },

  // Goes by having the higher folder register what the host calls, at startup.
  {
    from: "host/VimmaHost.sys.mjs",
    to: "agent/AgentChat.sys.mjs",
    kind: "lazy",
    reason: "the agent line follows the built-in agent's conversations",
  },
  {
    from: "host/agent-chat-ops.mjs",
    to: "agent/AgentChat.sys.mjs",
    kind: "lazy",
    reason: ":agent give hands the selected tab to a conversation",
  },
  {
    from: "host/agent-ui.mjs",
    to: "agent/AgentChat.sys.mjs",
    kind: "lazy",
    reason: "stopping the agents from the agent line stops the built-in agent's runs",
  },
  {
    from: "host/download-ops.mjs",
    to: "ctl/AgentDownloads.sys.mjs",
    kind: "lazy",
    reason: "the downloads picker marks the downloads an agent made",
  },
  {
    from: "host/route-ops.mjs",
    to: "config/ConfigHost.sys.mjs",
    kind: "lazy",
    reason: ":route add writes the new route to config.toml",
  },

  // Goes by passing the agent's services to the chat window when the host builds it, as
  // runners.mjs is passed the host.
  {
    from: "ui/agent-chat.mjs",
    to: "agent/AgentChat.sys.mjs",
    kind: "lazy",
    reason: "the agent chat window shows and drives the built-in agent's conversations",
  },
  {
    from: "ui/agent-chat.mjs",
    to: "agent/AgentCli.sys.mjs",
    kind: "lazy",
    reason: "the agent chat window offers the installed agent CLIs",
  },
  {
    from: "ui/agent-chat.mjs",
    to: "agent/AgentKeys.sys.mjs",
    kind: "lazy",
    reason: "the agent chat window says where a provider's API key comes from",
  },
  {
    from: "ui/agent-chat.mjs",
    to: "config/ConfigHost.sys.mjs",
    kind: "lazy",
    reason: "the agent chat window says when config.toml was refused",
  },
  {
    from: "ui/agent-chat.mjs",
    to: "host/mcp-ops.mjs",
    kind: "lazy",
    reason: "the agent chat window reads the [agent] providers from the MCP state",
  },
];
