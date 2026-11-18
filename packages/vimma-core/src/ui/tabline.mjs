/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The tab line (docs/specs/tab-line.md) as plain data: which tabs it lists, how they fit a width
 * in columns, and `gb`'s labels. The host renders it (ui/tabline.mjs); no HTML here.
 */
import { hintLabels } from "../page/hints.mjs";
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
 * One drawn entry: `name` cut to fit ("" for none), `label` gb's label while labels show.
 * @typedef {{ readonly tabId: string, readonly number: number, readonly name: string,
 *   readonly current: boolean, readonly playing: boolean, readonly pane: boolean,
 *   readonly label: string | null }} TabLineItem
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

/**
 * One entry's columns: a column of padding on each side, the label and a space, the number, the
 * pane mark, a space and the name, a space and ♪.
 * @param {{ number: number, name: string, pane: boolean, playing: boolean,
 *   label?: string | null }} item
 */
export function itemWidth(item) {
  return (
    2 +
    (item.label ? textWidth(item.label) + 1 : 0) +
    String(item.number).length +
    (item.pane ? 1 : 0) +
    (item.name ? 1 + textWidth(item.name) : 0) +
    (item.playing ? 2 : 0)
  );
}

/** A hidden count's mark, `‹n` or `n›`, with the space after or before it. @param {number} n */
const markWidth = (n) => (n > 0 ? String(n).length + 2 : 0);

/**
 * The columns a fitted line takes.
 * @param {TabLineFit} fit
 */
export function lineWidth(fit) {
  return (
    fit.items.reduce((n, item) => n + itemWidth(item), 0) +
    markWidth(fit.before) +
    markWidth(fit.after)
  );
}

/**
 * @param {TabLineEntry} entry
 * @param {number} nameWidth
 * @param {string | null} label
 * @returns {TabLineItem}
 */
function item(entry, nameWidth, label) {
  const name = nameWidth > 0 ? truncate(entry.name, nameWidth, "end") : "";
  return Object.freeze({ ...entry, name, label });
}

/**
 * Fits the entries into `width` columns (decision 10): every entry when they fit; else the run
 * around the current tab, grown a neighbour at a time, right then left, while it fits with the
 * hidden counts' marks. While gb's labels show (decision 13), only the tabs whose label starts
 * with what was typed are listed, and their names shrink before any of them is hidden.
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
  if (!list.length) return { items: [], before: 0, after: 0 };
  const make = (/** @type {number} */ w) =>
    list.map((e) => item(e, w, labelOf.get(e.tabId) ?? null));
  let items = make(nameWidth);
  const all = (/** @type {TabLineItem[]} */ xs) => ({ items: xs, before: 0, after: 0 });
  if (lineWidth(all(items)) <= width) return all(items);
  if (labels) {
    // Every label in view first: the names give way, down to the label and the number.
    for (let w = nameWidth - 1; w >= 0; w--) {
      const fewer = make(w);
      if (lineWidth(all(fewer)) <= width) return all(fewer);
    }
    items = make(0);
  }
  const current = Math.max(
    0,
    items.findIndex((i) => i.current),
  );
  const fits = (/** @type {number} */ a, /** @type {number} */ b) =>
    lineWidth({ items: items.slice(a, b + 1), before: a, after: items.length - 1 - b }) <= width;
  let a = current;
  let b = current;
  if (!fits(a, b)) {
    // Too narrow for the current tab's whole entry: its name is cut further, as the last resort.
    const only = /** @type {TabLineItem} */ (items[current]);
    const fit = { items: [only], before: current, after: items.length - 1 - current };
    // The columns left for the name; the space before it is counted already.
    const room = width - (lineWidth(fit) - textWidth(only.name));
    const name = room >= 1 ? truncate(only.name, room, "end") : "";
    return { ...fit, items: [Object.freeze({ ...only, name })] };
  }
  for (;;) {
    const right = b + 1 < items.length && fits(a, b + 1);
    if (right) b++;
    const left = a > 0 && fits(a - 1, b);
    if (left) a--;
    if (!right && !left) break;
  }
  return { items: items.slice(a, b + 1), before: a, after: items.length - 1 - b };
}

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
 * its tab, and any other key cancels, Esc and chords included (decision 12).
 * @param {TabLineLabels} state
 * @param {Chord} chord
 * @returns {{ state: TabLineLabels, result: TabLabelResult }}
 */
export function tabLabelKey(state, chord) {
  if (chord.ctrl || chord.alt || chord.meta || chord.shift) return { state, result: CANCEL };
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
