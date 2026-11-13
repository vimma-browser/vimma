import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_BODY, survivorsReport } from "../report.mjs";
import { tempDir } from "../../test/temp-dir.mjs";

const script = fileURLToPath(new URL("../report.mjs", import.meta.url));

/**
 * @param {string} status
 * @param {number} line
 * @param {string} [replacement]
 */
const mutant = (status, line, replacement = "false") => ({
  id: `${line}`,
  mutatorName: "BooleanLiteral",
  replacement,
  status,
  location: { start: { line, column: 3 }, end: { line, column: 7 } },
});

/** A mutation-testing-report-schema document as Stryker's json reporter writes it. */
const report = {
  schemaVersion: "2",
  thresholds: { high: 80, low: 60 },
  files: {
    "packages/vimma-core/src/b.mjs": {
      language: "javascript",
      source: "",
      mutants: [mutant("Killed", 1), mutant("Survived", 9), mutant("Survived", 2, "a\nb")],
    },
    "packages/vimma-core/src/a.mjs": {
      language: "javascript",
      source: "",
      mutants: [mutant("NoCoverage", 4), mutant("Timeout", 5), mutant("Killed", 6)],
    },
    "packages/vimma-core/src/clean.mjs": {
      language: "javascript",
      source: "",
      mutants: [mutant("Killed", 1)],
    },
  },
};

const meta = { runUrl: "https://example.test/run/1", commit: "abc1234" };

describe("survivorsReport", () => {
  const { body, score, survivors } = survivorsReport(report, meta);

  it("scores killed and timed-out mutants over all valid ones, as Stryker does", () => {
    // killed 3 + timeout 1 over 7 valid mutants
    expect(score).toBeCloseTo((4 / 7) * 100);
    expect(body).toContain("57.14 %");
  });

  it("counts survived and uncovered mutants as survivors", () => {
    expect(survivors).toBe(3);
  });

  it("lists survivors per file, files sorted, lines ascending, clean files left out", () => {
    const a = body.indexOf("### `packages/vimma-core/src/a.mjs` (1)");
    const b = body.indexOf("### `packages/vimma-core/src/b.mjs` (2)");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(body).not.toContain("clean.mjs");
    expect(body.indexOf("L2:3")).toBeLessThan(body.indexOf("L9:3"));
  });

  it("shows the mutator, the status and a one-line replacement for each survivor", () => {
    expect(body).toContain("- [ ] L4:3 BooleanLiteral → `false` (NoCoverage)");
    expect(body).toContain("- [ ] L2:3 BooleanLiteral → `a⏎b` (Survived)");
  });

  it("links the run and names the commit", () => {
    expect(body).toContain("https://example.test/run/1");
    expect(body).toContain("abc1234");
  });

  it(`stays under GitHub's issue body limit (${MAX_BODY} characters) by truncating the list`, () => {
    const many = {
      files: {
        "x.mjs": {
          language: "javascript",
          source: "",
          mutants: Array.from({ length: 5000 }, (_, i) =>
            mutant("Survived", i + 1, "x".repeat(40)),
          ),
        },
      },
    };
    const big = survivorsReport(many, meta).body;
    expect(big.length).toBeLessThanOrEqual(MAX_BODY);
    expect(big).toMatch(/more survivors not listed; see the HTML report/);
  });

  it("says so plainly when nothing survives", () => {
    const clean = { files: { "a.mjs": report.files["packages/vimma-core/src/clean.mjs"] } };
    expect(survivorsReport(clean, meta).body).toContain("No surviving mutants");
  });
});

describe("report.mjs on the command line", () => {
  it("writes the issue body to stdout and the score to GITHUB_OUTPUT", () => {
    const dir = tempDir("mutation-report-");
    const json = join(dir, "mutation.json");
    const out = join(dir, "output");
    writeFileSync(json, JSON.stringify(report));
    writeFileSync(out, "");
    const p = spawnSync(process.execPath, [script, json], {
      env: { ...process.env, GITHUB_OUTPUT: out, RUN_URL: meta.runUrl, COMMIT: meta.commit },
    });
    expect(p.status).toBe(0);
    expect(p.stdout.toString()).toContain("### `packages/vimma-core/src/b.mjs` (2)");
    expect(readFileSync(out, "utf8")).toBe("score=57.14\nsurvivors=3\n");
  });

  it("exits 2 when the report is missing", () => {
    expect(spawnSync(process.execPath, [script, "/nonexistent.json"]).status).toBe(2);
  });
});
