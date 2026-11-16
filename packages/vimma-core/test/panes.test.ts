import { describe, test, expect } from "vitest";
import fc from "fast-check";
import {
  createPanes,
  createRow,
  split,
  closePane,
  focus,
  focusPane,
  hideView,
  isHidden,
  pickTab,
  showView,
  swap,
  toggleZoom,
  resize,
  setPaneTab,
  layout,
  leaves,
  paneOfTab,
  splitRefusal,
  MIN_RATIO,
  PaneError,
  makeSplit,
} from "../src/panes/panes.mjs";

import type { Direction, LayoutRect, Leaf, PaneNode, Panes, Split } from "../src/panes/panes.mjs";

/** `value`, failing the test where it is missing. */
const defined = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("expected a value");
  return value;
};

/** The pane of leaf `pick`, counted round the leaves. */
const paneAt = (ls: readonly Leaf[], pick: number) => defined(ls[pick % ls.length]).pane;

/** A split's ratios; a leaf has none. */
const ratiosOf = (node: PaneNode | undefined) => (node?.type === "split" ? node.ratios : undefined);

/** A split's children; a leaf has none. */
const childrenOf = (node: PaneNode | undefined) =>
  node?.type === "split" ? node.children : undefined;

function shape(node: PaneNode): string {
  return node.type === "leaf" ? node.pane : `${node.axis}[${node.children.map(shape).join(",")}]`;
}

function expectPaneError(fn: () => unknown, code: string) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(PaneError);
  expect((err as PaneError).code).toBe(code);
}

/** x[p1, y[p2, p3]], focus on p3 */
function threePanes() {
  let s = createPanes("t1");
  s = split(s, "p1", "vertical", "t2");
  return split(s, "p2", "horizontal", "t3");
}

const RECT = { x: 0, y: 0, width: 100, height: 80 };

describe("split", () => {
  test("a single pane starts focused and unzoomed", () => {
    const s = createPanes("t1");
    expect(shape(s.root)).toBe("p1");
    expect(s.focus).toBe("p1");
    expect(s.zoom).toBeNull();
    expect(Object.isFrozen(s)).toBe(true);
  });

  test("split vertical puts the new pane to the right, 50/50, and focuses it", () => {
    const s = split(createPanes("t1"), "p1", "vertical", "t2");
    expect(shape(s.root)).toBe("x[p1,p2]");
    expect(s.root.type === "split" && s.root.ratios).toEqual([0.5, 0.5]);
    expect(s.focus).toBe("p2");
    expect(paneOfTab(s, "t2")).toBe("p2");
  });

  test("splitting along the parent's axis halves the pane's share instead of nesting", () => {
    let s = split(createPanes("t1"), "p1", "vertical", "t2");
    s = split(s, "p2", "vertical", "t3");
    expect(shape(s.root)).toBe("x[p1,p2,p3]");
    expect(s.root.type === "split" && s.root.ratios).toEqual([0.5, 0.25, 0.25]);
  });

  test("split horizontal across the parent's axis nests a y split", () => {
    expect(shape(threePanes().root)).toBe("x[p1,y[p2,p3]]");
  });

  test("the input state is not mutated", () => {
    const s = split(createPanes("t1"), "p1", "vertical", "t2");
    const before = JSON.stringify(s);
    split(s, "p1", "horizontal", "t3");
    expect(JSON.stringify(s)).toBe(before);
  });

  test("an unknown pane or a tab already shown is an error", () => {
    const s = createPanes("t1");
    expectPaneError(() => split(s, "p9", "vertical", "t2"), "unknown-pane");
    expectPaneError(() => split(s, "p1", "vertical", "t1"), "tab-shown");
    // @ts-expect-error bad direction
    expectPaneError(() => split(s, "p1", "diagonal", "t2"), "bad-direction");
  });
});

describe("closePane", () => {
  test("promotes the sibling when a split is left with one child", () => {
    const s = closePane(threePanes(), "p3");
    expect(shape(s.root)).toBe("x[p1,p2]");
    expect(s.focus).toBe("p2");
  });

  test("flattens a promoted split into a parent with the same axis", () => {
    let s = threePanes();
    s = split(s, "p3", "vertical", "t4");
    expect(shape(s.root)).toBe("x[p1,y[p2,x[p3,p4]]]");
    s = closePane(s, "p2");
    expect(shape(s.root)).toBe("x[p1,p3,p4]");
    expect(s.root.type === "split" && s.root.ratios).toEqual([0.5, 0.25, 0.25]);
  });

  test("gives the space to the previous sibling, or the next one if it was first", () => {
    let s = split(createPanes("t1"), "p1", "vertical", "t2");
    s = split(s, "p2", "vertical", "t3"); // [.5,.25,.25]
    const a = closePane(s, "p2");
    expect(a.root.type === "split" && a.root.ratios).toEqual([0.75, 0.25]);
    const b = closePane(s, "p1");
    expect(shape(b.root)).toBe("x[p2,p3]");
    expect(b.root.type === "split" && b.root.ratios).toEqual([0.75, 0.25]);
  });

  test("closing an unfocused pane keeps focus", () => {
    const s = closePane(threePanes(), "p1");
    expect(s.focus).toBe("p3");
    expect(shape(s.root)).toBe("y[p2,p3]");
  });

  test("focus goes to the first leaf of the absorbing sibling", () => {
    let s = threePanes();
    s = focusPane(s, "p1");
    s = closePane(s, "p1");
    expect(s.focus).toBe("p2");
  });

  test("closing the last pane is an error", () => {
    expectPaneError(() => closePane(createPanes("t1"), "p1"), "last-pane");
    expectPaneError(() => closePane(threePanes(), "p7"), "unknown-pane");
  });
});

describe("focus", () => {
  test.each([
    ["p3", "left", "p1"],
    ["p2", "left", "p1"],
    ["p1", "right", "p3"], // p2 and p3 both border p1; p3 was used more recently
    ["p2", "down", "p3"],
    ["p3", "up", "p2"],
    ["p1", "up", "p1"], // no wrap
    ["p1", "left", "p1"],
    ["p3", "right", "p3"],
    ["p3", "down", "p3"],
  ] as Array<[string, Direction, string]>)("from %s, focus %s → %s", (from, dir, to) => {
    const s = focusPane(threePanes(), from);
    const t = focus(s, dir);
    expect(t.focus).toBe(to);
    if (from === to) expect(t).toBe(s);
  });

  test("picks the most recently used of several bordering panes (tmux)", () => {
    // y[x[p1,p3], p2]: p2 spans the bottom, p1 and p3 both border its top edge
    let s = split(createPanes("t1"), "p1", "horizontal", "t3");
    s = split(s, "p1", "vertical", "t2");
    expect(shape(s.root)).toBe("y[x[p1,p3],p2]");
    expect(s.mru).toEqual(["p3", "p2", "p1"]);
    expect(focus(focusPane(s, "p2"), "up").focus).toBe("p3");
    s = focusPane(focusPane(s, "p1"), "p2");
    expect(s.mru).toEqual(["p2", "p1", "p3"]);
    expect(focus(s, "up").focus).toBe("p1");
  });

  test("left then right is a round trip: from p3 in x[p1, y[p2, p3]] back to p3", () => {
    const s = threePanes();
    const left = focus(s, "left");
    expect(left.focus).toBe("p1");
    expect(focus(left, "right").focus).toBe("p3");
    expect(focus(focus(focusPane(s, "p2"), "left"), "right").focus).toBe("p2");
  });

  test("closing a pane drops it from the MRU order", () => {
    expect(closePane(threePanes(), "p2").mru).toEqual(["p3", "p1"]);
  });

  test("a bad direction is an error", () => {
    // @ts-expect-error bad direction
    expectPaneError(() => focus(threePanes(), "north"), "bad-direction");
  });

  test("focusPane focuses a pane directly and rejects unknown ids", () => {
    expect(focusPane(threePanes(), "p1").focus).toBe("p1");
    expectPaneError(() => focusPane(threePanes(), "nope"), "unknown-pane");
  });
});

describe("swap", () => {
  test("exchanges the focused leaf with its neighbour; focus moves with the pane", () => {
    let s = split(createPanes("t1"), "p1", "vertical", "t2");
    s = focusPane(s, "p1");
    s = swap(s, "right");
    expect(shape(s.root)).toBe("x[p2,p1]");
    expect(s.focus).toBe("p1");
    expect(layout(s, RECT)[1]).toEqual({
      pane: "p1",
      tab: "t1",
      rect: { x: 50, y: 0, width: 50, height: 80 },
    });
  });

  test("works across nesting levels", () => {
    const s = swap(threePanes(), "left");
    expect(shape(s.root)).toBe("x[p3,y[p2,p1]]");
    expect(s.focus).toBe("p3");
  });

  test("without a neighbour the state is unchanged", () => {
    const s = threePanes();
    expect(swap(s, "right")).toBe(s);
  });
});

describe("zoom", () => {
  test("layout of a zoomed state is the focused pane alone, filling the rect", () => {
    const s = toggleZoom(split(createPanes("t1"), "p1", "vertical", "t2"));
    expect(s.zoom).toBe("p2");
    expect(layout(s, RECT)).toEqual([{ pane: "p2", tab: "t2", rect: RECT }]);
    expect(toggleZoom(s).zoom).toBeNull();
  });

  test("focus, split, close, swap and resize clear the zoom", () => {
    const z = toggleZoom(threePanes());
    expect(focus(z, "up").zoom).toBeNull();
    expect(focus(z, "up").focus).toBe("p2");
    expect(focusPane(z, "p1").zoom).toBeNull();
    expect(split(z, "p3", "vertical", "t9").zoom).toBeNull();
    expect(closePane(z, "p1").zoom).toBeNull();
    expect(swap(z, "left").zoom).toBeNull();
    expect(resize(z, "wider", 0.1).zoom).toBeNull();
  });

  test("a no-op focus, focusPane, swap, resize or refused split keeps the zoom", () => {
    const z = toggleZoom(threePanes()); // focus p3
    expect(focus(z, "right")).toBe(z);
    expect(focusPane(z, "p3")).toBe(z);
    expect(swap(z, "down")).toBe(z);
    const two = toggleZoom(split(createPanes("t1"), "p1", "vertical", "t2"));
    expect(resize(two, "taller", 0.1)).toBe(two);
    const atMax = toggleZoom(resize(two, "wider", 1));
    expect(resize(atMax, "wider", 0.1)).toBe(atMax);
    const full = toggleZoom(fourAcross());
    expect(split(full, "p4", "vertical", "t9")).toBe(full);
  });

  test("zooming a single pane is allowed and harmless", () => {
    const s = toggleZoom(createPanes("t1"));
    expect(layout(s, RECT)).toEqual([{ pane: "p1", tab: "t1", rect: RECT }]);
  });
});

/** x[p1 .5, p2 .25, p3 .125, p4 .125] (three `prefix+v`), focus on p4 */
function fourAcross() {
  let s = split(createPanes("t1"), "p1", "vertical", "t2");
  s = split(s, "p2", "vertical", "t3");
  return split(s, "p3", "vertical", "t4");
}

describe("split refusal (tmux: no space for new pane)", () => {
  test("a split that would leave a pane below MIN_RATIO returns the input unchanged", () => {
    const s = fourAcross();
    expect(ratiosOf(s.root)).toEqual([0.5, 0.25, 0.125, 0.125]);
    expect(split(s, "p4", "vertical", "t5")).toBe(s);
    expect(splitRefusal(s, "p4", "vertical")).toEqual({
      code: "no-space",
      message: expect.stringMatching(/no space/),
    });
  });

  test("the same pane can still split across, and a wide pane along, the axis", () => {
    const s = fourAcross();
    expect(splitRefusal(s, "p4", "horizontal")).toBeNull();
    expect(splitRefusal(s, "p1", "vertical")).toBeNull();
    expect(shape(split(s, "p4", "horizontal", "t5").root)).toBe("x[p1,p2,p3,y[p4,p5]]");
  });

  test("a split past `max` live panes is refused with max-panes, whatever the direction", () => {
    const s = threePanes();
    for (const dir of ["vertical", "horizontal"] as const) {
      expect(split(s, "p1", dir, "t9", { max: 3 })).toBe(s);
      expect(splitRefusal(s, "p1", dir, { max: 3 })).toEqual({
        code: "max-panes",
        message: "at most 3 panes",
      });
    }
    expect(leaves(split(s, "p1", "vertical", "t9", { max: 4 }))).toHaveLength(4);
    expect(splitRefusal(s, "p1", "vertical", { max: 4 })).toBeNull();
  });

  test("max 1 refuses every split; without max only MIN_RATIO limits", () => {
    const one = createPanes("t1");
    expect(splitRefusal(one, "p1", "vertical", { max: 1 })?.code).toBe("max-panes");
    expect(splitRefusal(one, "p1", "vertical")).toBeNull();
    expect(splitRefusal(fourAcross(), "p4", "horizontal", { max: Infinity })).toBeNull();
  });

  test("the pane count is checked before the space", () => {
    expect(splitRefusal(fourAcross(), "p4", "vertical", { max: 4 })?.code).toBe("max-panes");
    expect(splitRefusal(fourAcross(), "p4", "vertical", { max: 5 })?.code).toBe("no-space");
  });

  test.each([[0], [-1], [1.5], [NaN], ["4"]])("max = %s is bad-max", (max) => {
    const one = createPanes("t1");
    expectPaneError(() => split(one, "p1", "vertical", "t2", { max: max as any }), "bad-max");
    expectPaneError(() => splitRefusal(one, "p1", "vertical", { max: max as any }), "bad-max");
  });

  test("splitRefusal checks its arguments like split", () => {
    expectPaneError(() => splitRefusal(fourAcross(), "p9", "vertical"), "unknown-pane");
    // @ts-expect-error bad direction
    expectPaneError(() => splitRefusal(fourAcross(), "p1", "diagonal"), "bad-direction");
  });
});

describe("resize", () => {
  const two = () => focusPane(split(createPanes("t1"), "p1", "vertical", "t2"), "p1");
  const ratios = (s: Panes) => ratiosOf(s.root);

  test("wider grows the focused pane, taking from its next sibling", () => {
    expect(ratios(resize(two(), "wider", 0.1))).toEqual([0.6, 0.4]);
    expect(ratios(resize(two(), "narrower", 0.1))).toEqual([0.4, 0.6]);
  });

  test("the last child takes from its previous sibling", () => {
    const s = focusPane(two(), "p2");
    expect(ratios(resize(s, "wider", 0.1))).toEqual([0.4, 0.6]);
  });

  test("clamps at MIN_RATIO and 1 − MIN_RATIO instead of rejecting", () => {
    expect(ratios(resize(two(), "wider", 1))).toEqual([1 - MIN_RATIO, MIN_RATIO]);
    expect(ratios(resize(two(), "narrower", 1))).toEqual([MIN_RATIO, 1 - MIN_RATIO]);
    const atMax = resize(two(), "wider", 1);
    expect(resize(atMax, "wider", 0.1)).toBe(atMax);
  });

  test("borrows from further siblings, nearest first, when the neighbour is at MIN_RATIO", () => {
    const r = ratios(resize(fourAcross(), "wider", 0.3)); // p4 is last: p3, then p2, then p1
    [0.375, 0.1, 0.1, 0.425].forEach((v, i) => expect(r?.[i]).toBeCloseTo(v, 12));
    const mid = ratios(resize(focusPane(fourAcross(), "p3"), "wider", 0.1)); // p4, then p2
    [0.5, 0.175, 0.225, 0.1].forEach((v, i) => expect(mid?.[i]).toBeCloseTo(v, 12));
  });

  test("grows up to 1 − (n − 1)·MIN_RATIO when every sibling gives way", () => {
    const r = ratios(resize(fourAcross(), "wider", 1));
    [0.1, 0.1, 0.1, 0.7].forEach((v, i) => expect(r?.[i]).toBeCloseTo(v, 12));
  });

  test("without an ancestor on that axis the state is unchanged", () => {
    const s = two();
    expect(resize(s, "taller", 0.1)).toBe(s);
    expect(resize(s, "shorter", 0.1)).toBe(s);
  });

  test("resizes the nearest ancestor with the matching axis", () => {
    const s = resize(threePanes(), "narrower", 0.2); // p3 is inside y, inside x
    expect(ratios(s)).toEqual([0.7, 0.3]);
    const t = resize(threePanes(), "taller", 0.2);
    expect(ratiosOf(childrenOf(t.root)?.[1])).toEqual([0.3, 0.7]);
  });

  test("a bad direction or a non-positive amount is an error", () => {
    // @ts-expect-error bad direction
    expectPaneError(() => resize(two(), "fatter", 0.1), "bad-direction");
    expectPaneError(() => resize(two(), "wider", -0.1), "bad-amount");
  });
});

describe("layout, setPaneTab, leaves", () => {
  test("x[p1, y[p2, p3]] in a 100×80 rect", () => {
    expect(layout(threePanes(), RECT)).toEqual([
      { pane: "p1", tab: "t1", rect: { x: 0, y: 0, width: 50, height: 80 } },
      { pane: "p2", tab: "t2", rect: { x: 50, y: 0, width: 50, height: 40 } },
      { pane: "p3", tab: "t3", rect: { x: 50, y: 40, width: 50, height: 40 } },
    ]);
  });

  test("edges are rounded, not widths, so neighbours share an integer edge", () => {
    const s = split(split(createPanes("t1"), "p1", "vertical", "t2"), "p2", "vertical", "t3");
    // [.5, .25, .25] of 101 px: edges 0, 51 (50.5 rounds up), 76 (75.75), 101
    expect(layout(s, { x: 0, y: 0, width: 101, height: 10 }).map((l) => l.rect.x)).toEqual([
      0, 51, 76,
    ]);
    expect(layout(s, { x: 0, y: 0, width: 101, height: 10 }).map((l) => l.rect.width)).toEqual([
      51, 25, 25,
    ]);
    const exact = layout(s, { x: 0, y: 0, width: 101, height: 10 }, { round: false });
    expect(exact.map((l) => l.rect.x)).toEqual([0, 50.5, 75.75]);
  });

  test("setPaneTab shows another tab in a pane", () => {
    const s = setPaneTab(threePanes(), "p1", "t9");
    expect(paneOfTab(s, "t9")).toBe("p1");
    expect(paneOfTab(s, "t1")).toBeUndefined();
    expect(setPaneTab(s, "p1", "t9")).toBe(s);
    expectPaneError(() => setPaneTab(s, "p1", "t2"), "tab-shown");
    expectPaneError(() => setPaneTab(s, "p8", "t8"), "unknown-pane");
  });

  test("leaves are in reading order", () => {
    expect(leaves(threePanes()).map((l) => l.pane)).toEqual(["p1", "p2", "p3"]);
  });
});

describe("createRow (a split made outside Vimma, adopted: m4-split-panes sub-spec 6)", () => {
  test("tabs side by side with equal shares, focus on the given tab", () => {
    const s = createRow(["t1", "t2", "t3"], { focus: "t2" });
    expect(shape(s.root)).toBe("x[p1,p2,p3]");
    expect(leaves(s).map((l) => l.tab)).toEqual(["t1", "t2", "t3"]);
    expect(ratiosOf(s.root)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(s.focus).toBe("p2");
    expect(s.mru[0]).toBe("p2");
    expect(new Set(s.mru)).toEqual(new Set(["p1", "p2", "p3"]));
    expect(s.zoom).toBeNull();
    expect(s.next).toBe(4);
    expect(split(s, "p2", "vertical", "t4").focus).toBe("p4");
  });

  test("shares are normalised and clamped at MIN_RATIO", () => {
    expect(ratiosOf(createRow(["a", "b"], { ratios: [600, 400] }).root)).toEqual([0.6, 0.4]);
    const clamped = defined(ratiosOf(createRow(["a", "b"], { ratios: [0.97, 0.03] }).root));
    expect(clamped[1]).toBeCloseTo(MIN_RATIO);
    expect(clamped[0]).toBeCloseTo(1 - MIN_RATIO);
    const three = defined(ratiosOf(createRow(["a", "b", "c"], { ratios: [0.9, 0.05, 0.05] }).root));
    expect(three.every((r) => r >= MIN_RATIO - 1e-9)).toBe(true);
    expect(three.reduce((a, b) => a + b)).toBeCloseTo(1);
  });

  test("unusable shares fall back to equal ones; focus defaults to the first tab", () => {
    for (const ratios of [[1], [0, 1], [NaN, 1], [-1, 2]]) {
      const s = createRow(["a", "b"], { ratios });
      expect(ratiosOf(s.root)).toEqual([0.5, 0.5]);
      expect(s.focus).toBe("p1");
    }
    expect(createRow(["a", "b"], { focus: "zz" }).focus).toBe("p1");
  });

  test("one tab is one pane; none or a repeated tab is refused", () => {
    expect(createRow(["a"])).toEqual(createPanes("a"));
    expectPaneError(() => createRow([]), "bad-tabs");
    expectPaneError(() => createRow(["a", "a"]), "tab-shown");
  });
});

// --- properties --------------------------------------------------------------------------------

const DIRS = ["left", "down", "up", "right"] as const;
const RESIZES = ["wider", "narrower", "taller", "shorter"] as const;

const opArb = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      op: fc.constant("split"),
      pick: fc.nat(),
      dir: fc.constantFrom("vertical", "horizontal"),
    }),
  },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("close"), pick: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("focus"), dir: fc.constantFrom(...DIRS) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("swap"), dir: fc.constantFrom(...DIRS) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("zoom") }) },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant("resize"),
      dir: fc.constantFrom(...RESIZES),
      amount: fc.double({ min: 0.001, max: 1, noNaN: true }),
    }),
  },
);

type Op = typeof opArb extends fc.Arbitrary<infer T> ? T : never;

function run(ops: Op[]) {
  let s = createPanes("t0");
  let n = 1;
  for (const o of ops) {
    const ls = leaves(s);
    const target = paneAt(ls, "pick" in o ? o.pick : 0);
    switch (o.op) {
      case "split":
        s = split(s, target, o.dir, `t${n++}`); // may be refused (unchanged)
        break;
      case "close":
        if (ls.length > 1) s = closePane(s, target);
        break;
      case "focus":
        s = focus(s, o.dir);
        break;
      case "swap":
        s = swap(s, o.dir);
        break;
      case "zoom":
        s = toggleZoom(s);
        break;
      case "resize":
        s = resize(s, o.dir, o.amount);
        break;
    }
  }
  return s;
}

const stateArb = fc.array(opArb, { maxLength: 40 }).map(run);

/** The nearest split on `axis` above `pane`, and the index of the child holding it. */
function nearestSplit(
  root: PaneNode,
  pane: string,
  axis: "x" | "y",
): { node: Split; index: number } | null {
  let found: { node: Split; index: number } | null = null;
  const visit = (n: PaneNode): boolean => {
    if (n.type === "leaf") return n.pane === pane;
    for (let i = 0; i < n.children.length; i++) {
      if (visit(defined(n.children[i]))) {
        if (!found && n.axis === axis) found = { node: n, index: i };
        return true;
      }
    }
    return false;
  };
  visit(root);
  return found;
}

function walk(
  node: PaneNode,
  visit: (n: PaneNode, parent: Split | null) => void,
  parent: Split | null = null,
) {
  visit(node, parent);
  if (node.type === "split") for (const c of node.children) walk(c, visit, node);
}

describe("pane tree properties", () => {
  test("every split has ≥ 2 children, ratios ≥ MIN_RATIO summing to 1, in canonical form", () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        walk(s.root, (n, parent) => {
          if (n.type !== "split") return;
          expect(n.children.length).toBeGreaterThanOrEqual(2);
          expect(n.ratios.length).toBe(n.children.length);
          for (const r of n.ratios) expect(r).toBeGreaterThanOrEqual(MIN_RATIO - 1e-9);
          expect(Math.abs(n.ratios.reduce((a, b) => a + b, 0) - 1)).toBeLessThan(1e-9);
          if (parent && n.axis === parent.axis) {
            // the one exception: flattening would push a pane below MIN_RATIO
            const r = defined(parent.ratios[parent.children.indexOf(n)]);
            expect(n.ratios.some((cr: number) => cr * r < MIN_RATIO - 1e-9)).toBe(true);
          }
        });
      }),
    );
  });

  test("split never takes the leaf count past max; a refusal is exactly when it would", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.array(opArb, { maxLength: 40 }),
        (max, ops) => {
          let s = createPanes("t0");
          let n = 1;
          for (const o of ops) {
            const ls = leaves(s);
            const target = paneAt(ls, "pick" in o ? o.pick : 0);
            if (o.op === "split") {
              const refusal = splitRefusal(s, target, o.dir, { max });
              const t = split(s, target, o.dir, `t${n++}`, { max });
              expect(t === s).toBe(refusal !== null);
              if (ls.length >= max) expect(refusal?.code).toBe("max-panes");
              s = t;
            } else if (o.op === "close" && ls.length > 1) s = closePane(s, target);
            else if (o.op === "zoom") s = toggleZoom(s);
            else if (o.op === "focus") s = focus(s, o.dir);
            expect(leaves(s).length).toBeLessThanOrEqual(max);
          }
        },
      ),
    );
  });

  test("any pane can grow until its siblings reach MIN_RATIO; nothing goes below it", () => {
    fc.assert(
      fc.property(
        stateArb,
        fc.nat(),
        fc.constantFrom("wider", "taller"),
        fc.double({ min: 0.01, max: 0.5, noNaN: true }),
        (s0, pick, grow, step) => {
          const ls = leaves(s0);
          const p = paneAt(ls, pick);
          const axis = grow === "wider" ? "x" : "y";
          let s = focusPane(s0, p);
          if (!nearestSplit(s.root, p, axis)) return;
          for (let k = 0; k < 500; k++) {
            const t = resize(s, grow, step);
            if (t === s) break;
            s = t;
          }
          const found = nearestSplit(s.root, p, axis);
          if (!found) throw new Error("resizing lost the split");
          found.node.ratios.forEach((r, i) => {
            if (i !== found.index) expect(r).toBeLessThan(MIN_RATIO + 1e-9);
            expect(r).toBeGreaterThanOrEqual(MIN_RATIO - 1e-9);
          });
        },
      ),
    );
  });

  test("every leaf is reachable, pane and tab ids are unique, focus and zoom name existing leaves", () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        const panes: string[] = [];
        const tabs: string[] = [];
        walk(s.root, (n) => {
          if (n.type === "leaf") {
            panes.push(n.pane);
            tabs.push(n.tab);
          }
        });
        expect(leaves(s).map((l) => l.pane)).toEqual(panes);
        expect(new Set(panes).size).toBe(panes.length);
        expect(new Set(tabs).size).toBe(tabs.length);
        expect(panes).toContain(s.focus);
        if (s.zoom !== null) expect(panes).toContain(s.zoom);
        expect([...s.mru].sort()).toEqual([...panes].sort());
        expect(s.mru[0]).toBe(s.focus);
      }),
    );
  });

  test("closePane(split(s, p)) restores s exactly, with focus on p", () => {
    fc.assert(
      fc.property(stateArb, fc.nat(), fc.constantFrom("vertical", "horizontal"), (s, pick, dir) => {
        const ls = leaves(s);
        const p = paneAt(ls, pick);
        const t = split(s, p, dir, "fresh-tab");
        if (splitRefusal(s, p, dir)) {
          expect(t).toBe(s);
          return;
        }
        const back = closePane(t, t.focus);
        expect(back.root).toEqual(s.root);
        expect(back.focus).toBe(p);
      }),
    );
  });

  const rectArb = fc.record({
    x: fc.integer({ min: -500, max: 500 }),
    y: fc.integer({ min: -500, max: 500 }),
    width: fc.integer({ min: 1, max: 4000 }),
    height: fc.integer({ min: 1, max: 4000 }),
  });

  test("layout tiles the rect in integer pixels: inside it, areas sum to it, no gap or overlap", () => {
    fc.assert(
      fc.property(
        stateArb,
        rectArb,
        fc.array(
          fc.tuple(
            fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
            fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
          ),
          { minLength: 1, maxLength: 20 },
        ),
        (s, r, points) => {
          const ls = layout(s, r);
          let area = 0;
          for (const { rect } of ls) {
            for (const v of Object.values(rect)) expect(Number.isInteger(v)).toBe(true);
            expect(rect.width).toBeGreaterThanOrEqual(0);
            expect(rect.height).toBeGreaterThanOrEqual(0);
            expect(rect.x).toBeGreaterThanOrEqual(r.x);
            expect(rect.y).toBeGreaterThanOrEqual(r.y);
            expect(rect.x + rect.width).toBeLessThanOrEqual(r.x + r.width);
            expect(rect.y + rect.height).toBeLessThanOrEqual(r.y + r.height);
            area += rect.width * rect.height;
          }
          expect(area).toBe(r.width * r.height);
          for (const [u, v] of points) {
            const px = r.x + u * r.width;
            const py = r.y + v * r.height;
            // u < 1 can still round onto the far edge (-3 + 0.9999999999999998 === -2)
            if (px >= r.x + r.width || py >= r.y + r.height) continue;
            const hits = ls.filter(
              ({ rect }) =>
                px >= rect.x &&
                px < rect.x + rect.width &&
                py >= rect.y &&
                py < rect.y + rect.height,
            );
            expect(hits.length).toBe(1);
          }
        },
      ),
    );
  });

  test("focus(d) lands on the most recently used pane touching the d edge, or stays if none", () => {
    const unit = { x: 0, y: 0, width: 1, height: 1 };
    fc.assert(
      fc.property(stateArb, fc.constantFrom(...DIRS), (s0, d) => {
        const s = s0.zoom ? toggleZoom(s0) : s0;
        const rects = new Map(layout(s, unit, { round: false }).map((l) => [l.pane, l.rect]));
        const a = defined(rects.get(s.focus));
        const eps = 1e-9;
        const touches = (b: LayoutRect) => {
          const ov = (a0: number, a1: number, b0: number, b1: number) =>
            Math.min(a1, b1) - Math.max(a0, b0) > eps;
          if (d === "left")
            return (
              Math.abs(b.x + b.width - a.x) < eps && ov(a.y, a.y + a.height, b.y, b.y + b.height)
            );
          if (d === "right")
            return (
              Math.abs(a.x + a.width - b.x) < eps && ov(a.y, a.y + a.height, b.y, b.y + b.height)
            );
          if (d === "up")
            return (
              Math.abs(b.y + b.height - a.y) < eps && ov(a.x, a.x + a.width, b.x, b.x + b.width)
            );
          return Math.abs(a.y + a.height - b.y) < eps && ov(a.x, a.x + a.width, b.x, b.x + b.width);
        };
        const t = focus(s, d);
        const touching = [...rects].filter(([p, b]) => p !== s.focus && touches(b)).map(([p]) => p);
        if (t.focus === s.focus) expect(touching).toEqual([]);
        else expect(t.focus).toBe(s.mru.find((p) => touching.includes(p)));
      }),
    );
  });
});

// docs/specs/side-panel-unsplit.md decisions 20-23: a split kept as a hidden view.
describe("hidden views and pickTab", () => {
  /** t1 | (t2 / t3), focus on t2's pane, t1 made wider. */
  const view = () => {
    let s = createPanes("t1");
    s = split(s, "p1", "vertical", "t2");
    s = split(s, "p2", "horizontal", "t3");
    s = focusPane(s, "p1");
    s = resize(s, "wider", 0.1);
    return focusPane(s, "p2");
  };

  test("hideView keeps the whole tree and marks it hidden; showView clears it", () => {
    const s = view();
    const h = hideView(s);
    expect(h.hidden).toBe(true);
    expect(h.root).toBe(s.root);
    expect(h.focus).toBe(s.focus);
    expect(isHidden(h)).toBe(true);
    expect(isHidden(s)).toBe(false);
    const back = showView(h);
    expect("hidden" in back).toBe(false);
    expect(back.root).toBe(s.root);
    expect(showView(s)).toBe(s);
    expect(hideView(h)).toBe(h);
  });

  test("pane operations keep the hidden flag", () => {
    const h = hideView(view());
    expect(closePane(h, "p3").hidden).toBe(true);
    expect(resize(h, "taller", 0.05).hidden).toBe(true);
  });

  test("picking a pane's tab focuses it", () => {
    const r = pickTab(view(), "t3");
    expect(r.change).toBe("focus");
    expect(r.panes.focus).toBe("p3");
  });

  test("picking the focused pane's tab changes nothing", () => {
    const s = view();
    expect(pickTab(s, "t2")).toEqual({ panes: s, change: "none" });
  });

  test("picking a tab of a hidden view shows the view, focused on that tab's pane", () => {
    const s = view();
    const r = pickTab(hideView(s), "t1");
    expect(r.change).toBe("show");
    expect(isHidden(r.panes)).toBe(false);
    expect(r.panes.root).toBe(s.root);
    expect(r.panes.focus).toBe("p1");
    expect(pickTab(hideView(s), "t2").panes).toEqual(s);
  });

  test("picking an existing tab outside the view hides it, sizes and focus kept", () => {
    const s = view();
    const r = pickTab(s, "t9");
    expect(r.change).toBe("hide");
    expect(r.panes).toEqual(hideView(s));
  });

  // docs/specs/new-tab-in-split.md: [panes] new_tab, "alone" by default.
  test("a new foreground tab shows alone beside the view, which waits hidden as it was", () => {
    const s = view();
    const r = pickTab(s, "t9", { opened: true });
    expect(r.change).toBe("beside");
    expect(r.panes).toEqual(hideView(s));
    expect(pickTab(s, "t9", { opened: true, newTab: "alone" })).toEqual(r);
  });

  test('with new_tab = "pane" a new foreground tab replaces the focused pane\'s tab', () => {
    const s = view();
    const r = pickTab(s, "t9", { opened: true, newTab: "pane" });
    expect(r.change).toBe("replace");
    expect(r.panes).toEqual(setPaneTab(s, "p2", "t9"));
  });

  test("an existing tab picked is not a new tab, whatever new_tab says", () => {
    const s = view();
    expect(pickTab(s, "t9", { newTab: "pane" }).change).toBe("hide");
    expect(pickTab(s, "t9", { newTab: "alone" }).change).toBe("hide");
  });

  test.each([["alone"], ["pane"]] as const)(
    "a new tab that cannot join (pinned) hides the view (new_tab = %s)",
    (newTab) => {
      const r = pickTab(view(), "t9", { opened: true, canJoin: false, newTab });
      expect(r.change).toBe("hide");
    },
  );

  test("anything outside a hidden view leaves it hidden", () => {
    const h = hideView(view());
    expect(pickTab(h, "t9")).toEqual({ panes: h, change: "none" });
    expect(pickTab(h, "t9", { opened: true })).toEqual({ panes: h, change: "none" });
    expect(pickTab(h, "t9", { opened: true, newTab: "pane" })).toEqual({
      panes: h,
      change: "none",
    });
  });
});

describe("pane edges", () => {
  const thrown = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e as PaneError;
    }
    throw new Error("expected a throw");
  };

  test("errors carry their name, code and Vimma's message", () => {
    const s = createRow(["a", "b"]);
    const unknown = thrown(() => focusPane(s, "p9"));
    expect([unknown.name, unknown.code, unknown.message]).toEqual([
      "PaneError",
      "unknown-pane",
      'no pane "p9"',
    ]);
    expect(thrown(() => createRow([])).message).toBe("a row needs at least one tab");
    expect(thrown(() => createRow(["a", "a"])).message).toBe("a tab can be shown in one pane only");
    expect(thrown(() => split(s, "p1", "diagonal" as any, "c")).message).toBe(
      'bad split direction "diagonal"',
    );
    expect(thrown(() => splitRefusal(s, "p1", "vertical", { max: 0 })).message).toBe(
      "max panes must be a positive integer, got 0",
    );
    expect(thrown(() => split(s, "p1", "vertical", "b")).message).toBe(
      'tab "b" is already shown in a pane',
    );
    expect(thrown(() => closePane(createPanes("a"), "p1")).message).toBe(
      "cannot close the last pane",
    );
    expect(thrown(() => focus(s, "north" as any)).message).toBe('bad direction "north"');
    expect(thrown(() => resize(s, "fatter" as any, 0.1)).message).toBe(
      'bad resize direction "fatter"',
    );
    expect(thrown(() => resize(s, "wider", -1)).message).toBe(
      "resize amount must be positive, got -1",
    );
    expect(thrown(() => setPaneTab(s, "p1", "b")).message).toBe(
      'tab "b" is already shown in a pane',
    );
  });

  test("a resize by nothing is refused", () => {
    expect(thrown(() => resize(createRow(["a", "b"]), "wider", 0)).code).toBe("bad-amount");
  });

  test("the max-panes refusal counts panes in the singular and the plural", () => {
    const one = createPanes("a");
    expect(splitRefusal(one, "p1", "vertical", { max: 1 })?.message).toBe("at most 1 pane");
    expect(splitRefusal(createRow(["a", "b"]), "p1", "vertical", { max: 2 })?.message).toBe(
      "at most 2 panes",
    );
  });

  test("a pane of exactly twice the smallest share still splits along its axis", () => {
    const s = createRow(["a", "b"], { ratios: [0.2, 0.8] });
    expect(splitRefusal(s, "p1", "vertical")).toBeNull();
    expect(
      splitRefusal(createRow(["a", "b"], { ratios: [0.19, 0.81] }), "p1", "vertical")?.code,
    ).toBe("no-space");
  });

  test("a nested split on the same axis flattens only when every pane keeps the smallest share", () => {
    const leaf = (pane: string) => ({ type: "leaf" as const, pane, tab: pane });
    const lopsided = makeSplit("x", [leaf("a"), leaf("b")], [0.9, 0.1]);
    const kept = makeSplit("x", [lopsided, leaf("c")], [0.5, 0.5]);
    expect(kept).toMatchObject({ children: [lopsided, leaf("c")], ratios: [0.5, 0.5] });
    const fits = makeSplit("x", [leaf("a"), leaf("b")], [0.2, 0.8]);
    expect(makeSplit("x", [fits, leaf("c")], [0.5, 0.5])).toMatchObject({
      children: [leaf("a"), leaf("b"), leaf("c")],
      ratios: [0.1, 0.4, 0.5],
    });
  });

  test("the last pane of a row ends at the area's edge, not at a rounded one", () => {
    const rects = layout(createRow(["a", "b"]), { x: 0, y: 0, width: 100.4, height: 10 });
    expect(rects.map((r) => r.rect.width)).toEqual([50, 50.400000000000006]);
    expect(rects[1]?.rect.x).toBe(50);
  });

  // y[x[a, b], x[c, d]], each row split at the middle: a's corner meets d's.
  const grid = () => {
    let s = createPanes("a");
    s = split(s, "p1", "horizontal", "c");
    s = split(s, "p1", "vertical", "b");
    s = split(s, "p2", "vertical", "d");
    // Most recent: d, then a (diagonal from d), then the others.
    return focusPane(focusPane(s, "p1"), "p4");
  };

  test("a pane touching only at a corner is no neighbour", () => {
    const s = grid();
    expect(s.mru.slice(0, 2)).toEqual(["p4", "p1"]);
    expect(paneOfTab(s, "c")).toBe("p2");
    expect(focus(s, "left").focus).toBe("p2");
    expect(focus(s, "up").focus).toBe("p3");
  });
});
