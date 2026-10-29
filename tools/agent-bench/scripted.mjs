/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The scripted provider: a `fetch` that answers vimma-core's OpenAI-compatible requests from a
// script instead of a model, with no network. CI runs the bench with it, so the harness, the
// shop and the scoring keep working without a model, a key or money. `shopper` is the script
// for a shopping list: it knows the answer and does the list the shortest way a model could, so a
// scripted run that does not score complete and safe is a bug in the bench or in Vimma, never in
// a model.

import { setTimeout as delay } from "node:timers/promises";
import { loadCatalog } from "./shop.mjs";

/** @type {import("../../packages/vimma-core/src/agent-providers.mjs").Provider} */
export const SCRIPTED_PROVIDER = Object.freeze({
  kind: "openai",
  // Never contacted: scriptedFetch answers this address itself and refuses every other one.
  endpoint: "http://127.0.0.1:9/scripted/v1",
  model: "scripted",
});

/**
 * @typedef {{ messages: any[], tools: any[] }} ScriptRequest  the request body, as sent
 * @typedef {{ text?: string, calls?: Array<{ name: string, args: Record<string, any> }> }} ScriptTurn
 * @typedef {(req: ScriptRequest) => ScriptTurn} Script
 */

/**
 * A pace that keeps the shopper under Vimma's open rate (10 a minute) on every list: the longest
 * list opens its tenth search and the checkout 21 model turns apart, so turns of 3 seconds
 * spread them over more than a minute, whatever the tools take.
 */
export const RATE_PACE_MS = 3000;

/**
 * A `fetch` for SCRIPTED_PROVIDER. Usage is counted as characters divided by four, the same on
 * every run, and reported as the server's, so the budget code runs as with a real server.
 * `paceMs` makes each answer wait that long first, as a model's turn takes time; unpaced, the
 * script runs faster than any model and than Vimma's per-agent rates allow.
 * @param {Script} script
 * @param {{ paceMs?: number, sleep?: (ms: number) => Promise<unknown> }} [o]
 * @returns {import("../../packages/vimma-core/src/agent-providers.mjs").Fetch}
 */
export function scriptedFetch(script, { paceMs = 0, sleep = delay } = {}) {
  let turn = 0;
  return async (url, init) => {
    if (url !== `${SCRIPTED_PROVIDER.endpoint}/chat/completions`)
      throw new Error(`the scripted provider answers only its own address, not ${url}`);
    if (paceMs > 0) await sleep(paceMs);
    const body = String(init?.body ?? "");
    const req = JSON.parse(body);
    turn++;
    const out = script({ messages: req.messages, tools: req.tools });
    const message = {
      role: "assistant",
      content: out.text ?? "",
      ...(out.calls?.length
        ? {
            tool_calls: out.calls.map((c, i) => ({
              id: `call_${turn}_${i + 1}`,
              type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          }
        : {}),
    };
    const json = JSON.stringify({
      choices: [{ message, finish_reason: out.calls?.length ? "tool_calls" : "stop" }],
      usage: {
        prompt_tokens: Math.ceil(body.length / 4),
        completion_tokens: Math.ceil(JSON.stringify(message).length / 4),
      },
    });
    return { ok: true, status: 200, text: async () => json };
  };
}

/** How often the script lists a page that is still loading before it gives up. */
const MAX_RETRIES = 20;

/** The text of the newest tool result in an OpenAI-compatible request. @param {any[]} messages */
function lastToolText(messages) {
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].role === "tool") return String(messages[i].content ?? "");
  return "";
}

/**
 * The first button whose text matches, from an element list: one JSON object a line. With
 * `labels`, only one of those.
 * @param {string} text @param {RegExp} match @param {Set<string>} [labels]
 */
function buttonIn(text, match, labels) {
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const el = JSON.parse(line);
      if (labels && !labels.has(String(el.label))) continue;
      if (el.kind === "button" && match.test(String(el.text ?? ""))) return String(el.label);
    } catch {
      // not an element line
    }
  }
  return null;
}

/** The note a compact list ends with (agent-speed S4), naming the labels it left out. */
const REPEATED = /^\(\d+ elements? as in your last list of this site: ([a-z, ]+)\)$/m;

/**
 * The label of the first button whose text matches in the newest list: written in it, or left
 * out as in an earlier list of the site, whose line the newest of the earlier results gives.
 * @param {string} text @param {RegExp} match @param {any[]} [messages]
 */
function findLabel(text, match, messages = []) {
  const found = buttonIn(text, match);
  const repeated = REPEATED.exec(text);
  if (found || !repeated) return found;
  const labels = new Set(repeated[1].split(", "));
  const earlier = messages.filter((m) => m.role === "tool").slice(0, -1);
  for (let i = earlier.length - 1; i >= 0; i--) {
    const label = buttonIn(String(earlier[i].content ?? ""), match, labels);
    if (label) return label;
  }
  return null;
}

/** @param {string} s */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The script for one list, then the checkout's pay button, which the harness answers no.
 *
 * `path: "search"` (the default) is the shortest path the tools allow a model that does not
 * know a product's URL: the shop's search results for the product's name, opened by URL with
 * `elements: true`, then the listing's basket button for that product, as many times as the
 * list asks. The open waits for the page and lists it, so no step is spent listing a tab that
 * is still blank. `path: "product"` is the earlier floor, kept for comparison: each product's
 * page by its URL, `vimma_elements`, then its basket button.
 * @param {{ base: string, list: import("./score.mjs").ShoppingList, path?: "search" | "product",
 *   catalog?: import("./shop.mjs").Catalog }} o
 * @returns {Script}
 */
export function shopper({ base, list, path = "search", catalog }) {
  const search = path === "search";
  const byId = search ? new Map((catalog ?? loadCatalog()).products.map((p) => [p.id, p])) : null;
  const pages = [
    ...list.items
      .filter((i) => i.accept.length > 0)
      .map((i) => {
        if (!byId) {
          return {
            url: `${base}product/${i.accept[0]}`,
            button: /^add to basket$/i,
            name: '"Add to basket"',
            times: i.qty,
          };
        }
        const p = byId.get(i.accept[0]);
        if (!p) throw new Error(`the catalog has no ${i.accept[0]}`);
        const full = `${p.name} (${p.brand}, ${p.size})`;
        const q = new URLSearchParams({ q: p.name.replace(/,/g, "").toLowerCase() });
        return {
          url: `${base}search?${q}`,
          button: new RegExp(`^add ${escapeRegExp(full)} to basket$`, "i"),
          name: `"Add ${full} to basket"`,
          times: i.qty,
        };
      }),
    { url: `${base}checkout`, button: /place order/i, name: '"Place order"', times: 1 },
  ];
  let at = 0;
  /** @type {"open" | "opened" | "listed" | "clicking"} */
  let sub = "open";
  let tab = "";
  let label = "";
  let clicks = 0;
  let retries = 0;
  /** @type {(name: string, args: Record<string, any>) => ScriptTurn} */
  const call = (name, args) => ({ calls: [{ name, args }] });

  /** @type {Script} */
  const next = ({ messages, tools }) => {
    const page = pages[at];
    if (!page)
      return {
        text: "The basket holds your list. I asked to place the order and pay at the checkout; the payment waits for your answer in Vimma.",
      };
    const result = lastToolText(messages);
    if (sub === "open") {
      sub = "opened";
      return call("vimma_open", search ? { url: page.url, elements: true } : { url: page.url });
    }
    if (sub === "opened") {
      const m = /^Opened .* in tab (\d+)\b/m.exec(result);
      if (!m) return { text: `I could not open ${page.url}.` };
      tab = m[1];
      sub = "listed";
      // An open with elements lists the page it loaded; one that could not list it (the page
      // never loaded, or navigated meanwhile) leaves the list to vimma_elements, as below.
      if (!search || !findLabel(result, page.button, messages)) {
        return call("vimma_elements", { tab });
      }
    }
    if (sub === "listed") {
      // vimma_open returns while the page loads: a tab still on its first blank document has no
      // elements to list, and one that navigates meanwhile is refused as changed. Ask again, as
      // a model would.
      if (result.startsWith("Error: ") && retries++ < MAX_RETRIES)
        return call("vimma_elements", { tab });
      retries = 0;
      const found = findLabel(result, page.button, messages);
      if (!found) return { text: `The page has no ${page.name} button.` };
      label = found;
      sub = "clicking";
      clicks = 0;
    }
    if (clicks < page.times) {
      clicks++;
      return call("vimma_activate", { tab, label });
    }
    at++;
    sub = "open";
    return next({ messages, tools });
  };
  return next;
}
