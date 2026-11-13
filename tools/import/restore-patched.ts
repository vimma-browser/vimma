/**
 * Restores the upstream files our `src/**\/*.patch` files touch, before `surfer import`
 * re-applies the patches (docs/runbook.md, "Re-importing after a patch changes").
 *
 * Surfer applies each patch with `git apply -R` (ignoring failure) then `git apply`. When a
 * patch changed since the last import, the reverse of the new patch does not match what the old
 * one left in engine/, so the forward apply fails on a file that already carries the old hunks.
 * Checking out exactly those files from the engine's own git first makes every import start
 * from upstream. Nothing else in engine/ is touched: never `git checkout .`, never a clean.
 *
 * CLI: node tools/import/restore-patched.mjs [--dry-run]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Upstream paths a unified diff modifies: the `+++ b/<path>` line of each `--- `/`+++ ` header
 * pair outside a hunk. A file the patch creates (`--- /dev/null`) or deletes (`+++ /dev/null`)
 * has no upstream version to restore, so it is left out.
 * @param {string} text the patch
 * @returns {string[]} engine-relative paths, in order of first appearance, without duplicates
 */
export function patchedFiles(text) {
  const lines = text.split("\n");
  /** @type {string[]} */
  const files = [];
  let oldLeft = 0;
  let newLeft = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = /** @type {string} */ (lines[i]);
    if (oldLeft > 0 || newLeft > 0) {
      // Inside a hunk: count lines so a removed "-- a/x" or added "++ b/x" is never a header.
      if (line.startsWith("-")) oldLeft--;
      else if (line.startsWith("+")) newLeft--;
      else if (line.startsWith("\\")) continue;
      else {
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      continue;
    }
    const next = lines[i + 1];
    if (!line.startsWith("--- ") || next === undefined || !next.startsWith("+++ ")) continue;
    i++;
    const from = headerPath(line);
    const to = headerPath(next);
    if (from === "/dev/null" || to === "/dev/null" || !to.startsWith("b/")) continue;
    const file = to.slice(2);
    if (isAbsolute(file) || normalize(file).split(sep)[0] === ".." || file === "") {
      throw new Error(`patch path ${JSON.stringify(file)} is outside the engine`);
    }
    if (!files.includes(file)) files.push(file);
  }
  return files;
}

/** @param {string} line a `--- ` or `+++ ` header; a tab starts an optional timestamp */
function headerPath(line) {
  return /** @type {string} */ (line.slice(4).split("\t")[0]).trimEnd();
}

/**
 * @param {string} dir
 * @returns {string[]} every `*.patch` under dir, as absolute paths, sorted
 */
export function findPatches(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".patch"))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

/**
 * @param {{ src: string, engine: string, dryRun?: boolean }} opts
 * @returns {{ files: string[], untracked: string[], command?: string[], skipped?: string }}
 */
export function restorePatched({ src, engine, dryRun = false }) {
  if (!existsSync(join(engine, ".git"))) {
    return { files: [], untracked: [], skipped: `no engine git repo at ${engine}` };
  }
  /** @type {string[]} */
  const wanted = [];
  for (const patch of findPatches(src)) {
    for (const f of patchedFiles(readFileSync(patch, "utf8"))) {
      if (!wanted.includes(f)) wanted.push(f);
    }
  }
  if (wanted.length === 0) return { files: [], untracked: [] };
  // Only what upstream tracks can be checked out; a path it lacks would fail the whole checkout.
  const listed = git(engine, ["ls-files", "-z", "--", ...wanted])
    .split("\0")
    .filter(Boolean);
  const files = wanted.filter((f) => listed.includes(f));
  const untracked = wanted.filter((f) => !listed.includes(f));
  const command = ["git", "-C", engine, "checkout", "--", ...files];
  if (!dryRun && files.length > 0) git(engine, ["checkout", "--", ...files]);
  return { files, untracked, command };
}

/**
 * @param {string} dir
 * @param {string[]} args
 */
function git(dir, args) {
  // No inherited GIT_* (a hook or worktree's GIT_DIR would point git at the wrong repo).
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--dry-run");
  if (unknown.length > 0) {
    console.error(`usage: restore-patched.mjs [--dry-run] (unknown: ${unknown.join(" ")})`);
    process.exit(2);
  }
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const dryRun = args.includes("--dry-run");
  const r = restorePatched({ src: join(root, "src"), engine: join(root, "engine"), dryRun });
  if (r.skipped) console.log(`restore-patched: skipped, ${r.skipped}`);
  else {
    const verb = dryRun ? "would restore" : "restored";
    console.log(`restore-patched: ${verb} ${r.files.length} upstream file(s)`);
    for (const f of r.files) console.log(`  ${f}`);
    if (dryRun && r.command) console.log(`  (${r.command.join(" ")})`);
    for (const f of r.untracked) console.log(`  not in upstream, left alone: ${f}`);
  }
}
