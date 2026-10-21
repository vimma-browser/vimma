import { describe, test, expect } from "vitest";
import {
  BLOCK_KINDS,
  classifyBlock,
  pickBlocks,
  parentBlock,
  childBlock,
  needsBlockText,
} from "../src/blocks.mjs";

/**
 * A descriptor tree from a nested shorthand: [tag, props?, ...children]. Every element is on
 * screen unless it says `onScreen: false`. Indices are in document order.
 * @param {any} node
 */
function tree(node) {
  /** @type {any[]} */
  const out = [];
  /** @type {Map<string, number>} */
  const names = new Map();
  /**
   * @param {any} n
   * @param {number} parent
   */
  const add = (n, parent) => {
    const [tag, maybeProps, ...rest] = n;
    const hasProps = maybeProps && typeof maybeProps === "object" && !Array.isArray(maybeProps);
    const props = hasProps ? maybeProps : {};
    const children = hasProps ? rest : [maybeProps, ...rest].filter(Boolean);
    const index = out.length;
    out.push({ parent, tag, display: "block", onScreen: true, ...props });
    if (props.name) names.set(props.name, index);
    for (const c of children) add(c, index);
  };
  add(node, -1);
  return { descs: out, at: (/** @type {string} */ n) => /** @type {number} */ (names.get(n)) };
}

/** A leaf with visible text of its own. */
const T = { directText: true, text: true };

/**
 * @param {ReturnType<typeof tree>} t
 */
const picked = (t) =>
  pickBlocks(t.descs).map((b) => `${t.descs[b.index].name ?? t.descs[b.index].tag}:${b.kind}`);

describe("classifyBlock: what a text block is", () => {
  test.each([
    ["p", "paragraph"],
    ["h1", "heading"],
    ["h6", "heading"],
    ["li", "list item"],
    ["dt", "list item"],
    ["dd", "list item"],
    ["blockquote", "quote"],
    ["pre", "code"],
    ["figcaption", "caption"],
    ["caption", "caption"],
    ["td", "cell"],
    ["th", "cell"],
    ["summary", "block"],
    ["address", "block"],
  ])("<%s> is a %s", (tag, kind) => {
    expect(classifyBlock({ parent: -1, tag, text: true })).toBe(kind);
  });

  test.each([
    ["paragraph", "paragraph"],
    ["heading", "heading"],
    ["listitem", "list item"],
    ["blockquote", "quote"],
    ["code", "code"],
    ["cell", "cell"],
    ["gridcell", "cell"],
    ["rowheader", "cell"],
    ["columnheader", "cell"],
    ["caption", "caption"],
    ["note", "block"],
  ])("[role=%s] is a %s", (role, kind) => {
    expect(classifyBlock({ parent: -1, tag: "div", role, text: true, display: "block" })).toBe(
      kind,
    );
  });

  test("an inline [role=code] is not a block", () => {
    expect(
      classifyBlock({ parent: -1, tag: "span", role: "code", text: true, display: "inline" }),
    ).toBeNull();
  });

  test("a tag or role block with no visible text is not a block", () => {
    expect(classifyBlock({ parent: -1, tag: "p", text: false })).toBeNull();
    expect(classifyBlock({ parent: -1, tag: "td" })).toBeNull();
  });

  test("a generic block-level element with a direct text child is a block", () => {
    expect(classifyBlock({ parent: -1, tag: "div", display: "block", ...T })).toBe("block");
    expect(classifyBlock({ parent: -1, tag: "div", display: "flex", ...T })).toBe("block");
    expect(classifyBlock({ parent: -1, tag: "code", display: "block", ...T })).toBe("code");
  });

  test("a generic element without a direct text child, or inline, is not a block", () => {
    expect(classifyBlock({ parent: -1, tag: "div", display: "block", text: true })).toBeNull();
    expect(classifyBlock({ parent: -1, tag: "span", display: "inline", ...T })).toBeNull();
    expect(classifyBlock({ parent: -1, tag: "div", display: "contents", ...T })).toBeNull();
    expect(classifyBlock({ parent: -1, tag: "rt", display: "ruby-text", ...T })).toBeNull();
    expect(classifyBlock({ parent: -1, tag: "div", ...T })).toBeNull(); // display unknown
  });

  test.each([
    "html",
    "body",
    "script",
    "style",
    "template",
    "textarea",
    "input",
    "select",
    "button",
    "option",
    "svg",
    "canvas",
    "iframe",
    "tr",
    "table",
  ])("<%s> is never a block", (tag) => {
    expect(classifyBlock({ parent: -1, tag, display: "block", ...T })).toBeNull();
  });

  test("hidden, aria-hidden and editable elements are never blocks", () => {
    expect(classifyBlock({ parent: -1, tag: "p", hidden: true, ...T })).toBeNull();
    expect(classifyBlock({ parent: -1, tag: "p", ariaHidden: true, ...T })).toBeNull();
    expect(classifyBlock({ parent: -1, tag: "p", editable: true, ...T })).toBeNull();
  });

  test("the kinds are a closed list", () => {
    expect(BLOCK_KINDS).toEqual([
      "paragraph",
      "heading",
      "list item",
      "quote",
      "code",
      "cell",
      "caption",
      "block",
    ]);
  });

  test("needsBlockText: the child reads text and display only where they decide", () => {
    expect(needsBlockText({ parent: -1, tag: "p" })).toBe(true);
    expect(needsBlockText({ parent: -1, tag: "div", role: "note" })).toBe(true);
    expect(needsBlockText({ parent: -1, tag: "div" })).toBe(false);
    expect(needsBlockText({ parent: -1, tag: "script" })).toBe(false);
  });
});

describe("pickBlocks: one label per innermost text block", () => {
  test("innermost wins: an li holding two p gets two labels, not three", () => {
    const t = tree([
      "body",
      [
        "ul",
        ["li", { name: "li", ...T }, ["p", { name: "p1", ...T }], ["p", { name: "p2", ...T }]],
      ],
    ]);
    expect(picked(t)).toEqual(["p1:paragraph", "p2:paragraph"]);
  });

  test("an li with only inline content is the block", () => {
    const t = tree([
      "body",
      [
        "ul",
        ["li", { name: "a", ...T }, ["span", { display: "inline", ...T }]],
        ["li", { name: "b", ...T }],
      ],
    ]);
    expect(picked(t)).toEqual(["a:list item", "b:list item"]);
  });

  test("a pre highlighted with per-line divs is one code block", () => {
    const t = tree([
      "body",
      [
        "pre",
        { name: "pre", text: true },
        ["div", { name: "gutter", ...T }],
        ["div", T],
        ["div", T],
        ["div", T],
      ],
    ]);
    expect(picked(t)).toEqual(["pre:code"]);
  });

  test("a block code and [role=code] are atomic too, and so is a table caption", () => {
    const t = tree([
      "body",
      ["code", { name: "code", display: "block", ...T }, ["div", T]],
      ["div", { name: "rc", role: "code", text: true }, ["p", T]],
      ["table", ["caption", { name: "cap", text: true }, ["p", T]]],
    ]);
    expect(picked(t)).toEqual(["code:code", "rc:code", "cap:caption"]);
  });

  test("table rows get no label; cells do", () => {
    const t = tree([
      "body",
      ["table", ["tbody", ["tr", T, ["td", { name: "a", ...T }], ["td", { name: "b", ...T }]]]],
    ]);
    expect(picked(t)).toEqual(["a:cell", "b:cell"]);
  });

  test("a contenteditable host and everything in it are left out", () => {
    const t = tree([
      "body",
      ["div", { editable: true, ...T }, ["p", { editable: true, ...T }]],
      ["p", { name: "ok", ...T }],
    ]);
    expect(picked(t)).toEqual(["ok:paragraph"]);
  });

  test("anything inside hidden, aria-hidden, a button or an svg is left out", () => {
    const t = tree([
      "body",
      ["div", { ariaHidden: true }, ["p", T]],
      ["div", { hidden: true }, ["p", T]],
      ["button", ["div", T]],
      ["svg", ["div", T]],
      ["p", { name: "ok", ...T }],
    ]);
    expect(picked(t)).toEqual(["ok:paragraph"]);
  });

  test("generic leaf divs: a chat line is a block, its wrapper is not", () => {
    const t = tree([
      "body",
      ["div", ["div", { name: "line1", ...T }], ["div", { name: "line2", ...T }]],
    ]);
    expect(picked(t)).toEqual(["line1:block", "line2:block"]);
  });

  test("an off-screen inner block does not take its parent's label, and gets none itself", () => {
    const t = tree(["body", ["li", { name: "li", ...T }, ["p", { onScreen: false, ...T }]]]);
    expect(picked(t)).toEqual(["li:list item"]);
  });

  test("results are in descriptor (document) order", () => {
    const t = tree(["body", ["h2", { name: "h", ...T }], ["p", { name: "p", ...T }]]);
    expect(pickBlocks(t.descs)).toEqual([
      { index: t.at("h"), kind: "heading" },
      { index: t.at("p"), kind: "paragraph" },
    ]);
  });

  test("a parent index that is not earlier in the list is ignored, never a loop", () => {
    const descs = [
      { parent: 1, tag: "p", onScreen: true, ...T },
      { parent: 0, tag: "div" },
    ];
    expect(pickBlocks(descs)).toEqual([{ index: 0, kind: "paragraph" }]);
  });
});

describe("parentBlock / childBlock: the walks of + and -", () => {
  const t = tree([
    "body",
    { name: "body", textLength: 100 },
    [
      "section",
      { name: "section", textLength: 60 },
      [
        "ul",
        { name: "ul", textLength: 40 },
        [
          "li",
          { name: "li", textLength: 20, text: true },
          ["div", { name: "wrap", textLength: 20 }, ["p", { name: "p", textLength: 20, ...T }]],
        ],
        ["li", { name: "li2", textLength: 20, ...T }],
      ],
    ],
  ]);

  test("+ climbs to the nearest block-level ancestor with more text, skipping wrappers", () => {
    expect(parentBlock(t.descs, t.at("p"))).toBe(t.at("ul"));
    expect(parentBlock(t.descs, t.at("ul"))).toBe(t.at("section"));
  });

  test("+ stops below body", () => {
    expect(parentBlock(t.descs, t.at("section"))).toBe(-1);
  });

  test("+ skips inline ancestors", () => {
    const u = tree([
      "body",
      [
        "div",
        { name: "d", textLength: 30 },
        ["span", { display: "inline", textLength: 25 }, ["p", { name: "p", textLength: 10, ...T }]],
      ],
    ]);
    expect(parentBlock(u.descs, u.at("p"))).toBe(u.at("d"));
  });

  test("+ crosses a shadow host only when the host is a block", () => {
    const block = tree([
      "body",
      [
        "div",
        { name: "host", textLength: 30 },
        ["p", { name: "p", host: true, textLength: 10, ...T }],
      ],
    ]);
    expect(parentBlock(block.descs, block.at("p"))).toBe(block.at("host"));
    const inline = tree([
      "body",
      [
        "div",
        { textLength: 30 },
        [
          "x-card",
          { display: "inline", textLength: 20 },
          ["p", { name: "p", host: true, textLength: 10, ...T }],
        ],
      ],
    ]);
    expect(parentBlock(inline.descs, inline.at("p"))).toBe(-1);
  });

  test("- goes to the first block inside, in document order", () => {
    expect(childBlock(t.descs, t.at("ul"))).toBe(t.at("li"));
    expect(childBlock(t.descs, t.at("li"))).toBe(t.at("p"));
    expect(childBlock(t.descs, t.at("p"))).toBe(-1);
  });
});
