import { describe, expect, it } from "vitest";
import { callModel } from "../../../packages/vimma-core/src/agent/agent-providers.mjs";
import { SCRIPTED_PROVIDER, scriptedFetch, shopper } from "../scripted.ts";
import type { ScriptRequest } from "../scripted.ts";
import type { Catalog } from "../shop.ts";

const tools = [{ name: "vimma_open", description: "", inputSchema: { type: "object" } }];

/** One model turn through vimma-core's own adapter, as the loop makes it. */
const turn = (fetch: any, messages: any[]) =>
  callModel(SCRIPTED_PROVIDER, { fetch, key: "", system: "sys", tools, messages });

describe("scriptedFetch", () => {
  it("answers an OpenAI-compatible request with the script's tool calls", async () => {
    const fetch = scriptedFetch(() => ({ calls: [{ name: "vimma_open", args: { url: "x" } }] }));
    const reply = await turn(fetch, [{ role: "user", text: "go" }]);
    expect(reply.message.toolCalls).toEqual([
      { id: "call_1_1", name: "vimma_open", args: { url: "x" } },
    ]);
  });

  it("answers with text and no tool calls, which ends the turn", async () => {
    const fetch = scriptedFetch(() => ({ text: "done" }));
    const reply = await turn(fetch, [{ role: "user", text: "go" }]);
    expect(reply.message.text).toBe("done");
    expect(reply.message.toolCalls).toEqual([]);
  });

  it("reports usage counted from the request and reply, the same on every run", async () => {
    const fetch = scriptedFetch(() => ({ text: "done" }));
    const a = await turn(fetch, [{ role: "user", text: "go" }]);
    const b = await turn(fetch, [{ role: "user", text: "go" }]);
    expect(a.usage.estimated).toBe(false);
    expect(a.usage.input).toBeGreaterThan(0);
    expect(a.usage).toEqual(b.usage);
  });

  it("hands the script the request's messages", async () => {
    let seen: any[] = [];
    const fetch = scriptedFetch((req) => {
      seen = req.messages;
      return { text: "ok" };
    });
    await turn(fetch, [{ role: "user", text: "buy milk" }]);
    expect(seen.at(-1)).toEqual({ role: "user", content: "buy milk" });
  });

  it("makes no network request: it refuses any URL but its own", async () => {
    const fetch = scriptedFetch(() => ({ text: "ok" }));
    await expect(fetch("https://api.example.com/v1/chat/completions", {})).rejects.toThrow(
      /scripted/,
    );
  });
});

/** A tool message as the OpenAI-compatible adapter sends it. */
const toolMsg = (text: string) => ({
  role: "tool",
  tool_call_id: "c",
  content: text,
});

const ELEMENTS = [
  '{"label":"a","kind":"link","text":"Basket (0)"}',
  '{"label":"s","kind":"field","text":"","caption":"Quantity","value":"1"}',
  '{"label":"d","kind":"button","text":"Add to basket"}',
].join("\n");

const LISTING = [
  '{"label":"a","kind":"link","text":"Basket (0)"}',
  '{"label":"d","kind":"button","text":"Add Milk (Valio, 1 l) to basket"}',
  '{"label":"f","kind":"button","text":"Add Milk (Pirkka, 1 l) to basket"}',
].join("\n");

const CHECKOUT = [
  '{"label":"a","kind":"link","text":"Basket (2)"}',
  '{"label":"s","kind":"button","text":"Place order and pay"}',
].join("\n");

describe("shopper", () => {
  const list = {
    id: "T",
    items: [
      { text: "milk", accept: ["milk-pirkka"], qty: 2 },
      { text: "saffron", accept: [], qty: 0 },
    ],
  };

  it("opens each product, adds it as many times as asked, then tries to pay", () => {
    const next = shopper({ base: "http://127.0.0.1:1/", list, path: "product" });
    const messages: any[] = [{ role: "user", content: "task" }];
    const step = () => {
      const r = next({ messages } as ScriptRequest);
      messages.push({ role: "assistant", content: r.text ?? "" });
      return r;
    };

    expect(step().calls).toEqual([
      { name: "vimma_open", args: { url: "http://127.0.0.1:1/product/milk-pirkka" } },
    ]);
    messages.push(
      toolMsg("Opened http://127.0.0.1:1/product/milk-pirkka in tab 12 of Vimma's agent workspace"),
    );
    expect(step().calls).toEqual([{ name: "vimma_elements", args: { tab: "12" } }]);
    messages.push(
      toolMsg(`header\nsaid\n<untrusted-web-content>\n${ELEMENTS}\n</untrusted-web-content>`),
    );
    expect(step().calls).toEqual([{ name: "vimma_activate", args: { tab: "12", label: "d" } }]);
    messages.push(toolMsg("Clicked d in tab 12"));
    expect(step().calls).toEqual([{ name: "vimma_activate", args: { tab: "12", label: "d" } }]);
    messages.push(toolMsg("Clicked d in tab 12"));
    expect(step().calls).toEqual([
      { name: "vimma_open", args: { url: "http://127.0.0.1:1/checkout" } },
    ]);
    messages.push(
      toolMsg("Opened http://127.0.0.1:1/checkout in tab 13 of Vimma's agent workspace"),
    );
    expect(step().calls).toEqual([{ name: "vimma_elements", args: { tab: "13" } }]);
    messages.push(toolMsg(CHECKOUT));
    expect(step().calls).toEqual([{ name: "vimma_activate", args: { tab: "13", label: "s" } }]);
    messages.push(toolMsg("Error: The user denied this request in Vimma."));
    const last = step();
    expect(last.calls ?? []).toEqual([]);
    expect(last.text).toMatch(/basket/i);
  });

  it("lists a page again while it is still on its first blank document", () => {
    const next = shopper({ base: "http://127.0.0.1:1/", list, path: "product" });
    const messages: any[] = [{ role: "user", content: "task" }];
    next({ messages } as ScriptRequest);
    messages.push(toolMsg("Opened x in tab 3 of"));
    next({ messages } as ScriptRequest);
    messages.push(
      toolMsg("Error: Vimma could not do it: elements are listed only on http and https pages."),
    );
    expect(next({ messages } as ScriptRequest).calls).toEqual([
      { name: "vimma_elements", args: { tab: "3" } },
    ]);
    messages.push(toolMsg(ELEMENTS));
    expect(next({ messages } as ScriptRequest).calls).toEqual([
      { name: "vimma_activate", args: { tab: "3", label: "d" } },
    ]);
  });

  it("stops with a reply when a page has no button it needs", () => {
    const next = shopper({ base: "http://127.0.0.1:1/", list, path: "product" });
    const messages: any[] = [{ role: "user", content: "task" }];
    next({ messages } as ScriptRequest);
    messages.push(toolMsg("Opened x in tab 3 of"));
    next({ messages } as ScriptRequest);
    messages.push(toolMsg('{"label":"a","kind":"link","text":"Home"}'));
    const r = next({ messages } as ScriptRequest);
    expect(r.calls ?? []).toEqual([]);
    expect(r.text).toMatch(/no "Add to basket"/);
  });

  it("opens each item's search by URL with elements and clicks the listing's basket button", () => {
    const next = shopper({ base: "http://127.0.0.1:1/", list });
    const messages: any[] = [{ role: "user", content: "task" }];
    const step = () => {
      const r = next({ messages } as ScriptRequest);
      messages.push({ role: "assistant", content: r.text ?? "" });
      return r;
    };
    const opened = (url: string, tab: number, els: string) =>
      toolMsg(
        `The page ${url} (untrusted)\nOpened ${url} in tab ${tab} of Vimma's agent workspace, in the background.\n${els}`,
      );

    expect(step().calls).toEqual([
      { name: "vimma_open", args: { url: "http://127.0.0.1:1/search?q=milk", elements: true } },
    ]);
    messages.push(opened("http://127.0.0.1:1/search?q=milk", 12, LISTING));
    // The listing's own button for the product, not the first basket button on it.
    expect(step().calls).toEqual([{ name: "vimma_activate", args: { tab: "12", label: "f" } }]);
    messages.push(toolMsg("Clicked f in tab 12"));
    expect(step().calls).toEqual([{ name: "vimma_activate", args: { tab: "12", label: "f" } }]);
    messages.push(toolMsg("Clicked f in tab 12"));
    expect(step().calls).toEqual([
      { name: "vimma_open", args: { url: "http://127.0.0.1:1/checkout", elements: true } },
    ]);
    messages.push(opened("http://127.0.0.1:1/checkout", 13, CHECKOUT));
    expect(step().calls).toEqual([{ name: "vimma_activate", args: { tab: "13", label: "s" } }]);
    messages.push(toolMsg("Error: The user denied this request in Vimma."));
    const last = step();
    expect(last.calls ?? []).toEqual([]);
    expect(last.text).toMatch(/basket/i);
  });

  // agent-speed S4: a compact list leaves out the lines an earlier list of the site gave and
  // names their labels; the script reads them off that list, as a model does.
  it("finds a button a compact list left out in the earlier list that gave it", () => {
    const next = shopper({
      base: "http://127.0.0.1:1/",
      list: { ...list, items: [list.items[0]!] },
    });
    const messages: any[] = [{ role: "user", content: "task" }];
    messages.push(
      toolMsg(
        `Opened x in tab 9 of Vimma's agent workspace\n<untrusted-web-content>\n${LISTING}\n</untrusted-web-content>`,
      ),
    );
    next({ messages } as ScriptRequest);
    messages.push(
      toolMsg(
        "Opened http://127.0.0.1:1/search?q=milk in tab 12 of Vimma's agent workspace, in the " +
          "background.\n<untrusted-web-content>\n\n</untrusted-web-content>\n" +
          "(3 elements as in your last list of this site: a, d, f)",
      ),
    );
    expect(next({ messages } as ScriptRequest).calls).toEqual([
      { name: "vimma_activate", args: { tab: "12", label: "f" } },
    ]);
  });

  it("lists a search page again when its open could not list it", () => {
    const next = shopper({ base: "http://127.0.0.1:1/", list });
    const messages: any[] = [{ role: "user", content: "task" }];
    next({ messages } as ScriptRequest);
    messages.push(
      toolMsg(
        "Opened x in tab 3 of Vimma's agent workspace, in the background.\nNo elements: the page is still loading.",
      ),
    );
    expect(next({ messages } as ScriptRequest).calls).toEqual([
      { name: "vimma_elements", args: { tab: "3" } },
    ]);
    messages.push(toolMsg(LISTING));
    expect(next({ messages } as ScriptRequest).calls).toEqual([
      { name: "vimma_activate", args: { tab: "3", label: "f" } },
    ]);
  });
});

describe("shopper, parallel path", () => {
  const list = {
    id: "T",
    items: [
      { text: "milk", accept: ["milk-pirkka"], qty: 2 },
      { text: "oats", accept: ["oat-flakes"], qty: 1 },
      { text: "saffron", accept: [], qty: 0 },
    ],
  };
  const catalog = {
    products: [
      { id: "milk-pirkka", name: "Milk", brand: "Pirkka", size: "1 l" },
      { id: "oat-flakes", name: "Oat flakes", brand: "Myllyn Paras", size: "500 g" },
    ],
  } as Catalog;
  const OATS = [
    '{"label":"a","kind":"link","text":"Basket (0)"}',
    '{"label":"g","kind":"button","text":"Add Oat flakes (Myllyn Paras, 500 g) to basket"}',
  ].join("\n");
  /** The tool messages of one turn, in the order of its calls. */
  const results = (texts: string[]) =>
    texts.map((t, i) => ({ ...toolMsg(t), tool_call_id: `c${i}` }));
  const opened = (url: string, tab: number, els: string) =>
    `Opened ${url} in tab ${tab} of Vimma's agent workspace, in the background.\n${els}`;

  it("opens every search in one turn, then clicks every basket button in the next", () => {
    const next = shopper({ base: "http://127.0.0.1:1/", list, path: "parallel", catalog });
    const messages: any[] = [{ role: "user", content: "task" }];
    const step = () => {
      const r = next({ messages, tools: [] });
      messages.push({ role: "assistant", content: r.text ?? "" });
      return r;
    };

    expect(step().calls).toEqual([
      { name: "vimma_open", args: { url: "http://127.0.0.1:1/search?q=milk", elements: true } },
      {
        name: "vimma_open",
        args: { url: "http://127.0.0.1:1/search?q=oat+flakes", elements: true },
      },
    ]);
    messages.push(
      ...results([
        opened("http://127.0.0.1:1/search?q=milk", 12, LISTING),
        opened("http://127.0.0.1:1/search?q=oat+flakes", 13, OATS),
      ]),
    );
    // Each listing's own button, as many times as the list asks, all in one turn.
    expect(step().calls).toEqual([
      { name: "vimma_activate", args: { tab: "12", label: "f" } },
      { name: "vimma_activate", args: { tab: "12", label: "f" } },
      { name: "vimma_activate", args: { tab: "13", label: "g" } },
    ]);
    messages.push(
      ...results(["Clicked f in tab 12", "Clicked f in tab 12", "Clicked g in tab 13"]),
    );
    // The checkout depends on the basket, so it waits for the clicks' turn.
    expect(step().calls).toEqual([
      { name: "vimma_open", args: { url: "http://127.0.0.1:1/checkout", elements: true } },
    ]);
    messages.push(toolMsg(opened("http://127.0.0.1:1/checkout", 14, CHECKOUT)));
    expect(step().calls).toEqual([{ name: "vimma_activate", args: { tab: "14", label: "s" } }]);
    messages.push(toolMsg("Error: The user denied this request in Vimma."));
    const last = step();
    expect(last.calls ?? []).toEqual([]);
    expect(last.text).toMatch(/basket/i);
  });

  it("lists again, in one turn, only the pages whose open could not list them", () => {
    const next = shopper({ base: "http://127.0.0.1:1/", list, path: "parallel", catalog });
    const messages: any[] = [{ role: "user", content: "task" }];
    next({ messages, tools: [] });
    messages.push(
      ...results([
        "Opened x in tab 3 of Vimma's agent workspace, in the background.\nNo elements: the page is still loading.",
        opened("y", 4, OATS),
      ]),
    );
    expect(next({ messages, tools: [] }).calls).toEqual([
      { name: "vimma_elements", args: { tab: "3" } },
    ]);
    messages.push({ role: "assistant", content: "" }, toolMsg(LISTING));
    expect(next({ messages, tools: [] }).calls).toEqual([
      { name: "vimma_activate", args: { tab: "3", label: "f" } },
      { name: "vimma_activate", args: { tab: "3", label: "f" } },
      { name: "vimma_activate", args: { tab: "4", label: "g" } },
    ]);
  });

  it("finds a button a compact list left out in an earlier list of the same turn", () => {
    const next = shopper({
      base: "http://127.0.0.1:1/",
      list: { ...list, items: [list.items[1]!, list.items[0]!] },
      path: "parallel",
      catalog,
    });
    const messages: any[] = [{ role: "user", content: "task" }];
    next({ messages, tools: [] });
    messages.push(
      ...results([
        opened("x", 3, `${OATS}\n${LISTING.split("\n").slice(1).join("\n")}`),
        opened("y", 4, "(3 elements as in your last list of this site: a, d, f)"),
      ]),
    );
    expect(next({ messages, tools: [] }).calls).toEqual([
      { name: "vimma_activate", args: { tab: "3", label: "g" } },
      { name: "vimma_activate", args: { tab: "4", label: "f" } },
      { name: "vimma_activate", args: { tab: "4", label: "f" } },
    ]);
  });

  it("stops with a reply when an open failed", () => {
    const next = shopper({ base: "http://127.0.0.1:1/", list, path: "parallel", catalog });
    const messages: any[] = [{ role: "user", content: "task" }];
    next({ messages, tools: [] });
    messages.push(...results(["Error: too many vimma_open calls", opened("y", 4, OATS)]));
    const r = next({ messages, tools: [] });
    expect(r.calls ?? []).toEqual([]);
    expect(r.text).toMatch(/could not open http:\/\/127\.0\.0\.1:1\/search\?q=milk/);
  });
});

describe("scriptedFetch pacing", () => {
  it("waits paceMs before each answer, as a model's turn takes time", async () => {
    const waits: number[] = [];
    const fetch = scriptedFetch(() => ({ text: "ok" }), {
      paceMs: 1300,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await turn(fetch, [{ role: "user", text: "go" }]);
    await turn(fetch, [{ role: "user", text: "go" }]);
    expect(waits).toEqual([1300, 1300]);
  });

  it("does not wait unless asked", async () => {
    const waits: number[] = [];
    const fetch = scriptedFetch(() => ({ text: "ok" }), {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await turn(fetch, [{ role: "user", text: "go" }]);
    expect(waits).toEqual([]);
  });
});
