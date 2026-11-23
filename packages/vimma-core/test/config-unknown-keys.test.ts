// An unknown key with no close match is a warning that skips only that key (#1474, spec
// m5-core-config-and-theme, "Since changed"): a key a newer Vimma added must not keep an older
// one from loading the rest of a shared or synced file. A near miss of a real key, a type error,
// a key that belongs in another table, and the keys a CLI provider may never hold stay errors.
import { describe, test, expect } from "vitest";
import {
  addAgentProviderText,
  appendRouteText,
  parseConfig,
  setConfigKeysText,
} from "../src/config/config.mjs";
import { editSiteUnbindText } from "../src/config/site-edit.mjs";

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
        toml("[[agent.providers]]", 'name = "c"', 'kind = "cli"', 'cli = "claude"', line),
      );
      expect(r.errors, line).toHaveLength(1);
    }
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
