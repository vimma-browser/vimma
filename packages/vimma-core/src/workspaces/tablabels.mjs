/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Tab rename (`prefix+shift+t`, spec m2-core-logic): a label override per tab id, and the label
 * every view shows (rename > title > URL). Persisted as the optional `tabLabels` field of the
 * state snapshot (schema v1, additive). No-ops return the input itself.
 */
import { graphemes } from "../text/textwidth.mjs";

/** @typedef {Readonly<Record<string, string>>} TabLabels */

export const MAX_TAB_LABEL = 100;

/** The snapshot field that carries the labels. */
export const TAB_LABELS_FIELD = "tabLabels";

/** @typedef {{ path: string, message: string }} TabLabelWarning */

const EMOJI_START = /^\p{Extended_Pictographic}/u;

/**
 * The label as stored and shown. Format characters (`\p{Cf}`: bidi overrides and isolates, zero
 * width spaces, BOM, tags) are removed, except inside an emoji sequence (ZWJ, tag flags), so a
 * label cannot be invisible or reorder its neighbours. Control characters and whitespace runs
 * become one space; trimmed; at most MAX_TAB_LABEL grapheme clusters.
 * @param {string} text
 * @returns {string}
 */
export function normalizeTabLabel(text) {
  const visible = graphemes(String(text))
    .map(({ segment }) => (EMOJI_START.test(segment) ? segment : segment.replace(/\p{Cf}/gu, "")))
    .join("");
  const flat = visible.replace(/[\s\p{Cc}]+/gu, " ").trim();
  const cut = graphemes(flat)[MAX_TAB_LABEL];
  return cut ? flat.slice(0, cut.index).trimEnd() : flat;
}

/**
 * @param {Record<string, string>} labels
 * @returns {TabLabels}
 */
function freeze(labels) {
  return Object.freeze(labels);
}

/**
 * Sets a tab's label; a label that normalises to "" clears it.
 * @param {TabLabels} labels
 * @param {string} tabId
 * @param {string} text
 * @returns {TabLabels}
 */
export function setTabLabel(labels, tabId, text) {
  const label = normalizeTabLabel(text);
  if (!label) return clearTabLabel(labels, tabId);
  if (labels[tabId] === label) return labels;
  return freeze({ ...labels, [tabId]: label });
}

/**
 * @param {TabLabels} labels
 * @param {string} tabId
 * @returns {TabLabels}
 */
export function clearTabLabel(labels, tabId) {
  if (!Object.hasOwn(labels, tabId)) return labels;
  return freeze(Object.fromEntries(Object.entries(labels).filter(([id]) => id !== tabId)));
}

/**
 * @param {TabLabels} labels
 * @param {string} tabId
 * @returns {string | undefined}
 */
export function tabLabel(labels, tabId) {
  return Object.hasOwn(labels, tabId) ? labels[tabId] : undefined;
}

/**
 * Drops labels of tabs that no longer exist.
 * @param {TabLabels} labels
 * @param {Iterable<string>} liveTabIds
 * @returns {TabLabels}
 */
export function pruneTabLabels(labels, liveTabIds) {
  const live = new Set(liveTabIds);
  const kept = Object.entries(labels).filter(([id]) => live.has(id));
  return kept.length === Object.keys(labels).length ? labels : freeze(Object.fromEntries(kept));
}

/**
 * What the status bar, picker and side panel show: rename > non-blank title > URL > "New Tab".
 * @param {{ label?: string | null, title?: string | null, url?: string | null }} tab
 * @returns {string}
 */
export function displayLabel({ label, title, url }) {
  if (label) return label;
  if (title && title.trim()) return title;
  if (url) return url;
  return "New Tab";
}

/**
 * Plain JSON for the snapshot's `tabLabels` field, keys sorted; undefined when there are none,
 * so a snapshot without renames is unchanged.
 * @param {TabLabels} labels
 * @returns {Record<string, string> | undefined}
 */
export function writeTabLabels(labels) {
  const keys = Object.keys(labels).sort();
  if (!keys.length) return undefined;
  return Object.fromEntries(keys.map((k) => [k, /** @type {string} */ (labels[k])]));
}

/**
 * Reads the snapshot's `tabLabels` field (undefined = no renames) leniently, so a bad label never
 * fails a session restore: entries for unknown tabs or with non-string or empty values are dropped,
 * labels that are not normalised are normalised, and each such fix is reported as a warning.
 * @param {unknown} raw
 * @param {ReadonlySet<string>} tabIds every tab in the snapshot
 * @returns {{ labels: TabLabels, warnings: TabLabelWarning[] }}
 */
export function readTabLabels(raw, tabIds) {
  /** @type {TabLabelWarning[]} */
  const warnings = [];
  if (raw === undefined) return { labels: freeze({}), warnings };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push({ path: TAB_LABELS_FIELD, message: "not an object of tab id → label; ignored" });
    return { labels: freeze({}), warnings };
  }
  /** @type {[string, string][]} */
  const kept = [];
  for (const [id, value] of Object.entries(raw)) {
    const path = `${TAB_LABELS_FIELD}[${JSON.stringify(id)}]`;
    if (!tabIds.has(id)) {
      warnings.push({ path, message: "not a tab of this snapshot; dropped" });
      continue;
    }
    const label = typeof value === "string" ? normalizeTabLabel(value) : "";
    if (!label) {
      warnings.push({ path, message: "not a non-empty string; dropped" });
      continue;
    }
    if (label !== value) warnings.push({ path, message: "not normalised; normalised" });
    kept.push([id, label]);
  }
  return { labels: freeze(Object.fromEntries(kept)), warnings };
}
