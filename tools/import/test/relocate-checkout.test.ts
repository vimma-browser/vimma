import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { relocate, replacePath } from "../relocate-checkout.mjs";
import { tempDir } from "../../test/temp-dir.mjs";

describe("replacePath", () => {
  it("rewrites the old checkout path and what lies under it", () => {
    expect(replacePath("a /old/repo/engine b /old/repo\n", "/old/repo", "/new/vimma")).toBe(
      "a /new/vimma/engine b /new/vimma\n",
    );
  });

  it("leaves a longer path that only starts with the old one", () => {
    expect(replacePath("/old/repo2/x /old/repo-b /old/repo.c", "/old/repo", "/n")).toBe(
      "/old/repo2/x /old/repo-b /old/repo.c",
    );
  });

  it("treats the old path literally, not as a pattern", () => {
    expect(replacePath("/a.b/x /aXb/x", "/a.b", "/n")).toBe("/n/x /aXb/x");
  });
});

function tree() {
  const base = tempDir("vimma-relocate-");
  const from = join(base, "VimHerdr");
  const to = join(base, "vimma");
  const engine = join(to, "engine");
  const obj = join(engine, "obj-x86_64-pc-linux-gnu");
  mkdirSync(join(engine, "browser/base/content/vimma"), { recursive: true });
  mkdirSync(join(obj, "dist/bin"), { recursive: true });
  mkdirSync(join(obj, "build"), { recursive: true });
  mkdirSync(join(to, "src"), { recursive: true });
  // surfer import's absolute links into src/, one into an unrelated place, one relative.
  symlinkSync(`${from}/src/a.mjs`, join(engine, "browser/base/content/vimma/a.mjs"));
  symlinkSync("/usr/lib/libc.so.6", join(engine, "libc"));
  symlinkSync("../moz.build", join(engine, "browser/base/rel"));
  symlinkSync(`${from}/engine/obj-x86_64-pc-linux-gnu/x`, join(obj, "dist/bin/x"));
  // objdir text with the old path, a binary carrying it, dist text, and upstream source.
  writeFileSync(join(obj, "build/deps.mk"), `x: ${from}/engine/a.cpp ${from}2/b\n`);
  writeFileSync(join(obj, "build/lib.so"), Buffer.from(`\0ELF${from}/engine\0`));
  writeFileSync(join(obj, "dist/bin/platform.ini"), `${from}/engine\n`);
  writeFileSync(join(engine, "README"), `${from}\n`);
  return { from, to, engine, obj };
}

describe("relocate", () => {
  it("retargets absolute links into the old checkout and rewrites objdir text", () => {
    const { from, to, engine, obj } = tree();
    const r = relocate({ root: to, from });
    expect(r.links).toBe(2);
    expect(r.files).toBe(1);
    expect(readlinkSync(join(engine, "browser/base/content/vimma/a.mjs"))).toBe(`${to}/src/a.mjs`);
    expect(readlinkSync(join(obj, "dist/bin/x"))).toBe(`${to}/engine/obj-x86_64-pc-linux-gnu/x`);
    expect(readlinkSync(join(engine, "libc"))).toBe("/usr/lib/libc.so.6");
    expect(readlinkSync(join(engine, "browser/base/rel"))).toBe("../moz.build");
    expect(readFileSync(join(obj, "build/deps.mk"), "utf8")).toBe(
      `x: ${to}/engine/a.cpp ${from}2/b\n`,
    );
  });

  it("leaves binaries, dist/ and files outside the objdirs", () => {
    const { from, to, engine, obj } = tree();
    relocate({ root: to, from });
    expect(readFileSync(join(obj, "build/lib.so"), "latin1")).toContain(from);
    expect(readFileSync(join(obj, "dist/bin/platform.ini"), "utf8")).toBe(`${from}/engine\n`);
    expect(readFileSync(join(engine, "README"), "utf8")).toBe(`${from}\n`);
  });

  it("counts but changes nothing in dry-run mode", () => {
    const { from, to, engine, obj } = tree();
    const r = relocate({ root: to, from, dryRun: true });
    expect(r).toMatchObject({ links: 2, files: 1 });
    expect(readlinkSync(join(engine, "browser/base/content/vimma/a.mjs"))).toBe(
      `${from}/src/a.mjs`,
    );
    expect(readFileSync(join(obj, "build/deps.mk"), "utf8")).toContain(`${from}/engine/a.cpp`);
  });

  it("refuses relative paths and a move onto itself", () => {
    const { to } = tree();
    expect(() => relocate({ root: to, from: "repositories/VimHerdr" })).toThrow(/absolute/);
    expect(() => relocate({ root: to, from: to })).toThrow(/same/);
  });

  it("is a no-op on a second run", () => {
    const { from, to } = tree();
    relocate({ root: to, from });
    expect(relocate({ root: to, from })).toMatchObject({ links: 0, files: 0 });
  });
});
