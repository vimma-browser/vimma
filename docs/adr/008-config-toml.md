# ADR-008: Config: one `config.toml`

- Status: Accepted; amended by [ADR-012](012-toml-parser-smol-toml.md) (the parser is smol-toml, BSD-3-Clause), and by #1379: config.toml has no `schema` version or migrations any more ([m5-core-config-and-theme](../specs/m5-core-config-and-theme.md))
- Date: 2026-10-09

## Context

Users need to rebind both layers, define workspaces and theme.

## Decision

One `~/.config/vimma/config.toml`: Herdr `[keys]` syntax for the prefix layer, per-mode tables (`[modal.normal]`, ...) for the modal layer, `[workspaces]`, `[theme]`, `[unbind]`. Schema has an integer `schema` version with migrations. A small MIT-licensed JS TOML parser is vendored. Actions are a closed set from `actions.mjs`.

## Reasoning

Matches Herdr muscle memory; Firefox ships no TOML parser.

## Alternatives rejected

- **JSON**: no comments, unfriendly to hand-edit.
- **prefs.js / about:config**: not file-based, no structure.

## Consequences

We own a vendored parser and the migration chain.
