#!/usr/bin/env node
/**
 * Licence check of package-lock.json (spec m0-pipeline). Every installed package must carry an
 * SPDX licence expression satisfied by ALLOWED, or have an exception for its exact name@version
 * and licence in exceptions.json (with a reason). Exceptions that no longer match anything are
 * reported too, so the list cannot go stale. Usage:
 *   node tools/license-check/license-check.mjs [package-lock.json] [--exceptions file.json]
 * Exit 0 clean, 1 on violations or unused exceptions, 2 on bad input.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ALLOWED = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "MPL-2.0",
  "PSF-2.0",
  "Python-2.0",
]);

/**
 * @typedef {{ license: string, reason: string }} Exception
 * @typedef {{ name: string, version: string | null, license: string | null }} Violation
 */

/**
 * True when the SPDX expression is satisfied by `allow` (OR: any branch, AND: every term).
 * Anything unparseable (missing, `SEE LICENSE IN`, `WITH`, unbalanced parens) is false.
 * @param {unknown} expression
 * @param {Set<string>} [allow]
 */
export function spdxAllowed(expression, allow = ALLOWED) {
  if (typeof expression !== "string") return false;
  const tokens = expression.match(/[()]|[^\s()]+/g) ?? [];
  let i = 0;
  /** @returns {boolean} */
  const parseOr = () => {
    let ok = parseAnd();
    while (tokens[i] === "OR") {
      i++;
      ok = parseAnd() || ok;
    }
    return ok;
  };
  /** @returns {boolean} */
  const parseAnd = () => {
    let ok = parseAtom();
    while (tokens[i] === "AND") {
      i++;
      ok = parseAtom() && ok;
    }
    return ok;
  };
  /** @returns {boolean} */
  const parseAtom = () => {
    const token = tokens[i++];
    if (token === "(") {
      const ok = parseOr();
      if (tokens[i++] !== ")") throw new SyntaxError("unbalanced");
      return ok;
    }
    if (token === undefined || ["(", ")", "AND", "OR", "WITH"].includes(token)) {
      throw new SyntaxError(`unexpected ${token}`);
    }
    return allow.has(token);
  };
  try {
    const ok = parseOr();
    return i === tokens.length && ok;
  } catch {
    return false;
  }
}

/** @param {string} lockPath a `packages` key such as `node_modules/a/node_modules/@s/b` */
export function packageName(lockPath) {
  const at = lockPath.lastIndexOf("node_modules/");
  return lockPath.slice(at + "node_modules/".length);
}

/**
 * @param {{ packages?: Record<string, { version?: string, license?: unknown, link?: boolean }> }} lock
 * @param {{ allow?: Set<string>, exceptions?: Record<string, Exception> }} [options]
 * @returns {{ violations: Violation[], unusedExceptions: string[] }}
 */
export function checkLock(lock, { allow = ALLOWED, exceptions = {} } = {}) {
  /** @type {Violation[]} */
  const violations = [];
  const used = new Set();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path.startsWith("node_modules/") || entry.link) continue;
    const name = packageName(path);
    const version = entry.version ?? null;
    const license = typeof entry.license === "string" ? entry.license : null;
    if (spdxAllowed(license, allow)) continue;
    const key = `${name}@${version}`;
    const exception = exceptions[key];
    if (exception && exception.license === license) {
      used.add(key);
      continue;
    }
    violations.push({ name, version, license });
  }
  const unusedExceptions = Object.keys(exceptions).filter((key) => !used.has(key));
  return { violations, unusedExceptions };
}

/** @param {string[]} argv */
function main(argv) {
  let lockPath = "package-lock.json";
  let exceptionsPath = fileURLToPath(new URL("exceptions.json", import.meta.url));
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--exceptions") exceptionsPath = argv[++i] ?? "";
    else lockPath = argv[i] ?? lockPath;
  }
  let lock;
  /** @type {Record<string, Exception>} */
  let exceptions = {};
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
    if (existsSync(exceptionsPath)) {
      exceptions = JSON.parse(readFileSync(exceptionsPath, "utf8")).exceptions ?? {};
    }
  } catch (err) {
    console.error(`license-check: ${err instanceof Error ? err.message : err}`);
    return 2;
  }
  const { violations, unusedExceptions } = checkLock(lock, { exceptions });
  for (const v of violations) {
    console.error(`license-check: ${v.name}@${v.version} has licence ${v.license ?? "(none)"}`);
  }
  for (const key of unusedExceptions) {
    console.error(`license-check: exception ${key} matches nothing; remove it`);
  }
  if (violations.length || unusedExceptions.length) {
    console.error(
      `Allowed: ${[...ALLOWED].join(", ")}. Add a reviewed exception to ${exceptionsPath}.`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
