#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The import layering of src/browser/base/content/vimma/ (ADR-026), checked by
// `npm run layering` (part of `npm run lint`) and by its own step in ci.yml. Each folder has a
// layer (layers.ts); a module may import its own folder and any folder of a lower layer, never
// one of its own layer or a higher one, eagerly or lazily. The imports that break this today are
// listed one by one in layers.ts with their reason; a new one fails, and so does a listed one
// that no longer exists. No two modules may import each other eagerly, at any distance.
//
// eslint's no-restricted-imports cannot do this: it sees `import` declarations only, and most of
// these edges are chrome:// URLs passed to ChromeUtils.importESModule or to a lazy getter map.
// So each module is parsed and every string that names a Vimma module is an edge:
//
//   eager  an `import` or `export … from` declaration, or ChromeUtils.importESModule called
//          outside any function: the module is loaded with its importer.
//   lazy   anything else: a defineESModuleGetters map, importESModule inside a function,
//          import(), an actor's esModuleURI, a worker's URL. Loaded on first use.
//
// Type-only references (`@import`, `import("…")` in JSDoc) are comments and never load a module,
// so they are not edges. The files come from `git ls-files`, so vimma/core/ (a git-ignored copy
// that sync-core makes) is not read; imports of it are always allowed, as layer 0.
//
//   node tools/layering/layering.ts

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as espree from "espree";
import { EXCEPTIONS, LAYERS } from "./layers.ts";

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

/** An import that crosses the layering upwards and stays, for the reason given. */
export interface Exception {
  from: string;
  to: string;
  kind: "eager" | "lazy";
  reason: string;
}

interface AstNode {
  type: string;
  loc?: { start: { line: number } };
  [key: string]: unknown;
}

const isNode = (v: unknown): v is AstNode =>
  typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

/**
 * The Vimma module a specifier names, relative to vimma/, or null for anything else: a Firefox
 * module, a page or a data file. A URL ending in `/` (a base the importer appends names to)
 * names that folder. A relative specifier counts only where a module is imported: elsewhere a
 * string like "./x.mjs" is just text.
 */
function target(spec: string, file: string, relativeAllowed: boolean): string | null {
  let path: string;
  if (spec.startsWith(URL_PREFIX)) path = spec.slice(URL_PREFIX.length);
  else if (relativeAllowed && (spec.startsWith("./") || spec.startsWith("../")))
    path = posix.normalize(posix.join(posix.dirname(file), spec));
  else return null;
  if (path.startsWith("../")) return null;
  return /\.m?js$/.test(path) || (path.endsWith("/") && !path.slice(0, -1).includes("/"))
    ? path
    : null;
}

/**
 * Every edge from one module to another Vimma module, in source order.
 * @param source  the module's text
 * @param file  its path relative to vimma/ (`host/VimmaHost.sys.mjs`, `vimma.js`)
 */
export function importsOf(source: string, file: string): Edge[] {
  const ast = espree.parse(source, {
    ecmaVersion: "latest",
    sourceType: file.endsWith(".js") ? "script" : "module",
    loc: true,
  }) as unknown as AstNode;
  const edges: Edge[] = [];
  /** Specifier nodes already counted by the form that holds them. */
  const counted = new Set<AstNode>();
  const add = (spec: string, kind: Edge["kind"], node: AstNode, relative = false) => {
    const to = target(spec, file, relative);
    if (to) edges.push({ from: file, to, kind, line: node.loc?.start.line ?? 0 });
  };

  const walk = (node: AstNode, inFunction: boolean): void => {
    if (counted.has(node)) return;
    const nested = inFunction || /Function/.test(node.type);
    const source = node["source"];
    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      isNode(source)
    ) {
      counted.add(source);
      add(String(source["value"]), "eager", node, true);
    } else if (node.type === "ImportExpression" && isNode(source)) {
      counted.add(source);
      if (source.type === "Literal") add(String(source["value"]), "lazy", node, true);
    } else if (node.type === "CallExpression") {
      const callee = node["callee"];
      const args = node["arguments"];
      const first: unknown = Array.isArray(args) ? args[0] : undefined;
      if (
        isNode(callee) &&
        callee.type === "MemberExpression" &&
        isNode(callee["property"]) &&
        callee["property"]["name"] === "importESModule" &&
        isNode(first) &&
        first.type === "Literal" &&
        typeof first["value"] === "string"
      ) {
        counted.add(first);
        add(first["value"], inFunction ? "lazy" : "eager", first);
      }
    } else if (node.type === "Literal" && typeof node["value"] === "string") {
      add(node["value"], "lazy", node);
    } else if (node.type === "TemplateLiteral") {
      const quasis = node["quasis"];
      const head: unknown = Array.isArray(quasis) ? quasis[0] : undefined;
      const cooked = isNode(head) ? (head["value"] as { cooked?: string }).cooked : undefined;
      if (cooked) add(cooked, "lazy", node);
    }
    for (const [k, value] of Object.entries(node)) {
      if (k === "loc" || k === "range") continue;
      if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) walk(child, nested);
      } else if (isNode(value)) walk(value, nested);
    }
  };
  walk(ast, false);
  return edges;
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

/** Every module of vimma/ that git tracks, relative to vimma/. */
export function trackedModules(root: string): string[] {
  return execFileSync("git", ["ls-files", "-z", "--", `${VIMMA}*.mjs`, `${VIMMA}*.js`], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .map((f) => f.slice(VIMMA.length));
}

/** Every edge of the tree. */
export function treeEdges(root: string): Edge[] {
  return trackedModules(root).flatMap((f) =>
    importsOf(readFileSync(join(root, VIMMA, f), "utf8"), f),
  );
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
  const edges = treeEdges(ROOT);
  const errors = [
    ...layerErrors(edges, LAYERS, EXCEPTIONS),
    ...eagerCycles(edges),
    ...missingReadmes(ROOT).map(
      (d) => `vimma/${d}/ has no README.md: say what it owns and what it may import (${ADR})`,
    ),
  ];
  if (errors.length) {
    for (const e of errors) console.error(e);
    console.error(
      `\nLayering: ${errors.length} problem(s). The rules: docs/adr/026-module-layering.md.`,
    );
    process.exit(1);
  }
  console.log(
    `Layering: ${edges.length} imports follow ${ADR} (${EXCEPTIONS.length} listed exceptions), no eager cycle.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
