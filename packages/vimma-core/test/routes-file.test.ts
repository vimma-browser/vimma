// routes.toml, the routes file beside config.toml (docs/specs/routes-file.md): parsed and
// validated as config.toml's `[[routes]]` are, preferred over config.toml's rules when it exists,
// appended to by `:route add`, and filled by moving config.toml's rules on the first one.
import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config/config.mjs";
import { resolveRoutes } from "../src/config/routes.mjs";
import {
  MAX_ROUTES_FILE_BYTES,
  ROUTES_FILE,
  appendRouteFileText,
  inlineRoutes,
  moveRoutesText,
  parseRoutesFile,
  routesInForce,
} from "../src/config/routes-file.mjs";

const rule = { domain: "example.org", workspace: "work" };
const block = '[[routes]]\ndomain = "example.org"\nworkspace = "work"\n';

describe("parseRoutesFile", () => {
  test("parseRoutesFile reads [[routes]] and [routing] as config.toml does", () => {
    const text = [
      "[routing]",
      'default_workspace = "personal"',
      "",
      "[[routes]]",
      'domain = "GitHub.com"',
      'workspace = "work"',
      "",
      "[[routes]]",
      'app = "Slack"',
      'workspace = "work"',
      "",
    ].join("\n");
    const r = parseRoutesFile(text);
    expect(r.errors).toEqual([]);
    expect(r.defaultWorkspace).toBe("personal");
    expect(r.lines).toEqual([4, 8]);
    const inConfig = parseConfig(`schema = 2\n${text}`);
    expect(r.routes).toEqual(inConfig.config?.routes);
    expect(r.routes).toEqual(
      resolveRoutes([
        { domain: "GitHub.com", workspace: "work" },
        { app: "Slack", workspace: "work" },
      ]),
    );
  });

  test("a bad rule is an error at its line, named in routes.toml", () => {
    const r = parseRoutesFile('[[routes]]\ndomain = "https://github.com/x"\nworkspace = "w"\n');
    expect(r.routes).toBeNull();
    expect(r.errors).toEqual([
      expect.objectContaining({
        file: ROUTES_FILE,
        line: 2,
        path: "routes[0].domain",
        suggestion: "github.com",
      }),
    ]);
  });

  test("a bad default_workspace and an unknown [routing] key are errors", () => {
    const r = parseRoutesFile('[routing]\ndefault_workspace = 3\ndefualt = "x"\n');
    expect(r.routes).toBeNull();
    expect(r.errors.map((e) => [e.line, e.path, e.message])).toEqual([
      [2, "routing.default_workspace", "expected a string, got an integer"],
      [3, "routing.defualt", 'unknown key "defualt"'],
    ]);
    expect(parseRoutesFile('[routing]\ndefault_workspace = ""\n').errors[0]?.message).toBe(
      "workspace name must be 1 to 32 characters",
    );
    expect(parseRoutesFile("routing = 1\n").errors[0]?.message).toBe(
      "expected a table, got an integer",
    );
  });

  test("parseRoutesFile refuses another top-level key at its line", () => {
    const r = parseRoutesFile(
      '[[routes]]\ndomain = "a.example"\nworkspace = "w"\n\n[keys]\nx = "y"\n',
    );
    expect(r.routes).toBeNull();
    expect(r.errors).toEqual([
      {
        file: ROUTES_FILE,
        line: 5,
        path: "keys",
        message: "routes.toml holds only [[routes]] and [routing]",
      },
    ]);
    expect(parseRoutesFile("schema = 2\n").errors[0]?.path).toBe("schema");
  });

  test("a syntax error is reported with its line", () => {
    const r = parseRoutesFile("[[routes]\n");
    expect(r.routes).toBeNull();
    expect(r.errors[0]).toEqual(expect.objectContaining({ file: ROUTES_FILE, line: 1, path: "" }));
  });

  test("parseRoutesFile refuses a file over 1 MiB", () => {
    expect(MAX_ROUTES_FILE_BYTES).toBe(1024 * 1024);
    const big = `# ${"x".repeat(MAX_ROUTES_FILE_BYTES)}\n`;
    const r = parseRoutesFile(big);
    expect(r.routes).toBeNull();
    expect(r.errors).toEqual([
      { file: ROUTES_FILE, path: "", message: "larger than 1 MiB; not read" },
    ]);
  });

  test("an empty routes.toml has no rules", () => {
    expect(parseRoutesFile("")).toEqual({
      routes: [],
      defaultWorkspace: null,
      lines: [],
      errors: [],
    });
    expect(parseRoutesFile("# nothing yet\n").routes).toEqual([]);
  });
});

describe("parseConfig with routesFile", () => {
  test("parseConfig with routesFile leaves out routes, even invalid ones", () => {
    const text = 'schema = 2\n[[routes]]\ndomain = "not a host"\nworkspace = "w"\n';
    expect(parseConfig(text).errors).toHaveLength(1);
    const r = parseConfig(text, { routesFile: true });
    expect(r.errors).toEqual([]);
    expect(r.config?.routes).toEqual([]);
    const inline = parseConfig('routes = [{ domain = "a.example", workspace = "w" }]\n', {
      routesFile: true,
    });
    expect(inline.config?.routes).toEqual([]);
  });

  test("it still validates and applies config.toml's [routing]", () => {
    const text = '[routing]\ndefault_workspace = "work"\n';
    expect(parseConfig(text, { routesFile: true }).config?.routing.defaultWorkspace).toBe("work");
    expect(
      parseConfig("[routing]\ndefault_workspace = 1\n", { routesFile: true }).errors,
    ).toHaveLength(1);
  });
});

describe("inlineRoutes", () => {
  test("inlineRoutes finds [[routes]], an inline routes array and default_workspace", () => {
    expect(
      inlineRoutes('# c\n[routing]\ndefault_workspace = "w"\n\n[[routes]]\ndomain = "a.b"\n'),
    ).toEqual({ routes: 5, defaultWorkspace: 3 });
    expect(inlineRoutes('\nroutes = [{ domain = "a.b", workspace = "w" }]\n')).toEqual({
      routes: 2,
      defaultWorkspace: null,
    });
    expect(inlineRoutes("schema = 2\n")).toEqual({ routes: null, defaultWorkspace: null });
    expect(inlineRoutes("[[routes]\n")).toEqual({ routes: null, defaultWorkspace: null });
  });
});

describe("routesInForce", () => {
  const configText = [
    "schema = 2",
    "[routing]",
    'default_workspace = "cfg"',
    "",
    "[[routes]]",
    'domain = "a.example"',
    'workspace = "cfg"',
    "",
  ].join("\n");
  const config = parseConfig(configText).config;
  if (!config) throw new Error("the config parses");

  test("without routes.toml, config.toml's rules and default apply", () => {
    expect(routesInForce({ config, configText, file: null })).toEqual({
      file: "config.toml",
      routes: config.routes,
      lines: [5],
      defaultWorkspace: "cfg",
      warnings: [],
    });
  });

  test("with routes.toml, its rules apply and config.toml's draw one warning", () => {
    const file = parseRoutesFile('[[routes]]\ndomain = "b.example"\nworkspace = "rt"\n');
    const r = routesInForce({ config, configText, file });
    expect(r.file).toBe(ROUTES_FILE);
    expect(r.routes).toEqual(file.routes);
    expect(r.lines).toEqual([1]);
    expect(r.warnings).toEqual([
      { line: 5, path: "", message: "routes ignored: routes.toml is the routes file" },
    ]);
  });

  test("routes.toml's default_workspace wins; config.toml's applies when routes.toml has none", () => {
    const without = parseRoutesFile("");
    expect(routesInForce({ config, configText, file: without }).defaultWorkspace).toBe("cfg");
    const withDefault = parseRoutesFile('[routing]\ndefault_workspace = "rt"\n');
    const r = routesInForce({ config, configText, file: withDefault });
    expect(r.defaultWorkspace).toBe("rt");
    expect(r.warnings).toContainEqual({
      line: 3,
      path: "",
      message: "routing.default_workspace ignored: routes.toml sets it",
    });
  });

  test("a routes.toml never read well yet applies no rule, never config.toml's", () => {
    const broken = parseRoutesFile("[[routes]\n");
    const r = routesInForce({ config, configText, file: broken });
    expect(r.routes).toEqual([]);
    expect(r.defaultWorkspace).toBe("cfg");
  });
});

describe("appendRouteFileText", () => {
  test("appendRouteFileText appends a quoted block, creates a missing file, refuses a broken one", () => {
    expect(appendRouteFileText(null, rule)).toEqual({ create: block });
    expect(appendRouteFileText("", rule)).toEqual({ append: block });
    expect(appendRouteFileText("# mine\n", rule)).toEqual({ append: `\n${block}` });
    expect(appendRouteFileText("# mine", rule)).toEqual({ append: `\n\n${block}` });
    expect(appendRouteFileText("[[routes]\n", rule)).toEqual({
      error: "routes.toml does not parse now; fix it first",
    });
    const odd = appendRouteFileText(null, { domain: "a.example", workspace: 'x" [keys] y = "z' });
    expect("create" in odd && parseRoutesFile(odd.create).routes).toEqual(
      resolveRoutes([{ domain: "a.example", workspace: 'x" [keys] y = "z' }]),
    );
  });

  test("a rule the file would refuse is refused with the reason", () => {
    expect(appendRouteFileText("", { domain: "a.example", workspace: "" })).toEqual({
      error:
        "routes.toml does not parse with the rule added: routes[0].workspace: workspace name must be 1 to 32 characters",
    });
  });
});

describe("moveRoutesText", () => {
  const config = [
    "schema = 2",
    "",
    "[keys]",
    'new_tab = "t"',
    "",
    "# Work sites",
    "[[routes]]",
    'domain = "github.com"',
    "# the company's",
    'workspace = "work"',
    "",
    "# not about routes",
    "",
    "[theme]",
    'font = "monospace"',
    "",
    "[[routes]]   # chat",
    'app = "slack"',
    'workspace = "work"',
    "",
  ].join("\n");

  test("moveRoutesText keeps order, the comments inside and above each rule, and every other line", () => {
    const r = moveRoutesText(config, rule);
    if ("error" in r) throw new Error(r.error);
    expect(r.moved).toEqual({ rules: 2, defaultWorkspace: false });
    expect(r.routes).toBe(
      [
        "# Work sites",
        "[[routes]]",
        'domain = "github.com"',
        "# the company's",
        'workspace = "work"',
        "",
        "[[routes]]   # chat",
        'app = "slack"',
        'workspace = "work"',
        "",
        block,
      ].join("\n"),
    );
    expect(r.config).toBe(
      [
        "schema = 2",
        "",
        "[keys]",
        'new_tab = "t"',
        "",
        "# Moved to routes.toml by :route add; routes.toml is the routes file now.",
        "# # Work sites",
        "# [[routes]]",
        '# domain = "github.com"',
        "# # the company's",
        '# workspace = "work"',
        "",
        "# not about routes",
        "",
        "[theme]",
        'font = "monospace"',
        "",
        "# [[routes]]   # chat",
        '# app = "slack"',
        '# workspace = "work"',
        "",
      ].join("\n"),
    );
    const before = parseConfig(config).config;
    const after = parseConfig(r.config).config;
    expect(after?.routes).toEqual([]);
    expect({ ...after, routes: [] }).toEqual({ ...before, routes: [] });
  });

  test("moveRoutesText comments out [routing] only when default_workspace was its only key", () => {
    const only = moveRoutesText('[routing]\ndefault_workspace = "w"\n', rule);
    if ("error" in only) throw new Error(only.error);
    expect(only.moved).toEqual({ rules: 0, defaultWorkspace: true });
    expect(only.config).toBe(
      '# Moved to routes.toml by :route add; routes.toml is the routes file now.\n# [routing]\n# default_workspace = "w"\n',
    );
    expect(only.routes).toBe(`[routing]\ndefault_workspace = "w"\n\n${block}`);
    expect(parseRoutesFile(only.routes).defaultWorkspace).toBe("w");
  });

  test("default_workspace goes first, under its own header, then the rules", () => {
    const r = moveRoutesText(
      '[routing]\ndefault_workspace = "w"\n\n[[routes]]\ndomain = "a.example"\nworkspace = "w"\n',
      rule,
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.config.split("\n").slice(0, 3)).toEqual([
      "# Moved to routes.toml by :route add; routes.toml is the routes file now.",
      "# [routing]",
      '# default_workspace = "w"',
    ]);
    expect(r.routes.startsWith('[routing]\ndefault_workspace = "w"\n\n[[routes]]\n')).toBe(true);
    expect(r.moved).toEqual({ rules: 1, defaultWorkspace: true });
  });

  test("moveRoutesText refuses an inline routes array and a config.toml that does not parse", () => {
    expect(moveRoutesText('routes = [{ domain = "a.b", workspace = "w" }]\n', rule)).toEqual({
      error: "config.toml's routes are an inline array; move them to routes.toml by hand",
    });
    expect(moveRoutesText("[[routes]\n", rule)).toEqual({
      error: "config.toml does not parse now; fix it first (:config shows it)",
    });
    expect(moveRoutesText('routing = { default_workspace = "w" }\n', rule)).toEqual({
      error:
        "config.toml's default_workspace is not under a [routing] header; move them to routes.toml by hand",
    });
  });

  test("a moved routes.toml resolves to the old rules plus the new one", () => {
    const r = moveRoutesText(config, rule);
    if ("error" in r) throw new Error(r.error);
    const old = parseConfig(config).config?.routes ?? [];
    expect(parseRoutesFile(r.routes).routes).toEqual([
      ...old,
      ...resolveRoutes([rule]).map((x) => ({ ...x, index: old.length + 1 })),
    ]);
  });

  test("a multi-line string in a rule is moved whole", () => {
    const text = '[[routes]]\ndomain = "a.example"\nworkspace = """\nw"""\n';
    const r = moveRoutesText(text, rule);
    if ("error" in r) throw new Error(r.error);
    expect(parseRoutesFile(r.routes).routes?.[0]?.workspace).toBe("w");
    expect(parseConfig(r.config).config?.routes).toEqual([]);
  });
});
