// docs/specs/password-storage.md, behaviours 1 and 2, decisions 8 and 9: `[passwords] save` and
// `fill_on_load`, one Firefox pref each, both on by default as in Firefox.
import { describe, expect, test } from "vitest";
import { formatDefaultsToml } from "../src/config/defaults.mjs";
import { mergeWithDefaults, parseConfig } from "../src/config/config.mjs";

const toml = (...lines: string[]) => lines.join("\n") + "\n";

describe("[passwords]", () => {
  test("[passwords] save and fill_on_load resolve to their defaults when absent", () => {
    expect(parseConfig("").config?.passwords).toEqual({ save: true, fillOnLoad: true });
    expect(parseConfig(toml("[passwords]")).config?.passwords).toEqual({
      save: true,
      fillOnLoad: true,
    });
    expect(parseConfig(toml("[passwords]", "save = false")).config?.passwords).toEqual({
      save: false,
      fillOnLoad: true,
    });
    expect(parseConfig(toml("[passwords]", "fill_on_load = false")).config?.passwords).toEqual({
      save: true,
      fillOnLoad: false,
    });
  });

  test("save and fill_on_load default to true", () => {
    expect(mergeWithDefaults({}).passwords).toEqual({ save: true, fillOnLoad: true });
    expect(formatDefaultsToml()).toMatch(
      /^\[passwords\]\nsave = true +# .*\nfill_on_load = true +# .*$/m,
    );
  });

  test("a non-boolean save or fill_on_load is an error with its line", () => {
    const r = parseConfig(toml("[passwords]", 'save = "no"', "fill_on_load = 0"));
    expect(r.config).toBeNull();
    expect(r.errors).toEqual([
      { line: 2, path: "passwords.save", message: "expected a boolean, got a string" },
      { line: 3, path: "passwords.fill_on_load", message: "expected a boolean, got an integer" },
    ]);
  });

  test("an unknown key in [passwords] is a warning", () => {
    const r = parseConfig(toml("[passwords]", "save = false", "vault = true"));
    expect(r.errors).toEqual([]);
    expect(r.config?.passwords.save).toBe(false);
    expect(r.warnings).toEqual([
      { line: 3, path: "passwords.vault", message: 'unknown key "vault"; skipped' },
    ]);
  });

  test("a near miss of a key is an error, so a mistyped opt-out is not silently dropped", () => {
    const r = parseConfig(toml("[passwords]", "sav = false"));
    expect(r.config).toBeNull();
    expect(r.errors[0]?.path).toBe("passwords.sav");
  });
});
