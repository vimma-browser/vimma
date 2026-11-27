// docs/specs/close-last-tab.md: what a user close of a window's last tab does.
import { describe, test, expect } from "vitest";
import {
  CLOSE_LAST_QUIT_ID,
  CLOSE_LAST_VALUES,
  KEEP_TEXT,
  closeLastOutcome,
  closeWindowQuestion,
  lastTabRows,
  quitQuestion,
} from "../src/workspaces/closelast.mjs";
import { privateItem } from "../src/workspaces/privatews.mjs";

import type { CloseLastWindow } from "../src/workspaces/closelast.mjs";
import type { WorkspaceItem } from "../src/ui/picker.mjs";

/** The last normal window, with no other tabs anywhere. */
function alone(over: Partial<CloseLastWindow> = {}): CloseLastWindow {
  return {
    inPrivate: false,
    otherTabs: 0,
    otherWorkspaces: 0,
    privateTabs: 0,
    lastNormalWindow: true,
    otherPrivateTabs: 0,
    ...over,
  };
}

/** The last normal window, 14 tabs in 3 other workspaces. */
const withOthers = (over: Partial<CloseLastWindow> = {}) =>
  alone({ otherTabs: 14, otherWorkspaces: 3, ...over });
/** Another normal window is open. */
const notLast = (over: Partial<CloseLastWindow> = {}) =>
  alone({ lastNormalWindow: false, ...over });

const QUIT_Q = "quit Vimma? 14 tabs in 3 other workspaces come back at the next start y/N";
const CLOSE_Q =
  "close this window? 14 tabs in 3 other workspaces go to the recently closed windows y/N";

describe("closeLastOutcome", () => {
  test("the five values, in the order the docs list them", () => {
    expect(CLOSE_LAST_VALUES).toEqual(["picker", "new_tab", "ask", "quit", "keep"]);
  });

  describe('"picker" (behaviours 3 and 4)', () => {
    test("other workspaces' tabs: the picker, its last row quits", () => {
      expect(closeLastOutcome("picker", withOthers())).toEqual({
        kind: "picker",
        quitRow: "quit Vimma",
        privateQuestion: null,
      });
    });
    test("no other tabs: quits without a question", () => {
      expect(closeLastOutcome("picker", alone())).toEqual({ kind: "quit" });
    });
    test("another normal window: the last row closes this window; nothing else: closes it", () => {
      expect(closeLastOutcome("picker", notLast({ otherTabs: 2, otherWorkspaces: 1 }))).toEqual({
        kind: "picker",
        quitRow: "close this window",
        privateQuestion: null,
      });
      expect(closeLastOutcome("picker", notLast())).toEqual({ kind: "close_window" });
    });
    test("private tabs are the window's other tabs in the last normal window only", () => {
      expect(closeLastOutcome("picker", alone({ privateTabs: 2 }))).toEqual({
        kind: "picker",
        quitRow: "quit Vimma",
        privateQuestion: "quit Vimma? 2 private tabs are discarded y/N",
      });
      expect(closeLastOutcome("picker", withOthers({ privateTabs: 1 }))).toEqual({
        kind: "picker",
        quitRow: "quit Vimma",
        privateQuestion: "quit Vimma? 1 private tab is discarded y/N",
      });
      expect(closeLastOutcome("picker", notLast({ privateTabs: 2 }))).toEqual({
        kind: "close_window",
      });
    });
  });

  test("a value the config check would refuse never quits: today's new tab", () => {
    expect(closeLastOutcome("close" as never, alone())).toEqual({ kind: "new_tab" });
  });

  test('"new_tab" is today\'s new tab, in every window (behaviour 2)', () => {
    for (const w of [alone(), withOthers(), notLast(), alone({ privateTabs: 3 })]) {
      expect(closeLastOutcome("new_tab", w)).toEqual({ kind: "new_tab" });
    }
  });

  describe('"ask" (behaviour 5)', () => {
    test("no other tabs: quits without a question", () => {
      expect(closeLastOutcome("ask", alone())).toEqual({ kind: "quit" });
    });
    test("other workspaces' tabs: asks with their counts", () => {
      expect(closeLastOutcome("ask", withOthers())).toEqual({ kind: "ask", question: QUIT_Q });
    });
    test("private tabs: the question says they are discarded", () => {
      expect(closeLastOutcome("ask", withOthers({ privateTabs: 2 }))).toEqual({
        kind: "ask",
        question:
          "quit Vimma? 14 tabs in 3 other workspaces come back at the next start; " +
          "2 private tabs are discarded y/N",
      });
      expect(closeLastOutcome("ask", alone({ privateTabs: 2 }))).toEqual({
        kind: "ask",
        question: "quit Vimma? 2 private tabs are discarded y/N",
      });
    });
    test("another normal window: closes it, asking when it holds other tabs", () => {
      expect(closeLastOutcome("ask", notLast())).toEqual({ kind: "close_window" });
      expect(closeLastOutcome("ask", notLast({ privateTabs: 4 }))).toEqual({
        kind: "close_window",
      });
      expect(closeLastOutcome("ask", notLast({ otherTabs: 14, otherWorkspaces: 3 }))).toEqual({
        kind: "ask_close_window",
        question: CLOSE_Q,
      });
    });
  });

  describe('"quit" (behaviour 6)', () => {
    test("quits without a question, other workspaces' tabs or not", () => {
      expect(closeLastOutcome("quit", alone())).toEqual({ kind: "quit" });
      expect(closeLastOutcome("quit", withOthers())).toEqual({ kind: "quit" });
    });
    test("asks behaviour 5's question when private tabs are open", () => {
      expect(closeLastOutcome("quit", withOthers({ privateTabs: 2 }))).toEqual({
        kind: "ask",
        question:
          "quit Vimma? 14 tabs in 3 other workspaces come back at the next start; " +
          "2 private tabs are discarded y/N",
      });
    });
    test("another normal window: closes it without a question", () => {
      expect(closeLastOutcome("quit", notLast({ otherTabs: 5, otherWorkspaces: 2 }))).toEqual({
        kind: "close_window",
      });
    });
  });

  test('"keep" refuses in every window, the private workspace too (behaviours 7 and 11)', () => {
    for (const w of [alone(), withOthers(), notLast(), alone({ inPrivate: true })]) {
      expect(closeLastOutcome("keep", w)).toEqual({ kind: "keep" });
    }
    expect(KEEP_TEXT).toBe("last tab: not closed");
  });

  describe("the private workspace's last tab (behaviour 11)", () => {
    const priv = (over: Partial<CloseLastWindow> = {}) =>
      alone({ inPrivate: true, otherTabs: 0, ...over });
    test.each([["picker"], ["ask"], ["quit"]] as const)(
      '"%s" closes the private workspace, never Vimma',
      (value) => {
        expect(closeLastOutcome(value, priv())).toEqual({ kind: "close_private" });
        expect(closeLastOutcome(value, priv({ otherTabs: 9, otherWorkspaces: 2 }))).toEqual({
          kind: "close_private",
        });
      },
    );
    test('"new_tab" opens a new private tab', () => {
      expect(closeLastOutcome("new_tab", priv())).toEqual({ kind: "new_tab" });
    });
    test("another private window with tabs: only this window closes", () => {
      expect(closeLastOutcome("picker", priv({ otherPrivateTabs: 2 }))).toEqual({
        kind: "close_window",
      });
    });
  });
});

describe("the questions' counts", () => {
  test("singular and plural", () => {
    expect(quitQuestion({ otherTabs: 1, otherWorkspaces: 1, privateTabs: 0 })).toBe(
      "quit Vimma? 1 tab in 1 other workspace comes back at the next start y/N",
    );
    expect(quitQuestion({ otherTabs: 2, otherWorkspaces: 1, privateTabs: 0 })).toBe(
      "quit Vimma? 2 tabs in 1 other workspace come back at the next start y/N",
    );
    expect(closeWindowQuestion({ otherTabs: 1, otherWorkspaces: 1 })).toBe(
      "close this window? 1 tab in 1 other workspace goes to the recently closed windows y/N",
    );
  });
});

describe("lastTabRows (behaviour 3)", () => {
  const ws = (
    id: string,
    index: number,
    tabCount: number,
    over: Partial<WorkspaceItem> = {},
  ): WorkspaceItem => ({
    kind: "workspace",
    workspaceId: id,
    workspaceName: id,
    workspaceIndex: index,
    tabCount,
    foreignCount: 0,
    display: id,
    active: false,
    ...over,
  });
  const items = [
    ws("main", 1, 1, { active: true }),
    ws("work", 2, 3),
    ws("empty", 3, 0),
    ws("agent", 4, 2, { agent: true, display: "◇ agent" }),
  ];

  test("the window's other workspaces with tabs, then the quit row; none is current", () => {
    const rows = lastTabRows(items, { closedWorkspaceId: "main", quitRow: "quit Vimma" });
    expect(rows.map((r) => r.workspaceId)).toEqual(["work", "agent", CLOSE_LAST_QUIT_ID]);
    expect(rows.every((r) => !r.active)).toBe(true);
    expect(rows[0]).toMatchObject({ workspaceIndex: 2, tabCount: 3, display: "work" });
    expect(rows.at(-1)).toMatchObject({ display: "quit Vimma", countText: "" });
  });

  test("the private row after the workspaces when it is among the window's other tabs", () => {
    const priv = privateItem({ tabCount: 2, index: 5, active: false });
    const rows = lastTabRows(items, {
      closedWorkspaceId: "main",
      quitRow: "quit Vimma",
      privateRow: priv,
    });
    expect(rows.map((r) => r.workspaceId)).toEqual([
      "work",
      "agent",
      priv.workspaceId,
      CLOSE_LAST_QUIT_ID,
    ]);
  });

  test("in another normal window the last row closes this window", () => {
    const rows = lastTabRows(items, { closedWorkspaceId: "main", quitRow: "close this window" });
    expect(rows.at(-1)?.display).toBe("close this window");
  });
});
