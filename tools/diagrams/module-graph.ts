#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The module dependency picture in ARCHITECTURE.md is drawn from the imports, so it cannot
// disagree with the code (issue #943). This reads every tracked JavaScript file under
// src/browser/base/content/vimma/, collects the imports that reach another folder there, and
// writes them as D2 to docs/assets/diagrams/modules.d2; tools/diagrams/render.ts draws it.
//
// An import is eager when it runs while its module loads: a static import or export-from, or an
// importESModule() or import() call outside any function. It is lazy when it runs later: a lazy
// getter (defineESModuleGetters) or a call inside a function. Eager imports decide the order in
// which modules evaluate, so a loop of eager imports between folders is drawn as a cycle.
//
//   node tools/diagrams/module-graph.ts          write docs/assets/diagrams/modules.d2
//   node tools/diagrams/module-graph.ts --check  fail when the committed file differs

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as espree from "espree";
import type { Node } from "estree";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const VIMMA = "src/browser/base/content/vimma/";
export const MODULES_D2 = "docs/assets/diagrams/modules.d2";
const CHROME = "chrome://browser/content/vimma/";

export type Kind = "eager" | "lazy";

export interface Import {
  spec: string;
  kind: Kind;
}

export interface Edge {
  from: string;
  to: string;
  kind: Kind;
}

export interface SourceFile {
  /** relative to vimma/ */
  path: string;
  code: string;
}

const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

function parse(code: string): Node {
  const options = { ecmaVersion: "latest", loc: true } as const;
  try {
    return espree.parse(code, { ...options, sourceType: "module" }) as Node;
  } catch {
    // vimma.js is a classic script that the browser window loads with <script>.
    return espree.parse(code, { ...options, sourceType: "script" }) as Node;
  }
}

/** The string a literal or a template with no substitution holds, else null. */
function fixedString(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? null;
  return null;
}

function calleeName(node: Node): string | null {
  if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return null;
  const p = node.callee.property;
  return p.type === "Identifier" ? p.name : null;
}

/** The modules a file imports, in source order, each with when it loads. */
export function importsOf(code: string): Import[] {
  const found: Import[] = [];
  const fixed = (node: Node | null | undefined, at: Node): string => {
    const spec = fixedString(node);
    if (spec === null)
      throw new Error(`line ${at.loc?.start.line}: an import specifier is not a string literal`);
    return spec;
  };

  const visit = (node: Node, inFunction: boolean): void => {
    const kind: Kind = inFunction ? "lazy" : "eager";
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportAllDeclaration":
        found.push({ spec: fixed(node.source, node), kind: "eager" });
        break;
      case "ExportNamedDeclaration":
        if (node.source) found.push({ spec: fixed(node.source, node), kind: "eager" });
        break;
      case "ImportExpression":
        found.push({ spec: fixed(node.source, node), kind });
        break;
      case "CallExpression": {
        const name = calleeName(node);
        if (name === "importESModule") {
          found.push({ spec: fixed(node.arguments[0] as Node | undefined, node), kind });
        } else if (name === "defineESModuleGetters" || name === "defineLazyModuleGetters") {
          const map = node.arguments[1] as Node | undefined;
          if (map?.type !== "ObjectExpression")
            throw new Error(`line ${node.loc?.start.line}: ${name} without an object literal`);
          for (const prop of map.properties) {
            if (prop.type !== "Property") throw new Error(`line ${prop.loc?.start.line}: spread`);
            found.push({ spec: fixed(prop.value as Node, prop), kind: "lazy" });
          }
          // Its arguments hold nothing more to find.
          return;
        }
        break;
      }
    }
    // An instance field's initializer runs with each new object, not when the module loads.
    const entersFunction =
      FUNCTIONS.has(node.type) || (node.type === "PropertyDefinition" && !node.static);
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "range") continue;
      const children = Array.isArray(value) ? value : [value];
      for (const child of children)
        if (child && typeof child === "object" && typeof child.type === "string")
          visit(child as Node, inFunction || entersFunction);
    }
  };

  visit(parse(code), false);
  return found;
}

/**
 * The folder under vimma/ that a specifier reaches, or the file's own name for a file at the top
 * of vimma/ (vimma.js); null for anything outside vimma/ (Firefox's own modules).
 * @param spec  the import specifier
 * @param file  the importing file, relative to vimma/
 */
export function folderOf(spec: string, file: string): string | null {
  let path: string;
  if (spec.startsWith(CHROME)) path = spec.slice(CHROME.length);
  else if (spec.startsWith("./") || spec.startsWith("../"))
    path = posix.normalize(posix.join(posix.dirname(file), spec));
  else return null;
  if (path.startsWith("../") || path === "..") return null;
  return path.split("/")[0] ?? null;
}

/** One edge per pair of folders that import each other, eager when any of the imports is. */
export function folderEdges(files: readonly SourceFile[]): Edge[] {
  const edges = new Map<string, Edge>();
  for (const file of files) {
    let imports: Import[];
    try {
      imports = importsOf(file.code);
    } catch (e) {
      throw new Error(`${VIMMA}${file.path}: ${(e as Error).message}`, { cause: e });
    }
    const from = file.path.includes("/") ? (file.path.split("/")[0] ?? "") : file.path;
    for (const { spec, kind } of imports) {
      const to = folderOf(spec, file.path);
      if (to === null || to === from) continue;
      const key = `${from}\0${to}`;
      const seen = edges.get(key);
      if (!seen) edges.set(key, { from, to, kind });
      else if (kind === "eager") seen.kind = "eager";
    }
  }
  return [...edges.values()].sort((a, b) =>
    a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from),
  );
}

/**
 * The groups of folders that reach each other (strongly connected components of two or more),
 * through eager imports only or through any import; each group sorted, the largest first.
 */
export function cycleGroups(
  edges: readonly Edge[],
  through: "eager" | "any" = "eager",
): string[][] {
  const used = edges.filter((e) => through === "any" || e.kind === "eager");
  const next = new Map<string, string[]>();
  for (const e of used) {
    next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
    if (!next.has(e.to)) next.set(e.to, []);
  }
  // Tarjan's algorithm; the graph has a few dozen nodes, so recursion depth is no concern.
  let index = 0;
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const groups: string[][] = [];
  const connect = (v: string): void => {
    order.set(v, index);
    low.set(v, index++);
    stack.push(v);
    onStack.add(v);
    for (const w of next.get(v) ?? []) {
      if (!order.has(w)) {
        connect(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v) ?? 0, order.get(w) ?? 0));
    }
    if (low.get(v) === order.get(v)) {
      const group: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        group.push(w);
      } while (w !== v);
      if (group.length > 1) groups.push(group.sort());
    }
  };
  for (const v of [...next.keys()].sort()) if (!order.has(v)) connect(v);
  return groups.sort((a, b) => b.length - a.length || (a[0] ?? "").localeCompare(b[0] ?? ""));
}

const id = (folder: string): string => folder.replace(/[^\w]/g, "_");

/** "every folder drawn here", with the ones left out named. */
function everyExcept(drawn: readonly string[], reached: ReadonlySet<string>): string {
  const missing = drawn.filter((n) => !reached.has(n)).map((n) => `${n}/`);
  if (!missing.length) return "every folder drawn here";
  const list =
    missing.length === 1
      ? missing[0]
      : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
  return `every folder drawn here except ${list}`;
}

/**
 * The D2 source of the folder graph, the same text for the same edges in any order.
 *
 * Two nodes would draw an edge to nearly every folder and hide the rest, so the legend states
 * their edges instead: vimma.js, which imports every folder to start it, and core/, which
 * nearly every folder imports. Each eager cycle is a box holding its folders and the edges
 * between them; an edge that two or more of its folders share to the same folder outside starts
 * at the box, once.
 */
export function toD2(input: readonly Edge[]): string {
  const ENTRY = "vimma.js";
  const CORE = "core";
  const edges = [...input].sort((a, b) =>
    a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from),
  );
  const drawnEdges = edges.filter((e) => ![e.from, e.to].some((n) => n === ENTRY || n === CORE));
  // A folder that imports only core/ (services/) is still drawn, with no arrow.
  const drawn = [...new Set(edges.flatMap((e) => [e.from, e.to]))]
    .filter((n) => n !== ENTRY && n !== CORE)
    .sort();
  const groups = cycleGroups(drawnEdges);
  const groupOf = new Map<string, number>();
  groups.forEach((g, i) => g.forEach((f) => groupOf.set(f, i + 1)));
  const ref = (n: string) => (groupOf.has(n) ? `cycle${groupOf.get(n)}.${id(n)}` : id(n));

  // ELK layers a graph by its edges' direction, source above target. A lazy edge is written
  // target first (`b <- a` draws the same arrow from a to b), so that only eager imports decide
  // which folder sits above which, and lazy ones, which close most loops, point upwards.
  const arrow = (from: string, to: string, kind: Kind, cls: string) =>
    kind === "lazy" ? `${to} <- ${from} { class: ${cls} }` : `${from} -> ${to} { class: ${cls} }`;

  const lines = [
    "# Generated by npm run diagrams from the imports under src/browser/base/content/vimma/",
    "# (tools/diagrams/module-graph.ts). Do not edit: change the code, then regenerate.",
    "",
    "direction: down",
    "",
    "classes: {",
    "  folder: {",
    "    style: { fill: ${box}; stroke: ${box-line}; font-color: ${text}; font-size: 16; border-radius: 6 }",
    "  }",
    "  cycle-group: {",
    "    label.near: outside-top-left",
    "    style: { fill: ${cycle-fill}; stroke: ${cycle}; stroke-dash: 4; font-color: ${cycle}; font-size: 15; border-radius: 8 }",
    "  }",
    "  eager: { style: { stroke: ${line}; stroke-width: 1 } }",
    "  lazy: { style: { stroke: ${muted}; stroke-dash: 4 } }",
    "  cycle-edge: { style: { stroke: ${cycle}; stroke-width: 2 } }",
    "  legend: { shape: text; near: bottom-center; style: { font-color: ${muted}; font-size: 15 } }",
    "}",
    "",
  ];
  groups.forEach((g, i) => {
    lines.push(`cycle${i + 1}: "Eager import cycle: ${g.length} folders" {`);
    lines.push("  class: cycle-group");
    for (const n of g) lines.push(`  ${id(n)}: "${n}/" { class: folder }`);
    lines.push("}");
  });
  for (const n of drawn) if (!groupOf.has(n)) lines.push(`${id(n)}: "${n}/" { class: folder }`);
  lines.push("");

  // Edges out of a cycle to the same outside folder, to be merged when two or more share one.
  const leaving = new Map<string, Edge[]>();
  for (const e of drawnEdges) {
    const g = groupOf.get(e.from);
    if (g !== undefined && groupOf.get(e.to) !== g) {
      const key = `${g}\0${e.to}`;
      leaving.set(key, [...(leaving.get(key) ?? []), e]);
    }
  }
  const merged = new Set<string>();
  for (const e of drawnEdges) {
    const g = groupOf.get(e.from);
    const shared = g !== undefined ? leaving.get(`${g}\0${e.to}`) : undefined;
    if (shared && shared.length > 1) {
      const key = `${g}\0${e.to}`;
      if (merged.has(key)) continue;
      merged.add(key);
      const kind = shared.some((x) => x.kind === "eager") ? "eager" : "lazy";
      lines.push(arrow(`cycle${g}`, ref(e.to), kind, kind));
      continue;
    }
    const inside = g !== undefined && groupOf.get(e.to) === g;
    const cls = inside && e.kind === "eager" ? "cycle-edge" : e.kind;
    lines.push(arrow(ref(e.from), ref(e.to), e.kind, cls));
  }

  const fromEntry = new Set(edges.filter((e) => e.from === ENTRY).map((e) => e.to));
  const toCore = new Set(edges.filter((e) => e.to === CORE).map((e) => e.from));
  lines.push(
    "",
    `legend: "${[
      "An arrow points from a folder to one it imports.",
      "Solid: eager, the import loads with the module.",
      "Dashed: lazy, a getter or a call loads it later.",
      "An arrow from a cycle's box: two or more of its folders import that folder.",
      `${ENTRY} imports ${everyExcept(drawn, fromEntry)}.`,
      `${CORE}/ is imported by ${everyExcept(drawn, toCore)}.`,
    ].join("\\n")}" { class: legend }`,
  );
  return `${lines.join("\n")}\n`;
}

/** The tracked .js and .mjs files under vimma/ in a checkout, from git's index, sorted. */
export function readVimmaFiles(root: string): SourceFile[] {
  return execFileSync("git", ["ls-files", "-z", "--", VIMMA], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((f) => /\.m?js$/.test(f))
    .sort()
    .map((f) => ({ path: f.slice(VIMMA.length), code: readFileSync(join(root, f), "utf8") }));
}

function main(): void {
  const edges = folderEdges(readVimmaFiles(ROOT));
  const d2 = toD2(edges);
  const groups = cycleGroups(edges);
  const summary =
    `${edges.length} edges (${edges.filter((e) => e.kind === "lazy").length} lazy), ` +
    `${groups.length} eager cycle group(s): ${groups.map((g) => g.join(" ")).join("; ") || "none"}`;
  if (process.argv.includes("--check")) {
    let committed = "";
    try {
      committed = readFileSync(join(ROOT, MODULES_D2), "utf8");
    } catch {
      // Missing: reported below like a stale file.
    }
    if (committed !== d2) {
      console.error(
        `${MODULES_D2} does not match the imports under ${VIMMA}: run npm run diagrams ` +
          "and commit the result.",
      );
      process.exit(1);
    }
    console.log(`Module graph: ${MODULES_D2} matches the imports; ${summary}.`);
    return;
  }
  writeFileSync(join(ROOT, MODULES_D2), d2);
  console.log(`Wrote ${MODULES_D2}: ${summary}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
