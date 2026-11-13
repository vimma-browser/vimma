# ADR-025: Node-side tooling under `tools/` is TypeScript that Node runs unbuilt

- Status: Accepted
- Date: 2026-11-13
- Amends: [ADR-004](004-javascript-jsdoc.md) ("JavaScript ES modules with JSDoc types"), for
  `tools/` only

## Context

ADR-004 chose JavaScript with JSDoc types so that the code Firefox loads needs no compile step.
`tools/` is not loaded by Firefox: it is the Node side of the project (the e2e harness, packaging,
the updater's signing tools, the upstream autopilot, the lints), about 250 files, half of them
tests. Since `npm run typecheck` checks it with Node's types (issue #945), its JSDoc carries the
whole type system in comments: casts as `/** @type {T} */ (x)`, which prettier moves when they
start an expression, typedefs that cannot be generic without `@template`, and imports of types as
`import("./x.mjs").T`. The same types read and review more easily as TypeScript syntax.

Node 22.18 and later run a `.ts` file directly by erasing its types (type stripping): no flag, no
build step, and nothing written to stderr. On Node 22.23.3, the version `.nvmrc` pins:

```sh
$ node main.ts     # imports ./double.ts; an interface, a type-only import, annotations, a cast
doubled 4          # stderr empty, exit 0
$ node enum.ts
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode
```

Node 22.17 does not run `.ts` at all (`ERR_UNKNOWN_FILE_EXTENSION`).

## Decision

1. Code under `tools/` may be TypeScript (`.ts`), and moves to it one area at a time
   (issue #946). Node runs it as it is; there is no build step and no emitted JavaScript.
2. Only syntax Node can erase is allowed: no `enum`, `namespace` with code, parameter properties,
   `import x = require()` or `export =`. `tools/tsconfig.json` enforces it with
   `erasableSyntaxOnly`. `verbatimModuleSyntax` makes a type-only import say `import type`, since
   Node removes types without looking at what they import. A relative import names the file Node
   loads, `./x.ts` (`allowImportingTsExtensions`; the configuration has `noEmit`), and a test
   checks that every relative import in `tools/**/*.ts` names a file that exists.
3. `package.json` asks for Node `>=22.18`, the first Node 22 that runs `.ts` without a flag.
4. `.ts` files get what `.mjs` files get: `npm run typecheck` checks them (their tests too, unlike
   the `.mjs` tests, issue #947), Vitest collects `tools/**/test/**/*.test.ts`, eslint applies the
   same rules (`no-undef` and `no-unused-vars` among them) and prettier formats them.
5. eslint reads a `.ts` file through amaro, the type stripper Node itself uses (MIT, no
   dependencies, no install script): in strip-only mode it replaces each type with spaces, so the
   lines and columns eslint reports are those of the `.ts` file, and syntax Node cannot erase is a
   parsing error. Type annotations are not linted; tsc checks them.
6. JavaScript with JSDoc stays, as ADR-004 decided, for everything Firefox loads
   (`src/browser/base/content/vimma/`) and for `packages/vimma-core`, which `npm run sync-core`
   copies into the browser unbuilt. A test fails when a `.ts` file is tracked outside `tools/`.

## Reasoning

- **No build step.** Type stripping keeps ADR-004's property for the tools: the file that runs is
  the file in the repository, stack traces point at its lines, and a workflow runs a tool with
  `node tools/<area>/<file>.ts` as it runs a `.mjs` one today.
- **Erasable syntax only.** It is what Node can run without transforming code, and it keeps a
  `.ts` file a JavaScript file with annotations: removing them gives the program that runs.
- **Firefox and vimma-core stay JavaScript.** Firefox loads `.sys.mjs` and `.mjs` modules from
  `chrome://` and `resource://` URLs and does not strip types; making it load TypeScript would
  need a build step inside the Surfer tree, which ADR-004 rejected. `packages/vimma-core` is
  copied into that tree unbuilt, so it has the same constraint for as long as it is.
- **amaro, not typescript-eslint.** typescript-eslint's parser needs TypeScript's JavaScript API
  (its peer range is `typescript <6.1`); TypeScript 7, which the repository pins, is a native
  compiler without that API, and npm cannot install both under the name `typescript`. amaro
  lints exactly the program Node runs and adds one package.

## Alternatives rejected

- **TypeScript with a build step (`tsc` emitting JavaScript, or a bundler)**: two copies of each
  tool, a step that can be forgotten before running one, and stack traces that need source maps.
- **Running `.ts` through a loader (`tsx`, `ts-node`) or `--experimental-strip-types`**: a flag
  or a dependency in every command and workflow that runs a tool, for what Node now does unasked.
- **typescript-eslint with TypeScript 6 beside TypeScript 7**: the parser resolves `typescript`
  through its peer dependency, which npm will not satisfy with a second version.
- **Keeping JSDoc in `tools/`**: it works, and ADR-004 still allows it, but types in comments are
  harder to write and review than the syntax they stand for.

## Consequences

- An area moves in its own pull request, by rename plus JSDoc-to-syntax with no change in logic
  (`CONTRIBUTING.md`, "TypeScript in tools/"). Until every area has moved, `tools/` holds both.
- A workflow that runs a tool on the runner's own Node, without `actions/setup-node` and
  `.nvmrc`, needs that step before its tool can move: the runner's Node may be older than 22.18.
- A workflow that runs the base branch's copy of a tool (`git show "$BASE:tools/…"`) looks for
  the `.ts` name first and the `.mjs` name second, so that the pull request that renames the tool
  is still checked by the base's copy.
- Contributors need Node 22.18 or later; `.nvmrc` already pins a later one.
