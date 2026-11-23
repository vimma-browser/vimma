// config.mjs at the edges its other tests leave open (#1119, mutation testing): the exact text of
// each validation message, the schema-1 gate reported once, values at their limits, the keymap
// error's action names as the user wrote them, `[updates] check` read from any file, and the
// edits :route add and the agent setup make to config.toml, byte for byte.
import { describe, test, expect } from "vitest";
import {
  addAgentProviderText,
  appendRouteText,
  mergeWithDefaults,
  parseConfig,
  rawUpdatesCheck,
} from "../src/config/config.mjs";

// A config.toml whose first line is a comment, so errors are on the lines they always were.
const cfg = (...lines: string[]) => ["# config.toml", ...lines].join("\n") + "\n";

/** [line, path, message, suggestion?] for each error, or "ok" when the file is valid. */
function problems(text: string) {
  const r = parseConfig(text);
  if (r.config) {
    expect(r.errors).toEqual([]);
    return "ok";
  }
  return r.errors.map((e) => [e.line, e.path, e.message, ...(e.suggestion ? [e.suggestion] : [])]);
}

describe("validation messages", () => {
  test("a workspace that is not a table is reported as such, not read key by key", () => {
    expect(problems(cfg("[workspaces]", 'w = "x"'))).toEqual([
      [3, "workspaces.w", "expected a table, got a string"],
    ]);
  });

  test("each workspace key's message", () => {
    expect(problems(cfg("[workspaces]", '"a\\u0007" = {}'))).toEqual([
      [3, 'workspaces."a\\u0007"', "workspace name must not contain control characters"],
    ]);
    expect(
      problems(
        cfg(
          "[workspaces.w]",
          "color = 1",
          'icon = "nope"',
          'home = "ftp://x"',
          "autofill = 1",
          "[workspaces.v]",
          'color = "nope"',
        ),
      ),
    ).toEqual([
      [3, "workspaces.w.color", "expected a string, got an integer"],
      [4, "workspaces.w.icon", 'unknown icon "nope"'],
      [5, "workspaces.w.home", "must be an http://, https:// or about: URL without spaces"],
      [6, "workspaces.w.autofill", "expected a boolean, got an integer"],
      [8, "workspaces.v.color", 'unknown colour "nope"'],
    ]);
  });

  test("an unknown [modal] key or [unbind] mode can be the pdf context", () => {
    expect(problems(cfg("[modal]", "pdff = 1"))).toEqual([
      [3, "modal.pdff", 'unknown key "pdff"', "pdf"],
    ]);
    expect(problems(cfg("[unbind]", "pdff = []"))).toEqual([
      [3, "unbind.pdff", 'unknown mode "pdff"', "pdf"],
    ]);
  });

  test("a CLI provider's max_minutes must be an integer", () => {
    const text = cfg(
      "[[agent.providers]]",
      'name = "c"',
      'kind = "cli"',
      'cli = "claude-code"',
      'max_minutes = "5"',
    );
    expect(problems(text)).toEqual([
      [6, "agent.providers[0].max_minutes", "expected an integer, got a string"],
    ]);
  });

  test("a download folder of ~ alone is the home folder", () => {
    expect(problems(cfg("[mcp]", 'download_dir = "~"'))).toEqual([
      [3, "mcp.download_dir", "must not be your home folder"],
    ]);
  });

  test("a negative schema is ignored, as every schema line is", () => {
    expect(problems("schema = -1\n")).toBe("ok");
  });
});

describe("a key added after M5, in a schema-1 file", () => {
  test("has its value checked as in any file", () => {
    expect(problems("schema = 1\npanes = 3\n")).toEqual([
      [2, "panes", "expected a table, got an integer"],
    ]);
    expect(problems("schema = 1\n[modal]\nhint_chars = 5\n")).toEqual([
      [3, "modal.hint_chars", "expected a string, got an integer"],
    ]);
  });
});

describe("values at their limits", () => {
  test("a one-character name or font is long enough", () => {
    expect(
      problems(
        cfg(
          "[workspaces.w]",
          "[routing]",
          'default_workspace = "w"',
          "[mcp]",
          'workspace = "m"',
          "[theme]",
          'font = "x"',
        ),
      ),
    ).toBe("ok");
  });

  test("[agent] integers are accepted at their maximum", () => {
    expect(
      problems(
        cfg(
          "[agent]",
          "max_running = 10",
          "max_steps = 1000",
          "max_tokens = 100_000_000",
          "keep_days = 3650",
          "keep_results = 1000",
        ),
      ),
    ).toBe("ok");
  });

  test("a grant_max_minutes that is not an integer leaves grant_minutes to the default maximum", () => {
    expect(problems(cfg("[mcp]", "grant_max_minutes = 1.0", "grant_minutes = 2"))).toEqual([
      [3, "mcp.grant_max_minutes", "expected an integer, got a float"],
    ]);
  });
});

describe("the resolved config", () => {
  test("its tables from the file are plain data a caller can change", () => {
    const config = parseConfig(
      cfg("[keys]", 'new_tab = "ctrl+t"', "[modal]", 'leader = "space"'),
    ).config!;
    config.keys.new_tab = "ctrl+n";
    config.modal.leader = ",";
    expect(config.keys.new_tab).toBe("ctrl+n");
    expect(config.modal.leader).toBe(",");
  });

  test("a site in the order but not in [sites] gets the default insert mode", () => {
    // parseConfig never passes such an order; this is the exported function's own fallback.
    expect(mergeWithDefaults({ sites: {} }, undefined, ["a.com"]).sites).toEqual([
      { match: "a.com", insert: "auto", sleep: true },
    ]);
  });
});

describe("a keymap error names actions as the file wrote them", () => {
  test("a key that is no action does not rename anything", () => {
    expect(problems(cfg("[keys]", 'undefined = "x"', 'foo = "y"'))).toEqual([
      [3, "keys.undefined", 'unknown action "undefined"'],
    ]);
  });

  test("a site whose host is spelt like an action keeps its own path", () => {
    const text = cfg(
      "[keys]",
      'prev_workspace = "ctrl+x"',
      "[sites.previous_workspace]",
      'unbind = ["zzzz+q"]',
    );
    expect(problems(text)).toEqual([
      [5, "sites.previous_workspace.unbind[0]", 'unknown modifier "zzzz" in "zzzz+q"'],
    ]);
  });

  test("an old name moves the error only when the error is about that action", () => {
    expect(problems(cfg("[keys]", 'prev_workspace = "ctrl+x"', 'new_tabb = "y"'))).toEqual([
      [4, "keys.new_tabb", 'unknown action "new_tabb"', "new_tab"],
    ]);
  });
});

describe("rawUpdatesCheck", () => {
  test("a boolean check in any one table of a list is an opt-out written elsewhere", () => {
    const text = cfg("[[routes]]", "check = false", "[[routes]]", 'domain = "a.com"');
    expect(rawUpdatesCheck(text)).toBeNull();
  });

  test("reads a file whose integers do not fit a JavaScript number", () => {
    expect(rawUpdatesCheck(cfg("[ui]", "x = 9223372036854775807"))).toBe("missing");
    expect(
      rawUpdatesCheck(cfg("[ui]", "x = 9223372036854775807", "[updates]", "check = false")),
    ).toBe(false);
  });
});

describe("appendRouteText", () => {
  const rule = { domain: "a.com", workspace: "w" };

  test("appends after a final newline with one blank line", () => {
    expect(appendRouteText(cfg(), rule)).toEqual({
      append: '\n[[routes]]\ndomain = "a.com"\nworkspace = "w"\n',
    });
  });

  test("a rule the TOML cannot take is refused with the parser's message", () => {
    expect(appendRouteText(cfg("routes = []"), rule)).toEqual({
      error:
        "config.toml does not parse with the rule added: trying to redefine an already defined table or value",
    });
  });
});

describe("addAgentProviderText", () => {
  const local = { name: "l", kind: "openai", endpoint: "http://localhost:1/v1", model: "m" };
  const existing = [
    "[[agent.providers]]",
    'name = "a"',
    'kind = "openai"',
    'endpoint = "http://localhost:2/v1"',
    'model = "m"',
  ];

  test("appends the provider after a final newline with one blank line", () => {
    expect(addAgentProviderText(cfg(), local, { makeDefault: false })).toEqual({
      text: cfg(
        "",
        "[[agent.providers]]",
        'name = "l"',
        'kind = "openai"',
        'endpoint = "http://localhost:1/v1"',
        'model = "m"',
        "vision = false",
      ),
      name: "l",
    });
  });

  test("writes no prices when either one is missing", () => {
    for (const price of [{ priceIn: 1 }, { priceOut: 1 }]) {
      const r = addAgentProviderText(cfg(), { ...local, ...price }, { makeDefault: false });
      expect((r as { text: string }).text).not.toContain("price");
    }
  });

  test("a provider the config would refuse is refused with the key and the reason", () => {
    expect(
      addAgentProviderText(cfg(), { ...local, model: "a\u0007b" }, { makeDefault: false }),
    ).toEqual({
      error:
        "config.toml does not parse with the provider added: agent.providers[0].model: must not contain control characters",
    });
  });

  test("a file that does not parse is refused before anything is added", () => {
    expect(addAgentProviderText(cfg("[ui]", "toolbar = 1"), local, { makeDefault: false })).toEqual(
      {
        error: "config.toml does not parse now; fix it first (:config shows it)",
      },
    );
  });

  test("a provider the TOML cannot take is refused with the parser's message", () => {
    expect(
      addAgentProviderText(cfg("agent = { providers = [] }"), local, { makeDefault: false }),
    ).toEqual({
      error:
        "config.toml does not parse with the provider added: trying to redefine an already defined table or value",
    });
  });

  test("checks the file before and after with the platform's keymap", () => {
    // alt+d is focus_urlbar on Linux only; meta+l is focus_urlbar on macOS only.
    const altD = cfg("[keys]", 'reload = ["alt+d"]');
    const metaL = cfg("[keys]", 'reload = ["meta+l"]');
    const opts = { makeDefault: false };
    expect(addAgentProviderText(altD, local, opts)).toHaveProperty("error");
    expect(addAgentProviderText(altD, local, { ...opts, mac: true })).toHaveProperty("text");
    expect(addAgentProviderText(metaL, local, opts)).toHaveProperty("text");
    expect(addAgentProviderText(metaL, local, { ...opts, mac: true })).toHaveProperty("error");
  });

  test("[agent] goes before the first providers header, not a comment that names one", () => {
    const text = cfg("# [[agent.providers]] are below", ...existing);
    expect(addAgentProviderText(text, local, { makeDefault: true })).toEqual({
      text: cfg(
        "# [[agent.providers]] are below",
        "[agent]",
        'default = "l"',
        "",
        ...existing,
        "",
        "[[agent.providers]]",
        'name = "l"',
        'kind = "openai"',
        'endpoint = "http://localhost:1/v1"',
        'model = "m"',
        "vision = false",
      ),
      name: "l",
    });
  });

  describe("refuses an edit whose result is not the provider asked for", () => {
    // Each of these says what is wrong (config-errors.test.ts, #1284); here only the refusal.
    const cli = { name: "c", kind: "cli", cli: "claude-code", endpoint: "", model: "" };

    test("a CLI this build does not know, which the config would skip", () => {
      expect(addAgentProviderText(cfg(), { ...cli, cli: "nope" }, { makeDefault: false })).toEqual({
        error: expect.any(String),
      });
    });

    test("a CLI provider given an endpoint, which it does not keep", () => {
      expect(
        addAgentProviderText(
          cfg(),
          { ...cli, endpoint: "http://localhost:1" },
          { makeDefault: false },
        ),
      ).toEqual({ error: expect.any(String) });
    });

    test("a CLI provider given no model, which reads back as an empty one", () => {
      const noModel = { ...cli, model: undefined } as unknown as typeof cli;
      expect(addAgentProviderText(cfg(), noModel, { makeDefault: false })).toEqual({
        error: expect.any(String),
      });
    });

    // setTomlKeys places `[agent]` by the parsed keys (setup-v2 decision 6), so a header-like
    // line inside a multi-line string is passed over and `[agent]` goes before the real table.
    test("[agent] goes before the real providers, not into a multi-line string", () => {
      const fake = [
        "[search.aliases]",
        'g = """https://a.com/?q=%s\\',
        "[[agent.providers]]\\",
        '"""',
      ];
      const r = addAgentProviderText(cfg(...fake, ...existing), local, { makeDefault: true });
      expect(r).toEqual({
        name: "l",
        text: cfg(
          ...fake,
          "[agent]",
          'default = "l"',
          "",
          ...existing,
          "",
          "[[agent.providers]]",
          'name = "l"',
          'kind = "openai"',
          'endpoint = "http://localhost:1/v1"',
          'model = "m"',
          "vision = false",
        ),
      });
    });
  });
});
