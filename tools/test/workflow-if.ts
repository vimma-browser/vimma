/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The subset of GitHub Actions expressions that job `if:` conditions and `with:` values use
// (literals, contexts, `!`, `==`, `!=`, `&&`, `||`, parentheses and the status functions), and a
// run of a workflow's job graph in which every job that starts succeeds. Tests use it to say
// which jobs a given event and set of outputs starts, rather than matching condition strings.
// Semantics follow GitHub's documentation: `&&` and `||` return an operand, strings compare
// without case, and operands of different types compare as numbers.
//
//   import { evaluate, runJobs } from "./workflow-if.mjs";

/** @typedef {string | number | boolean | null} Value */

/** @param {string} text */
function tokenize(text) {
  /** @type {string[]} */
  const tokens = [];
  const re =
    /\s*(?:('(?:[^']|'')*')|(==|!=|&&|\|\||[!()])|([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)|(-?\d+(?:\.\d+)?))/y;
  let at = 0;
  while (at < text.length) {
    if (/^\s*$/.test(text.slice(at))) break;
    re.lastIndex = at;
    const m = re.exec(text);
    if (!m) throw new Error(`cannot read the expression at: ${text.slice(at)}`);
    tokens.push(/** @type {string} */ (m[1] ?? m[2] ?? m[3] ?? m[4]));
    at = re.lastIndex;
  }
  return tokens;
}

/** @param {Value} v */
const truthy = (v) => !(v === false || v === null || v === "" || v === 0 || Number.isNaN(v));

/** @param {Value} v */
function toNumber(v) {
  if (v === null) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") return v.trim() === "" ? 0 : Number(v);
  return v;
}

/** @param {Value} a @param {Value} b */
function equal(a, b) {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  if (typeof a === typeof b) return a === b;
  return toNumber(a) === toNumber(b);
}

/**
 * @param {string} expression  with or without `${{ }}`
 * @param {Record<string, any>} context  `github`, `vars`, `needs`, `inputs`, and `status`, the
 *   values of the status functions: `{ success, failure, cancelled }`
 * @returns {Value}
 */
export function evaluate(expression, context) {
  const text = expression.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1");
  const tokens = tokenize(text);
  let i = 0;
  const peek = () => tokens[i];
  const take = (/** @type {string} */ want) => {
    if (tokens[i] !== want) throw new Error(`expected ${want} at token ${i}: ${text}`);
    i += 1;
  };
  /** @returns {Value} */
  const or = () => {
    let v = and();
    while (peek() === "||") {
      i += 1;
      const r = and();
      v = truthy(v) ? v : r;
    }
    return v;
  };
  /** @returns {Value} */
  const and = () => {
    let v = unary();
    while (peek() === "&&") {
      i += 1;
      const r = unary();
      v = truthy(v) ? r : v;
    }
    return v;
  };
  /** @returns {Value} */
  const unary = () => {
    if (peek() === "!") {
      i += 1;
      return !truthy(unary());
    }
    const left = primary();
    const op = peek();
    if (op === "==" || op === "!=") {
      i += 1;
      const right = primary();
      return op === "==" ? equal(left, right) : !equal(left, right);
    }
    return left;
  };
  /** @returns {Value} */
  const primary = () => {
    const t = tokens[i];
    if (t === undefined) throw new Error(`the expression ends early: ${text}`);
    i += 1;
    if (t === "(") {
      const v = or();
      take(")");
      return v;
    }
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (/^-?\d/.test(t)) return Number(t);
    if (t === "true" || t === "false") return t === "true";
    if (t === "null") return null;
    if (peek() === "(") {
      take("(");
      take(")");
      if (t === "always") return true;
      if (t === "success" || t === "failure" || t === "cancelled") return !!context.status?.[t];
      throw new Error(`function ${t}() is not supported here`);
    }
    /** @type {any} */
    let v = context;
    for (const key of t.split(".")) v = v == null ? null : v[key];
    return v === undefined ? null : v;
  };
  const value = or();
  if (i !== tokens.length) throw new Error(`unexpected ${tokens[i]} in: ${text}`);
  return value;
}

/** @typedef {"success" | "failure" | "cancelled" | "skipped"} Result */

/**
 * Runs a workflow's jobs in file order, as GitHub would for one event. A job that starts
 * succeeds unless `results` names another end for it; once one is cancelled, the run is. A job
 * whose `if:` names no status function gets GitHub's implicit `success() &&`.
 * @param {Map<string, Record<string, any>>} jobs  from workflow-runners.mjs's `jobs`
 * @param {{ github: Record<string, string>, vars: Record<string, string>,
 *   outputs?: Record<string, Record<string, string>>,
 *   results?: Record<string, "failure" | "cancelled"> }} run  outputs: what each job sets
 *   (also when it fails); results: how a job that starts ends, when not in success
 * @returns {Map<string, { result: Result, with: Record<string, Value> }>}
 */
export function runJobs(jobs, run) {
  /** @type {Map<string, { result: Result, with: Record<string, Value> }>} */
  const done = new Map();
  let cancelled = false;
  for (const [id, job] of jobs) {
    const needs = [job.needs ?? []].flat().map(String);
    /** @type {Record<string, any>} */
    const needsContext = {};
    for (const n of needs) {
      const d = done.get(n);
      if (!d) throw new Error(`${id} needs ${n}, which is not an earlier job`);
      needsContext[n] = {
        result: d.result,
        outputs: d.result === "skipped" ? {} : (run.outputs?.[n] ?? {}),
      };
    }
    const results = needs.map((n) => needsContext[n].result);
    const context = {
      github: run.github,
      vars: run.vars,
      needs: needsContext,
      inputs: {},
      status: {
        success: results.every((r) => r === "success"),
        failure: results.some((r) => r === "failure"),
        cancelled,
      },
    };
    const condition = String(job.if ?? "");
    const explicit = /\b(success|failure|cancelled|always)\(\)/.test(condition);
    const starts =
      (explicit || context.status.success) &&
      (condition === "" || truthy(evaluate(condition, context)));
    /** @type {Record<string, Value>} */
    const withValues = {};
    if (starts) {
      for (const [k, v] of Object.entries(job.with ?? {})) {
        withValues[k] = typeof v === "string" && v.includes("${{") ? evaluate(v, context) : v;
      }
    }
    /** @type {Result} */
    const result = starts ? (run.results?.[id] ?? "success") : "skipped";
    if (result === "cancelled") cancelled = true;
    done.set(id, { result, with: withValues });
  }
  return done;
}
