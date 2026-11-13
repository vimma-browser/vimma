import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { tempDir } from "../../test/temp-dir.mjs";
import {
  D2,
  DIAGRAMS,
  PALETTES,
  D2_ARGS,
  cachedBinary,
  checkDiagrams,
  composeSource,
  d2Asset,
  d2Binary,
  installD2,
  readStamp,
  renderDiagrams,
  unsafeContent,
  sourceHash,
  stamp,
  verifyChecksum,
} from "../render.ts";

const ROOT = new URL("../../../", import.meta.url);
const ROOT_DIR = fileURLToPath(ROOT);

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

  test("the hash covers the source, the palette, the D2 version and its flags", () => {
    const base = sourceHash("a -> b\n", "light");
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(sourceHash("a -> b\n", "light")).toBe(base);
    expect(sourceHash("a -> c\n", "light")).not.toBe(base);
    expect(sourceHash("a -> b\n", "dark")).not.toBe(base);
    expect(sourceHash("a -> b\n", "light", { version: "v0.0.1", args: D2_ARGS })).not.toBe(base);
    expect(sourceHash("a -> b\n", "light", { version: D2.version, args: ["--pad=0"] })).not.toBe(
      base,
    );
    expect(sourceHash("a -> b\n", "light", { version: D2.version, args: D2_ARGS })).toBe(base);
  });

  test("a stamped SVG gives back both hashes, on its second line, and stays one document", () => {
    const stamped = stamp(svg, "ab".repeat(32));
    const lines = stamped.split("\n");
    expect(lines[0]).toBe(`<?xml version="1.0" encoding="utf-8"?>`);
    expect(lines[1]).toMatch(/^<!-- Rendered by tools\/diagrams\/render\.ts from source sha256:/);
    expect(stamped.endsWith("</svg>\n")).toBe(true);
    const body = `<svg xmlns="http://www.w3.org/2000/svg"></svg>\n`;
    expect(readStamp(stamped)).toEqual({
      source: "ab".repeat(32),
      svg: createHash("sha256").update(body).digest("hex"),
      body,
    });
    expect(readStamp(svg)).toBeNull();
  });

  test("a stamp anywhere but the second line is not one", () => {
    const stamped = stamp(svg, "ab".repeat(32));
    const [decl, ...rest] = stamped.split("\n");
    expect(readStamp([decl, "<script>alert(1)</script>", ...rest].join("\n"))).toBeNull();
  });
});

describe("unsafeContent", () => {
  const ok =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">` +
    `<style>@font-face { src: url("data:application/font-woff;base64,AAAA"); }</style></svg>`;

  test("passes D2's own output: namespaces and data: fonts", () => {
    expect(unsafeContent(ok)).toEqual([]);
  });

  test("names scripts, foreignObject, event handlers and outside URLs", () => {
    expect(unsafeContent(`<svg><script>x()</script></svg>`)).toEqual(["a <script> element"]);
    expect(unsafeContent(`<svg><foreignObject/></svg>`)).toEqual(["a foreignObject element"]);
    expect(unsafeContent(`<svg><rect onload="x()"/></svg>`)).toEqual(["an onload= attribute"]);
    expect(unsafeContent(`<svg><image href="https://example.com/a.png"/></svg>`)).toEqual([
      "a URL other than the SVG namespaces: https://example.com/a.png",
    ]);
    expect(unsafeContent(`<svg><use href="//cdn.example/s.svg#a"/></svg>`)).toEqual([
      "a link to //cdn.example/s.svg#a",
    ]);
    expect(unsafeContent(`<svg><style>@import url(//cdn.example/f.css);</style></svg>`)).toEqual([
      "a url() other than data: //cdn.example/f.css",
    ]);
  });

  test("the committed SVGs hold none of them", () => {
    for (const { name } of DIAGRAMS)
      for (const variant of ["light", "dark"])
        expect(
          unsafeContent(
            readFileSync(join(ROOT_DIR, `docs/assets/diagrams/${name}-${variant}.svg`), "utf8"),
          ),
        ).toEqual([]);
  });
});

describe("checkDiagrams", () => {
  const setup = () => {
    const root = tempDir("vimma-diagrams-");
    mkdirSync(join(root, "docs/assets/diagrams"), { recursive: true });
    const source = "a -> b\n";
    writeFileSync(join(root, "docs/assets/diagrams/x.d2"), source);
    const write = (variant: "light" | "dark", hash: string, body = "<svg></svg>") =>
      writeFileSync(join(root, `docs/assets/diagrams/x-${variant}.svg`), stamp(body, hash));
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

  test("fails when an SVG was edited after the render", () => {
    const { root, source, write } = setup();
    write("light", sourceHash(source, "light"));
    write("dark", sourceHash(source, "dark"));
    const path = join(root, "docs/assets/diagrams/x-dark.svg");
    writeFileSync(path, readFileSync(path, "utf8").replace("<svg>", `<svg><rect onclick="x()"/>`));
    const lines = readFileSync(join(root, "docs/assets/diagrams/x-light.svg"), "utf8").split("\n");
    lines.splice(1, 0, "<script>x()</script>");
    writeFileSync(join(root, "docs/assets/diagrams/x-light.svg"), lines.join("\n"));
    expect(checkDiagrams(root, diagrams)).toEqual([
      "docs/assets/diagrams/x-light.svg has no stamp on its second line: run npm run diagrams",
      "docs/assets/diagrams/x-light.svg holds a <script> element",
      "docs/assets/diagrams/x-dark.svg was edited after it was rendered: run npm run diagrams",
      "docs/assets/diagrams/x-dark.svg holds an onclick= attribute",
    ]);
  });

  test("a missing source, an unlisted source and an SVG with no source are named", () => {
    const { root, source, write } = setup();
    write("light", sourceHash(source, "light"));
    write("dark", sourceHash(source, "dark"));
    writeFileSync(join(root, "docs/assets/diagrams/new.d2"), "c -> d\n");
    writeFileSync(join(root, "docs/assets/diagrams/old-light.svg"), "<svg/>");
    expect(
      checkDiagrams(root, [...diagrams, { name: "y", source: "docs/assets/diagrams/y.d2" }]),
    ).toEqual([
      "docs/assets/diagrams/y.d2 is missing: DIAGRAMS in tools/diagrams/render.ts names it",
      "docs/assets/diagrams/new.d2 is not in DIAGRAMS (tools/diagrams/render.ts): add it",
      "docs/assets/diagrams/old-light.svg has no source in DIAGRAMS: remove it",
    ]);
  });

  test("the committed SVGs are current", () => {
    expect(checkDiagrams(ROOT_DIR, DIAGRAMS)).toEqual([]);
  });
});

describe("the D2 binary", () => {
  /** A stand-in d2: reports the pinned version and writes a minimal SVG to its last argument. */
  const fakeD2 = (dir: string, version = D2.version) => {
    const bin = join(dir, "d2");
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        `if [ "$1" = "--version" ]; then echo ${version}; exit 0; fi`,
        'for a; do out="$a"; done',
        `printf '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>' > "$out"`,
        "",
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    return bin;
  };

  test("VIMMA_D2 of the pinned version is used, with no cache folder needed", async () => {
    const dir = tempDir("vimma-d2-");
    const bin = fakeD2(dir);
    const env = { VIMMA_D2: bin, XDG_CACHE_HOME: join(dir, "no-such-cache") };
    expect(await d2Binary(env)).toBe(bin);
    await expect(
      d2Binary({ ...env, VIMMA_D2: fakeD2(tempDir("vimma-d2-"), "v0.0.1") }),
    ).rejects.toThrow(/VIMMA_D2 is v0\.0\.1, the pin is/);
  });

  test("rendering needs no cache folder: its scratch files go to the system's temp folder", () => {
    const dir = tempDir("vimma-d2-");
    const root = tempDir("vimma-diagrams-");
    mkdirSync(join(root, "docs/assets/diagrams"), { recursive: true });
    writeFileSync(join(root, "docs/assets/diagrams/x.d2"), "a -> b\n");
    const prior = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = join(dir, "no-such-cache");
    try {
      renderDiagrams(root, fakeD2(dir), [{ name: "x", source: "docs/assets/diagrams/x.d2" }]);
    } finally {
      if (prior === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prior;
    }
    expect(existsSync(join(dir, "no-such-cache"))).toBe(false);
    expect(checkDiagrams(root, [{ name: "x", source: "docs/assets/diagrams/x.d2" }])).toEqual([]);
  });

  /** A release-shaped tarball holding the stand-in d2. */
  const tarball = () => {
    const dir = tempDir("vimma-d2-tar-");
    mkdirSync(join(dir, `d2-${D2.version}/bin`), { recursive: true });
    fakeD2(join(dir, `d2-${D2.version}/bin`));
    execFileSync("tar", ["-czf", join(dir, "d2.tar.gz"), "-C", dir, `d2-${D2.version}`]);
    return readFileSync(join(dir, "d2.tar.gz"));
  };

  test("is unpacked aside and moved into place, with its hash recorded and checked on use", () => {
    const cache = tempDir("vimma-d2-cache-");
    const bin = installD2(cache, tarball());
    expect(bin).toBe(join(cache, `d2-${D2.version}`, "bin", "d2"));
    expect(cachedBinary(cache)).toBe(bin);
    // Nothing is left from the unpacking.
    expect(readdirSync(cache).sort()).toEqual([`d2-${D2.version}`, "d2.sha256"]);
    // A binary changed after it was installed is not used.
    writeFileSync(bin, "#!/bin/sh\necho changed\n");
    expect(cachedBinary(cache)).toBeNull();
  });

  test("a half-unpacked cache, with no recorded hash, is not used", () => {
    const cache = tempDir("vimma-d2-cache-");
    mkdirSync(join(cache, `d2-${D2.version}/bin`), { recursive: true });
    fakeD2(join(cache, `d2-${D2.version}/bin`));
    expect(cachedBinary(cache)).toBeNull();
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

  test("no workflow and no npm script but diagrams renders: CI only checks", () => {
    const dir = join(ROOT_DIR, ".github/workflows");
    for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, f).not.toMatch(/npm run diagrams(?!:check)\b/);
      expect(text, f).not.toMatch(/render\.ts(?![^\n]*--check)/);
    }
    for (const [name, script] of Object.entries(pkg.scripts as Record<string, string>)) {
      if (name === "diagrams") continue;
      expect(script, name).not.toMatch(/npm run diagrams(?!:check)\b/);
      expect(script, name).not.toMatch(/render\.ts(?! --check)/);
    }
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
