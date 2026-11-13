import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPatches, patchedFiles, restorePatched } from "../restore-patched.mjs";
import { tempDir } from "../../test/temp-dir.mjs";

const modify = `--- a/browser/base/moz.build
+++ b/browser/base/moz.build
@@ -1 +1,2 @@
 a
+b
`;

describe("patchedFiles", () => {
  it("takes the target of each +++ b/ line", () => {
    expect(patchedFiles(modify)).toEqual(["browser/base/moz.build"]);
  });

  it("keeps several files of one patch, in order, once each", () => {
    const two = `${modify}--- a/toolkit/x.sys.mjs\n+++ b/toolkit/x.sys.mjs\n@@ -1 +1 @@\n-a\n+b\n`;
    expect(patchedFiles(two + modify)).toEqual(["browser/base/moz.build", "toolkit/x.sys.mjs"]);
  });

  it("strips a trailing timestamp after a tab", () => {
    const stamped = "--- a/x.js\t2026-01-01\n+++ b/x.js\t2026-01-01 00:00:00\n";
    expect(patchedFiles(stamped)).toEqual(["x.js"]);
  });

  it("skips a file the patch creates: upstream has nothing to restore", () => {
    expect(patchedFiles("--- /dev/null\n+++ b/new/file.js\n@@ -0,0 +1 @@\n+a\n")).toEqual([]);
  });

  it("skips a deleted file's /dev/null target", () => {
    expect(patchedFiles("--- a/gone.js\n+++ /dev/null\n")).toEqual([]);
  });

  it("does not take an added line that happens to read +++ b/", () => {
    // Inside a hunk, "--- a/x" then "+++ b/x" are the removed line "-- a/x" and the added
    // line "++ b/x": only a header pair outside a hunk counts.
    const tricky = `--- a/browser/base/moz.build\n+++ b/browser/base/moz.build\n@@ -1,2 +1,2 @@\n a\n--- a/not/a/header\n+++ b/not/a/header\n`;
    expect(patchedFiles(tricky)).toEqual(["browser/base/moz.build"]);
  });

  it("refuses a path that leaves the engine", () => {
    expect(() => patchedFiles("--- a/../etc/passwd\n+++ b/../etc/passwd\n")).toThrow(/outside/);
    expect(() => patchedFiles("--- a//etc/passwd\n+++ b//etc/passwd\n")).toThrow(/outside/);
  });
});

describe("findPatches", () => {
  it("finds .patch files under src/, sorted, and ignores other files", () => {
    const src = tempDir("vimma-restore-");
    mkdirSync(join(src, "browser/base"), { recursive: true });
    writeFileSync(join(src, "browser/base/moz-build.patch"), modify);
    writeFileSync(join(src, "browser/a.patch"), modify);
    writeFileSync(join(src, "browser/base/x.js"), "");
    expect(findPatches(src).map((p) => p.slice(src.length + 1))).toEqual([
      "browser/a.patch",
      "browser/base/moz-build.patch",
    ]);
  });
});

/**
 * @param {string} dir
 * @param {string[]} args
 */
const git = (dir, ...args) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: dir },
  });

function fixture() {
  const root = tempDir("vimma-restore-");
  const engine = join(root, "engine");
  mkdirSync(join(engine, "browser/base"), { recursive: true });
  mkdirSync(join(root, "src/browser/base"), { recursive: true });
  writeFileSync(join(engine, "browser/base/moz.build"), "a\n");
  writeFileSync(join(engine, "untouched.js"), "upstream\n");
  git(engine, "init", "-q");
  git(engine, "add", ".");
  git(engine, "commit", "-qm", "upstream");
  // What an earlier import left: the old patch applied, and an unrelated local change.
  writeFileSync(join(engine, "browser/base/moz.build"), "a\nold\n");
  writeFileSync(join(engine, "untouched.js"), "local edit\n");
  writeFileSync(join(root, "src/browser/base/moz-build.patch"), modify);
  return { root, engine };
}

describe("restorePatched", () => {
  it("restores exactly the patched files and nothing else", () => {
    const { root, engine } = fixture();
    const result = restorePatched({ src: join(root, "src"), engine });
    expect(result.files).toEqual(["browser/base/moz.build"]);
    expect(readFileSync(join(engine, "browser/base/moz.build"), "utf8")).toBe("a\n");
    expect(readFileSync(join(engine, "untouched.js"), "utf8")).toBe("local edit\n");
  });

  it("changes nothing in dry-run mode, and says what it would run", () => {
    const { root, engine } = fixture();
    const result = restorePatched({ src: join(root, "src"), engine, dryRun: true });
    expect(result.files).toEqual(["browser/base/moz.build"]);
    expect(result.command).toEqual([
      "git",
      "-C",
      engine,
      "checkout",
      "--",
      "browser/base/moz.build",
    ]);
    expect(readFileSync(join(engine, "browser/base/moz.build"), "utf8")).toBe("a\nold\n");
  });

  it("does nothing without an engine/ (before surfer download)", () => {
    const { root } = fixture();
    const result = restorePatched({ src: join(root, "src"), engine: join(root, "nope") });
    expect(result.skipped).toMatch(/no engine/);
    expect(result.files).toEqual([]);
  });

  it("leaves out a patched file upstream does not track, without failing", () => {
    const { root, engine } = fixture();
    writeFileSync(
      join(root, "src/browser/new.patch"),
      "--- a/browser/missing.js\n+++ b/browser/missing.js\n",
    );
    const result = restorePatched({ src: join(root, "src"), engine });
    expect(result.files).toEqual(["browser/base/moz.build"]);
    expect(result.untracked).toEqual(["browser/missing.js"]);
  });
});
