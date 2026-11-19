// config.toml has no schema (#1379, spec m5-config-load decision 8): every key is valid in every
// file, and a `schema` line, whatever its value, is accepted and ignored.
import { describe, test, expect } from "vitest";
import { parseConfig } from "../src/config/config.mjs";
import { formatConfigTemplate, formatDefaultsToml } from "../src/config/defaults.mjs";

import type { ResolvedConfig } from "../src/config/config.mjs";

const toml = (...lines: string[]) => lines.join("\n") + "\n";

/** Keys that once needed `schema = 2`, one or more from each such table. */
const NEWER_KEYS = toml(
  "[modal]",
  'hint_chars = "asdf"',
  "insert_editing = true",
  "[theme]",
  'appearance = "dark"',
  "[ui]",
  'tabline = "auto"',
  "[search]",
  'default = "DuckDuckGo"',
  "[mcp]",
  "enabled = true",
  "[agent]",
  "max_steps = 5",
  "[panes]",
  "max = 4",
  '[sites."docs.google.com"]',
  'insert = "always"',
  "[[routes]]",
  'domain = "example.com"',
  'workspace = "default"',
  "[routing]",
  'default_workspace = "default"',
  "[firefox]",
  'disable = ["ctrl+w"]',
  "[bookmarks]",
  'write_back = "none"',
  "[private]",
  'placement = "window"',
  "[updates]",
  "check = false",
  "[panel]",
  'numbers = "relative"',
  "[scroll]",
  "step = 40",
  "[statusbar]",
  "tab = false",
);

function ok(text: string) {
  const r = parseConfig(text);
  expect(r.errors).toEqual([]);
  return r.config as ResolvedConfig;
}

describe("config.toml without a schema line", () => {
  test("a file with no schema line may use [ui], [search], [mcp], [agent] and every other key", () => {
    const config = ok(NEWER_KEYS);
    expect(config.hintChars).toBe("asdf");
    expect(config.search?.default).toEqual({ kind: "engine", name: "DuckDuckGo" });
    expect(config.mcp.enabled).toBe(true);
    expect(config.agent.maxSteps).toBe(5);
    expect(config.updates.check).toBe(false);
    expect(config.panes.max).toBe(4);
  });

  test.each([["1"], ["2"]])("an older file with schema = %s still loads, with every key", (v) => {
    expect(ok(`schema = ${v}\n${NEWER_KEYS}`)).toEqual(ok(NEWER_KEYS));
  });

  test.each([["0"], ["3"], ["99999999999999999999"], ["-1"], ["1.5"], ['"2"'], ["true"], ["[2]"]])(
    "schema = %s is accepted and ignored",
    (v) => {
      expect(ok(`schema = ${v}\n${NEWER_KEYS}`)).toEqual(ok(NEWER_KEYS));
    },
  );

  test("a schema table is ignored too, the same as any value", () => {
    expect(ok(`${NEWER_KEYS}[schema]\nversion = 2\n`)).toEqual(ok(NEWER_KEYS));
  });

  test("defaults.toml and the :config template have no schema line, and both load", () => {
    for (const text of [formatDefaultsToml(), formatConfigTemplate()]) {
      expect(text).not.toMatch(/^schema\b/m);
      expect(parseConfig(text).errors).toEqual([]);
    }
  });

  test("other validation still applies next to a schema line", () => {
    const r = parseConfig(toml("schema = 2", "[panes]", "max = 99"));
    expect(r.config).toBeNull();
    expect(r.errors).toMatchObject([{ line: 3, path: "panes.max" }]);
  });
});
