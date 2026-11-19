/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The setup's chapters and steps as data (docs/specs/setup-v2.md decisions 7, 8 and 11): each
 * step's kind, its fixed choices (table, key and value), the actions its text may name, and its
 * text with `{keys:<action>}` placeholders that are filled from the keymap in force. A later
 * step is a row in CHAPTERS and its test, not new page code; chapter digits follow list order.
 * The page sends the host a step id and a choice index only, never a key or a value (decision 7).
 */

import { COMMANDS } from "../keys/cmdline.mjs";
import { getAction } from "../keys/actions.mjs";
import { displayBinding, formatKey, parseKey } from "../keys/keys.mjs";
import { tomlLiteral } from "../config/toml.mjs";
import { DEFAULT_THEME_NAME } from "../config/theme.mjs";
import { DEFAULT_HINT_CHARS } from "../page/hints.mjs";
import { defaultKeys } from "../config/defaults.mjs";

/** @import { Keymap } from "../keys/keymap.mjs" */
/** @import { ResolvedConfig } from "../config/config.mjs" */
/** @import { TomlEdit } from "../config/toml.mjs" */

/**
 * @typedef {object} SetupChoice
 * @property {string} label
 * @property {readonly TomlEdit[]} edits  what it writes; [] for Keep
 * @property {true} [keep]  Keep: the value in force, which is none of the step's choices
 * @property {true} [run]  an action step's choice that runs the step's action
 * @property {ActionResult} [result]  an action step's choice that runs nothing: what it means
 */

/**
 * @typedef {object} SetupStep
 * @property {string} id
 * @property {string} title
 * @property {"setting" | "action"} kind
 * @property {string} question
 * @property {string} text  may hold `<kbd>` page keys and `{keys:<action>}` placeholders
 * @property {readonly string[]} actions  the actions `text` may name
 * @property {readonly SetupChoice[]} choices  fixed choices; [] for an action step, and for the
 *   search engine, whose choices are the installed engines (stepChoices)
 * @property {{ table: string, key: string }} [setting]  the one key a choice of it sets, which
 *   Keep is judged by
 */

/**
 * @typedef {object} SetupChapter
 * @property {string} id
 * @property {number} digit  the key that starts the setup at it (behaviour 3)
 * @property {string} name
 * @property {readonly SetupStep[]} steps
 */

/** The page's own keys (behaviour 17): the only keys step text may write by hand. */
export const PAGE_KEYS = Object.freeze([
  "j",
  "k",
  "enter",
  "s",
  "h",
  "q",
  "esc",
  "space",
  "/",
  ..."123456789",
]);

/**
 * A setting step whose choices each set `table.key`.
 * @param {Omit<SetupStep, "kind" | "choices" | "setting">} step
 * @param {{ table: string, key: string }} setting
 * @param {[label: string, value: string | boolean][]} choices
 * @returns {SetupStep}
 */
function setting(step, { table, key }, choices) {
  return {
    ...step,
    kind: "setting",
    setting: { table, key },
    choices: choices.map(([label, value]) => ({ label, edits: [{ table, key, value }] })),
  };
}

/**
 * @param {Omit<SetupStep, "kind" | "choices">} step
 * @returns {SetupStep}
 */
const action = (step) => ({ ...step, kind: "action", choices: [] });

/**
 * The hint letters step's layouts (decision 10), each with its home row and its letter keys by
 * physical key: the top, home and bottom rows from `KeyQ`, `KeyA` and `KeyZ`, as a
 * `KeyboardEvent`'s `code` names them. A `key` that is no letter (`;` on QWERTY) is never
 * compared.
 */
const HINT_LAYOUT_ROWS = [
  { name: "QWERTY", chars: DEFAULT_HINT_CHARS, rows: ["qwertyuiop", "asdfghjkl;", "zxcvbnm,./"] },
  { name: "Colemak", chars: "arstdhneio", rows: ["qwfpgjluy;", "arstdhneio", "zxcvbkm,./"] },
  { name: "Dvorak", chars: "aoeuidhtns", rows: ["',.pyfgcrl", "aoeuidhtns", ";qjkxbmwvz"] },
];

/** The `code` of each key of the three rows, in the order of HINT_LAYOUT_ROWS' `rows`. */
const ROW_CODES = [
  [..."QWERTYUIOP"].map((c) => `Key${c}`),
  [...[..."ASDFGHJKL"].map((c) => `Key${c}`), "Semicolon"],
  [...[..."ZXCVBNM"].map((c) => `Key${c}`), "Comma", "Period", "Slash"],
];

/** @type {[id: string, name: string, steps: SetupStep[]][]} */
const TABLE = [
  [
    "essentials",
    "Essentials",
    [
      action({
        id: "content_blocker",
        title: "Content blocker",
        question: "Block ads and trackers with an add-on?",
        text:
          "<kbd>space</kbd> marks an add-on and <kbd>/</kbd> searches addons.mozilla.org. " +
          "<kbd>enter</kbd> installs the marked ones, each with Firefox's permission prompt. " +
          "Add-ons run in every workspace, the agent workspace too.",
        actions: [],
      }),
      setting(
        {
          id: "search_engine",
          title: "Search engine",
          question: "Which engine searches what you type in the address bar?",
          text: "Your choice goes into config.toml as the default engine.",
          actions: [],
        },
        { table: "search", key: "default" },
        [],
      ),
      {
        id: "colours",
        title: "Colours",
        kind: "setting",
        question: "Which colours should Vimma use?",
        text:
          "The page takes the colours as soon as you save. Set here, the appearance wins over " +
          "<code>:theme</code> from then on.",
        actions: [],
        // The keys a choice writes depend on what the window shows now (decision 12): these
        // are what each choice sets, and the essentials slice plans the effect.
        choices: [
          {
            label: "The Omarchy theme",
            edits: [{ table: "theme", key: "source", value: "omarchy" }],
          },
          { label: "Light", edits: [{ table: "theme", key: "appearance", value: "light" }] },
          { label: "Dark", edits: [{ table: "theme", key: "appearance", value: "dark" }] },
          {
            label: "Follow the system",
            edits: [{ table: "theme", key: "appearance", value: "system" }],
          },
        ],
      },
    ],
  ],
  [
    "moving_in",
    "Moving in",
    [
      action({
        id: "default_browser",
        title: "Default browser",
        question: "Make Vimma your default browser?",
        text: "Links from other programs then open in Vimma.",
        actions: [],
      }),
      action({
        id: "bring_your_data",
        title: "Bring your data",
        question: "Bring bookmarks, history and passwords from another browser?",
        text:
          "The import wizard reads Chrome, Chromium, Brave, Edge, Opera and Vivaldi on this " +
          "computer. A Firefox profile is not in it: bring Firefox data over with Firefox Sync " +
          "(<code>:settings sync</code>).",
        actions: [],
      }),
    ],
  ],
  [
    "window",
    "The window",
    [
      setting(
        {
          id: "address_bar",
          title: "Address bar",
          question: "Show the address bar and the add-on buttons?",
          text:
            "With it hidden, {keys:focus_urlbar} still opens the address bar for typing, and " +
            "{keys:toggle_toolbar} shows or hides the whole toolbar until restart.",
          actions: ["focus_urlbar", "toggle_toolbar"],
        },
        { table: "ui", key: "toolbar" },
        [
          ["Shown", "shown"],
          ["Hidden", "hidden"],
        ],
      ),
      setting(
        {
          id: "tab_line",
          title: "Tab line",
          question: "Show a line of tabs at the top of the window?",
          text: "{keys:toggle_tabline} shows or hides it until restart.",
          actions: ["toggle_tabline"],
        },
        { table: "ui", key: "tabline" },
        [
          ["Off", "off"],
          ["Always", "always"],
          ["Only with two or more tabs", "auto"],
        ],
      ),
    ],
  ],
  [
    "keys",
    "Your keys",
    [
      setting(
        {
          id: "prefix_key",
          title: "Prefix key",
          question: "Which key starts Vimma's window commands?",
          text:
            "Under each prefix is the key that lists every key with it; " +
            "{keys:show_keybinds} lists them now.",
          actions: ["show_keybinds"],
        },
        { table: "keys", key: "prefix" },
        [
          ["ctrl+b", "ctrl+b"],
          ["ctrl+a", "ctrl+a"],
        ],
      ),
      setting(
        {
          id: "hint_letters",
          title: "Hint letters",
          question: "Which letters label the links you follow by keyboard?",
          text:
            "{keys:follow_link} labels the links on a page with these letters. The home row of " +
            "the layout you type on is the quickest to reach.",
          actions: ["follow_link"],
        },
        { table: "modal", key: "hint_chars" },
        HINT_LAYOUT_ROWS.map(({ name, chars }) => [`${name}: ${chars}`, chars]),
      ),
    ],
  ],
  [
    "privacy_agents",
    "Privacy and agents",
    [
      setting(
        {
          id: "updates",
          title: "Updates",
          question: "Tell you when a new release is out?",
          text:
            "The check sends the update channel and the platform to updates.vimma.dev every " +
            "12 hours. Never check stops every request to it.",
          actions: [],
        },
        { table: "updates", key: "check" },
        [
          ["Tell me when a release is out", true],
          ["Never check", false],
        ],
      ),
      setting(
        {
          id: "agents",
          title: "Agents",
          question: "Let local AI agents ask to use Vimma through vimma-ctl mcp?",
          text:
            "Agents reach only the agent workspace. Sending a form, paying and showing you a " +
            "page always ask you first. <code>:mcp off</code> turns agents off until " +
            "<code>:mcp on</code> or a restart, whatever config.toml says and however often " +
            "it is read again.",
          actions: [],
        },
        { table: "mcp", key: "enabled" },
        [
          ["Off", false],
          ["On", true],
        ],
      ),
    ],
  ],
];

/**
 * @template T
 * @param {T} o
 * @returns {Readonly<T>}
 */
const freeze = (o) => Object.freeze(o);

/** @type {readonly SetupChapter[]} */
export const CHAPTERS = freeze(
  TABLE.map(([id, name, steps], i) =>
    freeze({
      id,
      digit: i + 1,
      name,
      steps: freeze(
        steps.map((s) =>
          freeze({
            ...s,
            actions: freeze([...s.actions]),
            choices: freeze(s.choices.map((c) => freeze({ ...c, edits: freeze([...c.edits]) }))),
          }),
        ),
      ),
    }),
  ),
);

/** Every step, in order. @type {readonly SetupStep[]} */
export const STEPS = freeze(CHAPTERS.flatMap((c) => c.steps));

/**
 * The hint letters step's layouts, in the order of its choices: each one's name, its home-row
 * letters and, by `code`, the letter each key types.
 * @type {readonly { name: string, chars: string, letters: Readonly<Record<string, string>> }[]}
 */
export const HINT_LAYOUTS = freeze(
  HINT_LAYOUT_ROWS.map(({ name, chars, rows }) =>
    freeze({
      name,
      chars,
      letters: freeze(
        Object.fromEntries(
          rows.flatMap((row, r) => [...row].map((ch, i) => [ROW_CODES[r]?.[i] ?? "", ch])),
        ),
      ),
    }),
  ),
);

/**
 * A key pressed on the page, as its keydown saw it. The page keeps these in memory only and
 * never sends or writes them (decision 10, Security and privacy).
 * @typedef {{ code: string, key: string }} PressedKey
 */

/** The most keys the page keeps for the guess: the latest few are enough. */
export const PRESSED_MAX = 32;

/**
 * `pressed` with `key` added when it is a letter typed without ctrl, alt or meta, the oldest
 * dropped past PRESSED_MAX, so that the page never holds more than the guess needs.
 * @param {readonly PressedKey[]} pressed @param {PressedKey} key
 * @param {{ ctrl?: boolean, alt?: boolean, meta?: boolean }} [mods]
 * @returns {PressedKey[]}
 */
export function rememberKey(pressed, key, { ctrl = false, alt = false, meta = false } = {}) {
  if (ctrl || alt || meta || !/^[a-z]$/i.test(key.key)) return [...pressed];
  return [...pressed, { code: key.code, key: key.key }].slice(-PRESSED_MAX);
}

/**
 * The layout the user types on, from the keys already pressed on the page (decision 10): the
 * first of HINT_LAYOUTS that puts every letter pressed on the physical key it came from. Null
 * without a letter pressed, or when no layout fits (AZERTY's `a` on `KeyQ`).
 * @param {readonly PressedKey[]} pressed
 * @returns {string | null}  the layout's home-row letters
 */
export function guessLayout(pressed) {
  const letters = pressed
    .map((p) => ({ code: p.code, key: p.key.toLowerCase() }))
    .filter((p) => /^[a-z]$/.test(p.key));
  if (!letters.length) return null;
  const fits = HINT_LAYOUTS.find((l) => letters.every((p) => l.letters[p.code] === p.key));
  return fits ? fits.chars : null;
}

/**
 * The row the hint letters step opens on (behaviour 26): the layout typed on when the value in
 * force is the built-in QWERTY default, which a user on another layout has most likely never
 * chosen; else the value in force (behaviour 9), so that a layout chosen before, or a custom
 * value under Keep, stays selected. With no guess, the value in force: QWERTY by default.
 * @param {readonly (string | null)[]} layouts  each choice's letters, null for Keep
 * @param {number} selected  the row of the value in force
 * @param {readonly PressedKey[]} pressed
 * @returns {number}
 */
export function hintRow(layouts, selected, pressed) {
  if (layouts[selected] !== DEFAULT_HINT_CHARS) return selected;
  const guess = guessLayout(pressed);
  const row = guess === null ? -1 : layouts.indexOf(guess);
  return row >= 0 ? row : selected;
}

/** @param {string} key  as keysFor shows it @returns {boolean} whether it works from a page */
const fromPage = (key) => !key.includes(" [");

/** @param {string} key  as keysFor shows it (`I`, `ctrl+b u`) @returns {string} as a sequence */
const sequenceOf = (key) =>
  key
    .split(" ")
    .map((chord) => {
      try {
        return formatKey(parseKey(chord));
      } catch {
        return chord;
      }
    })
    .join(" ");

/**
 * The keys of `action` that work from a page (decision 8, behaviour 17): keysFor without the
 * bindings of another mode (`I [visual]`), and without a `[keys]` binding that normal mode binds
 * to another action or unbinds (`[modal.normal] "<C-l>"`), because on a page that key no longer
 * runs it.
 * @param {Keymap} keymap @param {string} action
 * @returns {string[]}
 */
export function stepKeys(keymap, action) {
  const normal = new Set(
    keymap
      .sequences("normal")
      .filter((s) => s.name === action)
      .map((s) => s.seq),
  );
  return keymap.keysFor(action).filter((key) => fromPage(key) && normal.has(sequenceOf(key)));
}

/** @param {string} action @returns {string} the `:` command that runs it */
function commandOf(action) {
  const id = getAction(action)?.id;
  const cmd = COMMANDS.find((c) => c.action === id && c.argument !== "required");
  return `:${cmd ? cmd.name : action}`;
}

/** @param {string[]} keys @returns {string} `<kbd>a</kbd>, <kbd>b</kbd> or <kbd>c</kbd>` */
function kbdList(keys) {
  const k = keys.map((key) => `<kbd>${key}</kbd>`);
  return k.length < 2 ? k.join("") : `${k.slice(0, -1).join(", ")} or ${k.at(-1)}`;
}

/**
 * `step.text` with each `{keys:<action>}` replaced by its keys in force, or by its `:` command
 * when it has none (decision 8). A placeholder the step does not declare is left as it is, so
 * that the step table's test finds it.
 * @param {SetupStep} step @param {Keymap} keymap
 * @returns {string}
 */
export function fillStepText(step, keymap) {
  return step.text.replace(/\{keys:([a-z_]+)\}/g, (all, /** @type {string} */ action) => {
    if (!step.actions.includes(action)) return all;
    const keys = stepKeys(keymap, action);
    return keys.length ? kbdList(keys) : `<code>${commandOf(action)}</code>`;
  });
}

/**
 * For each of the prefix step's choices, the keys of the action the step names first
 * (`show_keybinds`), drawn with that choice as the prefix (decision 8): the keymap only knows
 * the prefix in force. Keep, which writes nothing, is drawn with the prefix in force.
 * @param {SetupStep} step @param {Keymap} keymap
 * @param {readonly SetupChoice[]} [choices]  the step's list as drawn (stepChoices), with Keep
 * @returns {string[][]}  per choice, the keys of the step's first action
 */
export function prefixHints(step, keymap, choices = step.choices) {
  const name = step.actions[0] ?? "";
  return choices.map((c) => {
    if (c.keep) return stepKeys(keymap, name);
    const prefix = parseKey(String(c.edits[0]?.value ?? ""));
    return keymap
      .bindingsFor(name)
      .filter(fromPage)
      .map((text) => displayBinding(text, { prefix, leader: keymap.leader }));
  });
}

/** The `[ui]` keys a drawing of the window shows, with their built-in defaults. */
const WINDOW_DEFAULTS = Object.freeze({ toolbar: "shown", tabline: "off" });

/** The steps that draw the window with each choice (Page layout): chapter 3's. */
const WINDOW_STEPS = new Set(CHAPTERS.find((c) => c.id === "window")?.steps.map((s) => s.id));

/**
 * What a step's drawing of the window shows for one choice.
 * @typedef {object} WindowSketch
 * @property {string} toolbar  "shown" or "hidden"
 * @property {string} tabline  "off", "always" or "auto"
 */

/**
 * The window a choice of a window step leaves (Page layout): the choice's own `[ui]` key over
 * the values in force, so that each drawing shows the rest of the window as it is now. Keep
 * draws the window in force; a step outside the window chapter draws none.
 * @param {SetupStep} step @param {SetupChoice} choice @param {InForce} inForce
 * @returns {WindowSketch | null}
 */
export function windowSketch(step, choice, inForce) {
  if (!WINDOW_STEPS.has(step.id)) return null;
  /** @param {keyof typeof WINDOW_DEFAULTS} key */
  const of = (key) => {
    const own = choice.edits.find((e) => e.table === "ui" && e.key === key);
    return String(own?.value ?? inForce[`ui.${key}`] ?? WINDOW_DEFAULTS[key]);
  };
  return { toolbar: of("toolbar"), tabline: of("tabline") };
}

/**
 * The values in force, by `table.key` (the file's, else the built-in default), as the host
 * resolves them.
 * @typedef {Record<string, unknown>} InForce
 */

/** @param {TomlEdit} e */
const pathOf = (e) => `${e.table}.${e.key}`;

/**
 * What the host knows besides the file: Firefox's default engine (in force without
 * `[search] default`), the appearance `:theme` remembered (without `[theme] appearance`).
 * @typedef {object} SetupRuntime
 * @property {string | null} [engine]
 * @property {string} [appearance]
 * @property {readonly string[]} [engines]  the installed engines: a `[search] default` written
 *   in another case is in force as the engine of that name, as the config's lookup finds it
 */

/**
 * The values in force of the steps' keys, by `table.key`, from a resolved config (the file at
 * `enter`, decision 4), its built-in defaults, and `runtime` for what the file leaves to
 * Firefox or a command (behaviour 9). A later step adds its key here.
 * @param {ResolvedConfig} config @param {SetupRuntime} [runtime]
 * @returns {InForce}
 */
export function inForceOf(config, { engine = null, appearance, engines = [] } = {}) {
  const named = config.search?.default?.kind === "engine" ? config.search.default.name : null;
  const fileEngine =
    named === null ? null : (engines.find((e) => e.toLowerCase() === named.toLowerCase()) ?? named);
  return {
    "search.default": fileEngine ?? engine ?? undefined,
    "theme.source": config.theme.source ?? "omarchy",
    "theme.name": config.theme.name ?? DEFAULT_THEME_NAME,
    "theme.appearance": config.theme.appearance ?? appearance ?? "system",
    "ui.toolbar": config.ui.toolbar,
    "ui.tabline": config.ui.tabline,
    "keys.prefix": prefixOf(config),
    "modal.hint_chars": config.hintChars,
  };
}

/**
 * The prefix in force as one chord in Vimma's notation, so that `ctrl+A` in the file is the
 * `ctrl+a` choice and enter on it writes nothing (behaviour 8); a prefix the notation cannot
 * read stays as written, for Keep.
 * @param {ResolvedConfig} config
 * @returns {string}
 */
function prefixOf(config) {
  const text = config.keys.prefix;
  if (typeof text !== "string") return String(defaultKeys().prefix);
  try {
    return formatKey(parseKey(text));
  } catch {
    return text;
  }
}

/**
 * The colours step's choices for the effect in force (decision 12): what each choice must write
 * so that the window shows it. The choice's own key comes last. Omarchy is offered only where
 * an Omarchy theme is found; with it shown, a built-in choice also writes `source = "file"`.
 * `vimma` is the only built-in palette, so a choice writes `name = "vimma"` only when another
 * name is in force.
 * @param {SetupStep} step @param {InForce} inForce @param {boolean} omarchy  a theme is found
 * @returns {{ choices: SetupChoice[], selected: number }}
 */
function colourChoices(step, inForce, omarchy) {
  const shown = omarchy && inForce["theme.source"] === "omarchy";
  const name = String(inForce["theme.name"] ?? DEFAULT_THEME_NAME);
  const otherName = name !== DEFAULT_THEME_NAME;
  /** @type {SetupChoice[]} */
  const choices = [];
  let selected = -1;
  for (const c of step.choices) {
    const own = c.edits[0];
    if (!own) continue;
    if (own.key === "source") {
      if (!omarchy) continue;
      if (shown) selected = choices.length;
      choices.push(c);
      continue;
    }
    /** @type {TomlEdit[]} */
    const edits = [];
    if (shown) edits.push({ table: "theme", key: "source", value: "file" });
    if (otherName) edits.push({ table: "theme", key: "name", value: DEFAULT_THEME_NAME });
    edits.push(own);
    if (!shown && !otherName && inForce["theme.appearance"] === own.value) {
      selected = choices.length;
    }
    choices.push({ label: c.label, edits });
  }
  if (selected >= 0) return { choices, selected };
  // Another name in force is none of the choices (behaviour 9).
  return {
    choices: [{ label: `Keep ${JSON.stringify(name)}`, edits: [], keep: true }, ...choices],
    selected: 0,
  };
}

/**
 * A step's choices with the one in force selected (behaviour 9). When the value in force is
 * none of them, **Keep** comes first, with that value, and is selected. The search engine's
 * choices are `engines`, the installed engines the host lists; the colours step's follow the
 * effect in force, with Omarchy only where `omarchy` says a theme is found.
 * @param {SetupStep} step @param {InForce} inForce
 * @param {{ engines?: readonly string[], omarchy?: boolean }} [options]
 * @returns {{ choices: SetupChoice[], selected: number }}
 */
export function stepChoices(step, inForce, { engines = [], omarchy = false } = {}) {
  if (step.id === "colours") return colourChoices(step, inForce, omarchy);
  /** @type {SetupChoice[]} */
  const choices =
    step.id === "search_engine"
      ? engines.map((name) => ({
          label: name,
          edits: [{ table: "search", key: "default", value: name }],
        }))
      : [...step.choices];
  const at = choices.findIndex((c) => c.edits.every((e) => Object.is(inForce[pathOf(e)], e.value)));
  if (at >= 0 || !step.setting) return { choices, selected: Math.max(at, 0) };
  const value = inForce[`${step.setting.table}.${step.setting.key}`];
  if (value === undefined) return { choices, selected: 0 };
  return {
    choices: [{ label: `Keep ${JSON.stringify(value)}`, edits: [], keep: true }, ...choices],
    selected: 0,
  };
}

/**
 * What `enter` on `choice` writes: its edits whose value is not the one in force (behaviour 8,
 * decision 4). Skip (`null`) and Keep write nothing.
 * @param {SetupChoice | null} choice @param {InForce} inForce
 * @returns {TomlEdit[]}
 */
export function planChoice(choice, inForce) {
  if (!choice) return [];
  return choice.edits.filter((e) => !Object.is(inForce[pathOf(e)], e.value));
}

/**
 * The lines a step shows before `enter` (behaviour 12): `[ui] toolbar = "hidden"`, or
 * "Writes nothing".
 * @param {readonly TomlEdit[]} edits
 * @returns {string[]}
 */
export function editLines(edits) {
  if (!edits.length) return ["Writes nothing"];
  return edits.map((e) => `[${e.table}] ${e.key} = ${tomlLiteral(e.value)}`);
}

/**
 * What `enter` on `choice` writes, judged against the values in force at `enter` (decision 4),
 * which may differ from those the step opened on. The colours step plans its choice again for
 * the effect then, from the choice's own key (its last edit).
 * @param {SetupStep} step @param {SetupChoice} choice @param {InForce} inForce
 * @param {{ omarchy?: boolean }} [options]
 * @returns {TomlEdit[] | null}  null when the choice is no longer offered (Omarchy went away):
 *   nothing is written, and it is not "already so"
 */
export function planAtEnter(step, choice, inForce, { omarchy = false } = {}) {
  if (choice.keep) return [];
  if (step.id === "colours") {
    const own = choice.edits.at(-1);
    const now = colourChoices(step, inForce, omarchy).choices.find(
      (c) => !c.keep && c.edits.at(-1)?.key === own?.key && c.edits.at(-1)?.value === own?.value,
    );
    return now ? planChoice(now, inForce) : null;
  }
  return planChoice(choice, inForce);
}

/**
 * What an action step of Moving in did (decision 17): SetupHost.setDefaultBrowser's answer,
 * openImportWizard's, or what a choice that runs nothing means.
 * @typedef {"default" | "asked" | "unavailable" | "failed" | "closed" | "not-now" | "already"
 *   | "left"} ActionResult
 */

/**
 * @typedef {object} MovingInState  what the host found before drawing a Moving in step
 * @property {boolean} [isDefault]
 * @property {boolean} [canSet]
 * @property {"flatpak" | "policy" | "locked" | null} [why]  why Make Default cannot be asked
 * @property {boolean} [canImport]  the profileImport policy allows the wizard
 */

/** Why the default browser step cannot ask the system, by SetupHost's reason. */
const NO_DEFAULT = {
  flatpak:
    "Under Flatpak, Vimma can neither set nor check the default browser: choose it in your " +
    "system's settings.",
  policy: "Your organisation's policy does not let Vimma change the default browser.",
  locked: "A locked preference keeps Vimma from changing the default browser.",
};

/**
 * The choices of a Moving in step (behaviours 22 and 23) for what the system allows now: they
 * save no key, so each has no edits. A step that cannot act offers only to move on and says why.
 * @param {string} id  "default_browser" or "bring_your_data"
 * @param {MovingInState} state
 * @returns {{ choices: SetupChoice[], selected: number, status: string }}
 */
export function actionChoices(id, state) {
  /** @param {string} label @param {ActionResult} result @returns {SetupChoice} */
  const pass = (label, result) => ({ label, edits: [], result });
  if (id === "default_browser") {
    if (state.isDefault) {
      return {
        choices: [pass("Go on", "already")],
        selected: 0,
        status: "Vimma is already your default browser.",
      };
    }
    if (!state.canSet) {
      return {
        choices: [pass("Go on", "left")],
        selected: 0,
        status: NO_DEFAULT[state.why ?? "policy"],
      };
    }
    return {
      choices: [
        { label: "Make Vimma the default browser", edits: [], run: true },
        pass("Not now", "not-now"),
      ],
      selected: 0,
      status: "Vimma is not your default browser now.",
    };
  }
  if (id === "bring_your_data") {
    if (!state.canImport) {
      return {
        choices: [pass("Go on", "left")],
        selected: 0,
        status: "Your organisation's policy turns the import wizard off.",
      };
    }
    return {
      choices: [
        { label: "Open the import wizard", edits: [], run: true },
        pass("Not now", "not-now"),
      ],
      selected: 0,
      status: "",
    };
  }
  return { choices: [], selected: 0, status: "" };
}

/**
 * What the page does with a Moving in result: move on or keep the step open, what the footer
 * says, and what "Saved this run" lists, so that an action that acted is never reported as
 * "nothing written" (behaviour 11).
 * @param {string} id @param {ActionResult} result
 * @returns {{ advance: boolean, saved: string[], said: string }}
 */
export function actionOutcome(id, result) {
  /** @param {string} said @param {string[]} [saved] */
  const on = (said, saved = []) => ({ advance: true, saved, said });
  /** @param {string} said */
  const stay = (said) => ({ advance: false, saved: [], said });
  switch (result) {
    case "not-now":
      return on("not now");
    case "left":
      return on("left as it is");
    case "already":
      return on("already the default browser");
    case "default":
      return on("Vimma is now the default browser", ["made the default browser"]);
    case "asked":
      // The system took the request, but its check still names another browser: it may
      // be waiting for the user to confirm in a dialog of its own.
      return on("asked the system to make Vimma the default; it may ask you to confirm", [
        "asked the system to make Vimma the default",
      ]);
    case "closed":
      return on("import wizard closed", ["import wizard closed"]);
    case "failed":
      return stay("The system did not make Vimma the default browser.");
    case "unavailable":
      return stay(
        id === "bring_your_data"
          ? "The import wizard cannot open here."
          : "Vimma cannot change the default browser here.",
      );
  }
  return stay("");
}

/**
 * Step text as parts the page builds nodes from, never as HTML: `<kbd>` and `<code>` become
 * their own parts and everything else stays text, so a key the user bound (`<`) is never markup.
 * @param {string} text  a step's text, filled (fillStepText)
 * @returns {{ tag: "kbd" | "code" | null, text: string }[]}
 */
export function textParts(text) {
  /** @type {{ tag: "kbd" | "code" | null, text: string }[]} */
  const out = [];
  let at = 0;
  for (const m of text.matchAll(/<(kbd|code)>(.*?)<\/\1>/g)) {
    if (m.index > at) out.push({ tag: null, text: text.slice(at, m.index) });
    out.push({ tag: /** @type {"kbd" | "code"} */ (m[1]), text: m[2] ?? "" });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ tag: null, text: text.slice(at) });
  return out;
}
