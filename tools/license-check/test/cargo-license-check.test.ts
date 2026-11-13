import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CRATE_MANIFESTS,
  checkCargoMetadata,
  normaliseCargoLicense,
} from "../cargo-license-check.mjs";
import { tempDir } from "../../test/temp-dir.mjs";

const script = fileURLToPath(new URL("../cargo-license-check.mjs", import.meta.url));

/** @param {Array<{ name: string, version: string, license?: string | null }>} packages */
const metadata = (packages) => ({
  packages: packages.map((p) => ({ license: null, ...p })),
});

describe("normaliseCargoLicense", () => {
  it("turns the legacy slash form into OR", () => {
    expect(normaliseCargoLicense("MIT/Apache-2.0")).toBe("MIT OR Apache-2.0");
    expect(normaliseCargoLicense("MIT / Apache-2.0")).toBe("MIT OR Apache-2.0");
  });

  it("leaves SPDX expressions and null alone", () => {
    expect(normaliseCargoLicense("MIT OR Apache-2.0")).toBe("MIT OR Apache-2.0");
    expect(normaliseCargoLicense(null)).toBe(null);
  });
});

describe("checkCargoMetadata", () => {
  it("passes crates under allowed licences, including our own MPL-2.0", () => {
    const result = checkCargoMetadata(
      metadata([
        { name: "vimma-ctl", version: "0.1.0", license: "MPL-2.0" },
        { name: "a", version: "1.0.0", license: "MIT OR Apache-2.0" },
        { name: "b", version: "1.0.0", license: "MIT/Apache-2.0" },
        { name: "c", version: "1.0.0", license: "Apache-2.0 OR BSL-1.0" },
      ]),
    );
    expect(result).toEqual({ violations: [], unusedExceptions: [] });
  });

  it("flags copyleft, unknown and missing licences", () => {
    const { violations } = checkCargoMetadata(
      metadata([
        { name: "gpl", version: "1.0.0", license: "GPL-3.0-only" },
        { name: "file-only", version: "2.0.0", license: null },
        { name: "both", version: "1.0.0", license: "MIT AND Unicode-3.0" },
      ]),
    );
    expect(violations).toEqual([
      { name: "gpl", version: "1.0.0", license: "GPL-3.0-only" },
      { name: "file-only", version: "2.0.0", license: null },
      { name: "both", version: "1.0.0", license: "MIT AND Unicode-3.0" },
    ]);
  });

  it("honours an exception for the exact name, version and licence, and reports unused ones", () => {
    const exceptions = {
      "both@1.0.0": { license: "MIT AND Unicode-3.0", reason: "Unicode licence, permissive" },
      "gone@1.0.0": { license: "MIT", reason: "no longer used" },
    };
    const result = checkCargoMetadata(
      metadata([{ name: "both", version: "1.0.0", license: "MIT AND Unicode-3.0" }]),
      { exceptions },
    );
    expect(result).toEqual({ violations: [], unusedExceptions: ["gone@1.0.0"] });
  });
});

describe("CLI", () => {
  const run = (/** @type {object} */ meta) => {
    const dir = tempDir("cargo-license-");
    const file = join(dir, "metadata.json");
    writeFileSync(file, JSON.stringify(meta));
    // No exceptions: the repo's own (cargo-exceptions.json) name real crates, which this
    // metadata leaves out, so they would be reported unused.
    const exceptions = join(dir, "exceptions.json");
    writeFileSync(exceptions, JSON.stringify({ exceptions: {} }));
    return spawnSync(process.execPath, [script, "--metadata", file, "--exceptions", exceptions], {
      encoding: "utf8",
    });
  };

  it("checks the crates the repo builds", () => {
    expect(CRATE_MANIFESTS).toEqual(["tools/vimma-ctl/Cargo.toml"]);
  });

  it("exits 0 for allowed licences", () => {
    const out = run(metadata([{ name: "vimma-ctl", version: "0.1.0", license: "MPL-2.0" }]));
    expect(out.status).toBe(0);
    expect(out.stdout).toBe("cargo-license-check: 1 crate(s), all allowed\n");
  });

  it("exits 1 and names the crate otherwise", () => {
    const out = run(metadata([{ name: "gpl", version: "1.0.0", license: "GPL-3.0-only" }]));
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("cargo-license-check: gpl@1.0.0 has licence GPL-3.0-only");
  });

  it("exits 2 on unreadable input", () => {
    const out = spawnSync(process.execPath, [script, "--metadata", "/nonexistent.json"], {
      encoding: "utf8",
    });
    expect(out.status).toBe(2);
  });
});
