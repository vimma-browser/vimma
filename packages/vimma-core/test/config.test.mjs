import { describe, test, expect } from "vitest";
import {
  CONFIG_SCHEMA_VERSION,
  MIGRATIONS,
  formatConfigError,
  mergeWithDefaults,
  migrate,
  parseConfig,
  reloadConfig,
} from "../src/config.mjs";
import { compileKeymap } from "../src/keymap.mjs";
import { formatDefaultsToml } from "../src/defaults.mjs";
import { MODES } from "../src/modes.mjs";

/** @param {string[]} lines */
const toml = (...lines) => lines.join("\n") + "\n";

/** @param {string} text */
function errorsOf(text) {
  const r = parseConfig(text);
  expect(r.config).toBeNull();
  expect(r.keymap).toBeNull();
  return r.errors;
}

/** @param {string} text */
function oneError(text) {
  const errors = errorsOf(text);
  expect(errors).toHaveLength(1);
  return /** @type {import("../src/config.mjs").ConfigError} */ (errors[0]);
}

describe("parseConfig: valid input", () => {
  test("the generated defaults.toml parses without errors to the default keymap", () => {
    const r = parseConfig(formatDefaultsToml());
    expect(r.errors).toEqual([]);
    expect(r.migratedFrom).toBeNull();
    const km = compileKeymap();
    for (const mode of MODES) {
      expect(r.keymap?.sequences(mode)).toEqual(km.sequences(mode));
    }
  });

  test("an empty file is the defaults, migrated from schema 0", () => {
    const r = parseConfig("");
    expect(r.errors).toEqual([]);
    expect(r.migratedFrom).toBe(0);
    expect(r.config).toEqual(mergeWithDefaults({}));
    expect(r.config?.schema).toBe(CONFIG_SCHEMA_VERSION);
  });

  test("[keys] overrides reach the keymap and are marked overridden", () => {
    const r = parseConfig(toml("schema = 1", "[keys]", 'new_tab = ["ctrl+alt+c"]'));
    expect(r.errors).toEqual([]);
    expect(r.keymap?.bindingsFor("new_tab")).toContain("ctrl+alt+c");
    expect(r.keymap?.isOverridden("new_tab")).toBe(true);
    expect(r.config?.keys).toEqual({ new_tab: ["ctrl+alt+c"] });
  });

  test("[modal] leader and timeout_ms and a mode table are accepted", () => {
    const r = parseConfig(
      toml("[modal]", 'leader = ","', "timeout_ms = 0", "[modal.normal]", '"J" = "tab.next"'),
    );
    expect(r.errors).toEqual([]);
    expect(r.keymap?.leader.key).toBe(",");
    expect(r.keymap?.timeoutMs).toBe(0);
  });

  test("workspaces keep file order, take defaults, and normalise colour aliases", () => {
    const r = parseConfig(
      toml(
        "[workspaces]",
        'work = { color = "blue", icon = "briefcase", home = "https://intranet.example" }',
        'admin = { autofill = false, color = "turquoise" }',
        "personal = {}",
        '"side project" = { color = "toolbar", home = "about:blank" }',
      ),
    );
    expect(r.errors).toEqual([]);
    expect(r.config?.workspaces).toEqual([
      {
        name: "work",
        color: "blue",
        icon: "briefcase",
        home: "https://intranet.example",
        autofill: true,
      },
      { name: "admin", color: "cyan", icon: "circle", autofill: false },
      { name: "personal", color: "gray", icon: "circle", autofill: true },
      { name: "side project", color: "gray", icon: "circle", home: "about:blank", autofill: true },
    ]);
  });

  test("workspaces keep file order even with number-like names", () => {
    const r = parseConfig(
      toml("[workspaces]", "work = {}", "2 = {}", '"1" = {}', "[workspaces.10]", "[workspaces.b]"),
    );
    expect(r.errors).toEqual([]);
    expect(r.config?.workspaces.map((w) => w.name)).toEqual(["work", "2", "1", "10", "b"]);
  });

  test("[theme] values and [theme.colors] are normalised", () => {
    const r = parseConfig(
      toml(
        "[theme]",
        'source = "file"',
        'font = "CaskaydiaMono Nerd Font"',
        "[theme.colors]",
        'accent = "#ABC"',
        'mode = "light"',
      ),
    );
    expect(r.errors).toEqual([]);
    expect(r.config?.theme).toEqual({
      source: "file",
      name: "vimma",
      font: "CaskaydiaMono Nerd Font",
      colors: { accent: "#aabbcc", mode: "light" },
    });
  });

  test("the plan's example config block is valid", () => {
    const r = parseConfig(
      toml(
        "[keys]",
        'prefix = "ctrl+b"',
        'new_tab = ["prefix+c", "ctrl+alt+c"]',
        'split_vertical = ["prefix+v"]',
        'show_keybinds = ["prefix+?"]',
        'next_workspace = ["ctrl+i"]',
        'prev_workspace = ["ctrl+u"]',
        'toggle_sidebar = ["prefix+b", "<leader>n"]',
        "[workspaces]",
        'work     = { color = "blue",  home = "https://intranet.example" }',
        'admin    = { color = "red",   autofill = false }',
        'personal = { color = "green" }',
        "[modal]",
        'leader = " "',
        "timeout_ms = 800",
        "[modal.normal]",
        '"j" = "scroll.down"',
        '"d" = "scroll.half_down"',
        '"u" = "scroll.half_up"',
        '"gt" = "tab.next"',
        '"<leader>ff" = "goto.picker"',
        "[theme]",
        'source = "omarchy"',
        'font = "CaskaydiaMono Nerd Font"',
        "[unbind]",
        "normal = []",
      ),
    );
    expect(r.errors).toEqual([]);
  });
});

describe("parseConfig: errors carry line numbers", () => {
  test("an unknown action names the line, the path and a suggestion", () => {
    const e = oneError(toml("schema = 1", "[keys]", 'new_tabb = ["prefix+c"]'));
    expect(e).toMatchObject({ line: 3, path: "keys.new_tabb", suggestion: "new_tab" });
    expect(formatConfigError(e, "config.toml")).toBe(
      'config.toml:3: keys.new_tabb: unknown action "new_tabb" (did you mean "new_tab"?)',
    );
  });

  // Regression (found by the fuzzer, seed 1027517388, issue #134): an action name with a `[`
  // made parseConfig throw "RangeError: Invalid array length" instead of reporting it.
  test("an unknown action whose name is not a bare key is an error, not a throw", () => {
    const e = oneError(toml("schema = 1", "[keys]", '"c[mmand" = "/"'));
    expect(e).toMatchObject({ line: 3, path: 'keys."c[mmand"' });
  });

  // The same crash from the issue's own seed (2487349044): the name reached through dotted keys.
  test("an unknown action named through dotted keys with a `[` is an error, not a throw", () => {
    const r = parseConfig(toml("schema = 1", `'keys'.'mod['."github.com" = "github.com"`));
    expect(r.errors).toEqual([{ line: 2, path: 'keys."mod["', message: 'unknown action "mod["' }]);
  });

  test("a TOML syntax error has line and column, and no config", () => {
    const e = oneError(toml("schema = 1", "", "[keys]", "new_tab = prefix+c"));
    expect(e.line).toBe(4);
    expect(e.column).toBeGreaterThan(0);
    expect(e.path).toBe("");
    expect(formatConfigError(e, "config.toml")).toMatch(/^config\.toml:4:\d+: \S/);
  });

  test("a schema from a newer vimma is an error", () => {
    const e = oneError(toml("# hi", `schema = ${CONFIG_SCHEMA_VERSION + 1}`));
    expect(e).toMatchObject({ line: 2, path: "schema" });
    expect(e.message).toMatch(/newer vimma/);
  });

  test.each([["-1"], ["1.5"], ['"1"']])("schema = %s is an error", (v) => {
    expect(oneError(toml(`schema = ${v}`)).path).toBe("schema");
  });

  test.each([
    ["-5", /0 and 10000/],
    ["20000", /0 and 10000/],
    ["12.5", /integer/],
    ['"800"', /expected an integer, got a string/],
  ])("timeout_ms = %s is an error", (v, msg) => {
    const e = oneError(toml("[modal]", `timeout_ms = ${v}`));
    expect(e).toMatchObject({ line: 2, path: "modal.timeout_ms" });
    expect(e.message).toMatch(msg);
  });

  test("a non-string leader is a type error", () => {
    expect(oneError(toml("[modal]", "leader = 1")).path).toBe("modal.leader");
  });

  test("an unknown key in [modal] says key, not mode, and suggests", () => {
    const e = oneError(toml("[modal]", 'leadr = ","'));
    expect(e).toMatchObject({ line: 2, path: "modal.leadr", suggestion: "leader" });
    expect(e.message).toBe('unknown key "leadr"');
  });

  test.each([
    ["schema = 1.0", "schema", /must be an integer, got a float/],
    ["[modal]\ntimeout_ms = 1e3", "modal.timeout_ms", /expected an integer, got a float/],
    ["[modal]\ntimeout_ms = 800.0", "modal.timeout_ms", /expected an integer, got a float/],
  ])("%j: TOML floats are not integers", (text, path, msg) => {
    const e = oneError(text);
    expect(e.path).toBe(path);
    expect(e.message).toMatch(msg);
  });

  test("an unterminated array hints at the line that opened it", () => {
    const e = oneError(toml("[keys]", 'new_tab = ["prefix+c",', "", "[theme]"));
    expect(e.message).toMatch(/unclosed "\[" opened at line 2\?/);
  });

  test("a bracket inside a string or comment does not count as unclosed", () => {
    const e = oneError(toml('a = "[" # [', "b = '['", "c = ="));
    expect(e.line).toBe(3);
    expect(e.message).not.toMatch(/unclosed/);
  });

  test.each([
    ["work = { home = 3 }", "workspaces.work.home", /expected a string, got an integer/],
    ["work = { icon = true }", "workspaces.work.icon", /expected a string, got a boolean/],
    ["work = { color = 1979-05-27 }", "workspaces.work.color", /got a date/],
  ])("workspace type error %s", (line, path, msg) => {
    const e = oneError(toml("[workspaces]", line));
    expect(e.path).toBe(path);
    expect(e.message).toMatch(msg);
  });

  test("[theme] source of the wrong type is an error", () => {
    expect(oneError(toml("[theme]", "source = 1")).message).toMatch(/expected a string/);
  });

  test("[unbind] with a string instead of a list is an error", () => {
    expect(oneError(toml("[unbind]", 'normal = "x"')).message).toMatch(/list of key strings/);
  });

  test("an unknown mode table suggests the closest mode", () => {
    const e = oneError(toml("[modal.nromal]", '"j" = "scroll.down"'));
    expect(e).toMatchObject({ line: 1, path: "modal.nromal", suggestion: "normal" });
  });

  test("a mode table that is not a table is a type error", () => {
    expect(oneError(toml("[modal]", 'normal = "x"')).path).toBe("modal.normal");
  });

  test("an unknown mode under [unbind] suggests the closest mode", () => {
    const e = oneError(toml("[unbind]", 'insrt = ["j"]'));
    expect(e).toMatchObject({ line: 2, path: "unbind.insrt", suggestion: "insert" });
  });

  test("a bad binding inside a multi-line array points at its own line", () => {
    const e = oneError(toml("[keys]", "new_tab = [", '  "prefix+c",', '  "ctrl+bogus",', "]"));
    expect(e).toMatchObject({ line: 4, path: "keys.new_tab[1]" });
  });

  test("a bad modal action points at its line and suggests", () => {
    const e = oneError(toml("[modal.normal]", '"j" = "scroll.dwn"'));
    expect(e).toMatchObject({ line: 2, path: "modal.normal.j", suggestion: "scroll.down" });
  });

  test("a conflict with a default binding points at the user's line", () => {
    const e = oneError(toml("schema = 1", "", "[keys]", 'new_tab = ["prefix+n"]'));
    expect(e).toMatchObject({ line: 4, path: "keys.new_tab" });
    expect(e.message).toMatch(/already bound/);
  });

  test("an error on an alias names the alias the user wrote, at its line", () => {
    // plan §2 writes prev_workspace; compileKeymap reports the canonical previous_workspace
    const e = oneError(toml("schema = 1", "", "[keys]", 'prev_workspace = ["prefix+n"]'));
    expect(e).toMatchObject({ line: 4, path: "keys.prev_workspace" });
    expect(e.message).not.toMatch(/previous_workspace/);
  });

  test("a conflict naming the user's alias as the other binding uses the alias", () => {
    const e = oneError(
      toml("[keys]", 'prev_workspace = ["ctrl+alt+p"]', 'new_tab = ["ctrl+alt+p"]'),
    );
    expect(e.message).toMatch(/already bound to prev_workspace/);
  });

  test("an unknown top-level table suggests the closest one", () => {
    const e = oneError(toml("[thmee]", 'source = "file"'));
    expect(e).toMatchObject({ line: 1, path: "thmee", suggestion: "theme" });
  });

  test("a top-level section with the wrong type is an error", () => {
    expect(oneError(toml('keys = "ctrl+b"')).message).toMatch(/expected a table, got a string/);
    expect(oneError(toml("workspaces = []")).message).toMatch(/got an array/);
  });

  test.each([
    ['work = { color = "blu" }', "workspaces.work.color", "blue"],
    ['work = { icon = "brifcase" }', "workspaces.work.icon", "briefcase"],
    ['work = { colour = "blue" }', "workspaces.work.colour", "color"],
  ])("workspace %s is an error with a suggestion", (line, path, suggestion) => {
    const e = oneError(toml("[workspaces]", line));
    expect(e).toMatchObject({ line: 2, path, suggestion });
  });

  test.each([
    ['work = { home = "javascript:alert(1)" }', "workspaces.work.home"],
    ['work = { home = "https://a b" }', "workspaces.work.home"],
    ['work = { autofill = "no" }', "workspaces.work.autofill"],
    ["work = { color = 3 }", "workspaces.work.color"],
    ['"" = {}', 'workspaces.""'],
    [`${"w".repeat(33)} = {}`, `workspaces.${"w".repeat(33)}`],
    ['"tab\\there" = {}', 'workspaces."tab\\there"'],
    ['work = "blue"', "workspaces.work"],
  ])("workspace %s is an error", (line, path) => {
    expect(oneError(toml("[workspaces]", line)).path).toBe(path);
  });

  test.each([
    ['source = "omarchy-ish"', "theme.source", /"omarchy" or "file"/],
    ['font = "x; color: red"', "theme.font", /must not contain/],
    ['font = ""', "theme.font", /1 to 200/],
    ["font = 12", "theme.font", /expected a string/],
    ['sorce = "file"', "theme.sorce", /unknown key/],
    ['colors = "red"', "theme.colors", /expected a table/],
  ])("[theme] %s is an error", (line, path, msg) => {
    const e = oneError(toml("[theme]", line));
    expect(e).toMatchObject({ line: 2, path });
    expect(e.message).toMatch(msg);
  });

  test.each([
    ['acent = "#ffffff"', "theme.colors.acent", /unknown colour/, "accent"],
    ['accent = "blue"', "theme.colors.accent", /hex colour/, undefined],
    ['mode = "dim"', "theme.colors.mode", /"dark" or "light"/, undefined],
  ])("[theme.colors] %s is an error", (line, path, msg, suggestion) => {
    const e = oneError(toml("[theme.colors]", line));
    expect(e).toMatchObject({ line: 2, path });
    expect(e.suggestion).toBe(suggestion);
    expect(e.message).toMatch(msg);
  });

  test("all schema errors are reported at once, in file order", () => {
    const errors = errorsOf(
      toml("[modal]", "timeout_ms = -1", "[workspaces]", 'w = { color = "x" }', "[thme]"),
    );
    expect(errors.map((e) => e.line)).toEqual([2, 4, 5]);
  });

  test("keymap errors are not reported while the keymap tables have schema errors", () => {
    const errors = errorsOf(toml("[keys]", 'new_tabb = ["x"]', "[modal]", "timeout_ms = -1"));
    expect(errors.map((e) => e.path)).toEqual(["modal.timeout_ms"]);
  });

  test("formatConfigError without a line names only the file", () => {
    expect(formatConfigError({ path: "", message: "boom" }, "c.toml")).toBe("c.toml: boom");
    expect(formatConfigError({ path: "a.b", message: "boom", line: 2, column: 3 }, "c.toml")).toBe(
      "c.toml:2:3: a.b: boom",
    );
  });
});

describe("mergeWithDefaults", () => {
  test("fills every section", () => {
    expect(mergeWithDefaults({})).toEqual({
      schema: 2,
      keys: {},
      modal: {},
      unbind: {},
      workspaces: [],
      theme: { source: "omarchy", name: "vimma", font: "monospace", colors: {} },
      panes: { max: 4, layout: "dwindle", mainSize: 0.6 },
      hintChars: "asdfghjkl",
      sites: [],
      routes: [],
      firefox: {
        disable: [
          "ctrl+b",
          "ctrl+d",
          "ctrl+e",
          "ctrl+h",
          "ctrl+i",
          "ctrl+k",
          "ctrl+o",
          "ctrl+u",
          "ctrl+w",
          "ctrl+y",
        ],
        enable: [],
      },
      insertEditing: true,
      bookmarks: { root: "workspace" },
      private: { placement: "swap" },
      mcp: {
        workspace: "agent",
        askTimeout: 50,
        grantMinutes: 10,
        grantMaxMinutes: 480,
        maxReadChars: 200000,
        notify: true,
        downloadDir: "~/Downloads/vimma-agent",
        downloadMaxMb: 200,
        clamavMaxAgeDays: 7,
      },
      ui: { toolbar: "shown" },
      updates: { check: true },
      search: null,
    });
  });
});

describe("migrate", () => {
  test("v0 → v1 adds schema = 1 and keeps everything else", () => {
    const raw = { keys: { new_tab: ["prefix+c"] } };
    const r = migrate(raw, 0, 1);
    expect(r.applied).toEqual(["0→1"]);
    expect(r.config).toEqual({ schema: 1, keys: { new_tab: ["prefix+c"] } });
    expect(raw).toEqual({ keys: { new_tab: ["prefix+c"] } });
  });

  test("the current version needs no step", () => {
    const current = { schema: CONFIG_SCHEMA_VERSION };
    expect(migrate(current, CONFIG_SCHEMA_VERSION)).toEqual({ config: current, applied: [] });
  });

  test("a chain of steps runs in order", () => {
    /** @type {Record<number, (c: Record<string, unknown>) => Record<string, unknown>>} */
    const registry = {
      0: (c) => ({ ...c, schema: 1, trail: [0] }),
      1: (c) => ({ ...c, schema: 2, trail: [.../** @type {number[]} */ (c.trail), 1] }),
    };
    const r = migrate({}, 0, 2, registry);
    expect(r.applied).toEqual(["0→1", "1→2"]);
    expect(r.config).toEqual({ schema: 2, trail: [0, 1] });
  });

  test("a gap in the registry throws", () => {
    expect(() => migrate({}, 0, 2, { 0: (c) => c })).toThrow(/no migration from schema 1/);
  });

  test("migrating backwards throws", () => {
    expect(() => migrate({}, 2, 1)).toThrow(/newer/);
  });

  test("every version below the current one has a registered step", () => {
    for (let v = 0; v < CONFIG_SCHEMA_VERSION; v++) expect(MIGRATIONS[v]).toBeTypeOf("function");
  });
});

describe("reloadConfig keeps the last good config", () => {
  const good = toml("[keys]", 'new_tab = ["ctrl+alt+c"]');
  const broken = toml("[keys]", "new_tab = ctrl+alt+c");

  test("with no previous config, valid text becomes active", () => {
    const r = reloadConfig(null, good);
    expect(r.kept).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.active.keymap.bindingsFor("new_tab")).toContain("ctrl+alt+c");
  });

  test("with no previous config, broken text activates the defaults", () => {
    const r = reloadConfig(null, broken);
    expect(r.kept).toBe(true);
    expect(r.errors).toHaveLength(1);
    expect(r.active.config).toEqual(mergeWithDefaults({}));
    expect(r.active.keymap.bindingsFor("new_tab")).toContain("prefix+c");
  });

  test("broken text keeps the previous config active, unchanged", () => {
    const first = reloadConfig(null, good).active;
    const r = reloadConfig(first, broken);
    expect(r.kept).toBe(true);
    expect(r.active).toBe(first);
    expect(r.errors[0]?.line).toBe(2);
  });

  test("valid text replaces the previous config", () => {
    const first = reloadConfig(null, good).active;
    const r = reloadConfig(first, "");
    expect(r.kept).toBe(false);
    expect(r.active).not.toBe(first);
    expect(r.active.keymap.bindingsFor("new_tab")).toContain("prefix+c");
  });
});
