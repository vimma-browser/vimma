import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { planSplit, PlanError } from "../src/panes/splitplan.mjs";
import {
  closePane,
  createPanes,
  focus,
  leaves,
  setPaneTab,
  split,
  swap,
  toggleZoom,
} from "../src/panes/panes.mjs";

import type { Panes } from "../src/panes/panes.mjs";
import type { SplitGroupState, SplitPlan } from "../src/panes/splitplan.mjs";

const group = (s: Partial<SplitGroupState> = {}): SplitGroupState => ({
  members: [],
  active: [],
  hidden: [],
  ...s,
});

const EMPTY = {
  join: [],
  leave: [],
  order: [],
  activate: [],
  deactivate: [],
  hideVisually: [],
  showVisually: [],
};

/** Splits right repeatedly: x[t0, t1, …]. */
function across(tabs: string[]): Panes {
  let p = createPanes(tabs[0] as string);
  for (const t of tabs.slice(1)) p = split(p, p.focus, "vertical", t);
  return p;
}

/** `extra`: hidden tabs of the workspace. */
const ws = (panes: Panes | null, extra: string[] = []) => ({
  tabs: [...(panes ? leaves(panes).map((l) => l.tab) : []), ...extra],
  panes,
});

/**
 * What Firefox and the host end up with after the host applies `plan` in order: membership
 * (a rebuild keeps the remaining members in order and appends the joiners; fewer than two
 * members dissolve the wrapper), then the moveBefore sequence, then the flags.
 */
function apply(cur: SplitGroupState, plan: SplitPlan): SplitGroupState {
  let members = cur.members.slice();
  if (plan.leave.length || plan.join.length) {
    members = [...members.filter((t) => !plan.leave.includes(t)), ...plan.join];
    if (members.length < 2) members = [];
  }
  for (const { tab, before } of plan.order) {
    expect(members).toContain(tab);
    members = members.filter((t) => t !== tab);
    const at = before === null ? members.length : members.indexOf(before);
    expect(at).toBeGreaterThanOrEqual(0);
    members.splice(at, 0, tab);
  }
  const active = new Set(cur.active);
  for (const t of plan.activate) active.add(t);
  for (const t of plan.deactivate) active.delete(t);
  const hidden = new Set(cur.hidden);
  for (const t of plan.hideVisually) hidden.add(t);
  for (const t of plan.showVisually) hidden.delete(t);
  return { members, active: [...active], hidden: [...hidden] };
}

describe("planSplit", () => {
  test("one pane and no wrapper: nothing to do", () => {
    expect(planSplit(ws(createPanes("a")), group({ active: ["a"] }))).toEqual(EMPTY);
  });

  test("an empty workspace with no wrapper: nothing to do", () => {
    expect(planSplit(ws(null), group())).toEqual(EMPTY);
  });

  test("the first split joins both tabs and activates the new one", () => {
    const plan = planSplit(ws(across(["a", "b"])), group({ active: ["a"] }));
    expect(plan).toEqual({ ...EMPTY, join: ["a", "b"], activate: ["b"] });
  });

  test("a third pane joins the wrapper", () => {
    const plan = planSplit(
      ws(across(["a", "b", "c"])),
      group({ members: ["a", "b"], active: ["a", "b"] }),
    );
    expect(plan).toEqual({ ...EMPTY, join: ["c"], activate: ["c"] });
  });

  test("closing a pane keeps its tab but drops and deactivates it", () => {
    const tree = closePane(across(["a", "b", "c"]), "p2");
    const plan = planSplit(
      ws(tree, ["b"]),
      group({ members: ["a", "b", "c"], active: ["a", "b", "c"] }),
    );
    expect(plan).toEqual({ ...EMPTY, leave: ["b"], deactivate: ["b"] });
  });

  test("back to one pane: every member leaves, the dropped one is deactivated", () => {
    const tree = closePane(across(["a", "b"]), "p2");
    const plan = planSplit(ws(tree, ["b"]), group({ members: ["a", "b"], active: ["a", "b"] }));
    expect(plan).toEqual({ ...EMPTY, leave: ["a", "b"], deactivate: ["b"] });
  });

  test("a swap is one moveBefore into reading order", () => {
    const tree = swap(focus(across(["a", "b"]), "left"), "right"); // x[b, a]
    expect(leaves(tree).map((l) => l.tab)).toEqual(["b", "a"]);
    const plan = planSplit(ws(tree), group({ members: ["a", "b"], active: ["a", "b"] }));
    expect(plan.order).toHaveLength(1);
    expect(apply(group({ members: ["a", "b"] }), plan).members).toEqual(["b", "a"]);
  });

  test("an L shape is ordered in reading order, not split order", () => {
    // x[a, y[b, c]]: reading order a, b, c
    let tree = across(["a", "b"]);
    tree = split(tree, tree.focus, "horizontal", "c");
    const cur = group({ members: ["c", "a", "b"], active: ["a", "b", "c"] });
    const plan = planSplit(ws(tree), cur);
    expect(plan.order).toEqual([{ tab: "c", before: null }]);
  });

  test("zoom hides and deactivates the other panes; unzoom shows and reactivates them", () => {
    const tree = focus(across(["a", "b", "c"]), "left"); // focus b
    const zoomed = toggleZoom(tree);
    const live = group({ members: ["a", "b", "c"], active: ["a", "b", "c"] });
    const z = planSplit(ws(zoomed), live);
    expect(z).toEqual({ ...EMPTY, deactivate: ["a", "c"], hideVisually: ["a", "c"] });
    const after = apply(live, z);
    expect(planSplit(ws(tree), after)).toEqual({
      ...EMPTY,
      activate: ["a", "c"],
      showVisually: ["a", "c"],
    });
  });

  test("a zoomed-away pane that is closed is shown again and stays inactive", () => {
    const cur = group({ members: ["a", "b", "c"], active: ["b"], hidden: ["a", "c"] });
    const tree = closePane(across(["a", "b", "c"]), "p3"); // x[a, b], no zoom
    const plan = planSplit(ws(tree, ["c"]), cur);
    expect(plan).toEqual({ ...EMPTY, leave: ["c"], activate: ["a"], showVisually: ["a", "c"] });
  });

  test("replacing a pane's tab rebuilds with the new tab joined", () => {
    const tree = setPaneTab(across(["a", "b"]), "p2", "c");
    const plan = planSplit(ws(tree, ["b"]), group({ members: ["a", "b"], active: ["a", "b"] }));
    expect(plan).toEqual({
      ...EMPTY,
      leave: ["b"],
      join: ["c"],
      activate: ["c"],
      deactivate: ["b"],
    });
  });

  test("decision 14: a member of another workspace leaves the wrapper", () => {
    const plan = planSplit(
      ws(across(["a", "b"])),
      group({ members: ["a", "x", "b"], active: ["a", "x", "b"] }),
    );
    expect(plan).toEqual({ ...EMPTY, leave: ["x"], deactivate: ["x"] });
  });

  test("decision 14: a tree showing a tab of another workspace is refused", () => {
    const err = (() => {
      try {
        planSplit({ tabs: ["a"], panes: across(["a", "x"]) }, group());
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(PlanError);
    expect((err as PlanError).code).toBe("cross-workspace");
  });

  test("a group state listing a member twice is bad-state", () => {
    expect(() => planSplit(ws(across(["a", "b"])), group({ members: ["a", "a"] }))).toThrow(
      expect.objectContaining({ code: "bad-state" }),
    );
  });
});

// ---- properties ----

const TABS = ["a", "b", "c", "d", "e", "f", "g"];

const treeOpArb = fc.oneof(
  fc.record({
    op: fc.constant("split"),
    pick: fc.nat(),
    dir: fc.constantFrom("vertical", "horizontal"),
  }),
  fc.record({ op: fc.constant("close"), pick: fc.nat() }),
  fc.record({ op: fc.constant("swap"), dir: fc.constantFrom("left", "right", "up", "down") }),
  fc.record({ op: fc.constant("focus"), dir: fc.constantFrom("left", "right", "up", "down") }),
  fc.record({ op: fc.constant("zoom") }),
  fc.record({ op: fc.constant("replace"), pick: fc.nat(), tab: fc.nat() }),
);

/** A workspace with tabs a..g and a pane tree over some of them (or none). */
const workspaceArb = fc
  .tuple(fc.boolean(), fc.array(treeOpArb, { maxLength: 15 }))
  .map(([empty, ops]) => {
    if (empty) return { tabs: TABS, panes: null };
    let p = createPanes("a");
    for (const o of ops) {
      const ls = leaves(p);
      const shown = new Set(ls.map((l) => l.tab));
      const free = TABS.filter((t) => !shown.has(t));
      const leaf = ls[("pick" in o ? o.pick : 0) % ls.length];
      if (!leaf) throw new Error("a pane tree has a leaf");
      const target = leaf.pane;
      if (o.op === "split" && free.length) p = split(p, target, o.dir, free[0] as string);
      else if (o.op === "close" && ls.length > 1) p = closePane(p, target);
      else if (o.op === "swap") p = swap(p, o.dir);
      else if (o.op === "focus") p = focus(p, o.dir);
      else if (o.op === "zoom") p = toggleZoom(p);
      else if (o.op === "replace" && free.length) {
        p = setPaneTab(p, target, free[o.tab % free.length] as string);
      }
    }
    return { tabs: TABS, panes: p };
  });

/** Whatever Firefox's group looks like: any members (foreign x, y too) and any flags. */
const currentArb = fc
  .tuple(
    fc.shuffledSubarray([...TABS, "x", "y"]),
    fc.subarray([...TABS, "x", "y"]),
    fc.subarray([...TABS, "x", "y"]),
  )
  .map(([members, active, hidden]) =>
    group({ members: members.length < 2 ? [] : members, active, hidden }),
  );

function target(w: { tabs: string[]; panes: Panes | null }) {
  const tabs = w.panes ? leaves(w.panes).map((l) => l.tab) : [];
  const members = tabs.length >= 2 ? tabs : [];
  const zoom = w.panes?.zoom ? leaves(w.panes).find((l) => l.pane === w.panes?.zoom)?.tab : null;
  const hidden = zoom && members.length ? members.filter((t) => t !== zoom) : [];
  const active = tabs.filter((t) => !hidden.includes(t));
  return { tabs, members, hidden, active };
}

const size = (plan: SplitPlan) => Object.values(plan).reduce((n, ops) => n + ops.length, 0);

describe("planSplit properties", () => {
  test("applying the plan yields the target: members, reading order, zoom, docshells", () => {
    fc.assert(
      fc.property(workspaceArb, currentArb, (w, cur) => {
        const t = target(w);
        const after = apply(cur, planSplit(w, cur));
        expect(after.members).toEqual(t.members);
        expect([...after.hidden].sort()).toEqual([...t.hidden].sort());
        // every tab we manage (leaves, old members, hidden panels) is active iff a visible leaf
        for (const tab of new Set([...t.tabs, ...cur.members, ...cur.hidden])) {
          expect(after.active.includes(tab)).toBe(t.active.includes(tab));
        }
      }),
    );
  });

  test("the plan is empty when Firefox already matches, and applying it twice is a no-op", () => {
    fc.assert(
      fc.property(workspaceArb, currentArb, (w, cur) => {
        const after = apply(cur, planSplit(w, cur));
        expect(planSplit(w, after)).toEqual(EMPTY);
        const t = target(w);
        expect(
          planSplit(w, group({ members: t.members, active: t.active, hidden: t.hidden })),
        ).toEqual(EMPTY);
      }),
    );
  });

  test("ops are disjoint and minimal: each tab at most once per list, order only when needed", () => {
    fc.assert(
      fc.property(workspaceArb, currentArb, (w, cur) => {
        const plan = planSplit(w, cur);
        for (const ops of [
          plan.join,
          plan.leave,
          plan.activate,
          plan.deactivate,
          plan.hideVisually,
          plan.showVisually,
        ]) {
          expect(new Set(ops).size).toBe(ops.length);
        }
        expect(plan.join.filter((x) => plan.leave.includes(x))).toEqual([]);
        expect(plan.activate.filter((x) => plan.deactivate.includes(x))).toEqual([]);
        expect(plan.hideVisually.filter((x) => plan.showVisually.includes(x))).toEqual([]);
        const t = target(w);
        expect(plan.order.length).toBeLessThan(Math.max(1, t.members.length));
        expect(size(plan)).toBeLessThanOrEqual(
          3 * (t.tabs.length + cur.members.length + cur.hidden.length),
        );
      }),
    );
  });
});

describe("split plan edges", () => {
  const thrown = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e as PlanError;
    }
    throw new Error("expected a throw");
  };

  test("errors carry their name and say what was wrong", () => {
    const twice = thrown(() => planSplit(ws(null), group({ members: ["a", "a"] })));
    expect([twice.name, twice.code, twice.message]).toEqual([
      "PlanError",
      "bad-state",
      'members lists a tab twice: ["a","a"]',
    ]);
    const stray = thrown(() => planSplit({ tabs: ["a"], panes: across(["a", "b", "c"]) }, group()));
    expect([stray.code, stray.message]).toEqual([
      "cross-workspace",
      "panes show tabs of another workspace: b, c",
    ]);
  });

  test("a member out of order at the front moves before its successor", () => {
    const p = across(["a", "b", "c"]);
    const plan = planSplit(ws(p), group({ members: ["b", "c", "a"], active: ["a", "b", "c"] }));
    expect(plan.order).toEqual([{ tab: "a", before: "b" }]);
  });

  test("a zoom on a pane the tree does not have hides nothing", () => {
    const p = { ...across(["a", "b"]), zoom: "p9" };
    const plan = planSplit(ws(p), group({ members: ["a", "b"], active: ["a", "b"] }));
    expect(plan).toEqual(EMPTY);
  });
});
