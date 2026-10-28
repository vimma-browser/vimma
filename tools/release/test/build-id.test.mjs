import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIdProblem, fullVersionBuildIds, iniBuildId } from "../build-id.mjs";

// #563: the build ID compiled into a release (what Services.appinfo.appBuildID says) and the one
// in its packaged application.ini (what tools/update/manifest.mjs offers) must be the same, or
// the release offers itself to itself as an update.

const SCRIPT = fileURLToPath(new URL("../build-id.mjs", import.meta.url));
const INI = (id) =>
  `; This file is not used.\n[App]\nVendor=Vimma\nName=Vimma\nVersion=159.0\nBuildID=${id}\n` +
  `[Gecko]\nMinVersion=159.0\n`;

describe("build IDs", () => {
  it("reads the app and platform build IDs from --full-version", () => {
    expect(fullVersionBuildIds("Vimma Vimma 0.1.10 20261027202113 20261027202113 \n")).toEqual({
      app: "20261027202113",
      platform: "20261027202113",
    });
    expect(fullVersionBuildIds("Vimma 0.1.10 · Firefox 159.0")).toBeNull();
  });

  it("reads [App] BuildID from application.ini, not another section's", () => {
    expect(iniBuildId(INI("20261027213312"))).toBe("20261027213312");
    expect(iniBuildId("[Build]\nBuildID=20261027213312\n")).toBeNull();
    expect(iniBuildId("[App]\nBuildID=soon\n")).toBeNull();
  });

  it("a packaged build ID that differs from the binary's is a problem", () => {
    const line = "Vimma Vimma 0.1.10 20261027202113 20261027202113";
    expect(buildIdProblem(line, INI("20261027202113"))).toBeNull();
    expect(buildIdProblem(line, INI("20261027213312"))).toBe(
      "application.ini has BuildID 20261027213312, the binary 20261027202113",
    );
    expect(
      buildIdProblem("Vimma Vimma 0.1.10 20261027202113 20261027213312", INI("20261027202113")),
    ).toBe(
      "the binary's platform build ID 20261027213312 differs from its app build ID 20261027202113",
    );
    expect(buildIdProblem("nothing", INI("20261027202113"))).toMatch(/--full-version/);
    expect(buildIdProblem(line, "[App]\n")).toMatch(/application\.ini/);
  });

  it("the command runs the binary and fails on a mismatch", () => {
    const dir = mkdtempSync(join(tmpdir(), "vimma-build-id-"));
    try {
      const bin = join(dir, "vimma");
      writeFileSync(
        bin,
        '#!/bin/sh\n[ "$1" = --full-version ] && echo "Vimma Vimma 0.1.10 20261027202113 20261027202113"\n',
      );
      chmodSync(bin, 0o755);
      const run = (/** @type {string} */ id) => {
        writeFileSync(join(dir, "application.ini"), INI(id));
        return spawnSync(
          process.execPath,
          [SCRIPT, "--binary", bin, "--ini", join(dir, "application.ini")],
          { encoding: "utf8" },
        );
      };
      const ok = run("20261027202113");
      expect(ok.status).toBe(0);
      expect(ok.stdout).toBe("build-id=20261027202113\n");
      const bad = run("20261027213312");
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain(
        "::error::application.ini has BuildID 20261027213312, the binary 20261027202113",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
