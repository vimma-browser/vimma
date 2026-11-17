/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// For the any ratchets: the `any` types in a JavaScript file's JSDoc, as `tsc --checkJs` reads
// them. Code Firefox loads and vimma-core stay JavaScript with JSDoc (ADR-025, decision 6), and
// checkJs accepts `any` there, which turns its checks off; each ratchet counts these in its tree.

import { readFileSync } from "node:fs";
import { relative } from "node:path";

/**
 * The type expressions of a source's JSDoc comments: the braces after a tag such as `@param`,
 * `@type` or `@typedef`, nested braces included. Prose that says "any" is not counted.
 */
export function jsdocTypes(source: string): string[] {
  const types: string[] = [];
  for (const comment of source.match(/\/\*\*[\s\S]*?\*\//g) ?? []) {
    for (const tag of comment.matchAll(/@[a-zA-Z]+\s*\{/g)) {
      let depth = 0;
      const start = (tag.index ?? 0) + tag[0].length - 1;
      for (let i = start; i < comment.length; i++) {
        if (comment[i] === "{") depth++;
        else if (comment[i] === "}" && --depth === 0) {
          types.push(comment.slice(start + 1, i));
          break;
        }
      }
    }
  }
  return types;
}

/**
 * How many `any` a JSDoc type expression holds: a `*` that stands as a type (`*`, `Array<*>`,
 * `* | null`) and a bare `?` are one each, as checkJs reads them. The ` * ` that starts each
 * continuation line of the comment is not a type.
 */
export function anyCount(type: string): number {
  const text = type.replace(/\n\s*\*/g, "\n");
  const bare = text.trim() === "?" ? 1 : 0;
  const stars = (text.match(/(^|[<,|(\s])\*(?=$|[>,|)[\s])/g) ?? []).length;
  return bare + stars + (text.match(/\bany\b/g) ?? []).length;
}

/** Each `any` in a source's JSDoc types, as `path: type`, the path relative to `root`. */
export function anys(root: string, path: string): string[] {
  const rel = relative(root, path);
  return jsdocTypes(readFileSync(path, "utf8")).flatMap((t) =>
    Array.from({ length: anyCount(t) }, () => `${rel}: ${t.replace(/\s+/g, " ").trim()}`),
  );
}
