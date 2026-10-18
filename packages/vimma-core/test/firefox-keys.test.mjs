// Firefox's own shortcuts (docs/specs/key-handling-batch.md § 1): which <key> elements of
// #mainKeyset Vimma turns off.
import { describe, test, expect } from "vitest";
import {
  FIREFOX_SHORTCUTS,
  OVERLAP_CHORDS,
  boundChords,
  canonicalChord,
  pageFirst,
  planFirefoxKeys,
  xulKeyChord,
} from "../src/firefox-keys.mjs";
import { compileKeymap } from "../src/keymap.mjs";
import { getAction } from "../src/actions.mjs";

describe("xulKeyChord", () => {
  test.each([
    [{ key: "W", modifiers: "accel" }, "ctrl+w"],
    [{ key: "w", modifiers: "accel" }, "ctrl+w"],
    [{ key: "T", modifiers: "accel,shift" }, "ctrl+shift+t"],
    [{ key: "1", modifiers: "alt" }, "alt+1"],
    [{ key: "M", modifiers: "control" }, "ctrl+m"],
    [{ key: "Z", modifiers: "control,alt" }, "ctrl+alt+z"],
    [{ key: "+", modifiers: "accel" }, "ctrl+plus"],
    [{ key: "-", modifiers: "accel" }, "ctrl+minus"],
    [{ key: "[", modifiers: "accel" }, "ctrl+["],
    [{ key: "]", modifiers: "accel,shift" }, "ctrl+}"],
    [{ key: "4", modifiers: "control,shift" }, "ctrl+$"],
    [{ keycode: "VK_F5" }, "f5"],
    [{ keycode: "VK_F5", modifiers: "accel" }, "ctrl+f5"],
    [{ keycode: "VK_LEFT", modifiers: "alt" }, "alt+left"],
    [{ keycode: "VK_TAB", modifiers: "control,shift" }, "ctrl+shift+tab"],
    [{ keycode: "VK_ESCAPE", modifiers: "shift" }, "shift+esc"],
    [{ keycode: "VK_DELETE", modifiers: "accel,shift" }, "ctrl+shift+delete"],
    [{ keycode: "VK_BACK" }, "backspace"],
    [{ key: "W", modifiers: "accel" }, "meta+w", { mac: true }],
    [{ key: "M", modifiers: "control" }, "ctrl+m", { mac: true }],
    [{ key: "Q", modifiers: "meta" }, "meta+q"],
    [{ key: "R", modifiers: "os, accel" }, "ctrl+meta+r"],
  ])("<key %j> is %s", (el, chord, opts = {}) => {
    expect(xulKeyChord(el, opts)).toBe(chord);
  });

  test.each([
    [{ key: "", modifiers: "accel" }],
    [{}],
    [{ keycode: "VK_NOT_A_KEY" }],
    [{ key: "ab", modifiers: "accel" }],
  ])("<key %j> has no chord (not localized yet, or not one we can name)", (el) => {
    expect(xulKeyChord(el)).toBeNull();
  });
});

/** The Linux #mainKeyset keys the tests need, as the host reads them. */
const KEYS = [
  { id: "key_newNavigatorTab", chord: "ctrl+t" },
  { id: "focusURLBar", chord: "ctrl+l" },
  { id: "key_search", chord: "ctrl+k" },
  { id: "key_search2", chord: "ctrl+j" },
  { id: "openFileKb", chord: "ctrl+o" },
  { id: "key_close", chord: "ctrl+w" },
  { id: "key_viewSource", chord: "ctrl+u" },
  { id: "key_viewInfo", chord: "ctrl+i" },
  { id: "addBookmarkAsKb", chord: "ctrl+d" },
  { id: "viewBookmarksSidebarKb", chord: "ctrl+b" },
  { id: "key_gotoHistory", chord: "ctrl+h" },
  { id: "key_quitApplication", chord: "ctrl+q" },
  { id: "key_copy", chord: "ctrl+c", internal: true },
  { id: "key_reload2", chord: "f5" },
  { id: "key_stop", chord: "esc" },
  { id: "key_selectTab1", chord: "alt+1" },
  { id: "key_restoreLastClosedTabOrWindowOrSession", chord: "ctrl+shift+t" },
  { id: "", chord: "ctrl+minus" },
];
/** @param {{ off: readonly { id: string }[] }} plan */
const ids = (plan) => plan.off.map((k) => k.id);

describe("planFirefoxKeys", () => {
  test("the default list is exactly the chords Vimma or Vim use", () => {
    expect([...OVERLAP_CHORDS]).toEqual([
      "ctrl+b",
      "ctrl+d",
      "ctrl+e",
      "ctrl+h",
      "ctrl+i",
      "ctrl+k",
      "ctrl+o",
      "ctrl+u",
      "ctrl+w",
      "ctrl+y",
    ]);
  });

  test("the default turns off the overlapping keys and says which chords match nothing", () => {
    const plan = planFirefoxKeys(KEYS, { disable: OVERLAP_CHORDS, enable: [] });
    expect(ids(plan)).toEqual([
      "key_search",
      "openFileKb",
      "key_close",
      "key_viewSource",
      "key_viewInfo",
      "addBookmarkAsKb",
      "viewBookmarksSidebarKb",
      "key_gotoHistory",
    ]);
    expect(plan.unmatched).toEqual(["ctrl+e", "ctrl+y"]);
  });

  test("enable keeps a listed chord Firefox's", () => {
    const plan = planFirefoxKeys(KEYS, { disable: OVERLAP_CHORDS, enable: ["ctrl+w", "ctrl+k"] });
    expect(ids(plan)).not.toContain("key_close");
    expect(ids(plan)).not.toContain("key_search");
    expect(ids(plan)).toContain("key_viewSource");
  });

  // Decision 9: "all" is the whole inventory but fate d, plain and function keys included, and
  // ctrl+q is no longer kept (it is Vimma's quit, which asks as Firefox did).
  test('"all" turns off every inventory key and every chord with ctrl, alt or meta', () => {
    const plan = planFirefoxKeys(KEYS, { disable: "all", enable: [] });
    expect(ids(plan)).toEqual(KEYS.filter((k) => !k.internal).map((k) => k.id));
    expect(plan.unmatched).toEqual([]);
  });

  test('"all" leaves fate d keys and unlisted plain keys alone', () => {
    const keys = [
      { id: "key_fullScreen", chord: "f6" },
      { id: "plain", chord: "x" },
      { id: "key_aboutProcesses", chord: "shift+esc" },
      { id: "key_quitApplication", chord: "meta+q" },
    ];
    expect(ids(planFirefoxKeys(keys, { disable: "all", enable: [] }, { mac: true }))).toEqual([
      "key_aboutProcesses",
      "key_quitApplication",
    ]);
  });

  test('"all" with enable keeps those', () => {
    const plan = planFirefoxKeys(KEYS, { disable: "all", enable: ["ctrl+t", "alt+1"] });
    expect(ids(plan)).not.toContain("key_newNavigatorTab");
    expect(ids(plan)).not.toContain("key_selectTab1");
    expect(ids(plan)).toContain("key_close");
  });

  test("a list turns off only its chords, every key with that chord", () => {
    const keys = [...KEYS, { id: "goBackKb2", chord: "ctrl+[" }, { id: "x", chord: "ctrl+[" }];
    const plan = planFirefoxKeys(keys, { disable: ["ctrl+[", "f5"], enable: [] });
    expect(ids(plan)).toEqual(["key_reload2", "goBackKb2", "x"]);
  });

  test("an internal key is never turned off, even when listed", () => {
    const plan = planFirefoxKeys(KEYS, { disable: ["ctrl+c"], enable: [] });
    expect(ids(plan)).toEqual([]);
    expect(plan.unmatched).toEqual(["ctrl+c"]);
  });

  test("a key without a chord yet is left alone", () => {
    const plan = planFirefoxKeys([{ id: "late", chord: null }], { disable: "all", enable: [] });
    expect(ids(plan)).toEqual([]);
  });
});

// docs/specs/firefox-keys.md sub-PR 1: Firefox's keys are Vimma bindings.
describe("FIREFOX_SHORTCUTS (the inventory)", () => {
  const keymap = compileKeymap();
  const rows = FIREFOX_SHORTCUTS;

  test("is well formed: canonical chords, fates a-d, a/b rows name an existing action", () => {
    expect(rows.length).toBeGreaterThan(100);
    for (const r of rows) {
      const where = `${r.chord} ${r.id}`;
      expect(canonicalChord(r.chord), where).toBe(r.chord);
      expect(["a", "b", "c", "d"], where).toContain(r.fate);
      expect(r.does, where).toBeTruthy();
      if (r.action) expect(getAction(r.action), where).toBeDefined();
      if (r.fate === "b") expect(r.action, where).toBeTruthy();
      if (r.action) expect(["all", "normal"], where).toContain(r.modes);
      if (r.fate === "a" || r.fate === "b") expect(["P", "V"], where).toContain(r.first);
      else expect(r.first, where).toBeUndefined();
    }
  });

  test("no chord is listed twice with different actions", () => {
    /** @type {Map<string, string>} */
    const seen = new Map();
    for (const r of rows) {
      if (!r.action || r.unbound) continue;
      const prev = seen.get(r.chord);
      if (prev) expect(r.action, r.chord).toBe(prev);
      seen.set(r.chord, r.action);
    }
  });

  test("has every row of the spec's tables it names", () => {
    const byId = new Map(rows.filter((r) => r.id).map((r) => [r.id, r]));
    expect(byId.get("key_newNavigatorTab")).toMatchObject({ chord: "ctrl+t", fate: "a" });
    expect(byId.get("key_privatebrowsing")).toMatchObject({
      chord: "ctrl+shift+p",
      fate: "a",
      action: "private_workspace",
      first: "V",
    });
    expect(byId.get("key_toggleToolboxF12")).toMatchObject({ chord: "f12", action: "devtools" });
    expect(byId.get("key_dom")).toMatchObject({
      chord: "ctrl+shift+w",
      fate: "b",
      action: "devtools_dom",
    });
    expect(byId.get("key_find")).toMatchObject({
      chord: "ctrl+f",
      fate: "a",
      action: "find_forward",
      first: "P",
    });
    expect(rows.filter((r) => r.source === "devtools" && !r.conditional)).toHaveLength(14);
    expect(rows.filter((r) => /^alt\+[1-9]$/.test(r.chord))).toHaveLength(9);
    expect(rows.filter((r) => r.source === "menubar")).toHaveLength(8);
    for (const r of rows.filter((r) => r.source === "menubar")) expect(r.fate, r.chord).toBe("d");
  });

  // Decision 16: every Firefox key is a Vimma binding on Firefox's own chord.
  test.each([
    ["ctrl+j", "web_search"],
    ["ctrl+f", "find_forward"],
    ["ctrl+shift+d", "bookmark_all_tabs"],
    ["ctrl+shift+b", "toggle_bookmarks_toolbar"],
    ["ctrl+alt+x", "ai_chatbot_sidebar"],
    ["ctrl+alt+u", "open_tabs_sidebar"],
    ["ctrl+alt+z", "toggle_firefox_sidebar"],
    ["ctrl+shift+x", "switch_text_direction"],
    ["f7", "caret_browsing"],
  ])("%s runs %s by default, after the page", (chord, action) => {
    expect(keymap.trie("normal").children.get(chord)?.action?.name).toBe(action);
    expect(keymap.trie("insert").children.get(chord)?.action?.name).toBe(action);
    expect(pageFirst(chord)).toBe(true);
  });

  // Decision 17: shift+esc has no modifier that makes a chord global, so a text field keeps it.
  test("shift+esc runs about_processes in normal mode only, after the page", () => {
    expect(keymap.trie("normal").children.get("shift+esc")?.action?.name).toBe("about_processes");
    expect(keymap.trie("insert").children.get("shift+esc")).toBeUndefined();
    expect(pageFirst("shift+esc")).toBe(true);
  });

  test("the only unbound c keys are the conditional ones, ' and the alt tap", () => {
    const left = rows.filter((r) => r.fate === "c" && !r.conditional).map((r) => r.chord);
    expect(left).toEqual([
      "ctrl+f7",
      "alt+f7",
      "ctrl+alt+f7",
      "meta+f7",
      "ctrl+meta+f7",
      "alt+meta+f7",
      "ctrl+alt+meta+f7",
      "'",
    ]);
    expect(getAction("devtools_dom")).toBeDefined();
    expect(keymap.trie("normal").children.get("ctrl+shift+w")?.action?.name).toBe("close_window");
  });

  test("every a/b row with an action is bound to it by the default keymap, in its modes", () => {
    for (const r of rows) {
      if (!r.action || r.unbound) continue;
      const modes =
        r.modes === "all" ? ["normal", "insert", "visual", "panel", "help"] : ["normal"];
      for (const mode of modes) {
        const node = keymap.trie(/** @type {any} */ (mode)).children.get(r.chord);
        expect(node?.action?.name, `${r.chord} in ${mode}`).toBe(r.action);
        expect(node?.children.size, `${r.chord} in ${mode} is a whole binding`).toBe(0);
      }
    }
  });

  test("normal-only rows are not bound in insert mode", () => {
    for (const chord of ["ctrl+[", "ctrl+]", "esc"]) {
      const row = rows.find((r) => r.chord === chord && r.action);
      expect(row?.modes, chord).toBe("normal");
      expect(keymap.trie("insert").children.get(chord)?.action?.name, chord).not.toBe(row?.action);
    }
  });

  test("every c chord (but the conditional ones) is unbound by default", () => {
    const bound = boundChords(keymap);
    for (const r of rows) {
      if (r.fate !== "c" || r.conditional) continue;
      // ctrl+shift+w is close_window; the DOM panel's key on it is the one that stays off.
      if (rows.some((o) => o.chord === r.chord && o.action)) continue;
      expect(bound.has(r.chord), `${r.chord} (${r.id})`).toBe(false);
    }
  });

  test("the 47 new actions are named, and firefox_command runs any other (sub-PR 2)", () => {
    const actions = new Set(rows.filter((r) => r.fate === "b").map((r) => r.action));
    expect(actions.size).toBe(47);
    expect(getAction("firefox_command")).toMatchObject({ id: "firefox.command", group: "Browser" });
    expect(getAction("new_private_window")).toBeUndefined();
  });
});

describe("pageFirst (who goes first: decision 6)", () => {
  test.each([
    ["ctrl+s", true],
    ["ctrl+plus", true],
    ["alt+left", true],
    ["f5", true],
    ["esc", true],
    ["ctrl+shift+z", true],
    ["ctrl+t", false],
    ["ctrl+n", false],
    ["ctrl+tab", false],
    ["ctrl+shift+p", false],
    ["ctrl+q", false],
    ["ctrl+w", false],
    ["ctrl+o", false],
    ["alt+j", false],
    ["ctrl+f", true],
  ])("%s: page first %s", (chord, want) => {
    expect(pageFirst(chord)).toBe(want);
  });

  test("with the fullscreen Keyboard Lock on, Firefox's keys go to the page, but F11", () => {
    expect(pageFirst("ctrl+t", { keyboardLock: true })).toBe(true);
    expect(pageFirst("ctrl+tab", { keyboardLock: true })).toBe(true);
    expect(pageFirst("f11", { fullScreen: true, keyboardLock: true })).toBe(false);
    expect(pageFirst("alt+j", { keyboardLock: true })).toBe(false);
  });

  test("a normal-mode row is the page's first in normal mode only: Esc leaves insert at once", () => {
    expect(pageFirst("esc", { mode: "normal" })).toBe(true);
    expect(pageFirst("ctrl+[", { mode: "normal" })).toBe(true);
    for (const mode of /** @type {const} */ (["insert", "visual", "command", "hint"])) {
      expect(pageFirst("esc", { mode }), mode).toBe(false);
      expect(pageFirst("ctrl+[", { mode }), mode).toBe(false);
    }
    expect(pageFirst("ctrl+s", { mode: "insert" })).toBe(true);
  });

  test("f11 is the page's first, but Firefox's own in full screen", () => {
    expect(pageFirst("f11")).toBe(true);
    expect(pageFirst("f11", { fullScreen: true })).toBe(false);
  });
});

describe("bound means off (decision 2)", () => {
  test("boundChords: the first chord of every binding, in any mode", () => {
    const bound = boundChords(compileKeymap());
    for (const chord of ["ctrl+t", "ctrl+b", "ctrl+w", "alt+left", "ctrl+[", "esc", "f12"]) {
      expect(bound.has(chord), chord).toBe(true);
    }
    for (const chord of ["ctrl+f", "ctrl+j", "f7", "ctrl+shift+b"]) {
      expect(bound.has(chord), chord).toBe(true);
    }
    for (const chord of ["'", "alt+f", "alt+h"]) {
      expect(bound.has(chord), chord).toBe(false);
    }
  });

  test("a bound chord is off whatever disable says, an enabled one stays on", () => {
    const bound = new Set(["ctrl+t", "f5", "ctrl+w"]);
    const plan = planFirefoxKeys(KEYS, { disable: [], enable: ["ctrl+w"] }, { bound });
    expect(ids(plan)).toEqual(["key_newNavigatorTab", "key_reload2"]);
    expect(plan.unmatched).toEqual([]);
  });

  test("an internal key stays the editor's even when bound", () => {
    const plan = planFirefoxKeys(KEYS, { disable: [], enable: [] }, { bound: new Set(["ctrl+c"]) });
    expect(ids(plan)).toEqual([]);
  });
});
