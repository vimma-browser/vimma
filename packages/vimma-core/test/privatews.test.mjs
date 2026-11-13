import { describe, test, expect } from "vitest";
import {
  PRIVATE_REFUSALS,
  PRIVATE_WORKSPACE_ID,
  closePrivateQuestion,
  cycleFromPrivate,
  movePrivateQuestion,
  parsePrivateCommand,
  privateItem,
  privateNeighbours,
  privateReturn,
  privateToggle,
} from "../src/privatews.mjs";
import {
  isWorkspaceId,
  lastWorkspace,
  nextWorkspace,
  previousWorkspace,
} from "../src/workspaces.mjs";
import { workspaceItems, pickerKey, openPicker } from "../src/picker.mjs";

const model = Object.freeze({
  active: "w2",
  next: 4,
  alternate: "w1",
  workspaces: [
    { id: "w1", name: "work", container: "1", tabs: ["t1"], activeTab: "t1", panes: null },
    { id: "w2", name: "admin", container: "2", tabs: ["t2"], activeTab: "t2", panes: null },
    { id: "w3", name: "home", container: "3", tabs: [], activeTab: null, panes: null },
  ],
});

describe("the private workspace's id", () => {
  test("is never a valid workspace id, so no workspace can collide with it", () => {
    expect(isWorkspaceId(PRIVATE_WORKSPACE_ID)).toBe(false);
  });
});

describe("privateNeighbours (decision 6)", () => {
  const [main, work, agent] = [
    { id: "w1", name: "main" },
    { id: "w2", name: "work" },
    { id: "w3", name: "agent" },
  ];
  const ws = [main, work, agent];
  test("the side panel names the last and the first normal workspace", () => {
    expect(privateNeighbours(ws)).toEqual(["agent", "main"]);
  });
  test("past the agent workspace, which the cycle skips (vimma-mcp decision 9)", () => {
    expect(privateNeighbours(ws, new Set(["w3"]))).toEqual(["work", "main"]);
    expect(privateNeighbours([main, agent], new Set(["w3"]))).toEqual(["main", "main"]);
  });
  test("with no normal workspace there is none", () => {
    expect(privateNeighbours([])).toEqual([null, null]);
    expect(privateNeighbours([agent], new Set(["w3"]))).toEqual([null, null]);
  });
});

describe("cycleFromPrivate (decision 5)", () => {
  const order = ["w1", "w2", "w3"];
  test("ctrl+b ) from private goes to the first normal workspace", () => {
    expect(cycleFromPrivate(order, "next")).toBe("w1");
  });
  test("ctrl+b ( from private goes to the last normal workspace", () => {
    expect(cycleFromPrivate(order, "previous")).toBe("w3");
  });
  test("with no normal workspace there is nowhere to go", () => {
    expect(cycleFromPrivate([], "next")).toBeNull();
    expect(cycleFromPrivate([], "previous")).toBeNull();
  });
});

describe("normal cycling and the normal alternate never reach private", () => {
  test("next / previous wrap inside the normal workspaces", () => {
    const last = { ...model, active: "w3" };
    expect(nextWorkspace(last).active).toBe("w1");
    expect(previousWorkspace({ ...model, active: "w1" }).active).toBe("w3");
  });
  test("ctrl+^ goes to the last normal workspace", () => {
    expect(lastWorkspace(model).active).toBe("w1");
  });
});

describe("privateReturn: ctrl+^ from private", () => {
  test("returns to the workspace left while it still exists", () => {
    expect(privateReturn("w2", ["w1", "w2"])).toBe("w2");
  });
  test("a workspace closed meanwhile, or none remembered: the window as it is", () => {
    expect(privateReturn("w9", ["w1", "w2"])).toBeNull();
    expect(privateReturn(null, ["w1"])).toBeNull();
  });
});

describe("privateToggle (decisions 2 and 3)", () => {
  const ok = { enabled: true, permanent: false };
  test("outside private, with none open: open it", () => {
    expect(privateToggle({ ...ok, inPrivate: false, open: false })).toEqual({ kind: "open" });
  });
  test("outside private, with one open: go there", () => {
    expect(privateToggle({ ...ok, inPrivate: false, open: true })).toEqual({ kind: "focus" });
  });
  test("inside private: back to the workspace left", () => {
    expect(privateToggle({ ...ok, inPrivate: true, open: true })).toEqual({ kind: "back" });
  });
  test("permanent private browsing: refused with its message", () => {
    expect(privateToggle({ enabled: true, permanent: true, inPrivate: true, open: true })).toEqual({
      kind: "refuse",
      text: PRIVATE_REFUSALS["permanent-private"],
    });
    expect(PRIVATE_REFUSALS["permanent-private"]).toBe(
      "every window is private (permanent private browsing)",
    );
  });
  test("private browsing off by policy: refused with its message", () => {
    expect(
      privateToggle({ enabled: false, permanent: false, inPrivate: false, open: false }),
    ).toEqual({ kind: "refuse", text: "private browsing is turned off by policy" });
  });
  test("moving out of private has its refusal", () => {
    expect(PRIVATE_REFUSALS["move-out-of-private"]).toBe(
      "a private tab cannot leave the private workspace",
    );
  });
});

describe("privateItem: the workspace picker's private row", () => {
  test("is the last row, with the tab count of every private window", () => {
    const items = [...workspaceItems(model), privateItem({ tabCount: 5, index: 4, active: false })];
    const row = items.at(-1);
    expect(row).toMatchObject({
      kind: "workspace",
      private: true,
      workspaceId: PRIVATE_WORKSPACE_ID,
      workspaceName: "private",
      display: "◆ private",
      workspaceIndex: 4,
      tabCount: 5,
      foreignCount: 0,
      active: false,
    });
    expect(Object.isFrozen(row)).toBe(true);
  });
  test("with no private window it says new", () => {
    expect(privateItem({ tabCount: 0, index: 1, active: false }).countText).toBe("new");
    expect(privateItem({ tabCount: 1, index: 1, active: false }).countText).toBe("1 tab");
    expect(privateItem({ tabCount: 5, index: 1, active: true }).countText).toBe("5 tabs");
  });
  test("Enter selects it and m moves the tab there, like any workspace row", () => {
    const items = [...workspaceItems(model), privateItem({ tabCount: 0, index: 4, active: false })];
    const state = openPicker(items, { activeId: PRIVATE_WORKSPACE_ID });
    expect(pickerKey(state, "enter").effect).toEqual({ type: "select", id: PRIVATE_WORKSPACE_ID });
    expect(pickerKey(state, "m").effect).toEqual({ type: "move", id: PRIVATE_WORKSPACE_ID });
  });
});

describe("questions", () => {
  test("closing asks with the tab count and what is discarded", () => {
    expect(closePrivateQuestion(5)).toBe(
      "Close the private workspace (5 tabs)? Its history, cookies and site data are discarded. y/N",
    );
    expect(closePrivateQuestion(1)).toBe(
      "Close the private workspace (1 tab)? Its history, cookies and site data are discarded. y/N",
    );
  });
  test("moving a tab into private asks first", () => {
    expect(movePrivateQuestion()).toBe(
      "Reopen this tab in the private workspace? Its back/forward history and form data are " +
        "lost. y/N",
    );
  });
});

describe("parsePrivateCommand: :private [close]", () => {
  test("without text it toggles", () => {
    expect(parsePrivateCommand(undefined)).toEqual({ kind: "toggle" });
    expect(parsePrivateCommand("")).toEqual({ kind: "toggle" });
  });
  test("close closes it", () => {
    expect(parsePrivateCommand("close")).toEqual({ kind: "close" });
    expect(parsePrivateCommand(" CLOSE ")).toEqual({ kind: "close" });
  });
  test("anything else is refused", () => {
    expect(parsePrivateCommand("open")).toEqual({
      kind: "refuse",
      text: ':private takes "close" or nothing',
    });
  });
});
