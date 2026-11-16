// docs/specs/search-engines.md: `[search]` in config.toml, its reconcile plan, `:open @` completion.
import { describe, test, expect } from "vitest";
import { parseConfig } from "../src/config/config.mjs";
import { completeCommandLine } from "../src/keys/cmdline.mjs";
import { formatConfigTemplate, formatDefaultsToml } from "../src/config/defaults.mjs";
import {
  appliedAliases,
  configuredEngine,
  parseSearchState,
  planSearch,
  resolveSearch,
  searchCompletions,
  toFirefoxTemplate,
} from "../src/config/search.mjs";

import type { ResolvedConfig } from "../src/config/config.mjs";
import type { InstalledEngine } from "../src/config/search.mjs";

const v2 = (...lines: string[]) => ["schema = 2", ...lines].join("\n") + "\n";

function ok(text: string) {
  const r = parseConfig(text);
  expect(r.errors).toEqual([]);
  return r.config as ResolvedConfig;
}

function errors(text: string) {
  const r = parseConfig(text);
  expect(r.config).toBeNull();
  return r.errors.map((e) => ({
    line: e.line,
    path: e.path,
    message: e.message,
    ...(e.suggestion ? { suggestion: e.suggestion } : {}),
  }));
}

const TEMPLATE_ERROR =
  "must be an https:// or http:// URL with one %s, or an installed engine's name";

describe("[search] in config.toml", () => {
  test("left out, the config has no search section and the defaults none either", () => {
    expect(ok(v2()).search).toBeNull();
    expect(ok("").search).toBeNull();
  });

  test("default and aliases resolve, sorted by alias, templates with their host", () => {
    const c = ok(
      v2(
        "[search]",
        'default = "DuckDuckGo"',
        "[search.aliases]",
        'w = "Wikipedia (en)"',
        'gh = "https://github.com/search?q=%s"',
      ),
    );
    expect(c.search).toEqual({
      default: { kind: "engine", name: "DuckDuckGo" },
      aliases: [
        {
          alias: "gh",
          kind: "template",
          url: "https://github.com/search?q={searchTerms}",
          host: "github.com",
        },
        { alias: "w", kind: "engine", name: "Wikipedia (en)" },
      ],
    });
  });

  test("an empty [search] resolves to nothing to do", () => {
    expect(ok(v2("[search]")).search).toEqual({ default: null, aliases: [] });
  });

  test("alias keys: one leading @ dropped, lowercased", () => {
    const c = ok(
      v2("[search.aliases]", '"@GH" = "https://github.com/search?q=%s"', 'Wp = "Wikipedia (en)"'),
    );
    expect(c.search?.aliases.map((a) => a.alias)).toEqual(["gh", "wp"]);
  });

  test("two keys equal after normalising are an error", () => {
    expect(
      errors(
        v2(
          "[search.aliases]",
          'gh = "https://github.com/search?q=%s"',
          '"@GH" = "https://github.com/issues?q=%s"',
        ),
      ),
    ).toEqual([{ line: 4, path: 'search.aliases."@GH"', message: 'same alias as "gh"' }]);
  });

  test("alias keys with bad characters or over 32 characters are errors", () => {
    const message = "an alias is a letter or digit, then up to 31 of a-z 0-9 . _ -";
    expect(errors(v2("[search.aliases]", '"g h" = "Google"'))).toEqual([
      { line: 3, path: 'search.aliases."g h"', message },
    ]);
    expect(errors(v2("[search.aliases]", '"@@g" = "Google"'))).toEqual([
      { line: 3, path: 'search.aliases."@@g"', message },
    ]);
    expect(errors(v2("[search.aliases]", `${"a".repeat(33)} = "Google"`))).toEqual([
      { line: 3, path: `search.aliases.${"a".repeat(33)}`, message },
    ]);
    expect(ok(v2("[search.aliases]", `${"a".repeat(32)} = "Google"`)).search?.aliases).toHaveLength(
      1,
    );
  });

  test.each([
    ["https://example.com/search?q=%s&page=%s", "two %s"],
    ["https://example.com/search", "no %s"],
    ["javascript:%s", "javascript:"],
    ["file:///tmp/%s", "file:"],
    ["ftp://example.com/%s", "ftp:"],
    ["data:text/html,%s", "data:"],
    ["https://exa mple.com/?q=%s", "unparsable"],
  ])("template %s (%s) is an error", (value) => {
    expect(errors(v2("[search.aliases]", `t = ${JSON.stringify(value)}`))).toEqual([
      { line: 3, path: "search.aliases.t", message: TEMPLATE_ERROR },
    ]);
  });

  test("an http:// template is accepted; %s becomes {searchTerms}", () => {
    const c = ok(v2("[search.aliases]", 'sx = "http://searx.lan:8080/search?q=%s"'));
    expect(c.search?.aliases).toEqual([
      {
        alias: "sx",
        kind: "template",
        url: "http://searx.lan:8080/search?q={searchTerms}",
        host: "searx.lan",
      },
    ]);
    expect(toFirefoxTemplate("https://a.example/%s?x=1")).toBe(
      "https://a.example/{searchTerms}?x=1",
    );
  });

  test("engine names: 1 to 100 characters, no control characters, strings only", () => {
    const message = "an engine name is 1 to 100 characters without control characters";
    expect(errors(v2("[search.aliases]", 'e = ""'))).toEqual([
      { line: 3, path: "search.aliases.e", message },
    ]);
    expect(errors(v2("[search.aliases]", `e = "${"x".repeat(101)}"`))).toEqual([
      { line: 3, path: "search.aliases.e", message },
    ]);
    expect(errors(v2("[search.aliases]", 'e = "Bad\\u0007Name"'))).toEqual([
      { line: 3, path: "search.aliases.e", message },
    ]);
    expect(errors(v2("[search.aliases]", "e = 3"))).toEqual([
      { line: 3, path: "search.aliases.e", message: "expected a string, got an integer" },
    ]);
    expect(ok(v2("[search.aliases]", `e = "${"x".repeat(100)}"`)).search?.aliases).toHaveLength(1);
  });

  test("two aliases naming the same engine, case-insensitively, is an error", () => {
    expect(errors(v2("[search.aliases]", 'w = "Wikipedia (en)"', 'wp = "wikipedia (EN)"'))).toEqual(
      [
        {
          line: 4,
          path: "search.aliases.wp",
          message: 'names the same engine as "w": an engine has one alias',
        },
      ],
    );
  });

  test("default names an engine, or @key of a template alias", () => {
    expect(ok(v2("[search]", 'default = "Bing"')).search?.default).toEqual({
      kind: "engine",
      name: "Bing",
    });
    const c = ok(
      v2("[search]", 'default = "@SX"', "[search.aliases]", 'sx = "https://searx.example/?q=%s"'),
    );
    expect(c.search?.default).toEqual({ kind: "template", alias: "sx" });
  });

  test("default as @key of an engine alias or of an unknown alias is an error", () => {
    expect(
      errors(v2("[search]", 'default = "@w"', "[search.aliases]", 'w = "Wikipedia (en)"')),
    ).toEqual([
      {
        line: 3,
        path: "search.default",
        message: '"@w" names an installed engine: write its name, "Wikipedia (en)"',
      },
    ]);
    expect(
      errors(v2("[search]", 'default = "@gj"', "[search.aliases]", 'gh = "https://g.example/%s"')),
    ).toEqual([
      {
        line: 3,
        path: "search.default",
        message: 'no alias "gj" in [search.aliases]',
        suggestion: "@gh",
      },
    ]);
    expect(errors(v2("[search]", "default = 1"))).toEqual([
      { line: 3, path: "search.default", message: "expected a string, got an integer" },
    ]);
  });

  test("unknown [search] keys get a suggestion; aliases must be a table", () => {
    expect(errors(v2("[search]", 'defualt = "Bing"'))).toEqual([
      { line: 3, path: "search.defualt", message: 'unknown key "defualt"', suggestion: "default" },
    ]);
    expect(errors(v2("[search]", 'aliases = "gh"'))).toEqual([
      { line: 3, path: "search.aliases", message: "expected a table, got a string" },
    ]);
  });

  test("a schema 1 file with [search] is told it is new in schema 2", () => {
    expect(errors('schema = 1\n[search]\ndefault = "Bing"\n')).toEqual([
      {
        line: 2,
        path: "search",
        message: "is new in schema 2: put schema = 2 at the top of the file",
      },
    ]);
  });

  test("the template carries a commented [search] block; defaults.toml means no [search]", () => {
    expect(formatDefaultsToml()).toMatch(/^# \[search\]$/m);
    expect(formatDefaultsToml()).toMatch(/^# gh = "https:\/\/github\.com\/search\?q=%s"$/m);
    expect(ok(formatDefaultsToml()).search).toBeNull();
    expect(ok(formatConfigTemplate()).search).toBeNull();
  });
});

describe("resolveSearch", () => {
  test("null for no section", () => {
    expect(resolveSearch(undefined)).toBeNull();
  });
});

const engine = (e: Partial<InstalledEngine> & { id: string; name: string }): InstalledEngine => ({
  alias: "",
  aliases: [],
  hidden: false,
  ...e,
});

const GOOGLE = engine({ id: "google", name: "Google", aliases: ["@google"] });
const DDG = engine({ id: "ddg", name: "DuckDuckGo", aliases: ["@duckduckgo", "@ddg"] });
const WIKI = engine({ id: "wiki", name: "Wikipedia (en)", aliases: ["@wikipedia"] });
const INSTALLED = [GOOGLE, DDG, WIKI];

const searchOf = (...lines: string[]) => ok(v2(...lines)).search as any;

const GH = "https://github.com/search?q={searchTerms}";

describe("planSearch", () => {
  test("nothing configured and nothing recorded: no steps", () => {
    expect(planSearch(null, null, { engines: INSTALLED, defaultId: "google" })).toEqual({
      steps: [],
      problems: [],
      state: null,
    });
  });

  test("first apply creates, sets aliases and the default, and records what it replaced", () => {
    const next = searchOf(
      "[search]",
      'default = "DuckDuckGo"',
      "[search.aliases]",
      'gh = "https://github.com/search?q=%s"',
      'w = "Wikipedia (en)"',
    );
    const wiki = { ...WIKI, alias: "wp", aliases: ["wp", "@wikipedia"] };
    const plan = planSearch(null, next, {
      engines: [GOOGLE, DDG, wiki],
      defaultId: "google",
    });
    expect(plan.problems).toEqual([]);
    expect(plan.steps).toEqual([
      { op: "create", alias: "gh", name: "github.com", url: GH },
      { op: "set-alias", id: "wiki", alias: "@w" },
      { op: "set-default", id: "ddg" },
    ]);
    expect(plan.state).toEqual({
      created: [{ alias: "gh", id: null, name: "github.com", url: GH }],
      aliased: [{ alias: "w", id: "wiki", replaced: "wp" }],
      default: { set: "ddg", previous: "google" },
    });
  });

  test("the same config again: no steps, the same state", () => {
    const next = searchOf(
      "[search]",
      'default = "@gh"',
      "[search.aliases]",
      'gh = "https://github.com/search?q=%s"',
      'w = "Wikipedia (en)"',
    );
    const state = {
      created: [{ alias: "gh", id: "u1", name: "github.com", url: GH }],
      aliased: [{ alias: "w", id: "wiki", replaced: "" }],
      default: { set: "u1", previous: "google" },
    };
    const engines = [
      ...INSTALLED.map((e) => (e.id === "wiki" ? { ...e, alias: "@w" } : e)),
      engine({ id: "u1", name: "github.com", alias: "@gh", aliases: ["@gh"], url: GH }),
    ];
    expect(planSearch(state, next, { engines, defaultId: "u1" })).toEqual({
      steps: [],
      problems: [],
      state,
    });
  });

  test("a new template with @key as default: the default follows the created engine", () => {
    const next = searchOf(
      "[search]",
      'default = "@sx"',
      "[search.aliases]",
      'sx = "https://searx.example/?q=%s"',
    );
    const plan = planSearch(null, next, { engines: INSTALLED, defaultId: "google" });
    expect(plan.steps).toEqual([
      {
        op: "create",
        alias: "sx",
        name: "searx.example",
        url: "https://searx.example/?q={searchTerms}",
      },
      { op: "set-default", created: "sx" },
    ]);
    expect(plan.state?.default).toEqual({ set: null, previous: "google" });
  });

  const managed = (url: string, name = "github.com") => ({
    created: [{ alias: "gh", id: "u1", name, url }],
    aliased: [],
    default: null,
  });

  test("a changed template updates the engine; a changed host renames it too", () => {
    const old = "https://github.com/old?q={searchTerms}";
    const engines = [
      ...INSTALLED,
      engine({ id: "u1", name: "github.com", alias: "@gh", url: old }),
    ];
    const same = planSearch(
      managed(old),
      searchOf("[search.aliases]", 'gh = "https://github.com/search?q=%s"'),
      { engines, defaultId: "google" },
    );
    expect(same.steps).toEqual([{ op: "update", id: "u1", url: GH }]);
    const moved = planSearch(
      managed(old),
      searchOf("[search.aliases]", 'gh = "https://gitlab.com/search?q=%s"'),
      { engines, defaultId: "google" },
    );
    expect(moved.steps).toEqual([
      { op: "update", id: "u1", url: "https://gitlab.com/search?q={searchTerms}" },
      { op: "rename", id: "u1", name: "gitlab.com" },
    ]);
    expect(moved.state?.created).toEqual([
      {
        alias: "gh",
        id: "u1",
        name: "gitlab.com",
        url: "https://gitlab.com/search?q={searchTerms}",
      },
    ]);
  });

  test("a name another engine has gets the alias after it", () => {
    const engines = [...INSTALLED, engine({ id: "x", name: "github.com" })];
    const plan = planSearch(
      null,
      searchOf("[search.aliases]", 'gh = "https://github.com/search?q=%s"'),
      { engines, defaultId: "google" },
    );
    expect(plan.steps).toEqual([{ op: "create", alias: "gh", name: "github.com (@gh)", url: GH }]);
  });

  test("an alias removed: its engine is removed, an installed engine's alias put back", () => {
    const state = {
      created: [{ alias: "gh", id: "u1", name: "github.com", url: GH }],
      aliased: [{ alias: "w", id: "wiki", replaced: "wp" }],
      default: null,
    };
    const engines = [
      GOOGLE,
      DDG,
      { ...WIKI, alias: "@w" },
      engine({ id: "u1", name: "github.com", alias: "@gh", url: GH }),
    ];
    const plan = planSearch(state, searchOf("[search]"), { engines, defaultId: "google" });
    expect(plan.steps).toEqual([
      { op: "remove", id: "u1" },
      { op: "set-alias", id: "wiki", alias: "wp" },
    ]);
    expect(plan.state).toEqual({ created: [], aliased: [], default: null });
  });

  test("an alias changed in Settings since is not put back", () => {
    const state = {
      created: [],
      aliased: [{ alias: "w", id: "wiki", replaced: "" }],
      default: null,
    };
    const engines = [GOOGLE, DDG, { ...WIKI, alias: "mine" }];
    expect(planSearch(state, null, { engines, defaultId: "google" }).steps).toEqual([]);
  });

  test("the whole section removed: the default goes back, then the engines go", () => {
    const state = {
      created: [
        {
          alias: "sx",
          id: "u1",
          name: "searx.example",
          url: "https://searx.example/{searchTerms}",
        },
      ],
      aliased: [],
      default: { set: "u1", previous: "ddg" },
    };
    const engines = [
      ...INSTALLED,
      engine({
        id: "u1",
        name: "searx.example",
        alias: "@sx",
        url: "https://searx.example/{searchTerms}",
      }),
    ];
    const plan = planSearch(state, null, { engines, defaultId: "u1" });
    expect(plan.steps).toEqual([
      { op: "set-default", id: "ddg" },
      { op: "remove", id: "u1" },
    ]);
    expect(plan.state).toBeNull();
  });

  test("default removed: restored only while it is still Vimma's and the old one exists", () => {
    const state = { created: [], aliased: [], default: { set: "ddg", previous: "google" } };
    const none = searchOf("[search]");
    expect(planSearch(state, none, { engines: INSTALLED, defaultId: "ddg" }).steps).toEqual([
      { op: "set-default", id: "google" },
    ]);
    // Changed in Settings since: kept.
    expect(planSearch(state, none, { engines: INSTALLED, defaultId: "wiki" }).steps).toEqual([]);
    // The previous engine is gone: Firefox's choice stands.
    expect(planSearch(state, none, { engines: [DDG, WIKI], defaultId: "ddg" }).steps).toEqual([]);
    expect(
      planSearch(state, none, {
        engines: [{ ...GOOGLE, hidden: true }, DDG, WIKI],
        defaultId: "ddg",
      }).steps,
    ).toEqual([]);
  });

  test("the file wins at every apply: a default changed in Settings is set back", () => {
    const state = { created: [], aliased: [], default: { set: "ddg", previous: "google" } };
    const plan = planSearch(state, searchOf("[search]", 'default = "DuckDuckGo"'), {
      engines: INSTALLED,
      defaultId: "wiki",
    });
    expect(plan.steps).toEqual([{ op: "set-default", id: "ddg" }]);
    expect(plan.state?.default).toEqual({ set: "ddg", previous: "google" });
  });

  test("an engine name not installed is a problem with a suggestion; nothing changes", () => {
    const plan = planSearch(null, searchOf("[search]", 'default = "DuckDuckGoo"'), {
      engines: INSTALLED,
      defaultId: "google",
    });
    expect(plan.steps).toEqual([]);
    expect(plan.problems).toEqual([
      {
        path: ["search", "default"],
        message: 'no search engine named "DuckDuckGoo"',
        suggestion: "DuckDuckGo",
      },
    ]);
  });

  test("names match case-insensitively", () => {
    const plan = planSearch(null, searchOf("[search]", 'default = "duckduckgo"'), {
      engines: INSTALLED,
      defaultId: "google",
    });
    expect(plan.steps).toEqual([{ op: "set-default", id: "ddg" }]);
  });

  test("a hidden engine says where to restore it", () => {
    const plan = planSearch(null, searchOf("[search.aliases]", 'w = "Wikipedia (en)"'), {
      engines: [GOOGLE, DDG, { ...WIKI, hidden: true }],
      defaultId: "google",
    });
    expect(plan.steps).toEqual([]);
    expect(plan.problems).toEqual([
      {
        path: ["search", "aliases", "w"],
        message: '"Wikipedia (en)" is removed in Settings: Restore Default Search Engines there',
      },
    ]);
  });

  test("an alias another engine already has is a problem", () => {
    const plan = planSearch(
      null,
      searchOf("[search.aliases]", 'google = "https://g.example/?q=%s"', 'ddg = "Wikipedia (en)"'),
      { engines: INSTALLED, defaultId: "google" },
    );
    expect(plan.steps).toEqual([]);
    expect(plan.problems).toEqual([
      { path: ["search", "aliases", "ddg"], message: "@ddg is already DuckDuckGo's alias" },
      { path: ["search", "aliases", "google"], message: "@google is already Google's alias" },
    ]);
  });

  test("a managed engine deleted in Settings is created again", () => {
    const plan = planSearch(
      managed(GH),
      searchOf("[search.aliases]", 'gh = "https://github.com/search?q=%s"'),
      { engines: INSTALLED, defaultId: "google" },
    );
    expect(plan.steps).toEqual([{ op: "create", alias: "gh", name: "github.com", url: GH }]);
  });

  test("an alias moved from one engine to another frees the old one first", () => {
    const state = {
      created: [],
      aliased: [{ alias: "w", id: "wiki", replaced: "" }],
      default: null,
    };
    const engines = [GOOGLE, DDG, { ...WIKI, alias: "@w", aliases: ["@w", "@wikipedia"] }];
    const plan = planSearch(state, searchOf("[search.aliases]", 'w = "Google"'), {
      engines,
      defaultId: "google",
    });
    expect(plan.problems).toEqual([]);
    expect(plan.steps).toEqual([
      { op: "set-alias", id: "wiki", alias: "" },
      { op: "set-alias", id: "google", alias: "@w" },
    ]);
  });
});

describe(":open @ completion", () => {
  const search = searchCompletions([
    { alias: "@gh", engine: "github.com" },
    { alias: "@google", engine: "Google" },
    { alias: "@wikipedia", engine: "Wikipedia (en)" },
  ]);
  const complete = (line: string) =>
    completeCommandLine(line, { args: { search } }).candidates.map((c) => [c.value, c.description]);

  test("lists the aliases starting with what was typed, each with its engine", () => {
    expect(complete("open @g")).toEqual([
      ["open @gh ", "github.com"],
      ["open @google ", "Google"],
    ]);
    expect(complete("tabnew @")).toHaveLength(3);
    expect(complete("open @W")).toEqual([["open @wikipedia ", "Wikipedia (en)"]]);
  });

  test("completes nothing once words follow, or without the @", () => {
    expect(complete("open @gh foo")).toEqual([]);
    expect(complete("open example.com")).toEqual([]);
    expect(complete("open ")).toEqual([]);
  });
});

describe("appliedAliases (about:vimma's Search line)", () => {
  const resolved = resolveSearch({
    aliases: {
      gh: "https://github.com/search?q=%s",
      w: "Wikipedia (en)",
      typo: "Wikipdia (en)",
      taken: "https://example.com/?q=%s",
    },
  });
  const aliases = resolved?.aliases ?? [];

  test("lists only the aliases the last apply made or gave an engine", () => {
    const state = {
      created: [{ alias: "gh", id: "u1", name: "github.com", url: "x" }],
      aliased: [{ alias: "w", id: "wiki", replaced: "" }],
      default: null,
    };
    expect(appliedAliases(aliases, state).map((a) => a.alias)).toEqual(["gh", "w"]);
  });

  test("lists none before anything applied", () => {
    expect(appliedAliases(aliases, null)).toEqual([]);
  });
});

describe("parseSearchState", () => {
  const good = {
    created: [{ alias: "gh", id: "u1", name: "github.com", url: GH }],
    aliased: [{ alias: "w", id: "wiki", replaced: "" }],
    default: { set: "u1", previous: "google" },
  };

  test("a recorded state comes back as it was", () => {
    expect(parseSearchState(JSON.stringify(good))).toEqual({ state: good });
    expect(parseSearchState(JSON.stringify({ created: [], aliased: [], default: null }))).toEqual({
      state: { created: [], aliased: [], default: null },
    });
  });

  test("nothing recorded is no state and no problem", () => {
    expect(parseSearchState("")).toEqual({ state: null });
    expect(parseSearchState("null")).toEqual({ state: null });
  });

  test.each([
    ["not JSON", "{"],
    ["created not a list", JSON.stringify({ ...good, created: "x" })],
    ["a created entry without an id", JSON.stringify({ ...good, created: [{ alias: "gh" }] })],
    [
      "a created id that is null",
      JSON.stringify({ ...good, created: [{ ...good.created[0], id: null }] }),
    ],
    ["aliased not a list", JSON.stringify({ ...good, aliased: {} })],
    [
      "an aliased entry with a number",
      JSON.stringify({ ...good, aliased: [{ alias: "w", id: 1, replaced: "" }] }),
    ],
    ["default not an object", JSON.stringify({ ...good, default: "u1" })],
    ["default without previous", JSON.stringify({ ...good, default: { set: "u1" } })],
    ["a list at the top", "[]"],
  ])("%s is discarded with the reason", (_why, text) => {
    const r = parseSearchState(text);
    expect(r.state).toBeNull();
    expect(r.problem).toMatch(/^vimma\.search\.applied /);
  });
});

describe("[search] values at their edges", () => {
  test.each([
    ["x = 1.5", "expected a string, got a float"],
    ["x = true", "expected a string, got a boolean"],
    ["x = [1]", "expected a string, got an array"],
    ["x = { a = 1 }", "expected a string, got a table"],
    // A template's scheme is at the start; %s in the host is a host of its own.
    ['x = "xhttps://a.example/?q=%s"', TEMPLATE_ERROR],
  ])("[search.aliases] %s: %s", (line, message) => {
    expect(errors(v2("[search.aliases]", line))).toEqual([
      { line: 3, path: "search.aliases.x", message },
    ]);
  });

  test("aliases must be a table, named with its type", () => {
    expect(errors(v2("[search]", "aliases = 1"))).toEqual([
      { line: 3, path: "search.aliases", message: "expected a table, got an integer" },
    ]);
  });

  test("a one-character engine name is a name; a control character is not", () => {
    expect(ok(v2("[search]", 'default = "G"')).search?.default).toEqual({
      kind: "engine",
      name: "G",
    });
    expect(errors(v2("[search]", 'default = "G\\u0001"'))).toEqual([
      {
        line: 3,
        path: "search.default",
        message: "an engine name is 1 to 100 characters without control characters",
      },
    ]);
  });

  test("a template's host is read with %s as a word", () => {
    expect(resolveSearch({ aliases: { s: "https://%s.example.com/" } })?.aliases).toEqual([
      {
        alias: "s",
        kind: "template",
        url: "https://{searchTerms}.example.com/",
        host: "x.example.com",
      },
    ]);
  });

  test("aliases are sorted whatever order the file has", () => {
    const r = resolveSearch({ aliases: { c: "C", a: "A", b: "B" } });
    expect(r?.aliases.map((a) => a.alias)).toEqual(["a", "b", "c"]);
  });

  test(":open @ completion is sorted by alias", () => {
    expect(
      searchCompletions([
        { alias: "@b", engine: "B" },
        { alias: "@a", engine: "A" },
        { alias: "@c", engine: "C" },
      ]).map((c) => c.name),
    ).toEqual(["@a", "@b", "@c"]);
  });
});

describe("planSearch at its edges", () => {
  const profile = (engines: InstalledEngine[], defaultId = "google") => ({ engines, defaultId });

  test("a hidden engine is not suggested for a name not installed", () => {
    const plan = planSearch(
      null,
      searchOf("[search]", 'default = "DuckDuckGoo"'),
      profile([GOOGLE, { ...DDG, hidden: true }]),
    );
    expect(plan.problems).toEqual([
      { path: ["search", "default"], message: 'no search engine named "DuckDuckGoo"' },
    ]);
  });

  test("an exact name wins over a case-insensitive one", () => {
    const lower = engine({ id: "g2", name: "google" });
    const plan = planSearch(
      null,
      searchOf("[search]", 'default = "google"'),
      profile([GOOGLE, lower]),
    );
    expect(plan.steps).toEqual([{ op: "set-default", id: "g2" }]);
  });

  test("the alias an engine has already is not taken for another's", () => {
    const wiki = { ...WIKI, alias: "@w", aliases: ["@w", "@wikipedia"] };
    const plan = planSearch(
      null,
      searchOf("[search.aliases]", 'w = "Wikipedia (en)"'),
      profile([GOOGLE, DDG, wiki]),
    );
    expect(plan).toEqual({
      steps: [],
      problems: [],
      state: { created: [], aliased: [{ alias: "w", id: "wiki", replaced: "@w" }], default: null },
    });
  });

  test("a template alias turned into an installed engine's moves without a conflict", () => {
    const state = {
      created: [{ alias: "gh", id: "u1", name: "github.com", url: GH }],
      aliased: [],
      default: null,
    };
    const u1 = engine({ id: "u1", name: "github.com", alias: "@gh", aliases: ["@gh"], url: GH });
    const plan = planSearch(state, searchOf("[search.aliases]", 'gh = "Google"'), {
      engines: [...INSTALLED, u1],
      defaultId: "google",
    });
    expect(plan.problems).toEqual([]);
    expect(plan.steps).toEqual([
      { op: "remove", id: "u1" },
      { op: "set-alias", id: "google", alias: "@gh" },
    ]);
  });

  test.each([
    // Vimma gave @w to another engine; the user gave it to Wikipedia in Settings since.
    [[{ alias: "w", id: "ddg", replaced: "" }], { alias: "@w", aliases: ["@w"] }],
    // Vimma gave Wikipedia @q; the user changed it to @w in Settings since.
    [[{ alias: "q", id: "wiki", replaced: "" }], { alias: "@w", aliases: ["@w"] }],
    // Wikipedia still has Vimma's @q, and @w of its own.
    [[{ alias: "q", id: "wiki", replaced: "" }], { alias: "@q", aliases: ["@q", "@w"] }],
  ])("an alias the user gave an engine is not taken from it (%j)", (aliased, wiki) => {
    const plan = planSearch(
      { created: [], aliased, default: null },
      searchOf("[search.aliases]", 'w = "Google"'),
      profile([GOOGLE, DDG, { ...WIKI, ...wiki }]),
    );
    expect(plan.problems).toEqual([
      { path: ["search", "aliases", "w"], message: "@w is already Wikipedia (en)'s alias" },
    ]);
  });

  test("an engine keeps the alias it had before Vimma's, whatever else was aliased", () => {
    const state = {
      created: [],
      aliased: [
        { alias: "g", id: "google", replaced: "gg" },
        { alias: "w", id: "wiki", replaced: "wp" },
      ],
      default: null,
    };
    const plan = planSearch(
      state,
      searchOf("[search.aliases]", 'g = "Google"', 'w = "Wikipedia (en)"'),
      profile([{ ...GOOGLE, alias: "@g" }, DDG, { ...WIKI, alias: "@w" }]),
    );
    expect(plan.steps).toEqual([]);
    expect(plan.state?.aliased).toEqual(state.aliased);
  });

  test("two templates on one host get distinct names", () => {
    const plan = planSearch(
      null,
      searchOf(
        "[search.aliases]",
        'gh = "https://github.com/search?q=%s"',
        'gi = "https://github.com/issues?q=%s"',
      ),
      profile(INSTALLED),
    );
    expect(plan.steps).toEqual([
      { op: "create", alias: "gh", name: "github.com", url: GH },
      {
        op: "create",
        alias: "gi",
        name: "github.com (@gi)",
        url: "https://github.com/issues?q={searchTerms}",
      },
    ]);
  });

  test("each managed engine is matched by its own alias, and gets it back", () => {
    const GL = "https://gitlab.com/search?q={searchTerms}";
    const state = {
      created: [
        { alias: "gh", id: "u1", name: "github.com", url: GH },
        { alias: "gl", id: "u2", name: "gitlab.com", url: GL },
      ],
      aliased: [],
      default: null,
    };
    const engines = [
      ...INSTALLED,
      engine({ id: "u1", name: "github.com", alias: "@gh", url: GH }),
      engine({ id: "u2", name: "gitlab.com", alias: "", url: GL }),
    ];
    const plan = planSearch(
      state,
      searchOf(
        "[search.aliases]",
        'gh = "https://github.com/search?q=%s"',
        'gl = "https://gitlab.com/search?q=%s"',
      ),
      profile(engines),
    );
    expect(plan.steps).toEqual([{ op: "set-alias", id: "u2", alias: "@gl" }]);
    expect(plan.state?.created).toEqual(state.created);
  });

  test("a managed engine deleted in Settings is not removed again", () => {
    const state = {
      created: [{ alias: "gh", id: "u1", name: "github.com", url: GH }],
      aliased: [],
      default: null,
    };
    expect(planSearch(state, null, profile(INSTALLED))).toEqual({
      steps: [],
      problems: [],
      state: null,
    });
  });

  test("a default that was already Firefox's is not set again when it goes", () => {
    const state = { created: [], aliased: [], default: { set: "google", previous: "google" } };
    expect(planSearch(state, searchOf("[search]"), profile(INSTALLED)).steps).toEqual([]);
  });

  test("problems are listed default first, then by alias", () => {
    const plan = planSearch(
      null,
      searchOf("[search]", 'default = "Nope"', "[search.aliases]", 'a = "Nada"'),
      profile(INSTALLED),
    );
    expect(plan.problems.map((p) => p.path)).toEqual([
      ["search", "default"],
      ["search", "aliases", "a"],
    ]);
  });
});

describe("parseSearchState: the reason a state is discarded", () => {
  const good = { created: [], aliased: [], default: null };
  test.each([
    ["{", "is not JSON"],
    ["[]", "is not an object"],
    ["1", "is not an object"],
    [JSON.stringify({ ...good, created: "x" }), 'has a malformed "created" list'],
    [JSON.stringify({ ...good, aliased: {} }), 'has a malformed "aliased" list'],
    [JSON.stringify({ ...good, default: "u1" }), 'has a malformed "default"'],
  ])("%s: %s", (text, why) => {
    expect(parseSearchState(text)).toEqual({
      state: null,
      problem: `vimma.search.applied ${why}; discarded`,
    });
  });
});

describe("configuredEngine (the setup page's current engine)", () => {
  const names = ["Google", "DuckDuckGo", "github.com"];
  const state = {
    created: [{ alias: "gh", id: "u1", name: "github.com", url: GH }],
    aliased: [],
    default: null,
  };

  test("an engine default names the installed engine, exact before ignoring case", () => {
    expect(configuredEngine({ kind: "engine", name: "DuckDuckGo" }, names, null)).toBe(
      "DuckDuckGo",
    );
    expect(configuredEngine({ kind: "engine", name: "duckduckgo" }, names, null)).toBe(
      "DuckDuckGo",
    );
    expect(configuredEngine({ kind: "engine", name: "google" }, ["google", "Google"], null)).toBe(
      "google",
    );
  });

  test("a template default names the engine Vimma made for its alias", () => {
    expect(configuredEngine({ kind: "template", alias: "gh" }, names, state)).toBe("github.com");
  });

  test("null when the file names no engine among them", () => {
    expect(configuredEngine(null, names, state)).toBeNull();
    expect(configuredEngine({ kind: "engine", name: "Bing" }, names, null)).toBeNull();
    expect(configuredEngine({ kind: "template", alias: "gh" }, names, null)).toBeNull();
    expect(configuredEngine({ kind: "template", alias: "x" }, names, state)).toBeNull();
    expect(configuredEngine({ kind: "template", alias: "gh" }, ["Google"], state)).toBeNull();
  });
});
