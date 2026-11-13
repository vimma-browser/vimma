import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { planWorkspaceSwitch } from "../src/workspaces/switchplan.mjs";
import { PlanError } from "../src/panes/splitplan.mjs";
import {
  createWorkspaces,
  openTab,
  selectTab,
  switchWorkspace,
} from "../src/workspaces/workspaces.mjs";

/** @import { TabsState, SwitchPlan } from "../src/workspaces/switchplan.mjs" */
/** @import { Workspaces } from "../src/workspaces/workspaces.mjs" */

const three = () =>
  createWorkspaces([
    { name: "work", container: "1" },
    { name: "personal", container: "2" },
    { name: "admin", container: "3" },
  ]);

/** work: a, b (b active); personal: c, d (c active); admin: empty. work is active. */
function model() {
  let s = three();
  for (const t of ["a", "b"]) s = openTab(s, t);
  for (const t of ["c", "d"]) s = openTab(s, t, { workspace: { index: 2 }, activate: false });
  return s;
}

/**
 * @param {Array<[string, { hidden?: boolean, pinned?: boolean, group?: string }?]>} tabs
 * @param {string | null} selected
 * @returns {TabsState}
 */
const state = (tabs, selected) => ({
  tabs: tabs.map(([id, o = {}]) => ({
    id,
    hidden: o.hidden ?? false,
    pinned: o.pinned ?? false,
    group: o.group ?? null,
  })),
  selected,
});

/**
 * Firefox, as far as a switch is concerned: selecting shows the tab; hideTab does nothing to a
 * pinned or selected tab and hides a split member's whole group (except a selected member);
 * showTab shows one tab.
 * @param {TabsState} st
 * @param {SwitchPlan} plan
 * @returns {TabsState}
 */
function apply(st, plan) {
  const tabs = st.tabs.map((t) => ({ ...t }));
  const byId = (/** @type {string} */ id) => {
    const t = tabs.find((x) => x.id === id);
    expect(t).toBeDefined();
    return /** @type {(typeof tabs)[number]} */ (t);
  };
  let selected = st.selected;
  if (plan.select !== null) {
    selected = plan.select;
    byId(plan.select).hidden = false;
  }
  for (const id of plan.show) byId(id).hidden = false;
  for (const id of plan.hide) {
    const t = byId(id);
    if (t.pinned || t.id === selected) continue;
    const members = t.group ? tabs.filter((x) => x.group === t.group) : [t];
    for (const m of members) if (m.id !== selected && !m.pinned) m.hidden = true;
  }
  return { tabs, selected };
}

describe("planWorkspaceSwitch", () => {
  test("switching shows the target's tabs, hides the others and selects its active tab", () => {
    const s = switchWorkspace(model(), { index: 2 });
    const st = state([["a"], ["b"], ["c", { hidden: true }], ["d", { hidden: true }]], "b");
    expect(planWorkspaceSwitch(s, { index: 2 }, st)).toEqual({
      select: "c",
      show: ["c", "d"],
      hide: ["a", "b"],
      unsplit: [],
    });
  });

  test("the target defaults to the model's active workspace", () => {
    const s = switchWorkspace(model(), { index: 2 });
    const st = state([["a"], ["b"], ["c", { hidden: true }], ["d", { hidden: true }]], "b");
    expect(planWorkspaceSwitch(s, undefined, st)).toEqual(planWorkspaceSwitch(s, { index: 2 }, st));
  });

  test("pinned tabs are never hidden; tabs the model does not know are left alone", () => {
    const st = state([["p", { pinned: true }], ["a"], ["b"], ["u"], ["c"], ["d"]], "a");
    const plan = planWorkspaceSwitch(model(), { index: 1 }, st);
    expect(plan).toEqual({ select: "b", show: [], hide: ["c", "d"], unsplit: [] });
  });

  test("a split group is hidden through one member, since hideTab hides the whole group", () => {
    const st = state([["a"], ["b"], ["c", { group: "g1" }], ["d", { group: "g1" }]], "c");
    const plan = planWorkspaceSwitch(model(), { index: 1 }, st);
    expect(plan).toEqual({ select: "b", show: [], hide: ["c"], unsplit: [] });
    expect(
      apply(st, plan)
        .tabs.filter((t) => t.hidden)
        .map((t) => t.id),
    ).toEqual(["c", "d"]);
  });

  test("the target's split group stays whole: a foreign member is not hidden but unsplit", () => {
    // decision 14 was broken outside vimma: c (personal) is in work's split with a and b
    const st = state(
      [["a", { group: "g" }], ["b", { group: "g" }], ["c", { group: "g" }], ["d"]],
      "b",
    );
    const plan = planWorkspaceSwitch(model(), { index: 1 }, st);
    expect(plan).toEqual({ select: "b", show: [], hide: ["d"], unsplit: ["c"] });
  });

  test("switching to an empty workspace selects nothing (the host opens its home first)", () => {
    const st = state([["a"], ["b"], ["c", { hidden: true }], ["d", { hidden: true }]], "b");
    expect(planWorkspaceSwitch(model(), { index: 3 }, st)).toEqual({
      select: null,
      show: [],
      hide: ["a", "b"],
      unsplit: [],
    });
  });

  test("nothing to do when Firefox already shows exactly the target", () => {
    const st = state([["a"], ["b"], ["c", { hidden: true }], ["d", { hidden: true }]], "b");
    expect(planWorkspaceSwitch(model(), { index: 1 }, st)).toEqual({
      select: "b",
      show: [],
      hide: [],
      unsplit: [],
    });
  });

  test("an unknown workspace or a tab listed twice is refused", () => {
    const st = state([["a"]], "a");
    expect(() => planWorkspaceSwitch(model(), { name: "nope" }, st)).toThrow(PlanError);
    expect(() => planWorkspaceSwitch(model(), { index: 1 }, state([["a"], ["a"]], "a"))).toThrow(
      expect.objectContaining({ code: "bad-state" }),
    );
  });
});

// ---- properties ----

const N = 9;
const IDS = Array.from({ length: N }, (_, i) => `t${i}`);

/** Tabs t0..t8 spread over three workspaces, some selected; a random target. */
const modelArb = fc
  .record({
    homes: fc.array(fc.integer({ min: 1, max: 3 }), { minLength: N, maxLength: N }),
    picks: fc.array(fc.nat({ max: N - 1 }), { maxLength: 6 }),
    active: fc.integer({ min: 1, max: 3 }),
  })
  .map(({ homes, picks, active }) => {
    let s = three();
    IDS.forEach((id, i) => {
      s = openTab(s, id, {
        workspace: { index: /** @type {number} */ (homes[i]) },
        activate: false,
      });
    });
    for (const p of picks) s = selectTab(s, /** @type {string} */ (IDS[p]));
    return switchWorkspace(s, { index: active });
  });

/** Firefox's tabs: the model's, two pinned and one unknown, shuffled, with random state. */
const tabsArb = fc
  .record({
    order: fc.shuffledSubarray([...IDS, "p0", "p1", "u0"], { minLength: N + 3 }),
    hidden: fc.array(fc.boolean(), { minLength: N + 3, maxLength: N + 3 }),
    groups: fc.array(fc.constantFrom(null, null, "g1", "g2", "g3"), {
      minLength: N + 3,
      maxLength: N + 3,
    }),
    selected: fc.nat({ max: N + 2 }),
  })
  .map(({ order, hidden, groups, selected }) => {
    const tabs = order.map((id, i) => {
      const pinned = id.startsWith("p");
      return {
        id,
        pinned,
        hidden: !pinned && !!hidden[i],
        group: pinned ? null : (groups[i] ?? null),
      };
    });
    const sel = /** @type {(typeof tabs)[number]} */ (tabs[selected % tabs.length]);
    sel.hidden = false;
    return { tabs, selected: sel.id };
  });

/** @param {Workspaces} s */
const tabsOf = (s) => new Set(s.workspaces.find((w) => w.id === s.active)?.tabs);

describe("planWorkspaceSwitch properties", () => {
  test("afterwards exactly the target's tabs (and pinned, unknown, mixed-group ones) are visible", () => {
    fc.assert(
      fc.property(modelArb, tabsArb, (s, st) => {
        const plan = planWorkspaceSwitch(s, undefined, st);
        const after = apply(st, plan);
        const mine = tabsOf(s);
        const known = new Set(s.workspaces.flatMap((w) => w.tabs));
        const active = s.workspaces.find((w) => w.id === s.active)?.activeTab ?? null;
        expect(plan.select).toBe(active);
        if (active) expect(after.selected).toBe(active);
        /** @param {string | null} g */
        const mixed = (g) => !!g && st.tabs.some((t) => t.group === g && mine.has(t.id));
        for (const t of after.tabs) {
          const before = /** @type {any} */ (st.tabs.find((x) => x.id === t.id));
          if (mine.has(t.id)) expect(t.hidden).toBe(false);
          else if (t.pinned) expect(t.hidden).toBe(before.hidden);
          else if (mixed(t.group)) {
            expect(t.hidden).toBe(before.hidden);
            if (known.has(t.id)) expect(plan.unsplit).toContain(t.id);
          } else if (known.has(t.id) && t.id !== after.selected) expect(t.hidden).toBe(true);
        }
        // a split group ends all hidden or all shown (except a selected member, as upstream)
        for (const g of ["g1", "g2", "g3"]) {
          const members = after.tabs.filter((t) => t.group === g && t.id !== after.selected);
          if (!mixed(g) && members.some((t) => known.has(t.id))) {
            expect(new Set(members.map((t) => t.hidden)).size).toBeLessThanOrEqual(1);
          }
        }
      }),
    );
  });

  test("never hides a pinned tab, a target tab or more than one member per group", () => {
    fc.assert(
      fc.property(modelArb, tabsArb, (s, st) => {
        const plan = planWorkspaceSwitch(s, undefined, st);
        const mine = tabsOf(s);
        const groups = plan.hide
          .map((id) => st.tabs.find((t) => t.id === id)?.group)
          .filter(Boolean);
        expect(new Set(groups).size).toBe(groups.length);
        for (const id of plan.hide) {
          expect(mine.has(id)).toBe(false);
          expect(st.tabs.find((t) => t.id === id)?.pinned).toBe(false);
        }
      }),
    );
  });

  test("idempotent: planning again after applying shows and hides nothing", () => {
    fc.assert(
      fc.property(modelArb, tabsArb, (s, st) => {
        const after = apply(st, planWorkspaceSwitch(s, undefined, st));
        const again = planWorkspaceSwitch(s, undefined, after);
        if (again.select !== null) {
          expect(again.show).toEqual([]);
          expect(again.hide).toEqual([]);
        }
      }),
    );
  });
});
