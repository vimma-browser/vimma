#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The code comments' counterpart of process-wording.mjs: a comment says why the code is the way
// it is, for readers who were not part of the work. This check (npm run lint, and CI) fails on a
// comment that records the process instead: the Markdown check's phrases (review attributions
// and pointers to the contributor instructions file among them), plus dated and quoted answers
// ("user: '...'"). A reason from a review stays; its attribution goes.
//
// Only comments are read: `//`, `/* */` (JavaScript, Rust, CSS) and `#` (shell, YAML, Python,
// TOML), found by a line scan that does not parse strings. A comment block is a run of lines that
// carry a comment; a block that has to name the phrases carries `process-wording: <reason>`. A
// marker without a reason exempts nothing.
//
//   node tools/md-wording/comment-wording.mjs [file ...]   (default: the tracked files in SCOPE)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PATTERNS, matchPatterns } from "./process-wording.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const CODE_PATTERNS = [
  ...PATTERNS,
  // a dated answer: "The user (2026-10-12): ..." (process-wording: quotes the match)
  /\buser\s+\(20\d\d-/gi,
  // a quoted answer: user: "agent should be able to …" (process-wording: quotes the match)
  /\buser:\s*["'“‘]/gi,
];

const MARKER = /\bprocess-wording:\s*\S/;

/** Tracked paths the check reads by default: our code, its tests, tools and workflows. */
const SCOPE = [
  /^src\/browser\/base\/content\/vimma\//,
  /^src\/browser\/themes\/(?:.+\/)?vimma\//,
  /^packages\//,
  /^tools\//,
  /^tests\//,
  /^\.github\//,
  /^eslint\.config\.mjs$/,
];
/** The checks' own tests: their strings quote the phrases, and the line scan reads strings. */
const OUT_OF_SCOPE = [/^tools\/md-wording\/test\//];

/**
 * How a file writes its comments, by extension; null for a file without comments to read.
 * @param {string} path
 * @returns {"slash" | "hash" | null}
 */
export function commentStyle(path) {
  if (/\.(?:[cm]?js|jsx|ts|rs|css)$/.test(path)) return "slash";
  if (/\.(?:sh|bash|ya?ml|py|toml)$/.test(path)) return "hash";
  return null;
}

/**
 * The comment text on each line (null where the line carries none).
 * @param {string} src
 * @param {"slash" | "hash"} style
 * @returns {(string | null)[]}
 */
function commentText(src, style) {
  const lines = src.split("\n");
  if (style === "hash") {
    return lines.map((line) => {
      const m = /(?:^|(?<=\s))#/.exec(line);
      return m ? line.slice(m.index).replace(/^[#!]*/, "") : null;
    });
  }
  let inBlock = false;
  return lines.map((line) => {
    /** @type {string[]} */
    const parts = [];
    let pos = 0;
    let any = false;
    while (pos <= line.length) {
      if (inBlock) {
        any = true;
        const end = line.indexOf("*/", pos);
        parts.push(line.slice(pos, end < 0 ? line.length : end).replace(/^\s*\*+/, ""));
        if (end < 0) break;
        inBlock = false;
        pos = end + 2;
        continue;
      }
      // A comment starts a line or follows whitespace, so `https://` and `src/**` are not one.
      const start = /(?:^|(?<=\s))\/[/*]/g;
      start.lastIndex = pos;
      const m = start.exec(line);
      if (!m) break;
      any = true;
      if (line[m.index + 1] === "/") {
        parts.push(line.slice(m.index + 2).replace(/^[/!]*/, ""));
        break;
      }
      inBlock = true;
      pos = m.index + 2;
    }
    return any ? parts.join(" ") : null;
  });
}

/**
 * Process wording in a source file's comments, outside blocks exempted by a marker with a reason.
 * @param {string} src
 * @param {"slash" | "hash"} style
 * @returns {{ line: number, phrase: string }[]}
 */
export function findCommentWording(src, style) {
  const texts = commentText(src, style);
  const found = [];
  let start = 0;
  while (start < texts.length) {
    if (texts[start] === null) {
      start++;
      continue;
    }
    let end = start;
    while (end < texts.length && texts[end] !== null) end++;
    const block = /** @type {string[]} */ (texts.slice(start, end));
    if (!MARKER.test(block.join(" ")))
      found.push(...matchPatterns(block, start + 1, CODE_PATTERNS));
    start = end;
  }
  return found;
}

/** @returns {string[]} the tracked files in SCOPE that have comments to read, repo-relative */
function trackedSources() {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  return out
    .split("\0")
    .filter(
      (path) =>
        path &&
        SCOPE.some((re) => re.test(path)) &&
        !OUT_OF_SCOPE.some((re) => re.test(path)) &&
        commentStyle(path) !== null,
    );
}

function main() {
  const files = process.argv.slice(2);
  const paths = files.length > 0 ? files : trackedSources();
  let problems = 0;
  for (const path of paths) {
    const style = commentStyle(path);
    if (style === null) continue;
    const src = readFileSync(resolve(ROOT, path), "utf8");
    for (const { line, phrase } of findCommentWording(src, style)) {
      console.error(`${path}:${line}: process wording in a comment "${phrase}"`);
      problems++;
    }
  }
  if (problems > 0) {
    console.error(
      `${problems} process wording problem(s) in comments. Keep the reason, drop who said it; ` +
        "see tools/md-wording/comment-wording.mjs for the marker that exempts a block.",
    );
    process.exit(1);
  }
  console.log(`Comment wording: ${paths.length} source files clean.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
