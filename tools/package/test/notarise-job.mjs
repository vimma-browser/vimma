// What release.yml's macos-notarise job, the only one holding the Apple secrets, may be (spec
// macos-build, decision 23; docs/security.md, B14). Parsing its shell to allowlist commands cannot
// be made sound, so the job must equal a golden copy, macos-notarise.golden.txt beside this file,
// line for line after trailing whitespace is trimmed; only the commits its actions are pinned to
// may differ, and each must be a full commit SHA. Any other change, a command, a step key such as
// `shell:`, `env:` or `working-directory:`, or a job key such as `defaults:` or `container:`, is a
// change to the golden file, which review reads. The workflow's own top-level keys and `env:`,
// which every job inherits, are fixed too. Returns the problems found, empty when all is as it
// must be; release-workflow.test.mjs checks the job and mutations of it.
import { readFileSync } from "node:fs";
import { CORE_SCHEMA, load } from "js-yaml";

const GOLDEN = readFileSync(new URL("macos-notarise.golden.txt", import.meta.url), "utf8");

/** The workflow's top-level keys and env, which reach every job's steps. */
const WORKFLOW_KEYS = ["name", "on", "permissions", "concurrency", "env", "jobs"];
const WORKFLOW_ENV = { TAG: "${{ inputs.tag }}" };

/**
 * The job's text as compared: the comment lines that open the next job are dropped, trailing
 * whitespace is trimmed and each pinned commit is replaced by `<pinned>`.
 * @param {string} block
 */
export function normaliseJob(block) {
  const lines = block.split("\n");
  // only the comment and blank lines at the very end belong to the next job; a comment followed
  // by anything else stays, so nothing can hide behind one
  while (lines.length > 0 && /^(?: {2}#.*|\s*)$/.test(lines.at(-1) ?? "")) lines.pop();
  return lines
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/@[0-9a-f]{40}( # v[\d.]+)?/g, "@<pinned>")
    .replace(/\n+$/, "\n");
}

/**
 * @param {string} block the job's YAML block, as release-workflow.test.mjs's jobs() gives it
 * @param {string} workflow the whole release.yml
 * @returns {string[]}
 */
export function notariseJobProblems(block, workflow) {
  /** @type {string[]} */
  const problems = [];
  for (const m of block.matchAll(/uses: ([^@\s]+)@(\S+)/g)) {
    if (!/^[0-9a-f]{40}$/.test(m[2] ?? ""))
      problems.push(`${m[1]}@${m[2]} is not pinned to a commit`);
  }
  const got = normaliseJob(block).split("\n");
  const want = GOLDEN.split("\n");
  const at = want.findIndex((line, i) => got[i] !== line);
  if (at !== -1 || got.length !== want.length) {
    const line = at === -1 ? Math.min(got.length, want.length) : at;
    problems.push(
      `macos-notarise differs from its golden copy (macos-notarise.golden.txt) at line ${line + 1}: ` +
        `${JSON.stringify(got[line])}, want ${JSON.stringify(want[line])}`,
    );
  }
  const parsed = /** @type {Record<string, unknown>} */ (load(workflow, { schema: CORE_SCHEMA }));
  const keys = Object.keys(parsed);
  if (keys.join(",") !== WORKFLOW_KEYS.join(",")) {
    problems.push(`the workflow's top-level keys are ${keys.join(", ")}`);
  }
  if (JSON.stringify(parsed.env) !== JSON.stringify(WORKFLOW_ENV)) {
    problems.push(`the workflow env is ${JSON.stringify(parsed.env)}`);
  }
  return problems;
}
