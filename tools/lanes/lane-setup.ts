#!/usr/bin/env node
/**
 * `npm run lane:setup` (docs/runbook.md, "Parallel browser lanes"): gives this git worktree its
 * own engine/ and artifact build, so `npm run mochitest -- --artifact tests/browser/` runs here
 * in isolation, next to other lanes and the main checkout's full build.
 *
 *   npm run lane:setup -- [--source <checkout>] [--force] [--allow-copy] [--no-verify]
 *
 * 1. reflink-copies <source>/engine (default: the main checkout's) without its obj-* dirs;
 * 2. resets the copy to upstream: unlinks the source import's symlinks, `git checkout -- .`,
 *    `git clean -fd` (lanes.mjs, resetEngine);
 * 3. runs this worktree's `npm run import`, then tools/artifact-build into engine/obj-artifact;
 * 4. checks no symlink leads into the source checkout, runs browser_vimma_branding.js, and
 *    prints the timings and the disk used.
 * The source checkout is only read. Refuses to run in the main checkout.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  assertLane,
  copyEngine,
  foreignLinks,
  gitEnv,
  laneLinks,
  mainWorktree,
  parseBtrfsDu,
  removeForeignLinks,
  resetEngine,
  teardownTarget,
} from "./lanes.mjs";

const VERIFY_TEST = "tests/browser/browser_vimma_branding.js";

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} cwd
 * @param {boolean} [quiet] capture stdout instead of passing it through
 * Every child (git, and npm/node, whose surfer runs git apply in engine/) gets gitEnv(): no
 * inherited GIT_DIR/GIT_WORK_TREE can steer it at another repo.
 */
function run(cmd, args, cwd, quiet = false) {
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    env: gitEnv(),
  });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${res.status}) ${res.stderr ?? ""}`);
  }
  return res.stdout ?? "";
}

/** @param {number} bytes */
function gb(bytes) {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

/**
 * @param {string} engine
 * @returns {string}
 */
export function diskReport(engine) {
  const btrfs = spawnSync("btrfs", ["filesystem", "du", "-s", "--raw", engine], {
    encoding: "utf8",
  });
  if (btrfs.status === 0) {
    const { total, exclusive } = parseBtrfsDu(btrfs.stdout);
    return `${gb(total)} total, ${gb(exclusive)} exclusive (btrfs filesystem du)`;
  }
  const du = (/** @type {string[]} */ ...a) =>
    Number(spawnSync("du", ["-sb", ...a, engine], { encoding: "utf8" }).stdout.split("\t")[0]);
  return `${gb(du("--apparent-size"))} apparent, ${gb(du())} allocated (du; not btrfs, so no exclusive figure)`;
}

/** @param {string} root this worktree */
async function main(root) {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      force: { type: "boolean", default: false },
      "allow-copy": { type: "boolean", default: false },
      "no-verify": { type: "boolean", default: false },
    },
  });
  const mainCheckout = mainWorktree(run("git", ["worktree", "list", "--porcelain"], root, true));
  const source = resolve(values.source ?? mainCheckout);
  assertLane(root, mainCheckout);
  assertLane(root, source);
  const srcEngine = join(source, "engine");
  if (!existsSync(join(srcEngine, ".git"))) {
    throw new Error(`${srcEngine} has no .git; is ${source} a checkout with an engine?`);
  }
  const engine = join(root, "engine");
  if (existsSync(engine)) {
    if (!values.force) throw new Error(`${engine} exists; pass --force to replace it`);
    rmSync(teardownTarget(root, mainCheckout), { recursive: true, force: true });
  }

  /** @type {Array<[string, number]>} */
  const times = [];
  /**
   * @template T
   * @param {string} name
   * @param {() => T | Promise<T>} fn
   */
  const phase = async (name, fn) => {
    console.log(`lane-setup: ${name}…`);
    const t = performance.now();
    const out = await fn();
    times.push([name, (performance.now() - t) / 1000]);
    return out;
  };

  // Links into main can survive in a non-default source's engine; check both.
  const sources = [...new Set([source, mainCheckout])];
  const { reflink, locks } = await phase("copy", () =>
    copyEngine(srcEngine, engine, { allowCopy: values["allow-copy"] }),
  );
  for (const lock of locks) console.warn(`lane-setup: removed stale lock ${lock} (lane copy)`);
  if (!reflink) console.warn("lane-setup: reflinks unsupported; made a full copy (--allow-copy)");
  await phase("reset", () => {
    const links = removeForeignLinks(engine, sources, root);
    const cleaned = resetEngine(engine);
    console.log(`lane-setup: unlinked ${links.length} links, cleaned ${cleaned.length} paths`);
  });
  await phase("import", () => run("npm", ["run", "import"], root));
  await phase("artifact build", () =>
    run("node", ["tools/artifact-build/artifact-build.mjs"], root),
  );

  const stray = foreignLinks(engine, sources, root);
  const into = sources.join(" or ");
  if (stray.length) {
    throw new Error(`symlinks still lead into ${into}:\n${stray.slice(0, 10).join("\n")}`);
  }
  const own = laneLinks(engine, root).length;
  if (own === 0) throw new Error(`no symlink in ${engine} leads into ${root}; did import run?`);
  console.log(`lane-setup: ${own} symlinks lead into this lane, none into ${into}`);
  if (!values["no-verify"]) {
    await phase("mochitest", () =>
      run("npm", ["run", "mochitest", "--", "--artifact", VERIFY_TEST], root),
    );
  }

  console.log("\nlane-setup: done");
  for (const [name, s] of times) console.log(`  ${name.padEnd(15)} ${s.toFixed(1)} s`);
  console.log(`  disk            ${diskReport(engine)}`);
  console.log("Run: npm run mochitest -- --artifact tests/browser/");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "")).catch((e) => {
    console.error(`lane-setup: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
