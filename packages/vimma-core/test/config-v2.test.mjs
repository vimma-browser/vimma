// Config schema 2 (spec m3-m4-core-prep): [panes] max, [modal] hint_chars, [sites."<host>"].
import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { CONFIG_SCHEMA_VERSION, MIGRATIONS, migrate, parseConfig } from "../src/config.mjs";
import { DEFAULT_CONFIG, formatDefaultsToml } from "../src/defaults.mjs";
import { DEFAULT_HINT_CHARS } from "../src/hints.mjs";
import { PANES_MAX_DEFAULT, PANES_MAX_LIMIT } from "../src/panes.mjs";

/** @param {string[]} lines */
const toml = (...lines) => lines.join("\n") + "\n";
/** @param {string[]} lines */
const v2 = (...lines) => toml("schema = 2", ...lines);

/** @param {string} text */
function ok(text) {
  const r = parseConfig(text);
  expect(r.errors).toEqual([]);
  return /** @type {import("../src/config.mjs").ResolvedConfig} */ (r.config);
}

/** @param {string} text */
function errors(text) {
  const r = parseConfig(text);
  expect(r.config).toBeNull();
  return r.errors.map((e) => ({
    line: e.line,
    path: e.path,
    message: e.message,
    ...(e.suggestion ? { suggestion: e.suggestion } : {}),
  }));
}

describe("schema 2", () => {
  test("is the current schema; 1 → 2 is the identity plus schema = 2", () => {
    expect(CONFIG_SCHEMA_VERSION).toBe(2);
    const raw = { schema: 1, keys: { new_tab: ["prefix+c"] } };
    expect(migrate(raw, 1)).toEqual({
      config: { schema: 2, keys: { new_tab: ["prefix+c"] } },
      applied: ["1→2"],
    });
    expect(raw.schema).toBe(1);
    expect(MIGRATIONS[1]).toBeTypeOf("function");
  });

  test("a v1 file still loads, migrated, with the new sections at their defaults", () => {
    const r = parseConfig(toml("schema = 1", "[modal]", "timeout_ms = 500"));
    expect(r.errors).toEqual([]);
    expect(r.migratedFrom).toBe(1);
    expect(r.config).toMatchObject({
      schema: 2,
      panes: { max: PANES_MAX_DEFAULT },
      hintChars: DEFAULT_HINT_CHARS,
      sites: [],
    });
  });

  test("defaults: panes.max 4, hint_chars the home row, no sites; defaults.toml is schema 2", () => {
    expect(PANES_MAX_DEFAULT).toBe(4);
    expect(DEFAULT_CONFIG.panes).toEqual({ max: 4, layout: "dwindle", main_size: 60 });
    const text = formatDefaultsToml();
    expect(text).toMatch(/^schema = 2$/m);
    expect(text).toMatch(
      /^\[panes\]\nmax = 4\n(#.*\n)*layout = "dwindle"\n(#.*\n)*main_size = 60$/m,
    );
    expect(text).toMatch(/^hint_chars = "asdfghjkl"$/m);
    expect(text).toMatch(/^# \[sites\."docs\.google\.com"\]$/m);
    expect(parseConfig(text).migratedFrom).toBeNull();
  });

  test("a schema 3 file is from a newer vimma", () => {
    expect(errors(toml("schema = 3"))).toEqual([
      { line: 1, path: "schema", message: expect.stringMatching(/newer vimma.*up to 2/) },
    ]);
  });
});

describe("[panes] max", () => {
  test.each([[1], [4], [7], [PANES_MAX_LIMIT]])("max = %i is accepted", (max) => {
    expect(ok(v2("[panes]", `max = ${max}`)).panes).toEqual({
      max,
      layout: "dwindle",
      mainSize: 0.6,
    });
  });

  test.each([
    ["0", "must be an integer between 1 and 16"],
    ["17", "must be an integer between 1 and 16"],
    ["-4", "must be an integer between 1 and 16"],
    ["4.0", "expected an integer, got a float"],
    ['"4"', "expected an integer, got a string"],
  ])("max = %s is an error at its line", (v, message) => {
    expect(errors(v2("", "[panes]", `max = ${v}`))).toEqual([
      { line: 4, path: "panes.max", message },
    ]);
  });

  test("an unknown key suggests max; panes must be a table", () => {
    expect(errors(v2("[panes]", "maks = 4"))).toEqual([
      { line: 3, path: "panes.maks", message: 'unknown key "maks"', suggestion: "max" },
    ]);
    expect(errors(v2("panes = 4"))).toEqual([
      { line: 2, path: "panes", message: "expected a table, got an integer" },
    ]);
  });

  test("property: any integer max is accepted iff it is within 1..16", () => {
    fc.assert(
      fc.property(fc.integer({ min: -100, max: 100 }), (max) => {
        const r = parseConfig(v2("[panes]", `max = ${max}`));
        expect(r.config !== null).toBe(max >= 1 && max <= PANES_MAX_LIMIT);
        if (r.config) expect(r.config.panes.max).toBe(max);
      }),
    );
  });
});

// docs/specs/tiling-layouts.md
describe("[panes] layout and main_size", () => {
  test("defaults: dwindle, 60 %", () => {
    expect(ok(v2("")).panes).toEqual({ max: 4, layout: "dwindle", mainSize: 0.6 });
  });

  test.each([["dwindle"], ["manual"]])('layout = "%s" is accepted', (layout) => {
    expect(ok(v2("[panes]", `layout = "${layout}"`)).panes.layout).toBe(layout);
  });

  test("an unknown layout is an error with the nearest name", () => {
    expect(errors(v2("[panes]", 'layout = "dwindel"'))).toEqual([
      {
        line: 3,
        path: "panes.layout",
        message: 'must be "dwindle" or "manual"',
        suggestion: "dwindle",
      },
    ]);
    expect(errors(v2("[panes]", "layout = 1"))).toEqual([
      { line: 3, path: "panes.layout", message: "expected a string, got an integer" },
    ]);
  });

  test.each([[20], [55], [80]])("main_size = %i is that percent", (pct) => {
    expect(ok(v2("[panes]", `main_size = ${pct}`)).panes.mainSize).toBeCloseTo(pct / 100, 9);
  });

  test.each([
    ["19", "must be an integer between 20 and 80 (percent)"],
    ["81", "must be an integer between 20 and 80 (percent)"],
    ["0.6", "expected an integer, got a float"],
    ['"60%"', "expected an integer, got a string"],
  ])("main_size = %s is an error", (v, message) => {
    expect(errors(v2("[panes]", `main_size = ${v}`))).toEqual([
      { line: 3, path: "panes.main_size", message },
    ]);
  });

  test("an unknown key suggests the nearest of max, layout, main_size", () => {
    expect(errors(v2("[panes]", "mainsize = 60"))).toEqual([
      {
        line: 3,
        path: "panes.mainsize",
        message: 'unknown key "mainsize"',
        suggestion: "main_size",
      },
    ]);
  });
});

describe("[modal] hint_chars", () => {
  test("a valid charset is resolved; the keymap ignores the key", () => {
    const r = parseConfig(
      v2("[modal]", 'hint_chars = "jfkdls"', "[modal.normal]", '"j" = "scroll.down"'),
    );
    expect(r.errors).toEqual([]);
    expect(r.config?.hintChars).toBe("jfkdls");
    expect(r.keymap).not.toBeNull();
  });

  test.each([['"aa"'], ['"a"'], ['"ABC"'], ['"a b"'], ['""']])(
    "hint_chars = %s is an error",
    (v) => {
      expect(errors(v2("[modal]", `hint_chars = ${v}`))).toEqual([
        {
          line: 3,
          path: "modal.hint_chars",
          message: "must be at least 2 distinct characters, none uppercase or whitespace",
        },
      ]);
    },
  );

  test("a non-string hint_chars is a type error", () => {
    expect(errors(v2("[modal]", "hint_chars = 5"))[0]).toMatchObject({
      path: "modal.hint_chars",
      message: "expected a string, got an integer",
    });
  });

  test("an unknown [modal] key now also suggests hint_chars", () => {
    expect(errors(v2("[modal]", 'hint_char = "asdf"'))[0]).toMatchObject({
      path: "modal.hint_char",
      suggestion: "hint_chars",
    });
  });
});

describe('[sites."<host>"]', () => {
  test("rules are resolved in file order, insert defaulting to auto", () => {
    const config = ok(
      v2(
        '[sites."docs.google.com"]',
        'insert = "always"',
        '[sites."Example.COM."]',
        '[sites."10.0.0.1"]',
        'insert = "never"',
        '[sites."[::1]"]',
        'insert = "auto"',
        "[sites.localhost]",
        'insert = "never"',
      ),
    );
    expect(config.sites).toEqual([
      { match: "docs.google.com", insert: "always" },
      { match: "Example.COM.", insert: "auto" },
      { match: "10.0.0.1", insert: "never" },
      { match: "[::1]", insert: "auto" },
      { match: "localhost", insert: "never" },
    ]);
  });

  test.each([
    ["https://docs.google.com/document", "docs.google.com"],
    ["*.example.com", "example.com"],
    ["example.com:8080", "example.com"],
    ["exa mple.com", undefined],
    ["", undefined],
    ["-bad-.com", undefined],
  ])("site %j is not a hostname", (host, suggestion) => {
    expect(errors(v2(`[sites.${JSON.stringify(host)}]`, 'insert = "never"'))).toEqual([
      {
        line: 2,
        path: `sites.${JSON.stringify(host)}`,
        message: 'must be a hostname like "docs.google.com", without scheme, port, path or *',
        ...(suggestion ? { suggestion } : {}),
      },
    ]);
  });

  test("insert must be auto, never or always; unknown keys suggest insert", () => {
    expect(errors(v2('[sites."a.com"]', 'insert = "allways"', "insrt = 1"))).toEqual([
      {
        line: 3,
        path: 'sites."a.com".insert',
        message: 'must be "auto", "never" or "always"',
        suggestion: "always",
      },
      {
        line: 4,
        path: 'sites."a.com".insrt',
        message: 'unknown key "insrt"',
        suggestion: "insert",
      },
    ]);
    expect(errors(v2('[sites."a.com"]', "insert = true"))[0]?.message).toBe(
      "expected a string, got a boolean",
    );
  });

  test("the same host twice (case and a trailing dot ignored) is an error on the second", () => {
    expect(errors(v2('[sites."a.com"]', '[sites."A.com."]'))).toEqual([
      { line: 3, path: 'sites."A.com."', message: 'same host as "a.com"' },
    ]);
  });

  test("a site must be a table", () => {
    expect(errors(v2("[sites]", '"a.com" = "always"'))).toEqual([
      { line: 3, path: 'sites."a.com"', message: "expected a table, got a string" },
    ]);
  });
});

describe("schema 2 keys need schema = 2", () => {
  test.each([
    [["schema = 1", "[panes]", "max = 2"], 2, "panes"],
    [["[panes]", "max = 2"], 1, "panes"],
    [["schema = 1", '[sites."a.com"]'], 2, "sites"],
    [["schema = 1", "[modal]", 'hint_chars = "asdf"'], 3, "modal.hint_chars"],
  ])("%j is an error naming the key", (lines, line, path) => {
    expect(errors(toml(...lines))).toEqual([
      {
        line,
        path,
        message: "is new in schema 2: put schema = 2 at the top of the file",
      },
    ]);
  });
});

// docs/specs/key-handling-batch.md § 1 and § 2.
describe("[firefox] disable and enable", () => {
  // docs/specs/firefox-keys.md decisions 9 and 10: Firefox's own shortcuts are off by default.
  test('the default is disable = "all" and enables none', () => {
    expect(ok(v2()).firefox).toEqual({ disable: "all", enable: [] });
    const text = formatDefaultsToml();
    expect(text).toMatch(/^\[firefox\]\ndisable = "all"\nenable = \[\]$/m);
    expect(ok(text).firefox).toEqual({ disable: "all", enable: [] });
  });

  test('"all" and a list with enable are resolved, chords canonical', () => {
    expect(ok(v2("[firefox]", 'disable = "all"', 'enable = ["ctrl+T", "alt+1"]')).firefox).toEqual({
      disable: "all",
      enable: ["ctrl+shift+t", "alt+1"],
    });
    expect(ok(v2("[firefox]", 'disable = ["control+w", "ctrl+U", "F5"]')).firefox).toEqual({
      disable: ["ctrl+w", "ctrl+shift+u", "f5"],
      enable: [],
    });
    expect(ok(v2("[firefox]", "disable = []")).firefox).toEqual({ disable: [], enable: [] });
  });

  // Decision 9: an inventory chord without ctrl, alt or meta (Firefox's stop) can be enabled.
  test('enable = ["esc", "shift+esc"] is valid', () => {
    expect(ok(v2("[firefox]", 'enable = ["esc", "shift+esc"]')).firefox.enable).toEqual([
      "esc",
      "shift+esc",
    ]);
  });

  test("an enabled chord the user binds is an error at the enable line", () => {
    expect(
      errors(v2("[keys]", 'new_tab = ["ctrl+t"]', "[firefox]", 'enable = ["ctrl+t"]')),
    ).toEqual([
      {
        line: 5,
        path: "firefox.enable[0]",
        message: "ctrl+t is bound to new_tab in [keys]; unbind it or drop it here",
      },
    ]);
  });

  test.each([
    ['disable = "none"', "firefox.disable", 'must be "all" or a list of keys like "ctrl+w"'],
    ["disable = 3", "firefox.disable", 'must be "all" or a list of keys like "ctrl+w"'],
    ['disable = ["ctrl+ww"]', "firefox.disable[0]", 'unknown key "ww" in "ctrl+ww"'],
    [
      'enable = ["w"]',
      "firefox.enable[0]",
      "Firefox's shortcuts have ctrl, alt or meta, are function keys, or are esc or shift+esc",
    ],
    ["enable = [1]", "firefox.enable[0]", "expected a key string, got an integer"],
    ['enable = "all"', "firefox.enable", "expected a list of key strings, got a string"],
  ])("%s is an error", (line, path, message) => {
    expect(errors(v2("[firefox]", line))).toEqual([{ line: 3, path, message }]);
  });

  test("an unknown key in [firefox] suggests one", () => {
    expect(errors(v2("[firefox]", "disabel = []"))).toEqual([
      { line: 3, path: "firefox.disabel", message: 'unknown key "disabel"', suggestion: "disable" },
    ]);
  });

  test("[firefox] is new in schema 2", () => {
    expect(errors(toml("schema = 1", "[firefox]", "disable = []"))).toEqual([
      {
        line: 2,
        path: "firefox",
        message: "is new in schema 2: put schema = 2 at the top of the file",
      },
    ]);
  });
});

describe("[modal] insert_editing", () => {
  test("is on by default and can be turned off; the keymap ignores it", () => {
    expect(ok(v2()).insertEditing).toBe(true);
    expect(formatDefaultsToml()).toMatch(/^insert_editing = true$/m);
    const r = parseConfig(v2("[modal]", "insert_editing = false"));
    expect(r.errors).toEqual([]);
    expect(r.config?.insertEditing).toBe(false);
    expect(r.keymap).not.toBeNull();
  });

  test("must be a boolean, and is new in schema 2", () => {
    expect(errors(v2("[modal]", 'insert_editing = "yes"'))).toEqual([
      { line: 3, path: "modal.insert_editing", message: "expected a boolean, got a string" },
    ]);
    expect(errors(toml("schema = 1", "[modal]", "insert_editing = false"))).toEqual([
      {
        line: 3,
        path: "modal.insert_editing",
        message: "is new in schema 2: put schema = 2 at the top of the file",
      },
    ]);
  });
});

// docs/specs/bookmarks.md, decision 2.
describe("[bookmarks] root", () => {
  test('defaults to "workspace"', () => {
    expect(ok(v2()).bookmarks).toEqual({ root: "workspace" });
    expect(DEFAULT_CONFIG.bookmarks).toEqual({ root: "workspace" });
    expect(formatDefaultsToml()).toMatch(/^\[bookmarks\]\n(#.*\n)*root = "workspace"$/m);
  });

  test.each([["workspace"], ["toolbar"], ["all"]])('root = "%s" is accepted', (root) => {
    expect(ok(v2("[bookmarks]", `root = "${root}"`)).bookmarks.root).toBe(root);
  });

  test("an unknown root is an error, with the nearest name when one is close", () => {
    expect(errors(v2("[bookmarks]", 'root = "menu"'))).toEqual([
      { line: 3, path: "bookmarks.root", message: 'must be "workspace", "toolbar" or "all"' },
    ]);
    expect(errors(v2("[bookmarks]", 'root = "tolbar"'))).toEqual([
      {
        line: 3,
        path: "bookmarks.root",
        message: 'must be "workspace", "toolbar" or "all"',
        suggestion: "toolbar",
      },
    ]);
    expect(errors(v2("[bookmarks]", "root = true"))).toEqual([
      { line: 3, path: "bookmarks.root", message: "expected a string, got a boolean" },
    ]);
  });

  test("an unknown key suggests root; the section is a table, new in schema 2", () => {
    expect(errors(v2("[bookmarks]", 'roots = "all"'))).toEqual([
      { line: 3, path: "bookmarks.roots", message: 'unknown key "roots"', suggestion: "root" },
    ]);
    expect(errors(v2("bookmarks = 1"))).toEqual([
      { line: 2, path: "bookmarks", message: "expected a table, got an integer" },
    ]);
    expect(errors(toml("schema = 1", "[bookmarks]", 'root = "all"'))).toEqual([
      {
        line: 2,
        path: "bookmarks",
        message: "is new in schema 2: put schema = 2 at the top of the file",
      },
    ]);
  });
});

// The built-in palette by name: vimma (vimma.dev's colours) by default, Tokyo Night on request.
describe("[theme] name", () => {
  test('defaults to "vimma"', () => {
    expect(ok(v2()).theme.name).toBe("vimma");
    expect(DEFAULT_CONFIG.theme?.name).toBe("vimma");
    expect(formatDefaultsToml()).toMatch(/^\[theme\]\nsource = "omarchy"\nname = "vimma"$/m);
  });

  test.each([["vimma"], ["tokyo-night"]])('name = "%s" is accepted', (name) => {
    expect(ok(v2("[theme]", `name = "${name}"`)).theme.name).toBe(name);
  });

  test("an unknown name is an error, with the nearest name when one is close", () => {
    expect(errors(v2("[theme]", 'name = "gruvbox"'))).toEqual([
      { line: 3, path: "theme.name", message: 'must be "vimma" or "tokyo-night"' },
    ]);
    expect(errors(v2("[theme]", 'name = "tokyonight"'))).toEqual([
      {
        line: 3,
        path: "theme.name",
        message: 'must be "vimma" or "tokyo-night"',
        suggestion: "tokyo-night",
      },
    ]);
    expect(errors(v2("[theme]", "name = 1"))).toEqual([
      { line: 3, path: "theme.name", message: "expected a string, got an integer" },
    ]);
  });

  test("is new in schema 2; the rest of [theme] is not", () => {
    expect(errors(toml("schema = 1", "[theme]", 'name = "tokyo-night"'))).toEqual([
      {
        line: 3,
        path: "theme.name",
        message: "is new in schema 2: put schema = 2 at the top of the file",
      },
    ]);
    expect(ok(toml("schema = 1", "[theme]", 'source = "file"')).theme.name).toBe("vimma");
  });
});

// docs/specs/theme-appearance.md, B: the built-in palette dark, light or as the system is.
describe("[theme] appearance", () => {
  test("left out, it stays out: :theme's pref decides", () => {
    expect(ok(v2()).theme.appearance).toBeUndefined();
    expect(DEFAULT_CONFIG.theme?.appearance).toBeUndefined();
  });

  test.each([["system"], ["dark"], ["light"]])('appearance = "%s" is accepted', (v) => {
    expect(ok(v2("[theme]", `appearance = "${v}"`)).theme.appearance).toBe(v);
  });

  test("an unknown value suggests the nearest; a non-string is a type error", () => {
    expect(errors(v2("[theme]", 'appearance = "ligt"'))).toEqual([
      {
        line: 3,
        path: "theme.appearance",
        message: 'must be "system", "dark" or "light"',
        suggestion: "light",
      },
    ]);
    expect(errors(v2("[theme]", "appearance = 1"))).toEqual([
      { line: 3, path: "theme.appearance", message: "expected a string, got an integer" },
    ]);
  });

  test("is new in schema 2", () => {
    expect(errors(toml("schema = 1", "[theme]", 'appearance = "dark"'))).toEqual([
      {
        line: 3,
        path: "theme.appearance",
        message: "is new in schema 2: put schema = 2 at the top of the file",
      },
    ]);
  });

  test("defaults.toml documents it as a comment, so the file does not pin it", () => {
    expect(formatDefaultsToml()).toMatch(/^# appearance = "system"$/m);
    expect(formatDefaultsToml()).not.toMatch(/^appearance =/m);
    expect(ok(formatDefaultsToml()).theme.appearance).toBeUndefined();
  });
});

// docs/specs/private-swap.md, decision 1.
describe("[private] placement", () => {
  test('defaults to "swap"', () => {
    expect(ok(v2()).private).toEqual({ placement: "swap" });
    expect(DEFAULT_CONFIG.private).toEqual({ placement: "swap" });
    expect(formatDefaultsToml()).toMatch(/^\[private\]\n(#.*\n)*placement = "swap"$/m);
  });

  test.each([["swap"], ["window"]])('placement = "%s" is accepted', (placement) => {
    expect(ok(v2("[private]", `placement = "${placement}"`)).private.placement).toBe(placement);
  });

  test("an unknown placement is an error, with the nearest name when one is close", () => {
    expect(errors(v2("[private]", 'placement = "tab"'))).toEqual([
      { line: 3, path: "private.placement", message: 'must be "swap" or "window"' },
    ]);
    expect(errors(v2("[private]", 'placement = "windows"'))).toEqual([
      {
        line: 3,
        path: "private.placement",
        message: 'must be "swap" or "window"',
        suggestion: "window",
      },
    ]);
    expect(errors(v2("[private]", "placement = false"))).toEqual([
      { line: 3, path: "private.placement", message: "expected a string, got a boolean" },
    ]);
  });

  test("an unknown key suggests placement; the section is a table, new in schema 2", () => {
    expect(errors(v2("[private]", 'placment = "window"'))).toEqual([
      {
        line: 3,
        path: "private.placment",
        message: 'unknown key "placment"',
        suggestion: "placement",
      },
    ]);
    expect(errors(v2("private = 1"))).toEqual([
      { line: 2, path: "private", message: "expected a table, got an integer" },
    ]);
    expect(errors(toml("schema = 1", "[private]", 'placement = "window"'))).toEqual([
      {
        line: 2,
        path: "private",
        message: "is new in schema 2: put schema = 2 at the top of the file",
      },
    ]);
  });
});

// docs/specs/toolbar-toggle.md, decision 3: [ui] toolbar, a schema-2 table.
describe("[ui] toolbar", () => {
  test('defaults to "shown"', () => {
    expect(ok(v2()).ui).toEqual({ toolbar: "shown", bookmarksToolbar: null });
    expect(DEFAULT_CONFIG.ui).toEqual({ toolbar: "shown" });
    expect(formatDefaultsToml()).toMatch(/^\[ui\]\n(#.*\n)*toolbar = "shown"$/m);
  });

  test.each([["shown"], ["hidden"]])('toolbar = "%s" is accepted', (toolbar) => {
    expect(ok(v2("[ui]", `toolbar = "${toolbar}"`)).ui.toolbar).toBe(toolbar);
  });

  test("any other value is an error, with the nearest one when it is close", () => {
    expect(errors(v2("[ui]", 'toolbar = "off"'))).toEqual([
      { line: 3, path: "ui.toolbar", message: 'must be "shown" or "hidden"' },
    ]);
    expect(errors(v2("[ui]", 'toolbar = "hiden"'))).toEqual([
      { line: 3, path: "ui.toolbar", message: 'must be "shown" or "hidden"', suggestion: "hidden" },
    ]);
    expect(errors(v2("[ui]", "toolbar = false"))).toEqual([
      { line: 3, path: "ui.toolbar", message: "expected a string, got a boolean" },
    ]);
  });

  test("an unknown key is an error; [ui] is a table, new in schema 2", () => {
    expect(errors(v2("[ui]", 'tolbar = "hidden"'))).toEqual([
      { line: 3, path: "ui.tolbar", message: 'unknown key "tolbar"', suggestion: "toolbar" },
    ]);
    expect(errors(v2("[ui]", "tabstrip = true"))).toMatchObject([
      { line: 3, path: "ui.tabstrip", message: 'unknown key "tabstrip"' },
    ]);
    expect(errors(v2("ui = 1"))).toEqual([
      { line: 2, path: "ui", message: "expected a table, got an integer" },
    ]);
    expect(errors(toml("schema = 1", "[ui]", 'toolbar = "hidden"'))).toEqual([
      { line: 2, path: "ui", message: "is new in schema 2: put schema = 2 at the top of the file" },
    ]);
  });
});

// docs/specs/bookmarks-toolbar-hidden.md, decision 3: [ui] bookmarks_toolbar, unset by default.
describe("[ui] bookmarks_toolbar", () => {
  test("left out, the config has none: Firefox's pref decides; the template only comments it", () => {
    expect(ok(v2()).ui.bookmarksToolbar).toBeNull();
    expect(DEFAULT_CONFIG.ui).not.toHaveProperty("bookmarks_toolbar");
    expect(formatDefaultsToml()).toMatch(/^# bookmarks_toolbar = "shown"$/m);
    expect(formatDefaultsToml()).not.toMatch(/^bookmarks_toolbar/m);
  });

  test.each([["shown"], ["hidden"], ["newtab"]])('bookmarks_toolbar = "%s" is accepted', (v) => {
    expect(ok(v2("[ui]", `bookmarks_toolbar = "${v}"`)).ui).toEqual({
      toolbar: "shown",
      bookmarksToolbar: v,
    });
  });

  test("Firefox's own words and other values are errors, with the Vimma word when one fits", () => {
    const message = 'must be "shown", "hidden" or "newtab"';
    const at = { line: 3, path: "ui.bookmarks_toolbar", message };
    expect(errors(v2("[ui]", 'bookmarks_toolbar = "always"'))).toEqual([
      { ...at, suggestion: "shown" },
    ]);
    expect(errors(v2("[ui]", 'bookmarks_toolbar = "never"'))).toEqual([
      { ...at, suggestion: "hidden" },
    ]);
    expect(errors(v2("[ui]", 'bookmarks_toolbar = "hiden"'))).toEqual([
      { ...at, suggestion: "hidden" },
    ]);
    expect(errors(v2("[ui]", 'bookmarks_toolbar = "blue"'))).toEqual([at]);
    expect(errors(v2("[ui]", "bookmarks_toolbar = true"))).toEqual([
      { line: 3, path: "ui.bookmarks_toolbar", message: "expected a string, got a boolean" },
    ]);
  });

  test("a near miss of the key name suggests it; schema 1 has no [ui]", () => {
    expect(errors(v2("[ui]", 'bookmark_toolbar = "shown"'))).toEqual([
      {
        line: 3,
        path: "ui.bookmark_toolbar",
        message: 'unknown key "bookmark_toolbar"',
        suggestion: "bookmarks_toolbar",
      },
    ]);
    expect(errors(toml("schema = 1", "[ui]", 'bookmarks_toolbar = "shown"'))).toEqual([
      { line: 2, path: "ui", message: "is new in schema 2: put schema = 2 at the top of the file" },
    ]);
  });
});

// docs/specs/vimma-mcp.md, decision 26: [mcp], a schema-2 table; config wins over :mcp on|off.
describe("[mcp]", () => {
  // docs/specs/mcp-session-grants.md S1: grant_minutes 0, a grant for the whole connection.
  test("defaults: workspace agent, 50 s, grants for the connection or at most 480 min, 200,000 characters, notify", () => {
    expect(ok(v2()).mcp).toEqual({
      workspace: "agent",
      askTimeout: 50,
      grantMinutes: 0,
      grantMaxMinutes: 480,
      maxReadChars: 200000,
      notify: true,
      downloadDir: "~/Downloads/vimma-agent",
      downloadMaxMb: 200,
      clamavMaxAgeDays: 7,
    });
    expect(ok(toml()).mcp.workspace).toBe("agent");
    expect(DEFAULT_CONFIG.mcp).toEqual({
      workspace: "agent",
      ask_timeout: 50,
      grant_minutes: 0,
      grant_max_minutes: 480,
      max_read_chars: 200000,
      notify: true,
      download_dir: "~/Downloads/vimma-agent",
      download_max_mb: 200,
      clamav_max_age_days: 7,
    });
    const text = formatDefaultsToml();
    expect(text).toMatch(/^\[mcp\]\n# enabled = false\nworkspace = "agent"\nask_timeout = 50$/m);
    expect(text).toMatch(
      /^grant_minutes = 0\ngrant_max_minutes = 480\nmax_read_chars = 200000\nnotify = true$/m,
    );
    expect(text).toMatch(/^download_dir = "~\/Downloads\/vimma-agent"\ndownload_max_mb = 200$/m);
    expect(text).toMatch(/^clamav_max_age_days = 7$/m);
  });

  test("every key as written; enabled only when the file sets it", () => {
    const mcp = ok(
      v2(
        "[mcp]",
        "enabled = true",
        'workspace = "bots"',
        "ask_timeout = 10",
        "grant_minutes = 1440",
        "grant_max_minutes = 1440",
        "max_read_chars = 1000",
        "notify = false",
        'download_dir = "/srv/agent-files"',
        "download_max_mb = 4096",
        "clamav_max_age_days = 90",
      ),
    ).mcp;
    expect(mcp).toEqual({
      enabled: true,
      workspace: "bots",
      askTimeout: 10,
      grantMinutes: 1440,
      grantMaxMinutes: 1440,
      maxReadChars: 1000,
      notify: false,
      downloadDir: "/srv/agent-files",
      downloadMaxMb: 4096,
      clamavMaxAgeDays: 90,
    });
    expect(ok(v2("[mcp]", "enabled = false")).mcp.enabled).toBe(false);
    expect("enabled" in ok(v2("[mcp]", "notify = true")).mcp).toBe(false);
  });

  test("each bound is an error that says the range", () => {
    const at = (/** @type {string} */ line) => errors(v2("[mcp]", line))[0];
    expect(at("ask_timeout = 5")).toEqual({
      line: 3,
      path: "mcp.ask_timeout",
      message: "must be an integer between 10 and 300 (seconds)",
    });
    expect(at("ask_timeout = 301")?.message).toBe(
      "must be an integer between 10 and 300 (seconds)",
    );
    expect(at("grant_max_minutes = 0")?.message).toBe(
      "must be an integer between 1 and 1440 (minutes)",
    );
    expect(at("grant_max_minutes = 1441")?.path).toBe("mcp.grant_max_minutes");
    expect(at("grant_minutes = -1")?.message).toBe(
      "must be an integer between 0 and grant_max_minutes (480)",
    );
    expect(ok(v2("[mcp]", "grant_minutes = 0")).mcp.grantMinutes).toBe(0);
    expect(at("max_read_chars = 999")?.message).toBe("must be an integer between 1000 and 500000");
    expect(at("max_read_chars = 500001")?.path).toBe("mcp.max_read_chars");
    expect(at('ask_timeout = "50"')?.message).toBe("expected an integer, got a string");
    expect(at("notify = 1")?.message).toBe("expected a boolean, got an integer");
    expect(at('enabled = "yes"')?.message).toBe("expected a boolean, got a string");
  });

  test("grant_minutes above grant_max_minutes is an error", () => {
    expect(errors(v2("[mcp]", "grant_minutes = 60", "grant_max_minutes = 30"))).toEqual([
      {
        line: 3,
        path: "mcp.grant_minutes",
        message: "must be an integer between 0 and grant_max_minutes (30)",
      },
    ]);
    expect(errors(v2("[mcp]", "grant_minutes = 500"))[0]?.message).toBe(
      "must be an integer between 0 and grant_max_minutes (480)",
    );
  });

  // Decision 31 b, f (sub-PR 2c): the quarantine folder and the size cap.
  test("download_dir is ~ or absolute, never home, / or the Downloads folder itself", () => {
    const at = (/** @type {string} */ line) => errors(v2("[mcp]", line))[0];
    expect(ok(v2("[mcp]", 'download_dir = "~/agent-files"')).mcp.downloadDir).toBe("~/agent-files");
    expect(at('download_dir = "agent-files"')).toEqual({
      line: 3,
      path: "mcp.download_dir",
      message: "must start with ~/ or /",
    });
    for (const dir of ["~", "~/", "/", "/./", "~/Downloads", "~/./Downloads/", "$HOME/Downloads"]) {
      expect(at(`download_dir = "${dir}"`)?.message, dir).toMatch(
        /^must not (be your home folder|be \/|be the Downloads folder itself|start with \$)/,
      );
    }
    expect(at('download_dir = "~/a/../b"')?.message).toBe("must not contain ..");
    expect(at('download_dir = "~/a\\u0007b"')?.message).toBe("must not contain control characters");
    expect(at("download_dir = 3")?.message).toBe("expected a string, got an integer");
  });

  // No hidden folder of home, nothing anyone can write (security.md M12).
  test("download_dir is never in a hidden folder of home or in /tmp, /var/tmp, /dev/shm", () => {
    const at = (/** @type {string} */ line) => errors(v2("[mcp]", line))[0]?.message;
    expect(at('download_dir = "~/.local/bin"')).toBe("must not be in a hidden folder (.local)");
    expect(at('download_dir = "~/a/.cache"')).toBe("must not be in a hidden folder (.cache)");
    for (const dir of ["/tmp/q", "/var/tmp", "/dev/shm/x", "/tmp"]) {
      expect(at(`download_dir = "${dir}"`), dir).toBe("must not be in /tmp, /var/tmp or /dev/shm");
    }
    expect(ok(v2("[mcp]", 'download_dir = "~/agent.files"')).mcp.downloadDir).toBe("~/agent.files");
  });

  test("download_max_mb is 1 to 4096", () => {
    const at = (/** @type {string} */ line) => errors(v2("[mcp]", line))[0];
    expect(ok(v2("[mcp]", "download_max_mb = 1")).mcp.downloadMaxMb).toBe(1);
    expect(at("download_max_mb = 0")).toEqual({
      line: 3,
      path: "mcp.download_max_mb",
      message: "must be an integer between 1 and 4096 (MB)",
    });
    expect(at("download_max_mb = 4097")?.path).toBe("mcp.download_max_mb");
    expect(at('download_max_mb = "200"')?.message).toBe("expected an integer, got a string");
  });

  test("clamav_max_age_days is 1 to 90, 7 by default", () => {
    const at = (/** @type {string} */ line) => errors(v2("[mcp]", line))[0];
    expect(ok(v2("[mcp]", "notify = true")).mcp.clamavMaxAgeDays).toBe(7);
    expect(ok(v2("[mcp]", "clamav_max_age_days = 1")).mcp.clamavMaxAgeDays).toBe(1);
    expect(at("clamav_max_age_days = 0")).toEqual({
      line: 3,
      path: "mcp.clamav_max_age_days",
      message: "must be an integer between 1 and 90 (days)",
    });
    expect(at("clamav_max_age_days = 91")?.path).toBe("mcp.clamav_max_age_days");
    expect(at('clamav_max_age_days = "7"')?.message).toBe("expected an integer, got a string");
  });

  test('workspace follows the workspace-name rules and is never "private"', () => {
    const at = (/** @type {string} */ line) => errors(v2("[mcp]", line))[0];
    expect(at('workspace = "private"')).toEqual({
      line: 3,
      path: "mcp.workspace",
      message: 'must not be "private", the private workspace\'s name',
    });
    expect(at('workspace = ""')?.message).toBe("must be 1 to 32 characters");
    expect(at(`workspace = "${"x".repeat(33)}"`)?.message).toBe("must be 1 to 32 characters");
    expect(at('workspace = "a\\u0007b"')?.message).toBe("must not contain control characters");
    expect(at("workspace = 3")?.message).toBe("expected a string, got an integer");
  });

  test("a misspelt key suggests the right one; [mcp] without schema = 2 asks for it", () => {
    expect(errors(v2("[mcp]", "ask_timout = 50"))).toEqual([
      {
        line: 3,
        path: "mcp.ask_timout",
        message: 'unknown key "ask_timout"',
        suggestion: "ask_timeout",
      },
    ]);
    expect(errors(toml("[mcp]", "enabled = true"))).toEqual([
      {
        line: 1,
        path: "mcp",
        message: "is new in schema 2: put schema = 2 at the top of the file",
      },
    ]);
    expect(errors(v2("mcp = true"))).toEqual([
      { line: 2, path: "mcp", message: "expected a table, got a boolean" },
    ]);
  });
});
