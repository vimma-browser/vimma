import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Issue #125: the gate must still catch a real regression. The dispatcher is wrapped so a flag can
// make every dispatch() do extra work, as a slower dispatcher would; the bench cases build their
// dispatcher through this module, so the injected cost lands in the measured hot path.
const slow = vi.hoisted(() => ({ iterations: 0, sink: 0 }));
vi.mock("../../../packages/vimma-core/src/dispatcher.mjs", async (importOriginal) => {
  /** @type {typeof import("../../../packages/vimma-core/src/dispatcher.mjs")} */
  const real = await importOriginal();
  return {
    ...real,
    /** @type {typeof real.createDispatcher} */
    createDispatcher: (...args) => {
      const d = real.createDispatcher(...args);
      const dispatch = d.dispatch;
      d.dispatch = (mode, chord) => {
        let x = slow.sink;
        for (let i = 0; i < slow.iterations; i++) x = (x * 31 + i) | 0;
        slow.sink = x;
        return dispatch(mode, chord);
      };
      return d;
    },
  };
});

const { CASES, reference } = await import("../../../packages/vimma-core/bench/cases.mjs");
const { childArgs, extractCommit, measure, PROCESSES, ROUNDS, run, SAMPLES, sides } =
  await import("../bench.mjs");
const { combinePaired, compare, formatTable } = await import("../compare.mjs");
const { tempDir } = await import("../../test/temp-dir.mjs");

const MACHINE = "test machine | x64 | node 22.0.0";
const BASELINE = new URL("../../../packages/vimma-core/bench/baseline.json", import.meta.url);
const KEY_CASE = "single key: j → scroll.down";

describe("bench processes", () => {
  it("run each child with its own fixed hash seed, the same set on every run (issue #125)", () => {
    const args = Array.from({ length: PROCESSES }, (_, p) => childArgs(p, "/base"));
    const seeds = args.map((a) => a.find((x) => x.startsWith("--hash-seed=")));
    expect(seeds.every(Boolean)).toBe(true);
    expect(new Set(seeds).size).toBe(PROCESSES);
    expect(Array.from({ length: PROCESSES }, (_, p) => childArgs(p, "/base"))).toEqual(args);
    for (const a of args) expect(a.slice(a.indexOf("--child"))).toContain("/base");
  });

  it("load the baseline first in half of the processes, so load order cannot lean the median (issue #342)", () => {
    const args = Array.from({ length: PROCESSES }, (_, p) => childArgs(p, "/base"));
    const baseFirst = args.filter((a) => a.includes("--base-first")).length;
    const headFirst = args.filter((a) => a.includes("--head-first")).length;
    expect(baseFirst + headFirst).toBe(PROCESSES);
    expect(Math.abs(baseFirst - headFirst)).toBeLessThanOrEqual(1);
  });
});

describe("measure", () => {
  it("interleaves the cases sample by sample, so the variants it compares share the runner's state (issue #342)", () => {
    // Measured case after case, each case's 51 samples took a block of time of their own, and a
    // change in the runner's load between two blocks (another test file starting on the sibling
    // hyperthread) moved one variant against the other: unchanged code read +26.8 % on a sequence
    // and +31.2 % on the apply case against its own baseline in the coverage pool.
    /** @type {string[]} */
    const order = [];
    /** @param {string} name */
    const probe = (name) => ({
      name,
      run: () => {
        if (order.at(-1) !== name) order.push(name);
        return name;
      },
    });
    // Three cases: with two, the rotating order puts the same case at the end of one sweep and
    // the start of the next, and the probe counts that as one stretch.
    measure([probe("a"), probe("b"), probe("c")], reference);
    expect(order.length).toBeGreaterThanOrEqual(ROUNDS * SAMPLES * 2);
  });
});

/**
 * A scripted machine on a virtual clock that only the cases and the reference advance. It turns
 * busy and quiet in phases of 1 to 11 ms, each longer than a sweep over the cases (a seeded random walk, so every run is the same),
 * and while busy a case costs `BUSY` times as much and the reference not: another process on the
 * sibling hyperthread slows an allocating case more than the reference (issue #342). Busy about
 * half of the time, as a test pool next door can be, each side's median of 51 samples falls on
 * whichever mode has one more sample (issue #667).
 * @param {number} seed
 */
function noisyMachine(seed) {
  const BUSY = 1.5;
  let t = 0;
  let busy = false;
  let until = 0;
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
  /** @param {number} ns */
  const work = (ns) => {
    while (t >= until) {
      busy = !busy;
      until += 1_000_000 + random() * 10_000_000;
    }
    return busy ? ns * BUSY : ns;
  };
  /** @param {number} ns the case's cost on a quiet machine */
  const cases = (ns) => ({
    CASES: [
      {
        name: "case",
        run: () => {
          t += work(ns);
          return 1;
        },
        expected: 1,
      },
    ],
    reference: () => {
      t += 500;
      return 1;
    },
  });
  return { clock: () => BigInt(Math.round(t)), cases };
}

describe("the gate on a noisy machine", () => {
  const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
  const gate = { budgetUs: Infinity };

  it("passes the unchanged code whichever way the busy phases fall (issue #667)", () => {
    for (const seed of SEEDS) {
      const m = noisyMachine(seed);
      const { head, base } = run(m.cases(1000), m.cases(1000), seed % 2 === 0, m);
      const r = compare(head, base, gate);
      expect(r.ok, `seed ${seed}: ${r.failures.join("\n")}`).toBe(true);
    }
  });

  it("fails a case made 20 % slower whichever way the busy phases fall (issue #667)", () => {
    for (const seed of SEEDS) {
      const m = noisyMachine(seed);
      const { head, base } = run(m.cases(1200), m.cases(1000), seed % 2 === 0, m);
      const r = compare(head, base, gate);
      expect(r.ok, `seed ${seed}: ${formatTable(r)}`).toBe(false);
    }
  });
});

describe("extractCommit", () => {
  it("writes a commit's core and its bench cases to a directory, to measure them alongside the working tree", async () => {
    const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const dir = tempDir("vimma-bench-base-");
    const cases = extractCommit(head, dir);
    /** @type {typeof import("../../../packages/vimma-core/bench/cases.mjs")} */
    const base = await import(pathToFileURL(cases).href);
    expect(base.CASES.map((c) => c.name)).toEqual(CASES.map((c) => c.name));
    for (const c of base.CASES) expect(c.run()).toEqual(c.expected);
  });

  it("refuses something that is not a commit", () => {
    expect(() => extractCommit("not-a-commit-0000", tempDir("vimma-bench-base-"))).toThrow(
      /not-a-commit-0000/,
    );
  });
});

describe("the baseline", () => {
  it("names a commit of this branch's history, the code every run is measured against", () => {
    const { commit } = JSON.parse(readFileSync(BASELINE, "utf8"));
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"]);
    expect(ancestor.status, `${commit} is not an ancestor of HEAD`).toBe(0);
  });
});

describe("the gate on a real measurement", () => {
  // Issues #202 and #342: the unchanged code, the slowed code and the baseline are variants
  // measured in one measure() call, sample by sample in rotating order, so they share the JIT's
  // state, the runner's speed and whatever else the parallel test pool is doing at the time.
  // Measured one after the other (#202), the code measured first ran in a different JIT state
  // from the code measured after the slowdown. Measured in one call but case after case (#342),
  // the pool's load still moved between the variants' blocks of samples: in 60 such checks on
  // hosted runners under the coverage pool, unchanged code read from -21 % to +40 % on one case;
  // sample by sample, from -14 % to +12 %. Gated on each side's own median, a load that came and
  // went in phases still read unchanged code at +25.0 % on a hosted macOS runner (#667): the gate
  // now pairs the variants sweep by sweep (bench.mjs, sides), as the bench does.
  /**
   * The cases with the dispatcher slowed by `n` iterations, named `tag` + the case's name. Every
   * variant runs through the same closure, so they differ only in the work the flag injects.
   * @param {string} tag
   * @param {number} n
   * @param {typeof CASES} cases
   */
  const variant = (tag, n, cases) =>
    cases.map((c) => ({
      name: `${tag}${c.name}`,
      run: () => {
        slow.iterations = n;
        return c.run();
      },
    }));
  /**
   * `tag`'s cases against the baseline variant's, as the gate reads a bench run: per measurement,
   * the change of each sweep (bench.mjs, sides), and over the measurements, the median change, as
   * the bench combines its processes (combinePaired).
   * @param {ReturnType<typeof measure>[]} runs
   * @param {string} tag
   * @param {string} [baseTag]
   */
  const against = (runs, tag, baseTag = "base|") => {
    const pairs = runs.map((m) => sides(m, tag, baseTag, MACHINE));
    return combinePaired(
      pairs.map((p) => p.head),
      pairs.map((p) => p.base),
      runs.map(() => true),
    );
  };
  /** @param {ReturnType<typeof against>} r */
  const keyChange = (r) =>
    (r.head.cases[KEY_CASE]?.ratio ?? NaN) / (r.base.cases[KEY_CASE]?.ratio ?? NaN) - 1;
  const keyCase = CASES.filter((c) => c.name === KEY_CASE);

  it("fails a dispatcher made 20 % slower and passes the unchanged code", () => {
    // Size the injected work from its cost per iteration, measured with enough of it (512
    // iterations, about doubling a single key) that the runner's noise is small next to it. Aim
    // at +25 % so that a reading of at least +20 % below needs no second try most of the time.
    const SIZING = 512;
    const sizing = measure(
      [...variant("a|", 0, keyCase), ...variant("b|", SIZING, keyCase)],
      reference,
    );
    const perIteration = keyChange(against([sizing], "b|", "a|")) / SIZING;
    let n = Math.max(1, Math.round(0.25 / perIteration));

    // Under the coverage pool, an A/B can still read every case of one variant a few per cent
    // off another, even the apply case the slowdown does not touch, and the injected loop's cost
    // moves as the JIT recompiles it (14 iterations read +19 % in one A/B, +3 % in
    // the next). The bench takes the median of 15 processes for this; the test takes the median
    // of three A/Bs, and checks the slowdown on that same median: while a single key reads under
    // +20 %, it grows the work towards +25 % and measures again. The work only grows.
    const ab = () =>
      measure(
        [
          ...variant("base|", 0, CASES),
          ...variant("same|", 0, CASES),
          ...variant("slow|", n, CASES),
        ],
        reference,
      );
    let runs = [ab(), ab(), ab()];
    for (let attempt = 1; attempt < 3; attempt++) {
      const change = keyChange(against(runs, "slow|"));
      if (change >= 0.2) break;
      n = Math.max(Math.ceil(n * 1.25), change > 0 ? Math.ceil((n * 0.25) / change) : 2 * n);
      runs = [ab(), ab(), ab()];
    }
    slow.iterations = 0;
    const slower = against(runs, "slow|");

    // The dispatcher is at least 20 % slower: every case that dispatches, not the apply case, so
    // the suite (geometric mean of five cases) moves about 1.2 ** (4 / 5), +15.7 %, over the 10 %
    // gate. The multi-key cases move a little less than a single key does.
    // The gate under test is the ratio gate. The 50 µs budget is for the code as it ships, and
    // compare.test.mjs covers it; under coverage, the instrumented apply case can read over it
    // in all three A/Bs, which says nothing about the gate (issue #202).
    const gate = { budgetUs: Infinity };
    expect(keyChange(slower)).toBeGreaterThanOrEqual(0.15);
    const regressed = compare(slower.head, slower.base, gate);
    expect(regressed.ok, regressed.failures.join("\n")).toBe(false);
    expect(regressed.failures.join("\n")).toMatch(/^suite: \+/);
    const unchanged = against(runs, "same|");
    const same = compare(unchanged.head, unchanged.base, gate);
    expect(same.ok, same.failures.join("\n")).toBe(true);
  }, 180_000);
});
