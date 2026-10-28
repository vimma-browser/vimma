import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { formatDefaultsToml } from "../src/defaults.mjs";
import { bindingsJson } from "../src/help.mjs";
import { compileKeymap } from "../src/keymap.mjs";

test("defaults.toml matches the snapshot", () => {
  expect(formatDefaultsToml()).toMatchSnapshot();
});

test("the committed defaults.toml is up to date (run npm run gen-docs)", () => {
  const committed = readFileSync(new URL("../defaults.toml", import.meta.url), "utf8");
  expect(committed).toBe(formatDefaultsToml());
});

test("the committed docs/bindings.json is up to date (run npm run gen-docs)", () => {
  // Parsed, so prettier may format the file; vimma.dev mirrors it (docs/specs/site-keys-mirror.md).
  const committed = readFileSync(new URL("../../../docs/bindings.json", import.meta.url), "utf8");
  expect(JSON.parse(committed)).toEqual(bindingsJson(compileKeymap()));
});

test("defaults.toml lists macOS's own default keys as comments under [keys] (#386)", () => {
  const toml = formatDefaultsToml();
  const keys = toml.slice(toml.indexOf("[keys]"), toml.indexOf("[modal]"));
  expect(keys).toContain('\n# history_back = ["meta+left", "meta+["]\n');
  expect(keys).toContain('\n# select_last_tab = ["meta+9"]\n');
  expect(keys).toContain('\n# focus_urlbar = ["ctrl+l", "meta+l"]\n');
  expect(keys).toContain('\nhistory_back = ["alt+left"]\n');
});
