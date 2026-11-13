import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { tempDir } from "../../test/temp-dir.mjs";
import {
  D2,
  DIAGRAMS,
  PALETTES,
  checkDiagrams,
  composeSource,
  d2Asset,
  readStamp,
  sourceHash,
  stamp,
  verifyChecksum,
} from "../render.ts";

const ROOT = new URL("../../../", import.meta.url);

describe("the pinned D2", () => {
  test("is a fixed release, with a SHA-256 for each platform contributors use", () => {
    expect(D2.version).toMatch(/^v\d+\.\d+\.\d+$/);
    for (const asset of Object.values(D2.assets)) expect(asset?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d2Asset("linux", "x64")).toEqual({
      name: `d2-${D2.version}-linux-amd64.tar.gz`,
      sha256: D2.assets["linux-amd64"]?.sha256,
      url: `https://github.com/terrastruct/d2/releases/download/${D2.version}/d2-${D2.version}-linux-amd64.tar.gz`,
    });
    expect(d2Asset("darwin", "arm64").name).toBe(`d2-${D2.version}-macos-arm64.tar.gz`);
    expect(() => d2Asset("win32", "x64")).toThrow(/no pinned D2 for win32-x64/);
  });

  test("a download whose checksum differs is refused", () => {
    const bytes = Buffer.from("not d2");
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(() => verifyChecksum(bytes, sha)).not.toThrow();
    expect(() => verifyChecksum(bytes, "0".repeat(64))).toThrow(/checksum mismatch/);
  });

  test("lays out with ELK, which D2 bundles under its own licence, not TALA", () => {
    expect(composeSource("a -> b\n", PALETTES.light)).toMatch(/layout-engine: elk/);
  });
});

describe("composeSource", () => {
  test("appends the palette as vars, so the source's line numbers stay as written", () => {
    const out = composeSource("a: ${text}\n", PALETTES.dark);
    expect(out.startsWith("a: ${text}\n")).toBe(true);
    expect(out).toContain(`text: "${PALETTES.dark.vars.text}"`);
    expect(out).toContain(`theme-id: ${PALETTES.dark.themeId}`);
  });

  test("light and dark use the same variable names", () => {
    expect(Object.keys(PALETTES.dark.vars)).toEqual(Object.keys(PALETTES.light.vars));
    expect(Object.keys(PALETTES.dark.overrides)).toEqual(Object.keys(PALETTES.light.overrides));
  });
});

describe("stamps", () => {
  const svg = `<?xml version="1.0" encoding="utf-8"?><svg xmlns="http://www.w3.org/2000/svg"></svg>`;

  test("the hash covers the source, the palette and the D2 version", () => {
    const base = sourceHash("a -> b\n", "light");
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(sourceHash("a -> b\n", "light")).toBe(base);
    expect(sourceHash("a -> c\n", "light")).not.toBe(base);
    expect(sourceHash("a -> b\n", "dark")).not.toBe(base);
  });

  test("a stamped SVG gives its hash back, and stays one XML document", () => {
    const stamped = stamp(svg, "ab".repeat(32));
    expect(stamped.startsWith(`<?xml version="1.0" encoding="utf-8"?>\n<!-- `)).toBe(true);
    expect(stamped.endsWith("</svg>\n")).toBe(true);
    expect(readStamp(stamped)).toBe("ab".repeat(32));
    expect(readStamp(svg)).toBeNull();
  });
});

describe("checkDiagrams", () => {
  const setup = () => {
    const root = tempDir("vimma-diagrams-");
    mkdirSync(join(root, "docs/assets/diagrams"), { recursive: true });
    const source = "a -> b\n";
    writeFileSync(join(root, "docs/assets/diagrams/x.d2"), source);
    const write = (variant: "light" | "dark", hash: string) =>
      writeFileSync(
        join(root, `docs/assets/diagrams/x-${variant}.svg`),
        stamp("<svg></svg>", hash),
      );
    return { root, source, write };
  };
  const diagrams = [{ name: "x", source: "docs/assets/diagrams/x.d2" }];

  test("passes when each SVG carries the hash of its current source", () => {
    const { root, source, write } = setup();
    write("light", sourceHash(source, "light"));
    write("dark", sourceHash(source, "dark"));
    expect(checkDiagrams(root, diagrams)).toEqual([]);
  });

  test("fails when the source changed after the render, or an SVG is missing", () => {
    const { root, write } = setup();
    write("light", sourceHash("a -> c\n", "light"));
    expect(checkDiagrams(root, diagrams)).toEqual([
      "docs/assets/diagrams/x-light.svg was rendered from another docs/assets/diagrams/x.d2: run npm run diagrams",
      "docs/assets/diagrams/x-dark.svg is missing: run npm run diagrams",
    ]);
  });

  test("the committed SVGs are current", () => {
    expect(checkDiagrams(ROOT.pathname, DIAGRAMS)).toEqual([]);
  });
});

describe("the repository's wiring", () => {
  const pkg = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8"));

  test("npm run diagrams regenerates the module graph, then renders", () => {
    expect(pkg.scripts.diagrams).toBe(
      "node tools/diagrams/module-graph.ts && node tools/diagrams/render.ts",
    );
  });

  test("npm run lint runs the check, which needs no D2", () => {
    expect(pkg.scripts["diagrams:check"]).toBe(
      "node tools/diagrams/module-graph.ts --check && node tools/diagrams/render.ts --check",
    );
    expect(pkg.scripts.lint).toMatch(/&& npm run diagrams:check(?: |$)/);
  });

  test("ARCHITECTURE.md shows each SVG in a picture that follows the colour scheme", () => {
    const md = readFileSync(new URL("ARCHITECTURE.md", ROOT), "utf8");
    for (const { name } of DIAGRAMS) {
      const dark = `docs/assets/diagrams/${name}-dark.svg`;
      const light = `docs/assets/diagrams/${name}-light.svg`;
      expect(md).toContain(`<source media="(prefers-color-scheme: dark)" srcset="${dark}">`);
      expect(md).toContain(`<source media="(prefers-color-scheme: light)" srcset="${light}">`);
      expect(md).toMatch(new RegExp(`<img src="${light}" alt="[^"]{40,}"`));
    }
  });
});
