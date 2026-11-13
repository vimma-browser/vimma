// The fonts the e2e browser renders with (issue #944): the vendored DejaVu faces, pinned by
// SHA-256 in tests/e2e/fonts/README.md, and a fontconfig file that offers nothing else.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { E2E_FONTCONFIG, E2E_FONTS } from "../launcher.mjs";
import { defined } from "../../test/defined.ts";

/** @returns {Map<string, string>} file name → SHA-256, from the README's table */
const listedSums = () => {
  const readme = readFileSync(join(E2E_FONTS, "README.md"), "utf8");
  const rows = [...readme.matchAll(/^\| `([^`]+\.ttf)` .*\| `([0-9a-f]{64})` \|$/gm)];
  return new Map(rows.map((m) => [defined(m[1]), defined(m[2])]));
};

describe("vendored e2e fonts", () => {
  it("lists every font file with the SHA-256 it has", () => {
    const files = readdirSync(E2E_FONTS).filter((f) => f.endsWith(".ttf"));
    const sums = listedSums();
    expect(files.length).toBeGreaterThan(0);
    expect([...sums.keys()].sort()).toEqual(files.sort());
    for (const f of files) {
      const sum = createHash("sha256")
        .update(readFileSync(join(E2E_FONTS, f)))
        .digest("hex");
      expect(sum, f).toBe(sums.get(f));
    }
  });

  it("ships the fonts' licences beside them", () => {
    expect(readFileSync(join(E2E_FONTS, "DejaVu-LICENSE"), "utf8")).toContain("Bitstream Vera");
    expect(readFileSync(join(E2E_FONTS, "Liberation-LICENSE"), "utf8")).toContain(
      "SIL OPEN FONT LICENSE Version 1.1",
    );
  });
});

/** @returns {boolean} */
const haveFcMatch = () => {
  try {
    execFileSync("fc-match", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
// fontconfig's tools come with the fontconfig library the browser itself links; CI's e2e job
// (E2E_REQUIRE_XVFB=1) must not skip these.
const fc = haveFcMatch() || process.env.E2E_REQUIRE_XVFB === "1";

describe.skipIf(!fc)(
  `fontconfig file the browser gets${fc ? "" : " (skipped: no fc-match)"}`,
  () => {
    const home = mkdtempSync(join(tmpdir(), "vimma-fonts-test-"));
    afterAll(() => rmSync(home, { recursive: true, force: true }));
    // The browser's env (launcher.mjs, browserEnv): HOME in a temp folder, so no user config.
    const env = { PATH: process.env.PATH ?? "", HOME: home, FONTCONFIG_FILE: E2E_FONTCONFIG };
    /** @param {string} tool @param {string[]} args */
    const run = (tool, args) => execFileSync(tool, args, { env, encoding: "utf8" });

    it.each([
      ["monospace", "DejaVu Sans Mono", "DejaVuSansMono.ttf"],
      ["monospace:bold", "DejaVu Sans Mono", "DejaVuSansMono-Bold.ttf"],
      ["sans-serif", "DejaVu Sans", "DejaVuSans.ttf"],
      ["sans-serif:bold", "DejaVu Sans", "DejaVuSans-Bold.ttf"],
      ["serif", "DejaVu Serif", "DejaVuSerif.ttf"],
      ["serif:bold", "DejaVu Serif", "DejaVuSerif-Bold.ttf"],
      ["system-ui", "DejaVu Sans", "DejaVuSans.ttf"],
      ["Sans", "DejaVu Sans", "DejaVuSans.ttf"],
      ["JetBrainsMono Nerd Font", "DejaVu Sans", "DejaVuSans.ttf"],
      ["Helvetica", "Liberation Sans", "LiberationSans-Regular.ttf"],
      ["Arial", "Liberation Sans", "LiberationSans-Regular.ttf"],
    ])("resolves %s to %s", (pattern, family, file) => {
      const out = run("fc-match", ["-f", "%{family[0]}|%{file}", pattern]);
      expect(out).toBe(`${family}|${join(E2E_FONTS, file)}`);
    });

    it("offers no font outside the vendored folder", () => {
      const files = run("fc-list", ["-f", "%{file}\n"]).trim().split("\n").sort();
      expect(files).toEqual(
        readdirSync(E2E_FONTS)
          .filter((f) => f.endsWith(".ttf"))
          .map((f) => join(E2E_FONTS, f))
          .sort(),
      );
    });

    // CI's ubuntu-24.04 fontconfig-config: hintslight, antialias, rgb sub-pixel order and the
    // default LCD filter (its conf.d links 10-hinting-slight, 10-yes-antialias, 10-sub-pixel-rgb
    // and 11-lcdfilter-default).
    it("renders as CI's Ubuntu does: slight hinting, antialiasing, rgb order, default LCD filter", () => {
      const out = run("fc-match", [
        "-f",
        "%{hintstyle}|%{antialias}|%{hinting}|%{rgba}|%{lcdfilter}",
        "sans-serif",
      ]);
      expect(out).toBe("1|True|True|1|1");
    });
  },
);
