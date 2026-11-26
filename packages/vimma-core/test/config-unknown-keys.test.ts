// An unknown key with no close match is a warning that skips only that key (#1474, spec
// m5-core-config-and-theme, "Since changed"): a key a newer Vimma added must not keep an older
// one from loading the rest of a shared or synced file. A near miss of a real key, a type error,
// a key that belongs in another table, and the keys a CLI provider may never hold stay errors.
import { describe, test, expect } from "vitest";
import {
  addAgentProviderText,
  appendRouteText,
  parseConfig,
  rawUpdatesCheck,
  setConfigKeysText,
} from "../src/config/config.mjs";
import { editSiteUnbindText } from "../src/config/site-edit.mjs";
import { withSiteUnbinds } from "../src/keys/keymap.mjs";
import { resolveActionName } from "../src/keys/actions.mjs";

const toml = (...lines: string[]) => lines.join("\n") + "\n";

describe("an unknown key with no close match", () => {
  test("in a known table is a warning; the rest of the file applies", () => {
    const r = parseConfig(toml("[ui]", 'toolbar = "shown"', 'sparkles = "lots"'));
    expect(r.errors).toEqual([]);
    expect(r.config?.ui.toolbar).toBe("shown");
    expect(r.warnings).toEqual([
      { line: 3, path: "ui.sparkles", message: 'unknown key "sparkles"; skipped' },
    ]);
  });

  test("as a table of its own is a warning, and only that table is skipped", () => {
    const r = parseConfig(toml("[hologram]", "depth = 3", "[scroll]", "step = 7"));
    expect(r.errors).toEqual([]);
    expect(r.config?.scroll.step).toBe(7);
    expect(r.warnings).toEqual([
      { line: 1, path: "hologram", message: 'unknown key "hologram"; skipped' },
    ]);
    expect(r.config).not.toHaveProperty("hologram");
  });

  test("in a provider, in [mcp], in a site and in [modal] is a warning", () => {
    const r = parseConfig(
      toml(
        "[modal]",
        "telepathy = true",
        "[mcp]",
        "teleport = true",
        '[sites."example.com"]',
        "levitate = true",
        "[[agent.providers]]",
        'name = "local"',
        'kind = "openai"',
        'endpoint = "http://127.0.0.1:8080/v1"',
        'model = "m"',
        "temperature_curve = 2",
      ),
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.path)).toEqual([
      "modal.telepathy",
      "mcp.teleport",
      'sites."example.com".levitate',
      "agent.providers[0].temperature_curve",
    ]);
    expect(r.config?.agent.providers.map((p) => p.name)).toEqual(["local"]);
  });
});

describe("what stays an error", () => {
  test("a near miss of a real key, with the suggestion", () => {
    const r = parseConfig(toml("[scroll]", "steps = 5"));
    expect(r.errors).toEqual([
      { line: 2, path: "scroll.steps", message: 'unknown key "steps"', suggestion: "step" },
    ]);
  });

  test("a value of the wrong type", () => {
    expect(parseConfig(toml("[scroll]", 'step = "five"')).errors).toHaveLength(1);
  });

  test("a top-level table's dotted line under another table (#1270)", () => {
    const r = parseConfig(toml("[ui]", 'keys.prefix = "ctrl+a"'));
    expect(r.errors[0]?.message).toMatch(/belongs under \[keys\]/);
  });

  test("a program, command or secret in a CLI provider (M60)", () => {
    for (const line of ['command = "x"', 'path = "/bin/x"', 'api_key = "k"']) {
      const r = parseConfig(
        toml("[[agent.providers]]", 'name = "c"', 'kind = "cli"', 'cli = "claude-code"', line),
      );
      expect(r.errors, line).toHaveLength(1);
    }
  });
});

// The same rule for a binding: an action this build does not know, with no close match, is most
// likely one a newer Vimma added, so only that binding is left out (#1474 follow-up).
describe("an unknown action with no close match", () => {
  test("in [keys] is a warning; the other bindings and the rest of the file apply", () => {
    const r = parseConfig(
      toml(
        "[keys]",
        'summon_hologram = ["prefix+h"]',
        'new_tab = ["prefix+t"]',
        "[scroll]",
        "step = 7",
      ),
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([
      {
        line: 2,
        path: "keys.summon_hologram",
        message: 'unknown action "summon_hologram"; skipped',
      },
    ]);
    expect(r.keymap?.keysFor("new_tab")).toContain("ctrl+b t");
    expect(r.keymap?.keysFor("new_tab")).not.toContain("ctrl+b c");
    expect(r.config?.scroll.step).toBe(7);
    expect(r.config?.keys).not.toHaveProperty("summon_hologram");
  });

  test("in a [modal.<mode>] table is a warning; that table's other bindings apply", () => {
    const r = parseConfig(toml("[modal.normal]", '"zq" = "summon_hologram"', '"zt" = "new_tab"'));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([
      {
        line: 2,
        path: "modal.normal.zq",
        message: 'unknown action "summon_hologram"; skipped',
      },
    ]);
    expect(r.keymap?.keysFor("new_tab")).toContain("zt");
  });

  test("whose name is not a bare key is skipped, not a throw (#134)", () => {
    const r = parseConfig(toml(`'keys'.'mod['."github.com" = "github.com"`));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([
      { line: 1, path: 'keys."mod["', message: 'unknown action "mod["; skipped' },
    ]);
  });

  test("leaves a keymap that a site unbind can compile again", () => {
    const r = parseConfig(toml("[keys]", 'summon_hologram = "prefix+h"'));
    const km = withSiteUnbinds(r.keymap!, new Map([["example.com", ["j"]]]));
    expect(km.keysFor("new_tab")).toEqual(r.keymap?.keysFor("new_tab"));
  });
});

describe("a skipped binding, further", () => {
  test("named like an Object.prototype member is skipped; the prototype stays clean", () => {
    const r = parseConfig(
      toml(
        "[keys]",
        '__proto__ = "prefix+h"',
        'constructor = "prefix+j"',
        "[modal.normal]",
        '"__proto__" = "toString"',
      ),
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.message)).toEqual([
      'unknown action "__proto__"; skipped',
      'unknown action "constructor"; skipped',
      'unknown action "toString"; skipped',
    ]);
    expect(Object.prototype).not.toHaveProperty("prefix");
  });

  test("on a default [modal] sequence leaves the default action there (F2's accepted risk)", () => {
    // `d` is scroll.half_down in normal mode by default (defaults.mjs).
    const name = resolveActionName("scroll.half_down")!.name;
    const r = parseConfig(toml("[modal.normal]", '"d" = "summon_hologram"'));
    expect(r.warnings).toHaveLength(1);
    expect(r.keymap?.keysFor(name)).toEqual(parseConfig("").keymap?.keysFor(name));
    expect(r.keymap?.keysFor(name)).toContain("d");
  });
});

describe("a binding that stays an error", () => {
  test.each([
    // A near miss of a real action is a typo.
    [["[keys]", 'new_tabb = "prefix+t"'], 'unknown action "new_tabb"'],
    [["[modal.normal]", '"zt" = "new_tabb"'], 'unknown action "new_tabb"'],
    // Malformed key notation is a bad value, as #1477 kept bad values errors.
    [["[keys]", 'new_tab = "ctrl+bogus+t"'], 'unknown modifier "bogus"'],
    // A boolean check fails closed (m6a-updater decision 31).
    [["[keys]", "check = false"], 'unknown key "check"'],
    [["[keys.newer]", "updates = { check = false }"], 'unknown key "newer"'],
    [["[keys.newer.deep]", "check = false"], 'unknown key "newer"'],
    // A top-level table's dotted line under [keys] is misplaced (#1270).
    [["[keys]", 'ui.toolbar = "shown"'], "belongs under [ui]"],
  ])("%j", (lines, message) => {
    const r = parseConfig(toml(...lines));
    expect(r.warnings).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.message).toContain(message);
  });
});

describe("secrets and update checks", () => {
  test("a secret-like name in [agent], a provider or [mcp] stays an error", () => {
    const cases: [string, string][] = [
      ["[agent]", 'access_token = "t"'],
      ["[mcp]", 'auth_header = "Bearer t"'],
      ["[[agent.providers]]", 'api-key = "k"'],
    ];
    for (const [table, line] of cases) {
      const r = parseConfig(toml(table, line));
      expect(r.errors.map((e) => e.message).join(), line).toMatch(/login storage|keyring|secret/i);
    }
  });

  test("a newer table no longer makes another error hold update checks", () => {
    expect(rawUpdatesCheck(toml("[hologram]", "x = 1", "[scroll]", 'step = "x"'))).toBe("missing");
    expect(rawUpdatesCheck(toml("[updatez]", "check = false"))).toBeNull();
  });
});

describe("the writers take a file with an unknown key", () => {
  const file = toml("[future]", "wish = 1", "[ui]", "shimmer = true");

  test("setConfigKeysText", () => {
    const r = setConfigKeysText(file, [{ table: "scroll", key: "step", value: 9 }]);
    expect(r).toEqual({ text: `${file}\n[scroll]\nstep = 9\n` });
  });

  test("addAgentProviderText", () => {
    const r = addAgentProviderText(
      file,
      { name: "local", kind: "openai", endpoint: "http://127.0.0.1:8080/v1", model: "m" },
      { makeDefault: false },
    );
    expect("error" in r ? r.error : r.text).toContain("[[agent.providers]]");
    expect("error" in r ? "" : r.text.startsWith(file)).toBe(true);
  });

  test("appendRouteText", () => {
    const r = appendRouteText(file, { domain: "example.com", workspace: "work" });
    expect(r).toHaveProperty("append");
  });

  test("editSiteUnbindText", () => {
    const r = editSiteUnbindText(file, "example.com", { add: ["j"] });
    expect("error" in r ? r.error : r.added).toEqual(["j"]);
  });
});
