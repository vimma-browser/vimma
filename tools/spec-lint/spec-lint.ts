#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The shape docs/specs/README.md asks of specs and ADRs, checked in `npm run lint` and CI:
//
// - Every spec's `Status:` line starts with draft, accepted or implemented; every ADR's
//   `- Status:` line with Proposed, Accepted, Superseded, Deprecated or Rejected. A note may
//   follow the word.
// - A draft or accepted spec names its GitHub issue on an `Issue:` (or `Issues:`) line in its
//   header, so tools/spec-lint/spec-status.mjs can compare the two.
// - In a draft or accepted spec, every decision states its reason. A decision is a numbered item
//   with a bold title, at the start of a line, in the Design section or a section whose heading
//   says "Decisions". Its text must contain a reason word (REASON below). Implemented specs are
//   frozen history and are not checked. Decisions written before this check are listed in
//   decisions-baseline.json; an entry that is no longer needed fails, so the list only shrinks.
//
//   node tools/spec-lint/spec-lint.mjs

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BASELINE = join(dirname(fileURLToPath(import.meta.url)), "decisions-baseline.json");

export const SPEC_STATUSES = Object.freeze(["draft", "accepted", "implemented"]);
export const ADR_STATUSES = Object.freeze([
  "Proposed",
  "Accepted",
  "Superseded",
  "Deprecated",
  "Rejected",
]);
/** Statuses whose decisions are checked and which need an issue: the spec is still live. */
const LIVE = new Set(["draft", "accepted"]);

/**
 * Words that introduce a reason. Plain words, not a grammar: a decision written to the README's
 * rule ("Vimma does X, because Y") always has one, and a bare statement never does.
 */
const REASON = /\b(?:because|so that|so|since|reasons?|in order to)\b(?=[\s:,.])/i;

/**
 * The header: everything before the first `## ` heading.
 * @param {string} md
 */
function header(md) {
  const m = /^## /m.exec(md);
  return m ? md.slice(0, m.index) : md;
}

/**
 * The first word after a `Status:` label, and whether what follows it is a note (end of line,
 * a space, a parenthesis, a comma or a semicolon) rather than more of the word.
 * @param {string} md
 * @param {RegExp} label  matches the label at the start of a line
 * @returns {{ word: string, rest: string } | null}
 */
function statusOf(md, label) {
  const line = header(md)
    .split("\n")
    .find((l) => label.test(l));
  if (line === undefined) return null;
  const value = line.replace(label, "").trim();
  const m = /^([^\s(,;·|]*)(.*)$/.exec(value);
  return { word: m?.[1] ?? "", rest: m?.[2] ?? "" };
}

const SPEC_LABEL = /^Status:\s*/;
const ADR_LABEL = /^- Status:\s*/;
const ISSUE_LABEL = /^Issues?:\s*/;

/**
 * @param {string} md  a spec
 * @returns {{ status: string | null, issues: number[] }}
 */
export function parseSpec(md) {
  const s = statusOf(md, SPEC_LABEL);
  // The `Issue:` paragraph: its line and the lines that continue it, up to a blank line.
  const lines = header(md).split("\n");
  const at = lines.findIndex((l) => ISSUE_LABEL.test(l));
  let end = at;
  while (at >= 0 && end < lines.length && (lines[end] ?? "").trim() !== "") end++;
  const line = at >= 0 ? lines.slice(at, end).join(" ") : undefined;
  const issues = line ? [...new Set([...line.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))] : [];
  return { status: s ? s.word : null, issues };
}

/**
 * @param {{ word: string, rest: string } | null} s
 * @param {readonly string[]} allowed
 * @param {string} label  how the line is written, for the message
 * @returns {string[]}
 */
function statusErrors(s, allowed, label) {
  if (!s) return [`status: no \`${label}\` line in the header`];
  const list = `${allowed.slice(0, -1).join(", ")} or ${allowed.at(-1)}`;
  if (!allowed.includes(s.word) || /^\s*\|/.test(s.rest))
    return [`status: "${s.word}${s.rest.slice(0, 20)}" must start with ${list}`];
  return [];
}

/**
 * The status and issue rules for one spec.
 * @param {string} md
 * @returns {string[]}
 */
export function specErrors(md) {
  const s = statusOf(md, SPEC_LABEL);
  const errors = statusErrors(s, SPEC_STATUSES, "Status:");
  if (errors.length === 0 && s && LIVE.has(s.word) && parseSpec(md).issues.length === 0)
    errors.push(
      `issue: a ${s.word} spec names its GitHub issue on an \`Issue: #N\` line in its header`,
    );
  return errors;
}

/**
 * The status rule for one ADR.
 * @param {string} md
 * @returns {string[]}
 */
export function adrStatusErrors(md) {
  return statusErrors(statusOf(md, ADR_LABEL), ADR_STATUSES, "- Status:");
}

/** @param {string} text */
export function hasReason(text) {
  return REASON.test(text.replace(/\s+/g, " ") + " ");
}

/**
 * The decisions of a spec: numbered items with a bold title at the start of a line, in the
 * Design section (and its sub-sections) or a section whose heading names decisions.
 * @param {string} md
 * @returns {{ number: number, title: string, line: number, text: string }[]}
 */
export function findDecisions(md) {
  /** @type {{ number: number, title: string, line: number, text: string }[]} */
  const found = [];
  let inSection = false;
  /** @type {{ number: number, title: string, line: number, text: string } | null} */
  let current = null;
  let blank = false;
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const heading = /^(#{2,6})\s+(.*)$/.exec(line);
    if (heading) {
      current = null;
      const [, hashes, text] = heading;
      if (hashes === "##") inSection = /^(?:[A-Z]\.\s*)?design\b|\bdecisions\b/i.test(text ?? "");
      else if (/\bdecisions\b/i.test(text ?? "")) inSection = true;
      continue;
    }
    if (!inSection) continue;
    const item = /^(\d+)\.\s+\*\*(.+?)\*\*/.exec(line);
    if (item) {
      current = { number: Number(item[1]), title: item[2] ?? "", line: i + 1, text: line };
      found.push(current);
      blank = false;
      continue;
    }
    if (!current) continue;
    if (line.trim() === "") {
      blank = true;
      continue;
    }
    // After a blank line, an unindented line that is not a list item ends the decision.
    if (blank && /^\S/.test(line)) {
      current = null;
      continue;
    }
    current.text += "\n" + line;
    blank = false;
  }
  return found;
}

/**
 * The reason rule for one spec.
 * @param {string} file  for the messages
 * @param {string} md
 * @param {readonly string[]} baseline  titles of this spec's decisions written before the rule
 * @returns {{ errors: string[], used: string[] }}  `used`: the baseline titles still needed
 */
export function decisionErrors(file, md, baseline) {
  const { status } = parseSpec(md);
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const used = [];
  if (!status || !LIVE.has(status)) return { errors, used };
  for (const d of findDecisions(md)) {
    if (hasReason(d.text)) continue;
    if (baseline.includes(d.title)) {
      if (!used.includes(d.title)) used.push(d.title);
      continue;
    }
    errors.push(
      `${file}:${d.line}: decision ${d.number} "${d.title}" has no reason: say why ("because", ` +
        `"so that", "Reason:"), as docs/specs/README.md asks`,
    );
  }
  return { errors, used };
}

/**
 * Baseline entries no longer needed: the decision now has a reason, was renamed or removed, or
 * its spec is implemented.
 * @param {Record<string, string[]>} baseline
 * @param {Record<string, string[]>} used
 * @returns {string[]}
 */
export function staleBaseline(baseline, used) {
  /** @type {string[]} */
  const errors = [];
  for (const [file, titles] of Object.entries(baseline))
    for (const title of titles)
      if (!(used[file] ?? []).includes(title))
        errors.push(
          `${file}: baseline entry "${title}" is no longer needed: remove it from ` +
            `tools/spec-lint/decisions-baseline.json`,
        );
  return errors;
}

/** @param {string} dir @returns {string[]} the Markdown files in it, sorted */
const markdown = (dir) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort();

function main() {
  /** @type {Record<string, string[]>} */
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  /** @type {Record<string, string[]>} */
  const used = {};
  /** @type {string[]} */
  const errors = [];
  for (const file of markdown("docs/specs")) {
    const md = readFileSync(join(ROOT, "docs/specs", file), "utf8");
    for (const e of specErrors(md)) errors.push(`docs/specs/${file}: ${e}`);
    const r = decisionErrors(`docs/specs/${file}`, md, baseline[file] ?? []);
    errors.push(...r.errors);
    if (r.used.length) used[file] = r.used;
  }
  for (const e of staleBaseline(baseline, used)) errors.push(`docs/specs/${e}`);
  for (const file of markdown("docs/adr")) {
    const md = readFileSync(join(ROOT, "docs/adr", file), "utf8");
    for (const e of adrStatusErrors(md)) errors.push(`docs/adr/${file}: ${e}`);
  }
  if (errors.length) {
    for (const e of errors) console.error(e);
    console.error(`\nSpec lint: ${errors.length} problem(s). The rules: docs/specs/README.md.`);
    process.exit(1);
  }
  console.log("Spec lint: statuses, issues and decision reasons are in order.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
