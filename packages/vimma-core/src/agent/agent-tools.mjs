/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The built-in agent's tools (docs/specs/builtin-agent.md B2, B6, B7): the MCP agent tools,
// unchanged, from the generated agent-tools-data.mjs.

import { AGENT_INSTRUCTIONS, AGENT_TOOL_LIST } from "./agent-tools-data.mjs";

export { AGENT_INSTRUCTIONS, AGENT_TOOL_LIST };

/** @typedef {{ name: string, description: string, inputSchema: any }} AgentToolDef */

/**
 * The tools offered to a model. A model without vision gets no `vimma_screenshot`, which it
 * could not use and whose definition costs tokens on every request (B7).
 * @param {{ vision: boolean }} opts
 * @returns {AgentToolDef[]}
 */
export function agentTools({ vision }) {
  return AGENT_TOOL_LIST.filter((t) => vision || t.name !== "vimma_screenshot").map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}
