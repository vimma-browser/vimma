// A [keys] binding the user wrote on a default action's key (#1633): the user's binding wins, the
// default action loses only that key, and a warning names the clash instead of the whole file
// being refused. Two of the user's own bindings on one key stay an error.
import { describe, test, expect } from "vitest";
import { compileKeymap, KeymapError } from "../src/keys/keymap.mjs";
import { parseConfig } from "../src/config/config.mjs";

const prefixN = (keymap: ReturnType<typeof compileKeymap>) =>
  keymap.trie("normal").children.get("ctrl+b")?.children.get("n")?.action?.name;

describe("compileKeymap: a user binding on a default's key", () => {
  test("wins, and the default keeps its other keys", () => {
    const keymap = compileKeymap({ keys: { new_tab: ["prefix+n"] } });
    expect(prefixN(keymap)).toBe("new_tab");
    expect(keymap.bindingsFor("next_tab")).toEqual(["ctrl+tab", "ctrl+pagedown", "gt"]);
    expect(keymap.trie("insert").children.get("ctrl+tab")?.action?.name).toBe("next_tab");
    expect(keymap.isOverridden("next_tab")).toBe(true);
    expect(keymap.warnings).toEqual([
      {
        path: "keys.new_tab[0]",
        message:
          '"prefix+n" takes next_tab\'s default key; next_tab keeps ctrl+tab, ctrl+pagedown and gt',
      },
    ]);
  });

  test("a default left with no key says how to give it one", () => {
    const keymap = compileKeymap({ keys: { new_tab: ["prefix+c", "prefix+shift+t"] } });
    expect(keymap.bindingsFor("rename_tab")).toEqual([]);
    expect(keymap.warnings).toEqual([
      {
        path: "keys.new_tab[1]",
        message:
          '"prefix+shift+t" takes rename_tab\'s default key, so rename_tab has no key:' +
          " bind it under [keys] to get it back",
      },
    ]);
  });

  test("a key the defaults leave free warns about nothing", () => {
    expect(compileKeymap({ keys: { new_tab: ["prefix+c", "ctrl+alt+c"] } }).warnings).toEqual([]);
    expect(compileKeymap().warnings).toEqual([]);
  });

  test("a taken key shadowed by a modal binding falls back to the user's action", () => {
    // In insert mode a suggestion list's ctrl+p hides [keys]' ctrl+p, which runs outside a list.
    const keymap = compileKeymap({ keys: { reload: ["ctrl+p"] } });
    expect(keymap.fallback("insert", "ctrl+p")?.name).toBe("reload");
    expect(keymap.warnings).toMatchObject([{ message: expect.stringMatching(/print_page/) }]);
  });

  test("listing the default action's own keys takes the key without a warning", () => {
    const keymap = compileKeymap({
      keys: { new_tab: ["prefix+n"], next_tab: ["ctrl+tab", "ctrl+pagedown"] },
    });
    expect(prefixN(keymap)).toBe("new_tab");
    expect(keymap.warnings).toEqual([]);
  });

  test("two of the user's own bindings on one key stay an error", () => {
    expect(() =>
      compileKeymap({ keys: { new_tab: ["ctrl+alt+c"], quit: ["ctrl+alt+c"] } }),
    ).toThrow(KeymapError);
  });
});

describe("parseConfig: a user binding on a default's key", () => {
  test("applies the file, with the warning at the user's line", () => {
    const r = parseConfig('[keys]\nnew_tab = "prefix+n"\n');
    expect(r.errors).toEqual([]);
    expect(r.config).not.toBeNull();
    expect(r.keymap && prefixN(r.keymap)).toBe("new_tab");
    expect(r.warnings).toEqual([
      {
        line: 2,
        path: "keys.new_tab",
        message:
          '"prefix+n" takes next_tab\'s default key; next_tab keeps ctrl+tab, ctrl+pagedown and gt',
      },
    ]);
  });

  test("an alias is named as the user wrote it", () => {
    const r = parseConfig('[keys]\nprev_workspace = ["prefix+n"]\n');
    expect(r.warnings).toMatchObject([{ line: 2, path: "keys.prev_workspace[0]" }]);
  });

  test("macOS's default keys decide the clash", () => {
    // meta+9 is select_last_tab on macOS only.
    const text = '[keys]\nnew_tab = "meta+9"\n';
    expect(parseConfig(text).warnings).toEqual([]);
    expect(parseConfig(text, { mac: true }).warnings).toMatchObject([
      { line: 2, path: "keys.new_tab", message: expect.stringMatching(/select_last_tab/) },
    ]);
  });
});
