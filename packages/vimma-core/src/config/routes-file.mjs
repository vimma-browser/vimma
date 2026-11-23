/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * routes.toml, the routes file beside config.toml (spec: docs/specs/routes-file.md). When it
 * exists, its `[[routes]]` are the rules in force and config.toml's are ignored with a warning;
 * its `[routing] default_workspace` wins over config.toml's. Rules are checked by the same
 * validateRoutes and resolveRoutes as config.toml's, so moving a rule never changes what it
 * means (decision 4). `:route add` appends here, and its first use moves config.toml's rules
 * into a new file (moveRoutesText, decision 8). Pure: the host reads and writes the files.
 */
import { parseConfig } from "./config.mjs";
import { utf8Over } from "./bookmarks-file.mjs";
import { formatPath, locateKeys, parseToml, sameTomlValue } from "./toml.mjs";
import { resolveRoutes, validateRouting, validateRoutes } from "./routes.mjs";

/** @import { ConfigError, ResolvedConfig } from "./config.mjs" */
/** @import { Route } from "./routes.mjs" */
/** @import { Path } from "./toml.mjs" */

export const ROUTES_FILE = "routes.toml";
/** Bounds the parse on the main thread; a thousand rules are under 100 KiB (decision 4). */
export const MAX_ROUTES_FILE_BYTES = 1024 * 1024;

const MOVED_NOTE = "# Moved to routes.toml by :route add; routes.toml is the routes file now.";
const BY_HAND = "move them to routes.toml by hand";

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
 * config.toml's, Behaviour 5), or null when routes.toml does not exist.
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
  if (file.defaultWorkspace !== null && inline.defaultWorkspace !== null) {
    warnings.push({
      line: inline.defaultWorkspace,
      path: "",
      message: "routing.default_workspace ignored: routes.toml sets it",
    });
  }
  warnings.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return {
    file: ROUTES_FILE,
    routes: file.routes ?? [],
    lines: file.routes ? file.lines : [],
    defaultWorkspace: file.defaultWorkspace ?? config.routing.defaultWorkspace,
    warnings,
  };
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
 * anything else is no rule.
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
  if (Array.isArray(v)) return { file: "config.toml", routes: v };
  if (!isTable(v) || !Array.isArray(v.routes)) return none;
  if (v.file !== ROUTES_FILE && v.file !== "config.toml") return none;
  return { file: v.file, routes: v.routes };
}

/** @param {{ domain: string, workspace: string }} rule */
const ruleBlock = ({ domain, workspace }) =>
  `[[routes]]\ndomain = ${JSON.stringify(domain)}\nworkspace = ${JSON.stringify(workspace)}\n`;

/**
 * `:route add` into routes.toml (Behaviour 8): the block to append, or the file to create when
 * it is missing (`text` null). Refused with the reason, nothing to write, when the file does not
 * parse now or would not with the rule. JSON's quoting is TOML's for these values, so a name
 * stays one string.
 * @param {string | null} text
 * @param {{ domain: string, workspace: string }} rule
 * @returns {{ append: string } | { create: string } | { error: string }}
 */
export function appendRouteFileText(text, rule) {
  const block = ruleBlock(rule);
  if (text !== null && parseRoutesFile(text).errors.length) {
    return { error: `${ROUTES_FILE} does not parse now; fix it first` };
  }
  const base = text ?? "";
  const glue = base === "" ? "" : base.endsWith("\n") ? "\n" : "\n\n";
  const added = `${glue}${block}`;
  const first = parseRoutesFile(base + added).errors[0];
  if (first) {
    return {
      error: `${ROUTES_FILE} does not parse with the rule added: ${first.path ? `${first.path}: ` : ""}${first.message}`,
    };
  }
  return text === null ? { create: added } : { append: added };
}

/**
 * The table headers of a TOML text that parsed: their 0-based line and name. Lines inside a
 * multi-line string are skipped. The caller checks its result by parsing, so a text this scan
 * misreads is refused, never written.
 * @param {string[]} lines
 * @returns {{ at: number, name: string, array: boolean }[]}
 */
function headers(lines) {
  /** @type {{ at: number, name: string, array: boolean }[]} */
  const out = [];
  /** @type {string | null} */
  let open = null;
  lines.forEach((line, at) => {
    if (open === null) {
      const m = /^\s*(\[\[?)\s*([^\]#]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
      if (m) out.push({ at, name: /** @type {string} */ (m[2]), array: m[1] === "[[" });
    }
    for (const delim of line.match(/"""|'''/g) ?? []) {
      if (open === null) open = delim;
      else if (open === delim) open = null;
    }
  });
  return out;
}

/** @param {string} line */
const isComment = (line) => line.trimStart().startsWith("#");
/** @param {string} line */
const isBlank = (line) => line.trim() === "";

/**
 * The first `:route add` with config.toml's rules and no routes.toml (Behaviour 9, decision 8):
 * the new routes.toml (config.toml's `default_workspace` under `[routing]`, then each
 * `[[routes]]` table as written, with the comments inside it and directly above its header,
 * then the new rule) and config.toml with every moved line commented out under one note.
 * Checked before it is returned: routes.toml resolves to config.toml's rules plus the new one,
 * in order, with the same default, and config.toml loads with nothing else changed.
 * @param {string} configText
 * @param {{ domain: string, workspace: string }} rule
 * @param {{ mac?: boolean }} [options]  check config.toml with macOS's default keys
 * @returns {{ routes: string, config: string, moved: { rules: number, defaultWorkspace: boolean } }
 *   | { error: string }}
 */
export function moveRoutesText(configText, rule, { mac = false } = {}) {
  const before = parseConfig(configText, { mac });
  const parsed = parseToml(configText, { integersAsBigInt: true });
  if (before.errors.length || !before.config || !parsed.ok) {
    return { error: "config.toml does not parse now; fix it first (:config shows it)" };
  }
  const raw = parsed.value;
  const lines = configText.split("\n");
  const heads = headers(lines);
  const ruleCount = Array.isArray(raw.routes) ? raw.routes.length : 0;
  const routeHeads = heads.filter((h) => h.array && h.name === "routes");
  if (raw.routes !== undefined && routeHeads.length === 0) {
    return { error: `config.toml's routes are an inline array; ${BY_HAND}` };
  }
  const unsafe = { error: `config.toml's routes could not be moved safely; ${BY_HAND}` };
  if (routeHeads.length !== ruleCount) return unsafe;

  /** 0-based lines to comment out in config.toml. @type {Set<number>} */
  const out = new Set();
  /** @type {string[]} */
  const parts = [];

  const routing = isTable(raw.routing) ? raw.routing : null;
  const hasDefault = routing?.default_workspace !== undefined;
  if (hasDefault) {
    const head = heads.find((h) => !h.array && h.name === "routing");
    if (!head) {
      return {
        error: `config.toml's default_workspace is not under a [routing] header; ${BY_HAND}`,
      };
    }
    const at = (locateKeys(configText)(["routing", "default_workspace"]) ?? 0) - 1;
    const next = heads.find((h) => h.at > head.at)?.at ?? lines.length;
    const line = lines[at] ?? "";
    if (at <= head.at || at >= next || !/^\s*default_workspace\s*=/.test(line)) return unsafe;
    parts.push(`[routing]\n${line}\n`);
    out.add(at);
    if (Object.keys(/** @type {Record<string, unknown>} */ (routing)).length === 1) {
      out.add(head.at);
    }
  }

  let floor = 0;
  for (const head of routeHeads) {
    const next = heads.find((h) => h.at > head.at)?.at ?? lines.length;
    let end = next - 1;
    while (end > head.at && (isBlank(lines[end] ?? "") || isComment(lines[end] ?? ""))) end--;
    let start = head.at;
    while (start - 1 >= floor && isComment(lines[start - 1] ?? "")) start--;
    floor = end + 1;
    parts.push(`${lines.slice(start, end + 1).join("\n")}\n`);
    for (let i = start; i <= end; i++) if (!isBlank(lines[i] ?? "")) out.add(i);
  }
  parts.push(ruleBlock(rule));
  const routesText = parts.join("\n");

  const first = Math.min(...out);
  const configOut = lines.flatMap((line, i) => {
    const kept = out.has(i) ? `# ${line}` : line;
    return i === first ? [MOVED_NOTE, kept] : [kept];
  });
  const newConfig = out.size ? configOut.join("\n") : configText;

  // The check of decision 8: nothing dropped, reordered or changed, in either file.
  const file = parseRoutesFile(routesText);
  const expected = [...before.config.routes, ...resolveRoutes([rule])].map((r, i) => ({
    ...r,
    index: i + 1,
  }));
  if (
    !file.routes ||
    JSON.stringify(file.routes) !== JSON.stringify(expected) ||
    file.defaultWorkspace !== before.config.routing.defaultWorkspace
  ) {
    return unsafe;
  }
  const after = parseConfig(newConfig, { mac });
  const rawAfter = parseToml(newConfig, { integersAsBigInt: true });
  if (after.errors.length || !rawAfter.ok || !sameTomlValue(rest(raw), rest(rawAfter.value))) {
    return unsafe;
  }
  return {
    routes: routesText,
    config: newConfig,
    moved: { rules: ruleCount, defaultWorkspace: hasDefault },
  };
}

/**
 * A parsed config.toml without its routes and default workspace (and a `[routing]` left
 * empty), to compare what a move leaves.
 * @param {Record<string, unknown>} raw
 */
function rest(raw) {
  const out = { ...raw };
  delete out.routes;
  if (isTable(out.routing)) {
    const routing = { ...out.routing };
    delete routing.default_workspace;
    if (Object.keys(routing).length) out.routing = routing;
    else delete out.routing;
  }
  return out;
}
