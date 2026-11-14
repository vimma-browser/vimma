// `:source <path>` and `:config` (spec m5-config-load, § `:source <path>` and `:config`).
import { describe, test, expect } from "vitest";
import { parseConfig, resolveSourcePath } from "../src/config/config.mjs";
import { formatConfigTemplate } from "../src/config/defaults.mjs";
import { bindingTable } from "../src/ui/help.mjs";
import { MODES } from "../src/keys/modes.mjs";

const env = {
  home: "/home/u",
  xdgConfigHome: "/xdg",
  configDir: "/xdg/vimma",
};

describe("resolveSourcePath", () => {
  test.each([
    ["/etc/vimma/work.toml", "/etc/vimma/work.toml"],
    ["~", "/home/u"],
    ["~/work.toml", "/home/u/work.toml"],
    ["$HOME/work.toml", "/home/u/work.toml"],
    ["${HOME}/work.toml", "/home/u/work.toml"],
    ["$XDG_CONFIG_HOME/vimma/work.toml", "/xdg/vimma/work.toml"],
    ["${XDG_CONFIG_HOME}/vimma/work.toml", "/xdg/vimma/work.toml"],
    // Relative: next to config.toml, so `:source work.toml` finds a sibling.
    ["work.toml", "/xdg/vimma/work.toml"],
    ["sub/work.toml", "/xdg/vimma/sub/work.toml"],
    ["../other/x.toml", "/xdg/other/x.toml"],
    // Other variables and ~user are not expanded: the path is taken as typed.
    ["$FOO/x.toml", "/xdg/vimma/$FOO/x.toml"],
    ["~other/x.toml", "/xdg/vimma/~other/x.toml"],
    ["/a//b/./c.toml", "/a/b/c.toml"],
  ])("%j → %j", (arg, expected) => {
    expect(resolveSourcePath(arg, env)).toBe(expected);
  });

  test("an unset or relative XDG_CONFIG_HOME means ~/.config, as the XDG spec says", () => {
    for (const xdgConfigHome of ["", "rel/dir", undefined]) {
      expect(resolveSourcePath("$XDG_CONFIG_HOME/v.toml", { ...env, xdgConfigHome })).toBe(
        "/home/u/.config/v.toml",
      );
    }
  });

  test("an empty or blank argument is null (plain :source)", () => {
    expect(resolveSourcePath("", env)).toBeNull();
    expect(resolveSourcePath("   ", env)).toBeNull();
  });
});

describe("formatConfigTemplate", () => {
  const text = formatConfigTemplate();

  test("means exactly the defaults: every setting is commented out", () => {
    const r = parseConfig(text);
    const none = parseConfig("");
    expect(r.errors).toEqual([]);
    const km = /** @type {import("../src/keys/keymap.mjs").Keymap} */ (r.keymap);
    const kmNone = /** @type {import("../src/keys/keymap.mjs").Keymap} */ (none.keymap);
    expect(bindingTable(km)).toEqual(bindingTable(kmNone));
    for (const mode of MODES) expect(km.sequences(mode)).toEqual(kmNone.sequences(mode));
    expect([km.prefix, km.leader, km.timeoutMs]).toEqual([
      kmNone.prefix,
      kmNone.leader,
      kmNone.timeoutMs,
    ]);
    // The [modal.<mode>] headers stay so an uncommented line lands in its table; empty, they
    // add nothing (the keymap above is the default one).
    const modes = Object.keys(/** @type {any} */ (r.config).modal);
    expect(Object.values(/** @type {any} */ (r.config).modal)).toEqual(modes.map(() => ({})));
    expect({ ...r.config, modal: {} }).toEqual(none.config);
  });

  test("says what it is and how to use it, and lists every default binding", () => {
    expect(text.startsWith("# Vimma config")).toBe(true);
    expect(text).toContain(":source");
    expect(text).toMatch(/^schema = 2$/m);
    expect(text).toMatch(/^# new_tab = \["prefix\+c", "ctrl\+t"\]$/m);
    expect(text).toMatch(/^\[keys\]$/m);
    expect(text).not.toMatch(/^new_tab =/m);
  });

  test("its header, all comments, says how to edit it, that saves reload, :config and ctrl+b ?", () => {
    const header = text.slice(0, text.indexOf("\nschema = 2")).split("\n");
    expect(header.every((line) => line.startsWith("#"))).toBe(true);
    const said = header.join("\n");
    expect(said).toMatch(/uncomment/i);
    expect(said).toMatch(/save/i);
    expect(said).toMatch(/:config\b.*opens this file/);
    expect(said).toContain("ctrl+b ?");
    expect(said).toMatch(/remove the `# `/);
  });
});
