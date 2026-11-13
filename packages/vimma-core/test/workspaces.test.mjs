import { describe, test, expect } from "vitest";
import fc from "fast-check";
import {
  createWorkspaces,
  addWorkspace,
  renameWorkspace,
  deleteWorkspace,
  switchWorkspace,
  nextWorkspace,
  previousWorkspace,
  openTab,
  closeTab,
  selectTab,
  moveTab,
  splitPane,
  withPanes,
  activeWorkspace,
  findWorkspace,
  workspaceOfTab,
  WorkspaceError,
  MAX_WORKSPACE_ID,
  setWorkspaceContainer,
  workspaceRefFor,
  lastWorkspace,
  alternateWorkspace,
  setAlternate,
  leaveSkipped,
  splitsOf,
} from "../src/workspaces.mjs";
import { createSplits, newSplit } from "../src/splits.mjs";
import { closePane, focus, leaves, resize, setPaneTab, swap, toggleZoom } from "../src/panes.mjs";
import { toSnapshot, readSnapshot } from "../src/snapshot.mjs";

/**
 * The workspace state a snapshot restores to, without its tab renames.
 * @param {unknown} input
 * @param {Parameters<typeof readSnapshot>[1]} [options]
 */
const stateOf = (input, options) => readSnapshot(input, options).state;

/** @param {() => unknown} fn @param {string} code */
function expectWsError(fn, code) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(WorkspaceError);
  expect(/** @type {WorkspaceError} */ (err).code).toBe(code);
}

const two = () =>
  createWorkspaces([
    { name: "work", container: "c-work" },
    { name: "personal", container: "c-personal" },
  ]);

/** work with tabs a, b, c; `b` active */
function abc() {
  let s = two();
  for (const t of ["a", "b", "c"]) s = openTab(s, t);
  return selectTab(s, "b");
}

/** @param {any} s */
const ws = (s) => activeWorkspace(s);
/** @param {any} w */
const paneTabs = (w) => (w.panes ? leaves(w.panes).map((l) => l.tab) : []);

describe("workspace lifecycle", () => {
  test("createWorkspaces makes the first workspace active, empty, with stable ids", () => {
    const s = two();
    expect(ws(s)).toMatchObject({
      id: "w1",
      name: "work",
      container: "c-work",
      tabs: [],
      activeTab: null,
      panes: null,
    });
    expect(s.workspaces.map((w) => w.id)).toEqual(["w1", "w2"]);
    expect(Object.isFrozen(s)).toBe(true);
    expectWsError(() => createWorkspaces([]), "last-workspace");
  });

  test("next/previous wrap around in workspace order", () => {
    let s = two();
    s = nextWorkspace(s);
    expect(ws(s).name).toBe("personal");
    s = nextWorkspace(s);
    expect(ws(s).name).toBe("work");
    expect(ws(previousWorkspace(s)).name).toBe("personal");
  });

  test("switch by index, by name or by id", () => {
    expect(ws(switchWorkspace(two(), { index: 2 })).name).toBe("personal");
    expect(ws(switchWorkspace(two(), { name: "personal" })).name).toBe("personal");
    expect(ws(switchWorkspace(two(), { id: "w2" })).name).toBe("personal");
    const s = two();
    expect(switchWorkspace(s, { index: 1 })).toBe(s);
    expectWsError(() => switchWorkspace(two(), { index: 3 }), "unknown-workspace");
    expectWsError(() => switchWorkspace(two(), { name: "nope" }), "unknown-workspace");
    expect(findWorkspace(two(), { index: 0 })).toBeUndefined();
  });

  test("addWorkspace appends and activates unless asked not to", () => {
    const s = addWorkspace(two(), { name: "admin", container: "c-admin" });
    expect(ws(s)).toMatchObject({ id: "w3", name: "admin" });
    expect(findWorkspace(s, { index: 3 })?.name).toBe("admin");
    const t = addWorkspace(two(), { name: "admin", container: "c-admin" }, { activate: false });
    expect(ws(t).name).toBe("work");
  });

  test.each([
    [{ name: "work", container: "c-x" }, "duplicate-name"],
    [{ name: "  ", container: "c-x" }, "empty-name"],
    [{ name: "x", container: "c-work" }, "duplicate-container"],
    [{ name: "x", container: "" }, "empty-container"],
  ])("addWorkspace(%o) fails with %s", (def, code) => {
    expectWsError(() => addWorkspace(two(), def), code);
  });

  test("names are trimmed", () => {
    expect(ws(addWorkspace(two(), { name: " admin ", container: "c" })).name).toBe("admin");
  });

  test("renameWorkspace keeps id and container; duplicate or empty names fail", () => {
    const s = renameWorkspace(two(), { name: "work" }, "job");
    expect(ws(s)).toMatchObject({ id: "w1", name: "job", container: "c-work" });
    expect(renameWorkspace(s, { id: "w1" }, "job")).toBe(s);
    expectWsError(() => renameWorkspace(two(), { index: 1 }, "personal"), "duplicate-name");
    expectWsError(() => renameWorkspace(two(), { index: 1 }, ""), "empty-name");
    expectWsError(() => renameWorkspace(two(), { index: 9 }, "x"), "unknown-workspace");
  });

  test("deleteWorkspace returns its tabs to close and activates the previous workspace", () => {
    let s = switchWorkspace(abc(), { index: 2 });
    s = openTab(s, "d");
    const r = deleteWorkspace(s, { name: "personal" });
    expect(r.closedTabs).toEqual(["d"]);
    expect(ws(r.state).name).toBe("work");
    expect(r.state.workspaces.length).toBe(1);
  });

  test("deleting the first, active workspace activates the next; the last one cannot go", () => {
    const r = deleteWorkspace(abc(), { index: 1 });
    expect(r.closedTabs).toEqual(["a", "b", "c"]);
    expect(ws(r.state).name).toBe("personal");
    expectWsError(() => deleteWorkspace(r.state, { index: 1 }), "last-workspace");
  });

  test("deleting an inactive workspace keeps the active one", () => {
    const r = deleteWorkspace(abc(), { index: 2 });
    expect(ws(r.state).name).toBe("work");
    expect(r.closedTabs).toEqual([]);
  });
});

describe("explicit workspace ids", () => {
  const uuid = "ws-6f1c2a3e-0b7d-4c55-9a1e-2f3b4c5d6e7f";

  test("createWorkspaces and addWorkspace keep an explicit id; others are minted as before", () => {
    let s = createWorkspaces([
      { name: "work", container: "c-work", id: uuid },
      { name: "personal", container: "c-personal" },
    ]);
    expect(s.workspaces.map((w) => w.id)).toEqual([uuid, "w1"]);
    expect(s.active).toBe(uuid);
    s = addWorkspace(s, { name: "shop", container: "c-shop", id: "ws-shop" }, { activate: false });
    expect(findWorkspace(s, { id: "ws-shop" })?.name).toBe("shop");
    expect(s.active).toBe(uuid);
  });

  test("an explicit id shaped like a minted one moves the counter past it", () => {
    let s = createWorkspaces([{ name: "work", container: "c-work", id: "w7" }]);
    s = addWorkspace(s, { name: "personal", container: "c-personal" });
    expect(s.workspaces.map((w) => w.id)).toEqual(["w7", "w8"]);
    expect(stateOf(toSnapshot(s))).toEqual(s);
  });

  test("explicit ids round-trip through a v1 snapshot", () => {
    const s = createWorkspaces([{ name: "work", container: "c-work", id: uuid }]);
    const snap = toSnapshot(openTab(s, "a"));
    expect(snap.schema).toBe(1);
    expect(stateOf(JSON.stringify(snap))).toEqual(openTab(s, "a"));
  });

  test("a duplicate id is duplicate-id", () => {
    const s = createWorkspaces([{ name: "work", container: "c-work", id: "ws-a" }]);
    expectWsError(
      () => addWorkspace(s, { name: "x", container: "c-x", id: "ws-a" }),
      "duplicate-id",
    );
    expectWsError(
      () =>
        createWorkspaces([
          { name: "a", container: "c-a", id: "same" },
          { name: "b", container: "c-b", id: "same" },
        ]),
      "duplicate-id",
    );
  });

  test.each([
    ["empty", ""],
    ["too long", "x".repeat(MAX_WORKSPACE_ID + 1)],
    ["whitespace", "ws a"],
    ["control character", "ws\u0007"],
    ["not a string", 7],
  ])("a bad id (%s) is bad-id", (_, id) => {
    expectWsError(
      () => createWorkspaces([{ name: "w", container: "c", id: /** @type {any} */ (id) }]),
      "bad-id",
    );
  });

  test("an id of exactly MAX_WORKSPACE_ID characters is fine", () => {
    const id = "x".repeat(MAX_WORKSPACE_ID);
    expect(createWorkspaces([{ name: "w", container: "c", id }]).active).toBe(id);
  });
});

describe("tab bookkeeping", () => {
  test("the first tab creates the pane layout; activating shows it in the focused pane", () => {
    const s = abc();
    expect(ws(s).tabs).toEqual(["a", "b", "c"]);
    expect(ws(s).activeTab).toBe("b");
    expect(paneTabs(ws(s))).toEqual(["b"]);
    expect(workspaceOfTab(s, "c")?.name).toBe("work");
    expect(workspaceOfTab(s, "zz")).toBeUndefined();
  });

  test("openTab after a tab, unactivated, or into another workspace", () => {
    let s = selectTab(abc(), "a");
    s = openTab(s, "d", { after: "a" });
    expect(ws(s).tabs).toEqual(["a", "d", "b", "c"]);
    expect(ws(s).activeTab).toBe("d");
    s = openTab(s, "e", { activate: false });
    expect(ws(s).activeTab).toBe("d");
    s = openTab(s, "f", { workspace: { name: "personal" }, activate: false });
    expect(ws(s).name).toBe("work");
    expect(findWorkspace(s, { index: 2 })).toMatchObject({ tabs: ["f"], activeTab: "f" });
    expectWsError(() => openTab(s, "a"), "duplicate-tab");
    expectWsError(() => openTab(s, "g", { after: "zz" }), "unknown-tab");
  });

  test("closing the active tab activates its right neighbour, else its left", () => {
    let s = closeTab(abc(), "b");
    expect(ws(s).activeTab).toBe("c");
    expect(paneTabs(ws(s))).toEqual(["c"]);
    s = closeTab(s, "c");
    expect(ws(s).activeTab).toBe("a");
    s = closeTab(s, "a");
    expect(ws(s)).toMatchObject({ tabs: [], activeTab: null, panes: null });
    expectWsError(() => closeTab(s, "a"), "unknown-tab");
  });

  // docs/specs/multiple-splits.md decision 2: a split never names a closed tab.
  test("closing a tab of a workspace's splits closes its pane there; one pane left ends it", () => {
    let s = abc();
    const splits = newSplit(createSplits(), ["a", "b", "c"]).splits;
    const active = s.active;
    s = Object.freeze({
      ...s,
      workspaces: Object.freeze(
        s.workspaces.map((w) => (w.id === active ? { ...w, ...splits } : w)),
      ),
    });
    s = closeTab(s, "b");
    expect(splitsOf(ws(s)).splits.map((x) => leaves(x).map((l) => l.tab))).toEqual([["a", "c"]]);
    s = closeTab(s, "c");
    expect(splitsOf(ws(s))).toEqual(createSplits());
  });

  test("splitsOf: a workspace without splits reads its tree as split 1, a lone tab as none", () => {
    expect(splitsOf(ws(abc())).splits).toEqual([]);
    const s = splitPane(selectTab(abc(), "a"), "vertical", "d");
    expect(splitsOf(ws(s)).splits.map((x) => x.number)).toEqual([1]);
  });

  test("closing a hidden tab changes nothing else", () => {
    const s = closeTab(abc(), "a");
    expect(ws(s)).toMatchObject({ tabs: ["b", "c"], activeTab: "b" });
  });

  test("closing a focused tab shown in a split shows the new active tab in that pane", () => {
    let s = selectTab(abc(), "a");
    s = splitPane(s, "vertical", "d"); // tabs a, d, b, c; panes x[a, d], focus d
    expect(ws(s).tabs).toEqual(["a", "d", "b", "c"]);
    expect(paneTabs(ws(s))).toEqual(["a", "d"]);
    s = closeTab(s, "d");
    expect(ws(s).activeTab).toBe("b");
    expect(paneTabs(ws(s))).toEqual(["a", "b"]);
  });

  test("closing a focused tab when its right neighbour is shown elsewhere focuses that pane", () => {
    let s = selectTab(abc(), "a");
    s = splitPane(s, "vertical", "d"); // a, d, b, c
    s = withPanes(s, (p) => focus(p, "left")); // focus a
    s = closeTab(s, "a"); // right neighbour d is shown in the other pane
    expect(paneTabs(ws(s))).toEqual(["d"]);
    expect(ws(s).activeTab).toBe("d");
  });

  test("closing an unfocused tab shown in a pane shows a hidden tab there, else closes the pane", () => {
    let s = selectTab(abc(), "a");
    s = splitPane(s, "vertical", "d"); // x[a, d], focus d; hidden b, c
    s = closeTab(s, "a");
    expect(paneTabs(ws(s))).toEqual(["b", "d"]);
    expect(ws(s).activeTab).toBe("d");
    s = closeTab(closeTab(s, "c"), "b"); // no hidden tab left
    expect(paneTabs(ws(s))).toEqual(["d"]);
  });

  test("selectTab switches to the tab's workspace and focuses its pane if shown", () => {
    let s = openTab(abc(), "p", { workspace: { index: 2 }, activate: false });
    s = selectTab(s, "p");
    expect(ws(s).name).toBe("personal");
    expect(ws(s).activeTab).toBe("p");
    s = switchWorkspace(s, { index: 1 });
    s = splitPane(s, "horizontal", "d"); // x? y[b, d], focus d
    s = selectTab(s, "b");
    expect(paneTabs(ws(s))).toEqual(["b", "d"]);
    expect(ws(s).panes?.focus).toBe("p1");
    expect(selectTab(s, "b")).toBe(s);
    expectWsError(() => selectTab(s, "zz"), "unknown-tab");
  });

  test("moveTab reopens the tab at the end of the target and stays put", () => {
    const s = moveTab(abc(), "a", { name: "personal" }, { newTabId: "a2" });
    expect(ws(s).name).toBe("work");
    expect(ws(s).tabs).toEqual(["b", "c"]);
    expect(findWorkspace(s, { index: 2 })).toMatchObject({ tabs: ["a2"], activeTab: "a2" });
    const t = moveTab(abc(), "b", { index: 2 });
    expect(ws(t).activeTab).toBe("c");
    expect(findWorkspace(t, { index: 2 })?.tabs).toEqual(["b"]);
    const u = abc();
    expect(moveTab(u, "a", { index: 1 })).toBe(u);
    expectWsError(() => moveTab(u, "a", { index: 2 }, { newTabId: "b" }), "duplicate-tab");
  });

  test("moveTab accepts a new tab the host already registered in the target (TabOpen first)", () => {
    // the host reopens the page in the target container; its TabOpen handler registers it there
    let s = openTab(abc(), "a2", { workspace: { name: "personal" }, activate: false });
    s = moveTab(s, "a", { name: "personal" }, { newTabId: "a2" });
    expect(ws(s).tabs).toEqual(["b", "c"]);
    expect(findWorkspace(s, { name: "personal" })).toMatchObject({ tabs: ["a2"], activeTab: "a2" });
  });

  test("moveTab still rejects a new tab registered anywhere but the target", () => {
    let s = addWorkspace(abc(), { name: "admin", container: "c-admin" }, { activate: false });
    s = openTab(s, "x", { workspace: { name: "admin" } });
    expectWsError(() => moveTab(s, "a", { name: "personal" }, { newTabId: "x" }), "duplicate-tab");
    expectWsError(() => moveTab(s, "a", { name: "personal" }, { newTabId: "c" }), "duplicate-tab");
  });

  test("moveTab appends to a target that already has tabs without changing its active tab", () => {
    let s = openTab(abc(), "p", { workspace: { index: 2 } });
    s = moveTab(s, "a", { index: 2 });
    expect(findWorkspace(s, { index: 2 })).toMatchObject({ tabs: ["p", "a"], activeTab: "p" });
  });
});

describe("panes inside workspaces", () => {
  test("splitPane opens the tab after the active one and focuses it", () => {
    const s = splitPane(abc(), "vertical", "d");
    expect(ws(s).tabs).toEqual(["a", "b", "d", "c"]);
    expect(ws(s).activeTab).toBe("d");
    expect(paneTabs(ws(s))).toEqual(["b", "d"]);
  });

  test("a refused splitPane (max panes or no space) returns the state itself", () => {
    const s = splitPane(abc(), "vertical", "d", { max: 2 });
    expect(splitPane(s, "horizontal", "e", { max: 2 })).toBe(s);
    let t = splitPane(abc(), "vertical", "d"); // .5 .5
    t = splitPane(t, "vertical", "e"); // .5 .25 .25
    t = splitPane(t, "vertical", "f"); // .5 .25 .125 .125
    expect(splitPane(t, "vertical", "g")).toBe(t); // no-space
    expect(
      leaves(/** @type {any} */ (ws(splitPane(s, "horizontal", "e", { max: 3 })).panes)),
    ).toHaveLength(3);
  });

  test("withPanes applies a pane op and syncs the active tab", () => {
    let s = splitPane(abc(), "vertical", "d");
    s = withPanes(s, (p) => focus(p, "left"));
    expect(ws(s).activeTab).toBe("b");
    const z = withPanes(s, toggleZoom);
    expect(ws(z).panes?.zoom).toBe("p1");
    expect(withPanes(s, (p) => p)).toBe(s);
  });

  test("a pane op that shows a tab of no workspace's list is rejected", () => {
    expectWsError(() => withPanes(abc(), (p) => setPaneTab(p, p.focus, "stray")), "unknown-tab");
  });

  test("pane ops on an empty workspace fail; splitPane in one opens a single pane", () => {
    expectWsError(() => withPanes(two(), (p) => p), "no-tab");
    const s = splitPane(two(), "vertical", "x");
    expect(paneTabs(ws(s))).toEqual(["x"]);
  });
});

// --- properties --------------------------------------------------------------------------------

const opArb = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      op: fc.constant("open"),
      w: fc.nat(),
      activate: fc.boolean(),
      after: fc.boolean(),
    }),
  },
  { weight: 3, arbitrary: fc.record({ op: fc.constant("close"), pick: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("select"), pick: fc.nat() }) },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant("move"),
      pick: fc.nat(),
      w: fc.nat(),
      id: fc.constantFrom("same", "new", "registered"),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      op: fc.constant("pane"),
      kind: fc.constantFrom("close", "swap", "zoom", "resize"),
      pick: fc.nat(),
      dir: fc.constantFrom("left", "down", "up", "right"),
      grow: fc.constantFrom("wider", "narrower", "taller", "shorter"),
      amount: fc.double({ min: 0.01, max: 1, noNaN: true }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("previous") }) },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant("split"),
      dir: fc.constantFrom("vertical", "horizontal"),
      max: fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant("focus"),
      dir: fc.constantFrom("left", "down", "up", "right"),
    }),
  },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("switch"), w: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("next") }) },
  {
    weight: 1,
    arbitrary: fc.record({
      op: fc.constant("add"),
      id: fc.option(fc.constantFrom("w2", "w3", "w9", "ws-a", "ws-b"), { nil: undefined }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("delete"), w: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("rename"), w: fc.nat() }) },
);

/** @param {any[]} ops */
function run(ops) {
  let s = two();
  let n = 0;
  for (const o of ops) {
    const all = s.workspaces.flatMap((w) => w.tabs);
    const tab = all.length ? all[(o.pick ?? 0) % all.length] : undefined;
    const wref = { index: ((o.w ?? 0) % s.workspaces.length) + 1 };
    switch (o.op) {
      case "open": {
        const target = /** @type {any} */ (findWorkspace(s, wref));
        const after = o.after && target.activeTab ? target.activeTab : undefined;
        s = openTab(s, `t${n++}`, { workspace: wref, activate: o.activate, after });
        break;
      }
      case "close":
        if (tab) s = closeTab(s, tab);
        break;
      case "select":
        if (tab) s = selectTab(s, tab);
        break;
      case "move": {
        if (!tab) break;
        if (o.id === "same") s = moveTab(s, tab, wref);
        else if (o.id === "new") s = moveTab(s, tab, wref, { newTabId: `t${n++}` });
        else if (workspaceOfTab(s, tab) !== findWorkspace(s, wref)) {
          const id = `t${n++}`;
          s = openTab(s, id, { workspace: wref, activate: false });
          s = moveTab(s, tab, wref, { newTabId: id });
        }
        break;
      }
      case "pane": {
        if (!activeWorkspace(s).panes) break;
        s = withPanes(s, (p) => {
          const ls = leaves(p);
          const target = /** @type {any} */ (ls[o.pick % ls.length]).pane;
          if (o.kind === "close") return ls.length > 1 ? closePane(p, target) : p;
          if (o.kind === "swap") return swap(p, o.dir);
          if (o.kind === "zoom") return toggleZoom(p);
          return resize(p, o.grow, o.amount);
        });
        break;
      }
      case "previous":
        s = previousWorkspace(s);
        break;
      case "split":
        s = splitPane(s, o.dir, `t${n++}`, { max: o.max });
        break;
      case "focus":
        if (activeWorkspace(s).panes) s = withPanes(s, (p) => focus(p, o.dir));
        break;
      case "switch":
        s = switchWorkspace(s, wref);
        break;
      case "next":
        s = nextWorkspace(s);
        break;
      case "add": {
        // explicit ids too, some shaped like minted ones (w<n>)
        const id = o.id && !findWorkspace(s, { id: o.id }) ? o.id : undefined;
        s = addWorkspace(s, { name: `ws${n}`, container: `c${n}`, id }, { activate: false });
        n++;
        break;
      }
      case "delete":
        if (s.workspaces.length > 1) s = deleteWorkspace(s, wref).state;
        break;
      case "rename":
        s = renameWorkspace(s, wref, `renamed${n++}`);
        break;
    }
  }
  return s;
}

const stateArb = fc.array(opArb, { maxLength: 60 }).map(run);

describe("workspace properties", () => {
  test("every tab is in exactly one workspace; active tab, panes and tabs agree", () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        const all = s.workspaces.flatMap((w) => w.tabs);
        expect(new Set(all).size).toBe(all.length);
        expect(s.workspaces.map((w) => w.id)).toContain(s.active);
        const names = s.workspaces.map((w) => w.name);
        const containers = s.workspaces.map((w) => w.container);
        expect(new Set(names).size).toBe(names.length);
        expect(new Set(containers).size).toBe(containers.length);
        if (s.alternate !== undefined) {
          expect(s.workspaces.map((w) => w.id)).toContain(s.alternate);
          expect(s.alternate).not.toBe(s.active);
        }
        for (const w of s.workspaces) {
          if (w.tabs.length === 0) {
            expect(w.activeTab).toBeNull();
            expect(w.panes).toBeNull();
            continue;
          }
          expect(w.panes).not.toBeNull();
          const p = /** @type {import("../src/panes.mjs").Panes} */ (w.panes);
          expect(w.tabs).toContain(w.activeTab);
          const shown = leaves(p);
          expect(shown.find((l) => l.pane === p.focus)?.tab).toBe(w.activeTab);
          for (const l of shown) expect(w.tabs).toContain(l.tab);
        }
      }),
    );
  });

  test("readSnapshot(toSnapshot(s)) restores s", () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        const back = stateOf(JSON.stringify(toSnapshot(s)));
        expect(back).toEqual(s);
      }),
    );
  });
});

describe("container and typed references (m3 leftovers)", () => {
  test("setWorkspaceContainer swaps a workspace's container, keeping its tabs", () => {
    const s = abc();
    const next = setWorkspaceContainer(s, { name: "work" }, "c-new");
    expect(findWorkspace(next, { name: "work" })).toMatchObject({
      container: "c-new",
      tabs: ["a", "b", "c"],
      activeTab: "b",
    });
    expect(setWorkspaceContainer(next, { name: "work" }, "c-new")).toBe(next);
    expectWsError(
      () => setWorkspaceContainer(s, { name: "work" }, "c-personal"),
      "duplicate-container",
    );
    expectWsError(() => setWorkspaceContainer(s, { name: "work" }, ""), "empty-container");
    expectWsError(() => setWorkspaceContainer(s, { name: "nope" }, "x"), "unknown-workspace");
  });

  test("workspaceRefFor: an exact name first, then digits as a place, else a name", () => {
    const s = createWorkspaces([
      { name: "2", container: "c1" },
      { name: "x", container: "c2" },
      { name: "main", container: "c3" },
    ]);
    expect(workspaceRefFor(s, "2")).toEqual({ name: "2" });
    expect(workspaceRefFor(s, "3")).toEqual({ index: 3 });
    expect(workspaceRefFor(s, "x")).toEqual({ name: "x" });
    expect(workspaceRefFor(s, "9")).toEqual({ index: 9 });
    expect(workspaceRefFor(null, "2")).toEqual({ index: 2 });
    expect(workspaceRefFor(s, "nowhere")).toEqual({ name: "nowhere" });
  });
});

describe("the alternate workspace (Vim's ctrl+^)", () => {
  const three = () =>
    addWorkspace(two(), { name: "admin", container: "c-admin" }, { activate: false });

  test("a fresh model has none, and lastWorkspace leaves it as it is", () => {
    const s = three();
    expect(s.alternate).toBeUndefined();
    expect(alternateWorkspace(s)).toBeUndefined();
    expect(lastWorkspace(s)).toBe(s);
  });

  test("every switch remembers the workspace it left; lastWorkspace toggles between two", () => {
    let s = switchWorkspace(three(), { name: "admin" });
    expect(alternateWorkspace(s)?.name).toBe("work");
    s = lastWorkspace(s);
    expect(ws(s).name).toBe("work");
    expect(alternateWorkspace(s)?.name).toBe("admin");
    s = lastWorkspace(s);
    expect(ws(s).name).toBe("admin");
    expect(alternateWorkspace(s)?.name).toBe("work");
  });

  test("a switch to the active workspace changes nothing", () => {
    const s = switchWorkspace(three(), { name: "admin" });
    expect(switchWorkspace(s, { name: "admin" })).toBe(s);
  });

  test("next, previous, selectTab and a new active workspace set it too", () => {
    expect(alternateWorkspace(nextWorkspace(three()))?.name).toBe("work");
    expect(alternateWorkspace(previousWorkspace(three()))?.name).toBe("work");
    let s = openTab(three(), "x", { workspace: { name: "personal" } });
    s = selectTab(s, "x");
    expect(ws(s).name).toBe("personal");
    expect(alternateWorkspace(s)?.name).toBe("work");
    expect(selectTab(s, "x")).toBe(s);
    const t = addWorkspace(three(), { name: "shop", container: "c-shop" });
    expect(alternateWorkspace(t)?.name).toBe("work");
  });

  test("deleting the alternate forgets it; deleting the active one keeps a different one", () => {
    let s = switchWorkspace(three(), { name: "admin" });
    expect(deleteWorkspace(s, { name: "work" }).state.alternate).toBeUndefined();
    s = switchWorkspace(s, { name: "personal" }); // alternate admin
    const r = deleteWorkspace(s, { name: "personal" }); // work becomes active
    expect(ws(r.state).name).toBe("work");
    expect(alternateWorkspace(r.state)?.name).toBe("admin");
    s = switchWorkspace(switchWorkspace(three(), { name: "personal" }), { name: "admin" });
    // admin goes; personal (its previous) becomes active and was the alternate: none left
    const q = deleteWorkspace(s, { name: "admin" });
    expect(ws(q.state).name).toBe("personal");
    expect(q.state.alternate).toBeUndefined();
  });

  test("setAlternate takes a known workspace other than the active one, else clears it", () => {
    const s = three();
    expect(alternateWorkspace(setAlternate(s, "w3"))?.name).toBe("admin");
    expect(setAlternate(s, "w1").alternate).toBeUndefined();
    expect(setAlternate(s, "nope").alternate).toBeUndefined();
    expect(setAlternate(setAlternate(s, "w3"), undefined).alternate).toBeUndefined();
    expect(setAlternate(s, undefined)).toBe(s);
    const t = setAlternate(s, "w2");
    expect(setAlternate(t, "w2")).toBe(t);
    expect(Object.isFrozen(t)).toBe(true);
  });

  test("the alternate round-trips through a snapshot; an unusable one is dropped", () => {
    const s = switchWorkspace(three(), { name: "admin" });
    const snap = toSnapshot(s);
    expect(snap.alternate).toBe("w1");
    expect(stateOf(JSON.stringify(snap))).toEqual(s);
    expect("alternate" in toSnapshot(three())).toBe(false);
    for (const bad of ["w3", "nope", 7, null]) {
      const back = stateOf({ ...snap, alternate: bad });
      expect(back.alternate).toBeUndefined();
    }
  });
});

// docs/specs/vimma-mcp.md, decision 9: the agent workspace is in the picker, never in the cycle
// or the alternate.
describe("skipped workspaces (the agent workspace)", () => {
  const withAgent = () =>
    addWorkspace(
      createWorkspaces([
        { id: "main", name: "main", container: "1" },
        { id: "work", name: "work", container: "2" },
      ]),
      { id: "agent", name: "agent", container: "3" },
      { activate: false },
    );
  const skip = new Set(["agent"]);

  test("next from work is main, previous from main is work: never agent", () => {
    const fromWork = switchWorkspace(withAgent(), { id: "work" });
    expect(ws(nextWorkspace(fromWork, skip)).name).toBe("main");
    expect(ws(previousWorkspace(withAgent(), skip)).name).toBe("work");
    let s = withAgent();
    const seen = [];
    for (let i = 0; i < 3; i++) {
      s = nextWorkspace(s, skip);
      seen.push(ws(s).name);
    }
    expect(seen).toEqual(["work", "main", "work"]);
    // Without a skip set, the cycle is every workspace, as before.
    expect(ws(nextWorkspace(fromWork)).name).toBe("agent");
  });

  test("from inside agent, next and previous go to the neighbouring cycled workspaces", () => {
    const inAgent = switchWorkspace(withAgent(), { id: "agent" });
    expect(ws(nextWorkspace(inAgent, skip)).name).toBe("main");
    expect(ws(previousWorkspace(inAgent, skip)).name).toBe("work");
  });

  test("only skipped workspaces besides the active one: the cycle stays put", () => {
    const s = createWorkspaces([
      { id: "main", name: "main", container: "1" },
      { id: "agent", name: "agent", container: "3" },
    ]);
    expect(nextWorkspace(s, skip)).toBe(s);
    expect(previousWorkspace(s, skip)).toBe(s);
  });

  test("from agent, the alternate is where you came from", () => {
    const s = switchWorkspace(switchWorkspace(withAgent(), { id: "work" }), { id: "agent" });
    expect(alternateWorkspace(s, skip)?.name).toBe("work");
    expect(ws(lastWorkspace(s, skip)).name).toBe("work");
  });

  test("leaving agent keeps the alternate of before: work's alternate is main, never agent", () => {
    // main → agent → work
    const inAgent = switchWorkspace(withAgent(), { id: "agent" });
    const raw = switchWorkspace(inAgent, { id: "work" });
    const s = leaveSkipped(inAgent, raw, skip);
    expect(alternateWorkspace(s, skip)?.name).toBe("main");
    expect(ws(lastWorkspace(s, skip)).name).toBe("main");
    // A switch that does not leave a skipped workspace is returned as it is.
    const onward = nextWorkspace(raw, skip);
    expect(leaveSkipped(raw, onward, skip)).toBe(onward);
  });

  test("an alternate that is skipped is never landed on from a cycled workspace", () => {
    const inAgent = switchWorkspace(withAgent(), { id: "agent" });
    const s = switchWorkspace(inAgent, { id: "work" }); // alternate agent, not fixed up
    expect(alternateWorkspace(s, skip)).toBeUndefined();
    expect(lastWorkspace(s, skip)).toBe(s);
    expect(alternateWorkspace(s)?.name).toBe("agent");
  });

  test("addWorkspace `before` puts a new workspace ahead of another (agent stays last)", () => {
    const s = addWorkspace(
      withAgent(),
      { id: "shop", name: "shop", container: "4" },
      {
        activate: false,
        before: "agent",
      },
    );
    expect(s.workspaces.map((w) => w.name)).toEqual(["main", "work", "shop", "agent"]);
    const end = addWorkspace(withAgent(), { name: "x", container: "5" }, { before: "nope" });
    expect(end.workspaces.map((w) => w.name)).toEqual(["main", "work", "agent", "x"]);
  });
});
