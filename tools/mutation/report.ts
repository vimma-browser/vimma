#!/usr/bin/env node
/**
 * Turns Stryker's JSON report (mutation-testing-report-schema) into the body of the one tracking
 * issue that .github/workflows/mutation.yml keeps up to date (spec ci-quality-gates; plan §5:
 * "survivors become issues"). Usage:
 *   RUN_URL=… COMMIT=… node tools/mutation/report.mjs reports/mutation/mutation.json > body.md
 * Writes `score` and `survivors` to $GITHUB_OUTPUT when set. Exit 0, or 2 on unreadable input.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** GitHub refuses issue bodies over 65536 characters; keep a margin for the footer. */
export const MAX_BODY = 65_000;

const SURVIVOR = new Set(["Survived", "NoCoverage"]);
const DETECTED = new Set(["Killed", "Timeout"]);

/**
 * @typedef {{ mutatorName: string, replacement?: string, status: string,
 *   location: { start: { line: number, column: number } } }} Mutant
 * @typedef {{ files: Record<string, { mutants: Mutant[] }> }} Report
 */

/** @param {string} s */
const oneLine = (s) => s.replace(/\r?\n/g, "⏎").replace(/`/g, "'").slice(0, 80);

/**
 * @param {Report} report
 * @param {{ runUrl: string, commit: string }} meta
 */
export function survivorsReport(report, { runUrl, commit }) {
  let detected = 0;
  let valid = 0;
  /** @type {[string, Mutant[]][]} */
  const perFile = [];
  for (const [file, { mutants }] of Object.entries(report.files).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const left = [];
    for (const m of mutants) {
      if (DETECTED.has(m.status)) detected++;
      if (DETECTED.has(m.status) || SURVIVOR.has(m.status)) valid++;
      if (SURVIVOR.has(m.status)) left.push(m);
    }
    left.sort((a, b) => a.location.start.line - b.location.start.line);
    if (left.length) perFile.push([file, left]);
  }
  const score = valid ? (detected / valid) * 100 : 100;
  const survivors = perFile.reduce((n, [, ms]) => n + ms.length, 0);

  const head =
    [
      `Weekly mutation run of \`packages/vimma-core/src\` at ${commit}: score **${score.toFixed(2)} %**, ` +
        `${survivors} surviving mutant${survivors === 1 ? "" : "s"}. [Run and HTML report](${runUrl}).`,
      "",
      "A survivor is a change to the code that no test noticed. Add or sharpen a test that kills it " +
        "(red first), or mark it equivalent with a `// Stryker disable next-line <mutator>: reason` " +
        "comment. This issue is rewritten by every run; see docs/runbook.md, “Mutation testing”.",
      "",
    ].join("\n") + "\n";
  if (!survivors) return { body: `${head}No surviving mutants.\n`, score, survivors };

  const lines = [];
  let length = head.length;
  let listed = 0;
  const reserve = 200;
  outer: for (const [file, ms] of perFile) {
    const title = `### \`${file}\` (${ms.length})\n`;
    if (length + title.length + reserve > MAX_BODY) break;
    lines.push(title);
    length += title.length;
    for (const m of ms) {
      const { line, column } = m.location.start;
      const item =
        `- [ ] L${line}:${column} ${m.mutatorName} → \`${oneLine(m.replacement ?? "")}\` ` +
        `(${m.status})\n`;
      if (length + item.length + reserve > MAX_BODY) break outer;
      lines.push(item);
      length += item.length;
      listed++;
    }
    lines.push("\n");
    length++;
  }
  if (listed < survivors) {
    lines.push(`\n…and ${survivors - listed} more survivors not listed; see the HTML report.\n`);
  }
  return { body: head + lines.join(""), score, survivors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  /** @type {Report} */
  let report;
  try {
    report = JSON.parse(readFileSync(process.argv[2] ?? "reports/mutation/mutation.json", "utf8"));
  } catch (e) {
    console.error(`mutation report: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  const { body, score, survivors } = survivorsReport(report, {
    runUrl: process.env.RUN_URL ?? "(local run)",
    commit: process.env.COMMIT ?? "HEAD",
  });
  process.stdout.write(body);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `score=${score.toFixed(2)}\nsurvivors=${survivors}\n`,
    );
  }
}
