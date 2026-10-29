// docs/specs/builtin-agent.md B15, Behaviour 19-23: what a stored conversation holds (the
// user's messages, the agent's replies and Vimma's task summaries, never tool output), what a
// reopened conversation sends the model, and when `keep_days` deletes one.
import { describe, expect, test } from "vitest";
import {
  MAX_RECORD_BYTES,
  STORE_VERSION,
  expired,
  hostsOf,
  lastUseText,
  modelMessages,
  readRecord,
  restoredEntries,
  stoppedAtCheckpoint,
  storedRecord,
  taskSummary,
} from "../src/agent-store.mjs";

const provider = {
  name: "ollama",
  kind: "openai",
  endpoint: "http://127.0.0.1:11434/v1",
  model: "qwen3:14b",
  vision: false,
};

const conversation = {
  uid: "0b5c3c1e-8a9f-4f63-9b7d-2c1a5e4f6a70",
  title: "Weekly groceries",
  created: 1_700_000_000_000,
  used: 1_700_000_500_000,
  provider,
  stored: [
    { kind: "user", text: "buy milk" },
    { kind: "agent", text: "I'll open the shop." },
    { kind: "summary", text: "task done · 4 steps · 12k tokens · hosts: shop.example" },
  ],
};

describe("storedRecord", () => {
  test("a stored conversation holds messages, replies and summaries, never tool output", () => {
    const record = storedRecord({
      ...conversation,
      // What a conversation holds in memory besides: none of it is stored.
      messages: [{ role: "tool", results: [{ content: [{ type: "text", text: "PAGE TEXT" }] }] }],
      transcript: { entries: [{ kind: "step", text: 'clicked button "Buy"' }] },
      state: { agent: { client: "built-in" } },
      stored: [...conversation.stored, { kind: "step", text: "clicked" }],
    });
    expect(record).toEqual({
      v: STORE_VERSION,
      id: conversation.uid,
      title: "Weekly groceries",
      created: conversation.created,
      used: conversation.used,
      provider,
      entries: conversation.stored,
    });
    expect(JSON.stringify(record)).not.toContain("PAGE TEXT");
    expect(JSON.stringify(record)).not.toContain("clicked");
  });

  test("the provider keeps its prices and never a key", () => {
    const record = storedRecord({
      ...conversation,
      provider: { ...provider, priceIn: 3, priceOut: 15, key: "sk-secret", apiKey: "sk-secret" },
    });
    expect(record.provider).toEqual({ ...provider, priceIn: 3, priceOut: 15 });
    expect(JSON.stringify(record)).not.toContain("sk-secret");
  });
});

describe("storedRecord's size", () => {
  test("a long conversation keeps its newest entries within MAX_RECORD_BYTES", () => {
    const big = "é".repeat(50_000);
    const stored = Array.from({ length: 20 }, (_, i) => ({ kind: "user", text: `${i} ${big}` }));
    const record = storedRecord({ ...conversation, stored });
    const bytes = new TextEncoder().encode(JSON.stringify(record)).length;
    expect(bytes).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    expect(record.entries.length).toBeGreaterThan(0);
    expect(record.entries.at(-1)?.text.startsWith("19 ")).toBe(true);
    expect(record.entries[0]?.text.startsWith("0 ")).toBe(false);
  });
});

describe("readRecord", () => {
  test("reads what storedRecord wrote", () => {
    const record = storedRecord(conversation);
    expect(readRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  test("refuses another version, a bad provider or an unknown entry", () => {
    const record = storedRecord(conversation);
    expect(readRecord({ ...record, v: STORE_VERSION + 1 })).toBeNull();
    expect(readRecord({ ...record, provider: { ...provider, kind: "shell" } })).toBeNull();
    expect(readRecord({ ...record, provider: { ...provider, endpoint: "not a url" } })).toBeNull();
    expect(readRecord({ ...record, entries: [{ kind: "tool", text: "x" }] })).toBeNull();
    expect(readRecord({ ...record, entries: [{ kind: "user", text: 4 }] })).toBeNull();
    expect(readRecord({ ...record, id: "../../etc/passwd" })).toBeNull();
    expect(readRecord(null)).toBeNull();
    expect(readRecord("text")).toBeNull();
  });

  test("drops fields it does not know", () => {
    const record = storedRecord(conversation);
    const read = readRecord({ ...record, extra: 1, provider: { ...provider, key: "k" } });
    expect(read).toEqual(record);
  });
});

describe("modelMessages", () => {
  test("a reopened conversation sends messages, replies and summaries only", () => {
    expect(modelMessages(conversation.stored)).toEqual([
      { role: "user", text: "buy milk" },
      { role: "assistant", text: "I'll open the shop.", toolCalls: [] },
      {
        role: "user",
        text: "(Vimma: an earlier task: task done · 4 steps · 12k tokens · hosts: shop.example)",
      },
    ]);
  });
});

describe("restoredEntries", () => {
  test("a reopened conversation's transcript shows its messages, replies and summaries", () => {
    expect(restoredEntries(conversation.stored)).toEqual([
      { kind: "user", text: "buy milk" },
      { kind: "agent", text: "I'll open the shop." },
      { kind: "notice", text: "task done · 4 steps · 12k tokens · hosts: shop.example" },
    ]);
  });
});

describe("taskSummary", () => {
  test("a task summary names outcome, counts and hosts, and no page text", () => {
    expect(
      taskSummary({
        outcome: "done",
        checkpoint: false,
        steps: 14,
        tokens: 212_400,
        estimated: false,
        hosts: ["shop.example", "cdn.shop.example"],
      }),
    ).toBe("task done · 14 steps · 212k tokens · hosts: shop.example, cdn.shop.example");
    expect(
      taskSummary({
        outcome: "budget",
        checkpoint: false,
        steps: 60,
        tokens: 900,
        estimated: true,
        hosts: [],
      }),
    ).toBe("task stopped at its budget · 60 steps · ~900 tokens · no pages loaded");
    expect(
      taskSummary({
        outcome: "done",
        checkpoint: true,
        steps: 1,
        tokens: 1000,
        estimated: false,
        hosts: ["shop.example"],
      }),
    ).toBe("task stopped at a checkpoint · 1 step · 1k tokens · hosts: shop.example");
    expect(
      taskSummary({ outcome: "stopped", checkpoint: false, steps: 2, tokens: 0, hosts: [] }),
    ).toMatch(/^task stopped · 2 steps/);
    expect(
      taskSummary({ outcome: "error", checkpoint: false, steps: 2, tokens: 0, hosts: [] }),
    ).toMatch(/^task failed · 2 steps/);
  });

  test("many hosts are cut", () => {
    const hosts = Array.from({ length: 14 }, (_, i) => `h${i}.example`);
    const text = taskSummary({ outcome: "done", checkpoint: false, steps: 1, tokens: 1, hosts });
    expect(text).toContain("h9.example");
    expect(text).not.toContain("h10.example");
    expect(text).toMatch(/and 4 more$/);
  });
});

describe("hostsOf", () => {
  test("http and https hosts only, once each, in order", () => {
    expect(
      hostsOf([
        "https://shop.example/a?q=secret",
        "https://shop.example/b",
        "http://127.0.0.1:8080/x",
        "about:blank",
        "javascript:alert(1)",
        "not a url",
        undefined,
        "https://xn--mnchen-3ya.example/",
      ]),
    ).toEqual(["shop.example", "127.0.0.1:8080", "xn--mnchen-3ya.example"]);
  });
});

describe("stoppedAtCheckpoint", () => {
  test("the task's last step was a checkpoint not answered yes", () => {
    const no = { kind: "checkpoint", text: "▲ asked to pay", outcome: "→ you said no" };
    const yes = { kind: "checkpoint", text: "▲ asked to pay", outcome: "→ you said yes" };
    const step = { kind: "step", text: "clicked", outcome: "ran under grant" };
    const reply = { kind: "agent", text: "I stopped." };
    expect(stoppedAtCheckpoint([step, no, reply])).toBe(true);
    expect(stoppedAtCheckpoint([{ ...no, outcome: "→ no answer, stopped" }, reply])).toBe(true);
    expect(stoppedAtCheckpoint([step, yes, reply])).toBe(false);
    expect(stoppedAtCheckpoint([no, step])).toBe(false);
    expect(stoppedAtCheckpoint([reply])).toBe(false);
  });
});

describe("expired", () => {
  const day = 86_400_000;
  test("only with keep_days, and only when unused for longer", () => {
    expect(expired(0, 100 * day, null)).toBe(false);
    expect(expired(0, 30 * day, 30)).toBe(false);
    expect(expired(0, 30 * day + 1, 30)).toBe(true);
  });
});

describe("lastUseText", () => {
  const now = Date.UTC(2026, 9, 29, 12, 0);
  test("how long ago a conversation was used", () => {
    expect(lastUseText(now - 20_000, now)).toBe("just now");
    expect(lastUseText(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(lastUseText(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(lastUseText(now - 2 * 86_400_000, now)).toBe("2 days ago");
    expect(lastUseText(now - 86_400_000, now)).toBe("1 day ago");
  });
});
