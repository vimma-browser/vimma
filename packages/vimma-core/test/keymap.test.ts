import { describe, test, expect } from "vitest";
import { compileKeymap, KeymapError } from "../src/keys/keymap.mjs";
import { createDispatcher } from "../src/keys/dispatcher.mjs";
import { parseKey } from "../src/keys/keys.mjs";
import { parsePath } from "../src/config/toml.mjs";

import type { Mode } from "../src/keys/modes.mjs";
import type { TrieNode } from "../src/keys/keymap.mjs";

describe("compileKeymap", () => {
  test("compiles defaults without errors", () => {
    const km = compileKeymap();
    expect(km.prefix).toEqual({ key: "b", ctrl: true, alt: false, shift: false, meta: false });
    expect(km.leader.key).toBe("space");
  });

  test("an unknown action in [keys] fails with a suggestion", () => {
    let err;
    try {
      compileKeymap({ keys: { new_tabb: ["prefix+c"] } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(KeymapError);
    if (!(err instanceof KeymapError)) throw err;
    expect(err.path).toBe("keys.new_tabb");
    expect(err.suggestion).toBe("new_tab");
    expect(err.message).toMatch(/did you mean "new_tab"/);
  });

  // Regression (found by the fuzzer, seed 1027517388, issue #134): `keys."c[mmand"` came back
  // as the path `keys.c[mmand`, which parsePath cannot read back.
  test.each([
    [{ keys: { "c[mmand": "/" } }, 'keys."c[mmand"', ["keys", "c[mmand"]],
    [{ keys: { "new.tab": ["prefix+c"] } }, 'keys."new.tab"', ["keys", "new.tab"]],
    [{ modal: { 'n"x': {} } }, 'modal."n\\"x"', ["modal", 'n"x']],
    [{ unbind: { "a[0": [] } }, 'unbind."a[0"', ["unbind", "a[0"]],
  ])("a written name that is not bare is quoted in the error path (%j)", (user, path, segs) => {
    let err;
    try {
      compileKeymap(user);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(KeymapError);
    if (!(err instanceof KeymapError)) throw err;
    expect(err.path).toBe(path);
    expect(parsePath(err.path)).toEqual(segs);
  });

  test("an unknown action in [modal.normal] fails with a suggestion", () => {
    expect(() => compileKeymap({ modal: { normal: { j: "scroll.dwn" } } })).toThrow(/scroll\.down/);
  });

  test("bad key notation reports the config path with index", () => {
    let err;
    try {
      compileKeymap({ keys: { new_tab: ["prefix+c", "ctrl+bogus"] } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(KeymapError);
    if (!(err instanceof KeymapError)) throw err;
    expect(err.path).toBe("keys.new_tab[1]");
  });

  test("a single string is accepted where a list is expected", () => {
    const km = compileKeymap({ keys: { new_tab: "ctrl+alt+c" } });
    // [keys] replaces only the prefix-layer chords; the modal "t" binding is a separate layer
    expect(km.bindingsFor("new_tab")).toEqual(["ctrl+alt+c", "t"]);
  });

  test("the same sequence bound to two actions in one mode is an error", () => {
    expect(() => compileKeymap({ keys: { new_tab: ["prefix+n"] } })).toThrow(KeymapError);
  });

  test("an unknown mode table is an error", () => {
    expect(() => compileKeymap({ modal: { nromal: { j: "scroll.down" } } })).toThrow(/normal/);
  });

  test("unknown top-level keys in [keys] other than prefix are actions, prefix is a chord", () => {
    expect(() => compileKeymap({ keys: { prefix: "ctrl+nope" } })).toThrow(KeymapError);
    expect(compileKeymap({ keys: { prefix: "ctrl+a" } }).prefix.key).toBe("a");
  });

  test("a non-string, non-list binding value is an error", () => {
    // @ts-expect-error a number where a binding goes: the validation under test
    expect(() => compileKeymap({ keys: { new_tab: 3 } })).toThrow(KeymapError);
    expect(() => compileKeymap({ modal: { normal: { j: 3 } } })).toThrow(KeymapError);
  });

  test("unbind removes a default modal binding", () => {
    const km = compileKeymap({ unbind: { normal: ["x"] } });
    expect(km.bindingsFor("close_tab")).not.toContain("x");
  });

  test("unbind in an unknown mode or with bad notation is an error", () => {
    expect(() => compileKeymap({ unbind: { nope: ["x"] } })).toThrow(KeymapError);
    expect(() => compileKeymap({ unbind: { normal: ["<Bad>"] } })).toThrow(KeymapError);
  });

  test("overriding a [keys] action marks it overridden", () => {
    const km = compileKeymap({ keys: { new_tab: ["ctrl+alt+c"] } });
    expect(km.isOverridden("new_tab")).toBe(true);
    expect(km.isOverridden("next_tab")).toBe(false);
  });

  test("modal bindings are listed with their mode", () => {
    const km = compileKeymap();
    expect(km.bindingsFor("scroll_down")).toContain("j");
  });

  test("leader and timeout come from [modal]", () => {
    const km = compileKeymap({ modal: { leader: ",", timeout_ms: 300 } });
    expect(km.leader.key).toBe(",");
    expect(km.timeoutMs).toBe(300);
  });

  test("invalid timeout_ms is an error", () => {
    expect(() => compileKeymap({ modal: { timeout_ms: -1 } })).toThrow(KeymapError);
  });
});

describe("normal-mode extras (yy, p, P, gi, gu, gU, gf)", () => {
  /** The action a key sequence reaches in `mode`, or undefined. */
  const actionAt = (mode: Mode, keys: string[]) => {
    let node: TrieNode | undefined = compileKeymap().trie(mode);
    for (const k of keys) node = node?.children.get(k);
    return node?.action?.id;
  };

  test.each([
    [["y", "y"], "page.yank_url"],
    [["p"], "page.open_clipboard"],
    [["shift+p"], "page.open_clipboard_new_tab"],
    [["g", "i"], "page.focus_input"],
    [["g", "u"], "page.url_up"],
    [["g", "shift+u"], "page.url_root"],
    [["g", "f"], "page.view_source"],
  ])("normal %j runs %s", (keys, id) => {
    expect(actionAt("normal", keys)).toBe(id);
  });

  test("]q and [q step the grep list in normal mode (live-grep)", () => {
    expect(actionAt("normal", ["]", "q"])).toBe("grep.next");
    expect(actionAt("normal", ["[", "q"])).toBe("grep.previous");
  });

  test("prefix+f is a group: no action of its own, g under it (live-grep decision 2)", () => {
    const f = compileKeymap().trie("normal").children.get("ctrl+b")?.children.get("f");
    expect(f?.action).toBeFalsy();
    expect([...(f?.children.keys() ?? [])]).toEqual(["g"]);
  });

  test("y alone is a prefix in normal mode, not an action of its own", () => {
    const y = compileKeymap().trie("normal").children.get("y");
    expect(y?.action).toBeFalsy();
    expect([...(y?.children.keys() ?? [])]).toEqual(["y"]);
  });

  test("copy mode keeps y and Y for the selection", () => {
    expect(actionAt("visual", ["y"])).toBe("selection.yank");
    expect(actionAt("visual", ["shift+y"])).toBe("selection.yank_lines");
    expect(actionAt("visual", ["p"])).toBeUndefined();
  });

  test("the keys are normal-only: insert mode has none of them", () => {
    for (const key of ["y", "p", "shift+p", "g"]) {
      expect(compileKeymap().trie("insert").children.get(key)).toBeUndefined();
    }
  });

  test("z stays unbound in normal mode (the pass-through key the tests rely on)", () => {
    expect(compileKeymap().trie("normal").children.get("z")).toBeUndefined();
  });
});

describe("I focuses the address bar", () => {
  /** The action one key reaches in `mode`, or undefined. */
  const at = (mode: Mode, key: string) => compileKeymap().trie(mode).children.get(key)?.action?.id;

  test.each(["normal", "visual", "panel"] as Mode[])("%s mode: I runs urlbar.focus", (mode) => {
    expect(at(mode, "shift+i")).toBe("urlbar.focus");
  });

  test("insert mode leaves I to the text field", () => {
    expect(at("insert", "shift+i")).toBeUndefined();
  });

  test("lower-case i keeps its own meaning", () => {
    expect(at("normal", "i")).toBe("mode.insert");
    expect(compileKeymap().trie("visual").children.get("i")?.children.has("w")).toBe(true);
  });

  test("the action is named focus_urlbar", () => {
    expect(compileKeymap().bindingsFor("focus_urlbar")).toContain("I");
  });
});

// docs/specs/firefox-keys.md decision 7: a function-key chord in [keys] is global, as
// Firefox's are.
describe("function keys in [keys]", () => {
  test("an f5 or shift+f12 binding works in every mode", () => {
    const km = compileKeymap({ keys: { goto_picker: ["f8", "shift+f8"] } });
    for (const mode of ["normal", "insert", "visual", "panel", "help"] as const) {
      expect(km.trie(mode).children.get("f8")?.action?.name, mode).toBe("goto_picker");
      expect(km.trie(mode).children.get("shift+f8")?.action?.name, mode).toBe("goto_picker");
    }
  });

  test("a plain [keys] binding stays normal-only", () => {
    const km = compileKeymap({ keys: { goto_picker: ["q"] } });
    expect(km.trie("normal").children.get("q")?.action?.name).toBe("goto_picker");
    expect(km.trie("insert").children.get("q")).toBeUndefined();
  });
});

// docs/specs/firefox-keys.md decision 9: `[firefox] enable` gives a chord back to Firefox.
describe("[firefox] enable in the keymap", () => {
  test("drops the chord's default bindings, in every mode", () => {
    const km = compileKeymap({ firefox: { enable: ["ctrl+t", "esc"] } });
    for (const mode of ["normal", "insert", "panel"] as const) {
      expect(km.trie(mode).children.get("ctrl+t"), mode).toBeUndefined();
    }
    expect(km.keysFor("new_tab")).toEqual(["ctrl+b c", "t"]);
    expect(km.keysFor("stop_loading")).toEqual([]);
    expect(km.trie("panel").children.get("esc")).toBeDefined();
  });

  test("a chord the user binds is an error at the enable line", () => {
    let err;
    try {
      compileKeymap({
        keys: { new_tab: ["ctrl+t"] },
        firefox: { enable: ["ctrl+j", "ctrl+t"] },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(KeymapError);
    if (!(err instanceof KeymapError)) throw err;
    expect(err.path).toBe("firefox.enable[1]");
    expect(err.detail).toBe("ctrl+t is bound to new_tab in [keys]; unbind it or drop it here");
  });

  test("a [modal.*] binding of the user names its table", () => {
    expect(() =>
      compileKeymap({
        modal: { normal: { "<C-j>": "new_tab" } },
        firefox: { enable: ["ctrl+j"] },
      }),
    ).toThrow("ctrl+j is bound to new_tab in [modal.normal]; unbind it or drop it here");
  });
});

// docs/specs/page-suggestions.md: ctrl+n and ctrl+p in insert mode, and their fallback.
describe("suggestion keys in insert mode", () => {
  test("ctrl+n and ctrl+p move through a page's suggestion list", () => {
    const km = compileKeymap();
    expect(km.trie("insert").children.get("ctrl+n")?.action?.name).toBe("suggestion_next");
    expect(km.trie("insert").children.get("ctrl+p")?.action?.name).toBe("suggestion_prev");
    expect(km.trie("normal").children.get("ctrl+p")?.action?.name).toBe("print_page");
  });

  test("the fallback is the chord's [keys] binding in that mode", () => {
    const km = compileKeymap();
    expect(km.fallback("insert", "ctrl+p")?.name).toBe("print_page");
    // new_window is on ctrl+b shift+c (decision 7): with no list open ctrl+n is the page's.
    expect(km.fallback("insert", "ctrl+n")).toBeNull();
    expect(km.fallback("normal", "ctrl+p")).toBeNull();
    expect(km.fallback("insert", "ctrl+x")).toBeNull();
  });

  test("new_window is ctrl+b shift+c, and ctrl+n has no binding outside insert mode", () => {
    const km = compileKeymap();
    expect(km.keysFor("new_window")).toEqual(["ctrl+b shift+c"]);
    expect(km.trie("normal").children.get("ctrl+b")?.children.get("shift+c")?.action?.name).toBe(
      "new_window",
    );
    for (const mode of ["normal", "visual", "panel", "help", "command"] as const)
      expect(km.trie(mode).children.get("ctrl+n"), mode).toBeUndefined();
  });

  test("a user's [keys] binding on the chord is the fallback", () => {
    const km = compileKeymap({ keys: { new_tab: ["ctrl+n"] } });
    expect(km.fallback("insert", "ctrl+n")?.name).toBe("new_tab");
  });

  test("[unbind] insert drops the suggestion key", () => {
    const km = compileKeymap({ unbind: { insert: ["<C-n>"] } });
    expect(km.trie("insert").children.get("ctrl+n")).toBeUndefined();
  });

  test("[firefox] enable drops the default suggestion binding on its chord", () => {
    const km = compileKeymap({ firefox: { enable: ["ctrl+n"] } });
    expect(km.trie("insert").children.get("ctrl+n")).toBeUndefined();
    expect(km.keysFor("suggestion_next")).toEqual([]);
    expect(km.fallback("insert", "ctrl+n")).toBeNull();
    expect(km.trie("insert").children.get("ctrl+p")?.action?.name).toBe("suggestion_prev");
  });

  test("a user's [modal.insert] binding on the enabled chord is an error", () => {
    expect(() =>
      compileKeymap({
        modal: { insert: { "<C-n>": "suggestion_next" } },
        firefox: { enable: ["ctrl+n"] },
      }),
    ).toThrow("ctrl+n is bound to suggestion_next in [modal.insert]; unbind it or drop it here");
  });

  // Issue #1261: ctrl+j and ctrl+k too, beside ctrl+n and ctrl+p.
  test("ctrl+j and ctrl+k move through the list too, in insert mode only", () => {
    const km = compileKeymap();
    expect(km.trie("insert").children.get("ctrl+j")?.action?.name).toBe("suggestion_next");
    expect(km.trie("insert").children.get("ctrl+k")?.action?.name).toBe("suggestion_prev");
    expect(km.keysFor("suggestion_next")).toEqual(["ctrl+n [insert]", "ctrl+j [insert]"]);
    expect(km.keysFor("suggestion_prev")).toEqual(["ctrl+p [insert]", "ctrl+k [insert]"]);
    expect(km.trie("normal").children.get("ctrl+j")?.action?.name).toBe("web_search");
    expect(km.trie("normal").children.get("ctrl+k")).toBeUndefined();
  });

  test("outside a list ctrl+j and ctrl+k have no [keys] fallback", () => {
    const km = compileKeymap();
    // web_search on ctrl+j is a text-field key's default (key-handling-batch § 2), not bound in
    // insert mode: there the host presses Enter instead, as before.
    expect(km.fallback("insert", "ctrl+j")).toBeNull();
    expect(km.fallback("insert", "ctrl+k")).toBeNull();
  });

  test("with insert_editing off, ctrl+j falls back to the web search", () => {
    const km = compileKeymap({ modal: { insert_editing: false } });
    expect(km.trie("insert").children.get("ctrl+j")?.action?.name).toBe("suggestion_next");
    expect(km.fallback("insert", "ctrl+j")?.name).toBe("web_search");
  });

  test("a user's bindings on ctrl+j and ctrl+k are kept", () => {
    const own = compileKeymap({ modal: { insert: { "<C-j>": "tab.new", "<C-k>": "tab.close" } } });
    expect(own.trie("insert").children.get("ctrl+j")?.action?.name).toBe("new_tab");
    expect(own.trie("insert").children.get("ctrl+k")?.action?.name).toBe("close_tab");
    expect(own.keysFor("suggestion_next")).toEqual(["ctrl+n [insert]"]);
    const keys = compileKeymap({ keys: { new_tab: ["ctrl+k"] } });
    expect(keys.fallback("insert", "ctrl+k")?.name).toBe("new_tab");
    expect(keys.trie("normal").children.get("ctrl+k")?.action?.name).toBe("new_tab");
    const unbound = compileKeymap({ unbind: { insert: ["<C-j>", "<C-k>"] } });
    expect(unbound.trie("insert").children.get("ctrl+j")).toBeUndefined();
    expect(unbound.trie("insert").children.get("ctrl+k")).toBeUndefined();
  });

  test("[firefox] enable = ['ctrl+j'] drops the suggestion binding on ctrl+j alone", () => {
    const km = compileKeymap({ firefox: { enable: ["ctrl+j"] } });
    expect(km.trie("insert").children.get("ctrl+j")).toBeUndefined();
    expect(km.keysFor("suggestion_next")).toEqual(["ctrl+n [insert]"]);
    expect(km.trie("insert").children.get("ctrl+k")?.action?.name).toBe("suggestion_prev");
  });
});

// docs/specs/firefox-keys.md decision 5: a `:` value runs a command line.
describe(": bindings in [modal.*]", () => {
  test("compile to a command binding with its line", () => {
    const km = compileKeymap({
      modal: { normal: { "<C-S-y>": ":firefox Tools:Downloads" } },
    });
    const action = km.trie("normal").children.get("ctrl+shift+y")?.action;
    expect(action).toMatchObject({ id: "cmdline.run", line: "firefox Tools:Downloads" });
    expect(km.commands()).toEqual([
      { line: ":firefox Tools:Downloads", bindings: ["ctrl+shift+y"], name: action?.name },
    ]);
    // Only normal mode has it: insert mode keeps the default downloads binding.
    expect(km.trie("insert").children.get("ctrl+shift+y")?.action?.name).toBe("downloads");
  });

  test("an unknown command word is an error at its line, with a suggestion", () => {
    let err;
    try {
      compileKeymap({ modal: { normal: { x: ":firfox Tools:Downloads" } } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(KeymapError);
    if (!(err instanceof KeymapError)) throw err;
    expect(err.path).toBe('modal.normal."x"');
    expect(err.detail).toBe('not a command: "firfox"');
    expect(err.suggestion).toBe("firefox");
  });

  test("the defaults have no command bindings", () => {
    expect(compileKeymap().commands()).toEqual([]);
  });
});

// Issue #386, docs/specs/macos-build.md decision 29: Option types characters on a Mac, so the
// default alt keys are Firefox's macOS chords there (browser-sets.inc.xhtml, Firefox 159).
describe("macOS defaults: Firefox's macOS chords for the alt keys", () => {
  const linux = compileKeymap();
  const mac = compileKeymap({}, { mac: true });
  const at = (km: ReturnType<typeof compileKeymap>, chord: string, mode: Mode = "normal") =>
    km.trie(mode).children.get(chord)?.action?.name;

  const MAC: Array<[string, string]> = [
    ["meta+left", "history_back"],
    ["meta+right", "history_forward"],
    ["meta+[", "history_back"],
    ["meta+]", "history_forward"],
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n): [string, string] => [`meta+${n}`, `select_tab_${n}`]),
    ["meta+9", "select_last_tab"],
    ["meta+l", "focus_urlbar"],
    // goHome is alt+home on every platform, and Option+Home types no character.
    ["alt+home", "go_home"],
  ];

  test.each(MAC)("%s runs %s on macOS, in every mode", (chord, action) => {
    for (const mode of ["normal", "insert", "visual", "panel", "help"] as const) {
      expect(at(mac, chord, mode), `${chord} in ${mode}`).toBe(action);
    }
  });

  test("the Linux alt chords Option turns into characters are unbound on macOS", () => {
    for (const chord of ["alt+left", "alt+right", "alt+d", "alt+1", "alt+8", "alt+9"]) {
      expect(at(mac, chord), chord).toBeUndefined();
    }
  });

  test("Linux keeps its defaults: the alt chords, and no meta chord", () => {
    expect(at(linux, "alt+left")).toBe("history_back");
    expect(at(linux, "alt+right")).toBe("history_forward");
    expect(at(linux, "alt+d")).toBe("focus_urlbar");
    expect(at(linux, "alt+1")).toBe("select_tab_1");
    expect(at(linux, "alt+9")).toBe("select_last_tab");
    expect(at(linux, "alt+home")).toBe("go_home");
    for (const [chord] of MAC.filter(([c]) => c.startsWith("meta+"))) {
      expect(at(linux, chord), chord).toBeUndefined();
    }
    expect(compileKeymap({}, { mac: false }).bindingsFor("history_back")).toEqual(
      linux.bindingsFor("history_back"),
    );
  });

  test("the keys macOS shares with Linux stay: prefix keys, ctrl+l, ctrl+[ and ctrl+]", () => {
    expect(mac.bindingsFor("select_tab_1")).toEqual(["prefix+1", "meta+1"]);
    expect(mac.bindingsFor("select_tab_9")).toEqual(["prefix+9"]);
    expect(mac.bindingsFor("focus_urlbar").slice(0, 2)).toEqual(["ctrl+l", "meta+l"]);
    expect(mac.bindingsFor("focus_urlbar")).not.toContain("alt+d");
    expect(at(mac, "ctrl+[")).toBe("history_back");
    expect(at(mac, "ctrl+]")).toBe("history_forward");
    expect(at(mac, "ctrl+t")).toBe("new_tab");
  });

  test("a user's [keys] list replaces the macOS default as it does Linux's", () => {
    const km = compileKeymap({ keys: { history_back: ["ctrl+alt+h"] } }, { mac: true });
    expect(km.bindingsFor("history_back")).toContain("ctrl+alt+h");
    expect(at(km, "meta+left")).toBeUndefined();
    expect(at(km, "meta+right")).toBe("history_forward");
  });

  test("[firefox] enable gives a macOS chord back to Firefox", () => {
    const km = compileKeymap({ firefox: { enable: ["meta+left"] } }, { mac: true });
    expect(at(km, "meta+left")).toBeUndefined();
    expect(at(km, "meta+[")).toBe("history_back");
  });
});

// docs/specs/key-handling-batch.md § 2: ctrl+j and ctrl+m are Enter in a text field, as in Vim.
describe("text-field keys before default [keys] bindings", () => {
  const at = (km: any, mode: string, key: string) => km.trie(mode).children.get(key)?.action?.name;

  test("ctrl+j and ctrl+m are unbound where keys type into a field, bound elsewhere", () => {
    const km = compileKeymap();
    for (const mode of ["insert", "command", "help"]) {
      expect(at(km, mode, "ctrl+j"), mode).toBeUndefined();
      expect(at(km, mode, "ctrl+m"), mode).toBeUndefined();
    }
    for (const mode of ["normal", "panel", "pdf"]) {
      expect(at(km, mode, "ctrl+j"), mode).toBe("web_search");
      expect(at(km, mode, "ctrl+m"), mode).toBe("mute_tab");
    }
  });

  test("other default chords stay bound in insert mode", () => {
    expect(at(compileKeymap(), "insert", "ctrl+l")).toBe("focus_urlbar");
  });

  test("insert_editing = false keeps the bindings in every mode", () => {
    const km = compileKeymap({ modal: { insert_editing: false } });
    expect(at(km, "insert", "ctrl+j")).toBe("web_search");
    expect(at(km, "command", "ctrl+m")).toBe("mute_tab");
  });

  test("a binding the user added wins in insert mode; one repeating the default does not", () => {
    const keys = compileKeymap({ keys: { reload: "ctrl+m", mute_tab: "alt+m" } });
    expect(at(keys, "insert", "ctrl+m")).toBe("reload");
    const copied = compileKeymap({ keys: { mute_tab: ["ctrl+m"], web_search: "<C-j>" } });
    expect(at(copied, "insert", "ctrl+m")).toBeUndefined();
    expect(at(copied, "insert", "ctrl+j")).toBeUndefined();
    expect(at(copied, "normal", "ctrl+m")).toBe("mute_tab");
    const modal = compileKeymap({ modal: { insert: { "<C-j>": "web_search" } } });
    expect(at(modal, "insert", "ctrl+j")).toBe("web_search");
  });
});

// docs/specs/close-active-tab.md: closing the active tab from insert mode and the side panel.
describe("closing the active tab from insert mode and the side panel", () => {
  const at = (km: any, mode: string, key: string) => km.trie(mode).children.get(key)?.action?.name;

  test("ctrl+w stays the field's delete-word key in insert mode by default", () => {
    const km = compileKeymap();
    expect(at(km, "insert", "ctrl+w")).toBeUndefined();
    expect(at(km, "panel", "ctrl+w")).toBeUndefined();
    expect(km.bindingsFor("panel_close_active_tab")).toEqual([]);
  });

  test("[modal.insert] <C-w> = tab.close closes the tab from a text field", () => {
    const km = compileKeymap({ modal: { insert: { "<C-w>": "tab.close" } } });
    expect(at(km, "insert", "ctrl+w")).toBe("close_tab");
    // Only there: normal mode keeps its ctrl+w pane keys, the panel and the : line their own.
    expect(at(km, "command", "ctrl+w")).toBeUndefined();
    expect(at(km, "panel", "ctrl+w")).toBeUndefined();
  });

  test("[modal.panel] <C-w> = panel.close_active_tab binds it in the side panel", () => {
    const km = compileKeymap({ modal: { panel: { "<C-w>": "panel.close_active_tab" } } });
    expect(at(km, "panel", "ctrl+w")).toBe("panel_close_active_tab");
    const d = createDispatcher(km);
    expect(d.dispatch("panel", parseKey("ctrl+w"))).toEqual({
      kind: "action",
      action: { id: "panel.close_active_tab" },
    });
  });

  test("[keys] close_tab with ctrl+w is a global chord: insert, panel and the : line", () => {
    const km = compileKeymap({ keys: { close_tab: ["prefix+shift+x", "ctrl+w"] } });
    for (const mode of ["insert", "panel", "command"]) {
      expect(at(km, mode, "ctrl+w"), mode).toBe("close_tab");
    }
  });
});

/** The message compileKeymap fails with, or undefined when it compiles. */
function failure(user: Parameters<typeof compileKeymap>[0]): string | undefined {
  try {
    compileKeymap(user);
  } catch (e) {
    if (!(e instanceof KeymapError)) throw e;
    return e.message;
  }
  return undefined;
}

describe("compileKeymap: what each config error says", () => {
  test("KeymapError names itself and adds its path and suggestion", () => {
    const e = new KeymapError("unknown action", "keys.x", "new_tab");
    expect(e.name).toBe("KeymapError");
    expect(e.message).toBe('keys.x: unknown action (did you mean "new_tab"?)');
    expect(new KeymapError("bad", "keys.x").message).toBe("keys.x: bad");
  });

  test.each<[string, Parameters<typeof compileKeymap>[0], string]>([
    ["a bad prefix", { keys: { prefix: "ctrl+" } }, 'keys.prefix: missing key in "ctrl+"'],
    ["a bad leader", { modal: { leader: "ctrl+" } }, 'modal.leader: missing key in "ctrl+"'],
    [
      "a list holding a non-string",
      { keys: { new_tab: ["c", 5] as never } },
      "keys.new_tab: expected a key string or a list of key strings",
    ],
    [
      "bad notation in a list",
      { keys: { new_tab: ["ctrl+alt+c", "ctrl+"] } },
      'keys.new_tab[1]: missing key in "ctrl+"',
    ],
    [
      "bad notation in a single string",
      { keys: { new_tab: "ctrl+" } },
      'keys.new_tab: missing key in "ctrl+"',
    ],
    [
      "an unknown modal table",
      { modal: { hnt: {} } },
      'modal.hnt: unknown mode "hnt" (did you mean "hint"?)',
    ],
    [
      "a modal value that is not a string",
      { modal: { normal: { j: 5 } } as never },
      'modal.normal."j": expected an action name',
    ],
    [
      "a bare : binding",
      { modal: { normal: { gd: ":" } } },
      'modal.normal."gd": expected a command after :',
    ],
    [
      "the prefix in [modal.pdf]",
      { modal: { pdf: { "<C-b>x": "scroll.down" } } },
      'modal.pdf."<C-b>x": [modal.pdf] cannot bind the prefix',
    ],
    ["an unknown [unbind] table", { unbind: { nrml: ["j"] } }, 'unbind.nrml: unknown mode "nrml"'],
    [
      "bad notation in [unbind]",
      { unbind: { normal: ["ctrl+"] } },
      'unbind.normal[0]: missing key in "ctrl+"',
    ],
    [
      "a [firefox] enable that is not a list",
      { firefox: { enable: 5 } } as never,
      "firefox.enable: expected a key string or a list of key strings",
    ],
  ])("%s", (_name, user, message) => {
    expect(failure(user)).toBe(message);
  });

  test.each([["100"], [Infinity], [NaN], [-1]])("timeout_ms %j is refused", (timeout) => {
    expect(failure({ modal: { timeout_ms: timeout as never } })).toBe(
      "modal.timeout_ms: must be a non-negative number of milliseconds",
    );
  });

  test("a conflict names the mode", () => {
    expect(failure({ keys: { new_tab: ["ctrl+alt+c"], quit: ["ctrl+alt+c"] } })).toBe(
      'keys.quit: "ctrl+alt+c" is already bound to new_tab in normal mode',
    );
  });
});

describe("compileKeymap: : bindings", () => {
  test("the command line drops the colons and white space around it", () => {
    for (const value of [
      ":firefox Tools:Downloads ",
      "::firefox Tools:Downloads",
      ": firefox Tools:Downloads",
    ]) {
      const node = compileKeymap({ modal: { normal: { gd: value } } })
        .trie("normal")
        .children.get("g")
        ?.children.get("d");
      expect(node?.action).toMatchObject({ id: "cmdline.run", line: "firefox Tools:Downloads" });
    }
  });

  test("one command line bound twice is one Commands row with both bindings", () => {
    const km = compileKeymap({
      modal: {
        normal: { gd: ":firefox Tools:Downloads" },
        visual: { gd: ":firefox Tools:Downloads" },
      },
    });
    expect(km.commands()).toEqual([
      {
        line: ":firefox Tools:Downloads",
        bindings: ["gd", "gd [visual]"],
        name: ":firefox Tools:Downloads",
      },
    ]);
    const node = km.trie("normal").children.get("g")?.children.get("d");
    expect(node?.action).toMatchObject({ group: "Commands" });
    expect(km.trie("visual").children.get("g")?.children.get("d")?.action).toBe(node?.action);
  });

  test("a : binding on the prefix shows the prefix's keys", () => {
    const km = compileKeymap({ modal: { normal: { "prefix+d": ":firefox Tools:Downloads" } } });
    expect(km.commands()[0]?.bindings).toEqual(["ctrl+b d"]);
  });

  test("a : binding unbound everywhere leaves the Commands group", () => {
    const km = compileKeymap({
      modal: { normal: { gd: ":firefox Tools:Downloads" } },
      unbind: { normal: ["gd"] },
    });
    expect(km.commands()).toEqual([]);
  });
});

describe("compileKeymap: the modes a [keys] binding reaches", () => {
  const has = (km: ReturnType<typeof compileKeymap>, mode: Mode, seq: string, pdf = false) =>
    km.sequences(mode, pdf ? "pdf" : "page").some((s) => s.seq === seq);

  test("a leader binding reaches normal mode, the side panel and the pdf context only", () => {
    const km = compileKeymap({ keys: { toggle_sidebar: ["<leader>n"] } });
    expect(has(km, "normal", "space n")).toBe(true);
    expect(has(km, "panel", "space n")).toBe(true);
    expect(has(km, "normal", "space n", true)).toBe(true);
    expect(has(km, "insert", "space n")).toBe(false);
  });

  test("a plain binding reaches normal mode and the pdf context, not the side panel", () => {
    const km = compileKeymap({ keys: { new_tab: ["Q"] } });
    expect(has(km, "normal", "shift+q")).toBe(true);
    expect(has(km, "normal", "shift+q", true)).toBe(true);
    expect(has(km, "panel", "shift+q")).toBe(false);
  });

  test.each(["f1", "f10"])("a function key (%s) works in every mode", (key) => {
    const km = compileKeymap({ keys: { new_tab: [key] } });
    expect(has(km, "insert", key)).toBe(true);
  });

  test("the prefix may be bound in a mode's own table outside the pdf context", () => {
    expect(failure({ modal: { visual: { "<C-b>": "scroll.down" } } })).toBeUndefined();
  });

  test("the same binding listed twice for one action is no conflict and lists once", () => {
    const km = compileKeymap({ keys: { new_tab: ["ctrl+alt+c", "ctrl+alt+c"] } });
    expect(km.bindingsFor("new_tab").filter((b) => b.startsWith("ctrl"))).toEqual(["ctrl+alt+c"]);
  });

  test("of two spellings of one binding, the first names the pending keys", () => {
    const leader = compileKeymap({ keys: { new_tab: ["<leader>c", "space c"] } });
    expect(leader.trie("normal").children.get("space")?.label).toBe("leader");
    const plain = compileKeymap({ keys: { new_tab: ["space c", "<leader>c"] } });
    expect(plain.trie("normal").children.get("space")?.label).toBe("space");
  });

  test("a [keys] binding left only outside normal mode carries no mode in listings", () => {
    const km = compileKeymap({
      keys: { new_tab: ["ctrl+alt+c"] },
      unbind: { normal: ["ctrl+alt+c"] },
    });
    expect(km.bindingsFor("new_tab").filter((b) => b.startsWith("ctrl"))).toEqual(["ctrl+alt+c"]);
  });
});

describe("compileKeymap: overrides, unbinding and Firefox's keys", () => {
  test("a user modal binding marks its action, and the one it replaced, as overridden", () => {
    const km = compileKeymap({ modal: { normal: { j: "scroll.up" } } });
    expect(km.isOverridden("scroll_up")).toBe(true);
    expect(km.isOverridden("scroll_down")).toBe(true);
    expect(compileKeymap().isOverridden("scroll_down")).toBe(false);
  });

  test("unbinding in normal mode unbinds the pdf context too, and in another mode only there", () => {
    const km = compileKeymap({ unbind: { normal: ["j"], insert: ["ctrl+t"] } });
    expect(km.sequences("normal", "pdf").some((s) => s.seq === "j")).toBe(false);
    expect(km.sequences("normal", "pdf").some((s) => s.seq === "ctrl+t")).toBe(true);
    expect(km.sequences("insert").some((s) => s.seq === "ctrl+t")).toBe(false);
    expect(km.isOverridden("scroll_down")).toBe(true);
  });

  test("[firefox] enable drops a default [keys] binding whatever its action", () => {
    const km = compileKeymap({ firefox: { enable: ["ctrl+shift+a"] } });
    expect(km.sequences("normal").some((s) => s.seq === "ctrl+shift+a")).toBe(false);
  });

  test("[firefox] enable passes over a user binding that is unbound everywhere", () => {
    expect(
      failure({
        modal: { visual: { "<C-e>": "scroll.down" } },
        unbind: { visual: ["ctrl+e"] },
        firefox: { enable: ["ctrl+e"] },
      }),
    ).toBeUndefined();
  });

  test("fallback is null for a [keys] binding nothing shadows", () => {
    expect(compileKeymap().fallback("normal", "ctrl+t")).toBeNull();
  });
});
