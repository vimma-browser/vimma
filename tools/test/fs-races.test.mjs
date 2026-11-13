// The tools' check-then-use windows (CodeQL js/file-system-race): a file that changes between a
// tool's check and its use must not get past the check. Each case changes the file right before
// the tool's first read, write or open of it (fs-race.mjs).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeUse, fired } from "./fs-race.mjs";
import { prepareProfile } from "../start.mjs";
import { waitForDiscovery } from "../e2e/launcher.mjs";
import { relocate } from "../import/relocate-checkout.ts";
import { checkFile } from "../security/check-doc-links.ts";

vi.mock("node:fs", async (original) =>
  (await import("./fs-race.mjs")).racyFs(/** @type {any} */ (await original())),
);

/** @type {string[]} */
const dirs = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "vimma-race-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("check-then-use races", () => {
  it("start: a user.js that appears after the check is merged, not overwritten", () => {
    const profile = tempDir();
    const userJs = join(profile, "user.js");
    beforeUse(userJs, () => writeFileSync(userJs, 'user_pref("browser.startup.page", 3);\n'));
    prepareProfile(profile, [["vimma.test.pref", true]]);
    expect(fired()).toBe(true);
    const js = readFileSync(userJs, "utf8");
    expect(js).toContain('user_pref("browser.startup.page", 3);');
    expect(js).toContain('user_pref("vimma.test.pref", true);');
  });

  it("launcher: a discovery file swapped after its mode check is not trusted", async () => {
    const profile = tempDir();
    const path = join(profile, "vimma-control.json");
    const body = (/** @type {number} */ pid) =>
      JSON.stringify({ protocol: 1, port: 4000, token: "ab".repeat(32), pid });
    writeFileSync(path, body(1), { mode: 0o600 });
    const loose = join(profile, "loose.json");
    writeFileSync(loose, body(2));
    chmodSync(loose, 0o644);
    beforeUse(path, () => renameSync(loose, path));
    await expect(waitForDiscovery(profile, { timeoutMs: 400 })).rejects.toThrow(/mode 644/);
    expect(fired()).toBe(true);
  });

  it("relocate: an objdir file swapped for a symlink is not written through", () => {
    const base = tempDir();
    const from = join(base, "old");
    const obj = join(base, "new", "engine", "obj-x");
    mkdirSync(join(obj, "build"), { recursive: true });
    const outside = join(base, "outside.txt");
    writeFileSync(outside, `${from}/keep\n`);
    const deps = join(obj, "build", "deps.mk");
    writeFileSync(deps, `x: ${from}/a.cpp\n`);
    beforeUse(deps, () => {
      rmSync(deps);
      symlinkSync(outside, deps);
    });
    relocate({ root: join(base, "new"), from });
    expect(fired()).toBe(true);
    expect(lstatSync(deps).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe(`${from}/keep\n`);
  });

  it("check-doc-links: a test file replaced by a directory is reported, not a crash", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "docs"));
    mkdirSync(join(dir, "tests"));
    const test = join(dir, "tests", "a.js");
    writeFileSync(test, "add_task(async function real_task() {});\n");
    writeFileSync(join(dir, "docs", "s.md"), "[`real_task`](../tests/a.js)\n");
    beforeUse(test, () => {
      rmSync(test);
      mkdirSync(test);
    });
    const { problems } = checkFile(join(dir, "docs", "s.md"));
    expect(fired()).toBe(true);
    expect(problems).toEqual([expect.stringMatching(/a\.js is not a file/)]);
  });
});
