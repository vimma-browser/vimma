import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { readSnapshot, toSnapshot } from "../src/workspaces/snapshot.mjs";
import { createWorkspaces, openTab } from "../src/workspaces/workspaces.mjs";
import { setTabLabel } from "../src/workspaces/tablabels.mjs";

/**
 * The workspace state a snapshot restores to, without its tab renames.
 * @param {unknown} input
 * @param {Parameters<typeof readSnapshot>[1]} [options]
 */
const stateOf = (input, options) => readSnapshot(input, options).state;

const valid = () =>
  JSON.parse(
    readFileSync(new URL("../../../tests/contract/state/v1/valid.json", import.meta.url), "utf8"),
  );

describe("tab labels in snapshot v1 (m2-core-logic)", () => {
  test("labels round-trip through toSnapshot / readSnapshot", () => {
    const state = stateOf(valid());
    const labels = setTabLabel(setTabLabel({}, "tab-b", "mail"), "tab-a", "code");
    const json = toSnapshot(state, { tabLabels: labels });
    expect(json.tabLabels).toEqual({ "tab-a": "code", "tab-b": "mail" });
    expect(Object.keys(json.tabLabels ?? {})).toEqual(["tab-a", "tab-b"]);
    const back = readSnapshot(JSON.stringify(json));
    expect(back.state).toEqual(state);
    expect(back.tabLabels).toEqual(labels);
    expect(back.warnings).toEqual([]);
  });

  test("without labels the snapshot is unchanged v1 and reads back with none", () => {
    const state = stateOf(valid());
    expect(toSnapshot(state, { tabLabels: {} })).toEqual(valid());
    expect(toSnapshot(state)).not.toHaveProperty("tabLabels");
    expect(readSnapshot(valid())).toMatchObject({ tabLabels: {}, warnings: [] });
  });

  test("labels of tabs that are gone are not written", () => {
    const state = stateOf(valid());
    const json = toSnapshot(state, { tabLabels: { "tab-a": "code", closed: "old" } });
    expect(json.tabLabels).toEqual({ "tab-a": "code" });
  });

  test("a snapshot with stale or invalid labels still restores, with warnings", () => {
    const raw = valid();
    raw.tabLabels = { "tab-a": " padded\u202e ", gone: "x", "tab-b": 7, "tab-c": "" };
    const r = readSnapshot(raw);
    expect(r.state).toEqual(stateOf(valid()));
    expect(r.tabLabels).toEqual({ "tab-a": "padded" });
    expect(r.warnings.map((w) => w.path)).toEqual([
      'tabLabels["tab-a"]',
      'tabLabels["gone"]',
      'tabLabels["tab-b"]',
      'tabLabels["tab-c"]',
    ]);
    raw.tabLabels = "nonsense";
    expect(readSnapshot(raw).warnings.map((w) => w.path)).toEqual(["tabLabels"]);
    expect(stateOf(raw)).toEqual(stateOf(valid()));
  });

  test("property: any tabLabels value never fails a restore", () => {
    fc.assert(
      fc.property(fc.anything(), (labels) => {
        const raw = valid();
        raw.tabLabels = labels;
        const r = readSnapshot(raw);
        expect(r.state).toEqual(stateOf(valid()));
      }),
    );
  });

  test("property: labels on open tabs round-trip", () => {
    let s = createWorkspaces([{ name: "work", container: "c1" }]);
    for (const t of ["t1", "t2", "t3"]) s = openTab(s, t);
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom("t1", "t2", "t3"), fc.string()), (raw) => {
        let labels = {};
        for (const [k, v] of Object.entries(raw)) labels = setTabLabel(labels, k, v);
        const r = readSnapshot(JSON.stringify(toSnapshot(s, { tabLabels: labels })));
        expect(r.tabLabels).toEqual(labels);
        expect(r.warnings).toEqual([]);
      }),
    );
  });
});
