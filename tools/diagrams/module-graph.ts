#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The module dependency picture in ARCHITECTURE.md is drawn from the imports, so it cannot
// disagree with the code (issue #943). The imports come from tools/layering, the scanner that
// checks ADR-026's layers, so the picture and the rule read the same edges. This folds them into
// one edge per pair of folders under src/browser/base/content/vimma/ and writes them as D2 to
// docs/assets/diagrams/modules.d2, the folders in bands by layer; tools/diagrams/render.ts draws it.
//
// An import is eager when it runs while its module loads and lazy when it runs later (a lazy
// getter, or a call inside a function), as tools/layering decides.
//
//   node tools/diagrams/module-graph.ts          write docs/assets/diagrams/modules.d2
//   node tools/diagrams/module-graph.ts --check  fail when the committed file differs

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Edge as FileEdge,
  type Exception,
  ROOT_FOLDER,
  folderOf,
  layerErrors,
  treeScan,
} from "../layering/layering.ts";
import { EXCEPTIONS, LAYERS } from "../layering/layers.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const VIMMA = "src/browser/base/content/vimma/";
export const MODULES_D2 = "docs/assets/diagrams/modules.d2";

export type Kind = "eager" | "lazy";

/** An import between two folders; `(root)` is vimma.js. */
export interface Edge {
  from: string;
  to: string;
  kind: Kind;
}

/** One edge per pair of folders that import each other, eager when any of the imports is. */
export function folderEdges(input: readonly FileEdge[]): Edge[] {
  const edges = new Map<string, Edge>();
  for (const e of input) {
    const from = folderOf(e.from);
    // A URL prefix (`host/`) names its folder.
    const to = folderOf(e.to.endsWith("/") ? `${e.to}-` : e.to);
    if (from === to) continue;
    const key = `${from}\0${to}`;
    const seen = edges.get(key);
    if (!seen) edges.set(key, { from, to, kind: e.kind });
    else if (e.kind === "eager") seen.kind = "eager";
  }
  return [...edges.values()].sort(byEnds);
}

/**
 * What `npm run layering` would report about the scanned tree: unreadable specifiers and imports
 * that break the layers. The picture is drawn only from a tree with none, so an orange arrow is
 * always a listed exception.
 */
export function inputErrors(
  edges: FileEdge[],
  problems: readonly string[],
  layers: Record<string, number>,
  exceptions: Exception[],
): string[] {
  return [...problems, ...layerErrors(edges, layers, exceptions)];
}

/** The lines only `committed` has ("- "), then those only `generated` has ("+ "). */
export function lineDiff(committed: string, generated: string): string[] {
  const a = committed.split("\n");
  const b = generated.split("\n");
  return [
    ...a.filter((l) => !b.includes(l)).map((l) => `- ${l}`),
    ...b.filter((l) => !a.includes(l)).map((l) => `+ ${l}`),
  ];
}

function byEnds(a: Edge, b: Edge): number {
  return a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from);
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
  return `every folder drawn here except ${listed(missing)}`;
}

function listed(items: readonly string[]): string {
  return items.length === 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The D2 source of the folder graph, the same text for the same edges in any order.
 *
 * Each folder carries its ADR-026 layer and sits in a row by it, the top layer first, so the
 * layering shows at a glance: an import down the layers is drawn plain, and an upward one, which
 * only tools/layering/layers.ts's exceptions allow, in the warning colour. Two folders would draw an edge to nearly every other
 * and hide the rest, so the legend states theirs instead: vimma.js, which imports every folder to
 * start it, and core/, which nearly every folder imports.
 */
export function toD2(
  input: readonly Edge[],
  layers: Record<string, number>,
  exceptions: readonly Exception[],
): string {
  const CORE = "core";
  const edges = [...input].sort(byEnds);
  const hidden = (n: string) => n === ROOT_FOLDER || n === CORE;
  const drawnEdges = edges.filter((e) => !hidden(e.from) && !hidden(e.to));
  // A folder that imports only core/ (services/) is still drawn, with no arrow.
  const drawn = [...new Set(edges.flatMap((e) => [e.from, e.to]))].filter((n) => !hidden(n)).sort();
  const layerOf = (n: string): number => {
    const layer = layers[n];
    if (layer === undefined) throw new Error(`${n}/ has no layer in tools/layering/layers.ts`);
    return layer;
  };
  const layersDrawn = [...new Set(drawn.map(layerOf))].sort((x, y) => y - x);
  const isUp = (e: Edge) => layerOf(e.to) >= layerOf(e.from);
  const listedPairs = new Set(exceptions.map((x) => `${folderOf(x.from)}\0${folderOf(x.to)}`));
  for (const e of drawnEdges)
    if (isUp(e) && !listedPairs.has(`${e.from}\0${e.to}`))
      throw new Error(
        `${e.from}/ imports ${e.to}/ upwards, and no exception in tools/layering/layers.ts lists it: npm run layering says more`,
      );

  // A layer of three or more folders would gather a fan of arrows from each importer, so an
  // importer that reaches two or more of its folders gets one arrow to the layer's band,
  // labelled with how many. Only downward imports merge; an upward one is always drawn alone.
  const bandSize = (layer: number) => drawn.filter((d) => layerOf(d) === layer).length;
  const into = new Map<string, Edge[]>();
  for (const e of drawnEdges) {
    if (isUp(e) || bandSize(layerOf(e.to)) < 3) continue;
    const key = `${e.from}\0${layerOf(e.to)}`;
    into.set(key, [...(into.get(key) ?? []), e]);
  }
  const mergedKeys = new Set([...into].filter(([, list]) => list.length > 1).map(([k]) => k));
  const banded = new Set([...mergedKeys].map((k) => Number(k.split("\0")[1])));
  const ref = (n: string) => (banded.has(layerOf(n)) ? `layer${layerOf(n)}.${id(n)}` : id(n));

  const lines = [
    "# Generated by npm run diagrams from the imports under src/browser/base/content/vimma/",
    "# (tools/diagrams/module-graph.ts). Do not edit: change the code, then regenerate.",
    "",
    "direction: down",
    "",
    "classes: {",
    "  band: {",
    "    label.near: outside-top-left",
    "    style: { fill: ${zone-app}; stroke: ${box-line}; stroke-dash: 4; font-color: ${muted}; font-size: 16; border-radius: 8 }",
    "  }",
    "  folder: {",
    "    style: { fill: ${bg}; stroke: ${box-line}; font-color: ${text}; font-size: 18; border-radius: 6 }",
    "  }",
    "  order: { style: { opacity: 0 } }",
    "  down: { style: { stroke: ${line}; stroke-width: 1 } }",
    "  down-lazy: { style: { stroke: ${line}; stroke-dash: 4 } }",
    "  up: { style: { stroke: ${cycle}; stroke-width: 2 } }",
    "  up-lazy: { style: { stroke: ${cycle}; stroke-width: 2; stroke-dash: 4 } }",
    "  legend: { shape: text; near: bottom-center; style: { font-color: ${muted}; font-size: 17 } }",
    "}",
    "",
  ];
  for (const layer of layersDrawn) {
    const band = banded.has(layer);
    if (band) lines.push(`layer${layer}: "Layer ${layer}" {`, "  class: band");
    for (const n of drawn.filter((d) => layerOf(d) === layer))
      lines.push(`${band ? "  " : ""}${id(n)}: "${n}/ · ${layer}" { class: folder }`);
    if (band) lines.push("}");
  }
  lines.push("");
  // ELK places a folder only as far down as its arrows push it, so a folder that imports
  // nothing of the next layer below (start/ imports only ui/) would sink towards the bottom.
  // An invisible link to that layer holds each folder in its row.
  for (const n of drawn) {
    const below = layersDrawn.find((l) => l < layerOf(n));
    if (below === undefined) continue;
    const reaches = drawnEdges.some((e) => e.from === n && !isUp(e) && layerOf(e.to) === below);
    if (reaches) continue;
    const first = drawn.find((d) => layerOf(d) === below) ?? "";
    lines.push(`${ref(n)} -> ${banded.has(below) ? `layer${below}` : ref(first)} { class: order }`);
  }
  lines.push("");
  // ELK layers a graph by its edges' direction, source above target. An upward edge is written
  // target first (`b <- a` draws the same arrow from a to b), so that it does not pull a lower
  // folder above a higher one.
  const written = new Set<string>();
  for (const e of drawnEdges) {
    const lazy = (kind: Kind) => (kind === "lazy" ? "-lazy" : "");
    const key = `${e.from}\0${layerOf(e.to)}`;
    if (!isUp(e) && mergedKeys.has(key)) {
      if (written.has(key)) continue;
      written.add(key);
      const list = into.get(key) ?? [];
      const kind = list.some((x) => x.kind === "eager") ? "eager" : "lazy";
      lines.push(
        `${ref(e.from)} -> layer${layerOf(e.to)}: "${list.length}" { class: down${lazy(kind)} }`,
      );
      continue;
    }
    lines.push(
      isUp(e)
        ? `${ref(e.to)} <- ${ref(e.from)} { class: up${lazy(e.kind)} }`
        : `${ref(e.from)} -> ${ref(e.to)} { class: down${lazy(e.kind)} }`,
    );
  }

  const fromEntry = new Set(edges.filter((e) => e.from === ROOT_FOLDER).map((e) => e.to));
  const toCore = new Set(edges.filter((e) => e.to === CORE).map((e) => e.from));
  const issues = [...new Set(exceptions.flatMap((x) => (x.issue ? [`#${x.issue}`] : [])))].sort();
  const cycles = cycleGroups(drawnEdges).map((g) => g.map((n) => `${n}/`).join(", "));
  lines.push(
    "",
    `legend: "${[
      "An arrow points from a folder to one it imports: solid when the import loads with the",
      "module (eager), dashed when a getter or a call loads it later (lazy).",
      "Grey: down the layers, as ADR-026 allows.",
      ...(mergedKeys.size ? ["An arrow to a band: imports that many of its folders."] : []),
      exceptions.length
        ? `Orange: the ${exceptions.length} upward imports tools/layering/layers.ts lists, one arrow per pair of folders` +
          (issues.length ? ` (${listed(issues)} removes them).` : ".")
        : "No arrow points up: ADR-026 allows no upward import.",
      ...cycles.map((c) => `Eager cycle, closed only by orange arrows: ${c}.`),
      `vimma.js imports ${everyExcept(drawn, fromEntry)}.`,
      `${CORE}/ is imported by ${everyExcept(drawn, toCore)}.`,
    ].join("\\n")}" { class: legend }`,
  );
  return `${lines.join("\n")}\n`;
}

function main(): void {
  const { edges: fileEdges, problems } = treeScan(ROOT);
  const errors = inputErrors(fileEdges, problems, LAYERS, EXCEPTIONS);
  if (errors.length) {
    for (const e of errors) console.error(e);
    console.error("\nModule graph: not drawn until npm run layering passes.");
    process.exit(1);
  }
  const edges = folderEdges(fileEdges);
  const d2 = toD2(edges, LAYERS, EXCEPTIONS);
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
      for (const line of lineDiff(committed, d2)) console.error(line);
      console.error(
        `\n${MODULES_D2} does not match the imports under ${VIMMA}: run npm run diagrams ` +
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
