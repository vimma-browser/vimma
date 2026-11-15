/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * `[search]` in config.toml (docs/specs/search-engines.md): the default engine and `@alias`
 * keywords. Validation and resolving are called by config.mjs; `planSearch` is the pure
 * reconcile the host runs against the profile's engines; `searchCompletions` feeds `:open @`.
 * Core imports nothing from Firefox: the host passes the engines in.
 */
import { closest } from "../keys/actions.mjs";

/** @import { Path } from "./toml.mjs" */

/**
 * @typedef {{ alias: string, kind: "engine", name: string }
 *   | { alias: string, kind: "template", url: string, host: string }} SearchAlias
 *   `alias` without its `@`; a template's `url` in Firefox's form (`{searchTerms}`)
 */
/**
 * @typedef {object} ResolvedSearch
 * @property {{ kind: "engine", name: string } | { kind: "template", alias: string } | null}
 *   default
 * @property {SearchAlias[]} aliases  sorted by alias
 */
/**
 * One of the profile's engines, as the host reads it from SearchService.
 * @typedef {object} InstalledEngine
 * @property {string} id
 * @property {string} name
 * @property {string} alias     the user alias (`engine.alias`, "Keyword" in Settings), "" for none
 * @property {string[]} aliases every alias the engine answers to, the user's included
 * @property {boolean} hidden   removed in Settings
 * @property {string} [url]     a user engine's search URL, `{searchTerms}` in it
 */
/**
 * What Vimma applied last, kept per profile (decision 6).
 * @typedef {object} SearchState
 * @property {{ alias: string, id: string | null, name: string, url: string }[]} created
 *   engines Vimma made from templates; `id` is null until the host has made it
 * @property {{ alias: string, id: string, replaced: string }[]} aliased
 *   installed engines Vimma gave a user alias, with the one it replaced
 * @property {{ set: string | null, previous: string } | null} default
 *   the engine Vimma made the default (null: one it is creating) and the one before
 */
/**
 * @typedef {{ op: "create", alias: string, name: string, url: string }
 *   | { op: "update", id: string, url: string }
 *   | { op: "rename", id: string, name: string }
 *   | { op: "remove", id: string }
 *   | { op: "set-alias", id: string, alias: string }
 *   | { op: "set-default", id: string }
 *   | { op: "set-default", created: string }} SearchStep
 */
/** @typedef {{ path: Path, message: string, suggestion?: string }} SearchProblem */

const SEARCH_KEYS = ["default", "aliases"];
const ALIAS = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const ALIAS_MESSAGE = "an alias is a letter or digit, then up to 31 of a-z 0-9 . _ -";
const TEMPLATE_MESSAGE =
  "must be an https:// or http:// URL with one %s, or an installed engine's name";
const NAME_MESSAGE = "an engine name is 1 to 100 characters without control characters";
const MAX_NAME = 100;
// eslint-disable-next-line no-control-regex -- control characters are what it looks for
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** A value that means to be a URL (a scheme, `://` or `%s`) is checked as a template. */
const URL_LIKE = /:\/\/|%s|^[a-z][a-z0-9+.-]*:\S/i;

/** @param {string} key  as written in [search.aliases] */
export const normalizeAlias = (key) => (key.startsWith("@") ? key.slice(1) : key).toLowerCase();

/** @param {string} url  a template with one `%s` */
export const toFirefoxTemplate = (url) => url.replace("%s", "{searchTerms}");

/** @param {unknown} v */
const isTable = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** @param {unknown} v */
function typeName(v) {
  if (typeof v === "bigint") return "an integer";
  if (typeof v === "number") return "a float";
  if (typeof v === "string") return "a string";
  if (typeof v === "boolean") return "a boolean";
  if (Array.isArray(v)) return "an array";
  return "a table";
}

/**
 * A template's host, or null when it is not an http(s) URL with exactly one `%s`.
 * @param {string} value
 */
function templateHost(value) {
  if (!/^https?:\/\//i.test(value) || value.split("%s").length !== 2) return null;
  try {
    return new URL(value.replace("%s", "x")).hostname || null;
  } catch {
    return null;
  }
}

/** @param {string} name */
const isEngineName = (name) => name.length >= 1 && name.length <= MAX_NAME && !CONTROL.test(name);

/**
 * Every problem in `[search]` (schema 2), with config paths.
 * @param {Record<string, unknown>} search
 * @returns {SearchProblem[]}
 */
export function validateSearch(search) {
  /** @type {SearchProblem[]} */
  const problems = [];
  /** @param {Path} path @param {string} message @param {string} [suggestion] */
  const fail = (path, message, suggestion) =>
    problems.push(suggestion ? { path, message, suggestion } : { path, message });

  for (const key of Object.keys(search)) {
    if (!SEARCH_KEYS.includes(key))
      fail(["search", key], `unknown key "${key}"`, closest(key, SEARCH_KEYS));
  }
  /** @type {Map<string, { key: string, kind: "engine" | "template", name?: string }>} */
  const aliases = new Map();
  /** @type {Map<string, string>} engine name, lowercased → the alias key naming it */
  const engines = new Map();
  const table = search.aliases;
  if (table !== undefined && !isTable(table)) {
    fail(["search", "aliases"], `expected a table, got ${typeName(table)}`);
  } else if (table !== undefined) {
    for (const [key, v] of Object.entries(/** @type {Record<string, unknown>} */ (table))) {
      const path = ["search", "aliases", key];
      const alias = normalizeAlias(key);
      if (!ALIAS.test(alias)) {
        fail(path, ALIAS_MESSAGE);
        continue;
      }
      const same = aliases.get(alias);
      if (same) {
        fail(path, `same alias as "${same.key}"`);
        continue;
      }
      if (typeof v !== "string") {
        fail(path, `expected a string, got ${typeName(v)}`);
        continue;
      }
      if (URL_LIKE.test(v)) {
        if (templateHost(v) === null) fail(path, TEMPLATE_MESSAGE);
        else aliases.set(alias, { key, kind: "template" });
        continue;
      }
      if (!isEngineName(v)) {
        fail(path, NAME_MESSAGE);
        continue;
      }
      const first = engines.get(v.toLowerCase());
      if (first !== undefined) {
        fail(path, `names the same engine as "${first}": an engine has one alias`);
        continue;
      }
      engines.set(v.toLowerCase(), key);
      aliases.set(alias, { key, kind: "engine", name: v });
    }
  }

  const d = search.default;
  const path = ["search", "default"];
  if (d === undefined) return problems;
  if (typeof d !== "string") fail(path, `expected a string, got ${typeName(d)}`);
  else if (d.startsWith("@")) {
    const alias = normalizeAlias(d);
    const target = aliases.get(alias);
    if (!target) {
      const near = closest(alias, [...aliases.keys()]);
      fail(path, `no alias "${alias}" in [search.aliases]`, near ? `@${near}` : undefined);
    } else if (target.kind === "engine") {
      fail(path, `"${d}" names an installed engine: write its name, "${target.name}"`);
    }
  } else if (!isEngineName(d)) fail(path, NAME_MESSAGE);
  return problems;
}

/**
 * `[search]` as config.mjs hands it on; null when the file has no `[search]`.
 * @param {{ default?: string, aliases?: Record<string, string> } | undefined} search  valid
 * @returns {ResolvedSearch | null}
 */
export function resolveSearch(search) {
  if (!search) return null;
  const aliases = Object.entries(search.aliases ?? {})
    .map(([key, value]) => {
      const alias = normalizeAlias(key);
      const host = URL_LIKE.test(value) ? templateHost(value) : null;
      return /** @type {SearchAlias} */ (
        host === null
          ? { alias, kind: "engine", name: value }
          : { alias, kind: "template", url: toFirefoxTemplate(value), host }
      );
    })
    .sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));
  const d = search.default;
  return {
    default:
      d === undefined
        ? null
        : d.startsWith("@")
          ? { kind: "template", alias: normalizeAlias(d) }
          : { kind: "engine", name: d },
    aliases,
  };
}

/**
 * The steps that make the profile's engines match `next`, given what Vimma applied last
 * (`previous`), and the problems only the installed engines reveal (decision 9). Steps run in
 * order: the default goes back before the engine it was is removed, and an alias is freed
 * before another engine takes it.
 * @param {SearchState | null} previous
 * @param {ResolvedSearch | null} next
 * @param {{ engines: readonly InstalledEngine[], defaultId: string }} profile
 * @returns {{ steps: SearchStep[], problems: SearchProblem[], state: SearchState | null }}
 */
export function planSearch(previous, next, { engines, defaultId }) {
  /** @type {SearchStep[]} */
  const restoreDefault = [];
  /** @type {SearchStep[]} */
  const removals = [];
  /** @type {SearchStep[]} */
  const restores = [];
  /** @type {SearchStep[]} */
  const changes = [];
  /** @type {SearchStep[]} */
  const setDefault = [];
  /** @type {SearchProblem[]} */
  const problems = [];
  const byId = new Map(engines.map((e) => [e.id, e]));
  const visible = engines.filter((e) => !e.hidden);
  const created = previous?.created ?? [];
  const aliased = previous?.aliased ?? [];
  const managedIds = new Set(created.map((c) => c.id));
  const aliases = next?.aliases ?? [];
  const wantedTemplates = new Set(aliases.filter((a) => a.kind === "template").map((a) => a.alias));

  /** @type {SearchState} */
  const state = { created: [], aliased: [], default: null };

  /**
   * The engine `@alias` already belongs to, other than `self` and other than through Vimma.
   * @param {string} alias
   * @param {string | null} self
   */
  const holder = (alias, self) => {
    const at = `@${alias}`;
    return engines.find((e) => {
      if (e.id === self || managedIds.has(e.id)) return false;
      if (!e.aliases.some((a) => a.toLowerCase() === at)) return false;
      const ours = aliased.some((x) => x.id === e.id && `@${x.alias}` === e.alias.toLowerCase());
      return !(ours && e.alias.toLowerCase() === at);
    });
  };

  /**
   * An engine by name (exact, else case-insensitive), or the problem with it.
   * @param {string} name
   * @param {Path} path
   * @returns {InstalledEngine | null}
   */
  const findEngine = (name, path) => {
    const lower = name.toLowerCase();
    const found =
      engines.find((e) => e.name === name) ?? engines.find((e) => e.name.toLowerCase() === lower);
    if (found && !found.hidden) return found;
    if (found) {
      problems.push({
        path,
        message: `"${found.name}" is removed in Settings: Restore Default Search Engines there`,
      });
    } else {
      const near = closest(
        name,
        visible.map((e) => e.name),
      );
      problems.push({
        path,
        message: `no search engine named "${name}"`,
        ...(near ? { suggestion: near } : {}),
      });
    }
    return null;
  };

  // Templates: Vimma's own engines.
  const taken = new Set(
    engines.filter((e) => !managedIds.has(e.id)).map((e) => e.name.toLowerCase()),
  );
  /** @type {Map<string, string | null>} alias → the engine's id (null: being created) */
  const templateIds = new Map();
  for (const a of aliases) {
    if (a.kind !== "template") continue;
    const path = ["search", "aliases", a.alias];
    const name = taken.has(a.host.toLowerCase()) ? `${a.host} (@${a.alias})` : a.host;
    taken.add(name.toLowerCase());
    const prev = created.find((c) => c.alias === a.alias);
    const eng = prev?.id ? byId.get(prev.id) : undefined;
    if (eng) {
      if (eng.url !== a.url) changes.push({ op: "update", id: eng.id, url: a.url });
      if (eng.name !== name) changes.push({ op: "rename", id: eng.id, name });
      if (eng.alias !== `@${a.alias}`)
        changes.push({ op: "set-alias", id: eng.id, alias: `@${a.alias}` });
      state.created.push({ alias: a.alias, id: eng.id, name, url: a.url });
      templateIds.set(a.alias, eng.id);
      continue;
    }
    const other = holder(a.alias, null);
    if (other) {
      problems.push({ path, message: `@${a.alias} is already ${other.name}'s alias` });
      continue;
    }
    changes.push({ op: "create", alias: a.alias, name, url: a.url });
    state.created.push({ alias: a.alias, id: null, name, url: a.url });
    templateIds.set(a.alias, null);
  }
  for (const c of created) {
    if (wantedTemplates.has(c.alias) && templateIds.has(c.alias)) continue;
    if (c.id && byId.has(c.id)) removals.push({ op: "remove", id: c.id });
  }

  // Aliases on installed engines.
  /** @type {Set<string>} "alias id" pairs kept */
  const kept = new Set();
  for (const a of aliases) {
    if (a.kind !== "engine") continue;
    const path = ["search", "aliases", a.alias];
    const eng = findEngine(a.name, path);
    if (!eng) continue;
    const other = holder(a.alias, eng.id);
    if (other) {
      problems.push({ path, message: `@${a.alias} is already ${other.name}'s alias` });
      continue;
    }
    const prev = aliased.find((x) => x.alias === a.alias && x.id === eng.id);
    if (eng.alias !== `@${a.alias}`)
      changes.push({ op: "set-alias", id: eng.id, alias: `@${a.alias}` });
    state.aliased.push({ alias: a.alias, id: eng.id, replaced: prev ? prev.replaced : eng.alias });
    kept.add(`${a.alias} ${eng.id}`);
  }
  for (const x of aliased) {
    if (kept.has(`${x.alias} ${x.id}`)) continue;
    const eng = byId.get(x.id);
    if (eng && eng.alias === `@${x.alias}`)
      restores.push({ op: "set-alias", id: x.id, alias: x.replaced });
  }

  // The default.
  const wanted = next?.default ?? null;
  const before = previous?.default ?? null;
  if (wanted) {
    const path = ["search", "default"];
    /** @type {string | null | undefined} undefined: not settable now */
    let target;
    if (wanted.kind === "engine") target = findEngine(wanted.name, path)?.id;
    else if (templateIds.has(wanted.alias)) target = templateIds.get(wanted.alias);
    if (target === undefined) state.default = before;
    else {
      if (target === null && wanted.kind === "template") {
        setDefault.push({ op: "set-default", created: wanted.alias });
      } else if (target !== null && target !== defaultId)
        setDefault.push({ op: "set-default", id: target });
      state.default = { set: target, previous: before ? before.previous : defaultId };
    }
  } else if (before) {
    const prev = byId.get(before.previous);
    if (defaultId === before.set && prev && !prev.hidden && before.previous !== defaultId) {
      restoreDefault.push({ op: "set-default", id: before.previous });
    }
  }

  const empty = !state.created.length && !state.aliased.length && !state.default;
  return {
    steps: [...restoreDefault, ...removals, ...restores, ...changes, ...setDefault],
    problems: problems.sort((a, b) =>
      String(a.path[2] ?? "").localeCompare(String(b.path[2] ?? "")),
    ),
    state: empty && !next ? null : state,
  };
}

/**
 * The aliases about:vimma lists (decision 14): those the last apply recorded, so an alias it
 * skipped (an engine not installed, an alias already taken) shows only as its error.
 * @param {readonly SearchAlias[]} aliases  `[search.aliases]`, resolved
 * @param {SearchState | null} state  what the last apply recorded
 * @returns {SearchAlias[]}
 */
export function appliedAliases(aliases, state) {
  if (!state) return [];
  const made = new Set(state.created.map((c) => c.alias));
  const given = new Set(state.aliased.map((x) => x.alias));
  return aliases.filter((a) => (a.kind === "template" ? made : given).has(a.alias));
}

/**
 * The aliases `:open @` completes, from the host's list (Vimma's and Firefox's own).
 * @param {readonly { alias: string, engine: string }[]} list  `alias` with its `@`
 * @returns {{ name: string, description: string }[]}
 */
export function searchCompletions(list) {
  return list
    .filter((e) => e.alias.startsWith("@"))
    .map((e) => ({ name: e.alias.toLowerCase(), description: e.engine }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const STATE_PREF_NAME = "vimma.search.applied";

/**
 * The state the host recorded (decision 6), read back from its pref. Anything not in the shape
 * Vimma writes is discarded whole, with the reason: a hand-edited or corrupt value must neither
 * stop `[search]` from applying nor name engines for Vimma to remove.
 * @param {string} text  the pref's value; "" when unset
 * @returns {{ state: SearchState | null, problem?: string }}
 */
export function parseSearchState(text) {
  if (text === "" || text === "null") return { state: null };
  /** @param {string} why */
  const bad = (why) => ({ state: null, problem: `${STATE_PREF_NAME} ${why}; discarded` });
  /** @type {unknown} */
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return bad("is not JSON");
  }
  const isString = (/** @type {unknown} */ x) => typeof x === "string";
  /** @param {unknown} x @param {string[]} keys */
  const record = (x, keys) =>
    isTable(x) && keys.every((k) => isString(/** @type {Record<string, unknown>} */ (x)[k]));
  if (!isTable(v)) return bad("is not an object");
  const { created, aliased, default: d } = /** @type {Record<string, unknown>} */ (v);
  if (!Array.isArray(created) || !created.every((c) => record(c, ["alias", "id", "name", "url"]))) {
    return bad('has a malformed "created" list');
  }
  if (!Array.isArray(aliased) || !aliased.every((a) => record(a, ["alias", "id", "replaced"]))) {
    return bad('has a malformed "aliased" list');
  }
  if (d !== null && !record(d, ["set", "previous"])) return bad('has a malformed "default"');
  return { state: /** @type {SearchState} */ (v) };
}
