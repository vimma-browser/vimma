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
import { firefoxShortcuts, isShortcutChord } from "../keys/firefox-keys.mjs";
import { tomlLiteral } from "../config/toml.mjs";
import { DEFAULT_THEME_NAME } from "../config/theme.mjs";
import { mcpAdoptedWarning, mcpState } from "../agent/agent.mjs";
import { DEFAULT_HINT_CHARS } from "../page/hints.mjs";
import { defaultKeys } from "../config/defaults.mjs";
import { parseConfig } from "../config/config.mjs";

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
 * @property {true} [record]  the prefix step's own key (decision 21): `enter` waits for a key
 *   combination when its edits are empty, else (a prefix of the user's own in force) writes
 *   nothing as the value in force does
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
          { label: "Vimma light", edits: [{ table: "theme", key: "appearance", value: "light" }] },
          { label: "Vimma dark", edits: [{ table: "theme", key: "appearance", value: "dark" }] },
          {
            label: "Vimma, following the system",
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
        // The built-in prefix; the second row, a key the user presses, is added by stepChoices
        // (decision 21).
        [["ctrl+b", "ctrl+b"]],
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
            "12 hours, with no cookies. Never check stops every request to " +
            "updates.vimma.dev, <code>:update</code> included.",
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
          // Two lines (behaviour 28), then the kill switch: the page shows each line apart.
          text:
            "Agents reach only the agent workspace.\n" +
            "Sending a form, paying and showing you a page always ask you first.\n" +
            "<code>:mcp off</code> turns agents off until <code>:mcp on</code> or a restart, " +
            "whatever config.toml says and however often it is read again.",
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
    const value = c.edits[0]?.value;
    // "Choose your own" before a key is pressed: no prefix to draw yet.
    if (value === undefined) return [];
    const prefix = parseKey(String(value));
    return keymap
      .bindingsFor(name)
      .filter(fromPage)
      .map((text) => displayBinding(text, { prefix, leader: keymap.leader }));
  });
}

/** The `[ui]` keys a drawing of the window shows, with their built-in defaults. */
/** The config in force with no file at all: every key its built-in default. */
const DEFAULTS = /** @type {ResolvedConfig} */ (parseConfig("").config);
const WINDOW_DEFAULTS = Object.freeze({
  toolbar: DEFAULTS.ui.toolbar,
  tabline: DEFAULTS.ui.tabline,
});

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
 * @property {{ pref: boolean, off: boolean }} [mcp]  `:mcp on|off`'s pref, and whether `:mcp off`
 *   holds agents off for the session (decision 16)
 */

/**
 * The values in force of the steps' keys, by `table.key`, from a resolved config (the file at
 * `enter`, decision 4), its built-in defaults, and `runtime` for what the file leaves to
 * Firefox or a command (behaviour 9). A later step adds its key here. With no config in force
 * (a broken file and no good one before it), the built-in defaults are.
 * @param {ResolvedConfig | null} resolved @param {SetupRuntime} [runtime]
 * @returns {InForce}
 */
export function inForceOf(
  resolved,
  { engine = null, appearance, engines = [], mcp = { pref: false, off: false } } = {},
) {
  const config = resolved ?? DEFAULTS;
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
    "updates.check": config.updates.check,
    // What `:mcp` says (behaviour 9): its off for the session, then the file, then the pref.
    "mcp.enabled": mcpState({
      pref: mcp.pref,
      ...(config.mcp.enabled === undefined ? {} : { config: config.mcp.enabled }),
      off: mcp.off,
    }).enabled,
    // Not choices' keys: what the agents step plans and says from (agentsTurnOn, choiceNote).
    "mcp.file": config.mcp.enabled,
    "mcp.held": mcp.off,
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
 * The prefix step's two rows (decision 21): the built-in `ctrl+b`, and a key the user presses.
 * A prefix of the user's own in force is that second row, selected, and `enter` on it writes
 * nothing, as on any value in force; there is no Keep.
 * @param {SetupStep} step @param {InForce} inForce
 * @returns {{ choices: SetupChoice[], selected: number }}
 */
function prefixChoices(step, inForce) {
  const now = String(inForce["keys.prefix"] ?? "");
  const builtIn = step.choices.filter((c) => !c.keep);
  const at = builtIn.findIndex((c) => c.edits[0]?.value === now);
  /** @type {SetupChoice} */
  const own =
    at >= 0
      ? { label: "Choose your own", edits: [], record: true }
      : {
          label: `Your own: ${now}`,
          edits: [{ table: "keys", key: "prefix", value: now }],
          record: true,
        };
  return { choices: [...builtIn, own], selected: at >= 0 ? at : builtIn.length };
}

/**
 * What the page needs to judge a key pressed on the prefix step without sending it anywhere
 * (decision 21), as plain data: the keymap's own rules, read by the host from the keymap in
 * force, and by the host again from config.toml at `enter`.
 * @typedef {object} PrefixRules
 * @property {string} inForce  the prefix in force, canonical
 * @property {string} leader  `[modal] leader`, canonical
 * @property {string[]} lists  the bindings of `show_keybinds` that work from a page, as written
 *   (`prefix+?`), to draw the key that lists every key under a pressed prefix
 * @property {Record<string, string>} taken  the first key of each binding not written with
 *   `prefix`, with its action (Keymap.keysOutsidePrefix)
 * @property {string[]} firefox  the chords `[firefox] enable` gives back to Firefox
 * @property {Record<string, string>} shared  what Firefox does with a key it keeps for fields and
 *   menus (the inventory's fate d), which the prefix would take from it
 */

/** @param {Keymap} keymap @returns {PrefixRules} */
export function prefixRules(keymap) {
  const { user, mac } = keymap.source;
  /** @type {string[]} */
  const firefox = [];
  const enable = /** @type {unknown} */ (user.firefox?.enable);
  const enabled = typeof enable === "string" ? [enable] : Array.isArray(enable) ? enable : [];
  for (const text of enabled) {
    try {
      firefox.push(formatKey(parseKey(String(text))));
    } catch {
      // compileKeymap refused it already; a keymap in force has none.
    }
  }
  /** @type {Record<string, string>} */
  const shared = {};
  for (const r of firefoxShortcuts({ mac })) {
    if (r.fate === "d" && !(r.chord in shared)) shared[r.chord] = r.does;
  }
  return {
    inForce: formatKey(keymap.prefix),
    leader: formatKey(keymap.leader),
    lists: keymap.bindingsFor("show_keybinds").filter(fromPage),
    taken: Object.fromEntries(keymap.keysOutsidePrefix()),
    firefox,
    shared,
  };
}

/** Keys that are never the prefix whatever the modifiers (decision 21). */
const NEVER_PREFIX = new Set(["esc", "enter", "tab"]);

/**
 * Why `chord` cannot be the prefix, or null when it can (decision 21). The prefix in force is
 * never refused: pressed again, it writes nothing.
 * @param {string} chord  canonical (formatKey)
 * @param {PrefixRules} rules
 * @returns {string | null}
 */
export function prefixRefusal(chord, rules) {
  if (chord === rules.inForce) return null;
  /** @type {import("../keys/keys.mjs").Chord} */
  let c;
  try {
    c = parseKey(chord);
  } catch {
    return `${chord} is no key Vimma can bind.`;
  }
  if (NEVER_PREFIX.has(c.key)) {
    return `${chord}: esc, enter and tab stay with Vimma, pages and forms, so none of them can be the prefix.`;
  }
  if (!isShortcutChord(c)) {
    return `${chord} alone is a key you type: the prefix needs ctrl, alt or meta with it, such as ctrl+a.`;
  }
  if (chord === rules.leader) return `${chord} is the leader key ([modal] leader).`;
  if (rules.firefox.includes(chord)) {
    return `${chord} is Firefox's own: [firefox] enable in config.toml gives it back to Firefox.`;
  }
  const action = rules.taken[chord];
  if (action) {
    return `${chord} already runs ${action}; as the prefix it no longer would. Choose another key, or unbind it in config.toml first.`;
  }
  return null;
}

/**
 * What Firefox no longer does once `chord` is the prefix, for a key it keeps for fields and
 * menus (`ctrl+a`, select all), or null.
 * @param {string} chord  canonical @param {PrefixRules} rules
 * @returns {string | null}
 */
export function prefixNote(chord, rules) {
  if (chord === rules.inForce) return null;
  const does = rules.shared[chord];
  return does ? `${chord} is also Firefox's ${does}; as the prefix, it no longer does that.` : null;
}

/**
 * The keys that would list every key with `chord` as the prefix (behaviour 25).
 * @param {string} chord  canonical @param {PrefixRules} rules
 * @returns {string[]}
 */
export function prefixListKeys(chord, rules) {
  const prefix = parseKey(chord);
  const leader = parseKey(rules.leader);
  return rules.lists.map((text) => displayBinding(text, { prefix, leader }));
}

/**
 * A chord the page proposes, read as one chord in Vimma's notation and written back in its
 * canonical form, or null: the host writes nothing else (decision 21, Security and privacy).
 * @param {unknown} text
 * @returns {string | null}
 */
export function readPrefix(text) {
  if (typeof text !== "string" || !text || /\s/.test(text)) return null;
  try {
    return formatKey(parseKey(text));
  } catch {
    return null;
  }
}

/**
 * What `enter` on a key pressed on the prefix step writes: `[keys] prefix`, or nothing for the
 * prefix in force (behaviour 8).
 * @param {string} chord  canonical @param {InForce} inForce
 * @returns {TomlEdit[]}
 */
export function planPrefix(chord, inForce) {
  return chord === inForce["keys.prefix"] ? [] : [{ table: "keys", key: "prefix", value: chord }];
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
  if (step.id === "prefix_key") return prefixChoices(step, inForce);
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
  if (step.id === "agents" && agentsTurnOn(step, choice, inForce)) {
    // Held off by `:mcp off` with the file already on: the consent alone turns agents on.
    return inForce["mcp.file"] === true ? [] : planChoice(choice, inForce);
  }
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
 * Whether `enter` on `choice` turns agents on (behaviour 28): the agents step's "on" while they
 * are off. That `enter` is the user's consent, as a yes to `:mcp on` is, so the host checks what
 * that yes checks and ends `:mcp off`'s hold as it does (docs/security/12-agents-mcp.md M65).
 * @param {SetupStep} step @param {SetupChoice} choice @param {InForce} inForce
 * @returns {boolean}
 */
export function agentsTurnOn(step, choice, inForce) {
  if (step.id !== "agents" || choice.keep) return false;
  const on = choice.edits.some((e) => e.table === "mcp" && e.key === "enabled" && e.value === true);
  return on && inForce["mcp.enabled"] !== true;
}

/**
 * A line the agents step shows under a choice, besides what it writes: that "on" also ends
 * `:mcp off`'s hold, as `:mcp on` does; that the file turns agents on again at the next start
 * while the hold keeps them off; what `:mcp on`'s question says of a workspace of yours; or that
 * there is no agent workspace to turn on. Null for every other step and choice.
 * @param {SetupStep} step @param {SetupChoice} choice @param {InForce} inForce
 * @param {{ adopted?: { name: string, tabs: number } | null, missing?: boolean }} [agent]
 *   the agent workspace when it is one Vimma did not make, or `missing` without one
 * @returns {string | null}
 */
export function choiceNote(step, choice, inForce, { adopted = null, missing = false } = {}) {
  if (step.id !== "agents" || choice.keep) return null;
  if (agentsTurnOn(step, choice, inForce)) {
    if (missing) {
      return "There is no agent workspace (containers are off), so agents cannot be turned on.";
    }
    const hold = inForce["mcp.held"] ? "Also ends :mcp off for this session." : null;
    if (adopted) {
      const warning = mcpAdoptedWarning(adopted.name, { tabs: adopted.tabs });
      return hold ? `${warning} ${hold}` : warning;
    }
    return hold;
  }
  const off = choice.edits.some((e) => e.key === "enabled" && e.value === false);
  if (off && inForce["mcp.held"] && inForce["mcp.file"] === true) {
    return "config.toml's [mcp] enabled = true turns agents on again at the next start.";
  }
  return null;
}

/**
 * The lines a choice shows before `enter` (behaviour 12): what `planAtEnter` would write, and
 * "Writes nothing" for the agents step's "on" without an agent workspace, which the host
 * refuses as `:mcp on` refuses it (decision 20).
 * @param {SetupStep} step @param {SetupChoice} choice @param {InForce} inForce
 * @param {{ omarchy?: boolean, missing?: boolean }} [options]  `missing`: no agent workspace
 * @returns {string[]}
 */
export function choiceLines(step, choice, inForce, { omarchy = false, missing = false } = {}) {
  if (missing && agentsTurnOn(step, choice, inForce)) return editLines([]);
  return editLines(planAtEnter(step, choice, inForce, { omarchy }) ?? []);
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
