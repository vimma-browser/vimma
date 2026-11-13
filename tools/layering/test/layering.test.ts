import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { tempDir } from "../../test/temp-dir.mjs";
import {
  type Edge,
  type Exception,
  eagerCycles,
  exceptionErrors,
  htmlImports,
  importsOf,
  jarErrors,
  layerErrors,
  missingReadmes,
  scanModule,
} from "../layering.ts";
import { EXCEPTIONS } from "../layers.ts";

const V = "chrome://browser/content/vimma/";

/**
 * A specifier in double quotes. The fixtures build their relative imports with it, so that
 * tools/test/typescript-tools.test.mjs, which reads this file's own relative imports as text,
 * does not take them for imports of this file.
 */
const q = (spec: string) => JSON.stringify(spec);

/** The edges `importsOf` finds, as `to (kind)` strings, for short assertions. */
function found(source: string, file = "host/a.mjs"): string[] {
  return importsOf(source, file).map((e) => `${e.to} (${e.kind})`);
}

describe("importsOf: every way a module reaches another", () => {
  test("a static import, relative or by chrome:// URL, is eager", () => {
    expect(
      found(
        [
          `import { A } from ${q("../ui/a.mjs")};`,
          `import { B } from ${q("./b.mjs")};`,
          `import { C } from "${V}ctl/C.sys.mjs";`,
        ].join("\n"),
      ),
    ).toEqual(["ui/a.mjs (eager)", "host/b.mjs (eager)", "ctl/C.sys.mjs (eager)"]);
  });

  test("a re-export is an eager import", () => {
    expect(
      found(
        `export { A } from ${q("../ui/a.mjs")};\nexport * from ${q("../split/b.mjs")};\nexport const x = 1;`,
      ),
    ).toEqual(["ui/a.mjs (eager)", "split/b.mjs (eager)"]);
  });

  test("ChromeUtils.importESModule at module level is eager, inside a function lazy", () => {
    expect(
      found(
        [
          `const { A } = ChromeUtils.importESModule("${V}ui/a.mjs");`,
          `function f() { return ChromeUtils.importESModule("${V}config/ConfigHost.sys.mjs"); }`,
          `const g = () => ChromeUtils.importESModule("${V}agent/AgentChat.sys.mjs");`,
          `class K { m() { ChromeUtils.importESModule("${V}ctl/AgentGate.sys.mjs"); } }`,
        ].join("\n"),
      ),
    ).toEqual([
      "ui/a.mjs (eager)",
      "config/ConfigHost.sys.mjs (lazy)",
      "agent/AgentChat.sys.mjs (lazy)",
      "ctl/AgentGate.sys.mjs (lazy)",
    ]);
  });

  test("a lazy getter map, ChromeUtils.defineLazyGetter and import() are lazy", () => {
    expect(
      found(
        [
          `const lazy = {};`,
          `ChromeUtils.defineESModuleGetters(lazy, {`,
          `  setTimeout: "resource://gre/modules/Timer.sys.mjs",`,
          `  AgentChat: "${V}agent/AgentChat.sys.mjs",`,
          `});`,
          `ChromeUtils.defineLazyGetter(lazy, "G", () =>`,
          `  ChromeUtils.importESModule("${V}ctl/AgentGate.sys.mjs").AgentGate);`,
          `const later = import(${q("../config/ConfigHost.sys.mjs")});`,
        ].join("\n"),
      ),
    ).toEqual([
      "agent/AgentChat.sys.mjs (lazy)",
      "ctl/AgentGate.sys.mjs (lazy)",
      "config/ConfigHost.sys.mjs (lazy)",
    ]);
  });

  test("a module URL in any other string (an actor, a worker) is a lazy reference", () => {
    expect(
      found(
        [
          `const BASE = "${V}actors/";`,
          "const parent = { esModuleURI: `${BASE}VimmaParent.sys.mjs` };",
          `const worker = new ChromeWorker("${V}actors/grep-worker.mjs", { type: "module" });`,
          `const uri = \`${V}start/StartPage.sys.mjs\`;`,
        ].join("\n"),
        "actors/VimmaActors.sys.mjs",
      ),
    ).toEqual([
      "actors/ (lazy)",
      "actors/grep-worker.mjs (lazy)",
      "start/StartPage.sys.mjs (lazy)",
    ]);
  });

  test("Firefox modules, pages, data files and type-only imports are not edges", () => {
    expect(
      found(
        [
          `import { X } from "resource://gre/modules/X.sys.mjs";`,
          `const S = ChromeUtils.importESModule("moz-src:///browser/S.sys.mjs");`,
          `const page = "${V}start/start.html";`,
          `const data = "${V}about/patches.json";`,
          `/** @import { Mode } from ${q("../core/modes.mjs")} */`,
          `/** @type {import(${q("../ui/b.mjs")}).B} */`,
          `const b = null;`,
          `const word = "./not-an-import.mjs";`,
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("a classic script (vimma.js) is read too", () => {
    expect(
      found(
        `var { VimmaHost } = ChromeUtils.importESModule("${V}host/VimmaHost.sys.mjs");`,
        "vimma.js",
      ),
    ).toEqual(["host/VimmaHost.sys.mjs (eager)"]);
  });

  test("each edge carries the importing file and its line", () => {
    expect(importsOf(`\n\nimport "../ui/a.mjs";`, "host/a.mjs")).toEqual([
      { from: "host/a.mjs", to: "ui/a.mjs", kind: "eager", line: 3 },
    ]);
  });
});

describe("scanModule: a specifier that is not a fixed string is an error", () => {
  /** What `scanModule` reports, edges as `to (kind)` and problems as they are. */
  function scanned(source: string, file = "host/a.mjs") {
    const { edges, problems } = scanModule(source, file);
    return { edges: edges.map((e) => `${e.to} (${e.kind})`), problems };
  }

  test("a template literal without ${} is a plain string", () => {
    expect(
      scanned(
        [
          "const a = import(`" + V + "host/VimmaHost.sys.mjs`);",
          "const { B } = ChromeUtils.importESModule(`" + V + "ui/b.mjs`);",
        ].join("\n"),
      ),
    ).toEqual({ edges: ["host/VimmaHost.sys.mjs (lazy)", "ui/b.mjs (eager)"], problems: [] });
  });

  test("import() and importESModule with a computed specifier fail", () => {
    expect(
      scanned(
        [
          "const n = 'VimmaHost';",
          "const a = import(`" + V + "host/${n}.sys.mjs`);",
          `const b = ChromeUtils.importESModule("${V}" + "host/VimmaHost.sys.mjs");`,
          "const P = 'x';",
          `const c = ChromeUtils.importESModule(P + "host/VimmaHost.sys.mjs");`,
          "const d = import(n);",
        ].join("\n"),
      ).problems,
    ).toEqual([
      "host/a.mjs:2: an import specifier is not a fixed string",
      "host/a.mjs:3: an import specifier is not a fixed string",
      "host/a.mjs:5: an import specifier is not a fixed string",
      "host/a.mjs:6: an import specifier is not a fixed string",
    ]);
  });

  test("a lazy getter map's value must be a fixed string", () => {
    expect(
      scanned(
        [
          "const lazy = {};",
          "const P = 'x';",
          "ChromeUtils.defineESModuleGetters(lazy, {",
          `  A: "${V}agent/AgentChat.sys.mjs",`,
          "  B: P + 'ctl/AgentGate.sys.mjs',",
          "});",
        ].join("\n"),
      ),
    ).toEqual({
      edges: ["agent/AgentChat.sys.mjs (lazy)"],
      problems: ["host/a.mjs:5: an import specifier is not a fixed string"],
    });
  });

  test("a string that is only part of a Vimma URL fails, unless it names a folder", () => {
    expect(
      scanned(
        [
          `const ROOT = "${V}";`,
          `const HOST = "${V}host/";`,
          "const n = 'x';",
          "const t = `" + V + "ctl/${n}.sys.mjs`;",
          "const u = `" + V + "${n}`;",
        ].join("\n"),
      ),
    ).toEqual({
      edges: ["host/ (lazy)", "ctl/ (lazy)"],
      problems: [
        "host/a.mjs:1: a string names part of a Vimma module URL, not a module or a folder",
        "host/a.mjs:5: a string names part of a Vimma module URL, not a module or a folder",
      ],
    });
  });

  test("a moz-src:/// URL into vimma/ is an edge like its chrome:// twin", () => {
    expect(
      scanned(
        `const { H } = ChromeUtils.importESModule("moz-src:///browser/base/content/vimma/host/VimmaHost.sys.mjs");`,
        "ui/x.mjs",
      ),
    ).toEqual({ edges: ["host/VimmaHost.sys.mjs (eager)"], problems: [] });
  });

  test("Firefox's own computed imports are not Vimma's business", () => {
    expect(
      scanned(
        `const n = "Timer"; const T = ChromeUtils.importESModule(\`resource://gre/modules/\${n}.sys.mjs\`);`,
      ),
    ).toEqual({ edges: [], problems: [] });
  });
});

describe("importsOf: what runs while the module evaluates is eager", () => {
  test("an immediately called function at module level is eager", () => {
    expect(
      found(
        [
          `(() => ChromeUtils.importESModule("${V}ctl/a.mjs"))();`,
          `(function () { ChromeUtils.importESModule("${V}ctl/b.mjs"); })();`,
          `const later = () => (() => ChromeUtils.importESModule("${V}ctl/c.mjs"))();`,
        ].join("\n"),
      ),
    ).toEqual(["ctl/a.mjs (eager)", "ctl/b.mjs (eager)", "ctl/c.mjs (lazy)"]);
  });

  test("a static block and a static field are eager, an instance field lazy", () => {
    expect(
      found(
        [
          "class K {",
          `  static { ChromeUtils.importESModule("${V}ctl/a.mjs"); }`,
          `  static s = ChromeUtils.importESModule("${V}ctl/b.mjs");`,
          `  i = ChromeUtils.importESModule("${V}ctl/c.mjs");`,
          "}",
        ].join("\n"),
      ),
    ).toEqual(["ctl/a.mjs (eager)", "ctl/b.mjs (eager)", "ctl/c.mjs (lazy)"]);
  });
});

describe("htmlImports", () => {
  test("a page's script and stylesheet URLs into vimma/ are eager edges", () => {
    expect(
      htmlImports(
        [
          `<link rel="stylesheet" href="chrome://browser/skin/vimma/about.css" />`,
          `<script type="module" src="${V}about/about.mjs"></script>`,
          `<script src="../ui/x.js"></script>`,
        ].join("\n"),
        "about/about.html",
      ),
    ).toEqual({
      edges: [
        { from: "about/about.html", to: "about/about.mjs", kind: "eager", line: 2 },
        { from: "about/about.html", to: "ui/x.js", kind: "eager", line: 3 },
      ],
      problems: [],
    });
  });

  test("an inline script is an error: its imports would go unread", () => {
    expect(
      htmlImports(
        `<p>\n<script type="module">\n  import "../host/a.mjs";\n</script>`,
        "about/a.html",
      ).problems,
    ).toEqual(["about/a.html:2: an inline <script> is not read; load the code from a module file"]);
  });
});

describe("jarErrors", () => {
  test("every module is packaged at its own path, so the URL's folder is the source folder", () => {
    expect(
      jarErrors(
        [
          "browser.jar:",
          "        content/browser/vimma/vimma.js                    (vimma.js)",
          "        content/browser/vimma/host/VimmaHost.sys.mjs      (host/VimmaHost.sys.mjs)",
          "        content/browser/vimma/core                        (core/**/*.mjs)",
          "        content/browser/vimma/about/patches.json          (/browser/config/vimma/patches.json)",
          "        content/browser/vimma/ui/moved.mjs                (host/moved.mjs)",
        ].join("\n"),
      ),
    ).toEqual([
      "jar.mn:6: content/browser/vimma/ui/moved.mjs is packaged from host/moved.mjs; a module's URL must be its source path",
    ]);
  });
});

describe("exceptionErrors", () => {
  const base = { from: "ui/x.mjs", to: "host/a.mjs", kind: "lazy" as const, reason: "r" };

  test("each exception says whether it stays or goes, and a leaving one names its issue", () => {
    expect(
      exceptionErrors([
        { ...base, fate: "stays" },
        { ...base, to: "host/b.mjs", fate: "goes", issue: 936 },
        { ...base, to: "host/c.mjs", fate: "goes" },
      ]),
    ).toEqual(["exception ui/x.mjs -> host/c.mjs (lazy) goes but names no issue"]);
  });

  test("the list does not grow without a change to ADR-026", () => {
    // Raising this number is a decision: amend ADR-026's "Exceptions" with the new import and
    // why it cannot be avoided. Lower it whenever an exception goes.
    const PINNED = 17;
    expect(
      EXCEPTIONS.length,
      `tools/layering/layers.ts lists ${EXCEPTIONS.length} exceptions, more than the ${PINNED} ADR-026 allows: an upward import needs an ADR change, not just a list entry`,
    ).toBeLessThanOrEqual(PINNED);
  });
});

/** A small tree: core at the bottom, ui above it, host above ui, ctl above host. */
const layers = { core: 0, ui: 1, split: 1, host: 2, ctl: 3, "(root)": 4 };

function edge(from: string, to: string, kind: Edge["kind"] = "eager", line = 1): Edge {
  return { from, to, kind, line };
}

describe("layerErrors", () => {
  test("a folder may import its own folder and any lower layer", () => {
    expect(
      layerErrors(
        [
          edge("host/a.mjs", "host/b.mjs"),
          edge("host/a.mjs", "ui/x.mjs"),
          edge("host/a.mjs", "core/keys.mjs"),
          edge("ctl/C.sys.mjs", "host/a.mjs", "lazy"),
          edge("vimma.js", "ctl/C.sys.mjs"),
        ],
        layers,
        [],
      ),
    ).toEqual([]);
  });

  test("an import of a higher layer fails, eager or lazy", () => {
    expect(
      layerErrors(
        [
          edge("ui/x.mjs", "host/a.mjs", "eager", 7),
          edge("host/a.mjs", "ctl/C.sys.mjs", "lazy", 9),
        ],
        layers,
        [],
      ),
    ).toEqual([
      "ui/x.mjs:7 imports host/a.mjs (eager): ui (layer 1) may not import host (layer 2)",
      "host/a.mjs:9 imports ctl/C.sys.mjs (lazy): host (layer 2) may not import ctl (layer 3)",
    ]);
  });

  test("folders of the same layer do not import each other", () => {
    expect(layerErrors([edge("ui/x.mjs", "split/p.mjs", "eager", 3)], layers, [])).toEqual([
      "ui/x.mjs:3 imports split/p.mjs (eager): ui (layer 1) may not import split (layer 1)",
    ]);
  });

  test("a folder missing from the layers fails, as importer or as imported", () => {
    expect(
      layerErrors(
        [edge("newthing/n.mjs", "core/a.mjs"), edge("host/a.mjs", "other/o.mjs")],
        layers,
        [],
      ),
    ).toEqual([
      "newthing/n.mjs: the folder newthing/ has no layer: add it to LAYERS (tools/layering/layers.ts) and ADR-026",
      "other/o.mjs: the folder other/ has no layer: add it to LAYERS (tools/layering/layers.ts) and ADR-026",
    ]);
  });

  test("an exception lets exactly its edge through, with its kind", () => {
    const exceptions: Exception[] = [
      { from: "ui/x.mjs", to: "host/a.mjs", kind: "lazy", reason: "a reason", fate: "stays" },
    ];
    expect(layerErrors([edge("ui/x.mjs", "host/a.mjs", "lazy")], layers, exceptions)).toEqual([]);
    const listed = edge("ui/x.mjs", "host/a.mjs", "lazy");
    expect(
      layerErrors([listed, edge("ui/x.mjs", "host/a.mjs", "eager", 2)], layers, exceptions),
    ).toEqual([
      "ui/x.mjs:2 imports host/a.mjs (eager): ui (layer 1) may not import host (layer 2)",
    ]);
    expect(
      layerErrors([listed, edge("ui/x.mjs", "host/b.mjs", "lazy", 4)], layers, exceptions),
    ).toEqual(["ui/x.mjs:4 imports host/b.mjs (lazy): ui (layer 1) may not import host (layer 2)"]);
  });

  test("a stale exception fails: its edge is gone, or no longer crosses a layer upwards", () => {
    const exceptions: Exception[] = [
      { from: "ui/x.mjs", to: "host/a.mjs", kind: "lazy", reason: "gone", fate: "stays" },
      {
        from: "ctl/C.sys.mjs",
        to: "host/a.mjs",
        kind: "eager",
        reason: "allowed anyway",
        fate: "stays",
      },
    ];
    expect(layerErrors([edge("ctl/C.sys.mjs", "host/a.mjs")], layers, exceptions)).toEqual([
      "stale exception: ui/x.mjs -> host/a.mjs (lazy) is no longer imported; remove it from tools/layering/layers.ts",
      "stale exception: ctl/C.sys.mjs -> host/a.mjs (eager) is allowed by the layers; remove it from tools/layering/layers.ts",
    ]);
  });

  test("an exception without a reason fails", () => {
    expect(
      layerErrors([edge("ui/x.mjs", "host/a.mjs", "lazy")], layers, [
        { from: "ui/x.mjs", to: "host/a.mjs", kind: "lazy", reason: " ", fate: "stays" },
      ]),
    ).toEqual(["exception ui/x.mjs -> host/a.mjs (lazy) gives no reason"]);
  });
});

describe("eagerCycles", () => {
  test("two modules importing each other eagerly are a cycle", () => {
    expect(
      eagerCycles([edge("host/a.mjs", "host/b.mjs"), edge("host/b.mjs", "host/a.mjs")]),
    ).toEqual(["eager import cycle: host/a.mjs -> host/b.mjs -> host/a.mjs"]);
  });

  test("a longer loop is found once", () => {
    expect(
      eagerCycles([
        edge("host/a.mjs", "ui/b.mjs"),
        edge("ui/b.mjs", "ctl/c.mjs"),
        edge("ctl/c.mjs", "host/a.mjs"),
        edge("ctl/c.mjs", "core/k.mjs"),
      ]),
    ).toEqual(["eager import cycle: ctl/c.mjs -> host/a.mjs -> ui/b.mjs -> ctl/c.mjs"]);
  });

  test("a loop closed by a lazy import is not an eager cycle", () => {
    expect(
      eagerCycles([edge("host/a.mjs", "host/b.mjs"), edge("host/b.mjs", "host/a.mjs", "lazy")]),
    ).toEqual([]);
  });
});

describe("missingReadmes", () => {
  test("names each tracked folder of vimma/ without a README.md", () => {
    const root = tempDir("vimma-layering-");
    const vimma = "src/browser/base/content/vimma";
    for (const f of ["vimma.js", "host/a.mjs", "ui/README.md", "ui/b.mjs", "about/about.html"]) {
      mkdirSync(dirname(join(root, vimma, f)), { recursive: true });
      writeFileSync(join(root, vimma, f), "");
    }
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    expect(missingReadmes(root)).toEqual(["about", "host"]);
  });
});
