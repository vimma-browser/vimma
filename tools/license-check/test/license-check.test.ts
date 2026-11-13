import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED, checkLock, packageName, spdxAllowed } from "../license-check.mjs";
import { tempDir } from "../../test/temp-dir.mjs";

const script = fileURLToPath(new URL("../license-check.mjs", import.meta.url));

/** @param {Record<string, object>} packages */
const lock = (packages) => ({
  lockfileVersion: 3,
  packages: { "": { name: "vimma" }, ...packages },
});

describe("spdxAllowed", () => {
  const allow = new Set(["MIT", "Apache-2.0"]);

  it("accepts a single allowed identifier", () => {
    expect(spdxAllowed("MIT", allow)).toBe(true);
  });

  it("rejects a single identifier outside the list", () => {
    expect(spdxAllowed("GPL-3.0-only", allow)).toBe(false);
  });

  it("accepts an OR expression when any branch is allowed", () => {
    expect(spdxAllowed("(MIT OR WTFPL)", allow)).toBe(true);
  });

  it("rejects an AND expression unless every term is allowed", () => {
    expect(spdxAllowed("(MIT AND Zlib)", allow)).toBe(false);
    expect(spdxAllowed("MIT AND Apache-2.0", allow)).toBe(true);
  });

  it("handles nesting", () => {
    expect(spdxAllowed("(GPL-2.0-only OR (MIT AND Apache-2.0))", allow)).toBe(true);
    expect(spdxAllowed("(GPL-2.0-only OR (MIT AND Zlib))", allow)).toBe(false);
  });

  it("rejects missing or garbled licences", () => {
    expect(spdxAllowed(undefined, allow)).toBe(false);
    expect(spdxAllowed("", allow)).toBe(false);
    expect(spdxAllowed("(MIT OR", allow)).toBe(false);
    expect(spdxAllowed("SEE LICENSE IN LICENSE.md", allow)).toBe(false);
  });
});

describe("packageName", () => {
  it("takes the last node_modules segment, scoped or not", () => {
    expect(packageName("node_modules/minimatch")).toBe("minimatch");
    expect(packageName("node_modules/a/node_modules/@scope/b")).toBe("@scope/b");
  });
});

describe("checkLock", () => {
  it("passes when every package is on the allowlist", () => {
    const result = checkLock(
      lock({
        "node_modules/a": { version: "1.0.0", license: "MIT" },
        "node_modules/@s/b": { version: "2.0.0", license: "(BSD-2-Clause OR MIT OR Apache-2.0)" },
      }),
    );
    expect(result).toEqual({ violations: [], unusedExceptions: [] });
  });

  it("reports a disallowed or missing licence with name and version", () => {
    const { violations } = checkLock(
      lock({
        "node_modules/gpl": { version: "1.2.3", license: "GPL-3.0-only" },
        "node_modules/x/node_modules/none": { version: "0.1.0" },
      }),
    );
    expect(violations).toEqual([
      { name: "gpl", version: "1.2.3", license: "GPL-3.0-only" },
      { name: "none", version: "0.1.0", license: null },
    ]);
  });

  it("skips the root, workspace links and workspace sources", () => {
    const { violations } = checkLock(
      lock({
        "node_modules/vimma-core": { resolved: "packages/vimma-core", link: true },
        "packages/vimma-core": { name: "vimma-core", version: "0.0.0" },
      }),
    );
    expect(violations).toEqual([]);
  });

  it("accepts an exception only for the exact name@version it names", () => {
    const exceptions = { "pako@1.0.11": { license: "(MIT AND Zlib)", reason: "permissive" } };
    const ok = checkLock(
      lock({ "node_modules/pako": { version: "1.0.11", license: "(MIT AND Zlib)" } }),
      { exceptions },
    );
    expect(ok.violations).toEqual([]);
    const bumped = checkLock(
      lock({ "node_modules/pako": { version: "2.0.0", license: "(MIT AND Zlib)" } }),
      { exceptions },
    );
    expect(bumped.violations).toHaveLength(1);
    expect(bumped.unusedExceptions).toEqual(["pako@1.0.11"]);
  });

  it("does not let an exception cover a changed licence", () => {
    const exceptions = { "pako@1.0.11": { license: "(MIT AND Zlib)", reason: "permissive" } };
    const { violations } = checkLock(
      lock({ "node_modules/pako": { version: "1.0.11", license: "GPL-3.0-only" } }),
      { exceptions },
    );
    expect(violations).toHaveLength(1);
  });

  it("defaults to the spec allowlist", () => {
    expect([...ALLOWED].sort()).toEqual(
      [
        "Apache-2.0",
        "BSD-2-Clause",
        "BSD-3-Clause",
        "ISC",
        "MIT",
        "MPL-2.0",
        "PSF-2.0",
        "Python-2.0",
      ].sort(),
    );
  });

  it("accepts the PSF licence under its current and former SPDX ids without an exception", () => {
    const { violations } = checkLock(
      lock({
        "node_modules/argparse": { version: "2.0.1", license: "Python-2.0" },
        "node_modules/js-yaml/node_modules/argparse": { version: "3.0.3", license: "PSF-2.0" },
      }),
    );
    expect(violations).toEqual([]);
  });
});

describe("CLI", () => {
  /** @param {object} data */
  function runOn(data) {
    const dir = tempDir("licence-");
    const file = join(dir, "package-lock.json");
    writeFileSync(file, JSON.stringify(data));
    return spawnSync(process.execPath, [script, file, "--exceptions", join(dir, "none.json")], {
      encoding: "utf8",
    });
  }

  it("exits 0 on a clean lock", () => {
    const run = runOn(lock({ "node_modules/a": { version: "1.0.0", license: "ISC" } }));
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("exits 1 and names the offender", () => {
    const run = runOn(lock({ "node_modules/gpl": { version: "1.2.3", license: "GPL-3.0-only" } }));
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/gpl@1\.2\.3.*GPL-3\.0-only/);
  });

  it("passes on the repo's own package-lock.json with its exceptions file", () => {
    const run = spawnSync(process.execPath, [script], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      encoding: "utf8",
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });
});
