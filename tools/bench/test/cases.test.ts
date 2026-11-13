import { describe, expect, it } from "vitest";
import { CASES, reference } from "../../../packages/vimma-core/bench/cases.mjs";

describe("bench cases", () => {
  it("cover a single key, the prefix plus a key and a count plus a motion", () => {
    const names = CASES.map((c) => c.name).join("\n");
    expect(names).toMatch(/^single key: /m);
    expect(names).toMatch(/^prefix \+ key: /m);
    expect(names).toMatch(/^count \+ motion: /m);
  });

  it.each(CASES.map((c) => [c.name, c]))(
    "%s produces the action it names, every time it runs",
    (_name, c) => {
      for (let i = 0; i < 3; i++) expect(c.run()).toEqual(c.expected);
    },
  );

  it("has unique names, which key the baseline", () => {
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
  });

  it("has a reference workload that returns a value, so it cannot be optimised away", () => {
    expect(reference()).toBeGreaterThan(0);
  });
});
