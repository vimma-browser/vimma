import { describe, test, expect } from "vitest";
import { pickerItems } from "../src/ui/picker.mjs";
import {
  CLOSED_TAB_CAP,
  CLOSED_WINDOW_CAP,
  ROW_CAP,
  accessibleName,
  closedTabItem,
  closedWindowItem,
  countText,
  rowRange,
  sectionHeading,
  sectionOf,
  tabSearchItems,
} from "../src/ui/tabsearch.mjs";

/** @import { PickerItem } from "../src/ui/picker.mjs" */
/** @import { Workspaces } from "../src/workspaces/workspaces.mjs" */

/**
 * A workspaces model from what the pickers read of each workspace: its id, name, tabs and active
 * tab. The container and panes, which they do not read, are filled in.
 * @param {{ active: string, workspaces: { id: string, name: string, tabs: string[],
 *   activeTab: string | null }[] }} model
 * @returns {Workspaces}
 */
const fixture = ({ active, workspaces }) => ({
  active,
  next: workspaces.length + 1,
  workspaces: workspaces.map((w) => ({ ...w, container: w.id, panes: null })),
});

const model = fixture({
  active: "w1",
  workspaces: [
    { id: "w1", name: "work", tabs: ["t1", "t2"], activeTab: "t1" },
    { id: "w2", name: "personal", tabs: ["t3"], activeTab: "t3" },
  ],
});
/** @param {string} id */
const info = (id) => ({ title: `Title ${id}`, url: `https://${id}.example.com/` });
const here = pickerItems(model, info, {});
const there = pickerItems(
  fixture({ ...model, workspaces: [{ id: "w1", name: "work", tabs: ["u1"], activeTab: "u1" }] }),
  info,
  {},
  { window: 2 },
);
const secret = pickerItems(
  fixture({
    active: "window",
    workspaces: [{ id: "window", name: "private", tabs: ["p1"], activeTab: "p1" }],
  }),
  info,
  {},
);

/** @param {number} closedId @param {Partial<Parameters<typeof closedTabItem>[0]>} [extra] */
const closedTab = (closedId, extra = {}) => ({
  closedId,
  title: `Closed ${closedId}`,
  url: `https://c${closedId}.example.com/`,
  closedAt: closedId,
  private: false,
  workspaceName: "work",
  ...extra,
});

describe("tab search lists (docs/specs/tab-search.md, decisions 3 and 5)", () => {
  test("tabs closed in the same millisecond list the last closed first", () => {
    // SessionStore keeps such ties oldest first (it inserts before the first strictly older
    // entry) and stamps closedAt in whole milliseconds; closedId grows with every close.
    const items = tabSearchItems({
      private: false,
      windows: [{ private: false, items: here }],
      closedTabs: [
        closedTab(4, { closedAt: 7 }),
        closedTab(5, { closedAt: 7 }),
        closedTab(6, { closedAt: 7 }),
      ],
      closedWindows: [
        { closedId: 8, title: "A", tabCount: 1, closedAt: 9 },
        { closedId: 9, title: "B", tabCount: 1, closedAt: 9 },
      ],
    });
    expect(items.filter((i) => i.closed).map((i) => i.tabId)).toEqual([
      "closed:6",
      "closed:5",
      "closed:4",
      "closedwin:9",
      "closedwin:8",
    ]);
  });

  test("this window, then other windows, then recently closed newest first, then windows", () => {
    const items = tabSearchItems({
      private: false,
      windows: [
        { private: false, items: here },
        { private: false, items: there },
      ],
      closedTabs: [closedTab(1), closedTab(3), closedTab(2)],
      closedWindows: [{ closedId: 9, title: "Old window", tabCount: 3, closedAt: 5 }],
    });
    expect(items.map((i) => i.tabId)).toEqual([
      "t1",
      "t2",
      "t3",
      "u1",
      "closed:3",
      "closed:2",
      "closed:1",
      "closedwin:9",
    ]);
    expect(items.find((i) => i.tabId === "u1")?.window).toBe(2);
    expect(items.find((i) => i.tabId === "closedwin:9")).toMatchObject({
      closed: true,
      closedWindow: true,
      tabCount: 3,
      display: "Old window",
      markers: "closed window",
    });
  });

  test("a normal window never lists a private tab, and the private window only private ones", () => {
    const normalWindow = { private: false, items: here };
    const privateWindow = { private: true, items: secret };
    const input = {
      windows: [normalWindow, privateWindow],
      closedTabs: [closedTab(1), closedTab(2, { private: true, title: "Secret closed" })],
      closedWindows: [{ closedId: 9, title: "Old window", tabCount: 1, closedAt: 5 }],
    };
    const normal = tabSearchItems({ ...input, private: false });
    expect(normal.map((i) => i.tabId)).toEqual(["t1", "t2", "t3", "closed:1", "closedwin:9"]);
    const inPrivate = tabSearchItems({
      ...input,
      private: true,
      windows: [privateWindow, normalWindow],
    });
    expect(inPrivate.map((i) => i.tabId)).toEqual(["p1", "closed:2"]);
    expect(JSON.stringify(normal)).not.toContain("Secret");
  });

  test("closed tabs and windows are capped as Firefox caps them (25 and 5)", () => {
    expect([CLOSED_TAB_CAP, CLOSED_WINDOW_CAP]).toEqual([25, 5]);
    const items = tabSearchItems({
      private: false,
      windows: [{ private: false, items: [] }],
      closedTabs: Array.from({ length: 40 }, (_, i) => closedTab(i)),
      closedWindows: Array.from({ length: 8 }, (_, i) => ({
        closedId: 100 + i,
        title: `W${i}`,
        tabCount: 1,
        closedAt: i,
      })),
    });
    expect(items.filter((i) => i.closed && !i.closedWindow)).toHaveLength(25);
    expect(items[0]?.tabId).toBe("closed:39");
    expect(items.filter((i) => i.closedWindow)).toHaveLength(5);
  });

  test("a closed agent tab is marked as one", () => {
    const item = closedTabItem(closedTab(4, { workspaceName: "agent", agent: true }));
    expect(item).toMatchObject({ agent: true, closed: true, markers: "agent closed" });
    expect(closedWindowItem({ closedId: 1, title: "", tabCount: 2, closedAt: 0 }).display).toBe(
      "Closed window",
    );
  });
});

describe("sections, names and the row cap", () => {
  const all = tabSearchItems({
    private: false,
    windows: [
      { private: false, items: here },
      { private: false, items: there },
    ],
    closedTabs: [closedTab(1)],
    closedWindows: [],
  });
  const byId = (/** @type {string} */ id) =>
    /** @type {PickerItem} */ (all.find((i) => i.tabId === id));

  test("a section is a window's workspace, or recently closed", () => {
    expect(sectionOf(byId("t1"))).toBe(sectionOf(byId("t2")));
    expect(sectionOf(byId("t1"))).not.toBe(sectionOf(byId("t3")));
    expect(sectionOf(byId("t1"))).not.toBe(sectionOf(byId("u1")));
    expect(sectionOf(byId("closed:1"))).toBe("closed");
    expect(sectionHeading(byId("t1"), 12)).toBe("work · 12");
    expect(sectionHeading(byId("u1"), 40)).toBe("work · 40 · w2");
    expect(sectionHeading(byId("closed:1"), 9)).toBe("Recently closed · 9");
    const agent = pickerItems(model, info, {}, { agentId: "w2" }).find((i) => i.agent);
    if (!agent) throw new Error("no agent item");
    expect(sectionHeading(agent, 1)).toBe("◇ personal · 1");
  });

  test("accessible names say the workspace, the window or recently closed, and the markers", () => {
    expect(accessibleName(byId("t1"))).toBe("Title t1, work");
    expect(accessibleName(byId("u1"))).toBe("Title u1, work, window 2");
    expect(accessibleName(byId("closed:1"))).toBe("Closed 1, work, recently closed");
    const playing = { ...byId("t1"), playing: /** @type {const} */ (true), markers: "playing" };
    expect(accessibleName(playing)).toBe("Title t1, work, playing");
    const win = closedWindowItem({ closedId: 1, title: "Mail", tabCount: 3, closedAt: 0 });
    expect(accessibleName(win)).toBe("Mail, closed window, 3 tabs");
  });

  test("the live region's count", () => {
    expect(countText(0)).toBe("no tabs match");
    expect(countText(1)).toBe("1 tab");
    expect(countText(12)).toBe("12 tabs");
  });

  test("at most 200 rows are rendered, a window that follows the selection", () => {
    expect(ROW_CAP).toBe(200);
    expect(rowRange(50, 10)).toEqual({ start: 0, end: 50 });
    expect(rowRange(500, 0)).toEqual({ start: 0, end: 200 });
    expect(rowRange(500, 150)).toEqual({ start: 50, end: 250 });
    expect(rowRange(500, 499)).toEqual({ start: 300, end: 500 });
  });
});
