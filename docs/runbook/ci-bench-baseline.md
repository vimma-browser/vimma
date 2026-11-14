### Bench baseline (`ci.yml`)

Issue #17: key-to-action in core must stay under 50 µs and must not regress by more
than 10 %. `npm run bench` measures five cases (a single key, the prefix plus a key, a count plus
a motion, a two-key sequence, and applying a pane-focus action to a 30-tab workspace) from
`packages/vimma-core/bench/cases.mjs`, twice: as the working tree has them and as the **baseline
commit** named in `packages/vimma-core/bench/baseline.json` has them, in the same processes,
sample by sample. `npm run bench -- --check` is the CI step (about 45 s). It fails when:

- any case of the working tree takes **50 µs or more** (budget), or
- the **suite**, the geometric mean of the cases' changes against the baseline commit, is more
  than **10 %** slower, or one case is more than **25 %** slower, or a case of the baseline
  commit is gone.

The gate is the same on every machine: there are no per-runner numbers to fall back from.
`--base <commit>` measures against another commit, for example `--base origin/main` to see what
a branch costs before opening a pull request.

Why it does not flake (CI never retries; a flaky test means quarantine):

- **The baseline is measured in the same run (issue #342).** Until issue #342 the baseline was
  numbers, one entry per runner class, recorded by other jobs. Unchanged code then read up to
  +12.5 % on the suite against them: over 88 CI runs on `main`, the Xeon 8370C entry (two
  samples) read +11.6 % to +12.5 % every time, the EPYC 9V45 and 9V74 entries +5 % to +9 %, and
  one Xeon 8573C job +10.7 %. A recorded number carries its job's image, neighbours and load, and
  the gate's 10 % margin went on that. Now both sides of each case run on the same runner, in the
  same 15 processes, a few milliseconds apart; in 20 hosted jobs over six CPU models, unchanged
  code read −1.6 % to +3.4 % on the suite (cases −3.3 % to +8.7 %), and `main` against the
  baseline commit −0.7 % to +1.6 % (cases −4.3 % to +5.8 %).
- **Sample by sample, not case after case.** Each sample sweeps over every case in an order that
  rotates per sample. Measured case after case, each case's 51 samples took their own block of
  time, and a change in the runner's load between two blocks (another process on the sibling
  hyperthread slows an allocating case more than the reference) moved one side against the
  other: in the gate's own test (below), unchanged code read from −21 % to +40 % on one case under
  the coverage pool; sample by sample, from −14 % to +12 %.
- **Paired sweep by sweep (issue #667).** The gate does not divide one side's median ratio by the
  other's. When the runner's load comes and goes in phases of a few milliseconds, each side's
  samples fall into a busy and a quiet mode, and a median lands on whichever mode got one more
  sample: unchanged code read +25.0 % on one case on a hosted macOS runner. Instead, each sweep
  divides the working tree's ratio by the baseline's, both taken a few milliseconds apart in the
  same phase, and the gate takes the median of those per round and the median of the rounds.
  `tools/bench/test/bench.test.ts` scripts such a machine on a fake clock: on 20 seeds,
  separate medians read identical code up to +50 %, the paired change reads it within the gate
  and still fails a case made 20 % slower.
- **Load order alternates.** Two copies of identical code in one process differ by several per
  cent on the sub-microsecond cases, one way or the other, from process to process. Loading the
  working tree first in every process leaned that one way (+6 % to +8 % on the suite for
  identical code on one machine), so every other process loads and lists the baseline first,
  and the gate takes each process's own change (working tree over baseline), the median of
  those per load order, and the geometric mean of the two orders. A median of each side alone,
  or of all the changes, would keep the lean: with 8 processes of one order and 7 of the other, a
  7 % lean read identical code at +6.2 % and +7.0 %.
- **Ratios, not raw times.** Each sample times a case and then a fixed reference workload; the
  gate compares the case/reference ratio. A clock change or a busy neighbour mid-run moves both.
- **A reference that costs the same in every process.** The reference looks up integer keys in a
  `Map`. V8 hashes strings with a hash seed it picks at random per process, so a string-keyed
  table gets a different bucket layout in each process; the old string-keyed reference was up to
  22 % slower or faster from one process to the next on an AMD EPYC 7763, and every ratio of that
  process moved with it (issue #125). Integer keys are hashed without the seed. Each bench prints
  the spread (`reference 0.480 µs, +0.2 % from fastest to slowest process`); a large one says the
  reference stopped being steady.
- **The same hash seeds on every run.** The cases do use string keys (the dispatcher's trie), so
  each of the 15 processes runs with its own fixed `--hash-seed` (1 to 15): every run measures the
  same set of table layouts, not 15 new random ones.
- **Robust statistics.** Warm-up, batches of ≥ 100 µs, the median of 51 paired samples per
  round, the median over 5 rounds, per process. Over the 15 processes: the **lowest µs** for the budget
  (noise only adds time) and the **median change** for the gate. Not the lowest ratio: noise in
  the reference's time lowers a ratio, so the lowest ratio picked whichever process had the
  slowest reference (issue #125, PR #121).
- **It still catches a real slowdown.** A dispatcher made 20 % slower fails the gate
  (`tools/bench/test/bench.test.ts`): the test measures the baseline, an unchanged copy and the
  slowed code as variants of one `measure()` call, as the bench measures its two sides, and gates
  the median of three such runs. By hand: a loop of 24 multiply-adds at the top of `dispatch()`
  read +15.2 % on the suite against `--base HEAD` and the step exited 1.
- **The budget has headroom.** The slowest case is about 17 µs on CI, the key cases under 1 µs.

If the step does fail without a slowing change, that is a flake: quarantine it (open an
issue with the log; do not re-run to green), and look at the numbers before touching thresholds.

**Node is pinned exactly** in `.nvmrc`; ci, e2e, mutation, fuzz, sites, spec-status, downloads,
pkgbuild, semgrep, release-please and claude use `node-version-file: .nvmrc` (the base-branch
guards run on the runner's own Node, docs/security/14-build-and-release-supply-chain.md B18), and so do the nightly build jobs and
every release and macos job: no setup-node step takes a bare major such as `node-version: 22`,
which would give the newest 22.x the runner has. A release job checks out the tag's commit before
setup-node, so it reads that tag's `.nvmrc`; every release tag has one (from v0.1.1), and the
build jobs of the same commit read it too, so a tree without it could not be released anyway.
`tools/test/runner-node.test.ts` fails on a setup-node without `.nvmrc`, and lists the jobs that
still run `node` or `npm` on the runner image's own Node, whose version this repository does not
choose; that list only shrinks (#946). A Node bump is its
own PR, by hand (Dependabot has no `.nvmrc` support); a new major also moves `@types/node` to it
(`npm run typecheck` checks `tools/` against it). `.nvmrc` never
leaves `engines` in `package.json` (`^22.18.0 || >=24.3.0`), the versions that run the `.ts` tools
without a flag or a warning (ADR-025). The bench needs nothing for it: both sides of the
comparison run on the same Node.

Moving the baseline, deliberately (like snapshots: never to make a red run green without saying
why):

1. A change that is meant to cost time (a new feature in the dispatch path), or removing or
   renaming a case, is the reason to move it. A new case needs no move: it is measured, noted as
   having no baseline yet, and held to the budget until the baseline commit has it.
2. A pull request cannot name its own merge commit, so it states the cost it brings in
   `baseline.json`'s `accepted`, per case: `"prefix + key": { "change": 0.12, "why": "per-mode
leader lookup" }`. The gate then compares the case with the baseline commit's time plus 12 %,
   and prints the accepted cost as a note. `npm run bench` shows the cost to put there.
3. A later pull request moves `commit` to a commit that has the change and empties `accepted`.
   Removing or renaming a case needs the same move: the commit must not have the old case.
4. The commit body carries a changelog line naming the cases and the change, e.g.
   `bench baseline: prefix + key +12 % from per-mode leader lookup (intended)`.

`--base <commit>` ignores `accepted`, which is relative to the stored commit.
