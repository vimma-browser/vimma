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

Node runs a `.ts` file directly by erasing its types (type stripping), with no flag, no build
step and nothing written to stderr, from 22.18 in the 22 line and from 24.3 on. On Node 22.23.3,
the version `.nvmrc` pins:

```sh
$ node main.ts     # imports ./double.ts; an interface, a type-only import, annotations, a cast
doubled 4          # stderr empty, exit 0
$ node enum.ts
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode
```

Measured on other versions with the same file: 22.17.1 and 23.5.0 do not run `.ts` at all
(`ERR_UNKNOWN_FILE_EXTENSION`); 23.6.0, 23.11.1 and 24.2.0 run it but print
`ExperimentalWarning: Type Stripping is an experimental feature` on stderr, which tools whose
tests compare stderr cannot have; 22.18.0 and 24.3.0 run it cleanly.

## Decision

1. New Node code under `tools/` is written as `.ts`; Rust, shell and Python stay as they are. The
   existing `.mjs` files move to `.ts` one area at a time (issue #946). Node runs it as it is;
   there is no build step and no emitted JavaScript. `tools/test/mjs-allowlist.txt` lists the
   `.mjs` files still to move, and a test fails on a `.mjs`, `.js` or `.cjs` file that is not
   listed or a listed one that is gone, so the list only shrinks. Decision 7's exception stands,
   and a script a browser page loads is outside the rule: it is a `.js` file in a `fixtures/`
   folder, which the test does not count.
2. Only syntax Node can erase is allowed: no `enum`, `namespace` with code, parameter properties,
   `import x = require()` or `export =`. `tools/tsconfig.json` enforces it with
   `erasableSyntaxOnly`. `verbatimModuleSyntax` makes a type-only import say `import type`, since
   Node removes types without looking at what they import. A relative import names the file Node
   loads, `./x.ts` (`allowImportingTsExtensions`; the configuration has `noEmit`), and a test
   checks that every relative import in `tools/**/*.ts` names a file that exists.
3. `package.json` asks for Node `^22.18.0 || >=24.3.0`: the versions measured above to run `.ts`
   with no flag and no warning.
4. `.ts` files get what `.mjs` files get: `npm run typecheck` checks them (their tests too, unlike
   the `.mjs` tests, issue #947), Vitest collects `tools/**/test/**/*.test.ts`, eslint applies the
   same rules (`no-undef` and `no-unused-vars` among them) and prettier formats them.
5. eslint reads a `.ts` file through amaro, the type stripper Node itself uses (MIT, no
   dependencies, no install script): in strip-only mode it replaces each type with spaces, so the
   lines and columns eslint reports are those of the `.ts` file, and syntax Node cannot erase is a
   parsing error at that syntax. Its limits:
   - Types are not linted. A mistake at the type level (a wrong annotation, an unknown type
     name) is caught by tsc alone.
   - eslint's amaro (the `package.json` version, 1.3.0 today) is not the one inside Node
     (`process.versions.amaro`: 1.1.8 in Node 22.23.3), so lint and runtime erase with
     different versions. tsc's `erasableSyntaxOnly` is the check that holds; the parse error is
     an earlier signal.
   - A value used only in a type position (`const sizes = [1]; type S = typeof sizes;`) is
     reported by `no-unused-vars`, because the type that uses it is gone. Such a value gets an
     `eslint-disable-next-line` with its reason, or the type is written out.
6. JavaScript with JSDoc stays, as ADR-004 decided, for everything Firefox loads
   (`src/browser/base/content/vimma/`) and for `packages/vimma-core`, which `npm run sync-core`
   copies into the browser unbuilt. A test fails when a `.ts` file is tracked outside `tools/`.
7. One exception inside `tools/`: the hooks of `tools/claude-plugin` stay `.mjs`. Claude Code and
   Copilot CLI run them on each contributor's own Node, which may be older than 22.18; there a
   `.ts` hook exits 1 with `ERR_UNKNOWN_FILE_EXTENSION`, and a hook that exits with anything but 2
   does not block, so the guard would stop guarding without a word. The plugin moves only with a
   plan that fails closed on such a Node, after a security review.
   A second exception: the guards that workflows run from the base branch, `tools/ci/docs-only.mjs`
   and `tools/ci/key-guard.mjs`, and key-guard's test, which the guard's `GUARD_PATHS` names, stay
   `.mjs`. They judge a pull request inside its checkout, so they run on the runner image's own
   Node with nothing of the pull request run first, and a `.ts` file would need a Node set up in
   that checkout: `actions/setup-node` runs `npm --version` and `yarn --version` there, and a
   package manager reads its configuration from the current directory (docs/security.md, B17).
   `tools/ci/tree-covered.mjs` runs only on pushes to `main`, from trusted files, and may move
   with the rest of `tools/ci`.

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
- A job that runs a tool on the runner's own Node (a `node` or `npm` step before any
  `actions/setup-node` with `.nvmrc`) needs that step before its tool can move: the runner's Node
  may be older than 22.18. On the day of this record those jobs are: ci.yml `check`,
  `vimma-ctl-macos` and `covered`; e2e.yml `changes`; key-guard.yml `key-guard`; pkgbuild.yml
  `covered`; semgrep.yml `covered`; dependabot-automerge.yml `classify`; downloads.yml `collect`;
  mutation.yml `report`; spec-status.yml `check`; upstream.yml `detect`, `track`, `publish`,
  `patch-issue` and `drift`; upstream-beta.yml `detect` and `render`; upstream-merge.yml `merge`.
- A job that checks out only some paths (`sparse-checkout: tools/ci/tree-covered.mjs` in
  pkgbuild.yml and semgrep.yml) names the new file when it moves.
- A step that runs the base branch's copy of a tool (`git show "$BASE:tools/…"`: ci.yml and
  e2e.yml for `docs-only.mjs`, key-guard.yml for `key-guard.mjs`) runs it on the runner's own
  Node, so those tools stay `.mjs` (decision 7, second exception). (Since changed: an earlier
  draft of this record had such steps look for a `.ts` name first; that needed Node set up in the
  pull request's checkout before the guard, which decision 7 now rules out.)
- Contributors need Node 22.18 or later in the 22 line, or 24.3 or later; `.nvmrc` pins 22.23.3.
