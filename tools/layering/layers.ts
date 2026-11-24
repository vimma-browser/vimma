/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The layers of src/browser/base/content/vimma/, as docs/adr/026-module-layering.md decides, and
// the empty list of imports that break them. layering.ts checks the tree against both.

import type { Exception, Restricted } from "./layering.ts";

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
 * Imports that break the layers: none. The last three (the host reading the agent gate) went
 * when the gate moved to host/ (#936), and ADR-026, decision 5, admits no new one:
 * layer-rules.ts fails on any entry here, whatever its reason. Reach a higher folder through a
 * topic, a callback or an interface object (decision 4).
 */
export const EXCEPTIONS: Exception[] = [];

/**
 * Modules only the listed modules may import, eagerly or lazily, whatever their layer. The agent
 * gate decides what an agent may do and asks the user (docs/security/12-agents-mcp.md section 12);
 * with it in host/ (layer 3), every host/ module, VimmaParent.sys.mjs among them, and every folder
 * above could import it by the layers alone. These are today's callers, each reviewed; a new one
 * needs a security review first, then a line here and in the test. A listed module that stops
 * importing it fails too.
 */
export const RESTRICTED: Record<string, Restricted> = {
  "host/AgentGate.sys.mjs": {
    importers: [
      "agent/AgentChat.sys.mjs",
      "ctl/AgentDownloads.sys.mjs",
      "ctl/VimmaControl.sys.mjs",
      "ctl/agent-commands.mjs",
      "host/VimmaHost.sys.mjs",
      "host/agent-ui.mjs",
      "host/mcp-ops.mjs",
    ],
    review:
      "a new caller of the agent gate needs a security review (docs/security/12-agents-mcp.md section 12)",
  },
  /**
   * The agent's reach (docs/security/12-agents-mcp.md M2, M8): which tabs an agent may name, who
   * owns them, and the re-check after the yes. Only agent-commands.mjs, which asks the gate
   * around these calls, uses them; the built-in agent reaches ownership through its
   * AgentTabOwners.
   */
  "ctl/agent-tabs.mjs": {
    importers: ["ctl/agent-commands.mjs"],
    review:
      "a new caller of the agent tab model needs a security review (docs/security/12-agents-mcp.md section 12, M2 and M8)",
  },
  /**
   * The agent's reach into a page (docs/security/12-agents-mcp.md M25 to M28): its clicks, fills
   * and submissions, each run after the child's reply and checked again just before. Only
   * VimmaChild, which hands it the parent's `Vimma:Agent*` messages, builds one; another module
   * of the content process could act in a page without the parent's question.
   */
  "actors/agent-page.mjs": {
    importers: ["actors/VimmaChild.sys.mjs"],
    review:
      "a new caller of the agent's page work needs a security review (docs/security/12-agents-mcp.md section 12, M25 to M28)",
  },
  /**
   * The user's activation for their own hint (docs/security/12-agents-mcp.md M26; issue #1303):
   * the one place Vimma gives a page transient user activation. Only VimmaChild imports it, for
   * the parent's `Vimma:ActivateHint`; a module the agent's clicks reach could hand the page the
   * user's gesture.
   */
  "actors/user-gesture.mjs": {
    importers: ["actors/VimmaChild.sys.mjs"],
    review:
      "a new caller of the user's activation needs a security review (docs/security/12-agents-mcp.md section 12, M26)",
  },
  /**
   * The page's own dispatchEvent, called through waived Xrays for an agent's press
   * (docs/security/12-agents-mcp.md M26; issue #1321). Only VimmaChild imports it, with events
   * the page's constructors built: a caller that passed a chrome object would hand it to code
   * the page can replace.
   */
  "actors/page-events.mjs": {
    importers: ["actors/VimmaChild.sys.mjs"],
    review:
      "a new caller of the page's own dispatch needs a security review (docs/security/12-agents-mcp.md section 12, M26)",
  },
  /**
   * The `:hover` locks and pointer events of a hover (docs/specs/hover.md): its caller chooses
   * the events' trust by the dispatch it passes, so each caller is reviewed.
   */
  "actors/hover.mjs": {
    importers: ["actors/VimmaChild.sys.mjs"],
    review:
      "a new caller of the hover's locks and events needs a security review (docs/specs/hover.md decision 3)",
  },
  /**
   * The chat window's API key entry (docs/security/12-agents-mcp-built-in-agent.md M46): the
   * masked key field that never reveals the key, and the calls that store, clear and delete it.
   * The chat window and its view, which builds the field, are its only callers.
   */
  "ui/agent-chat-key.mjs": {
    importers: ["ui/agent-chat.mjs", "ui/agent-chat-view.mjs"],
    review:
      "a new caller of the API key entry or its masked field needs a security review (docs/security/12-agents-mcp-built-in-agent.md M46)",
  },
  /**
   * The chat window's model setup (docs/security/12-agents-mcp-built-in-agent.md, endpoint rules
   * and B12): a hosted provider's endpoint checked by checkEndpoint, and a picked provider written
   * to config.toml. The chat window is its only caller.
   */
  "ui/agent-chat-models.mjs": {
    importers: ["ui/agent-chat.mjs"],
    review:
      "a new caller of the model setup needs a security review (docs/security/12-agents-mcp-built-in-agent.md endpoint rules, B12)",
  },
};
