import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// docs/specs/upstream-beta-canary.md, Security and privacy: the Beta canary pins a Beta only in
// its own CI checkout. main ships on the Firefox release channel (ADR-002), so the pin it commits
// is always a release: never a beta (`bN`), a nightly (`aN`) or an ESR.
const surfer = JSON.parse(readFileSync(new URL("../../surfer.json", import.meta.url), "utf8"));

describe("surfer.json pin", () => {
  it("surfer.json on main pins a Firefox release, never a beta", () => {
    expect(surfer.version.product).toBe("firefox");
    expect(surfer.version.version).toMatch(/^\d+\.\d+(\.\d+)?$/);
  });
});
