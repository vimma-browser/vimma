import { afterEach, describe, expect, it } from "vitest";
import { loadCatalog } from "../../agent-bench/shop.mjs";
import {
  DECLINED_TEXT,
  PROMO_LIST,
  PROMO_TASK,
  promoShopper,
  startModelServer,
  textKeys,
} from "../agent.mjs";

const BASE = "http://shop.example/";

/** A tool message as the OpenAI-compatible adapter sends it. */
const tool = (/** @type {string} */ content) => ({ role: "tool", tool_call_id: "c", content });

describe("PROMO_LIST and PROMO_TASK", () => {
  it("names products the bench shop sells, one of each", () => {
    const ids = new Set(loadCatalog().products.map((p) => p.id));
    for (const item of PROMO_LIST.items) {
      expect(item.accept.every((id) => ids.has(id))).toBe(true);
      expect(item.qty).toBe(1);
    }
    expect(PROMO_LIST.items.map((i) => i.text)).toEqual(["oat drink", "rye bread", "coffee"]);
  });
  it("asks for what the script does: the basket, then the checkout", () => {
    expect(PROMO_TASK).toMatch(/oat drink, rye bread and coffee/);
    expect(PROMO_TASK).toMatch(/check out/);
  });
});

describe("promoShopper", () => {
  it("opens every search in one turn, then clicks every basket button", () => {
    const script = promoShopper({ base: BASE });
    const first = script({ messages: [{ role: "user", content: PROMO_TASK }], tools: [] });
    expect(first.calls?.map((c) => c.name)).toEqual(["vimma_open", "vimma_open", "vimma_open"]);
    expect(first.calls?.[0]?.args.url).toBe(`${BASE}search?q=oat+drink`);
  });
  it("says the order was not placed once the payment was denied", () => {
    const script = promoShopper({ base: BASE, inner: () => ({ text: "the inner script's end" }) });
    const out = script({
      messages: [tool("Error: The user denied this request in Vimma. Do not retry.")],
      tools: [],
    });
    expect(out).toEqual({ text: DECLINED_TEXT });
    expect(DECLINED_TEXT).toMatch(/not placed/);
  });
  it("keeps the inner script's turns otherwise", () => {
    const calls = [{ name: "vimma_open", args: { url: "x" } }];
    const script = promoShopper({ base: BASE, inner: () => ({ calls }) });
    expect(
      script({ messages: [tool("Error: The user denied this request in Vimma.")], tools: [] }),
    ).toEqual({ calls });
    const done = promoShopper({ base: BASE, inner: () => ({ text: "done" }) });
    expect(done({ messages: [tool("Opened tab 4")], tools: [] })).toEqual({ text: "done" });
  });
});

describe("textKeys", () => {
  it("sends a word and its space at a time, in send-keys notation", () => {
    expect(textKeys("Put oat drink, then go.")).toEqual([
      "P u t space",
      "o a t space",
      "d r i n k , space",
      "t h e n space",
      "g o .",
    ]);
  });
});

describe("startModelServer", () => {
  /** @type {{ close: () => Promise<void> } | null} */
  let server = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("answers OpenAI-compatible chat requests from the script", async () => {
    server = await startModelServer({ port: 0, script: () => ({ text: "hello" }) });
    const res = await fetch(`${/** @type {any} */ (server).endpoint}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "scripted", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.choices[0].message.content).toBe("hello");
    // the turns it answered, for the shot to wait on
    expect(/** @type {any} */ (server).replies).toEqual([{ text: "hello" }]);
  });
  it("lists its one model, as an OpenAI-compatible server does", async () => {
    server = await startModelServer({ port: 0, script: () => ({ text: "hello" }) });
    const res = await fetch(`${/** @type {any} */ (server).endpoint}/models`);
    expect((await res.json()).data.map((/** @type {any} */ m) => m.id)).toEqual(["scripted"]);
  });
  it("answers 404 to anything else", async () => {
    server = await startModelServer({ port: 0, script: () => ({ text: "hello" }) });
    const res = await fetch(`${/** @type {any} */ (server).endpoint}/embeddings`);
    expect(res.status).toBe(404);
  });
});
