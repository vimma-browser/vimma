# ADR-004: Language: JavaScript ES modules with JSDoc types

- Status: Accepted; amended by [ADR-025](025-typescript-for-tools.md) (Node-side tooling under
  `tools/` is TypeScript that Node runs unbuilt)
- Date: 2026-10-09

## Context

Firefox chrome code is JS (`.sys.mjs` / `.mjs`). We want type safety without a compile step inside the Firefox tree.

## Decision

Write plain ES modules with JSDoc types, type-checked by `tsc --checkJs` (no emit) in CI.

## Reasoning

No transpile step means patches and stack traces map 1:1 to source; debugging in the Browser Toolbox works directly.

## Alternatives rejected

- **TypeScript with a build step**: complicates Surfer integration and debugging inside the Firefox tree.

## Consequences

JSDoc is more verbose than TS syntax; tsc strictness must be enforced in CI.

Amended by [ADR-025](025-typescript-for-tools.md): this decision still covers the code Firefox
loads and `packages/vimma-core`; `tools/`, which only Node runs, moves to TypeScript with no build
step, since Node 22.18 erases the types itself.
