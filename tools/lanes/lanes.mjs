/**
 * Parallel browser lanes (docs/runbook.md, "Parallel browser lanes"): a git worktree with its
 * own engine/, reflink-copied from a source checkout's engine (default: the main checkout), so
 * several agents can run `npm run mochitest -- --artifact` at once without sharing a tree.
 *
 * Everything here writes only under the lane's engine/; the source checkout is read, never
 * written. assertLane and teardownTarget are the guards; the CLIs are lane-setup.mjs and
 * lane-teardown.mjs.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/** Objdirs live at the engine's top level (MOZ_OBJDIR=@TOPSRCDIR@/obj-…); none is copied. */
const OBJDIR = /^obj-/;

/**
 * @param {string} porcelain output of `git worktree list --porcelain`
 * @returns {string} the main worktree (git lists it first)
 */
export function mainWorktree(porcelain) {
  const match = /^worktree (.+)$/m.exec(porcelain);
  if (!match?.[1]) throw new Error("no worktree in `git worktree list --porcelain` output");
  return match[1];
}

/**
 * @param {string} p
 * @param {string} dir
 */
function inside(p, dir) {
  return p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** @param {string} p the path, and its real path when it exists */
function forms(p) {
  const abs = resolve(p);
  return existsSync(abs) ? [...new Set([abs, realpathSync(abs)])] : [abs];
}

/**
 * Throws unless `root` is a checkout other than `main`: a lane never is the main checkout.
 * @param {string} root the would-be lane (a worktree root)
 * @param {string} main the main checkout
 */
export function assertLane(root, main) {
  if (realpathSync(root) === realpathSync(main)) {
    throw new Error(
      `${root} is the main checkout; lanes are for worktrees (git worktree add, or an agent ` +
        `worktree under .claude/worktrees/). The main checkout's engine/ is never touched.`,
    );
  }
}

/**
 * @param {string[]} names top-level entries of the source engine/
 * @returns {string[]} the ones a lane copies: all but the objdirs
 */
export function copyEntries(names) {
  return names.filter((n) => !OBJDIR.test(n));
}

/**
 * @typedef {(args: string[]) => Promise<{ code: number, stderr: string }>} Cp
 */

/**
 * GNU cp's reflink flags as BSD cp (macOS) spells them: `-c` clones with clonefile(2) on APFS
 * and fails where it cannot, like --reflink=always; --reflink=auto is a plain copy.
 * @param {string[]} args GNU cp arguments
 * @param {NodeJS.Platform} [platform]
 * @returns {string[]}
 */
export function cpArgs(args, platform = process.platform) {
  if (platform !== "darwin") return args;
  return args.flatMap((a) =>
    a === "--reflink=always" ? ["-c"] : a === "--reflink=auto" ? [] : [a],
  );
}

/** @type {Cp} */
function runCp(args) {
  return new Promise((done) => {
    const child = spawn("cp", cpArgs(args), { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => done({ code: code ?? 1, stderr }));
  });
}

/**
 * A file to probe reflinks with: the index is large enough not to be inlined in btrfs metadata.
 * @param {string} src
 */
function probeFile(src) {
  for (const p of [".git/index", "mach", ".git/HEAD"]) {
    const abs = join(src, p);
    if (existsSync(abs) && lstatSync(abs).isFile()) return abs;
  }
  throw new Error(`${src} does not look like an engine/ (no .git/index, mach or .git/HEAD)`);
}

/**
 * Reflink-copies `src` (an engine/) to `dest`, without its objdirs. `cp -a` keeps modes,
 * timestamps and symlinks as they are (they are fixed up afterwards by removeForeignLinks).
 * Refuses an existing `dest`; refuses a non-reflink copy (6 GB, minutes) unless allowCopy.
 * @param {string} src
 * @param {string} dest
 * @param {{ allowCopy?: boolean, cp?: Cp, jobs?: number }} [opts]
 */
export async function copyEngine(src, dest, { allowCopy = false, cp = runCp, jobs = 8 } = {}) {
  // One atomic, non-recursive mkdir: a second setup in the same worktree fails here (EEXIST),
  // and so does a dangling symlink at dest; a missing lane root is not created.
  try {
    mkdirSync(dest);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "EEXIST") {
      throw new Error(`${dest} already exists; pass --force to replace it`, { cause: e });
    }
    throw e;
  }
  const probe = join(dest, ".lane-reflink-probe");
  const res = await cp(["--reflink=always", probeFile(src), probe]);
  rmSync(probe, { force: true });
  let mode = "--reflink=always";
  if (res.code !== 0) {
    if (!allowCopy) {
      rmSync(dest, { recursive: true, force: true });
      throw new Error(
        `cannot reflink ${src} to ${dest} (${res.stderr.trim()}): both must be on the same ` +
          `btrfs (or XFS with reflink) filesystem. A plain copy is about 6 GB and takes ` +
          `minutes; pass --allow-copy to do it anyway.`,
      );
    }
    mode = "--reflink=auto";
  }
  const queue = copyEntries(readdirSync(src));
  /** @type {string[]} */
  const failures = [];
  const worker = async () => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      const r = await cp(["-a", mode, join(src, name), join(dest, name)]);
      if (r.code !== 0) failures.push(`${name}: ${r.stderr.trim()}`);
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  if (failures.length) throw new Error(`copying ${src} failed:\n${failures.join("\n")}`);
  return { reflink: mode === "--reflink=always", locks: removeStaleLocks(dest) };
}

/**
 * Removes *.lock files under the lane's .git: copied while a git command ran in the source
 * (say, mid-import), they would block every git call in the lane. Only ever called on the lane.
 * @param {string} engine the lane's engine/
 * @returns {string[]} the removed locks
 */
function removeStaleLocks(engine) {
  const gitDir = join(engine, ".git");
  if (!existsSync(gitDir) || isLink(gitDir)) return [];
  /** @type {string[]} */
  const locks = [];
  const stack = [gitDir];
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.name.endsWith(".lock")) locks.push(p);
    }
  }
  for (const lock of locks) unlinkSync(lock);
  return locks;
}

/** @param {string} p */
function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Every symlink under `engine`, skipping its .git and objdirs, with the absolute path it points
 * at (not resolved further; Surfer's links are absolute).
 * @param {string} engine
 * @returns {Array<[string, string]>}
 */
function symlinks(engine) {
  /** @type {Array<[string, string]>} */
  const out = [];
  const stack = [engine];
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (dir === engine && (entry.name === ".git" || OBJDIR.test(entry.name))) continue;
      if (entry.isSymbolicLink()) out.push([p, resolve(dirname(p), readlinkSync(p))]);
      else if (entry.isDirectory()) stack.push(p);
    }
  }
  return out;
}

/**
 * Symlinks in the lane's engine that point into a source checkout (Surfer's absolute links
 * from the import there), excluding those into the lane, which lives under the source's path
 * when it is an agent worktree. Pass both --source and the main checkout: a non-default
 * source's engine may itself have been copied from main's and still carry links into it.
 * @param {string} engine the lane's engine/
 * @param {string | string[]} sources the source checkout(s)
 * @param {string} lane the lane (worktree root)
 * @returns {string[]}
 */
export function foreignLinks(engine, sources, lane) {
  const src = [sources].flat().flatMap(forms);
  const own = forms(lane);
  return symlinks(engine)
    .filter(([, t]) => src.some((s) => inside(t, s)) && !own.some((l) => inside(t, l)))
    .map(([p]) => p);
}

/**
 * Symlinks in the lane's engine that point into the lane outside its engine (its src/, tests/):
 * what its own `surfer import` made. Upstream's links within the engine are not counted.
 * @param {string} engine
 * @param {string} lane
 * @returns {string[]}
 */
export function laneLinks(engine, lane) {
  const own = forms(lane);
  const eng = forms(engine);
  return symlinks(engine)
    .filter(([, t]) => own.some((l) => inside(t, l)) && !eng.some((e) => inside(t, e)))
    .map(([p]) => p);
}

/**
 * Unlinks the foreign links (never their targets). Refuses unless `engine` is inside a lane
 * that is none of the source checkouts.
 * @param {string} engine
 * @param {string | string[]} sources see foreignLinks
 * @param {string} lane
 * @returns {string[]} the removed links
 */
export function removeForeignLinks(engine, sources, lane) {
  for (const source of [sources].flat()) assertLane(lane, source);
  if (!forms(lane).some((l) => inside(realpathSync(engine), l))) {
    throw new Error(`${engine} is not inside the lane ${lane}`);
  }
  const links = foreignLinks(engine, sources, lane);
  for (const link of links) unlinkSync(link);
  return links;
}

/**
 * The environment for git children, without GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE or any other
 * GIT_* variable: from a hook or `git rebase --exec` they point at the calling repo (possibly
 * main's), and `git -C <engine> reset` would then reset that repo's index.
 * @returns {NodeJS.ProcessEnv}
 */
export function gitEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
}

/** Files the import writes that upstream's .gitignore (`/mozconfig*`) hides from git clean. */
const IMPORT_IGNORED = ["mozconfig", "mozconfig.artifact"];

/**
 * Resets a copied engine/ to upstream as `surfer download` committed it, so the source
 * checkout's import does not leak into the lane. Surfer's own `surfer reset`
 * (dist/commands/reset.js) runs `git reset`, `git checkout .`, `git clean -fdx`; this is the
 * same without -x, so files upstream ignores (caches, objdirs) stay:
 * - `git checkout -- .` undoes the .patch files and restores .gitignore, dropping the lines
 *   copy-patches.js appended for every src/ and tests/ file it linked;
 * - with those lines gone, `git clean -fd` sees, and removes, what the import added: the dirs
 *   its links lived in (removeForeignLinks has unlinked the links themselves), the generated
 *   browser/branding/<brand>/, files new .patch files created;
 * - mozconfig and mozconfig.artifact, which upstream ignores, are removed by name.
 * Call removeForeignLinks first: git checkout over a link into the source would replace the
 * link, not write through it, but nothing here should depend on that.
 * @param {string} engine the lane's engine/
 * @returns {string[]} the paths git clean removed
 */
export function resetEngine(engine) {
  const git = (/** @type {string[]} */ ...args) => {
    const res = spawnSync("git", ["-C", engine, ...args], { encoding: "utf8", env: gitEnv() });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")} in ${engine}: ${res.stderr}`);
    return res.stdout;
  };
  // Without its own .git, git would find the enclosing worktree (or main, which the lane sits
  // inside) and reset that.
  let top = "";
  try {
    top = git("rev-parse", "--show-toplevel").trim();
  } catch {
    // no repo at all; refused below
  }
  if (!top || realpathSync(top) !== realpathSync(engine)) {
    throw new Error(
      `${engine} is not the top of its own git repo (git says ${top || "no repo"}); refusing ` +
        `to reset or clean it`,
    );
  }
  git("reset", "-q");
  git("checkout", "--", ".");
  const removed = git("clean", "-fd")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.replace(/^Removing /, ""));
  for (const name of IMPORT_IGNORED) rmSync(join(engine, name), { force: true });
  return removed;
}

/**
 * The engine/ that `lane:teardown` may remove: the worktree's own, a real directory, never the
 * main checkout's.
 * @param {string} root the worktree root
 * @param {string} main the main checkout
 * @returns {string}
 */
export function teardownTarget(root, main) {
  assertLane(root, main);
  const engine = join(resolve(root), "engine");
  if (!existsSync(engine) && !isLink(engine)) throw new Error(`${root} has no engine/`);
  if (isLink(engine)) {
    throw new Error(`${engine} is a symlink; refusing (it may lead to another checkout's engine)`);
  }
  const real = realpathSync(engine);
  const mainEngine = join(main, "engine");
  if (!existsSync(mainEngine)) {
    throw new Error(
      `the main checkout ${main} has no engine/, so ${engine} cannot be checked against it; ` +
        `refusing (remove it by hand if you are sure)`,
    );
  }
  if (inside(real, realpathSync(mainEngine))) {
    throw new Error(`${engine} resolves into the main checkout's engine; refusing`);
  }
  return engine;
}

/**
 * @param {string} out stdout of `btrfs filesystem du -s --raw <path>`
 * @returns {{ total: number, exclusive: number }} bytes
 */
export function parseBtrfsDu(out) {
  const row = out
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find((f) => f.length >= 4 && /^\d+$/.test(f[0] ?? "") && /^\d+$/.test(f[1] ?? ""));
  if (!row) throw new Error(`unexpected \`btrfs filesystem du\` output: ${out.trim()}`);
  return { total: Number(row[0]), exclusive: Number(row[1]) };
}
