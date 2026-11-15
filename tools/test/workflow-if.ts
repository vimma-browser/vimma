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
//   import { evaluate, runJobs } from "./workflow-if.ts";

export type Value = string | number | boolean | null;

/**
 * What an expression reads: `github`, `vars`, `needs`, `inputs`, and `status`, the values of the
 * status functions. A path an expression names ends at a Value the test put there.
 */
export interface Context {
  status?: { success: boolean; failure: boolean; cancelled: boolean };
  [key: string]: unknown;
}

function tokenize(text: string) {
  const tokens: string[] = [];
  const re =
    /\s*(?:('(?:[^']|'')*')|(==|!=|&&|\|\||[!()])|([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)|(-?\d+(?:\.\d+)?))/y;
  let at = 0;
  while (at < text.length) {
    if (/^\s*$/.test(text.slice(at))) break;
    re.lastIndex = at;
    const m = re.exec(text);
    if (!m) throw new Error(`cannot read the expression at: ${text.slice(at)}`);
    tokens.push((m[1] ?? m[2] ?? m[3] ?? m[4]) as string);
    at = re.lastIndex;
  }
  return tokens;
}

const truthy = (v: Value) => !(v === false || v === null || v === "" || v === 0 || Number.isNaN(v));

function toNumber(v: Value) {
  if (v === null) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") return v.trim() === "" ? 0 : Number(v);
  return v;
}

function equal(a: Value, b: Value) {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  if (typeof a === typeof b) return a === b;
  return toNumber(a) === toNumber(b);
}

/**
 * @param expression  with or without `${{ }}`
 * @param context  `github`, `vars`, `needs`, `inputs`, and `status`, the values of the status
 *   functions: `{ success, failure, cancelled }`
 */
export function evaluate(expression: string, context: Context): Value {
  const text = expression.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1");
  const tokens = tokenize(text);
  let i = 0;
  const peek = () => tokens[i];
  const take = (want: string) => {
    if (tokens[i] !== want) throw new Error(`expected ${want} at token ${i}: ${text}`);
    i += 1;
  };
  const or = (): Value => {
    let v = and();
    while (peek() === "||") {
      i += 1;
      const r = and();
      v = truthy(v) ? v : r;
    }
    return v;
  };
  const and = (): Value => {
    let v = unary();
    while (peek() === "&&") {
      i += 1;
      const r = unary();
      v = truthy(v) ? r : v;
    }
    return v;
  };
  const unary = (): Value => {
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
  const primary = (): Value => {
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
    let v: unknown = context;
    for (const key of t.split(".")) v = v == null ? null : (v as Record<string, unknown>)[key];
    return v === undefined ? null : (v as Value);
  };
  const value = or();
  if (i !== tokens.length) throw new Error(`unexpected ${tokens[i]} in: ${text}`);
  return value;
}

export type Result = "success" | "failure" | "cancelled" | "skipped";

/**
 * Runs a workflow's jobs in file order, as GitHub would for one event. A job that starts
 * succeeds unless `results` names another end for it; once one is cancelled, the run is. A job
 * whose `if:` names no status function gets GitHub's implicit `success() &&`.
 * @param jobs  from workflow-runners.mjs's `jobs`
 * @param run  outputs: what each job sets (also when it fails); results: how a job that starts
 *   ends, when not in success
 */
export function runJobs(
  jobs: Map<string, Record<string, unknown>>,
  run: {
    github: Record<string, string>;
    vars: Record<string, string>;
    outputs?: Record<string, Record<string, string>>;
    results?: Record<string, "failure" | "cancelled">;
  },
): Map<string, { result: Result; with: Record<string, Value> }> {
  const done = new Map<string, { result: Result; with: Record<string, Value> }>();
  let cancelled = false;
  for (const [id, job] of jobs) {
    const needs = [job.needs ?? []].flat().map(String);
    const needsContext: Record<string, { result: Result; outputs: Record<string, string> }> = {};
    for (const n of needs) {
      const d = done.get(n);
      if (!d) throw new Error(`${id} needs ${n}, which is not an earlier job`);
      needsContext[n] = {
        result: d.result,
        outputs: d.result === "skipped" ? {} : (run.outputs?.[n] ?? {}),
      };
    }
    const results = needs.map((n) => needsContext[n]!.result);
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
    const withValues: Record<string, Value> = {};
    if (starts) {
      for (const [k, v] of Object.entries(job.with ?? {})) {
        withValues[k] = typeof v === "string" && v.includes("${{") ? evaluate(v, context) : v;
      }
    }
    const result: Result = starts ? (run.results?.[id] ?? "success") : "skipped";
    if (result === "cancelled") cancelled = true;
    done.set(id, { result, with: withValues });
  }
  return done;
}
