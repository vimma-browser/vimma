#!/usr/bin/env node
/**
 * `npm run lane:teardown` (docs/runbook.md, "Parallel browser lanes"): removes this worktree's
 * engine/ (its copy of the tree and its obj-artifact). Refuses in the main checkout, and refuses
 * an engine/ that is a symlink or resolves into the main checkout's engine (lanes.mjs,
 * teardownTarget).
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gitEnv, mainWorktree, teardownTarget } from "./lanes.mjs";

/** @param {string} root this worktree */
function main(root) {
  const res = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
    env: gitEnv(),
  });
  if (res.status !== 0) throw new Error(`git worktree list failed: ${res.stderr}`);
  const engine = teardownTarget(root, mainWorktree(res.stdout));
  console.log(`lane-teardown: removing ${engine}`);
  rmSync(engine, { recursive: true, force: true });
  console.log("lane-teardown: done");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, ""));
  } catch (e) {
    console.error(`lane-teardown: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
