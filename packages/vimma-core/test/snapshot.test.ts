import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import {
  SCHEMA_VERSION,
  SNAPSHOT_MIGRATIONS,
  toSnapshot,
  readSnapshot,
  migrateSnapshot,
  canWrite,
  SnapshotError,
} from "../src/workspaces/snapshot.mjs";
import { activeWorkspace, splitsOf } from "../src/workspaces/workspaces.mjs";
import { createRow } from "../src/panes/panes.mjs";

/** A written snapshot's first workspace; throws when it has none, so no assertion reads past it. */
function firstOf(snapshot: ReturnType<typeof toSnapshot>) {
  const w = snapshot.workspaces[0];
  if (!w) throw new Error("the snapshot has no workspace");
  return w;
}

/** The workspace state a snapshot restores to, without its tab renames. */
const stateOf = (input: unknown, options?: Parameters<typeof readSnapshot>[1]) =>
  readSnapshot(input, options).state;

const fixture = (name: string) =>
  readFileSync(new URL(`../../../tests/contract/state/v1/${name}`, import.meta.url), "utf8");

function snapshotError(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SnapshotError);
    return e as SnapshotError;
  }
  throw new Error("expected a SnapshotError");
}

describe("contract fixtures, schema v1", () => {
  test("valid.json loads and round-trips through toSnapshot", () => {
    const s = stateOf(fixture("valid.json"));
    expect(activeWorkspace(s).name).toBe("personal");
    expect(activeWorkspace(s).panes?.zoom).toBe("p1");
    expect(toSnapshot(s)).toEqual(JSON.parse(fixture("valid.json")));
    expect(SCHEMA_VERSION).toBe(1);
  });

  test("invalid.json fails with a SnapshotError naming the path", () => {
    const e = snapshotError(() => stateOf(fixture("invalid.json")));
    expect(e.path).toBe("workspaces[0].panes.root.ratios");
    expect(e.message).toMatch(/workspaces\[0\]\.panes\.root\.ratios/);
  });
});

function mutated(mutate: (raw: any) => void) {
  const raw = JSON.parse(fixture("valid.json"));
  mutate(raw);
  return raw;
}

describe("validation", () => {
  test.each([
    ["schema missing", (r) => delete r.schema, "schema"],
    ["no workspaces", (r) => (r.workspaces = []), "workspaces"],
    ["workspaces not an array", (r) => (r.workspaces = {}), "workspaces"],
    ["unknown active", (r) => (r.active = "w9"), "active"],
    ["next too small", (r) => (r.next = 3), "next"],
    ["workspace not an object", (r) => (r.workspaces[2] = 7), "workspaces[2]"],
    ["duplicate workspace id", (r) => (r.workspaces[1].id = "w1"), "workspaces[1].id"],
    ["workspace id too long", (r) => (r.workspaces[1].id = "x".repeat(129)), "workspaces[1].id"],
    ["workspace id with a space", (r) => (r.workspaces[1].id = "w 2"), "workspaces[1].id"],
    ["duplicate name", (r) => (r.workspaces[1].name = "work"), "workspaces[1].name"],
    ["empty name", (r) => (r.workspaces[1].name = " "), "workspaces[1].name"],
    [
      "duplicate container",
      (r) => (r.workspaces[2].container = "vimma-work"),
      "workspaces[2].container",
    ],
    ["tab in two workspaces", (r) => (r.workspaces[1].tabs = ["tab-a"]), "workspaces[1].tabs[0]"],
    ["non-string tab", (r) => (r.workspaces[0].tabs[1] = 5), "workspaces[0].tabs[1]"],
    [
      "active tab not in tabs",
      (r) => (r.workspaces[0].activeTab = "tab-z"),
      "workspaces[0].activeTab",
    ],
    [
      "active tab not focused",
      (r) => (r.workspaces[0].activeTab = "tab-a"),
      "workspaces[0].activeTab",
    ],
    [
      "empty workspace with an active tab",
      (r) => (r.workspaces[2].activeTab = "tab-x"),
      "workspaces[2].activeTab",
    ],
    [
      "empty workspace with panes",
      (r) => (r.workspaces[2].panes = r.workspaces[1].panes),
      "workspaces[2].panes",
    ],
    ["tabs without panes", (r) => (r.workspaces[1].panes = null), "workspaces[1].panes"],
    [
      "unknown node type",
      (r) => (r.workspaces[1].panes.root.type = "tree"),
      "workspaces[1].panes.root.type",
    ],
    ["bad axis", (r) => (r.workspaces[0].panes.root.axis = "z"), "workspaces[0].panes.root.axis"],
    [
      "one-child split",
      (r) => r.workspaces[0].panes.root.children.pop(),
      "workspaces[0].panes.root.children",
    ],
    [
      "ratios count",
      (r) => r.workspaces[0].panes.root.ratios.push(0),
      "workspaces[0].panes.root.ratios",
    ],
    [
      "negative ratio",
      (r) => (r.workspaces[0].panes.root.ratios = [1.5, -0.5]),
      "workspaces[0].panes.root.ratios",
    ],
    [
      "nested split on the same axis",
      (r) => (r.workspaces[0].panes.root.children[1].axis = "x"),
      "workspaces[0].panes.root.children[1].axis",
    ],
    [
      "pane tab not in the workspace",
      (r) => (r.workspaces[0].panes.root.children[0].tab = "tab-d"),
      "workspaces[0].panes.root.children[0].tab",
    ],
    [
      "tab shown twice",
      (r) => (r.workspaces[0].panes.root.children[0].tab = "tab-b"),
      "workspaces[0].panes.root.children[1].children[0].tab",
    ],
    [
      "duplicate pane id",
      (r) => (r.workspaces[0].panes.root.children[0].pane = "p2"),
      "workspaces[0].panes.root.children[1].children[0].pane",
    ],
    [
      "name with surrounding spaces",
      (r) => (r.workspaces[1].name = " personal"),
      "workspaces[1].name",
    ],
    [
      "mru missing a pane",
      (r) => (r.workspaces[0].panes.mru = ["p3", "p2"]),
      "workspaces[0].panes.mru",
    ],
    [
      "mru not led by focus",
      (r) => (r.workspaces[0].panes.mru = ["p2", "p3", "p1"]),
      "workspaces[0].panes.mru",
    ],
    [
      "mru repeats a pane",
      (r) => (r.workspaces[0].panes.mru = ["p3", "p3", "p1"]),
      "workspaces[0].panes.mru",
    ],
    ["focus not a leaf", (r) => (r.workspaces[0].panes.focus = "p9"), "workspaces[0].panes.focus"],
    ["zoom not a leaf", (r) => (r.workspaces[0].panes.zoom = "p9"), "workspaces[0].panes.zoom"],
    ["pane next too small", (r) => (r.workspaces[0].panes.next = 2), "workspaces[0].panes.next"],
    ["panes not an object", (r) => (r.workspaces[0].panes = "x"), "workspaces[0].panes"],
  ] as Array<[string, (raw: any) => void, string]>)("%s → %s", (_, mutate, path) => {
    expect(snapshotError(() => stateOf(mutated(mutate))).path).toBe(path);
  });

  test("a same-axis child split is accepted when flattening would squeeze a pane below MIN_RATIO", () => {
    const raw = mutated((r) => {
      const inner = r.workspaces[0].panes.root.children[1];
      inner.axis = "x";
      inner.ratios = [0.15, 0.85]; // 0.15 × 0.5 < MIN_RATIO
    });
    expect(stateOf(raw).workspaces[0]?.panes?.root).toMatchObject({
      children: [{ type: "leaf" }, { axis: "x", ratios: [0.15, 0.85] }],
    });
  });

  test("broken JSON and non-objects are rejected", () => {
    expect(snapshotError(() => stateOf("{")).code).toBe("bad-json");
    expect(snapshotError(() => stateOf("[]")).path).toBe("");
    expect(snapshotError(() => stateOf(null)).code).toBe("invalid");
  });
});

describe("panes.layout (docs/specs/tiling-layouts.md): optional, no schema bump", () => {
  const withLayout = (layout: unknown) =>
    mutated((r) => {
      const w = r.workspaces.find((x: any) => x.panes?.root.type === "split");
      w.panes.layout = layout;
    });
  const read = (raw: any) =>
    (stateOf(raw) as any).workspaces.find((w: any) => w.panes?.root.type === "split").panes;

  test("a preset name is kept and written back", () => {
    const raw = withLayout("tiled");
    const panes = read(raw);
    expect(panes.layout).toBe("tiled");
    expect(toSnapshot(stateOf(raw))).toEqual(raw);
    expect(raw.schema).toBe(SCHEMA_VERSION);
  });

  test.each([["grid"], [3], [null]])("%s is dropped without failing the restore", (bad) => {
    const panes = read(withLayout(bad));
    expect("layout" in panes).toBe(false);
  });

  test("a snapshot without it reads as before (no layout key)", () => {
    expect("layout" in read(JSON.parse(fixture("valid.json")))).toBe(false);
  });
});

describe("migrations", () => {
  test("a newer schema is unsupported", () => {
    const e = snapshotError(() => stateOf(mutated((r) => (r.schema = 2))));
    expect(e.code).toBe("unsupported-schema");
    expect(e.path).toBe("schema");
  });

  test("an older schema without a migration step is unsupported", () => {
    expect(snapshotError(() => stateOf(mutated((r) => (r.schema = 0)))).code).toBe(
      "unsupported-schema",
    );
    expect(Object.keys(SNAPSHOT_MIGRATIONS)).toEqual([]);
  });

  test("an injected 0 → 1 step migrates a v0 file", () => {
    // pretend v0 called containers "identity"
    const v0 = mutated((r) => {
      r.schema = 0;
      for (const w of r.workspaces) {
        w.identity = w.container;
        delete w.container;
      }
    });
    const migrations = {
      0: (raw: any) => ({
        ...raw,
        schema: 1,
        workspaces: raw.workspaces.map(({ identity, ...w }: any) => ({
          ...w,
          container: identity,
        })),
      }),
    };
    expect(migrateSnapshot(v0, migrations).schema).toBe(1);
    expect(toSnapshot(stateOf(v0, { migrations }))).toEqual(JSON.parse(fixture("valid.json")));
  });

  test("a migration that does not advance the schema throws instead of looping", () => {
    const v0 = mutated((r) => (r.schema = 0));
    const stuck = { 0: (raw: any) => raw };
    const e = snapshotError(() => migrateSnapshot(v0, stuck));
    expect(e.code).toBe("bad-migration");
    expect(e.path).toBe("schema");
    const garbage = { 0: () => 42 };
    expect(snapshotError(() => migrateSnapshot(v0, garbage)).code).toBe("bad-migration");
  });

  test("a current snapshot passes through migrateSnapshot untouched", () => {
    const raw = JSON.parse(fixture("valid.json"));
    expect(migrateSnapshot(raw)).toBe(raw);
  });
});

describe("canWrite: never overwrite a file from a newer vimma", () => {
  test.each([
    ["no file", null, true],
    ["a v1 file", fixture("valid.json"), true],
    ["a v1 object", JSON.parse(fixture("valid.json")), true],
    ["an older file", JSON.stringify({ schema: 0 }), true],
    ["a newer file", JSON.stringify({ schema: 2, anything: true }), false],
    ["a newer object", { schema: 7 }, false],
    ["unreadable JSON", "{ not json", true],
    ["no schema", JSON.stringify({ workspaces: [] }), true],
  ])("%s → %s", (_, existing, expected) => {
    expect(canWrite(existing)).toBe(expected);
  });
});

// docs/specs/side-panel-unsplit.md decision 24: a hidden view and the tab shown alone over it.
describe("panes.hidden and alone: optional, no schema bump", () => {
  /** w1's split hidden, tab-z shown alone; activeTab stays the focused pane's tab (tab-c). */
  const hidden = (more: (w: any) => void = () => {}) =>
    mutated((r) => {
      const w = r.workspaces[0];
      w.tabs.push("tab-z");
      w.panes.hidden = true;
      w.alone = "tab-z";
      more(w);
    });
  const w1 = (raw: any) => (stateOf(raw) as any).workspaces[0];

  test("a hidden view reads with the alone tab as the active one, and writes back", () => {
    const raw = hidden();
    const w = w1(raw);
    expect(w.panes.hidden).toBe(true);
    expect(w.activeTab).toBe("tab-z");
    expect(toSnapshot(stateOf(raw))).toEqual(raw);
    expect(raw.schema).toBe(SCHEMA_VERSION);
  });

  test("the file keeps activeTab on the focused pane, so an older reader shows the split", () => {
    const raw = hidden();
    expect(raw.workspaces[0].activeTab).toBe("tab-c");
    const written = toSnapshot(stateOf(raw));
    expect(firstOf(written).activeTab).toBe("tab-c");
    expect(firstOf(written).alone).toBe("tab-z");
  });

  test.each([
    ["no alone tab", (w: any) => delete w.alone],
    ["an alone tab not in the workspace", (w: any) => (w.alone = "tab-d")],
    ["an alone tab that is a pane's", (w: any) => (w.alone = "tab-a")],
    ["hidden not true", (w: any) => (w.panes.hidden = "yes")],
  ])("%s: the view reads as shown, without failing", (_, change) => {
    const w = w1(hidden(change));
    expect("hidden" in w.panes).toBe(false);
    expect(w.activeTab).toBe("tab-c");
  });

  test("a one-pane tree is never hidden", () => {
    const raw = mutated((r) => {
      r.workspaces[1].panes.hidden = true;
    });
    expect("hidden" in (stateOf(raw) as any).workspaces[1].panes).toBe(false);
  });

  test("a snapshot without them reads as before", () => {
    const w = w1(JSON.parse(fixture("valid.json")));
    expect("hidden" in w.panes).toBe(false);
    expect(toSnapshot(stateOf(fixture("valid.json"))).workspaces[0]).not.toHaveProperty("alone");
  });
});

// docs/specs/multiple-splits.md decision 15: every split of a workspace, with the old fields kept.
describe("splits: a list, with panes and activeTab kept for an older reader", () => {
  /** w1 (tabs a-c in valid.json's tree) gains tab-x and tab-y, a second split numbered 3. */
  const several = (o: { shown?: number | null; alone?: string } = {}) => {
    const base = stateOf(fixture("valid.json"));
    const w = base.workspaces[0] as any;
    const one = Object.freeze({ ...w.panes, number: 1 });
    const three = Object.freeze({
      ...createRow(["tab-x", "tab-y"], { focus: "tab-y" }),
      number: 3,
    });
    const shown = o.shown === undefined ? 3 : o.shown;
    const activeTab = o.alone ?? (shown === 1 ? "tab-c" : "tab-y");
    const w1 = Object.freeze({
      ...w,
      tabs: Object.freeze([...w.tabs, "tab-x", "tab-y", "tab-z"]),
      activeTab,
      splits: Object.freeze([one, three]),
      shown,
      last: shown ?? 1,
    });
    return Object.freeze({ ...base, workspaces: Object.freeze([w1, ...base.workspaces.slice(1)]) });
  };
  const w1 = (s: any) => (s as any).workspaces[0];

  test("several splits round-trip with their numbers and the shown one", () => {
    const written = toSnapshot(several());
    expect(firstOf(written).splits.map((x: any) => x.number)).toEqual([1, 3]);
    expect(firstOf(written).shown).toBe(3);
    const back = stateOf(JSON.parse(JSON.stringify(written)));
    expect(w1(back).splits.map((x: any) => x.number)).toEqual([1, 3]);
    expect(w1(back).shown).toBe(3);
    expect(w1(back).last).toBe(3);
    expect(w1(back).activeTab).toBe("tab-y");
    expect(w1(back).splits[1].focus).toBe(w1(several()).splits[1].focus);
    expect(toSnapshot(back)).toEqual(written);
  });

  test("the written panes is the shown split, as an older reader expects it", () => {
    const written = toSnapshot(several());
    const w = firstOf(written);
    expect(w.panes.root).toEqual(w.splits[1].root);
    expect(w.panes).not.toHaveProperty("number");
    expect(w.panes).not.toHaveProperty("hidden");
    expect(w.activeTab).toBe("tab-y");
    expect(w).not.toHaveProperty("alone");
    // An older reader sees one split, shown, and needs nothing else.
    const older = JSON.parse(JSON.stringify(written));
    for (const x of older.workspaces) {
      delete x.splits;
      delete x.shown;
    }
    expect(w1(stateOf(older)).panes.root).toEqual(w.splits[1].root);
  });

  test("on a lone tab: shown is null, panes is the split shown last, hidden, alone kept", () => {
    const written = toSnapshot(several({ shown: null, alone: "tab-z" }));
    const w = firstOf(written);
    expect(w.shown).toBeNull();
    expect(w.panes.hidden).toBe(true);
    expect(w.panes.root).toEqual(w.splits[0].root);
    expect(w.activeTab).toBe("tab-c");
    expect(w.alone).toBe("tab-z");
    const back = w1(stateOf(JSON.parse(JSON.stringify(written))));
    expect(back.shown).toBeNull();
    expect(back.last).toBe(1);
    expect(back.activeTab).toBe("tab-z");
  });

  test("a file with only panes reads as one split, number 1, and writes back unchanged", () => {
    const s = stateOf(fixture("valid.json"));
    expect(w1(s)).not.toHaveProperty("splits");
    const one = splitsOf(w1(s));
    expect(one.splits.map((x) => x.number)).toEqual([1]);
    expect(one.shown).toBe(1);
    expect(one.splits[0]?.root).toEqual(w1(s).panes.root);
    expect(splitsOf((s as any).workspaces[1]).splits).toEqual([]);
    expect(toSnapshot(s)).toEqual(JSON.parse(fixture("valid.json")));
  });

  test("a hidden panes with alone reads as split 1, not shown", () => {
    const raw = mutated((r) => {
      r.workspaces[0].tabs.push("tab-z");
      r.workspaces[0].panes.hidden = true;
      r.workspaces[0].alone = "tab-z";
    });
    expect(splitsOf(w1(stateOf(raw)))).toMatchObject({ shown: null, last: 1 });
  });

  const damaged = (damage: (splits: any[]) => void) => {
    const raw = JSON.parse(JSON.stringify(toSnapshot(several())));
    damage(raw.workspaces[0].splits);
    return w1(stateOf(raw));
  };

  test.each([
    ["a repeated number", (x: any[]) => (x[1].number = 1)],
    ["a number out of range", (x: any[]) => (x[1].number = 10)],
    ["a number that is not an integer", (x: any[]) => (x[1].number = "3")],
    ["a tab of an earlier split", (x: any[]) => (x[1].root.children[0].tab = "tab-a")],
    ["a malformed tree", (x: any[]) => (x[1].root.ratios = [0.9, 0.9])],
    ["a tab not in the workspace", (x: any[]) => (x[1].root.children[0].tab = "t-q")],
    ["one pane only", (x: any[]) => (x[1].root = x[1].root.children[0])],
    ["not an object", (x: any[]) => (x[1] = 7)],
  ])("%s: that entry is dropped, the rest of the file reads", (_, damage) => {
    const w = damaged(damage);
    expect(w.splits.map((x: any) => x.number)).toEqual([1]);
    expect(w.shown).toBeNull();
  });

  test("a splits field that is not an array reads as no splits", () => {
    const raw = JSON.parse(JSON.stringify(toSnapshot(several())));
    raw.workspaces[0].splits = { 1: "x" };
    expect(w1(stateOf(raw)).splits).toEqual([]);
  });

  test("property: a tab is never in two splits after a read, whatever the file says", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 11 }), fc.constantFrom(0, 1)), {
          maxLength: 6,
        }),
        (entries) => {
          const raw = JSON.parse(JSON.stringify(toSnapshot(several())));
          const [one, three] = raw.workspaces[0].splits;
          raw.workspaces[0].splits = entries.map(([n, which]) => ({
            ...JSON.parse(JSON.stringify(which ? three : one)),
            number: n,
          }));
          const w = w1(stateOf(raw));
          const tabs = w.splits.flatMap((x: any) => JSON.stringify(x.root).match(/tab-[a-z]/g));
          expect(new Set(tabs).size).toBe(tabs.length);
          const ns = w.splits.map((x: any) => x.number);
          expect(new Set(ns).size).toBe(ns.length);
          expect(ns.every((n: number) => n >= 1 && n <= 9)).toBe(true);
        },
      ),
    );
  });
});

// #1119: mutants the tests above let through.
describe("validation: what each refusal says", () => {
  test.each([
    ["schema missing", (r) => delete r.schema, "schema: missing or not an integer"],
    ["next too small", (r) => (r.next = 3), "next: must be an integer above 3"],
    ["no workspaces", (r) => (r.workspaces = []), "workspaces: need at least one workspace"],
    ["workspace not an object", (r) => (r.workspaces[2] = 7), "workspaces[2]: must be an object"],
    [
      "duplicate workspace id",
      (r) => (r.workspaces[1].id = "w1"),
      "workspaces[1].id: missing, malformed or duplicate",
    ],
    [
      "empty name",
      (r) => (r.workspaces[1].name = ""),
      "workspaces[1].name: empty, duplicate or with surrounding spaces",
    ],
    [
      "name not a string",
      (r) => (r.workspaces[1].name = 5),
      "workspaces[1].name: empty, duplicate or with surrounding spaces",
    ],
    [
      "empty container",
      (r) => (r.workspaces[2].container = ""),
      "workspaces[2].container: empty or duplicate",
    ],
    [
      "container not a string",
      (r) => (r.workspaces[2].container = ["vimma-admin"]),
      "workspaces[2].container: empty or duplicate",
    ],
    [
      "tabs not an array",
      (r) => (r.workspaces[2].tabs = {}),
      "workspaces[2].tabs: must be an array",
    ],
    [
      "an empty tab id",
      (r) => (r.workspaces[0].tabs[1] = ""),
      "workspaces[0].tabs[1]: empty or already open",
    ],
    [
      "a tab id that is not a string",
      (r) => (r.workspaces[0].tabs[1] = ["tab-b"]),
      "workspaces[0].tabs[1]: empty or already open",
    ],
    [
      "empty workspace with an active tab",
      (r) => (r.workspaces[2].activeTab = "tab-x"),
      "workspaces[2].activeTab: must be null without tabs",
    ],
    [
      "empty workspace with panes",
      (r) => (r.workspaces[2].panes = r.workspaces[1].panes),
      "workspaces[2].panes: must be null without tabs",
    ],
    [
      "active tab not in tabs",
      (r) => (r.workspaces[0].activeTab = "tab-z"),
      "workspaces[0].activeTab: must be one of the tabs",
    ],
    [
      "tabs without panes",
      (r) => (r.workspaces[1].panes = null),
      "workspaces[1].panes: a workspace with tabs needs a layout",
    ],
    [
      "active tab not focused",
      (r) => (r.workspaces[0].activeTab = "tab-a"),
      "workspaces[0].activeTab: must be the focused pane's tab",
    ],
    [
      "panes not an object",
      (r) => (r.workspaces[0].panes = "x"),
      "workspaces[0].panes: must be an object or null",
    ],
    [
      "a node that is not an object",
      (r) => (r.workspaces[0].panes.root.children[0] = 7),
      "workspaces[0].panes.root.children[0]: a pane node must be an object",
    ],
    [
      "duplicate pane id",
      (r) => (r.workspaces[0].panes.root.children[0].pane = "p2"),
      "workspaces[0].panes.root.children[1].children[0].pane: missing or duplicate",
    ],
    [
      "pane tab not in the workspace",
      (r) => (r.workspaces[0].panes.root.children[0].tab = "tab-d"),
      "workspaces[0].panes.root.children[0].tab: not a tab of this workspace",
    ],
    [
      "tab shown twice",
      (r) => (r.workspaces[0].panes.root.children[0].tab = "tab-b"),
      "workspaces[0].panes.root.children[1].children[0].tab: tab shown in two panes",
    ],
    [
      "unknown node type",
      (r) => (r.workspaces[1].panes.root.type = "tree"),
      'workspaces[1].panes.root.type: must be "leaf" or "split"',
    ],
    [
      "bad axis",
      (r) => (r.workspaces[0].panes.root.axis = "z"),
      'workspaces[0].panes.root.axis: must be "x" or "y"',
    ],
    [
      "one-child split",
      (r) => r.workspaces[0].panes.root.children.pop(),
      "workspaces[0].panes.root.children: a split needs at least two children",
    ],
    [
      "ratios not an array",
      (r) => (r.workspaces[0].panes.root.ratios = null),
      "workspaces[0].panes.root.ratios: one positive ratio per child, summing to 1",
    ],
    [
      "three ratios summing to 1 for two children",
      (r) => (r.workspaces[0].panes.root.ratios = [0.5, 0.25, 0.25]),
      "workspaces[0].panes.root.ratios: one positive ratio per child, summing to 1",
    ],
    [
      "a zero ratio",
      (r) => (r.workspaces[0].panes.root.ratios = [1, 0]),
      "workspaces[0].panes.root.ratios: one positive ratio per child, summing to 1",
    ],
    [
      "a nested same-axis split whose smallest pane is exactly MIN_RATIO when flattened",
      (r) => {
        const inner = r.workspaces[0].panes.root.children[1];
        inner.axis = "x";
        inner.ratios = [0.2, 0.8]; // 0.2 × 0.5 = MIN_RATIO: flattening keeps every pane
      },
      "workspaces[0].panes.root.children[1].axis: same axis as the parent split",
    ],
    [
      "focus not a leaf",
      (r) => (r.workspaces[0].panes.focus = "p9"),
      "workspaces[0].panes.focus: must name a pane",
    ],
    [
      "mru with a pane that is not one",
      (r) => (r.workspaces[0].panes.mru = ["p3", "p2", "p9"]),
      "workspaces[0].panes.mru: every pane once, most recently focused first, starting with focus",
    ],
    [
      "zoom not a leaf",
      (r) => (r.workspaces[0].panes.zoom = "p9"),
      "workspaces[0].panes.zoom: must be null or a pane",
    ],
    ["unknown active", (r) => (r.active = "w9"), "active: must name a workspace"],
  ] as Array<[string, (raw: any) => void, string]>)("%s", (_, mutate, message) => {
    const e = snapshotError(() => stateOf(mutated(mutate)));
    expect(e.message).toBe(message);
    expect(e.name).toBe("SnapshotError");
    expect(e.code).toBe("invalid");
  });

  test("broken JSON names the whole document as <root>", () => {
    const e = snapshotError(() => stateOf("{"));
    expect(e.message).toMatch(/^<root>: not JSON: ./);
    expect(snapshotError(() => stateOf("[]")).message).toBe(
      "<root>: a snapshot must be a JSON object",
    );
  });

  test("schema refusals name the schema", () => {
    expect(snapshotError(() => stateOf(mutated((r) => (r.schema = 2)))).message).toBe(
      "schema: schema 2 is not supported",
    );
    const v0 = mutated((r) => (r.schema = 0));
    expect(snapshotError(() => migrateSnapshot(v0, { 0: (raw: any) => raw })).message).toBe(
      "schema: the migration from schema 0 did not produce 1",
    );
  });

  test("a newer schema is unsupported even when a migration step is given for it", () => {
    const v2 = mutated((r) => (r.schema = 2));
    const e = snapshotError(() =>
      migrateSnapshot(v2, { 2: (raw: any) => ({ ...raw, schema: 3 }) }),
    );
    expect(e.code).toBe("unsupported-schema");
  });
});

describe("readSnapshot: the state it returns", () => {
  test("is a copy: the input's arrays are not frozen or shared", () => {
    const raw = JSON.parse(fixture("valid.json"));
    const w = stateOf(raw).workspaces[0] as any;
    expect(Object.isFrozen(raw.workspaces[0].tabs)).toBe(false);
    expect(Object.isFrozen(raw.workspaces[0].panes.mru)).toBe(false);
    expect(Object.isFrozen(raw.workspaces[0].panes.root.ratios)).toBe(false);
    expect(w.tabs).not.toBe(raw.workspaces[0].tabs);
  });

  test("has no alternate key when the file has none", () => {
    expect(stateOf(fixture("valid.json"))).not.toHaveProperty("alternate");
  });

  test("a one-pane tree with an alone tab is still never hidden", () => {
    const raw = mutated((r) => {
      r.workspaces[1].tabs.push("tab-e");
      r.workspaces[1].panes.hidden = true;
      r.workspaces[1].alone = "tab-e";
    });
    const w = (stateOf(raw) as any).workspaces[1];
    expect("hidden" in w.panes).toBe(false);
    expect(w.activeTab).toBe("tab-d");
  });
});

describe("toSnapshot: plain JSON", () => {
  test("its arrays and trees are copies, not the frozen state", () => {
    const s = stateOf(fixture("valid.json"));
    const w = firstOf(toSnapshot(s));
    expect(Object.isFrozen(w.tabs)).toBe(false);
    expect(Object.isFrozen(w.panes)).toBe(false);
  });
});

describe("splits: edges", () => {
  /** valid.json's w1 with a second split (tab-x, tab-y), as a written file's splits. */
  const withSplits = (splits: (one: any, two: any) => any[], extra: (w: any) => void = () => {}) =>
    mutated((r) => {
      const w = r.workspaces[0];
      w.tabs.push("tab-x", "tab-y");
      const one = { ...JSON.parse(JSON.stringify(w.panes)), number: 1 };
      const two = {
        root: {
          type: "split",
          axis: "x",
          ratios: [0.5, 0.5],
          children: [
            { type: "leaf", pane: "p1", tab: "tab-x" },
            { type: "leaf", pane: "p2", tab: "tab-y" },
          ],
        },
        focus: "p2",
        mru: ["p2", "p1"],
        zoom: null,
        next: 3,
        number: 2,
      };
      w.splits = splits(one, two);
      extra(w);
    });
  const numbers = (raw: any) =>
    ((stateOf(raw) as any).workspaces[0].splits as any[]).map((x) => x.number);

  test("splits read in number order, whatever the file's order", () => {
    expect(numbers(withSplits((one, two) => [{ ...two, number: 9 }, one]))).toEqual([1, 9]);
  });

  test("a null entry is dropped like any other that is not an object", () => {
    expect(numbers(withSplits((one) => [null, one]))).toEqual([1]);
  });

  test("an entry of one valid pane is dropped: a split has two", () => {
    const lone = (two: any) => ({
      root: two.root.children[1],
      focus: "p2",
      mru: ["p2"],
      zoom: null,
      next: 3,
      number: 2,
    });
    expect(numbers(withSplits((one, two) => [one, lone(two)]))).toEqual([1]);
  });

  test("on a lone tab, the older view is the split shown last, not the first", () => {
    // tab-z alone; the file's activeTab (tab-y) says split 2 showed last.
    const raw = withSplits(
      (one, two) => [one, two],
      (w) => {
        w.tabs.push("tab-z");
        w.panes = JSON.parse(JSON.stringify({ ...w.splits[1], number: undefined, hidden: true }));
        w.activeTab = "tab-y";
        w.alone = "tab-z";
      },
    );
    const s = stateOf(raw);
    expect((s as any).workspaces[0]).toMatchObject({ shown: null, last: 2, activeTab: "tab-z" });
    const written = firstOf(toSnapshot(s));
    expect(written.panes.root).toEqual(written.splits[1].root);
    expect(written.panes.hidden).toBe(true);
  });
});
