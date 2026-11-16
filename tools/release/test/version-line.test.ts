import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { versionLine } from "../version-line.ts";

// Spec firefox-versions, decision 3: the line `vimma --version` prints, written once for scripts.

const surfer = (firefox: unknown, display: unknown) => ({
  version: { product: "firefox", version: firefox },
  brands: { vimma: { release: { displayVersion: display } } },
});

describe("versionLine", () => {
  it('versionLine gives "Vimma 0.5.2 · Firefox 158.0" from surfer.json', () => {
    expect(versionLine(surfer("158.0", "0.5.2"))).toBe("Vimma 0.5.2 · Firefox 158.0");
    expect(versionLine(surfer("157.0.1", "0.1.0"))).toBe("Vimma 0.1.0 · Firefox 157.0.1");
  });

  it("versionLine throws on a missing or non-SemVer display version or a malformed Firefox version", () => {
    expect(() => versionLine(surfer("158.0", undefined))).toThrow(/displayVersion/);
    expect(() => versionLine(surfer("158.0", "0.5"))).toThrow(/displayVersion/);
    expect(() => versionLine(surfer("158.0", 5))).toThrow(/displayVersion/);
    expect(() => versionLine(surfer(undefined, "0.5.2"))).toThrow(/version\.version/);
    expect(() => versionLine(surfer("158", "0.5.2"))).toThrow(/version\.version/);
    expect(() => versionLine(surfer("158.0 ", "0.5.2"))).toThrow(/version\.version/);
    expect(() => versionLine({ version: { version: "158.0" } })).toThrow(/brands\.vimma/);
  });

  it("prints the line for this checkout's surfer.json when run as a script", () => {
    const root = new URL("../../../", import.meta.url);
    const config = JSON.parse(readFileSync(new URL("surfer.json", root), "utf8"));
    const res = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("tools/release/version-line.ts", root))],
      { cwd: fileURLToPath(root), encoding: "utf8" },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(`${versionLine(config)}\n`);
  });
});
