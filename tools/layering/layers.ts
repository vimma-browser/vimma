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
 * Imports that break the layers today, each named by importer, imported module and kind, with
 * why it cannot be avoided yet and the issue that removes it. The list only shrinks: a new
 * upward import fails the check, so does an entry whose import is gone, and the test pins the
 * count. ADR-026, "Exceptions", says how each goes.
 */
export const EXCEPTIONS: Exception[] = [
  // The parent actor lives in actors/ and forwards page reports to the host. Firefox loads it
  // from the URL VimmaActors.register() names, which is fixed to actors/ today; the actor moves
  // to host/ once vimma.js passes the parent's URL in.
  {
    from: "actors/VimmaParent.sys.mjs",
    to: "host/VimmaHost.sys.mjs",
    kind: "eager",
    reason:
      "focus, click and block reports must reach the host, and the parent actor sits in actors/ until register() takes its URL",
    fate: "goes",
    issue: 936,
  },
  {
    from: "actors/VimmaParent.sys.mjs",
    to: "host/pdf-ops.mjs",
    kind: "eager",
    reason:
      "the PDF viewer's state and outline must reach the host's PDF code, from the same parent actor",
    fate: "goes",
    issue: 936,
  },

  // The agent gate's state lives in ctl/, above the host that shows it.
  {
    from: "host/VimmaHost.sys.mjs",
    to: "ctl/AgentGate.sys.mjs",
    kind: "eager",
    reason: "the :mcp log picker lists the gate's log, which only AgentGate holds",
    fate: "goes",
    issue: 936,
  },
  {
    from: "host/agent-ui.mjs",
    to: "ctl/AgentGate.sys.mjs",
    kind: "eager",
    reason: "the agent line shows and answers the gate's questions, which only AgentGate holds",
    fate: "goes",
    issue: 936,
  },
  {
    from: "host/mcp-ops.mjs",
    to: "ctl/AgentGate.sys.mjs",
    kind: "lazy",
    reason: ":mcp revoke and :mcp log act on the grants and log, which only AgentGate holds",
    fate: "goes",
    issue: 936,
  },
];
