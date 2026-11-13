// Tiling layouts (docs/specs/tiling-layouts.md): tmux's presets and Hyprland's dwindle, as pure
// tree builders over the pane tree.
import { describe, test, expect } from "vitest";
import fc from "fast-check";
import {
  createPanes,
  createRow,
  split,
  closePane,
  focusPane,
  layout,
  leaves,
  resize,
  swap,
  toggleZoom,
  MIN_RATIO,
} from "../src/panes/panes.mjs";
import {
  LAYOUTS,
  MAIN_SIZE_DEFAULT,
  arrange,
  dwindleDirection,
  isLayoutName,
  layoutOfAction,
  layoutRefusal,
  nextLayout,
  repane,
  repaneRefusal,
  showTogether,
  togetherRefusal,
} from "../src/panes/layouts.mjs";
import { getAction } from "../src/keys/actions.mjs";
import { completeCommandLine, parseCommandLine } from "../src/keys/cmdline.mjs";
import { createDispatcher } from "../src/keys/dispatcher.mjs";
import { compileKeymap } from "../src/keys/keymap.mjs";
import { parseKey } from "../src/keys/keys.mjs";
import { createWorkspaces } from "../src/workspaces/workspaces.mjs";
import { readSnapshot, toSnapshot } from "../src/workspaces/snapshot.mjs";

/**
 * The workspace state a snapshot restores to, without its tab renames.
 * @param {unknown} input
 * @param {Parameters<typeof readSnapshot>[1]} [options]
 */
const stateOf = (input, options) => readSnapshot(input, options).state;

/** @param {any} node @returns {string} */
function shape(node) {
  return node.type === "leaf" ? node.pane : `${node.axis}[${node.children.map(shape).join(",")}]`;
}

/** @param {any} node @returns {number[][]} every split's ratios, depth first */
function ratios(node) {
  return node.type === "leaf" ? [] : [node.ratios.slice(), ...node.children.flatMap(ratios)];
}

const WIDE = { x: 0, y: 0, width: 1280, height: 740 };
const TALL = { x: 0, y: 0, width: 600, height: 1000 };

/**
 * `n` panes p1..pn showing t1..tn side by side, focus on `focus` (default p1).
 * @param {number} n
 * @param {string} [focus]
 */
function row(n, focus) {
  const s = createRow(Array.from({ length: n }, (_, i) => `t${i + 1}`));
  return focus ? focusPane(s, focus) : s;
}

/** x[p1, y[p2, p3]] built by hand, focus p3 */
function lShape() {
  let s = createPanes("t1");
  s = split(s, "p1", "vertical", "t2");
  return split(s, "p2", "horizontal", "t3");
}

const close = (/** @type {number[][]} */ got, /** @type {number[][]} */ want) => {
  expect(got.length).toBe(want.length);
  got.forEach((r, i) => {
    expect(r.length).toBe(/** @type {number[]} */ (want[i]).length);
    r.forEach((v, j) => expect(v).toBeCloseTo(/** @type {number} */ (want[i]?.[j]), 9));
  });
};

describe("LAYOUTS and cycling", () => {
  test("the six presets, in the cycle order", () => {
    expect(LAYOUTS).toEqual([
      "even-horizontal",
      "even-vertical",
      "main-vertical",
      "main-horizontal",
      "tiled",
      "dwindle",
    ]);
    expect(Object.isFrozen(LAYOUTS)).toBe(true);
    expect(MAIN_SIZE_DEFAULT).toBe(0.6);
  });

  test("nextLayout: the one after, wrapping; the first without one", () => {
    expect(nextLayout(undefined)).toBe("even-horizontal");
    expect(nextLayout(null)).toBe("even-horizontal");
    expect(nextLayout("even-horizontal")).toBe("even-vertical");
    expect(nextLayout("tiled")).toBe("dwindle");
    expect(nextLayout("dwindle")).toBe("even-horizontal");
    expect(nextLayout(/** @type {any} */ ("bogus"))).toBe("even-horizontal");
  });

  test("isLayoutName", () => {
    for (const name of LAYOUTS) expect(isLayoutName(name)).toBe(true);
    expect(isLayoutName("main")).toBe(false);
    expect(isLayoutName(3)).toBe(false);
  });
});

describe("arrange: the trees", () => {
  test("one pane: nothing to arrange, the state comes back as it is", () => {
    const s = createPanes("t1");
    for (const name of LAYOUTS) expect(arrange(s, name)).toBe(s);
  });

  test.each([
    [2, "x[p1,p2]", [[0.5, 0.5]]],
    [3, "x[p1,p2,p3]", [[1 / 3, 1 / 3, 1 / 3]]],
    [4, "x[p1,p2,p3,p4]", [[0.25, 0.25, 0.25, 0.25]]],
  ])("even-horizontal, %i panes: one row, even", (n, want, rs) => {
    const s = arrange(row(n), "even-horizontal");
    expect(shape(s.root)).toBe(want);
    close(ratios(s.root), rs);
  });

  test("even-vertical: one column, even, from any tree", () => {
    const s = arrange(lShape(), "even-vertical");
    expect(shape(s.root)).toBe("y[p1,p2,p3]");
    close(ratios(s.root), [[1 / 3, 1 / 3, 1 / 3]]);
    expect(shape(arrange(row(2), "even-vertical").root)).toBe("y[p1,p2]");
  });

  test("main-vertical: the focused pane large on the left, the rest stacked on the right", () => {
    const s = arrange(row(4, "p3"), "main-vertical");
    expect(shape(s.root)).toBe("x[p3,y[p1,p2,p4]]");
    close(ratios(s.root), [
      [0.6, 0.4],
      [1 / 3, 1 / 3, 1 / 3],
    ]);
    expect(shape(arrange(row(2, "p2"), "main-vertical").root)).toBe("x[p2,p1]");
    close(ratios(arrange(row(2, "p2"), "main-vertical").root), [[0.6, 0.4]]);
    expect(shape(arrange(row(3, "p1"), "main-vertical").root)).toBe("x[p1,y[p2,p3]]");
  });

  test("main-horizontal: the main pane on top, the rest side by side below", () => {
    const s = arrange(row(3, "p2"), "main-horizontal");
    expect(shape(s.root)).toBe("y[p2,x[p1,p3]]");
    close(ratios(s.root), [
      [0.6, 0.4],
      [0.5, 0.5],
    ]);
  });

  test("main-*: mainSize sets the main share", () => {
    const s = arrange(row(3), "main-vertical", { mainSize: 0.7 });
    close(ratios(s.root), [
      [0.7, 0.3],
      [0.5, 0.5],
    ]);
  });

  test.each([
    [2, "x[p1,p2]"],
    [3, "y[x[p1,p2],p3]"],
    [4, "y[x[p1,p2],x[p3,p4]]"],
    [5, "y[x[p1,p2,p3],x[p4,p5]]"],
    [6, "y[x[p1,p2,p3],x[p4,p5,p6]]"],
    [7, "y[x[p1,p2,p3],x[p4,p5,p6],p7]"],
    [9, "y[x[p1,p2,p3],x[p4,p5,p6],x[p7,p8,p9]]"],
  ])("tiled, %i panes: rows of ceil(√n), filled in reading order", (n, want) => {
    const s = arrange(row(n), "tiled");
    expect(shape(s.root)).toBe(want);
    for (const r of ratios(s.root)) for (const v of r) expect(v).toBeCloseTo(1 / r.length, 9);
  });

  test("tiled at 4 panes is a 2×2 grid on screen", () => {
    const rects = layout(arrange(row(4), "tiled"), { x: 0, y: 0, width: 1000, height: 800 });
    expect(rects.map((r) => r.rect)).toEqual([
      { x: 0, y: 0, width: 500, height: 400 },
      { x: 500, y: 0, width: 500, height: 400 },
      { x: 0, y: 400, width: 500, height: 400 },
      { x: 500, y: 400, width: 500, height: 400 },
    ]);
  });

  test.each([
    [2, "x[p1,p2]"],
    [3, "x[p1,y[p2,p3]]"],
    [4, "x[p1,y[p2,x[p3,p4]]]"],
  ])("dwindle on a wide window, %i panes: a spiral, halves along the longer side", (n, want) => {
    const s = arrange(row(n), "dwindle", { area: WIDE });
    expect(shape(s.root)).toBe(want);
    for (const r of ratios(s.root)) close([r], [[0.5, 0.5]]);
  });

  test("dwindle on a tall window starts stacked", () => {
    expect(shape(arrange(row(3), "dwindle", { area: TALL }).root)).toBe("y[p1,x[p2,p3]]");
  });

  test("dwindle on a very wide area keeps splitting side by side (canonical: flattened)", () => {
    const s = arrange(row(3), "dwindle", { area: { x: 0, y: 0, width: 4000, height: 500 } });
    expect(shape(s.root)).toBe("x[p1,p2,p3]");
    close(ratios(s.root), [[0.5, 0.25, 0.25]]);
  });

  test("dwindle without an area assumes a wide window", () => {
    expect(shape(arrange(row(3), "dwindle").root)).toBe("x[p1,y[p2,p3]]");
  });

  test("an unknown name throws", () => {
    expect(() => arrange(row(2), /** @type {any} */ ("grid"))).toThrow(/layout/);
  });

  test("a bad mainSize throws", () => {
    expect(() => arrange(row(2), "main-vertical", { mainSize: 0.05 })).toThrow(/main/);
    expect(() => arrange(row(2), "main-vertical", { mainSize: 1 })).toThrow(/main/);
  });
});

describe("arrange: focus, zoom, mru, tabs", () => {
  test.each(LAYOUTS)("%s keeps every pane with its tab, the focus and the MRU order", (name) => {
    const s = focusPane(lShape(), "p1");
    const t = arrange(s, name);
    const tabs = (/** @type {any} */ x) =>
      Object.fromEntries(leaves(x).map((l) => [l.pane, l.tab]));
    expect(tabs(t)).toEqual(tabs(s));
    expect(t.focus).toBe("p1");
    expect(t.mru).toEqual(s.mru);
    expect(t.next).toBe(s.next);
    expect(t.layout).toBe(name);
    expect(Object.isFrozen(t)).toBe(true);
  });

  test("a preset ends a zoom, as tmux's select-layout does", () => {
    const s = toggleZoom(lShape());
    expect(s.zoom).toBe("p3");
    const t = arrange(s, "tiled");
    expect(t.zoom).toBeNull();
    expect(t.focus).toBe("p3");
  });

  test("the name survives manual changes, so cycling goes on from it (tmux's lastlayout)", () => {
    let s = arrange(row(3), "main-vertical");
    s = resize(s, "wider", 0.05);
    s = swap(s, "right");
    s = split(s, s.focus, "horizontal", "t9");
    expect(s.layout).toBe("main-vertical");
    s = closePane(s, s.focus);
    expect(s.layout).toBe("main-vertical");
    expect(nextLayout(s.layout)).toBe("main-horizontal");
  });
});

describe("arrange: round trips", () => {
  test.each(LAYOUTS)("%s twice is the same tree (idempotent)", (name) => {
    for (const n of [2, 3, 4]) {
      const once = arrange(row(n, "p2"), name, { area: WIDE });
      const twice = arrange(once, name, { area: WIDE });
      expect(shape(twice.root)).toBe(shape(once.root));
      expect(ratios(twice.root)).toEqual(ratios(once.root));
    }
  });

  test("cycling: six presses come back to even-horizontal, and every later round is the same", () => {
    for (const n of [2, 3, 4]) {
      let s = row(n, "p2");
      /** @param {any} t */
      const round = (t) => {
        /** @type {string[]} */
        const seen = [];
        for (let i = 0; i < LAYOUTS.length; i++) {
          t = arrange(t, nextLayout(t.layout), { area: WIDE });
          seen.push(`${t.layout} ${shape(t.root)}`);
        }
        return { t, seen };
      };
      const first = round(s);
      expect(first.seen.map((x) => x.split(" ")[0])).toEqual(LAYOUTS);
      // main-* put the focused pane first in reading order; from then on the order is stable
      const second = round(first.t);
      expect(second.seen).toEqual(round(second.t).seen);
      expect(second.t.layout).toBe("dwindle");
      s = second.t;
      expect(s.focus).toBe("p2");
    }
  });

  test.each(LAYOUTS.flatMap((a) => LAYOUTS.map((b) => [a, b])))(
    "%s then %s keeps the same panes and tabs, and the focus",
    (a, b) => {
      const s = row(4, "p3");
      const t = arrange(arrange(s, a, { area: WIDE }), b, { area: WIDE });
      expect(
        leaves(t)
          .map((l) => `${l.pane}:${l.tab}`)
          .sort(),
      ).toEqual(
        leaves(s)
          .map((l) => `${l.pane}:${l.tab}`)
          .sort(),
      );
      expect(t.focus).toBe("p3");
      // b alone on a's result is the same as b on a fresh row, except the main-* order
      expect(t.layout).toBe(b);
    },
  );

  test("a preset's tree survives the snapshot, with its name", () => {
    const s = arrange(row(4, "p2"), "main-vertical");
    let ws = createWorkspaces([{ name: "a", container: "c1" }]);
    const w = /** @type {any} */ (ws.workspaces[0]);
    ws = {
      ...ws,
      workspaces: [{ ...w, tabs: ["t1", "t2", "t3", "t4"], activeTab: "t2", panes: s }],
    };
    const back = /** @type {any} */ (stateOf(JSON.stringify(toSnapshot(/** @type {any} */ (ws)))));
    const p = back.workspaces[0].panes;
    expect(shape(p.root)).toBe(shape(s.root));
    expect(p.layout).toBe("main-vertical");
  });
});

describe("layoutRefusal", () => {
  test("null within MIN_RATIO", () => {
    for (const name of LAYOUTS) expect(layoutRefusal(row(4), name)).toBeNull();
    expect(layoutRefusal(row(10), "even-horizontal")).toBeNull();
    expect(layoutRefusal(row(11), "main-vertical")).toBeNull();
  });

  test("no space when a pane would get less than MIN_RATIO of its split", () => {
    expect(MIN_RATIO).toBe(0.1);
    expect(layoutRefusal(row(11), "even-horizontal")).toEqual({
      code: "no-space",
      message: "no space for 11 panes in even-horizontal",
    });
    expect(layoutRefusal(row(12), "main-horizontal")?.code).toBe("no-space");
    expect(layoutRefusal(row(16), "tiled")).toBeNull();
    expect(layoutRefusal(row(16), "dwindle")).toBeNull();
  });

  test("arrange returns the input unchanged when refused", () => {
    const s = row(11);
    expect(arrange(s, "even-vertical")).toBe(s);
  });
});

describe("dwindleDirection", () => {
  test("one pane: side by side on a wide area, stacked on a tall one", () => {
    expect(dwindleDirection(createPanes("t1"), WIDE)).toBe("vertical");
    expect(dwindleDirection(createPanes("t1"), TALL)).toBe("horizontal");
  });

  test("a square pane splits side by side", () => {
    expect(dwindleDirection(createPanes("t1"), { x: 0, y: 0, width: 500, height: 500 })).toBe(
      "vertical",
    );
  });

  test("ctrl+b enter from 1 to 4 panes spirals: side by side, stacked, side by side", () => {
    let s = createPanes("t1");
    /** @type {string[]} */
    const dirs = [];
    for (let i = 2; i <= 4; i++) {
      const d = dwindleDirection(s, WIDE);
      dirs.push(d);
      s = split(s, s.focus, d, `t${i}`);
    }
    expect(dirs).toEqual(["vertical", "horizontal", "vertical"]);
    expect(shape(s.root)).toBe("x[p1,y[p2,x[p3,p4]]]");
  });

  test("uses the focused pane's rectangle, ignoring a zoom", () => {
    // x[p1, p2] on a wide area: each half is 640×740, taller than wide
    const s = toggleZoom(row(2));
    expect(dwindleDirection(s, WIDE)).toBe("horizontal");
  });
});

describe("property: any tree, any preset", () => {
  const opArb = fc.record({
    pick: fc.nat(),
    dir: fc.constantFrom(/** @type {const} */ ("vertical"), /** @type {const} */ ("horizontal")),
  });

  test("same leaves, canonical, focus kept, and the snapshot reads it back", () => {
    fc.assert(
      fc.property(
        fc.array(opArb, { maxLength: 15 }),
        fc.constantFrom(...LAYOUTS),
        fc.integer({ min: 20, max: 80 }),
        (ops, name, pct) => {
          let s = createPanes("t1");
          let n = 1;
          for (const op of ops) {
            const ls = leaves(s);
            const target = /** @type {any} */ (ls[op.pick % ls.length]).pane;
            const next = split(s, target, op.dir, `t${n + 1}`, { max: 16 });
            if (next !== s) n++;
            s = next;
          }
          const t = arrange(s, name, { area: WIDE, mainSize: pct / 100 });
          if (layoutRefusal(s, name)) {
            expect(t).toBe(s);
            return;
          }
          expect(
            leaves(t)
              .map((l) => l.tab)
              .sort(),
          ).toEqual(
            leaves(s)
              .map((l) => l.tab)
              .sort(),
          );
          expect(t.focus).toBe(s.focus);
          const tabs = leaves(t).map((l) => l.tab);
          const ws = createWorkspaces([{ name: "a", container: "c1" }]);
          const w = /** @type {any} */ (ws.workspaces[0]);
          const focusTab = leaves(t).find((l) => l.pane === t.focus)?.tab;
          const doc = {
            ...ws,
            workspaces: [{ ...w, tabs, activeTab: focusTab, panes: t }],
          };
          // readSnapshot checks canonical form, ratios summing to 1, unique panes and tabs
          const back = /** @type {any} */ (stateOf(toSnapshot(/** @type {any} */ (doc))));
          expect(shape(back.workspaces[0].panes.root)).toBe(shape(t.root));
          for (const r of ratios(t.root)) for (const v of r) expect(v).toBeGreaterThan(0.0999);
        },
      ),
    );
  });
});

describe("actions, keys and :layout", () => {
  /** @param {string} keys space-separated chords, in normal mode */
  const dispatched = (keys) => {
    const d = createDispatcher(compileKeymap());
    return keys
      .split(" ")
      .map((k) => d.dispatch("normal", parseKey(k)))
      .at(-1);
  };
  const act = (/** @type {string} */ id) => ({ kind: "action", action: { id } });

  test("ctrl+b enter is a new pane, ctrl+b space the next layout", () => {
    expect(dispatched("ctrl+b enter")).toEqual(act("pane.new"));
    expect(dispatched("ctrl+b space")).toEqual(act("pane.next_layout"));
    const km = compileKeymap();
    expect(km.bindingsFor("new_pane")).toEqual(["prefix+enter"]);
    expect(km.bindingsFor("next_layout")).toEqual(["prefix+space"]);
  });

  test("ctrl+b v and ctrl+b - keep their explicit direction", () => {
    expect(dispatched("ctrl+b v")).toEqual(act("pane.split_vertical"));
    expect(dispatched("ctrl+b minus")).toEqual(act("pane.split_horizontal"));
  });

  test("one bindable action per preset, unbound by default, and select_layout", () => {
    const km = compileKeymap();
    for (const name of LAYOUTS) {
      const config = `layout_${name.replace("-", "_")}`;
      expect(getAction(config), config).toMatchObject({
        id: `pane.layout_${name.replace("-", "_")}`,
        group: "Panes",
      });
      expect(km.bindingsFor(config)).toEqual([]);
    }
    expect(getAction("select_layout")?.id).toBe("pane.select_layout");
    expect(layoutOfAction("pane.layout_main_vertical")).toBe("main-vertical");
    expect(layoutOfAction("pane.next_layout")).toBeUndefined();
  });

  test("a preset action can be bound in config.toml", () => {
    const km = compileKeymap({ keys: { layout_tiled: ["prefix+alt+t"] } });
    const d = createDispatcher(km);
    d.dispatch("normal", parseKey("ctrl+b"));
    expect(d.dispatch("normal", parseKey("alt+t"))).toEqual(act("pane.layout_tiled"));
  });

  test(":layout cycles, :layout <name> picks one", () => {
    expect(parseCommandLine(":layout")).toEqual({
      kind: "run",
      command: "layout",
      action: { id: "pane.next_layout" },
    });
    expect(parseCommandLine(":layout tiled")).toEqual({
      kind: "run",
      command: "layout",
      action: { id: "pane.select_layout" },
      text: "tiled",
    });
  });

  test("Tab completes the six preset names after :layout, without the host's help", () => {
    const values = (/** @type {string} */ line) =>
      completeCommandLine(line).candidates.map((c) => c.value);
    expect(values(":layout ")).toEqual(LAYOUTS.map((n) => `layout ${n}`));
    expect(values(":layout main")).toEqual(["layout main-vertical", "layout main-horizontal"]);
    expect(values(":layout til")[0]).toBe("layout tiled");
    expect(completeCommandLine(":layout dw").candidates[0]).toMatchObject({
      kind: "argument",
      label: "dwindle",
      description: "layout",
    });
  });
});

// docs/specs/m4-side-panel-multiselect.md: the side panel's marked tabs shown together.
describe("showTogether", () => {
  /** @param {any} node @returns {string} the tree with each leaf's tab */
  const tabsOf = (node) =>
    node.type === "leaf" ? node.tab : `${node.axis}[${node.children.map(tabsOf).join(",")}]`;
  const focusTab = (/** @type {any} */ s) => leaves(s).find((l) => l.pane === s.focus)?.tab;

  test.each([
    [["a", "b"], "x[a,b]"],
    [["a", "b", "c"], "x[a,y[b,c]]"],
    [["a", "b", "c", "d"], "x[a,y[b,x[c,d]]]"],
  ])("dwindle on a wide window: %j → %s", (ids, want) => {
    const s = showTogether(ids, { mode: "dwindle", area: WIDE });
    expect(tabsOf(s.root)).toBe(want);
    expect(s.zoom).toBeNull();
    expect(s.layout).toBeUndefined();
  });

  test("dwindle on a tall window stacks first", () => {
    expect(tabsOf(showTogether(["a", "b", "c"], { mode: "dwindle", area: TALL }).root)).toBe(
      "y[a,x[b,c]]",
    );
  });

  test("the default mode is dwindle and the default area wide", () => {
    expect(tabsOf(showTogether(["a", "b", "c"]).root)).toBe("x[a,y[b,c]]");
  });

  test("manual: a row, side by side, even", () => {
    const s = showTogether(["a", "b", "c"], { mode: "manual" });
    expect(tabsOf(s.root)).toBe("x[a,b,c]");
    close(ratios(s.root), [[1 / 3, 1 / 3, 1 / 3]]);
    expect(s.layout).toBeUndefined();
  });

  test("a stored preset wins over the mode and stays stored", () => {
    const s = showTogether(["a", "b", "c", "d"], { preset: "tiled", mode: "manual", area: WIDE });
    expect(tabsOf(s.root)).toBe("y[x[a,b],x[c,d]]");
    expect(s.layout).toBe("tiled");
  });

  test("main-vertical makes the focused tab the main pane, the rest in order", () => {
    const s = showTogether(["a", "b", "c"], {
      preset: "main-vertical",
      focus: "b",
      mainSize: 0.7,
    });
    expect(tabsOf(s.root)).toBe("x[b,y[a,c]]");
    close(ratios(s.root), [
      [0.7, 0.3],
      [0.5, 0.5],
    ]);
  });

  test("an unknown stored preset is ignored", () => {
    const s = showTogether(["a", "b"], { preset: "spiral", mode: "manual" });
    expect(tabsOf(s.root)).toBe("x[a,b]");
    expect(s.layout).toBeUndefined();
  });

  test("focus: the given tab, else the first; mru starts with it and lists every pane", () => {
    const s = showTogether(["a", "b", "c"], { focus: "c" });
    expect(focusTab(s)).toBe("c");
    expect(s.mru[0]).toBe(s.focus);
    expect([...s.mru].sort()).toEqual(
      leaves(s)
        .map((l) => l.pane)
        .sort(),
    );
    expect(focusTab(showTogether(["a", "b"]))).toBe("a");
    expect(focusTab(showTogether(["a", "b"], { focus: "z" }))).toBe("a");
  });

  test("the result is a frozen tree with distinct pane ids and a snapshot round trip", () => {
    const s = showTogether(["a", "b", "c", "d"], { preset: "main-horizontal" });
    expect(Object.isFrozen(s)).toBe(true);
    expect(new Set(leaves(s).map((l) => l.pane)).size).toBe(4);
    expect(s.next).toBeGreaterThan(4);
    let ws = createWorkspaces([{ name: "w", container: "1" }]);
    const w = /** @type {any} */ (ws.workspaces[0]);
    ws = {
      ...ws,
      workspaces: [{ ...w, tabs: ["a", "b", "c", "d"], activeTab: "a", panes: s }],
    };
    const back = /** @type {any} */ (stateOf(toSnapshot(ws)).workspaces[0]).panes;
    expect(back.layout).toBe("main-horizontal");
    expect(tabsOf(back.root)).toBe(tabsOf(s.root));
  });

  test("fewer than two tabs, or a tab twice, is a programming error", () => {
    expect(() => showTogether(["a"])).toThrow();
    expect(() => showTogether([])).toThrow();
    expect(() => showTogether(["a", "a"])).toThrow();
  });
});

// docs/specs/side-panel-unsplit.md decision 15: removals keep the shape, an addition re-arranges.
describe("repane", () => {
  /** @param {any} node @returns {string} the tree with each leaf's tab */
  const tabsOf = (node) =>
    node.type === "leaf" ? node.tab : `${node.axis}[${node.children.map(tabsOf).join(",")}]`;
  const focusTab = (/** @type {any} */ s) => leaves(s).find((l) => l.pane === s.focus)?.tab;
  /** A dwindle of t1..t4, resized by hand, layout "dwindle" stored, focus on t2's pane. */
  const resized = () => {
    let s = arrange(row(4), "dwindle", { area: WIDE });
    s = resize(s, "wider", 0.1);
    return focusPane(s, "p2");
  };

  test("removals only: each removed pane closes as prefix+x, the other sizes stay", () => {
    const before = resized();
    const want = closePane(before, "p3");
    const s = repane(before, ["t1", "t2", "t4"], { focus: "t2", area: WIDE });
    expect(tabsOf(s.root)).toBe(tabsOf(want.root));
    close(ratios(s.root), ratios(want.root));
    expect(s.layout).toBe("dwindle");
    expect(focusTab(s)).toBe("t2");
  });

  test("removing two keeps the rest and moves focus to the given tab", () => {
    const s = repane(resized(), ["t1", "t4"], { focus: "t4" });
    expect(tabsOf(s.root)).toBe("x[t1,t4]");
    expect(focusTab(s)).toBe("t4");
    expect(s.mru[0]).toBe(s.focus);
  });

  test("a removal ends a zoom", () => {
    const zoomed = toggleZoom(resized());
    expect(zoomed.zoom).not.toBeNull();
    expect(repane(zoomed, ["t1", "t2", "t3"], { focus: "t2" }).zoom).toBeNull();
  });

  test("an added tab re-arranges the whole set, as showTogether", () => {
    const options = { focus: "t2", area: WIDE, mode: /** @type {const} */ ("dwindle") };
    const s = repane(resized(), ["t1", "t2", "t5"], options);
    const want = showTogether(["t1", "t2", "t5"], { ...options, preset: "dwindle" });
    expect(tabsOf(s.root)).toBe(tabsOf(want.root));
    close(ratios(s.root), ratios(want.root));
    expect(focusTab(s)).toBe("t2");
    expect(s.layout).toBe("dwindle");
  });

  test("without a tree it is showTogether", () => {
    const s = repane(null, ["a", "b", "c"], { focus: "b", area: WIDE });
    expect(tabsOf(s.root)).toBe("x[a,y[b,c]]");
    expect(focusTab(s)).toBe("b");
  });

  test("the same tabs: the tree is kept, focus moves to the given tab", () => {
    const before = resized();
    const s = repane(before, ["t4", "t3", "t2", "t1"], { focus: "t4" });
    expect(s.root).toBe(before.root);
    expect(focusTab(s)).toBe("t4");
  });

  test("repaneRefusal: removals never refuse; an addition past max does", () => {
    expect(repaneRefusal(resized(), ["t1", "t2"], { max: 1 })).toBeNull();
    expect(repaneRefusal(resized(), ["t1", "t2", "t3", "t4", "t5"], { max: 4 })).toEqual({
      code: "max-panes",
      message: "at most 4 panes",
    });
    expect(repaneRefusal(null, ["a", "b", "c"], { max: 2 })?.code).toBe("max-panes");
  });

  test("fewer than two tabs is a programming error", () => {
    expect(() => repane(resized(), ["t1"], {})).toThrow();
  });
});

describe("togetherRefusal", () => {
  test("more tabs than max: at most N panes", () => {
    expect(togetherRefusal(["a", "b", "c", "d", "e"], { max: 4 })).toEqual({
      code: "max-panes",
      message: "at most 4 panes",
    });
    expect(togetherRefusal(["a", "b", "c", "d"], { max: 4 })).toBeNull();
  });

  test("no space in the preset or the row: core's reason", () => {
    const ids = Array.from({ length: 11 }, (_, i) => `t${i}`);
    expect(togetherRefusal(ids, { max: 16, preset: "even-horizontal" })).toEqual({
      code: "no-space",
      message: "no space for 11 panes in even-horizontal",
    });
    expect(togetherRefusal(ids, { max: 16, mode: "manual" })).toEqual({
      code: "no-space",
      message: "no space for 11 panes in even-horizontal",
    });
    expect(togetherRefusal(ids, { max: 16 })).toBeNull();
  });

  test("max defaults to unbounded", () => {
    expect(togetherRefusal(["a", "b", "c", "d", "e"])).toBeNull();
  });
});
