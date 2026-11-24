import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// docs/specs/m6a-updater.md, Tests, "Security rehearsal": update-rehearsal.yml's shape. Text
// checks, like downloads-workflow.test.ts: no YAML dependency.
const text = readFileSync(
  new URL("../../../.github/workflows/update-rehearsal.yml", import.meta.url),
  "utf8",
);

describe("update rehearsal workflow", () => {
  it("runs once a day and by hand, never on a pull request or a push", () => {
    expect(text).toMatch(/^ {4}- cron: "\d+ \d+ \* \* \*"/m);
    expect(text).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(text).not.toMatch(/^ {2}(pull_request\w*|push|workflow_run|release):/m);
  });

  it("runs only in this repository and only while UPDATES_ENABLED is true", () => {
    expect(text.match(/^ {4}if: (.+)$/gm)).toEqual([
      "    if: github.repository == 'vimma-browser/vimma' && vars.UPDATES_ENABLED == 'true'",
    ]);
  });

  it("grants nothing by default and the job reads contents only", () => {
    expect(text).toMatch(/^permissions: \{\}$/m);
    expect(text).toMatch(/^ {4}permissions:\n {6}contents: read\b/m);
    expect(text.match(/^ {6}[a-z-]+: (read|write)/gm)).toEqual(["      contents: read"]);
  });

  it("uses no secret and keeps no credential in the checkout", () => {
    expect(text).not.toMatch(/secrets\./);
    expect(text).toContain("persist-credentials: false");
    expect(text).not.toMatch(/\b(npm|npx) (ci|install|exec|run)\b/);
  });

  it("pins every action by commit", () => {
    const uses = text.match(/uses: \S+/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });

  it("runs the rehearsal script and keeps its logs", () => {
    expect(text).toContain(
      'node tools/update/rehearsal.ts run --repo "$REPO" --out "$RUNNER_TEMP/rehearsal"',
    );
    expect(text).toContain("path: ${{ runner.temp }}/rehearsal/logs");
  });
});
