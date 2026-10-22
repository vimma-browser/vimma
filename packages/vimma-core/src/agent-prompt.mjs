/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The agent question line, pure (docs/specs/vimma-mcp.md, sub-PR 2b): when it may open by
 * itself (decision 14), what it says (13), what each key does (13, 20), the notices and the
 * desktop notification's text (15, 16, 23), the status bar's agent state (24), full control's
 * question (29 C) and `:control` (29 D), and the checkpoints' questions and notices, for
 * sending a form and paying (docs/specs/mcp-checkpoints.md). The browser's ui/agent-prompt.mjs draws it and
 * host/agent-ui.mjs runs it; every value here is plain text, set as text there (security.md C1).
 */

import { AGENT_GLYPH } from "./agent.mjs";
import { pageText } from "./agent-checkpoint.mjs";
import { DOWNLOAD_TOOL, formatBytes } from "./agent-downloads.mjs";
import { displayUrl, truncate } from "./statusbar.mjs";
import { textWidth } from "./textwidth.mjs";

/** No key for this long before the question may open by itself (decision 14). */
export const QUIET_MS = 1500;
/** The question a new full-control connection asks while MCP is on (decision 29 C). */
export const FULL_CONTROL = "full_control";
/** A full-control client's code: 4 of 2-9 and A-Z without I and O (security.md S13). */
export const FULL_CODE = /^[2-9A-HJ-NP-Z]{4}$/;
/** Titles in the question are cut at this many columns (decision 13). */
export const TITLE_COLUMNS = 60;
/** `◇ agent ·` shows this long after a request ran (decision 24). */
export const RAN_MS = 2000;
/** The longest `:control on <minutes>` (decision 29 D). */
export const CONTROL_MAX_MINUTES = 1440;
/**
 * What a download no agent connection asked for calls itself (decision 31): a page's own, or one
 * the agent that opened its tab is gone from. It cannot be granted, and `x` is a plain no.
 */
export const PAGE_CLIENT = "a page in the agent workspace";
/** Digits a grant's count may have: 1440 is the most a grant can be. */
const MAX_COUNT_DIGITS = 4;

/**
 * @typedef {{ client?: string, version?: string, via?: string } | null | undefined} Label
 * @typedef {{ tool: string, label: Label, what: Record<string, any> }} Asked
 * @typedef {{ text: string, strong?: boolean, warn?: boolean, isolate?: "auto" | "ltr" }} Part
 *   `isolate`: text an agent or a page chose, drawn as its own bidi run (security.md M4): `auto`
 *   for names and titles (<bdi>), `ltr` for URLs; `warn`: a checkpoint's glyph and verb, in the
 *   theme's warning colour (docs/specs/mcp-checkpoints.md C3)
 * @typedef {{ kind: "once" } | { kind: "deny" } | { kind: "mute" }
 *   | { kind: "grant", minutes: number | null }} PromptAnswer
 */

/** Control characters, line breaks and bidi overrides become spaces: one line, read as is. */
// eslint-disable-next-line no-control-regex -- the control characters are what it removes
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]+/g;

/** @param {unknown} s */
const clean = (s) =>
  String(s ?? "")
    .replace(UNSAFE, " ")
    .replace(/ {2,}/g, " ")
    .trim();

/** `[mcp] workspace`'s default. */
const AGENT_WORKSPACE = "agent";
/** The agent workspace's name as a question shows it: one line, never empty. @param {string} s */
const workspaceName = (s) => clean(s) || AGENT_WORKSPACE;

/**
 * What the question calls the agent: its self-reported name, else its parent process, else
 * "an agent". Labels, never proof (decision 4).
 * @param {Label} label
 */
export function clientName(label) {
  return clean(label?.client) || clean(label?.via) || "an agent";
}

/**
 * Whether the question may open by itself now (decision 14); otherwise it waits as
 * `◇ agent 1?` for `ctrl+b shift+a`.
 * @param {{ focused: boolean, inField: boolean, sinceKeyMs: number, otherOpen: boolean,
 *   fullscreen: boolean }} now
 */
export function mayOpenByItself({ focused, inField, sinceKeyMs, otherOpen, fullscreen }) {
  return focused && !inField && sinceKeyMs >= QUIET_MS && !otherOpen && !fullscreen;
}

/** @param {unknown} title */
const cutTitle = (title) => truncate(clean(title), TITLE_COLUMNS, "end");

/**
 * A tab as the question shows it: its place in the agent workspace, title and URL.
 * @param {Record<string, any>} what
 * @returns {Part[]}
 */
function tabParts(what) {
  const place = Number.isInteger(what.index) ? `${what.index} ` : "";
  return [
    { text: `${place}"` },
    { text: cutTitle(what.title), isolate: "auto" },
    { text: '" ' },
    { text: displayUrl(clean(what.url)), isolate: "ltr" },
  ];
}
/**
 * The URL with its host in bold (decision 13: opens show the full URL).
 * @param {string} url @param {string} host
 * @returns {Part[]}
 */
function urlParts(url, host) {
  const at = host ? url.indexOf(host) : -1;
  /** @type {Part[]} */
  const parts =
    at === -1
      ? [{ text: url }]
      : [
          { text: url.slice(0, at) },
          { text: host, strong: true },
          { text: url.slice(at + host.length) },
        ];
  return parts.filter((p) => p.text).map((p) => ({ ...p, isolate: "ltr" }));
}

/**
 * A download as the question shows it (decision 31 a): its name, size, type and extension, and
 * the host it comes from in bold; never the URL.
 * @param {Record<string, any>} w
 * @returns {Part[]}
 */
function downloadParts(w) {
  const type = clean(w.type) || "unknown type";
  const ext = clean(w.ext);
  return [
    { text: '"' },
    { text: cutTitle(w.name), isolate: "auto" },
    { text: `" ${formatBytes(Number(w.size ?? -1))} ${type}${ext ? ` (.${ext})` : ""} from ` },
    { text: clean(w.host), strong: true, isolate: "ltr" },
  ];
}

/** A download no agent connection asked for (PAGE_CLIENT). @param {Asked} q */
export const isPage = (q) => q.tool === DOWNLOAD_TOOL && q.label?.client === PAGE_CLIENT;

/**
 * What a grant leaves asked that a task meets on its way, the checkpoints, as the grant's notice
 * says it, and as the question's hint says it in short, so the usual question still fits one
 * line (docs/specs/mcp-grants.md G3, mcp-checkpoints Behaviour 8).
 */
export const STILL_ASKS = "sending a form or paying still asks";
export const GRANT_SCOPE = "all but forms and paying";

/**
 * A checkpoint's glyph in place of the agent glyph (docs/specs/mcp-checkpoints.md C3): used
 * nowhere else in Vimma's chrome, so it means one thing without its colour.
 */
export const CHECKPOINT_GLYPH = "▲";

/** The tool that brings the agent workspace to the front (docs/specs/mcp-drive.md D2). */
export const SHOW_TOOL = "vimma_show";

/**
 * Whether the question is one yes or no, with no count or grant and `x` a plain no: a page's
 * download, an unscanned file (decision 31) and `vimma_show` (mcp-drive D4).
 * @param {Asked} q
 */
export const noGrant = (q) =>
  isPage(q) || q.tool === SHOW_TOOL || !!q.what?.unscanned || isCheckpoint(q);

/**
 * Whether the question is a checkpoint (docs/specs/mcp-checkpoints.md C1): a step that pays
 * (`pay`) or sends a form (`submit`), asked under any grant with `y` and `n` only.
 * @param {Asked} q
 */
export const isCheckpoint = (q) => !!q.what?.pay || !!q.what?.submit;

/**
 * A form submission as the question shows it (docs/specs/mcp-forms.md F15): its method and the
 * host of its destination in bold, and how many fields it sends when the fields themselves are
 * not known (`counted`; mcp-checkpoints Behaviour 4 lists them after).
 * @param {Record<string, any>} s @param {boolean} counted
 * @returns {Part[]}
 */
function submitParts(s, counted) {
  const fields = Number(s.fields) || 0;
  return [
    { text: " → " },
    { text: clean(s.method).toUpperCase(), strong: true },
    { text: " " },
    ...urlParts(displayUrl(clean(s.action)), clean(s.host)),
    ...(counted ? [{ text: ` (${fields} field${fields === 1 ? "" : "s"})` }] : []),
  ];
}

/**
 * An element as an activation's question shows it (F28): its label, kind and text.
 * @param {Record<string, any>} w
 * @returns {Part[]}
 */
function elementParts(w) {
  return [
    { text: `  ${clean(w.label)} ${clean(w.kind)} "` },
    { text: cutTitle(w.text), isolate: "auto" },
    { text: '"' },
  ];
}

/** A fill's question cuts each value, each field's name and the whole list at these columns. */
const FILL_VALUE_COLUMNS = 40;
const FILL_NAME_COLUMNS = 24;
const FILL_COLUMNS = 160;

/** The page's text, cleaned for the question (mcp-checkpoints Behaviour 4). @param {unknown} s */
const pageClean = (s) => clean(pageText(s));

/**
 * What a form submission sends, as a checkpoint shows it (docs/specs/mcp-checkpoints.md
 * Behaviour 4): each field's name and value, cut as a fill's are; a sensitive field as its name
 * and `•••`, a file field as its name; hidden fields counted, not listed; the list cut with
 * `… (N more)` where the line ends. Empty when there is nothing to say.
 * @param {Record<string, any>} sent @param {string} lead  what comes before the fields
 * @returns {Part[]}
 */
function sentParts(sent, lead) {
  const fields = Array.isArray(sent.fields) ? sent.fields : [];
  const hidden = Number(sent.hidden) || 0;
  let left = Number(sent.more) || 0;
  if (!fields.length && !left && !hidden) return [];
  /** @type {Part[]} */
  const parts = [{ text: lead }];
  let width = 0;
  let said = false;
  for (const [i, f] of fields.entries()) {
    const name = truncate(pageClean(f?.name), FILL_NAME_COLUMNS, "end");
    const value = truncate(pageClean(f?.value), FILL_VALUE_COLUMNS, "end");
    /** @type {Part[]} */
    const piece = [
      ...(i ? [{ text: ", " }] : []),
      { text: name, isolate: /** @type {const} */ ("auto") },
      ...(f?.secret
        ? [{ text: " •••" }]
        : f?.file
          ? [{ text: " (file)" }]
          : [
              { text: ' "' },
              { text: value, isolate: /** @type {const} */ ("auto") },
              { text: '"' },
            ]),
    ];
    const wide = textWidth(piece.map((p) => p.text).join(""));
    if (width + wide > FILL_COLUMNS) {
      // The fields left out are counted, so the user knows the line does not show them all.
      left += fields.length - i;
      break;
    }
    width += wide;
    parts.push(...piece);
    said = true;
  }
  if (left) {
    parts.push({ text: `${said ? ", " : ""}… (${left} more)` });
    said = true;
  }
  if (hidden) parts.push({ text: `${said ? ", " : ""}+ ${hidden} hidden` });
  return parts;
}

/** A payment's question quotes the page's total cut at this many columns (C7). */
const TOTAL_COLUMNS = 40;

/**
 * A checkpoint's question (docs/specs/mcp-checkpoints.md Behaviour 2-4, C2, C3, C7): `▲` and
 * the verb in the warning colour; a payment names the button (the keys of a key step), the site
 * in bold and the total the page states; a form its place, title and destination, then what it
 * sends. A payment that also sends a form says so after the payment.
 * @param {Asked} q @param {string} who
 * @returns {{ parts: Part[], hint: string }}
 */
function checkpointLine(q, who) {
  const w = q.what ?? {};
  const pay = w.pay && typeof w.pay === "object" ? w.pay : null;
  /** @type {Part[]} */
  const parts = [
    { text: CHECKPOINT_GLYPH, warn: true },
    { text: " " },
    { text: who, isolate: "auto" },
    { text: " " },
    { text: pay ? "wants to pay" : "wants to send a form", warn: true },
    { text: ": " },
  ];
  if (pay) {
    const keys = clean(pay.keys);
    if (keys) parts.push({ text: "keys " }, { text: keys, isolate: "ltr" });
    else {
      parts.push({ text: '"' }, { text: cutTitle(pageText(pay.text)), isolate: "auto" });
      parts.push({ text: '"' });
    }
    parts.push({ text: " on " }, { text: clean(pay.site), strong: true, isolate: "ltr" });
    // The page's claim, quoted as such: the user's bank is the authority on what is charged.
    const total = truncate(pageClean(pay.total), TOTAL_COLUMNS, "end");
    if (total) {
      parts.push({ text: ' · the page says "' }, { text: total, isolate: "auto" }, { text: '"' });
    }
    // A key call that follows a link shows its keys too (mcp-drive D14): none runs unseen.
    if (!keys && q.tool === "vimma_keys" && clean(w.keys)) {
      parts.push({ text: "  keys: " }, { text: clean(w.keys), isolate: "ltr" });
    }
  } else {
    const place = Number.isInteger(w.index) ? `${w.index} ` : "";
    parts.push({ text: `${place}"` }, { text: cutTitle(w.title), isolate: "auto" }, { text: '"' });
  }
  const sent = w.sent && typeof w.sent === "object" ? w.sent : null;
  if (w.submit) {
    parts.push(...submitParts(w.submit, !sent));
    if (q.tool === "vimma_fill") {
      parts.push(...fillParts(w, "  after filling ", true));
      if (sent) parts.push(...sentParts(sent, "  also "));
    } else if (sent) {
      parts.push(...sentParts(sent, "  "));
    }
  }
  return { parts, hint: pay ? "y pay · n stop" : "y send it · n stop" };
}

/**
 * A fill's fields as its question shows them (docs/specs/mcp-forms.md F14): each label, the
 * field's name or label text and the value in quotes (a checkbox's checked or unchecked), values
 * and names cut with …, the list cut with … where the line ends; `:mcp log` keeps them whole.
 * @param {Record<string, any>} w @param {string} lead  what comes before the fields
 * @param {boolean} [count]  name how many fields there are also when there is one
 * @returns {Part[]}
 */
function fillParts(w, lead, count = false) {
  return fillLine(w, lead, count).parts;
}

/**
 * `fillParts`, and whether every field's name and value fits the question whole.
 * @param {Record<string, any>} w @param {string} lead @param {boolean} count
 * @returns {{ parts: Part[], fits: boolean }}
 */
function fillLine(w, lead, count) {
  const fields = Array.isArray(w.fields) ? w.fields : [];
  const n = fields.length;
  /** @type {Part[]} */
  const parts = [{ text: n === 1 && !count ? lead : `${lead}${n} field${n === 1 ? "" : "s"}: ` }];
  let width = 0;
  let fits = true;
  for (const [i, f] of fields.entries()) {
    const fullName = clean(f?.name);
    const name = truncate(fullName, FILL_NAME_COLUMNS, "end");
    const flag = typeof f?.value === "boolean";
    const fullValue = flag ? "" : clean(f?.value);
    const value = truncate(fullValue, FILL_VALUE_COLUMNS, "end");
    if (name !== fullName || value !== fullValue) fits = false;
    /** @type {Part[]} */
    const piece = [
      { text: `${i ? ", " : ""}${clean(f?.label)}${name ? " " : ""}` },
      ...(name ? [{ text: name, isolate: /** @type {const} */ ("auto") }] : []),
      { text: flag ? ` = ${f.value ? "checked" : "unchecked"}` : ' = "' },
      ...(flag ? [] : [{ text: value, isolate: /** @type {const} */ ("auto") }, { text: '"' }]),
    ].filter((p) => p.text);
    const more = textWidth(piece.map((p) => p.text).join(""));
    if (width + more > FILL_COLUMNS) {
      // The fields left out are counted, so the user knows the line does not show them all.
      parts.push({ text: `${i ? ", " : ""}… (${n - i} more)` });
      fits = false;
      break;
    }
    width += more;
    parts.push(...piece);
  }
  return { parts, fits };
}

/**
 * Whether a fill's question shows every field's name and value whole (docs/specs/mcp-forms.md
 * F14, F15): a fill that submits must, because its one yes sends them.
 * @param {Record<string, any>} what
 */
export const fillFits = (what) => fillLine(what, "", false).fits;

/**
 * The question line: its text in parts (the host of an open in bold), the hint shown once the
 * line is armed, and the accessible name (the whole question).
 * @param {Asked} q
 * @param {{ grantMinutes: number, agentWorkspace?: string }} config  `agentWorkspace`: the agent
 *   workspace's name, which full control's question says it reaches beyond (mcp-drive D23)
 * @returns {{ parts: Part[], hint: string, label: string }}
 */
export function questionLine(q, { grantMinutes, agentWorkspace = AGENT_WORKSPACE }) {
  const who = clientName(q.label);
  /** @type {Part[]} */
  let parts;
  // mcp-grants G3: a grant covers every tool of the connection, and the hint says what still asks.
  let hint = `y once · ${grantMinutes}a ${grantMinutes} min, ${GRANT_SCOPE} · n deny · x mute`;
  const w = q.what ?? {};
  if (q.tool === FULL_CONTROL) {
    // The code the client printed on its own terminal (security.md S13): the user answers
    // the question of the vimma-ctl they ran, not one a racing client slipped in.
    const code = typeof w.code === "string" && FULL_CODE.test(w.code) ? w.code : null;
    // Asked only while MCP is on (decision 29 C), when an agent with a shell could be the one
    // asking: the line says that a yes reaches past the agent workspace (mcp-drive D23).
    /** @type {Part[]} */
    const reach = [
      { text: ' wants full control (every workspace, not only "' },
      { text: workspaceName(agentWorkspace), isolate: "auto" },
      { text: '") — y/N' },
    ];
    if (code) {
      parts = [
        { text: `${AGENT_GLYPH} vimma-ctl with code ` },
        { text: code, strong: true },
        ...reach,
      ];
      hint = "y if the code is the one vimma-ctl printed · n deny";
    } else {
      parts = [{ text: `${AGENT_GLYPH} a client with no code` }, ...reach];
      hint = "y allow · n deny";
    }
  } else if (isCheckpoint(q)) {
    ({ parts, hint } = checkpointLine(q, who));
  } else {
    /** @type {Part[]} */
    const head = [
      { text: `${AGENT_GLYPH} ` },
      { text: who, isolate: "auto" },
      { text: ` wants ${q.tool}: ` },
    ];
    if (q.tool === "vimma_open") {
      const url = clean(w.url);
      parts = [...head, ...urlParts(url, clean(w.host))];
      if (w.tab !== undefined) {
        parts.push({ text: ' in "' }, { text: cutTitle(w.title), isolate: "auto" }, { text: '"' });
      }
    } else if (q.tool === DOWNLOAD_TOOL) {
      parts = [...head, ...downloadParts(w)];
      if (w.unscanned) {
        // ClamAV could not scan it: keeping it unscanned is asked, default no (security.md M13).
        parts.push({ text: ` — ⚠ not scanned: ${clean(w.unscanned)}; keep it?` });
        hint = "y keep it unscanned · n delete";
      } else if (w.danger) {
        parts.push({ text: ` — ⚠ ${clean(w.danger)}` });
        hint = "! allow this one file · n deny";
      } else if (isPage(q)) {
        hint = "y once · n deny";
      }
    } else if (q.tool === SHOW_TOOL) {
      // mcp-drive D4: a show is asked every time, so there is nothing to grant.
      // The question says that a yes changes the user's view, and to which workspace (D2).
      parts = [
        ...head,
        ...tabParts(w),
        { text: ' (switches you to "' },
        { text: workspaceName(agentWorkspace), isolate: "auto" },
        { text: '")' },
      ];
      hint = "y show it · n deny";
    } else if (q.tool === "vimma_fill") {
      parts = [...head, ...tabParts(w), ...fillParts(w, "  ")];
    } else if (q.tool === "vimma_activate") {
      parts = [...head, ...tabParts(w), ...elementParts(w)];
    } else if (q.tool === "vimma_tabs") {
      parts = [...head, { text: `the list of agent tabs (${Number(w.count) || 0})` }];
    } else if (q.tool === "vimma_keys") {
      // mcp-drive D14: the keys exactly as they will run, after parsing.
      parts = [
        ...head,
        ...tabParts(w),
        { text: "  keys: " },
        { text: clean(w.keys), isolate: "ltr" },
      ];
    } else {
      parts = [...head, ...tabParts(w)];
    }
  }
  return { parts, hint, label: parts.map((p) => p.text).join("") };
}

/**
 * What a key does to the question (decision 13): `y` once; `n`, Esc and Enter deny; `x` denies
 * and mutes; digits make a count and `a` grants that many minutes (a bare `a`: the default);
 * Backspace takes a digit back. Any other key neither allows nor denies. Full control's
 * question (`full`) and a page's download (`noGrant`) have no count or grant, and their `x` is a
 * plain no. A dangerous download (`dangerous`, decision 31 d) is allowed only by `!`, for that
 * one file: `y`, `a` and counts do nothing there.
 * @param {{ count: string }} state  the digits typed so far
 * @param {string} key  core formatKey of the keydown
 * @param {{ full?: boolean, noGrant?: boolean, dangerous?: boolean }} [options]
 * @returns {{ kind: "answer", answer: PromptAnswer } | { kind: "count", count: string }
 *   | { kind: "ignore" }}
 */
export function promptKey(
  { count },
  key,
  { full = false, noGrant = false, dangerous = false } = {},
) {
  /** @param {PromptAnswer} answer */
  const say = (answer) => ({ kind: /** @type {const} */ ("answer"), answer });
  const plain = full || noGrant;
  if (key === "n" || key === "N" || key === "esc" || key === "enter") return say({ kind: "deny" });
  if (key === "x") return say(plain ? { kind: "deny" } : { kind: "mute" });
  if (dangerous) return key === "!" ? say({ kind: "once" }) : { kind: "ignore" };
  if (key === "y" || key === "Y" || key === "shift+y") return say({ kind: "once" });
  if (plain) return { kind: "ignore" };
  if (key === "a") return say({ kind: "grant", minutes: count ? Number(count) : null });
  if (/^[0-9]$/.test(key)) {
    if ((key === "0" && !count) || count.length >= MAX_COUNT_DIGITS) return { kind: "ignore" };
    return { kind: "count", count: count + key };
  }
  if (key === "backspace" && count) return { kind: "count", count: count.slice(0, -1) };
  return { kind: "ignore" };
}

/**
 * The notice after a grant (decision 20, mcp-grants G3): its scope, how long, whether the cap
 * cut it, what still asks and the key that ends it, and how many waiting calls it let run,
 * which the user never saw asked (mcp-grants behaviour 1; `:mcp log` lists them).
 * @param {Asked} q @param {{ minutes: number, capped: boolean }} length
 * @param {number} [released]
 */
export function grantNotice(q, { minutes, capped }, released = 0) {
  const cap = capped ? ", the most [mcp] grant_max_minutes allows" : "";
  const also = released
    ? ` · it also ran ${released} waiting call${released === 1 ? "" : "s"} (:mcp log)`
    : "";
  return (
    `${clientName(q.label)} may use the agent workspace for ${minutes} min${cap}; ` +
    `${STILL_ASKS} (ctrl+b shift+a ends it)${also}`
  );
}

/** @param {unknown} fields  "1 field", "3 fields" */
const fieldCount = (fields) => {
  const n = Array.isArray(fields) ? fields.length : 0;
  return `${n} field${n === 1 ? "" : "s"}`;
};

/**
 * The notice for a call made under a grant (decision 23).
 * @param {Asked} q @param {number} until  the grant's end @param {number} now
 */
export function ranNotice(q, until, now) {
  const left = Math.max(1, Math.ceil((until - now) / 60_000));
  const w = q.what ?? {};
  const did =
    q.tool === "vimma_read_page"
      ? `read "${cutTitle(w.title)}"`
      : q.tool === "vimma_open"
        ? `opened ${clean(w.host) || displayUrl(clean(w.url))}`
        : q.tool === "vimma_close_tab"
          ? `closed "${cutTitle(w.title)}"`
          : q.tool === "vimma_tabs"
            ? "listed the agent tabs"
            : q.tool === "vimma_keys" && w.followed
              ? // mcp-drive D14: a follow under a grant names the host it loaded.
                `followed a link to ${clean(w.followed)} in "${cutTitle(w.title)}"`
              : q.tool === "vimma_keys"
                ? `pressed ${clean(w.keys)} in "${cutTitle(w.title)}"`
                : q.tool === "vimma_elements"
                  ? `listed the buttons and fields of "${cutTitle(w.title)}"`
                  : q.tool === "vimma_activate"
                    ? `clicked ${clean(w.kind)} "${cutTitle(w.text)}" in "${cutTitle(w.title)}"`
                    : q.tool === "vimma_fill"
                      ? `filled ${fieldCount(w.fields)} in "${cutTitle(w.title)}"`
                      : q.tool === "vimma_screenshot"
                        ? `took a screenshot of "${cutTitle(w.title)}"`
                        : q.tool === "vimma_console"
                          ? `read the errors of "${cutTitle(w.title)}"`
                          : q.tool === DOWNLOAD_TOOL
                            ? `downloads "${cutTitle(w.name)}"`
                            : `used ${q.tool}`;
  return `${clientName(q.label)} ${did} (grant, ${left}m left)`;
}

/**
 * The notice after `vimma_show` switched a window to the agent workspace (mcp-drive D3, D6):
 * `ctrl+^` returns, because the switch is an ordinary one. `otherWindow`: the tab is in a window
 * other than the one where the user answered, which switched instead. `switched: false`: the
 * window was on the agent workspace already, so the show only selected the tab and `ctrl+^`
 * would not go back to where the user was.
 * @param {Asked} q @param {{ otherWindow: boolean, switched?: boolean }} where
 */
export function shownNotice(q, { otherWindow, switched = true }) {
  const whose = `${clientName(q.label)}'s tab`;
  if (!switched) return otherWindow ? `showing ${whose} in the other window` : `showing ${whose}`;
  return otherWindow
    ? `showing ${whose}, shown in the other window · ctrl+^ there goes back`
    : `showing ${whose} · ctrl+^ goes back`;
}

/**
 * The notice after a denial: the user's no (`user`), `x` (`mute`) or no answer (`timeout`).
 * @param {Asked} q @param {"user" | "mute" | "timeout"} why
 */
export function deniedNotice(q, why) {
  if (why === "timeout") return "agent request timed out (denied)";
  const who = clientName(q.label);
  if (q.tool === FULL_CONTROL) return `denied ${who} full control`;
  const w = q.what ?? {};
  // mcp-checkpoints Behaviour 5: a no stops that step only, and `x` is a plain no there.
  if (w.pay) return `stopped ${who}'s payment on ${clean(w.pay.site)}`;
  if (w.submit) return `stopped ${who}'s form to ${clean(w.submit.host)}`;
  const muted = why === "mute" ? "; muted until it reconnects" : "";
  return `denied ${who}'s ${q.tool}${muted}`;
}

/**
 * The notice after a checkpoint's yes (docs/specs/mcp-checkpoints.md Behaviour 6): where the
 * form went, or the site the payment was on.
 * @param {Asked} q
 */
export function checkpointNotice(q) {
  const w = q.what ?? {};
  if (w.pay) return `paid on ${clean(w.pay.site)}`;
  return `sent the form to ${clean(w.submit?.host) || displayUrl(clean(w.submit?.action))}`;
}

/** What each tool asks for, in the desktop notification (no URL, no title). */
const ASKS = Object.freeze({
  vimma_tabs: "list its tabs",
  vimma_read_page: "read a page",
  vimma_open: "open a page",
  vimma_close_tab: "close a tab",
  vimma_keys: "move around a page",
  [SHOW_TOOL]: "show you a page",
  vimma_elements: "list a page's buttons and fields",
  vimma_activate: "click on a page",
  vimma_fill: "fill in a form",
  vimma_screenshot: "take a screenshot of a page",
  vimma_console: "read a page's errors and failed requests",
  [DOWNLOAD_TOOL]: "download a file",
});

/**
 * The desktop notification's text (decision 15): who and what kind of request, never a URL or
 * title, since notifications show on lock screens and in screen shares.
 * @param {Asked} q
 */
export function agentAlertText(q) {
  const who = clientName(q.label);
  if (q.tool === FULL_CONTROL) return `${who} asks for full control of Vimma (every workspace)`;
  // mcp-checkpoints Behaviour 7: no site, amount or URL, as for every question.
  if (q.what?.pay) return `${who} asks to pay`;
  if (q.what?.submit) return `${who} asks to send a form`;
  const asks = /** @type {Record<string, string>} */ (ASKS);
  return `${who} asks to use Vimma's agent workspace (${asks[q.tool] ?? "use a tool"})`;
}

/** What `:mcp log` says of each outcome (mcp-drive D14). */
const OUTCOMES = Object.freeze({
  yes: "allowed",
  grant: "ran under a grant",
  user: "denied",
  timeout: "no answer (denied)",
  busy: "denied (busy)",
  muted: "denied (muted)",
  cancelled: "cancelled",
  "in-use": "denied (the user was using the tab)",
  changed: "denied (the tab changed)",
  followed: "followed a link",
  "checkpoint-yes": "allowed (checkpoint)",
  "checkpoint-no": "denied (checkpoint)",
  failed: "failed",
});

/** @type {Readonly<Record<string, string>>} */
const OUTCOME_TEXT = OUTCOMES;

/** FSI…PDI: text an agent or a page chose, as its own bidi run (security.md M4). */
const isolate = (/** @type {string} */ t) => (t ? `\u2068${t}\u2069` : "");

/**
 * One row of `:mcp log` (mcp-drive D14) in its three cells: the time; the client, the tool, the
 * tab's title and the keys or URL; and what came of it. Plain text.
 * @param {import("./agent.mjs").LogEntry} e
 * @returns {{ time: string, text: string, outcome: string }}
 */
export function logCells(e) {
  const d = new Date(e.at);
  const time = [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  const title = cutTitle(e.title);
  const detail = truncate(clean(e.detail), 120, "end");
  const text = [
    isolate(clientName({ client: e.client })),
    clean(e.tool),
    title ? `"${isolate(title)}"` : "",
    isolate(detail),
  ]
    .filter(Boolean)
    .join(" ");
  const outcome =
    e.outcome === "stopped"
      ? `stopped (${clean(e.why) || "early"})`
      : (OUTCOME_TEXT[e.outcome] ?? clean(e.outcome));
  return { time, text, outcome };
}

/**
 * One row of `:mcp log` as one line: `17:05:09 claude-code vimma_keys "Pricing" 3j · allowed`.
 * @param {import("./agent.mjs").LogEntry} e
 */
export function logRow(e) {
  const { time, text, outcome } = logCells(e);
  return `${time} ${text} · ${outcome}`;
}

/**
 * The status bar's agent state (decision 24), or null when there is nothing to show: no agent
 * connection and no question waiting.
 * @param {{ connections: number, waiting: number, grants: { until: number }[],
 *   ranAt: number | null, now: number }} a
 * @returns {{ waiting: number, minutes: number | null, ran: boolean } | null}
 */
export function agentState({ connections, waiting, grants, ranAt, now }) {
  if (!connections && !waiting) return null;
  const first = grants.length ? Math.min(...grants.map((g) => g.until)) : null;
  return {
    waiting,
    minutes: first === null ? null : Math.max(1, Math.ceil((first - now) / 60_000)),
    ran: ranAt !== null && now - ranAt < RAN_MS,
  };
}

/**
 * @typedef {{ kind: "status" } | { kind: "on", minutes: number } | { kind: "off" }
 *   | { kind: "refuse", text: string }} ControlCommand
 */

/**
 * `:control [on <minutes> | off]` (decision 29 D).
 * @param {string | undefined} text
 * @returns {ControlCommand}
 */
export function parseControlCommand(text) {
  const words = (text ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { kind: "status" };
  if (words.length === 1 && words[0] === "off") return { kind: "off" };
  if (
    words[0] === "on" &&
    words.length === 2 &&
    /^[0-9]+$/.test(/** @type {string} */ (words[1]))
  ) {
    const minutes = Number(words[1]);
    if (minutes >= 1 && minutes <= CONTROL_MAX_MINUTES) return { kind: "on", minutes };
  }
  return {
    kind: "refuse",
    text: `:control takes on <minutes> (1 to ${CONTROL_MAX_MINUTES}) or off`,
  };
}

/**
 * `:control on <minutes>`'s question. While MCP is on, an agent with a shell can use full control
 * too, so the question says that it reaches past the agent workspace (mcp-drive D22).
 * @param {number} minutes
 * @param {string | null} [agentWorkspace]  the agent workspace's name while MCP is on, else null
 */
export function controlOnQuestion(minutes, agentWorkspace = null) {
  if (agentWorkspace !== null) {
    return (
      `Turn on full control for ${minutes} min? It reaches every workspace and tab, not only ` +
      // FSI…PDI: the name is its own bidi run (security.md M4), as the question line's <bdi>.
      `"\u2068${workspaceName(agentWorkspace)}\u2069", and any local AI agent with a shell can ` +
      "use it. y/N"
    );
  }
  return (
    "Turn on full control (vimma-ctl: keys in this window, every workspace) for " +
    `${minutes} min? y/N`
  );
}

/**
 * Full control's state, for `:control`, `:mcp` and about:vimma.
 * @param {{ enabled: boolean, until: number | null, now: number }} s  `until` in ms, or null
 */
export function controlStatus({ enabled, until, now }) {
  if (!enabled) return "full control off (:control on <minutes>)";
  if (until === null) return "full control on (vimma.control.enabled, no time limit)";
  return `full control on, ${Math.max(1, Math.ceil((until - now) / 60_000))}m left`;
}

/**
 * `:control on`'s end time, read back (security.md S13): the pref holds ms since the epoch as
 * a string of digits. Anything else, a time that has passed, or one further ahead than the
 * longest `:control on` (a clock moved back, a hand edit) turns control off: it fails closed.
 * No pref at all is control set without an end (about:config).
 * @param {string | undefined} raw  the pref, or undefined when it is not set
 * @param {number} now  ms
 * @returns {{ kind: "none" } | { kind: "off" } | { kind: "until", until: number }}
 */
export function controlEnd(raw, now) {
  if (raw === undefined) return { kind: "none" };
  if (!/^[1-9][0-9]{0,15}$/.test(raw)) return { kind: "off" };
  const until = Number(raw);
  if (!Number.isSafeInteger(until) || until <= now) return { kind: "off" };
  if (until - now > (CONTROL_MAX_MINUTES + 1) * 60_000) return { kind: "off" };
  return { kind: "until", until };
}
