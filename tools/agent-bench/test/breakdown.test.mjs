import { describe, expect, it } from "vitest";
import { buildRequest } from "../../../packages/vimma-core/src/agent-providers.mjs";
import { formatBreakdown, requestParts, timedFetch } from "../breakdown.mjs";

/** @type {import("../../../packages/vimma-core/src/agent-providers.mjs").ToolDef[]} */
const TOOLS = [
  { name: "vimma_open", description: "Opens a page.", inputSchema: { type: "object" } },
  { name: "vimma_elements", description: "Lists elements.", inputSchema: { type: "object" } },
];
const SYSTEM = "You act in Vimma's agent workspace.";
const TASK = "Buy milk at http://127.0.0.1:1/.";
const OLD = '{"label":"a","kind":"link","text":"Milk"}';
const NEW = '{"label":"b","kind":"button","text":"Add to basket"}';

/** @type {import("../../../packages/vimma-core/src/agent-providers.mjs").ChatMessage[]} */
const MESSAGES = [
  { role: "user", text: TASK },
  { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "vimma_elements", args: {} }] },
  {
    role: "tool",
    results: [
      { id: "c1", name: "vimma_elements", isError: false, content: [{ type: "text", text: OLD }] },
    ],
  },
  { role: "assistant", text: "", toolCalls: [{ id: "c2", name: "vimma_elements", args: {} }] },
  {
    role: "tool",
    results: [
      { id: "c2", name: "vimma_elements", isError: false, content: [{ type: "text", text: NEW }] },
    ],
  },
];

/** @param {"openai" | "anthropic"} kind */
const body = (kind) =>
  buildRequest(
    { kind, endpoint: "http://127.0.0.1:9/v1", model: "m" },
    { key: "", system: SYSTEM, tools: TOOLS, messages: MESSAGES },
  ).body;

describe("requestParts", () => {
  for (const kind of /** @type {const} */ (["openai", "anthropic"])) {
    it(`splits a ${kind} request into what each part costs`, () => {
      const b = body(kind);
      const p = requestParts(b);
      expect(p.total).toBe(b.length);
      expect(p.system).toBe(SYSTEM.length);
      expect(p.task).toBe(TASK.length);
      expect(p.tools).toBeGreaterThan(JSON.stringify(TOOLS.map((t) => t.description)).length);
      // The newest results are the ones after the model's last turn; older ones are history.
      expect(p.latest).toBe(NEW.length);
      expect(p.results).toBe(OLD.length);
      expect(p.calls).toBeGreaterThan(0);
      expect(p.tools + p.system + p.task + p.calls + p.results + p.latest).toBeLessThanOrEqual(
        p.total,
      );
    });
  }

  it("counts nothing for a body it cannot read, beyond its length", () => {
    expect(requestParts("not json")).toEqual({
      total: 8,
      tools: 0,
      system: 0,
      task: 0,
      calls: 0,
      results: 0,
      latest: 0,
    });
  });
});

describe("timedFetch", () => {
  it("times each request and hands on its parts, and the reply unchanged", async () => {
    let now = 1000;
    /** @type {any[]} */
    const turns = [];
    const inner = async () => {
      now += 250;
      return { ok: true, status: 200, text: async () => "reply" };
    };
    const f = timedFetch(
      inner,
      (t) => turns.push(t),
      () => now,
    );
    const b = body("openai");
    const res = await f("http://127.0.0.1:9/v1/chat/completions", { body: b });
    expect(await res.text()).toBe("reply");
    expect(res.ok).toBe(true);
    expect(turns).toEqual([{ ms: 250, parts: requestParts(b) }]);
  });
});

describe("formatBreakdown", () => {
  it("says per run where the time went and what a request held", () => {
    const parts = {
      total: 4000,
      tools: 2000,
      system: 400,
      task: 100,
      calls: 300,
      results: 800,
      latest: 400,
    };
    const out = formatBreakdown([
      {
        list: "L01",
        run: 1,
        steps: 3,
        wallMs: 10_000,
        turns: [
          { ms: 2000, input: 1000, output: 50, parts },
          { ms: 4000, input: 1200, output: 30, parts: { ...parts, total: 4800, results: 1600 } },
        ],
        calls: [
          { name: "vimma_open", ms: 1000 },
          { name: "vimma_elements", ms: 500 },
        ],
      },
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(
      /^\| List \| Run \| Steps \| Model turns \| Model time \| Tool time \|/,
    );
    expect(lines[2]).toBe(
      "| L01 | 1 | 3 | 2 | 6 s | 2 s | 1100 | 1200 | 40 | 45 | 11 | 7 | 27 | 9 |",
    );
  });
});
