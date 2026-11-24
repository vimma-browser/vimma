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
} from "../src/agent/agent-store.mjs";
import type { StoredEntry } from "../src/agent/agent-store.mjs";

const provider = {
  name: "ollama",
  kind: "openai",
  endpoint: "http://127.0.0.1:11434/v1",
  model: "qwen3:14b",
  vision: false,
};

const stored: StoredEntry[] = [
  { kind: "user", text: "buy milk" },
  { kind: "agent", text: "I'll open the shop." },
  { kind: "summary", text: "task done · 4 steps · 12k tokens · hosts: shop.example" },
];
const conversation = {
  uid: "0b5c3c1e-8a9f-4f63-9b7d-2c1a5e4f6a70",
  title: "Weekly groceries",
  created: 1_700_000_000_000,
  used: 1_700_000_500_000,
  provider,
  stored,
};

describe("storedRecord", () => {
  test("a stored conversation holds messages, replies and summaries, never tool output", () => {
    const inMemory = {
      ...conversation,
      // What a conversation holds in memory besides: none of it is stored.
      messages: [{ role: "tool", results: [{ content: [{ type: "text", text: "PAGE TEXT" }] }] }],
      transcript: { entries: [{ kind: "step", text: 'clicked button "Buy"' }] },
      state: { agent: { client: "built-in" } },
      stored: [...conversation.stored, { kind: "step", text: "clicked" }],
    };
    const record = storedRecord(inMemory);
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

  // docs/specs/builtin-agent-cli.md C4: a CLI provider is stored by its name, the CLI it is and
  // its model; never a path, an argument or an environment.
  test("an agent CLI provider is stored by name, cli and model only", () => {
    const cli = {
      name: "claude",
      kind: "cli",
      cli: "claude-code",
      endpoint: "",
      model: "",
      vision: false,
      maxMinutes: 30,
      path: "/home/u/.local/bin/claude",
      env: { LD_PRELOAD: "x" },
    };
    const record = storedRecord({ ...conversation, provider: cli });
    expect(record.provider).toEqual({
      name: "claude",
      kind: "cli",
      cli: "claude-code",
      endpoint: "",
      model: "",
      vision: false,
    });
    expect(readRecord(JSON.parse(JSON.stringify(record)))?.provider).toEqual(record.provider);
    expect(() => storedRecord({ ...conversation, provider: { ...cli, cli: "evil" } })).toThrow();
  });
});

describe("the stored provider", () => {
  const read = (p: unknown) => readRecord({ ...storedRecord(conversation), provider: p });

  test("an Anthropic provider and its vision are kept", () => {
    const claude = {
      name: "claude",
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      model: "claude-x",
      vision: true,
    };
    expect(storedRecord({ ...conversation, provider: claude }).provider).toEqual(claude);
    expect(read({ ...claude, vision: "yes" })?.provider.vision).toBe(false);
  });

  test("a provider out of shape is not stored, nor read back", () => {
    for (const p of [
      null,
      "ollama",
      { ...provider, name: "" },
      { ...provider, name: 5 },
      { ...provider, model: "" },
      { ...provider, model: 5 },
      { ...provider, endpoint: ["http://127.0.0.1:11434/v1"] },
      { ...provider, endpoint: "file:///home/u/model" },
      { ...provider, endpoint: "javascript:alert(1)" },
      { name: "claude", kind: "cli", cli: "claude-code", endpoint: "", model: 5 },
      { name: "", kind: "cli", cli: "claude-code", endpoint: "", model: "" },
      { name: 5, kind: "cli", cli: "claude-code", endpoint: "", model: "" },
    ]) {
      expect(read(p), JSON.stringify(p)).toBeNull();
      expect(() => storedRecord({ ...conversation, provider: p })).toThrow(
        "the conversation's provider cannot be stored",
      );
    }
  });

  test("prices are kept only as two numbers of zero or more", () => {
    const priced = (priceIn: unknown, priceOut: unknown) =>
      read({ ...provider, priceIn, priceOut })?.provider;
    expect(priced(0, 0)).toEqual({ ...provider, priceIn: 0, priceOut: 0 });
    for (const [a, b] of [
      [3, undefined],
      [undefined, 15],
      [-1, 15],
      [3, Number.POSITIVE_INFINITY],
      [Number.NaN, 15],
      ["3", 15],
    ]) {
      expect(priced(a, b), `${a} ${b}`).toEqual(provider);
    }
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

describe("storedRecord's size, at the limit", () => {
  const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
  // Three entries whose record is `extra` bytes over MAX_RECORD_BYTES, given the first entry.
  const over = (first: StoredEntry, extra: number) => {
    const rest = [
      { kind: "user", text: "b" },
      { kind: "agent", text: "" },
    ] as StoredEntry[];
    const now = bytes(storedRecord({ ...conversation, stored: [first, ...rest] }));
    rest[1] = { kind: "agent", text: "c".repeat(MAX_RECORD_BYTES + extra - now) };
    return [first, ...rest];
  };

  test("a record of exactly MAX_RECORD_BYTES keeps every entry", () => {
    const stored = over({ kind: "user", text: "a" }, 0);
    const record = storedRecord({ ...conversation, stored });
    expect(bytes(record)).toBe(MAX_RECORD_BYTES);
    expect(record.entries).toEqual(stored);
  });

  test("dropping the oldest entry and its comma is enough when that fits", () => {
    const first = { kind: "user", text: "a" } as StoredEntry;
    const stored = over(first, bytes(first) + 1);
    const record = storedRecord({ ...conversation, stored });
    expect(record.entries).toEqual(stored.slice(1));
    expect(bytes(record)).toBe(MAX_RECORD_BYTES);
  });

  test("a single entry is cut to fit exactly, its start kept", () => {
    const stored = [{ kind: "user", text: `start ${"x".repeat(MAX_RECORD_BYTES)}` }];
    const record = storedRecord({ ...conversation, stored });
    expect(bytes(record)).toBe(MAX_RECORD_BYTES);
    expect(record.entries[0]?.text.startsWith("start xxx")).toBe(true);
  });

  test("a conversation without entries is stored", () => {
    expect(storedRecord({ ...conversation, stored: [] }).entries).toEqual([]);
  });
});

describe("storedRecord's size, one entry", () => {
  test("a single entry over MAX_RECORD_BYTES is cut", () => {
    const stored = [{ kind: "user", text: "x".repeat(MAX_RECORD_BYTES + 10) }];
    const record = storedRecord({ ...conversation, stored });
    const bytes = new TextEncoder().encode(JSON.stringify(record)).length;
    expect(bytes).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    expect(record.entries[0]?.text.startsWith("xxx")).toBe(true);
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

  test("refuses an id, a title, a time or an entry list out of shape", () => {
    const record = storedRecord(conversation);
    for (const bad of [
      { id: [conversation.uid] },
      { id: 5 },
      { title: 5 },
      { created: -1 },
      { created: "5" },
      { created: Number.POSITIVE_INFINITY },
      { used: -1 },
      { used: "5" },
      { used: Number.POSITIVE_INFINITY },
      { provider: null },
      { entries: "buy milk" },
      {
        entries: [
          { kind: "user", text: "ok" },
          { kind: "step", text: "clicked" },
        ],
      },
    ]) {
      expect(readRecord({ ...record, ...bad }), JSON.stringify(bad)).toBeNull();
    }
    expect(readRecord({ ...record, created: 0, used: 0 })).toMatchObject({ created: 0, used: 0 });
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

  test("millions of tokens, and an outcome it does not know", () => {
    const summary = (tokens: number, outcome = "done") =>
      taskSummary({ outcome, checkpoint: false, steps: 2, tokens, hosts: [] });
    expect(summary(999_499)).toBe("task done · 2 steps · 999k tokens · no pages loaded");
    expect(summary(999_500)).toBe("task done · 2 steps · 1M tokens · no pages loaded");
    expect(summary(999_999)).toBe("task done · 2 steps · 1M tokens · no pages loaded");
    expect(summary(1_000_000)).toBe("task done · 2 steps · 1M tokens · no pages loaded");
    expect(summary(999)).toBe("task done · 2 steps · 999 tokens · no pages loaded");
    expect(summary(1_499)).toBe("task done · 2 steps · 1k tokens · no pages loaded");
    expect(summary(1_500)).toBe("task done · 2 steps · 2k tokens · no pages loaded");
    expect(summary(1_049_999)).toBe("task done · 2 steps · 1M tokens · no pages loaded");
    expect(summary(1_050_000)).toBe("task done · 2 steps · 1.1M tokens · no pages loaded");
    expect(summary(9_999_999)).toBe("task done · 2 steps · 10M tokens · no pages loaded");
    expect(summary(2_540_000)).toBe("task done · 2 steps · 2.5M tokens · no pages loaded");
    expect(summary(10, "exploded")).toBe("task failed · 2 steps · 10 tokens · no pages loaded");
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
        "ftp://files.example/",
        "file:///etc/passwd",
        ["https://array.example/"],
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
    expect(expired(10 * day, 40 * day, 30)).toBe(false);
    expect(expired(10 * day, 40 * day + 1, 30)).toBe(true);
  });
});

describe("lastUseText", () => {
  const now = Date.UTC(2026, 9, 29, 12, 0);
  test("how long ago a conversation was used", () => {
    expect(lastUseText(now - 20_000, now)).toBe("just now");
    expect(lastUseText(now - 59_999, now)).toBe("just now");
    expect(lastUseText(now - 60_000, now)).toBe("1 min ago");
    expect(lastUseText(now - 3_600_000, now)).toBe("1 h ago");
    expect(lastUseText(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(lastUseText(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(lastUseText(now - 2 * 86_400_000, now)).toBe("2 days ago");
    expect(lastUseText(now - 86_400_000, now)).toBe("1 day ago");
  });
});

// Issue #1119: the edges the weekly mutation run left unpinned.
describe("storedRecord at its edges", () => {
  test("an entry that is not a plain object is dropped, even a function with the fields", () => {
    const fn = Object.assign(() => {}, { kind: "user", text: "from a function" });
    expect(storedRecord({ ...conversation, stored: [fn, ...stored] }).entries).toEqual(stored);
  });

  test("a record too long without any entry is stored as it is", () => {
    const title = "t".repeat(MAX_RECORD_BYTES);
    const record = storedRecord({ ...conversation, title, stored: [] });
    expect(record.title).toBe(title);
    expect(record.entries).toEqual([]);
  });

  test("one cut fits an entry whose characters JSON escapes into several bytes", () => {
    const text = `${"x".repeat(MAX_RECORD_BYTES - 2000)}${"\u0001é\u{1F95B}".repeat(1000)}`;
    const record = storedRecord({ ...conversation, stored: [{ kind: "user", text }] });
    const bytes = new TextEncoder().encode(JSON.stringify(record)).length;
    expect(bytes).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    expect(record.entries[0]?.text.startsWith("xxx")).toBe(true);
  });
});
