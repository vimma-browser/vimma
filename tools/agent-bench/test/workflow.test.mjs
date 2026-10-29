import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STEPS } from "../../upstream/suite-results.mjs";

const e2e = readFileSync(new URL("../../../.github/workflows/e2e.yml", import.meta.url), "utf8");

/** @param {string} id @returns {string} the step with this id */
function step(id) {
  const found = e2e.split(/^(?= {6}- )/m).find((s) => new RegExp(`^ {8}id: ${id}$`, "m").test(s));
  if (!found) throw new Error(`no step with id ${id}`);
  return found;
}

describe("the agent bench in e2e.yml", () => {
  it("runs the scripted provider on the artifact build, checked, after the e2e scenarios", () => {
    const s = step("agent-bench");
    expect(s).toMatch(/run: npm run agent-bench -- --artifact --check --lists \S+\n/);
    // no model and no network: the scripted provider is the default and nothing else is named
    expect(s).not.toMatch(/--provider|--model|--endpoint|--key-env|secrets\./);
    expect(e2e.indexOf("id: e2e\n")).toBeLessThan(e2e.indexOf("id: agent-bench\n"));
  });

  it("is recorded in Beta mode's suite results", () => {
    expect(STEPS).toContain("agent-bench");
  });
});
