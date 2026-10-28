/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The scripted provider: a `fetch` that answers vimma-core's OpenAI-compatible requests from a
// script instead of a model, with no network. CI runs the bench with it, so the harness, the
// shop and the scoring keep working without a model, a key or money. `shopper` is the script
// for a shopping list: it knows the answer and does the list the shortest way, so a scripted run
// that does not score complete and safe is a bug in the bench or in Vimma, never in a model.

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
 * A `fetch` for SCRIPTED_PROVIDER. Usage is counted as characters divided by four, the same on
 * every run, and reported as the server's, so the budget code runs as with a real server.
 * @param {Script} script
 * @returns {import("../../packages/vimma-core/src/agent-providers.mjs").Fetch}
 */
export function scriptedFetch(script) {
  let turn = 0;
  return async (url, init) => {
    if (url !== `${SCRIPTED_PROVIDER.endpoint}/chat/completions`)
      throw new Error(`the scripted provider answers only its own address, not ${url}`);
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
 * The label of the first button whose text matches, from a vimma_elements result: one JSON
 * object a line.
 * @param {string} text @param {RegExp} match
 */
function findLabel(text, match) {
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const el = JSON.parse(line);
      if (el.kind === "button" && match.test(String(el.text ?? ""))) return String(el.label);
    } catch {
      // not an element line
    }
  }
  return null;
}

/**
 * The script for one list: each product's page, its basket button as many times as the list
 * asks, then the checkout's pay button, which the harness answers no.
 * @param {{ base: string, list: import("./score.mjs").ShoppingList }} o
 * @returns {Script}
 */
export function shopper({ base, list }) {
  const pages = [
    ...list.items
      .filter((i) => i.accept.length > 0)
      .map((i) => ({
        url: `${base}product/${i.accept[0]}`,
        button: /^add to basket$/i,
        name: '"Add to basket"',
        times: i.qty,
      })),
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
      return call("vimma_open", { url: page.url });
    }
    if (sub === "opened") {
      const m = /in tab (\d+)/.exec(result);
      if (!m) return { text: `I could not open ${page.url}.` };
      tab = m[1];
      sub = "listed";
      return call("vimma_elements", { tab });
    }
    if (sub === "listed") {
      // vimma_open returns while the page loads: a tab still on its first blank document has no
      // elements to list, and one that navigates meanwhile is refused as changed. Ask again, as
      // a model would.
      if (result.startsWith("Error: ") && retries++ < MAX_RETRIES)
        return call("vimma_elements", { tab });
      retries = 0;
      const found = findLabel(result, page.button);
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
