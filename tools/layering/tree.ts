/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The tree walk: every file the check covers, read once each as UTF-8, and every check run in
// the order its errors are reported.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXCEPTIONS, LAYERS, RESTRICTED } from "./layers.ts";
import { encodingErrors } from "./encoding.ts";
import { getterNames } from "./hand-ons.ts";
import { eagerCycles, exceptionErrors, folderOf, layerErrors } from "./layer-rules.ts";
import { ADR, type Edge, type Scan, VIMMA } from "./model.ts";
import {
  danglingEdges,
  fileTypeErrors,
  jarErrors,
  jarModules,
  mozBuildErrors,
} from "./packaging.ts";
import { htmlImports } from "./pages.ts";
import { patchErrors } from "./patches.ts";
import { restrictedErrors } from "./restricted.ts";
import { scanModule } from "./scan.ts";
import { coreErrors } from "./vimma-core.ts";

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

/** Encoding problems of the files the tree check has read (readText). */
let encodingProblems: string[] = [];

/** The one way the tree check reads a file: as UTF-8, with its encoding checked. */
function readText(path: string, label: string): string {
  const bytes = readFileSync(path);
  const problems = encodingErrors(bytes, label);
  encodingProblems.push(...problems);
  // A file whose bytes are not what the check reads them as is reported, not parsed: the
  // parser's own error would hide the reason.
  return problems.length ? "" : bytes.toString("utf8");
}

/** Every edge of the tree, and every specifier in it that cannot be read. */
export function treeScan(root: string): Scan {
  const scans = trackedFiles(root).map((f) => {
    const text = readText(join(root, VIMMA, f), `vimma/${f}`);
    return f.endsWith(".html") ? htmlImports(text, f) : scanModule(text, f);
  });
  return {
    edges: scans.flatMap((s) => s.edges),
    problems: scans.flatMap((s) => s.problems),
    handOns: scans.flatMap((s) => s.handOns ?? []),
    names: scans.flatMap((s) => s.names ?? []),
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
    .map((file) => ({ file, text: readText(join(root, file), file) }));
}

/** The files git tracks under a folder of the repository, relative to the repository. */
function gitFiles(root: string, folder: string): string[] {
  return execFileSync("git", ["ls-files", "-z", "--", folder], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

/** Everything `npm run layering` checks in the tree at `root`, and the edges it read. */
export function treeErrors(root: string): { edges: Edge[]; errors: string[] } {
  encodingProblems = [];
  const { edges, problems, handOns = [], names = [] } = treeScan(root);
  const data = Object.fromEntries(
    Object.keys(RESTRICTED).map((m) => {
      const path = join(root, VIMMA, m);
      return [
        m,
        existsSync(path) ? getterNames(readText(path, `vimma/${m}`), m) : new Set<string>(),
      ];
    }),
  );
  const jar = readText(join(root, VIMMA, "jar.mn"), "vimma/jar.mn");
  const vimmaFiles = gitFiles(root, VIMMA).map((f) => f.slice(VIMMA.length));
  const mozBuild = join(root, VIMMA, "moz.build");
  const core = gitFiles(root, "packages/vimma-core/src/").filter((f) => /\.m?js$/.test(f));
  const errors = [
    ...problems,
    ...fileTypeErrors(vimmaFiles),
    ...(existsSync(mozBuild) ? mozBuildErrors(readText(mozBuild, "vimma/moz.build")) : []),
    ...core.flatMap((f) => coreErrors(readText(join(root, f), f), f)),
    ...jarErrors(jar),
    ...danglingEdges(edges, new Set(trackedFiles(root)), jarModules(jar)),
    ...exceptionErrors(EXCEPTIONS),
    ...layerErrors(edges, LAYERS, EXCEPTIONS),
    ...restrictedErrors(edges, RESTRICTED, handOns, data, names),
    ...patchErrors(trackedPatches(root), RESTRICTED),
    ...eagerCycles(edges),
    ...missingReadmes(root).map(
      (d) => `vimma/${d}/ has no README.md: say what it owns and what it may import (${ADR})`,
    ),
    // Last, after every read above.
    ...encodingProblems,
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
