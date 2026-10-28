// docs/specs/builtin-agent.md B6, B10, Behaviour 15-18, 34: the pure model loop, driven here by
// a scripted OpenAI-compatible server (a fake `fetch`) and a scripted tool runner. No network.
import { describe, expect, test } from "vitest";
import { Budget } from "../src/agent-budget.mjs";
import { checkToolCall, clearContext, startTask } from "../src/agent-loop.mjs";

const provider = { kind: "openai", endpoint: "http://127.0.0.1:11434/v1", model: "m" };
const TOOLS = [
  {
    name: "vimma_open",
    description: "Open a URL.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, tab: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "vimma_tabs",
    description: "List tabs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "vimma_console",
    description: "Console.",
    inputSchema: {
      type: "object",
      properties: {
        tab: { type: "string" },
        since: { type: "integer" },
        all: { type: "boolean" },
        n: { type: "number" },
        list: { type: "array" },
        opts: { type: "object" },
      },
    },
  },
];

/**
 * @param {string} name @param {any} args @param {string} [id]
 */
const call = (name, args, id = `c_${name}`) => ({
  id,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});

/**
 * A scripted server: each entry is the assistant message of one reply, or a function given the
 * request's `init` that returns a promise of one.
 * @param {any[]} script
 */
function server(script) {
  /** @type {any[]} */
  const bodies = [];
  /** @type {any[]} */
  const inits = [];
  /** @type {any} */
  const fetch = async (/** @type {string} */ _url, /** @type {any} */ init) => {
    inits.push(init);
    bodies.push(JSON.parse(init.body));
    const next = script.shift();
    if (next === undefined) throw new Error("the script ran out");
    const message = typeof next === "function" ? await next(init) : next;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }),
    };
  };
  return { fetch, bodies, inits };
}

/** @param {Record<string, (args: any) => any>} [impl] */
function runner(impl = {}) {
  /** @type {{ name: string, args: any }[]} */
  const calls = [];
  const runTool = async (/** @type {string} */ name, /** @type {any} */ args) => {
    calls.push({ name, args });
    const f = impl[name];
    if (f) return f(args);
    return { content: [{ type: "text", text: `${name} ok` }] };
  };
  return { runTool, calls };
}

function deferred() {
  /** @type {(v?: any) => void} */
  let resolve = () => {};
  /** @type {Promise<any>} */
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

/** @param {any} opts */
const start = (opts) =>
  startTask({
    provider,
    key: "",
    system: "SYS",
    tools: TOOLS,
    messages: [{ role: "user", text: "Buy milk" }],
    budget: new Budget(),
    ...opts,
  });

describe("the loop", () => {
  test("a tool call runs through the runner and its result goes back to the model", async () => {
    const s = server([
      { content: "", tool_calls: [call("vimma_open", { url: "https://shop.example/" })] },
      { content: "Opened." },
    ]);
    const r = runner({
      vimma_open: () => ({ content: [{ type: "text", text: "tab 12" }] }),
    });
    const res = await start({ fetch: s.fetch, runTool: r.runTool }).done;
    expect(r.calls).toEqual([{ name: "vimma_open", args: { url: "https://shop.example/" } }]);
    expect(s.bodies).toHaveLength(2);
    expect(s.bodies[1].messages.slice(-1)).toEqual([
      { role: "tool", tool_call_id: "c_vimma_open", content: "tab 12" },
    ]);
    expect(res.outcome).toBe("done");
    expect(res.reply).toBe("Opened.");
  });

  test("a reply without a tool call ends the turn", async () => {
    const s = server([{ content: "Which shop?" }]);
    const r = runner();
    const events = /** @type {any[]} */ ([]);
    const res = await start({
      fetch: s.fetch,
      runTool: r.runTool,
      onEvent: (/** @type {any} */ e) => events.push(e),
    }).done;
    expect(res.outcome).toBe("done");
    expect(res.reply).toBe("Which shop?");
    expect(r.calls).toEqual([]);
    expect(s.bodies).toHaveLength(1);
    expect(res.messages.slice(-1)).toEqual([
      { role: "assistant", text: "Which shop?", toolCalls: [] },
    ]);
    expect(events.map((e) => e.type)).toEqual(["usage", "reply"]);
  });

  test("the model's text before its tool calls is reported", async () => {
    const s = server([
      { content: "Looking.", tool_calls: [call("vimma_tabs", {})] },
      { content: "None open." },
    ]);
    const events = /** @type {any[]} */ ([]);
    await start({
      fetch: s.fetch,
      runTool: runner().runTool,
      onEvent: (/** @type {any} */ e) => events.push(e),
    }).done;
    expect(events.map((e) => e.type)).toEqual([
      "usage",
      "reply",
      "call",
      "result",
      "usage",
      "reply",
    ]);
    expect(events[1]).toEqual({ type: "reply", text: "Looking." });
    expect(events[3]).toMatchObject({
      type: "result",
      call: { name: "vimma_tabs" },
      result: { isError: false },
    });
  });

  test("a message added during a task reaches the next turn", async () => {
    const gate = deferred();
    const s = server([
      { content: "", tool_calls: [call("vimma_tabs", {})] },
      { content: "Lactose-free, noted." },
    ]);
    const r = runner({ vimma_tabs: () => gate.promise });
    const task = start({ fetch: s.fetch, runTool: r.runTool });
    await new Promise((res) => setTimeout(res, 0));
    task.steer("lactose-free only");
    gate.resolve({ content: [{ type: "text", text: "no tabs" }] });
    const res = await task.done;
    expect(s.bodies[1].messages.slice(-2)).toEqual([
      { role: "tool", tool_call_id: "c_vimma_tabs", content: "no tabs" },
      { role: "user", content: "lactose-free only" },
    ]);
    expect(res.outcome).toBe("done");
  });

  test("a message added while the model writes its last reply gets a turn of its own", async () => {
    /** @type {any} */
    let task;
    const s = server([
      async () => {
        task.steer("also bread");
        return { content: "Milk is in the basket." };
      },
      { content: "Bread too." },
    ]);
    task = start({ fetch: s.fetch, runTool: runner().runTool });
    const res = await task.done;
    expect(s.bodies).toHaveLength(2);
    expect(s.bodies[1].messages.slice(-2)).toEqual([
      { role: "assistant", content: "Milk is in the basket." },
      { role: "user", content: "also bread" },
    ]);
    expect(res.reply).toBe("Bread too.");
  });

  test("stop aborts the request and starts no further step", async () => {
    /** @type {any} */
    let task;
    const s = server([
      (/** @type {any} */ init) =>
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
          task.stop();
        }),
    ]);
    const r = runner();
    task = start({ fetch: s.fetch, runTool: r.runTool });
    const res = await task.done;
    expect(s.inits[0].signal.aborted).toBe(true);
    expect(res.outcome).toBe("stopped");
    expect(res.after).toBe(null);
    expect(r.calls).toEqual([]);
  });

  test("stop during a step lets it finish, then runs nothing more", async () => {
    const gate = deferred();
    const s = server([
      {
        content: "",
        tool_calls: [
          call("vimma_open", { url: "https://a.example/" }, "c1"),
          call("vimma_open", { url: "https://b.example/" }, "c2"),
        ],
      },
    ]);
    const r = runner({ vimma_open: () => gate.promise });
    const task = start({ fetch: s.fetch, runTool: r.runTool });
    await new Promise((res) => setTimeout(res, 0));
    task.stop();
    gate.resolve({ content: [{ type: "text", text: "opened" }] });
    const res = await task.done;
    expect(r.calls).toHaveLength(1);
    expect(s.bodies).toHaveLength(1);
    expect(res.outcome).toBe("stopped");
    expect(res.after).toMatchObject({ id: "c1", name: "vimma_open" });
    // Every call has a result, so the conversation can go on with the next task.
    expect(res.messages.at(-1)).toEqual({
      role: "tool",
      results: [
        {
          id: "c1",
          name: "vimma_open",
          isError: false,
          content: [{ type: "text", text: "opened" }],
        },
        {
          id: "c2",
          name: "vimma_open",
          isError: true,
          content: [{ type: "text", text: "Not run: the task was stopped." }],
        },
      ],
    });
  });

  test("stop before the task starts sends nothing", async () => {
    const s = server([]);
    const task = start({ fetch: s.fetch, runTool: runner().runTool });
    task.stop();
    const res = await task.done;
    expect(res.outcome).toBe("stopped");
    expect(s.bodies).toHaveLength(0);
  });

  test("a denied call is returned to the model as denied", async () => {
    const s = server([
      { content: "", tool_calls: [call("vimma_open", { url: "https://shop.example/" })] },
      { content: "You said no." },
    ]);
    const r = runner({
      vimma_open: () => ({
        isError: true,
        content: [{ type: "text", text: "denied: the user said no" }],
      }),
    });
    const res = await start({ fetch: s.fetch, runTool: r.runTool }).done;
    expect(s.bodies[1].messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "c_vimma_open",
      content: "Error: denied: the user said no",
    });
    expect(res.outcome).toBe("done");
  });

  test("a runner that throws gives the model an error, not a dead task", async () => {
    const s = server([{ content: "", tool_calls: [call("vimma_tabs", {})] }, { content: "ok" }]);
    const r = runner({
      vimma_tabs: () => {
        throw new Error("socket closed");
      },
    });
    const res = await start({ fetch: s.fetch, runTool: r.runTool }).done;
    expect(s.bodies[1].messages.at(-1).content).toBe("Error: The tool failed: socket closed");
    expect(res.outcome).toBe("done");
  });

  test("a runner result without content is an empty result", async () => {
    const s = server([{ content: "", tool_calls: [call("vimma_tabs", {})] }, { content: "ok" }]);
    const r = runner({ vimma_tabs: () => ({}) });
    await start({ fetch: s.fetch, runTool: r.runTool }).done;
    expect(s.bodies[1].messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "c_vimma_tabs",
      content: "",
    });
  });

  test("a provider error ends the task with the error", async () => {
    /** @type {any} */
    const fetch = async () => ({ ok: false, status: 500, text: async () => "overloaded" });
    const res = await start({ fetch, runTool: runner().runTool }).done;
    expect(res.outcome).toBe("error");
    expect(res.error).toBe("500: overloaded");
  });

  test("the endpoint rules apply: local_only refuses a remote provider", async () => {
    const s = server([{ content: "hi" }]);
    const res = await start({
      fetch: s.fetch,
      runTool: runner().runTool,
      provider: { ...provider, endpoint: "https://llm.example/v1" },
      localOnly: true,
    }).done;
    expect(res.outcome).toBe("error");
    expect(res.error).toBe("local_only refuses llm.example");
    expect(s.bodies).toHaveLength(0);
  });

  test("the history passed in is not changed", async () => {
    const messages = [{ role: "user", text: "hi" }];
    const s = server([{ content: "hello" }]);
    const res = await start({ fetch: s.fetch, runTool: runner().runTool, messages }).done;
    expect(messages).toHaveLength(1);
    expect(res.messages).toHaveLength(2);
  });
});

describe("malformed tool calls", () => {
  test("broken JSON, an unknown tool and a wrong argument never reach the runner", async () => {
    const s = server([
      {
        content: "",
        tool_calls: [
          call("vimma_open", '{"url": "https://', "bad-json"),
          call("vimma_download", { url: "x" }, "unknown"),
          // As qwen2.5:1.5b wrote it (fixtures/agent-providers/ollama-tool-call.json).
          call("vimma_open", { url: { type: "string", value: "https://example.com" } }, "typed"),
          call("vimma_open", {}, "missing"),
          call("vimma_open", { url: "https://a.example/", extra: 1 }, "extra"),
          call("vimma_open", { url: "https://a.example/" }, "fine"),
        ],
      },
      { content: "done" },
    ]);
    const r = runner();
    const events = /** @type {any[]} */ ([]);
    const res = await start({
      fetch: s.fetch,
      runTool: r.runTool,
      onEvent: (/** @type {any} */ e) => events.push(e),
    }).done;
    expect(r.calls).toEqual([{ name: "vimma_open", args: { url: "https://a.example/" } }]);
    const tools = s.bodies[1].messages.filter((/** @type {any} */ m) => m.role === "tool");
    expect(tools.map((/** @type {any} */ m) => [m.tool_call_id, m.content])).toEqual([
      ["bad-json", "Error: Not run: its arguments are not valid JSON."],
      ["unknown", 'Error: Not run: there is no tool named "vimma_download".'],
      ["typed", 'Error: Not run: "url" must be a string.'],
      ["missing", 'Error: Not run: vimma_open needs "url".'],
      ["extra", 'Error: Not run: vimma_open takes no "extra".'],
      ["fine", "vimma_open ok"],
    ]);
    expect(events.filter((e) => e.type === "refused")).toHaveLength(5);
    expect(res.outcome).toBe("done");
  });

  test("malformed calls count as steps, so a model that keeps writing them stops", async () => {
    const bad = { content: "", tool_calls: [call("nope", {})] };
    const s = server([bad, bad, bad, bad]);
    const res = await start({
      fetch: s.fetch,
      runTool: runner().runTool,
      budget: new Budget({ maxSteps: 3 }),
    }).done;
    expect(res.outcome).toBe("budget");
    expect(res.exceeded).toEqual({ limit: "steps", used: 3, max: 3 });
    expect(s.bodies).toHaveLength(3);
  });

  test.each([
    [{ since: 5 }, null],
    [{ since: 1.5 }, '"since" must be an integer'],
    [{ all: "yes" }, '"all" must be a boolean'],
    [{ n: "1" }, '"n" must be a number'],
    [{ n: Number.NaN }, '"n" must be a number'],
    [{ list: {} }, '"list" must be an array'],
    [{ opts: [] }, '"opts" must be an object'],
    [{ opts: null }, '"opts" must be an object'],
    [{ unknown: 1 }, null],
  ])("checkToolCall %j", (args, error) => {
    expect(checkToolCall({ id: "x", name: "vimma_console", args }, TOOLS)).toBe(error);
  });
});

describe("budgets", () => {
  test("a task stops at max_steps between two calls of one reply", async () => {
    const s = server([
      { content: "", tool_calls: [call("vimma_tabs", {}, "a"), call("vimma_tabs", {}, "b")] },
    ]);
    const r = runner();
    const res = await start({
      fetch: s.fetch,
      runTool: r.runTool,
      budget: new Budget({ maxSteps: 1 }),
    }).done;
    expect(r.calls).toHaveLength(1);
    expect(res.outcome).toBe("budget");
    expect(res.exceeded).toEqual({ limit: "steps", used: 1, max: 1 });
    expect(res.messages.at(-1).results[1]).toEqual({
      id: "b",
      name: "vimma_tabs",
      isError: true,
      content: [{ type: "text", text: "Not run: the task reached its budget." }],
    });
  });

  test("a task stops at max_tokens before running the reply's calls", async () => {
    const s = server([{ content: "", tool_calls: [call("vimma_tabs", {})] }]);
    const r = runner();
    const res = await start({
      fetch: s.fetch,
      runTool: r.runTool,
      budget: new Budget({ maxTokens: 110 }),
    }).done;
    expect(r.calls).toEqual([]);
    expect(res.outcome).toBe("budget");
    expect(res.exceeded).toEqual({ limit: "tokens", used: 110, max: 110 });
  });

  test("a task stops at max_cost", async () => {
    const s = server([
      { content: "", tool_calls: [call("vimma_tabs", {})] },
      { content: "", tool_calls: [call("vimma_tabs", {})] },
    ]);
    const res = await start({
      fetch: s.fetch,
      runTool: runner().runTool,
      // 100 in and 10 out at 1000 and 10000 per million: 0.2 a request.
      budget: new Budget({ maxCost: 0.3 }, { priceIn: 1000, priceOut: 10000 }),
    }).done;
    expect(res.outcome).toBe("budget");
    expect(res.exceeded?.limit).toBe("cost");
    expect(s.bodies).toHaveLength(2);
  });

  test("a final reply that crosses the budget still ends as done", async () => {
    const s = server([{ content: "All done." }]);
    const res = await start({
      fetch: s.fetch,
      runTool: runner().runTool,
      budget: new Budget({ maxTokens: 50 }),
    }).done;
    expect(res.outcome).toBe("done");
    expect(res.reply).toBe("All done.");
  });

  test("continue runs the same task on with the budget renewed", async () => {
    const budget = new Budget({ maxSteps: 1 });
    const s1 = server([{ content: "", tool_calls: [call("vimma_tabs", {})] }]);
    const first = await start({ fetch: s1.fetch, runTool: runner().runTool, budget }).done;
    expect(first.outcome).toBe("budget");
    budget.renew();
    const s2 = server([{ content: "Finished." }]);
    const second = await start({
      fetch: s2.fetch,
      runTool: runner().runTool,
      budget,
      messages: [...first.messages, { role: "user", text: "continue" }],
    }).done;
    expect(second.outcome).toBe("done");
    expect(s2.bodies[0].messages.slice(-2)).toEqual([
      { role: "tool", tool_call_id: "c_vimma_tabs", content: "vimma_tabs ok" },
      { role: "user", content: "continue" },
    ]);
  });
});

describe("clearContext", () => {
  test("a cleared context sends messages, replies and summaries only", () => {
    /** @type {import("../src/agent-providers.mjs").ChatMessage[]} */
    const history = [
      { role: "user", text: "Buy milk" },
      {
        role: "assistant",
        text: "Opening.",
        toolCalls: [{ id: "c1", name: "vimma_open", args: { url: "https://shop.example/" } }],
        raw: { kind: "anthropic", content: [] },
      },
      {
        role: "tool",
        results: [
          {
            id: "c1",
            name: "vimma_open",
            isError: false,
            content: [{ type: "text", text: "page text" }],
          },
        ],
      },
      { role: "assistant", text: "", toolCalls: [{ id: "c2", name: "vimma_tabs", args: {} }] },
      { role: "assistant", text: "Milk is in the basket.", toolCalls: [] },
      { role: "user", text: "Task summary by Vimma: done, 2 steps." },
    ];
    expect(clearContext(history)).toEqual([
      { role: "user", text: "Buy milk" },
      { role: "assistant", text: "Opening.", toolCalls: [] },
      { role: "assistant", text: "Milk is in the basket.", toolCalls: [] },
      { role: "user", text: "Task summary by Vimma: done, 2 steps." },
    ]);
  });
});
