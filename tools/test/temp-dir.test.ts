import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isolateTmp, tempDir } from "./temp-dir.mjs";
import guard from "./tmp-guard.ts";

describe("tempDir", () => {
  let failed: string = "";

  it("makes a fresh dir under the OS temp dir with the prefix", () => {
    const dir = tempDir("vimma-tempdir-");
    expect(dirname(dir)).toBe(tmpdir());
    expect(basename(dir).startsWith("vimma-tempdir-")).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it.fails("removes it even when the test fails", () => {
    failed = tempDir("vimma-tempdir-");
    writeFileSync(join(failed, "f"), "x");
    expect(1).toBe(2);
  });

  it("…so the failed test's dir is gone afterwards", () => {
    expect(failed).not.toBe("");
    expect(existsSync(failed)).toBe(false);
  });
});

describe("isolateTmp", () => {
  /** A parent standing in for /tmp, removed by the test itself. */
  const parent = () => tempDir("vimma-isolate-");

  it("points TMPDIR at a fresh run dir and restores it after", () => {
    const env = { TMPDIR: "/before" };
    const where = parent();
    const finish = isolateTmp(env, where);
    const run = env.TMPDIR;
    expect(dirname(run)).toBe(where);
    expect(existsSync(run)).toBe(true);
    expect(finish()).toEqual([]);
    expect(env.TMPDIR).toBe("/before");
    expect(existsSync(run)).toBe(false);
  });

  it("unsets TMPDIR again when it was not set", () => {
    const env: Record<string, string | undefined> = {};
    const finish = isolateTmp(env, parent());
    expect(env.TMPDIR).toBeDefined();
    finish();
    expect("TMPDIR" in env).toBe(false);
  });

  it("reports what a run left behind, and removes it anyway", () => {
    const env = {};
    const finish = isolateTmp(env, parent());
    const run = (env as any).TMPDIR as string;
    mkdirSync(join(run, "vimma-lanes-abc123", "main"), { recursive: true });
    writeFileSync(join(run, "stray"), "x");
    expect(finish()).toEqual(["stray", "vimma-lanes-abc123"]);
    expect(existsSync(run)).toBe(false);
  });
});

function restore(saved: string | undefined) {
  if (saved === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = saved;
}

describe("the vitest global setup", () => {
  it("fails the run with the leaked names, and still cleans up", () => {
    const saved = process.env.TMPDIR;
    const outer = mkdtempSync(join(tmpdir(), "vimma-guard-"));
    process.env.TMPDIR = outer;
    try {
      const teardown = guard();
      const run = process.env.TMPDIR as string;
      expect(dirname(run)).toBe(outer);
      mkdirSync(join(run, "vimma-out-x1y2z3"));
      expect(() => teardown()).toThrow(/left 1 entry .*vimma-out-x1y2z3/);
      expect(process.env.TMPDIR).toBe(outer);
      expect(existsSync(run)).toBe(false);
    } finally {
      restore(saved);
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it("does not count Node's compile cache as a leak", () => {
    const saved = process.env.TMPDIR;
    const outer = mkdtempSync(join(tmpdir(), "vimma-guard-"));
    process.env.TMPDIR = outer;
    try {
      const teardown = guard();
      mkdirSync(join(process.env.TMPDIR as string, "node-compile-cache"));
      expect(() => teardown()).not.toThrow();
    } finally {
      restore(saved);
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it("passes a clean run", () => {
    const saved = process.env.TMPDIR;
    const outer = mkdtempSync(join(tmpdir(), "vimma-guard-"));
    process.env.TMPDIR = outer;
    try {
      const teardown = guard();
      expect(() => teardown()).not.toThrow();
    } finally {
      restore(saved);
      rmSync(outer, { recursive: true, force: true });
    }
  });
});
