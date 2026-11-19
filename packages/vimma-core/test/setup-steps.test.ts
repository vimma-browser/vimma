// docs/specs/setup-v2.md decisions 7-9 and 11: the chapters and steps of the setup as data, the
// keys their text names filled from the keymap in force, and the `<kbd>` check.
import { describe, expect, test } from "vitest";
import {
  CHAPTERS,
  PAGE_KEYS,
  STEPS,
  editLines,
  fillStepText,
  inForceOf,
  planAtEnter,
  planChoice,
  prefixHints,
  stepChoices,
  stepKeys,
  textParts,
} from "../src/system/setup-steps.mjs";
import { parseConfig, setConfigKeysText } from "../src/config/config.mjs";
import { compileKeymap } from "../src/keys/keymap.mjs";
import { getAction } from "../src/keys/actions.mjs";
import { parseKey } from "../src/keys/keys.mjs";

import type { SetupStep } from "../src/system/setup-steps.mjs";

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
        "schema = 2\n",
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
    expect(prefixHints(step("prefix_key"), keymap)).toEqual([["ctrl+b ?"], ["ctrl+a ?"]]);
    const own = compileKeymap({ keys: { prefix: "ctrl+space", show_keybinds: ["prefix+y"] } });
    expect(prefixHints(step("prefix_key"), own)).toEqual([["ctrl+b y"], ["ctrl+a y"]]);
  });

  test("after a new prefix, the toolbar step shows the new prefix", () => {
    expect(fillStepText(step("address_bar"), keymap)).toContain("<kbd>ctrl+b u</kbd>");
    const after = compileKeymap({ keys: { prefix: "ctrl+a" } });
    expect(fillStepText(step("address_bar"), after)).toContain("<kbd>ctrl+a u</kbd>");
  });
});

describe("choices, Keep and the line a step writes (behaviours 8, 9 and 12)", () => {
  const toolbar = step("address_bar");

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
    const prefix = stepChoices(step("prefix_key"), { "keys.prefix": "ctrl+space" });
    expect(prefix.choices[0]?.label).toBe('Keep "ctrl+space"');
  });

  test("choosing the value in force plans no write", () => {
    const r = stepChoices(toolbar, { "ui.toolbar": "shown" });
    expect(planChoice(r.choices[r.selected]!, { "ui.toolbar": "shown" })).toEqual([]);
    expect(planChoice(r.choices[1]!, { "ui.toolbar": "shown" })).toEqual([
      { table: "ui", key: "toolbar", value: "hidden" },
    ]);
  });

  test("skip and keep plan no write", () => {
    const r = stepChoices(step("prefix_key"), { "keys.prefix": "ctrl+space" });
    expect(planChoice(r.choices[0]!, { "keys.prefix": "ctrl+space" })).toEqual([]);
    expect(planChoice(null, { "keys.prefix": "ctrl+space" })).toEqual([]);
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
      "ui.toolbar": "shown",
      "ui.tabline": "off",
    });
    const set = inForce(
      'schema = 2\n[search]\ndefault = "Bing"\n[theme]\nappearance = "light"\n' +
        '[ui]\ntoolbar = "hidden"\n',
      { engine: "Google", appearance: "dark" },
    );
    expect(set).toMatchObject({
      "search.default": "Bing",
      "theme.appearance": "light",
      "ui.toolbar": "hidden",
    });
    expect(inForce("schema = 2\n")["theme.appearance"]).toBe("system");
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
      "Light",
      "Dark",
      "Follow the system",
    ]);
    expect(labels(stepChoices(colours, inForce("schema = 2\n"), { omarchy: false }))).toEqual([
      "Light",
      "Dark",
      "Follow the system",
    ]);
  });

  test("colours: the choice in force writes nothing, with and without an Omarchy theme", () => {
    const shown = stepChoices(colours, inForce("schema = 2\n"), { omarchy: true });
    expect(shown.choices[shown.selected]?.label).toBe("The Omarchy theme");
    expect(writes("schema = 2\n", "The Omarchy theme", true)).toEqual([]);
    const builtin = stepChoices(colours, inForce("schema = 2\n"), { omarchy: false });
    expect(builtin.choices[builtin.selected]?.label).toBe("Follow the system");
    expect(writes("schema = 2\n", "Follow the system", false)).toEqual([]);
    // :theme's appearance is in force without the key, and choosing it writes nothing.
    const dark = stepChoices(colours, inForce("schema = 2\n", { appearance: "dark" }), {
      omarchy: false,
    });
    expect(dark.choices[dark.selected]?.label).toBe("Dark");
    expect(writes("schema = 2\n", "Dark", false, { appearance: "dark" })).toEqual([]);
    // Omarchy found but turned off in the file: the built-in palette is the effect.
    const off = 'schema = 2\n[theme]\nsource = "file"\nappearance = "light"\n';
    const r = stepChoices(colours, inForce(off), { omarchy: true });
    expect(r.choices[r.selected]?.label).toBe("Light");
    expect(writes(off, "Light", true)).toEqual([]);
    expect(writes(off, "The Omarchy theme", true)).toEqual([
      { table: "theme", key: "source", value: "omarchy" },
    ]);
  });

  test("colours: light without an Omarchy theme writes appearance only", () => {
    expect(writes("schema = 2\n", "Light", false)).toEqual([
      { table: "theme", key: "appearance", value: "light" },
    ]);
  });

  test("colours: light with an Omarchy theme writes source and appearance", () => {
    expect(writes("schema = 2\n", "Light", true)).toEqual([
      { table: "theme", key: "source", value: "file" },
      { table: "theme", key: "appearance", value: "light" },
    ]);
    // The appearance :theme set is already light: only the source changes the effect.
    expect(writes("schema = 2\n", "Light", true, { appearance: "light" })).toEqual([
      { table: "theme", key: "source", value: "file" },
    ]);
  });

  test('colours: light or system with tokyo-night also writes name = "vimma"', () => {
    const tokyo = 'schema = 2\n[theme]\nname = "tokyo-night"\nappearance = "dark"\n';
    const r = stepChoices(colours, inForce(tokyo), { omarchy: false });
    expect(r.choices[0]).toMatchObject({ label: 'Keep "tokyo-night"', keep: true });
    expect(r.selected).toBe(0);
    expect(planAtEnter(colours, r.choices[0]!, inForce(tokyo), { omarchy: false })).toEqual([]);
    expect(writes(tokyo, "Light", false)).toEqual([
      { table: "theme", key: "name", value: "vimma" },
      { table: "theme", key: "appearance", value: "light" },
    ]);
    expect(writes(tokyo, "Follow the system", false)).toEqual([
      { table: "theme", key: "name", value: "vimma" },
      { table: "theme", key: "appearance", value: "system" },
    ]);
    expect(writes(tokyo, "Dark", false)).toEqual([]);
    // The line the step shows says so before enter.
    const light = r.choices.find((c) => c.label === "Light")!;
    expect(editLines(planChoice(light, inForce(tokyo)))).toEqual([
      '[theme] name = "vimma"',
      '[theme] appearance = "light"',
    ]);
  });

  test("a choice judged at enter uses the file then, not the one the step opened on", () => {
    const opened = stepChoices(colours, inForce("schema = 2\n"), { omarchy: false });
    const light = opened.choices.find((c) => c.label === "Light")!;
    // Set to light by hand while the step was open: enter writes nothing.
    const now = inForce('schema = 2\n[theme]\nappearance = "light"\n');
    expect(planAtEnter(colours, light, now, { omarchy: false })).toEqual([]);
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
