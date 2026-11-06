import { afterEach, describe, expect, it } from "vitest";
import { startShop } from "../../agent-bench/shop.mjs";
import {
  DECLINED_TEXT,
  PROMO_CATALOG,
  SHOP_NAME,
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
  it("names products the promo's shop sells, one of each", () => {
    const ids = new Set(PROMO_CATALOG.products.map((p) => p.id));
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

describe("PROMO_CATALOG", () => {
  it("has no brands: a product is its name and size", () => {
    for (const p of PROMO_CATALOG.products) expect(p.brand).toBe("");
    expect(SHOP_NAME).not.toMatch(/bench/i);
  });
  it("is what the promo's shop shows: no brand in a button, the shop's name in the title", async () => {
    const shop = await startShop({ catalog: PROMO_CATALOG, name: SHOP_NAME });
    try {
      const html = await (await fetch(`${shop.base}search?q=oat+drink`)).text();
      expect(html).toContain(`<title>Search: oat drink · ${SHOP_NAME}</title>`);
      expect(html).toContain('aria-label="Add Oat drink, 1 l to basket"');
      expect(html).not.toMatch(/Bench Shop|\(, /);
    } finally {
      await shop.close();
    }
  });
});

describe("promoShopper", () => {
  it("finds the unbranded basket buttons", () => {
    const script = promoShopper({ base: BASE });
    script({ messages: [{ role: "user", content: PROMO_TASK }], tools: [] });
    const list = (/** @type {string} */ id, /** @type {string} */ label) =>
      `Opened ${BASE} in tab ${id}\n{"label":"${label}","kind":"button","text":"Add ${
        { 1: "Oat drink, 1 l", 2: "Rye bread, 500 g", 3: "Ground coffee, 500 g" }[id]
      } to basket"}`;
    const out = script({
      messages: [
        { role: "assistant", content: "" },
        { role: "tool", tool_call_id: "a", content: list("1", "a") },
        { role: "tool", tool_call_id: "b", content: list("2", "b") },
        { role: "tool", tool_call_id: "c", content: list("3", "c") },
      ],
      tools: [],
    });
    expect(out.calls?.map((c) => c.args)).toEqual([
      { tab: "1", label: "a" },
      { tab: "2", label: "b" },
      { tab: "3", label: "c" },
    ]);
  });
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
