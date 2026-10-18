import { describe, test, expect } from "vitest";
import {
  PINNED_MARK_TEXT,
  gutterOf,
  inRange,
  markSummary,
  markedRows,
  openPanel,
  panelKey,
  refreshPanel,
} from "../src/sidepanel.mjs";
import { compileKeymap } from "../src/keymap.mjs";
import { createDispatcher } from "../src/dispatcher.mjs";
import { parseKey } from "../src/keys.mjs";

/** @import { PanelState, PanelTabInfo } from "../src/sidepanel.mjs" */

const model = {
  active: "w2",
  next: 4,
  workspaces: [
    { id: "w1", name: "work", container: "1", tabs: ["t1"], activeTab: "t1", panes: null },
    {
      id: "w2",
      name: "admin",
      container: "2",
      tabs: ["t2", "t3", "t4"],
      activeTab: "t3",
      panes: null,
    },
    { id: "w3", name: "personal", container: "3", tabs: [], activeTab: null, panes: null },
  ],
};

/** @type {Record<string, PanelTabInfo>} */
const tabs = {
  t1: { title: "GitHub", url: "https://github.com/" },
  t2: { title: "Mail", url: "https://mail.example.com/inbox" },
  t3: { title: "", url: "about:blank", label: "scratch", playing: true },
  t4: { title: "Bank", url: "https://bank.fi/", foreign: true },
};
const info = (/** @type {string} */ id) => tabs[id];

/**
 * @param {PanelState} s
 * @param {{ id: string, arg?: number }[]} actions
 */
function press(s, actions) {
  /** @type {ReturnType<typeof panelKey>["effect"]} */
  let effect = null;
  for (const a of actions) ({ state: s, effect } = panelKey(s, a));
  return { state: s, effect };
}

describe("openPanel", () => {
  test("Given the active workspace, then the header names it and its ctrl+u / ctrl+i neighbours", () => {
    const s = openPanel(model, info, { color: "green" });
    expect(s.workspace).toEqual({ id: "w2", name: "admin", index: 2, color: "green" });
    expect(s.previous).toBe("work");
    expect(s.next).toBe("personal");
  });

  test("Given its tabs, then one numbered row each: label, host, active, foreign, playing", () => {
    const s = openPanel(model, info);
    expect(s.rows).toEqual([
      {
        tabId: "t2",
        number: 1,
        display: "Mail",
        host: "mail.example.com",
        active: false,
        foreign: false,
        playing: false,
        pinned: false,
      },
      {
        tabId: "t3",
        number: 2,
        display: "scratch",
        host: "about:blank",
        active: true,
        foreign: false,
        playing: true,
        pinned: false,
      },
      {
        tabId: "t4",
        number: 3,
        display: "Bank",
        host: "bank.fi",
        active: false,
        foreign: true,
        playing: false,
        pinned: false,
      },
    ]);
  });

  test("Given no selection asked for, then the active tab's row is highlighted", () => {
    expect(openPanel(model, info).selected).toBe(1);
  });

  test("Given the last workspace, then the neighbours wrap as ctrl+i / ctrl+u do", () => {
    const s = openPanel({ ...model, active: "w3" }, info);
    expect([s.previous, s.next]).toEqual(["admin", "work"]);
    expect(s.rows).toEqual([]);
    expect(s.selected).toBe(0);
  });

  test("Given one workspace, then it has no neighbours", () => {
    const one = { ...model, active: "w1", workspaces: [model.workspaces[0]] };
    const s = openPanel(one, info);
    expect([s.previous, s.next]).toEqual([null, null]);
  });

  test("Given the agent workspace, then the header names the ctrl+b ( / ctrl+b ) targets past it", () => {
    // docs/specs/vimma-mcp.md decision 9: the cycle skips the agent workspace (w3 here), so the
    // header must not name it as a neighbour.
    const skip = new Set(["w3"]);
    const last = openPanel({ ...model, active: "w2" }, info, { skip });
    expect([last.previous, last.next]).toEqual(["work", "work"]);
    const first = openPanel({ ...model, active: "w1" }, info, { skip });
    expect([first.previous, first.next]).toEqual(["admin", "admin"]);
    const again = refreshPanel(last, { ...model, active: "w2" }, info, { skip });
    expect([again.previous, again.next]).toEqual(["work", "work"]);
  });

  test("Given only the agent workspace besides this one, then there are no neighbours", () => {
    const two = { ...model, active: "w1", workspaces: [model.workspaces[0], model.workspaces[2]] };
    const s = openPanel(two, info, { skip: new Set(["w3"]) });
    expect([s.previous, s.next]).toEqual([null, null]);
  });

  test("Given the agent workspace is the active one, then its neighbours are the cycle's", () => {
    const s = openPanel({ ...model, active: "w3" }, info, { skip: new Set(["w3"]) });
    expect([s.previous, s.next]).toEqual(["admin", "work"]);
  });

  test("Given the private workspace, then its head says so and its neighbours are the host's", () => {
    const priv = {
      active: "◆ private",
      next: 1,
      workspaces: [
        {
          id: "◆ private",
          name: "private",
          container: "",
          tabs: ["t1", "t2"],
          activeTab: "t2",
          panes: null,
        },
      ],
    };
    const s = openPanel(priv, info, { private: true, neighbours: ["home", "work"] });
    expect(s.workspace).toMatchObject({ id: "◆ private", name: "private", private: true });
    expect([s.previous, s.next]).toEqual(["home", "work"]);
    expect(s.rows.map((r) => r.tabId)).toEqual(["t1", "t2"]);
    const again = refreshPanel(s, priv, info, { private: true, neighbours: ["home", "work"] });
    expect(again.workspace.private).toBe(true);
    expect([again.previous, again.next]).toEqual(["home", "work"]);
  });

  test("Given a tab the host no longer knows, then its row still says something", () => {
    const s = openPanel({ ...model, active: "w1" }, () => undefined);
    expect(s.rows[0]).toMatchObject({ display: "New Tab", host: "" });
  });
});

describe("panelKey", () => {
  const s = openPanel(model, info);

  test("j / k move the highlight and stop at the ends", () => {
    expect(press(s, [{ id: "panel.down" }]).state.selected).toBe(2);
    expect(press(s, [{ id: "panel.down" }, { id: "panel.down" }]).state.selected).toBe(2);
    expect(press(s, [{ id: "panel.up" }, { id: "panel.up" }]).state.selected).toBe(0);
  });

  test("Enter selects the highlighted tab", () => {
    expect(press(s, [{ id: "panel.up" }, { id: "panel.open" }]).effect).toEqual({
      type: "select",
      id: "t2",
    });
  });

  test("a digit selects that row's tab", () => {
    expect(press(s, [{ id: "panel.select", arg: 3 }]).effect).toEqual({ type: "select", id: "t4" });
  });

  test("a digit past the last row selects nothing and says so", () => {
    const { state, effect } = press(s, [{ id: "panel.select", arg: 4 }]);
    expect(state).toBe(s);
    expect(effect).toEqual({ type: "refuse", text: "no tab 4 in admin" });
  });

  test("Enter in an empty workspace does nothing", () => {
    const empty = openPanel({ ...model, active: "w3" }, info);
    expect(press(empty, [{ id: "panel.open" }]).effect).toBeNull();
  });

  test("Esc closes", () => {
    expect(press(s, [{ id: "panel.close" }]).effect).toEqual({ type: "close" });
  });

  test("an action that is not the panel's leaves it as it is", () => {
    expect(press(s, [{ id: "tab.new" }])).toEqual({ state: s, effect: null });
  });

  // docs/specs/key-handling-batch.md § 4
  test("x closes the highlighted tab and moves the highlight to the next row", () => {
    const { state, effect } = press(s, [{ id: "panel.up" }, { id: "panel.close_tab" }]);
    expect(effect).toEqual({ type: "closeTab", id: "t2" });
    expect(state.rows[state.selected].tabId).toBe("t3");
  });

  test("x on the last row moves the highlight to the row before it", () => {
    const { state, effect } = press(s, [{ id: "panel.down" }, { id: "panel.close_tab" }]);
    expect(effect).toEqual({ type: "closeTab", id: "t4" });
    expect(state.rows[state.selected].tabId).toBe("t3");
  });

  test("x after the refresh closes the next tab: three x close three rows", () => {
    let state = press(s, [{ id: "panel.up" }]).state;
    const closed = [];
    let left = model;
    for (let i = 0; i < 3; i++) {
      const r = panelKey(state, { id: "panel.close_tab" });
      closed.push(/** @type {any} */ (r.effect).id);
      left = {
        ...left,
        workspaces: left.workspaces.map((w) =>
          w.id === "w2" ? { ...w, tabs: w.tabs.filter((t) => t !== closed.at(-1)) } : w,
        ),
      };
      state = refreshPanel(r.state, left, info);
    }
    expect(closed).toEqual(["t2", "t3", "t4"]);
    expect(state.rows).toEqual([]);
  });

  test("x on a pinned tab refuses and closes nothing", () => {
    const pinned = openPanel(model, (id) => ({ ...tabs[id], pinned: id === "t3" }));
    expect(pinned.rows[1].pinned).toBe(true);
    const { state, effect } = press(pinned, [{ id: "panel.close_tab" }]);
    expect(state).toBe(pinned);
    expect(effect).toEqual({ type: "refuse", text: "pinned tab: unpin it to close it" });
  });

  test("x in an empty workspace does nothing", () => {
    const empty = openPanel({ ...model, active: "w3" }, info);
    expect(press(empty, [{ id: "panel.close_tab" }]).effect).toBeNull();
  });

  // docs/specs/m3-workspaces.md, "Settled: moving a background tab from the side panel"
  test("m moves the highlighted tab, not the selected one: the host asks where", () => {
    const { state, effect } = press(s, [{ id: "panel.up" }, { id: "panel.move" }]);
    expect(effect).toEqual({ type: "move", id: "t2" });
    expect(state.rows[state.selected].tabId).toBe("t2");
  });

  test("m on a pinned tab refuses", () => {
    const pinned = openPanel(model, (id) => ({ ...tabs[id], pinned: id === "t3" }));
    expect(press(pinned, [{ id: "panel.move" }]).effect).toEqual({
      type: "refuse",
      text: "pinned tab: unpin it to move it",
    });
  });

  test("m in an empty workspace does nothing", () => {
    const empty = openPanel({ ...model, active: "w3" }, info);
    expect(press(empty, [{ id: "panel.move" }]).effect).toBeNull();
  });

  test("m is panel.move in panel mode", () => {
    const d = createDispatcher(compileKeymap());
    expect(d.dispatch("panel", parseKey("m"))).toEqual({
      kind: "action",
      action: { id: "panel.move" },
    });
  });
});

describe("refreshPanel", () => {
  test("Given the highlighted tab is still listed, then the highlight stays on it", () => {
    const s = press(openPanel(model, info), [{ id: "panel.down" }]).state;
    const moved = {
      ...model,
      workspaces: model.workspaces.map((w) =>
        w.id === "w2" ? { ...w, tabs: ["t5", "t2", "t3", "t4"] } : w,
      ),
    };
    const next = refreshPanel(s, moved, info);
    expect(next.rows[next.selected].tabId).toBe("t4");
  });

  test("Given another workspace (ctrl+i), then it lists that one, its active tab highlighted", () => {
    const s = press(openPanel(model, info), [{ id: "panel.down" }]).state;
    const next = refreshPanel(s, { ...model, active: "w1" }, info, { color: "blue" });
    expect(next.workspace).toEqual({ id: "w1", name: "work", index: 1, color: "blue" });
    expect(next.rows.map((r) => r.tabId)).toEqual(["t1"]);
    expect(next.selected).toBe(0);
  });
});

describe("panel keys in the keymap", () => {
  const keymap = compileKeymap();
  /**
   * @param {string} mode
   * @param {string} keys
   */
  const feed = (mode, keys) => {
    const d = createDispatcher(keymap);
    return keys.split(" ").map((k) => d.dispatch(/** @type {any} */ (mode), parseKey(k)));
  };

  test("space n (a leader binding from config.toml) closes the panel from panel mode", () => {
    const d = createDispatcher(
      compileKeymap({ keys: { toggle_sidebar: ["prefix+b", "<leader>n"] } }),
    );
    const r = ["space", "n"].map((k) => d.dispatch("panel", parseKey(k)));
    expect(r.at(-1)).toEqual({
      kind: "action",
      action: { id: "sidebar.toggle" },
    });
  });

  test("prefix b toggles it from panel mode", () => {
    expect(feed("panel", "ctrl+b b").at(-1)).toMatchObject({ action: { id: "sidebar.toggle" } });
  });

  test("x closes the tab and ctrl+shift+t reopens one in panel mode; 3 still selects row 3", () => {
    expect(feed("panel", "x")[0]).toEqual({ kind: "action", action: { id: "panel.close_tab" } });
    expect(feed("panel", "ctrl+shift+t")[0]).toEqual({
      kind: "action",
      action: { id: "tab.restore" },
    });
    expect(feed("panel", "3 x")).toEqual([
      { kind: "action", action: { id: "panel.select", arg: 3 } },
      { kind: "action", action: { id: "panel.close_tab" } },
    ]);
  });

  test("leader bindings still do not fire in insert mode", () => {
    expect(feed("insert", "space")[0]).toEqual({ kind: "pass" });
  });
});

// docs/specs/m4-side-panel-multiselect.md: marks, a line-wise range, and Enter showing the
// marked tabs together as panes.
describe("marks", () => {
  const five = {
    ...model,
    workspaces: model.workspaces.map((w) =>
      w.id === "w2" ? { ...w, tabs: ["t2", "t3", "t4", "t5", "t6"], activeTab: "t2" } : w,
    ),
  };
  /** @type {Record<string, PanelTabInfo>} */
  const more = { ...tabs, t5: { title: "Docs" }, t6: { title: "Pinned", pinned: true } };
  const info5 = (/** @type {string} */ id) => more[id];
  const open = () => openPanel(five, info5);
  /**
   * @param {string[]} list
   * @returns {typeof five}
   */
  const withTabs = (list) => ({
    ...five,
    workspaces: five.workspaces.map((w) => (w.id === "w2" ? { ...w, tabs: list } : w)),
  });
  const SPACE = { id: "panel.mark" };
  const V = { id: "panel.visual" };
  const J = { id: "panel.down" };
  const K = { id: "panel.up" };
  const ENTER = { id: "panel.open" };
  const ESC = { id: "panel.close" };

  test("a new panel has no marks and no range", () => {
    const s = open();
    expect(s.marked).toEqual([]);
    expect(s.anchor).toBeNull();
    expect(markSummary(s)).toBe("");
  });

  test("space marks the highlighted row and leaves the highlight on it", () => {
    const { state } = press(open(), [SPACE]);
    expect(state.marked).toEqual(["t2"]);
    expect(state.selected).toBe(0);
    expect(markSummary(state)).toBe("1 marked");
  });

  test("space again on the same row unmarks it, the highlight still there", () => {
    const { state } = press(open(), [J, SPACE, SPACE]);
    expect(state.marked).toEqual([]);
    expect(state.selected).toBe(1);
  });

  test("only j / k move the highlight between marks", () => {
    let { state } = press(open(), [SPACE, J, SPACE]);
    expect(state.marked).toEqual(["t2", "t3"]);
    expect(state.selected).toBe(1);
    expect(markSummary(state)).toBe("2 marked");
    ({ state } = press(state, [K, SPACE]));
    expect(state.marked).toEqual(["t3"]);
    expect(state.selected).toBe(0);
  });

  test("space on the last row marks it and stays there", () => {
    const once = press(openPanel(model, info), [J, SPACE]).state;
    expect(once.marked).toEqual(["t4"]);
    expect(once.selected).toBe(2);
    expect(press(once, [SPACE]).state.marked).toEqual([]);
  });

  test("space on a pinned row refuses and marks nothing", () => {
    const { state, effect } = press(open(), [J, J, J, J, SPACE]);
    expect(state.marked).toEqual([]);
    expect(effect).toEqual({ type: "refuse", text: PINNED_MARK_TEXT });
  });

  test("V starts a range that j / k stretch; V again marks every row in it", () => {
    let { state } = press(open(), [J, V, J, J]);
    expect(state.anchor).toBe("t3");
    expect(inRange(state, 0)).toBe(false);
    expect([1, 2, 3].map((i) => inRange(state, i))).toEqual([true, true, true]);
    expect(inRange(state, 4)).toBe(false);
    expect(markSummary(state)).toBe("range: 3");
    ({ state } = press(state, [V]));
    expect(state.anchor).toBeNull();
    expect(state.marked).toEqual(["t3", "t4", "t5"]);
    expect(markSummary(state)).toBe("3 marked");
  });

  test("a range upward, ended by space, adds to the marks already there", () => {
    const { state } = press(open(), [SPACE, J, J, V, K, SPACE]);
    expect(state.marked).toEqual(["t2", "t3", "t4"]);
    expect(state.anchor).toBeNull();
    expect(state.selected).toBe(1);
  });

  test("a range skips a pinned row", () => {
    const { state, effect } = press(open(), [J, J, J, V, J, V]);
    expect(state.marked).toEqual(["t5"]);
    expect(effect).toBeNull();
  });

  test("the summary counts the range and the marks while both exist", () => {
    const { state } = press(open(), [SPACE, J, V, J]);
    expect(markSummary(state)).toBe("range: 2 · 1 marked");
  });

  test("Esc ends the range first, then clears the marks, then closes", () => {
    let r = press(open(), [SPACE, J, V, J, ESC]);
    expect(r.state.anchor).toBeNull();
    expect(r.state.marked).toEqual(["t2"]);
    expect(r.effect).toBeNull();
    r = press(r.state, [ESC]);
    expect(r.state.marked).toEqual([]);
    expect(r.effect).toBeNull();
    r = press(r.state, [ESC]);
    expect(r.effect).toEqual({ type: "close" });
  });

  test("Enter with two marks or more shows them together, in row order", () => {
    const { effect } = press(open(), [J, J, SPACE, K, K, SPACE, J, ENTER]);
    expect(effect).toEqual({ type: "together", ids: ["t2", "t4"], focus: "t2" });
  });

  test("Enter focuses the highlighted row when it is marked, else the first marked", () => {
    const on = press(open(), [SPACE, J, SPACE, J, SPACE, K, ENTER]).effect;
    expect(on).toEqual({ type: "together", ids: ["t2", "t3", "t4"], focus: "t3" });
    const off = press(open(), [J, SPACE, J, SPACE, J, ENTER]).effect;
    expect(off).toEqual({ type: "together", ids: ["t3", "t4"], focus: "t3" });
  });

  test("Enter with one mark goes to that tab, as Enter on its row", () => {
    const { effect } = press(open(), [J, SPACE, J, J, ENTER]);
    expect(effect).toEqual({ type: "select", id: "t3" });
  });

  test("Enter in a range marks it, then shows the marks together", () => {
    const { effect } = press(open(), [V, J, J, ENTER]);
    expect(effect).toEqual({ type: "together", ids: ["t2", "t3", "t4"], focus: "t4" });
  });

  test("Enter without marks still goes to the highlighted tab; a digit ignores the marks", () => {
    expect(press(open(), [J, ENTER]).effect).toEqual({ type: "select", id: "t3" });
    expect(press(open(), [SPACE, J, SPACE, J, { id: "panel.select", arg: 4 }]).effect).toEqual({
      type: "select",
      id: "t5",
    });
  });

  test("x keeps the marks of the other rows; the refresh drops a closed tab's mark", () => {
    let { state } = press(open(), [SPACE, J, SPACE]);
    expect(state.marked).toEqual(["t2", "t3"]);
    ({ state } = press(state, [{ id: "panel.close_tab" }]));
    state = refreshPanel(state, withTabs(["t2", "t4", "t5", "t6"]), info5);
    expect(state.marked).toEqual(["t2"]);
  });

  test("a refresh in the same workspace keeps marks and the range on listed tabs", () => {
    const s = press(open(), [SPACE, J, V]).state;
    const next = refreshPanel(s, five, info5);
    expect(next.marked).toEqual(["t2"]);
    expect(next.anchor).toBe("t3");
  });

  test("a refresh whose range anchor closed ends the range", () => {
    const s = press(open(), [J, V, J]).state;
    expect(refreshPanel(s, withTabs(["t2", "t4", "t5", "t6"]), info5).anchor).toBeNull();
  });

  test("marks follow their tabs when the order changes, and stay in row order", () => {
    const s = press(open(), [SPACE, J, J, SPACE]).state;
    expect(s.marked).toEqual(["t2", "t4"]);
    expect(refreshPanel(s, withTabs(["t4", "t3", "t2", "t5", "t6"]), info5).marked).toEqual([
      "t4",
      "t2",
    ]);
  });

  test("another workspace (ctrl+b )) clears the marks and the range", () => {
    const s = press(open(), [SPACE, J, V]).state;
    const next = refreshPanel(s, { ...five, active: "w1" }, info5);
    expect(next.marked).toEqual([]);
    expect(next.anchor).toBeNull();
  });

  test("markedRows lists the marked rows in row order", () => {
    const s = press(open(), [J, J, SPACE, K, K, SPACE]).state;
    expect(markedRows(s).map((r) => r.tabId)).toEqual(["t2", "t4"]);
  });

  test("the default keys: space marks, V starts a range, in panel mode", () => {
    const d = createDispatcher(compileKeymap());
    expect(d.dispatch("panel", parseKey("space"))).toEqual({
      kind: "action",
      action: { id: "panel.mark" },
    });
    expect(d.dispatch("panel", parseKey("V"))).toEqual({
      kind: "action",
      action: { id: "panel.visual" },
    });
  });

  test("they are rebindable under [modal.panel]", () => {
    const d = createDispatcher(
      compileKeymap({ modal: { panel: { m: "panel_mark", v: "panel_visual" } } }),
    );
    expect(d.dispatch("panel", parseKey("m"))).toEqual({
      kind: "action",
      action: { id: "panel.mark" },
    });
    expect(d.dispatch("panel", parseKey("v"))).toEqual({
      kind: "action",
      action: { id: "panel.visual" },
    });
  });

  test("with a leader binding added, space waits for the next key and then marks", () => {
    const d = createDispatcher(
      compileKeymap({ keys: { toggle_sidebar: ["prefix+b", "<leader>n"] } }),
    );
    expect(d.dispatch("panel", parseKey("space"))).toEqual({ kind: "pending" });
    expect(d.ambiguous()).toBe(true);
    expect(d.flush()).toEqual({ kind: "action", action: { id: "panel.mark" } });
  });
});

// docs/specs/side-panel-unsplit.md: the split's panes start marked; Enter applies a change.
describe("a split in the panel", () => {
  const five = {
    ...model,
    workspaces: model.workspaces.map((w) =>
      w.id === "w2" ? { ...w, tabs: ["t2", "t3", "t4", "t5", "t6"], activeTab: "t3" } : w,
    ),
  };
  /** @type {Record<string, PanelTabInfo>} */
  const more = { ...tabs, t5: { title: "Docs" }, t6: { title: "Chat" } };
  const info5 = (/** @type {string} */ id) => more[id];
  /** t2, t3, t4 are the panes, t3's has focus; the highlight starts on t3 (the active tab). */
  const split = { panes: ["t4", "t2", "t3"], paneFocus: "t3" };
  const open = () => openPanel(five, info5, split);
  const SPACE = { id: "panel.mark" };
  const V = { id: "panel.visual" };
  const J = { id: "panel.down" };
  const K = { id: "panel.up" };
  const ENTER = { id: "panel.open" };
  const ESC = { id: "panel.close" };

  test("the panes start marked, in row order, and the header names the split", () => {
    const s = open();
    expect(s.panes).toEqual(["t2", "t3", "t4"]);
    expect(s.marked).toEqual(["t2", "t3", "t4"]);
    expect(s.anchor).toBeNull();
    expect(markSummary(s)).toBe("split: 3 panes");
  });

  test("without a split nothing is marked, as before", () => {
    for (const s of [openPanel(five, info5), openPanel(five, info5, { panes: [] })]) {
      expect(s.panes).toEqual([]);
      expect(s.marked).toEqual([]);
      expect(markSummary(s)).toBe("");
    }
  });

  test("a pane tab not listed in the workspace is not marked", () => {
    const s = openPanel(five, info5, { panes: ["t2", "t3", "gone"], paneFocus: "t2" });
    expect(s.panes).toEqual(["t2", "t3"]);
    expect(s.marked).toEqual(["t2", "t3"]);
  });

  test("space unmarks a pane and marks another tab; the header says what Enter will do", () => {
    let { state } = press(open(), [SPACE, J]);
    expect(state.marked).toEqual(["t2", "t4"]);
    expect(markSummary(state)).toBe("split: 3 → 2");
    ({ state } = press(state, [J, SPACE]));
    expect(state.marked).toEqual(["t2", "t4", "t5"]);
    expect(markSummary(state)).toBe("split: 3 → 3");
    ({ state } = press(state, [K, K, K, K, SPACE, J, J, SPACE, J]));
    expect(state.marked).toEqual(["t5"]);
    expect(markSummary(state)).toBe("split: 3 → 1 (unsplit)");
    ({ state } = press(state, [SPACE]));
    expect(state.marked).toEqual([]);
    expect(markSummary(state)).toBe("split: 3 → 0 (unsplit)");
  });

  test("marking back to the panes reads as unchanged", () => {
    const { state } = press(open(), [SPACE, SPACE]);
    expect(state.marked).toEqual(["t2", "t3", "t4"]);
    expect(markSummary(state)).toBe("split: 3 panes");
  });

  test("an open range is counted before the split", () => {
    const { state } = press(open(), [J, V, J]);
    expect(markSummary(state)).toBe("range: 2 · split: 3 panes");
  });

  test("the gutter: ● marked, ○ a pane that will leave, │ in a range, else blank", () => {
    let { state } = press(open(), [SPACE, J]);
    expect([0, 1, 2, 3, 4].map((i) => gutterOf(state, i))).toEqual(["●", "○", "●", "", ""]);
    ({ state } = press(state, [J, V, J]));
    expect([0, 1, 2, 3, 4].map((i) => gutterOf(state, i))).toEqual(["●", "○", "●", "│", "│"]);
  });

  test("Enter with the marks unchanged goes to the highlighted tab (decision 12)", () => {
    expect(press(open(), [ENTER]).effect).toEqual({ type: "select", id: "t3" });
    expect(press(open(), [J, J, ENTER]).effect).toEqual({ type: "select", id: "t5" });
    expect(press(open(), [SPACE, SPACE, J, ENTER]).effect).toEqual({
      type: "select",
      id: "t4",
    });
  });

  test("Enter after unmarking a pane shows the rest; the focused pane keeps focus", () => {
    const { effect } = press(open(), [J, SPACE, J, ENTER]);
    expect(effect).toEqual({ type: "together", ids: ["t2", "t3"], focus: "t3" });
  });

  test("the focused pane unmarked: focus on the highlighted row if marked, else the first", () => {
    const on = press(open(), [SPACE, J, J, SPACE, ENTER]).effect;
    expect(on).toEqual({ type: "together", ids: ["t2", "t4", "t5"], focus: "t5" });
    const off = press(open(), [SPACE, J, J, J, ENTER]).effect;
    expect(off).toEqual({ type: "together", ids: ["t2", "t4"], focus: "t2" });
  });

  test("Enter after marking another tab adds it", () => {
    const { effect } = press(open(), [J, J, SPACE, J, ENTER]);
    expect(effect).toEqual({ type: "together", ids: ["t2", "t3", "t4", "t5"], focus: "t3" });
  });

  test("Enter after removing one and adding another applies both at once", () => {
    const { effect } = press(open(), [K, SPACE, J, J, J, SPACE, J, ENTER]);
    expect(effect).toEqual({ type: "together", ids: ["t3", "t4", "t5"], focus: "t3" });
  });

  test("Enter with one mark left ends the split and shows that tab alone", () => {
    const { effect } = press(open(), [K, SPACE, J, J, SPACE, J, ENTER]);
    expect(effect).toEqual({ type: "alone", id: "t3" });
  });

  // Decision 25: Enter applies the marks, then goes to the highlighted row.
  test("the user's flow: space on pane C, Enter on C: C alone, the rest a hidden view", () => {
    const { effect } = press(open(), [J, SPACE, ENTER]);
    expect(effect).toEqual({ type: "together", ids: ["t2", "t3"], focus: "t3", alone: "t4" });
  });

  test("one mark left with the highlight on a removed pane: that pane shows alone", () => {
    const { effect } = press(open(), [K, SPACE, J, J, SPACE, ENTER]);
    expect(effect).toEqual({ type: "alone", id: "t4" });
  });

  test("the highlighted row has focus when it is marked, before the kept focused pane", () => {
    const { effect } = press(open(), [J, J, SPACE, ENTER]);
    expect(effect).toEqual({ type: "together", ids: ["t2", "t3", "t4", "t5"], focus: "t5" });
  });

  test("a hidden view's panes are marked, and the header says it is hidden", () => {
    const s = openPanel(five, info5, { ...split, paneHidden: true });
    expect(s.marked).toEqual(["t2", "t3", "t4"]);
    expect(s.hidden).toBe(true);
    expect(markSummary(s)).toBe("split: 3 panes (hidden)");
    expect(markSummary(press(s, [SPACE]).state)).toBe("split: 3 → 2");
    expect(open().hidden).toBe(false);
  });

  test("Enter with no mark left ends the split and shows the highlighted tab alone", () => {
    const { effect } = press(open(), [K, SPACE, J, SPACE, J, SPACE, J, J, ENTER]);
    expect(effect).toEqual({ type: "alone", id: "t6" });
  });

  test("Enter in a range marks it first, then compares with the split", () => {
    expect(press(open(), [K, V, J, ENTER]).effect).toEqual({ type: "select", id: "t3" });
    expect(press(open(), [J, J, V, ENTER]).effect).toEqual({
      type: "together",
      ids: ["t2", "t3", "t4", "t5"],
      focus: "t5",
    });
  });

  test("a digit still goes to its row, whatever is marked", () => {
    expect(press(open(), [SPACE, J, { id: "panel.select", arg: 5 }]).effect).toEqual({
      type: "select",
      id: "t6",
    });
  });

  test("Esc with the marks unchanged closes at once", () => {
    expect(press(open(), [ESC]).effect).toEqual({ type: "close" });
  });

  test("Esc with changed marks puts the panes' marks back, then closes", () => {
    let r = press(open(), [SPACE, J, SPACE, J, ESC]);
    expect(r.state.marked).toEqual(["t2", "t3", "t4"]);
    expect(r.effect).toBeNull();
    r = press(r.state, [ESC]);
    expect(r.effect).toEqual({ type: "close" });
  });

  test("Esc ends a range first, even on an unchanged split", () => {
    const r = press(open(), [V, J, ESC]);
    expect(r.state.anchor).toBeNull();
    expect(r.state.marked).toEqual(["t2", "t3", "t4"]);
    expect(r.effect).toBeNull();
  });

  test("a refresh follows the split while the marks are unchanged", () => {
    const next = refreshPanel(open(), five, info5, { panes: ["t2", "t3"], paneFocus: "t2" });
    expect(next.panes).toEqual(["t2", "t3"]);
    expect(next.marked).toEqual(["t2", "t3"]);
    expect(next.paneFocus).toBe("t2");
  });

  test("a refresh keeps the user's changes, dropping tabs no longer listed", () => {
    const s = press(open(), [SPACE, J, J, SPACE]).state;
    expect(s.marked).toEqual(["t2", "t4", "t5"]);
    const fewer = {
      ...five,
      workspaces: five.workspaces.map((w) =>
        w.id === "w2" ? { ...w, tabs: ["t2", "t3", "t5", "t6"] } : w,
      ),
    };
    const next = refreshPanel(s, fewer, info5, { panes: ["t2", "t3"], paneFocus: "t3" });
    expect(next.panes).toEqual(["t2", "t3"]);
    expect(next.marked).toEqual(["t2", "t5"]);
  });

  test("another workspace starts from its own split", () => {
    const s = press(open(), [SPACE]).state;
    const two = {
      ...five,
      active: "w1",
      workspaces: five.workspaces.map((w) => (w.id === "w1" ? { ...w, tabs: ["t1", "t7"] } : w)),
    };
    const next = refreshPanel(s, two, info5, { panes: ["t1", "t7"], paneFocus: "t7" });
    expect(next.marked).toEqual(["t1", "t7"]);
    expect(next.paneFocus).toBe("t7");
    expect(refreshPanel(s, two, info5).marked).toEqual([]);
  });
});
