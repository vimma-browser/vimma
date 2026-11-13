import { describe, test, expect } from "vitest";
import { describeAction, notImplementedText } from "../src/actions.mjs";
import { tabIds, tabTarget } from "../src/tabs.mjs";

// Spec: docs/specs/m2-tab-keys.md

describe("tabTarget", () => {
  test("tab.next and tab.previous wrap around the visible tabs, as Herdr does", () => {
    expect(tabTarget({ id: "tab.next" }, 0, 3)).toBe(1);
    expect(tabTarget({ id: "tab.next" }, 2, 3)).toBe(0);
    expect(tabTarget({ id: "tab.previous" }, 1, 3)).toBe(0);
    expect(tabTarget({ id: "tab.previous" }, 0, 3)).toBe(2);
  });

  test("a single tab is its own next and previous", () => {
    expect(tabTarget({ id: "tab.next" }, 0, 1)).toBe(0);
    expect(tabTarget({ id: "tab.previous" }, 0, 1)).toBe(0);
  });

  test("tab.goto N selects the Nth tab (1-based)", () => {
    expect(tabTarget({ id: "tab.goto", arg: 1 }, 2, 3)).toBe(0);
    expect(tabTarget({ id: "tab.goto", arg: 3 }, 0, 3)).toBe(2);
  });

  test("tab.goto past the last tab is a no-op (Herdr: tabs.get(index)?)", () => {
    expect(tabTarget({ id: "tab.goto", arg: 4 }, 0, 3)).toBeNull();
    expect(tabTarget({ id: "tab.goto", arg: 9 }, 0, 1)).toBeNull();
  });

  test("a count on tab.next goes to tab N, as Vim's Ngt", () => {
    expect(tabTarget({ id: "tab.next", count: 2 }, 0, 3)).toBe(1);
    expect(tabTarget({ id: "tab.next", count: 5 }, 0, 3)).toBeNull();
  });

  test("a count on tab.previous goes back N tabs, wrapping, as Vim's NgT", () => {
    expect(tabTarget({ id: "tab.previous", count: 2 }, 0, 3)).toBe(1);
    expect(tabTarget({ id: "tab.previous", count: 4 }, 2, 3)).toBe(1);
  });

  test("no tabs, an unknown current tab or another action: null", () => {
    expect(tabTarget({ id: "tab.next" }, 0, 0)).toBeNull();
    expect(tabTarget({ id: "tab.next" }, -1, 3)).toBeNull();
    expect(tabTarget({ id: "tab.goto" }, 0, 3)).toBeNull();
    expect(tabTarget({ id: "tab.close" }, 0, 3)).toBeNull();
  });
});

describe("describeAction", () => {
  test("is the description of the action with that id and arg", () => {
    expect(describeAction({ id: "pane.split_vertical" })).toBe("Split right");
    expect(describeAction({ id: "tab.goto", arg: 3 })).toBe("Jump to tab 3 in this workspace");
  });

  test("falls back to the id for an id it does not know", () => {
    expect(describeAction({ id: "nope.nothing" })).toBe("nope.nothing");
  });

  test("notImplementedText names the action", () => {
    expect(notImplementedText({ id: "pane.zoom" })).toBe("Zoom pane: not implemented yet");
  });
});

// docs/specs/firefox-keys.md: alt+9, Firefox's last tab, counts the workspace's visible tabs.
describe("tab.goto_last", () => {
  test.each([
    [0, 5, 4],
    [4, 5, 4],
    [0, 1, 0],
  ])("from tab %i of %i goes to %i", (current, length, want) => {
    expect(tabTarget({ id: "tab.goto_last" }, current, length)).toBe(want);
  });

  test("no tabs: nothing", () => {
    expect(tabTarget({ id: "tab.goto_last" }, 0, 0)).toBeNull();
  });
});

// A window without workspaces (private) keys the picker's tabs by panel; an unloaded tab has
// none (#958).
describe("tabIds", () => {
  test("a loaded tab's id is its panel", () => {
    const ids = tabIds();
    expect(ids.idOf({ linkedPanel: "panel-1-2" })).toBe("panel-1-2");
  });

  test("unloaded tabs get ids of their own, the same on every call", () => {
    const ids = tabIds();
    const a = { linkedPanel: null };
    const b = { linkedPanel: null };
    expect(ids.idOf(a)).not.toBe(ids.idOf(b));
    expect(ids.idOf(a)).toBe(ids.idOf(a));
    expect(typeof ids.idOf(a)).toBe("string");
  });

  test("find takes a tab's panel, or the id it had while unloaded", () => {
    const ids = tabIds();
    const loaded = { linkedPanel: "panel-1-2" };
    /** @type {{ linkedPanel: string | null }} */
    const lazy = { linkedPanel: null };
    const other = { linkedPanel: null };
    const tabs = [loaded, other, lazy];
    tabs.forEach((t) => ids.idOf(t));
    const lazyId = ids.idOf(lazy);
    expect(ids.find(tabs, "panel-1-2")).toBe(loaded);
    expect(ids.find(tabs, lazyId)).toBe(lazy);
    // Selecting the tab loads it: the row listed before still finds it.
    lazy.linkedPanel = "panel-1-9";
    expect(ids.find(tabs, lazyId)).toBe(lazy);
    expect(ids.find(tabs, "panel-1-9")).toBe(lazy);
    expect(ids.find(tabs, "panel-9-9")).toBeUndefined();
  });
});
