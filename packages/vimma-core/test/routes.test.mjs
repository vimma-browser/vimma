// Workspace routing rules (spec workspace-routing): `[[routes]]` in config.toml, matched by
// domain, URL prefix or the application that opened the link; the first match wins.
import { describe, expect, test } from "vitest";
import { appendRouteText, parseConfig } from "../src/config.mjs";
import { formatConfigTemplate } from "../src/defaults.mjs";
import {
  describeRoute,
  isAppToken,
  matchRoute,
  resolveRoutes,
  routeDomainFor,
  validateRoutes,
} from "../src/routes.mjs";

/** @param {string[]} lines */
const v2 = (...lines) => ["schema = 2", ...lines].join("\n") + "\n";

/** @param {string} text */
function config(text) {
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

/** @param {Record<string, string>[]} raw */
const routes = (raw) => {
  expect(validateRoutes(raw)).toEqual([]);
  return resolveRoutes(raw);
};

/**
 * The workspace the first matching rule names, or null.
 * @param {Record<string, string>[]} raw
 * @param {string} url
 * @param {string | null} [app]
 */
const target = (raw, url, app = null) => matchRoute(routes(raw), { url, app })?.workspace ?? null;

describe("[[routes]] in config.toml", () => {
  test("are read in file order, with their rule number", () => {
    const c = config(
      v2(
        "[[routes]]",
        'domain = "github.com"',
        'workspace = "work"',
        "",
        "[[routes]]",
        'app = "Slack"',
        'workspace = "work"',
        "",
        "[[routes]]",
        'url = "file:///home/me/work/"',
        'workspace = "notes"',
      ),
    );
    expect(c.routes).toEqual([
      { index: 1, workspace: "work", domain: { host: "github.com", sub: false, ip: false } },
      { index: 2, workspace: "work", app: "slack" },
      { index: 3, workspace: "notes", url: "file:///home/me/work/" },
    ]);
  });

  test("no rules by default", () => {
    expect(config(v2()).routes).toEqual([]);
  });

  test("are new in schema 2", () => {
    expect(errors('[[routes]]\ndomain = "a.com"\nworkspace = "w"\n')).toEqual([
      { line: 1, path: "routes", message: expect.stringMatching(/new in schema 2/) },
    ]);
  });

  test("errors name the rule and the line", () => {
    expect(
      errors(
        v2(
          "[[routes]]",
          'domain = "https://github.com/x"',
          'workspace = "work"',
          "[[routes]]",
          'workspace = "work"',
          "[[routes]]",
          'domain = "a.com"',
          'url = "https://a.com/"',
          'workspace = "w"',
          "[[routes]]",
          'app = "my app"',
          'workspace = "w"',
          "[[routes]]",
          'domain = "a.com"',
          "[[routes]]",
          'domian = "a.com"',
          'workspace = "w"',
          "[[routes]]",
          'url = "javascript:alert(1)"',
          'workspace = "w"',
          "[[routes]]",
          'domain = "a.com"',
          "workspace = 3",
        ),
      ),
    ).toEqual([
      {
        line: 3,
        path: "routes[0].domain",
        message: expect.stringMatching(/hostname like/),
        suggestion: "github.com",
      },
      {
        line: 5,
        path: "routes[1]",
        message: 'a rule needs domain, url or app (and "workspace")',
      },
      { line: 9, path: "routes[2].url", message: "use domain or url, not both" },
      { line: 12, path: "routes[3].app", message: expect.stringMatching(/application name/) },
      { line: 14, path: "routes[4]", message: 'missing "workspace"' },
      {
        line: 17,
        path: "routes[5].domian",
        message: 'unknown key "domian"',
        suggestion: "domain",
      },
      { line: 20, path: "routes[6].url", message: expect.stringMatching(/a URL like/) },
      { line: 24, path: "routes[7].workspace", message: "expected a string, got an integer" },
    ]);
  });

  test("routes must be an array of tables", () => {
    expect(errors(v2('routes = "github.com"'))).toEqual([
      { line: 2, path: "routes", message: "expected [[routes]] tables, got a string" },
    ]);
    expect(errors(v2('routes = ["github.com"]'))).toEqual([
      { line: 2, path: "routes[0]", message: "expected a table, got a string" },
    ]);
  });

  test("a workspace name is checked as [workspaces] checks it", () => {
    expect(errors(v2("[[routes]]", 'domain = "a.com"', `workspace = "${"w".repeat(33)}"`))).toEqual(
      [
        {
          line: 4,
          path: "routes[0].workspace",
          message: "workspace name must be 1 to 32 characters",
        },
      ],
    );
  });
});

describe("domain rules", () => {
  const github = [{ domain: "github.com", workspace: "work" }];

  test("match the host and its subdomains, on label boundaries", () => {
    expect(target(github, "https://github.com/vimma-browser/vimma")).toBe("work");
    expect(target(github, "https://api.github.com/")).toBe("work");
    expect(target(github, "http://a.b.github.com/")).toBe("work");
    expect(target(github, "https://notgithub.com/")).toBeNull();
    expect(target(github, "https://github.com.evil.example/")).toBeNull();
    expect(target(github, "https://evil.example/?github.com")).toBeNull();
  });

  test("ignore ports, case and a trailing dot", () => {
    expect(target(github, "https://GitHub.COM:8443/x")).toBe("work");
    expect(target(github, "https://github.com./")).toBe("work");
    expect(target([{ domain: "GitHub.com.", workspace: "w" }], "https://github.com/")).toBe("w");
  });

  test('"*." matches only subdomains', () => {
    const corp = [{ domain: "*.corp.example", workspace: "work" }];
    expect(target(corp, "https://jira.corp.example/")).toBe("work");
    expect(target(corp, "https://a.b.corp.example/")).toBe("work");
    expect(target(corp, "https://corp.example/")).toBeNull();
    expect(resolveRoutes(corp)[0]?.domain).toEqual({
      host: "corp.example",
      sub: true,
      ip: false,
    });
  });

  test("compare IDN as punycode, written either way", () => {
    const unicode = [{ domain: "bücher.example", workspace: "w" }];
    const puny = [{ domain: "xn--bcher-kva.example", workspace: "w" }];
    expect(target(unicode, "https://xn--bcher-kva.example/")).toBe("w");
    expect(target(unicode, "https://shop.bücher.example/")).toBe("w");
    expect(target(puny, "https://bücher.example/")).toBe("w");
    expect(target(unicode, "https://bucher.example/")).toBeNull();
  });

  test("IP literals match only themselves", () => {
    const v4 = [{ domain: "10.0.0.5", workspace: "lab" }];
    expect(target(v4, "http://10.0.0.5:8080/")).toBe("lab");
    expect(target(v4, "http://110.0.0.5/")).toBeNull();
    expect(target(v4, "http://x.10.0.0.5/")).toBeNull();
    for (const domain of ["::1", "[::1]"]) {
      expect(target([{ domain, workspace: "lab" }], "http://[::1]:3000/")).toBe("lab");
    }
    // The URL parser reads "0.5" as 0.0.0.5: a rule must be written as the address it matches.
    expect(validateRoutes([{ domain: "0.5", workspace: "w" }])).toHaveLength(1);
    expect(validateRoutes([{ domain: "*.10.0.0.5", workspace: "w" }])).toHaveLength(1);
  });

  test("never match about:, file:, data: or other schemes", () => {
    const any = [{ domain: "localhost", workspace: "w" }];
    expect(target(any, "http://localhost:8000/")).toBe("w");
    expect(target(any, "file://localhost/etc/hosts")).toBeNull();
    expect(target(github, "view-source:https://github.com/")).toBeNull();
    expect(target(github, "about:newtab")).toBeNull();
    expect(target(github, "not a url")).toBeNull();
  });

  test("refuse what is not a hostname, with a suggestion", () => {
    /** @param {string} domain */
    const problem = (domain) => validateRoutes([{ domain, workspace: "w" }])[0];
    expect(problem("github.com:443")).toMatchObject({ suggestion: "github.com" });
    expect(problem("*github.com")).toMatchObject({ path: [0, "domain"] });
    expect(problem("a.*.com")).toBeDefined();
    expect(problem("")).toBeDefined();
    expect(problem("user@github.com")).toBeDefined();
    expect(problem("-bad-.com")).toBeDefined();
  });
});

describe("url rules", () => {
  test("are a prefix of the parsed URL, any scheme", () => {
    const notes = [{ url: "file:///home/me/work/", workspace: "notes" }];
    expect(target(notes, "file:///home/me/work/todo.md")).toBe("notes");
    expect(target(notes, "file:///home/me/workshop/")).toBeNull();
    expect(
      target([{ url: "about:preferences", workspace: "w" }], "about:preferences#privacy"),
    ).toBe("w");
  });

  test("end on a boundary: a path segment, a query, a fragment or the end", () => {
    const app = [{ url: "https://example.com/app", workspace: "w" }];
    expect(target(app, "https://example.com/app")).toBe("w");
    expect(target(app, "https://example.com/app/x")).toBe("w");
    expect(target(app, "https://example.com/app?x=1")).toBe("w");
    expect(target(app, "https://example.com/app#top")).toBe("w");
    expect(target(app, "https://example.com/apples")).toBeNull();
    expect(target(app, "https://example.com/app.html")).toBeNull();
    // A prefix that ends in "/" is its own boundary.
    const dir = [{ url: "file:///home/me/work/", workspace: "w" }];
    expect(target(dir, "file:///home/me/work/a.md")).toBe("w");
    expect(target([{ url: "about:pref", workspace: "w" }], "about:preferences")).toBeNull();
  });

  test("normalise the prefix as the URL parser does", () => {
    const gh = [{ url: "HTTPS://GitHub.com", workspace: "w" }];
    expect(resolveRoutes(gh)[0]?.url).toBe("https://github.com/");
    expect(target(gh, "https://github.com/x")).toBe("w");
    expect(target(gh, "https://github.com.evil.example/")).toBeNull();
  });
});

describe("rule values", () => {
  test("a url that does not parse, or a workspace name with a control character", () => {
    expect(validateRoutes([{ url: "http://[bad", workspace: "w" }])).toEqual([
      { path: [0, "url"], message: expect.stringMatching(/a URL like/) },
    ]);
    expect(validateRoutes([{ url: "github.com", workspace: "w" }])).toHaveLength(1);
    expect(validateRoutes([{ domain: "a.com", workspace: "a\tb" }])).toEqual([
      { path: [0, "workspace"], message: "workspace name must not contain control characters" },
    ]);
  });
});

describe("app rules", () => {
  const slack = [{ app: "slack", workspace: "work" }];

  test("match the application that opened the link", () => {
    expect(target(slack, "https://anything.example/", "slack")).toBe("work");
    expect(target(slack, "about:blank", "slack")).toBe("work");
    expect(target(slack, "https://anything.example/", "discord")).toBeNull();
    expect(target(slack, "https://anything.example/", null)).toBeNull();
  });

  test("with a domain, both must match", () => {
    const both = [{ app: "discord", domain: "youtube.com", workspace: "fun" }];
    expect(target(both, "https://www.youtube.com/", "discord")).toBe("fun");
    expect(target(both, "https://www.youtube.com/", "slack")).toBeNull();
    expect(target(both, "https://github.com/", "discord")).toBeNull();
  });

  test("an app name is a simple token", () => {
    for (const ok of ["slack", "nvim", "org.gnome.nautilus", "c++", "a", "x-1_2"]) {
      expect(isAppToken(ok)).toBe(true);
    }
    for (const bad of ["", "Slack", "my app", "../etc", "a/b", "-x", ".x", "a".repeat(33), "ä"]) {
      expect(isAppToken(bad)).toBe(false);
    }
    expect(isAppToken(/** @type {any} */ (null))).toBe(false);
  });

  test("a hint that is not a token never matches", () => {
    expect(target([{ app: "slack", workspace: "w" }], "https://a.example/", "SLACK")).toBeNull();
  });
});

describe("precedence", () => {
  test("file order: the first match wins, whatever its kind", () => {
    const appFirst = [
      { app: "slack", workspace: "work" },
      { domain: "youtube.com", workspace: "personal" },
    ];
    expect(target(appFirst, "https://youtube.com/", "slack")).toBe("work");
    const domainFirst = [appFirst[1], appFirst[0]];
    expect(target(/** @type {any} */ (domainFirst), "https://youtube.com/", "slack")).toBe(
      "personal",
    );
    expect(target(/** @type {any} */ (domainFirst), "https://github.com/", "slack")).toBe("work");
  });

  test("a rule naming a workspace that does not exist is skipped", () => {
    const rules = routes([
      { domain: "github.com", workspace: "wrok" },
      { domain: "github.com", workspace: "work" },
    ]);
    const hit = matchRoute(
      rules,
      { url: "https://github.com/", app: null },
      { workspaces: ["work"] },
    );
    expect(hit).toMatchObject({ index: 2, workspace: "work" });
    expect(
      matchRoute(rules, { url: "https://github.com/", app: null }, { workspaces: [] }),
    ).toBeNull();
  });

  test("no rules, no match", () => {
    expect(matchRoute([], { url: "https://github.com/", app: "slack" })).toBeNull();
  });
});

describe("describing and adding rules", () => {
  test("describeRoute says what a rule matches", () => {
    const [d, s, a, u, ip] = routes([
      { domain: "github.com", workspace: "w" },
      { domain: "*.corp.example", workspace: "w" },
      { app: "discord", domain: "youtube.com", workspace: "w" },
      { url: "file:///x/", workspace: "w" },
      { domain: "::1", workspace: "w" },
    ]);
    expect(describeRoute(/** @type {any} */ (d))).toBe("domain github.com");
    expect(describeRoute(/** @type {any} */ (s))).toBe("domain *.corp.example");
    expect(describeRoute(/** @type {any} */ (a))).toBe("app discord, domain youtube.com");
    expect(describeRoute(/** @type {any} */ (u))).toBe("url file:///x/");
    expect(describeRoute(/** @type {any} */ (ip))).toBe("domain [::1]");
  });

  test("routeDomainFor: the page's host without www., http(s) only", () => {
    expect(routeDomainFor("https://www.github.com/x")).toBe("github.com");
    expect(routeDomainFor("https://gist.github.com/")).toBe("gist.github.com");
    expect(routeDomainFor("http://10.0.0.5:8080/")).toBe("10.0.0.5");
    expect(routeDomainFor("http://[::1]/")).toBe("::1");
    expect(routeDomainFor("https://www/")).toBe("www");
    expect(routeDomainFor("about:newtab")).toBeNull();
    expect(routeDomainFor("file:///etc/hosts")).toBeNull();
    expect(routeDomainFor("garbage")).toBeNull();
  });

  test("appendRouteText adds a [[routes]] table that parses", () => {
    const before = v2("[panes]", "max = 2");
    const r = appendRouteText(before, { domain: "github.com", workspace: "work" });
    expect(r).toEqual({
      append: '\n[[routes]]\ndomain = "github.com"\nworkspace = "work"\n',
    });
    const after = config(before + /** @type {{ append: string }} */ (r).append);
    expect(after.routes).toEqual([
      { index: 1, workspace: "work", domain: { host: "github.com", sub: false, ip: false } },
    ]);
    expect(after.panes.max).toBe(2);
  });

  test("appendRouteText checks the file with the platform's keymap (#386)", () => {
    const rule = { domain: "a.com", workspace: "w" };
    // alt+d is focus_urlbar on Linux only; meta+l is focus_urlbar on macOS only.
    const altD = v2("[keys]", 'reload = ["alt+d"]');
    const metaL = v2("[keys]", 'reload = ["meta+l"]');
    expect(appendRouteText(altD, rule)).toHaveProperty("error");
    expect(appendRouteText(altD, rule, { mac: true })).toHaveProperty("append");
    expect(appendRouteText(metaL, rule)).toHaveProperty("append");
    expect(appendRouteText(metaL, rule, { mac: true })).toHaveProperty("error");
  });

  test("appendRouteText quotes a workspace name as a TOML string", () => {
    const r = appendRouteText(v2(), { domain: "a.com", workspace: 'say "hi"' });
    expect(r).toMatchObject({ append: expect.stringContaining('workspace = "say \\"hi\\""') });
  });

  test("appendRouteText adds a newline to a file that lacks one", () => {
    expect(appendRouteText("schema = 2", { domain: "a.com", workspace: "w" })).toEqual({
      append: '\n\n[[routes]]\ndomain = "a.com"\nworkspace = "w"\n',
    });
  });

  test("appendRouteText to a missing file: the template plus the rule", () => {
    const r = /** @type {{ create: string }} */ (
      appendRouteText(null, { domain: "a.com", workspace: "w" })
    );
    expect(r.create.startsWith(formatConfigTemplate())).toBe(true);
    expect(config(r.create).routes).toHaveLength(1);
  });

  test("appendRouteText refuses what would not parse, and says why", () => {
    expect(appendRouteText("schema = 2\n[keys\n", { domain: "a.com", workspace: "w" })).toEqual({
      error: expect.stringMatching(/does not parse.*fix it first/),
    });
    expect(
      appendRouteText('[keys]\nnew_tab = "prefix+c"\n', { domain: "a.com", workspace: "w" }),
    ).toEqual({ error: expect.stringMatching(/schema = 2/) });
    expect(
      appendRouteText(v2('routes = [{ domain = "b.com", workspace = "w" }]'), {
        domain: "a.com",
        workspace: "w",
      }),
    ).toEqual({ error: expect.stringMatching(/does not parse/) });
    expect(appendRouteText(v2(), { domain: "a b", workspace: "w" })).toEqual({
      error: expect.stringMatching(/hostname/),
    });
  });
});
