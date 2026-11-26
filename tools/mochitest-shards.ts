// Splits the mochitests into shards by file, for the macOS job in e2e.yml (issue #1569,
// docs/runbook/ci-macos-mochitests.md). mochitest's own --total-chunks cuts the manifest into
// runs of equal file counts, which left the two halves about 13 % apart on the measured times;
// this split balances the times instead. tools/mochitest-times.json holds each file's median
// seconds on the macOS runner; a file it does not name (a new test) counts as the median file, so
// it lands in a shard without an edit here. The split depends only on the manifest and the table.

/** @param toml  tests/browser/browser.toml */
export function manifestTests(toml: string): string[] {
  return [...toml.matchAll(/^\["(browser_[^"]+\.js)"\]$/gm)].map((m) => m[1] ?? "");
}

/**
 * The longest file first to the least loaded shard (ties: the file name, then the lower shard).
 *
 * @param files  the manifest's test files
 * @param times  measured seconds per file
 * @param shard  1-based
 * @param total  number of shards
 * @returns the shard's files, in manifest order
 */
export function shardTests(
  files: string[],
  times: Record<string, number>,
  shard: number,
  total: number,
): string[] {
  const known = Object.values(times).sort((a, b) => a - b);
  const median = known[Math.floor(known.length / 2)] ?? 1;
  const cost = (f: string) => (Object.hasOwn(times, f) ? (times[f] ?? median) : median);
  const order = [...files].sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0));
  const load = new Array<number>(total).fill(0);
  const owner = new Map<string, number>();
  for (const f of order) {
    const least = load.indexOf(Math.min(...load));
    load[least] = (load[least] ?? 0) + cost(f);
    owner.set(f, least + 1);
  }
  return files.filter((f) => owner.get(f) === shard);
}

/**
 * `npm run mochitest -- --shard=N/M`: replaces the flag with shard N's test paths.
 *
 * @param argv  arguments after `npm run mochitest --`
 * @param toml  tests/browser/browser.toml
 * @param times  tools/mochitest-times.json
 */
export function applyShard(argv: string[], toml: string, times: Record<string, number>): string[] {
  const flag = argv.find((a) => a.startsWith("--shard"));
  if (flag === undefined) return argv;
  const m = /^--shard=(\d+)\/(\d+)$/.exec(flag);
  const [shard, total] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  if (!m || total < 1 || shard < 1 || shard > total)
    throw new Error(`${flag}: expected --shard=N/M with 1 <= N <= M`);
  const rest = argv.filter((a) => a !== flag);
  if (rest.some((a) => !a.startsWith("-")))
    throw new Error("--shard picks the test files itself: give no test paths with it");
  return [
    ...rest,
    ...shardTests(manifestTests(toml), times, shard, total).map((f) => `tests/browser/${f}`),
  ];
}
