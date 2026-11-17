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
      if (wantsLabel) {
        // D12: the label is the hint characters right after `f`, up to a space or another key;
        // labels being prefix-free, `fsdG` is a follow of sd, then G.
        const step = /** @type {AgentStep} */ (wantsLabel);
        wantsLabel = null;
        let label = "";
        while (i < end && LABEL_CHARS.has(/** @type {string} */ (text[i]))) label += text[i++];
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

/**
 * `s` as shown in the list: NFKC first, so a compatibility character (a fullwidth quote) is
 * what it looks like before the text is quoted and cannot end its JSON string; then without
 * the invisible characters.
 * @param {string} s
 */
export const shown = (s) => [...s.normalize("NFKC")].filter((c) => !within(c, UNSHOWN)).join("");

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
 * `text` without the user name and password of its URL, and of the URLs nested in it: the
 * authority after the scheme's slashes, up to its last `@`. Each scheme's authority ends where a
 * WHATWG URL parser ends it (a slash, a question mark or a number sign, and for a special scheme a
 * backslash too); a case where they could differ drops more, never less. `cut` says the text was
 * cut, so an authority that runs to its end may hide a user name and password: it is dropped
 * whole, and only the scheme and its slashes kept.
 * @param {string} text @param {boolean} cut @param {number} depth
 * @returns {string}
 */
function withoutUserinfo(text, cut, depth) {
  // As a URL parser does: leading C0 controls and spaces go, and so do tabs and line breaks.
  const t = text.replace(/[\t\n\r]/g, "");
  let start = 0;
  while (start < t.length && t.charCodeAt(start) <= 0x20) start++;
  const s = t.slice(start);
  const m = URL_SCHEME.exec(s);
  if (!m) return s;
  const name = /** @type {string} */ (m[1]).toLowerCase();
  const rest = s.slice(m[0].length);
  if (NESTED_SCHEMES.has(name)) {
    // Past NESTED_MAX the rest is not read, so it is dropped: it may hold a user name.
    return depth < NESTED_MAX ? m[0] + withoutUserinfo(rest, cut, depth + 1) : `${m[0]}\u2026`;
  }
  const special = SPECIAL_SCHEMES.has(name);
  const lead = special ? (/^[/\\]*/.exec(rest)?.[0] ?? "") : rest.startsWith("//") ? "//" : null;
  if (lead === null) return s;
  const after = rest.slice(lead.length);
  let end = after.search(special ? /[/\\?#]/ : /[/?#]/);
  if (end < 0) {
    if (cut) return `${m[0]}${lead}\u2026`;
    end = after.length;
  }
  return m[0] + lead + after.slice(after.lastIndexOf("@", end) + 1);
}

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
  const first = withoutUserinfo(read, cut, 0);
  const text = shown(first).replace(/\s/g, "");
  return cutTo(withoutUserinfo(text, cut, 0), max);
}

/** What Firefox drops from a URL it makes a tab's label of (#setTabLabel): its scheme and www. */
const LABEL_SCHEME = /^[^:]+:\/\/(?:www\.)?/;

/**
 * A page's own title as the agent may see it (security.md M21, #1209), in depth: one that is a
 * URL (no white space, a scheme and an authority holding a user name or password once shown)
 * loses them as agentUrl drops them. Any other title is the page's text, returned as it is.
 * @param {unknown} label
 */
export function agentTitle(label) {
  const s = String(label ?? "");
  const t = s.trim();
  if (!t || /\s/.test(t)) return s;
  const plain = shown(t);
  if (!plain.includes("@") || !URL_SCHEME.test(plain)) return s;
  return withoutUserinfo(plain, false, 0) === plain ? s : agentUrl(t, AGENT_PAGE_URL_MAX);
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
 * with white space between the two is not a target, and keeps its white space.
 */
const MARKDOWN_TARGET = /\]\(([^()\s]*)\)/g;

/**
 * A page's text as the agent may read it (security.md M7, #1209): each markdown link's and
 * image's target without its user name and password, as agentUrl drops them. Firefox's
 * extractor writes a link as `[text](href)` with the href resolved against the page's URL, so a
 * page whose URL holds a user name and password would give them to every relative link.
 * @param {string} text
 */
export function markdownWithoutUserinfo(text) {
  return text.replace(MARKDOWN_TARGET, (_, url) => `](${withoutUserinfo(url, false, 0)})`);
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
