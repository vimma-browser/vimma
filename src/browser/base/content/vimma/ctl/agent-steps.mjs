/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The agent commands' step checks and reply helpers (docs/specs/vimma-mcp.md, decision 4): which
// `vimma_keys` step acts first and whether it may pay (docs/specs/mcp-checkpoints.md C6, C7),
// what a submission shows, and the cuts and checks of a reply. This module asks nothing:
// agent-commands.mjs asks the gate with what these return.

import { AgentAct } from "./AgentAct.sys.mjs";
import { AgentDrive } from "./AgentDrive.sys.mjs";

/** @import { ConnId } from "../core/agent.mjs" */
/** @import { HintTarget } from "../actors/VimmaActors.sys.mjs" */

/**
 * What a submission sends, without the child's `text` and `identity` marks
 * (docs/specs/mcp-consequence.md K2), which decide whether it asks but are not shown.
 * @param {import("../core/agent-checkpoint.mjs").SentFields} sent
 */
export const unmarked = (sent) => ({
  ...sent,
  fields: sent.fields.map(({ text, identity, ...f }) => (void text, void identity, f)),
});

/** Key steps that load a page: payment steps where the page may pay (mcp-checkpoints Behaviour 3). */
const LOADS = new Set(["history.back", "history.forward", "page.url_up", "page.url_root"]);

/**
 * The first step of a `vimma_keys` call that acts (a follow, `gu`, `gU`, `H` or `L`), when it
 * acts on the page in the tab now: only scrolls and finds come before it. An `f` before it lists
 * new labels, so its target is known only as the call runs.
 * @param {import("../core/agent-keys.mjs").AgentStep[]} list
 */
export function firstActing(list) {
  for (const [index, step] of list.entries()) {
    if (LOADS.has(step.action)) return { index, step };
    if (step.action === "hint.follow") return step.label === undefined ? null : { index, step };
  }
  return null;
}

/**
 * The link a follow names now, in the connection's current labels of the page, or null.
 * @param {MozTabBrowser} browser @param {ConnId} conn
 * @param {import("../core/agent-keys.mjs").AgentStep} step
 */
export function linkOf(browser, conn, step) {
  const session = AgentDrive.current(conn, browser);
  const target = session?.byLabel.get(/** @type {string} */ (step.label));
  return target ? { target, elements: session?.source === "elements" } : null;
}

/**
 * Whether a key step may pay, and its question's payment part (mcp-checkpoints C6, C7): a
 * follow by the link's words and the page's card fields, a load by the card fields.
 * @param {MozTabBrowser} browser @param {ConnId} conn
 * @param {import("../core/agent-keys.mjs").AgentStep} step
 * @param {{ target: HintTarget, elements: boolean } | null} [found]  the follow's link, as the run
 *   resolved it; else it is looked up in the connection's labels now
 */
export async function payStep(browser, conn, step, found = null) {
  if (step.action !== "hint.follow") return AgentAct.payment(browser, { keys: step.keys });
  const link = found ?? linkOf(browser, conn, step);
  // No such link: the follow is refused as it runs, before anything loads.
  if (!link) return null;
  if (link.elements) {
    return AgentAct.payment(browser, { target: link.target, text: link.target.info?.text ?? "" });
  }
  return AgentAct.payment(browser, {
    text: link.target.text ?? "",
    keys: step.keys,
    frame: link.target.wg,
  });
}

/**
 * Cut `text` to `max` code points.
 * @param {string} text @param {number} max
 */
export function cut(text, max) {
  const chars = [...text];
  return chars.length > max
    ? { text: chars.slice(0, max).join(""), truncated: true }
    : { text, truncated: false };
}

/**
 * `s` as well-formed Unicode: a lone surrogate (a page's title or text can hold one) becomes
 * U+FFFD, so the JSON line is one vimma-ctl's strict parser accepts (security.md M7).
 * @param {unknown} s
 */
export const wf = (s) => String(s).toWellFormed();

/**
 * `v`'s property `key`, or undefined when `v` is no object: a reply from a page's process.
 * @param {unknown} v @param {string} key
 * @returns {unknown}
 */
export const fieldOf = (v, key) =>
  typeof v === "object" && v !== null ? /** @type {unknown} */ (Reflect.get(v, key)) : undefined;

/** UTF-8 length of `value` as JSON. @param {unknown} value */
export const jsonBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
