/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The `:` command line: parsing, completion and history. See docs/specs/m1-core-logic.md
 * § Command line.
 */
import { ACTIONS, closest, resolveActionName } from "./actions.mjs";
import { scoreField } from "./picker.mjs";
import { LAYOUTS } from "./layouts.mjs";

/** @import { Action } from "./dispatcher.mjs" */

/**
 * @typedef {object} CommandDef
 * @property {string} name
 * @property {readonly string[]} aliases
 * @property {"none" | "optional" | "required"} argument
 * @property {string} action       the action id, run without text (or with it, absent textAction)
 * @property {string} [textAction] the action id when text is given, if it differs
 * @property {string} [text]       fixed text the action always runs with (`:about`)
 * @property {string} description
 */
/** @typedef {{ code: string, message: string, suggestions: readonly string[] }} CommandError */
/**
 * @typedef {{ kind: "run", command: string, action: Action, text?: string }
 *   | { kind: "empty" }
 *   | { kind: "error", error: CommandError }} CommandResult
 */
/**
 * `value` replaces the whole line; `label`, if any, is what the list shows (an argument's text
 * without its command).
 * @typedef {{ value: string, kind: "command" | "action" | "argument", description: string,
 *   label?: string }} Candidate
 */
/** @typedef {{ name: string, description: string }} AliasCompletion */
/**
 * What arguments complete to: names by `ARGUMENT_KINDS` key, and `search`, the `@aliases`
 * `:open` completes, as AliasCompletion.
 * @typedef {Readonly<Record<string, readonly string[] | readonly AliasCompletion[]>>}
 *   CompletionArgs
 */
/**
 * @typedef {object} History
 * @property {readonly string[]} entries oldest first
 * @property {number} limit
 * @property {number | null} index      the recalled entry, null when not browsing
 * @property {string} draft             the line as typed before the first Up
 */

/**
 * @param {string} name
 * @param {CommandDef["argument"]} argument
 * @param {string} action
 * @param {string} description
 * @param {{ aliases?: string[], textAction?: string, text?: string }} [extra]
 * @returns {CommandDef}
 */
const cmd = (name, argument, action, description, { aliases = [], textAction, text } = {}) =>
  Object.freeze({
    name,
    aliases: Object.freeze(aliases),
    argument,
    action,
    ...(textAction ? { textAction } : {}),
    ...(text ? { text } : {}),
    description,
  });

/** The commands of plan §2 (Neovim column). Any action name is a command too. */
/** @type {readonly CommandDef[]} */
export const COMMANDS = Object.freeze([
  cmd("open", "required", "page.open", "Open a URL in this tab"),
  cmd("tabnew", "optional", "tab.new", "New tab, optionally opening a URL"),
  cmd("tabrename", "optional", "tab.rename", "Rename tab (without a name: prompt)"),
  cmd("q", "none", "pane.close", "Close pane (the last one closes the tab)", {
    aliases: ["quit"],
  }),
  cmd("vsplit", "none", "pane.split_vertical", "Split right", { aliases: ["vs"] }),
  cmd("split", "none", "pane.split_horizontal", "Split down", { aliases: ["sp"] }),
  // docs/specs/tiling-layouts.md: without a name the next preset, as ctrl+b space.
  cmd("layout", "optional", "pane.next_layout", "Next layout, or the named one (Tab completes)", {
    textAction: "pane.select_layout",
  }),
  // `wsn`, as Vim's `:wsn[ext]`: the prefix was unique before `wsnew` came. The short aliases
  // follow Vim's buffer commands (`:b`, `:bn`, `:bp`, `:bd`, `:badd`, `:ls`; m3-workspaces).
  cmd("wsnext", "none", "workspace.next", "Next workspace", { aliases: ["wsn", "wn"] }),
  cmd("wsprev", "none", "workspace.previous", "Previous workspace", { aliases: ["wp"] }),
  cmd(
    "workspace",
    "optional",
    "workspace.picker",
    "Switch workspace by name or number, # the previous one (without: picker)",
    { aliases: ["ws"], textAction: "workspace.switch" },
  ),
  cmd("workspaces", "none", "workspace.picker", "Workspace picker (as :ls lists buffers)"),
  // m3-workspaces 4a/4b. Without text, new / rename / move ask on the command line.
  cmd("wsnew", "optional", "workspace.new", "New workspace (and switch to it)", {
    aliases: ["wa"],
  }),
  cmd("wsrename", "optional", "workspace.rename", "Rename this workspace"),
  cmd("wsdelete", "optional", "workspace.close", "Close this (or the named) workspace; asks", {
    aliases: ["wd"],
  }),
  cmd("wsmove", "optional", "workspace.move_tab", "Move the tab to a workspace (name or number)"),
  // workspace-routing: without text, the rules (about:vimma); `add [workspace]`, `move`.
  cmd("route", "optional", "workspace.route", "Routing rules (add [workspace] | move)"),
  // docs/specs/private-workspace.md: toggles; `:private close` closes it (asks y/N).
  cmd("private", "optional", "workspace.private", "Private workspace; again goes back (close)", {
    aliases: ["priv"],
  }),
  // docs/specs/firefox-keys.md decision 5: any command or key of the window, by its id.
  cmd(
    "firefox",
    "required",
    "firefox.command",
    "Run a Firefox command or key by id (Tab completes)",
  ),
  cmd("ls", "none", "goto.picker", "Tab search: every tab, every window, recently closed"),
  // docs/specs/tab-search.md decision 2: the same picker, the text as its query.
  cmd("tabsearch", "optional", "goto.picker", "Tab search, with the text as its query", {
    aliases: ["ts", "b"],
  }),
  // docs/specs/live-grep.md decision 2: with text opens with that query; alone resumes.
  cmd("grep", "optional", "grep.resume", "Live grep (with text: that query; alone: the last)", {
    textAction: "grep.open",
  }),
  cmd("sidebar", "none", "sidebar.toggle", "Open / close the side panel"),
  // docs/specs/toolbar-toggle.md decision 2: show / hide set a known state (vimma-ctl).
  cmd("toolbar", "optional", "toolbar.toggle", "Show / hide the toolbar (show | hide)"),
  // docs/specs/bookmarks.md: with a path, files the page without the prompt.
  cmd("bookmark", "optional", "bookmark.add", "Bookmark this page (optionally folders/title)"),
  cmd("bookmarks", "none", "bookmarks.toggle", "Open / close the bookmarks panel"),
  // docs/specs/bookmarks-toolbar-hidden.md decision 5: Firefox's toggle; a word sets a state.
  cmd(
    "bookmarkstoolbar",
    "optional",
    "browser.bookmarks_toolbar",
    "Firefox's Bookmarks Toolbar (show | hide | newtab)",
  ),
  cmd("map", "none", "help.show", "Show all bindings"),
  cmd("help", "none", "help.show", "Show all bindings", { aliases: ["h"] }),
  // m5-config-load: with a path, that file replaces the config in force (all or nothing).
  cmd("source", "optional", "config.reload", "Reload config (or load the given file)"),
  cmd("setup", "none", "setup.open", "Set up add-ons and the search engine again"),
  cmd("config", "none", "config.edit", "Open config.toml in a tab (created if missing)"),
  // docs/specs/theme-appearance.md: without a word, the other of dark and light.
  cmd("theme", "optional", "theme.appearance", "Built-in theme: dark, light or system (Tab)"),
  // about:vimma (m5-about-vimma): a fixed URL for tab.new, so no new action or host runner.
  cmd("about", "none", "tab.new", "Open about:vimma (diagnostics)", {
    aliases: ["vimma"],
    text: "about:vimma",
  }),
  // docs/specs/m6a-updater.md: checks now; an update opens about:vimma's steps.
  cmd("update", "none", "app.update_check", "Check for a newer Vimma and how to update"),
  cmd("restart", "none", "app.restart", "Restart Vimma (tabs come back); applies an update"),
  cmd("bug", "none", "tab.new", "Copy a redacted about:vimma report", {
    text: "about:vimma#bug",
  }),
  // docs/specs/addon-manager.md. Without a name, :addon asks on the command line.
  cmd("addons", "none", "addons.picker", "Add-on picker"),
  cmd("addon", "optional", "addons.popup", "Open an add-on's popup (Tab completes names)"),
  // docs/specs/vimma-mcp.md: local AI agents and the agent workspace (on, off, revoke, forget);
  // log: docs/specs/mcp-drive.md D14.
  cmd(
    "mcp",
    "optional",
    "mcp.command",
    "Agents (MCP): on, off, revoke, forget, log; without: the status",
  ),
  // docs/specs/vimma-mcp.md decision 29 D: full control (vimma.control.enabled) for a while.
  cmd(
    "control",
    "optional",
    "control.command",
    "Full control: on <minutes>, off; without: the status",
  ),
  // docs/specs/builtin-agent.md Behaviour 14: without a word, the window.
  cmd(
    "agent",
    "optional",
    "agent.command",
    "Built-in agent: its window; stop, new, model, list, clear, give, forget all",
  ),
]);

/**
 * Action ids the commands use that actions.mjs does not define yet. The host spec adds them
 * (with `npm run gen-docs`) and empties this list. `agent.command` (`:agent`) joins
 * actions.mjs with the built-in agent's key, so that the keymap changes once
 * (docs/specs/builtin-agent.md B13); until then the host runs it by its id.
 */
export const PENDING_ACTIONS = Object.freeze(/** @type {string[]} */ (["agent.command"]));

/** `:toolbar`'s words, in completion order. */
const TOOLBAR_WORDS = Object.freeze(/** @type {const} */ (["show", "hide"]));

/**
 * `:toolbar [show|hide]` (docs/specs/toolbar-toggle.md decision 2): toggle without a word.
 * @param {string | undefined} text
 * @returns {{ kind: "toggle" | "show" | "hide" } | { kind: "refuse", text: string }}
 */
export function parseToolbarCommand(text) {
  const word = (text ?? "").trim().toLowerCase();
  if (!word) return { kind: "toggle" };
  if (word === "show" || word === "hide") return { kind: word };
  const near = closest(word, [...TOOLBAR_WORDS]);
  const refusal = ':toolbar takes "show", "hide" or nothing';
  return { kind: "refuse", text: near ? `${refusal}: did you mean "${near}"?` : refusal };
}

/** `:bookmarkstoolbar`'s words, in completion order, and the `[ui]` word each sets. */
const BOOKMARKS_TOOLBAR_WORDS = Object.freeze(
  /** @type {const} */ ({ show: "shown", hide: "hidden", newtab: "newtab" }),
);

/**
 * `:bookmarkstoolbar [show|hide|newtab]` (docs/specs/bookmarks-toolbar-hidden.md decision 5):
 * Firefox's own toggle without a word.
 * @param {string | undefined} text
 * @returns {{ kind: "toggle" }
 *   | { kind: "set", setting: import("./bookmarks-toolbar.mjs").BookmarksToolbarSetting }
 *   | { kind: "refuse", text: string }}
 */
export function parseBookmarksToolbarCommand(text) {
  const word = (text ?? "").trim().toLowerCase();
  if (!word) return { kind: "toggle" };
  if (Object.hasOwn(BOOKMARKS_TOOLBAR_WORDS, word)) {
    return {
      kind: "set",
      setting: BOOKMARKS_TOOLBAR_WORDS[/** @type {keyof typeof BOOKMARKS_TOOLBAR_WORDS} */ (word)],
    };
  }
  const near = closest(word, Object.keys(BOOKMARKS_TOOLBAR_WORDS));
  const refusal = ':bookmarkstoolbar takes "show", "hide", "newtab" or nothing';
  return { kind: "refuse", text: near ? `${refusal}: did you mean "${near}"?` : refusal };
}

/** @type {Map<string, CommandDef>} */
const byWord = new Map();
for (const c of COMMANDS) for (const w of [c.name, ...c.aliases]) byWord.set(w, c);

/** Config names of actions, once each (aliases are left out of completion). */
const ACTION_NAMES = [...new Set(ACTIONS.map((a) => a.name))];

/** The action id each word runs: a command's (and its text action), or an action name's. */
/** @type {Map<string, string[]>} */
const WORD_IDS = new Map([
  ...[...byWord].map(([w, c]) => /** @type {[string, string[]]} */ ([w, idsOf(c)])),
  ...ACTION_NAMES.map(
    (n) => /** @type {[string, string[]]} */ ([n, [resolveActionName(n)?.id ?? ""]]),
  ),
]);

/** @param {CommandDef} c */
function idsOf(c) {
  return c.textAction ? [c.action, c.textAction] : [c.action];
}

/**
 * Whether `word` runs one of the `hidden` action ids: an unfinished feature's, while its pref
 * is off (CONTRIBUTING.md, "Unfinished features": no command of it shows).
 * @param {string} word @param {readonly string[]} hidden
 */
const isHidden = (word, hidden) =>
  hidden.length > 0 && (WORD_IDS.get(word) ?? []).some((id) => hidden.includes(id));

/**
 * A free-text argument: the rest of the line, trimmed, unquoted only when one pair of quotes
 * wraps all of it (`"my  tab"`), so apostrophes inside text (`Juuso's tab`) stay as typed.
 * @param {string} raw
 */
function unwrap(raw) {
  const q = raw[0];
  if (raw.length >= 2 && (q === '"' || q === "'") && raw.endsWith(q)) {
    const inner = raw.slice(1, -1);
    if (!inner.includes(q)) return inner;
  }
  return raw;
}

/**
 * @param {string} code
 * @param {string} message
 * @param {string[]} [suggestions]
 * @returns {CommandResult}
 */
const fail = (code, message, suggestions = []) =>
  Object.freeze({
    kind: "error",
    error: Object.freeze({ code, message, suggestions: Object.freeze(suggestions) }),
  });

/**
 * @param {string} command
 * @param {Action} action
 * @param {string} [text]
 * @returns {CommandResult}
 */
const runResult = (command, action, text) =>
  Object.freeze({
    kind: "run",
    command,
    action: Object.freeze(action),
    ...(text ? { text } : {}),
  });

/** Every word a user can type, for suggestions. */
const ALL_WORDS = [...byWord.keys(), ...ACTION_NAMES];
/**
 * A word more than twice the longest is further from every word than `closest` allows, so it
 * is not compared: the edit distance is quadratic, and a pasted megabyte froze the window.
 */
const MAX_SUGGEST = 2 * Math.max(...ALL_WORDS.map((w) => w.length));

/**
 * Commands whose name or alias starts with `word`, once each.
 * @param {string} word
 */
const commandsWithPrefix = (word, hidden = /** @type {readonly string[]} */ ([])) => [
  ...new Set(
    [...byWord]
      .filter(([w, c]) => w.startsWith(word) && !idsOf(c).some((id) => hidden.includes(id)))
      .map(([, c]) => c),
  ),
];

/**
 * Parse one command line (with or without leading colons, which Vim also accepts).
 * @param {string} line
 * @param {{ hidden?: readonly string[] }} [options]  action ids whose commands and names do
 *   not exist now (an unfinished feature's, while its pref is off)
 * @returns {CommandResult}
 */
export function parseCommandLine(line, { hidden = [] } = {}) {
  const m = /^[\s:]*([^\s:]\S*)([\s\S]*)$/.exec(line);
  if (!m) return Object.freeze({ kind: "empty" });
  const word = /** @type {string} */ (m[1]).toLowerCase();
  const raw = /** @type {string} */ (m[2]).trim();
  const text = unwrap(raw);

  let command = isHidden(word, hidden) ? undefined : byWord.get(word);
  if (!command) {
    const found = resolveActionName(word);
    const def = found && !hidden.includes(found.id) ? found : undefined;
    if (def) {
      if (raw) return unexpected(word);
      /** @type {Action} */
      const action = { id: def.id };
      if (def.arg !== undefined) action.arg = def.arg;
      return runResult(word, action);
    }
    let candidates = commandsWithPrefix(word, hidden);
    if (candidates.length > 1) {
      // `:wor` is `:workspace`, not also `:workspaces`: a command whose name begins a word of
      // every other match wins, as Vim's shortest abbreviation does.
      const outer = candidates.filter(
        (c) =>
          c.name.startsWith(word) &&
          candidates.every((o) => [o.name, ...o.aliases].some((w) => w.startsWith(c.name))),
      );
      if (outer.length === 1) candidates = outer;
    }
    if (candidates.length > 1) {
      const names = candidates.map((c) => c.name);
      return fail("ambiguous-command", `ambiguous command "${word}": ${names.join(", ")}`, names);
    }
    command = candidates[0];
  }
  if (!command) {
    const words = hidden.length ? ALL_WORDS.filter((w) => !isHidden(w, hidden)) : ALL_WORDS;
    const prefixed = words.filter((w) => w.startsWith(word)).slice(0, 3);
    const near = word.length <= MAX_SUGGEST ? closest(word, words) : undefined;
    const suggestions = prefixed.length ? prefixed : near ? [near] : [];
    return fail("unknown-command", `not a command: "${word}"`, suggestions);
  }

  if (command.argument === "none" && raw) {
    return unexpected(
      command.name,
      command.name === "map" ? "; bindings are set in config.toml" : "",
    );
  }
  if (command.argument === "required" && !text) {
    return fail("missing-argument", `:${command.name} needs an argument`);
  }
  const id = text && command.textAction ? command.textAction : command.action;
  return runResult(command.name, { id }, command.text ?? text);
}

/**
 * @param {string} name
 * @param {string} [hint]
 */
const unexpected = (name, hint = "") =>
  fail("unexpected-argument", `:${name} takes no argument${hint}`);

/**
 * Subsequence match: the span of `text` the letters of `word` cover, or -1.
 * @param {string} word
 * @param {string} text
 * @returns {{ span: number, start: number } | null}
 */
function fuzzy(word, text) {
  let start = -1;
  let i = 0;
  for (const ch of word) {
    const at = text.indexOf(ch, i);
    if (at < 0) return null;
    if (start < 0) start = at;
    i = at + 1;
  }
  return { span: i - start, start };
}

/** @type {Candidate[]} */
const CANDIDATES = [
  ...COMMANDS.flatMap((c) => [
    { value: c.name, kind: /** @type {const} */ ("command"), description: c.description },
    ...c.aliases.map((a) => ({
      value: a,
      kind: /** @type {const} */ ("command"),
      description: `${c.description} (short for :${c.name})`,
    })),
  ]),
  ...ACTION_NAMES.map((name) => ({
    value: name,
    kind: /** @type {const} */ ("action"),
    description: /** @type {import("./actions.mjs").ActionDef} */ (
      ACTIONS.find((a) => a.name === name)
    ).description,
  })),
].map((c) => Object.freeze(c));

/**
 * Commands that complete their argument: the list of names the host passes (its key in
 * `args`), or a fixed list core knows (`fixed`), and what a candidate says it is.
 * @type {Readonly<Record<string, { names: string, kind: string, fixed?: readonly string[] }>>}
 */
const ARGUMENT_KINDS = Object.freeze({
  addon: { names: "addon", kind: "add-on" },
  firefox: { names: "firefox", kind: "Firefox command" },
  // docs/specs/search-engines.md, decision 11: `@alias`, while it is the only word.
  open: { names: "search", kind: "search engine" },
  tabnew: { names: "search", kind: "search engine" },
  layout: { names: "layout", kind: "layout", fixed: LAYOUTS },
  private: { names: "private", kind: "private workspace", fixed: ["close"] },
  // The two a first-time user reaches for, then back to following the system.
  theme: { names: "theme", kind: "appearance", fixed: ["dark", "light", "system"] },
  toolbar: { names: "toolbar", kind: "toolbar", fixed: TOOLBAR_WORDS },
  bookmarkstoolbar: {
    names: "bookmarkstoolbar",
    kind: "bookmarks toolbar",
    fixed: Object.keys(BOOKMARKS_TOOLBAR_WORDS),
  },
  workspace: { names: "workspace", kind: "workspace" },
  wsdelete: { names: "workspace", kind: "workspace" },
  wsmove: { names: "workspace", kind: "workspace" },
});

/**
 * Candidates for a command's argument (`:addon bit` → `addon Bitwarden`): `names` matched
 * fuzzily (the pickers' scoring), best first; a blank argument lists them all in order.
 * @param {string} command  the command word as typed (`ws`, `workspace`)
 * @param {string} kind     what a candidate is, for its description
 * @param {string} text  the argument typed so far
 * @param {readonly string[]} names
 * @returns {Candidate[]}
 */
function argumentCandidates(command, kind, text, names) {
  const t = text.trim();
  const ranked = t
    ? names
        .flatMap((name, i) => {
          const m = scoreField(name, t);
          return m ? [{ name, i, score: m.score }] : [];
        })
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .map((r) => r.name)
    : [...names];
  return ranked.map((name) =>
    Object.freeze({
      value: `${command} ${name}`,
      kind: /** @type {const} */ ("argument"),
      description: kind,
      label: name,
    }),
  );
}

/**
 * `:open @g` → `open @gh ` (search-engines decision 11): the aliases starting with the one word
 * typed, each with its engine, the words to follow after the space.
 * @param {string} command
 * @param {string} text
 * @param {readonly AliasCompletion[]} aliases  from searchCompletions
 * @returns {Candidate[]}
 */
function aliasCandidates(command, text, aliases) {
  if (!/^@\S*$/.test(text)) return [];
  const typed = text.toLowerCase();
  return aliases
    .filter((a) => a.name.startsWith(typed))
    .map((a) =>
      Object.freeze({
        value: `${command} ${a.name} `,
        kind: /** @type {const} */ ("argument"),
        description: a.description,
        label: a.name,
      }),
    );
}

/**
 * Completion candidates for the command word, or for the argument of a command that completes
 * one, from the names the host passes in `args` (`{ addon: [...], workspace: [...] }`, and
 * `search`: the `@aliases` with their engines).
 * @param {string} line
 * @param {{ limit?: number, args?: CompletionArgs, hidden?: readonly string[] }} [options]
 *   `hidden`: action ids whose commands are left out (parseCommandLine)
 * @returns {{ word: string, candidates: Candidate[] }}
 */
export function completeCommandLine(line, { limit = 20, args = {}, hidden = [] } = {}) {
  const rest = line.replace(/^[\s:]*/, "");
  const m = /^(\S*)(\s?)/.exec(rest);
  const word = (m?.[1] ?? "").toLowerCase();
  if (m?.[2]) {
    const command = byWord.get(word)?.name;
    const spec = command && Object.hasOwn(ARGUMENT_KINDS, command) ? ARGUMENT_KINDS[command] : null;
    const names =
      spec && Object.hasOwn(args, spec.names)
        ? /** @type {readonly string[]} */ (args[spec.names])
        : (spec?.fixed ?? undefined);
    if (!spec || !names) return { word, candidates: [] };
    const text = rest.slice(/** @type {string} */ (m[1]).length + 1);
    if (spec.names === "search") {
      return {
        word,
        candidates: aliasCandidates(
          word,
          text,
          /** @type {readonly AliasCompletion[]} */ (args.search ?? []),
        ).slice(0, limit),
      };
    }
    return {
      word,
      candidates: argumentCandidates(word, spec.kind, text, names).slice(0, limit),
    };
  }
  /** @type {Candidate[]} */
  const exact = [];
  /** @type {Candidate[]} */
  const prefix = [];
  /** @type {Array<{ c: Candidate, span: number, start: number, i: number }>} */
  const loose = [];
  CANDIDATES.forEach((c, i) => {
    if (isHidden(c.value, hidden)) return;
    if (c.value === word) exact.push(c);
    else if (c.value.startsWith(word)) prefix.push(c);
    else {
      const f = fuzzy(word, c.value);
      if (f) loose.push({ c, ...f, i });
    }
  });
  loose.sort((a, b) => a.span - b.span || a.start - b.start || a.i - b.i);
  return { word, candidates: [...exact, ...prefix, ...loose.map((l) => l.c)].slice(0, limit) };
}

/**
 * @param {{ limit?: number }} [options]
 * @returns {History}
 */
export function createHistory({ limit = 100 } = {}) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`history limit must be a positive integer, got ${limit}`);
  }
  return Object.freeze({ entries: Object.freeze([]), limit, index: null, draft: "" });
}

/**
 * Store an executed line: trimmed, once (the newest copy), at most `limit` lines.
 * @param {History} h
 * @param {string} line
 * @returns {History}
 */
export function pushHistory(h, line) {
  const l = line.trim();
  const entries = l ? [...h.entries.filter((e) => e !== l), l].slice(-h.limit) : h.entries;
  return Object.freeze({ ...h, entries: Object.freeze(entries), index: null, draft: "" });
}

/**
 * Up: the next older entry starting with the draft (the line as it was before the first Up).
 * @param {History} h
 * @param {string} current
 * @returns {{ history: History, text: string }}
 */
export function historyPrevious(h, current) {
  const draft = h.index === null ? current : h.draft;
  const from = h.index === null ? h.entries.length - 1 : h.index - 1;
  for (let i = from; i >= 0; i--) {
    const e = /** @type {string} */ (h.entries[i]);
    if (e.startsWith(draft)) return { history: Object.freeze({ ...h, index: i, draft }), text: e };
  }
  return { history: h, text: current };
}

/**
 * Down: the next newer matching entry, or past the newest the draft.
 * @param {History} h
 * @param {string} current
 * @returns {{ history: History, text: string }}
 */
export function historyNext(h, current) {
  if (h.index === null) return { history: h, text: current };
  for (let i = h.index + 1; i < h.entries.length; i++) {
    const e = /** @type {string} */ (h.entries[i]);
    if (e.startsWith(h.draft)) return { history: Object.freeze({ ...h, index: i }), text: e };
  }
  return { history: resetHistoryCursor(h), text: h.draft };
}

/**
 * After Enter or Esc: stop browsing.
 * @param {History} h
 * @returns {History}
 */
export function resetHistoryCursor(h) {
  return Object.freeze({ ...h, index: null, draft: "" });
}
