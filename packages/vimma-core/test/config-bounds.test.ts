// config.toml validation at its edges (docs/specs/m5-core-config-and-theme.md § Errors with
// file:line): each bounded value is accepted at its limit and refused one past it, each problem
// is reported once at its own line, and a table added after M5 has its keys checked in any file.
import { describe, test, expect } from "vitest";
import {
  addAgentProviderText,
  appendRouteText,
  parseConfig,
  rawUpdatesCheck,
  reloadConfig,
} from "../src/config/config.mjs";
import { compileKeymap } from "../src/keys/keymap.mjs";

// A config.toml whose first line is a comment, so errors are on the lines they always were.
const cfg = (...lines: string[]) => ["# config.toml", ...lines].join("\n") + "\n";
const a = (n: number) => "a".repeat(n);

/** [line, path, message, suggestion?] for each error, or "ok" when the file is valid. */
function problems(text: string) {
  const r = parseConfig(text);
  if (r.config) {
    expect(r.errors).toEqual([]);
    return "ok";
  }
  return r.errors.map((e) => [e.line, e.path, e.message, ...(e.suggestion ? [e.suggestion] : [])]);
}

const NEWER_TABLES = [
  "firefox",
  "panes",
  "bookmarks",
  "routing",
  "panel",
  "private",
  "ui",
  "updates",
  "mcp",
  "search",
  "sites",
  "agent",
  "scroll",
];

/** [line, path, message] for each warning of a file that applies. */
function warned(text: string) {
  const r = parseConfig(text);
  expect(r.errors).toEqual([]);
  return r.warnings.map((e) => [e.line, e.path, e.message]);
}

describe("tables added after M5, in a schema-1 file", () => {
  // An unknown key is skipped with a warning (#1474), except in [updates], which fails closed;
  // [sites] holds a table per host, so its `bogus` is a host, not a key.
  test.each(NEWER_TABLES)("[%s] has its keys checked", (table) => {
    const text = `schema = 1\n[${table}]\nbogus = 1\n`;
    if (table === "sites") {
      expect(problems(text)).toEqual([[3, "sites.bogus", "expected a table, got an integer"]]);
    } else if (table === "updates") {
      expect(problems(text)).toEqual([[3, "updates.bogus", 'unknown key "bogus"']]);
    } else expect(warned(text)).toEqual([[3, `${table}.bogus`, 'unknown key "bogus"; skipped']]);
  });

  test("the same table in a file without a schema line has its keys checked", () => {
    expect(warned(cfg("[firefox]", "bogus = 1"))).toEqual([
      [3, "firefox.bogus", 'unknown key "bogus"; skipped'],
    ]);
  });
});

describe("schema", () => {
  test.each([["schema = 3\n"], ["schema = 99999999999999999999\n"]])("%j is ignored", (text) => {
    expect(problems(text)).toBe("ok");
  });
});

describe("bounded values", () => {
  test.each([
    ["[modal]\ntimeout_ms = 10000\n", "ok"],
    [
      "[modal]\ntimeout_ms = 10001\n",
      [[2, "modal.timeout_ms", "must be an integer between 0 and 10000"]],
    ],
    [`[workspaces.${a(32)}]\n`, "ok"],
    [
      `[workspaces.${a(33)}]\n`,
      [[1, `workspaces.${a(33)}`, "workspace name must be 1 to 32 characters"]],
    ],
    [cfg("[routing]", `default_workspace = "${a(32)}"`), "ok"],
    [
      cfg("[routing]", `default_workspace = "${a(33)}"`),
      [[3, "routing.default_workspace", "workspace name must be 1 to 32 characters"]],
    ],
    [
      cfg("[routing]", 'default_workspace = ""'),
      [[3, "routing.default_workspace", "workspace name must be 1 to 32 characters"]],
    ],
    [
      cfg("[routing]", 'default_workspace = "a\\u0001"'),
      [[3, "routing.default_workspace", "workspace name must not contain control characters"]],
    ],
    [`[theme]\nfont = "${a(200)}"\n`, "ok"],
    [`[theme]\nfont = "${a(201)}"\n`, [[2, "theme.font", "must be 1 to 200 characters"]]],
    ['[theme]\nfont = ""\n', [[2, "theme.font", "must be 1 to 200 characters"]]],
    ['[theme.colors]\nmode = "light"\n', "ok"],
    ['[theme.colors]\nmode = "dark"\n', "ok"],
    ['[theme.colors]\nmode = "dim"\n', [[2, "theme.colors.mode", 'must be "dark" or "light"']]],
    [cfg("[mcp]", "ask_timeout = 300"), "ok"],
    [
      cfg("[mcp]", "ask_timeout = 301"),
      [[3, "mcp.ask_timeout", "must be an integer between 10 and 300 (seconds)"]],
    ],
    [cfg("[mcp]", "open_per_minute = 1"), "ok"],
    [cfg("[mcp]", "open_per_minute = 600"), "ok"],
    [
      cfg("[mcp]", "open_per_minute = 0"),
      [[3, "mcp.open_per_minute", "must be an integer between 1 and 600 (per minute)"]],
    ],
    [
      cfg("[mcp]", "open_per_minute = 601"),
      [[3, "mcp.open_per_minute", "must be an integer between 1 and 600 (per minute)"]],
    ],
    [cfg("[mcp]", "load_per_minute = 1"), "ok"],
    [cfg("[mcp]", "load_per_minute = 600"), "ok"],
    [
      cfg("[mcp]", "load_per_minute = 0"),
      [[3, "mcp.load_per_minute", "must be an integer between 1 and 600 (per minute)"]],
    ],
    [
      cfg("[mcp]", "load_per_minute = 601"),
      [[3, "mcp.load_per_minute", "must be an integer between 1 and 600 (per minute)"]],
    ],
    [cfg("[mcp]", `workspace = "${a(32)}"`), "ok"],
    [cfg("[mcp]", `workspace = "${a(33)}"`), [[3, "mcp.workspace", "must be 1 to 32 characters"]]],
  ])("%j", (text, expected) => {
    expect(problems(text)).toEqual(expected);
  });
});

describe("[mcp] grant_minutes is bounded by the grant_max_minutes in force", () => {
  const over = (max: number) => `must be an integer between 0 and grant_max_minutes (${max})`;
  test.each([
    [["grant_max_minutes = 1", "grant_minutes = 1"], "ok"],
    [["grant_max_minutes = 1", "grant_minutes = 2"], [[4, "mcp.grant_minutes", over(1)]]],
    [["grant_max_minutes = 1440", "grant_minutes = 1440"], "ok"],
    // An invalid grant_max_minutes is reported, and the default (480) bounds grant_minutes.
    [
      ["grant_max_minutes = 1441", "grant_minutes = 1440"],
      [
        [3, "mcp.grant_max_minutes", "must be an integer between 1 and 1440 (minutes)"],
        [4, "mcp.grant_minutes", over(480)],
      ],
    ],
    [
      ["grant_max_minutes = 0", "grant_minutes = 61"],
      [[3, "mcp.grant_max_minutes", "must be an integer between 1 and 1440 (minutes)"]],
    ],
    [["grant_minutes = 480"], "ok"],
    [["grant_minutes = 481"], [[3, "mcp.grant_minutes", over(480)]]],
    [["grant_minutes = -1"], [[3, "mcp.grant_minutes", over(480)]]],
    [["grant_minutes = 1.5"], [[3, "mcp.grant_minutes", "expected an integer, got a float"]]],
  ])("%j", (lines, expected) => {
    expect(problems(cfg("[mcp]", ...lines))).toEqual(expected);
  });
});

describe("[sites] hosts", () => {
  const BAD = 'must be a hostname like "docs.google.com", without scheme, port, path or *';
  test.each([
    ["https://Docs.Example.com:8080/x", "Docs.Example.com"],
    ["*.example.com", "example.com"],
    ["example.com:", "example.com"],
    ["example.com?q", "example.com"],
    ["example.com#x", "example.com"],
    ["ftp://x", "x"],
    ["x.y/", "x.y"],
    // Only a scheme at the start, `*.` at the start and a port at the end are taken off.
    ["1http://a.com", "1http"],
  ])("%j suggests %j", (host, suggestion) => {
    expect(problems(cfg(`[sites."${host}"]`))).toEqual([
      [2, `sites.${JSON.stringify(host)}`, BAD, suggestion],
    ]);
  });

  test.each(["a b", "-x-:80", "a*.example.com", "example.com:80x", "[a.example]"])(
    "%j has no suggestion",
    (host) => {
      expect(problems(cfg(`[sites."${host}"]`))).toEqual([
        [2, `sites.${JSON.stringify(host)}`, BAD],
      ]);
    },
  );

  test.each([
    ["Example.COM", "example.com."],
    ["[::1]", "::1"],
  ])("%j and %j are the same host", (first, second) => {
    expect(problems(cfg(`[sites."${first}"]`, `[sites."${second}"]`))).toEqual([
      [3, `sites."${second}"`, `same host as "${first}"`],
    ]);
  });

  test("a host that ends another is not the same host", () => {
    expect(problems(cfg('[sites."a"]', '[sites."xa"]'))).toBe("ok");
  });
});

describe("[agent]", () => {
  const SECRET =
    "an API key must not be in config.toml: Vimma keeps it in login storage, set in the agent's setup";
  const provider = (name: string, ...more: string[]) => [
    "[[agent.providers]]",
    `name = ${name}`,
    'kind = "openai"',
    'endpoint = "https://api.example.com/v1"',
    'model = "m"',
    ...more,
  ];
  const cli = (...more: string[]) => [
    "[[agent.providers]]",
    'name = "c"',
    'kind = "cli"',
    'cli = "claude-code"',
    ...more,
  ];

  test.each([
    [["[agent]", "default = 5"], [[3, "agent.default", "expected a string, got an integer"]]],
    [
      ["[agent]", 'default = ""'],
      [
        [3, "agent.default", "must be 1 to 32 characters"],
        [3, "agent.default", 'no provider is named ""'],
      ],
    ],
    [["[agent]", "max_cost = 1000"], "ok"],
    [
      ["[agent]", "max_cost = 1000.5"],
      [[3, "agent.max_cost", "must be a number above 0 and at most 1000"]],
    ],
    [
      ["[agent]", "max_cost = 0"],
      [[3, "agent.max_cost", "must be a number above 0 and at most 1000"]],
    ],
    [["[agent]", 'max_cost = "1"'], [[3, "agent.max_cost", "expected a number, got a string"]]],
    [
      ["[agent]", "providers = 1"],
      [[3, "agent.providers", "expected [[agent.providers]] tables, got an integer"]],
    ],
    [
      ["[agent]", "providers = [1]"],
      [[3, "agent.providers[0]", "expected a table, got an integer"]],
    ],
    [["[agent]", 'API_KEY = "x"'], [[3, "agent.API_KEY", SECRET]]],
    // A name that is not a string is reported, and is not counted as a second provider's.
    [
      [...provider("5"), ...provider("5")],
      [
        [3, "agent.providers[0].name", "expected a string, got an integer"],
        [8, "agent.providers[1].name", "expected a string, got an integer"],
      ],
    ],
    [
      provider('"a"', "kind2 = 1"),
      [[7, "agent.providers[0].kind2", 'unknown key "kind2"', "kind"]],
    ],
    [
      [
        "[[agent.providers]]",
        'name = "a"',
        "kind = 1",
        "endpoint = 2",
        'model = "m"',
        'vision = "y"',
        'price_in = "1"',
        "price_out = 1",
      ],
      [
        [4, "agent.providers[0].kind", "expected a string, got an integer"],
        [5, "agent.providers[0].endpoint", "expected a string, got an integer"],
        [7, "agent.providers[0].vision", "expected a boolean, got a string"],
        [8, "agent.providers[0].price_in", "expected a number, got a string"],
      ],
    ],
    [provider('"a"', "price_in = 0", "price_out = 1000000"), "ok"],
    [
      provider('"a"', "price_in = -0.5", "price_out = 1000000.5"),
      [
        [
          7,
          "agent.providers[0].price_in",
          "must be a number from 0 to 1000000 (per million tokens)",
        ],
        [
          8,
          "agent.providers[0].price_out",
          "must be a number from 0 to 1000000 (per million tokens)",
        ],
      ],
    ],
    [provider('"a"', 'Token = "x"'), [[7, "agent.providers[0].Token", SECRET]]],
    [
      [...cli().map((l) => l.replace('"c"', '""')), ...cli().map((l) => l.replace('"c"', '""'))],
      [
        [3, "agent.providers[0].name", "must be 1 to 32 characters"],
        [7, "agent.providers[1].name", "must be 1 to 32 characters"],
      ],
    ],
    [cli("max_minutes = 1"), "ok"],
    [
      cli("max_minutes = 0"),
      [[6, "agent.providers[0].max_minutes", "must be an integer between 1 and 1440 (minutes)"]],
    ],
    // An unknown key is skipped with a warning (#1474): the provider applies.
    [cli("bogus = 1"), "ok"],
    [cli("SECRET = 1"), [[6, "agent.providers[0].SECRET", SECRET]]],
  ])("%j", (lines, expected) => {
    expect(problems(cfg(...lines))).toEqual(expected);
  });

  test.each([
    ['kind = "openai"', 'endpoint = "https://a.example/v1"'],
    ['kind = "openai"', 'model = "m"'],
    ['endpoint = "https://a.example/v1"', 'model = "m"'],
  ])("a provider without one of kind, endpoint and model: %s, %s", (...lines) => {
    expect(problems(cfg("[[agent.providers]]", 'name = "x"', ...lines))).toEqual([
      [2, "agent.providers[0]", 'a provider needs "kind", "endpoint" and "model"'],
    ]);
  });

  test("an unknown agent CLI is a warning that lists the known ones", () => {
    const r = parseConfig(cfg(...cli().map((l) => l.replace("claude-code", "nope"))));
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.message)).toEqual([
      'unknown agent CLI "nope": this provider is skipped (this version knows "claude-code", "codex" or "gemini")',
    ]);
  });
});

describe("keymap errors name the action as written", () => {
  test("an alias's error keeps the alias; another key's error is not renamed", () => {
    expect(problems('[keys]\nprev_workspace = ["bogus+key"]\n')).toEqual([
      [2, "keys.prev_workspace[0]", 'unknown modifier "bogus" in "bogus+key"'],
    ]);
    expect(problems('[keys]\nprev_workspace = ["ctrl+p"]\nnew_tab = ["bogus+key"]\n')).toEqual([
      [3, "keys.new_tab[0]", 'unknown modifier "bogus" in "bogus+key"'],
    ]);
  });

  test("unbind takes a list", () => {
    expect(problems('[unbind]\nnormal = "x"\n')).toEqual([
      [2, "unbind.normal", "expected a list of key strings, got a string"],
    ]);
  });
});

describe("reloadConfig", () => {
  test("a file with errors keeps Linux's default keymap and no warnings", () => {
    const r = reloadConfig(null, "[bad");
    expect(r.kept).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.active.keymap.keysFor("history_back")).toEqual(
      compileKeymap({}, { mac: false }).keysFor("history_back"),
    );
    expect(r.active.keymap.keysFor("history_back")).not.toContain("meta+left");
  });
});

describe("rawUpdatesCheck: a stray check", () => {
  test.each([
    ["[ui]\ncheck = true\n", null],
    ["[ui.x]\ncheck = false\n", null],
    ["[[routes]]\ndomain = 'a'\nworkspace = 'w'\ncheck = true\n", null],
    ["[ui]\ncheck = 1\n", "missing"],
    ["[ui]\nchecks = true\n", "missing"],
    ["[updates]\ncheck = false\n", false],
  ])("%j reads as %j", (text, expected) => {
    expect(rawUpdatesCheck(`schema = 2\n${text}`)).toBe(expected);
  });
});

describe("appendRouteText", () => {
  const rule = { domain: "a.com", workspace: "w" };
  const block = '[[routes]]\ndomain = "a.com"\nworkspace = "w"\n';

  test("a file without a final newline gets a blank line before the rule", () => {
    expect(appendRouteText("schema = 2", rule)).toEqual({ append: `\n\n${block}` });
    expect(appendRouteText("schema = 2\n", rule)).toEqual({ append: `\n${block}` });
  });

  test("a schema-1 file takes the rule too", () => {
    expect(appendRouteText("schema = 1\n", rule)).toEqual({ append: `\n${block}` });
  });
});

describe("addAgentProviderText: what is written", () => {
  const o = {
    name: "o",
    kind: "openai",
    endpoint: "http://127.0.0.1:11434/v1",
    model: "m",
    vision: false,
  };
  const block = (name: string, kind = "openai", endpoint = o.endpoint, ...more: string[]) =>
    [
      "[[agent.providers]]",
      `name = "${name}"`,
      `kind = "${kind}"`,
      `endpoint = "${endpoint}"`,
      'model = "m"',
      ...more,
    ].join("\n") + "\n";
  const two = `schema = 2\n${block("o")}${block("o-2", "anthropic")}`;

  test("prices are written only as a pair; vision always", () => {
    expect(
      addAgentProviderText(
        "schema = 2",
        { ...o, priceIn: 1, priceOut: 2.5 },
        { makeDefault: false },
      ),
    ).toEqual({
      added: expect.any(Array),
      text: `schema = 2\n\n${block("o", "openai", o.endpoint, "vision = false", "price_in = 1", "price_out = 2.5")}`,
      name: "o",
    });
    expect(
      addAgentProviderText(
        "schema = 2\n",
        { ...o, vision: true, priceIn: 1 },
        { makeDefault: false },
      ),
    ).toEqual({
      added: expect.any(Array),
      text: `schema = 2\n\n${block("o", "openai", o.endpoint, "vision = true")}`,
      name: "o",
    });
  });

  test("a provider is the same only by kind, endpoint and model; a new one is numbered", () => {
    const endpoint = "http://127.0.0.1:9/v1";
    expect(addAgentProviderText(two, { ...o, endpoint }, { makeDefault: false })).toEqual({
      added: expect.any(Array),
      text: `${two}\n${block("o-3", "openai", endpoint, "vision = false")}`,
      name: "o-3",
    });
    expect(addAgentProviderText(two, { ...o, kind: "anthropic" }, { makeDefault: false })).toEqual({
      added: expect.any(Array),
      text: two,
      name: "o-2",
    });
  });

  test("a default already naming the provider is left as it is, quotes and all", () => {
    const text = `schema = 2\n[agent]\ndefault = 'o'\n${block("o")}`;
    expect(addAgentProviderText(text, o, { makeDefault: true })).toEqual({
      added: expect.any(Array),
      text,
      name: "o",
    });
  });

  test("[agent] goes before the first providers header, however it is spaced", () => {
    const text = `schema = 2\n${block("z", "openai", "http://127.0.0.1:1/v1").replace("[[agent.providers]]", "  [[ agent . providers ]]")}`;
    const r = addAgentProviderText(text, o, { makeDefault: true });
    expect(r).toEqual({
      added: expect.any(Array),
      text: `schema = 2\n[agent]\ndefault = "o"\n\n${text.slice("schema = 2\n".length)}\n${block("o", "openai", o.endpoint, "vision = false")}`,
      name: "o",
    });
  });

  test("an inline agent table cannot take a default", () => {
    expect(
      addAgentProviderText("schema = 2\nagent = { max_steps = 5 }\n", o, { makeDefault: true }),
    ).toEqual({
      error:
        'config.toml cannot take [agent] default: agent is an inline table ({ … }); set default = "o" in it by hand, or write it as a [agent] table',
    });
  });
});

describe("config edges", () => {
  test("a table where a key string belongs is named a table", () => {
    expect(problems("[modal]\nleader = {}\n")).toEqual([
      [2, "modal.leader", "expected a key string, got a table"],
    ]);
  });

  test("hint_chars takes two distinct characters", () => {
    expect(problems(cfg("[modal]", 'hint_chars = "ab"'))).toBe("ok");
    expect(problems(cfg("[modal]", 'hint_chars = "aa"'))).toEqual([
      [
        3,
        "modal.hint_chars",
        "must be at least 2 distinct characters, none uppercase or whitespace",
      ],
    ]);
  });

  test("provider names and models are bounded", () => {
    const provider = (name: string, model: string) =>
      cfg(
        "[[agent.providers]]",
        `name = "${name}"`,
        'kind = "openai"',
        'endpoint = "https://a.example/v1"',
        `model = "${model}"`,
      );
    expect(problems(provider(a(32), a(200)))).toBe("ok");
    expect(problems(provider(a(33), a(201)))).toEqual([
      [3, "agent.providers[0].name", "must be 1 to 32 characters"],
      [6, "agent.providers[0].model", "must be 1 to 200 characters"],
    ]);
  });

  test("integer prices come out as numbers", () => {
    const r = parseConfig(
      cfg(
        "[[agent.providers]]",
        'name = "a"',
        'kind = "openai"',
        'endpoint = "https://a.example/v1"',
        'model = "m"',
        "price_in = 1",
        "price_out = 2",
      ),
    );
    expect(r.config?.agent.providers[0]).toMatchObject({ priceIn: 1, priceOut: 2 });
  });

  test("keys left out of a workspace or [theme] are absent, not undefined", () => {
    const c = parseConfig('[workspaces.w]\ncolor = "blue"\n').config;
    expect(Object.keys(c?.workspaces[0] ?? {}).sort()).toEqual([
      "autofill",
      "color",
      "icon",
      "name",
    ]);
    expect(Object.keys(c?.theme ?? {}).sort()).toEqual(["colors", "font", "name", "source"]);
  });

  test("a file that does not parse has no warnings", () => {
    expect(parseConfig("[bad").warnings).toEqual([]);
  });

  test("another agent CLI is a provider of its own", () => {
    const cc = 'schema = 2\n\n[[agent.providers]]\nname = "c"\nkind = "cli"\ncli = "claude-code"\n';
    const codex = { name: "c", kind: "cli", cli: "codex", endpoint: "", model: "", vision: false };
    expect(addAgentProviderText(cc, codex, { makeDefault: false })).toEqual({
      added: expect.any(Array),
      text: `${cc}\n[[agent.providers]]\nname = "c-2"\nkind = "cli"\ncli = "codex"\n`,
      name: "c-2",
    });
  });
});
