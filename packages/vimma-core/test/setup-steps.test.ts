// docs/specs/setup-v2.md decisions 7-9 and 11: the chapters and steps of the setup as data, the
// keys their text names filled from the keymap in force, and the `<kbd>` check.
import { describe, expect, test } from "vitest";
import {
  CHAPTERS,
  PAGE_KEYS,
  STEPS,
  actionChoices,
  actionOutcome,
  editLines,
  fillStepText,
  inForceOf,
  planAtEnter,
  planChoice,
  prefixHints,
  stepChoices,
  stepKeys,
  textParts,
  windowSketch,
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

  // #1383: vimma is the only built-in palette. The removed "tokyo-night" is vimma in force, so
  // the step offers no Keep and a choice writes no name.
  test("colours: a removed palette's name is vimma: no Keep, no name written", () => {
    const removed = 'schema = 2\n[theme]\nname = "tokyo-night"\nappearance = "dark"\n';
    const r = stepChoices(colours, inForce(removed), { omarchy: false });
    expect(r.choices.some((c) => c.keep)).toBe(false);
    expect(r.choices[r.selected]?.label).toBe("Dark");
    expect(writes(removed, "Light", false)).toEqual([
      { table: "theme", key: "appearance", value: "light" },
    ]);
    expect(writes(removed, "Dark", false)).toEqual([]);
  });

  test('colours: another name in force is kept, and a choice also writes name = "vimma"', () => {
    const other = { ...inForce("schema = 2\n"), "theme.name": "other" };
    const r = stepChoices(colours, other, { omarchy: false });
    expect(r.choices[0]).toMatchObject({ label: 'Keep "other"', keep: true });
    expect(r.selected).toBe(0);
    expect(planAtEnter(colours, r.choices[0]!, other, { omarchy: false })).toEqual([]);
    const light = r.choices.find((c) => c.label === "Light")!;
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

  test("the address bar step opens on the toolbar in force: shown by default, else the file's", () => {
    expect(stepChoices(bar, inForce("schema = 2\n")).selected).toBe(0);
    const hidden = inForce('schema = 2\n[ui]\ntoolbar = "hidden"\n');
    const r = stepChoices(bar, hidden);
    expect(r.choices.map((c) => c.label)).toEqual(["Shown", "Hidden"]);
    expect(r.selected).toBe(1);
    expect(planAtEnter(bar, r.choices[1]!, hidden)).toEqual([]);
    expect(planAtEnter(bar, r.choices[0]!, hidden)).toEqual([
      { table: "ui", key: "toolbar", value: "shown" },
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
      tabline: "off",
    });
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
