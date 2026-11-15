/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The agent role's refusals (docs/specs/vimma-mcp.md, decision 4): an error with a protocol code,
// and the `denied` refusal by reason. The codes and texts are the contract with VimmaControl, the
// built-in agent and vimma-ctl. Plain data: this module asks nothing and reaches no tab.

/**
 * A refusal with a protocol error code (and, for `denied`, its reason; for a used-up rate, the
 * milliseconds until the next call is allowed, issue #592).
 */
export class AgentError extends Error {
  /**
   * @param {string} code @param {string} message @param {string} [reason]
   * @param {number} [retryAfter]
   */
  constructor(code, message, reason, retryAfter) {
    super(message);
    this.code = code;
    this.reason = reason;
    this.retryAfter = retryAfter;
  }
}

/** The denial texts, by reason (decision 4); the MCP layer words them for the model. */
const DENIED = /** @type {Record<string, string>} */ ({
  user: "the user denied this request in Vimma",
  timeout: "no answer in Vimma in time; treated as denied",
  busy: "too many agent requests are waiting in Vimma; try again later",
  muted: "this agent connection is muted in Vimma after repeated denials",
  changed: "the tab changed after the user was asked; nothing was done",
  cancelled: "the request was cancelled",
  "in-use": "the user is using this tab in Vimma; nothing was done",
});

/** @param {string} reason */
export const denied = (reason) => new AgentError("denied", DENIED[reason] ?? reason, reason);
