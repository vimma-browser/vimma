import { describe, test, expect } from "vitest";
import {
  BLOCK_KINDS,
  classifyBlock,
  pickBlocks,
  parentBlock,
  childBlock,
  adjacentBlock,
  needsBlockText,
  blockAround,
  blockObject,
} from "../src/page/blocks.mjs";

/**
 * A descriptor tree from a nested shorthand: [tag, props?, ...children]. Every element is on
 * screen unless it says `onScreen: false`. Indices are in document order.
 */
function tree(node: any) {
  const out: any[] = [];
  const names: Map<string, number> = new Map();
  const add = (n: any, parent: number) => {
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
  return { descs: out, at: (n: string) => names.get(n) as number };
}

/** A leaf with visible text of its own. */
const T = { directText: true, text: true };

const picked = (t: ReturnType<typeof tree>) =>
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

describe("adjacentBlock: the walks of j and k", () => {
  const t = tree([
    "body",
    ["h2", { name: "h", ...T }],
    ["p", { name: "p1", ...T }],
    [
      "ul",
      { name: "ul" },
      ["li", { name: "li1", text: true }, ["p", { name: "lp1", ...T }]],
      ["li", { name: "li2", text: true }, ["p", { name: "lp2", ...T }]],
    ],
    ["p", { name: "hidden", onScreen: false, ...T }],
    ["pre", { name: "pre", text: true }, ["div", { name: "line", ...T }]],
    ["p", { name: "p2", ...T }],
  ]);

  test("j: the next labelled block in document order, k the previous", () => {
    expect(adjacentBlock(t.descs, t.at("h"), 1)).toBe(t.at("p1"));
    expect(adjacentBlock(t.descs, t.at("p1"), 1)).toBe(t.at("lp1"));
    expect(adjacentBlock(t.descs, t.at("lp2"), 1)).toBe(t.at("pre"));
    expect(adjacentBlock(t.descs, t.at("p2"), -1)).toBe(t.at("pre"));
    expect(adjacentBlock(t.descs, t.at("lp1"), -1)).toBe(t.at("p1"));
  });

  test("hidden blocks and the lines of a code block are stepped over", () => {
    expect(adjacentBlock(t.descs, t.at("pre"), 1)).toBe(t.at("p2"));
    expect(adjacentBlock(t.descs, t.at("pre"), -1)).toBe(t.at("lp2"));
  });

  test("from a block reached with +, j leaves it and k never lands inside or around it", () => {
    expect(adjacentBlock(t.descs, t.at("ul"), 1)).toBe(t.at("pre"));
    expect(adjacentBlock(t.descs, t.at("ul"), -1)).toBe(t.at("p1"));
    expect(adjacentBlock(t.descs, t.at("li2"), -1)).toBe(t.at("lp1"));
  });

  test("a count steps that many, and stops at the last block there is", () => {
    expect(adjacentBlock(t.descs, t.at("h"), 3)).toBe(t.at("lp2"));
    expect(adjacentBlock(t.descs, t.at("h"), 99)).toBe(t.at("p2"));
    expect(adjacentBlock(t.descs, t.at("p2"), -99)).toBe(t.at("h"));
  });

  test("no block further: -1", () => {
    expect(adjacentBlock(t.descs, t.at("p2"), 1)).toBe(-1);
    expect(adjacentBlock(t.descs, t.at("h"), -1)).toBe(-1);
    expect(adjacentBlock(t.descs, 999, 1)).toBe(-1);
  });
});

describe("blockAround / blockObject: ip and ap in copy mode", () => {
  // The chain from body to the element holding the caret, as the child describes it.
  const chain = (...links: any[]) => {
    let node = links[links.length - 1];
    for (let i = links.length - 2; i >= 0; i--) node = [...links[i], node];
    return tree(node);
  };

  test("ip: the innermost block around the caret, through inline ancestors", () => {
    const t = chain(
      ["body", { textLength: 100 }],
      ["section", { name: "section", textLength: 60 }],
      ["p", { name: "p", textLength: 20, ...T }],
      ["em", { name: "em", display: "inline", textLength: 5, ...T }],
    );
    expect(blockAround(t.descs, t.at("em"))).toBe(t.at("p"));
    expect(blockAround(t.descs, t.at("p"))).toBe(t.at("p"));
  });

  test("ip: a list item's paragraph, not the item", () => {
    const t = chain(
      ["body"],
      ["li", { name: "li", text: true, textLength: 30 }],
      ["p", { name: "p", textLength: 20, ...T }],
    );
    expect(blockAround(t.descs, t.at("p"))).toBe(t.at("p"));
  });

  test("ip: a generic leaf div with text of its own", () => {
    const t = chain(["body"], ["div"], ["div", { name: "chat", ...T }]);
    expect(blockAround(t.descs, t.at("chat"))).toBe(t.at("chat"));
  });

  test("ip: a code block is one block, whatever line the caret is on", () => {
    const t = chain(
      ["body"],
      ["pre", { name: "pre", text: true }],
      ["div", { name: "line", ...T }],
      ["span", { name: "tok", display: "inline", ...T }],
    );
    expect(blockAround(t.descs, t.at("tok"))).toBe(t.at("pre"));
    expect(blockAround(t.descs, t.at("line"))).toBe(t.at("pre"));
  });

  test("ip: nothing in an editable region, an aria-hidden one or a control", () => {
    const edit = chain(
      ["body"],
      ["div", { editable: true, ...T }],
      ["p", { name: "p", editable: true, ...T }],
    );
    expect(blockAround(edit.descs, edit.at("p"))).toBe(-1);
    const hidden = chain(["body"], ["div", { ariaHidden: true }], ["p", { name: "p", ...T }]);
    expect(blockAround(hidden.descs, hidden.at("p"))).toBe(-1);
    const button = chain(["body"], ["p", T], ["button", { name: "b", ...T }]);
    expect(blockAround(button.descs, button.at("b"))).toBe(-1);
  });

  test("ip: no block around text straight in body", () => {
    const t = chain(["body", { name: "body", ...T }]);
    expect(blockAround(t.descs, t.at("body"))).toBe(-1);
    expect(blockAround(t.descs, 5)).toBe(-1);
  });

  const nested = chain(
    ["body", { textLength: 200 }],
    ["article", { name: "article", textLength: 120 }],
    ["section", { name: "section", textLength: 60 }],
    ["p", { name: "p", textLength: 20, ...T }],
  );

  test("ap: the block around the caret when the selection does not cover it", () => {
    expect(blockObject(nested.descs, nested.at("p"), true, () => false)).toBe(nested.at("p"));
    expect(blockObject(nested.descs, nested.at("p"), false, () => true)).toBe(nested.at("p"));
  });

  test("ap again: grows to the parent block while the selection covers the block", () => {
    const covered = new Set([nested.at("p")]);
    expect(blockObject(nested.descs, nested.at("p"), true, (i) => covered.has(i))).toBe(
      nested.at("section"),
    );
    covered.add(nested.at("section"));
    expect(blockObject(nested.descs, nested.at("p"), true, (i) => covered.has(i))).toBe(
      nested.at("article"),
    );
  });

  test("ap at the outermost block keeps it", () => {
    expect(blockObject(nested.descs, nested.at("p"), true, () => true)).toBe(nested.at("article"));
  });

  test("ap with no block around the caret: none", () => {
    const t = chain(["body", { name: "body", ...T }]);
    expect(blockObject(t.descs, t.at("body"), true, () => true)).toBe(-1);
  });
});

describe("block edges", () => {
  // Plain descriptor lists: parent links as a content process might send them.
  const d = (tag: string, parent: number, props: Record<string, unknown> = {}) => ({
    tag,
    parent,
    display: "block",
    text: true,
    onScreen: true,
    ...props,
  });

  test("an element with no display, or display none, is not a block", () => {
    expect(classifyBlock(d("div", -1, { directText: true, display: "" }))).toBeNull();
    expect(classifyBlock(d("div", -1, { directText: true, display: "none" }))).toBeNull();
    expect(classifyBlock(d("div", -1, { directText: true, display: "flex" }))).toBe("block");
  });

  test("an excluded tag block, or a role that is no block, needs no text read", () => {
    expect(needsBlockText(d("p", -1, { hidden: true }))).toBe(false);
    expect(needsBlockText(d("div", -1, { role: "button" }))).toBe(false);
    expect(needsBlockText(d("div", -1, { role: "note" }))).toBe(true);
  });

  test("only role=code needs a block-level display; an inline role block is a block", () => {
    expect(classifyBlock(d("span", -1, { role: "paragraph", display: "inline" }))).toBe(
      "paragraph",
    );
    expect(classifyBlock(d("span", -1, { role: "code", display: "inline" }))).toBeNull();
  });

  test("an element that is no block does not seal what is inside it, even with a caption role", () => {
    const descs = [d("tr", -1, { role: "caption" }), d("td", 0)];
    expect(pickBlocks(descs)).toEqual([{ index: 1, kind: "cell" }]);
  });

  test("a role=caption block is taken whole", () => {
    const descs = [d("div", -1, { role: "caption" }), d("p", 0)];
    expect(pickBlocks(descs)).toEqual([{ index: 0, kind: "caption" }]);
  });

  test("a parent at index 0 counts", () => {
    expect(pickBlocks([d("li", -1), d("p", 0)])).toEqual([{ index: 1, kind: "paragraph" }]);
    expect(pickBlocks([d("pre", -1), d("p", 0)])).toEqual([{ index: 0, kind: "code" }]);
  });

  test("a parent link that is not earlier in the list is no parent", () => {
    expect(pickBlocks([d("p", 1), d("li", -1)])).toEqual([
      { index: 0, kind: "paragraph" },
      { index: 1, kind: "list item" },
    ]);
    expect(pickBlocks([d("p", 0)])).toEqual([{ index: 0, kind: "paragraph" }]);
    expect(pickBlocks([d("li", -1), d("p", 0.5)])).toEqual([
      { index: 0, kind: "list item" },
      { index: 1, kind: "paragraph" },
    ]);
  });

  test("+ from no element, to a parent at index 0, and never to html", () => {
    expect(parentBlock([], 0)).toBe(-1);
    const descs = [d("div", -1, { textLength: 10 }), d("p", 0, { textLength: 5 })];
    expect(parentBlock(descs, 1)).toBe(0);
    const html = [d("html", -1, { textLength: 10 }), d("p", 0, { textLength: 5 })];
    expect(parentBlock(html, 1)).toBe(-1);
  });

  test("+ through parent links in a circle ends", () => {
    const circle = [
      d("span", 1, { display: "inline", textLength: 1 }),
      d("span", 0, { display: "inline", textLength: 1 }),
    ];
    expect(parentBlock(circle, 0)).toBe(-1);
  });

  test("- looks only after the element, and finds a child of the first element", () => {
    expect(childBlock([d("p", 1), d("div", -1)], 1)).toBe(-1);
    expect(childBlock([d("div", -1), d("p", 0)], 0)).toBe(1);
  });

  test("- through a parent link past the list or in a circle finds nothing", () => {
    expect(childBlock([d("div", -1), d("div", -1), d("p", 99)], 1)).toBe(-1);
    expect(childBlock([d("div", -1), d("p", 2), d("span", 1)], 0)).toBe(-1);
  });

  test("j and k need an element and a whole, non-zero count", () => {
    const descs = [d("p", -1), d("p", -1), d("p", -1)];
    expect(adjacentBlock(descs, 1, 1)).toBe(2);
    expect(adjacentBlock(descs, -1, 1)).toBe(-1);
    expect(adjacentBlock(descs, 1, 0)).toBe(-1);
    expect(adjacentBlock(descs, 1, 1.5)).toBe(-1);
  });

  test("ip finds a code block at index 0 around the caret", () => {
    expect(blockAround([d("pre", -1), d("span", 0)], 1)).toBe(0);
  });

  test("ip follows only parent links earlier in the list", () => {
    expect(blockAround([d("p", 1), d("textarea", -1)], 0)).toBe(0);
    expect(blockAround([d("p", 0.5), d("textarea", -1)], 0)).toBe(0);
  });

  test("ap climbs to a parent block at index 0", () => {
    const descs = [d("div", -1, { textLength: 10 }), d("p", 0, { textLength: 5 })];
    expect(blockObject(descs, 1, true, () => true)).toBe(0);
  });

  test("ap climbs from a block at index 0", () => {
    const descs = [
      d("p", 2, { textLength: 5 }),
      d("span", -1, { display: "inline" }),
      d("div", -1, { textLength: 10 }),
    ];
    expect(blockObject(descs, 0, true, () => true)).toBe(2);
  });
});
