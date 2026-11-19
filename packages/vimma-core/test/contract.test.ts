// Contract fixtures (docs/architecture/testing.md): one valid and the invalid cases for each
// `schema` line that older config.toml files carry, and Omarchy colors.toml files. config.toml has
// no schema any more (#1379): the line is ignored, so every valid file here loads with every key.
import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { parseConfig } from "../src/config/config.mjs";
import { parseOmarchyColors } from "../src/config/theme.mjs";

const contract = new URL("../../../tests/contract/", import.meta.url);

describe.each(["v1", "v2"])("config fixtures %s", (folder) => {
  const dir = new URL(`config/${folder}/`, contract);
  const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
  const expected: Record<string, { line: number; path: string; suggestion: string | null }[]> =
    JSON.parse(read("expected-errors.json"));
  const files = readdirSync(dir);
  const valid = files.filter((f) => /^valid.*\.toml$/.test(f));
  const invalid = files.filter((f) => /^invalid-.*\.toml$/.test(f));

  test.each(valid)("%s parses without errors", (name) => {
    expect(parseConfig(read(name)).errors).toEqual([]);
  });

  test("there is at least one invalid fixture, and each has expected errors", () => {
    expect(valid).toContain("valid.toml");
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
});

describe("Omarchy colors.toml", () => {
  const read = (name: string) => readFileSync(new URL(`theme/${name}`, contract), "utf8");

  test.each(["sample.colors.toml", "light.colors.toml"])("%s is valid", (name) => {
    expect(parseOmarchyColors(read(name)).errors).toEqual([]);
  });

  test("invalid.colors.toml is rejected", () => {
    expect(parseOmarchyColors(read("invalid.colors.toml")).palette).toBeNull();
  });
});
