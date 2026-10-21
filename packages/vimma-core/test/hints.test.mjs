import { describe, test, expect } from "vitest";
import fc from "fast-check";
import {
  DEFAULT_HINT_CHARS,
  HINT_ACTIONS,
  hintLabels,
  orderTargets,
  startHints,
  hintKey,
  visibleHints,
  HintError,
  parseHintReply,
  parseBlockReply,
  BLOCK_REPLY_MAX_TEXT,
  HINT_REPLY_MAX_TARGETS,
  HINT_REPLY_MAX_FRAMES,
  HINT_REPLY_MAX_HREF,
} from "../src/hints.mjs";
import { ACTIONS } from "../src/actions.mjs";
import { parseKey } from "../src/keys.mjs";

/** ⌈log_k n⌉ by integer arithmetic (no floating-point surprises at exact powers). */
function ceilLog(n, k) {
  let L = 0;
  let p = 1;
  while (p < n) {
    p *= k;
    L++;
  }
  return L;
}

describe("hintLabels", () => {
  test("the default hint characters are the home row without ;", () => {
    expect(DEFAULT_HINT_CHARS).toBe("asdfghjkl");
  });

  test.each([
    [0, []],
    [1, ["a"]],
    [9, ["a", "s", "d", "f", "g", "h", "j", "k", "l"]],
  ])("Given %i targets, then %j", (n, labels) => {
    expect(hintLabels(n)).toEqual(labels);
  });

  test("Given 10 targets, then 8 one-letter labels and la, ls", () => {
    expect(hintLabels(10)).toEqual(["a", "s", "d", "f", "g", "h", "j", "k", "la", "ls"]);
  });

  test("Given 12 targets, then la ls ld lf after 8 one-letter labels", () => {
    expect(hintLabels(12).slice(8)).toEqual(["la", "ls", "ld", "lf"]);
  });

  test("Given 81 targets, then all two-letter labels; 82 gives 80 two- and 2 three-letter", () => {
    const l81 = hintLabels(81);
    expect(l81.every((l) => l.length === 2)).toBe(true);
    const l82 = hintLabels(82);
    expect(l82.filter((l) => l.length === 2)).toHaveLength(80);
    expect(l82.slice(80)).toEqual(["lla", "lls"]);
  });

  test.each(["ab", "asdf", "jkl;"])(
    "charset %s: n = 1 and n = k give single characters",
    (chars) => {
      expect(hintLabels(1, chars)).toEqual([chars[0]]);
      expect(hintLabels(chars.length, chars)).toEqual([...chars]);
    },
  );

  test("a custom charset is used in its own order", () => {
    expect(hintLabels(4, "ab")).toEqual(["aa", "ab", "ba", "bb"]);
    expect(hintLabels(3, "ab")).toEqual(["a", "ba", "bb"]);
  });

  test.each(["a", "aa", "aB", "a ", "", "a\t"])("charset %j is bad-charset", (chars) => {
    expect(() => hintLabels(3, chars)).toThrow(HintError);
    try {
      hintLabels(3, chars);
    } catch (e) {
      expect(e.code).toBe("bad-charset");
    }
  });

  test.each([-1, 1.5, NaN, Infinity])("count %s is bad-count", (n) => {
    expect(() => hintLabels(n)).toThrow(expect.objectContaining({ code: "bad-count" }));
  });

  test("property: n labels, unique, prefix-free, minimal, ordered, deterministic", () => {
    const charsetArb = fc
      .uniqueArray(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789;,."), {
        minLength: 2,
        maxLength: 12,
      })
      .map((a) => a.join(""));
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2000 }), charsetArb, (n, chars) => {
        const labels = hintLabels(n, chars);
        const k = chars.length;
        // Plain checks, one expect each: per-label expect() calls are too slow for 2000 labels.
        expect(labels).toHaveLength(n);
        expect(new Set(labels).size).toBe(n);
        expect(labels.every((l) => [...l].every((c) => chars.includes(c)))).toBe(true);
        expect(labels.every((l) => l.length >= 1)).toBe(true);
        // prefix-free: in sorted order a prefix would sit right before an extension of it
        const sorted = [...labels].sort();
        expect(sorted.some((l, i) => i > 0 && l.startsWith(sorted[i - 1]))).toBe(false);
        if (n >= 1) {
          const L = Math.max(1, ceilLog(n, k));
          expect(labels.every((l) => l.length === L - 1 || l.length === L)).toBe(true);
          const short = labels.filter((l) => l.length === L - 1).length;
          const long = n - short;
          // Kraft: the code fits in a k-ary tree of depth L, and no further label can be shortened.
          expect(short * k + long).toBeLessThanOrEqual(k ** L);
          if (long > 0 && L > 1) expect((short + 1) * k + (long - 1)).toBeGreaterThan(k ** L);
          if (n <= k) expect(labels).toEqual([...chars].slice(0, n));
        }
        // ordered by length, then charset order
        const before = (a, b) => {
          if (a.length !== b.length) return a.length < b.length;
          const j = [...a].findIndex((c, idx) => c !== b[idx]);
          return chars.indexOf(a[j]) < chars.indexOf(b[j]);
        };
        expect(labels.every((l, i) => i === 0 || before(labels[i - 1], l))).toBe(true);
        expect(hintLabels(n, chars)).toEqual(labels);
      }),
      { numRuns: 300 },
    );
  });
});

const r = (x, y, width = 40, height = 16) => ({ x, y, width, height });

describe("orderTargets", () => {
  test("a shuffled 3 × 3 grid reads row by row", () => {
    const grid = [];
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 3; col++)
        grid.push({ id: `${row}${col}`, rect: r(col * 100, row * 50) });
    const shuffled = [
      grid[4],
      grid[8],
      grid[0],
      grid[2],
      grid[6],
      grid[1],
      grid[7],
      grid[3],
      grid[5],
    ];
    expect(orderTargets(shuffled).map((t) => t.id)).toEqual(grid.map((t) => t.id));
  });

  test("links on one text line with ragged tops stay one row, left to right", () => {
    const ts = [
      { id: "c", rect: r(300, 98) },
      { id: "a", rect: r(0, 100) },
      { id: "b", rect: r(150, 102) },
    ];
    expect(orderTargets(ts).map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  test("a target more than half a line lower starts a new row", () => {
    const ts = [
      { id: "low-left", rect: r(0, 109) },
      { id: "high-right", rect: r(300, 100) },
    ];
    expect(orderTargets(ts).map((t) => t.id)).toEqual(["high-right", "low-left"]);
  });

  test("extra fields pass through and the input is not mutated", () => {
    const ts = Object.freeze([
      Object.freeze({ id: 2, href: "/b", rect: r(10, 0) }),
      Object.freeze({ id: 1, href: "/a", rect: r(0, 0) }),
    ]);
    const out = orderTargets(ts);
    expect(out[0]).toBe(ts[1]);
    expect(out[1]).toBe(ts[0]);
  });

  test("property: a permutation of the input, invariant under input order", () => {
    const rectArb = fc.record({
      x: fc.integer({ min: 0, max: 400 }),
      y: fc.integer({ min: 0, max: 400 }),
      width: fc.integer({ min: 1, max: 100 }),
      height: fc.integer({ min: 1, max: 60 }),
    });
    fc.assert(
      fc.property(
        fc
          .array(rectArb, { maxLength: 40 })
          .chain((rects) =>
            fc.tuple(fc.constant(rects), fc.shuffledSubarray(rects, { minLength: rects.length })),
          ),
        ([rects, shuffled]) => {
          const a = orderTargets(rects.map((rect, i) => ({ i, rect })));
          expect(a.map((t) => t.i).sort((p, q) => p - q)).toEqual(rects.map((_, i) => i));
          const b = orderTargets(shuffled.map((rect) => ({ rect })));
          expect(b.map((t) => t.rect)).toEqual(a.map((t) => t.rect));
        },
      ),
    );
  });
});

/** 12 targets in reading order: one row of 12. */
const twelve = Array.from({ length: 12 }, (_, i) => ({ id: i, rect: r(i * 50, 0) }));
const key = (k) => parseKey(k);
/** Feed space-separated keys; return the last { state, result } and all results. */
function feed(state, keys) {
  const results = [];
  for (const k of keys.split(" ")) {
    const out = hintKey(state, key(k));
    state = out.state;
    results.push(out.result);
  }
  return { state, results };
}

describe("hint mode", () => {
  test("HINT_ACTIONS are action ids in actions.mjs", () => {
    const ids = new Set(ACTIONS.map((a) => a.id));
    expect(HINT_ACTIONS).toEqual(["hint.follow", "hint.follow_new_tab", "hint.element"]);
    for (const id of HINT_ACTIONS) expect(ids.has(id)).toBe(true);
  });

  test("startHints labels targets in reading order with the shortest labels first", () => {
    const shuffled = [...twelve].reverse();
    const s = startHints(shuffled, { action: "hint.follow" });
    expect(s.typed).toBe("");
    expect(s.action).toBe("hint.follow");
    expect(s.hints.map((h) => h.target.id)).toEqual(twelve.map((t) => t.id));
    expect(s.hints.map((h) => h.label)).toEqual(hintLabels(12));
  });

  test("Given 12 targets, when l then s, then narrow to 4 and select the second l… target", () => {
    const s = startHints(twelve, { action: "hint.follow" });
    const { state, results } = feed(s, "l s");
    expect(results[0]).toEqual({ kind: "narrow", visible: 4 });
    expect(results[1]).toEqual({
      kind: "select",
      action: "hint.follow",
      target: twelve[9],
      label: "ls",
    });
    expect(state.typed).toBe("ls");
  });

  test("F's action is carried by the selection", () => {
    const s = startHints(twelve, { action: "hint.follow_new_tab" });
    expect(hintKey(s, key("a")).result).toMatchObject({
      kind: "select",
      action: "hint.follow_new_tab",
      target: twelve[0],
    });
  });

  test("element focus is a hint action, carried by the selection", () => {
    const s = startHints(twelve, { action: "hint.element" });
    expect(hintKey(s, key("a")).result).toMatchObject({
      kind: "select",
      action: "hint.element",
      target: twelve[0],
    });
  });

  test("text blocks order by their first visible line, not by their whole box", () => {
    // A tall paragraph on the left whose box reaches past two short ones on the right: its
    // first line is in the first row, the right column's second block in the second.
    const blocks = [
      { id: "right2", rect: { x: 300, y: 60, width: 200, height: 16 } },
      { id: "left", rect: { x: 0, y: 0, width: 280, height: 16 } },
      { id: "right1", rect: { x: 300, y: 2, width: 200, height: 16 } },
    ];
    expect(orderTargets(blocks).map((b) => b.id)).toEqual(["left", "right1", "right2"]);
  });

  test("an unknown action is bad-action; zero targets is no-targets", () => {
    expect(() => startHints(twelve, { action: "hint.yank" })).toThrow(
      expect.objectContaining({ code: "bad-action" }),
    );
    expect(() => startHints([], { action: "hint.follow" })).toThrow(
      expect.objectContaining({ code: "no-targets" }),
    );
  });

  test("a single target still gets a label", () => {
    const s = startHints([twelve[0]], { action: "hint.follow" });
    expect(s.hints).toEqual([{ label: "a", target: twelve[0] }]);
  });

  test("custom chars are used", () => {
    const s = startHints(twelve.slice(0, 3), { action: "hint.follow", chars: "jk" });
    expect(s.hints.map((h) => h.label)).toEqual(["j", "kj", "kk"]);
    expect(hintKey(s, key("k")).result).toEqual({ kind: "narrow", visible: 2 });
  });

  test("Backspace removes the last typed key; with nothing typed it is ignored", () => {
    const s = startHints(twelve, { action: "hint.follow" });
    const { state, results } = feed(s, "l backspace backspace");
    expect(results[1]).toEqual({ kind: "narrow", visible: 12 });
    expect(results[2]).toEqual({ kind: "ignored" });
    expect(state.typed).toBe("");
    expect(visibleHints(state)).toHaveLength(12);
  });

  test.each(["z", "ctrl+a", "alt+l", "meta+l", "1", "enter", "space"])(
    "%s is ignored and the state is unchanged",
    (k) => {
      const s = startHints(twelve, { action: "hint.follow" });
      const out = hintKey(s, key(k));
      expect(out.result).toEqual({ kind: "ignored" });
      expect(out.state).toBe(s);
    },
  );

  test("a label key that matches nothing after l is ignored (typo-safe)", () => {
    const s = feed(startHints(twelve, { action: "hint.follow" }), "l").state;
    const out = hintKey(s, key("k"));
    expect(out.result).toEqual({ kind: "ignored" });
    expect(out.state).toBe(s);
    expect(visibleHints(s).map((h) => h.label)).toEqual(["la", "ls", "ld", "lf"]);
  });

  test("shift+a selects a (caps lock); Esc cancels; shift+esc is ignored", () => {
    const s = startHints(twelve, { action: "hint.follow" });
    expect(hintKey(s, key("shift+a")).result).toMatchObject({ kind: "select", label: "a" });
    expect(hintKey(s, key("A")).result).toMatchObject({ kind: "select", label: "a" });
    expect(hintKey(s, key("esc"))).toEqual({ state: s, result: { kind: "cancel" } });
    expect(hintKey(s, key("shift+esc")).result).toEqual({ kind: "ignored" });
  });

  test("a non-letter label character such as ; works", () => {
    const s = startHints(twelve.slice(0, 2), { action: "hint.follow", chars: "a;" });
    expect(hintKey(s, key(";")).result).toMatchObject({ kind: "select", label: ";" });
  });

  test("states are frozen and never mutated", () => {
    const s = startHints(twelve, { action: "hint.follow" });
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.hints)).toBe(true);
    hintKey(s, key("l"));
    expect(s.typed).toBe("");
  });
});

describe("parseHintReply: untrusted Vimma:CollectHints replies from a content process", () => {
  const rect = { x: 10, y: 20, width: 30, height: 12 };
  const good = {
    targets: [
      { id: 0, rect, kind: "link", href: "https://example.com/" },
      { id: 1, rect, kind: "input" },
      { id: 2, rect, kind: "click" },
    ],
    frames: [{ id: 42, rect }],
    ms: 3.5,
  };

  test("the caps are 5,000 targets, 64 frames and 8 KiB hrefs", () => {
    expect([HINT_REPLY_MAX_TARGETS, HINT_REPLY_MAX_FRAMES, HINT_REPLY_MAX_HREF]).toEqual([
      5000, 64, 8192,
    ]);
  });

  test("a well-formed reply → a fresh copy with only the known fields", () => {
    const extra = {
      ...good,
      evil: 1,
      targets: good.targets.map((t) => ({ ...t, label: "x", rect: { ...t.rect, z: 1 } })),
    };
    const parsed = parseHintReply(extra);
    expect(parsed).toEqual(good);
    expect(parsed?.targets[0]?.rect).not.toBe(extra.targets[0]?.rect);
  });

  test("an empty frame is fine", () => {
    expect(parseHintReply({ targets: [], frames: [], ms: 0 })).toEqual({
      targets: [],
      frames: [],
      ms: 0,
    });
  });

  const t0 = good.targets[0];
  test.each([
    ["null", null],
    ["an array", []],
    ["no ms", { targets: [], frames: [] }],
    ["ms not finite", { ...good, ms: Infinity }],
    ["a negative ms", { ...good, ms: -1 }],
    ["targets not an array", { ...good, targets: {} }],
    ["frames not an array", { ...good, frames: "x" }],
    [
      "too many targets",
      { ...good, targets: Array.from({ length: 5001 }, (_, id) => ({ ...t0, id })) },
    ],
    ["too many frames", { ...good, frames: Array.from({ length: 65 }, (_, id) => ({ id, rect })) }],
    ["a duplicate id", { ...good, targets: [t0, t0] }],
    ["a negative id", { ...good, targets: [{ ...t0, id: -1 }] }],
    ["a fractional id", { ...good, targets: [{ ...t0, id: 0.5 }] }],
    ["an unknown kind", { ...good, targets: [{ ...t0, kind: "script" }] }],
    ["a NaN coordinate", { ...good, targets: [{ ...t0, rect: { ...rect, x: NaN } }] }],
    ["a huge coordinate", { ...good, targets: [{ ...t0, rect: { ...rect, y: 1e7 } }] }],
    ["a zero width", { ...good, targets: [{ ...t0, rect: { ...rect, width: 0 } }] }],
    ["a string height", { ...good, targets: [{ ...t0, rect: { ...rect, height: "9" } }] }],
    ["an href not a string", { ...good, targets: [{ ...t0, href: 1 }] }],
    [
      "a block with no blockKind",
      { ...good, targets: [{ id: 0, rect, kind: "block", box: rect }] },
    ],
    [
      "a block with an unknown blockKind",
      { ...good, targets: [{ id: 0, rect, kind: "block", blockKind: "script", box: rect }] },
    ],
    [
      "a block with no box",
      { ...good, targets: [{ id: 0, rect, kind: "block", blockKind: "paragraph" }] },
    ],
    [
      "a block with a non-finite box",
      {
        ...good,
        targets: [
          { id: 0, rect, kind: "block", blockKind: "paragraph", box: { ...rect, x: Infinity } },
        ],
      },
    ],
    ["a blockKind on a link", { ...good, targets: [{ ...t0, blockKind: "paragraph" }] }],
    ["a long href", { ...good, targets: [{ ...t0, href: "h".repeat(8193) }] }],
    ["a frame id not an integer", { ...good, frames: [{ id: "42", rect }] }],
    [
      "a duplicate frame id",
      {
        ...good,
        frames: [
          { id: 42, rect },
          { id: 42, rect },
        ],
      },
    ],
    ["a negative frame id", { ...good, frames: [{ id: -1, rect }] }],
    ["a frame with no rect", { ...good, frames: [{ id: 42 }] }],
  ])("%s → null", (_, value) => {
    expect(parseHintReply(value)).toBeNull();
  });

  test("a block target needs a kind from the closed list and a finite box", () => {
    const block = { id: 0, rect, kind: "block", blockKind: "code", box: rect };
    expect(
      parseHintReply({ targets: [block], frames: [], ms: 0 }, { blocks: true })?.targets,
    ).toEqual([block]);
    for (const bad of [
      { ...block, blockKind: "script" },
      { ...block, blockKind: undefined },
      { ...block, box: undefined },
      { ...block, box: { ...rect, width: NaN } },
    ]) {
      expect(parseHintReply({ targets: [bad], frames: [], ms: 0 }, { blocks: true })).toBeNull();
    }
  });

  test("only a block target carries a blockKind or a box", () => {
    for (const bad of [
      { ...t0, blockKind: "paragraph" },
      { ...t0, box: rect },
    ]) {
      expect(parseHintReply({ targets: [bad], frames: [], ms: 0 })).toBeNull();
    }
  });

  test("a block target carries no href", () => {
    const block = { id: 0, rect, kind: "block", blockKind: "code", box: rect, href: "https://x/" };
    expect(parseHintReply({ targets: [block], frames: [], ms: 0 }, { blocks: true })).toBeNull();
  });

  test("a reply holds only the kind of target its collection asked for", () => {
    const block = { id: 0, rect, kind: "block", blockKind: "code", box: rect };
    const links = { targets: [t0], frames: [], ms: 0 };
    const blocks = { targets: [block], frames: [], ms: 0 };
    expect(parseHintReply(links)).not.toBeNull();
    expect(parseHintReply(blocks, { blocks: true })).not.toBeNull();
    expect(parseHintReply(blocks)).toBeNull();
    expect(parseHintReply(links, { blocks: true })).toBeNull();
  });

  test("a throwing getter → null, not an exception", () => {
    const hostile = {
      ...good,
      get targets() {
        throw new Error("boom");
      },
    };
    expect(parseHintReply(hostile)).toBeNull();
  });
});

describe("parseBlockReply: untrusted Vimma:Block replies from a content process", () => {
  const box = { x: 8, y: -40, width: 300, height: 120 };
  const moved = { kind: "paragraph", length: 412, box };

  test.each(["focus", "parent", "child", "next", "prev"])(
    "%s: a kind from the closed list, a length and a box",
    (op) => {
      expect(parseBlockReply(moved, op)).toEqual(moved);
      expect(parseBlockReply({ ...moved, extra: "dropped", box: { ...box, z: 1 } }, op)).toEqual(
        moved,
      );
    },
  );

  test.each([
    ["an unknown kind", { ...moved, kind: "script" }],
    ["no kind", { ...moved, kind: undefined }],
    ["a negative length", { ...moved, length: -1 }],
    ["a fractional length", { ...moved, length: 1.5 }],
    ["a length past the cap", { ...moved, length: BLOCK_REPLY_MAX_TEXT + 1 }],
    ["a non-finite box", { ...moved, box: { ...box, x: Infinity } }],
    ["a box far off any screen", { ...moved, box: { ...box, y: 1e7 } }],
    ["an empty box", { ...moved, box: { ...box, width: 0 } }],
    ["no box", { ...moved, box: undefined }],
    ["a string", "paragraph"],
    ["an array", [moved]],
    ["null", null],
  ])("a move with %s → null", (_, value) => {
    expect(parseBlockReply(value, "focus")).toBeNull();
  });

  test("rect: the block's box; frame: a subframe's viewport", () => {
    expect(parseBlockReply({ box, kind: "x" }, "rect")).toEqual({ box });
    expect(parseBlockReply({ rect: box }, "frame")).toEqual({ rect: box });
    expect(parseBlockReply({ box: { ...box, height: NaN } }, "rect")).toBeNull();
    expect(parseBlockReply({ rect: null }, "frame")).toBeNull();
  });

  test("yank: the text, and whether the page marks it unselectable", () => {
    expect(parseBlockReply({ text: "a\tb", unselectable: false, x: 1 }, "yank")).toEqual({
      text: "a\tb",
      unselectable: false,
    });
    expect(parseBlockReply({ text: "", unselectable: true }, "yank")).toEqual({
      text: "",
      unselectable: true,
    });
    expect(parseBlockReply({ text: 3, unselectable: false }, "yank")).toBeNull();
    expect(parseBlockReply({ text: "a", unselectable: "no" }, "yank")).toBeNull();
    const long = "x".repeat(BLOCK_REPLY_MAX_TEXT + 1);
    expect(parseBlockReply({ text: long, unselectable: false }, "yank")).toBeNull();
  });

  test("select: whether the page marks the block unselectable", () => {
    expect(parseBlockReply({ unselectable: true }, "select")).toEqual({ unselectable: true });
    expect(parseBlockReply({ unselectable: 1 }, "select")).toBeNull();
  });

  test("an unknown op → null", () => {
    expect(parseBlockReply(moved, "click")).toBeNull();
    expect(parseBlockReply(moved, "__proto__")).toBeNull();
  });

  test("a throwing getter → null, not an exception", () => {
    const hostile = {
      ...moved,
      get kind() {
        throw new Error("boom");
      },
    };
    expect(parseBlockReply(hostile, "next")).toBeNull();
  });
});
