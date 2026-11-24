import { describe, test, expect, vi } from "vitest";
import {
  GREP_CAPS,
  GREP_SCOPE_NAMES,
  closedPreview,
  fitAround,
  grepClosed,
  grepCountText,
  grepListText,
  grepPickerKey,
  grepRows,
  grepHost,
  grepScopeText,
  grepText,
  holdReplies,
  openGrepPicker,
  parseGrepReply,
  parsePreviewReply,
  parseQuery,
  previewLines,
  pruneGrepList,
  setGrepRows,
  stepGrepList,
} from "../src/ui/grep.mjs";
import { BLOCK } from "../src/page/motions.mjs";

import type {
  GrepClosedEntry,
  GrepList,
  GrepPickerState,
  GrepRow,
  GrepTab,
} from "../src/ui/grep.mjs";

/**
 * The characters `run`'s regular expressions read: for each exec, from where it starts (lastIndex
 * for a global or sticky one) to the end of its match, or to the end of the text without one. A
 * failed sticky or `^`-anchored exec counts as reading to the end, though the engine stops at once.
 * It cannot see backtracking within a match attempt, nor time: timing belongs in tools/bench.
 */
const charsRead = (run: () => void) => {
  const exec = RegExp.prototype.exec;
  let read = 0;
  const spy = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (
    this: RegExp,
    s: string,
  ) {
    const from = this.global || this.sticky ? this.lastIndex : 0;
    const m = exec.call(this, s);
    read += (m ? m.index + m[0].length : s.length) - from;
    return m;
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return read;
};

const must = (q: string) => {
  const parsed = parseQuery(q);
  if (!parsed) throw new Error(`no query for ${q}`);
  return parsed;
};

describe("parseQuery: ripgrep's smart case", () => {
  test.each([
    ["foo", false],
    ["Foo", true],
    ["a\\w", false],
    ["\\w+Error", true],
    ["\\bretry\\b", false],
    ["[A-Z]x", true],
    ["\\.", false],
    ["\\p{Lu}x", false],
    ["(?<Name>x)", false],
    ["x{2,3}", false],
  ])("%s matches case: %s", (q, caseSensitive) => {
    const parsed = must(q);
    expect(parsed.caseSensitive).toBe(caseSensitive);
    expect(parsed.literal).toBe(false);
  });

  test("a query with no literal (\\w+) matches case, as ripgrep does", () => {
    expect(must("\\w+").caseSensitive).toBe(true);
    expect(must("\\d\\s").caseSensitive).toBe(true);
  });

  test("case is applied to the expression", () => {
    expect(must("needle").regex.test("A NEEDLE")).toBe(true);
    expect(must("Needle").regex.test("a needle")).toBe(false);
    expect(must("nee+dle").regex.test("neeeedle")).toBe(true);
  });

  test("an invalid expression is matched literally and flagged", () => {
    const q = must("c++(");
    expect(q.literal).toBe(true);
    expect(q.regex.test("in c++(x)")).toBe(true);
    expect(q.regex.test("in c(x)")).toBe(false);
    expect(must("what?(").literal).toBe(true);
    expect(must("Lit(").caseSensitive).toBe(true);
    expect(must("lit(").caseSensitive).toBe(false);
  });

  test("an empty query gives none", () => {
    expect(parseQuery("")).toBeNull();
  });
});

describe("grepText", () => {
  const text = ["alpha needle one", "beta", "gamma needle two needle"].join(BLOCK);

  test("matches per line, with start, end, line and ordinal", () => {
    const { matches, count } = grepText(text, must("needle"));
    expect(count).toBe(3);
    expect(matches.map((m) => [m.line, m.ordinal, text.slice(m.start, m.end)])).toEqual([
      [1, 0, "needle"],
      [3, 1, "needle"],
      [3, 2, "needle"],
    ]);
    const first = matches[0];
    if (!first) throw new Error("no match");
    expect(first.context).toBe("alpha needle one");
    expect(first.context.slice(first.at[0], first.at[1])).toBe("needle");
  });

  test("lines split at BLOCK, line breaks and carriage returns", () => {
    const { matches } = grepText(`a x${BLOCK}b x\nc x\rd x`, must("x"));
    expect(matches.map((m) => m.line)).toEqual([1, 2, 3, 4]);
  });

  test("blank lines (white space only) are not lines: not numbered, never matched", () => {
    const { matches } = grepText(`  ${BLOCK}a x${BLOCK} \t ${BLOCK}b x`, must("x"));
    expect(matches.map((m) => m.line)).toEqual([1, 2]);
    expect(grepText(`  ${BLOCK}a`, must(" ")).count).toBe(0);
  });

  test("a match never spans two lines", () => {
    expect(grepText(`one${BLOCK}two`, must("one.two")).count).toBe(0);
    expect(grepText("one\ntwo", must("one\\s+two")).count).toBe(0);
  });

  test("the context is cut to 160 characters, at most 60 before the match", () => {
    const line = `${"a".repeat(300)}needle${"b".repeat(300)}`;
    const [m] = grepText(line, must("needle")).matches;
    if (!m) throw new Error("no match");
    expect(m.context.startsWith("…")).toBe(true);
    expect(m.context.endsWith("…")).toBe(true);
    expect(m.context.length).toBeLessThanOrEqual(GREP_CAPS.context + 2);
    expect(m.context.slice(m.at[0], m.at[1])).toBe("needle");
    expect(m.at[0]).toBe(61);
  });

  test("a frame lists 100 matches and counts to 1,000", () => {
    const many = Array.from({ length: 1500 }, () => "x").join(BLOCK);
    const { matches, count } = grepText(many, must("x"));
    expect(matches).toHaveLength(GREP_CAPS.listed);
    expect(count).toBe(GREP_CAPS.counted);
  });

  test("zero-length matches do not loop and are not listed", () => {
    expect(grepText("abc def", must("^")).count).toBe(0);
    expect(grepText("abc def", must("\\b")).count).toBe(0);
    const { matches } = grepText("aaa b", must("a*"));
    expect(matches.map((m) => [m.start, m.end])).toEqual([[0, 3]]);
  });

  test("a surrogate pair is stepped over whole after an empty match", () => {
    expect(() => grepText("😀😀", must("x*"))).not.toThrow();
  });

  // The spec's budget (1,000,000 characters under 50 ms) is pinned by the work grepText does, not
  // by timing it: a wall-clock budget in the unit suite measures the runner, and failed on loaded
  // ones (issue #1144). The characters its regular expressions read are the same on any machine,
  // and per character the same for any length, so 100,000 show what 1,000,000 would, and a
  // quadratic change fails here in seconds instead of running for minutes.
  test("100,000 characters: each character is read twice", () => {
    const line = "the quick brown fox jumps over the lazy dog ";
    const lines = Math.ceil(1e5 / (line.length + 1));
    const big = Array.from({ length: lines }, () => line).join(BLOCK);
    let result: ReturnType<typeof grepText> | undefined;
    const read = charsRead(() => {
      result = grepText(big, must("lazy cat"));
    });
    expect(result?.count).toBe(0);
    // Once to find its line's end and once by the query, and the blank check stops at a line's
    // first character. A second pass over a line, or a line read again from the text's start
    // (quadratic), reads more. The floor only shows the spy saw the work.
    expect(read).toBeGreaterThanOrEqual(big.length);
    expect(read).toBeLessThanOrEqual(2 * big.length + lines);
  });
});

describe("fitAround: a row or preview line fitted to its width, the match in view", () => {
  const line = `Paragraph 7 lorem ipsum dolor sit amet consectetur adipiscing needle7 tail ${"x".repeat(200)}`;
  const s = line.indexOf("needle7");
  const at: [number, number] = [s, s + "needle7".length];

  test("a line that fits is left as it is", () => {
    expect(fitAround("a needle b", [2, 8], 20, 16)).toEqual({ text: "a needle b", at: [2, 8] });
  });

  test("a long line keeps the match and a third of the width before it, within the width", () => {
    const {
      text,
      at: [a, b],
    } = fitAround(line, at, 30, 16);
    expect(text.length).toBeLessThanOrEqual(30);
    expect(text.slice(a, b)).toBe("needle7");
    expect(text.startsWith("…")).toBe(true);
    expect(text.endsWith("…")).toBe(true);
    // A third of the width, the ellipsis included, comes before the match.
    expect(a).toBe(Math.floor((30 - 2) / 3) + 1);
    expect(text.slice(1, a)).toBe(line.slice(s - (a - 1), s));
  });

  test("before caps the context before the match in a wide box", () => {
    const {
      text,
      at: [a, b],
    } = fitAround(line, at, 120, 16);
    expect(a).toBe(17);
    expect(text.slice(a, b)).toBe("needle7");
    expect(text.length).toBeLessThanOrEqual(120);
  });

  test("a match near the end fills the box with more context before it", () => {
    const end = `${"w".repeat(100)} needle`;
    const {
      text,
      at: [a, b],
    } = fitAround(end, [101, 107], 30, 16);
    expect(text).toBe(`…${"w".repeat(21)} needle`);
    expect(text.slice(a, b)).toBe("needle");
  });

  test("a match near the start keeps the line's start, with no ellipsis there", () => {
    const {
      text,
      at: [a, b],
    } = fitAround(`ab needle ${"y".repeat(60)}`, [3, 9], 20, 16);
    expect(text.startsWith("ab needle")).toBe(true);
    expect([a, b]).toEqual([3, 9]);
    expect(text.length).toBeLessThanOrEqual(20);
  });

  test("a match longer than the width shows its start", () => {
    const long = `${"z".repeat(50)}${"m".repeat(40)}${"z".repeat(50)}`;
    const {
      text,
      at: [a, b],
    } = fitAround(long, [50, 90], 12, 16);
    expect(text.length).toBeLessThanOrEqual(12);
    expect(text.slice(a, b)).toMatch(/^m+$/);
    expect(b - a).toBeGreaterThan(0);
  });

  test("a tiny or empty width still shows some of the match", () => {
    const {
      text,
      at: [a, b],
    } = fitAround(line, at, 0, 16);
    expect(b).toBeGreaterThan(a);
    expect(text.slice(a, b)).toBe("ne");
  });

  test("a match that starts with a surrogate pair is never marked empty, however narrow", () => {
    const emoji = `${"x".repeat(40)}😀needle${"x".repeat(40)}`;
    const {
      text,
      at: [a, b],
    } = fitAround(emoji, [40, 48], 1, 16);
    expect(text.slice(a, b)).toBe("😀");
  });

  test("a surrogate pair is never split", () => {
    const emoji = `${"😀".repeat(40)}needle${"😀".repeat(40)}`;
    const i = emoji.indexOf("needle");
    const {
      text,
      at: [a, b],
    } = fitAround(emoji, [i, i + 6], 21, 16);
    expect(text.slice(a, b)).toBe("needle");
    expect(text).not.toMatch(/^…?[\udc00-\udfff]/u);
    expect(/[\ud800-\udbff]…?$/u.test(text)).toBe(false);
  });
});

describe("previewLines", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const text = lines.join(BLOCK);

  test("ten lines each side, the matched line and the match in it", () => {
    const start = text.indexOf("line 15");
    const p = previewLines(text, start, start + 7);
    expect(p.first).toBe(5);
    expect(p.lines).toHaveLength(21);
    expect(p.lines[p.line]).toBe("line 15");
    expect(p.at).toEqual([0, 7]);
  });

  test("blank lines are left out of the preview", () => {
    const spaced = lines.flatMap((l) => [l, "   "]).join(BLOCK);
    const start = spaced.indexOf("line 15");
    const p = previewLines(spaced, start, start + 7);
    expect(p.first).toBe(5);
    expect(p.lines).toHaveLength(21);
    expect(p.lines[p.line]).toBe("line 15");
    expect(p.lines[0]).toBe("line 5");
  });

  test("fewer lines at the start and the end", () => {
    const p = previewLines(text, 0, 6);
    expect(p.first).toBe(1);
    expect(p.line).toBe(0);
    expect(p.lines).toHaveLength(11);
    const end = previewLines(text, text.indexOf("line 30"), text.length);
    expect(end.lines).toHaveLength(11);
    expect(end.line).toBe(10);
  });
});

describe("parseGrepReply: a content process's reply, checked", () => {
  const good = {
    gen: 3,
    count: 1,
    matches: [{ start: 0, end: 3, line: 1, ordinal: 0, context: "abc", at: [0, 3] }],
  };

  test("a good reply is copied", () => {
    const r = parseGrepReply(good);
    expect(r).toEqual(good);
    expect(r).not.toBe(good);
  });

  test.each([
    null,
    "x",
    { ...good, gen: -1 },
    { ...good, count: "1" },
    { ...good, matches: "x" },
    { ...good, matches: [{ ...good.matches[0], start: 1.5 }] },
    { ...good, matches: [{ ...good.matches[0], context: 3 }] },
    { ...good, matches: [{ ...good.matches[0], at: [3, 1] }] },
  ])("drops %j", (raw) => {
    expect(parseGrepReply(raw)).toBeNull();
  });

  test("cuts overlong contexts and too many matches", () => {
    const m = { ...good.matches[0], context: "x".repeat(10000), at: [0, 9000] };
    const r = parseGrepReply({ ...good, count: 5000, matches: Array(500).fill(m) });
    expect(r?.matches).toHaveLength(GREP_CAPS.listed);
    expect(r?.matches[0]?.context.length).toBeLessThanOrEqual(GREP_CAPS.context + 2);
    expect(r?.matches[0]?.at[1]).toBeLessThanOrEqual(GREP_CAPS.context + 2);
    expect(r?.count).toBe(GREP_CAPS.counted);
  });

  test("a reply's timedOut and cut flags are kept as booleans", () => {
    expect(parseGrepReply({ ...good, timedOut: true, cut: true })).toMatchObject({
      timedOut: true,
      cut: true,
    });
    expect(parseGrepReply({ ...good, timedOut: "yes" })).toBeNull();
    expect(parseGrepReply(good)).not.toHaveProperty("timedOut");
  });

  test("parsePreviewReply clips the match to its line", () => {
    const r = parsePreviewReply({ first: 1, line: 0, at: [2, 900], lines: ["abcd"] });
    expect(r?.at).toEqual([2, 4]);
    const past = parsePreviewReply({ first: 1, line: 0, at: [10, 20], lines: ["abcd"] });
    expect(past?.at).toEqual([4, 4]);
  });

  test("parsePreviewReply checks and cuts the preview", () => {
    const ok = { first: 1, line: 0, at: [0, 1], lines: ["a", "b"] };
    expect(parsePreviewReply(ok)).toEqual(ok);
    expect(parsePreviewReply({ ...ok, line: 5 })).toBeNull();
    expect(parsePreviewReply({ ...ok, lines: [1] })).toBeNull();
    const long = parsePreviewReply({ ...ok, lines: Array(100).fill("y".repeat(5000)) });
    expect(long?.lines.length).toBeLessThanOrEqual(2 * GREP_CAPS.previewLines + 1);
    expect(long?.lines[0]?.length).toBeLessThanOrEqual(GREP_CAPS.previewWidth + 2);
  });
});

const tab = (tabId: string, index: number, extra: Partial<GrepTab> = {}): GrepTab => ({
  tabId,
  index,
  title: `Tab ${tabId}`,
  host: `${tabId}.test`,
  workspace: "work",
  agent: false,
  loaded: true,
  window: 1,
  ...extra,
});

const reply = (n: number, ctx: string = "a needle") => ({
  count: n,
  matches: Array.from({ length: n }, (_, i) => ({
    start: i * 10,
    end: i * 10 + 6,
    line: i + 1,
    ordinal: i,
    context: ctx,
    at: [2, 8] as [number, number],
  })),
});

describe("grepRows", () => {
  const tabs = [tab("a", 1), tab("b", 2), tab("c", 3)];

  test("rows in tab order whatever order replies arrived in", () => {
    const frames = new Map([
      ["c", [{ key: "0", host: null, reply: reply(1) }]],
      ["a", [{ key: "0", host: null, reply: reply(2) }]],
    ]);
    const { rows, count, tabsWithMatches } = grepRows(tabs, frames);
    expect(rows.map((r) => [r.tabId, r.kind === "match" ? r.ordinal : -1])).toEqual([
      ["a", 0],
      ["a", 1],
      ["c", 0],
    ]);
    expect(count).toBe(3);
    expect(tabsWithMatches).toBe(2);
  });

  test("frames in their order; a frame from another site carries its host", () => {
    const frames = new Map([
      [
        "a",
        [
          { key: "0", host: null, reply: reply(1) },
          { key: "1", host: "other.test", reply: reply(1) },
        ],
      ],
    ]);
    const { rows } = grepRows(tabs, frames);
    expect(rows.map((r) => (r.kind === "match" ? r.frameHost : "x"))).toEqual([null, "other.test"]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });

  test("the agent workspace's rows last, not-loaded tabs at the far end", () => {
    const all = [tab("ag", 1, { agent: true }), tab("lazy", 2, { loaded: false }), tab("a", 3)];
    const frames = new Map([
      ["ag", [{ key: "0", host: null, reply: reply(1) }]],
      ["a", [{ key: "0", host: null, reply: reply(1) }]],
    ]);
    const { rows } = grepRows(all, frames);
    expect(rows.map((r) => `${r.kind}:${r.tabId}`)).toEqual([
      "match:a",
      "match:ag",
      "unloaded:lazy",
    ]);
  });

  test("rows carry their tab's window mark and host", () => {
    const two = [tab("a", 1), tab("w", 1, { window: 2, workspace: "home" })];
    const frames = new Map([
      ["a", [{ key: "0", host: null, reply: reply(1) }]],
      ["w", [{ key: "0", host: null, reply: reply(1) }]],
    ]);
    const { rows } = grepRows(two, frames);
    expect(rows.map((r) => [r.window, r.host, r.workspace])).toEqual([
      [1, "a.test", "work"],
      [2, "w.test", "home"],
    ]);
  });

  test("closed rows come after the open tabs' matches and before not-loaded tabs", () => {
    const all = [tab("a", 1), tab("lazy", 2, { loaded: false })];
    const frames = new Map([["a", [{ key: "0", host: null, reply: reply(1) }]]]);
    const closed = grepClosed([closedTab(1, "Needle notes", "https://n.test/a")], must("needle"));
    const { rows, count, tabsWithMatches } = grepRows(all, frames, GREP_CAPS, closed);
    expect(rows.map((r) => `${r.kind}:${r.tabId}`)).toEqual([
      "match:a",
      "closed:closed:1",
      "unloaded:lazy",
    ]);
    expect(count).toBe(2);
    expect(tabsWithMatches).toBe(2);
  });

  test("at most 2,000 rows", () => {
    const many = Array.from({ length: 30 }, (_, i) => tab(`t${i}`, i + 1));
    const frames = new Map(
      many.map((t) => [t.tabId, [{ key: "0", host: null, reply: reply(100) }]]),
    );
    const { rows, count } = grepRows(many, frames);
    expect(rows).toHaveLength(GREP_CAPS.rows);
    expect(count).toBe(3000);
  });

  test("the count text", () => {
    expect(grepCountText(0, 0, 0)).toBe("no matches");
    expect(grepCountText(1, 1, 1)).toBe("1 match in 1 tab");
    expect(grepCountText(37, 37, 6)).toBe("37 matches in 6 tabs");
  });
});

function rowsOf(tabIds: string[]): GrepRow[] {
  const tabs = [...new Set(tabIds)].map((t, i) => tab(t, i + 1));
  const frames: Map<string, any[]> = new Map();
  for (const t of tabs) {
    const n = tabIds.filter((x) => x === t.tabId).length;
    frames.set(t.tabId, [{ key: "0", host: null, reply: reply(n, `in ${t.tabId}`) }]);
  }
  return grepRows(tabs, frames).rows;
}

describe("holdReplies: the parent keeps at most the rows it can list, best first", () => {
  const entry = (rank: number, n: number) => ({ rank, reply: reply(n) });
  const kept = (entries: { reply: { matches: unknown[] } }[]) =>
    entries.reduce((n, e) => n + e.reply.matches.length, 0);

  test("matches are kept until 2,000 are held; past that only counts", () => {
    const entries = Array.from({ length: 21 }, (_, i) => entry(i, 100));
    const held = holdReplies(entries);
    expect(kept(held)).toBe(GREP_CAPS.rows);
    expect(held.at(-1)?.reply.matches).toEqual([]);
    expect(held.at(-1)?.reply.count).toBe(100);
  });

  test("a better-ranked reply that arrives last still keeps its matches", () => {
    const late = [...Array.from({ length: 20 }, () => entry(9, 100)), entry(1, 100)];
    const held = holdReplies(late);
    expect(kept(held)).toBe(GREP_CAPS.rows);
    expect(held.at(-1)?.reply.matches).toHaveLength(100);
    expect(held.filter((e) => e.rank === 9 && e.reply.matches.length === 0)).toHaveLength(1);
  });

  test("the last reply that fits only in part is cut, so exactly 2,000 are held", () => {
    const held = holdReplies([entry(0, 1500), entry(1, 1000), entry(2, 10)]);
    expect(kept(held)).toBe(GREP_CAPS.rows);
    expect(held[1]?.reply.matches).toHaveLength(500);
    expect(held[1]?.reply.matches.map((m) => m.ordinal)).toEqual(
      Array.from({ length: 500 }, (_, i) => i),
    );
    expect(held[1]?.reply.count).toBe(1000);
    expect(held[2]?.reply.matches).toEqual([]);
  });

  test("under the cap nothing changes", () => {
    const entries = [entry(2, 10), entry(1, 10)];
    expect(holdReplies(entries)).toEqual(entries);
  });
});

describe("the grep list", () => {
  const rows = rowsOf(["a", "a", "b", "c"]);

  test("steps across tabs and wraps at both ends", () => {
    const alive = () => true;
    let list: GrepList = { query: "x", rows, index: 0 };
    const seen = [];
    for (let i = 0; i < 5; i++) {
      const next = stepGrepList(list, 1, alive);
      if (!next) throw new Error("no step");
      list = next;
      seen.push(list.index);
    }
    expect(seen).toEqual([1, 2, 3, 0, 1]);
    expect(stepGrepList({ ...list, index: 0 }, -1, alive)?.index).toBe(3);
  });

  test("skips results whose tab has closed; none left gives null", () => {
    const list = { query: "x", rows, index: 0 };
    expect(stepGrepList(list, 1, (id) => id !== "a")?.index).toBe(2);
    expect(stepGrepList(list, 1, () => false)).toBeNull();
  });

  test("the notice text", () => {
    expect(grepListText({ query: "x", rows, index: 2 })).toBe("grep 3/4");
  });

  test("[q after the current row's tab closed goes to the last row", () => {
    const pruned = pruneGrepList({ query: "x", rows, index: 1 }, (id) => id !== "a");
    if (!pruned) throw new Error("the list went");
    expect(stepGrepList(pruned, -1, () => true)?.index).toBe(1);
  });

  test("pruneGrepList drops a closed tab's rows and keeps its place", () => {
    const at = pruneGrepList({ query: "x", rows, index: 3 }, (id) => id !== "a");
    expect(at?.rows.map((r) => r.tabId)).toEqual(["b", "c"]);
    expect(at?.index).toBe(1);
    const onDead = pruneGrepList({ query: "x", rows, index: 1 }, (id) => id !== "a");
    expect(onDead?.index).toBe(-1);
    if (!onDead) throw new Error("the list went");
    expect(stepGrepList(onDead, 1, () => true)?.index).toBe(0);
    expect(pruneGrepList({ query: "x", rows, index: 0 }, () => false)).toBeNull();
  });
});

describe("grepPickerKey", () => {
  const rows = rowsOf(["a", "a", "b", "b", "c"]);
  const open = (extra: Partial<GrepPickerState> = {}) => ({
    ...setGrepRows(openGrepPicker("x"), rows),
    ...extra,
  });
  const press = (s: GrepPickerState, keys: string[]) => {
    let effect: ReturnType<typeof grepPickerKey>["effect"] = null;
    for (const k of keys) ({ state: s, effect } = grepPickerKey(s, k));
    return { state: s, effect };
  };

  test("opens in search mode with the query and the best result selected", () => {
    const s = open();
    expect(s.mode).toBe("search");
    expect(s.query).toBe("x");
    expect(s.selected).toBe(0);
    expect(s.scope).toBe("workspace");
  });

  test("down keys move toward the best result, up keys away from it", () => {
    expect(press(open(), ["up", "up", "ctrl+p"]).state.selected).toBe(3);
    expect(press(open(), ["up", "up", "ctrl+n"]).state.selected).toBe(1);
    expect(press(open(), ["down"]).state.selected).toBe(0);
    expect(press(open(), ["esc", "k", "k", "j"]).state.selected).toBe(1);
  });

  test("gg goes to the top (the last result), G to the best", () => {
    expect(press(open(), ["esc", "g", "g"]).state.selected).toBe(4);
    expect(press(open(), ["esc", "g", "g", "shift+g"]).state.selected).toBe(0);
  });

  test("Tab and shift+tab go to the next and previous tab's first result", () => {
    expect(press(open(), ["tab"]).state.selected).toBe(2);
    expect(press(open(), ["tab", "tab"]).state.selected).toBe(4);
    expect(press(open(), ["tab", "tab", "tab"]).state.selected).toBe(4);
    expect(press(open(), ["tab", "up", "shift+tab"]).state.selected).toBe(2);
    expect(press(open(), ["tab", "shift+tab"]).state.selected).toBe(0);
  });

  test("typing edits the query and asks for a search", () => {
    const { state, effect } = press(open(), ["y"]);
    expect(state.query).toBe("xy");
    expect(effect).toEqual({ type: "query", query: "xy" });
    expect(press(open(), ["backspace"]).effect).toEqual({ type: "query", query: "" });
  });

  test("ctrl+s cycles the scope and searches again", () => {
    const one = press(open(), ["ctrl+s"]);
    expect(one.state.scope).toBe("window");
    expect(one.effect).toEqual({ type: "scope", scope: "window" });
    const keys = (n: number) => Array.from({ length: n }, () => "ctrl+s");
    expect(press(open(), keys(2)).state.scope).toBe("windows");
    expect(press(open(), keys(3)).state.scope).toBe("closed");
    expect(press(open(), keys(4)).state.scope).toBe("workspace");
    expect(GREP_SCOPE_NAMES).toEqual({
      workspace: "this workspace",
      window: "this window",
      windows: "all windows",
      closed: "all windows + closed",
    });
  });

  test("ctrl+space refines the results fuzzily; Esc goes back to the grep query", () => {
    const r = press(open(), ["ctrl+space", "i", "n", "space", "b"]);
    expect(r.state.refine?.query).toBe("in b");
    expect(r.state.query).toBe("x");
    expect(r.state.rows.map((row) => row.tabId)).toEqual(["b", "b"]);
    expect(r.effect).toBeNull();
    const back = press(r.state, ["esc"]);
    expect(back.state.refine).toBeNull();
    expect(back.state.rows).toHaveLength(5);
    expect(back.state.mode).toBe("search");
  });

  test("ctrl+u and ctrl+d scroll the preview; without one ctrl+u clears", () => {
    expect(press(open({ preview: true }), ["ctrl+d"]).effect).toEqual({
      type: "preview",
      by: 1,
    });
    expect(press(open({ preview: true }), ["ctrl+u"]).effect).toEqual({
      type: "preview",
      by: -1,
    });
    const cleared = press(open({ preview: false }), ["ctrl+u"]);
    expect(cleared.state.query).toBe("");
    expect(cleared.effect).toEqual({ type: "query", query: "" });
  });

  test("Esc: search mode → browse mode → close; / and i go back to typing", () => {
    const browse = press(open(), ["esc"]);
    expect(browse.state.mode).toBe("browse");
    expect(press(browse.state, ["esc"]).effect).toEqual({ type: "close" });
    expect(press(browse.state, ["q"]).effect).toEqual({ type: "close" });
    expect(press(browse.state, ["/"]).state.mode).toBe("search");
    expect(press(browse.state, ["i"]).state.mode).toBe("search");
  });

  test("Enter selects the row", () => {
    const { effect } = press(open(), ["up", "enter"]);
    expect(effect).toEqual({ type: "select", row: rows[1] });
  });

  test("while the best result is selected, it stays the best as rows arrive", () => {
    const s = open();
    const more = rowsOf(["0", "a", "a", "b", "b", "c"]);
    const next = setGrepRows(s, more);
    expect(next.selected).toBe(0);
    expect(next.rows[0]?.tabId).toBe("0");
  });

  test("new rows keep the selected result selected", () => {
    const s = press(open(), ["up", "up"]).state;
    const id = s.rows[s.selected]?.id;
    const more = rowsOf(["0", "a", "a", "b", "b", "c"]);
    const next = setGrepRows(s, more);
    expect(next.rows[next.selected]?.id).toBe(id);
  });

  test("a new query selects the best result again", () => {
    const s = press(open(), ["up", "up", "z"]).state;
    expect(s.selected).toBe(0);
  });
});

const closedTab = (
  closedId: number,
  title: string,
  url: string,
  extra: Partial<GrepClosedEntry> = {},
): GrepClosedEntry => ({
  closedId,
  closedWindow: false,
  title,
  url,
  closedAt: 1000 - closedId,
  window: 1,
  workspace: "work",
  agent: false,
  tabs: [],
  ...extra,
});

describe("grepClosed: recently closed tabs and windows match on title and URL", () => {
  test("a title or URL match is a closed row with the match marked", () => {
    const rows = grepClosed(
      [
        closedTab(1, "Retry budget", "https://docs.test/retry"),
        closedTab(2, "Billing", "https://pay.test/budget-plan"),
        closedTab(3, "Other", "https://x.test/"),
      ],
      must("budget"),
    );
    expect(rows.map((r) => [r.id, r.titleAt, r.urlAt])).toEqual([
      ["closed:1", [6, 12], null],
      ["closed:2", null, [17, 23]],
    ]);
    expect(rows[0]).toMatchObject({
      kind: "closed",
      tabId: "closed:1",
      closedId: 1,
      closedWindow: false,
      host: "docs.test",
      window: 1,
      workspace: "work",
    });
  });

  test("smart case and the literal fallback apply as for page text", () => {
    const entries = [
      closedTab(1, "needle", "https://a.test/"),
      closedTab(2, "Needle", "https://b.test/"),
    ];
    expect(grepClosed(entries, must("Needle")).map((r) => r.closedId)).toEqual([2]);
    expect(grepClosed(entries, must("needle")).map((r) => r.closedId)).toEqual([1, 2]);
    expect(grepClosed([closedTab(1, "c++( guide", "https://c.test/")], must("c++(")).length).toBe(
      1,
    );
  });

  test("a closed window matches through its tabs and shows the first that matches", () => {
    const win = closedTab(7, "Work window", "", {
      closedWindow: true,
      window: 0,
      tabs: [
        { title: "Inbox", url: "https://mail.test/" },
        { title: "Retry budget", url: "https://docs.test/retry" },
      ],
    });
    const [row] = grepClosed([win], must("budget"));
    expect(row).toMatchObject({
      id: "closedwin:7",
      closedWindow: true,
      title: "Retry budget",
      host: "docs.test",
      tabCount: 2,
      titleAt: [6, 12],
    });
    expect(grepClosed([win], must("inbox|budget"))[0]?.title).toBe("Inbox");
  });

  test("newest first, at most 25 tabs and 5 windows, as Firefox keeps", () => {
    const tabs = Array.from({ length: 40 }, (_, i) =>
      closedTab(i, `needle ${i}`, "https://t.test/", { closedAt: i }),
    );
    const wins = Array.from({ length: 8 }, (_, i) =>
      closedTab(100 + i, "w", "", {
        closedWindow: true,
        closedAt: i,
        tabs: [{ title: "needle", url: "https://w.test/" }],
      }),
    );
    const rows = grepClosed([...tabs, ...wins], must("needle"));
    expect(rows.filter((r) => !r.closedWindow)).toHaveLength(25);
    expect(rows.filter((r) => r.closedWindow)).toHaveLength(5);
    expect(rows[0]?.closedId).toBe(39);
    expect(rows.findIndex((r) => r.closedWindow)).toBe(25);
  });

  test("entries closed in the same millisecond come last closed first", () => {
    const rows = grepClosed(
      [
        closedTab(4, "needle a", "https://t.test/", { closedAt: 7 }),
        closedTab(5, "needle b", "https://t.test/", { closedAt: 7 }),
        closedTab(6, "needle c", "https://t.test/", { closedAt: 7 }),
      ],
      must("needle"),
    );
    expect(rows.map((r) => r.closedId)).toEqual([6, 5, 4]);
  });

  test("a closed window takes the agent marking of the tab it shows", () => {
    const win = closedTab(7, "W", "", {
      closedWindow: true,
      window: 0,
      workspace: "",
      tabs: [
        { title: "mine", url: "https://a.test/" },
        { title: "agent needle", url: "https://b.test/", workspace: "agent", agent: true },
      ],
    });
    const mine = closedTab(1, "needle mine", "https://c.test/");
    const rows = grepClosed([win, mine], must("needle"));
    expect(rows.map((r) => [r.id, r.agent, r.workspace])).toEqual([
      ["closed:1", false, "work"],
      ["closedwin:7", true, "agent"],
    ]);
  });

  test("a host-less URL gives no host, and a closed row's URL and host are cut", () => {
    expect(grepHost(`about:blank#${"x".repeat(5000)}`)).toBe("");
    expect(grepHost("data:text/html,hello")).toBe("");
    expect(grepHost("https://docs.test/a")).toBe("docs.test");
    expect(grepHost(`https://${"h".repeat(60)}.test/`).length).toBeLessThanOrEqual(64);
    const [row] = grepClosed(
      [closedTab(1, "needle", `about:blank#${"x".repeat(5000)}`)],
      must("needle"),
    );
    expect(row?.host).toBe("");
    expect(row?.url.length).toBeLessThanOrEqual(GREP_CAPS.context + 2);
  });

  test("one closed title matching a thousand times cannot crowd out the rest", () => {
    const greedy = closedTab(0, "a".repeat(1000), "https://g.test/", { closedAt: 2000 });
    const rest = Array.from({ length: 24 }, (_, i) =>
      closedTab(i + 1, `a ${i}`, "https://t.test/"),
    );
    expect(grepClosed([greedy, ...rest], must("a"))).toHaveLength(25);
  });

  test("a closed window's tabs past 20 and fields past 1,000 characters are not matched", () => {
    const tabs = Array.from({ length: 30 }, (_, i) => ({
      title: i === 25 ? "late needle" : `tab ${i}`,
      url: "https://w.test/",
    }));
    const win = closedTab(7, "W", "", { closedWindow: true, tabs });
    expect(grepClosed([win], must("needle"))).toEqual([]);
    const far = closedTab(1, `${"x".repeat(1500)} needle`, "https://f.test/");
    expect(grepClosed([far], must("needle"))).toEqual([]);
  });

  test("agent workspace rows are marked and come last", () => {
    const rows = grepClosed(
      [
        closedTab(1, "needle a", "https://a.test/", { agent: true }),
        closedTab(2, "needle b", "https://b.test/"),
      ],
      must("needle"),
    );
    expect(rows.map((r) => [r.closedId, r.agent])).toEqual([
      [2, false],
      [1, true],
    ]);
  });

  test("a closed row's preview names it and what Enter does", () => {
    const [tabRow] = grepClosed(
      [closedTab(1, "Retry budget", "https://docs.test/retry")],
      must("budget"),
    );
    if (!tabRow) throw new Error("no closed tab row");
    const p = closedPreview(tabRow);
    expect(p.lines).toEqual([
      "Recently closed tab",
      "Retry budget",
      "https://docs.test/retry",
      "Only its title and URL are searched.",
      "Enter reopens it.",
    ]);
    expect(p.line).toBe(1);
    expect(p.at).toEqual([6, 12]);
    const win = closedTab(7, "W", "", {
      closedWindow: true,
      tabs: [
        { title: "Inbox", url: "https://mail.test/" },
        { title: "Retry budget", url: "https://docs.test/retry" },
      ],
    });
    const [winRow] = grepClosed([win], must("budget"));
    if (!winRow) throw new Error("no closed window row");
    const wp = closedPreview(winRow);
    expect(wp.lines[0]).toBe("Recently closed window, 2 tabs");
    expect(wp.lines).toContain("Inbox  https://mail.test/");
    expect(wp.lines.slice(-2)).toEqual([
      "Only their titles and URLs are searched.",
      "Enter reopens the window.",
    ]);
  });
});

describe("grepText firstPerLine", () => {
  test("takes the first match of each line and counts lines", () => {
    const r = grepText("aaa\nbab\nccc", must("a"), {
      ...GREP_CAPS,
      listed: GREP_CAPS.counted,
      firstPerLine: true,
    });
    expect(r.matches.map((m) => [m.line, m.start])).toEqual([
      [1, 0],
      [2, 5],
    ]);
    expect(r.count).toBe(2);
  });
});

describe("grepScopeText: what is being searched", () => {
  const tabs = [
    tab("a", 1),
    tab("b", 2, { loaded: false }),
    tab("n", 1, { workspace: "notes" }),
    tab("g", 1, { workspace: "agent", agent: true }),
    tab("x", 1, { window: 2, workspace: "home" }),
    tab("y", 2, { window: 2, workspace: "home" }),
  ];

  test("one workspace: its window, name and tab count", () => {
    const text = grepScopeText("workspace", tabs.slice(0, 2), null);
    expect(text.title).toBe("Scope: this workspace · ctrl+s");
    expect(text.lines).toEqual(["w1 this window: work · 2 tabs, 1 not loaded"]);
  });

  test("windows grouped, each with its workspaces and counts; the agent marked", () => {
    const text = grepScopeText("windows", tabs, null);
    expect(text.title).toBe("Scope: all windows · ctrl+s");
    expect(text.lines).toEqual([
      "w1 this window: work 2, notes 1, ◇ agent 1 · 4 tabs, 1 not loaded",
      "w2: home · 2 tabs",
    ]);
  });

  test("the closed scope adds what recently closed holds", () => {
    const text = grepScopeText("closed", tabs.slice(4), { tabs: 3, windows: 1 });
    expect(text.lines).toEqual([
      "w2: home · 2 tabs",
      "recently closed: 3 tabs, 1 window · titles and URLs only",
    ]);
  });

  test("past five windows the rest are summed in one line", () => {
    const many = Array.from({ length: 8 }, (_, i) => tab(`t${i}`, 1, { window: i + 1 }));
    const { lines } = grepScopeText("windows", many, null);
    expect(lines).toHaveLength(6);
    expect(lines.at(-1)).toBe("… 3 more windows · 3 tabs");
  });

  test("no tabs in scope says so", () => {
    expect(grepScopeText("workspace", [], null).lines).toEqual(["no tabs"]);
  });
});

// Issue #1119: the behaviours below were not pinned by any test, so mutation testing could change
// them unnoticed.
describe("parseQuery: what ripgrep counts as a literal", () => {
  test.each([
    // Escaped code points are literals, upper case or not.
    ["\\x41", true],
    ["\\x61", false],
    ["\\u0041", true],
    ["\\u0061", false],
    ["\\u{41}", true],
    ["\\u{61}", false],
    ["\\u{1F600}", false],
    // Only from where the escape starts: what comes before is read too.
    ["\\dX\\x61", true],
    ["\\dX\\u0061", true],
    ["\\dX\\u{61}", true],
    ["\\dxx\\p{L}", false],
    ["\\P{Ll}x", false],
    ["\\p{Lu}", true],
    // Group syntax, back references and named ones are not literals.
    ["(?<Name>X)", true],
    ["(?:A)", true],
    ["(?=a)", false],
    ["(?<!a)", false],
    ["a?", false],
    ["(?<ab>\\d)\\k<ab>", true],
    ["(?<n>\\d)\\k<n>X", true],
    ["(\\d)\\1", true],
    ["\\dx\\1(a)", false],
    // A control character and \n, \t, \0 are literals, never upper case.
    ["\\cJ", false],
    ["\\dA\\cj", true],
    ["\\n", false],
    ["\\t\\d", false],
    ["\\0", false],
    ["\\W\\S\\D\\B", true],
    ["\\.X", true],
    // A class's characters are literals; its leading ^ is not; it ends at ].
    ["[a-z]", false],
    ["[^A]", true],
    ["[^]", true],
    ["[\\dA]", true],
    ["\\d[\\d]", true],
    ["[a](?<Name>b)", false],
    // Counted repetition is not a literal.
    ["\\d{12}", true],
    ["\\d{2}", true],
    ["\\d{2,}", true],
    ["\\d{2,34}", true],
    ["\\d.^$|(\\d)*", true],
  ])("%s matches case: %s", (q, caseSensitive) => {
    const parsed = must(q);
    expect(parsed.literal).toBe(false);
    expect(parsed.caseSensitive).toBe(caseSensitive);
    expect(parsed.regex.flags).toBe(caseSensitive ? "gu" : "giu");
  });

  test.each([
    ["a{", false],
    ["a\\", false],
    ["A\\", true],
    ["\\u{110000}", false],
  ])("%s does not compile: matched as typed, case from its letters (%s)", (q, caseSensitive) => {
    const parsed = must(q);
    expect(parsed.literal).toBe(true);
    expect(parsed.caseSensitive).toBe(caseSensitive);
    expect(parsed.regex.flags).toBe(caseSensitive ? "gu" : "giu");
    expect(parsed.regex.test(`x ${q.toUpperCase()} x`)).toBe(true);
  });
});

describe("grepText: cuts, steps and caps", () => {
  const caps = { listed: 100, counted: 1000, context: 10, before: 3 };
  const contexts = (text: string, q: string) =>
    grepText(text, must(q), caps).matches.map((m) => [m.context, m.at]);
  const alphabet = "0123456789abcdefghijklmnopqrstu";

  test("a line as wide as the context is not cut", () => {
    expect(contexts("0123456789", "5")).toEqual([["0123456789", [5, 6]]]);
  });

  test("a cut line keeps the width, and an ellipsis marks each cut end", () => {
    expect(contexts(alphabet, "1")).toEqual([["0123456789…", [1, 2]]]);
    expect(contexts(alphabet, "f")).toEqual([["…cdefghijkl…", [4, 5]]]);
    // Near the end the window moves back to stay as wide.
    expect(contexts(alphabet, "s")).toEqual([["…lmnopqrstu", [8, 9]]]);
  });

  test("a cut never splits a surrogate pair", () => {
    expect(contexts("ab😀cdefghijklmnopq", "d")).toEqual([["…😀cdefghij…", [4, 5]]]);
    expect(contexts("abcd😀efghijklmnopq", "g")).toEqual([["…efghijklm…", [3, 4]]]);
    expect(contexts("0123456789😀xyzxyzxyz", "0")).toEqual([["0123456789…", [0, 1]]]);
    expect(contexts("012345678😀xyzxyzxyz", "0")).toEqual([["012345678…", [0, 1]]]);
  });

  test("an empty match steps one code unit, or two over a surrogate pair", () => {
    const spans = (text: string) => grepText(text, must("x*")).matches.map((m) => [m.start, m.end]);
    expect(spans("ax")).toEqual([[1, 2]]);
    expect(spans("￿x")).toEqual([[1, 2]]);
    expect(spans("😀x")).toEqual([[2, 3]]);
  });

  test("an empty line is no line", () => {
    expect(grepText("a\n\nb", must("b")).matches.map((m) => m.line)).toEqual([2]);
    expect(grepText("a\n\nb", must("S")).count).toBe(0);
  });

  test("counting stops at the cap", () => {
    expect(grepText("aaaaa", must("a"), { ...caps, counted: 3 }).count).toBe(3);
  });
});

describe("previewLines: edges", () => {
  test("a match at a line's end is in that line", () => {
    const p = previewLines("ab\ncd", 2, 2);
    expect(p).toEqual({ first: 1, line: 0, at: [2, 2], lines: ["ab", "cd"] });
  });

  test("a match at the very end of the text is on its own empty line", () => {
    expect(previewLines("a\nb\n", 4, 4)).toEqual({
      first: 1,
      line: 2,
      at: [0, 0],
      lines: ["a", "b", ""],
    });
  });

  // The grep actor never asks past the text (it checks end <= the text's length); this is the
  // fallback for when it would.
  test("a start past the text shows its last lines", () => {
    expect(previewLines("a\nb\nc", 10, 11, 1)).toMatchObject({
      first: 2,
      line: 1,
      lines: ["b", "c"],
    });
    expect(previewLines("", 5, 6)).toEqual({ first: 1, line: 0, at: [0, 0], lines: [] });
  });

  test("the match is clipped to its line", () => {
    expect(previewLines("abc\ndef", 1, 6).at).toEqual([1, 3]);
  });

  test("the text is read only up to n lines past the match", () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    let p: ReturnType<typeof previewLines> | undefined;
    const read = charsRead(() => {
      p = previewLines(text, 0, 4, 2);
    });
    expect(p?.lines).toEqual(["line 0", "line 1", "line 2"]);
    expect(read).toBeLessThan(100);
  });
});

describe("parseGrepReply and parsePreviewReply: every check", () => {
  const match = { start: 0, end: 3, line: 1, ordinal: 0, context: "abc", at: [0, 3] };
  const good = { count: 1, matches: [match] };

  test.each([
    0,
    false,
    { ...good, gen: 1.5 },
    { ...good, cut: "no" },
    { ...good, matches: [null] },
    { ...good, matches: ["x"] },
    { ...good, matches: [{ ...match, end: -1 }] },
    { ...good, matches: [{ ...match, start: 4 }] },
    { ...good, matches: [{ ...match, line: -1 }] },
    { ...good, matches: [{ ...match, ordinal: "0" }] },
    { ...good, matches: [{ ...match, at: [0, 1, 2] }] },
    { ...good, matches: [{ ...match, at: "0,1" }] },
    { ...good, matches: [{ ...match, at: [-1, 1] }] },
    { ...good, matches: [{ ...match, at: [0, 1.5] }] },
  ])("drops %j", (raw) => {
    expect(parseGrepReply(raw)).toBeNull();
  });

  test("an empty match and an empty range are fine; gen and cut are copied as given", () => {
    const empty = { ...match, end: 0, at: [1, 1] };
    expect(parseGrepReply({ ...good, matches: [empty] })?.matches).toEqual([empty]);
    expect(parseGrepReply({ ...good, gen: 0, cut: false })).toEqual({
      ...good,
      gen: 0,
      cut: false,
    });
    expect(parseGrepReply(good)).toEqual(good);
  });

  test("a context is cut to 162 characters, with the match clipped to it", () => {
    const long = { ...match, context: "x".repeat(170), at: [160, 170] };
    const [m] = parseGrepReply({ ...good, matches: [long] })?.matches ?? [];
    expect(m?.context).toHaveLength(GREP_CAPS.context + 2);
    expect(m?.at).toEqual([160, 162]);
    const exact = { ...match, context: "y".repeat(162), at: [0, 162] };
    expect(parseGrepReply({ ...good, matches: [exact] })?.matches[0]).toEqual(exact);
  });

  const ok = { first: 1, line: 0, at: [0, 1], lines: ["a", "b"] };
  test.each([
    null,
    7,
    { ...ok, first: -1 },
    { ...ok, line: 0.5 },
    { ...ok, at: [2, 1] },
    { ...ok, lines: "a" },
    { ...ok, lines: ["a", 2] },
    { ...ok, line: 2 },
  ])("parsePreviewReply drops %j", (raw) => {
    expect(parsePreviewReply(raw)).toBeNull();
  });

  test("a preview keeps 21 lines of at most 302 characters", () => {
    const lines = Array.from({ length: 22 }, (_, i) => `${i}`.padEnd(303, "z"));
    const r = parsePreviewReply({ ...ok, line: 20, lines });
    expect(r?.lines).toHaveLength(21);
    expect(r?.lines[20]).toBe(lines[20]?.slice(0, 302));
    expect(parsePreviewReply({ ...ok, line: 21, lines })).toBeNull();
  });
});

describe("grepRows, grepHost and the count text: edges", () => {
  test("a tab that is not loaded lists no matches, whatever replies it has", () => {
    const tabs = [tab("a", 1, { loaded: false })];
    const frames = new Map([["a", [{ key: "0", host: null, reply: reply(2) }]]]);
    const { rows, count, tabsWithMatches } = grepRows(tabs, frames);
    expect(rows.map((r) => [r.kind, r.id])).toEqual([["unloaded", "unloaded:a"]]);
    expect(count).toBe(0);
    expect(tabsWithMatches).toBe(0);
  });

  test("closed and not-loaded rows stop at the cap too", () => {
    const closed = grepClosed(
      [1, 2, 3].map((n) => closedTab(n, `needle ${n}`, "https://t.test/")),
      must("needle"),
    );
    const tabs = [tab("a", 1), tab("b", 2, { loaded: false })];
    const frames = new Map([["a", [{ key: "0", host: null, reply: reply(1) }]]]);
    const { rows, count, tabsWithMatches } = grepRows(tabs, frames, { rows: 2 }, closed);
    expect(rows.map((r) => r.id)).toEqual(["a:0:0", "closed:1"]);
    expect(count).toBe(4);
    expect(tabsWithMatches).toBe(4);
    const room = grepRows(tabs, frames, { rows: 5 }, closed).rows;
    expect(room.map((r) => r.id)).toEqual([
      "a:0:0",
      "closed:1",
      "closed:2",
      "closed:3",
      "unloaded:b",
    ]);
    expect(grepRows(tabs, frames, { rows: 4 }, closed).rows).toHaveLength(4);
  });

  test("a host is cut past 64 characters, and a URL that does not parse has none", () => {
    const host = (n: number) => `${"h".repeat(n - 5)}.test`;
    expect(grepHost(`https://${host(64)}/`)).toBe(host(64));
    expect(grepHost(`https://${host(65)}/`)).toBe(`${host(65).slice(0, 63)}…`);
    expect(grepHost("not a url")).toBe("");
  });

  test("the count text says how many are listed when not all are", () => {
    expect(grepCountText(100, 250, 3)).toBe("250 matches in 3 tabs, 100 listed");
    expect(grepCountText(2, 2, 1)).toBe("2 matches in 1 tab");
  });
});

describe("grepClosed: fields and windows, exactly", () => {
  test("only the closed titles and URLs are matched, each on its own line", () => {
    expect(grepClosed([closedTab(1, "x", "y")], must("was here"))).toEqual([]);
    expect(grepClosed([closedTab(1, "a", "b")], must("a.*b"))).toEqual([]);
    // A title's line breaks are spaces, so the title stays one line.
    const [row] = grepClosed([closedTab(1, "one\ntwo", "https://t.test/")], must("one two"));
    expect(row).toMatchObject({ title: "one two", titleAt: [0, 7] });
  });

  test("a match in the last entry's URL", () => {
    const [row] = grepClosed([closedTab(1, "Title", "https://last.test/")], must("last"));
    expect(row).toMatchObject({ titleAt: null, urlAt: [8, 12], title: "Title" });
  });

  test("a closed window marks the matches of the tab it shows, not another tab's", () => {
    const win = closedTab(7, "W", "", {
      closedWindow: true,
      tabs: [
        { title: "needle one", url: "https://a.test/" },
        { title: "two", url: "https://needle.test/" },
      ],
    });
    const [row] = grepClosed([win], must("needle"));
    expect(row).toMatchObject({ title: "needle one", titleAt: [0, 6], urlAt: null });
    expect(row?.url).toBe("https://a.test/");
  });

  test("a closed window previews its first ten tabs; a closed tab has none", () => {
    const tabs = Array.from({ length: 12 }, (_, i) => ({ title: `needle ${i}`, url: `u${i}` }));
    const [row] = grepClosed([closedTab(7, "W", "", { closedWindow: true, tabs })], must("needle"));
    expect(row?.tabs).toHaveLength(GREP_CAPS.previewLines);
    expect(row?.tabs[9]).toEqual({ title: "needle 9", url: "u9" });
    expect(row?.tabCount).toBe(12);
    const [one] = grepClosed([closedTab(1, "needle", "https://t.test/")], must("needle"));
    expect(one?.tabs).toEqual([]);
    expect(one?.tabCount).toBe(1);
  });

  test("a closed window's tab without a title or URL shows empty ones", () => {
    const tabs = [{ title: "needle", url: "https://a.test/" }, { url: "u" }, { title: "t" }];
    const win = closedTab(7, "W", "", { closedWindow: true, tabs } as Partial<GrepClosedEntry>);
    const [row] = grepClosed([win], must("needle"));
    expect(row?.tabs).toEqual([
      { title: "needle", url: "https://a.test/" },
      { title: "", url: "u" },
      { title: "t", url: "" },
    ]);
  });

  test("a closed row's preview: one tab in the singular, and no title match marks nothing", () => {
    const win = closedTab(7, "W", "", {
      closedWindow: true,
      tabs: [{ title: "Inbox", url: "https://needle.test/" }],
    });
    const [row] = grepClosed([win], must("needle"));
    if (!row) throw new Error("no closed window row");
    const p = closedPreview(row);
    expect(p.lines[0]).toBe("Recently closed window, 1 tab");
    expect(p.at).toEqual([0, 0]);
  });
});

describe("grepScopeText and holdReplies: order", () => {
  test("windows are listed by number", () => {
    const tabs = [10, 2, 1].map((w) => tab(`t${w}`, 1, { window: w, workspace: "" }));
    expect(grepScopeText("windows", tabs, null).lines).toEqual([
      "w1 this window: tabs · 1 tab",
      "w2: tabs · 1 tab",
      "w10: tabs · 1 tab",
    ]);
  });

  test("of two replies ranked the same, the earlier keeps its matches", () => {
    const held = holdReplies([
      { rank: 1, reply: reply(1500) },
      { rank: 1, reply: reply(1500) },
    ]);
    expect(held.map((e) => e.reply.matches.length)).toEqual([1500, 500]);
  });

  test("a reply kept whole is kept as it is", () => {
    const first = { rank: 0, reply: reply(1500) };
    const held = holdReplies([first, { rank: 1, reply: reply(1000) }]);
    expect(held[0]).toBe(first);
  });
});

describe("grepPickerKey: every key, exactly", () => {
  const rows = rowsOf(["a", "a", "b", "b", "c"]);
  const open = (query = "x") => setGrepRows(openGrepPicker(query), rows);
  const press = (s: GrepPickerState, keys: string[]) => {
    let effect: ReturnType<typeof grepPickerKey>["effect"] = null;
    for (const k of keys) ({ state: s, effect } = grepPickerKey(s, k));
    return { state: s, effect };
  };

  test("a new picker has no rows, no refine, no preview and no pending g", () => {
    expect(openGrepPicker("q")).toEqual({
      query: "q",
      mode: "search",
      scope: "workspace",
      all: [],
      rows: [],
      selected: 0,
      refine: null,
      preview: false,
      g: false,
    });
    expect(openGrepPicker("q", { preview: true }).preview).toBe(true);
  });

  test("moving past either end stays there, as the same state", () => {
    const s = open();
    expect(grepPickerKey(s, "down").state).toBe(s);
    expect(press(s, ["up", "up", "down"]).state.selected).toBe(1);
    const top = press(
      s,
      Array.from({ length: 10 }, () => "up"),
    ).state;
    expect(top.selected).toBe(4);
    expect(grepPickerKey(top, "up").state).toBe(top);
  });

  test("Tab on the last tab's first row stays there", () => {
    const s = setGrepRows(openGrepPicker("x"), rowsOf(["a", "b", "b"]));
    const onB = press(s, ["tab"]).state;
    expect(onB.selected).toBe(1);
    expect(grepPickerKey(onB, "tab").state).toBe(onB);
  });

  test("a g followed by another key is forgotten; gg leaves no g pending", () => {
    const browse = press(open(), ["esc"]).state;
    const afterJ = press(browse, ["g", "k"]).state;
    expect(afterJ.g).toBe(false);
    expect(afterJ.selected).toBe(1);
    expect(press(afterJ, ["g"]).state.selected).toBe(1);
    const gg = press(browse, ["g", "g"]).state;
    expect(gg.g).toBe(false);
    expect(gg.selected).toBe(4);
  });

  test("editing keys: backspace drops one character, ctrl+w a word, others type or do nothing", () => {
    const s = open("foo bar");
    expect(press(s, ["backspace"]).state.query).toBe("foo ba");
    expect(press(s, ["ctrl+w"]).effect).toEqual({ type: "query", query: "foo " });
    expect(grepPickerKey(s, "f5")).toEqual({ state: s, effect: null });
    // Nothing left to delete asks for no search.
    const empty = open("");
    expect(grepPickerKey(empty, "backspace")).toEqual({ state: empty, effect: null });
  });

  test("ctrl+u in browse mode without a preview does nothing", () => {
    const browse = press(open(), ["esc"]).state;
    expect(grepPickerKey(browse, "ctrl+u")).toEqual({ state: browse, effect: null });
  });

  test("refine: a blank refine lists every row; ctrl+space again keeps the refine", () => {
    const refining = press(open(), ["ctrl+space", "space"]).state;
    expect(refining.refine?.query).toBe(" ");
    expect(refining.rows).toEqual(rows);
    const typed = press(open(), ["ctrl+space", "i"]).state;
    expect(grepPickerKey(typed, "ctrl+space").state).toBe(typed);
    // ctrl+u on an empty refine query changes nothing.
    const fresh = press(open(), ["ctrl+space"]).state;
    const cleared = grepPickerKey(fresh, "ctrl+u");
    expect(cleared.state).toBe(fresh);
    expect(cleared.effect).toBeNull();
  });

  test("refine ranks the best match first and reads closed and not-loaded rows too", () => {
    const tabs = [tab("w", 1), tab("e", 2), tab("u", 3, { loaded: false, title: "needle tab" })];
    const frames = new Map([
      ["w", [{ key: "0", host: null, reply: reply(1, "a needle in a haystack") }]],
      ["e", [{ key: "0", host: null, reply: reply(1, "needle") }]],
    ]);
    const closed = grepClosed([closedTab(1, "Closed", "https://needle.test/")], must("needle"));
    const all = grepRows(tabs, frames, GREP_CAPS, closed).rows;
    const s = press(setGrepRows(openGrepPicker("x"), all), ["ctrl+space", ..."needle"]).state;
    expect(s.rows.map((r) => r.id)).toEqual(["e:0:0", "unloaded:u", "w:0:0", "closed:1"]);
    expect(
      press(s, ["backspace", "backspace", "backspace", "backspace", "backspace"]).state.rows,
    ).toHaveLength(4);
    expect(press(s, ["space", "z"]).state.rows).toEqual([]);
  });

  test("Esc from a refine that matched nothing goes back to every row, the best selected", () => {
    const none = press(open(), ["up", "ctrl+space", "z", "z", "z"]).state;
    expect(none.rows).toEqual([]);
    const back = grepPickerKey(none, "esc").state;
    expect(back.rows).toEqual(rows);
    expect(back.selected).toBe(0);
  });

  test("rows that arrive during a refine are kept for later, not shown", () => {
    const refining = press(open(), ["ctrl+space", "i", "n", "space", "b"]).state;
    const more = rowsOf(["0", "a", "a", "b", "b", "c"]);
    const next = setGrepRows(refining, more);
    expect(next.all).toBe(more);
    expect(next.rows).toBe(refining.rows);
    expect(grepPickerKey(next, "esc").state.rows).toBe(more);
  });

  test("new rows replace the list; a selected row that went selects the best", () => {
    const s = press(open(), ["up", "up"]).state;
    const other = rowsOf(["q", "r", "s"]);
    const next = setGrepRows(s, other);
    expect(next.all).toBe(other);
    expect(next.rows).toBe(other);
    expect(next.selected).toBe(0);
  });
});

describe("live grep: more edges", () => {
  test("a class's first character is a literal", () => {
    expect(must("[a]").caseSensitive).toBe(false);
  });

  test("a cut never lands between the halves of U+10000 or U+103FF", () => {
    const caps = { listed: 100, counted: 1000, context: 10, before: 3 };
    const ctx = (text: string, q: string) =>
      grepText(text, must(q), caps).matches.map((m) => [m.context, m.at]);
    expect(ctx("abcd\u{10000}efghijklmnopq", "g")).toEqual([["…efghijklm…", [3, 4]]]);
    expect(ctx("abcd\u{103FF}efghijklmnopq", "g")).toEqual([["…efghijklm…", [3, 4]]]);
  });

  test("a reply without gen or cut gets neither", () => {
    const r = parseGrepReply({ count: 0, matches: [] });
    expect(r).not.toHaveProperty("gen");
    expect(r).not.toHaveProperty("cut");
  });

  test("a closed window's tab without a title is not matched on one", () => {
    const tabs = [{ url: "https://a.test/" }] as GrepClosedEntry["tabs"];
    const win = closedTab(7, "W", "", { closedWindow: true, tabs });
    expect(grepClosed([win], must("was here"))).toEqual([]);
    expect(grepClosed([win], must("undefined"))).toEqual([]);
  });

  test("of three replies ranked the same, the earlier ones keep their matches", () => {
    const held = holdReplies([1, 1, 1].map((rank) => ({ rank, reply: reply(1000) })));
    expect(held.map((e) => e.reply.matches.length)).toEqual([1000, 1000, 0]);
  });

  test("[q steps back from the middle; a lone live row is stepped to itself", () => {
    const rows = rowsOf(["a", "b", "c"]);
    expect(stepGrepList({ query: "x", rows, index: 2 }, -1, () => true)?.index).toBe(1);
    expect(stepGrepList({ query: "x", rows, index: 1 }, 1, (id) => id === "b")?.index).toBe(1);
  });

  test("refine reads a not-loaded row's title only", () => {
    const tabs = [tab("u", 1, { loaded: false, title: "plain" })];
    const all = grepRows(tabs, new Map()).rows;
    const s = setGrepRows(openGrepPicker("x"), all);
    let r = grepPickerKey(s, "ctrl+space").state;
    for (const k of "undefined") r = grepPickerKey(r, k).state;
    expect(r.rows).toEqual([]);
  });
});
