// Contract fixtures (docs/architecture/testing.md): one valid and the invalid cases per config
// schema version, and Omarchy colors.toml files. A new schema version adds
// tests/contract/config/v<n>/.
import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { CONFIG_SCHEMA_VERSION, parseConfig } from "../src/config/config.mjs";
import { parseOmarchyColors } from "../src/config/theme.mjs";

const contract = new URL("../../../tests/contract/", import.meta.url);

describe.each(Array.from({ length: CONFIG_SCHEMA_VERSION }, (_, i) => i + 1))(
  "config schema v%i",
  (version) => {
    const dir = new URL(`config/v${version}/`, contract);
    const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
    const expected: Record<string, { line: number; path: string; suggestion: string | null }[]> =
      JSON.parse(read("expected-errors.json"));
    const invalid = readdirSync(dir).filter((f) => /^invalid-.*\.toml$/.test(f));

    test("valid.toml parses without errors", () => {
      const r = parseConfig(read("valid.toml"));
      expect(r.errors).toEqual([]);
      // an older version's valid file still loads, migrated to the current schema
      expect(r.config?.schema).toBe(CONFIG_SCHEMA_VERSION);
      expect(r.migratedFrom).toBe(version === CONFIG_SCHEMA_VERSION ? null : version);
    });

    test("there is at least one invalid fixture, and each has expected errors", () => {
      expect(invalid.length).toBeGreaterThan(0);
      expect(
        Object.keys(expected)
          .filter((k) => !k.startsWith("$"))
          .sort(),
      ).toEqual([...invalid].sort());
    });

    test.each(invalid)("%s gives exactly the expected errors", (name) => {
      const r = parseConfig(read(name));
      expect(r.config).toBeNull();
      expect(
        r.errors.map((e) => ({ line: e.line, path: e.path, suggestion: e.suggestion ?? null })),
      ).toEqual(expected[name]);
    });
  },
);

describe("Omarchy colors.toml", () => {
  const read = (name: string) => readFileSync(new URL(`theme/${name}`, contract), "utf8");

  test.each(["sample.colors.toml", "light.colors.toml"])("%s is valid", (name) => {
    expect(parseOmarchyColors(read(name)).errors).toEqual([]);
  });

  test("invalid.colors.toml is rejected", () => {
    expect(parseOmarchyColors(read("invalid.colors.toml")).palette).toBeNull();
  });
});
