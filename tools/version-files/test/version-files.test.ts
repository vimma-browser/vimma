import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  patchManifest,
  versionFiles,
  writePatchManifest,
  writeVersionFiles,
} from "../version-files.mjs";
import { tempDir } from "../../test/temp-dir.mjs";

/**
 * configure (`milestone()`) reads only the last line, as with config/milestone.txt.
 * @param {string} file
 */
const lastLine = (file) => file.trimEnd().split("\n").at(-1);

/**
 * @param {string | undefined} firefox
 * @param {string | undefined} display
 */
const surfer = (firefox, display) => ({
  version: { product: "firefox", version: firefox },
  brands: { vimma: { release: { displayVersion: display } } },
});

describe("versionFiles", () => {
  it("puts the Firefox version in version.txt and Vimma's in version_display.txt", () => {
    const files = versionFiles(surfer("157.0.1", "0.1.0"));
    expect(Object.keys(files).sort()).toEqual(["version.txt", "version_display.txt"]);
    expect(lastLine(files["version.txt"])).toBe("157.0.1");
    expect(lastLine(files["version_display.txt"])).toBe("0.1.0");
  });

  it("starts each file with the MPL header as # comments (surfer license-check)", () => {
    for (const file of Object.values(versionFiles(surfer("157.0.1", "0.1.0")))) {
      const head = file.split("\n").slice(0, 5);
      expect(head.slice(0, 3).every((l) => l.startsWith("# "))).toBe(true);
      expect(head.join("\n")).toContain("http://mozilla.org/MPL/2.0/");
      expect(file.endsWith("\n")).toBe(true);
    }
  });

  it("accepts a two-part Firefox version and a pre-release display version", () => {
    const files = versionFiles(surfer("158.0", "0.2.0-nightly.20261009"));
    expect(lastLine(files["version.txt"])).toBe("158.0");
    expect(lastLine(files["version_display.txt"])).toBe("0.2.0-nightly.20261009");
  });

  it("a beta pin writes 159.0 to version.txt", () => {
    // Mozilla's own Beta tree has 159.0 there (159.0b1 only in version_display.txt), and
    // browser_vimma_app_version.js expects appinfo.version to equal platformVersion.
    const files = versionFiles(surfer("159.0b1", "0.1.0"));
    expect(lastLine(files["version.txt"])).toBe("159.0");
    expect(lastLine(files["version_display.txt"])).toBe("0.1.0");
  });

  it("reads the named brand", () => {
    const config = surfer("157.0.1", "0.1.0");
    config.brands = { ...config.brands, other: { release: { displayVersion: "2.0.0" } } };
    expect(lastLine(versionFiles(config, "other")["version_display.txt"])).toBe("2.0.0");
  });

  it.each([
    ["a missing Firefox version", undefined, "0.1.0", /version\.version/],
    ["a malformed Firefox version", "157.0.1\n", "0.1.0", /version\.version/],
    ["a missing display version", "157.0.1", undefined, /displayVersion/],
    ["a display version that is not semver", "157.0.1", "0.1", /displayVersion/],
  ])("throws on %s", (_name, firefox, display, message) => {
    expect(() => versionFiles(surfer(firefox, display))).toThrow(message);
  });

  it("throws when the brand is missing", () => {
    expect(() => versionFiles(surfer("157.0.1", "0.1.0"), "nope")).toThrow(/brands\.nope/);
  });
});

describe("writeVersionFiles", () => {
  it("writes both files into the directory, creating it", () => {
    const dir = join(tempDir("vimma-version-"), "browser/config/vimma");
    expect(writeVersionFiles(surfer("157.0.1", "0.1.0"), dir)).toEqual({
      firefox: "157.0.1",
      display: "0.1.0",
    });
    expect(lastLine(readFileSync(join(dir, "version.txt"), "utf8"))).toBe("157.0.1");
    expect(lastLine(readFileSync(join(dir, "version_display.txt"), "utf8"))).toBe("0.1.0");
  });
});

describe("patchManifest", () => {
  /** A tree with two patches (one nested) and a file that is not one. */
  function tree() {
    const root = tempDir("vimma-patches-");
    /** @param {number} n */
    const hunk = (n) => `@@ -${n},1 +${n},2 @@\n line\n+added\n`;
    mkdirSync(join(root, "src/browser/base"), { recursive: true });
    writeFileSync(
      join(root, "src/browser/base/b.patch"),
      `diff --git a/x b/x\n--- a/x\n+++ b/x\n${hunk(1)}${hunk(9)}`,
    );
    writeFileSync(join(root, "src/a.patch"), `diff --git a/y b/y\n--- a/y\n+++ b/y\n${hunk(3)}`);
    writeFileSync(join(root, "src/notes.txt"), "@@ not a patch @@\n");
    return root;
  }

  it("lists every src/**/*.patch, sorted, with its hunk count", () => {
    expect(patchManifest(tree())).toEqual({
      patches: [
        { path: "src/a.patch", hunks: 1 },
        { path: "src/browser/base/b.patch", hunks: 2 },
      ],
      hunks: 3,
    });
  });

  it("counts the repository's own patches", () => {
    const m = patchManifest(fileURLToPath(new URL("../../../", import.meta.url)));
    expect(m.patches.length).toBeGreaterThan(0);
    expect(m.patches.every((p) => p.path.startsWith("src/") && p.hunks > 0)).toBe(true);
  });

  it("writes patches.json into the directory", () => {
    const root = tree();
    const dir = join(root, "out");
    writePatchManifest(root, dir);
    expect(JSON.parse(readFileSync(join(dir, "patches.json"), "utf8")).patches).toHaveLength(2);
  });
});
