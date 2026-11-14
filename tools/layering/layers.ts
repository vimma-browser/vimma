/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The layers of src/browser/base/content/vimma/, as docs/adr/026-module-layering.md decides, and
// the empty list of imports that break them. layering.ts checks the tree against both.

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
 * Imports that break the layers: none. The last three (the host reading the agent gate) went
 * when the gate moved to host/ (#936), and ADR-026, decision 5, admits no new one: layering.ts
 * fails on any entry here, whatever its reason. Reach a higher folder through a topic, a
 * callback or an interface object (decision 4).
 */
export const EXCEPTIONS: Exception[] = [];
