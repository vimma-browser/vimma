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
// may name it or build a Vimma URL from parts, so a new caller is a reviewed change. Where a rule
// could list forms to refuse, it lists instead the one form the tree uses and refuses the rest:
// ChromeUtils only as ChromeUtils.<name>, the loader only called directly, a lazy getter object
// only a fresh const, the gate only by its exact URL, jar.mn and vimma/moz.build only as they
// are, only the file types the check reads (ADR-026, "Limits of the check"). Tabs and line
// breaks, a query, a fragment, `.` or `..` segments, `%` escapes or the case of a URL's scheme
// and host do not hide an import; a string that names content/vimma/ without resolving is an
// error, and so is one that reaches a Vimma file through resource:// (ALIAS_ROOTS).
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
//
// This file runs the check and re-exports what the tests and tools/diagrams import. The checks
// live beside it, one module each, along the list in docs/security.md section 12: urls.ts (load
// positions and URL cleaning), loader.ts (the loader rule), scan.ts (the module scan),
// restricted.ts (the gate's importers and file name), hand-ons.ts, pages.ts, packaging.ts
// (jar.mn, vimma/moz.build, file types), encoding.ts, patches.ts (Firefox patches) and
// vimma-core.ts; layer-rules.ts holds the layers and cycles, tree.ts the walk over the tree, and
// model.ts what they share.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ADR } from "./model.ts";
import { treeErrors } from "./tree.ts";

export { encodingErrors } from "./encoding.ts";
export { getterNames } from "./hand-ons.ts";
export { eagerCycles, exceptionErrors, folderOf, layerErrors } from "./layer-rules.ts";
export {
  type Edge,
  type Exception,
  type HandOn,
  type Mention,
  type Restricted,
  type Scan,
  lettersOnly,
  ROOT_FOLDER,
} from "./model.ts";
export {
  danglingEdges,
  fileTypeErrors,
  jarErrors,
  jarModules,
  mozBuildErrors,
} from "./packaging.ts";
export { htmlImports } from "./pages.ts";
export { patchErrors } from "./patches.ts";
export { restrictedErrors } from "./restricted.ts";
export { importsOf, scanModule } from "./scan.ts";
export { missingReadmes, trackedFiles, treeErrors, treeScan } from "./tree.ts";
export { coreErrors } from "./vimma-core.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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
