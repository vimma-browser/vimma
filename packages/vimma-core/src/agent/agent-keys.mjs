/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `vimma_keys`'s keys (docs/specs/mcp-drive.md, D9-D12, D15; security.md M16, M20, M21): the text
 * an agent sends, parsed by a dispatcher of its own over Vimma's default keymap, never the user's,
 * and kept only when every action id is on a fixed whitelist. Nothing here reaches a page: the
 * browser runs each step as a Vimma action on the agent tab (ctl/AgentDrive.sys.mjs). Also the
 * link list `f` returns: its labels and its lines.
 */

import { ACTIONS } from "../keys/actions.mjs";
import { DEFAULT_CONFIG } from "../config/defaults.mjs";
import { createDispatcher } from "../keys/dispatcher.mjs";
import { DEFAULT_HINT_CHARS, hintLabels, orderTargets } from "../page/hints.mjs";
import { compileKeymap } from "../keys/keymap.mjs";
import { formatKey, parseBinding, parseKey } from "../keys/keys.mjs";
import { readerOriginalUrl } from "../page/pageurl.mjs";

/** @import { Chord, BindingElement } from "../keys/keys.mjs" */
/** @import { Action } from "../keys/dispatcher.mjs" */

/** The actions `vimma_keys` may run (D9), by id. */
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
    "hint.follow",
  ]),
);

/** D15: the keys' length, actions per call, a count, a find query. */
export const AGENT_KEY_LIMITS = Object.freeze({ chars: 512, actions: 32, count: 99, query: 256 });

/**
 * The longest page URL a reply carries, in code points: a tab's in `vimma_tabs`, and the page's
 * after a read, a list, a step, a screenshot or a console read. agentUrl cuts it (security.md M7).
 */
export const AGENT_PAGE_URL_MAX = 8192;

/**
 * D12: at most `max` links a list, each link's text cut at `text` and its href at `href`
 * characters; `f`'s labels live `ttlMs` (an element list's do not: `labelsCurrent`). `label` is the longest label `max` links get over
 * DEFAULT_HINT_CHARS, so a longer one can name no link.
 */
export const AGENT_LINKS = Object.freeze({
  max: 200,
  text: 80,
  href: 2048,
  ttlMs: 120_000,
  label: Math.max(...hintLabels(200, DEFAULT_HINT_CHARS).map((l) => l.length)),
});

/**
 * Whether a connection's labels still name what they listed (D12; mcp-forms F3; security.md
 * M18, M25): only on the document and URL they were collected on. `f`'s link list also lasts at
 * most `linkTtlMs`, because the child keeps none of its links and nothing else would end a label
 * of a link the page has since replaced. An element list has no time limit: the child holds each
 * of its elements, so a label of an element that left the page is refused as gone (F4), and a
 * model that takes minutes a step must still be able to click what it was shown (issue #591).
 * @param {{ mark: { doc: number, url: string }, at: number, source: "links" | "elements" }
 *   | null | undefined} session
 * @param {{ now: number, mark: { doc: number, url: string } }} page  the time and the page now
 * @param {number} [linkTtlMs]
 */
export function labelsCurrent(session, { now, mark }, linkTtlMs = AGENT_LINKS.ttlMs) {
  if (!session || session.mark.doc !== mark.doc || session.mark.url !== mark.url) return false;
  return session.source === "elements" || now - session.at < linkTtlMs;
}

/** The characters of a label (D12): the default ones, never the user's `hint_chars` (D10). */
const LABEL_CHARS = new Set(DEFAULT_HINT_CHARS);

/**
 * One action to run: the keys that made it as the question shows them, its id, its count, for
 * `/` and `?` the query, and for `f<label>` the label (`f` without one lists the links).
 * @typedef {{ keys: string, action: string, count?: number, query?: string, label?: string }} AgentStep
 * @typedef {{ ok: true, steps: AgentStep[] } | { ok: false, error: string }} AgentKeys
 */

/**
 * Vimma's defaults alone (D10): a user's `[keys]` or `[modal.normal]` could bind `j` to
 * `tab.close`, and the tool must mean the same in every install. Built once.
 * @type {import("../keys/keymap.mjs").Keymap | null}
 */
let keymap = null;

/** Why each refused action is refused, by id or by id prefix, first match wins. */
const REASONS = /** @type {const} */ ([
  [["command.open", "cmdline.run"], "the command line is the user's"],
  [
    ["mode.insert", "urlbar.focus", "page.focus_input", "page.open"],
    "vimma_keys never types into a page or a field",
  ],
  [["mode.visual", "caret.", "selection."], "copy mode and the selection are the user's"],
  [
    ["page.yank_url", "page.open_clipboard", "page.open_clipboard_new_tab", "hint.copy_target"],
    "the clipboard is the user's",
  ],
  [
    ["hint.follow_new_tab", "hint.follow_new_tab_fg", "page.view_source"],
    "it opens a tab; vimma_open does that, asked",
  ],
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

/** Each action id's group: getAction looks actions up by config name, not by id. */
const GROUP_BY_ID = new Map(ACTIONS.map((a) => [a.id, a.group]));

/**
 * Why `vimma_keys` refuses the action `id`.
 * @param {string} id
 */
export function refusalReason(id) {
  for (const [names, why] of REASONS) {
    if (names.some((n) => (n.endsWith(".") ? id.startsWith(n) : id === n))) return why;
  }
  const group = GROUP_BY_ID.get(id);
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
/**
 * Control, bidirectional and invisible characters, by code point range: the question must show
 * what runs. C0 but the tab, C1, and every range of agent-act's FILL_INVISIBLE (which imports
 * this module, so the ranges are written out; a test compares every code point), as vimma-ctl's
 * mcp/args.rs `keys_control`.
 */
export const CONTROL = Object.freeze(
  /** @type {const} */ ([
    [0x00, 0x08],
    [0x0a, 0x1f],
    [0x7f, 0x9f],
    [0xad, 0xad],
    [0x34f, 0x34f],
    [0x600, 0x605],
    [0x61c, 0x61c],
    [0x6dd, 0x6dd],
    [0x70f, 0x70f],
    [0x890, 0x891],
    [0x8e2, 0x8e2],
    [0x115f, 0x1160],
    [0x17b4, 0x17b5],
    [0x180b, 0x180f],
    [0x200b, 0x200f],
    [0x2028, 0x202e],
    [0x2060, 0x206f],
    [0x3164, 0x3164],
    [0xfe00, 0xfe0f],
    [0xfeff, 0xfeff],
    [0xffa0, 0xffa0],
    [0xfff0, 0xfffb],
    [0x110bd, 0x110bd],
    [0x110cd, 0x110cd],
    [0x13430, 0x1343f],
    [0x1bca0, 0x1bca3],
    [0x1d173, 0x1d17a],
    [0xe0000, 0xe0fff],
  ]),
);

/**
 * Whether `c`'s code point is in one of `ranges`.
 * @param {string} c @param {readonly (readonly [number, number])[]} ranges
 */
function within(c, ranges) {
  const cp = /** @type {number} */ (c.codePointAt(0));
  return ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/** Whether `s` holds a character of CONTROL. @param {string} s */
const hasControl = (s) => [...s].some((c) => within(c, CONTROL));
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
  } /* Stryker disable next-line BlockStatement: isOneKey's caller reads undefined as false */ catch {
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
  if (hasControl(text))
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
  /** The `f` that may take a label: the hint characters right after it. */
  /** @type {AgentStep | null} */
  let wantsLabel = null;

  /**
   * One action from the dispatcher: whitelisted, within the limits.
   * @param {Action} action
   * @returns {string | null} why it is refused, or null
   */
  const take = (action) => {
    const keys = typed;
    typed = "";
    if (!AGENT_KEY_ACTIONS.has(action.id))
      return refusal(keys, refusalReason(action.id), action.id);
    if (action.id === "hint.follow" && action.count !== undefined) {
      return refusal(keys, "a count does not apply to f");
    }
    if ((action.count ?? 0) > AGENT_KEY_LIMITS.count) {
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
    if (action.id === "hint.follow") wantsLabel = step;
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
      // The `>` that closes a `<...>` key is in the same word.
      const close = text[i] === "<" ? text.slice(0, end).indexOf(">", i + 1) : -1;
      if (close !== -1) {
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
      if (wantsLabel) {
        // D12: the label is the hint characters right after `f`, up to a space or another key;
        // labels being prefix-free, `fsdG` is a follow of sd, then G.
        const step = /** @type {AgentStep} */ (wantsLabel);
        wantsLabel = null;
        let label = "";
        // The word ends at white space or at the text's end, neither of them a label character.
        while (LABEL_CHARS.has(/** @type {string} */ (text[i]))) label += text[i++];
        if (label) {
          if (label.length > AGENT_LINKS.label) {
            const why = `a label is at most ${AGENT_LINKS.label} characters`;
            return refused(refusal(`${step.keys}${label}`, why));
          }
          step.label = label;
          step.keys = `${step.keys}${label}`;
        }
      }
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
        if (hasControl(query) || query.includes("\t")) {
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
  const list = steps.findIndex((s) => s.action === "hint.follow" && s.label === undefined);
  if (list !== -1 && list !== steps.length - 1) {
    const why = "f without a label lists the links and must be the last key";
    return refused(refusal(/** @type {AgentStep} */ (steps[list]).keys, why));
  }
  return { ok: true, steps };
}

/**
 * The keys as they will run (D14): each step's keys, a space between steps.
 * @param {AgentStep[]} steps
 */
export function shownKeys(steps) {
  return steps.map((s) => s.keys).join(" ");
}

/**
 * A link as the browser collected it: where it is, and its href and text as the page gave them.
 * @typedef {{ rect: { x: number, y: number, width: number, height: number }, href?: string,
 *   text?: string }} AgentLinkTarget
 */

/**
 * The links of `f` with their labels (D12): in reading order (orderTargets), at most
 * AGENT_LINKS.max, labelled over DEFAULT_HINT_CHARS; the rest dropped and counted.
 * @template {AgentLinkTarget} T
 * @param {readonly T[]} targets
 * @returns {{ links: { label: string, target: T }[], dropped: number }}
 */
export function labelAgentLinks(targets) {
  const kept = orderTargets(targets).slice(0, AGENT_LINKS.max);
  const labels = hintLabels(kept.length, DEFAULT_HINT_CHARS);
  return {
    links: kept.map((target, i) => ({ label: /** @type {string} */ (labels[i]), target })),
    dropped: Math.max(0, targets.length - kept.length),
  };
}

/**
 * Control, bidirectional and invisible characters, by code point range, dropped from a link's
 * text and href: tag characters, variation selectors and fillers among them, which a model
 * reads and the user cannot see. C0 but the white space, C1, and every range of agent-act's
 * FILL_INVISIBLE but the line and paragraph separators, which are white space too (a test
 * compares every code point).
 */
export const UNSHOWN = Object.freeze(
  /** @type {const} */ ([
    [0x00, 0x08],
    [0x0e, 0x1f],
    [0x7f, 0x9f],
    [0xad, 0xad],
    [0x34f, 0x34f],
    [0x600, 0x605],
    [0x61c, 0x61c],
    [0x6dd, 0x6dd],
    [0x70f, 0x70f],
    [0x890, 0x891],
    [0x8e2, 0x8e2],
    [0x115f, 0x1160],
    [0x17b4, 0x17b5],
    [0x180b, 0x180f],
    [0x200b, 0x200f],
    [0x202a, 0x202e],
    [0x2060, 0x206f],
    [0x3164, 0x3164],
    [0xfe00, 0xfe0f],
    [0xfeff, 0xfeff],
    [0xffa0, 0xffa0],
    [0xfff0, 0xfffb],
    [0x110bd, 0x110bd],
    [0x110cd, 0x110cd],
    [0x13430, 0x1343f],
    [0x1bca0, 0x1bca3],
    [0x1d173, 0x1d17a],
    [0xe0000, 0xe0fff],
  ]),
);

/** UNSHOWN as one pattern, so that a text is cleaned in one pass rather than a call a character. */
const UNSHOWN_PATTERN = new RegExp(
  `[${UNSHOWN.map(([lo, hi]) => `\\u{${lo.toString(16)}}-\\u{${hi.toString(16)}}`).join("")}]`,
  "gu",
);

/**
 * `s` as shown in the list: NFKC first, so a compatibility character (a fullwidth quote) is
 * what it looks like before the text is quoted and cannot end its JSON string; then without
 * the invisible characters.
 * @param {string} s
 */
export const shown = (s) => s.normalize("NFKC").replace(UNSHOWN_PATTERN, "");

/** @param {string} s @param {number} max  at most `max` code points, `…` the last when cut */
export function cutTo(s, max) {
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : s;
}

/** A URL's scheme and its colon. */
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):/i;
/** Schemes whose authority may come after any slashes or backslashes, or none (WHATWG). */
const SPECIAL_SCHEMES = new Set(["http", "https", "ws", "wss", "ftp", "file"]);
/** Schemes whose rest is a URL of its own, whose user name and password go too. */
const NESTED_SCHEMES = new Set(["view-source", "jar", "blob"]);
/** At most this many URLs inside one another are read (view-source:jar:https:...). */
const NESTED_MAX = 4;

/**
 * `text` as a URL parser reads it: without tabs and line breaks anywhere, and without the C0
 * controls and spaces it starts with.
 * @param {string} text
 */
// eslint-disable-next-line no-control-regex -- leading C0 controls are what the parser strips
const asParsed = (text) => text.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+/, "");

/**
 * How much more query text one call may read closely for user names and passwords (`left`, in
 * code units of the parameters that the quick check lets through, counted at every level of
 * nesting and in each pass). Decoding and normalising every parameter of every nested query costs
 * far more than reading an authority, so a page that writes many deep queries could otherwise
 * hold the parent process for seconds (#1352 review). An ordinary parameter, which the quick
 * check passes over, costs nothing, so a page of plain links keeps all its queries. A parameter
 * or query reached once it is spent is dropped: more is dropped that way, never less.
 * @typedef {{ left: number }} QueryWork
 */

/**
 * `text` without the user name and password of its URL, and of the URLs nested in it: the
 * authority after the scheme's slashes, up to its last `@`. Each scheme's authority ends where a
 * WHATWG URL parser ends it (a slash, a question mark or a number sign, and for a special scheme a
 * backslash too); a case where they could differ drops more, never less. `cut` says the text was
 * cut, so an authority that runs to its end may hide a user name and password: it is dropped
 * whole, and only the scheme and its slashes kept. The URLs percent-encoded in its query and
 * hash go too (queryWithoutUserinfo), and with `path`, those written in its path
 * (pathWithoutUserinfo).
 * @param {string} text @param {boolean} cut @param {number} depth @param {QueryWork} work
 * @param {boolean} [path]
 * @returns {string}
 */
function withoutUserinfo(text, cut, depth, work, path = true) {
  const s = asParsed(text);
  const m = URL_SCHEME.exec(s);
  if (!m) return s;
  const name = /** @type {string} */ (m[1]).toLowerCase();
  const rest = s.slice(m[0].length);
  if (NESTED_SCHEMES.has(name)) {
    // Past NESTED_MAX the rest is not read, so it is dropped: it may hold a user name.
    return depth < NESTED_MAX
      ? m[0] + withoutUserinfo(rest, cut, depth + 1, work, path)
      : `${m[0]}…`;
  }
  const special = SPECIAL_SCHEMES.has(name);
  const lead = special
    ? rest.slice(0, rest.search(/[^/\\]|$/))
    : rest.startsWith("//")
      ? "//"
      : null;
  // No authority (about:, data:, and file: without slashes, whose rest a URL parser reads as a
  // path, so a MediaWiki `File:Logo@2x.png` keeps its name): only its path and query may hold one.
  if (lead === null || (name === "file" && !lead))
    return (path ? pathWithoutUserinfo : queryWithoutUserinfo)(s, m[0].length, cut, depth, work);
  const after = rest.slice(lead.length);
  let end = after.search(special ? /[/\\?#]/ : /[/?#]/);
  if (end < 0) {
    if (cut) return `${m[0]}${lead}…`;
    end = after.length;
  }
  const from = after.lastIndexOf("@", end) + 1;
  const out = m[0] + lead + after.slice(from);
  const at = m[0].length + lead.length + end - from;
  return (path ? pathWithoutUserinfo : queryWithoutUserinfo)(out, at, cut, depth, work);
}

/**
 * A URL `s` without the user names and passwords of the URLs written unencoded in its path, which
 * starts at `at`, where its authority ends, and of those in its query and hash
 * (queryWithoutUserinfo). An archive or a redirect service writes a whole URL there
 * (`/web/2020/https://user:password@host/`, #1372). Each URL in the path is read as a URL
 * nested one level deeper, from its scheme to the end of the path, but not its own path: the next
 * is looked for after its scheme, as anywhereWithoutUserinfo does, so an authority that a URL
 * parser would end later (`foo://a\https://user@host`) hides none. Past NESTED_MAX of them, or
 * NESTED_MAX levels, the rest is not read, so it is dropped, query and hash too.
 * @param {string} s @param {number} at @param {boolean} cut @param {number} depth
 * @param {QueryWork} work
 * @returns {string}
 */
function pathWithoutUserinfo(s, at, cut, depth, work) {
  const rest = s.slice(at).search(/[?#]/);
  let end = rest < 0 ? s.length : at + rest;
  const last = cut && end === s.length;
  let out = s;
  for (let n = 0, from = at; ; n++) {
    EMBEDDED_URL.lastIndex = from;
    const found = EMBEDDED_URL.exec(out.slice(0, end));
    if (!found) return queryWithoutUserinfo(out, end, cut, depth, work);
    const nested = found.index;
    if (n >= NESTED_MAX || depth >= NESTED_MAX) return `${out.slice(0, nested)}\u2026`;
    const inner = withoutUserinfo(out.slice(nested, end), last, depth + 1, work, false);
    out = out.slice(0, nested) + inner + out.slice(end);
    end = nested + inner.length;
    from = nested + 1;
  }
}

/**
 * Where a URL may start inside a parameter's value, after its first character: a scheme not
 * preceded by a scheme character, followed by a slash or a backslash, or a special scheme's
 * colon alone, which a URL parser also reads (`https:ada@host`). Not `file:` alone: a URL parser
 * reads what follows as a path, never a user name, so a MediaWiki `File:Logo@2x.png` is kept.
 * A URL right after a scheme character (`/2020-https://…`) is not read, so that no scheme run is
 * searched from each of its characters.
 */
const EMBEDDED_URL = /(?<![a-z0-9+.-])(?:[a-z][a-z0-9+.-]*:(?=[/\\])|(?:https?|wss?|ftp):)/gi;

/**
 * `text` without the user names and passwords of the URL it starts with and of the URLs later in
 * it, as a parameter's value may hold them (`/go/https://user:password@host/`,
 * `1?next=https://…`; #1352 review). Each is read from where it starts to the end, first to last,
 * so a later one's stripping can never shorten an earlier one's authority; past NESTED_MAX of
 * them the rest is dropped.
 * @param {string} text @param {boolean} cut @param {number} depth @param {QueryWork} work
 */
function anywhereWithoutUserinfo(text, cut, depth, work) {
  let out = withoutUserinfo(text, cut, depth, work);
  for (let n = 0, from = 1; ; n++) {
    EMBEDDED_URL.lastIndex = from;
    const found = EMBEDDED_URL.exec(out);
    if (!found) return out;
    const at = found.index;
    if (n >= NESTED_MAX) return `${out.slice(0, at)}…`;
    out = out.slice(0, at) + withoutUserinfo(out.slice(at), cut, depth, work);
    from = at + 1;
  }
}

/**
 * `text` without the user names and passwords of its URLs, in two passes: first as given, where
 * an authority ends where a URL parser ends it (NFKC would make a fullwidth slash one that the
 * parser does not see, and end the authority before its `@`), then as `show` shows it, where a
 * fullwidth `@` is one: only more is dropped that way, never less.
 * @param {string} text @param {boolean} cut @param {number} depth @param {QueryWork} work
 * @param {(s: string) => string} show
 * @param {typeof withoutUserinfo} [strip]
 */
function bothPasses(text, cut, depth, work, show, strip = withoutUserinfo) {
  return strip(show(strip(text, cut, depth, work)), cut, depth, work);
}

/**
 * A URL `s` without the user names and passwords of the URLs percent-encoded in its query, which
 * starts at the first `?` from `at`, where its authority ends, and in its hash (#1324, #1348). A
 * parameter's name or value may be a whole URL, where no `@` ends an authority: Reader View's
 * `about:reader?url=`, the error pages' `u=`, an extension page that wraps the page it blocked,
 * a site's redirect parameter (`?next=`, `?continue=`, a single-page app's `#/login?next=`).
 * Each is decoded as URLSearchParams decodes it (Reader View reads its own that way: ReaderMode
 * getOriginalUrl) and stripped as a URL nested one level deeper, in agentUrl's two passes
 * (bothPasses), also where a URL starts later in it; a value encoded twice, a redirect inside a
 * redirect, is decoded once more. Only a parameter that lost something is written again, so the
 * page's address and the rest of its query stay as the page wrote them, and the agent still
 * knows which page it is on. Past NESTED_MAX, or once `work` is spent, the query and the hash
 * are not read, so they are dropped.
 * @param {string} s @param {number} at @param {boolean} cut @param {number} depth
 * @param {QueryWork} work
 * @returns {string}
 */
function queryWithoutUserinfo(s, at, cut, depth, work) {
  const h = s.indexOf("#", at);
  const main = h === -1 ? s : s.slice(0, h);
  const q = main.indexOf("?", at);
  // Up to and with the `?`.
  const head = q === -1 ? main : main.slice(0, q + 1);
  if (depth >= NESTED_MAX || work.left < 0) {
    return `${head}${q === -1 ? "" : "…"}${h === -1 ? "" : "#…"}`;
  }
  const search =
    q === -1 ? "" : paramsWithoutUserinfo(main.slice(q + 1), cut && h === -1, depth, work);
  const hash = h === -1 ? "" : `#${paramsWithoutUserinfo(s.slice(h + 1), cut, depth, work)}`;
  return head + search + hash;
}

/**
 * A query's or a hash's parameters, `text`, each without the user names and passwords of the
 * URLs it encodes; `text` itself when none held any. A hash is read whole as parameters too, so
 * `#/login?next=` is the name `/login?next` and a URL. Parameters are split at `&` and `;` first,
 * as some servers split them, and the result again at `&` alone, as URLSearchParams and the pages
 * that read their own query split them, so a value they read whole is read whole (a `;` may be in
 * a password). `cut` is passed on to the last.
 * @param {string} text @param {boolean} cut @param {number} depth @param {QueryWork} work
 * @returns {string}
 */
function paramsWithoutUserinfo(text, cut, depth, work) {
  const once = splitWithoutUserinfo(text, /([&;])/, cut, depth, work);
  return splitWithoutUserinfo(once, /(&)/, cut, depth, work);
}

/**
 * `text` split at `separator` (a capturing pattern), each name and value without the user names
 * and passwords of the URLs it encodes; `text` itself when none held any.
 * @param {string} text @param {RegExp} separator @param {boolean} cut @param {number} depth
 * @param {QueryWork} work
 * @returns {string}
 */
function splitWithoutUserinfo(text, separator, cut, depth, work) {
  const pieces = text.split(separator);
  // Joined again, pieces that lost nothing give `text` itself, separators and `=` included.
  return pieces
    .map((piece, i) => {
      // Stryker disable next-line ConditionalExpression: a separator (`&` or `;`) holds no URL, so reading it as a parameter gives it back as it is
      if (i % 2) return piece;
      const eq = piece.indexOf("=");
      const parts = eq < 0 ? [piece] : [piece.slice(0, eq), piece.slice(eq + 1)];
      const last = cut && i === pieces.length - 1;
      return parts
        .map((raw, j) => paramWithoutUserinfo(raw, last && j === parts.length - 1, depth + 1, work))
        .join("=");
    })
    .join("");
}

/**
 * One name or value of a query, `raw` as written there, without the user names and passwords of
 * the URLs it encodes: `raw` itself when that holds none, else the stripped text encoded again.
 * One still encoded past NESTED_MAX is not read, so it is dropped.
 * @param {string} raw @param {boolean} cut @param {number} depth @param {QueryWork} work
 * @returns {string}
 */
function paramWithoutUserinfo(raw, cut, depth, work) {
  const value = paramValue(raw);
  // Plain ASCII without a percent sign is a URL with a user name only with a colon and an at
  // sign, unless cut before its at sign: most parameters are, and are passed over quickly.
  if (!cut && !/[^\x20-\x7e]|%|:[^]*@/.test(value)) return raw;
  // Only a parameter read closely counts towards the work, so a page of ordinary queries keeps
  // them all; one read once the work is spent is dropped, as it may hold a user name.
  work.left -= raw.length;
  if (work.left < 0) return "\u2026";
  // Printable ASCII is as shown already, so a second pass would find nothing more.
  const ascii = !/[^\x20-\x7e]/.test(value);
  const stripped = ascii
    ? anywhereWithoutUserinfo(value, cut, depth, work)
    : bothPasses(value, cut, depth, work, shown, anywhereWithoutUserinfo);
  if (stripped !== (ascii ? value : asParsed(shown(asParsed(value))))) {
    return encodedParam(stripped);
  }
  // A value encoded once more, a redirect inside a redirect, is an encoded parameter itself.
  if (value === raw) return raw;
  if (depth >= NESTED_MAX) return "…";
  const inner = paramWithoutUserinfo(value, cut, depth + 1, work);
  return inner === value ? raw : encodedParam(inner);
}

/**
 * A query's name or value `raw` decoded as URLSearchParams decodes it: `+` a space, and each
 * percent-encoded UTF-8 sequence its character, an invalid one U+FFFD and a `%` that starts none
 * kept.
 * @param {string} raw
 */
function paramValue(raw) {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    // `v` is the parameter just written, so get never returns null.
    return /** @type {string} */ (new URLSearchParams(`v=${raw}`).get("v"));
  }
}

/** @param {string} value  as URLSearchParams writes it in a query */
const encodedParam = (value) => new URLSearchParams([["v", value]]).toString().slice(2);

/**
 * A URL as the agent may see it (security.md M21, M30, M31): a script's, file's or request's, a
 * link's href, a form's action, a tab's page. Without the user name and password it may carry,
 * as shown (NFKC, no invisible characters, no white space), then cut at `max` code points. The user name and password go before the cut, so that no cut
 * can take their `@` and leave them in (#1198). They go first from the text as the page gave it,
 * where the authority ends where a URL parser ends it (NFKC would make a fullwidth slash one that
 * the parser does not see), and again from the shown text, where a fullwidth `@` is one: only
 * more is dropped that way, never less. Only the first `4 * max` code units are read, so the work
 * is bounded however long the URL.
 * @param {unknown} url @param {number} max
 */
export function agentUrl(url, max) {
  const raw = String(url ?? "");
  const read = raw.slice(0, 4 * max);
  const cut = read.length < raw.length;
  const work = { left: queryWork(read) };
  const plain = bothPasses(read, cut, 0, work, (t) => shown(t).replace(/\s/g, ""));
  // A Reader View address is its article's URL, as the status bar shows it (#1323, #1324); one
  // that was cut may have lost the end of that URL, so it stays the stripped reader address.
  return cutTo((!cut && readerOriginalUrl(plain)) || plain, max);
}

/**
 * The query text one stripping of `text` may read (QueryWork): each code unit read about four
 * times over, in two passes and through the nesting, and a little more for a short URL.
 * @param {string} text
 */
const queryWork = (text) => 4 * text.length + 4096;

/** What Firefox drops from a URL it makes a tab's label of (#setTabLabel): its scheme and www. */
const LABEL_SCHEME = /^[^:]+:\/\/(?:www\.)?/;

/**
 * A page's own title as the agent may see it (security.md M21, #1209), in depth: one that is a
 * URL (no white space, a scheme and an authority holding a user name or password once shown,
 * also one percent-encoded in its query) loses them as agentUrl drops them. Any other
 * title is the page's text, returned as it is.
 * @param {unknown} label
 */
export function agentTitle(label) {
  const s = String(label ?? "");
  const t = s.trim();
  if (!t || /\s/.test(t)) return s;
  // A title longer than agentUrl reads is read only that far, so the work stays bounded
  // however long a page makes its title (#1352 review); it is given as agentUrl gives it.
  if (t.length > 4 * AGENT_PAGE_URL_MAX) {
    // Cut between two code points, so no half of an invisible character is left to show.
    const head = shown(t.slice(0, 4 * AGENT_PAGE_URL_MAX).replace(/[\ud800-\udbff]$/, ""));
    // Invisible characters may fill what is read, or cut a scheme short after it (#1372): a
    // head that is empty or may still begin a scheme is given as agentUrl gives it too.
    const scheme = URL_SCHEME.test(head) || /^(?:[a-z][a-z0-9+.-]*)?$/i.test(head);
    return scheme ? agentUrl(t, AGENT_PAGE_URL_MAX) : s;
  }
  const plain = shown(t);
  // An at sign, or a URL percent-encoded in its query (#1324, #1348), as shown and as given: a
  // fullwidth slash before the at sign ends no authority for a URL parser.
  if (!/[@%]/.test(plain) || !URL_SCHEME.test(plain)) return s;
  const work = { left: 2 * queryWork(t) };
  const holds =
    withoutUserinfo(plain, false, 0, work) !== plain || withoutUserinfo(t, false, 0, work) !== t;
  return holds ? agentUrl(t, AGENT_PAGE_URL_MAX) : s;
}

/**
 * A tab's title as the agent may see it (security.md M21, #1209). A label Firefox made of a URL
 * (`contentTitle`, the tab's `labelIsContentTitle`, not true: before a load, restored pending, a
 * page with no title, even after a redirect) may hold a user name and password, or only part of
 * one once Firefox cut it at 256 characters, or those of the URL the tab was opened at: it is
 * never read. The tab's URL `url` is given instead, without them, as Firefox shows a URL in a
 * label (no scheme, no www.). While a new tab's first load has not committed, its URL is
 * about:blank, and `typed`, the URL it is loading (Firefox keeps it as typed until the load ends;
 * Tabbrowser addTab), is given instead. A page's own title goes through agentTitle.
 * @param {unknown} label @param {unknown} contentTitle @param {unknown} url
 * @param {unknown} [typed]
 */
export function agentTabTitle(label, contentTitle, url, typed) {
  if (contentTitle === true) return agentTitle(label);
  const at = url === "about:blank" && typeof typed === "string" && typed ? typed : url;
  return agentUrl(at, AGENT_PAGE_URL_MAX).replace(LABEL_SCHEME, "");
}

/**
 * A markdown link's or image's target: `](`, then up to the next `)`. DOMExtractor writes a
 * resolved href there, which holds no white space and has its parentheses escaped; page text
 * with white space between the two is not a target, and keeps its white space. A link nested in
 * another link's text (a block anchor wrapping inline ones, as on Google's search pages) is
 * escaped once more by DOMExtractor's escapeMarkdownLink, which puts a backslash before each
 * bracket and parenthesis of the text: `\[a\]\(href\)`, with more backslashes for each deeper
 * nesting. So the `(` may follow backslashes, kept as they are; those before the closing `)`
 * are read as part of the target, which withoutUserinfo keeps byte for byte. Each part's
 * characters are disjoint from the next one's, so the match runs in linear time
 * (CodeQL js/polynomial-redos). Only a target is read, never a URL anywhere else in the text:
 * code, email addresses and URLs in a page's prose (`ssh://git@host` in a code span) stay.
 */
/** The query text all of one page's link targets may read together (QueryWork). */
const MARKDOWN_QUERY_WORK = 1 << 18;

const MARKDOWN_TARGET = /\](\\*)\(([^()\s]*)\)/g;

/**
 * A page's text as the agent may read it (security.md M7, #1209): each markdown link's and
 * image's target without its user name and password, as agentUrl drops them. Firefox's
 * extractor writes a link as `[text](href)` with the href resolved against the page's URL, so a
 * page whose URL holds a user name and password would give them to every relative link.
 * @param {string} text
 */
export function markdownWithoutUserinfo(text) {
  // Each target is read as far as a link's href in agentUrl, and all of them share one budget
  // of query work, so a page of many long, deep links costs a bounded time (#1352 review).
  const window = 4 * AGENT_LINKS.href;
  const work = { left: MARKDOWN_QUERY_WORK };
  return text.replace(MARKDOWN_TARGET, (_, open, url) => {
    const read = url.slice(0, window);
    const cut = read.length < url.length;
    const kept = withoutUserinfo(read, cut, 0, work);
    // An authority cut short is dropped as `https://…` already: one ellipsis is enough.
    return `]${open}(${kept}${cut && !kept.endsWith("\u2026") ? "\u2026" : ""})`;
  });
}

/**
 * The link list's text (D16, security.md M21), one link a line: the label, the text as a JSON
 * string cut at AGENT_LINKS.text, the href cut at AGENT_LINKS.href. The browser wraps it in the
 * untrusted-content delimiters (wrapUntrusted): every word of it is the page's.
 * @param {readonly { label: string, target: AgentLinkTarget }[]} links
 */
export function agentLinkLines(links) {
  return links.map(linkLine).join("\n");
}

/** @param {{ label: string, target: AgentLinkTarget }} link */
function linkLine({ label, target }) {
  const text = cutTo(
    shown(String(target.text ?? ""))
      .replace(/\s+/g, " ")
      .trim(),
    AGENT_LINKS.text,
  );
  const href = target.href ? agentUrl(target.href, AGENT_LINKS.href) : "(no URL)";
  return `${label} ${JSON.stringify(text)} ${href}`;
}

/**
 * The list's lines as far as they fit `maxBytes` once JSON-encoded (the reply is one line of
 * at most 1 MiB, protocol decision 4); the links after are left out and counted.
 * @param {readonly { label: string, target: AgentLinkTarget }[]} links @param {number} maxBytes
 * @returns {{ text: string, omitted: number }}
 */
export function agentLinkList(links, maxBytes) {
  const encoder = new TextEncoder();
  const lines = [];
  // The quotes of the JSON string.
  let bytes = 2;
  for (const link of links) {
    const line = linkLine(link);
    const cost = encoder.encode(JSON.stringify(line)).length - 2 + (lines.length ? 2 : 0);
    if (bytes + cost > maxBytes) break;
    bytes += cost;
    lines.push(line);
  }
  return { text: lines.join("\n"), omitted: links.length - lines.length };
}
