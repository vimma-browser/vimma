/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// tools/sync-core.ts copies packages/vimma-core/src, grouped in folders by area (#937), into the
// chrome tree as one flat folder, so the browser's `../core/<name>.mjs` imports and the
// mochitests' chrome:// URLs do not depend on where a module sits inside the package.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as espree from "espree";
import { describe, expect, it } from "vitest";
import { coreLayout, importPositions, rewriteSpecifiers, syncCore } from "../sync-core.ts";
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

/** A relative module path at an offset of a module's text: the offset of its opening quote. */
type Position = { offset: number; spec: string };

interface AstNode {
  type: string;
  range?: [number, number];
  [key: string]: unknown;
}

const isNode = (v: unknown): v is AstNode =>
  typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

const isRelative = (spec: unknown): spec is string =>
  typeof spec === "string" && (spec.startsWith("./") || spec.startsWith("../"));

/**
 * A type import or an `@import` tag in a JSDoc comment's text. Comments are the one place the
 * parser leaves as text, so this reads only JSDoc blocks the parser found, and only these two
 * forms: `import("<path>")` and `@import <names> from "<path>"`.
 */
const JSDOC_IMPORT =
  /(?:\bimport\(\s*|@import\s+(?:\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+)\s+from\s+)(["'])([^"'\n]*)\1/dg;

/**
 * Where a module imports another by relative path, as espree's parser sees it, without
 * sync-core's patterns: the source of each import and export-from declaration, the argument of
 * each `import()` that is a string literal, and the type imports and `@import` tags in JSDoc.
 */
function parsedImportPositions(text: string): Position[] {
  const ast = espree.parse(text, {
    ecmaVersion: "latest",
    sourceType: "module",
    range: true,
    comment: true,
  }) as unknown as AstNode & {
    comments: { type: string; value: string; range: [number, number] }[];
  };
  const found: Position[] = [];
  const source = (node: unknown) => {
    if (isNode(node) && node.type === "Literal" && isRelative(node.value) && node.range) {
      found.push({ offset: node.range[0], spec: node.value });
    }
  };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isNode(node)) return;
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      node.type === "ImportExpression"
    ) {
      source(node.source);
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(ast.body);
  for (const comment of ast.comments) {
    if (comment.type !== "Block" || !comment.value.startsWith("*")) continue;
    const start = comment.range[0] + "/*".length;
    for (const m of comment.value.matchAll(JSDOC_IMPORT)) {
      const quote = m.indices?.[1]?.[0];
      if (quote !== undefined && isRelative(m[2])) {
        found.push({ offset: start + quote, spec: m[2] });
      }
    }
  }
  return found.sort((a, b) => a.offset - b.offset);
}

/**
 * Where sync-core and the parser disagree on a module's imports, with the line: a path sync-core
 * rewrites that the parser does not see imported (program text the copy would silently change),
 * or an import the parser sees that sync-core leaves alone (a folder path left in the flat copy).
 */
function importDisagreements(
  text: string,
  file = "module.mjs",
  parsed = parsedImportPositions(text),
): string[] {
  const key = (p: Position) => `${p.offset}:${p.spec}`;
  const line = (p: Position) => text.slice(0, p.offset).split("\n").length;
  const parsedKeys = new Set(parsed.map(key));
  const rewritten = importPositions(text);
  const rewrittenKeys = new Set(rewritten.map(key));
  return [
    ...rewritten
      .filter((p) => !parsedKeys.has(key(p)))
      .map((p) => `${file}:${line(p)}: sync-core rewrites ${p.spec}, which is not an import`),
    ...parsed
      .filter((p) => !rewrittenKeys.has(key(p)))
      .map((p) => `${file}:${line(p)}: sync-core leaves the import of ${p.spec} alone`),
  ];
}

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

  const rewrite = (source: string) => rewriteSpecifiers(source, "agent/agent-keys.mjs", layout);

  it("rewrites single- and double-quoted specifiers, bare imports and JSDoc types", () => {
    expect(rewrite("import { parseKey } from '../keys/keys.mjs';")).toBe(
      "import { parseKey } from './keys.mjs';",
    );
    expect(rewrite('import "../keys/keys.mjs";')).toBe('import "./keys.mjs";');
    expect(rewrite("/** @param {import('../keys/keys.mjs').Chord} c */")).toBe(
      "/** @param {import('./keys.mjs').Chord} c */",
    );
    expect(rewrite('const m = await import("../keys/keys.mjs");')).toBe(
      'const m = await import("./keys.mjs");',
    );
  });

  it("rewrites a multi-line import, a re-export and an import of index.mjs", () => {
    expect(rewrite('import {\n  parseKey,\n  formatKey,\n} from "../keys/keys.mjs";')).toBe(
      'import {\n  parseKey,\n  formatKey,\n} from "./keys.mjs";',
    );
    expect(rewrite('export { parseKey } from "../keys/keys.mjs";')).toBe(
      'export { parseKey } from "./keys.mjs";',
    );
    expect(rewrite('import { x } from "../index.mjs";')).toBe('import { x } from "./index.mjs";');
    expect(rewrite('export * as k from "../keys/keys.mjs";')).toBe(
      'export * as k from "./keys.mjs";',
    );
    expect(rewrite('import { parseKey }\n  from\n  "../keys/keys.mjs";')).toBe(
      'import { parseKey }\n  from\n  "./keys.mjs";',
    );
  });

  it("leaves a regular expression literal alone", () => {
    const source = "const r = /\\.\\.\\/keys\\/keys\\.mjs/;";
    expect(rewrite(source)).toBe(source);
  });

  it("refuses a quoted relative path that is not an import, naming the file and line", () => {
    for (const [source, line] of [
      ['// mentions "../keys/keys.mjs"', 1],
      ["const a = 1;\nconst s = \"see '../keys/keys.mjs' for details\";", 2],
      ["const t = `../keys/keys.mjs`;", 1],
      ['const u = new URL("../keys/keys.mjs", import.meta.url);', 1],
      ['const v = "./nope.js";', 1],
      // An import's words inside a string are text, not an import.
      [`export const msg = "copied from '../keys/keys.mjs'";`, 1],
      [`export const m2 = () => "import('../keys/keys.mjs')";`, 1],
      [`const s = "import from '../keys/keys.mjs'";`, 1],
      [`const r = "run import '../keys/keys.mjs' now";`, 1],
      ["const x = `x from '../keys/keys.mjs'`;", 1],
      // A relative path to anything but a module, which the flat copy would leave pointing nowhere.
      ['const q = "../keys/keys.mjs?v=1";', 1],
      ['const j = "../keys/data.json";', 1],
      ['const k = "../keys/keys";', 1],
    ] as const) {
      expect(() => rewrite(source), source).toThrow(
        new RegExp(`agent/agent-keys\\.mjs:${line}: .* not an import`),
      );
    }
  });

  it("refuses a dynamic import whose specifier is not a plain string", () => {
    for (const source of ["await import(`../keys/${name}.mjs`);", "await import(name);"]) {
      expect(() => rewrite(source), source).toThrow(
        /agent\/agent-keys\.mjs:1: a dynamic import\(\) of something other than a plain string/,
      );
    }
  });

  it("refuses a relative module path that names no file of the package", () => {
    expect(() => rewriteSpecifiers('import "./keys.mjs";', "agent/agent-keys.mjs", layout)).toThrow(
      /agent\/agent-keys\.mjs:1: "\.\/keys\.mjs" names agent\/keys\.mjs/,
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

  it("changes no line of a module but the path inside an import, and keeps their number", () => {
    // Independent of the rewriter: each changed line is split at its quotes, and the two lines
    // may differ only in a whole string that follows `from`, `import` or `import(` outside any
    // other string, and that names the same module in the package and in the copy.
    const out = sync();
    const layout = coreLayout(filesUnder(SRC));
    const sourceOf = new Map([...layout].map(([from, to]) => [to, from]));
    /** Why `after` (in the copy `to`) is not `before` (in the package file `from`) with only an import path changed, or null. */
    const onlyImportPath = (before: string, after: string, from: string, to: string) => {
      const a = before.split(/(["'`])/);
      const b = after.split(/(["'`])/);
      if (a.length !== b.length) return "a different number of quotes";
      let open: string | null = null;
      for (let i = 0; i < a.length; i++) {
        const token = a[i] ?? "";
        if (token === b[i]) {
          if (i % 2 === 1) open = open === null ? token : open === token ? null : open;
          continue;
        }
        if (i % 2 === 1) return `quote ${token} became ${b[i]}`;
        const opened = a[i - 1] ?? "";
        const imported =
          open === opened &&
          opened !== "`" &&
          a[i + 1] === opened &&
          /(^|[^\w$.])(from|import)\s*\(?\s*$/.test(a[i - 2] ?? "");
        if (!imported) return `${token} changed outside an import`;
        const inPackage = posix.join(posix.dirname(from), token);
        const inCopy = sourceOf.get(posix.join(posix.dirname(to), b[i] ?? ""));
        if (inPackage !== inCopy) return `${token} became ${b[i]}, another module`;
      }
      return null;
    };
    const problems = [...layout]
      .filter(([from]) => from.endsWith(".mjs") && !from.startsWith("vendor/"))
      .flatMap(([from, to]) => {
        const before = readFileSync(join(SRC, from), "utf8").split("\n");
        const after = readFileSync(join(out, to), "utf8").split("\n");
        if (before.length !== after.length)
          return [`${from}: ${before.length} -> ${after.length} lines`];
        return before.flatMap((line, i) => {
          const why = line === after[i] ? null : onlyImportPath(line, after[i] ?? "", from, to);
          return why ? [`${from}:${i + 1}: ${why}`] : [];
        });
      });
    expect(problems).toEqual([]);
  });
});

/** The disagreements over every module sync-core rewrites in the package at `src` (not vendor/). */
function packageDisagreements(src: string): {
  modules: number;
  imports: number;
  problems: string[];
} {
  const modules = filesUnder(src).filter((p) => p.endsWith(".mjs") && !p.startsWith("vendor/"));
  let imports = 0;
  const problems = modules.flatMap((file) => {
    const text = readFileSync(join(src, file), "utf8");
    let parsed: Position[];
    try {
      parsed = parsedImportPositions(text);
    } catch (e) {
      return [`${file}: espree cannot parse it: ${(e as Error).message}`];
    }
    imports += parsed.length;
    return importDisagreements(text, file, parsed);
  });
  return { modules: modules.length, imports, problems };
}

describe("importPositions against a parser", () => {
  // The rewriter reads one line at a time, so a string or template literal that spans lines is
  // invisible from its later lines; espree parses the whole module. Comparing the two over the
  // real package (below) fails the pull request that adds such a line, before a release build
  // could rewrite it.
  it("agrees with the parser on imports in every form the package uses", () => {
    for (const [source, count] of [
      ['import {\n  parseKey,\n  formatKey,\n} from "../keys/keys.mjs";', 1],
      ['import { parseKey }\n  from\n  "../keys/keys.mjs";', 1],
      ['import "../keys/keys.mjs";', 1],
      ['export { parseKey } from "../keys/keys.mjs";\nexport * from "./agent-keys.mjs";', 2],
      ['export * as k from "../keys/keys.mjs";', 1],
      ['/** @import { Chord } from "../keys/keys.mjs" */', 1],
      ["/** @type {import('../keys/modes.mjs').Mode} */\nlet m;", 1],
      ['/**\n * @typedef {import("../keys/keys.mjs").Chord} C\n */', 1],
      ['const m = await import("../page/find.mjs");', 1],
      ["// import order matters: keys before modes\nconst a = 1;", 0],
      ['const s = "import from nowhere";', 0],
    ] as const) {
      expect(importDisagreements(source), source).toEqual([]);
      expect(parsedImportPositions(source), source).toHaveLength(count);
    }
  });

  it("reports an import's words inside a multi-line literal, which sync-core rewrites", () => {
    for (const [source, report] of [
      [
        'const t = `import {\n  a,\n} from "../keys/keys.mjs";\n`;',
        "module.mjs:3: sync-core rewrites ../keys/keys.mjs, which is not an import",
      ],
      [
        "const t = `\nimport { a } from '../text/strings.mjs';\n`;",
        "module.mjs:2: sync-core rewrites ../text/strings.mjs, which is not an import",
      ],
      [
        'const t = `\nawait import("../page/find.mjs")\n`;',
        "module.mjs:2: sync-core rewrites ../page/find.mjs, which is not an import",
      ],
      [
        "const s = \"first line \\\nimport { a } from '../text/strings.mjs'\";",
        "module.mjs:2: sync-core rewrites ../text/strings.mjs, which is not an import",
      ],
      [
        '// was: import { a } from "../keys/keys.mjs";\nconst a = 1;',
        "module.mjs:1: sync-core rewrites ../keys/keys.mjs, which is not an import",
      ],
    ] as const) {
      expect(importDisagreements(source), source).toEqual([report]);
    }
  });

  it("reports an import that sync-core would leave pointing into a folder", () => {
    // Not reachable with today's rewriter; it pins the other half of the comparison.
    expect(importDisagreements('import { a } from "../keys/keys.json";')).toEqual([
      "module.mjs:1: sync-core leaves the import of ../keys/keys.json alone",
    ]);
  });

  // Parsing all 83 modules takes about half a second on an idle machine, and can take longer
  // than vitest's default five seconds under heavy load.
  it("finds no disagreement in the real package", { timeout: 60_000 }, () => {
    const { modules, imports, problems } = packageDisagreements(SRC);
    expect(
      problems,
      "sync-core would change text that is not an import, or leave an import's folder path, in " +
        "the browser's flat copy: keep a path after `from` or `import` only in a real import of " +
        "a .mjs module (reword a comment, or a line of a multi-line string or template)",
    ).toEqual([]);
    expect(modules).toBeGreaterThan(80);
    expect(imports).toBeGreaterThan(250);
  });

  it("names the module and line when a package module has an import inside a template", () => {
    const src = tempDir("vimma-sync-core-oracle-");
    mkdirSync(join(src, "keys"));
    mkdirSync(join(src, "agent"));
    writeFileSync(join(src, "keys/keys.mjs"), "export const a = 1;\n");
    writeFileSync(
      join(src, "agent/zz-scratch.mjs"),
      'import { a } from "../keys/keys.mjs";\nexport const t = `\n} from "../keys/keys.mjs";\n`;\n',
    );
    expect(packageDisagreements(src).problems).toEqual([
      "agent/zz-scratch.mjs:3: sync-core rewrites ../keys/keys.mjs, which is not an import",
    ]);
  });
});
