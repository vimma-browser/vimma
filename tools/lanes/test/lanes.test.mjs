import { describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  assertLane,
  copyEngine,
  copyEntries,
  cpArgs,
  foreignLinks,
  laneLinks,
  mainWorktree,
  parseBtrfsDu,
  removeForeignLinks,
  resetEngine,
  teardownTarget,
} from "../lanes.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tempDir } from "../../test/temp-dir.mjs";

/**
 * A main checkout with an imported engine, and a worktree under its .claude/worktrees/, the
 * layout the lanes run in.
 */
function fakeCheckouts() {
  const base = tempDir("vimma-lanes-");
  const main = join(base, "main");
  const lane = join(main, ".claude", "worktrees", "agent-x");
  const engine = join(main, "engine");
  mkdirSync(join(main, "src", "browser"), { recursive: true });
  mkdirSync(join(main, "tests", "browser"), { recursive: true });
  writeFileSync(join(main, "src", "browser", "ours.js"), "ours\n");
  writeFileSync(join(main, "tests", "browser", "browser_x.js"), "test\n");
  mkdirSync(lane, { recursive: true });
  for (const dir of [".git", "browser/base", "browser/base/zen-components/tests/browser"]) {
    mkdirSync(join(engine, dir), { recursive: true });
  }
  writeFileSync(join(engine, ".git", "HEAD"), "ref: refs/heads/vimma\n");
  writeFileSync(join(engine, "mach"), "#!/bin/sh\n");
  chmodSync(join(engine, "mach"), 0o755);
  writeFileSync(join(engine, "browser", "base", "upstream.js"), "upstream\n");
  // Surfer's import: absolute symlinks into the checkout it ran from.
  symlinkSync(join(main, "src", "browser", "ours.js"), join(engine, "browser", "base", "ours.js"));
  symlinkSync(
    join(main, "tests", "browser", "browser_x.js"),
    join(engine, "browser/base/zen-components/tests/browser/browser_x.js"),
  );
  // An upstream relative symlink, which stays.
  symlinkSync("upstream.js", join(engine, "browser", "base", "alias.js"));
  for (const obj of ["obj-x86_64-pc-linux-gnu", "obj-artifact"]) {
    mkdirSync(join(engine, obj, "dist"), { recursive: true });
    writeFileSync(join(engine, obj, "dist", "libxul.so"), "big\n");
  }
  return { base, main, lane, engine };
}

/** cp that runs nothing and remembers its arguments; fails `--reflink=always` when asked. */
function fakeCp(reflink = true) {
  /** @type {string[][]} */
  const calls = [];
  /** @param {string[]} args */
  const cp = async (args) => {
    calls.push(args);
    if (!reflink && args.includes("--reflink=always")) {
      return { code: 1, stderr: "cp: failed to clone 'x': Operation not supported" };
    }
    return { code: 0, stderr: "" };
  };
  return { cp, calls };
}

describe("mainWorktree", () => {
  it("is the first worktree of `git worktree list --porcelain`", () => {
    const out = [
      "worktree /home/u/VimHerdr",
      "HEAD 10b3551",
      "branch refs/heads/main",
      "",
      "worktree /home/u/VimHerdr/.claude/worktrees/agent-x",
      "HEAD 28128bb",
      "detached",
      "",
    ].join("\n");
    expect(mainWorktree(out)).toBe("/home/u/VimHerdr");
  });

  it("throws on output without a worktree", () => {
    expect(() => mainWorktree("")).toThrow(/git worktree list/);
  });
});

describe("assertLane", () => {
  it("refuses the main checkout", () => {
    const { main } = fakeCheckouts();
    expect(() => assertLane(main, main)).toThrow(/main checkout/);
  });

  it("refuses the main checkout through a symlinked path", () => {
    const { base, main } = fakeCheckouts();
    symlinkSync(main, join(base, "alias"));
    expect(() => assertLane(join(base, "alias"), main)).toThrow(/main checkout/);
  });

  it("accepts a worktree", () => {
    const { main, lane } = fakeCheckouts();
    expect(() => assertLane(lane, main)).not.toThrow();
  });
});

describe("copyEntries", () => {
  it("excludes every obj-* dir and keeps .git", () => {
    expect(
      copyEntries([".git", "browser", "obj-x86_64-pc-linux-gnu", "obj-artifact", "obj-x", "mach"]),
    ).toEqual([".git", "browser", "mach"]);
  });
});

describe("cpArgs", () => {
  it("spells the reflink flags as BSD cp does on macOS, and leaves GNU cp's alone", () => {
    expect(cpArgs(["-a", "--reflink=always", "s", "d"], "darwin")).toEqual(["-a", "-c", "s", "d"]);
    expect(cpArgs(["-a", "--reflink=auto", "s", "d"], "darwin")).toEqual(["-a", "s", "d"]);
    expect(cpArgs(["-a", "--reflink=always", "s", "d"], "linux")).toEqual([
      "-a",
      "--reflink=always",
      "s",
      "d",
    ]);
  });
});

describe("copyEngine", () => {
  it("copies everything but the objdirs, with .git, permissions and symlinks as they are", async () => {
    const { main, lane, engine } = fakeCheckouts();
    const dest = join(lane, "engine");
    // tmpfs has no reflinks: this exercises the --allow-copy path with the real cp (on macOS,
    // APFS clones).
    await copyEngine(engine, dest, { allowCopy: true });
    expect(existsSync(join(dest, ".git", "HEAD"))).toBe(true);
    expect(statSync(join(dest, "mach")).mode & 0o777).toBe(0o755);
    expect(existsSync(join(dest, "obj-x86_64-pc-linux-gnu"))).toBe(false);
    expect(existsSync(join(dest, "obj-artifact"))).toBe(false);
    const link = join(dest, "browser", "base", "ours.js");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(main, "src", "browser", "ours.js"));
  });

  it("asks cp for reflinks of every entry but the objdirs", async () => {
    const { lane, engine } = fakeCheckouts();
    const { cp, calls } = fakeCp(true);
    await copyEngine(engine, join(lane, "engine"), { cp });
    const copies = calls.filter((c) => c.includes("-a"));
    expect(copies.every((c) => c.includes("--reflink=always"))).toBe(true);
    const sources = copies.map((c) => c.at(-2));
    expect(sources).toContain(join(engine, ".git"));
    expect(sources.some((s) => s?.includes("obj-"))).toBe(false);
  });

  it("fails with a clear message when reflinks are unsupported, before copying anything", async () => {
    const { lane, engine } = fakeCheckouts();
    const { cp, calls } = fakeCp(false);
    await expect(copyEngine(engine, join(lane, "engine"), { cp })).rejects.toThrow(
      /reflink.*--allow-copy/s,
    );
    expect(calls.filter((c) => c.includes("-a"))).toEqual([]);
  });

  it("falls back to a plain copy with allowCopy", async () => {
    const { lane, engine } = fakeCheckouts();
    const { cp, calls } = fakeCp(false);
    await copyEngine(engine, join(lane, "engine"), { cp, allowCopy: true });
    const copies = calls.filter((c) => c.includes("-a"));
    expect(copies.length).toBeGreaterThan(0);
    expect(copies.every((c) => c.includes("--reflink=auto"))).toBe(true);
  });

  it("refuses an existing destination", async () => {
    const { lane, engine } = fakeCheckouts();
    mkdirSync(join(lane, "engine"));
    await expect(copyEngine(engine, join(lane, "engine"), fakeCp())).rejects.toThrow(
      /already exists/,
    );
  });
});

describe("foreignLinks / removeForeignLinks", () => {
  it("finds the symlinks into the source checkout, not upstream or lane ones", async () => {
    const { main, lane, engine } = fakeCheckouts();
    const dest = join(lane, "engine");
    await copyEngine(engine, dest, { allowCopy: true });
    // A link into the lane itself (the lane lives under the main checkout's path).
    mkdirSync(join(lane, "src"), { recursive: true });
    writeFileSync(join(lane, "src", "mine.js"), "mine\n");
    symlinkSync(join(lane, "src", "mine.js"), join(dest, "browser", "base", "mine.js"));
    const found = foreignLinks(dest, main, lane);
    expect(found.sort()).toEqual(
      [
        join(dest, "browser/base/ours.js"),
        join(dest, "browser/base/zen-components/tests/browser/browser_x.js"),
      ].sort(),
    );
    expect(laneLinks(dest, lane)).toEqual([join(dest, "browser/base/mine.js")]);
  });

  it("removes them without touching their targets", async () => {
    const { main, lane, engine } = fakeCheckouts();
    const dest = join(lane, "engine");
    await copyEngine(engine, dest, { allowCopy: true });
    const removed = removeForeignLinks(dest, main, lane);
    expect(removed).toHaveLength(2);
    expect(foreignLinks(dest, main, lane)).toEqual([]);
    expect(existsSync(join(main, "src", "browser", "ours.js"))).toBe(true);
    expect(lstatSync(join(dest, "browser/base/alias.js")).isSymbolicLink()).toBe(true);
    // The source checkout's own engine is untouched.
    expect(lstatSync(join(engine, "browser/base/ours.js")).isSymbolicLink()).toBe(true);
  });

  it("refuses to scan the source checkout's own engine", () => {
    const { main, engine } = fakeCheckouts();
    expect(() => removeForeignLinks(engine, main, main)).toThrow(/main checkout/);
  });
});

describe("resetEngine", () => {
  /** An engine git repo as `surfer download` makes it, then imported. */
  function importedEngine() {
    const { main, lane } = fakeCheckouts();
    const engine = join(lane, "engine");
    mkdirSync(join(engine, "browser"), { recursive: true });
    const git = (/** @type {string[]} */ ...args) =>
      execFileSync("git", ["-C", engine, ...args], { encoding: "utf8" });
    git("init", "-q");
    writeFileSync(join(engine, ".gitignore"), "/mozconfig*\n/obj-*\n*.pyc\n");
    writeFileSync(join(engine, "browser", "moz.build"), "upstream\n");
    git("add", "-f", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "Firefox");
    // What the import did: patch a tracked file, add files and dirs, extend .gitignore.
    writeFileSync(join(engine, "browser", "moz.build"), "patched\n");
    writeFileSync(join(engine, ".gitignore"), "/mozconfig*\n/obj-*\n*.pyc\nbrowser/x.js\n");
    mkdirSync(join(engine, "browser", "branding", "vimma"), { recursive: true });
    writeFileSync(join(engine, "browser", "branding", "vimma", "a.txt"), "gen\n");
    mkdirSync(join(engine, "browser", "config", "vimma"), { recursive: true });
    writeFileSync(join(engine, "browser", "config", "vimma", "v.txt"), "0.1.0\n");
    writeFileSync(join(engine, "mozconfig"), "ours\n");
    writeFileSync(join(engine, "mozconfig.artifact"), "ours\n");
    git("add", "browser/moz.build");
    // Upstream-ignored local state, which is not ours to delete.
    writeFileSync(join(engine, "cache.pyc"), "\n");
    mkdirSync(join(engine, "obj-artifact"));
    writeFileSync(join(engine, "obj-artifact", "x"), "\n");
    return { main, lane, engine };
  }

  it("restores tracked files and removes what the import added", () => {
    const { engine } = importedEngine();
    resetEngine(engine);
    expect(readFileSync(join(engine, "browser", "moz.build"), "utf8")).toBe("upstream\n");
    expect(readFileSync(join(engine, ".gitignore"), "utf8")).not.toContain("browser/x.js");
    expect(existsSync(join(engine, "browser", "branding", "vimma"))).toBe(false);
    expect(existsSync(join(engine, "browser", "config"))).toBe(false);
    expect(existsSync(join(engine, "mozconfig"))).toBe(false);
    expect(existsSync(join(engine, "mozconfig.artifact"))).toBe(false);
    const status = execFileSync("git", ["-C", engine, "status", "--porcelain"], {
      encoding: "utf8",
    });
    expect(status).toBe("");
  });

  it("keeps files upstream's .gitignore ignores", () => {
    const { engine } = importedEngine();
    resetEngine(engine);
    expect(existsSync(join(engine, "cache.pyc"))).toBe(true);
    expect(existsSync(join(engine, "obj-artifact", "x"))).toBe(true);
  });
});

describe("teardownTarget", () => {
  it("is the worktree's engine/", () => {
    const { main, lane } = fakeCheckouts();
    mkdirSync(join(lane, "engine"));
    expect(teardownTarget(lane, main)).toBe(join(lane, "engine"));
  });

  it("refuses the main checkout's engine", () => {
    const { main } = fakeCheckouts();
    expect(() => teardownTarget(main, main)).toThrow(/main checkout/);
  });

  it("refuses an engine/ that is a symlink (to the main checkout's, say)", () => {
    const { main, lane, engine } = fakeCheckouts();
    symlinkSync(engine, join(lane, "engine"));
    expect(() => teardownTarget(lane, main)).toThrow(/symlink/);
  });

  it("refuses when there is no engine/", () => {
    const { main, lane } = fakeCheckouts();
    expect(() => teardownTarget(lane, main)).toThrow(/no engine/);
  });

  it("says so when the main checkout has no engine/", () => {
    const { main, lane, engine } = fakeCheckouts();
    mkdirSync(join(lane, "engine"));
    rmSync(engine, { recursive: true });
    expect(() => teardownTarget(lane, main)).toThrow(/main checkout .* has no engine/);
  });
});

describe("review follow-ups", () => {
  /** A real git repo at `dir` with one commit; returns a git runner with a clean env. */
  function gitRepo(/** @type {string} */ dir) {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
    );
    const git = (/** @type {string[]} */ ...args) =>
      execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x");
    return git;
  }

  /** The lane engine as a real repo with one patched, staged file. */
  function laneRepo() {
    const { main, lane } = fakeCheckouts();
    const engine = join(lane, "engine");
    mkdirSync(engine);
    const git = gitRepo(engine);
    writeFileSync(join(engine, "f"), "upstream\n");
    git("add", "f");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "f");
    writeFileSync(join(engine, "f"), "patched\n");
    git("add", "f");
    return { main, lane, engine };
  }

  it("resetEngine ignores GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE pointing at main", () => {
    const { main, engine } = laneRepo();
    const mainGit = gitRepo(main);
    writeFileSync(join(main, "staged.txt"), "x\n");
    mainGit("add", "staged.txt");
    const saved = { ...process.env };
    process.env.GIT_DIR = join(main, ".git");
    process.env.GIT_WORK_TREE = main;
    process.env.GIT_INDEX_FILE = join(main, ".git", "index");
    try {
      resetEngine(engine);
    } finally {
      for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
    expect(readFileSync(join(engine, "f"), "utf8")).toBe("upstream\n");
    expect(mainGit("diff", "--cached", "--name-only")).toBe("staged.txt\n");
  });

  it("resetEngine refuses an engine/ with no .git inside a bigger work tree", () => {
    const { main, lane } = fakeCheckouts();
    const mainGit = gitRepo(main);
    writeFileSync(join(main, "staged.txt"), "x\n");
    mainGit("add", "staged.txt");
    const engine = join(lane, "engine");
    mkdirSync(engine);
    writeFileSync(join(engine, "f"), "\n");
    expect(() => resetEngine(engine)).toThrow(/not the top of its own git repo/);
    expect(mainGit("diff", "--cached", "--name-only")).toBe("staged.txt\n");
    expect(existsSync(join(engine, "f"))).toBe(true);
  });

  it("copyEngine drops lock files copied from the source's .git, in the lane only", async () => {
    const { lane, engine } = fakeCheckouts();
    mkdirSync(join(engine, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(engine, ".git", "index.lock"), "");
    writeFileSync(join(engine, ".git", "refs", "heads", "vimma.lock"), "");
    const dest = join(lane, "engine");
    const { locks } = await copyEngine(engine, dest, { allowCopy: true });
    expect(locks.sort()).toEqual(
      [join(dest, ".git", "index.lock"), join(dest, ".git", "refs", "heads", "vimma.lock")].sort(),
    );
    expect(existsSync(join(dest, ".git", "index.lock"))).toBe(false);
    expect(existsSync(join(dest, ".git", "HEAD"))).toBe(true);
    expect(existsSync(join(engine, ".git", "index.lock"))).toBe(true);
    expect(existsSync(join(engine, ".git", "refs", "heads", "vimma.lock"))).toBe(true);
  });

  it("copyEngine: of two setups in one worktree, one fails cleanly", async () => {
    const { lane, engine } = fakeCheckouts();
    const dest = join(lane, "engine");
    const results = await Promise.allSettled([
      copyEngine(engine, dest, fakeCp()),
      copyEngine(engine, dest, fakeCp()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected");
    expect(String(failed?.status === "rejected" && failed.reason)).toMatch(/already exists/);
  });

  it("copyEngine refuses a lane engine/ that is a symlink", async () => {
    const { main, lane, engine } = fakeCheckouts();
    symlinkSync(join(main, "elsewhere"), join(lane, "engine"));
    await expect(copyEngine(engine, join(lane, "engine"), fakeCp())).rejects.toThrow(
      /already exists/,
    );
  });

  it("removeForeignLinks refuses a lane engine/ that is a symlink to the main engine", () => {
    const { main, lane, engine } = fakeCheckouts();
    symlinkSync(engine, join(lane, "engine"));
    expect(() => removeForeignLinks(join(lane, "engine"), main, lane)).toThrow(/not inside/);
    expect(lstatSync(join(engine, "browser/base/ours.js")).isSymbolicLink()).toBe(true);
  });

  it("works on a lane reached through a symlinked path component", async () => {
    const { base, main, engine } = fakeCheckouts();
    symlinkSync(main, join(base, "alias"));
    const lane = join(base, "alias", ".claude", "worktrees", "agent-x");
    const dest = join(lane, "engine");
    expect(() => assertLane(lane, main)).not.toThrow();
    await copyEngine(engine, dest, { allowCopy: true });
    expect(removeForeignLinks(dest, main, lane)).toHaveLength(2);
    expect(foreignLinks(dest, main, lane)).toEqual([]);
  });

  it("finds and removes links into both a non-default source and the main checkout", async () => {
    const { base, main, lane, engine } = fakeCheckouts();
    // Another worktree used as --source, whose engine also kept links into main.
    const other = join(base, "other");
    mkdirSync(join(other, "src"), { recursive: true });
    writeFileSync(join(other, "src", "o.js"), "o\n");
    const srcEngine = join(other, "engine");
    await copyEngine(engine, srcEngine, { allowCopy: true });
    symlinkSync(join(other, "src", "o.js"), join(srcEngine, "browser", "base", "o.js"));
    const dest = join(lane, "engine");
    await copyEngine(srcEngine, dest, { allowCopy: true });
    const sources = [other, main];
    expect(foreignLinks(dest, [other], lane)).toEqual([join(dest, "browser/base/o.js")]);
    expect(foreignLinks(dest, sources, lane)).toHaveLength(3);
    expect(removeForeignLinks(dest, sources, lane)).toHaveLength(3);
    expect(foreignLinks(dest, sources, lane)).toEqual([]);
  });
});

describe("parseBtrfsDu", () => {
  it("reads total and exclusive bytes from `btrfs filesystem du -s --raw`", () => {
    const out = [
      "     Total   Exclusive  Set shared  Filename",
      "6227123456   812345678  5414777778  engine",
    ].join("\n");
    expect(parseBtrfsDu(out)).toEqual({ total: 6227123456, exclusive: 812345678 });
  });

  it("throws on anything else", () => {
    expect(() => parseBtrfsDu("ERROR: not a btrfs filesystem")).toThrow(/btrfs/);
  });
});
