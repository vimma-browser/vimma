import { describe, test, expect } from "vitest";
import {
  GREP_CAPS,
  GREP_SCOPE_NAMES,
  closedPreview,
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
} from "../src/grep.mjs";
import { BLOCK } from "../src/motions.mjs";

/** @import { GrepList, GrepPickerState, GrepRow, GrepTab } from "../src/grep.mjs" */

/** @param {string} q */
const must = (q) => {
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

  test("bench: 1,000,000 characters under 50 ms", () => {
    const line = "the quick brown fox jumps over the lazy dog ";
    const big = Array.from({ length: Math.ceil(1e6 / (line.length + 1)) }, () => line).join(BLOCK);
    const q = must("lazy cat");
    grepText(big, q);
    const start = performance.now();
    grepText(big, q);
    expect(performance.now() - start).toBeLessThan(50);
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

/**
 * @param {string} tabId
 * @param {number} index
 * @param {Partial<GrepTab>} [extra]
 * @returns {GrepTab}
 */
const tab = (tabId, index, extra = {}) => ({
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

/**
 * @param {number} n
 * @param {string} [ctx]
 */
const reply = (n, ctx = "a needle") => ({
  count: n,
  matches: Array.from({ length: n }, (_, i) => ({
    start: i * 10,
    end: i * 10 + 6,
    line: i + 1,
    ordinal: i,
    context: ctx,
    at: /** @type {[number, number]} */ ([2, 8]),
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

/**
 * @param {string[]} tabIds
 * @returns {GrepRow[]}
 */
function rowsOf(tabIds) {
  const tabs = [...new Set(tabIds)].map((t, i) => tab(t, i + 1));
  /** @type {Map<string, any[]>} */
  const frames = new Map();
  for (const t of tabs) {
    const n = tabIds.filter((x) => x === t.tabId).length;
    frames.set(t.tabId, [{ key: "0", host: null, reply: reply(n, `in ${t.tabId}`) }]);
  }
  return grepRows(tabs, frames).rows;
}

describe("holdReplies: the parent keeps at most the rows it can list, best first", () => {
  /**
   * @param {number} rank
   * @param {number} n
   */
  const entry = (rank, n) => ({ rank, reply: reply(n) });
  const kept = (/** @type {{ reply: { matches: unknown[] } }[]} */ entries) =>
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
    /** @type {GrepList} */
    let list = { query: "x", rows, index: 0 };
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
  /** @param {Partial<GrepPickerState>} [extra] */
  const open = (extra = {}) => ({ ...setGrepRows(openGrepPicker("x"), rows), ...extra });
  /**
   * @param {GrepPickerState} s
   * @param {string[]} keys
   */
  const press = (s, keys) => {
    /** @type {ReturnType<typeof grepPickerKey>["effect"]} */
    let effect = null;
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
    const keys = (/** @type {number} */ n) => Array.from({ length: n }, () => "ctrl+s");
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

/**
 * @param {number} closedId
 * @param {string} title
 * @param {string} url
 * @param {Partial<import("../src/grep.mjs").GrepClosedEntry>} [extra]
 * @returns {import("../src/grep.mjs").GrepClosedEntry}
 */
const closedTab = (closedId, title, url, extra = {}) => ({
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
