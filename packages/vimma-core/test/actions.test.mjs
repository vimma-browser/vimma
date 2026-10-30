import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { ACTIONS, closest, getAction, resolveActionName } from "../src/actions.mjs";
import { compileKeymap } from "../src/keymap.mjs";

describe("actions", () => {
  test("every action has a unique id+arg, a unique config name, a group and a description", () => {
    const names = new Set();
    const ids = new Set();
    for (const a of ACTIONS) {
      expect(a.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(a.id).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
      expect(a.description.length).toBeGreaterThan(3);
      expect(a.group.length).toBeGreaterThan(0);
      expect(names.has(a.name)).toBe(false);
      names.add(a.name);
      const key = `${a.id}:${a.arg ?? ""}`;
      expect(ids.has(key)).toBe(false);
      ids.add(key);
    }
  });

  test("Herdr's documented action names exist", () => {
    for (const n of [
      "new_tab",
      "split_vertical",
      "split_horizontal",
      "focus_pane_left",
      "zoom",
      "resize_mode",
      "copy_mode",
      "next_tab",
      "previous_tab",
      "rename_tab",
      "close_tab",
      "new_workspace",
      "rename_workspace",
      "close_workspace",
      "move_to_workspace",
      "route_rules",
      "goto_picker",
      "toggle_sidebar",
    ]) {
      expect(getAction(n), n).toBeDefined();
    }
  });

  test("actions resolve by config name, by dotted id and by alias", () => {
    expect(resolveActionName("new_tab")?.id).toBe("tab.new");
    expect(resolveActionName("tab.new")?.name).toBe("new_tab");
    expect(resolveActionName("prev_workspace")?.name).toBe("previous_workspace");
    expect(resolveActionName("select_tab_3")).toMatchObject({ id: "tab.goto", arg: 3 });
    expect(resolveActionName("nope")).toBeUndefined();
  });

  test("ACTIONS is frozen so the closed set cannot be extended at runtime", () => {
    expect(Object.isFrozen(ACTIONS)).toBe(true);
  });

  test("every M2 tab action of plan §2 exists with its default binding (m2-core-logic)", () => {
    const km = compileKeymap();
    /** @type {Record<string, string[]>} */
    const want = {
      show_keybinds: ["prefix+?"],
      // Firefox's own tab keys too (docs/specs/firefox-keys.md).
      new_tab: ["prefix+c", "ctrl+t", "t"],
      next_tab: ["prefix+n", "ctrl+tab", "ctrl+pagedown", "gt"],
      previous_tab: ["prefix+p", "ctrl+shift+tab", "ctrl+pageup", "gT"],
      ...Object.fromEntries(
        Array.from({ length: 9 }, (_, i) => [
          `select_tab_${i + 1}`,
          i < 8 ? [`prefix+${i + 1}`, `alt+${i + 1}`] : [`prefix+${i + 1}`],
        ]),
      ),
      rename_tab: ["prefix+shift+t"],
      close_tab: ["prefix+shift+x", "ctrl+f4", "x"],
      goto_picker: ["prefix+g", "ctrl+shift+a", "b"],
    };
    for (const [name, bindings] of Object.entries(want)) {
      expect(getAction(name), name).toBeDefined();
      expect(km.bindingsFor(name), name).toEqual(bindings);
    }
    expect(getAction("select_tab_3")).toMatchObject({ id: "tab.goto", arg: 3 });
  });

  // docs/specs/vimma-mcp.md decisions 14 and 25: answer the waiting agent question.
  test("agent_prompt: prefix+shift+a, in every mode, in the Agents group (vimma-mcp)", () => {
    const km = compileKeymap();
    expect(getAction("agent_prompt")).toMatchObject({ id: "mcp.answer", group: "Agents" });
    expect(getAction("control_command")).toMatchObject({ id: "control.command", group: "Agents" });
    expect(km.bindingsFor("agent_prompt")).toEqual(["prefix+shift+a"]);
    expect(km.bindingsFor("control_command")).toEqual([]);
    for (const mode of /** @type {const} */ (["normal", "insert", "visual", "panel", "help"])) {
      const node = km.trie(mode).children.get("ctrl+b")?.children.get("shift+a");
      expect(node?.action?.id, mode).toBe("mcp.answer");
    }
  });

  // docs/specs/live-grep.md decision 2: ctrl+b f is the find group; ]q and [q step the results.
  test("live_grep on prefix+f g, grep_next / grep_previous on ]q / [q (live-grep)", () => {
    const km = compileKeymap();
    expect(getAction("live_grep")).toMatchObject({ id: "grep.open", group: "Find" });
    expect(getAction("grep_next")).toMatchObject({ id: "grep.next", group: "Find" });
    expect(getAction("grep_previous")).toMatchObject({ id: "grep.previous", group: "Find" });
    expect(getAction("grep_resume")).toMatchObject({ id: "grep.resume", group: "Find" });
    expect(km.bindingsFor("grep_resume")).toEqual([]);
    expect(km.bindingsFor("live_grep")).toEqual(["prefix+f g"]);
    expect(km.bindingsFor("grep_next")).toEqual(["]q"]);
    expect(km.bindingsFor("grep_previous")).toEqual(["[q"]);
    for (const mode of /** @type {const} */ (["normal", "insert", "visual", "panel", "help"])) {
      const f = km.trie(mode).children.get("ctrl+b")?.children.get("f");
      expect(f?.children.get("g")?.action?.id, mode).toBe("grep.open");
    }
  });

  test("private_workspace: prefix+shift+p and ctrl+shift+p, in every mode (private-workspace)", () => {
    const km = compileKeymap();
    expect(getAction("private_workspace")).toMatchObject({
      id: "workspace.private",
      group: "Workspaces",
    });
    expect(km.bindingsFor("private_workspace")).toEqual(["prefix+shift+p", "ctrl+shift+p"]);
    for (const mode of /** @type {const} */ (["normal", "insert", "visual", "panel", "help"])) {
      const node = km.trie(mode).children.get("ctrl+shift+p");
      expect(node?.action?.id, mode).toBe("workspace.private");
    }
  });
});

// The "did you mean" suggestion for config keys and values (config.mjs, routes.mjs, cmdline.mjs).
describe("closest", () => {
  /** Plain Levenshtein distance, the reference closest() must agree with. @param {string} a @param {string} b */
  function distance(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(
          /** @type {number} */ (prev[j]) + 1,
          /** @type {number} */ (cur[j - 1]) + 1,
          /** @type {number} */ (prev[j - 1]) + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
      prev = cur;
    }
    return /** @type {number} */ (prev[b.length]);
  }
  /** @param {string} text @param {string[]} pool */
  function reference(text, pool) {
    let best;
    let bestD = Infinity;
    for (const cand of pool) {
      const d = distance(text, cand);
      if (d < bestD) [best, bestD] = [cand, d];
    }
    return bestD <= Math.max(2, Math.floor(text.length / 3)) ? best : undefined;
  }

  test("suggests the nearest candidate, first one on a tie, only when near enough", () => {
    expect(closest("colr", ["color", "icon", "home"])).toBe("color");
    expect(closest("ab", ["ax", "ay"])).toBe("ax");
    expect(closest("zzzzzz", ["color", "icon"])).toBeUndefined();
    expect(closest("x", [])).toBeUndefined();
  });

  test("agrees with a plain edit-distance search, for any text and pool", () => {
    const word = fc.string({ unit: fc.constantFrom("a", "b", "c", "-", "é"), maxLength: 12 });
    fc.assert(
      fc.property(word, fc.array(word, { maxLength: 8 }), (text, pool) => {
        expect(closest(text, pool)).toBe(reference(text, pool));
      }),
      { seed: 20261014, numRuns: 2000 },
    );
  });

  // Regression (#196): a 1 MiB unknown config key ran a full edit-distance table against every
  // known key (seconds under coverage) for a suggestion that can never be close enough.
  test("costs nothing for a text far longer than every candidate", () => {
    const pool = ACTIONS.map((a) => a.name);
    const huge = "k".repeat(4 * 1024 * 1024);
    const start = performance.now();
    expect(closest(huge, pool)).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(50);
  });
});

// docs/specs/toolbar-toggle.md, decision 1.
describe("toolbar toggle", () => {
  test("ctrl+b u runs toggle_toolbar (toolbar.toggle) through the dispatcher", async () => {
    const { createDispatcher } = await import("../src/dispatcher.mjs");
    const { parseKey } = await import("../src/keys.mjs");
    expect(getAction("toggle_toolbar")).toMatchObject({
      id: "toolbar.toggle",
      group: "Navigation",
    });
    const d = createDispatcher(compileKeymap());
    for (const mode of ["normal", "insert"]) {
      expect(d.dispatch(mode, parseKey("ctrl+b"))).toEqual({ kind: "pending" });
      expect(d.dispatch(mode, parseKey("u"))).toEqual({
        kind: "action",
        action: { id: "toolbar.toggle" },
      });
    }
  });

  test("show_toolbar and hide_toolbar exist, unbound by default", () => {
    expect(getAction("show_toolbar")?.id).toBe("toolbar.show");
    expect(getAction("hide_toolbar")?.id).toBe("toolbar.hide");
    const km = compileKeymap();
    expect(km.bindingsFor("show_toolbar")).toEqual([]);
    expect(km.bindingsFor("hide_toolbar")).toEqual([]);
  });

  test("focus_element (hint.element) is a Hints action on F, in normal and element mode", () => {
    const a = getAction("focus_element");
    expect(a).toMatchObject({
      id: "hint.element",
      group: "Hints",
      description: "Focus a text block: v selects it, y copies it",
    });
    expect(resolveActionName("hint.element")?.name).toBe("focus_element");
    // In ELEMENT mode, F picks another block.
    expect(compileKeymap().bindingsFor("focus_element")).toEqual(["F", "F [element]"]);
  });

  test("follow_link_new_tab (hint.follow_new_tab) moved from F to gF", () => {
    expect(compileKeymap().bindingsFor("follow_link_new_tab")).toEqual(["gF"]);
  });

  // docs/specs/follow-link-switch.md decision 2.
  test("follow_link_new_tab_fg is hint.follow_new_tab_fg, in Hints, unbound", () => {
    expect(getAction("follow_link_new_tab_fg")).toMatchObject({
      id: "hint.follow_new_tab_fg",
      group: "Hints",
      description: "Follow link in new tab and switch to it",
    });
    expect(resolveActionName("hint.follow_new_tab_fg")?.name).toBe("follow_link_new_tab_fg");
    expect(compileKeymap().bindingsFor("follow_link_new_tab_fg")).toEqual([]);
  });

  test("the ELEMENT mode's actions are grouped, and bound only in [modal.element]", () => {
    const km = compileKeymap();
    for (const [name, id, key] of [
      ["element_visual", "element.visual", "v"],
      ["element_visual_line", "element.visual_line", "V"],
      ["element_yank", "element.yank", "y"],
      ["element_parent", "element.parent", "+"],
      ["element_child", "element.child", "-"],
      ["element_next", "element.next", "j"],
      ["element_prev", "element.prev", "k"],
    ]) {
      expect(getAction(name)).toMatchObject({ id, group: "Element focus" });
      expect(km.bindingsFor(name)).toEqual([`${key} [element]`]);
    }
  });

  test("prefix+u is the only default binding of toggle_toolbar, and no other action has it", () => {
    // compileKeymap throws on a conflict between default bindings.
    const km = compileKeymap();
    expect(km.bindingsFor("toggle_toolbar")).toEqual(["prefix+u"]);
    const others = ACTIONS.filter((a) => a.name !== "toggle_toolbar").flatMap((a) =>
      km.bindingsFor(a.name),
    );
    expect(others).not.toContain("prefix+u");
    const bound = ACTIONS.filter((a) => a.id.startsWith("toolbar."));
    expect(bound.map((a) => a.name).sort()).toEqual([
      "hide_toolbar",
      "show_toolbar",
      "toggle_toolbar",
    ]);
  });
});

describe("the built-in agent's window (docs/specs/builtin-agent.md B13)", () => {
  test("agent_chat (agent.command) is an Agents action on ctrl+b i, and :agent runs it", () => {
    expect(getAction("agent_chat")).toMatchObject({ id: "agent.command", group: "Agents" });
    expect(resolveActionName("agent.command")?.name).toBe("agent_chat");
    expect(compileKeymap().bindingsFor("agent_chat")).toEqual(["prefix+i"]);
  });
});
