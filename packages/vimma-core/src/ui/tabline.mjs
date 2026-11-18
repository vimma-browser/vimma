/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The tab line (docs/specs/tab-line.md) as plain data: which tabs it lists, how they fit a width
 * in columns, and `gb`'s labels. The host renders it (ui/tabline.mjs); no HTML here.
 */
import { hintLabelCase, hintLabels } from "../page/hints.mjs";
import { textWidth } from "../text/textwidth.mjs";
import { truncate } from "./statusbar.mjs";

/** @import { Chord } from "../keys/keys.mjs" */

/** @import { TabLineSetting } from "../config/defaults.mjs" */

/**
 * One tab of the line, before it is fitted.
 * @typedef {{ readonly tabId: string, readonly number: number, readonly name: string,
 *   readonly current: boolean, readonly playing: boolean, readonly pane: boolean }} TabLineEntry
 */
/**
 * One drawn entry: `name` cut to fit ("" for none); while gb's labels show, `label` the whole
 * label and `rest` the letters still to type, which are what is drawn; `bare` an entry drawn as
 * those letters alone (decision 13), with no number, mark or name.
 * @typedef {{ readonly tabId: string, readonly number: number, readonly name: string,
 *   readonly current: boolean, readonly playing: boolean, readonly pane: boolean,
 *   readonly label: string | null, readonly rest?: string, readonly bare?: boolean }} TabLineItem
 */
/**
 * What the line draws: the entries in view and how many tabs are hidden on each side.
 * @typedef {{ items: TabLineItem[], before: number, after: number }} TabLineFit
 */
/**
 * A gb session: each tab's label in tab order, and the characters typed so far.
 * @typedef {{ readonly chars: string, readonly typed: string,
 *   readonly labels: readonly { readonly tabId: string, readonly label: string }[] }} TabLineLabels
 */
/**
 * @typedef {{ kind: "narrow" } | { kind: "select", tabId: string } | { kind: "cancel" }}
 *   TabLabelResult
 */

/**
 * Whether the line is drawn: `always`, `auto` with two tabs or more, and while gb's labels show,
 * whatever the setting (decision 14).
 * @param {TabLineSetting} setting
 * @param {number} count  the workspace's tabs
 * @param {boolean} [labelling]
 */
export function tabLineShown(setting, count, labelling = false) {
  if (labelling) return true;
  if (setting === "always") return true;
  return setting === "auto" && count >= 2;
}

/**
 * The setting `:tabline` writes: off where the line is drawn, always where it is not, so the
 * command always changes what is seen (decision 6).
 * @param {boolean} drawn
 * @returns {TabLineSetting}
 */
export function nextTabLineSetting(drawn) {
  return drawn ? "off" : "always";
}

/**
 * The line's entries from the side panel's rows (core sidepanel.mjs openPanel), so the numbers,
 * names and tabs are the panel's (decision 7).
 * @param {readonly { tabId: string, number: number, display: string, active: boolean,
 *   playing: boolean }[]} rows
 * @param {readonly string[]} panes  the shown split's tabs
 * @returns {TabLineEntry[]}
 */
export function tabLineEntries(rows, panes) {
  const inPane = new Set(panes);
  return rows.map((r) =>
    Object.freeze({
      tabId: r.tabId,
      number: r.number,
      name: r.display,
      current: r.active,
      playing: r.playing,
      pane: inPane.has(r.tabId),
    }),
  );
}

/** Printable ASCII: one column a character, so no grapheme segmenting is needed. */
const ASCII = /^[\x20-\x7e]*$/;

/** @param {string} text */
const columns = (text) => (ASCII.test(text) ? text.length : textWidth(text));

/**
 * `text` cut to `width` columns with one ellipsis (statusbar.mjs truncate), the ASCII case
 * without segmenting.
 * @param {string} text
 * @param {number} width
 */
function cut(text, width) {
  if (!ASCII.test(text)) return truncate(text, width, "end");
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}

/**
 * The columns of an entry but its name: a column of padding on each side, the label's letters
 * still to type and a space, the number, the pane mark, a space before ♪ and ♪. A bare entry is
 * those letters and the padding.
 * @param {{ number: number, pane: boolean, playing: boolean, label?: string | null,
 *   rest?: string, bare?: boolean }} item
 */
function fixedWidth(item) {
  const shown = item.rest ?? item.label ?? "";
  const label = columns(shown);
  if (item.bare) return 2 + label;
  return (
    2 +
    (shown ? label + 1 : 0) +
    String(item.number).length +
    (item.pane ? 1 : 0) +
    (item.playing ? 2 : 0)
  );
}

/**
 * One entry's columns; the name takes a space before it.
 * @param {{ number: number, name: string, pane: boolean, playing: boolean,
 *   label?: string | null, rest?: string, bare?: boolean }} item
 */
export function itemWidth(item) {
  return fixedWidth(item) + (item.name && !item.bare ? 1 + columns(item.name) : 0);
}

/** A hidden count's mark, `‹n` or `n›`, with the space after or before it. @param {number} n */
const markWidth = (n) => (n > 0 ? String(n).length + 2 : 0);

/**
 * The columns a fitted line takes.
 * @param {TabLineFit} fit
 */
export function lineWidth(fit) {
  let n = markWidth(fit.before) + markWidth(fit.after);
  for (const i of fit.items) n += itemWidth(i);
  return n;
}

/**
 * Fits the entries into `width` columns (decision 10): every entry when they fit; else the run
 * around the current tab, grown a neighbour at a time, right then left, while it fits with the
 * hidden counts' marks. While gb's labels show (decision 13), only the tabs whose label starts
 * with what was typed are listed, each drawing the letters still to type; before any of them is
 * hidden their names shrink, then each is drawn as those letters alone, and if even that does not
 * fit, the run starts at the first tab listed, since labels go shortest first in tab order: the
 * tabs one key away are always in view. Each name is measured once and only the drawn ones are
 * cut, so a fit is linear in the tabs.
 * @param {readonly TabLineEntry[]} entries
 * @param {{ width: number, nameWidth: number, labels?: TabLineLabels | null }} options
 * @returns {TabLineFit}
 */
export function fitTabLine(entries, { width, nameWidth, labels = null }) {
  /** @type {Map<string, string>} */
  const labelOf = new Map();
  let list = entries;
  if (labels) {
    for (const l of labels.labels) {
      if (l.label.startsWith(labels.typed)) labelOf.set(l.tabId, l.label);
    }
    list = entries.filter((e) => labelOf.has(e.tabId));
  }
  const n = list.length;
  if (!n) return { items: [], before: 0, after: 0 };
  const label = (/** @type {TabLineEntry} */ e) => labelOf.get(e.tabId) ?? null;
  const typed = labels ? labels.typed.length : 0;
  /** @type {(e: TabLineEntry) => { label: string | null, rest?: string }} */
  const labelled = (e) => {
    const l = label(e);
    return l === null ? { label: null } : { label: l, rest: l.slice(typed) };
  };
  const fixed = list.map((e) => fixedWidth({ ...e, ...labelled(e) }));
  const names = list.map((e) => columns(e.name));
  // A name cut to `w` columns takes at most `w`, and a space before it.
  const nameCols = (/** @type {number} */ i, /** @type {number} */ w) => {
    const c = Math.min(/** @type {number} */ (names[i]), w);
    return c > 0 ? c + 1 : 0;
  };
  const total = (/** @type {number} */ w) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += /** @type {number} */ (fixed[i]) + nameCols(i, w);
    return sum;
  };
  /** @param {number} a @param {number} b @param {number} w @param {boolean} [bare] */
  const make = (a, b, w, bare = false) =>
    list.slice(a, b + 1).map((e) =>
      Object.freeze({
        ...e,
        name: bare || w <= 0 ? "" : cut(e.name, w),
        ...labelled(e),
        ...(bare ? { bare: true } : {}),
      }),
    );
  if (total(nameWidth) <= width) return { items: make(0, n - 1, nameWidth), before: 0, after: 0 };

  let w = nameWidth;
  let bare = false;
  /** @type {number[]} */
  let widths;
  if (labels) {
    // Every label in view first: the names give way (the widest that fits, by bisection, as the
    // total only grows with the width), then the numbers and marks.
    if (total(0) <= width) {
      let lo = 0;
      let hi = nameWidth;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (total(mid) <= width) lo = mid;
        else hi = mid - 1;
      }
      return { items: make(0, n - 1, lo), before: 0, after: 0 };
    }
    const bareWidths = list.map((e) => fixedWidth({ ...e, ...labelled(e), bare: true }));
    if (bareWidths.reduce((x, y) => x + y, 0) <= width) {
      return { items: make(0, n - 1, 0, true), before: 0, after: 0 };
    }
    bare = true;
    w = 0;
    widths = bareWidths;
  } else {
    widths = list.map((_, i) => /** @type {number} */ (fixed[i]) + nameCols(i, w));
  }

  // The run around the current tab, or while labelling from the first tab listed; grown with a
  // running sum.
  const current = labels
    ? 0
    : Math.max(
        0,
        list.findIndex((e) => e.current),
      );
  let a = current;
  let b = current;
  let sum = /** @type {number} */ (widths[current]);
  const fits = (/** @type {number} */ s, /** @type {number} */ x, /** @type {number} */ y) =>
    s + markWidth(x) + markWidth(n - 1 - y) <= width;
  if (!fits(sum, a, b)) {
    // Too narrow for the current tab's whole entry: its name is cut further, as the last resort.
    const [only] = make(current, current, w, bare);
    const fit = {
      items: [/** @type {TabLineItem} */ (only)],
      before: current,
      after: n - 1 - current,
    };
    const room = width - (lineWidth(fit) - (only?.name ? columns(only.name) : 0));
    const name = only && !bare && room >= 1 ? cut(entriesName(list, current), room) : "";
    return { ...fit, items: [Object.freeze({ .../** @type {TabLineItem} */ (only), name })] };
  }
  for (;;) {
    const right = b + 1 < n && fits(sum + /** @type {number} */ (widths[b + 1]), a, b + 1);
    if (right) sum += /** @type {number} */ (widths[++b]);
    const left = a > 0 && fits(sum + /** @type {number} */ (widths[a - 1]), a - 1, b);
    if (left) sum += /** @type {number} */ (widths[--a]);
    if (!right && !left) break;
  }
  return { items: make(a, b, w, bare), before: a, after: n - 1 - b };
}

/** @param {readonly TabLineEntry[]} list @param {number} i */
const entriesName = (list, i) => /** @type {TabLineEntry} */ (list[i]).name;

/**
 * gb's labels: one per tab, in tab order, from `[modal] hint_chars` (decision 12).
 * @param {readonly string[]} tabIds
 * @param {string} chars
 * @returns {TabLineLabels}
 */
export function startTabLabels(tabIds, chars) {
  const labels = hintLabels(tabIds.length, chars);
  return Object.freeze({
    chars,
    typed: "",
    labels: Object.freeze(
      tabIds.map((tabId, i) => Object.freeze({ tabId, label: /** @type {string} */ (labels[i]) })),
    ),
  });
}

const CANCEL = Object.freeze({ kind: /** @type {const} */ ("cancel") });
const NARROW = Object.freeze({ kind: /** @type {const} */ ("narrow") });

/**
 * One key while gb's labels show: the next character of a label narrows, a whole label selects
 * its tab, Backspace takes back the last character (and cancels with none typed), and any other
 * key cancels, Esc and chords included (decision 12). A letter typed with Shift or Caps Lock is
 * that letter, as for link hints: it arrives lower case with `shift` set (keys.mjs normaliseKey).
 * @param {TabLineLabels} state
 * @param {Chord} chord
 * @returns {{ state: TabLineLabels, result: TabLabelResult }}
 */
export function tabLabelKey(state, chord) {
  if (chord.ctrl || chord.alt || chord.meta) return { state, result: CANCEL };
  if (chord.key === "backspace" && !chord.shift) {
    if (!state.typed) return { state, result: CANCEL };
    const next = Object.freeze({ ...state, typed: [...state.typed].slice(0, -1).join("") });
    return { state: next, result: NARROW };
  }
  if ([...chord.key].length !== 1 || !state.chars.includes(chord.key)) {
    return { state, result: CANCEL };
  }
  const typed = state.typed + chord.key;
  const left = state.labels.filter((l) => l.label.startsWith(typed));
  if (!left.length) return { state, result: CANCEL };
  const next = Object.freeze({ ...state, typed });
  const hit = left.length === 1 ? left[0] : undefined;
  if (hit && hit.label === typed) {
    return { state: next, result: Object.freeze({ kind: "select", tabId: hit.tabId }) };
  }
  return { state: next, result: NARROW };
}

/**
 * What `{N}gb` says when the workspace has no tab `n` (docs/specs/tab-line.md decision 15), or
 * null when it has.
 * @param {number} n
 * @param {number} count  the workspace's tabs
 * @returns {string | null}
 */
export function tabCountRefusal(n, count) {
  if (n >= 1 && n <= count) return null;
  return `no tab ${n}: this workspace has ${count} ${count === 1 ? "tab" : "tabs"}`;
}

/**
 * The case gb's labels are drawn in: the link hints' rule (core hints.mjs hintLabelCase) for a
 * label that ignores the case typed, upper case, so the two kinds of label read alike.
 * @returns {"lower" | "upper"}
 */
export function tabLabelCase() {
  return hintLabelCase("hint.follow");
}
