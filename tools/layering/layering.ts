#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The import layering of src/browser/base/content/vimma/ (ADR-026), checked by
// `npm run layering` (part of `npm run lint`) and by its own step in ci.yml. Each folder has a
// layer (layers.ts); a module may import its own folder and any folder of a lower layer, never
// one of its own layer or a higher one, eagerly or lazily, with no exception: layers.ts lists
// none, and an entry there fails the check (ADR-026, decision 5). No two modules may import each
// other eagerly, at any distance. A restricted module (the agent gate) may be imported only by
// the modules layers.ts lists for it, whatever their layer; no module may hand it on (export it,
// return it, pass it, store it, take a method of it uncalled: handOnsOf), and no Firefox patch
// may name it or build a Vimma URL from parts, so a new caller is a reviewed change. A query, a
// fragment, `.` or `..` segments, `%` escapes or the case of a URL's scheme and host do not hide
// an import; a string that names content/vimma/ without resolving is an error, and so is one
// that reaches a Vimma file through resource:// (ALIAS_ROOTS), which loads a second copy.
//
// eslint's no-restricted-imports cannot do this: it sees `import` declarations only, and most of
// these edges are chrome:// URLs passed to ChromeUtils.importESModule or to a lazy getter map.
// So each module is parsed and every string that names a Vimma module is an edge:
//
//   eager  an `import` or `export … from` declaration, a page's `<script src>`, or
//          ChromeUtils.importESModule run while the module evaluates (outside any function, in
//          a function called on the spot, a static block or a static field).
//   lazy   anything else: a defineESModuleGetters map, importESModule inside a function,
//          import(), an actor's esModuleURI, a worker's URL. Loaded on first use.
//
// A string naming vimma.js, the root window script, is not an edge outside a load position: no
// module can import a classic script.
//
// A specifier where a module is loaded must be a fixed string, so that no import escapes the
// check; a string holding only part of a Vimma URL is refused too. Type-only references
// (`@import`, `import("…")` in JSDoc) are comments and never load a module, so they are not
// edges. ADR-026, "Limits of the check", lists what it does not see. The files come from `git ls-files`, so vimma/core/ (a git-ignored copy
// that sync-core makes) is not read; imports of it are always allowed, as layer 0.
//
// Every edge outside core/ must also name a module that exists: one git tracks and jar.mn
// packages. A mistyped chrome:// URL (the parent actor's, which vimma.js passes in) fails here.
//
//   node tools/layering/layering.ts

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as espree from "espree";
import { EXCEPTIONS, LAYERS, RESTRICTED } from "./layers.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VIMMA = "src/browser/base/content/vimma/";
const URL_PREFIX = "chrome://browser/content/vimma/";
const LAYERS_FILE = "tools/layering/layers.ts";
const ADR = "ADR-026";
/** The folder of the files at the top of vimma/ (vimma.js). */
export const ROOT_FOLDER = "(root)";

export interface Edge {
  /** the importing module, relative to vimma/ */
  from: string;
  /** the imported module (or, for a URL prefix, its folder with a trailing slash) */
  to: string;
  kind: "eager" | "lazy";
  line: number;
}

/**
 * An import that crosses the layering upwards. layers.ts lists none and exceptionErrors refuses
 * one there; layerErrors and the module diagram still take a list, which their tests fill.
 */
export interface Exception {
  from: string;
  to: string;
  kind: "eager" | "lazy";
  /** why the import cannot be avoided today */
  reason: string;
  /** "stays": ADR-026 keeps it; "goes": a follow-up removes it */
  fate: "stays" | "goes";
  /** the issue that tracks its removal, for one that goes */
  issue?: number;
}

/**
 * A module only the listed modules may import, whatever their layer: the layers say which
 * folders may reach it, this says which modules do.
 */
export interface Restricted {
  /** the modules that import it today, relative to vimma/ */
  importers: string[];
  /** what adding an importer takes, for the error */
  review: string;
}

/** What one file imports, and what in it could not be read. */
export interface Scan {
  edges: Edge[];
  /** `file:line: message`, for a specifier the check cannot resolve */
  problems: string[];
  /** Where a module hands a restricted one on (handOnsOf). */
  handOns?: HandOn[];
}

/**
 * A place where a module lets a restricted module, or one of its methods, out of its own hands:
 * an export of it, or any use other than calling it, reading a getter or keeping a local alias.
 */
export interface HandOn {
  /** the module that hands it on, relative to vimma/ */
  from: string;
  /** the restricted module */
  to: string;
  line: number;
  /** what it does, as the error says it: "re-exports", "hands on", … */
  how: string;
  /**
   * For a member read without a call: the member's name ("" when computed). A getter of the
   * restricted module's exported object is data, and restrictedErrors lets it pass.
   */
  member?: string;
}

interface AstNode {
  type: string;
  loc?: { start: { line: number } };
  [key: string]: unknown;
}

const isNode = (v: unknown): v is AstNode =>
  typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

/** The URL prefixes that name a file of vimma/: its chrome:// URL and its source path URL. */
const PREFIXES = [URL_PREFIX, "moz-src:///browser/base/content/vimma/"];

/**
 * Other URLs that reach the same files. browser.manifest maps chrome://browser/content/ to
 * chrome/browser/content/browser/ of the app's omni.ja, which resource:/// and resource://app/
 * name too, and resource://gre/ reaches it in an unpackaged build. The module loader accepts
 * resource:// and keys each module by its URL, so one of these loads a second copy of the
 * module, with its own state: for the agent gate, its own questions and grants. A string with
 * `content/browser/vimma` in its path, whatever its root, is refused (ALIAS).
 */
const ALIAS_ROOTS = [
  "resource:///chrome/browser/content/browser/vimma/",
  "resource://app/chrome/browser/content/browser/vimma/",
  "resource://gre/browser/chrome/browser/content/browser/vimma/",
];
const ALIAS_PATH = "/content/browser/vimma";

const NOT_FIXED = "an import specifier is not a fixed string";
const PARTIAL = "a string names part of a Vimma module URL, not a module or a folder";
const UNRESOLVED =
  "a string names content/vimma/ but no Vimma module or folder the check can resolve";
const ALIAS =
  "names a Vimma module through a resource:// URL, which loads a second copy of it with its own state; name it by its chrome:// URL";

type Resolved = { to: string } | "partial" | "unresolved" | "alias" | null;

/** Each `%XX` escape decoded: Firefox reads an escaped path as the file it names. */
const unescape = (text: string) =>
  text.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/**
 * A specifier as the module loader keys it, near enough to compare: without a query or a
 * fragment (the same file), the scheme and host in lower case, escapes decoded and `.` and `..`
 * segments resolved. A string that is no URL keeps its dots, for posix.join to resolve.
 */
function canonical(spec: string): string {
  const bare = unescape(spec.replace(/[?#][\s\S]*$/, ""));
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)(\/.*)?$/i.exec(bare);
  if (!m) return bare;
  const [, scheme = "", host = "", path = ""] = m;
  return `${scheme.toLowerCase()}${host.toLowerCase()}${path && posix.normalize(path)}`;
}

/**
 * A canonical URL's path under vimma/, and whether it reaches it through another root than a
 * Vimma prefix (ALIAS_ROOTS); null for a URL outside vimma/.
 */
function vimmaPath(canon: string): { path: string; alias: boolean } | null {
  for (const prefix of PREFIXES)
    if (canon.startsWith(prefix)) return { path: canon.slice(prefix.length), alias: false };
  const at = /^[a-z][a-z0-9+.-]*:\/\//.test(canon) ? canon.indexOf(ALIAS_PATH) : -1;
  const rest = at < 0 ? null : canon.slice(at + ALIAS_PATH.length);
  if (rest === null || (rest !== "" && !rest.startsWith("/"))) return null;
  return { path: rest.slice(1), alias: true };
}

/**
 * What a specifier names: a Vimma module or folder (relative to vimma/), "partial" for a URL
 * cut short before its folder, "alias" for one reached through a resource:// URL (ALIAS_ROOTS),
 * or null for anything else (a Firefox module, a page, a data file). A path ending inside a
 * folder without a file extension names that folder: a base the importer appends a module name
 * to. A relative specifier counts only where a module is imported; elsewhere a string like
 * "./x.mjs" is just text.
 */
function resolveSpec(spec: string, file: string, relativeAllowed: boolean): Resolved {
  const canon = canonical(spec);
  const named = vimmaPath(canon);
  if (named?.alias) return "alias";
  let path = named ? named.path : null;
  if (path === null && relativeAllowed && (canon.startsWith("./") || canon.startsWith("../")))
    path = posix.join(posix.dirname(file), canon);
  if (path === null) return /content\/vimma\//i.test(canon) ? "unresolved" : null;
  if (path !== "") path = posix.normalize(path);
  if (path === ".." || path.startsWith("../")) return null;
  if (/\.m?js$/.test(path)) return { to: path };
  const slash = path.indexOf("/");
  if (slash < 0) return "partial";
  if (/\.[a-z0-9]+$/i.test(path.slice(slash + 1))) return null;
  return { to: path.slice(0, slash + 1) };
}

/** Every root a URL to a file of vimma/ starts with. */
const ROOTS = [...PREFIXES, ...ALIAS_ROOTS];

/**
 * Whether a path is vimma.js, the one classic script at the top of vimma/, which browser.xhtml
 * loads with `<script src>`. No module can import it, so a string that names it outside a load
 * position is not an edge; passed to `importESModule` or `import()`, it still is one. Any other
 * top-level name, a second script included, stays an edge until it is named here.
 */
const isRootScript = (path: string) => path === "vimma.js";

/** The value of a string literal, or of a template literal without `${}`; else null. */
function fixedString(node: AstNode): string | null {
  if (node.type === "Literal" && typeof node["value"] === "string") return node["value"];
  const quasis = node["quasis"];
  const expressions = node["expressions"];
  if (node.type === "TemplateLiteral" && Array.isArray(expressions) && !expressions.length) {
    const head: unknown = Array.isArray(quasis) ? quasis[0] : undefined;
    return isNode(head) ? ((head["value"] as { cooked?: string }).cooked ?? null) : null;
  }
  return null;
}

/**
 * The fixed text a computed string starts with ("" when it starts with a name or a call): the
 * head of a template literal, or the left end of a `+` chain.
 */
function leadingText(node: AstNode): string {
  const fixed = fixedString(node);
  if (fixed !== null) return fixed;
  if (node.type === "TemplateLiteral") {
    const quasis = node["quasis"];
    const head: unknown = Array.isArray(quasis) ? quasis[0] : undefined;
    return isNode(head) ? ((head["value"] as { cooked?: string }).cooked ?? "") : "";
  }
  const left = node["left"];
  if (node.type === "BinaryExpression" && node["operator"] === "+" && isNode(left))
    return leadingText(left);
  return "";
}

/** True when a computed specifier may name a Vimma module: it does not start with another URL. */
function mayBeVimma(node: AstNode): boolean {
  const text = leadingText(node);
  const lower = text.toLowerCase();
  if (ROOTS.some((p) => lower.startsWith(p) || (text.length > 0 && p.startsWith(lower))))
    return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && vimmaPath(canonical(text))) return true;
  return !/^[a-z-]+:\/\//.test(text);
}

const isFunction = (n: AstNode) =>
  n.type === "FunctionExpression" ||
  n.type === "ArrowFunctionExpression" ||
  n.type === "FunctionDeclaration";

/**
 * Every edge from one module to another Vimma module, in source order, and every specifier it
 * cannot read. An import that runs while the module evaluates is eager: a declaration, and
 * ChromeUtils.importESModule outside any function, in a function called on the spot, in a
 * static block or in a static field. Anything that runs later is lazy.
 * @param source  the module's text
 * @param file  its path relative to vimma/ (`host/VimmaHost.sys.mjs`, `vimma.js`)
 * @param watched  the restricted modules whose hand-ons to report (Scan.handOns)
 */
export function scanModule(
  source: string,
  file: string,
  watched: ReadonlySet<string> = WATCHED,
): Scan {
  const ast = espree.parse(source, {
    ecmaVersion: "latest",
    sourceType: file.endsWith(".js") ? "script" : "module",
    loc: true,
  }) as unknown as AstNode;
  const edges: Edge[] = [];
  const problems: string[] = [];
  /** Nodes already read by the form that holds them. */
  const done = new Set<AstNode>();
  const lineOf = (node: AstNode) => node.loc?.start.line ?? 0;
  const problem = (node: AstNode, message: string) =>
    problems.push(`${file}:${lineOf(node)}: ${message}`);
  /**
   * A string in any position: a module URL in it is a lazy reference. The root window script's
   * URL is not: it is text, as a page's URL is (isRootScript).
   */
  const reference = (spec: string, node: AstNode) => {
    const r = resolveSpec(spec, file, false);
    if (r === "partial") problem(node, PARTIAL);
    else if (r === "unresolved") problem(node, UNRESOLVED);
    else if (r === "alias") problem(node, ALIAS);
    else if (r && !isRootScript(r.to))
      edges.push({ from: file, to: r.to, kind: "lazy", line: lineOf(node) });
  };
  /** A specifier where a module is loaded: it must be a fixed string. */
  const specifier = (node: AstNode, kind: Edge["kind"], relative: boolean, at: AstNode) => {
    done.add(node);
    const spec = fixedString(node);
    if (spec === null) {
      if (mayBeVimma(node)) problem(node, NOT_FIXED);
      return;
    }
    const r = resolveSpec(spec, file, relative);
    if (r === "partial") problem(node, PARTIAL);
    else if (r === "unresolved") problem(node, UNRESOLVED);
    else if (r === "alias") problem(node, ALIAS);
    else if (r) edges.push({ from: file, to: r.to, kind, line: lineOf(at) });
  };

  const walk = (node: AstNode, lazy: boolean, invoked = false): void => {
    if (done.has(node)) return;
    let inner = lazy || (isFunction(node) && !invoked);
    const source = node["source"];
    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      isNode(source)
    ) {
      specifier(source, "eager", true, node);
    } else if (node.type === "ImportExpression" && isNode(source)) {
      specifier(source, "lazy", true, node);
    } else if (node.type === "CallExpression") {
      const callee = node["callee"];
      const args = Array.isArray(node["arguments"]) ? (node["arguments"] as unknown[]) : [];
      const method =
        isNode(callee) && callee.type === "MemberExpression" && isNode(callee["property"])
          ? callee["property"]["name"]
          : null;
      const [first, second] = args;
      if (method === "importESModule" && isNode(first)) {
        specifier(first, lazy ? "lazy" : "eager", false, first);
      } else if (method === "defineESModuleGetters" && isNode(second)) {
        if (second.type !== "ObjectExpression") specifier(second, "lazy", false, second);
        else
          for (const prop of (second["properties"] as unknown[]) ?? [])
            if (isNode(prop) && isNode(prop["value"]))
              specifier(prop["value"], "lazy", false, prop["value"]);
      }
      // A function called on the spot runs now, as its caller does.
      if (isNode(callee) && isFunction(callee)) {
        walk(callee, lazy, true);
      }
    } else if (node.type === "Literal" && typeof node["value"] === "string") {
      reference(node["value"], node);
    } else if (node.type === "TemplateLiteral") {
      const fixed = fixedString(node);
      if (fixed !== null) reference(fixed, node);
      else {
        const r = resolveSpec(leadingText(node), file, false);
        if (r === "unresolved") problem(node, UNRESOLVED);
        else if (r === "alias") problem(node, ALIAS);
        else if (r === "partial" || (r && !r.to.endsWith("/"))) problem(node, PARTIAL);
        else if (r) edges.push({ from: file, to: r.to, kind: "lazy", line: lineOf(node) });
      }
    } else if (node.type === "PropertyDefinition" && !node["static"]) {
      // An instance field's initialiser runs when the class is constructed.
      inner = true;
    }
    for (const [k, value] of Object.entries(node)) {
      if (k === "loc" || k === "range") continue;
      if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) walk(child, inner);
      } else if (isNode(value)) walk(value, inner);
    }
    done.add(node);
  };
  walk(ast, false);
  return { edges, problems, handOns: handOnsOf(ast, file, watched) };
}

/** The restricted modules, whose hand-ons a scan looks for. */
const WATCHED: ReadonlySet<string> = new Set(Object.keys(RESTRICTED));

/**
 * What a local name holds of a restricted module: its export (the gate itself), its namespace
 * (`import * as`, the result of importESModule), or a lazy getter object some of whose keys
 * load it (defineESModuleGetters), each key with the module it loads.
 */
type Hold =
  | { kind: "value"; to: string }
  | { kind: "ns"; to: string }
  | { kind: "lazy"; keys: Map<string, string> };

/** The name of a non-computed key, or of a computed one that is a fixed string; else null. */
function keyName(node: AstNode, computed: boolean): string | null {
  if (!computed && node.type === "Identifier") return String(node["name"]);
  if (node.type === "Literal") return String(node["value"]);
  return computed ? fixedString(node) : null;
}

/** Node keys whose identifiers are names being bound, not read. */
const BINDING_KEYS: Record<string, string[]> = {
  VariableDeclarator: ["id"],
  FunctionDeclaration: ["id", "params"],
  FunctionExpression: ["id", "params"],
  ArrowFunctionExpression: ["params"],
  ClassDeclaration: ["id"],
  ClassExpression: ["id"],
  CatchClause: ["param"],
  AssignmentExpression: ["left"],
};

/**
 * Every hand-on of a restricted module (Scan.handOns). Each name that holds the module, or its
 * namespace, or a lazy getter object that loads it, is followed through local aliases (by name,
 * across the whole module: a shadowing name only adds errors, it never hides one). Each read of
 * such a name must be a call of one of its members (`AgentGate.request(…)`), a member read
 * (`AgentGate.waiting`: data when it is a getter, restrictedErrors decides), a local alias, or
 * the lazy object passed to a ChromeUtils or XPCOMUtils `define…` call. Anything else lets it
 * out: an export, a return, an argument, an element, a field, a property, a store. A function
 * that calls the module is a caller, not a hand-on: what it does for its own caller is the
 * security review's to judge.
 */
function handOnsOf(ast: AstNode, file: string, watched: ReadonlySet<string>): HandOn[] {
  const out: HandOn[] = [];
  if (!watched.size) return out;
  const add = (node: AstNode, to: string, how: string, member?: string) =>
    out.push({
      from: file,
      to,
      line: node.loc?.start.line ?? 0,
      how,
      ...(member === undefined ? {} : { member }),
    });
  /** The restricted module a fixed specifier names, or null. */
  const target = (node: unknown, relative: boolean): string | null => {
    const spec = isNode(node) ? fixedString(node) : null;
    const r = spec === null ? null : resolveSpec(spec, file, relative);
    return typeof r === "object" && r !== null && watched.has(r.to) ? r.to : null;
  };

  // Every node with its parent, and every identifier that is read rather than bound.
  const parents = new Map<AstNode, AstNode>();
  const reads = new Set<AstNode>();
  const nodes: AstNode[] = [];
  const visit = (node: AstNode, parent: AstNode | null, binding: boolean): void => {
    if (parent) parents.set(node, parent);
    nodes.push(node);
    if (node.type === "Identifier") {
      if (!binding) reads.add(node);
      return;
    }
    for (const [k, value] of Object.entries(node)) {
      if (k === "loc" || k === "range") continue;
      // Names that are not references: a member's or a key's name, an import's or an export's
      // outer name, a label.
      if (k === "property" && node.type === "MemberExpression" && !node["computed"]) continue;
      if (
        k === "key" &&
        !node["computed"] &&
        ["Property", "MethodDefinition", "PropertyDefinition"].includes(node.type)
      )
        continue;
      if (k === "label" || k === "meta") continue;
      if (node.type.startsWith("Import") && node.type !== "ImportExpression" && k !== "source")
        continue;
      if (node.type === "ExportSpecifier" && k === "exported") continue;
      // `export { X } from "…"` names the other module's X, not a local one.
      if (node.type === "ExportNamedDeclaration" && k === "specifiers" && node["source"]) continue;
      // A member on the left of an assignment is read, not bound: `AgentGate.request = f`.
      let bind = binding && node.type !== "MemberExpression";
      if (BINDING_KEYS[node.type]?.includes(k)) bind = true;
      // A default value or a computed key inside a pattern is an expression again.
      if (node.type === "AssignmentPattern" && k === "right") bind = false;
      if (node.type === "Property" && k === "key") bind = false;
      if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) visit(child, node, bind);
      } else if (isNode(value)) visit(value, node, bind);
    }
  };
  visit(ast, null, false);

  /** The parent of an expression, past a ChainExpression around it. */
  const up = (node: AstNode): { expr: AstNode; parent: AstNode | undefined } => {
    let expr = node;
    let parent = parents.get(expr);
    while (parent?.type === "ChainExpression") {
      expr = parent;
      parent = parents.get(expr);
    }
    return { expr, parent };
  };
  const isImportESModule = (node: AstNode) => {
    const callee = node["callee"];
    return (
      node.type === "CallExpression" &&
      isNode(callee) &&
      callee.type === "MemberExpression" &&
      isNode(callee["property"]) &&
      callee["property"]["name"] === "importESModule"
    );
  };
  /** A ChromeUtils or XPCOMUtils call that defines getters on its first argument. */
  const isDefine = (node: AstNode | undefined) => {
    const callee = node?.["callee"];
    if (node?.type !== "CallExpression" || !isNode(callee) || callee.type !== "MemberExpression")
      return false;
    const object = callee["object"];
    const property = callee["property"];
    return (
      isNode(object) &&
      ["ChromeUtils", "XPCOMUtils"].includes(String(object["name"])) &&
      isNode(property) &&
      /^define/.test(String(property["name"]))
    );
  };

  // The names the module declares itself: a lazy getter object must be one of them, since
  // globalThis and other outside objects are shared with every system module.
  const declared = new Set<string>();
  for (const node of nodes)
    if (
      node.type === "VariableDeclarator" &&
      isNode(node["id"]) &&
      node["id"].type === "Identifier"
    )
      declared.add(String(node["id"]["name"]));

  // The names that hold a restricted module, then their aliases until nothing changes.
  const holders = new Map<string, Hold>();
  const hold = (name: string, h: Hold) => {
    const had = holders.get(name);
    if (h.kind === "lazy" && had?.kind === "lazy") {
      const before = had.keys.size;
      for (const [k, v] of h.keys) had.keys.set(k, v);
      return had.keys.size !== before;
    }
    if (had) return false;
    holders.set(name, h);
    return true;
  };
  for (const node of nodes) {
    if (node.type === "ImportDeclaration") {
      const to = target(node["source"], true);
      if (to)
        for (const sp of (node["specifiers"] as unknown[]) ?? [])
          if (isNode(sp) && isNode(sp["local"]))
            hold(String(sp["local"]["name"]), {
              kind: sp.type === "ImportNamespaceSpecifier" ? "ns" : "value",
              to,
            });
    } else if (
      node.type === "CallExpression" &&
      isNode(node["callee"]) &&
      isNode(node["callee"]["property"]) &&
      node["callee"]["property"]["name"] === "defineESModuleGetters"
    ) {
      const [on, map] = (node["arguments"] as unknown[]) ?? [];
      if (!isNode(map) || map.type !== "ObjectExpression") continue;
      const keys = new Map<string, string>();
      for (const prop of (map["properties"] as unknown[]) ?? []) {
        if (!isNode(prop) || !isNode(prop["value"])) continue;
        const to = target(prop["value"], false);
        if (!to) continue;
        const key = isNode(prop["key"]) ? keyName(prop["key"], Boolean(prop["computed"])) : null;
        if (key === null) add(prop, to, "hands on");
        else keys.set(key, to);
      }
      if (!keys.size) continue;
      if (isNode(on) && on.type === "Identifier" && declared.has(String(on["name"])))
        hold(String(on["name"]), { kind: "lazy", keys });
      else
        for (const to of new Set(keys.values()))
          add(node, to, "defines a getter outside a local object for");
    }
  }

  /** What an expression holds of a restricted module, or null. */
  const holdOf = (node: AstNode): Hold | null => {
    if (node.type === "Identifier") return holders.get(String(node["name"])) ?? null;
    if (node.type === "ChainExpression" && isNode(node["expression"]))
      return holdOf(node["expression"]);
    if (isImportESModule(node)) {
      const to = target(((node["arguments"] as unknown[]) ?? [])[0], false);
      return to ? { kind: "ns", to } : null;
    }
    if (node.type === "AwaitExpression" && isNode(node["argument"])) {
      const arg = node["argument"];
      const to = arg.type === "ImportExpression" ? target(arg["source"], true) : null;
      return to ? { kind: "ns", to } : null;
    }
    if (node.type === "MemberExpression" && isNode(node["object"]) && isNode(node["property"])) {
      const outer = holdOf(node["object"]);
      if (!outer || outer.kind === "value") return null;
      if (outer.kind === "ns") return { kind: "value", to: outer.to };
      const key = keyName(node["property"], Boolean(node["computed"]));
      // A computed key the check cannot read may be any of the object's getters.
      const to = key === null ? [...outer.keys.values()][0] : outer.keys.get(key);
      return to ? { kind: "value", to } : null;
    }
    return null;
  };
  /** The names a pattern binds from a value that holds `h`. */
  const bindPattern = (pattern: AstNode, h: Hold): boolean => {
    if (pattern.type === "Identifier") return hold(String(pattern["name"]), h);
    if (pattern.type !== "ObjectPattern" || h.kind === "value") return false;
    let changed = false;
    for (const prop of (pattern["properties"] as unknown[]) ?? []) {
      if (!isNode(prop)) continue;
      if (prop.type === "RestElement" && isNode(prop["argument"])) {
        changed = bindPattern(prop["argument"], h) || changed;
        continue;
      }
      const value = prop["value"];
      if (!isNode(value) || !isNode(prop["key"])) continue;
      const key = keyName(prop["key"], Boolean(prop["computed"]));
      const to = h.kind === "ns" ? h.to : key === null ? undefined : h.keys.get(key);
      const inner = value.type === "AssignmentPattern" ? value["left"] : value;
      if (to && isNode(inner)) changed = bindPattern(inner, { kind: "value", to }) || changed;
    }
    return changed;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const node of nodes) {
      const init = node.type === "VariableDeclarator" ? node["init"] : node["right"];
      const id = node.type === "VariableDeclarator" ? node["id"] : node["left"];
      if (
        (node.type === "VariableDeclarator" || node.type === "AssignmentExpression") &&
        isNode(init) &&
        isNode(id)
      ) {
        const h = holdOf(init);
        if (h) changed = bindPattern(id, h) || changed;
      }
    }
  }

  const toOf = (h: Hold) => (h.kind === "lazy" ? [...new Set(h.keys.values())] : [h.to]);
  /** Checks where an expression that holds `h` goes (see the function's comment). */
  const check = (node: AstNode, h: Hold): void => {
    const { expr, parent } = up(node);
    if (!parent) return;
    if (parent.type === "MemberExpression" && parent["object"] === expr) {
      if (h.kind !== "value") {
        const inner = holdOf(parent);
        if (inner) check(parent, inner);
        return;
      }
      const call = up(parent).parent;
      const called =
        (call?.type === "CallExpression" || call?.type === "NewExpression") &&
        call["callee"] === up(parent).expr;
      if (called) return;
      const property = parent["property"];
      const key = isNode(property) ? keyName(property, Boolean(parent["computed"])) : null;
      const { expr: member, parent: user } = up(parent);
      if (
        (user?.type === "AssignmentExpression" && user["left"] === member) ||
        user?.type === "UpdateExpression" ||
        (user?.type === "UnaryExpression" && user["operator"] === "delete")
      ) {
        add(parent, h.to, `changes the member ${key ?? "(computed)"} of`);
        return;
      }
      add(
        parent,
        h.to,
        key ? `takes the method ${key}, uncalled, of` : "takes a member, uncalled, of",
        key ?? "",
      );
      return;
    }
    if (
      (parent.type === "CallExpression" || parent.type === "NewExpression") &&
      parent["callee"] === expr
    )
      return;
    if (parent.type === "VariableDeclarator" && parent["init"] === expr) {
      const id = parent["id"];
      if (isNode(id) && id.type === "Identifier") return;
      if (isNode(id) && id.type === "ObjectPattern" && h.kind === "value") {
        for (const prop of (id["properties"] as unknown[]) ?? []) {
          if (!isNode(prop)) continue;
          const key =
            prop.type === "Property" && isNode(prop["key"])
              ? keyName(prop["key"], Boolean(prop["computed"]))
              : null;
          if (key === null) add(prop, h.to, "hands on");
          else add(prop, h.to, `takes the method ${key}, uncalled, of`, key);
        }
        return;
      }
      if (isNode(id) && id.type === "ObjectPattern") return;
    }
    if (
      parent.type === "AssignmentExpression" &&
      parent["right"] === expr &&
      isNode(parent["left"]) &&
      parent["left"].type === "Identifier"
    )
      return;
    if (
      h.kind === "lazy" &&
      isDefine(parent) &&
      ((parent["arguments"] as unknown[]) ?? [])[0] === expr
    )
      return;
    const how =
      parent.type === "ExportSpecifier" || parent.type === "ExportDefaultDeclaration"
        ? "re-exports"
        : "hands on";
    for (const to of toOf(h)) add(expr, to, how);
  };

  for (const node of nodes) {
    if (node.type === "Identifier" && !reads.has(node)) continue;
    if (node.type === "ImportExpression") {
      const to = target(node["source"], true);
      if (!to) continue;
      const { expr, parent } = up(node);
      if (parent?.type === "AwaitExpression") check(parent, { kind: "ns", to });
      else add(expr, to, "hands on");
      continue;
    }
    if (node.type !== "Identifier" && !isImportESModule(node)) continue;
    const h = holdOf(node);
    if (h) check(node, h);
  }

  // An export … from a restricted module, and an exported name that holds one.
  for (const node of (ast["body"] as unknown[]) ?? []) {
    if (!isNode(node)) continue;
    if (node.type !== "ExportNamedDeclaration" && node.type !== "ExportAllDeclaration") continue;
    const from = target(node["source"], true);
    if (from) {
      add(node, from, "re-exports");
      continue;
    }
    const declaration = node["declaration"];
    if (!isNode(declaration)) continue;
    const names: string[] = [];
    const collect = (n: unknown): void => {
      if (!isNode(n)) return;
      if (n.type === "Identifier") names.push(String(n["name"]));
      else if (n.type === "ObjectPattern")
        for (const p of (n["properties"] as unknown[]) ?? [])
          collect(isNode(p) ? (p.type === "RestElement" ? p["argument"] : p["value"]) : null);
      else if (n.type === "ArrayPattern")
        for (const e of (n["elements"] as unknown[]) ?? []) collect(e);
      else if (n.type === "AssignmentPattern") collect(n["left"]);
      else if (n.type === "RestElement") collect(n["argument"]);
    };
    if (declaration.type === "VariableDeclaration")
      for (const d of (declaration["declarations"] as unknown[]) ?? [])
        collect(isNode(d) ? d["id"] : null);
    else collect(declaration["id"]);
    for (const name of names) {
      const h = holders.get(name);
      if (h) for (const to of toOf(h)) add(node, to, "re-exports");
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/**
 * The getters of a module's exported object literals (`export const G = { get waiting() … }`):
 * reading one of them is reading data, which restrictedErrors lets a holder of the module do.
 * @param source  the restricted module's text
 * @param file  its path relative to vimma/
 */
export function getterNames(source: string, file: string): Set<string> {
  const ast = espree.parse(source, {
    ecmaVersion: "latest",
    sourceType: file.endsWith(".js") ? "script" : "module",
  }) as unknown as AstNode;
  const names = new Set<string>();
  for (const node of (ast["body"] as unknown[]) ?? []) {
    const declaration =
      isNode(node) && node.type === "ExportNamedDeclaration" ? node["declaration"] : null;
    if (!isNode(declaration) || declaration.type !== "VariableDeclaration") continue;
    for (const d of (declaration["declarations"] as unknown[]) ?? []) {
      const init = isNode(d) ? d["init"] : null;
      if (!isNode(init) || init.type !== "ObjectExpression") continue;
      for (const prop of (init["properties"] as unknown[]) ?? [])
        if (isNode(prop) && prop["kind"] === "get" && isNode(prop["key"])) {
          const key = keyName(prop["key"], Boolean(prop["computed"]));
          if (key !== null) names.add(key);
        }
    }
  }
  return names;
}

/**
 * Every edge from one module to another Vimma module, in source order: `scanModule` without
 * its problems. tools/diagrams draws the module graph from it, so the picture and this check
 * read the same edges.
 */
export function importsOf(source: string, file: string): Edge[] {
  return scanModule(source, file).edges;
}

/**
 * The modules a page under vimma/ loads (`<script src>`, `<link href>`), as eager edges. An
 * inline `<script>` is a problem: its imports would go unread.
 * @param html  the page's text
 * @param file  its path relative to vimma/
 */
export function htmlImports(html: string, file: string): Scan {
  const edges: Edge[] = [];
  const problems: string[] = [];
  html.split("\n").forEach((text, i) => {
    for (const m of text.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
      const r = resolveSpec(m[1] ?? "", file, true);
      if (r === "alias") problems.push(`${file}:${i + 1}: ${ALIAS}`);
      else if (typeof r === "object" && r !== null && !r.to.endsWith("/"))
        edges.push({ from: file, to: r.to, kind: "eager", line: i + 1 });
    }
  });
  for (const m of html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/g)) {
    if (!(m[1] ?? "").trim()) continue;
    const line = html.slice(0, m.index).split("\n").length;
    problems.push(
      `${file}:${line}: an inline <script> is not read; load the code from a module file`,
    );
  }
  return { edges, problems };
}

/**
 * Where jar.mn packages a module somewhere other than its source path. The check reads a
 * module's folder from its chrome:// URL, which is right only while the two agree.
 * @param jar  jar.mn's text
 */
export function jarErrors(jar: string): string[] {
  const errors: string[] = [];
  jar.split("\n").forEach((text, i) => {
    const m = /^\s*content\/browser\/vimma\/(\S+)\s+\((\S+)\)/.exec(text);
    if (!m) return;
    const [, url = "", from = ""] = m;
    const moved = from.includes("*")
      ? !from.startsWith(`${url}/`)
      : /\.m?js$/.test(url) && from !== url;
    if (moved)
      errors.push(
        `jar.mn:${i + 1}: content/browser/vimma/${url} is packaged from ${from}; a module's URL must be its source path`,
      );
  });
  return errors;
}

/**
 * The modules jar.mn packages, by their path under vimma/. A wildcard line (core/**) adds none:
 * the folders it packages are not checked by name.
 * @param jar  jar.mn's text
 */
export function jarModules(jar: string): Set<string> {
  const modules = new Set<string>();
  for (const text of jar.split("\n")) {
    const m = /^\s*content\/browser\/vimma\/(\S+)\s+\((\S+)\)/.exec(text);
    if (m && !m[2]?.includes("*") && m[1]) modules.add(m[1]);
  }
  return modules;
}

/**
 * Edges to a module that does not exist: one git does not track, or one jar.mn does not package,
 * so a mistyped URL fails here instead of at run time (a missing parent actor drops every page
 * report without an error in a release). core/ is skipped (a git-ignored copy sync-core makes,
 * packaged by a wildcard), and so is a folder prefix, which names no file.
 * @param edges  every edge of the tree
 * @param tracked  the modules git tracks, relative to vimma/
 * @param packaged  the modules jar.mn packages (jarModules)
 */
export function danglingEdges(
  edges: Edge[],
  tracked: Set<string>,
  packaged: Set<string>,
): string[] {
  const errors: string[] = [];
  for (const e of edges) {
    if (e.to.endsWith("/") || folderOf(e.to) === "core") continue;
    if (!tracked.has(e.to))
      errors.push(
        `${e.from}:${e.line}: names ${e.to}, which is not a module git tracks under vimma/`,
      );
    else if (!packaged.has(e.to))
      errors.push(`${e.from}:${e.line}: names ${e.to}, which jar.mn does not package`);
  }
  return errors;
}

/**
 * Every listed exception: the last one went with #936, and ADR-026 (decision 5) admits no new
 * one. A higher folder is reached through a topic, a callback or an interface object instead.
 */
export function exceptionErrors(exceptions: Exception[]): string[] {
  return exceptions.map(
    (x) =>
      `exception ${key(x)}: ${ADR} allows no upward import; reach the higher folder through a topic, a callback or an interface object (decision 4)`,
  );
}

/**
 * Imports of a restricted module by a module its list does not hold, eager or lazy; listed
 * importers that no longer import it, so that the list stays exactly the callers reviewed; and
 * every place a module hands it on (Scan.handOns), but for reading a getter of it.
 * @param data  each restricted module's getters (getterNames): reading one is reading data
 */
export function restrictedErrors(
  edges: Edge[],
  restricted: Record<string, Restricted>,
  handOns: HandOn[] = [],
  data: Record<string, ReadonlySet<string>> = {},
): string[] {
  const errors: string[] = [];
  for (const [module, { importers, review }] of Object.entries(restricted)) {
    const allowed = new Set(importers);
    const seen = new Set<string>();
    for (const e of edges) {
      if (e.to !== module) continue;
      seen.add(e.from);
      if (!allowed.has(e.from))
        errors.push(
          `${e.from}:${e.line}: imports ${module}, which only the modules RESTRICTED lists in ${LAYERS_FILE} may import: ${review}, then a line there`,
        );
    }
    for (const h of handOns) {
      if (h.to !== module) continue;
      if (h.member !== undefined && data[module]?.has(h.member)) continue;
      errors.push(
        `${h.from}:${h.line}: ${h.how} ${module}, which only the modules RESTRICTED lists in ${LAYERS_FILE} may hold and none may hand on: ${review}`,
      );
    }
    for (const from of importers)
      if (!seen.has(from))
        errors.push(
          `stale importer: ${from} no longer imports ${module}; remove it from RESTRICTED in ${LAYERS_FILE}`,
        );
  }
  return errors;
}

/**
 * Firefox patches (the .patch files under src/) load Vimma modules by chrome:// URL from
 * Firefox's own files, which the module scan does not read; a patch is text in many languages,
 * so each added line is read as text. It fails when it names a restricted module, by any URL
 * that reaches its file (an escaped one, one with `..`, a resource:// one) or by its file name
 * alone (`base + "AgentGate.sys.mjs"`); no patch is on a restricted module's list. It fails too
 * when it holds a piece of a Vimma URL that names no file: a folder, or a URL cut short by `${`
 * or a closing quote (`"chrome://browser/content/" + …`), since a URL built from parts hides
 * which module it loads.
 */
export function patchErrors(
  patches: { file: string; text: string }[],
  restricted: Record<string, Restricted>,
): string[] {
  const errors: string[] = [];
  const files = Object.keys(restricted).map((m) => [m, posix.basename(m).toLowerCase()] as const);
  for (const { file, text } of patches)
    text.split("\n").forEach((line, i) => {
      if (!line.startsWith("+") || line.startsWith("+++")) return;
      const named = new Set<string>();
      const pieces: string[] = [];
      for (const [url] of line.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s"'`$,);]*/gi)) {
        const canon = canonical(url);
        const v = vimmaPath(canon);
        const path = v && v.path !== "" ? posix.normalize(v.path) : (v?.path ?? null);
        if (path !== null && restricted[path]) named.add(path);
        else if (
          path !== null ? !/\.[a-z0-9]+$/i.test(path) : ROOTS.some((r) => r.startsWith(canon))
        )
          pieces.push(url);
      }
      const lower = unescape(line).toLowerCase();
      for (const [module, base] of files) if (lower.includes(base)) named.add(module);
      for (const module of named)
        errors.push(
          `${file}:${i + 1}: names ${module}, which only the modules RESTRICTED lists in ${LAYERS_FILE} may import, and a Firefox patch is none of them: ${restricted[module]?.review ?? ""}`,
        );
      for (const piece of pieces)
        errors.push(
          `${file}:${i + 1}: builds a Vimma URL from parts (${piece}); a Firefox patch names each Vimma module by its whole chrome:// URL, so that the check can read it`,
        );
    });
  return errors;
}

/** The folder a path relative to vimma/ belongs to. */
export function folderOf(path: string): string {
  const slash = path.indexOf("/");
  return slash < 0 ? ROOT_FOLDER : path.slice(0, slash);
}

const key = (e: { from: string; to: string; kind: string }) => `${e.from} -> ${e.to} (${e.kind})`;

/**
 * What breaks the layering: imports of the same or a higher layer that no exception lists,
 * folders without a layer, and exceptions that are stale or give no reason.
 * @param edges  every edge of the tree
 * @param layers  each folder's layer, 0 at the bottom
 * @param exceptions  the upward imports that stay
 */
export function layerErrors(
  edges: Edge[],
  layers: Record<string, number>,
  exceptions: Exception[],
): string[] {
  const errors: string[] = [];
  const unranked = new Set<string>();
  const excepted = new Set(exceptions.map(key));
  const used = new Set<string>();
  const present = new Set<string>();
  for (const e of edges) {
    for (const path of [e.from, e.to]) {
      const folder = folderOf(path);
      if (layers[folder] === undefined && !unranked.has(folder)) {
        unranked.add(folder);
        errors.push(
          `${path}: the folder ${folder}/ has no layer: add it to LAYERS (${LAYERS_FILE}) and ${ADR}`,
        );
      }
    }
    present.add(key(e));
    const a = folderOf(e.from);
    const b = folderOf(e.to);
    const ra = layers[a];
    const rb = layers[b];
    if (a === b || ra === undefined || rb === undefined || rb < ra) continue;
    if (excepted.has(key(e))) {
      used.add(key(e));
      continue;
    }
    errors.push(
      `${e.from}:${e.line} imports ${e.to} (${e.kind}): ${a} (layer ${ra}) may not import ${b} (layer ${rb})`,
    );
  }
  for (const x of exceptions) {
    const k = key(x);
    if (!x.reason.trim()) errors.push(`exception ${k} gives no reason`);
    else if (!present.has(k))
      errors.push(`stale exception: ${k} is no longer imported; remove it from ${LAYERS_FILE}`);
    else if (!used.has(k))
      errors.push(`stale exception: ${k} is allowed by the layers; remove it from ${LAYERS_FILE}`);
  }
  return errors;
}

/**
 * Eager import cycles: modules that load each other, at any distance. Each strongly connected
 * group of the eager graph is reported once, as its shortest loop through the group's first
 * module in sort order.
 */
export function eagerCycles(edges: Edge[]): string[] {
  const next = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind !== "eager") continue;
    const list = next.get(e.from) ?? [];
    if (!list.includes(e.to)) list.push(e.to);
    next.set(e.from, list);
    if (!next.has(e.to)) next.set(e.to, []);
  }
  // Tarjan's strongly connected components.
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const groups: string[][] = [];
  const visit = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of next.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
    }
    if (low.get(v) !== index.get(v)) return;
    const group: string[] = [];
    for (let w = stack.pop(); w !== undefined; w = w === v ? undefined : stack.pop()) {
      onStack.delete(w);
      group.push(w);
    }
    if (group.length > 1 || (next.get(v) ?? []).includes(v)) groups.push(group);
  };
  for (const v of [...next.keys()].sort()) if (!index.has(v)) visit(v);

  return groups
    .map((group) => {
      const members = new Set(group);
      const start = [...group].sort()[0] ?? "";
      // Breadth first from `start` until an edge leads back to it, inside the group.
      const parent = new Map<string, string>();
      const queue = [start];
      let last: string | null = null;
      while (queue.length && last === null) {
        const v = queue.shift() ?? "";
        for (const w of [...(next.get(v) ?? [])].sort()) {
          if (!members.has(w)) continue;
          if (w === start) {
            last = v;
            break;
          }
          if (!parent.has(w)) {
            parent.set(w, v);
            queue.push(w);
          }
        }
      }
      const path: string[] = [];
      for (let v = last; v !== null && v !== start; v = parent.get(v) ?? null) path.unshift(v);
      return `eager import cycle: ${[start, ...path, start].join(" -> ")}`;
    })
    .sort();
}

/** Every module and page of vimma/ that git tracks, relative to vimma/. */
export function trackedFiles(root: string): string[] {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--", `${VIMMA}*.mjs`, `${VIMMA}*.js`, `${VIMMA}*.html`],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .map((f) => f.slice(VIMMA.length));
}

/** Every edge of the tree, and every specifier in it that cannot be read. */
export function treeScan(root: string): Scan {
  const scans = trackedFiles(root).map((f) => {
    const text = readFileSync(join(root, VIMMA, f), "utf8");
    return f.endsWith(".html") ? htmlImports(text, f) : scanModule(text, f);
  });
  return {
    edges: scans.flatMap((s) => s.edges),
    problems: scans.flatMap((s) => s.problems),
    handOns: scans.flatMap((s) => s.handOns ?? []),
  };
}

/** The Firefox patches git tracks under src/, with their text. */
function trackedPatches(root: string): { file: string; text: string }[] {
  return execFileSync("git", ["ls-files", "-z", "--", "src/**/*.patch"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }));
}

/** Everything `npm run layering` checks in the tree at `root`, and the edges it read. */
export function treeErrors(root: string): { edges: Edge[]; errors: string[] } {
  const { edges, problems, handOns = [] } = treeScan(root);
  const data = Object.fromEntries(
    Object.keys(RESTRICTED).map((m) => {
      const path = join(root, VIMMA, m);
      return [m, existsSync(path) ? getterNames(readFileSync(path, "utf8"), m) : new Set<string>()];
    }),
  );
  const jar = readFileSync(join(root, VIMMA, "jar.mn"), "utf8");
  const errors = [
    ...problems,
    ...jarErrors(jar),
    ...danglingEdges(edges, new Set(trackedFiles(root)), jarModules(jar)),
    ...exceptionErrors(EXCEPTIONS),
    ...layerErrors(edges, LAYERS, EXCEPTIONS),
    ...restrictedErrors(edges, RESTRICTED, handOns, data),
    ...patchErrors(trackedPatches(root), RESTRICTED),
    ...eagerCycles(edges),
    ...missingReadmes(root).map(
      (d) => `vimma/${d}/ has no README.md: say what it owns and what it may import (${ADR})`,
    ),
  ];
  return { edges, errors };
}

/** Folders of vimma/ that git tracks and that have no README.md. */
export function missingReadmes(root: string): string[] {
  const files = execFileSync("git", ["ls-files", "-z", "--", VIMMA], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .map((f) => f.slice(VIMMA.length));
  const folders = [...new Set(files.filter((f) => f.includes("/")).map(folderOf))].sort();
  return folders.filter((d) => !existsSync(join(root, VIMMA, d, "README.md")));
}

function main(): void {
  const { edges, errors } = treeErrors(ROOT);
  if (errors.length) {
    for (const e of errors) console.error(e);
    console.error(
      `\nLayering: ${errors.length} problem(s). The rules: docs/adr/026-module-layering.md.`,
    );
    process.exit(1);
  }
  console.log(
    `Layering: ${edges.length} imports follow ${ADR}, no exception, no eager cycle, restricted modules imported only by their listed callers.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
