import { describe, test, expect } from "vitest";
import {
  formatConfigError,
  mergeWithDefaults,
  parseConfig,
  reloadConfig,
} from "../src/config/config.mjs";
import { compileKeymap } from "../src/keys/keymap.mjs";
import { formatDefaultsToml } from "../src/config/defaults.mjs";
import { MODES } from "../src/keys/modes.mjs";

import type { ConfigError } from "../src/config/config.mjs";

const toml = (...lines: string[]) => lines.join("\n") + "\n";

function errorsOf(text: string) {
  const r = parseConfig(text);
  expect(r.config).toBeNull();
  expect(r.keymap).toBeNull();
  return r.errors;
}

function oneError(text: string) {
  const errors = errorsOf(text);
  expect(errors).toHaveLength(1);
  return errors[0] as ConfigError;
}

describe("parseConfig: valid input", () => {
  test("the generated defaults.toml parses without errors to the default keymap", () => {
    const r = parseConfig(formatDefaultsToml());
    expect(r.errors).toEqual([]);
    const km = compileKeymap();
    for (const mode of MODES) {
      expect(r.keymap?.sequences(mode)).toEqual(km.sequences(mode));
    }
  });

  test("an empty file is the defaults", () => {
    const r = parseConfig("");
    expect(r.errors).toEqual([]);
    expect(r.config).toEqual(mergeWithDefaults({}));
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
        'split_9 = "#F80"',
      ),
    );
    expect(r.errors).toEqual([]);
    expect(r.config?.theme).toEqual({
      source: "file",
      name: "vimma",
      font: "CaskaydiaMono Nerd Font",
      colors: { accent: "#aabbcc", mode: "light", split_9: "#ff8800" },
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

  // docs/specs/firefox-surfaces-trim.md decision 12: a config written before the action went
  // says why it no longer loads, instead of suggesting a look-alike action.
  test.each([
    [
      toml("schema = 1", "[keys]", 'ai_chatbot_sidebar = ["ctrl+alt+x"]'),
      "keys.ai_chatbot_sidebar",
    ],
    [toml("schema = 1", "[modal.normal]", '"gx" = "browser.sidebar_chatbot"'), "modal.normal.gx"],
  ])("a removed action is an error that says it was removed (%#)", (text, path) => {
    const e = oneError(text);
    expect(e).toMatchObject({ line: 3, path });
    expect(e.suggestion).toBeUndefined();
    expect(e.message).toMatch(/was removed: Firefox's AI chatbot is off in Vimma/);
  });

  // Regression (found by the fuzzer, seed 1027517388, issue #134): an action name with a `[`
  // made parseConfig throw "RangeError: Invalid array length" instead of reporting it.
  // Since #1474's follow-up, an unknown action with no close match is a skipped binding.
  test("an unknown action whose name is not a bare key is a warning, not a throw", () => {
    const r = parseConfig(toml("schema = 1", "[keys]", '"c[mmand" = "/"'));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([
      { line: 3, path: 'keys."c[mmand"', message: 'unknown action "c[mmand"; skipped' },
    ]);
  });

  // The same crash from the issue's own seed (2487349044): the name reached through dotted keys.
  test("an unknown action named through dotted keys with a `[` is a warning, not a throw", () => {
    const r = parseConfig(toml("schema = 1", `'keys'.'mod['."github.com" = "github.com"`));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([
      { line: 2, path: 'keys."mod["', message: 'unknown action "mod["; skipped' },
    ]);
  });

  test("a TOML syntax error has line and column, and no config", () => {
    const e = oneError(toml("schema = 1", "", "[keys]", "new_tab = prefix+c"));
    expect(e.line).toBe(4);
    expect(e.column).toBeGreaterThan(0);
    expect(e.path).toBe("");
    expect(formatConfigError(e, "config.toml")).toMatch(/^config\.toml:4:\d+: \S/);
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
    // prev_workspace is an alias (spec m0-core-dispatcher); compileKeymap's canonical name is
    // previous_workspace
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
    // docs/specs/multiple-splits.md decision 11.
    ['split_3 = "orange"', "theme.colors.split_3", /hex colour/, undefined],
    ['split_10 = "#ffffff"', "theme.colors.split_10", /unknown colour/, "split_1"],
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
      keys: {},
      modal: {},
      unbind: {},
      workspaces: [],
      theme: { source: "omarchy", name: "vimma", font: "monospace", colors: {} },
      panes: { max: 8, layout: "dwindle", mainSize: 0.6, maxSplits: 9, newTab: "alone" },
      hintChars: "asdfghjkl",
      sites: [],
      routes: [],
      routing: { defaultWorkspace: null },
      firefox: {
        disable: "all",
        enable: [],
      },
      insertEditing: true,
      bookmarks: { root: "workspace", bookmarklets: "none", writeBack: "all" },
      panel: { numbers: "absolute" },
      scroll: { step: 60 },
      private: { placement: "swap" },
      mcp: {
        workspace: "agent",
        askTimeout: 50,
        grantMinutes: 0,
        grantMaxMinutes: 480,
        maxReadChars: 200000,
        notify: true,
        downloadDir: "~/Downloads/vimma-agent",
        downloadMaxMb: 200,
        clamavMaxAgeDays: 7,
        openPerMinute: 15,
        loadPerMinute: 60,
      },
      ui: {
        toolbar: "hidden",
        toolbarSet: false,
        bookmarksToolbar: null,
        pdfOutline: "shown",
        tabline: "auto",
        tablineWidth: 14,
      },
      statusbar: { tab: true },
      tabs: { sleepAfter: 120, sleepOnLowMemory: true, closeLast: "picker" },
      passwords: { save: true, fillOnLoad: true },
      updates: { check: true },
      search: null,
      agent: {
        default: null,
        localOnly: false,
        maxRunning: 3,
        maxSteps: 100,
        maxTokens: 2_000_000,
        maxCost: 2,
        keepDays: null,
        keepResults: null,
        providers: [],
      },
    });
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

  test("on macOS the keymap, and the defaults it falls back to, are macOS's (#386)", () => {
    const mac = { mac: true };
    expect(parseConfig(good, mac).keymap?.bindingsFor("history_back")).toContain("meta+left");
    expect(parseConfig(good).keymap?.bindingsFor("history_back")).toContain("alt+left");
    const r = reloadConfig(null, broken, mac);
    expect(r.kept).toBe(true);
    expect(r.active.keymap.bindingsFor("select_last_tab")).toEqual(["meta+9"]);
    const urlbar = reloadConfig(null, good, mac).active.keymap.bindingsFor("focus_urlbar");
    expect(urlbar.slice(0, 2)).toEqual(["ctrl+l", "meta+l"]);
  });

  test("valid text replaces the previous config", () => {
    const first = reloadConfig(null, good).active;
    const r = reloadConfig(first, "");
    expect(r.kept).toBe(false);
    expect(r.active).not.toBe(first);
    expect(r.active.keymap.bindingsFor("new_tab")).toContain("prefix+c");
  });
});

// docs/specs/tab-sleep.md decisions 11 and 12, Behaviour 6.
describe("[tabs] and [sites] sleep", () => {
  test("[tabs] sleep_after accepts 0 and 5 to 10080, and rejects other numbers and types", () => {
    expect(parseConfig(toml()).config?.tabs).toEqual({
      sleepAfter: 120,
      sleepOnLowMemory: true,
      closeLast: "picker",
    });
    for (const v of [0, 5, 120, 10080]) {
      expect(parseConfig(toml("[tabs]", `sleep_after = ${v}`)).config?.tabs).toEqual({
        sleepAfter: v,
        sleepOnLowMemory: true,
        closeLast: "picker",
      });
    }
    for (const v of ["1", "4", "10081", "-5"]) {
      expect(oneError(toml("[tabs]", `sleep_after = ${v}`))).toEqual({
        line: 2,
        path: "tabs.sleep_after",
        message: "must be 0 (never) or an integer between 5 and 10080 (minutes)",
      });
    }
    expect(oneError(toml("[tabs]", "sleep_after = 2.5"))).toMatchObject({
      path: "tabs.sleep_after",
      message: "expected an integer, got a float",
    });
    expect(oneError(toml("[tabs]", 'sleep_after = "120"'))).toMatchObject({
      path: "tabs.sleep_after",
      message: "expected an integer, got a string",
    });
    // Not a near miss of sleep_after: skipped with a warning (#1474).
    expect(parseConfig(toml("[tabs]", "sleep = 120")).warnings).toEqual([
      { line: 2, path: "tabs.sleep", message: 'unknown key "sleep"; skipped' },
    ]);
  });

  // Decision 21, Behaviour 17.
  test("[tabs] sleep_on_low_memory accepts a boolean and rejects other types", () => {
    expect(parseConfig(toml()).config?.tabs.sleepOnLowMemory).toBe(true);
    for (const v of [true, false]) {
      expect(parseConfig(toml("[tabs]", `sleep_on_low_memory = ${v}`)).config?.tabs).toEqual({
        sleepAfter: 120,
        sleepOnLowMemory: v,
        closeLast: "picker",
      });
    }
    expect(
      parseConfig(toml("[tabs]", "sleep_after = 0", "sleep_on_low_memory = true")).config?.tabs,
    ).toEqual({ sleepAfter: 0, sleepOnLowMemory: true, closeLast: "picker" });
    expect(oneError(toml("[tabs]", 'sleep_on_low_memory = "no"'))).toEqual({
      line: 2,
      path: "tabs.sleep_on_low_memory",
      message: "expected a boolean, got a string",
    });
  });

  test('[sites."<host>"] sleep accepts a boolean and rejects other types', () => {
    const c = parseConfig(
      toml('[sites."example.com"]', "sleep = false", '[sites."a.example.com"]', "sleep = true"),
    ).config;
    expect(c?.sites).toEqual([
      { match: "example.com", insert: "auto", sleep: false },
      { match: "a.example.com", insert: "auto", sleep: true },
    ]);
    expect(parseConfig(toml('[sites."b.com"]', 'insert = "never"')).config?.sites).toEqual([
      { match: "b.com", insert: "never", sleep: true },
    ]);
    expect(oneError(toml('[sites."example.com"]', 'sleep = "no"'))).toEqual({
      line: 2,
      path: 'sites."example.com".sleep',
      message: "expected a boolean, got a string",
    });
  });

  test("defaults.toml sets [tabs] sleep_after = 120", () => {
    // On for everyone (spec, Delivery slice 4): the table is set, not a commented example.
    expect(formatDefaultsToml()).toMatch(
      /^\[tabs\]\nsleep_after = 120 .*\nsleep_on_low_memory = true .*$/m,
    );
    expect(formatDefaultsToml()).toMatch(/^# sleep = false +# .*$/m);
  });
});

// docs/specs/close-last-tab.md, behaviour 1: [tabs] close_last.
describe("[tabs] close_last", () => {
  test('defaults to "picker" when absent', () => {
    expect(parseConfig("").config?.tabs.closeLast).toBe("picker");
    expect(mergeWithDefaults({}).tabs.closeLast).toBe("picker");
    expect(formatDefaultsToml()).toMatch(/^close_last = "picker" +# .*$/m);
  });

  test.each([["picker"], ["new_tab"], ["ask"], ["quit"], ["keep"]])(
    'close_last = "%s" is accepted',
    (value) => {
      const r = parseConfig(toml("[tabs]", `close_last = "${value}"`));
      expect(r.errors).toEqual([]);
      expect(r.config?.tabs.closeLast).toBe(value);
    },
  );

  test("any other value or type is an error, with the nearest value when one is close", () => {
    expect(oneError(toml("[tabs]", 'close_last = "close"'))).toEqual({
      line: 2,
      path: "tabs.close_last",
      message: 'must be "picker", "new_tab", "ask", "quit" or "keep"',
    });
    expect(oneError(toml("[tabs]", 'close_last = "newtab"'))).toEqual({
      line: 2,
      path: "tabs.close_last",
      message: 'must be "picker", "new_tab", "ask", "quit" or "keep"',
      suggestion: "new_tab",
    });
    expect(oneError(toml("[tabs]", "close_last = true"))).toEqual({
      line: 2,
      path: "tabs.close_last",
      message: "expected a string, got a boolean",
    });
  });
});
