import { describe, expect, it } from "vitest";
import {
  BUDGET_US,
  CASE_THRESHOLD,
  THRESHOLD,
  combine,
  combinePaired,
  compare,
  median,
  minOfMedians,
} from "../compare.mjs";

const MACHINE = "AMD EPYC 7763 64-Core Processor | x64 | node 22.23.3";

/**
 * A bench result as bench.mjs writes it.
 * @param {Record<string, { us: number, ratio: number }>} cases
 * @param {string} [machine]
 */
const result = (cases, machine = MACHINE) => ({ machine, referenceUs: 0.5, cases });

/**
 * The baseline commit's cases, measured in the same processes as the run (bench.mjs).
 * @param {Record<string, { us: number, ratio: number }>} cases
 */
const baseline = (cases) => result(cases);

describe("median and minOfMedians", () => {
  it("takes the middle sample of an odd count and the mean of the middle two of an even one", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("does not reorder the samples it is given", () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });

  it("refuses an empty sample", () => {
    expect(() => median([])).toThrow(/empty/);
  });

  it("keeps the quietest round: the smallest of the per-round medians", () => {
    expect(
      minOfMedians([
        [9, 10, 11],
        [4, 5, 60],
        [7, 7, 7],
      ]),
    ).toBe(5);
  });
});

describe("combine", () => {
  it("keeps, per case, the lowest µs and the median ratio over the processes", () => {
    const combined = combine([
      { ...result({ a: { us: 2, ratio: 1.2 }, b: { us: 5, ratio: 3 } }), referenceUs: 0.5 },
      { ...result({ a: { us: 1, ratio: 1.4 }, b: { us: 6, ratio: 2.5 } }), referenceUs: 0.52 },
      { ...result({ a: { us: 3, ratio: 1.3 }, b: { us: 7, ratio: 2.8 } }), referenceUs: 0.51 },
    ]);
    expect(combined).toEqual({
      machine: MACHINE,
      referenceUs: 0.5,
      referenceSpread: expect.closeTo(0.04, 9),
      processes: 3,
      cases: { a: { us: 1, ratio: 1.3 }, b: { us: 5, ratio: 2.8 } },
    });
  });

  it("does not let one process with a slow reference set the ratios (issue #125)", () => {
    // A slower reference in one process lowers every ratio of that process. The lowest ratio
    // would pick exactly that process, and the next run, without one, would read as a regression.
    const steady = { a: { us: 1, ratio: 2 }, b: { us: 10, ratio: 20 } };
    const slowRef = { a: { us: 1, ratio: 1.6 }, b: { us: 10, ratio: 16 } };
    const runs = [steady, steady, slowRef, steady, steady].map((cases) => result(cases));
    expect(combine(runs).cases).toEqual(steady);
  });

  it("refuses results from different machines or with different cases", () => {
    expect(() => combine([result({ a: { us: 1, ratio: 1 } }), result({}, "other")])).toThrow(
      /machine/,
    );
    expect(() => combine([result({ a: { us: 1, ratio: 1 } }), result({})])).toThrow(/cases/);
    expect(() => combine([])).toThrow(/no results/);
  });
});

describe("combinePaired", () => {
  it("cancels a load-order shift that differs between processes", () => {
    // Process p loads the working tree first when p is even (bench.mjs, childArgs); whichever side
    // a process loads first reads 7 % slower here, and the code is otherwise the same.
    const heads = [];
    const bases = [];
    for (let p = 0; p < 15; p++) {
      const noise = 1 + ((p * 7) % 5) / 500;
      heads.push(result({ a: { us: 1, ratio: 2 * noise * (p % 2 ? 1 : 1.07) } }));
      bases.push(result({ a: { us: 1, ratio: 2 * noise * (p % 2 ? 1.07 : 1) } }));
    }
    const order = heads.map((_, p) => p % 2 === 0);
    const { head, base } = combinePaired(heads, bases, order);
    expect(Math.abs(compare(head, base).suiteChange ?? 1)).toBeLessThan(0.01);
    expect(head.cases.a?.ratio).toBeCloseTo(combine(heads).cases.a?.ratio ?? 0);
  });

  it("refuses results from different processes on each side", () => {
    expect(() => combinePaired([result({})], [], [true])).toThrow(/same processes/);
  });
});

describe("compare", () => {
  it("passes when every case is within 10 % of its baseline and under 50 µs", () => {
    const r = compare(
      result({ a: { us: 1.05, ratio: 2.1 }, b: { us: 3, ratio: 6 } }),
      baseline({ a: { us: 1, ratio: 2 }, b: { us: 3, ratio: 6 } }),
    );
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("fails when the suite (geometric mean of the cases' changes) regresses by more than 10 %", () => {
    const r = compare(
      result({ a: { us: 1, ratio: 2.22 }, b: { us: 1, ratio: 4.4 } }),
      baseline({ a: { us: 1, ratio: 2 }, b: { us: 1, ratio: 4 } }),
    );
    expect(r.ok).toBe(false);
    expect(r.suiteChange).toBeCloseTo(Math.sqrt(1.11 * 1.1) - 1);
    expect(r.failures).toEqual([expect.stringMatching(/^suite: \+10\.5 % .*10\.0 % limit/)]);
  });

  it("passes a suite regression of exactly 10 %, the limit itself", () => {
    expect(THRESHOLD).toBe(0.1);
    const r = compare(result({ a: { us: 1, ratio: 2.2 } }), baseline({ a: { us: 1, ratio: 2 } }));
    expect(r.ok).toBe(true);
  });

  it("passes one case 15 % slower when the suite stays within 10 %, and notes it", () => {
    const r = compare(
      result({ a: { us: 1, ratio: 2.3 }, b: { us: 1, ratio: 4 }, c: { us: 1, ratio: 1 } }),
      baseline({ a: { us: 1, ratio: 2 }, b: { us: 1, ratio: 4 }, c: { us: 1, ratio: 1 } }),
    );
    expect(r.ok).toBe(true);
    expect(r.notes).toEqual([expect.stringMatching(/^a: \+15\.0 %/)]);
  });

  it("fails any single case more than 25 % slower, whatever the suite does", () => {
    expect(CASE_THRESHOLD).toBe(0.25);
    const r = compare(
      result({ a: { us: 1, ratio: 2.6 }, b: { us: 1, ratio: 3 }, c: { us: 1, ratio: 3 } }),
      baseline({ a: { us: 1, ratio: 2 }, b: { us: 1, ratio: 4 }, c: { us: 1, ratio: 4 } }),
    );
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual([expect.stringMatching(/^a: \+30\.0 % .*25\.0 % limit/)]);
  });

  it("compares the ratio to the reference workload, not raw µs, so a slower runner passes", () => {
    const r = compare(result({ a: { us: 1.5, ratio: 2 } }), baseline({ a: { us: 1, ratio: 2 } }));
    expect(r.ok).toBe(true);
  });

  it("fails any case over the 50 µs budget, even one the baseline commit does not have", () => {
    expect(BUDGET_US).toBe(50);
    const r = compare(result({ slow: { us: 50.1, ratio: 100 } }), baseline({}));
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual([expect.stringMatching(/^slow: 50\.10 µs .*50 µs budget/)]);
  });

  it("fails a case of exactly 50.0 µs: the plan's budget is under 50 µs", () => {
    const r = compare(
      result({ edge: { us: 50, ratio: 2 } }),
      baseline({ edge: { us: 50, ratio: 2 } }),
    );
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual([expect.stringMatching(/^edge: 50\.00 µs .*50 µs budget/)]);
    expect(compare(result({ edge: { us: 49.99, ratio: 2 } }), baseline({})).ok).toBe(true);
  });

  it("passes one case exactly 25 % slower, the per-case limit itself", () => {
    const r = compare(
      result({ a: { us: 1, ratio: 2.5 }, b: { us: 1, ratio: 3 }, c: { us: 1, ratio: 3 } }),
      baseline({ a: { us: 1, ratio: 2 }, b: { us: 1, ratio: 3.3 }, c: { us: 1, ratio: 3.3 } }),
    );
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("compare with an accepted cost", () => {
  it("gates a case against its baseline plus the cost the baseline accepts for it, and says so", () => {
    const accepted = { a: { change: 0.12, why: "per-mode leader lookup" } };
    const r = compare(
      result({ a: { us: 1, ratio: 2.24 }, b: { us: 1, ratio: 4 } }),
      baseline({ a: { us: 1, ratio: 2 }, b: { us: 1, ratio: 4 } }),
      { accepted },
    );
    expect(r.ok).toBe(true);
    expect(r.suiteChange).toBeCloseTo(0);
    expect(r.rows[0]?.change).toBeCloseTo(0);
    expect(r.notes).toEqual([
      expect.stringMatching(/^a: \+12\.0 % accepted by the baseline \(per-mode leader lookup\)/),
    ]);
  });

  it("still fails a case that costs more than the baseline accepts plus the limit", () => {
    const accepted = { a: { change: 0.12, why: "w" } };
    const r = compare(result({ a: { us: 1, ratio: 2.9 } }), baseline({ a: { us: 1, ratio: 2 } }), {
      accepted,
    });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatch(/^suite: \+29\.5 % /);
  });
});

describe("compare: cases that come and go", () => {
  it("notes, without failing, a case the baseline does not have yet", () => {
    const r = compare(result({ fresh: { us: 1, ratio: 2 } }), baseline({}));
    expect(r.ok).toBe(true);
    expect(r.notes).toEqual([expect.stringMatching(/^fresh: no baseline/)]);
  });

  it("fails when a baseline case is missing from the run, so a case cannot vanish silently", () => {
    const r = compare(result({}), baseline({ gone: { us: 1, ratio: 2 } }));
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual([
      expect.stringMatching(/^gone: in the baseline commit but not measured; move the baseline/),
    ]);
  });

  it("lists one row per measured case with its change against the baseline", () => {
    const r = compare(result({ a: { us: 1, ratio: 1.8 } }), baseline({ a: { us: 1, ratio: 2 } }));
    expect(r.rows).toEqual([{ name: "a", us: 1, ratio: 1.8, base: 2, change: expect.any(Number) }]);
    expect(r.rows[0]?.change).toBeCloseTo(-0.1);
  });
});
