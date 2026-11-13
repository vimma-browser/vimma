#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// ARCHITECTURE.md keeps up with the tree (issue #931), checked by `npm run arch-lint` (part of
// `npm run lint`) and by its own step in ci.yml, which runs on docs-only changes too: every
// folder of src/browser/base/content/vimma/, every folder of tools/ and every workflow in
// .github/workflows/ is named in it, and everything it names in those forms exists. An overview
// that silently fell behind the code is the failure this prevents.
//
// A name counts only in a code span, in one of three forms: `vimma/<folder>/`, `tools/<folder>/`
// and `<workflow>.yml` (or `.yaml`). Deeper paths, files and bare prose are not entries, so the
// document can mention them freely. The repository's side comes from `git ls-files`, so
// git-ignored folders (vimma/core/, which sync-core copies in) and stray local files never count.
//
//   node tools/arch-lint/arch-lint.ts

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOC = "ARCHITECTURE.md";
const VIMMA = "src/browser/base/content/vimma/";
const TOOLS = "tools/";
const WORKFLOWS = ".github/workflows/";

export interface Entries {
  vimma: string[];
  tools: string[];
  workflows: string[];
}

/** Each kind: the code-span form that names an entry, the repository path and the form shown. */
const KINDS = [
  {
    key: "vimma",
    span: /^vimma\/([\w.-]+)\/$/,
    path: (n: string) => `${VIMMA}${n}/`,
    form: (n: string) => `vimma/${n}/`,
  },
  {
    key: "tools",
    span: /^tools\/([\w.-]+)\/$/,
    path: (n: string) => `${TOOLS}${n}/`,
    form: (n: string) => `tools/${n}/`,
  },
  {
    key: "workflows",
    span: /^([\w.-]+\.ya?ml)$/,
    path: (n: string) => `${WORKFLOWS}${n}`,
    form: (n: string) => n,
  },
] as const;

/** The folders and workflows a Markdown text names in its code spans, in order, each once. */
export function namedEntries(md: string): Entries {
  const named: Entries = { vimma: [], tools: [], workflows: [] };
  for (const m of md.matchAll(/`([^`\n]+)`/g)) {
    for (const kind of KINDS) {
      const name = kind.span.exec(m[1] ?? "")?.[1];
      if (name && !named[kind.key].includes(name)) named[kind.key].push(name);
    }
  }
  return named;
}

/**
 * What the document misses and what it names that does not exist.
 * @param md  ARCHITECTURE.md
 * @param repo  what the repository holds
 */
export function archErrors(md: string, repo: Entries): string[] {
  const named = namedEntries(md);
  const errors: string[] = [];
  for (const kind of KINDS) {
    for (const name of repo[kind.key])
      if (!named[kind.key].includes(name))
        errors.push(`${kind.path(name)} is missing: describe it as \`${kind.form(name)}\``);
  }
  for (const kind of KINDS) {
    for (const name of named[kind.key])
      if (!repo[kind.key].includes(name))
        errors.push(`\`${kind.form(name)}\` names ${kind.path(name)}, which does not exist`);
  }
  return errors;
}

/**
 * The tracked folders and workflows of a checkout, from git's index.
 * @param root  the checkout
 */
export function listEntries(root: string): Entries {
  const files = execFileSync("git", ["ls-files", "-z", "--", VIMMA, TOOLS, WORKFLOWS], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  /** @returns the first folder below `prefix`, sorted */
  const folders = (prefix: string): string[] => [
    ...new Set(
      files
        .filter((f) => f.startsWith(prefix) && f.slice(prefix.length).includes("/"))
        .map((f) => f.slice(prefix.length).split("/")[0] ?? ""),
    ),
  ];
  const workflows = files
    .filter((f) => f.startsWith(WORKFLOWS) && /^[^/]+\.ya?ml$/.test(f.slice(WORKFLOWS.length)))
    .map((f) => f.slice(WORKFLOWS.length));
  return {
    vimma: folders(VIMMA).sort(),
    tools: folders(TOOLS).sort(),
    workflows: workflows.sort(),
  };
}

function main(): void {
  let md = "";
  try {
    md = readFileSync(join(ROOT, DOC), "utf8");
  } catch {
    console.error(`${DOC} is missing: it is the map of the code (issue #931).`);
    process.exit(1);
  }
  const errors = archErrors(md, listEntries(ROOT));
  if (errors.length) {
    for (const e of errors) console.error(`${DOC}: ${e}`);
    console.error(
      `\nArchitecture lint: ${errors.length} problem(s). The rules: ${DOC}, "Keeping it current".`,
    );
    process.exit(1);
  }
  console.log("Architecture lint: every vimma/ folder, tools/ folder and workflow is described.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
