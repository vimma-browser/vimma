/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The add-on picker (`prefix+e`, `:addons`) and `:addon <name>` (docs/specs/addon-manager.md):
 * which add-ons are listed, a row's text, the best name match and the remove question with its
 * stale-answer check. The host reads AddonManager into AddonRecords; nothing here knows Firefox.
 */
import { filterItems } from "./picker.mjs";

/**
 * What the host reads from one AddonManager add-on.
 * @typedef {object} AddonRecord
 * @property {string} id
 * @property {string} name
 * @property {string} version
 * @property {string} type           "extension", "theme", "dictionary", ...
 * @property {boolean} enabled       not user-disabled (it may still be inactive: blocked)
 * @property {boolean} isSystem
 * @property {boolean} isBuiltin
 * @property {boolean} hidden
 * @property {boolean} privateAllowed may run in private windows
 * @property {boolean} update        an update is waiting
 */
/**
 * @typedef {object} AddonItem
 * @property {"addon"} kind
 * @property {string} addonId
 * @property {string} display  the name
 * @property {string} version
 * @property {boolean} enabled
 * @property {boolean} privateAllowed
 * @property {boolean} update
 * @property {boolean} active  never: no add-on is "the current one"
 */

/**
 * Listed: an extension that is not a system, built-in or hidden add-on (spec decision 3).
 * @param {AddonRecord} a
 */
export function isListedAddon(a) {
  return a.type === "extension" && !a.isSystem && !a.isBuiltin && !a.hidden;
}

/**
 * The picker's rows: the listed add-ons, by name (case-insensitive), then id.
 * @param {readonly AddonRecord[]} records
 * @returns {AddonItem[]}
 */
export function addonItems(records) {
  const key = (/** @type {AddonRecord} */ a) => a.name.toLocaleLowerCase();
  return records
    .filter(isListedAddon)
    .sort((a, b) => key(a).localeCompare(key(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((a) =>
      Object.freeze({
        kind: /** @type {const} */ ("addon"),
        addonId: a.id,
        display: a.name,
        version: a.version,
        enabled: a.enabled,
        privateAllowed: a.privateAllowed,
        update: a.update,
        active: false,
      }),
    );
}

/**
 * The row's right-hand cell: `1.2 · enabled · private ok · update`.
 * @param {AddonItem} item
 */
export function addonRowText(item) {
  return [
    item.version,
    item.enabled ? "enabled" : "disabled",
    ...(item.privateAllowed ? ["private ok"] : []),
    ...(item.update ? ["update"] : []),
  ].join(" · ");
}

/**
 * `:addon <name>`: the best fuzzy match by name among the listed add-ons, or null.
 * @param {readonly AddonItem[]} items
 * @param {string} query
 * @returns {AddonItem | null}
 */
export function bestAddon(items, query) {
  if (!query.trim()) return null;
  const best = filterItems(items, query)[0];
  return best ? /** @type {AddonItem} */ (best.item) : null;
}

/**
 * The y/N question `d` asks.
 * @param {AddonItem} item
 */
export function removeAddonQuestion(item) {
  return `remove "${item.display}" ${item.version}? (y/N)`;
}

/**
 * Whether the add-on is no longer the one the user answered yes for: gone, renamed, or another
 * version (an update landed). Enabling it or its private access do not count.
 * @param {AddonItem} asked
 * @param {AddonItem | null | undefined} now
 */
export function addonChanged(asked, now) {
  return !now || now.display !== asked.display || now.version !== asked.version;
}
