import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { tempDir } from "../../test/temp-dir.mjs";
import {
  type Edge,
  type Exception,
  danglingEdges,
  eagerCycles,
  exceptionErrors,
  getterNames,
  htmlImports,
  importsOf,
  jarErrors,
  jarModules,
  layerErrors,
  missingReadmes,
  patchErrors,
  restrictedErrors,
  scanModule,
  treeErrors,
} from "../layering.ts";
import { EXCEPTIONS, RESTRICTED } from "../layers.ts";

const V = "chrome://browser/content/vimma/";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

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
          "const child = { esModuleURI: `${BASE}VimmaChild.sys.mjs` };",
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

  test("a regular expression is not an edge, even one that spells a module URL", () => {
    // VimmaActors.register checks the parent actor's URL against such a pattern: it loads
    // nothing, so it is no import.
    expect(
      found(
        String.raw`const PARENT = /^chrome:\/\/browser\/content\/vimma\/host\/[\w-]+\.sys\.mjs$/;`,
        "actors/VimmaActors.sys.mjs",
      ),
    ).toEqual([]);
  });

  test("a string naming the root window script is not an edge; one naming a module still is", () => {
    // vimma.js is a classic script that browser.xhtml loads: no module can import it, so its URL
    // in a string (host/host-services.mjs names the one caller that may provide its services) is
    // text, as a page's URL is. A higher layer's module named the same way stays an edge.
    expect(
      found(
        [
          `const PROVIDER = "${V}vimma.js";`,
          `const AGENT = "${V}agent/AgentChat.sys.mjs";`,
          `const CHAT = \`${V}agent/agent-ui.mjs\`;`,
          `const OTHER = "${V}vimma2.js";`,
        ].join("\n"),
        "host/host-services.mjs",
      ),
    ).toEqual(["agent/AgentChat.sys.mjs (lazy)", "agent/agent-ui.mjs (lazy)", "vimma2.js (lazy)"]);
  });

  test("loading the root window script as a module is still an edge", () => {
    expect(found(`ChromeUtils.importESModule("${V}vimma.js");`)).toEqual(["vimma.js (eager)"]);
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

describe("danglingEdges", () => {
  const edge = (from: string, to: string, line = 1): Edge => ({ from, to, kind: "lazy", line });

  test("an edge to a file git does not track is reported, with the importing file and line", () => {
    expect(
      danglingEdges(
        [
          edge("vimma.js", "host/VimmaParent.sys.mjs", 57),
          edge("vimma.js", "host/VimmaParnet.sys.mjs", 58),
        ],
        new Set(["vimma.js", "host/VimmaParent.sys.mjs"]),
        new Set(["vimma.js", "host/VimmaParent.sys.mjs"]),
      ),
    ).toEqual([
      "vimma.js:58: names host/VimmaParnet.sys.mjs, which is not a module git tracks under vimma/",
    ]);
  });

  test("an edge to a tracked module that jar.mn does not package is reported", () => {
    expect(
      danglingEdges(
        [edge("host/a.mjs", "ui/b.mjs", 4)],
        new Set(["host/a.mjs", "ui/b.mjs"]),
        new Set(["host/a.mjs"]),
      ),
    ).toEqual(["host/a.mjs:4: names ui/b.mjs, which jar.mn does not package"]);
  });

  test("core/ (a git-ignored copy) and folder prefixes are not checked", () => {
    expect(
      danglingEdges(
        [edge("host/a.mjs", "core/modes.mjs"), edge("actors/VimmaActors.sys.mjs", "actors/")],
        new Set(["host/a.mjs"]),
        new Set(["host/a.mjs"]),
      ),
    ).toEqual([]);
  });
});

describe("jarModules", () => {
  test("the modules jar.mn packages, by their path under vimma/; a wildcard line adds none", () => {
    expect([
      ...jarModules(
        [
          "browser.jar:",
          "        content/browser/vimma/vimma.js                    (vimma.js)",
          "        content/browser/vimma/host/VimmaHost.sys.mjs      (host/VimmaHost.sys.mjs)",
          "        content/browser/vimma/core                        (core/**/*.mjs)",
        ].join("\n"),
      ),
    ]).toEqual(["vimma.js", "host/VimmaHost.sys.mjs"]);
  });
});

describe("exceptionErrors", () => {
  const base = { from: "ui/x.mjs", to: "host/c.mjs", kind: "lazy" as const, reason: "r" };

  test("refuses every entry: ADR-026 allows no upward import, whatever its fate or reason", () => {
    expect(
      exceptionErrors([
        { ...base, fate: "stays" },
        { ...base, to: "host/b.mjs", kind: "eager", fate: "goes", issue: 936 },
      ]),
    ).toEqual([
      "exception ui/x.mjs -> host/c.mjs (lazy): ADR-026 allows no upward import; reach the higher folder through a topic, a callback or an interface object (decision 4)",
      "exception ui/x.mjs -> host/b.mjs (eager): ADR-026 allows no upward import; reach the higher folder through a topic, a callback or an interface object (decision 4)",
    ]);
    expect(exceptionErrors([])).toEqual([]);
  });

  test("tools/layering/layers.ts lists no exception", () => {
    // The last one went in #936. Adding one is not a list edit: it changes ADR-026's decision 5,
    // exceptionErrors and this test.
    expect(EXCEPTIONS).toEqual([]);
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

describe("restrictedErrors", () => {
  const gate = "host/AgentGate.sys.mjs";
  const only = {
    [gate]: {
      importers: ["host/VimmaHost.sys.mjs", "ctl/VimmaControl.sys.mjs"],
      review:
        "a new caller of the agent gate needs a security review (docs/security.md section 12)",
    },
  };

  test("a module may import a restricted one only when it is listed, eagerly or lazily", () => {
    expect(
      restrictedErrors(
        [
          edge("host/VimmaHost.sys.mjs", gate),
          edge("ctl/VimmaControl.sys.mjs", gate, "lazy"),
          edge("host/VimmaHost.sys.mjs", "host/mcp-ops.mjs"),
        ],
        only,
      ),
    ).toEqual([]);
  });

  test("a new importer of the agent gate fails, in host/ or a higher folder alike", () => {
    expect(
      restrictedErrors(
        [
          edge("host/VimmaHost.sys.mjs", gate),
          edge("ctl/VimmaControl.sys.mjs", gate),
          edge("host/VimmaParent.sys.mjs", gate, "eager", 7),
          edge("config/ConfigHost.sys.mjs", gate, "lazy", 12),
        ],
        only,
      ),
    ).toEqual([
      "host/VimmaParent.sys.mjs:7: imports host/AgentGate.sys.mjs, which only the modules RESTRICTED lists in tools/layering/layers.ts may import: a new caller of the agent gate needs a security review (docs/security.md section 12), then a line there",
      "config/ConfigHost.sys.mjs:12: imports host/AgentGate.sys.mjs, which only the modules RESTRICTED lists in tools/layering/layers.ts may import: a new caller of the agent gate needs a security review (docs/security.md section 12), then a line there",
    ]);
  });

  test("a listed importer that no longer imports it fails, so the list stays exact", () => {
    expect(restrictedErrors([edge("host/VimmaHost.sys.mjs", gate)], only)).toEqual([
      "stale importer: ctl/VimmaControl.sys.mjs no longer imports host/AgentGate.sys.mjs; remove it from RESTRICTED in tools/layering/layers.ts",
    ]);
  });

  test("the gate's importers are exactly today's seven", () => {
    // Adding one is a security decision, not a list edit: review the new caller against
    // docs/security.md section 12 first, then add it here and in layers.ts.
    expect(Object.keys(RESTRICTED)).toEqual(["host/AgentGate.sys.mjs"]);
    expect(RESTRICTED["host/AgentGate.sys.mjs"]?.importers).toEqual([
      "agent/AgentChat.sys.mjs",
      "ctl/AgentDownloads.sys.mjs",
      "ctl/VimmaControl.sys.mjs",
      "ctl/agent-commands.mjs",
      "host/VimmaHost.sys.mjs",
      "host/agent-ui.mjs",
      "host/mcp-ops.mjs",
    ]);
  });
});

describe("restrictedErrors: a listed importer may not hand the module on", () => {
  const gate = "host/AgentGate.sys.mjs";
  const only = {
    [gate]: {
      importers: ["host/VimmaHost.sys.mjs"],
      review:
        "a new caller of the agent gate needs a security review (docs/security.md section 12)",
    },
  };
  /** The gate's getters, read from the module itself: reading one is reading data. */
  const data = () => ({
    [gate]: getterNames(
      readFileSync(join(ROOT, "src/browser/base/content/vimma", gate), "utf8"),
      gate,
    ),
  });
  /** The errors for host/VimmaHost.sys.mjs with this source, its own import included. */
  function handedOn(source: string): string[] {
    const { edges, handOns } = scanModule(source, "host/VimmaHost.sys.mjs");
    return restrictedErrors(edges, only, handOns, data());
  }
  const tail = `${gate}, which only the modules RESTRICTED lists in tools/layering/layers.ts may hold and none may hand on: a new caller of the agent gate needs a security review (docs/security.md section 12)`;
  const error = (line: number, how = "re-exports") =>
    `host/VimmaHost.sys.mjs:${line}: ${how} ${tail}`;
  const handsOn = (line: number) => error(line, "hands on");
  const method = (line: number, name: string) =>
    error(line, `takes the method ${name}, uncalled, of`);
  const imp = `import { AgentGate } from ${q("./AgentGate.sys.mjs")};`;
  const url = q(`${V}${gate}`);
  const getters = `const lazy = {};\nChromeUtils.defineESModuleGetters(lazy, { AgentGate: ${url} });`;

  test("export … from, named", () => {
    expect(handedOn(`export { AgentGate } from ${q("./AgentGate.sys.mjs")};`)).toEqual([error(1)]);
  });

  test("export * from", () => {
    expect(handedOn(`export * from ${q("./AgentGate.sys.mjs")};`)).toEqual([error(1)]);
  });

  test("an imported binding exported again, renamed or not", () => {
    expect(handedOn(`${imp}\nexport { AgentGate };`)).toEqual([error(2)]);
    expect(
      handedOn(
        `import { AgentGate as G } from ${q("./AgentGate.sys.mjs")};\nexport { G as Gate };`,
      ),
    ).toEqual([error(2)]);
  });

  test("an exported const that is the binding, or an object holding it", () => {
    // The object literal lets the gate out like any other value: "hands on", not "re-exports".
    expect(handedOn(`${imp}\nexport const gate = AgentGate;`)).toEqual([error(2)]);
    expect(handedOn(`${imp}\nexport const all = { gate: AgentGate };`)).toEqual([handsOn(2)]);
  });

  test("a default export of it", () => {
    expect(handedOn(`${imp}\nexport default AgentGate;`)).toEqual([error(2)]);
  });

  test("calling it from exported code is not handing it on", () => {
    expect(
      handedOn(`${imp}\nexport const Ui = { n() { return AgentGate.waiting.length; } };`),
    ).toEqual([]);
  });

  test("an alias of the binding, exported", () => {
    expect(handedOn(`${imp}\nconst g = AgentGate;\nexport { g };`)).toEqual([error(3)]);
    expect(handedOn(`${imp}\nlet g;\ng = AgentGate;\nexport { g };`)).toEqual([error(4)]);
  });

  test("a function that returns it, a list or a static field that holds it", () => {
    expect(handedOn(`${imp}\nexport function gate() { return AgentGate; }`)).toEqual([handsOn(2)]);
    expect(handedOn(`${imp}\nexport const gate = () => AgentGate;`)).toEqual([handsOn(2)]);
    expect(handedOn(`${imp}\nexport const a = [AgentGate];`)).toEqual([handsOn(2)]);
    expect(handedOn(`${imp}\nexport class X { static gate = AgentGate }`)).toEqual([handsOn(2)]);
  });

  test("one of its methods, bound or not", () => {
    expect(handedOn(`${imp}\nexport const req = AgentGate.request.bind(AgentGate);`)).toEqual([
      method(2, "request"),
      handsOn(2),
    ]);
    expect(handedOn(`${imp}\nexport const req = AgentGate.request;`)).toEqual([
      method(2, "request"),
    ]);
    expect(handedOn(`${imp}\nexport const { request } = AgentGate;`)).toEqual([
      method(2, "request"),
    ]);
  });

  test("a binding from ChromeUtils.importESModule, exported again", () => {
    expect(
      handedOn(`const { AgentGate } = ChromeUtils.importESModule(${url});\nexport { AgentGate };`),
    ).toEqual([error(2)]);
    expect(handedOn(`export const { AgentGate: G } = ChromeUtils.importESModule(${url});`)).toEqual(
      [error(1)],
    );
    expect(handedOn(`export const G = ChromeUtils.importESModule(${url}).AgentGate;`)).toEqual([
      error(1),
    ]);
    expect(handedOn(`export const M = ChromeUtils.importESModule(${url});`)).toEqual([error(1)]);
  });

  test("a namespace or an awaited import() of it, exported", () => {
    expect(
      handedOn(`import * as M from ${q("./AgentGate.sys.mjs")};\nexport const g = M.AgentGate;`),
    ).toEqual([error(2)]);
    expect(handedOn(`const m = await import(${q("./AgentGate.sys.mjs")});\nexport { m };`)).toEqual(
      [error(2)],
    );
    expect(handedOn(`export const p = import(${q("./AgentGate.sys.mjs")});`)).toEqual([handsOn(1)]);
  });

  test("a lazy getter object that holds it, exported", () => {
    expect(handedOn(`${getters}\nexport { lazy };`)).toEqual([error(3)]);
    expect(
      handedOn(
        `export const lazy = {};\nChromeUtils.defineESModuleGetters(lazy, { AgentGate: ${url} });`,
      ),
    ).toEqual([error(1)]);
    expect(handedOn(`${getters}\nexport const g = lazy.AgentGate;`)).toEqual([error(3)]);
  });

  test("a getter put on the shared global, or the gate stored or passed anywhere", () => {
    expect(
      handedOn(`ChromeUtils.defineESModuleGetters(globalThis, { AgentGate: ${url} });`),
    ).toEqual([error(1, "defines a getter outside a local object for")]);
    expect(handedOn(`${imp}\nglobalThis.gate = AgentGate;`)).toEqual([handsOn(2)]);
    expect(handedOn(`${imp}\nServices.obs.notifyObservers(AgentGate, "x");`)).toEqual([handsOn(2)]);
  });

  test("a member of it replaced or deleted", () => {
    expect(handedOn(`${imp}\nAgentGate.request = () => "allow";`)).toEqual([
      error(2, "changes the member request of"),
    ]);
    expect(handedOn(`${imp}\ndelete AgentGate.waiting;`)).toEqual([
      error(2, "changes the member waiting of"),
    ]);
  });

  test("calling it, reading its getters and keeping a local alias are not handing it on", () => {
    expect(
      handedOn(
        [
          getters,
          "ChromeUtils.defineESModuleGetters(lazy, { setTimeout: 'resource://gre/modules/Timer.sys.mjs' });",
          "export const Ui = {",
          "  status() {",
          "    const gate = lazy.AgentGate;",
          "    lazy.setTimeout(() => {}, 1);",
          "    return { n: gate.waiting.length, at: gate.ranAt, g: gate.grants(), h: gate.waiting[0] };",
          "  },",
          "  async ask(c) { await lazy.AgentGate.request(c, 'vimma_open', {}); lazy.AgentGate.on?.(); },",
          "  rows() { return lazy.AgentGate.log.map((e) => e); },",
          "};",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("getterNames: the data a restricted module's exported objects offer", () => {
  test("only getters of an exported object literal", () => {
    expect(
      getterNames(
        "export const G = { get a() { return 1; }, b() {}, c: 2, get d() { return 1; } };\nconst H = { get e() { return 1; } };",
        "host/g.mjs",
      ),
    ).toEqual(new Set(["a", "d"]));
  });

  test("the agent gate's: its read-only views", () => {
    const gate = "host/AgentGate.sys.mjs";
    const source = readFileSync(join(ROOT, "src/browser/base/content/vimma", gate), "utf8");
    expect([...getterNames(source, gate)].sort()).toEqual([
      "connections",
      "log",
      "ranAt",
      "waiting",
    ]);
  });
});

describe("importsOf: a URL with a query, a fragment or an upper-case scheme is still an edge", () => {
  const gate = "host/AgentGate.sys.mjs";
  test.each([
    [`ChromeUtils.importESModule("${V}${gate}?x")`, "eager"],
    [`ChromeUtils.importESModule("${V}${gate}#x")`, "eager"],
    [`ChromeUtils.importESModule("CHROME://browser/content/vimma/${gate}")`, "eager"],
    [`ChromeUtils.importESModule("${V}ui/../${gate}")`, "eager"],
    [`import(${q("./AgentGate.sys.mjs?x")})`, "lazy"],
    [`ChromeUtils.importESModule("chrome://BROWSER/content/vimma/${gate}")`, "eager"],
    [`ChromeUtils.importESModule("chrome://browser/content/ui/../vimma/${gate}")`, "eager"],
    [`ChromeUtils.importESModule("${V}host/AgentGate%2Esys.mjs")`, "eager"],
    [`ChromeUtils.importESModule("${V}%68ost/AgentGate.sys.mjs")`, "eager"],
  ])("%s", (source, kind) => {
    expect(found(`${source};`, "host/VimmaParent.sys.mjs")).toEqual([`${gate} (${kind})`]);
  });

  test("a string that names content/vimma/ but resolves to nothing the check knows is an error", () => {
    const { problems } = scanModule(
      `ChromeUtils.importESModule("resource://x/content/vimma/${gate}");`,
      "host/VimmaParent.sys.mjs",
    );
    expect(problems).toEqual([
      "host/VimmaParent.sys.mjs:1: a string names content/vimma/ but no Vimma module or folder the check can resolve",
    ]);
  });
});

describe("scanModule: a Vimma module named through a resource:// URL is refused", () => {
  // browser.manifest maps chrome://browser/content/ to chrome/browser/content/browser/ of the
  // app's omni.ja, which resource:/// (and resource://app/) also reach; resource://gre/ reaches
  // it in an unpackaged build. The module loader keys modules by URL, so such a URL loads a
  // second copy of the module, with its own state.
  const gate = "host/AgentGate.sys.mjs";
  const ALIAS =
    "names a Vimma module through a resource:// URL, which loads a second copy of it with its own state; name it by its chrome:// URL";
  test.each([
    `ChromeUtils.importESModule("resource:///chrome/browser/content/browser/vimma/${gate}")`,
    `ChromeUtils.importESModule("resource://app/chrome/browser/content/browser/vimma/${gate}")`,
    `ChromeUtils.importESModule("RESOURCE:///chrome/browser/content/browser/./vimma/${gate}")`,
    `ChromeUtils.importESModule("resource://gre/browser/chrome/browser/content/browser/vimma/${gate}")`,
    `ChromeUtils.defineESModuleGetters(lazy, { G: "resource:///chrome/browser/content/browser/vimma/${gate}" })`,
    `const u = "resource:///chrome/browser/content/browser/vimma/${gate}"`,
    `import("resource:///chrome/browser/content/browser/vimma/host/")`,
  ])("%s", (source) => {
    const { edges, problems } = scanModule(`${source};`, "host/VimmaParent.sys.mjs");
    expect({ edges, problems }).toEqual({
      edges: [],
      problems: [`host/VimmaParent.sys.mjs:1: ${ALIAS}`],
    });
  });

  test("a computed specifier that starts like one is not a fixed string", () => {
    const { problems } = scanModule(
      'ChromeUtils.importESModule("resource:///chrome/browser/" + name);',
      "host/VimmaParent.sys.mjs",
    );
    expect(problems).toEqual([
      "host/VimmaParent.sys.mjs:1: an import specifier is not a fixed string",
    ]);
  });

  test("Firefox's own resource:// modules are not Vimma's", () => {
    expect(
      scanModule(
        'ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");\nChromeUtils.importESModule("resource://gre/modules/" + name);',
        "host/a.mjs",
      ),
    ).toEqual({ edges: [], problems: [], handOns: [] });
  });
});

describe("patchErrors", () => {
  const only = {
    "host/AgentGate.sys.mjs": {
      importers: ["host/VimmaHost.sys.mjs"],
      review:
        "a new caller of the agent gate needs a security review (docs/security.md section 12)",
    },
  };
  test("an added line of a Firefox patch that names a restricted module fails", () => {
    expect(
      patchErrors(
        [
          {
            file: "src/browser/x/a.patch",
            text: [
              "--- a/x.sys.mjs",
              "+++ b/x.sys.mjs",
              `-  G: "${V}ctl/AgentGate.sys.mjs",`,
              `+  G: "${V}host/AgentGate.sys.mjs?v",`,
              `+  S: "${V}workspaces/WorkspaceStore.sys.mjs",`,
              ` context "${V}host/AgentGate.sys.mjs"`,
            ].join("\n"),
          },
        ],
        only,
      ),
    ).toEqual([
      "src/browser/x/a.patch:4: names host/AgentGate.sys.mjs, which only the modules RESTRICTED lists in tools/layering/layers.ts may import, and a Firefox patch is none of them: a new caller of the agent gate needs a security review (docs/security.md section 12)",
    ]);
  });

  /** The errors for one added line of a patch. */
  const added = (line: string) =>
    patchErrors([{ file: "src/browser/x/a.patch", text: `+++ b/x.sys.mjs\n+${line}` }], only);
  const names = (n: number) =>
    `src/browser/x/a.patch:${n}: names host/AgentGate.sys.mjs, which only the modules RESTRICTED lists in tools/layering/layers.ts may import, and a Firefox patch is none of them: a new caller of the agent gate needs a security review (docs/security.md section 12)`;
  const builds = (n: number, piece: string) =>
    `src/browser/x/a.patch:${n}: builds a Vimma URL from parts (${piece}); a Firefox patch names each Vimma module by its whole chrome:// URL, so that the check can read it`;

  test("a resource:// URL or an escaped one that reaches the gate fails too", () => {
    expect(
      added(`  G: "resource:///chrome/browser/content/browser/vimma/host/AgentGate.sys.mjs",`),
    ).toEqual([names(2)]);
    expect(added(`  G: "${V}host/AgentGate%2Esys.mjs",`)).toEqual([names(2)]);
    expect(added(`  G: "chrome://browser/content/ui/../vimma/host/AgentGate.sys.mjs",`)).toEqual([
      names(2),
    ]);
  });

  test("a URL built with a template literal or a + chain fails", () => {
    expect(added(`  importESModule(\`${V}\${dir}/AgentGate.sys.mjs\`);`)).toEqual([
      names(2),
      builds(2, V),
    ]);
    expect(added(`  const u = "${V}" + "host/AgentGate.sys.mjs";`)).toEqual([
      names(2),
      builds(2, V),
    ]);
    expect(added(`  const base = "${V}host/";`)).toEqual([builds(2, `${V}host/`)]);
    expect(added(`  const u = "chrome://browser/content/" + "vimma/host/" + name;`)).toEqual([
      builds(2, "chrome://browser/content/"),
    ]);
    expect(added(`  const u = "chrome://browser/content/vim" + "ma/host/" + name;`)).toEqual([
      builds(2, "chrome://browser/content/vim"),
    ]);
    expect(added(`  const u = base + "AgentGate.sys.mjs";`)).toEqual([names(2)]);
    expect(added(`  const u = \`\${base}AgentGate.sys.mjs\`;`)).toEqual([names(2)]);
  });

  test("whole URLs of other modules, pages and Firefox's own files pass", () => {
    expect(
      [
        `  <script src="${V}vimma.js"></script>`,
        `  S: "${V}workspaces/WorkspaceStore.sys.mjs",`,
        `    "content/vimma/licence/list.html",`,
        `  "chrome://browser/content/browser.js",`,
        `  "resource:///modules/BrowserWindowTracker.sys.mjs",`,
        "  // Vimma: AgentGate asks first.",
      ].flatMap(added),
    ).toEqual([]);
  });
});

describe("treeErrors: what npm run layering runs", () => {
  test("a module the gate's list does not hold fails the whole check", () => {
    const root = tempDir("vimma-layering-");
    const vimma = "src/browser/base/content/vimma";
    const files: Record<string, string> = {
      "host/README.md": "",
      "host/AgentGate.sys.mjs": "export const AgentGate = {};\n",
      "host/VimmaParent.sys.mjs": `import { AgentGate } from ${q("./AgentGate.sys.mjs")};\n`,
      "jar.mn": [
        "browser.jar:",
        "        content/browser/vimma/host/AgentGate.sys.mjs      (host/AgentGate.sys.mjs)",
        "        content/browser/vimma/host/VimmaParent.sys.mjs    (host/VimmaParent.sys.mjs)",
      ].join("\n"),
    };
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, vimma, f)), { recursive: true });
      writeFileSync(join(root, vimma, f), text);
    }
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    expect(treeErrors(root).errors).toContain(
      "host/VimmaParent.sys.mjs:1: imports host/AgentGate.sys.mjs, which only the modules RESTRICTED lists in tools/layering/layers.ts may import: a new caller of the agent gate needs a security review (docs/security.md section 12), then a line there",
    );
  });
});
