/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * routes.toml, the routes file beside config.toml (spec: docs/specs/routes-file.md). When it
 * exists, its `[[routes]]` and `[routing]` are the ones in force and config.toml's are ignored
 * with a warning. Rules are checked by the same validateRoutes and resolveRoutes as
 * config.toml's, so moving a rule never changes what it means (decision 4). `:route add`
 * appends to whichever file is the routes file. Pure: the host reads and writes the files.
 */
import { utf8Over } from "./bookmarks-file.mjs";
import { formatPath, locateKeys, parseToml } from "./toml.mjs";
import { resolveRoutes, routeBlockFor, validateRouting, validateRoutes } from "./routes.mjs";

/** @import { ConfigError, ResolvedConfig } from "./config.mjs" */
/** @import { Route } from "./routes.mjs" */
/** @import { Path } from "./toml.mjs" */

export const ROUTES_FILE = "routes.toml";
/** Bounds the parse on the main thread; a thousand rules are under 100 KiB (decision 4). */
export const MAX_ROUTES_FILE_BYTES = 1024 * 1024;

/**
 * @typedef {object} RoutesFile
 * @property {Route[] | null} routes   null when the file has errors
 * @property {string | null} defaultWorkspace
 * @property {number[]} lines          each rule's line, 1-based
 * @property {ConfigError[]} errors    each with `file: "routes.toml"`, in file order
 */

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isTable = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);

/**
 * routes.toml's text, read as config.toml's `[[routes]]` and `[routing]` are (Behaviour 2).
 * @param {string} text
 * @returns {RoutesFile}
 */
export function parseRoutesFile(text) {
  /** @param {ConfigError[]} errors @returns {RoutesFile} */
  const failed = (errors) => ({ routes: null, defaultWorkspace: null, lines: [], errors });
  if (utf8Over(text, MAX_ROUTES_FILE_BYTES)) {
    return failed([{ file: ROUTES_FILE, path: "", message: "larger than 1 MiB; not read" }]);
  }
  const parsed = parseToml(text, { integersAsBigInt: true });
  if (!parsed.ok) return failed([{ file: ROUTES_FILE, path: "", ...parsed.error }]);
  const raw = parsed.value;
  /** @type {{ path: Path, message: string, suggestion?: string }[]} */
  const problems = [];
  for (const key of Object.keys(raw)) {
    if (key !== "routes" && key !== "routing") {
      problems.push({ path: [key], message: "routes.toml holds only [[routes]] and [routing]" });
    }
  }
  if (raw.routes !== undefined) {
    for (const p of validateRoutes(raw.routes))
      problems.push({ ...p, path: ["routes", ...p.path] });
  }
  if (raw.routing !== undefined) {
    for (const p of validateRouting(raw.routing)) {
      problems.push({ ...p, path: ["routing", ...p.path] });
    }
  }
  const lineOf = locateKeys(text);
  if (problems.length) {
    return failed(
      problems
        .map(({ path, message, suggestion }) => {
          const line = lineOf(path);
          return {
            file: ROUTES_FILE,
            ...(line === undefined ? {} : { line }),
            path: formatPath(path),
            message,
            ...(suggestion ? { suggestion } : {}),
          };
        })
        .sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity)),
    );
  }
  const rules = /** @type {Record<string, string>[]} */ (raw.routes ?? []);
  const routing = /** @type {{ default_workspace?: string } | undefined} */ (raw.routing);
  return {
    routes: resolveRoutes(rules),
    defaultWorkspace: routing?.default_workspace ?? null,
    lines: rules.map((_, i) => lineOf(["routes", i]) ?? 0),
    errors: [],
  };
}

/**
 * The first line of config.toml's `routes` (tables or an inline array) and of its
 * `[routing] default_workspace`, null for what it does not have or a text that does not parse:
 * where the warnings of Behaviours 3 and 4 point.
 * @param {string} text
 * @returns {{ routes: number | null, defaultWorkspace: number | null }}
 */
export function inlineRoutes(text) {
  const parsed = parseToml(text, { integersAsBigInt: true });
  if (!parsed.ok) return { routes: null, defaultWorkspace: null };
  const raw = parsed.value;
  const lineOf = locateKeys(text);
  const routes = raw.routes === undefined ? null : (lineOf(["routes", 0]) ?? null);
  const defaultWorkspace =
    isTable(raw.routing) && raw.routing.default_workspace !== undefined
      ? (lineOf(["routing", "default_workspace"]) ?? null)
      : null;
  return { routes, defaultWorkspace };
}

/**
 * The rules and default workspace in force (Behaviours 3 to 6). `file` is routes.toml as last
 * read well (its `routes` null when no read has succeeded yet: then no rule applies, never
 * config.toml's, Behaviour 5), or null when routes.toml does not exist. routes.toml owns all of
 * `[routing]`: config.toml's `default_workspace` never stands in for it (decision 3).
 * @param {{ config: ResolvedConfig, configText: string, file: RoutesFile | null,
 *   configFile?: string }} input  `configText`: the text `config` was read from; `configFile`:
 *   its name (a `:source <file>` one), for about:vimma
 * @returns {{ file: string, routes: Route[], lines: number[], defaultWorkspace: string | null,
 *   warnings: ConfigError[] }}  `warnings` are about `configText`
 */
export function routesInForce({ config, configText, file, configFile = "config.toml" }) {
  if (!file) {
    const parsed = parseToml(configText, { integersAsBigInt: true });
    const lineOf = parsed.ok ? locateKeys(configText) : () => undefined;
    return {
      file: configFile,
      routes: config.routes,
      lines: config.routes.map((_, i) => lineOf(["routes", i]) ?? 0),
      defaultWorkspace: config.routing.defaultWorkspace,
      warnings: [],
    };
  }
  const inline = inlineRoutes(configText);
  /** @type {ConfigError[]} */
  const warnings = [];
  if (inline.routes !== null) {
    warnings.push({
      line: inline.routes,
      path: "",
      message: "routes ignored: routes.toml is the routes file",
    });
  }
  if (inline.defaultWorkspace !== null) {
    warnings.push({
      line: inline.defaultWorkspace,
      path: "",
      message: "routing.default_workspace ignored: routes.toml is the routes file",
    });
  }
  warnings.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return {
    file: ROUTES_FILE,
    routes: file.routes ?? [],
    lines: file.routes ? file.lines : [],
    defaultWorkspace: file.defaultWorkspace,
    warnings,
  };
}

/**
 * A cached rule as resolveRoutes made it: `index` and `workspace`, a `domain` table, and
 * string `url` and `app` when present.
 * @param {unknown} r
 * @returns {r is Route}
 */
function isCachedRoute(r) {
  if (!isTable(r) || typeof r.index !== "number" || typeof r.workspace !== "string") return false;
  const d = r.domain;
  if (d !== undefined) {
    if (!isTable(d) || typeof d.host !== "string") return false;
    if (typeof d.sub !== "boolean" || typeof d.ip !== "boolean") return false;
  }
  return [r.url, r.app].every((x) => x === undefined || typeof x === "string");
}

/**
 * `vimma.routes.cache`'s text: the rules in force and the file they came from, so that a cold
 * start routes before the files are read, and a routes.toml broken since the last session keeps
 * its own last good rules, never config.toml's (Behaviour 5). Any file but routes.toml is
 * recorded as config.toml (a `:source <file>` one included).
 * @param {readonly Route[]} routes
 * @param {string} file
 */
export function formatRoutesCache(routes, file) {
  return JSON.stringify({ file: file === ROUTES_FILE ? ROUTES_FILE : "config.toml", routes });
}

/**
 * The cache formatRoutesCache wrote; an older one, a bare array, holds config.toml's rules;
 * anything else is no rule. An entry that is not a rule's shape is dropped, so that a damaged
 * pref never reaches matching.
 * @param {string} text
 * @returns {{ file: string, routes: Route[] }}
 */
export function parseRoutesCache(text) {
  const none = { file: "config.toml", routes: [] };
  /** @type {unknown} */
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return none;
  }
  if (Array.isArray(v)) return { file: "config.toml", routes: v.filter(isCachedRoute) };
  if (!isTable(v) || !Array.isArray(v.routes)) return none;
  if (v.file !== ROUTES_FILE && v.file !== "config.toml") return none;
  return { file: v.file, routes: v.routes.filter(isCachedRoute) };
}

/**
 * `:route add` while routes.toml is the routes file (Behaviour 8): the block to append, in the
 * file's line endings. Refused with the reason, nothing to write, when the file does not parse
 * now or would not with the rule.
 * @param {string} text  routes.toml as it is
 * @param {{ domain: string, workspace: string }} rule
 * @returns {{ append: string } | { error: string }}
 */
export function appendRouteFileText(text, rule) {
  if (parseRoutesFile(text).errors.length) {
    return { error: `${ROUTES_FILE} does not parse now; fix it first` };
  }
  const added = routeBlockFor(text, rule);
  const first = parseRoutesFile(text + added).errors[0];
  if (first) {
    return {
      error: `${ROUTES_FILE} does not parse with the rule added: ${first.path ? `${first.path}: ` : ""}${first.message}`,
    };
  }
  return { append: added };
}
