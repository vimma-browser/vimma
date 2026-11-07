// The promo's agent shot (tools/promo/shots.mjs, `agent`): the task typed into Vimma's chat
// window, the agent bench's scripted shopper as its model, and a small OpenAI-compatible server
// on this machine that the chat window's provider points at. The script makes every take the
// same, offline and without a key; the window names the endpoint as it is configured, so the
// video never passes the script off as a real model.
import { createServer } from "node:http";
import { readBody } from "../agent-bench/shop.mjs";
import { SCRIPTED_PROVIDER, scriptedFetch, shopper } from "../agent-bench/scripted.mjs";

/** The model name the provider lists, and the chat window's first line shows. */
export const MODEL = "scripted";

/** What the shot types into the chat window. */
export const PROMO_TASK = "Put oat drink, rye bread and coffee in the basket, then check out.";

/** The promo's shop: a neutral name, never a real shop's. */
export const SHOP_NAME = "Corner Grocer";

/**
 * @param {string} id @param {string} category @param {string} name @param {string} size
 * @param {number} price @param {string} description
 * @returns {import("../agent-bench/shop.mjs").Product}
 */
const product = (id, category, name, size, price, description) => ({
  id,
  category,
  name,
  brand: "",
  size,
  price,
  tags: [],
  description,
  reviews: [],
});

/**
 * The promo shop's catalog: the bench shop's kinds of product, with no brands, so no real
 * company shows in the video. The bench's own catalog stays as its scoring needs it.
 * @type {import("../agent-bench/shop.mjs").Catalog}
 */
export const PROMO_CATALOG = Object.freeze({
  categories: [
    { id: "dairy", name: "Dairy and alternatives" },
    { id: "bakery", name: "Bakery" },
    { id: "coffee-tea", name: "Coffee and tea" },
  ],
  products: [
    product("oat-drink", "dairy", "Oat drink", "1 l", 1.59, "Oat drink, dairy free."),
    product("oat-drink-barista", "dairy", "Oat drink, barista", "1 l", 2.19, "Foams for coffee."),
    product("rye-whole", "bakery", "Rye bread", "500 g", 2.29, "A whole round loaf of sour rye."),
    product("rye-sliced", "bakery", "Rye bread, sliced", "500 g", 2.49, "Sour rye in slices."),
    product("coffee-ground", "coffee-tea", "Ground coffee", "500 g", 5.99, "Medium roast."),
    product("coffee-beans", "coffee-tea", "Coffee beans", "500 g", 7.49, "Dark roast, whole."),
  ],
});

/** @type {import("../agent-bench/score.mjs").ShoppingList} */
export const PROMO_LIST = Object.freeze({
  id: "promo",
  items: [
    { text: "oat drink", accept: ["oat-drink"], qty: 1 },
    { text: "rye bread", accept: ["rye-whole"], qty: 1 },
    { text: "coffee", accept: ["coffee-ground"], qty: 1 },
  ],
});

/** The agent's last reply once the payment was answered no. */
export const DECLINED_TEXT =
  "You said no at the payment, so the order was not placed. The basket keeps all three.";

/** The start of a tool result the user denied in Vimma (agent-bench/score.mjs isUserDenial). */
const DENIED = /^(Error: )?The user denied this request in Vimma\./;

/**
 * The bench's shopper on the parallel path (every search in one turn, every basket button in
 * the next), whose closing reply follows the answer at the payment: the bench's own reply says
 * the payment still waits, which a `n` has already settled.
 * @param {{ base: string, inner?: import("../agent-bench/scripted.mjs").Script }} o
 * @returns {import("../agent-bench/scripted.mjs").Script}
 */
export function promoShopper({ base, inner }) {
  const script =
    inner ?? shopper({ base, list: PROMO_LIST, path: "parallel", catalog: PROMO_CATALOG });
  return (req) => {
    const out = script(req);
    if (out.calls?.length) return out;
    const last = req.messages.at(-1);
    return last?.role === "tool" && DENIED.test(String(last.content ?? ""))
      ? { text: DECLINED_TEXT }
      : out;
  };
}

/**
 * Text as vimma-ctl send-keys arguments, a word and its space at a time, so the shot types at
 * a readable speed without a call per character.
 * @param {string} text
 * @returns {string[]}
 */
export function textKeys(text) {
  return (text.match(/\S+\s*/g) ?? []).map((word) =>
    [...word.replace(/\s+$/, "")].concat(/\s$/.test(word) ? ["space"] : []).join(" "),
  );
}

/**
 * An OpenAI-compatible server on 127.0.0.1 that answers with `script` (through the bench's
 * scriptedFetch, so its replies are what the bench's runs get): POST /v1/chat/completions, and
 * GET /v1/models naming MODEL. `paceMs` delays each answer, as a model's turn takes time.
 * `replies` lists the turns answered, so a shot can wait on the agent's progress.
 * @param {{ port: number, script: import("../agent-bench/scripted.mjs").Script, paceMs?: number }} o
 */
export async function startModelServer({ port, script, paceMs = 0 }) {
  /** @type {import("../agent-bench/scripted.mjs").ScriptTurn[]} */
  const replies = [];
  const answer = scriptedFetch(
    (req) => {
      const out = script(req);
      replies.push(out);
      return out;
    },
    { paceMs },
  );
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const body = await readBody(req);
    const json = (/** @type {number} */ status, /** @type {string} */ text) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(text);
    };
    if (req.method === "GET" && path === "/v1/models")
      return json(200, JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model" }] }));
    if (req.method === "POST" && path === "/v1/chat/completions") {
      try {
        const reply = await answer(`${SCRIPTED_PROVIDER.endpoint}/chat/completions`, { body });
        return json(reply.status, await reply.text());
      } catch (e) {
        // the detail goes to the recorder's log, never to the client, which sees a fixed message
        console.error("promo: the scripted model failed:", e);
        return json(500, JSON.stringify({ error: { message: "scripted model failed" } }));
      }
    }
    return json(404, JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  const bound = typeof address === "object" && address ? address.port : port;
  return {
    endpoint: `http://127.0.0.1:${bound}/v1`,
    /** every turn the script answered, oldest first */
    replies,
    /** @returns {Promise<void>} */
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
