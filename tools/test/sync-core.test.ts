/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// tools/sync-core.mjs copies packages/vimma-core/src, grouped in folders by area (#937), into the
// chrome tree as one flat folder, so the browser's `../core/<name>.mjs` imports and the
// mochitests' chrome:// URLs do not depend on where a module sits inside the package.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { coreLayout, rewriteSpecifiers, syncCore } from "../sync-core.mjs";
import { tempDir } from "./temp-dir.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC = join(ROOT, "packages/vimma-core/src");

/** Every file under `dir`, relative to it, with forward slashes. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

/** The relative module specifiers in a module's text: imports, re-exports and JSDoc types. */
const SPECIFIER = /(["'])(\.\.?\/[^"'\s]*?\.m?js)\1/g;

describe("coreLayout", () => {
  it("puts each module at the top of core/ and keeps vendor/ as it is", () => {
    const layout = coreLayout([
      "index.mjs",
      "keys/keys.mjs",
      "agent/agent-keys.mjs",
      "vendor/smol-toml/smol-toml.mjs",
      "vendor/smol-toml/smol-toml.d.mts",
    ]);
    expect(Object.fromEntries(layout)).toEqual({
      "index.mjs": "index.mjs",
      "keys/keys.mjs": "keys.mjs",
      "agent/agent-keys.mjs": "agent-keys.mjs",
      "vendor/smol-toml/smol-toml.mjs": "vendor/smol-toml/smol-toml.mjs",
      "vendor/smol-toml/smol-toml.d.mts": "vendor/smol-toml/smol-toml.d.mts",
    });
  });

  it("refuses two modules of the same name in different folders", () => {
    expect(() => coreLayout(["keys/find.mjs", "page/find.mjs"])).toThrow(
      /keys\/find\.mjs and page\/find\.mjs both become core\/find\.mjs/,
    );
  });
});

describe("rewriteSpecifiers", () => {
  const layout = coreLayout([
    "index.mjs",
    "keys/keys.mjs",
    "agent/agent-keys.mjs",
    "config/toml.mjs",
    "vendor/smol-toml/smol-toml.mjs",
  ]);

  it("points imports, re-exports and JSDoc types at the flat copy", () => {
    const source = [
      'import { parseKey } from "../keys/keys.mjs";',
      '/** @import { Chord } from "../keys/keys.mjs" */',
      '/** @type {import("../keys/keys.mjs").Chord} */',
      'export * from "./agent-keys.mjs";',
    ].join("\n");
    expect(rewriteSpecifiers(source, "agent/agent-keys.mjs", layout)).toBe(
      [
        'import { parseKey } from "./keys.mjs";',
        '/** @import { Chord } from "./keys.mjs" */',
        '/** @type {import("./keys.mjs").Chord} */',
        'export * from "./agent-keys.mjs";',
      ].join("\n"),
    );
    expect(rewriteSpecifiers('export * from "./keys/keys.mjs";', "index.mjs", layout)).toBe(
      'export * from "./keys.mjs";',
    );
  });

  it("keeps the vendored parser under vendor/", () => {
    expect(
      rewriteSpecifiers(
        'import { parse } from "../vendor/smol-toml/smol-toml.mjs";',
        "config/toml.mjs",
        layout,
      ),
    ).toBe('import { parse } from "./vendor/smol-toml/smol-toml.mjs";');
  });

  it("leaves text that is not a relative module path alone", () => {
    const source = 'const a = "src/main.c"; const b = "packages/vimma-core/src/keys/keys.mjs";';
    expect(rewriteSpecifiers(source, "agent/agent-keys.mjs", layout)).toBe(source);
  });

  it("refuses a relative module path that names no file of the package", () => {
    expect(() => rewriteSpecifiers('import "./keys.mjs";', "agent/agent-keys.mjs", layout)).toThrow(
      /agent\/agent-keys\.mjs: "\.\/keys\.mjs" names agent\/keys\.mjs/,
    );
  });
});

describe("syncCore on the real package", () => {
  const sync = () => {
    const out = tempDir("vimma-sync-core-");
    syncCore(SRC, out);
    return out;
  };

  it("emits one flat folder of modules, with the vendored parser under vendor/", () => {
    const emitted = filesUnder(sync());
    expect(emitted).toContain("index.mjs");
    expect(emitted).toContain("tablabels.mjs");
    expect(emitted).toContain("vendor/smol-toml/smol-toml.mjs");
    expect(emitted).toContain("vendor/smol-toml/smol-toml.d.mts");
    expect(emitted.filter((p) => p.includes("/") && !p.startsWith("vendor/"))).toEqual([]);
    // Licence and readme stay in packages/: jar.mn packs core/**/*.mjs only.
    expect(emitted.filter((p) => !/\.(mjs|d\.mts)$/.test(p))).toEqual([]);
    expect(emitted).toHaveLength(
      filesUnder(SRC).filter((p) => /\.(mjs|d\.mts)$/.test(p) && !p.endsWith(".test.mjs")).length,
    );
  });

  it("emits every core module that browser code and mochitests import by path", () => {
    const out = sync();
    const grep = execFileSync(
      "git",
      ["grep", "-ohE", "core/[a-z0-9-]+\\.mjs", "--", "src", "tests"],
      {
        cwd: ROOT,
        encoding: "utf8",
      },
    );
    const named = [...new Set(grep.trim().split("\n"))].sort();
    expect(named.length).toBeGreaterThan(50);
    expect(named.filter((p) => !existsSync(join(out, p.slice("core/".length))))).toEqual([]);
  });

  it("emits modules whose relative imports resolve inside the copy", () => {
    const out = sync();
    const broken = filesUnder(out)
      .filter((p) => p.endsWith(".mjs"))
      .flatMap((p) =>
        [...readFileSync(join(out, p), "utf8").matchAll(SPECIFIER)]
          .map(([, , spec = ""]) => posix.join(posix.dirname(p), spec))
          .filter((target) => !existsSync(join(out, target)))
          .map((target) => `${p} -> ${target}`),
      );
    expect(broken).toEqual([]);
  });

  it("changes nothing in a module but its relative import paths", () => {
    const out = sync();
    const layout = coreLayout(filesUnder(SRC));
    const blank = (text: string) => text.replace(SPECIFIER, "$1…$1");
    const changed = [...layout]
      .filter(([from]) => from.endsWith(".mjs"))
      .filter(
        ([from, to]) =>
          blank(readFileSync(join(SRC, from), "utf8")) !==
          blank(readFileSync(join(out, to), "utf8")),
      )
      .map(([from]) => from);
    expect(changed).toEqual([]);
  });
});
