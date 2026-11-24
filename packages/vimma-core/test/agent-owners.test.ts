// docs/specs/builtin-agent.md B17, Behaviour 30: each conversation has its own tabs of the
// agent workspace; MCP agents see only the tabs no conversation owns.
import { describe, expect, test } from "vitest";
import { TabOwners } from "../src/agent/agent-owners.mjs";

describe("TabOwners", () => {
  test("a tab belongs to the conversation that opened it", () => {
    const o = new TabOwners();
    o.opened(12, "builtin:1");
    expect(o.owner(12)).toBe("builtin:1");
    expect(o.tabsOf("builtin:1")).toEqual([12]);
    expect(o.visible(12, "builtin:1")).toBe(true);
    expect(o.visible(12, "builtin:2")).toBe(false);
    // An MCP connection (no conversation) does not see it.
    expect(o.visible(12, null)).toBe(false);
  });

  test("a tab a page opened belongs to its opener's conversation", () => {
    const o = new TabOwners();
    o.opened(12, "builtin:1");
    o.openedBy(13, 12);
    expect(o.owner(13)).toBe("builtin:1");
    // An opener no conversation owns passes on no owner.
    o.openedBy(15, 14);
    expect(o.owner(15)).toBe(null);
    expect(o.visible(15, null)).toBe(true);
    expect(o.visible(15, "builtin:1")).toBe(false);
  });

  test("a given tab belongs to the open conversation", () => {
    const o = new TabOwners();
    o.opened(20, "builtin:1");
    o.given(20, "builtin:2");
    expect(o.owner(20)).toBe("builtin:2");
    expect(o.tabsOf("builtin:1")).toEqual([]);
    expect(o.tabsOf("builtin:2")).toEqual([20]);
  });

  test("a moved tab belongs to none", () => {
    const o = new TabOwners();
    o.moved(30);
    expect(o.owner(30)).toBe(null);
    o.opened(31, "builtin:1");
    o.moved(31);
    expect(o.owner(31)).toBe(null);
    expect(o.visible(31, null)).toBe(true);
  });

  test("ownership ends when the tab closes", () => {
    const o = new TabOwners();
    o.opened(40, "builtin:1");
    o.opened(41, "builtin:1");
    o.closed(40);
    expect(o.owner(40)).toBe(null);
    expect(o.tabsOf("builtin:1")).toEqual([41]);
  });

  test("tab ids compare as numbers or strings alike", () => {
    const o = new TabOwners();
    o.opened("12", "builtin:1");
    expect(o.owner(12)).toBe("builtin:1");
    expect(o.tabsOf("builtin:1")).toEqual([12]);
  });

  // Issue #1119: a tab id is reused by a page's opening; the old owner must not stay.
  test("a tab a page opened from a tab no conversation owns loses any owner it had", () => {
    const o = new TabOwners();
    o.opened(50, "builtin:1");
    o.openedBy(50, 51);
    expect(o.owner(50)).toBe(null);
    expect(o.visible(50, "builtin:1")).toBe(false);
    expect(o.visible(50, null)).toBe(true);
  });
});

// Issue #1119: a tab no conversation owns leaves no entry behind, so the map holds only owned
// tabs however many tabs pages open.
test("a tab opened from a tab no conversation owns keeps no entry", () => {
  const o = new TabOwners();
  o.opened(60, "builtin:1");
  o.openedBy(60, 61);
  o.openedBy(62, 61);
  expect([...o.owners.keys()]).toEqual([]);
});
