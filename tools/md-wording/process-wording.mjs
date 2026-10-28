#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Vimma's Markdown is documentation for readers who were not part of the work
// (docs/specs/README.md, "Writing rules"): it states decisions with their reasons, never who
// asked for them, when, quoted chat or agent notes. This check (npm run lint, and CI) fails on
// wording that only makes sense as a record of that process.
//
// A paragraph that has to name the phrases, such as the rule itself, carries a marker with a
// reason: <!-- process-wording: why this paragraph may use them -->. A paragraph is a run of
// non-blank lines, so a marker in a tight list covers the whole list. A marker without a reason
// exempts nothing.
//
//   node tools/md-wording/process-wording.mjs [file.md ...]   (default: every tracked .md file)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Each pattern is a plain alternation (no nested quantifiers), matched case-insensitively
// against a paragraph whose lines are joined with a space, so a phrase may break across lines.
// They target who asked or decided, the people running the work, and session leftovers; the
// person using Vimma ("waits for the user's answer"), Firefox's session and Claude Code are
// product wording and do not match.
export const PATTERNS = [
  // the person who asked for the work, as the source of a decision
  /\buser(?:'s)?\s+(?:request|decision|decided|report|asked|said|wants|wanted|chose|approved|confirmed|words)\b/gi,
  /\bmaintainer(?:'s)?\s+(?:request|decision|decided|asked|said|wants|wanted|chose|approved|confirmed)\b/gi,
  /\b(?:flagged\s+for|asking|not\s+asked\s+of)\s+the\s+user\b/gi,
  /\byou\s+asked\s+for\b/gi,
  // attributions and dates of answers: "(user, 2026-10-11)", "(the maintainer)", "Answered 2026-"
  // (not a call such as `mergeWithDefaults(user, order)`; process-wording: quotes what it matches)
  /(?<![\w$])\((?:the\s+)?(?:user|maintainer)(?:[,:)])/gi,
  /\banswered\s+20\d\d-/gi,
  // the agents and sessions that did the work
  /\bcoordinator\b/gi,
  /\bhand-?over\b/gi,
  /\bfirst\s+draft\b(?!\s+release)/gi,
  /claude\.ai\/code\/session/gi,
  // a review as the source of a reason: "Security review of #182", "security review, finding 2",
  // "Review round 1", "PR #148 review"; the reason stays, the attribution goes
  // (process-wording: quotes what the patterns match)
  /\b(?:security\s+)?review(?:\s+of\s+(?:PR\s+)?#\d+|,\s+(?:finding\s+\d+|PR\s+#\d+)|\s+round\b)/gi,
  /\bPR\s+#\d+(?:'s)?\s+review\b/gi,
  // the contributor instructions for coding agents, not a reason a reader can check; the pointers
  // that send agents there (README, CONTRIBUTING) carry a marker
  /\b(?:CLAUDE|AGENTS)\.md\b/gi,
];

const MARKER = /<!--\s*process-wording:\s*\S[^>]*-->/;

/**
 * Process wording in a Markdown text, outside paragraphs exempted by a marker with a reason.
 * @param {string} md
 * @returns {{ line: number, phrase: string }[]}
 */
export function findProcessWording(md) {
  const found = [];
  const lines = md.split("\n");
  let start = 0;
  while (start < lines.length) {
    let end = start;
    while (end < lines.length && lines[end].trim() !== "") end++;
    if (end > start) found.push(...inParagraph(lines.slice(start, end), start + 1));
    start = end + 1;
  }
  return found;
}

/**
 * @param {string[]} lines  one paragraph
 * @param {number} first  the line number of its first line
 * @returns {{ line: number, phrase: string }[]}
 */
function inParagraph(lines, first) {
  if (MARKER.test(lines.join(" "))) return [];
  return matchPatterns(lines, first, PATTERNS);
}

/**
 * Every match of `patterns` in a paragraph whose lines are joined with a space, so a phrase may
 * break across lines, reported on the line where it starts.
 * @param {string[]} lines  one paragraph
 * @param {number} first  the line number of its first line
 * @param {RegExp[]} patterns  global regular expressions
 * @returns {{ line: number, phrase: string }[]}
 */
export function matchPatterns(lines, first, patterns) {
  const text = lines.join(" ");
  /** @type {number[]} */
  const offsets = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += line.length + 1;
  }
  const lineOf = (/** @type {number} */ index) => {
    let i = 0;
    while (i + 1 < offsets.length && offsets[i + 1] <= index) i++;
    return first + i;
  };
  const hits = [];
  for (const pattern of patterns) {
    for (const m of text.matchAll(pattern)) {
      hits.push({ index: m.index, line: lineOf(m.index), phrase: m[0].replace(/\s+/g, " ") });
    }
  }
  return hits.sort((a, b) => a.index - b.index).map(({ line, phrase }) => ({ line, phrase }));
}

/** @returns {string[]} the tracked Markdown files, repo-relative */
function trackedMarkdown() {
  const out = execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.split("\0").filter(Boolean);
}

function main() {
  const files = process.argv.slice(2);
  const paths = files.length > 0 ? files : trackedMarkdown();
  let problems = 0;
  for (const path of paths) {
    const md = readFileSync(resolve(ROOT, path), "utf8");
    for (const { line, phrase } of findProcessWording(md)) {
      console.error(`${path}:${line}: process wording "${phrase}" (docs/specs/README.md)`);
      problems++;
    }
  }
  if (problems > 0) {
    console.error(
      `${problems} process wording problem(s). State the decision and its reason instead; see ` +
        "tools/md-wording/process-wording.mjs for the marker that exempts a paragraph.",
    );
    process.exit(1);
  }
  console.log(`Process wording: ${paths.length} Markdown files clean.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
