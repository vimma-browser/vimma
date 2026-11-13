import { afterEach, describe, expect, it, vi } from "vitest";
import { contentFocusField, jsonLiteral, probe } from "../probes.mjs";

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
    const src = probe((/** @type {unknown} */ a) => a, nasty);
    expect(src).toContain(jsonLiteral(nasty));
    expect(src).not.toContain("</script>");
  });
});

// contentFocusField runs in the page; these stand in for the few DOM calls it makes.
describe("contentFocusField", () => {
  /**
   * A fake element that takes the focus unless `refuses`.
   * @param {string} tag @param {Record<string, string>} attrs @param {boolean} [refuses]
   */
  const field = (tag, attrs, refuses = false) => ({
    tagName: tag.toUpperCase(),
    id: attrs.id ?? "",
    getAttribute: (/** @type {string} */ n) => attrs[n] ?? null,
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
    focus() {
      if (!refuses) doc.activeElement = this;
    },
  });
  /** @type {{ activeElement: unknown, querySelectorAll: (s: string) => unknown[] }} */
  const doc = { activeElement: null, querySelectorAll: () => [] };
  /** @param {unknown[][]} lists what each selector list the probe asks for matches, in turn */
  const page = (...lists) => {
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
