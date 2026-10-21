import { describe, test, expect } from "vitest";
import { createDispatcher } from "../src/dispatcher.mjs";
import { compileKeymap } from "../src/keymap.mjs";
import { chordFromEvent, formatKey, parseKey } from "../src/keys.mjs";

/** Feed space-separated chords; return all results. */
function feed(d, mode, keys) {
  return keys.split(" ").map((k) => d.dispatch(mode, parseKey(k)));
}
const last = (arr) => arr[arr.length - 1];
const make = (cfg) => createDispatcher(compileKeymap(cfg));

describe("dispatcher (spec acceptance criteria)", () => {
  test("ctrl+b then ? in normal mode shows help after pending", () => {
    const r = feed(make(), "normal", "ctrl+b ?");
    expect(r[0]).toEqual({ kind: "pending" });
    expect(r[1]).toEqual({ kind: "action", action: { id: "help.show" } });
  });

  test("ctrl+b then ? in insert mode shows help (prefix layer is global)", () => {
    expect(last(feed(make(), "insert", "ctrl+b ?"))).toEqual({
      kind: "action",
      action: { id: "help.show" },
    });
  });

  test("ctrl+b f g opens live grep; ctrl+b f then an unbound key cancels (live-grep)", () => {
    const r = feed(make(), "normal", "ctrl+b f g");
    expect(r[0]).toEqual({ kind: "pending" });
    expect(r[1]).toEqual({ kind: "pending" });
    expect(r[2]).toEqual({ kind: "action", action: { id: "grep.open" } });
    const d = make();
    feed(d, "normal", "ctrl+b f");
    expect(d.dispatch("normal", parseKey("x")).kind).not.toBe("action");
    expect(d.pending()).toEqual([]);
  });

  test("j in insert mode passes through", () => {
    expect(feed(make(), "insert", "j")[0]).toEqual({ kind: "pass" });
  });

  test("esc in insert mode returns to normal", () => {
    expect(feed(make(), "insert", "esc")[0]).toEqual({
      kind: "action",
      action: { id: "mode.normal" },
    });
  });

  test("ctrl+b then 3 jumps to tab 3", () => {
    expect(last(feed(make(), "normal", "ctrl+b 3"))).toEqual({
      kind: "action",
      action: { id: "tab.goto", arg: 3 },
    });
  });

  test("3 g t carries a count; g t alone does not", () => {
    const d = make();
    expect(last(feed(d, "normal", "3 g t"))).toEqual({
      kind: "action",
      action: { id: "tab.next", count: 3 },
    });
    expect(last(feed(d, "normal", "g t"))).toEqual({
      kind: "action",
      action: { id: "tab.next" },
    });
  });

  test("multi-digit counts accumulate including zero", () => {
    expect(last(feed(make(), "normal", "1 0 j"))).toEqual({
      kind: "action",
      action: { id: "scroll.down", count: 10 },
    });
  });

  test("0 without a count is not a count", () => {
    expect(feed(make(), "normal", "0")[0]).toEqual({ kind: "pass" });
  });

  test("a count followed by an unbound key cancels", () => {
    expect(last(feed(make(), "normal", "3 z"))).toEqual({ kind: "cancel" });
  });

  test("ctrl+b then an unbound key cancels", () => {
    expect(last(feed(make(), "normal", "ctrl+b y"))).toEqual({ kind: "cancel" });
  });

  test("ctrl+b then esc cancels", () => {
    expect(last(feed(make(), "normal", "ctrl+b esc"))).toEqual({ kind: "cancel" });
  });

  test("with prefix ctrl+a, ctrl+b passes and ctrl+a c opens a tab", () => {
    const d = make({ keys: { prefix: "ctrl+a" } });
    expect(feed(d, "normal", "ctrl+b")[0]).toEqual({ kind: "pass" });
    expect(last(feed(d, "normal", "ctrl+a c"))).toEqual({
      kind: "action",
      action: { id: "tab.new" },
    });
  });

  test("an ambiguous sequence resolves to the shorter binding on flush", () => {
    const d = make({ modal: { normal: { g: "tab.new", gg: "scroll.top" } } });
    expect(feed(d, "normal", "g")[0]).toEqual({ kind: "pending" });
    expect(d.flush()).toEqual({ kind: "action", action: { id: "tab.new" } });
    expect(d.pending()).toEqual([]);
  });

  test("an ambiguous sequence resolves to the longer binding when the next key completes it", () => {
    const d = make({ modal: { normal: { g: "tab.new", gg: "scroll.top" } } });
    expect(last(feed(d, "normal", "g g"))).toEqual({
      kind: "action",
      action: { id: "scroll.top" },
    });
  });

  test("an ambiguous sequence followed by a non-continuing key runs the shorter and asks for replay", () => {
    const d = make({ modal: { normal: { g: "tab.new", gg: "scroll.top" } } });
    feed(d, "normal", "g");
    // j does not continue "g": the pending "g" resolves and the host must replay j
    const r = d.dispatch("normal", parseKey("j"));
    expect(r).toEqual({ kind: "action", action: { id: "tab.new" }, replay: true });
    expect(d.pending()).toEqual([]);
    expect(d.dispatch("normal", parseKey("j"))).toEqual({
      kind: "action",
      action: { id: "scroll.down" },
    });
  });

  test("ambiguous() is true only while flush() would resolve to an action", () => {
    const d = make({ modal: { normal: { g: "tab.new", gg: "scroll.top" } } });
    expect(d.ambiguous()).toBe(false);
    feed(d, "normal", "g");
    expect(d.ambiguous()).toBe(true);
    d.dispatch("normal", parseKey("g"));
    expect(d.ambiguous()).toBe(false);
  });

  test("a bare prefix, a dead modal prefix and a count are pending but not ambiguous", () => {
    const d = make();
    feed(d, "insert", "ctrl+b");
    expect(d.pending()).toEqual(["prefix"]);
    expect(d.ambiguous()).toBe(false);
    d.reset();
    feed(d, "normal", "g");
    expect(d.ambiguous()).toBe(false);
    d.reset();
    feed(d, "normal", "3");
    expect(d.ambiguous()).toBe(false);
  });

  test("flush with nothing pending returns null; flush on a dead prefix cancels", () => {
    const d = make();
    expect(d.flush()).toBeNull();
    feed(d, "normal", "g");
    expect(d.flush()).toEqual({ kind: "cancel" });
  });

  test("space n toggles the side panel in normal mode", () => {
    const d = make({ keys: { toggle_sidebar: ["prefix+b", "<leader>n"] } });
    expect(last(feed(d, "normal", "space n"))).toEqual({
      kind: "action",
      action: { id: "sidebar.toggle" },
    });
  });

  test("by default no leader binding exists: space n does not open the side panel", () => {
    const results = feed(make(), "normal", "space n");
    expect(results[0]).toEqual({ kind: "pass" });
    expect(results.some((r) => r.action?.id === "sidebar.toggle")).toBe(false);
    expect(last(feed(make(), "normal", "space b"))).not.toMatchObject({
      action: { id: "bookmarks.toggle" },
    });
  });

  test("leader bindings from [keys] do not fire in insert mode", () => {
    expect(feed(make(), "insert", "space")[0]).toEqual({ kind: "pass" });
  });

  test("replacing new_tab's chords removes prefix+c", () => {
    const d = make({ keys: { new_tab: ["ctrl+alt+c"] } });
    expect(last(feed(d, "normal", "ctrl+b c"))).toEqual({ kind: "cancel" });
    expect(last(feed(d, "normal", "ctrl+alt+c"))).toEqual({
      kind: "action",
      action: { id: "tab.new" },
    });
  });

  test("a dead modal sequence cancels", () => {
    expect(last(feed(make(), "normal", "g z"))).toEqual({ kind: "cancel" });
  });

  test("esc during a pending sequence cancels", () => {
    expect(last(feed(make(), "normal", "g esc"))).toEqual({ kind: "cancel" });
  });

  test("modal bindings override globals in their mode", () => {
    const d = make({
      keys: { next_workspace: ["ctrl+i"] },
      modal: { normal: { "<C-i>": "scroll.down" } },
    });
    expect(feed(d, "normal", "ctrl+i")[0]).toEqual({
      kind: "action",
      action: { id: "scroll.down" },
    });
    expect(feed(d, "insert", "ctrl+i")[0]).toEqual({
      kind: "action",
      action: { id: "workspace.next" },
    });
  });

  test("ctrl+b ) switches workspace in every mode", () => {
    for (const mode of ["normal", "insert", "visual", "panel"]) {
      expect(last(feed(make(), mode, "ctrl+b )")).action?.id).toBe("workspace.next");
    }
  });

  test("ctrl+b ( and ctrl+b ) go to the previous and next workspace in every mode", () => {
    for (const mode of ["normal", "insert", "visual", "panel"]) {
      expect(last(feed(make(), mode, "ctrl+b ("))).toEqual({
        kind: "action",
        action: { id: "workspace.previous" },
      });
      expect(last(feed(make(), mode, "ctrl+b )"))).toEqual({
        kind: "action",
        action: { id: "workspace.next" },
      });
    }
  });

  test("ctrl+b ( matches the character, so shift+8 on a Finnish layout works too", () => {
    const d = make();
    const ev = { ctrlKey: false, altKey: false, shiftKey: true, metaKey: false };
    d.dispatch("normal", parseKey("ctrl+b"));
    // event.key is "(" whichever key made it: shift+9 (US) or shift+8 (Finnish).
    expect(d.dispatch("normal", /** @type {any} */ (chordFromEvent({ ...ev, key: "(" })))).toEqual({
      kind: "action",
      action: { id: "workspace.previous" },
    });
  });

  test("ctrl+b 0 is still not bound", () => {
    expect(last(feed(make(), "normal", "ctrl+b 0"))).toEqual({ kind: "cancel" });
  });

  test("ctrl+i and ctrl+u no longer switch workspace in any mode", () => {
    for (const mode of ["normal", "insert", "visual", "panel"]) {
      for (const key of ["ctrl+i", "ctrl+u"]) {
        const id = feed(make(), mode, key)[0].action?.id;
        expect(id === "workspace.next" || id === "workspace.previous", `${mode} ${key}`).toBe(
          false,
        );
      }
    }
  });

  test.each([
    ["ctrl+d", "scroll.half_down"],
    ["ctrl+u", "scroll.half_up"],
    ["ctrl+e", "scroll.down"],
    ["ctrl+y", "scroll.up"],
    ["ctrl+o", "history.back"],
    ["ctrl+i", "history.forward"],
    ["d", "scroll.half_down"],
    ["u", "scroll.half_up"],
  ])("%s in normal mode runs %s, as in vim", (key, id) => {
    expect(feed(make(), "normal", key)[0]).toEqual({ kind: "action", action: { id } });
  });

  test.each(["ctrl+d", "ctrl+u", "ctrl+e", "ctrl+y", "ctrl+o", "ctrl+i"])(
    "%s in insert mode passes to the page",
    (key) => {
      expect(feed(make(), "insert", key)[0]).toEqual({ kind: "pass" });
    },
  );

  test("a count carries to ctrl+d", () => {
    expect(last(feed(make(), "normal", "3 ctrl+d"))).toEqual({
      kind: "action",
      action: { id: "scroll.half_down", count: 3 },
    });
  });

  test("help mode: esc closes, / filters", () => {
    const d = make();
    expect(feed(d, "help", "esc")[0]).toEqual({ kind: "action", action: { id: "help.close" } });
    expect(feed(d, "help", "/")[0]).toEqual({ kind: "action", action: { id: "help.filter" } });
  });

  test("reset clears pending state", () => {
    const d = make();
    feed(d, "normal", "ctrl+b");
    expect(d.pending().length).toBe(1);
    d.reset();
    expect(d.pending()).toEqual([]);
    expect(feed(d, "normal", "c")[0]).toEqual({ kind: "pass" });
  });

  test("pending() reports the buffered chords for the status bar", () => {
    const d = make();
    feed(d, "normal", "ctrl+b");
    expect(d.pending()).toEqual(["prefix"]);
    d.reset();
    feed(d, "normal", "2 g");
    expect(d.pending()).toEqual(["2", "g"]);
  });

  test("a mode switch mid-sequence starts fresh", () => {
    const d = make();
    feed(d, "normal", "g");
    expect(feed(d, "insert", "t")[0]).toEqual({ kind: "pass" });
  });

  test("an unknown mode is rejected", () => {
    expect(() => make().dispatch(/** @type {any} */ ("bogus"), parseKey("j"))).toThrow(/mode/);
  });
});

describe("copy mode keys (spec m1-copy-mode)", () => {
  test.each([
    ["v", "selection.toggle"],
    ["0", "caret.line_start"],
    ["$", "caret.line_end"],
    ["g g", "caret.top"],
    ["G", "caret.bottom"],
    ["y", "selection.yank"],
  ])("%s in visual mode runs %s", (keys, id) => {
    expect(last(feed(make(), "visual", keys))).toEqual({ kind: "action", action: { id } });
  });

  test("a count repeats a caret motion", () => {
    expect(last(feed(make(), "visual", "3 w"))).toEqual({
      kind: "action",
      action: { id: "caret.word_forward", count: 3 },
    });
  });
});

describe("copy mode: Vim motions, selection and yank keys", () => {
  test.each([
    ["e", "caret.word_end"],
    ["g e", "caret.word_end_backward"],
    ["W", "caret.bigword_forward"],
    ["B", "caret.bigword_backward"],
    ["E", "caret.bigword_end"],
    ["^", "caret.first_nonblank"],
    ["{", "caret.paragraph_backward"],
    ["}", "caret.paragraph_forward"],
    [";", "caret.find_repeat"],
    [",", "caret.find_repeat_reverse"],
    ["V", "selection.line"],
    ["o", "selection.swap"],
    ["i w", "selection.inner_word"],
    ["a w", "selection.a_word"],
    ["i p", "selection.inner_block"],
    ["a p", "selection.a_block"],
    ["Y", "selection.yank_lines"],
  ])("%s in visual mode runs %s", (keys, id) => {
    expect(last(feed(make(), "visual", keys))).toEqual({ kind: "action", action: { id } });
  });

  test.each([
    ["f", "caret.find_forward"],
    ["F", "caret.find_backward"],
    ["t", "caret.till_forward"],
    ["T", "caret.till_backward"],
  ])("%s waits for a character, then runs %s with it", (key, id) => {
    const d = make();
    expect(d.dispatch("visual", parseKey(key))).toEqual({ kind: "pending" });
    expect(d.ambiguous()).toBe(false);
    expect(d.pending()).toEqual([formatKey(parseKey(key))]);
    expect(d.dispatch("visual", parseKey("x"))).toEqual({
      kind: "action",
      action: { id, char: "x" },
    });
    expect(d.pending()).toEqual([]);
  });

  test("the character keeps its case, and shifted characters are themselves", () => {
    expect(last(feed(make(), "visual", "f X"))).toEqual({
      kind: "action",
      action: { id: "caret.find_forward", char: "X" },
    });
    expect(last(feed(make(), "visual", "t {"))).toEqual({
      kind: "action",
      action: { id: "caret.till_forward", char: "{" },
    });
    expect(last(feed(make(), "visual", "f space"))).toEqual({
      kind: "action",
      action: { id: "caret.find_forward", char: " " },
    });
  });

  test("a bound key is the character, not its binding (f then f, f then 3)", () => {
    expect(last(feed(make(), "visual", "f f"))).toEqual({
      kind: "action",
      action: { id: "caret.find_forward", char: "f" },
    });
    expect(last(feed(make(), "visual", "f 3"))).toEqual({
      kind: "action",
      action: { id: "caret.find_forward", char: "3" },
    });
  });

  test("a count before f is kept", () => {
    expect(last(feed(make(), "visual", "2 f a"))).toEqual({
      kind: "action",
      action: { id: "caret.find_forward", char: "a", count: 2 },
    });
  });

  test("Esc or a key that is no character cancels the pending f", () => {
    const d = make();
    expect(last(feed(d, "visual", "f esc"))).toEqual({ kind: "cancel" });
    expect(d.pending()).toEqual([]);
    expect(last(feed(d, "visual", "f enter"))).toEqual({ kind: "cancel" });
    expect(last(feed(d, "visual", "f ctrl+x"))).toEqual({ kind: "cancel" });
    expect(last(feed(d, "visual", "l"))).toEqual({
      kind: "action",
      action: { id: "caret.right" },
    });
  });

  test("flush drops a pending f", () => {
    const d = make();
    d.dispatch("visual", parseKey("f"));
    expect(d.flush()).toEqual({ kind: "cancel" });
    expect(d.pending()).toEqual([]);
  });

  test("a count repeats the new motions", () => {
    expect(last(feed(make(), "visual", "3 e"))).toEqual({
      kind: "action",
      action: { id: "caret.word_end", count: 3 },
    });
    expect(last(feed(make(), "visual", "5 j"))).toEqual({
      kind: "action",
      action: { id: "caret.down", count: 5 },
    });
  });

  test("f in normal mode is still hints", () => {
    expect(feed(make(), "normal", "f")[0]).toEqual({
      kind: "action",
      action: { id: "hint.follow" },
    });
  });
});

describe("element focus keys (docs/specs/element-focus.md, decision 7)", () => {
  test.each([
    ["v", "element.visual"],
    ["V", "element.visual_line"],
    ["y", "element.yank"],
    ["+", "element.parent"],
    ["-", "element.child"],
    ["j", "element.next"],
    ["k", "element.prev"],
    ["F", "hint.element"],
    ["esc", "mode.normal"],
  ])("%s in element mode runs %s", (keys, id) => {
    expect(last(feed(make(), "element", keys))).toEqual({ kind: "action", action: { id } });
  });

  test.each([
    ["3 j", "element.next", 3],
    ["2 k", "element.prev", 2],
    ["2 +", "element.parent", 2],
    ["4 -", "element.child", 4],
  ])("a count: %s runs %s %d times", (keys, id, count) => {
    expect(last(feed(make(), "element", keys))).toEqual({
      kind: "action",
      action: { id, count },
    });
  });

  test("F in normal mode starts element focus; gF opens a link in a background tab (decision 2)", () => {
    expect(last(feed(make(), "normal", "F"))).toEqual({
      kind: "action",
      action: { id: "hint.element" },
    });
    expect(last(feed(make(), "normal", "g F"))).toEqual({
      kind: "action",
      action: { id: "hint.follow_new_tab" },
    });
    expect(last(feed(make(), "normal", "f"))).toEqual({
      kind: "action",
      action: { id: "hint.follow" },
    });
  });

  test("a config.toml that binds F to background-tab hints keeps it", () => {
    const d = make({ modal: { normal: { F: "hint.follow_new_tab" } } });
    expect(last(feed(d, "normal", "F"))).toEqual({
      kind: "action",
      action: { id: "hint.follow_new_tab" },
    });
    expect(last(feed(d, "normal", "g F"))).toEqual({
      kind: "action",
      action: { id: "hint.follow_new_tab" },
    });
  });

  test("another plain key is no binding there (the host consumes it); chords keep theirs", () => {
    expect(last(feed(make(), "element", "x"))).toEqual({ kind: "pass" });
    expect(last(feed(make(), "element", "ctrl+b ?"))).toEqual({
      kind: "action",
      action: { id: "help.show" },
    });
  });
});

// Workspaces as Vim buffers: ctrl+^ (ctrl+6) for the alternate, ]w / [w to step, and the
// prefix forms that work in every mode.
describe("workspace keys like Vim's buffer keys", () => {
  const action = (/** @type {string} */ mode, /** @type {string} */ keys) =>
    last(feed(make(), mode, keys));
  const alternate = { kind: "action", action: { id: "workspace.last" } };

  test.each([
    ["normal", "ctrl+^"],
    ["normal", "ctrl+6"],
    ["normal", "ctrl+b ^"],
    ["normal", "ctrl+b ctrl+6"],
    ["insert", "ctrl+b ^"],
    ["insert", "ctrl+b ctrl+6"],
  ])("%s: %s goes to the alternate workspace", (mode, keys) => {
    expect(action(mode, keys)).toEqual(alternate);
  });

  test("ctrl+^ and ctrl+6 stay the page's in insert mode", () => {
    expect(action("insert", "ctrl+^")).toEqual({ kind: "pass" });
    expect(action("insert", "ctrl+6")).toEqual({ kind: "pass" });
  });

  test("] w and [ w step through the workspaces in normal mode", () => {
    expect(feed(make(), "normal", "] w")).toEqual([
      { kind: "pending" },
      { kind: "action", action: { id: "workspace.next" } },
    ]);
    expect(action("normal", "[ w")).toEqual({
      kind: "action",
      action: { id: "workspace.previous" },
    });
    expect(action("insert", "]")).toEqual({ kind: "pass" });
  });

  /**
   * A GTK keydown: `key` typed on physical key `code`.
   * @param {string} key
   * @param {string} code
   * @param {Record<string, boolean>} [mods]
   */
  const ev = (key, code, { altGraph = false, ...mods } = {}) => ({
    key,
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
    getModifierState: (/** @type {string} */ m) => m === "AltGraph" && altGraph,
  });

  test("the keydowns US and Finnish layouts send reach the same actions", () => {
    const d = make();
    const press = (/** @type {any} */ e) => d.dispatch("normal", chordFromEvent(e));
    // US: ctrl+shift+6 is "^" with shift (GTK keeps the shifted keyval under ctrl).
    expect(press(ev("^", "Digit6", { ctrlKey: true, shiftKey: true }))).toEqual(alternate);
    // Any layout: ctrl+6 is "6".
    expect(press(ev("6", "Digit6", { ctrlKey: true }))).toEqual(alternate);
    // Finnish: ] and [ are AltGr+9 and AltGr+8.
    expect(press(ev("]", "Digit9", { altGraph: true }))).toEqual({ kind: "pending" });
    expect(press(ev("w", "KeyW"))).toEqual({ kind: "action", action: { id: "workspace.next" } });
    expect(press(ev("[", "Digit8", { altGraph: true }))).toEqual({ kind: "pending" });
    expect(press(ev("w", "KeyW"))).toEqual({
      kind: "action",
      action: { id: "workspace.previous" },
    });
    // Finnish ^ is a dead key: GTK reports key "Dead" (NativeKeyToDOMKeyName.inc), no chord.
    expect(chordFromEvent(ev("Dead", "BracketRight", { ctrlKey: true, shiftKey: true }))).toBe(
      null,
    );
  });

  test("config.toml rebinds them like any other key", () => {
    const d = make({
      keys: { last_workspace: "prefix+tab" },
      modal: { normal: { "<C-^>": "tab.next", gb: "last_workspace" } },
    });
    expect(last(feed(d, "normal", "ctrl+b tab"))).toEqual(alternate);
    expect(last(feed(d, "normal", "ctrl+^"))).toEqual({
      kind: "action",
      action: { id: "tab.next" },
    });
    expect(last(feed(d, "normal", "g b"))).toEqual(alternate);
  });
});
