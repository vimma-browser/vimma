import { describe, expect, it } from "vitest";
import { callModel } from "../../../packages/vimma-core/src/agent-providers.mjs";
import { SCRIPTED_PROVIDER, scriptedFetch, shopper } from "../scripted.mjs";

const tools = [{ name: "vimma_open", description: "", inputSchema: { type: "object" } }];

/** One model turn through vimma-core's own adapter, as the loop makes it. */
const turn = (/** @type {any} */ fetch, /** @type {any[]} */ messages) =>
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
    /** @type {any[]} */
    let seen = [];
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
const toolMsg = (/** @type {string} */ text) => ({
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
    /** @type {any[]} */
    const messages = [{ role: "user", content: "task" }];
    const step = () => {
      const r = next({ messages });
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
    /** @type {any[]} */
    const messages = [{ role: "user", content: "task" }];
    next({ messages });
    messages.push(toolMsg("Opened x in tab 3 of"));
    next({ messages });
    messages.push(
      toolMsg("Error: Vimma could not do it: elements are listed only on http and https pages."),
    );
    expect(next({ messages }).calls).toEqual([{ name: "vimma_elements", args: { tab: "3" } }]);
    messages.push(toolMsg(ELEMENTS));
    expect(next({ messages }).calls).toEqual([
      { name: "vimma_activate", args: { tab: "3", label: "d" } },
    ]);
  });

  it("stops with a reply when a page has no button it needs", () => {
    const next = shopper({ base: "http://127.0.0.1:1/", list, path: "product" });
    /** @type {any[]} */
    const messages = [{ role: "user", content: "task" }];
    next({ messages });
    messages.push(toolMsg("Opened x in tab 3 of"));
    next({ messages });
    messages.push(toolMsg('{"label":"a","kind":"link","text":"Home"}'));
    const r = next({ messages });
    expect(r.calls ?? []).toEqual([]);
    expect(r.text).toMatch(/no "Add to basket"/);
  });

  it("opens each item's search by URL with elements and clicks the listing's basket button", () => {
    const next = shopper({ base: "http://127.0.0.1:1/", list });
    /** @type {any[]} */
    const messages = [{ role: "user", content: "task" }];
    const step = () => {
      const r = next({ messages });
      messages.push({ role: "assistant", content: r.text ?? "" });
      return r;
    };
    const opened = (
      /** @type {string} */ url,
      /** @type {number} */ tab,
      /** @type {string} */ els,
    ) =>
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
      list: { ...list, items: [list.items[0]] },
    });
    /** @type {any[]} */
    const messages = [{ role: "user", content: "task" }];
    messages.push(
      toolMsg(
        `Opened x in tab 9 of Vimma's agent workspace\n<untrusted-web-content>\n${LISTING}\n</untrusted-web-content>`,
      ),
    );
    next({ messages });
    messages.push(
      toolMsg(
        "Opened http://127.0.0.1:1/search?q=milk in tab 12 of Vimma's agent workspace, in the " +
          "background.\n<untrusted-web-content>\n\n</untrusted-web-content>\n" +
          "(3 elements as in your last list of this site: a, d, f)",
      ),
    );
    expect(next({ messages }).calls).toEqual([
      { name: "vimma_activate", args: { tab: "12", label: "f" } },
    ]);
  });

  it("lists a search page again when its open could not list it", () => {
    const next = shopper({ base: "http://127.0.0.1:1/", list });
    /** @type {any[]} */
    const messages = [{ role: "user", content: "task" }];
    next({ messages });
    messages.push(
      toolMsg(
        "Opened x in tab 3 of Vimma's agent workspace, in the background.\nNo elements: the page is still loading.",
      ),
    );
    expect(next({ messages }).calls).toEqual([{ name: "vimma_elements", args: { tab: "3" } }]);
    messages.push(toolMsg(LISTING));
    expect(next({ messages }).calls).toEqual([
      { name: "vimma_activate", args: { tab: "3", label: "f" } },
    ]);
  });
});

describe("scriptedFetch pacing", () => {
  it("waits paceMs before each answer, as a model's turn takes time", async () => {
    /** @type {number[]} */
    const waits = [];
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
    /** @type {number[]} */
    const waits = [];
    const fetch = scriptedFetch(() => ({ text: "ok" }), {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await turn(fetch, [{ role: "user", text: "go" }]);
    expect(waits).toEqual([]);
  });
});
