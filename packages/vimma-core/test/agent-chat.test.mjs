// docs/specs/builtin-agent.md B9, B19, Behaviour 6, 12-17, 34-35: the chat window's pure side.
// The transcript is built from the loop's task events and the gate's events for the
// conversation, never from a tool's own result format; every value is plain text.
import { describe, expect, test } from "vitest";
import {
  Transcript,
  builtinStatus,
  chatHeader,
  chatKey,
  chatText,
  entryView,
  externalNotice,
  isLocalEndpoint,
  parseAgentCommand,
} from "../src/agent-chat.mjs";

const call = (/** @type {string} */ name, args = {}, id = "c1") => ({ id, name, args });
const ok = { id: "c1", name: "vimma_activate", isError: false, content: [] };
const failed = { id: "c1", name: "vimma_activate", isError: true, content: [] };
const clickWhat = { kind: "button", text: "Lisää ostoskoriin", title: "Maito · Kauppa" };

/** @param {Transcript} t */
const texts = (t) =>
  t.entries.map((e) => `${e.kind}: ${e.text}${e.outcome ? ` · ${e.outcome}` : ""}`);

describe("the transcript", () => {
  test("transcript entries for a step, a checkpoint and a gate notice", () => {
    const t = new Transcript();
    t.user("Buy milk");
    t.task({ type: "call", call: call("vimma_activate") });
    t.gate({ kind: "ran", tool: "vimma_activate", what: clickWhat });
    t.task({ type: "result", call: call("vimma_activate"), result: ok });
    t.task({ type: "call", call: call("vimma_activate", {}, "c2") });
    t.gate({
      kind: "asked",
      tool: "vimma_activate",
      what: { pay: { site: "shop.example", total: "Total 42,90 €", text: "Pay" } },
    });
    t.gate({
      kind: "answered",
      tool: "vimma_activate",
      what: { pay: { site: "shop.example", total: "Total 42,90 €", text: "Pay" } },
      answer: "deny",
    });
    t.task({ type: "result", call: call("vimma_activate", {}, "c2"), result: failed });
    t.notice("granted: this conversation may use the agent workspace until stopped");
    expect(texts(t)).toEqual([
      "user: Buy milk",
      'step: clicked button "Lisää ostoskoriin" in "Maito · Kauppa" · ran under grant',
      'checkpoint: ▲ asked to pay on shop.example · the page says "Total 42,90 €" · → you said no',
      "notice: granted: this conversation may use the agent workspace until stopped",
    ]);
  });

  test("a step's outcome: asked → yes, denied, no answer, refused before the gate", () => {
    const t = new Transcript();
    t.task({ type: "call", call: call("vimma_read_page") });
    t.gate({ kind: "asked", tool: "vimma_read_page", what: { title: "Maito" } });
    expect(t.entries[0]).toMatchObject({ text: 'read "Maito"', outcome: "asking you" });
    t.gate({ kind: "answered", tool: "vimma_read_page", what: { title: "Maito" }, answer: "once" });
    t.task({ type: "result", call: call("vimma_read_page"), result: ok });
    t.task({ type: "call", call: call("vimma_read_page", {}, "c2") });
    t.gate({ kind: "asked", tool: "vimma_read_page", what: { title: "Kassa" } });
    t.gate({ kind: "answered", tool: "vimma_read_page", what: { title: "Kassa" }, answer: "deny" });
    t.task({ type: "result", call: call("vimma_read_page", {}, "c2"), result: failed });
    t.task({ type: "call", call: call("vimma_tabs", {}, "c3") });
    t.gate({ kind: "asked", tool: "vimma_tabs", what: { count: 1 } });
    t.gate({ kind: "timeout", tool: "vimma_tabs", what: { count: 1 } });
    t.task({ type: "result", call: call("vimma_tabs", {}, "c3"), result: failed });
    t.task({
      type: "refused",
      call: call("vimma_open", {}, "c4"),
      reason: 'vimma_open needs "url"',
    });
    t.task({ type: "call", call: call("vimma_close_tab", {}, "c5") });
    t.task({ type: "result", call: call("vimma_close_tab", {}, "c5"), result: failed });
    expect(t.entries.map((e) => e.outcome)).toEqual([
      "asked → yes",
      "denied",
      "denied (no answer)",
      'refused: vimma_open needs "url"',
      "refused",
    ]);
  });

  test("a step the gate says nothing of shows the loop's own name for it", () => {
    const t = new Transcript();
    t.task({ type: "call", call: call("vimma_new_tool") });
    t.task({ type: "result", call: call("vimma_new_tool"), result: ok });
    expect(t.entries[0]).toMatchObject({ kind: "step", text: "vimma_new_tool", outcome: "done" });
  });

  test("a message sent during a task is marked, and a reply is the agent's", () => {
    const t = new Transcript();
    t.user("first");
    t.task({ type: "reply", text: "On it." });
    t.user("and eggs", { during: true });
    t.task({ type: "steer", text: "and eggs" });
    expect(texts(t)).toEqual([
      "user: first",
      "agent: On it.",
      "user: and eggs (added during the task)",
    ]);
  });

  test("a task's end: stopped after the last step, the budget's limit, an error, done", () => {
    const t = new Transcript();
    t.task({ type: "call", call: call("vimma_activate") });
    t.gate({ kind: "ran", tool: "vimma_activate", what: clickWhat });
    t.task({ type: "result", call: call("vimma_activate"), result: ok });
    t.end({ outcome: "stopped", after: call("vimma_activate") });
    t.end({ outcome: "budget", exceeded: { limit: "steps", used: 60, max: 60 } });
    t.end({ outcome: "error", error: "HTTP 401: bad key" });
    t.end({ outcome: "done" });
    expect(t.entries.slice(1).map((e) => e.text)).toEqual([
      'stopped after "clicked button "Lisää ostoskoriin" in "Maito · Kauppa""',
      "stopped: 60 steps, the limit of [agent] max_steps",
      "stopped: HTTP 401: bad key",
      "done",
    ]);
    expect(t.entries.at(-2)?.warn).toBe(true);
  });

  test("a server error is a notice; usage adds nothing", () => {
    const t = new Transcript();
    t.task({ type: "usage", usage: { input: 1, output: 1, estimated: false } });
    t.task({ type: "server-error", error: "HTTP 500" });
    expect(texts(t)).toEqual(["notice: the model server failed (HTTP 500); it is asked again"]);
  });

  test("a step still running when the task stops says so", () => {
    const t = new Transcript();
    t.task({ type: "call", call: call("vimma_tabs") });
    t.gate({ kind: "asked", tool: "vimma_tabs", what: { count: 1 } });
    t.end({ outcome: "stopped", after: null });
    expect(texts(t)).toEqual(["step: listed the agent tabs · withdrawn", "end: stopped"]);
  });

  test("version counts every change, for the window to redraw", () => {
    const t = new Transcript();
    const v = t.version;
    t.user("x");
    expect(t.version).toBeGreaterThan(v);
  });
});

describe("plain text", () => {
  test("bidi overrides and control characters go; line breaks and tabs stay", () => {
    expect(chatText("a‮b\r\nc\u0007d\te⁦f")).toBe("ab\ncd\tef");
  });

  test("a reply line starting with a question glyph is indented under the agent label", () => {
    const view = entryView({ kind: "agent", text: "▲ wants to pay: y pay · n stop\nok" });
    expect(view).toEqual({
      label: "agent",
      lines: ["▲ wants to pay: y pay · n stop", "ok"],
      indent: true,
      tone: "normal",
    });
    expect(entryView({ kind: "user", text: "hi" })).toMatchObject({ label: "you", indent: true });
    expect(entryView({ kind: "step", text: "read", outcome: "ran under grant" })).toEqual({
      label: null,
      lines: ["· read — ran under grant"],
      indent: false,
      tone: "dim",
    });
    expect(
      entryView({ kind: "checkpoint", text: "▲ asked to pay", outcome: "→ you said no" }),
    ).toMatchObject({
      lines: ["▲ asked to pay → you said no"],
      tone: "warn",
    });
  });
});

describe("the header (Behaviour 6)", () => {
  const local = {
    name: "local",
    kind: "openai",
    endpoint: "http://127.0.0.1:11434/v1",
    model: "qwen3:14b",
  };
  test("says where data goes and where the agent works", () => {
    expect(chatHeader({ provider: local, granted: false })).toEqual([
      "local · qwen3:14b · stays on this machine",
      "works in: agent workspace · asks every step",
    ]);
    expect(
      chatHeader({
        provider: {
          name: "anthropic",
          kind: "anthropic",
          endpoint: "https://api.anthropic.com",
          model: "claude-sonnet-4-5",
        },
        granted: true,
        budget: { steps: 14, maxSteps: 60, tokens: 1, estimated: false, cost: null },
      }),
    ).toEqual([
      "anthropic · claude-sonnet-4-5 · page text sent to api.anthropic.com",
      "works in: agent workspace · granted · 14/60 steps",
    ]);
  });

  test("a local address that was not probed is named, not called private", () => {
    const vllm = { ...local, endpoint: "http://127.0.0.1:8000/v1" };
    expect(chatHeader({ provider: vllm, granted: false })[0]).toBe(
      "local · qwen3:14b · local endpoint 127.0.0.1:8000",
    );
    expect(chatHeader({ provider: local, granted: false, localOnly: true })[0]).toBe(
      "local · qwen3:14b · stays on this machine · local only",
    );
  });

  test("without a provider it says so", () => {
    expect(chatHeader({ provider: null, granted: false })[0]).toBe("no model set up");
  });
});

describe("what leaves the machine (Behaviour 5)", () => {
  test("only a loopback endpoint is local", () => {
    expect(isLocalEndpoint("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLocalEndpoint("http://[::1]:8000/v1")).toBe(true);
    expect(isLocalEndpoint("http://localhost:1234/v1")).toBe(true);
    expect(isLocalEndpoint("https://api.anthropic.com")).toBe(false);
    expect(isLocalEndpoint("not a url")).toBe(false);
  });

  test("the notice before the first task names the host and, when known, who runs it", () => {
    expect(
      externalNotice({ kind: "anthropic", endpoint: "https://api.anthropic.com", name: "a" }),
    ).toBe(
      "Page text the agent reads, field values it sees, screenshots and your messages are " +
        "sent to api.anthropic.com (Anthropic). y send · n cancel",
    );
    expect(
      externalNotice({ kind: "openai", endpoint: "https://llm.example.com/v1", name: "x" }),
    ).toBe(
      "Page text the agent reads, field values it sees, screenshots and your messages are " +
        "sent to llm.example.com. y send · n cancel",
    );
  });
});

describe("the status bar (Behaviour 35)", () => {
  const s = (/** @type {any} */ o) => ({
    steps: 14,
    maxSteps: 60,
    tokens: 212_400,
    estimated: false,
    cost: null,
    ...o,
  });
  test("one task: steps and tokens, cost with prices; several: how many", () => {
    expect(builtinStatus([])).toBe(null);
    expect(builtinStatus([s({})])).toBe("◇ built-in 14/60 · 212k tok");
    expect(builtinStatus([s({ cost: 0.414 })])).toBe("◇ built-in 14/60 · 212k tok · 0.41");
    expect(builtinStatus([s({ tokens: 1_250_000, estimated: true })])).toBe(
      "◇ built-in 14/60 · ~1.3M tok",
    );
    expect(builtinStatus([s({ tokens: 950 })])).toBe("◇ built-in 14/60 · 950 tok");
    expect(builtinStatus([s({}), s({})])).toBe("◇ 2 agents");
  });
});

describe(":agent (Behaviour 14)", () => {
  test("its words", () => {
    expect(parseAgentCommand(undefined)).toEqual({ kind: "open" });
    expect(parseAgentCommand(" stop ")).toEqual({ kind: "stop" });
    for (const w of ["new", "model", "list", "clear", "give"])
      expect(parseAgentCommand(w)).toEqual({ kind: w });
    expect(parseAgentCommand("forget all")).toEqual({ kind: "forget" });
    expect(parseAgentCommand("forget")).toMatchObject({
      kind: "refuse",
      text: expect.stringContaining('"forget all"'),
    });
    expect(parseAgentCommand("stpo")).toMatchObject({
      kind: "refuse",
      text: expect.stringContaining('did you mean "stop"?'),
    });
  });
});

describe("the window's keys in normal mode (Behaviour 14)", () => {
  test("move, return to the input, and the window's commands", () => {
    const k = (/** @type {string} */ key, pending = "") => chatKey(pending, key);
    expect(k("j")).toEqual({ kind: "do", what: "down" });
    expect(k("k")).toEqual({ kind: "do", what: "up" });
    expect(k("ctrl+d")).toEqual({ kind: "do", what: "half-down" });
    expect(k("ctrl+u")).toEqual({ kind: "do", what: "half-up" });
    expect(k("g")).toEqual({ kind: "pending", pending: "g" });
    expect(k("g", "g")).toEqual({ kind: "do", what: "top" });
    expect(k("x", "g")).toEqual({ kind: "none" });
    expect(k("G")).toEqual({ kind: "do", what: "bottom" });
    expect(k("shift+g")).toEqual({ kind: "do", what: "bottom" });
    for (const [key, what] of [
      ["i", "insert"],
      ["a", "insert"],
      ["s", "stop"],
      ["m", "model"],
      ["n", "new"],
      ["c", "list"],
      ["C", "clear"],
      ["P", "give"],
      ["y", "yank"],
      ["q", "close"],
    ])
      expect(k(key)).toEqual({ kind: "do", what });
    expect(k("z")).toEqual({ kind: "none" });
    expect(k("esc")).toEqual({ kind: "none" });
  });
});
