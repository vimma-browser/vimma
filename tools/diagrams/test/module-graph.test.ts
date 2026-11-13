import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { tempDir } from "../../test/temp-dir.mjs";
import {
  type Edge,
  cycleGroups,
  folderEdges,
  folderOf,
  importsOf,
  readVimmaFiles,
  toD2,
} from "../module-graph.ts";

const CHROME = "chrome://browser/content/vimma";
// Writes a relative specifier into the fixtures below, so that the scan of tools/ for relative
// imports of missing files (tools/test/typescript-tools.test.mjs) does not read them as this
// file's own imports.
const q = (spec: string): string => JSON.stringify(spec);

describe("importsOf", () => {
  test("a static import and an export-from are eager", () => {
    const code = [
      `import { A } from ${q("../host/VimmaHost.sys.mjs")};`,
      `import ${q("./side-effect.mjs")};`,
      `export { B } from "${CHROME}/ui/notice.mjs";`,
      `export * from ${q("../core/keys.mjs")};`,
    ].join("\n");
    expect(importsOf(code)).toEqual([
      { spec: "../host/VimmaHost.sys.mjs", kind: "eager" },
      { spec: "./side-effect.mjs", kind: "eager" },
      { spec: `${CHROME}/ui/notice.mjs`, kind: "eager" },
      { spec: "../core/keys.mjs", kind: "eager" },
    ]);
  });

  test("importESModule at the top of a module is eager, inside a function lazy", () => {
    const code = [
      `const { A } = ChromeUtils.importESModule("${CHROME}/agent/AgentChat.sys.mjs");`,
      `export function later() {`,
      `  return ChromeUtils.importESModule("${CHROME}/ctl/AgentGate.sys.mjs");`,
      `}`,
      `const f = () => ChromeUtils.importESModule("${CHROME}/ui/prompt.mjs");`,
    ].join("\n");
    expect(importsOf(code)).toEqual([
      { spec: `${CHROME}/agent/AgentChat.sys.mjs`, kind: "eager" },
      { spec: `${CHROME}/ctl/AgentGate.sys.mjs`, kind: "lazy" },
      { spec: `${CHROME}/ui/prompt.mjs`, kind: "lazy" },
    ]);
  });

  test("an eager import inside a top-level block or class body stays eager", () => {
    const code = [
      `if (globalThis.x) { ChromeUtils.importESModule("${CHROME}/a/A.sys.mjs"); }`,
      `class K { static field = ChromeUtils.importESModule("${CHROME}/b/B.sys.mjs"); }`,
      `class L { m() { ChromeUtils.importESModule("${CHROME}/c/C.sys.mjs"); } }`,
    ].join("\n");
    expect(importsOf(code).map((i) => i.kind)).toEqual(["eager", "eager", "lazy"]);
  });

  test("lazy getters and dynamic import() inside a function are lazy", () => {
    const code = [
      `const lazy = {};`,
      `ChromeUtils.defineESModuleGetters(lazy, {`,
      `  AgentChat: "${CHROME}/agent/AgentChat.sys.mjs",`,
      `  Other: "resource://gre/modules/Other.sys.mjs",`,
      `});`,
      `async function f() { await import(${q("../ui/side-panel.mjs")}); }`,
    ].join("\n");
    expect(importsOf(code)).toEqual([
      { spec: `${CHROME}/agent/AgentChat.sys.mjs`, kind: "lazy" },
      { spec: "resource://gre/modules/Other.sys.mjs", kind: "lazy" },
      { spec: "../ui/side-panel.mjs", kind: "lazy" },
    ]);
  });

  test("a classic script (vimma.js) is read too", () => {
    const code = [
      `var x = 1;`,
      `with (Math) { x = PI; }`,
      `ChromeUtils.importESModule("${CHROME}/host/VimmaHost.sys.mjs");`,
    ].join("\n");
    expect(importsOf(code)).toEqual([{ spec: `${CHROME}/host/VimmaHost.sys.mjs`, kind: "eager" }]);
  });

  test("a specifier that is not a string literal fails, so no edge goes unseen", () => {
    expect(() => importsOf("const p = 'x'; ChromeUtils.importESModule(p);")).toThrow(
      /line 1: .*not a string literal/,
    );
    expect(() => importsOf("ChromeUtils.defineESModuleGetters(lazy, { A: p });")).toThrow(
      /not a string literal/,
    );
    // A template literal with no substitution is a fixed string.
    expect(importsOf("import(`../ui/a.mjs`);")).toEqual([{ spec: "../ui/a.mjs", kind: "eager" }]);
  });
});

describe("folderOf", () => {
  test("relative and chrome:// specifiers name the folder under vimma/", () => {
    expect(folderOf("../host/VimmaHost.sys.mjs", "ctl/VimmaControl.sys.mjs")).toBe("host");
    expect(folderOf("./runners.mjs", "host/VimmaHost.sys.mjs")).toBe("host");
    expect(folderOf("../core/keys.mjs", "host/hypr/HyprIpc.sys.mjs")).toBe("host");
    expect(folderOf("../../core/keys.mjs", "host/hypr/HyprIpc.sys.mjs")).toBe("core");
    expect(folderOf(`${CHROME}/ui/notice.mjs`, "agent/AgentChat.sys.mjs")).toBe("ui");
    expect(folderOf("./host/VimmaHost.sys.mjs", "vimma.js")).toBe("host");
  });

  test("a file at the top of vimma/ is its own node; Firefox's modules are none", () => {
    expect(folderOf(`${CHROME}/vimma.js`, "host/VimmaHost.sys.mjs")).toBe("vimma.js");
    expect(folderOf("resource://gre/modules/Timer.sys.mjs", "host/a.mjs")).toBeNull();
    expect(folderOf("chrome://browser/content/browser.js", "host/a.mjs")).toBeNull();
    expect(folderOf("../../other.mjs", "host/a.mjs")).toBeNull();
  });
});

describe("folderEdges", () => {
  test("one edge per pair of folders, eager when any import is, sorted, none to itself", () => {
    const files = [
      {
        path: "ctl/VimmaControl.sys.mjs",
        code: [
          `import { H } from ${q("../host/VimmaHost.sys.mjs")};`,
          `import { G } from ${q("./AgentGate.sys.mjs")};`,
          `const lazy = {};`,
          `ChromeUtils.defineESModuleGetters(lazy, { U: "${CHROME}/ui/notice.mjs" });`,
          `function f() { ChromeUtils.importESModule("${CHROME}/host/runners.mjs"); }`,
        ].join("\n"),
      },
      {
        path: "host/VimmaHost.sys.mjs",
        code: [
          `ChromeUtils.defineESModuleGetters({}, { C: "${CHROME}/ctl/VimmaControl.sys.mjs" });`,
          `import { U } from ${q("../ui/notice.mjs")};`,
        ].join("\n"),
      },
      { path: "ui/notice.mjs", code: `import { k } from ${q("../core/keys.mjs")};` },
    ];
    expect(folderEdges(files)).toEqual([
      { from: "ctl", to: "host", kind: "eager" },
      { from: "ctl", to: "ui", kind: "lazy" },
      { from: "host", to: "ctl", kind: "lazy" },
      { from: "host", to: "ui", kind: "eager" },
      { from: "ui", to: "core", kind: "eager" },
    ]);
  });

  test("a parse error names the file", () => {
    expect(() => folderEdges([{ path: "ui/bad.mjs", code: "import {" }])).toThrow(/ui\/bad\.mjs/);
  });
});

describe("cycleGroups", () => {
  const e = (from: string, to: string, kind: Edge["kind"] = "eager"): Edge => ({ from, to, kind });

  test("the folders that reach each other through eager imports, largest group first", () => {
    const edges = [
      e("a", "b"),
      e("b", "a"),
      e("host", "ui"),
      e("ui", "agent"),
      e("agent", "host"),
      e("ui", "core"),
      e("x", "core"),
    ];
    expect(cycleGroups(edges)).toEqual([
      ["agent", "host", "ui"],
      ["a", "b"],
    ]);
  });

  test("a loop closed only by a lazy import is not an eager cycle", () => {
    expect(cycleGroups([e("host", "ctl"), e("ctl", "host", "lazy")])).toEqual([]);
    expect(cycleGroups([e("host", "ctl"), e("ctl", "host", "lazy")], "any")).toEqual([
      ["ctl", "host"],
    ]);
  });
});

describe("toD2", () => {
  const e = (from: string, to: string, kind: Edge["kind"] = "eager"): Edge => ({ from, to, kind });
  const edges: Edge[] = [
    // host/ and ui/ import each other eagerly; ctl/ imports host/, which imports it back lazily.
    e("host", "ui"),
    e("ui", "host"),
    e("ctl", "host"),
    e("host", "ctl", "lazy"),
    // Both members of the cycle import split/; only host/ imports search/.
    e("host", "split"),
    e("ui", "split"),
    e("host", "search", "lazy"),
    e("start", "ui"),
    // Summarised in the legend, not drawn.
    e("vimma.js", "host"),
    e("vimma.js", "ctl"),
    e("vimma.js", "ui"),
    e("vimma.js", "split"),
    e("vimma.js", "search"),
    e("vimma.js", "start"),
    e("host", "core"),
    e("ui", "core"),
    e("ctl", "core"),
    e("split", "core"),
    e("search", "core"),
  ];
  const d2 = toD2(edges);

  test("says it is generated and how to regenerate it", () => {
    expect(d2.split("\n")[0]).toMatch(/^# Generated by npm run diagrams/);
  });

  test("puts each eager cycle in a box of its own, with its edges inside", () => {
    expect(d2).toContain(`cycle1: "Eager import cycle: 2 folders" {`);
    expect(d2).toContain(`  host: "host/" { class: folder }`);
    expect(d2).toContain(`  ui: "ui/" { class: folder }`);
    expect(d2).toContain(`cycle1.host -> cycle1.ui { class: cycle-edge }`);
    expect(d2).toContain(`cycle1.ui -> cycle1.host { class: cycle-edge }`);
  });

  test("draws the folders outside a cycle, and edges into it to the folder they reach", () => {
    expect(d2).toContain(`ctl: "ctl/" { class: folder }`);
    expect(d2).toContain(`ctl -> cycle1.host { class: eager }`);
    expect(d2).toContain(`ctl <- cycle1.host { class: lazy }`);
    expect(d2).toContain(`start -> cycle1.ui { class: eager }`);
  });

  test("an edge out of a cycle that several of its folders share starts at the box", () => {
    expect(d2).toContain(`cycle1 -> split { class: eager }`);
    expect(d2).not.toContain(`cycle1.host -> split`);
    expect(d2).toContain(`search <- cycle1.host { class: lazy }`);
  });

  test("writes a lazy edge target first, so that only eager imports set the layers", () => {
    expect(d2).not.toMatch(/-> .* class: lazy/);
    expect(d2.match(/ <- .* class: lazy/g)).toHaveLength(2);
  });

  test("leaves vimma.js and core/ out of the drawing and says what they import", () => {
    expect(d2).not.toMatch(/^vimma_js|^core|-> core/m);
    expect(d2).toContain("vimma.js imports every folder drawn here.");
    expect(d2).toContain("core/ is imported by every folder drawn here except start/.");
  });

  test("a folder that imports only core/ is drawn alone", () => {
    const alone = toD2([...edges, e("services", "core"), e("vimma.js", "services")]);
    expect(alone).toContain(`services: "services/" { class: folder }`);
    expect(alone).not.toMatch(/services ->/);
  });

  test("names what vimma.js leaves out, when it does", () => {
    const fewer = toD2(
      edges.filter((x) => !(x.from === "vimma.js" && ["search", "start"].includes(x.to))),
    );
    expect(fewer).toContain("vimma.js imports every folder drawn here except search/ and start/.");
  });

  test("the same edges in any order give the same text", () => {
    expect(toD2([...edges].reverse())).toBe(d2);
  });
});

describe("readVimmaFiles", () => {
  test("reads the tracked JavaScript under vimma/, with paths relative to it", () => {
    const root = tempDir("vimma-module-graph-");
    const put = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-q");
    put("src/browser/base/content/vimma/vimma.js", "1;");
    put("src/browser/base/content/vimma/host/VimmaHost.sys.mjs", "2;");
    put("src/browser/base/content/vimma/ui/notice.mjs", "3;");
    put("src/browser/base/content/vimma/start/start.html", "<p>");
    put("src/browser/base/content/vimma/core/keys.mjs", "ignored, not tracked");
    put("src/other.mjs", "outside");
    git("add", "src/browser/base/content/vimma/vimma.js", "src/browser/base/content/vimma/host");
    git("add", "src/browser/base/content/vimma/ui", "src/browser/base/content/vimma/start");
    git("add", "src/other.mjs");
    expect(readVimmaFiles(root)).toEqual([
      { path: "host/VimmaHost.sys.mjs", code: "2;" },
      { path: "ui/notice.mjs", code: "3;" },
      { path: "vimma.js", code: "1;" },
    ]);
  });
});
