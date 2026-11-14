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
  coreErrors,
  encodingErrors,
  fileTypeErrors,
  missingReadmes,
  mozBuildErrors,
  patchErrors,
  restrictedErrors,
  scanModule,
  treeErrors,
} from "../layering.ts";
import { EXCEPTIONS, RESTRICTED } from "../layers.ts";

const V = "chrome://browser/content/vimma/";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const WIDEN =
  "widening this allow-list is a change to tools/layering/ that needs a fresh security review (ADR-026)";
const REVIEW =
  "a new caller of the agent gate needs a security review (docs/security/12-agents.md section 12)";
const ONLY = {
  "host/AgentGate.sys.mjs": { importers: ["host/VimmaHost.sys.mjs"], review: REVIEW },
};
const ALIAS =
  "names a Vimma module through a resource:// URL, which loads a second copy of it with its own state; name it by its chrome:// URL";
const MAP =
  'a getters map must be an object literal of key: "URL" entries with fixed keys, so that the check can read each one';
const SECOND =
  "names a restricted module by another URL than its own chrome:// URL or a plain relative path, which loads a second copy of it with its own state";
const OPTIONS =
  "loads a Vimma module with an options argument, which can load it and everything it imports, the gate included, a second time in another global";

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

  test("a computed specifier fails whatever it starts with, Firefox's own included", () => {
    // A head that looks like Firefox's can reach Vimma's files (resource://gre/modules/../…),
    // and the tree loads every module by a fixed string.
    expect(
      scanned(
        `const n = "Timer"; const T = ChromeUtils.importESModule(\`resource://gre/modules/\${n}.sys.mjs\`);`,
      ).problems,
    ).toEqual(["host/a.mjs:1: an import specifier is not a fixed string"]);
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
          `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src chrome:; style-src chrome: 'unsafe-inline'; img-src chrome:; object-src 'none'" />`,
          `<link rel="stylesheet" href="chrome://browser/skin/vimma/about.css" />`,
          `<script type="module" src="${V}about/about.mjs"></script>`,
          `<script type="module" src="../ui/x.js"></script>`,
        ].join("\n"),
        "about/about.html",
      ),
    ).toEqual({
      edges: [
        { from: "about/about.html", to: "about/about.mjs", kind: "eager", line: 3 },
        { from: "about/about.html", to: "ui/x.js", kind: "eager", line: 4 },
      ],
      problems: [],
      names: [],
    });
  });

  test("an inline script is an error: its imports would go unread", () => {
    expect(
      htmlImports(
        `<p>\n<script type="module">\n  import "../host/a.mjs";\n</script>`,
        "about/a.html",
      ).problems,
    ).toContain("about/a.html:2: an inline <script> is not read; load the code from a module file");
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
        "a new caller of the agent gate needs a security review (docs/security/12-agents.md section 12)",
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
      "host/VimmaParent.sys.mjs:7: imports host/AgentGate.sys.mjs, which only the modules RESTRICTED lists in tools/layering/layers.ts may import: a new caller of the agent gate needs a security review (docs/security/12-agents.md section 12), then a line there",
      "config/ConfigHost.sys.mjs:12: imports host/AgentGate.sys.mjs, which only the modules RESTRICTED lists in tools/layering/layers.ts may import: a new caller of the agent gate needs a security review (docs/security/12-agents.md section 12), then a line there",
    ]);
  });

  test("a listed importer that no longer imports it fails, so the list stays exact", () => {
    expect(restrictedErrors([edge("host/VimmaHost.sys.mjs", gate)], only)).toEqual([
      "stale importer: ctl/VimmaControl.sys.mjs no longer imports host/AgentGate.sys.mjs; remove it from RESTRICTED in tools/layering/layers.ts",
    ]);
  });

  test("the gate's importers are exactly today's seven", () => {
    // Adding one is a security decision, not a list edit: review the new caller against
    // docs/security/12-agents.md section 12 first, then add it here and in layers.ts.
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
        "a new caller of the agent gate needs a security review (docs/security/12-agents.md section 12)",
    },
  };
  /** The gate's getters, read from the module itself: a holder may read one. */
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
  const tail = `${gate}, which only the modules RESTRICTED lists in tools/layering/layers.ts may hold and none may hand on: a new caller of the agent gate needs a security review (docs/security/12-agents.md section 12)`;
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
    ).toEqual([
      error(1, "defines a getter outside a fresh `const X = {}` of the module's own for"),
    ]);
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

describe("getterNames: the getters a restricted module's exported objects offer", () => {
  test("only getters of an exported object literal", () => {
    expect(
      getterNames(
        "export const G = { get a() { return 1; }, b() {}, c: 2, get d() { return 1; } };\nconst H = { get e() { return 1; } };",
        "host/g.mjs",
      ),
    ).toEqual(new Set(["a", "d"]));
  });

  test("the agent gate's four getters", () => {
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
        'ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");',
        "host/a.mjs",
      ),
    ).toEqual({ edges: [], problems: [], handOns: [], names: [] });
  });

  test("a resource:// root with dot segments, plus a tail that names the packaged file", () => {
    const tail = "chrome/browser/content/browser/vimma/host/AgentGate.sys.mjs";
    expect(
      scanModule(
        `const t = "${tail}";\nChromeUtils.importESModule("resource:///./" + t);\nChromeUtils.importESModule("resource://gre/modules/../" + "browser/" + t);`,
        "ui/foo.mjs",
      ).problems,
    ).toEqual([
      `ui/foo.mjs:1: ${ALIAS}`,
      "ui/foo.mjs:2: an import specifier is not a fixed string",
      "ui/foo.mjs:3: an import specifier is not a fixed string",
    ]);
  });
});

describe("scanModule: what Firefox does to a URL, the check does too", () => {
  const gate = "host/AgentGate.sys.mjs";
  // net_FilterURIString drops tab, CR and LF anywhere, and bytes up to 0x20 at either end.
  test.each([
    [`ChromeUtils.importESModule("chrome://browser/content/vim\\tma/${gate}")`, "eager"],
    [`ChromeUtils.importESModule("chrome://browser/content\\n/vimma/${gate}")`, "eager"],
    [`ChromeUtils.importESModule(" \\r${V}${gate}\\u0001 ")`, "eager"],
    [`import { AgentGate } from "chrome://browser/con\\ttent/vimma/${gate}"`, "eager"],
  ])("%s", (source, kind) => {
    expect(found(`${source};`, "ui/foo.mjs")).toEqual([`${gate} (${kind})`]);
  });

  test("a tab inside a resource:// URL does not hide it", () => {
    expect(
      scanModule(
        `ChromeUtils.importESModule("resource:///chrome/browser/content/brow\\tser/vimma/${gate}");`,
        "ui/foo.mjs",
      ).problems,
    ).toEqual([`ui/foo.mjs:1: ${ALIAS}`]);
  });
});

describe("scanModule: the loader is read only where it is called directly", () => {
  const LOADER =
    "the module loader is named other than in a direct ChromeUtils.importESModule(…) or defineESModuleGetters(…) call, so the check cannot read what it loads";
  test.each([
    `ChromeUtils["importESModule"]("${V}host/" + "AgentGate.sys.mjs")`,
    `const load = ChromeUtils.importESModule`,
    `const { importESModule } = ChromeUtils`,
    `ChromeUtils.importESModule.call(ChromeUtils, "${V}host/AgentGate.sys.mjs")`,
    `(0, ChromeUtils.importESModule)("${V}host/AgentGate.sys.mjs")`,
    `const d = ChromeUtils.defineESModuleGetters.bind(ChromeUtils)`,
    `Reflect.get(ChromeUtils, "defineESModuleGetters")`,
  ])("%s", (source) => {
    expect(scanModule(`${source};`, "ui/foo.mjs").problems).toContain(`ui/foo.mjs:1: ${LOADER}`);
  });

  test("a module the list does not hold may not name the gate's file at all", () => {
    const { edges, handOns, names } = scanModule(
      [
        `const f = "AgentGate.sys.mjs";`,
        "const g = `x/AgentGate.sys.mjs`;",
        `const h = new Function("return ChromeUtils.importESModule('${V}host/AgentGate.sys.mjs')");`,
      ].join("\n"),
      "ui/foo.mjs",
    );
    const message = (n: number) =>
      `ui/foo.mjs:${n}: names the file of host/AgentGate.sys.mjs, which only the modules RESTRICTED lists in tools/layering/layers.ts may import: ${REVIEW}, then a line there`;
    expect(restrictedErrors(edges, ONLY, handOns, {}, names)).toEqual([
      message(1),
      message(2),
      message(3),
      "stale importer: host/VimmaHost.sys.mjs no longer imports host/AgentGate.sys.mjs; remove it from RESTRICTED in tools/layering/layers.ts",
    ]);
  });

  test("a listed importer names it freely, and an import is reported once", () => {
    const source = `import { AgentGate } from ${q("../host/AgentGate.sys.mjs")};`;
    const listed = scanModule(source, "host/VimmaHost.sys.mjs");
    expect(restrictedErrors(listed.edges, ONLY, listed.handOns, {}, listed.names)).toEqual([]);
    const other = scanModule(source, "ui/foo.mjs");
    expect(restrictedErrors(other.edges, ONLY, other.handOns, {}, other.names)).toHaveLength(2);
  });
});

describe("handOnsOf: holders a name could hide", () => {
  const gate = "host/AgentGate.sys.mjs";
  const only = { [gate]: { importers: ["host/VimmaHost.sys.mjs"], review: REVIEW } };
  const errors = (source: string) => {
    const { edges, problems, handOns } = scanModule(source, "host/VimmaHost.sys.mjs");
    return [...problems, ...restrictedErrors(edges, only, handOns, {})];
  };
  const tail = `${gate}, which only the modules RESTRICTED lists in tools/layering/layers.ts may hold and none may hand on: ${REVIEW}`;
  const U = q(`${V}${gate}`);
  const imp = `import { AgentGate } from ${U};`;

  test("a spread or a computed key in a getters map is not readable", () => {
    expect(
      errors(
        `export const lazy = {};\nChromeUtils.defineESModuleGetters(lazy, { ...{ AgentGate: ${U} } });\nexport const g = lazy.AgentGate;`,
      ),
    ).toContain(`host/VimmaHost.sys.mjs:2: ${MAP}`);
    expect(
      errors(`const lazy = {};\nChromeUtils.defineESModuleGetters(lazy, { [k]: ${U} });`),
    ).toContain(`host/VimmaHost.sys.mjs:2: ${MAP}`);
  });

  test("one name given two different holds fails", () => {
    expect(
      errors(
        `import * as NS from ${U};\n${imp}\nlet g = NS; g = AgentGate;\nexport const r = g.request.bind(null);`,
      ),
    ).toContain(`host/VimmaHost.sys.mjs:3: gives a name a second, different hold of ${tail}`);
    expect(
      errors(
        `${imp}\nconst lazy = {}; ChromeUtils.defineESModuleGetters(lazy, { Other: ${U} });\nlet x = lazy; x = AgentGate;\nexport const r = x.request;`,
      ),
    ).toContain(`host/VimmaHost.sys.mjs:3: gives a name a second, different hold of ${tail}`);
  });

  test("a bare assignment to a name the module does not declare is a store, not an alias", () => {
    expect(errors(`${imp}\nvimmaLeak = AgentGate;`)).toEqual([
      `host/VimmaHost.sys.mjs:2: hands on ${tail}`,
    ]);
    expect(errors(`${imp}\ndump = AgentGate;`)).toEqual([
      `host/VimmaHost.sys.mjs:2: hands on ${tail}`,
    ]);
    expect(errors(`${imp}\nfunction f(p) { p = AgentGate; return p.grants(); }`)).toEqual([]);
  });

  test("the lazy object goes only to ChromeUtils's own define calls, not a local ChromeUtils", () => {
    expect(
      errors(
        `const ChromeUtils = { defineLeak(o) { globalThis.leak = o; } };\nconst lazy = {};\nglobalThis.ChromeUtils.defineESModuleGetters(lazy, { AgentGate: ${U} });\nChromeUtils.defineLeak(lazy);`,
      ),
    ).toContain(
      `host/VimmaHost.sys.mjs:4: passes to another function (keep other getters on a second lazy object) the lazy object of ${tail}`,
    );
  });
});

describe("scanModule: a listed importer may not load a second gate", () => {
  const gate = "host/AgentGate.sys.mjs";
  const problems = (source: string, file = "host/VimmaHost.sys.mjs") =>
    scanModule(source, file).problems;
  test.each([
    `ChromeUtils.importESModule("${V}${gate}?x")`,
    `ChromeUtils.importESModule("${V}${gate}#f")`,
    `ChromeUtils.importESModule("${V}host/AgentGate%2Esys.mjs")`,
    `ChromeUtils.importESModule("${V}host//AgentGate.sys.mjs")`,
    `ChromeUtils.importESModule("moz-src:///browser/base/content/vimma/${gate}")`,
    `import(${q("./AgentGate.sys.mjs?x")})`,
    `import { AgentGate } from ${q(".//AgentGate.sys.mjs")}`,
    `ChromeUtils.defineESModuleGetters(lazy, { G: "${V}${gate}?x" })`,
  ])("%s", (source) => {
    expect(problems(`${source};`)).toEqual([`host/VimmaHost.sys.mjs:1: ${SECOND}`]);
  });

  test("Firefox's own normalising (case of scheme and host, dot segments) loads the one gate", () => {
    expect(
      problems(
        [
          `ChromeUtils.importESModule("CHROME://BROWSER/content/vimma/${gate}");`,
          `ChromeUtils.importESModule("${V}ui/../${gate}");`,
          `import { A } from ${q("./AgentGate.sys.mjs")};`,
          `import { B } from ${q("../host/AgentGate.sys.mjs")};`,
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("an options argument, such as { global: 'current' }, fails", () => {
    expect(
      problems(
        `ChromeUtils.importESModule("${V}${gate}", { global: "current" });\nconst lazy = {};\nChromeUtils.defineESModuleGetters(lazy, { G: "${V}${gate}" }, { global: "current" });`,
      ),
    ).toEqual([`host/VimmaHost.sys.mjs:1: ${OPTIONS}`, `host/VimmaHost.sys.mjs:3: ${OPTIONS}`]);
  });
});

describe("jarErrors: manifest lines", () => {
  const MANIFEST = (n: number) =>
    `jar.mn:${n}: a manifest line here may only override one .svg image with another, outside content/vimma/: no line may swap, re-root or register a Vimma module; ${WIDEN}`;
  test("an override of a module, or a new root onto Vimma's files, fails", () => {
    expect(
      jarErrors(
        [
          "browser.jar:",
          `% override ${V}host/AgentGate.sys.mjs chrome://browser/content/fake.sys.mjs`,
          "% resource vimmax %content/browser/vimma/",
          `% override chrome://browser/content/x.js ${V}host/AgentGate.sys.mjs`,
          "% content vimmay %content/browser/vimma/",
          "% override chrome://browser/skin/sidebar/foxy.svg chrome://browser/skin/vimma/empty.svg",
        ].join("\n"),
      ),
    ).toEqual([MANIFEST(2), MANIFEST(3), MANIFEST(4), MANIFEST(5)]);
  });

  test("an override of a page, or of a file with no extension, fails too", () => {
    expect(
      jarErrors(
        [
          "% override chrome://browser/content/browser.xhtml chrome://browser/content/evil.xhtml",
          "% override chrome://global/content/foo chrome://browser/skin/vimma/empty.svg",
          "% override chrome://browser/skin/a.svg chrome://browser/skin/b.svg",
        ].join("\n"),
      ),
    ).toEqual([MANIFEST(1), MANIFEST(2)]);
  });
});

describe("htmlImports: entities, unquoted attributes and the gate's file name", () => {
  test("an entity or an unquoted attribute does not hide an edge", () => {
    const at = (html: string) =>
      htmlImports(html, "about/x.html").edges.map((e) => `${e.to} (${e.kind})`);
    expect(
      at(
        `<script type="module" src="chrome://browser/content/vimm&#97;/host/AgentGate.sys.mjs"></script>`,
      ),
    ).toEqual(["host/AgentGate.sys.mjs (eager)"]);
    expect(at(`<script type="module" src=${V}host/AgentGate.sys.mjs></script>`)).toEqual([
      "host/AgentGate.sys.mjs (eager)",
    ]);
  });

  test("a page names the gate's file only when it is listed", () => {
    expect(htmlImports(`<p data-x="Agent&#x47;ate.sys.mjs"></p>`, "about/x.html").names).toEqual([
      { from: "about/x.html", to: "host/AgentGate.sys.mjs", line: 1 },
    ]);
  });
});

describe("patchErrors", () => {
  const only = {
    "host/AgentGate.sys.mjs": {
      importers: ["host/VimmaHost.sys.mjs"],
      review:
        "a new caller of the agent gate needs a security review (docs/security/12-agents.md section 12)",
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
      "src/browser/x/a.patch:4: names host/AgentGate.sys.mjs, which only the modules RESTRICTED lists in tools/layering/layers.ts may import, and a Firefox patch is none of them: a new caller of the agent gate needs a security review (docs/security/12-agents.md section 12)",
    ]);
  });

  /** The errors for one added line of a patch. */
  const added = (line: string) =>
    patchErrors([{ file: "src/browser/x/a.patch", text: `+++ b/x.sys.mjs\n+${line}` }], only);
  const names = (n: number) =>
    `src/browser/x/a.patch:${n}: names host/AgentGate.sys.mjs, which only the modules RESTRICTED lists in tools/layering/layers.ts may import, and a Firefox patch is none of them: a new caller of the agent gate needs a security review (docs/security/12-agents.md section 12)`;
  const builds = (n: number, piece: string) =>
    `src/browser/x/a.patch:${n}: builds a Vimma URL from parts (${piece}); a Firefox patch names each Vimma module by its whole chrome:// URL, so that the check can read it`;

  test("a resource:// URL or an escaped one that reaches the gate fails too", () => {
    expect(
      added(`  G: "resource:///chrome/browser/content/browser/vimma/host/AgentGate.sys.mjs",`),
    ).toEqual([
      "src/browser/x/a.patch:2: maps or names Vimma's packaged files by their path (content/browser/vimma); only vimma/jar.mn packages them",
      names(2),
    ]);
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

  test("JS escapes, tabs and a new root over Vimma's files fail", () => {
    expect(added(`  importESModule("${V}host/Agent\\x47ate.sys.mjs");`)).toEqual([names(2)]);
    expect(added(`  importESModule("${V}host/Agent\\u0047ate.sys.mjs");`)).toEqual([names(2)]);
    expect(added(`  importESModule("${V}host/Agent\\u{47}ate.sys.mjs");`)).toEqual([names(2)]);
    expect(
      added(`  importESModule("chrome://browser/content/vim\\tma/host/AgentGate.sys.mjs");`),
    ).toEqual([names(2)]);
    expect(added("% resource vimmax %content/browser/vimma/")).toEqual([
      "src/browser/x/a.patch:2: maps or names Vimma's packaged files by their path (content/browser/vimma); only vimma/jar.mn packages them",
    ]);
  });

  test("a long line is read in linear time", () => {
    const start = Date.now();
    added("a".repeat(50000));
    expect(Date.now() - start).toBeLessThan(500);
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
      "host/VimmaParent.sys.mjs:1: imports host/AgentGate.sys.mjs, which only the modules RESTRICTED lists in tools/layering/layers.ts may import: a new caller of the agent gate needs a security review (docs/security/12-agents.md section 12), then a line there",
    );
  });
});

/** Every error the check gives one module, against the real list and the gate's real getters. */
function allErrors(source: string, file: string): string[] {
  const gate = "host/AgentGate.sys.mjs";
  const data = {
    [gate]: getterNames(
      readFileSync(join(ROOT, "src/browser/base/content/vimma", gate), "utf8"),
      gate,
    ),
  };
  const s = scanModule(source, file);
  return [
    ...s.problems,
    ...restrictedErrors(s.edges, RESTRICTED, s.handOns, data, s.names).filter(
      (e) => !e.startsWith("stale"),
    ),
  ];
}
const U = `${V}host/AgentGate.sys.mjs`;
const LISTED = "host/agent-ui.mjs";
const UNLISTED = "ui/foo.mjs";
const GATE_TAIL =
  "host/AgentGate.sys.mjs, which only the modules RESTRICTED lists in tools/layering/layers.ts may hold and none may hand on: a new caller of the agent gate needs a security review (docs/security/12-agents.md section 12)";
const CHROMEUTILS =
  "ChromeUtils is used other than as ChromeUtils.<name>, so the check cannot see which of its functions runs";

describe("scanModule: ChromeUtils is read only as ChromeUtils.<name>", () => {
  test.each([
    "const L = ChromeUtils[`importESModule`];",
    'const L = ChromeUtils["import" + "ESModule"];',
    "for (const k in ChromeUtils) {}",
    "const C = ChromeUtils;",
    "f(ChromeUtils);",
    "const o = { ...ChromeUtils };",
    "const { compileScript } = ChromeUtils;",
    '"x" in ChromeUtils;',
    "const ChromeUtils = {};",
  ])("%s", (source) => {
    expect(allErrors(source, UNLISTED)).toContain(`${UNLISTED}:1: ${CHROMEUTILS}`);
  });

  test("a loader's name in a template string is refused too", () => {
    expect(allErrors("Reflect.get(C, `importESModule`);", UNLISTED)).toContain(
      `${UNLISTED}:1: the module loader is named other than in a direct ChromeUtils.importESModule(…) or defineESModuleGetters(…) call, so the check cannot read what it loads`,
    );
  });

  test("the tree's own forms pass", () => {
    expect(
      allErrors(
        'const lazy = {};\nChromeUtils.defineESModuleGetters(lazy, { A: "resource://gre/modules/A.sys.mjs" });\nconst { B } = ChromeUtils.importESModule("resource://gre/modules/B.sys.mjs");\nChromeUtils.defineLazyGetter(lazy, "x", () => 1);',
        UNLISTED,
      ),
    ).toEqual([]);
  });
});

describe("handOnsOf: a lazy getter object is a fresh local object, bound once", () => {
  const define = `ChromeUtils.defineESModuleGetters(lazy, { AgentGate: "${U}" });`;
  const outside = (n: number) =>
    `${LISTED}:${n}: defines a getter outside a fresh \`const X = {}\` of the module's own for ${GATE_TAIL}`;
  test.each([
    [`const lazy = globalThis;\n${define}`, 2],
    [`const lazy = Services;\n${define}`, 2],
    [`export function install(lazy) { ${define} }`, 1],
    [`let lazy = {};\n${define}\nlazy = globalThis;`, 2],
    [`var lazy = {};\n${define}`, 2],
    [`const lazy = {};\n{ const lazy = globalThis; ${define} }`, 2],
  ])("%s", (source, line) => {
    expect(allErrors(source, LISTED)).toContain(outside(line));
  });

  test("const lazy = {} and Object.create(null) pass", () => {
    expect(allErrors(`const lazy = {};\n${define}\nlazy.AgentGate.revoke();`, LISTED)).toEqual([]);
    expect(
      allErrors(`const lazy = Object.create(null);\n${define}\nlazy.AgentGate.revoke();`, LISTED),
    ).toEqual([]);
  });
});

describe("handOnsOf: an assignment to a name no scope declares is a store on the global", () => {
  const imp = `import { AgentGate } from "${U}";\n`;
  test.each([
    "function f() { let leak; }\nexport function g() { leak = AgentGate; }",
    "function f(dump) {}\ndump = AgentGate;",
    "try {} catch (dump) {}\ndump = AgentGate;",
    "{ class dump {} }\ndump = AgentGate;",
    "function f({ dump }) {}\ndump = AgentGate;",
    "for (const dump of []) {}\ndump = AgentGate;",
  ])("%s", (source) => {
    expect(allErrors(imp + source, LISTED)).toContain(`${LISTED}:3: hands on ${GATE_TAIL}`);
  });

  test("an assignment to a name in scope is an alias", () => {
    expect(
      allErrors(
        `${imp}function f(p) { p = AgentGate; return p.grants(); }\nlet g;\ng = AgentGate;\ng.revoke();`,
        LISTED,
      ),
    ).toEqual([]);
  });
});

describe("handOnsOf: nested and computed destructuring", () => {
  const lazy = `const lazy = {};\nChromeUtils.defineESModuleGetters(lazy, { AgentGate: "${U}" });\n`;
  const method = (n: number, name: string) =>
    `${LISTED}:${n}: takes the method ${name}, uncalled, of ${GATE_TAIL}`;
  test.each([
    [`import * as NS from "${U}";\nconst { AgentGate: { request } } = NS;\nexport { request };`, 2],
    [`${lazy}const { AgentGate: { request } } = lazy;\nexport { request };`, 3],
    [`const { AgentGate: { request } } = await import("${U}");\nexport { request };`, 1],
    [
      `const { AgentGate: { request } } = ChromeUtils.importESModule("${U}");\nexport { request };`,
      1,
    ],
  ])("%s", (source, line) => {
    expect(allErrors(source, LISTED)).toContain(method(line, "request"));
  });

  test("a getter taken by nested destructuring passes", () => {
    expect(
      allErrors(
        `import * as NS from "${U}";\nconst { AgentGate: { waiting } } = NS;\nwaiting.length;`,
        LISTED,
      ),
    ).toEqual([]);
  });

  test("a computed key on the lazy object may be the gate", () => {
    expect(
      allErrors(`${lazy}const k = "AgentGate";\nconst { [k]: G } = lazy;\nexport { G };`, LISTED),
    ).toContain(`${LISTED}:5: re-exports ${GATE_TAIL}`);
  });
});

describe("htmlImports: a page is read whole, values across lines and references decoded", () => {
  const page = (html: string) => htmlImports(html, "about/x.html");
  const ENTITY =
    "a page may use only the character references &amp; &quot; &apos; &lt; &gt; and numeric ones, which the check decodes";
  const INLINE = "an inline <script> is not read; load the code from a module file";
  const RISKY =
    "an on… event attribute, srcdoc or <base> changes what a page runs or loads in a way the check does not read";
  test.each([
    `<script type="module" src="${V}host/AgentGate&period;sys&period;mjs"></script>`,
    `<script type="module" src="${V}host/Agent&NewLine;Gate.sys.mjs"></script>`,
    `<script type="module" src="${V}host/Agent&Tab;Gate.sys.mjs"></script>`,
  ])("named reference: %s", (html) => {
    expect(page(html).problems).toContain(`about/x.html:1: ${ENTITY}`);
  });

  test("an attribute split across lines is one URL", () => {
    expect(
      page(`<script type="module" src="${V}host/Agent\nGate.sys.mjs"></script>`).edges.map(
        (e) => e.to,
      ),
    ).toEqual(["host/AgentGate.sys.mjs"]);
  });

  test.each([
    `<script type="module" data-src="x">import("y");</script>`,
    `<SCRIPT type="module">import("y");</SCRIPT>`,
    `<script\n type="module">import("y");</script>`,
    `<script src="a.js">import("y")</script>`,
  ])("inline code: %s", (html) => {
    expect(page(html).problems).toContain(`about/x.html:1: ${INLINE}`);
  });

  test.each([
    `<img onerror="import('y')" src=x>`,
    `<iframe srcdoc="x"></iframe>`,
    `<base href="${V}host/">`,
  ])("risky attribute: %s", (html) => {
    expect(page(html).problems).toContain(`about/x.html:1: ${RISKY}`);
  });

  test("a page full of unclosed tags is read in linear time", () => {
    const start = Date.now();
    page("<script ".repeat(20000));
    expect(Date.now() - start).toBeLessThan(500);
  });

  test("a numeric reference past U+10FFFF does not throw", () => {
    expect(() => page(`<a href="&#99999999999;&#x110000;">`)).not.toThrow();
    expect(() =>
      patchErrors([{ file: "a.patch", text: "+&#99999999999;" }], RESTRICTED),
    ).not.toThrow();
  });
});

describe("jarErrors: scripts and pages are packaged only under their own path", () => {
  const SCRIPT = (n: number) =>
    `jar.mn:${n}: a script or page may be packaged only from vimma/, under its own path in content/browser/vimma/; ${WIDEN}`;
  test("a module packaged anywhere else, or by a preprocessed line, fails", () => {
    expect(
      jarErrors(
        [
          "browser.jar:",
          "        content/browser/leak.sys.mjs (host/AgentGate.sys.mjs)",
          "        skin/classic/browser/leak.mjs (host/AgentGate.sys.mjs)",
          "*       content/browser/vimma/host/AgentGate.sys.mjs (host/AgentGate.sys.mjs)",
          "        content/browser/vimma/x.css (host/AgentGate.sys.mjs)",
          "        skin/classic/browser/vimma/a.css (/browser/themes/shared/vimma/a.css)",
          "        content/browser/vimma/core (core/**/*.mjs)",
        ].join("\n"),
      ),
    ).toEqual([
      SCRIPT(2),
      SCRIPT(3),
      `jar.mn:4: a preprocessed (*) line is not read by the check; package Vimma's files as they are; ${WIDEN}`,
      SCRIPT(5),
    ]);
  });
});

describe("scanModule: only module files are loaded", () => {
  test("loading a Vimma file that is not .mjs or .js fails", () => {
    expect(
      allErrors(`ChromeUtils.importESModule("${V}omarchy/vimma-theme-reload.sh");`, UNLISTED),
    ).toContain(`${UNLISTED}:1: loads a Vimma file that is not a module (.mjs or .js)`);
  });
});

describe("patchErrors: escapes and markup that hide the gate's file name", () => {
  const names = `src/x.patch:1: names host/AgentGate.sys.mjs, which only the modules RESTRICTED lists in tools/layering/layers.ts may import, and a Firefox patch is none of them: a new caller of the agent gate needs a security review (docs/security/12-agents.md section 12)`;
  test.each([
    String.raw`+  x("${V}host/Agent\Gate.sys.mjs");`,
    String.raw`+  x("${V}host/\101gentGate.sys.mjs");`,
    String.raw`+  x("${V}host/Agent\0Gate.sys.mjs");`,
    `+  <script src="${V}host/Agent<![CDATA[]]>Gate.sys.mjs"/>`,
    `+  <script src="${V}host/AgentGate&period;sys.mjs"/>`,
  ])("%s", (line) => {
    expect(patchErrors([{ file: "src/x.patch", text: line }], RESTRICTED)).toContain(names);
  });
});

describe("fileTypeErrors: every file under vimma/ is of a type the check reads or packages", () => {
  test("a page type it does not read fails", () => {
    expect(fileTypeErrors(["about/a.xhtml", "host/b.mjs", "start/c.png", "ui/d.svg"])).toEqual([
      `vimma/about/a.xhtml: a file type the check does not read; ${WIDEN}`,
      `vimma/ui/d.svg: a file type the check does not read; ${WIDEN}`,
    ]);
  });
});

describe("mozBuildErrors: vimma/moz.build exports no module", () => {
  test("only the jar manifest and the test manifest", () => {
    const text =
      'JAR_MANIFESTS += ["jar.mn"]\n\nBROWSER_CHROME_MANIFESTS += [\n    "/x/browser.toml",\n]\nEXTRA_JS_MODULES += ["host/AgentGate.sys.mjs"]\nMOZ_SRC_FILES += ["x"]';
    expect(mozBuildErrors(text)).toEqual([
      `vimma/moz.build:6: not one of the statement forms vimma/moz.build has today (JAR_MANIFESTS or BROWSER_CHROME_MANIFESTS += a list of plain strings); ${WIDEN}`,
      `vimma/moz.build:7: not one of the statement forms vimma/moz.build has today (JAR_MANIFESTS or BROWSER_CHROME_MANIFESTS += a list of plain strings); ${WIDEN}`,
    ]);
  });
});

describe("restrictedErrors: a listed module names the gate's file only by its exact URL", () => {
  test("any other string holding the name fails", () => {
    expect(
      allErrors(
        `import { AgentGate } from "./AgentGate.sys.mjs";\nconst s = "x/AgentGate.sys.mjs";\nconst r = /AgentGate.sys.mjs/;`,
        LISTED,
      ),
    ).toEqual([
      `${LISTED}:2: names the file of host/AgentGate.sys.mjs other than by its exact chrome:// URL or a plain relative path: a new caller of the agent gate needs a security review (docs/security/12-agents.md section 12)`,
      `${LISTED}:3: names the file of host/AgentGate.sys.mjs other than by its exact chrome:// URL or a plain relative path: a new caller of the agent gate needs a security review (docs/security/12-agents.md section 12)`,
    ]);
  });

  test("a regular expression in an unlisted module counts as a string", () => {
    expect(allErrors("const r = /AgentGate.sys.mjs/;", UNLISTED)).toEqual([
      `${UNLISTED}:1: names the file of host/AgentGate.sys.mjs, which only the modules RESTRICTED lists in tools/layering/layers.ts may import: a new caller of the agent gate needs a security review (docs/security/12-agents.md section 12), then a line there`,
    ]);
  });
});

describe("coreErrors: vimma-core reaches no loader the layering check cannot read", () => {
  test("import(), globalThis, eval, Function and the gate's file name fail", () => {
    expect(
      coreErrors(
        'const m = import(x);\nglobalThis.ChromeUtils;\neval("1");\nnew Function("1");\nconst f = "AgentGate.sys.mjs";\nconst ok = 1;',
        "packages/vimma-core/src/a.mjs",
      ),
    ).toEqual(
      [1, 2, 3, 4, 5].map(
        (n) =>
          `packages/vimma-core/src/a.mjs:${n}: vimma-core may not use import(), globalThis, eval or Function, nor name a restricted module's file: the layering check does not read core/`,
      ),
    );
  });
});

describe("treeErrors: file types, vimma/moz.build and vimma-core are read too", () => {
  test("each fails the whole check", () => {
    const root = tempDir("vimma-layering-");
    const files: Record<string, string> = {
      "src/browser/base/content/vimma/jar.mn": "browser.jar:\n",
      "src/browser/base/content/vimma/ui/README.md": "",
      "src/browser/base/content/vimma/ui/a.xhtml": "",
      "src/browser/base/content/vimma/moz.build": 'EXTRA_JS_MODULES += ["x.sys.mjs"]\n',
      "packages/vimma-core/src/a.mjs": "export const g = globalThis;\n",
    };
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), text);
    }
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    const { errors } = treeErrors(root);
    expect(errors).toContain(`vimma/ui/a.xhtml: a file type the check does not read; ${WIDEN}`);
    expect(errors).toContain(
      `vimma/moz.build:1: not one of the statement forms vimma/moz.build has today (JAR_MANIFESTS or BROWSER_CHROME_MANIFESTS += a list of plain strings); ${WIDEN}`,
    );
    expect(errors).toContain(
      "packages/vimma-core/src/a.mjs:1: vimma-core may not use import(), globalThis, eval or Function, nor name a restricted module's file: the layering check does not read core/",
    );
  });
});

/** Whether any error is on this line of this file. */
const onLine = (errors: string[], file: string, n: number) =>
  errors.some((e) => e.startsWith(`${file}:${n}: `));

describe("handOnsOf: the value of an assignment is the gate too", () => {
  const imp = `import { AgentGate } from "${U}";\n`;
  test.each([
    [`${imp}let b;\nexport const a = (b = AgentGate);`, 3],
    [`${imp}let b;\nglobalThis.leak = (b = AgentGate);`, 3],
    [
      `let gate;\nexport function getGate() { return (gate ??= ChromeUtils.importESModule("${U}").AgentGate); }`,
      2,
    ],
    [`${imp}let c;\nexport const get = () => (c = AgentGate);`, 3],
    [`${imp}let c;\nServices.obs.notifyObservers(c = AgentGate, "x");`, 3],
    [`${imp}let b;\nlet a = b = AgentGate;\nexport { a };`, 4],
    [`${imp}let b;\nexport const a = (b ||= AgentGate);`, 3],
    [`${imp}let b;\nexport const a = (b &&= AgentGate);`, 3],
  ])("%s", (source, line) => {
    expect(onLine(allErrors(source, LISTED), LISTED, line)).toBe(true);
  });

  test("an assignment whose value is discarded is only an alias", () => {
    expect(
      allErrors(
        `${imp}let g;\ng = AgentGate;\nlet h;\n(h = AgentGate), g.revoke();\nfor (;; g = AgentGate) break;`,
        LISTED,
      ),
    ).toEqual([]);
  });
});

describe("jarErrors: only the line forms jar.mn has today", () => {
  const LINE = (n: number) =>
    `jar.mn:${n}: not one of the line forms jar.mn has today (a "# " comment, the browser.jar: header, an entry, an .svg override); ${WIDEN}`;
  const DOTS = (n: number) =>
    `jar.mn:${n}: a "." or ".." segment in a jar.mn path can package a file from outside vimma/; ${WIDEN}`;
  test.each([
    ["        content/browser/vimma/../evil/e.mjs (../evil/e.mjs)", DOTS(2)],
    ["        content/browser/vimma/ui/../../evil/e.mjs (ui/../../evil/e.mjs)", DOTS(2)],
    ["        content/browser/vimma/ui/./a.mjs (ui/./a.mjs)", DOTS(2)],
    ["        content/browser/vimma/../leak/ (../leak/*)", DOTS(2)],
    ["#include host/extra.inc.mn", LINE(2)],
    ["#ifdef X", LINE(2)],
    ["#filter substitution", LINE(2)],
    ["        content/browser/vimma/ui/a.mjs", LINE(2)],
    ["other.jar:", LINE(2)],
    ["browser.jar:", LINE(2)],
    ["relativesrcdir ../..:", LINE(2)],
    ["[localization] @AB_CD@.jar:", LINE(2)],
    ["        content/browser/leak.mjs\t(host/AgentGate.sys.mjs) # c", LINE(2)],
  ])("%s", (line, error) => {
    expect(jarErrors(`browser.jar:\n${line}`)).toContain(error);
  });

  test("the forms it has pass", () => {
    expect(
      jarErrors(
        [
          "# This Source Code Form is subject to the terms of the Mozilla Public",
          "",
          "browser.jar:",
          "        content/browser/vimma/vimma.js                    (vimma.js)",
          "        content/browser/vimma/core                        (core/**/*.mjs)",
          "        skin/classic/browser/vimma/hints.css              (/browser/themes/shared/vimma/hints.css)",
          "        content/browser/vimma/about/patches.json          (/browser/config/vimma/patches.json)",
          "#",
          "% override chrome://browser/skin/sidebar/foxy.svg chrome://browser/skin/vimma/empty.svg",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("mozBuildErrors: vimma/moz.build has exactly today's shape", () => {
  const SHAPE = (n: number) =>
    `vimma/moz.build:${n}: not one of the statement forms vimma/moz.build has today (JAR_MANIFESTS or BROWSER_CHROME_MANIFESTS += a list of plain strings); ${WIDEN}`;
  test.each([
    ['JAR_MANIFESTS += ["jar.mn"]; EXTRA_JS_MODULES += ["host/AgentGate.sys.mjs"]', [SHAPE(1)]],
    ['JAR_MANIFESTS += ["jar.mn", "]"]\nEXTRA_JS_MODULES += ["x"]', [SHAPE(1), SHAPE(2)]],
    ['JAR_MANIFESTS += ["jar.mn", "["]\nEXTRA_JS_MODULES += ["x"]', [SHAPE(1), SHAPE(2)]],
    ['JAR_MANIFESTS += [] if "]" else []', [SHAPE(1)]],
    ["JAR_MANIFESTS += [x for x in y]", [SHAPE(1)]],
    ["BROWSER_CHROME_MANIFESTS = EXTRA_JS_MODULES", [SHAPE(1)]],
    ['JAR_MANIFESTS += [\n    "jar.mn", "x",\n]', [SHAPE(2)]],
    ['JAR_MANIFESTS += [\n    "a#b",\n]', [SHAPE(2)]],
    ['JAR_MANIFESTS += ["""jar.mn\n]\n"""]', [SHAPE(1), SHAPE(2), SHAPE(3)]],
    ['include("other.mozbuild")', [SHAPE(1)]],
  ])("%s", (text, errors) => {
    expect(mozBuildErrors(text)).toEqual(errors);
  });

  test("today's file passes", () => {
    expect(
      mozBuildErrors(readFileSync(join(ROOT, "src/browser/base/content/vimma/moz.build"), "utf8")),
    ).toEqual([]);
  });
});

describe("fileTypeErrors: types are lower case, and build files only at the top", () => {
  const TYPE = (f: string) => `vimma/${f}: a file type the check does not read; ${WIDEN}`;
  test("an upper-case extension, a second jar.mn or moz.build, fail", () => {
    expect(
      fileTypeErrors([
        "ui/x.MJS",
        "ui/x.Js",
        "host/extra.inc.mn",
        "ui/moz.build",
        "jar.mn",
        "moz.build",
      ]),
    ).toEqual([TYPE("ui/x.MJS"), TYPE("ui/x.Js"), TYPE("host/extra.inc.mn"), TYPE("ui/moz.build")]);
  });

  test("a load of an upper-case module name is not a module", () => {
    expect(allErrors(`ChromeUtils.importESModule("${V}ui/leak.MJS");`, UNLISTED)).toContain(
      `${UNLISTED}:1: loads a Vimma file that is not a module (.mjs or .js)`,
    );
  });
});

describe("htmlImports: only the elements, URLs and policies the pages use today", () => {
  const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src chrome:; style-src chrome: 'unsafe-inline'; img-src chrome:; object-src 'none'" />`;
  const page = (html: string) => htmlImports(`${CSP}\n${html}`, "start/x.html").problems;
  const at2 = (problems: string[]) => problems.some((p) => p.startsWith("start/x.html:2: "));
  test.each([
    `<script type="module" src="data:text/javascript;base64,aW1wb3J0"></script>`,
    `<script type="module" src="javascript:1"></script>`,
    `<script src="${V}start/start.mjs"></script>`,
    `<script type="importmap" src="x.json"></script>`,
    `<iframe src="javascript:1"></iframe>`,
    `<object data="${V}host/AgentGate.sys.mjs"></object>`,
    `<embed src="x">`,
    `<link rel="modulepreload" href="${V}host/AgentGate.sys.mjs">`,
    `<link rel="stylesheet" href="https://example.com/a.css">`,
    `<meta http-equiv="refresh" content="0;url=data:text/html,x">`,
    `<svg><script href="x"/></svg>`,
    `<form action="javascript:1"></form>`,
    `<a href="javascript:1">x</a>`,
    `<img src="x">`,
  ])("%s", (html) => {
    expect(at2(page(html))).toBe(true);
  });

  test("a policy other than today's two fails, and a page with a script needs one", () => {
    expect(
      htmlImports(
        `<meta http-equiv="Content-Security-Policy" content="script-src chrome: data:">`,
        "start/x.html",
      ).problems,
    ).toHaveLength(1);
    expect(
      htmlImports(`<script type="module" src="${V}start/start.mjs"></script>`, "start/x.html")
        .problems,
    ).toHaveLength(1);
  });

  test("today's pages pass", () => {
    for (const f of [
      "about/about.html",
      "start/start.html",
      "setup/setup.html",
      "licence/list.html",
      "licence/body.html",
      "licence/product-name.html",
    ]) {
      const text = readFileSync(join(ROOT, "src/browser/base/content/vimma", f), "utf8");
      expect(htmlImports(text, f).problems).toEqual([]);
    }
  });

  test("a %-escaped file name anywhere in a page is a name", () => {
    expect(htmlImports(`<p title="Agent%47ate.sys.mjs"></p>`, "about/x.html").names).toHaveLength(
      1,
    );
  });

  test("20,000 unknown references are read in linear time", () => {
    const start = Date.now();
    htmlImports("&a\n".repeat(20000), "about/x.html");
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe("scanModule: no options argument on any Vimma module, and workers are load positions", () => {
  const OPTIONS =
    "loads a Vimma module with an options argument, which can load it and everything it imports, the gate included, a second time in another global";
  test.each([
    `ChromeUtils.importESModule("${V}host/VimmaHost.sys.mjs", { global: "devtools" });`,
    `const lazy = {};\nChromeUtils.defineESModuleGetters(lazy, { C: "${V}ctl/VimmaControl.sys.mjs" }, { global: "current" });`,
  ])("%s", (source) => {
    expect(allErrors(source, "ctl/NewThing.sys.mjs").join("\n")).toContain(OPTIONS);
  });

  test("a worker's URL is a load position: fixed, and an edge", () => {
    expect(
      allErrors(
        "new ChromeWorker(`" + V + "host/Agent${'Gate'}.sys.mjs`, { type: 'module' });",
        UNLISTED,
      ),
    ).toContain(`${UNLISTED}:1: an import specifier is not a fixed string`);
    expect(found(`new ChromeWorker("${V}ui/w.mjs");`, UNLISTED)).toEqual(["ui/w.mjs (lazy)"]);
    expect(allErrors(`const W = "${V}ui/w.mjs";\nnew ChromeWorker(W);`, UNLISTED)).toEqual([]);
    expect(allErrors(`let W = "${V}ui/w.mjs";\nnew ChromeWorker(W);`, UNLISTED)).toContain(
      `${UNLISTED}:2: an import specifier is not a fixed string`,
    );
  });
});

describe("patchErrors: build files and options", () => {
  const run = (file: string, line: string) =>
    patchErrors([{ file: "src/x.patch", text: `+++ b/${file}\n+${line}` }], RESTRICTED);
  test.each([
    ["browser/base/jar.mn", "  content/browser/x/G.sys.mjs (content/vimma/host/Agent*.sys.mjs)"],
    ["browser/base/moz.build", 'MOZ_SRC_FILES += ["base/content/vimma/host/Agent*"]'],
    ["browser/base/moz.build", 'DIRS += ["content/vimma/ui"]'],
    ["browser/modules/moz.build", 'EXTRA_JS_MODULES.vimma += ["../base/content/vimma/host/x.mjs"]'],
  ])("%s: %s", (file, line) => {
    expect(run(file, line).join("\n")).toContain(
      "names Vimma's folder (content/vimma) in a build file",
    );
  });

  test("today's lines in browser/base/moz.build pass", () => {
    for (const line of [
      '    "content/vimma",',
      '    "content/vimma/licence/list.html",',
      '    "content/vimma/licence/body.html",',
      '    "content/vimma/licence/product-name.html",',
    ])
      expect(run("browser/base/moz.build", line)).toEqual([]);
  });

  test("an options argument on a line that names a Vimma URL fails", () => {
    expect(
      run(
        "browser/x.sys.mjs",
        `ChromeUtils.importESModule("${V}host/VimmaHost.sys.mjs", { global: "devtools" });`,
      ).join("\n"),
    ).toContain("loads a Vimma module with an options argument");
  });
});

describe("handOnsOf: the lazy object goes to no other function", () => {
  test("XPCOMUtils on the gate's lazy object says to use a second one", () => {
    expect(
      allErrors(
        `const lazy = {};\nChromeUtils.defineESModuleGetters(lazy, { AgentGate: "${U}" });\nXPCOMUtils.defineLazyPreferenceGetter(lazy, "x", "a.b", false);`,
        LISTED,
      ),
    ).toContain(
      `${LISTED}:3: passes to another function (keep other getters on a second lazy object) the lazy object of ${GATE_TAIL}`,
    );
  });
});

describe("scanModule: the gate loads only as a module of the main loader", () => {
  test("in a worker it would be a second copy, in another global", () => {
    expect(allErrors(`new ChromeWorker("${U}", { type: "module" });`, LISTED)).toContain(
      `${LISTED}:1: loads a restricted module in a worker, a second copy of it with its own state`,
    );
  });

  test("import attributes on a Vimma module count as options", () => {
    expect(
      allErrors(
        `import { AgentGate } from "${U}" with { type: "json" };\nAgentGate.revoke();`,
        LISTED,
      ),
    ).toContain(
      `${LISTED}:1: loads a Vimma module with an options argument, which can load it and everything it imports, the gate included, a second time in another global`,
    );
  });
});

describe("htmlImports: attributes as the parser keeps them, and the policy first", () => {
  const POLICY = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src chrome:; style-src chrome: 'unsafe-inline'; img-src chrome:; object-src 'none'" />`;
  const SCRIPT = `<script type="module" src="${V}start/start.mjs"></script>`;
  const problems = (html: string) => htmlImports(html, "start/x.html").problems.join("\n");
  test("a repeated attribute fails: the parser keeps the first copy", () => {
    expect(
      problems(
        `<meta http-equiv="Content-Security-Policy" content="script-src chrome: data:" content="default-src 'none'; script-src chrome:; style-src chrome: 'unsafe-inline'; img-src chrome:; object-src 'none'" />\n${SCRIPT}`,
      ),
    ).toContain("start/x.html:1: <meta> repeats the attribute content");
    expect(
      problems(
        `${POLICY}\n<script type="module" src="data:text/javascript,1" SRC="${V}start/start.mjs"></script>`,
      ),
    ).toContain("start/x.html:2: <script> repeats the attribute src");
  });

  test("the policy comes once, before the first script or link", () => {
    const ORDER =
      "a page with a script or a stylesheet carries exactly one of today's Content-Security-Policy values, in its head, before the first of them";
    expect(problems(`${SCRIPT}\n${POLICY}`)).toContain(ORDER);
    expect(
      problems(
        `<link rel="stylesheet" href="chrome://browser/skin/vimma/start.css" />\n${POLICY}\n${SCRIPT}`,
      ),
    ).toContain(ORDER);
    expect(problems(`${POLICY}\n${POLICY}\n${SCRIPT}`)).toContain(ORDER);
    expect(htmlImports(`${POLICY}\n${SCRIPT}`, "start/x.html").problems).toEqual([]);
  });
});

describe("encodingErrors: every file the check reads is UTF-8, as the check reads it", () => {
  const bytes = (...b: number[]) => new Uint8Array(b);
  const ENC = (what: string) =>
    `vimma/a.html: ${what}; the check reads UTF-8 without a byte order mark, as Firefox reads these files only then`;
  test.each([
    [bytes(0xef, 0xbb, 0xbf, 0x3c), "starts with a byte order mark"],
    [bytes(0xff, 0xfe, 0x3c, 0x00), "starts with a byte order mark"],
    [bytes(0xfe, 0xff, 0x00, 0x3c), "starts with a byte order mark"],
    [bytes(0x3c, 0x00, 0x3e), "holds a NUL byte"],
    [bytes(0x3c, 0xc3, 0x28), "is not valid UTF-8"],
  ])("%s", (b, what) => {
    expect(encodingErrors(b, "vimma/a.html")).toEqual([ENC(what)]);
  });

  test("plain UTF-8 passes", () => {
    expect(encodingErrors(new TextEncoder().encode("<p>é</p>"), "vimma/a.html")).toEqual([]);
  });

  test("a UTF-16 page in the tree fails the whole check", () => {
    const root = tempDir("vimma-layering-");
    const vimma = join(root, "src/browser/base/content/vimma");
    mkdirSync(join(vimma, "start"), { recursive: true });
    writeFileSync(join(vimma, "jar.mn"), "browser.jar:\n");
    writeFileSync(join(vimma, "start/README.md"), "");
    writeFileSync(
      join(vimma, "start/x.html"),
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("<script src=data:,1></script>", "utf16le"),
      ]),
    );
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    expect(treeErrors(root).errors.join("\n")).toContain(
      "vimma/start/x.html: starts with a byte order mark",
    );
  });
});

describe("scanModule: a worker reached as a member is a worker", () => {
  test("new globalThis.ChromeWorker(<built URL>) fails", () => {
    expect(allErrors(`new globalThis.ChromeWorker("${V}host/Agent" + x);`, UNLISTED)).toContain(
      `${UNLISTED}:1: an import specifier is not a fixed string`,
    );
  });
});

describe("patchErrors: today's build lines only in browser/base/moz.build", () => {
  test("the same line in another build file fails", () => {
    expect(
      patchErrors(
        [{ file: "src/x.patch", text: '+++ b/browser/other/moz.build\n+    "content/vimma",' }],
        RESTRICTED,
      ).join("\n"),
    ).toContain("names Vimma's folder (content/vimma) in a build file");
  });
});

describe("htmlImports: the policy sits in the head", () => {
  test("a policy in the body is ignored by Firefox, so it fails", () => {
    const POLICY = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src chrome:; style-src chrome: 'unsafe-inline'; img-src chrome:; object-src 'none'" />`;
    const SCRIPT = `<script type="module" src="${V}start/start.mjs"></script>`;
    const ORDER =
      "a page with a script or a stylesheet carries exactly one of today's Content-Security-Policy values, in its head, before the first of them";
    expect(
      htmlImports(
        `<html><head></head><body>${POLICY}\n${SCRIPT}</body></html>`,
        "start/x.html",
      ).problems.join("\n"),
    ).toContain(ORDER);
    expect(
      htmlImports(`<html><head>${POLICY}</head><body>\n${SCRIPT}</body></html>`, "start/x.html")
        .problems,
    ).toEqual([]);
  });
});

describe("treeErrors: a module that is not UTF-8 reports its encoding, not a parse error", () => {
  test.each([
    [
      "a UTF-16 module",
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("export const a = 1;\n", "utf16le")]),
      "starts with a byte order mark",
    ],
    [
      "a trailing NUL",
      Buffer.concat([Buffer.from("export const a = 1;\n"), Buffer.from([0])]),
      "holds a NUL byte",
    ],
    [
      "trailing invalid bytes",
      Buffer.concat([Buffer.from("export const a = 1;\n"), Buffer.from([0xc3, 0x28])]),
      "is not valid UTF-8",
    ],
  ])("%s", (_, bytes, what) => {
    const root = tempDir("vimma-layering-");
    const vimma = join(root, "src/browser/base/content/vimma");
    mkdirSync(join(vimma, "ui"), { recursive: true });
    writeFileSync(join(vimma, "jar.mn"), "browser.jar:\n");
    writeFileSync(join(vimma, "ui/README.md"), "");
    writeFileSync(join(vimma, "ui/a.mjs"), bytes);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    expect(treeErrors(root).errors.join("\n")).toContain(`vimma/ui/a.mjs: ${what}`);
  });
});
