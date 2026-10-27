import { describe, test, expect } from "vitest";
import { compileKeymap } from "../src/keymap.mjs";
import {
  bindingTable,
  bindingsJson,
  filterBindings,
  keyLegend,
  renderHelpText,
} from "../src/help.mjs";
import { MODES } from "../src/modes.mjs";
import { ACTIONS } from "../src/actions.mjs";
import { DEFAULT_CONFIG } from "../src/defaults.mjs";

/** [keys] lists that drop every default leader binding, so no binding uses the leader. */
const NO_LEADER_KEYS = Object.fromEntries(
  Object.entries(DEFAULT_CONFIG.keys)
    .filter(([, v]) => [v].flat().some((b) => /<leader>/i.test(b)))
    .map(([k, v]) => [k, [v].flat().filter((b) => !/<leader>/i.test(b))]),
);

describe("help table", () => {
  test("has one row per action in ACTIONS order", () => {
    const rows = bindingTable(compileKeymap());
    expect(rows.map((r) => r.name)).toEqual(ACTIONS.map((a) => a.name));
  });

  test("shows the keys a user presses, not config notation", () => {
    // An explicit sidebar list, so the leader binding does not hang on the defaults.
    const km = compileKeymap({ keys: { toggle_sidebar: ["prefix+b", "<leader>n"] } });
    const rows = bindingTable(km);
    const keys = (name) => rows.find((r) => r.name === name)?.bindings;
    expect(keys("show_keybinds")).toContain("ctrl+b ?");
    expect(keys("toggle_sidebar")).toEqual(["ctrl+b b", "space n"]);
    expect(keys("close_tab")).toEqual(["ctrl+b shift+x", "ctrl+f4", "x"]);
    expect(keys("focus_pane_left")).toEqual(["ctrl+b h", "ctrl+w h"]);
    for (const r of rows) {
      for (const b of r.bindings) expect(b, r.name).not.toMatch(/prefix|<leader>|<[a-z]/i);
    }
  });

  test("mode-scoped bindings keep their mode", () => {
    const rows = bindingTable(compileKeymap());
    const all = rows.flatMap((r) => r.bindings);
    expect(all).toContain("esc [panel]");
    expect(all).toContain("enter [resize]");
    expect(all).toContain("< [resize]");
  });

  test("follows a remapped prefix and leader", () => {
    const km = compileKeymap({
      keys: { prefix: "ctrl+a", toggle_sidebar: ["prefix+b", "<leader>n"] },
      modal: { leader: "," },
    });
    const row = bindingTable(km).find((r) => r.name === "toggle_sidebar");
    expect(row?.bindings).toEqual(["ctrl+a b", ", n"]);
  });

  test("the legend always names the prefix", () => {
    expect(keyLegend(compileKeymap())).toMatch(/^prefix = ctrl\+b\b/);
    expect(keyLegend(compileKeymap({ keys: { prefix: "ctrl+a" } }))).toMatch(/^prefix = ctrl\+a\b/);
  });

  test("the legend leaves the leader out when nothing is bound to it", () => {
    const km = compileKeymap({ keys: NO_LEADER_KEYS });
    expect(ACTIONS.flatMap((a) => km.bindingsFor(a.name)).join(" ")).not.toMatch(/<leader>/i);
    expect(keyLegend(km)).toBe("prefix = ctrl+b");
  });

  test("the legend leaves the leader out when its only binding is unbound", () => {
    const km = compileKeymap({
      modal: { normal: { "<leader>ff": "goto.picker" } },
      keys: NO_LEADER_KEYS,
      unbind: { normal: ["<leader>ff"] },
    });
    expect(keyLegend(km)).toBe("prefix = ctrl+b");
  });

  test("the legend names the leader once a user binds a key to it", () => {
    const km = compileKeymap({
      keys: { ...NO_LEADER_KEYS, prefix: "ctrl+a" },
      modal: { leader: ",", normal: { "<leader>ff": "goto.picker" } },
    });
    expect(keyLegend(km)).toBe("prefix = ctrl+a · leader = ,");
    expect(bindingTable(km).find((r) => r.name === "goto_picker")?.bindings).toContain(", ff");
  });

  test("marks user overrides", () => {
    const rows = bindingTable(compileKeymap({ keys: { new_tab: ["ctrl+alt+c"] } }));
    expect(rows.find((r) => r.name === "new_tab")).toMatchObject({
      overridden: true,
      bindings: ["ctrl+alt+c", "t"],
    });
  });

  test("filter matches name, description and binding, case-insensitively", () => {
    const rows = bindingTable(compileKeymap());
    expect(filterBindings(rows, "RENAME").map((r) => r.name)).toEqual(
      expect.arrayContaining(["rename_tab", "rename_workspace"]),
    );
    expect(filterBindings(rows, "ctrl+b ?").map((r) => r.name)).toContain("show_keybinds");
    expect(filterBindings(rows, "ctrl+b b").map((r) => r.name)).toContain("toggle_sidebar");
    expect(filterBindings(rows, "sidebar").map((r) => r.name)).toContain("toggle_sidebar");
    expect(filterBindings(rows, "")).toHaveLength(rows.length);
    expect(filterBindings(rows, "zzzz")).toEqual([]);
  });

  test("help text for defaults matches the snapshot", () => {
    expect(renderHelpText(bindingTable(compileKeymap()))).toMatchSnapshot();
  });

  test("help text marks overrides with an asterisk", () => {
    const txt = renderHelpText(bindingTable(compileKeymap({ keys: { new_tab: ["ctrl+alt+c"] } })));
    expect(txt).toMatch(/\* new_tab/);
  });
});

describe("bindingsJson (docs/bindings.json, mirrored by vimma.dev)", () => {
  test("groups and actions keep ACTIONS order, one entry per action", () => {
    const data = bindingsJson(compileKeymap());
    expect(data.version).toBe(1);
    expect(data.groups.flatMap((g) => g.actions.map((a) => a.name))).toEqual(
      ACTIONS.map((a) => a.name),
    );
    expect(data.groups.map((g) => g.name)).toEqual([...new Set(ACTIONS.map((a) => a.group))]);
    const help = ACTIONS.find((a) => a.name === "help_close");
    const row = data.groups.flatMap((g) => g.actions).find((a) => a.name === "help_close");
    expect(row?.description).toBe(help?.description);
  });

  test("keys are the overlay's, with the mode split off and chords split on spaces", () => {
    const km = compileKeymap();
    const data = bindingsJson(km);
    const table = bindingTable(km);
    for (const a of data.groups.flatMap((g) => g.actions)) {
      const shown = a.keys.map((k) => (k.mode ? `${k.keys} [${k.mode}]` : k.keys));
      expect(shown, a.name).toEqual(table.find((r) => r.name === a.name)?.bindings);
      for (const k of a.keys) {
        expect(k.chords).toEqual(k.keys.split(" "));
        if (k.mode) expect(MODES).toContain(k.mode);
      }
    }
    const keysOf = (name) =>
      data.groups.flatMap((g) => g.actions).find((a) => a.name === name)?.keys;
    expect(keysOf("help_close")).toContainEqual({ keys: "esc", chords: ["esc"], mode: "help" });
    expect(keysOf("rename_tab")).toEqual([
      { keys: "ctrl+b shift+t", chords: ["ctrl+b", "shift+t"] },
    ]);
  });

  test("names the prefix, the legend and the modes", () => {
    const data = bindingsJson(compileKeymap({ keys: { prefix: "ctrl+a" } }));
    expect(data.prefix).toBe("ctrl+a");
    expect(data.legend).toMatch(/^prefix = ctrl\+a\b/);
    expect(data.modes).toEqual([...MODES]);
    const all = data.groups.flatMap((g) => g.actions).flatMap((a) => a.keys);
    expect(all.map((k) => k.keys)).toContain("ctrl+a ?");
  });
});

// docs/specs/firefox-keys.md decisions 3 and 7.
describe("Firefox's keys in the overlay", () => {
  const rows = bindingTable(compileKeymap());
  const row = (name) => rows.find((r) => r.name === name);

  test("Browser comes after Page, Developer tools after it", () => {
    const groups = [...new Set(rows.map((r) => r.group))];
    expect(groups.indexOf("Browser")).toBe(groups.indexOf("Page") + 1);
    expect(groups.indexOf("Developer tools")).toBe(groups.indexOf("Browser") + 1);
  });

  test("restore_tab is a Tabs action now, on ctrl+shift+t in every mode", () => {
    expect(row("restore_tab")).toMatchObject({ group: "Tabs", bindings: ["ctrl+shift+t"] });
  });

  test("Go back lists H, ctrl+o, alt+left and ctrl+[", () => {
    expect(row("history_back")?.bindings).toEqual(["alt+left", "H", "ctrl+o", "ctrl+["]);
    expect(row("history_forward")?.bindings).toEqual(["alt+right", "L", "ctrl+i", "ctrl+]"]);
  });

  test("the tab keys list Firefox's", () => {
    expect(row("new_tab")?.bindings).toEqual(["ctrl+b c", "ctrl+t", "t"]);
    expect(row("next_tab")?.bindings).toEqual(["ctrl+b n", "ctrl+tab", "ctrl+pagedown", "gt"]);
    expect(row("select_tab_1")?.bindings).toEqual(["ctrl+b 1", "alt+1"]);
    expect(row("select_tab_9")?.bindings).toEqual(["ctrl+b 9"]);
    expect(row("select_last_tab")).toMatchObject({ group: "Tabs", bindings: ["alt+9"] });
  });

  test("the developer tools keys are Firefox's own", () => {
    expect(row("devtools")).toMatchObject({
      group: "Developer tools",
      bindings: ["ctrl+shift+i", "f12"],
    });
    expect(row("devtools_style_editor")?.bindings).toEqual(["shift+f7"]);
  });

  test("the goto picker is tab search, on ctrl+b g, ctrl+shift+a and b (docs/specs/tab-search.md)", () => {
    expect(row("goto_picker")).toMatchObject({
      group: "Navigation",
      bindings: ["ctrl+b g", "ctrl+shift+a", "b"],
      description: "Tab search: every tab, every window, recently closed",
    });
    expect(row("tab_search")).toBeUndefined();
  });

  test("stop_loading is normal-mode esc", () => {
    expect(row("stop_loading")).toMatchObject({ group: "Browser", bindings: ["esc"] });
  });
});

describe("the Commands and Firefox (on in config.toml) groups", () => {
  test("a : binding is a row of Commands, its line the description", () => {
    const km = compileKeymap({ modal: { normal: { "<C-S-y>": ":firefox Tools:Downloads" } } });
    const rows = bindingTable(km).filter((r) => r.group === "Commands");
    expect(rows).toEqual([
      expect.objectContaining({
        description: ":firefox Tools:Downloads",
        bindings: ["ctrl+shift+y"],
        runnable: true,
      }),
    ]);
  });

  test("Firefox keys that are on come from the host, after every action", () => {
    const rows = bindingTable(compileKeymap(), {
      firefox: [{ chord: "ctrl+j", id: "key_search2", label: "Search" }],
    });
    expect(rows.at(-1)).toMatchObject({
      group: "Firefox (on in config.toml)",
      name: "key_search2",
      description: "Search",
      bindings: ["ctrl+j"],
    });
  });

  test("both groups are empty, so not shown, with the defaults", () => {
    const groups = new Set(bindingTable(compileKeymap()).map((r) => r.group));
    expect(groups.has("Commands")).toBe(false);
    expect(groups.has("Firefox (on in config.toml)")).toBe(false);
  });
});
