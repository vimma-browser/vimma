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
// the modules layers.ts lists for it, whatever their layer; none may re-export it, and no
// Firefox patch may name its URL, so a new caller is a reviewed change. A query, a fragment or
// the case of a URL's scheme does not hide an import, and a string that names content/vimma/
// without resolving is an error.
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
  /**
   * Where a module hands another on: an `export … from` or `export *` of it, or an export of a
   * binding imported from it (as the binding itself, in an object literal, or as the default).
   * `to` is the module handed on.
   */
  reexports?: Edge[];
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

const NOT_FIXED = "an import specifier is not a fixed string";
const PARTIAL = "a string names part of a Vimma module URL, not a module or a folder";
const UNRESOLVED =
  "a string names content/vimma/ but no Vimma module or folder the check can resolve";

type Resolved = { to: string } | "partial" | "unresolved" | null;

/**
 * What a specifier names: a Vimma module or folder (relative to vimma/), "partial" for a URL
 * cut short before its folder, or null for anything else (a Firefox module, a page, a data
 * file). A path ending inside a folder without a file extension names that folder: a base the
 * importer appends a module name to. A relative specifier counts only where a module is
 * imported; elsewhere a string like "./x.mjs" is just text.
 */
function resolveSpec(spec: string, file: string, relativeAllowed: boolean): Resolved {
  // A query or a fragment loads the same module; a URL's scheme and host have no case.
  const bare = spec.replace(/[?#][\s\S]*$/, "");
  let path: string | null = null;
  for (const prefix of PREFIXES)
    if (bare.slice(0, prefix.length).toLowerCase() === prefix) path = bare.slice(prefix.length);
  if (path === null && relativeAllowed && (bare.startsWith("./") || bare.startsWith("../")))
    path = posix.join(posix.dirname(file), bare);
  if (path === null) return /content\/vimma\//i.test(spec) ? "unresolved" : null;
  if (path !== "") path = posix.normalize(path);
  if (path === ".." || path.startsWith("../")) return null;
  if (/\.m?js$/.test(path)) return { to: path };
  const slash = path.indexOf("/");
  if (slash < 0) return "partial";
  if (/\.[a-z0-9]+$/i.test(path.slice(slash + 1))) return null;
  return { to: path.slice(0, slash + 1) };
}

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
  if (PREFIXES.some((p) => text.startsWith(p) || (text.length > 0 && p.startsWith(text))))
    return true;
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
 */
export function scanModule(source: string, file: string): Scan {
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
  return { edges, problems, reexports: reexportsOf(ast, file) };
}

/** The bindings a module imports from Vimma modules, by local name. */
function importedBindings(ast: AstNode, file: string): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const node of (ast["body"] as unknown[]) ?? []) {
    if (!isNode(node) || node.type !== "ImportDeclaration" || !isNode(node["source"])) continue;
    const spec = fixedString(node["source"]);
    const r = spec === null ? null : resolveSpec(spec, file, true);
    if (!r || typeof r === "string") continue;
    for (const s of (node["specifiers"] as unknown[]) ?? []) {
      const local = isNode(s) && isNode(s["local"]) ? s["local"]["name"] : undefined;
      if (typeof local === "string") bindings.set(local, r.to);
    }
  }
  return bindings;
}

/** See Scan.reexports. A function that uses the binding is a caller, not a hand-on. */
function reexportsOf(ast: AstNode, file: string): Edge[] {
  const bindings = importedBindings(ast, file);
  const out: Edge[] = [];
  const add = (to: string | undefined, node: AstNode) => {
    if (to) out.push({ from: file, to, kind: "eager", line: node.loc?.start.line ?? 0 });
  };
  /** The modules a value hands on: a binding itself, or bindings held in an object literal. */
  const held = (value: unknown): string[] => {
    if (!isNode(value)) return [];
    if (value.type === "Identifier") {
      const to = bindings.get(String(value["name"]));
      return to ? [to] : [];
    }
    if (value.type === "ObjectExpression")
      return ((value["properties"] as unknown[]) ?? []).flatMap((p) =>
        isNode(p) ? held(p.type === "SpreadElement" ? p["argument"] : p["value"]) : [],
      );
    return [];
  };
  for (const node of (ast["body"] as unknown[]) ?? []) {
    if (!isNode(node)) continue;
    const source = node["source"];
    if (
      (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
      isNode(source)
    ) {
      const spec = fixedString(source);
      const r = spec === null ? null : resolveSpec(spec, file, true);
      if (r && typeof r !== "string") add(r.to, node);
    } else if (node.type === "ExportNamedDeclaration") {
      for (const s of (node["specifiers"] as unknown[]) ?? [])
        if (isNode(s)) for (const to of held(s["local"])) add(to, node);
      const declaration = node["declaration"];
      if (isNode(declaration) && declaration.type === "VariableDeclaration")
        for (const d of (declaration["declarations"] as unknown[]) ?? [])
          if (isNode(d)) for (const to of held(d["init"])) add(to, node);
    } else if (node.type === "ExportDefaultDeclaration") {
      for (const to of held(node["declaration"])) add(to, node);
    }
  }
  return out;
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
      if (r && r !== "partial" && r !== "unresolved" && !r.to.endsWith("/"))
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
 * Imports of a restricted module by a module its list does not hold, eager or lazy, and listed
 * importers that no longer import it, so that the list stays exactly the callers reviewed.
 */
export function restrictedErrors(
  edges: Edge[],
  restricted: Record<string, Restricted>,
  reexports: Edge[] = [],
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
    for (const e of reexports)
      if (e.to === module)
        errors.push(
          `${e.from}:${e.line}: re-exports ${module}, which only the modules RESTRICTED lists in ${LAYERS_FILE} may hold and none may hand on: ${review}`,
        );
    for (const from of importers)
      if (!seen.has(from))
        errors.push(
          `stale importer: ${from} no longer imports ${module}; remove it from RESTRICTED in ${LAYERS_FILE}`,
        );
  }
  return errors;
}

/**
 * Firefox patches (the .patch files under src/) load Vimma modules by chrome:// URL from Firefox's own
 * files, which the module scan does not read. An added line that names a restricted module
 * fails: no patch is on a restricted module's list.
 */
export function patchErrors(
  patches: { file: string; text: string }[],
  restricted: Record<string, Restricted>,
): string[] {
  const errors: string[] = [];
  for (const { file, text } of patches)
    text.split("\n").forEach((line, i) => {
      if (!line.startsWith("+") || line.startsWith("+++")) return;
      for (const m of line.matchAll(/[a-z-]+:\/\/[^\s"'`]*content\/vimma\/[^\s"'`,)]*/gi)) {
        const r = resolveSpec(m[0], "", false);
        const rule = r && typeof r !== "string" ? restricted[r.to] : undefined;
        if (r && typeof r !== "string" && rule)
          errors.push(
            `${file}:${i + 1}: names ${r.to}, which only the modules RESTRICTED lists in ${LAYERS_FILE} may import, and a Firefox patch is none of them: ${rule.review}`,
          );
      }
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
    reexports: scans.flatMap((s) => s.reexports ?? []),
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
  const { edges, problems, reexports = [] } = treeScan(root);
  const jar = readFileSync(join(root, VIMMA, "jar.mn"), "utf8");
  const errors = [
    ...problems,
    ...jarErrors(jar),
    ...danglingEdges(edges, new Set(trackedFiles(root)), jarModules(jar)),
    ...exceptionErrors(EXCEPTIONS),
    ...layerErrors(edges, LAYERS, EXCEPTIONS),
    ...restrictedErrors(edges, RESTRICTED, reexports),
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
