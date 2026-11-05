// docs/specs/multiple-splits.md: several splits per workspace, one shown at a time.
import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { closePane, createRow, hideView, leaves, paneOfTab, split } from "../src/panes.mjs";
import {
  MAX_SPLITS_DEFAULT,
  NO_SPLITS_TO_PICK,
  MAX_SPLITS_LIMIT,
  SplitsError,
  createSplits,
  endSplit,
  hiddenSplitRefusal,
  newSplit,
  removeSplitTab,
  selectSplitTab,
  showSplit,
  shownSplit,
  splitLabel,
  splitFocusTab,
  splitOfTab,
  splitPickerItems,
  splitsFromPanes,
  stepSplit,
  updateSplit,
} from "../src/splits.mjs";

/** @import { Splits } from "../src/splits.mjs" */

/** @param {Splits} s */
const numbers = (s) => s.splits.map((x) => x.number);
/** @param {Splits} s @param {number} n */
const tabsOf = (s, n) =>
  leaves(/** @type {any} */ (s.splits.find((x) => x.number === n))).map((l) => l.tab);

/**
 * Splits made one after the other from the side panel's marks.
 * @param {string[][]} groups
 * @param {{ max?: number }} [options]
 */
function made(groups, options = {}) {
  let s = createSplits();
  for (const tabs of groups) {
    const r = newSplit(s, tabs, options);
    expect(r.refusal).toBeNull();
    s = r.splits;
  }
  return s;
}

/** @param {() => unknown} fn @param {string} code */
function expectSplitsError(fn, code) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(SplitsError);
  expect(/** @type {SplitsError} */ (err).code).toBe(code);
}

describe("numbers (decision 8)", () => {
  test("defaults: nine splits at most, labels S1 to S9", () => {
    expect(MAX_SPLITS_DEFAULT).toBe(9);
    expect(MAX_SPLITS_LIMIT).toBe(9);
    expect(createSplits()).toEqual({ splits: [], shown: null, last: null });
    expect(splitLabel(2)).toBe("S2");
  });

  test("a new split takes the lowest free number and is shown at once", () => {
    const s = made([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(numbers(s)).toEqual([1, 2]);
    expect(s.shown).toBe(2);
    expect(s.last).toBe(2);
    expect(shownSplit(s)?.number).toBe(2);
  });

  test("a split ending frees its number, and the next new split takes it", () => {
    let s = made([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
    s = endSplit(s, 2);
    expect(numbers(s)).toEqual([1, 3]);
    s = /** @type {any} */ (newSplit(s, ["g", "h"])).splits;
    expect(numbers(s)).toEqual([1, 2, 3]);
    expect(s.shown).toBe(2);
    expect(tabsOf(s, 2)).toEqual(["g", "h"]);
  });

  test("numbers are kept while a split exists: ending split 1 does not renumber the others", () => {
    const s = endSplit(
      made([
        ["a", "b"],
        ["c", "d"],
      ]),
      1,
    );
    expect(numbers(s)).toEqual([2]);
    expect(s.shown).toBe(2);
  });

  test("ending the shown split leaves none shown; ending the last-shown forgets it", () => {
    const s = endSplit(
      made([
        ["a", "b"],
        ["c", "d"],
      ]),
      2,
    );
    expect(s.shown).toBeNull();
    expect(s.last).toBeNull();
    expectSplitsError(() => endSplit(s, 2), "unknown-split");
  });

  test("the result is frozen, and the input is not changed", () => {
    const before = made([["a", "b"]]);
    const after = /** @type {any} */ (newSplit(before, ["c", "d"])).splits;
    expect(Object.isFrozen(after)).toBe(true);
    expect(Object.isFrozen(after.splits)).toBe(true);
    expect(numbers(before)).toEqual([1]);
  });
});

describe("selecting a tab (behaviour 2)", () => {
  test("a tab of split 1 shows split 1, focuses its pane and hides split 2", () => {
    const s = made([
      ["a", "b"],
      ["c", "d"],
    ]);
    const r = selectSplitTab(s, "a");
    expect(r.change).toBe("show");
    expect(r.splits.shown).toBe(1);
    expect(r.splits.last).toBe(1);
    const one = /** @type {any} */ (shownSplit(r.splits));
    expect(one.focus).toBe(paneOfTab(one, "a"));
  });

  test("a tab of the shown split focuses its pane; its focused tab changes nothing", () => {
    const s = made([["a", "b"]]);
    const focused = /** @type {any} */ (shownSplit(s));
    const other = leaves(focused).find((l) => l.pane !== focused.focus)?.tab ?? "";
    const r = selectSplitTab(s, other);
    expect(r.change).toBe("focus");
    expect(shownSplit(r.splits)?.focus).toBe(paneOfTab(focused, other));
    const again = selectSplitTab(r.splits, other);
    expect(again.change).toBe("none");
    expect(again.splits).toBe(r.splits);
  });

  test("a tab in no split hides every split and keeps the shown one as the last", () => {
    const s = made([
      ["a", "b"],
      ["c", "d"],
    ]);
    const r = selectSplitTab(s, "z");
    expect(r.change).toBe("hide");
    expect(r.splits.shown).toBeNull();
    expect(r.splits.last).toBe(2);
    expect(selectSplitTab(r.splits, "y")).toEqual({ splits: r.splits, change: "none" });
  });

  test("showing a split keeps its tree, sizes, zoom and focused pane", () => {
    let s = made([["a", "b", "c"]], {});
    const tree = split(/** @type {any} */ (shownSplit(s)), "p1", "horizontal", "x");
    s = updateSplit(s, 1, tree);
    s = /** @type {any} */ (newSplit(s, ["d", "e"])).splits;
    s = selectSplitTab(s, "z").splits;
    const back = showSplit(s, 1);
    const shown = /** @type {any} */ (shownSplit(back));
    expect(shown.root).toBe(tree.root);
    expect(shown.focus).toBe(tree.focus);
    expect(shown.zoom).toBe(tree.zoom);
    expect(shown.number).toBe(1);
    expectSplitsError(() => showSplit(s, 7), "unknown-split");
  });

  test("splitOfTab names a tab's split; a tab in none has none", () => {
    const s = made([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(splitOfTab(s, "c")?.number).toBe(2);
    expect(splitOfTab(s, "z")).toBeUndefined();
  });
});

describe("a new split from marked tabs (behaviour 5, decision 6)", () => {
  test("a marked tab of another split moves: its pane closes there as closePane closes it", () => {
    let s = made([["a", "b", "c"]]);
    const before = /** @type {any} */ (shownSplit(s));
    s = /** @type {any} */ (newSplit(s, ["b", "z"])).splits;
    expect(numbers(s)).toEqual([1, 2]);
    expect(tabsOf(s, 1)).toEqual(["a", "c"]);
    expect(tabsOf(s, 2)).toEqual(["b", "z"]);
    const one = /** @type {any} */ (s.splits[0]);
    expect(one.root).toEqual(
      closePane(before, /** @type {string} */ (paneOfTab(before, "b"))).root,
    );
  });

  test("split 1 left with one pane ends and frees number 1", () => {
    let s = made([["a", "b"]]);
    s = /** @type {any} */ (newSplit(s, ["b", "z"])).splits;
    expect(numbers(s)).toEqual([1]);
    expect(tabsOf(s, 1)).toEqual(["b", "z"]);
    expect(s.shown).toBe(1);
  });

  test("the new split's focus is the tab asked for, else its first", () => {
    const s = /** @type {any} */ (newSplit(createSplits(), ["a", "b"], { focus: "b" })).splits;
    expect(shownSplit(s)?.focus).toBe(paneOfTab(/** @type {any} */ (shownSplit(s)), "b"));
    const t = /** @type {any} */ (newSplit(createSplits(), ["a", "b"])).splits;
    expect(shownSplit(t)?.focus).toBe(paneOfTab(/** @type {any} */ (shownSplit(t)), "a"));
  });

  test("fewer than two tabs, or a tab twice, is an error", () => {
    expectSplitsError(() => newSplit(createSplits(), ["a"]), "bad-tabs");
    expectSplitsError(() => newSplit(createSplits(), ["a", "a"]), "bad-tabs");
  });

  test("the tenth split is refused with behaviour 5's text and nothing changes", () => {
    const groups = Array.from({ length: 9 }, (_, i) => [`a${i}`, `b${i}`]);
    const s = made(groups);
    expect(numbers(s)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const r = newSplit(s, ["x", "y"]);
    expect(r.refusal).toBe("new split: at most 9 splits in a workspace");
    expect(r.splits).toBe(s);
  });

  test("a lower max_splits refuses sooner, in its own words", () => {
    const s = made(
      [
        ["a", "b"],
        ["c", "d"],
      ],
      { max: 2 },
    );
    expect(newSplit(s, ["x", "y"], { max: 2 }).refusal).toBe(
      "new split: at most 2 splits in a workspace",
    );
  });

  test("at the limit, a new split that ends another by taking its tabs is not refused", () => {
    const s = made(
      [
        ["a", "b"],
        ["c", "d"],
      ],
      { max: 2 },
    );
    const r = newSplit(s, ["a", "x"], { max: 2 });
    expect(r.refusal).toBeNull();
    expect(numbers(r.splits)).toEqual([1, 2]);
    expect(tabsOf(r.splits, 1)).toEqual(["a", "x"]);
  });

  test("max_splits = 1 gives today's single split: a new one replaces it", () => {
    const s = made([["a", "b"]], { max: 1 });
    const r = newSplit(s, ["c", "d"], { max: 1 });
    expect(r.refusal).toBeNull();
    expect(numbers(r.splits)).toEqual([1]);
    expect(tabsOf(r.splits, 1)).toEqual(["c", "d"]);
    expect(r.splits.shown).toBe(1);
  });

  test("max outside 1 to 9 is an error", () => {
    for (const max of [0, 10, 1.5, Number.NaN]) {
      expectSplitsError(() => newSplit(createSplits(), ["a", "b"], { max }), "bad-max");
    }
  });
});

describe("stepping (behaviour 8)", () => {
  test("]s goes to the next split by number and wraps; [s the previous", () => {
    let s = made([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
    s = showSplit(s, 1);
    const order = [];
    for (let i = 0; i < 4; i++) {
      s = stepSplit(s, 1).splits;
      order.push(s.shown);
    }
    expect(order).toEqual([2, 3, 1, 2]);
    s = stepSplit(s, -1).splits;
    s = stepSplit(s, -1).splits;
    expect(s.shown).toBe(3);
  });

  test("numbers with gaps are stepped in order", () => {
    let s = endSplit(
      made([
        ["a", "b"],
        ["c", "d"],
        ["e", "f"],
      ]),
      2,
    );
    s = showSplit(s, 1);
    expect(stepSplit(s, 1).splits.shown).toBe(3);
    expect(stepSplit(s, -1).splits.shown).toBe(3);
  });

  test("from a lone tab, both directions show the split shown last first", () => {
    let s = made([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
    s = selectSplitTab(showSplit(s, 2), "z").splits;
    expect(stepSplit(s, 1).splits.shown).toBe(2);
    expect(stepSplit(s, -1).splits.shown).toBe(2);
  });

  test("from a lone tab with no split shown before, the first in that direction", () => {
    const s = Object.freeze({
      ...made([
        ["a", "b"],
        ["c", "d"],
      ]),
      shown: null,
      last: null,
    });
    expect(stepSplit(s, 1).splits.shown).toBe(1);
    expect(stepSplit(s, -1).splits.shown).toBe(2);
  });

  test("with no split: refused with 'no splits', nothing changes", () => {
    const s = createSplits();
    expect(stepSplit(s, 1)).toEqual({ splits: s, refusal: "no splits" });
  });
});

describe("changing a split's tree", () => {
  test("updateSplit replaces the tree and keeps the number", () => {
    const s = made([["a", "b"]]);
    const tree = split(/** @type {any} */ (shownSplit(s)), "p1", "vertical", "c");
    const t = updateSplit(s, 1, tree);
    expect(tabsOf(t, 1).sort()).toEqual(["a", "b", "c"]);
    expect(t.splits[0]?.number).toBe(1);
  });

  test("a tree left with one pane ends the split", () => {
    const s = made([["a", "b"]]);
    const one = closePane(/** @type {any} */ (shownSplit(s)), "p2");
    expect(updateSplit(s, 1, one)).toEqual(createSplits());
  });

  test("a tree with a tab of another split is an error", () => {
    const s = made([
      ["a", "b"],
      ["c", "d"],
    ]);
    expectSplitsError(() => updateSplit(s, 1, createRow(["a", "c"])), "bad-tabs");
  });

  test("a hidden flag from a single-split tree is not kept", () => {
    const s = made([["a", "b"]]);
    const t = updateSplit(s, 1, hideView(/** @type {any} */ (shownSplit(s))));
    expect(t.splits[0]).not.toHaveProperty("hidden");
  });
});

describe("a tab closing", () => {
  test("closes its pane; a split left with one pane ends", () => {
    let s = made([
      ["a", "b", "c"],
      ["d", "e"],
    ]);
    s = removeSplitTab(s, "b");
    expect(tabsOf(s, 1)).toEqual(["a", "c"]);
    s = removeSplitTab(s, "d");
    expect(numbers(s)).toEqual([1]);
    expect(s.shown).toBeNull();
    expect(removeSplitTab(s, "zz")).toBe(s);
  });
});

describe("a snapshot's single tree (decision 15)", () => {
  test("a split tree reads as split 1, shown unless hidden", () => {
    const tree = createRow(["a", "b"]);
    expect(splitsFromPanes(tree)).toMatchObject({ shown: 1, last: 1 });
    expect(numbers(splitsFromPanes(tree))).toEqual([1]);
    expect(splitsFromPanes(hideView(tree))).toMatchObject({ shown: null, last: 1 });
    expect(splitsFromPanes(hideView(tree)).splits[0]).not.toHaveProperty("hidden");
  });

  test("one pane or none is no split", () => {
    expect(splitsFromPanes(createRow(["a"]))).toEqual(createSplits());
    expect(splitsFromPanes(null)).toEqual(createSplits());
  });
});

describe("invariants", () => {
  test("property: a tab is in one split at most, numbers are 1-9, unique and in order", () => {
    const tabs = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const op = fc.oneof(
      fc.record({
        kind: fc.constant("new"),
        tabs: fc.uniqueArray(fc.constantFrom(...tabs), { minLength: 2, maxLength: 4 }),
      }),
      fc.record({ kind: fc.constant("select"), tab: fc.constantFrom(...tabs, "z") }),
      fc.record({ kind: fc.constant("close"), tab: fc.constantFrom(...tabs) }),
      fc.record({ kind: fc.constant("step"), by: fc.constantFrom(1, -1) }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 30 }), fc.integer({ min: 1, max: 9 }), (ops, max) => {
        let s = createSplits();
        for (const o of ops) {
          if (o.kind === "new") s = newSplit(s, o.tabs, { max }).splits;
          else if (o.kind === "select") s = selectSplitTab(s, o.tab).splits;
          else if (o.kind === "close") s = removeSplitTab(s, o.tab);
          else s = stepSplit(s, o.by).splits;
          const seen = new Set();
          for (const x of s.splits) {
            expect(leaves(x).length).toBeGreaterThanOrEqual(2);
            for (const l of leaves(x)) {
              expect(seen.has(l.tab)).toBe(false);
              seen.add(l.tab);
            }
          }
          const ns = numbers(s);
          expect(ns).toEqual([...ns].sort((a, b) => a - b));
          expect(new Set(ns).size).toBe(ns.length);
          expect(ns.every((n) => n >= 1 && n <= max)).toBe(true);
          if (s.shown !== null) expect(ns).toContain(s.shown);
          if (s.last !== null) expect(ns).toContain(s.last);
        }
      }),
    );
  });
});

describe("hiddenSplitRefusal (decision 4)", () => {
  test("names the split shown last and the way back, before the split keys exist", () => {
    expect(hiddenSplitRefusal(2)).toBe(
      "split S2 is hidden: select one of its tabs (ctrl+b b) to go back, or mark tabs there for a new split",
    );
  });
});

describe("the split picker's rows (behaviour 7, decision 12)", () => {
  const titles = /** @type {Record<string, string>} */ ({
    a: "Editor",
    b: "PDF",
    c: "Search",
    d: "Docs",
    e: "Notes",
  });
  const titleOf = (/** @type {string} */ id) => titles[id] ?? "";

  test("one row per split in number order: label, pane count, titles; the shown one active", () => {
    const s = showSplit(
      made([
        ["a", "b"],
        ["c", "d", "e"],
      ]),
      1,
    );
    const items = splitPickerItems(s, titleOf);
    expect(items).toEqual([
      {
        kind: "split",
        splitId: "1",
        number: 1,
        label: "S1",
        paneCount: 2,
        display: "Editor · PDF",
        active: true,
      },
      {
        kind: "split",
        splitId: "2",
        number: 2,
        label: "S2",
        paneCount: 3,
        display: "Search · Docs · Notes",
        active: false,
      },
    ]);
    expect(Object.isFrozen(items[0])).toBe(true);
  });

  test("on a lone tab no row is active; without splits there are none", () => {
    const s = selectSplitTab(made([["a", "b"]]), "z").splits;
    expect(splitPickerItems(s, titleOf).map((i) => i.active)).toEqual([false]);
    expect(splitPickerItems(createSplits(), titleOf)).toEqual([]);
    expect(NO_SPLITS_TO_PICK).toBe("no splits in this workspace");
  });

  test("a split is shown by selecting its focused pane's tab", () => {
    let s = made([
      ["a", "b"],
      ["c", "d"],
    ]);
    s = selectSplitTab(s, "d").splits;
    s = selectSplitTab(s, "a").splits;
    expect(splitFocusTab(s, 2)).toBe("d");
    expect(splitFocusTab(s, 1)).toBe("a");
    expect(splitFocusTab(s, 3)).toBeNull();
  });
});
