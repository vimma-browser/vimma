// docs/specs/setup-v2.md decisions 7-9 and 11: the chapters and steps of the setup as data, the
// keys their text names filled from the keymap in force, and the `<kbd>` check.
import { describe, expect, test } from "vitest";
import {
  CHAPTERS,
  PAGE_KEYS,
  STEPS,
  agentsTurnOn,
  choiceLines,
  choiceNote,
  HINT_LAYOUTS,
  actionChoices,
  actionOutcome,
  editLines,
  fillStepText,
  PRESSED_MAX,
  guessLayout,
  hintRow,
  rememberKey,
  inForceOf,
  planAtEnter,
  planChoice,
  planPrefix,
  composedRefusal,
  prefixHints,
  prefixListKeys,
  prefixNote,
  prefixRefusal,
  prefixRules,
  readPrefix,
  stepChoices,
  stepKeys,
  textParts,
  windowSketch,
} from "../src/system/setup-steps.mjs";
import { parseConfig, setConfigKeysText } from "../src/config/config.mjs";
import { compileKeymap } from "../src/keys/keymap.mjs";
import { getAction } from "../src/keys/actions.mjs";
import { chordFromEvent, formatKey, parseKey } from "../src/keys/keys.mjs";

import type { SetupChoice, SetupStep } from "../src/system/setup-steps.mjs";

const keymap = compileKeymap();
const step = (id: string) => STEPS.find((s) => s.id === id) as SetupStep;
const kbds = (html: string) => [...html.matchAll(/<kbd>([^<]*)<\/kbd>/g)].map((m) => m[1] ?? "");
const placeholders = (text: string) => [...text.matchAll(/\{keys:([a-z_]+)\}/g)].map((m) => m[1]);
/** Every key of a `<kbd>`: a sequence of chords, each one the notation parser reads. */
const parses = (key: string) =>
  key.split(" ").every((chord) => {
    try {
      parseKey(chord);
      return true;
    } catch {
      return false;
    }
  });

describe("the chapters and steps (decision 11)", () => {
  test("eleven steps in five chapters, in the spec's order, chapter digits by list order", () => {
    expect(CHAPTERS.map((c) => [c.digit, c.name, c.steps.map((s) => s.id)])).toEqual([
      [1, "Essentials", ["content_blocker", "search_engine", "colours"]],
      [2, "Moving in", ["default_browser", "bring_your_data"]],
      [3, "The window", ["address_bar", "tab_line"]],
      [4, "Your keys", ["prefix_key", "hint_letters"]],
      [5, "Privacy and agents", ["updates", "agents"]],
    ]);
    expect(STEPS.length).toBe(11);
    expect(new Set(STEPS.map((s) => s.id)).size).toBe(11);
  });

  test("every setting step's choices are a table, a key and a value the config schema accepts", () => {
    const steps = STEPS.filter((s) => s.kind === "setting" && s.choices.length);
    // Choice k of every step in one write: one config parse per k, not per choice (each parse
    // compiles the keymap), and no two steps set the same key.
    const most = Math.max(...steps.map((s) => s.choices.length));
    for (let k = 0; k < most; k++) {
      const chosen = steps.flatMap((s) => s.choices.slice(k, k + 1));
      for (const c of chosen) expect(c.edits.length, c.label).toBeGreaterThan(0);
      const r = setConfigKeysText(
        "",
        chosen.flatMap((c) => c.edits),
      );
      const labels = chosen.map((c) => c.label).join(", ");
      expect(r, labels).toHaveProperty("text");
      expect("text" in r && r.text, labels).toBeTruthy();
    }
  });

  test("the search engine step's choices are the installed engines", () => {
    const s = step("search_engine");
    expect(s.choices).toEqual([]);
    expect(stepChoices(s, {}, { engines: ["Google", "DuckDuckGo"] }).choices).toEqual([
      { label: "Google", edits: [{ table: "search", key: "default", value: "Google" }] },
      { label: "DuckDuckGo", edits: [{ table: "search", key: "default", value: "DuckDuckGo" }] },
    ]);
  });

  test("an action step has no choices and writes nothing", () => {
    for (const id of ["content_blocker", "default_browser", "bring_your_data"]) {
      expect(step(id)).toMatchObject({ kind: "action", choices: [] });
    }
  });
});

describe("keys named on the page (decisions 8 and 9)", () => {
  test("every kbd in a step's text is a page key or a placeholder's output", () => {
    for (const s of STEPS) {
      for (const k of kbds(s.text)) expect(PAGE_KEYS, `${s.id}: <kbd>${k}</kbd>`).toContain(k);
      const filled = fillStepText(s, keymap);
      expect(filled, s.id).not.toMatch(/\{keys:/);
      for (const k of kbds(filled)) expect(parses(k), `${s.id}: <kbd>${k}</kbd>`).toBe(true);
    }
  });

  test("a step's placeholders name only the actions it declares, and each exists", () => {
    for (const s of STEPS) {
      for (const name of placeholders(s.text)) expect(s.actions, s.id).toContain(name);
      for (const name of s.actions) expect(getAction(name), `${s.id}: ${name}`).toBeTruthy();
    }
  });

  test("a hand-written key in step text fails the check", () => {
    const bad = { ...step("address_bar"), text: "Press <kbd>ctrl+l</kbd>." };
    expect(kbds(bad.text).every((k) => PAGE_KEYS.includes(k))).toBe(false);
  });

  test("keys are filled from the keymap: a rebound key shows, an unbound one is left out", () => {
    const s = step("address_bar");
    expect(stepKeys(keymap, "focus_urlbar")).toEqual(["ctrl+l", "alt+d", "I"]);
    expect(fillStepText(s, keymap)).toContain(
      "<kbd>ctrl+l</kbd>, <kbd>alt+d</kbd> or <kbd>I</kbd>",
    );
    const rebound = compileKeymap({ keys: { focus_urlbar: ["ctrl+k"] } });
    expect(stepKeys(rebound, "focus_urlbar")).toEqual(["ctrl+k", "I"]);
    expect(fillStepText(s, rebound)).toContain("<kbd>ctrl+k</kbd> or <kbd>I</kbd>");
    expect(fillStepText(s, rebound)).not.toContain("alt+d");
  });

  test("a key normal mode binds to another action, or unbinds, is not named", () => {
    // [modal.normal] takes ctrl+l for tab.next: on a page ctrl+l no longer opens the address bar.
    const shadowed = compileKeymap({ modal: { normal: { "<C-l>": "tab.next" } } });
    expect(stepKeys(shadowed, "focus_urlbar")).toEqual(["alt+d", "I"]);
    const unbound = compileKeymap({ unbind: { normal: ["<C-l>"] } });
    expect(stepKeys(unbound, "focus_urlbar")).toEqual(["alt+d", "I"]);
    expect(fillStepText(step("address_bar"), shadowed)).toContain(
      "<kbd>alt+d</kbd> or <kbd>I</kbd> still opens",
    );
    // The prefix chords stay: they run the action in normal mode.
    expect(stepKeys(compileKeymap({ keys: { prefix: "ctrl+a" } }), "toggle_toolbar")).toEqual([
      "ctrl+a u",
    ]);
  });

  test("keys with a mode suffix are left out of a placeholder", () => {
    expect(keymap.keysFor("focus_urlbar")).toContain("I [visual]");
    expect(stepKeys(keymap, "focus_urlbar").some((k) => k.includes("["))).toBe(false);
  });

  test("an action with no key is named by its command", () => {
    const none = compileKeymap({ keys: { toggle_toolbar: [] } });
    expect(stepKeys(none, "toggle_toolbar")).toEqual([]);
    expect(fillStepText(step("address_bar"), none)).toContain("<code>:toolbar</code>");
    // The command that runs the action, not only its name.
    const s = { ...step("address_bar"), text: "{keys:check_updates}", actions: ["check_updates"] };
    expect(fillStepText(s, compileKeymap({ keys: { check_updates: [] } }))).toBe(
      "<code>:update</code>",
    );
  });

  test("the prefix step draws show_keybinds with each candidate prefix", () => {
    const now = inForce("schema = 2\n");
    const { choices } = stepChoices(step("prefix_key"), now);
    // "Choose your own" has no prefix until a key is pressed: nothing is drawn under it.
    expect(prefixHints(step("prefix_key"), keymap, choices)).toEqual([["ctrl+b ?"], []]);
    const own = compileKeymap({ keys: { prefix: "ctrl+space", show_keybinds: ["prefix+y"] } });
    const mine = stepChoices(step("prefix_key"), { "keys.prefix": "ctrl+space" }).choices;
    expect(prefixHints(step("prefix_key"), own, mine)).toEqual([["ctrl+b y"], ["ctrl+space y"]]);
  });

  test("a custom prefix in force is the second row, selected, drawn with its own key", () => {
    const own = compileKeymap({ keys: { prefix: "ctrl+space" } });
    const now = inForce('schema = 2\n[keys]\nprefix = "ctrl+space"\n');
    const r = stepChoices(step("prefix_key"), now);
    expect(r.choices.map((c) => c.label)).toEqual(["ctrl+b", "Your own: ctrl+space"]);
    expect(r.selected).toBe(1);
    // Planned as Keep: enter writes nothing, whatever the file says by then (behaviour 14).
    expect(r.choices[1]).toMatchObject({ record: true, keep: true, edits: [] });
    expect(prefixHints(step("prefix_key"), own, r.choices)).toEqual([
      ["ctrl+b ?"],
      ["ctrl+space ?"],
    ]);
    // In force: enter on it writes nothing.
    expect(planAtEnter(step("prefix_key"), r.choices[1]!, now)).toEqual([]);
    expect(choiceLines(step("prefix_key"), r.choices[1]!, now)).toEqual(["Writes nothing"]);
  });

  test("the hint letters step names the key that shows the hints, from the keymap", () => {
    expect(fillStepText(step("hint_letters"), keymap)).toContain("<kbd>f</kbd>");
    const rebound = compileKeymap({ modal: { normal: { t: "hint.follow" } } });
    expect(fillStepText(step("hint_letters"), rebound)).toContain("<kbd>t</kbd>");
  });

  test("after a new prefix, the toolbar step shows the new prefix", () => {
    expect(fillStepText(step("address_bar"), keymap)).toContain("<kbd>ctrl+b u</kbd>");
    const after = compileKeymap({ keys: { prefix: "ctrl+a" } });
    expect(fillStepText(step("address_bar"), after)).toContain("<kbd>ctrl+a u</kbd>");
  });
});

describe("choices, Keep and the line a step writes (behaviours 8, 9 and 12)", () => {
  const toolbar = step("address_bar");

  // Re-review L1: a broken config.toml with no good one before it leaves no config in force;
  // the built-in defaults are in force then, and the toolbar is hidden by default.
  test("with no config in force, the defaults are: hidden is selected and drawn", () => {
    const now = inForceOf(null);
    expect(now["ui.toolbar"]).toBe("hidden");
    expect(stepChoices(toolbar, now).selected).toBe(1);
    const tabline = step("tab_line");
    expect(windowSketch(tabline, tabline.choices[0]!, {})?.toolbar).toBe("hidden");
  });

  test("the value in force is selected", () => {
    const r = stepChoices(toolbar, { "ui.toolbar": "hidden" });
    expect(r.choices.map((c) => c.label)).toEqual(["Shown", "Hidden"]);
    expect(r.selected).toBe(1);
  });

  test("a value in force that is no choice adds keep, first and selected", () => {
    const r = stepChoices(step("hint_letters"), { "modal.hint_chars": "qwerty" });
    expect(r.choices[0]).toEqual({ label: 'Keep "qwerty"', edits: [], keep: true });
    expect(r.selected).toBe(0);
    expect(r.choices.length).toBe(step("hint_letters").choices.length + 1);
    // The prefix step's Keep is its second row, a prefix of the user's own (decision 21).
    const prefix = stepChoices(step("prefix_key"), { "keys.prefix": "ctrl+space" });
    expect(prefix.choices.map((c) => [c.label, !!c.keep])).toEqual([
      ["ctrl+b", false],
      ["Your own: ctrl+space", true],
    ]);
  });

  test("choosing the value in force plans no write", () => {
    const r = stepChoices(toolbar, { "ui.toolbar": "shown" });
    expect(planChoice(r.choices[r.selected]!, { "ui.toolbar": "shown" })).toEqual([]);
    expect(planChoice(r.choices[1]!, { "ui.toolbar": "shown" })).toEqual([
      { table: "ui", key: "toolbar", value: "hidden" },
    ]);
  });

  test("skip and keep plan no write", () => {
    const r = stepChoices(step("hint_letters"), { "modal.hint_chars": "qwerty" });
    expect(planChoice(r.choices[0]!, { "modal.hint_chars": "qwerty" })).toEqual([]);
    expect(planChoice(null, { "modal.hint_chars": "qwerty" })).toEqual([]);
  });

  test("agents: off is the first choice and in force without the key", () => {
    const r = stepChoices(step("agents"), { "mcp.enabled": false });
    expect(r.choices.map((c) => c.label)).toEqual(["Off", "On"]);
    expect(r.selected).toBe(0);
  });

  test("each setting step's shown line is the edit it plans", () => {
    expect(editLines([{ table: "ui", key: "toolbar", value: "hidden" }])).toEqual([
      '[ui] toolbar = "hidden"',
    ]);
    expect(editLines([{ table: "updates", key: "check", value: false }])).toEqual([
      "[updates] check = false",
    ]);
    expect(editLines([])).toEqual(["Writes nothing"]);
    for (const s of STEPS) {
      for (const c of s.choices) {
        expect(editLines(planChoice(c, {}))).toEqual(
          c.edits.map((e) => `[${e.table}] ${e.key} = ${JSON.stringify(e.value)}`),
        );
      }
    }
  });
});

/** The values in force for `text` (the file at `enter`) and what the window shows. */
const inForce = (text: string, runtime = {}) => {
  const { config } = parseConfig(text);
  if (!config) throw new Error(`does not parse: ${text}`);
  return inForceOf(config, runtime);
};

describe("the value in force at enter (decision 4)", () => {
  test("the file's value, else the built-in default, else what Firefox or :theme has", () => {
    expect(inForce("schema = 2\n", { engine: "Google", appearance: "dark" })).toMatchObject({
      "search.default": "Google",
      "theme.source": "omarchy",
      "theme.name": "vimma",
      "theme.appearance": "dark",
      "ui.toolbar": "hidden",
      "ui.tabline": "auto",
    });
    const set = inForce(
      'schema = 2\n[search]\ndefault = "Bing"\n[theme]\nappearance = "light"\n' +
        '[ui]\ntoolbar = "shown"\n',
      { engine: "Google", appearance: "dark" },
    );
    expect(set).toMatchObject({
      "search.default": "Bing",
      "theme.appearance": "light",
      "ui.toolbar": "shown",
    });
    expect(inForce("schema = 2\n")["theme.appearance"]).toBe("system");
  });
});

describe("your keys: the prefix and the hint letters in force (behaviours 9 and 26)", () => {
  test("the prefix and hint letters in force: the file's, else the built-in default", () => {
    expect(inForce("schema = 2\n")).toMatchObject({
      "keys.prefix": "ctrl+b",
      "modal.hint_chars": "asdfghjkl",
    });
    expect(
      inForce('schema = 2\n[keys]\nprefix = "ctrl+a"\n[modal]\nhint_chars = "arstdhneio"\n'),
    ).toMatchObject({ "keys.prefix": "ctrl+a", "modal.hint_chars": "arstdhneio" });
  });

  test("the prefix is compared as a chord, however the file spells it", () => {
    const now = inForce('schema = 2\n[keys]\nprefix = "Control+a"\n');
    expect(now["keys.prefix"]).toBe("ctrl+a");
    const r = stepChoices(step("prefix_key"), now);
    expect(r.choices[r.selected]?.label).toBe("Your own: ctrl+a");
    expect(planChoice(r.choices[r.selected]!, now)).toEqual([]);
    expect(planPrefix("ctrl+a", now)).toEqual([]);
  });

  test("the list is ctrl+b and choose your own; a key pressed writes [keys] prefix", () => {
    const now = inForce("schema = 2\n");
    const r = stepChoices(step("prefix_key"), now);
    expect(r.choices.map((c) => c.label)).toEqual(["ctrl+b", "Choose your own"]);
    expect(r.selected).toBe(0);
    expect(r.choices[1]).toMatchObject({ edits: [], record: true });
    expect(planAtEnter(step("prefix_key"), r.choices[0]!, now)).toEqual([]);
    expect(editLines(planPrefix("ctrl+a", now))).toEqual(['[keys] prefix = "ctrl+a"']);
    // The prefix in force, pressed again, writes nothing (behaviour 8).
    expect(planPrefix("ctrl+b", now)).toEqual([]);
  });
});

describe("a prefix the user presses (decision 21)", () => {
  const rules = (user = {}) => prefixRules(compileKeymap(user));
  const refused = (chord: string, user = {}) => prefixRefusal(chord, rules(user));

  test("tmux's and other chords with ctrl or alt are taken", () => {
    for (const chord of ["ctrl+a", "ctrl+space", "alt+w", "ctrl+alt+b"]) {
      expect(refused(chord), chord).toBeNull();
    }
    // The prefix in force is no refusal: it writes nothing.
    expect(refused("ctrl+b")).toBeNull();
  });

  test("a key without ctrl, alt or meta is refused: it is typed", () => {
    // Function keys too: one rule, ctrl, alt or meta.
    for (const chord of ["a", "A", "1", "space", "/", "left", "f2", "shift+f2"]) {
      expect(refused(chord), chord).toMatch(/needs ctrl, alt or meta/);
    }
  });

  test("esc, enter and tab are refused, with or without a modifier", () => {
    for (const chord of ["esc", "enter", "tab", "ctrl+enter", "alt+tab", "ctrl+esc", "shift+tab"]) {
      expect(refused(chord), chord).toMatch(/esc, enter and tab/);
    }
  });

  test("a chord the keymap binds outside the prefix is refused with its action", () => {
    expect(refused("ctrl+l")).toMatch(/ctrl\+l already runs focus_urlbar/);
    // Firefox's keys that open tabs and windows and quit are Vimma's actions by default.
    for (const chord of ["ctrl+t", "ctrl+q", "ctrl+n"]) {
      expect(refused(chord), chord).toMatch(/already runs/);
    }
    // A key the user bound in the file, and one the user freed.
    expect(refused("ctrl+a", { keys: { close_tab: ["ctrl+a"] } })).toMatch(/runs close_tab/);
    expect(refused("ctrl+l", { keys: { focus_urlbar: [] } })).toBeNull();
    // Bindings written with the prefix move with it: they are no conflict.
    expect(refused("alt+w", { keys: { toggle_toolbar: ["prefix+y"] } })).toBeNull();
  });

  test("Vim's text-field keys are refused while insert_editing is on: the prefix would not work in a field", () => {
    expect(refused("ctrl+h")).toBe(
      "ctrl+h deletes a character in text fields, where the prefix would not work. Choose another key.",
    );
    expect(refused("ctrl+w")).toMatch(/ctrl\+w deletes a word in text fields/);
    // Refused for that, not by accident of a binding: unbound, still refused.
    expect(refused("ctrl+w", { keys: { focus_pane_left: [] } })).toMatch(/deletes a word/);
    for (const chord of ["ctrl+u", "ctrl+j", "ctrl+m"]) {
      expect(refused(chord), chord).toMatch(/in text fields/);
    }
    expect(refused("ctrl+h", { modal: { insert_editing: false } })).toBeNull();
    // On macOS, Cocoa makes ctrl+h a backspace itself and Vimma adds none: no text-field key.
    expect(prefixRefusal("ctrl+h", prefixRules(compileKeymap({}, { mac: true })))).toBeNull();
  });

  test("copy, paste, cut, undo and redo, and macOS's own keys, are refused", () => {
    for (const chord of ["ctrl+c", "ctrl+v", "ctrl+x", "ctrl+z", "ctrl+shift+z"]) {
      expect(refused(chord), chord).toMatch(/which Vimma leaves to Firefox and the system/);
    }
    expect(refused("ctrl+c")).toBe("ctrl+c is copy, which Vimma leaves to Firefox and the system.");
    const mac = prefixRules(compileKeymap({}, { mac: true }));
    for (const chord of [
      "meta+c",
      "meta+v",
      "meta+x",
      "meta+z",
      "shift+meta+z",
      "meta+q",
      "meta+m",
      "meta+h",
      "meta+,",
    ]) {
      expect(prefixRefusal(chord, mac), chord).toMatch(
        /which Vimma leaves to Firefox and the system/,
      );
    }
    expect(prefixRefusal("meta+q", mac)).toBe(
      "meta+q is quit (macOS's own key), which Vimma leaves to Firefox and the system.",
    );
    // Select all stays takeable, with its note, on both.
    expect(refused("ctrl+a")).toBeNull();
    expect(prefixRefusal("meta+a", mac)).toBeNull();
  });

  test("a character Option composes is refused: Vimma would not see alt with that letter", () => {
    // macOS, US layout: option+w types ∑ and reports no AltGraph.
    const e = {
      key: "∑",
      code: "KeyW",
      altKey: true,
      ctrlKey: false,
      shiftKey: false,
      metaKey: false,
      getModifierState: () => false,
    };
    const chord = formatKey(chordFromEvent(e)!);
    expect(composedRefusal(e, chord)).toBe(
      `alt+w types ∑ on this keyboard, so Vimma sees ${chord}, not alt+w. Choose a key with ctrl or meta.`,
    );
    // Linux: alt+w is alt+w.
    expect(composedRefusal({ ...e, key: "w" }, "alt+w")).toBeNull();
    expect(composedRefusal({ ...e, key: "a", altKey: false }, "ctrl+a")).toBeNull();
  });

  test("the leader and a key given back to Firefox are refused", () => {
    expect(refused("ctrl+space", { modal: { leader: "ctrl+space" } })).toMatch(/leader/);
    expect(refused("ctrl+t", { firefox: { enable: ["ctrl+t"] } })).toMatch(/\[firefox\] enable/);
  });

  test("a key Firefox keeps for fields is taken, with a note on what it no longer does", () => {
    expect(prefixNote("ctrl+a", rules())).toBe(
      "ctrl+a is also Firefox's select all; as the prefix, it no longer does that.",
    );
    expect(prefixNote("alt+w", rules())).toBeNull();
    // macOS's inventory: select all is cmd+a there, so ctrl+a gives nothing up.
    const mac = prefixRules(compileKeymap({}, { mac: true }));
    expect(prefixNote("ctrl+a", mac)).toBeNull();
    expect(prefixNote("meta+a", mac)).toBe(
      "meta+a is also Firefox's select all; as the prefix, it no longer does that.",
    );
  });

  test("the key that lists every key is drawn with the chord pressed", () => {
    expect(prefixListKeys("alt+w", rules())).toEqual(["alt+w ?"]);
    expect(prefixListKeys("alt+w", rules({ keys: { show_keybinds: ["prefix+y"] } }))).toEqual([
      "alt+w y",
    ]);
  });

  test("the host reads only one chord in Vimma's notation", () => {
    expect(readPrefix("ctrl+a")).toBe("ctrl+a");
    expect(readPrefix("Control+a")).toBe("ctrl+a");
    for (const bad of ["ctrl+b ctrl+b", "", "ctrl+nope", "x = 1\n", 42, null, undefined]) {
      expect(readPrefix(bad), String(bad)).toBeNull();
    }
  });

  test("the rules are plain data the page can hold", () => {
    const r = rules();
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    expect(r.inForce).toBe("ctrl+b");
  });

  test("a custom hint_chars in the file adds Keep, first and selected, and Keep writes nothing", () => {
    const now = inForce('schema = 2\n[modal]\nhint_chars = "fjdkslaghei"\n');
    const r = stepChoices(step("hint_letters"), now);
    expect(r.choices[0]).toEqual({ label: 'Keep "fjdkslaghei"', edits: [], keep: true });
    expect(r.selected).toBe(0);
    expect(editLines(planAtEnter(step("hint_letters"), r.choices[0]!, now) ?? [])).toEqual([
      "Writes nothing",
    ]);
  });
});

/** A key as the page's keydown saw it: the physical key and the character it typed. */
const press = (keys: string, codes: string[]) =>
  [...keys].map((key, i) => ({ key, code: codes[i] ?? "" }));

describe("the hint letters step guesses the layout (decision 10)", () => {
  // j and k, the page's own keys, on each layout (Research, "No keyboard-layout API").
  const qwerty = press("jk", ["KeyJ", "KeyK"]);
  const colemak = press("jk", ["KeyY", "KeyN"]);
  const dvorak = press("jk", ["KeyC", "KeyV"]);
  const layouts = HINT_LAYOUTS.map((l) => l.chars);

  test("the layouts are the step's choices, in order", () => {
    expect(HINT_LAYOUTS.map((l) => l.chars)).toEqual(
      step("hint_letters").choices.map((c) => c.edits[0]?.value),
    );
  });

  test("the hint step selects the layout that matches the pressed keys, QWERTY otherwise", () => {
    expect(guessLayout(qwerty)).toBe("asdfghjkl");
    expect(guessLayout(colemak)).toBe("arstdhneio");
    expect(guessLayout(dvorak)).toBe("aoeuidhtns");
    // Shifted letters and keys that are no letter tell the same.
    expect(guessLayout([...press("J", ["KeyY"]), { key: "Enter", code: "Enter" }])).toBe(
      "arstdhneio",
    );
    // A key every layout puts in the same place says nothing more: QWERTY, the first.
    expect(guessLayout(press("a", ["KeyA"]))).toBe("asdfghjkl");
    // No letter pressed, or a layout that is none of the three (AZERTY's a on KeyQ): no guess.
    expect(guessLayout([])).toBeNull();
    expect(guessLayout(press("a", ["KeyQ"]))).toBeNull();
    expect(guessLayout([{ key: "Escape", code: "Escape" }])).toBeNull();
  });

  test("keys that fit two layouts at once fit none: QWERTY stays", () => {
    // j where QWERTY has it, k where Colemak has it.
    const mixed = press("jk", ["KeyJ", "KeyN"]);
    expect(guessLayout(mixed)).toBeNull();
    expect(hintRow(layouts, 0, mixed)).toBe(0);
  });

  test("a key that is no letter is never compared, even on a letter row", () => {
    // `;` sits on KeySemicolon on QWERTY and Colemak, and on KeyZ on Dvorak: it says nothing.
    expect(guessLayout(press(";", ["KeySemicolon"]))).toBeNull();
    expect(guessLayout([...press(";", ["KeyZ"]), ...colemak])).toBe("arstdhneio");
  });

  test("the page keeps only the latest keys, at most PRESSED_MAX", () => {
    let kept: { code: string; key: string }[] = [];
    for (let i = 0; i < PRESSED_MAX + 5; i++) kept = rememberKey(kept, { code: "KeyJ", key: "j" });
    expect(kept.length).toBe(PRESSED_MAX);
    expect(PRESSED_MAX).toBe(32);
    // The newest wins: Colemak keys pressed last are among those kept.
    for (const k of colemak) kept = rememberKey(kept, k);
    expect(kept.slice(-2)).toEqual(colemak);
    expect(kept.length).toBe(PRESSED_MAX);
    // Only letters typed without ctrl, alt or meta are kept.
    expect(rememberKey([], { code: "Enter", key: "Enter" })).toEqual([]);
    expect(rememberKey([], { code: "KeyJ", key: "j" }, { ctrl: true })).toEqual([]);
  });

  test("the guess moves the cursor off the built-in QWERTY default only", () => {
    // QWERTY in force (the default): the layout typed on is selected first.
    expect(hintRow(layouts, 0, colemak)).toBe(1);
    expect(hintRow(layouts, 0, dvorak)).toBe(2);
    expect(hintRow(layouts, 0, qwerty)).toBe(0);
    // No evidence: QWERTY, the value in force, stays.
    expect(hintRow(layouts, 0, [])).toBe(0);
    // A layout chosen before (in the file) or a custom value (Keep) stays selected.
    expect(hintRow(layouts, 2, colemak)).toBe(2);
    expect(hintRow([null, ...layouts], 0, colemak)).toBe(0);
  });
});

describe("the search engine named in another case (behaviour 8)", () => {
  const engines = ["Google", "DuckDuckGo"];
  const file = 'schema = 2\n[search]\ndefault = "duckduckgo"\n';

  test("is the installed engine of that name: selected, no Keep, enter writes nothing", () => {
    const now = inForce(file, { engines });
    expect(now["search.default"]).toBe("DuckDuckGo");
    const r = stepChoices(step("search_engine"), now, { engines });
    expect(r.choices.map((c) => c.label)).toEqual(engines);
    expect(r.selected).toBe(1);
    expect(planChoice(r.choices[1]!, now)).toEqual([]);
  });

  test("a name no engine has stays as written, for Keep", () => {
    const now = inForce('schema = 2\n[search]\ndefault = "Gone"\n', { engines });
    expect(now["search.default"]).toBe("Gone");
    expect(stepChoices(step("search_engine"), now, { engines }).choices[0]?.label).toBe(
      'Keep "Gone"',
    );
  });
});

describe("colours: the effect in force (decision 12)", () => {
  const colours = step("colours");
  const labels = (r: { choices: { label: string }[] }) => r.choices.map((c) => c.label);
  /** What enter on the choice labelled `label` writes, judged against `text` then. */
  const writes = (text: string, label: string, omarchy: boolean, runtime = {}) => {
    const now = inForce(text, runtime);
    const r = stepChoices(colours, now, { omarchy });
    const choice = r.choices.find((c) => c.label === label);
    if (!choice) throw new Error(`no ${label} in ${labels(r).join(", ")}`);
    return planAtEnter(colours, choice, now, { omarchy });
  };

  test("the Omarchy choice is listed only where an Omarchy theme is found", () => {
    expect(labels(stepChoices(colours, inForce("schema = 2\n"), { omarchy: true }))).toEqual([
      "The Omarchy theme",
      "Vimma light",
      "Vimma dark",
      "Vimma, following the system",
    ]);
    expect(labels(stepChoices(colours, inForce("schema = 2\n"), { omarchy: false }))).toEqual([
      "Vimma light",
      "Vimma dark",
      "Vimma, following the system",
    ]);
  });

  test("colours: the choice in force writes nothing, with and without an Omarchy theme", () => {
    const shown = stepChoices(colours, inForce("schema = 2\n"), { omarchy: true });
    expect(shown.choices[shown.selected]?.label).toBe("The Omarchy theme");
    expect(writes("schema = 2\n", "The Omarchy theme", true)).toEqual([]);
    const builtin = stepChoices(colours, inForce("schema = 2\n"), { omarchy: false });
    expect(builtin.choices[builtin.selected]?.label).toBe("Vimma, following the system");
    expect(writes("schema = 2\n", "Vimma, following the system", false)).toEqual([]);
    // :theme's appearance is in force without the key, and choosing it writes nothing.
    const dark = stepChoices(colours, inForce("schema = 2\n", { appearance: "dark" }), {
      omarchy: false,
    });
    expect(dark.choices[dark.selected]?.label).toBe("Vimma dark");
    expect(writes("schema = 2\n", "Vimma dark", false, { appearance: "dark" })).toEqual([]);
    // Omarchy found but turned off in the file: the built-in palette is the effect.
    const off = 'schema = 2\n[theme]\nsource = "file"\nappearance = "light"\n';
    const r = stepChoices(colours, inForce(off), { omarchy: true });
    expect(r.choices[r.selected]?.label).toBe("Vimma light");
    expect(writes(off, "Vimma light", true)).toEqual([]);
    expect(writes(off, "The Omarchy theme", true)).toEqual([
      { table: "theme", key: "source", value: "omarchy" },
    ]);
  });

  test("colours: light without an Omarchy theme writes appearance only", () => {
    expect(writes("schema = 2\n", "Vimma light", false)).toEqual([
      { table: "theme", key: "appearance", value: "light" },
    ]);
  });

  test("colours: light with an Omarchy theme writes source and appearance", () => {
    expect(writes("schema = 2\n", "Vimma light", true)).toEqual([
      { table: "theme", key: "source", value: "file" },
      { table: "theme", key: "appearance", value: "light" },
    ]);
    // The appearance :theme set is already light: only the source changes the effect.
    expect(writes("schema = 2\n", "Vimma light", true, { appearance: "light" })).toEqual([
      { table: "theme", key: "source", value: "file" },
    ]);
  });

  // #1383: vimma is the only built-in palette. The removed "tokyo-night" is vimma in force, so
  // the step offers no Keep and a choice writes no name.
  test("colours: a removed palette's name is vimma: no Keep, no name written", () => {
    const removed = 'schema = 2\n[theme]\nname = "tokyo-night"\nappearance = "dark"\n';
    const r = stepChoices(colours, inForce(removed), { omarchy: false });
    expect(r.choices.some((c) => c.keep)).toBe(false);
    expect(r.choices[r.selected]?.label).toBe("Vimma dark");
    expect(writes(removed, "Vimma light", false)).toEqual([
      { table: "theme", key: "appearance", value: "light" },
    ]);
    expect(writes(removed, "Vimma dark", false)).toEqual([]);
  });

  test('colours: another name in force is kept, and a choice also writes name = "vimma"', () => {
    const other = { ...inForce("schema = 2\n"), "theme.name": "other" };
    const r = stepChoices(colours, other, { omarchy: false });
    expect(r.choices[0]).toMatchObject({ label: 'Keep "other"', keep: true });
    expect(r.selected).toBe(0);
    expect(planAtEnter(colours, r.choices[0]!, other, { omarchy: false })).toEqual([]);
    const light = r.choices.find((c) => c.label === "Vimma light")!;
    expect(planAtEnter(colours, light, other, { omarchy: false })).toEqual([
      { table: "theme", key: "name", value: "vimma" },
      { table: "theme", key: "appearance", value: "light" },
    ]);
    expect(editLines(planChoice(light, other))).toEqual([
      '[theme] name = "vimma"',
      '[theme] appearance = "light"',
    ]);
  });

  test("a choice no longer offered at enter plans null, not an empty write", () => {
    const opened = stepChoices(colours, inForce('schema = 2\n[theme]\nsource = "file"\n'), {
      omarchy: true,
    });
    const omarchy = opened.choices.find((c) => c.label === "The Omarchy theme")!;
    // Omarchy went away before enter: the choice is gone, which is not "already so".
    expect(planAtEnter(colours, omarchy, inForce("schema = 2\n"), { omarchy: false })).toBeNull();
    expect(planAtEnter(colours, omarchy, inForce("schema = 2\n"), { omarchy: true })).toEqual([]);
  });

  test("a choice judged at enter uses the file then, not the one the step opened on", () => {
    const opened = stepChoices(colours, inForce("schema = 2\n"), { omarchy: false });
    const light = opened.choices.find((c) => c.label === "Vimma light")!;
    // Set to light by hand while the step was open: enter writes nothing.
    const now = inForce('schema = 2\n[theme]\nappearance = "light"\n');
    expect(planAtEnter(colours, light, now, { omarchy: false })).toEqual([]);
  });
});

describe("updates (behaviour 27)", () => {
  const updates = step("updates");

  test("the file's check is in force, else the default: tell me", () => {
    expect(inForce("schema = 2\n")["updates.check"]).toBe(true);
    const off = inForce("schema = 2\n[updates]\ncheck = false\n");
    expect(off["updates.check"]).toBe(false);
    const r = stepChoices(updates, off);
    expect(r.choices.map((c) => c.label)).toEqual(["Tell me when a release is out", "Never check"]);
    expect(r.selected).toBe(1);
    expect(planChoice(r.choices[0]!, off)).toEqual([
      { table: "updates", key: "check", value: true },
    ]);
    expect(planChoice(r.choices[1]!, off)).toEqual([]);
  });

  test("says what the check sends and that never check stops every request", () => {
    expect(updates.text).toContain("the update channel and the platform");
    expect(updates.text).toContain("updates.vimma.dev");
    expect(updates.text).toContain("every 12 hours");
    expect(updates.text).toContain("Never check stops every request to updates.vimma.dev");
  });
});

describe("agents (behaviour 28, decisions 14 and 16)", () => {
  const agents = step("agents");
  const [off, on] = agents.choices as [SetupChoice, SetupChoice];
  const ENABLED = "schema = 2\n[mcp]\nenabled = true\n";
  const DISABLED = "schema = 2\n[mcp]\nenabled = false\n";
  const mcp = (pref: boolean, held: boolean) => ({ mcp: { pref, off: held } });

  test("in force is what :mcp decides: its off for the session, then the file, then the pref", () => {
    expect(inForce("schema = 2\n")["mcp.enabled"]).toBe(false);
    expect(inForce("schema = 2\n", mcp(true, false))["mcp.enabled"]).toBe(true);
    expect(inForce(ENABLED, mcp(false, false))["mcp.enabled"]).toBe(true);
    expect(inForce(ENABLED, mcp(false, true))["mcp.enabled"]).toBe(false);
    expect(inForce(DISABLED, mcp(true, false))["mcp.enabled"]).toBe(false);
  });

  test("off is selected first unless agents are on", () => {
    expect(stepChoices(agents, inForce("schema = 2\n")).selected).toBe(0);
    expect(stepChoices(agents, inForce(ENABLED, mcp(false, true))).selected).toBe(0);
    expect(stepChoices(agents, inForce(ENABLED)).selected).toBe(1);
    expect(stepChoices(agents, inForce("schema = 2\n", mcp(true, false))).selected).toBe(1);
  });

  test("on writes enabled = true and is the consent; off for the session ends with it", () => {
    const none = inForce("schema = 2\n");
    expect(planAtEnter(agents, on, none)).toEqual([{ table: "mcp", key: "enabled", value: true }]);
    expect(agentsTurnOn(agents, on, none)).toBe(true);
    // `:mcp off` holds a file's enabled = true off: the file already says on, so only the
    // consent, as `:mcp on`'s yes, turns agents on.
    const held = inForce(ENABLED, mcp(false, true));
    expect(planAtEnter(agents, on, held)).toEqual([]);
    expect(agentsTurnOn(agents, on, held)).toBe(true);
    // Held without the key: the file gets it, and the hold ends too.
    const heldBare = inForce("schema = 2\n", mcp(false, true));
    expect(planAtEnter(agents, on, heldBare)).toEqual([
      { table: "mcp", key: "enabled", value: true },
    ]);
    expect(agentsTurnOn(agents, on, heldBare)).toBe(true);
  });

  test("the choice in force turns nothing on and writes nothing", () => {
    const now = inForce(ENABLED);
    expect(planAtEnter(agents, on, now)).toEqual([]);
    expect(agentsTurnOn(agents, on, now)).toBe(false);
    const none = inForce("schema = 2\n");
    expect(planAtEnter(agents, off, none)).toEqual([]);
    expect(agentsTurnOn(agents, off, none)).toBe(false);
    // Plain enter on the preselected off, under the hold, leaves the file as it is (behaviour 8).
    expect(planAtEnter(agents, off, inForce(ENABLED, mcp(false, true)))).toEqual([]);
  });

  test("off writes enabled = false only while agents are on", () => {
    expect(planAtEnter(agents, off, inForce(ENABLED))).toEqual([
      { table: "mcp", key: "enabled", value: false },
    ]);
    expect(planAtEnter(agents, off, inForce("schema = 2\n", mcp(true, false)))).toEqual([
      { table: "mcp", key: "enabled", value: false },
    ]);
    // No step turns agents on for any other step or choice.
    for (const s of STEPS) {
      for (const c of s.choices) {
        if (s.id === "agents" && c === on) continue;
        expect(agentsTurnOn(s, c, inForce("schema = 2\n"))).toBe(false);
      }
    }
  });

  test("the notes say what the hold and an adopted workspace mean", () => {
    const held = inForce(ENABLED, mcp(false, true));
    expect(choiceNote(agents, on, held)).toBe("Also ends :mcp off for this session.");
    expect(choiceNote(agents, off, held)).toBe(
      "config.toml's [mcp] enabled = true turns agents on again at the next start.",
    );
    expect(choiceNote(agents, on, inForce("schema = 2\n"))).toBeNull();
    expect(choiceNote(agents, off, inForce("schema = 2\n"))).toBeNull();
    expect(
      choiceNote(agents, on, inForce("schema = 2\n"), { adopted: { name: "work", tabs: 3 } }),
    ).toBe(
      '"work" is your own workspace (3 tabs, its own logins). Agents will be able to read it.',
    );
    expect(choiceNote(agents, on, inForce("schema = 2\n"), { adopted: null, missing: true })).toBe(
      "There is no agent workspace (containers are off), so agents cannot be turned on.",
    );
    expect(choiceNote(step("updates"), step("updates").choices[1]!, held)).toBeNull();
    // Under the hold, a workspace of yours: both what :mcp on's question says and the hold.
    expect(choiceNote(agents, on, held, { adopted: { name: "work", tabs: 1 } })).toBe(
      '"work" is your own workspace (1 tab, its own logins). Agents will be able to read it. ' +
        "Also ends :mcp off for this session.",
    );
  });

  test("on without an agent workspace shows that it writes nothing: it is refused", () => {
    const none = inForce("schema = 2\n");
    expect(choiceLines(agents, on, none, { missing: true })).toEqual(["Writes nothing"]);
    expect(choiceLines(agents, on, none)).toEqual(["[mcp] enabled = true"]);
    expect(choiceLines(agents, off, inForce(ENABLED), { missing: true })).toEqual([
      "[mcp] enabled = false",
    ]);
    const updates = step("updates");
    expect(choiceLines(updates, updates.choices[1]!, none, { missing: true })).toEqual([
      "[updates] check = false",
    ]);
  });

  test("the step says, in two lines, where agents reach and what always asks", () => {
    const lines = agents.text.split("\n");
    expect(lines[0]).toBe("Agents reach only the agent workspace.");
    expect(lines[1]).toBe("Sending a form, paying and showing you a page always ask you first.");
    expect(agents.text).toContain(
      "<code>:mcp off</code> turns agents off until <code>:mcp on</code> or a restart, " +
        "whatever config.toml says and however often it is read again.",
    );
  });
});

describe("step text as page nodes", () => {
  test("kbd and code become their own parts, everything else is text", () => {
    expect(textParts("Press <kbd>ctrl+l</kbd> or <code>:open</code>.")).toEqual([
      { tag: null, text: "Press " },
      { tag: "kbd", text: "ctrl+l" },
      { tag: null, text: " or " },
      { tag: "code", text: ":open" },
      { tag: null, text: "." },
    ]);
  });

  test("a key with markup characters stays text: nothing is parsed as HTML", () => {
    expect(textParts("<kbd><</kbd> <b>x</b>")).toEqual([
      { tag: "kbd", text: "<" },
      { tag: null, text: " <b>x</b>" },
    ]);
  });
});

describe("the window chapter (behaviours 9, 17 and 24, Page layout)", () => {
  const bar = step("address_bar");

  test("the address bar step names every page key of focus_urlbar and toggle_toolbar", () => {
    expect(fillStepText(bar, keymap)).toBe(
      "With it hidden, <kbd>ctrl+l</kbd>, <kbd>alt+d</kbd> or <kbd>I</kbd> still opens the " +
        "address bar for typing, and <kbd>ctrl+b u</kbd> shows or hides the whole toolbar " +
        "until restart.",
    );
    // A rebound key as bound, an unbound one left out, an action without a key by its command.
    const own = compileKeymap({
      keys: { focus_urlbar: ["ctrl+k", "ctrl+l"], toggle_toolbar: [] },
    });
    expect(fillStepText(bar, own)).toBe(
      "With it hidden, <kbd>ctrl+k</kbd>, <kbd>ctrl+l</kbd> or <kbd>I</kbd> still opens the " +
        "address bar for typing, and <code>:toolbar</code> shows or hides the whole toolbar " +
        "until restart.",
    );
  });

  // toolbar-toggle decision 3 (changed 19 Nov 2026): hidden by default.
  test("the address bar step opens on the toolbar in force: hidden by default, else the file's", () => {
    const fresh = inForce("");
    const first = stepChoices(bar, fresh);
    expect(first.choices.map((c) => c.label)).toEqual(["Shown", "Hidden"]);
    expect(first.selected).toBe(1);
    expect(planAtEnter(bar, first.choices[1]!, fresh)).toEqual([]);
    const shown = inForce('[ui]\ntoolbar = "shown"\n');
    const r = stepChoices(bar, shown);
    expect(r.selected).toBe(0);
    expect(planAtEnter(bar, r.choices[0]!, shown)).toEqual([]);
    expect(planAtEnter(bar, r.choices[1]!, shown)).toEqual([
      { table: "ui", key: "toolbar", value: "hidden" },
    ]);
  });

  test("each choice draws the window it leaves, with the rest of the window in force", () => {
    const now = inForce('schema = 2\n[ui]\ntabline = "always"\n');
    const r = stepChoices(bar, now);
    expect(r.choices.map((c) => windowSketch(bar, c, now))).toEqual([
      { toolbar: "shown", tabline: "always" },
      { toolbar: "hidden", tabline: "always" },
    ]);
    // Without a [ui] table: the built-in defaults.
    expect(windowSketch(bar, r.choices[1]!, inForce("schema = 2\n"))).toEqual({
      toolbar: "hidden",
      tabline: "auto",
    });
  });

  // tab-line decision 3 (changed 20 Nov 2026, #1403): "auto" by default.
  test("the tab line step opens on the tab line in force: auto by default, else the file's", () => {
    const tabs = step("tab_line");
    for (const fresh of [inForce(""), inForceOf(null)]) {
      const first = stepChoices(tabs, fresh);
      expect(first.choices.map((c) => c.label)).toEqual([
        "Off",
        "Always",
        "Only with two or more tabs",
      ]);
      expect(first.selected).toBe(2);
      expect(planAtEnter(tabs, first.choices[2]!, fresh)).toEqual([]);
    }
    const off = inForce('[ui]\ntabline = "off"\n');
    const r = stepChoices(tabs, off);
    expect(r.selected).toBe(0);
    expect(planAtEnter(tabs, r.choices[0]!, off)).toEqual([]);
    expect(planAtEnter(tabs, r.choices[2]!, off)).toEqual([
      { table: "ui", key: "tabline", value: "auto" },
    ]);
  });

  test("the tab line step draws its choices over the same window", () => {
    const tabs = step("tab_line");
    const now = inForce('schema = 2\n[ui]\ntoolbar = "hidden"\n');
    expect(stepChoices(tabs, now).choices.map((c) => windowSketch(tabs, c, now))).toEqual([
      { toolbar: "hidden", tabline: "off" },
      { toolbar: "hidden", tabline: "always" },
      { toolbar: "hidden", tabline: "auto" },
    ]);
  });

  test("keep draws the window in force, and a step outside the window chapter draws none", () => {
    const keep = { label: "Keep", edits: [], keep: true as const };
    expect(windowSketch(bar, keep, { "ui.toolbar": "hidden", "ui.tabline": "auto" })).toEqual({
      toolbar: "hidden",
      tabline: "auto",
    });
    const engine = step("search_engine");
    expect(windowSketch(engine, { label: "x", edits: [] }, {})).toBeNull();
  });
});

// docs/specs/setup-v2.md behaviours 22 and 23, decision 17: the Moving in steps act, they save no
// key; their choices follow what the system allows now, and each result says what happened.
describe("the Moving in chapter's action steps", () => {
  const labels = (r: ReturnType<typeof actionChoices>) => r.choices.map((c) => c.label);

  test("default browser: make default or not now, while another browser is the default", () => {
    const r = actionChoices("default_browser", { isDefault: false, canSet: true, why: null });
    expect(labels(r)).toEqual(["Make Vimma the default browser", "Not now"]);
    expect(r.choices.map((c) => c.run ?? false)).toEqual([true, false]);
    expect(r.choices.every((c) => c.edits.length === 0)).toBe(true);
    expect(r.status).toMatch(/not your default browser/);
  });

  test("default browser: says so and only moves on when Vimma already is the default", () => {
    const r = actionChoices("default_browser", { isDefault: true, canSet: true, why: null });
    expect(labels(r)).toEqual(["Go on"]);
    expect(r.choices[0]?.run).toBeUndefined();
    expect(r.status).toMatch(/already your default browser/);
  });

  test("default browser: says why it cannot ask, and only moves on", () => {
    for (const [why, words] of [
      ["flatpak", /Flatpak/],
      ["policy", /policy/],
      ["locked", /locked/],
    ] as const) {
      const r = actionChoices("default_browser", { isDefault: false, canSet: false, why });
      expect(labels(r)).toEqual(["Go on"]);
      expect(r.status).toMatch(words);
    }
  });

  test("bring your data: the wizard or not now, and only go on where policy turns import off", () => {
    const r = actionChoices("bring_your_data", { canImport: true });
    expect(labels(r)).toEqual(["Open the import wizard", "Not now"]);
    expect(r.choices.map((c) => c.run ?? false)).toEqual([true, false]);
    const off = actionChoices("bring_your_data", { canImport: false });
    expect(labels(off)).toEqual(["Go on"]);
    expect(off.status).toMatch(/policy/);
  });

  test("a result that acted is listed as saved, never as nothing written", () => {
    expect(actionOutcome("default_browser", "default")).toEqual({
      advance: true,
      saved: ["made the default browser"],
      said: "Vimma is now the default browser",
    });
    expect(actionOutcome("default_browser", "asked").saved).toEqual([
      "asked the system to make Vimma the default",
    ]);
    expect(actionOutcome("bring_your_data", "closed")).toEqual({
      advance: true,
      saved: ["import wizard closed"],
      said: "import wizard closed",
    });
  });

  test("not now and go on move on and save nothing; a failure keeps the step open", () => {
    for (const id of ["default_browser", "bring_your_data"]) {
      expect(actionOutcome(id, "not-now")).toEqual({ advance: true, saved: [], said: "not now" });
    }
    expect(actionOutcome("default_browser", "already")).toMatchObject({ advance: true, saved: [] });
    for (const [id, result] of [
      ["default_browser", "failed"],
      ["default_browser", "unavailable"],
      ["bring_your_data", "unavailable"],
    ] as const) {
      const o = actionOutcome(id, result);
      expect(o.advance).toBe(false);
      expect(o.saved).toEqual([]);
      expect(o.said).not.toBe("");
    }
  });
});
