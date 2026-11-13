/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Property-based fuzzing of the parsers of outside input (docs/specs/m7-fuzzing.md), with
 * fast-check. Normal CI runs a small seeded set (a fixed seed, so a red run is red again on
 * re-run); the nightly fuzz workflow (.github/workflows/fuzz.yml) runs many more cases from a
 * random seed. Environment:
 *
 *   VIMMA_FUZZ_SEED      the seed (default FIXED_SEED)
 *   VIMMA_FUZZ_RUNS      cases per property before weighting (default 100)
 *   VIMMA_FUZZ_TIME_MS   stop a property after this long, passing (nightly; default: no limit)
 *   VIMMA_FUZZ_PATH      replay one failing case: the `path` a failure report printed
 *   VIMMA_FUZZ_OUT       folder to write one JSON file per failing property into
 *
 * Reproducing a failure: docs/runbook.md, "Fuzzing: reproducing a failing seed".
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { expect } from "vitest";

export const FIXED_SEED = 20261010;

/** @param {string} name @param {number} fallback */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new Error(`${name} must be an integer, got ${raw}`);
  return n;
}

export const SEED = envInt("VIMMA_FUZZ_SEED", FIXED_SEED);
export const RUNS = envInt("VIMMA_FUZZ_RUNS", 100);
const TIME_MS = envInt("VIMMA_FUZZ_TIME_MS", 0);
const PATH = process.env.VIMMA_FUZZ_PATH || undefined;
const OUT = process.env.VIMMA_FUZZ_OUT || undefined;

/** Vitest's per-test timeout for a fuzz test: the time limit plus room for the slowest case. */
export const FUZZ_TIMEOUT = (TIME_MS || 30_000) + 30_000;

/**
 * Prototypes a parser could pollute, with every own property's value at load time. A parser
 * that assigns `obj[key] = v` with a key from its input (`__proto__`, `constructor`) changes
 * one of these.
 */
const PROTOTYPES = /** @type {const} */ ([
  ["Object.prototype", Object.prototype],
  ["Array.prototype", Array.prototype],
  ["Function.prototype", Function.prototype],
  ["String.prototype", String.prototype],
]);
const SNAPSHOT = PROTOTYPES.map(([name, proto]) => ({
  name,
  proto,
  keys: Reflect.ownKeys(proto),
  values: new Map(
    Reflect.ownKeys(proto).map((k) => [k, Reflect.getOwnPropertyDescriptor(proto, k)]),
  ),
}));

/** Throws when a parser added, removed or replaced a property of a built-in prototype. */
export function expectNoPollution() {
  for (const { name, proto, keys, values } of SNAPSHOT) {
    const now = Reflect.ownKeys(proto);
    expect(now, `${name} keys`).toEqual(keys);
    for (const k of now) {
      const a = values.get(k);
      const b = Reflect.getOwnPropertyDescriptor(proto, k);
      const same = a?.value === b?.value && a?.get === b?.get && a?.set === b?.set;
      expect(same, `${name}.${String(k)} replaced`).toBe(true);
    }
  }
  expect(Object.getPrototypeOf(Object.prototype)).toBe(null);
}

/**
 * Runs `fn` and fails when it took longer than `ms`: a hang on a small input shows as a slow
 * case long before it shows as a stuck job. Generous on purpose (shared CI runners).
 * @template T
 * @param {number} ms
 * @param {() => T} fn
 * @param {string} [label]  names the input in the failure message
 * @returns {T}
 */
export function within(ms, fn, label) {
  const start = performance.now();
  const out = fn();
  const took = performance.now() - start;
  if (took > ms) {
    throw new Error(`${label ? `${label}: ` : ""}took ${Math.round(took)} ms, budget ${ms} ms`);
  }
  return out;
}

/**
 * Runs `fn`; anything it throws must be an instance of `allowed` (the parser's documented error).
 * @param {() => unknown} fn
 * @param {Function | null} allowed  null: nothing may be thrown
 */
export function throwsOnly(fn, allowed) {
  try {
    fn();
  } catch (e) {
    if (allowed && e instanceof allowed) return e;
    throw new Error(
      `threw ${String(e)} (${/** @type {any} */ (e)?.name}), not ${allowed?.name ?? "nothing"}`,
      {
        cause: e,
      },
    );
  }
  return undefined;
}

/** The running test's own title (vitest's current name ends with it, after the describes). */
function testTitle() {
  return (expect.getState().currentTestName ?? "").split(" > ").at(-1) ?? "";
}

/**
 * The shell command that replays one failing case. `-t` takes a pattern matched against test
 * titles, so the title is regex-escaped, and single-quoted so the shell passes it on as written.
 * @param {number} seed
 * @param {string | null} path  fast-check's counterexample path
 * @param {string} title  the failing test's title
 */
export function replayCommand(seed, path, title) {
  const pattern = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("'", "'\\''");
  return `VIMMA_FUZZ_SEED=${seed} VIMMA_FUZZ_PATH=${path} npx vitest run packages/vimma-core/test/fuzz -t '${pattern}'`;
}

/**
 * Check `property` with the run's seed; on failure write the seed, the replay path and the
 * counterexample to VIMMA_FUZZ_OUT, then fail with fast-check's report.
 * @param {string} name   the test's name, for the failure file
 * @param {fc.IProperty<any>} property  a synchronous property: fc.check returns its details
 * @param {{ weight?: number }} [options]  weight: a share of RUNS (slow targets run fewer cases)
 */
export function fuzz(name, property, { weight = 1 } = {}) {
  const numRuns = Math.max(1, Math.round(RUNS * weight));
  /** @type {fc.Parameters<any>} */
  const params = { seed: SEED, numRuns };
  if (PATH) Object.assign(params, { path: PATH, endOnFailure: true });
  if (TIME_MS)
    Object.assign(params, { interruptAfterTimeLimit: TIME_MS, markInterruptAsFailure: false });
  const details = fc.check(property, params);
  expectNoPollution();
  if (!details.failed) return;
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    const file = join(OUT, `${name.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80)}.json`);
    const failure = {
      test: name,
      seed: details.seed,
      path: details.counterexamplePath,
      counterexample: fc.stringify(details.counterexample),
      error: String(details.errorInstance),
      replay: replayCommand(details.seed, details.counterexamplePath, testTitle()),
    };
    writeFileSync(file, `${JSON.stringify(failure, null, 2)}\n`);
  }
  throw new Error(fc.defaultReportMessage(details));
}

/** Names that are properties of every object: a lookup `table[key]` finds them unless guarded. */
export const PROTO_NAMES = Object.freeze([
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__defineGetter__",
  "__lookupGetter__",
  "__defineSetter__",
  "__lookupSetter__",
  "length",
  "name",
  "caller",
  "arguments",
  "call",
  "apply",
  "bind",
]);

/** Strings that break parsers: prototype names, separators, controls, surrogates, big ones. */
export const nastyString = fc.oneof(
  { weight: 4, arbitrary: fc.string({ unit: "grapheme-ascii", maxLength: 40 }) },
  { weight: 3, arbitrary: fc.string({ unit: "binary", maxLength: 40 }) },
  { weight: 3, arbitrary: fc.constantFrom(...PROTO_NAMES) },
  { weight: 1, arbitrary: fc.constantFrom(...PROTO_NAMES.map((n) => n.toUpperCase())) },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      "",
      " ",
      "\0",
      "\n",
      "\r\n",
      "\t",
      " ",
      "﻿",
      "\ud800",
      "\udfff",
      "‮",
      "%00",
      "%2e",
      "..",
      "\\",
      '"',
      "'",
      "#",
      "=",
      "[",
      "]",
      "{",
      "}",
      "<",
      ">",
      "+",
      "-",
      ":",
      ".",
      "*",
    ),
  },
);
