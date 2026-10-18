/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The binding table behind `prefix+?`, `:map` and docs/bindings.md. Rendered from the same
 * compiled keymap the dispatcher uses, so help cannot drift from behaviour.
 */
import { ACTIONS, isRunnable } from "./actions.mjs";
import { displayKey } from "./keys.mjs";
import { MODES, isMode } from "./modes.mjs";

/** @import { Keymap } from "./keymap.mjs" */
/**
 * @typedef {object} BindingRow
 * @property {string} id
 * @property {string} name
 * @property {string} group
 * @property {string} description
 * @property {string[]} bindings  the keys a user presses (keymap.keysFor), not config notation
 * @property {boolean} overridden
 * @property {boolean} runnable     false greys the row out (see isRunnable)
 */

/** The overlay group of the Firefox keys `[firefox] enable` keeps on. */
export const FIREFOX_ON_GROUP = "Firefox (on in config.toml)";

/**
 * @param {Keymap} keymap
 * @param {{ runnable?: ReadonlySet<string>,
 *   firefox?: readonly { chord: string, id: string, label: string }[] }} [options]
 *   runnable: action ids the host implements, undefined marks every row runnable (isRunnable's
 *   default); firefox: the window's Firefox keys that are on, from the host, last
 *   (docs/specs/firefox-keys.md decision 9)
 * @returns {BindingRow[]}
 */
export function bindingTable(keymap, { runnable, firefox = [] } = {}) {
  /** @type {BindingRow[]} */
  const commands = keymap.commands().map((c) => ({
    id: "cmdline.run",
    name: c.name,
    group: "Commands",
    description: c.line,
    bindings: c.bindings,
    overridden: false,
    runnable: isRunnable("cmdline.run", runnable),
  }));
  /** @type {BindingRow[]} */
  const on = firefox.map((k) => ({
    id: k.id,
    name: k.id,
    group: FIREFOX_ON_GROUP,
    description: k.label,
    bindings: [k.chord],
    overridden: false,
    runnable: true,
  }));
  return [...actionRows(keymap, runnable), ...commands, ...on];
}

/**
 * @param {Keymap} keymap
 * @param {ReadonlySet<string> | undefined} runnable
 * @returns {BindingRow[]}
 */
function actionRows(keymap, runnable) {
  return ACTIONS.map((a) => ({
    id: a.id,
    name: a.name,
    group: a.group,
    description: a.description,
    bindings: keymap.keysFor(a.name),
    overridden: keymap.isOverridden(a.name),
    runnable: isRunnable(a.id, runnable),
  }));
}

/**
 * One line naming the keys `prefix` and `leader` stand for, to head a listing.
 * @param {Keymap} keymap
 * @returns {string}
 */
export function keyLegend(keymap) {
  return keymap.legend();
}

/**
 * @typedef {object} JsonKey
 * @property {string} keys      as pressed, e.g. `ctrl+b shift+t`
 * @property {string[]} chords  `keys` split on spaces: `["ctrl+b", "shift+t"]`; `gt` stays one
 * @property {string} [mode]    only on a binding limited to one mode (`esc [help]`)
 */
/**
 * @typedef {object} JsonAction
 * @property {string} name         the config.toml and `:` command name
 * @property {string} description
 * @property {JsonKey[]} keys      empty when the action has no default key
 */
/**
 * @typedef {object} BindingsJson
 * @property {1} version  bumped only when the shape changes
 * @property {string} generated
 * @property {string} prefix
 * @property {string} legend
 * @property {string[]} modes
 * @property {{ name: string, actions: JsonAction[] }[]} groups
 */

/**
 * docs/bindings.json, the machine-readable twin of docs/bindings.md that vimma.dev mirrors
 * (docs/specs/site-keys-mirror.md). Built from bindingTable, so groups and actions keep the
 * overlay's order and keys cannot disagree with it.
 * @param {Keymap} keymap
 * @returns {BindingsJson}
 */
export function bindingsJson(keymap) {
  /** @type {BindingsJson["groups"]} */
  const groups = [];
  for (const r of bindingTable(keymap)) {
    let group = groups.at(-1);
    if (group?.name !== r.group) {
      group = { name: r.group, actions: [] };
      groups.push(group);
    }
    const keys = r.bindings.map((text) => {
      const m = / \[([a-z]+)\]$/.exec(text);
      const mode = m?.[1] && isMode(m[1]) ? m[1] : undefined;
      const pressed = mode ? text.slice(0, -` [${mode}]`.length) : text;
      /** @type {JsonKey} */
      const key = { keys: pressed, chords: pressed.split(" ") };
      if (mode) key.mode = mode;
      return key;
    });
    group.actions.push({ name: r.name, description: r.description, keys });
  }
  return {
    version: 1,
    generated:
      "Generated from packages/vimma-core/src/actions.mjs and defaults.mjs by npm run gen-docs; do not edit.",
    prefix: displayKey(keymap.prefix),
    legend: keyLegend(keymap),
    modes: [...MODES],
    groups,
  };
}

/**
 * Case-insensitive substring filter over name, description and bindings.
 * @param {BindingRow[]} rows
 * @param {string} query
 * @returns {BindingRow[]}
 */
export function filterBindings(rows, query) {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) =>
    [r.name, r.description, ...r.bindings].some((s) => s.toLowerCase().includes(q)),
  );
}

/**
 * Plain-text table grouped by action group. `*` marks user overrides.
 * @param {BindingRow[]} rows
 * @returns {string}
 */
export function renderHelpText(rows) {
  const nameW = Math.max(...rows.map((r) => r.name.length));
  const keysW = Math.max(...rows.map((r) => r.bindings.join(", ").length));
  /** @type {string[]} */
  const out = [];
  let group = "";
  for (const r of rows) {
    if (r.group !== group) {
      if (group) out.push("");
      out.push(r.group);
      group = r.group;
    }
    const keys = r.bindings.length ? r.bindings.join(", ") : "(unbound)";
    out.push(
      `${r.overridden ? "*" : " "} ${r.name.padEnd(nameW)}  ${keys.padEnd(keysW)}  ${r.description}`.trimEnd(),
    );
  }
  return out.join("\n") + "\n";
}
