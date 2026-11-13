/**
 * Fixes a checkout after it moved on disk (docs/runbook.md, "Moving the checkout").
 *
 * `surfer import` links engine/ to src/ with absolute symlinks, and an objdir records absolute
 * paths in Make dependency files, cargo files and the like. After `mv old new`, this:
 *
 * 1. retargets every symlink under engine/ whose absolute target lies in the old checkout to
 *    the same place in this one (about 139k links on the 2026-10-10 move), and
 * 2. rewrites the old path in the text files of each engine/obj-* objdir, except dist/ (its
 *    entries are links, handled by 1; about 6.9k files on that move). Binaries (a NUL byte)
 *    are left alone; the next build relinks them.
 *
 * Upstream sources, .git and anything outside engine/ are never written. Run it, then
 * `npm run import` and a build (mach reconfigures on its own).
 *
 * CLI: node tools/import/relocate-checkout.mjs --from /old/path [--dry-run]
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  ftruncateSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_TEXT = 64 * 1024 * 1024;

/**
 * Replaces `from` wherever it is the whole path or a directory prefix of one: not inside a
 * longer name such as `/old/repo2`.
 * @param {string} text
 * @param {string} from
 * @param {string} to
 */
export function replacePath(text, from, to) {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${escaped}(?![A-Za-z0-9._-])`, "g"), to);
}

/**
 * @param {string} dir
 * @param {(path: string, entry: import("node:fs").Dirent) => void} visit
 * @param {(name: string) => boolean} [skipDir]
 */
function walk(dir, visit, skipDir = () => false) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!skipDir(e.name)) walk(p, visit, skipDir);
    } else visit(p, e);
  }
}

/**
 * @param {{ root: string, from: string, dryRun?: boolean }} opts root: this checkout (where the
 *   tree is now); from: where it was
 * @returns {{ links: number, files: number }} what was (or, dry, would be) changed
 */
export function relocate({ root, from, dryRun = false }) {
  if (!isAbsolute(from) || !isAbsolute(root)) {
    throw new Error("relocate: --from and the checkout must be absolute paths");
  }
  const old = resolve(from);
  const now = resolve(root);
  if (old === now) throw new Error(`relocate: ${old} is the same path as this checkout`);
  const engine = join(now, "engine");
  const under = (/** @type {string} */ t) => t === old || t.startsWith(`${old}/`);

  let links = 0;
  walk(
    engine,
    (p, e) => {
      if (!e.isSymbolicLink()) return;
      const target = readlinkSync(p);
      if (!under(target)) return;
      links++;
      if (dryRun) return;
      unlinkSync(p);
      symlinkSync(now + target.slice(old.length), p);
    },
    (name) => name === ".git",
  );

  let files = 0;
  const needle = Buffer.from(old);
  for (const obj of readdirSync(engine, { withFileTypes: true })) {
    if (!obj.isDirectory() || !obj.name.startsWith("obj-")) continue;
    const objdir = join(engine, obj.name);
    for (const top of readdirSync(objdir, { withFileTypes: true })) {
      if (top.name === "dist") continue;
      const visit = (/** @type {string} */ p) => {
        // One descriptor for the check, the read and the write, opened without following a
        // link: a file swapped for a link between them cannot be written through
        // (CodeQL js/file-system-race). O_NONBLOCK: a FIFO is opened, seen and skipped.
        const { O_RDONLY, O_RDWR, O_NOFOLLOW, O_NONBLOCK } = fsConstants;
        let fd;
        try {
          fd = openSync(p, (dryRun ? O_RDONLY : O_RDWR) | O_NOFOLLOW | O_NONBLOCK);
        } catch (e) {
          if (/** @type {NodeJS.ErrnoException} */ (e).code === "ELOOP") return; // a link
          throw e;
        }
        try {
          const st = fstatSync(fd);
          // Big files are build products (libxul is gigabytes), never text worth rewriting.
          if (!st.isFile() || st.size > MAX_TEXT) return;
          const buf = readFileSync(fd);
          if (!buf.includes(needle) || buf.includes(0)) return;
          const text = buf.toString("utf8");
          const next = replacePath(text, old, now);
          if (next === text) return;
          files++;
          if (dryRun) return;
          const out = Buffer.from(next);
          ftruncateSync(fd, 0);
          writeSync(fd, out, 0, out.length, 0);
        } finally {
          closeSync(fd);
        }
      };
      const p = join(objdir, top.name);
      if (top.isDirectory()) walk(p, (f) => visit(f));
      else visit(p);
    }
  }
  return { links, files };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--from");
  const from = at >= 0 ? args[at + 1] : undefined;
  const dryRun = args.includes("--dry-run");
  const known = new Set(["--from", "--dry-run", from]);
  if (!from || args.some((a) => !known.has(a))) {
    console.error("usage: relocate-checkout.mjs --from /old/checkout/path [--dry-run]");
    process.exit(2);
  }
  const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
  const r = relocate({ root, from, dryRun });
  const verb = dryRun ? "would retarget" : "retargeted";
  console.log(
    `relocate-checkout: ${verb} ${r.links} symlink(s) and rewrote ${r.files} objdir file(s)`,
  );
  if (!dryRun) console.log("next: npm run import, then a build (mach reconfigures)");
}
