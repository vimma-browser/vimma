/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `vimma_keys`'s keys (docs/specs/mcp-drive.md, D9-D11, D15; security.md M16, M20): the text an
 * agent sends, parsed by a dispatcher of its own over Vimma's default keymap, never the user's,
 * and kept only when every action id is on a fixed whitelist. Nothing here reaches a page: the
 * browser runs each step as a Vimma action on the agent tab (ctl/AgentDrive.sys.mjs).
 */

import { getAction } from "./actions.mjs";
import { DEFAULT_CONFIG } from "./defaults.mjs";
import { createDispatcher } from "./dispatcher.mjs";
import { compileKeymap } from "./keymap.mjs";
import { formatKey, parseBinding, parseKey } from "./keys.mjs";

/** @import { Chord, BindingElement } from "./keys.mjs" */
/** @import { Action } from "./dispatcher.mjs" */

/** The actions `vimma_keys` may run (D9), by id. Links (`hint.follow`) come with D12. */
export const AGENT_KEY_ACTIONS = Object.freeze(
  new Set([
    "scroll.down",
    "scroll.up",
    "scroll.left",
    "scroll.right",
    "scroll.half_down",
    "scroll.half_up",
    "scroll.top",
    "scroll.bottom",
    "history.back",
    "history.forward",
    "find.forward",
    "find.backward",
    "find.next",
    "find.previous",
    "page.url_up",
    "page.url_root",
  ]),
);

/** D15: the keys' length, actions per call, a count, a find query. */
export const AGENT_KEY_LIMITS = Object.freeze({ chars: 512, actions: 32, count: 99, query: 256 });

/**
 * One action to run: the keys that made it as the question shows them, its id, its count and,
 * for `/` and `?`, the query.
 * @typedef {{ keys: string, action: string, count?: number, query?: string }} AgentStep
 * @typedef {{ ok: true, steps: AgentStep[] } | { ok: false, error: string }} AgentKeys
 */

/**
 * Vimma's defaults alone (D10): a user's `[keys]` or `[modal.normal]` could bind `j` to
 * `tab.close`, and the tool must mean the same in every install. Built once.
 * @type {import("./keymap.mjs").Keymap | null}
 */
let keymap = null;

/** Why each refused action is refused, by id or by id prefix, first match wins. */
const REASONS = /** @type {const} */ ([
  [["hint.follow"], "following links by hint label is not in this Vimma yet; use vimma_open"],
  [["command.open", "cmdline.run"], "the command line is the user's"],
  [
    ["mode.insert", "urlbar.focus", "page.focus_input", "page.open"],
    "vimma_keys never types into a page or a field",
  ],
  [["mode.visual", "caret.", "selection."], "copy mode and the selection are the user's"],
  [
    ["page.yank_url", "page.open_clipboard", "page.open_clipboard_new_tab"],
    "the clipboard is the user's",
  ],
  [["hint.follow_new_tab", "page.view_source"], "it opens a tab; vimma_open does that, asked"],
  [["page.reload"], "a reload can send a form again"],
  [
    ["workspace.", "window.", "tab.", "pane.", "panel.", "goto.", "sidebar.", "grep."],
    "the tabs, workspaces, windows and layout are the user's",
  ],
]);

/** Groups of actions.mjs that are the browser's own, never a page's. */
const USER_GROUPS = new Set([
  "Browser",
  "Developer tools",
  "Bookmarks",
  "Config",
  "Add-ons",
  "Help",
  "Agents",
]);

/** @param {string} id */
function reasonFor(id) {
  for (const [names, why] of REASONS) {
    if (names.some((n) => (n.endsWith(".") ? id.startsWith(n) : id === n))) return why;
  }
  const group = getAction(id)?.group;
  if (group && USER_GROUPS.has(group)) return "the browser's own tools and settings are the user's";
  return "it is not one of the keys vimma_keys runs";
}

/**
 * Why the keys are refused, naming the first key refused and, when it is bound, its action.
 * @param {string} keys @param {string} why @param {string} [id]
 */
const refusal = (keys, why, id) => `key "${keys}"${id ? ` (${id})` : ""} is refused: ${why}`;

/** @param {string} error @returns {AgentKeys} */
const refused = (error) => ({ ok: false, error });

/** Vim's names for the modifiers, in the order `<C-S-x>` writes them. */
const VIM_MODS = /** @type {const} */ ([
  ["ctrl", "C"],
  ["alt", "A"],
  ["shift", "S"],
  ["meta", "M"],
]);

/**
 * A chord as the question shows it: a character as itself (`j`, `G`), anything else in Vim's
 * brackets (`<C-d>`, `<esc>`).
 * @param {Chord} c
 */
function shownChord(c) {
  if (!c.ctrl && !c.alt && !c.meta && [...c.key].length === 1) {
    return c.shift ? c.key.toUpperCase() : c.key;
  }
  const mods = VIM_MODS.filter(([m]) => c[m]).map(([, v]) => `${v}-`);
  const key = formatKey({ ...c, ctrl: false, alt: false, shift: false, meta: false });
  return `<${mods.join("")}${key}>`;
}

/** The end of a `/` or `?` query, in any case. */
const QUERY_END = /<cr>/i;
/** Control, bidirectional and invisible characters: the question must show what runs. */
const CONTROL =
  // eslint-disable-next-line no-control-regex -- the control characters are what it refuses
  /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
/** The default prefix (ctrl+b): it and every binding after it are the user's. */
const PREFIX = formatKey(parseKey(/** @type {string} */ (DEFAULT_CONFIG.keys?.prefix)));
const PREFIX_WHY = "the prefix, the leader and their bindings are the user's";

/**
 * A whitespace-delimited word that is one key (`esc`, `ctrl+b`, `prefix+x`), as parseBinding
 * reads a `[modal.*]` value; any other word is a run of keys (`gg`, `3j`, `/foo`).
 * @param {string} word
 */
function isOneKey(word) {
  if (word.length < 2 || !/^[A-Za-z0-9+-]+$/.test(word)) return false;
  if (word.includes("+")) return true;
  try {
    parseKey(word);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse `vimma_keys`'s keys: each step's action id, count and find query, or why not. Notation
 * is the one `[modal.*]` tables use (parseBinding); whitespace between keys is ignored. `/` and
 * `?` take the text up to the next `<CR>` as their query: characters, not keys.
 * @param {string} text
 * @returns {AgentKeys}
 */
export function parseAgentKeys(text) {
  const chars = [...text];
  if (chars.length > AGENT_KEY_LIMITS.chars) {
    return refused(`keys must be at most ${AGENT_KEY_LIMITS.chars} characters`);
  }
  if (CONTROL.test(text))
    return refused(
      "keys must not contain control characters, bidirectional controls or invisible characters",
    );
  keymap ??= compileKeymap();
  const dispatcher = createDispatcher(keymap);
  /** @type {AgentStep[]} */
  const steps = [];
  /** What the current step has typed so far. */
  let typed = "";
  /** The step that wants its query: the text after its `/` or `?`. */
  /** @type {AgentStep | null} */
  let wantsQuery = null;

  /**
   * One action from the dispatcher: whitelisted, within the limits.
   * @param {Action} action
   * @returns {string | null} why it is refused, or null
   */
  const take = (action) => {
    const keys = typed;
    typed = "";
    if (!AGENT_KEY_ACTIONS.has(action.id)) return refusal(keys, reasonFor(action.id), action.id);
    if (action.count !== undefined && action.count > AGENT_KEY_LIMITS.count) {
      return refusal(keys, `a count must be at most ${AGENT_KEY_LIMITS.count}`);
    }
    if (steps.length >= AGENT_KEY_LIMITS.actions) {
      return `keys must be at most ${AGENT_KEY_LIMITS.actions} actions`;
    }
    /** @type {AgentStep} */
    const step = { keys, action: action.id };
    if (action.count !== undefined) step.count = action.count;
    steps.push(step);
    if (action.id === "find.forward" || action.id === "find.backward") wantsQuery = step;
    return null;
  };

  /**
   * One element of the keys into the dispatcher.
   * @param {BindingElement} el
   * @returns {string | null} why the keys are refused, or null
   */
  const feed = (el) => {
    if ("special" in el) {
      const name = el.special === "prefix" ? "prefix" : "<leader>";
      return refusal(`${typed}${name}`, PREFIX_WHY);
    }
    typed += shownChord(el);
    if (formatKey(el) === PREFIX) return refusal(typed, PREFIX_WHY);
    for (;;) {
      const r = dispatcher.dispatch("normal", el);
      if (r.kind === "pending") return null;
      if (r.kind !== "action") return refusal(typed, "it is not one of the keys vimma_keys runs");
      if (!r.replay) return take(r.action);
      // A shorter binding ran (`g` alone, were it bound): this key starts the next one.
      const shown = shownChord(el);
      typed = typed.slice(0, typed.length - shown.length);
      const why = take(r.action);
      if (why) return why;
      typed = shown;
    }
  };

  let i = 0;
  while (i < text.length) {
    if (/\s/.test(/** @type {string} */ (text[i]))) {
      i++;
      continue;
    }
    let end = text.slice(i).search(/\s/);
    end = end === -1 ? text.length : i + end;
    const word = text.slice(i, end);
    if (isOneKey(word)) {
      /** @type {BindingElement[]} */
      let els;
      try {
        els = parseBinding(word);
      } catch {
        return refused(refusal(word, "it is not a key"));
      }
      for (const el of els) {
        const why = feed(el);
        if (why) return refused(why);
      }
      i = end;
      continue;
    }
    // A run of keys, one character or `<...>` at a time; a query may run on past this word.
    while (i < end) {
      /** @type {BindingElement} */
      let el;
      if (text[i] === "<" && text.indexOf(">", i + 1) !== -1 && text.indexOf(">", i + 1) < end) {
        const close = text.indexOf(">", i + 1);
        const token = text.slice(i, close + 1);
        try {
          el = /** @type {BindingElement} */ (parseBinding(token)[0]);
        } catch {
          return refused(refusal(token, "it is not a key"));
        }
        i = close + 1;
      } else {
        const ch = String.fromCodePoint(/** @type {number} */ (text.codePointAt(i)));
        try {
          el = parseKey(ch);
        } catch {
          return refused(refusal(ch, "it is not a key"));
        }
        i += ch.length;
      }
      const why = feed(el);
      if (why) return refused(why);
      if (wantsQuery) {
        const step = /** @type {AgentStep} */ (wantsQuery);
        wantsQuery = null;
        const rest = text.slice(i);
        const at = rest.search(QUERY_END);
        if (at === -1)
          return refused(refusal(step.keys, "a find needs its query to end with <CR>"));
        const query = rest.slice(0, at);
        if (!query) return refused(refusal(step.keys, "a find query must not be empty"));
        if ([...query].length > AGENT_KEY_LIMITS.query) {
          const why = `a find query must be at most ${AGENT_KEY_LIMITS.query} characters`;
          return refused(refusal(step.keys, why));
        }
        if (CONTROL.test(query) || query.includes("\t")) {
          return refused(refusal(step.keys, "a find query must not contain control characters"));
        }
        step.query = query;
        step.keys = `${step.keys}${JSON.stringify(query)}⏎`;
        i += at + "<CR>".length;
        const next = text.slice(i).search(/\s/);
        end = next === -1 ? text.length : i + next;
      }
    }
  }
  const last = dispatcher.flush();
  if (last?.kind === "action") {
    const why = take(last.action);
    if (why) return refused(why);
  } else if (typed) {
    return refused(refusal(typed, "the key sequence is incomplete"));
  }
  if (!steps.length) return refused("keys has no keys");
  return { ok: true, steps };
}

/**
 * The keys as they will run (D14): each step's keys, a space between steps.
 * @param {AgentStep[]} steps
 */
export function shownKeys(steps) {
  return steps.map((s) => s.keys).join(" ");
}
