#!/usr/bin/env node
/**
 * Key-to-action bench for vimma-core (spec ci-quality-gates, plan §5 "Performance", issues #17
 * and #342). Measures each case in packages/vimma-core/bench/cases.mjs twice, as the working tree
 * has it and as the baseline commit (baseline.json) has it, in the same processes, and gates the
 * working tree against the baseline commit (tools/bench/compare.mjs).
 *
 * Why the baseline is a commit measured alongside, not numbers recorded once: a recorded number
 * carries the recording job's runner, image and load, and GitHub's hosted runners differ by more
 * than the 10 % gate from job to job on unchanged code (issue #342). Measured in the same
 * processes, sample by sample, both sides share all of that, and only the code differs.
 *
 * Measurement:
 *   - warm-up: each case runs for WARMUP_MS first, so the JIT has optimised it;
 *   - a sample times a batch of runs lasting at least SAMPLE_NS (timer resolution is irrelevant),
 *     then a batch of the fixed reference workload, and records ns per run and their ratio; the
 *     ratio cancels the runner's speed, including frequency changes during the run;
 *   - a round takes SAMPLES samples, each a sweep over every case in an order that rotates per
 *     sample, and keeps each case's median; the two sides of a case are measured within a few
 *     milliseconds of each other, so a change in the runner's load moves both;
 *   - per case: µs is the minimum of the round medians (noise only adds time), checked against
 *     the 50 µs budget; the ratio is the median of the round medians, gated against the baseline
 *     commit's;
 *   - PROCESSES fresh processes, each with its own fixed V8 hash seed (childArgs), combined by
 *     compare.mjs: the lowest µs and the median ratio. The seed decides the bucket layout of every
 *     string-keyed Map (the dispatcher's trie), which moves a case by a few per cent from one
 *     process to the next; fixed seeds measure the same layouts on every run (issue #125).
 *
 * Usage: node tools/bench/bench.mjs [--check] [--base <commit>] [--json out.json]
 *   --check  exit 1 on a regression over 10 % or a case over 50 µs (compare.mjs)
 *   --base   measure against this commit instead of baseline.json's (e.g. origin/main)
 */
import { spawnSync } from "node:child_process";
import { cpus, tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { combine, compare, formatTable, median, minOfMedians } from "./compare.mjs";

const WARMUP_MS = 200;
const SAMPLE_NS = 100_000;
export const SAMPLES = 51;
export const ROUNDS = 5;
// Fresh processes per run, combined by compare.mjs's combine().
export const PROCESSES = 15;
const REPO = fileURLToPath(new URL("../..", import.meta.url));
export const BASELINE = join(REPO, "packages/vimma-core/bench/baseline.json");
const CASES_PATH = "packages/vimma-core/bench/cases.mjs";
// What a baseline commit needs to run its cases: the pure core and the cases themselves.
const CORE_PATHS = ["packages/vimma-core/src", "packages/vimma-core/bench"];

/** @type {unknown} */
let sink;

/**
 * Node arguments for bench process `p` (0-based): this script as a child, with hash seed p + 1,
 * measuring the baseline cases extracted to `baseDir` alongside the working tree's. Every other
 * process loads and lists the baseline first: two copies of identical code in one process differ
 * by several per cent on the sub-microsecond cases, and which one was loaded first leaned that
 * difference one way on a given machine (unchanged code read +6 % to +8 % on the suite).
 * @param {number} p
 * @param {string} baseDir
 */
export function childArgs(p, baseDir) {
  const order = p % 2 ? "--base-first" : "--head-first";
  return [`--hash-seed=${p + 1}`, fileURLToPath(import.meta.url), "--child", baseDir, order];
}

/**
 * Writes `commit`'s core and bench cases under `dir`, so one process can import both versions.
 * A shallow clone may lack the commit; it is fetched then, as CI's checkout of a pull request
 * only has the history it asked for.
 * @param {string} commit
 * @param {string} dir
 * @returns {string} the path of the commit's cases.mjs
 */
export function extractCommit(commit, dir) {
  const git = (/** @type {string[]} */ ...args) =>
    spawnSync("git", args, { cwd: REPO, maxBuffer: 256 * 1024 * 1024 });
  if (git("cat-file", "-e", `${commit}^{commit}`).status !== 0) {
    git("fetch", "--quiet", "--no-tags", "--depth=1", "origin", commit);
  }
  const tar = git("archive", "--format=tar", `${commit}^{commit}`, ...CORE_PATHS);
  if (tar.status !== 0) {
    throw new Error(`bench: cannot read ${commit} from git: ${tar.stderr.toString().trim()}`);
  }
  const untar = spawnSync("tar", ["-x", "-C", dir], { input: tar.stdout });
  if (untar.status !== 0) throw new Error(`bench: tar failed: ${untar.stderr.toString().trim()}`);
  return join(dir, "packages/vimma-core/bench/cases.mjs");
}

/** CPU model, arch and the exact Node version, printed with each run to read its log by. */
export function machineKey() {
  const model = (cpus()[0]?.model ?? "unknown cpu").replace(/\s+/g, " ").trim();
  return `${model} | ${process.arch} | node ${process.versions.node}`;
}

/**
 * A timing loop of its own per case: one shared loop would see every case's `run` at the same
 * call site, go megamorphic, and make each case's number depend on which cases ran before it.
 * @param {() => unknown} run
 * @returns {(n: number) => number} ns for n runs
 */
function timer(run) {
  const loop = new Function(
    "run",
    "hrtime",
    "keep",
    `return function time(n) {
      let last;
      const t0 = hrtime();
      for (let i = 0; i < n; i++) last = run();
      const t1 = hrtime();
      keep(last);
      return Number(t1 - t0);
    };`,
  );
  return loop(run, process.hrtime.bigint, (/** @type {unknown} */ v) => {
    sink = v;
  });
}

/** @param {(n: number) => number} time */
function calibrate(time) {
  const until = performance.now() + WARMUP_MS;
  while (performance.now() < until) time(100);
  let batch = 1;
  while (time(batch) < SAMPLE_NS) batch *= 2;
  return batch;
}

/**
 * Each sample times a batch of the case and, right after it, a batch of the reference workload;
 * their quotient is that sample's ratio. The two batches run within a fraction of a millisecond,
 * so a change in CPU frequency or a busy neighbour hits both and cancels out of the ratio.
 * Samples sweep over all the cases in turn, so the cases compared with each other (the working
 * tree's and the baseline commit's version of one case) see the same runner state: measured case
 * after case, a change in load between their blocks of samples did not cancel, since a busy
 * sibling hyperthread slows an allocating case more than the reference (issue #342).
 * @param {{ name: string, run: () => unknown }[]} cases
 * @param {() => unknown} ref
 * @returns {{ referenceUs: number, cases: Map<string, import("./compare.mjs").CaseResult> }}
 */
export function measure(cases, ref) {
  const refTime = timer(ref);
  const refBatch = calibrate(refTime);
  const timers = cases.map((c) => timer(c.run));
  const batches = timers.map(calibrate);
  const n = cases.length;
  /** @type {number[][][]} */
  const us = cases.map(() => []);
  /** @type {number[][][]} */
  const ratios = cases.map(() => []);
  /** @type {number[][]} */
  const refUs = [];
  for (let r = 0; r < ROUNDS; r++) {
    /** @type {number[][]} */
    const t = cases.map(() => []);
    /** @type {number[][]} */
    const q = cases.map(() => []);
    /** @type {number[]} */
    const refRound = [];
    for (let s = 0; s < SAMPLES; s++) {
      for (let k = 0; k < n; k++) {
        const i = (k + s + r) % n;
        const time = /** @type {(n: number) => number} */ (timers[i]);
        const batch = /** @type {number} */ (batches[i]);
        const caseNs = time(batch) / batch;
        const refNs = refTime(refBatch) / refBatch;
        t[i]?.push(caseNs / 1000);
        q[i]?.push(caseNs / refNs);
        refRound.push(refNs / 1000);
      }
    }
    for (let i = 0; i < n; i++) {
      us[i]?.push(t[i] ?? []);
      ratios[i]?.push(q[i] ?? []);
    }
    refUs.push(refRound);
  }
  return {
    referenceUs: minOfMedians(refUs),
    cases: new Map(
      cases.map((c, i) => [
        c.name,
        {
          // the budget: the quietest round, since noise only adds time
          us: minOfMedians(us[i] ?? []),
          // the regression gate: the typical round, since noise can move a ratio either way
          ratio: median((ratios[i] ?? []).map(median)),
        },
      ]),
    ),
  };
}

const HEAD = "head|";
const BASE = "base|";

/** @typedef {typeof import("../../packages/vimma-core/bench/cases.mjs")} CasesModule */

/**
 * One child's measurement: the working tree's cases and the baseline commit's, interleaved.
 * @param {CasesModule} head
 * @param {CasesModule} base
 * @param {boolean} headFirst which side comes first in the list of cases
 * @returns {{ head: import("./compare.mjs").Result, base: import("./compare.mjs").Result }}
 */
export function run(head, base, headFirst) {
  const tagged = (/** @type {string} */ tag, /** @type {CasesModule} */ m) =>
    m.CASES.map((c) => ({ name: tag + c.name, run: c.run }));
  const sides = [tagged(HEAD, head), tagged(BASE, base)];
  if (!headFirst) sides.reverse();
  const { referenceUs, cases } = measure(sides.flat(), head.reference);
  const side = (/** @type {string} */ tag) => ({
    machine: machineKey(),
    referenceUs,
    cases: Object.fromEntries(
      [...cases].filter(([name]) => name.startsWith(tag)).map(([n, c]) => [n.slice(tag.length), c]),
    ),
  });
  return { head: side(HEAD), base: side(BASE) };
}

/**
 * Exits 2 unless every case produces what it should: a case that measures the wrong work would
 * gate nothing.
 * @param {string} which
 * @param {{ name: string, run: () => unknown, expected: unknown }[]} cases
 */
function verify(which, cases) {
  for (const c of cases) {
    if (JSON.stringify(c.run()) !== JSON.stringify(c.expected)) {
      console.error(`bench: ${which} "${c.name}" does not produce ${JSON.stringify(c.expected)}`);
      process.exit(2);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  /** @param {string} flag */
  const valueOf = (flag) => {
    const i = args.indexOf(flag);
    const v = i < 0 ? undefined : args[i + 1];
    return v && !v.startsWith("--") ? v : undefined;
  };
  /** @param {string} root @returns {Promise<CasesModule>} */
  const load = (root) => import(pathToFileURL(join(root, CASES_PATH)).href);
  if (args.includes("--child")) {
    const dir = valueOf("--child");
    if (!dir) process.exit(2);
    const headFirst = args.includes("--head-first");
    /** @type {CasesModule[]} */
    const loaded = [];
    for (const root of headFirst ? [REPO, dir] : [dir, REPO]) loaded.push(await load(root));
    const [head, base] = /** @type {CasesModule[]} */ (headFirst ? loaded : loaded.reverse());
    verify("working tree", head.CASES);
    verify("baseline", base.CASES);
    const result = run(head, base, headFirst);
    if (sink === undefined) process.exit(2); // keeps `sink` observable: no run is optimised away
    process.stdout.write(JSON.stringify(result));
    process.exit(0);
  }

  verify("working tree", (await load(REPO)).CASES);
  const stored = JSON.parse(readFileSync(BASELINE, "utf8"));
  const override = valueOf("--base");
  const commit = override ?? stored.commit;
  // Accepted costs are relative to the stored commit; against another commit they mean nothing.
  const accepted = override ? {} : (stored.accepted ?? {});
  const dir = mkdtempSync(join(tmpdir(), "vimma-bench-base-"));
  /** @type {{ head: import("./compare.mjs").Result, base: import("./compare.mjs").Result }[]} */
  const results = [];
  try {
    extractCommit(commit, dir);
    for (let p = 0; p < PROCESSES; p++) {
      const child = spawnSync(process.execPath, childArgs(p, dir), { encoding: "utf8" });
      if (child.status !== 0) throw new Error(`bench: process ${p + 1} failed\n${child.stderr}`);
      results.push(JSON.parse(child.stdout));
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 2;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (process.exitCode === 2) process.exit(2);
  const head = combine(results.map((r) => r.head));
  const base = combine(results.map((r) => r.base));
  const r = compare(head, base, { accepted });
  const json = valueOf("--json");
  if (json) writeFileSync(json, `${JSON.stringify({ commit, head, base }, null, 2)}\n`);
  console.log(
    `machine: ${head.machine} (reference ${head.referenceUs.toFixed(3)} µs, ` +
      `+${(head.referenceSpread * 100).toFixed(1)} % from fastest to slowest process)`,
  );
  console.log(`baseline: ${commit}, measured in the same ${head.processes} processes`);
  console.log(formatTable(r));
  for (const note of r.notes) console.log(`note: ${note}`);
  if (args.includes("--check")) {
    for (const failure of r.failures) console.error(failure);
    process.exit(r.ok ? 0 : 1);
  }
}
