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
//   node tools/arch-lint/arch-lint.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOC = "ARCHITECTURE.md";
const VIMMA = "src/browser/base/content/vimma/";
const TOOLS = "tools/";
const WORKFLOWS = ".github/workflows/";

/** @typedef {{ vimma: string[], tools: string[], workflows: string[] }} Entries */

/** Each kind: the code-span form that names an entry, the repository path and the form shown. */
const KINDS = /** @type {const} */ ([
  {
    key: "vimma",
    span: /^vimma\/([\w.-]+)\/$/,
    path: (/** @type {string} */ n) => `${VIMMA}${n}/`,
    form: (/** @type {string} */ n) => `vimma/${n}/`,
  },
  {
    key: "tools",
    span: /^tools\/([\w.-]+)\/$/,
    path: (/** @type {string} */ n) => `${TOOLS}${n}/`,
    form: (/** @type {string} */ n) => `tools/${n}/`,
  },
  {
    key: "workflows",
    span: /^([\w.-]+\.ya?ml)$/,
    path: (/** @type {string} */ n) => `${WORKFLOWS}${n}`,
    form: (/** @type {string} */ n) => n,
  },
]);

/**
 * The folders and workflows a Markdown text names in its code spans, in order, each once.
 * @param {string} md
 * @returns {Entries}
 */
export function namedEntries(md) {
  /** @type {Entries} */
  const named = { vimma: [], tools: [], workflows: [] };
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
 * @param {string} md  ARCHITECTURE.md
 * @param {Entries} repo  what the repository holds
 * @returns {string[]}
 */
export function archErrors(md, repo) {
  const named = namedEntries(md);
  /** @type {string[]} */
  const errors = [];
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
 * @param {string} root  the checkout
 * @returns {Entries}
 */
export function listEntries(root) {
  const files = execFileSync("git", ["ls-files", "-z", "--", VIMMA, TOOLS, WORKFLOWS], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  /** @param {string} prefix @returns {string[]} the first folder below `prefix`, sorted */
  const folders = (prefix) => [
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

function main() {
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
