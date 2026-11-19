// docs/specs/setup-v2.md decision 5: setConfigKeysText, the text half of
// ConfigHost.setConfigKeys. The edit is parsed with parseConfig before the host renames it over
// config.toml, so a setting step can never leave a file that does not load.
import { describe, expect, test } from "vitest";
import { parseConfig, setConfigKeysText } from "../src/config/config.mjs";
import { formatConfigTemplate } from "../src/config/defaults.mjs";

// A config.toml whose first line is a comment, so errors are on the lines they always were.
const cfg = (...lines: string[]) => ["# config.toml", ...lines].join("\n") + "\n";

describe("setConfigKeysText", () => {
  test("sets the keys and keeps every other line", () => {
    const text = cfg("# mine", "[ui]", 'toolbar = "shown" # hand-set', "", "[search]");
    expect(
      setConfigKeysText(text, [
        { table: "ui", key: "toolbar", value: "hidden" },
        { table: "search", key: "default", value: "DuckDuckGo" },
      ]),
    ).toEqual({
      text: cfg(
        "# mine",
        "[ui]",
        'toolbar = "hidden" # hand-set',
        "",
        "[search]",
        'default = "DuckDuckGo"',
      ),
    });
  });

  test("a missing file starts from the commented template", () => {
    const r = setConfigKeysText(null, [{ table: "search", key: "default", value: "Bing" }]);
    expect("text" in r && r.text?.startsWith(formatConfigTemplate())).toBe(true);
    expect("text" in r && parseConfig(r.text ?? "").config?.search?.default).toEqual({
      kind: "engine",
      name: "Bing",
    });
  });

  test("an edit that leaves the text as it was writes nothing", () => {
    const text = cfg("[ui]", 'toolbar = "hidden"');
    expect(setConfigKeysText(text, [{ table: "ui", key: "toolbar", value: "hidden" }])).toEqual({
      text: null,
    });
  });

  test("a file that does not load now is never edited", () => {
    expect(
      setConfigKeysText(cfg("[ui]", 'toolbar = "sideways"'), [
        { table: "search", key: "default", value: "Bing" },
      ]),
    ).toEqual({ error: "config.toml does not parse now; fix it first (:config shows it)" });
  });

  test("an edit the file would not load with is refused, with the reason", () => {
    expect(
      setConfigKeysText(cfg("[ui]"), [{ table: "ui", key: "toolbar", value: "sideways" }]),
    ).toEqual({
      error: 'config.toml would not load with the edit: ui.toolbar: must be "shown" or "hidden"',
    });
  });

  test("a line edit setTomlKeys refuses is refused with its line", () => {
    expect(
      setConfigKeysText(cfg("[ui]", 'toolbar = """', 'shown"""'), [
        { table: "ui", key: "toolbar", value: "hidden" },
      ]),
    ).toEqual({ error: "config.toml:3: ui.toolbar is not a one-line value" });
  });

  test("a table made by its sub-tables alone gets its header", () => {
    const text = cfg("[theme.colors]", 'accent = "#ff0000"');
    const r = setConfigKeysText(text, [
      { table: "theme", key: "appearance", value: "dark" },
      { table: "updates", key: "check", value: false },
    ]);
    expect("text" in r && r.text).toBe(
      cfg(
        "[theme]",
        'appearance = "dark"',
        "",
        "[theme.colors]",
        'accent = "#ff0000"',
        "",
        "[updates]",
        "check = false",
      ),
    );
  });
});
