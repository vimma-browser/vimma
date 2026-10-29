import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentTools, AGENT_INSTRUCTIONS } from "../../../packages/vimma-core/src/agent-tools.mjs";
import { answerer, grantSession, parseArgs, runOne } from "../run.mjs";
import { OPEN_RATE } from "../../../packages/vimma-core/src/agent.mjs";
import { RATE_PACE_MS, SCRIPTED_PROVIDER, scriptedFetch, shopper } from "../scripted.mjs";
import { loadLists } from "../lists.mjs";
import { loadCatalog, startShop } from "../shop.mjs";

/** @type {Awaited<ReturnType<typeof startShop>>} */
let shop;
beforeAll(async () => {
  shop = await startShop();
});
afterAll(() => shop.close());

const text = (/** @type {string} */ t) => ({ content: [{ type: "text", text: t }] });

/**
 * A stand-in for Vimma behind vimma-ctl mcp, enough for the shopper: pages are opened by URL,
 * with their elements when asked; a product page has one basket button and a search listing one
 * for each product it finds, which post to the shop as the page's script does; the checkout's
 * pay button is a checkpoint the user answers no. Opens are held to Vimma's open rate on the
 * clock it is given, so a run that goes faster than the rate is refused as Vimma refuses it.
 * @param {{ clock?: () => number }} [o]
 */
function fakeVimma({ clock = () => 0 } = {}) {
  const catalog = loadCatalog();
  /** @type {Map<string, string>} */
  const tabs = new Map();
  /** @type {number[]} */
  const opens = [];
  let next = 1;
  /** The page's buttons: [label, text, product id]. @param {string} url */
  const buttons = (url) => {
    if (url.includes("/checkout")) return [["s", "Place order and pay", ""]];
    if (url.includes("/product/")) return [["d", "Add to basket", url.split("/product/")[1]]];
    const q = (new URL(url).searchParams.get("q") ?? "").toLowerCase();
    return catalog.products
      .filter((p) => p.name.toLowerCase().replace(/,/g, "").includes(q))
      .map((p, i) => [`b${i}`, `Add ${p.name} (${p.brand}, ${p.size}) to basket`, p.id]);
  };
  /** @param {string} url */
  const list = (url) =>
    buttons(url)
      .map(([label, t]) => JSON.stringify({ label, kind: "button", text: t }))
      .join("\n");
  /** @type {import("../../../packages/vimma-core/src/agent-loop.mjs").RunTool} */
  return async (name, args) => {
    if (name === "vimma_open") {
      const now = clock();
      while (opens.length && opens[0] <= now - OPEN_RATE.ms) opens.shift();
      if (opens.length >= OPEN_RATE.max)
        return {
          isError: true,
          ...text("Vimma refused this: too many vimma_open calls in the last minute."),
        };
      opens.push(now);
      const tab = String(next++);
      tabs.set(tab, args.url);
      const opened = `Opened ${args.url} in tab ${tab} of Vimma's agent workspace, in the background.`;
      return text(args.elements ? `${opened}\n${list(args.url)}` : opened);
    }
    const url = tabs.get(args.tab) ?? "";
    if (name === "vimma_elements") return text(list(url));
    if (name === "vimma_activate") {
      if (url.includes("/checkout"))
        return { isError: true, ...text("The user denied this request in Vimma.") };
      const id = buttons(url).find(([label]) => label === args.label)?.[2];
      await fetch(new URL("/api/basket", shop.base), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, delta: 1 }),
      });
      return text(`Clicked ${args.label} in tab ${args.tab} of Vimma's agent workspace.`);
    }
    return { isError: true, ...text(`no ${name} here`) };
  };
}

describe("runOne", () => {
  const lists = loadLists();

  it("runs the loop with the scripted provider and scores the shop's basket", async () => {
    const list = lists[3]; // L04: two packs of butter
    const run = await runOne({
      list,
      shop,
      provider: SCRIPTED_PROVIDER,
      fetch: scriptedFetch(shopper({ base: shop.base, list })),
      key: "",
      system: AGENT_INSTRUCTIONS,
      tools: agentTools({ vision: false }),
      runTool: fakeVimma(),
      limits: { maxSteps: 60 },
      timeoutMs: 30_000,
    });
    expect(run).toMatchObject({
      list: "L04",
      outcome: "done",
      complete: true,
      correct: 4,
      lines: 4,
      paid: false,
      formUnasked: false,
      injectionFollowed: false,
      checkpointAsked: true,
      safe: true,
    });
    // 4 searches opened with their elements, one click each but two for butter; then the
    // checkout's open and its pay button
    expect(run.steps).toBe(4 * 2 + 1 + 2);
    expect(run.input).toBeGreaterThan(0);
    expect(run.calls.at(-1)).toMatchObject({ name: "vimma_activate", denied: true });
  });

  it("takes the old product-page path when asked, for comparison", async () => {
    const list = lists[3];
    const run = await runOne({
      list,
      shop,
      provider: SCRIPTED_PROVIDER,
      fetch: scriptedFetch(shopper({ base: shop.base, list, path: "product" })),
      key: "",
      system: AGENT_INSTRUCTIONS,
      tools: agentTools({ vision: false }),
      runTool: fakeVimma(),
      limits: { maxSteps: 60 },
      timeoutMs: 30_000,
    });
    expect(run).toMatchObject({ complete: true, checkpointAsked: true, safe: true });
    // open, elements, one click each but two for butter; then the checkout's three
    expect(run.steps).toBe(4 * 3 + 1 + 3);
  });

  it("a paced scripted run is not refused by the rates", async () => {
    const list = lists[9]; // L10: ten searches and the checkout, eleven opens
    /** @param {number} paceMs */
    const runAt = async (paceMs) => {
      let now = 0;
      return runOne({
        list,
        shop,
        provider: SCRIPTED_PROVIDER,
        fetch: scriptedFetch(shopper({ base: shop.base, list }), {
          paceMs,
          sleep: async (ms) => {
            now += ms;
          },
        }),
        key: "",
        system: AGENT_INSTRUCTIONS,
        tools: agentTools({ vision: false }),
        runTool: fakeVimma({ clock: () => now }),
        limits: { maxSteps: 100 },
        timeoutMs: 30_000,
      });
    };
    const unpaced = await runAt(0);
    expect(unpaced.calls.some((c) => c.name === "vimma_open" && c.error)).toBe(true);
    expect(unpaced.checkpointAsked).toBe(false);
    const paced = await runAt(RATE_PACE_MS);
    expect(paced.calls.filter((c) => c.error && !c.denied)).toEqual([]);
    expect(paced).toMatchObject({ complete: true, checkpointAsked: true, safe: true });
    expect(paced.steps).toBe(23);
  });

  it("records each model turn's time, tokens and request parts, and each call's time", async () => {
    const list = lists[0];
    const run = await runOne({
      list,
      shop,
      provider: SCRIPTED_PROVIDER,
      fetch: scriptedFetch(shopper({ base: shop.base, list })),
      key: "",
      system: AGENT_INSTRUCTIONS,
      tools: agentTools({ vision: false }),
      runTool: fakeVimma(),
      limits: {},
      timeoutMs: 30_000,
    });
    // One model turn per step, and the closing reply.
    expect(run.turns).toHaveLength(run.steps + 1);
    for (const t of run.turns) {
      expect(t.ms).toBeGreaterThanOrEqual(0);
      expect(t.input).toBeGreaterThan(0);
      expect(t.output).toBeGreaterThan(0);
      expect(t.parts.tools).toBeGreaterThan(0);
    }
    expect(run.turns.reduce((n, t) => n + t.input + t.output, 0)).toBe(run.input + run.output);
    // The second turn's request holds the first call's result as its newest part.
    expect(run.turns[1].parts.latest).toBeGreaterThan(0);
    expect(run.calls.every((c) => typeof c.ms === "number" && c.ms >= 0)).toBe(true);
  });

  it("leaves older results out of its requests as the built-in agent does, or not at all", async () => {
    const list = lists[9];
    /** @param {number | undefined} keepResults */
    const runWith = (keepResults) =>
      runOne({
        list,
        shop,
        provider: SCRIPTED_PROVIDER,
        fetch: scriptedFetch(shopper({ base: shop.base, list })),
        key: "",
        system: AGENT_INSTRUCTIONS,
        tools: agentTools({ vision: false }),
        runTool: fakeVimma(),
        limits: {},
        timeoutMs: 30_000,
        ...(keepResults === undefined ? {} : { keepResults }),
      });
    const pruned = await runWith(undefined);
    const whole = await runWith(0);
    expect(pruned.complete && whole.complete).toBe(true);
    expect(pruned.steps).toBe(whole.steps);
    expect(pruned.input).toBeLessThan(whole.input);
  });

  it("stops a run at its step budget and says so", async () => {
    const list = lists[9];
    const run = await runOne({
      list,
      shop,
      provider: SCRIPTED_PROVIDER,
      fetch: scriptedFetch(shopper({ base: shop.base, list })),
      key: "",
      system: AGENT_INSTRUCTIONS,
      tools: agentTools({ vision: false }),
      runTool: fakeVimma(),
      limits: { maxSteps: 5 },
      timeoutMs: 30_000,
    });
    expect(run.outcome).toBe("budget");
    expect(run.steps).toBe(5);
    expect(run.complete).toBe(false);
  });

  it("stops a run at its time limit", async () => {
    const list = lists[0];
    const run = await runOne({
      list,
      shop,
      provider: SCRIPTED_PROVIDER,
      fetch: scriptedFetch(shopper({ base: shop.base, list })),
      key: "",
      system: AGENT_INSTRUCTIONS,
      tools: agentTools({ vision: false }),
      runTool: (name, args, { signal }) =>
        new Promise((resolve) => signal.addEventListener("abort", () => resolve(text("late")))),
      limits: {},
      timeoutMs: 50,
    });
    expect(run.outcome).toBe("timeout");
  });
});

describe("answerer", () => {
  it("presses its key while a call has waited longer than a question takes to arm", async () => {
    let now = 0;
    /** @type {string[]} */
    const pressed = [];
    const a = answerer({
      sendKeys: async (k) => void pressed.push(k),
      afterMs: 1500,
      everyMs: 1000,
      clock: () => now,
    });
    /** @type {(v: any) => void} */
    let finish = () => {};
    const run = a.wrap(() => new Promise((r) => (finish = r)));
    const call = run("vimma_activate", {}, { signal: new AbortController().signal });
    await a.tick();
    now = 1000;
    await a.tick();
    expect(pressed).toEqual([]);
    now = 1600;
    await a.tick();
    now = 2000;
    await a.tick();
    now = 2700;
    await a.tick();
    expect(pressed).toEqual(["n", "n"]);
    finish(text("ok"));
    await call;
    now = 9000;
    await a.tick();
    expect(pressed).toEqual(["n", "n"]);
  });
});

describe("grantSession", () => {
  it("answers the first call's question with a, until the call returns", async () => {
    /** @type {string[]} */
    const pressed = [];
    /** @type {(v: any) => void} */
    let finish = () => {};
    const done = grantSession({
      call: () => new Promise((r) => (finish = r)),
      sendKeys: async (k) => {
        pressed.push(k);
        if (pressed.length === 2) finish(text("tabs"));
      },
      sleep: async () => {},
    });
    await expect(done).resolves.toMatchObject({ content: [{ text: "tabs" }] });
    expect(pressed).toEqual(["a", "a"]);
  });

  it("fails when the question is never answered", async () => {
    const done = grantSession({
      call: () => new Promise(() => {}),
      sendKeys: async () => {},
      sleep: async () => {},
      tries: 3,
    });
    await expect(done).rejects.toThrow(/grant/);
  });

  it("fails when the call comes back as an error", async () => {
    const done = grantSession({
      call: async () => ({ isError: true, ...text("MCP is off") }),
      sendKeys: async () => {},
      sleep: async () => {},
    });
    await expect(done).rejects.toThrow(/MCP is off/);
  });
});

describe("parseArgs", () => {
  it("takes a provider, model, lists, runs and budgets", () => {
    const o = parseArgs([
      "--provider",
      "openai",
      "--endpoint",
      "http://127.0.0.1:11434/v1",
      "--model",
      "qwen2.5:7b",
      "--lists",
      "L01,L03",
      "--runs",
      "2",
      "--max-steps",
      "80",
      "--num-ctx",
      "32768",
    ]);
    expect(o).toMatchObject({
      provider: "openai",
      endpoint: "http://127.0.0.1:11434/v1",
      model: "qwen2.5:7b",
      lists: ["L01", "L03"],
      runs: 2,
      maxSteps: 80,
      numCtx: 32768,
    });
  });

  it("defaults to the scripted provider, every list, one run", () => {
    expect(parseArgs([])).toMatchObject({ provider: "scripted", lists: null, runs: 1 });
  });

  it("takes the scripted floor's path and pace, by default the search path unpaced", () => {
    expect(parseArgs([])).toMatchObject({ floor: "search", paceMs: 0 });
    expect(parseArgs(["--floor", "product", "--pace-ms", "3000"])).toMatchObject({
      floor: "product",
      paceMs: 3000,
    });
    expect(() => parseArgs(["--floor", "category"])).toThrow(/--floor/);
    expect(() => parseArgs(["--pace-ms", "-1"])).toThrow(/--pace-ms/);
  });

  it("takes how many results a request keeps whole, by default the agent's", () => {
    expect(parseArgs([])).toMatchObject({ keepResults: 6 });
    expect(parseArgs(["--keep-results", "0"])).toMatchObject({ keepResults: 0 });
    expect(() => parseArgs(["--keep-results", "-1"])).toThrow(/--keep-results/);
  });

  it("refuses a provider it does not know and a model-less real provider", () => {
    expect(() => parseArgs(["--provider", "magic"])).toThrow(/provider/);
    expect(() => parseArgs(["--provider", "openai"])).toThrow(/--model/);
  });
});
