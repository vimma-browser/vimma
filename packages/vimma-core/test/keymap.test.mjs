import { describe, test, expect } from "vitest";
import { compileKeymap, KeymapError } from "../src/keymap.mjs";
import { parsePath } from "../src/toml.mjs";

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
  /**
   * The action a key sequence reaches in `mode`, or undefined.
   * @param {string} mode
   * @param {string[]} keys
   */
  const actionAt = (mode, keys) => {
    let node = compileKeymap().trie(/** @type {any} */ (mode));
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
  /**
   * The action one key reaches in `mode`, or undefined.
   * @param {string} mode
   * @param {string} key
   */
  const at = (mode, key) =>
    compileKeymap()
      .trie(/** @type {any} */ (mode))
      .children.get(key)?.action?.id;

  test.each(["normal", "visual", "panel"])("%s mode: I runs urlbar.focus", (mode) => {
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
    for (const mode of /** @type {const} */ (["normal", "insert", "visual", "panel", "help"])) {
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
    for (const mode of /** @type {const} */ (["normal", "insert", "panel"])) {
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
  /** @param {ReturnType<typeof compileKeymap>} km @param {string} chord @param {string} mode */
  const at = (km, chord, mode = "normal") =>
    km.trie(/** @type {any} */ (mode)).children.get(chord)?.action?.name;

  const MAC = [
    ["meta+left", "history_back"],
    ["meta+right", "history_forward"],
    ["meta+[", "history_back"],
    ["meta+]", "history_forward"],
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`meta+${n}`, `select_tab_${n}`]),
    ["meta+9", "select_last_tab"],
    ["meta+l", "focus_urlbar"],
    // goHome is alt+home on every platform, and Option+Home types no character.
    ["alt+home", "go_home"],
  ];

  test.each(MAC)("%s runs %s on macOS, in every mode", (chord, action) => {
    for (const mode of ["normal", "insert", "visual", "panel", "help"]) {
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
      expect(at(linux, /** @type {string} */ (chord)), chord).toBeUndefined();
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
