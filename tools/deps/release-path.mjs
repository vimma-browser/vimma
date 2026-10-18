// The npm packages the release build runs, computed from package-lock.json (spec
// build-supply-chain, decisions 13 to 15; docs/security.md, B3). dependabot-automerge.yml's
// `classify` job runs this from the pull request's base commit on the head commit's lockfile, read
// as data, and holds the pull request for a person when any package on the release path changes.
//
//   node tools/deps/release-path.mjs --diff <base lockfile> <head lockfile>
//     prints {"decision":"merge"|"review","packages":[{name,key,old,new,diff}]}
//   node tools/deps/release-path.mjs [lockfile]
//     prints the release path's lockfile keys, one per line
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * What release.yml's build job runs from node_modules: Surfer (npm run import, surfer build) and
 * ajv (validate-sbom.mjs). release-path.test.mjs checks this against the job's imports.
 */
export const ROOTS = ["@zen-browser/surfer", "ajv"];

/**
 * @typedef {{ version?: string, resolved?: string, integrity?: string, name?: string,
 *   dependencies?: Record<string, string>, optionalDependencies?: Record<string, string>,
 *   peerDependencies?: Record<string, string>, link?: boolean }} Entry
 * @typedef {{ packages: Record<string, Entry> }} Lockfile
 * @typedef {{ name: string, key: string, old: string | null, new: string | null, diff: boolean }}
 *   Change
 */

/**
 * Node's lookup: the nearest node_modules/<name> from `from` upwards, then the top level.
 * @param {Record<string, Entry>} packages
 * @param {string} from a lockfile key ("" for the root package)
 * @param {string} name
 * @returns {string | undefined} the key of the package `from` gets for `name`
 */
function resolve(packages, from, name) {
  let dir = from;
  for (;;) {
    const key = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`;
    if (key in packages) return key;
    if (!dir) return undefined;
    const at = dir.lastIndexOf("/node_modules/");
    dir = at < 0 ? "" : dir.slice(0, at);
  }
}

/**
 * @param {Lockfile} lock a package-lock.json, lockfileVersion 2 or 3
 * @returns {Set<string>} the lockfile keys of the roots and every package they depend on
 */
export function releasePath(lock) {
  const packages = lock?.packages;
  if (!packages || typeof packages !== "object") throw new Error("not a lockfile: no packages");
  /** @type {Set<string>} */
  const out = new Set();
  /** @type {[string, string, boolean][]} from, name, required */
  const queue = ROOTS.map((name) => /** @type {[string, string, boolean]} */ (["", name, true]));
  while (queue.length > 0) {
    const [from, name, required] = /** @type {[string, string, boolean]} */ (queue.pop());
    const key = resolve(packages, from, name);
    if (key === undefined) {
      // A missing required package means the lockfile is not what npm would install from.
      if (required) throw new Error(`${from || "the root"} needs ${name}, which is not installed`);
      continue;
    }
    if (out.has(key)) continue;
    out.add(key);
    const entry = packages[key] ?? {};
    for (const dep of Object.keys(entry.dependencies ?? {})) queue.push([key, dep, true]);
    // Optional and peer dependencies run when npm installed them, so they count when present.
    for (const dep of Object.keys(entry.optionalDependencies ?? {})) queue.push([key, dep, false]);
    for (const dep of Object.keys(entry.peerDependencies ?? {})) queue.push([key, dep, false]);
  }
  return out;
}

const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * @param {Lockfile} base the base commit's lockfile
 * @param {Lockfile} head the pull request's lockfile
 * @returns {{ decision: "merge" | "review", packages: Change[] }} `review` when a package whose
 *   version, resolved or integrity changed is on the release path of either lockfile; `diff`
 *   says whether its name and both versions are safe to hand to `npm diff` as arguments
 */
export function classify(base, head) {
  const path = new Set([...releasePath(base), ...releasePath(head)]);
  /** @type {Change[]} */
  const packages = [];
  for (const key of [...path].sort()) {
    const a = base.packages[key];
    const b = head.packages[key];
    if (
      a &&
      b &&
      a.version === b.version &&
      a.resolved === b.resolved &&
      a.integrity === b.integrity
    ) {
      continue;
    }
    const name = b?.name ?? a?.name ?? key.slice(key.lastIndexOf("node_modules/") + 13);
    const old = a?.version ?? null;
    const now = b?.version ?? null;
    const diff = NAME.test(name) && VERSION.test(old ?? "") && VERSION.test(now ?? "");
    packages.push({ name, key, old, new: now, diff });
  }
  return { decision: packages.length > 0 ? "review" : "merge", packages };
}

/** @param {string} file */
const load = (file) => /** @type {Lockfile} */ (JSON.parse(readFileSync(file, "utf8")));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--diff" && args.length === 3) {
    process.stdout.write(`${JSON.stringify(classify(load(args[1] ?? ""), load(args[2] ?? "")))}\n`);
  } else if (args.length <= 1 && !args[0]?.startsWith("-")) {
    for (const key of [...releasePath(load(args[0] ?? "package-lock.json"))].sort()) {
      process.stdout.write(`${key}\n`);
    }
  } else {
    process.stderr.write("usage: release-path.mjs [lockfile] | --diff <base> <head>\n");
    process.exit(2);
  }
}
