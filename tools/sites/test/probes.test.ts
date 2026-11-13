import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Script, createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentFocusField, jsonLiteral, probe } from "../probes.ts";

// probe() builds source text for the browser to evaluate, with the argument embedded as a
// literal. The literal must decode to the same value and carry no character that could end the
// surrounding code early when it is embedded elsewhere (CodeQL js/bad-code-sanitization).
describe("probe source", () => {
  const nasty = { s: "</script><!--     `${x}` \\ \" ' /", n: [1, null, true] };

  it("embeds the argument as a literal that decodes to the same value", () => {
    expect(JSON.parse(jsonLiteral(nasty))).toEqual(nasty);
  });

  it("escapes <, >, / and the line separators in the literal", () => {
    const lit = jsonLiteral(nasty);
    for (const ch of ["<", ">", "/", " ", " "]) expect(lit).not.toContain(ch);
  });

  it("uses that literal in the probe source", () => {
    const src = probe((a: unknown) => a, nasty);
    expect(src).toContain(jsonLiteral(nasty));
    expect(src).not.toContain("</script>");
  });
});

// contentFocusField runs in the page; these stand in for the few DOM calls it makes.
describe("contentFocusField", () => {
  /** A fake element that takes the focus unless `refuses`. */
  const field = (tag: string, attrs: Record<string, string>, refuses: boolean = false) => ({
    tagName: tag.toUpperCase(),
    id: attrs.id ?? "",
    getAttribute: (n: string) => attrs[n] ?? null,
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
    focus() {
      if (!refuses) doc.activeElement = this;
    },
  });
  const doc: { activeElement: unknown; querySelectorAll: (s: string) => unknown[] } = {
    activeElement: null,
    querySelectorAll: () => [],
  };
  /** @param lists what each selector list the probe asks for matches, in turn */
  const page = (...lists: unknown[][]) => {
    let call = 0;
    doc.activeElement = null;
    doc.querySelectorAll = () => lists[call++] ?? [];
    vi.stubGlobal("document", doc);
    vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible", display: "block" }));
  };
  afterEach(() => vi.unstubAllGlobals());

  it("skips a visible input that refuses the focus (regex101's hidden select input)", () => {
    page([field("input", { id: "base-ui-hidden-input" }, true), field("input", { name: "q" })]);
    expect(contentFocusField({ selector: null })).toEqual({
      found: true,
      desc: "input[name=q]",
      focused: true,
    });
  });

  it("falls back to a code editor's text box when no input takes the focus", () => {
    page([field("input", { id: "hidden" }, true)], [field("div", { id: "editor" })]);
    expect(contentFocusField({ selector: null })).toEqual({
      found: true,
      desc: "div#editor",
      focused: true,
    });
  });

  it("reports the first field it found when none takes the focus", () => {
    page([field("input", { id: "hidden" }, true)], []);
    expect(contentFocusField({ selector: null })).toEqual({
      found: true,
      desc: "input#hidden",
      focused: false,
    });
  });
});

// probes.ts is TypeScript (ADR-025), and probe() sends a function's source text to the browser,
// which cannot read type syntax. Node erases the types before it loads the module, so the text
// is the erased program: checked here in a child Node, as `npm run sites` loads the module, since
// Vitest compiles the file its own way.
describe("probe source sent from Node", () => {
  const PROBES = fileURLToPath(new URL("../probes.ts", import.meta.url));
  const sources: Record<string, string> = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(new URL("../probes.ts", import.meta.url).href)});
        const out = {};
        for (const [name, fn] of Object.entries(m))
          if (/^(content|chrome)/.test(name)) out[name] = m.probe(fn, { selector: null });
        process.stdout.write(JSON.stringify(out));`,
      ],
      { encoding: "utf8" },
    ),
  );

  it("has every content and chrome probe", () => {
    const declared = [
      ...readFileSync(PROBES, "utf8").matchAll(/^export function ((?:content|chrome)\w*)/gm),
    ];
    expect(Object.keys(sources).sort()).toEqual(declared.map((m) => m[1]).sort());
    expect(Object.keys(sources).length).toBeGreaterThan(20);
  });

  it("is plain JavaScript: each probe's text compiles, though the module has types", () => {
    for (const [name, src] of Object.entries(sources)) {
      expect(() => new Script(src, { filename: name }), name).not.toThrow();
    }
    // The checker has teeth: the same function as written in probes.ts does not compile.
    const written = /^export function contentScrollSnapshot\(\) \{\n[^]*?^\}$/m.exec(
      readFileSync(PROBES, "utf8"),
    )?.[0];
    expect(written).toMatch(/: Array</);
    expect(() => new Script(`(${(written as string).replace(/^export /, "")})`)).toThrow(
      SyntaxError,
    );
  });

  it("still evaluates: the sent contentFocusField finds the field outside Node's module", () => {
    let focused: unknown = null;
    const input = {
      tagName: "INPUT",
      id: "",
      getAttribute: (n: string) => (n === "name" ? "q" : null),
      getBoundingClientRect: () => ({ width: 100, height: 20 }),
      focus() {
        focused = this;
      },
    };
    const page = createContext({
      document: {
        get activeElement() {
          return focused;
        },
        querySelectorAll: () => [input],
      },
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    });
    expect(JSON.parse(runInContext(sources.contentFocusField as string, page))).toEqual({
      found: true,
      desc: "input[name=q]",
      focused: true,
    });
  });
});
