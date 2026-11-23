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
  formatRoutesCache,
  inlineRoutes,
  parseRoutesCache,
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

  test("it leaves out config.toml's [routing] too, even an invalid one", () => {
    const text = "[routing]\ndefault_workspace = 1\n";
    expect(parseConfig(text).errors).toHaveLength(1);
    const r = parseConfig(text, { routesFile: true });
    expect(r.errors).toEqual([]);
    expect(r.config?.routing.defaultWorkspace).toBeNull();
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
      {
        line: 3,
        path: "",
        message: "routing.default_workspace ignored: routes.toml is the routes file",
      },
      { line: 5, path: "", message: "routes ignored: routes.toml is the routes file" },
    ]);
  });

  test("routes.toml owns [routing]: config.toml's default_workspace never applies", () => {
    const without = routesInForce({ config, configText, file: parseRoutesFile("") });
    expect(without.defaultWorkspace).toBeNull();
    expect(without.warnings).toContainEqual({
      line: 3,
      path: "",
      message: "routing.default_workspace ignored: routes.toml is the routes file",
    });
    const withDefault = parseRoutesFile('[routing]\ndefault_workspace = "rt"\n');
    expect(routesInForce({ config, configText, file: withDefault }).defaultWorkspace).toBe("rt");
  });

  test("a routes.toml never read well yet applies no rule, never config.toml's", () => {
    const broken = parseRoutesFile("[[routes]\n");
    const r = routesInForce({ config, configText, file: broken });
    expect(r.routes).toEqual([]);
    expect(r.defaultWorkspace).toBeNull();
  });
});

describe("appendRouteFileText", () => {
  test("appendRouteFileText appends a quoted block and refuses a broken file", () => {
    expect(appendRouteFileText("", rule)).toEqual({ append: block });
    expect(appendRouteFileText("# mine\n", rule)).toEqual({ append: `\n${block}` });
    expect(appendRouteFileText("# mine", rule)).toEqual({ append: `\n\n${block}` });
    expect(appendRouteFileText("[[routes]\n", rule)).toEqual({
      error: "routes.toml does not parse now; fix it first",
    });
    const odd = appendRouteFileText("", { domain: "a.example", workspace: 'x" [keys] y = "z' });
    expect("append" in odd && parseRoutesFile(odd.append).routes).toEqual(
      resolveRoutes([{ domain: "a.example", workspace: 'x" [keys] y = "z' }]),
    );
  });

  test("appendRouteFileText keeps a CRLF file's line endings", () => {
    const crlf = '[[routes]]\r\ndomain = "b.example"\r\nworkspace = "w"\r\n';
    const r = appendRouteFileText(crlf, rule);
    expect(r).toEqual({ append: `\r\n${block.replaceAll("\n", "\r\n")}` });
    expect(parseRoutesFile(crlf + ("append" in r ? r.append : "")).routes).toHaveLength(2);
  });

  test("a rule the file would refuse is refused with the reason", () => {
    expect(appendRouteFileText("", { domain: "a.example", workspace: "" })).toEqual({
      error:
        "routes.toml does not parse with the rule added: routes[0].workspace: workspace name must be 1 to 32 characters",
    });
  });
});

describe("the routes cache (vimma.routes.cache)", () => {
  const routes = resolveRoutes([{ domain: "a.example", workspace: "w" }]);

  test("it records which file its rules came from", () => {
    const text = formatRoutesCache(routes, "routes.toml");
    expect(parseRoutesCache(text)).toEqual({ file: "routes.toml", routes });
    expect(parseRoutesCache(formatRoutesCache([], "config.toml"))).toEqual({
      file: "config.toml",
      routes: [],
    });
  });

  test("an older cache, a bare array, holds config.toml's rules", () => {
    expect(parseRoutesCache(JSON.stringify(routes))).toEqual({ file: "config.toml", routes });
  });

  test("anything else is no rule from config.toml", () => {
    for (const text of ["", "{", "3", '{"file":"x.toml","routes":[]}', '{"routes":{}}']) {
      expect(parseRoutesCache(text)).toEqual({ file: "config.toml", routes: [] });
    }
  });
});
