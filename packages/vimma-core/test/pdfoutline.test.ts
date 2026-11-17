import { describe, test, expect } from "vitest";
import {
  OUTLINE_MAX_ENTRIES,
  OUTLINE_TRUNCATED_TEXT,
  currentEntry,
  openOutline,
  outlineKey,
  outlineRows,
  outlineUrlAllowed,
  parsePdfOutline,
  selectOutlinePage,
  setOutlineQuery,
} from "../src/ui/pdfoutline.mjs";

// docs/specs/pdf-mode.md decision 10, docs/security/20-pdf-viewer.md section 20 (V8).

const e = (title: string, level: number, page: number, more: object = {}) => ({
  title,
  level,
  page,
  kind: "dest",
  collapsed: false,
  ...more,
});

// 0 Preface (1)
// 1 Chapter 1 (3)
// 2   Section 1.1 (4)
// 3     Detail (4)
// 4   Section 1.2 (5)   collapsed
// 5     Hidden (5)
// 6 Chapter 2 (6)
// 7 Website (0, url)
const ENTRIES = [
  e("Preface", 1, 1),
  e("Chapter 1", 1, 3),
  e("Section 1.1", 2, 4),
  e("Detail", 3, 4),
  e("Section 1.2", 2, 5, { collapsed: true }),
  e("Hidden", 3, 5),
  e("Chapter 2", 1, 6),
  e("Website", 1, 0, { kind: "url", url: "https://example.com/" }),
];
const raw = { entries: ENTRIES, truncated: false };
const outline = () => parsePdfOutline(raw, 6) as NonNullable<ReturnType<typeof parsePdfOutline>>;

const titles = (s: ReturnType<typeof openOutline>) => outlineRows(s).map((r) => r.title);
const selectedTitle = (s: ReturnType<typeof openOutline>) =>
  outlineRows(s).find((r) => r.selected)?.title;
function keys(s: ReturnType<typeof openOutline>, ...ids: string[]) {
  let state = s;
  let effect: any = null;
  for (const id of ids) ({ state, effect } = outlineKey(state, { id, page: 4 }));
  return { state, effect };
}

describe("parsePdfOutline", () => {
  test("accepts a full outline", () => {
    const o = outline();
    expect(o.truncated).toBe(false);
    expect(o.entries).toHaveLength(8);
    expect(o.entries[7]).toEqual({
      title: "Website",
      level: 1,
      page: 0,
      kind: "url",
      collapsed: false,
      url: "https://example.com/",
    });
    expect(o.entries[0]).not.toHaveProperty("url");
  });

  test("an empty outline is an outline with no entries", () => {
    expect(parsePdfOutline({ entries: [], truncated: false }, 3)).toEqual({
      entries: [],
      truncated: false,
    });
  });

  test("accepts every kind, and the truncated flag", () => {
    const kinds = ["dest", "action", "attachment", "ocg", "none"];
    const o = parsePdfOutline(
      { entries: kinds.map((kind) => e(kind, 1, 0, { kind })), truncated: true },
      1,
    );
    expect(o?.entries.map((x) => x.kind)).toEqual(kinds);
    expect(o?.truncated).toBe(true);
  });

  describe("an outline outside its bounds is dropped", () => {
    const many = Array.from({ length: OUTLINE_MAX_ENTRIES + 1 }, (_, i) => e(`e${i}`, 1, 1));
    const deep = Array.from({ length: 33 }, (_, i) => e(`d${i}`, i + 1, 1));
    test.each([
      ["no record", null],
      ["entries not an array", { entries: "x", truncated: false }],
      ["no truncated flag", { entries: ENTRIES }],
      ["5001 entries", { entries: many, truncated: true }],
      ["a level of 33", { entries: deep, truncated: false }],
      ["a skipped level", { entries: [e("a", 1, 1), e("b", 3, 1)], truncated: false }],
      ["a first entry below the top", { entries: [e("a", 2, 1)], truncated: false }],
      ["level 0", { entries: [e("a", 0, 1)], truncated: false }],
      ["a 513-character title", { entries: [e("x".repeat(513), 1, 1)], truncated: false }],
      ["a title that is not a string", { entries: [e(5 as any, 1, 1)], truncated: false }],
      [
        "an 8193-character URL",
        {
          entries: [e("u", 1, 0, { kind: "url", url: "https://a/" + "x".repeat(8183) })],
          truncated: false,
        },
      ],
      [
        "a URL entry without its URL",
        { entries: [e("u", 1, 0, { kind: "url" })], truncated: false },
      ],
      [
        "a URL on another kind",
        { entries: [e("u", 1, 1, { url: "https://a/" })], truncated: false },
      ],
      ["a page past the count", { entries: [e("a", 1, 7)], truncated: false }],
      ["a negative page", { entries: [e("a", 1, -1)], truncated: false }],
      ["a fractional page", { entries: [e("a", 1, 1.5)], truncated: false }],
      ["an unknown kind", { entries: [e("a", 1, 1, { kind: "script" })], truncated: false }],
      ["collapsed not a boolean", { entries: [e("a", 1, 1, { collapsed: 1 })], truncated: false }],
      ["an extra field", { entries: [e("a", 1, 1, { dest: [0] })], truncated: false }],
    ])("%s", (_name, bad) => {
      expect(parsePdfOutline(bad, 6)).toBeNull();
    });

    test("5000 entries and a level of 32 are within bounds", () => {
      expect(parsePdfOutline({ entries: many.slice(1), truncated: true }, 6)?.entries).toHaveLength(
        5000,
      );
      expect(parsePdfOutline({ entries: deep.slice(0, 32), truncated: false }, 6)).not.toBeNull();
    });
  });

  test("titles lose control and format characters, and runs of white space", () => {
    const o = parsePdfOutline(
      { entries: [e("‮evil​ \t\n title\u0007  ", 1, 1)], truncated: false },
      1,
    );
    expect(o?.entries[0]?.title).toBe("evil title");
  });
});

describe("outlineUrlAllowed", () => {
  test.each([
    ["https://example.com/a", true],
    ["http://example.com/", true],
    ["javascript:alert(1)", false],
    ["JAVASCRIPT:alert(1)", false],
    ["data:text/html,x", false],
    ["file:///etc/passwd", false],
    ["view-source:https://example.com/", false],
    ["not a url", false],
  ])("%s → %s", (url, ok) => {
    expect(outlineUrlAllowed(url)).toBe(ok);
  });
});

describe("the current entry", () => {
  test("the deepest of the last entries at or before the page", () => {
    const o = outline();
    expect(currentEntry(o, 1)).toBe(0);
    expect(currentEntry(o, 2)).toBe(0);
    expect(currentEntry(o, 3)).toBe(1);
    expect(currentEntry(o, 4)).toBe(3);
    expect(currentEntry(o, 5)).toBe(5);
    expect(currentEntry(o, 6)).toBe(6);
  });

  test("before every entry's page, the first entry", () => {
    const o = parsePdfOutline({ entries: [e("a", 1, 3)], truncated: false }, 6) as any;
    expect(currentEntry(o, 1)).toBe(0);
  });

  test("opening selects it and expands the path to it; the rest as the document says", () => {
    const s = openOutline(outline(), 5);
    expect(selectedTitle(s)).toBe("Hidden");
    expect(titles(s)).toEqual([
      "Preface",
      "Chapter 1",
      "Section 1.1",
      "Detail",
      "Section 1.2",
      "Hidden",
      "Chapter 2",
      "Website",
    ]);
    const start = openOutline(outline(), 1);
    expect(selectedTitle(start)).toBe("Preface");
    // A negative count starts collapsed.
    expect(titles(start)).not.toContain("Hidden");
  });

  test("rows carry their depth and whether they open", () => {
    const rows = outlineRows(openOutline(outline(), 1));
    expect(rows[1]).toMatchObject({ title: "Chapter 1", depth: 0, parent: true, open: true });
    expect(rows[3]).toMatchObject({ title: "Detail", depth: 2, parent: false });
    expect(rows[4]).toMatchObject({ title: "Section 1.2", parent: true, open: false });
  });
});

// Decision 19: an outline shown beside the document follows its page.
describe("selectOutlinePage", () => {
  test("selects the entry for the page and opens the path to it, keeping the rest", () => {
    const s = keys(openOutline(outline(), 1), "index.collapse_all").state;
    expect(titles(s)).toEqual(["Preface", "Chapter 1", "Chapter 2", "Website"]);
    const at5 = selectOutlinePage(s, 5);
    expect(selectedTitle(at5)).toBe("Hidden");
    expect(titles(at5)).toEqual([
      "Preface",
      "Chapter 1",
      "Section 1.1",
      "Section 1.2",
      "Hidden",
      "Chapter 2",
      "Website",
    ]);
    expect(selectOutlinePage(at5, 5)).toBe(at5);
    expect(selectedTitle(selectOutlinePage(at5, 6))).toBe("Chapter 2");
  });

  test("a filtered outline stays as typed", () => {
    const s = setOutlineQuery(openOutline(outline(), 1), "chap");
    expect(selectOutlinePage(s, 5)).toBe(s);
  });
});

describe("index mode's keys", () => {
  test("j and k move, and stop at the ends", () => {
    const s = openOutline(outline(), 1);
    expect(selectedTitle(keys(s, "index.down").state)).toBe("Chapter 1");
    expect(selectedTitle(keys(s, "index.up").state)).toBe("Preface");
    expect(selectedTitle(keys(s, ...Array(20).fill("index.down")).state)).toBe("Website");
  });

  test("gg and G go to the first and last row", () => {
    const s = openOutline(outline(), 4);
    expect(selectedTitle(keys(s, "index.last").state)).toBe("Website");
    expect(selectedTitle(keys(s, "index.first").state)).toBe("Preface");
  });

  test("ctrl+d and ctrl+u move half the rows shown", () => {
    const s = openOutline(outline(), 1);
    expect(selectedTitle(keys(s, "index.half_down").state)).toBe("Section 1.1");
    expect(selectedTitle(keys(s, "index.half_down", "index.half_up").state)).toBe("Preface");
  });

  test("h and zc collapse, then go to the parent; l and zo expand", () => {
    const s = openOutline(outline(), 4); // Detail
    const up = keys(s, "index.collapse").state;
    expect(selectedTitle(up)).toBe("Section 1.1");
    expect(titles(up)).toContain("Detail");
    const closed = keys(up, "index.collapse").state;
    expect(titles(closed)).not.toContain("Detail");
    expect(selectedTitle(keys(closed, "index.collapse").state)).toBe("Chapter 1");
    expect(titles(keys(closed, "index.expand").state)).toContain("Detail");
  });

  test("zO and zC open and close the whole subtree", () => {
    const s = keys(openOutline(outline(), 3), "index.collapse").state; // Chapter 1, closed
    expect(titles(s)).not.toContain("Section 1.1");
    const all = keys(s, "index.expand_subtree").state;
    expect(titles(all)).toContain("Hidden");
    const none = keys(all, "index.collapse_subtree", "index.expand").state;
    expect(titles(none)).toContain("Section 1.1");
    expect(titles(none)).not.toContain("Detail");
  });

  test("L / zR and H / zM expand and collapse everything", () => {
    const s = openOutline(outline(), 4); // Detail
    const closed = keys(s, "index.collapse_all").state;
    expect(titles(closed)).toEqual(["Preface", "Chapter 1", "Chapter 2", "Website"]);
    expect(selectedTitle(closed)).toBe("Chapter 1");
    expect(titles(keys(closed, "index.expand_all").state)).toHaveLength(8);
  });

  test("Enter follows the entry by its index; Esc closes", () => {
    const s = openOutline(outline(), 4);
    expect(keys(s, "index.follow").effect).toEqual({ type: "follow", index: 3 });
    expect(keys(s, "index.close").effect).toEqual({ type: "close" });
  });

  test("an empty outline follows nothing", () => {
    const s = openOutline({ entries: [], truncated: false }, 1);
    expect(outlineRows(s)).toEqual([]);
    expect(keys(s, "index.follow").effect).toBeNull();
    expect(keys(s, "index.down").effect).toBeNull();
  });
});

describe("the filter", () => {
  test("/ starts it; typed text narrows fuzzily, best match first, with the titles above", () => {
    const s = openOutline(outline(), 1);
    const { state, effect } = keys(s, "index.filter");
    expect(effect).toEqual({ type: "filter" });
    expect(outlineRows(state)).toHaveLength(8);
    const f = setOutlineQuery(state, "sec");
    const rows = outlineRows(f);
    expect(rows.map((r) => r.title)).toEqual(["Section 1.1", "Section 1.2"]);
    expect(rows[0]).toMatchObject({ path: "Chapter 1", selected: true, ranges: [[0, 3]] });
    // Collapsed entries are found too.
    expect(outlineRows(setOutlineQuery(state, "hidn")).map((r) => r.path)).toEqual([
      "Chapter 1 › Section 1.2",
    ]);
    expect(outlineRows(setOutlineQuery(state, "zzz"))).toEqual([]);
  });

  test("ctrl+n / ctrl+p move among the matches; Enter follows the match", () => {
    const f = setOutlineQuery(keys(openOutline(outline(), 1), "index.filter").state, "sec");
    const { state, effect } = keys(f, "index.down", "index.follow");
    expect(selectedTitle(state)).toBe("Section 1.2");
    expect(effect).toEqual({ type: "follow", index: 4 });
  });

  test("Esc returns to the whole outline, where it was", () => {
    const s = openOutline(outline(), 4);
    const f = setOutlineQuery(keys(s, "index.filter").state, "chap");
    const back = keys(f, "index.close");
    expect(back.effect).toBeNull();
    expect(back.state.query).toBeNull();
    expect(selectedTitle(back.state)).toBe("Detail");
  });
});

test("a truncated outline says so after its last row", () => {
  const o = parsePdfOutline({ entries: [e("a", 1, 1)], truncated: true }, 1) as any;
  expect(OUTLINE_TRUNCATED_TEXT).toBe("outline truncated at 5000 entries");
  expect(openOutline(o, 1).outline.truncated).toBe(true);
});

// A first entry with children starts collapsed:
// 0 Intro (1)   collapsed
// 1   Setup (2)
// 2 Usage (3)
const parsed = (entries: object[], pages = 6) =>
  parsePdfOutline({ entries, truncated: false }, pages) as NonNullable<
    ReturnType<typeof parsePdfOutline>
  >;
const nested = () =>
  parsed([e("Intro", 1, 1, { collapsed: true }), e("Setup", 2, 2), e("Usage", 1, 3)]);

describe("parsePdfOutline at its bounds", () => {
  test("a missing entry drops the outline", () => {
    expect(parsePdfOutline({ entries: [null], truncated: false }, 6)).toBeNull();
  });

  test("a 512-character title and an 8192-character URL are kept", () => {
    const title = "x".repeat(512);
    const url = "https://a/" + "x".repeat(8182);
    const o = parsed([e(title, 1, 1), e("u", 1, 0, { kind: "url", url })]);
    expect(o.entries[0]?.title).toBe(title);
    expect(o.entries[1]?.url).toBe(url);
  });
});

describe("the current entry in detail", () => {
  test("an entry with no page is never the current one", () => {
    expect(currentEntry(parsed([e("a", 1, 3), e("none", 1, 0, { kind: "none" })]), 1)).toBe(0);
    expect(currentEntry(parsed([e("none", 1, 0, { kind: "none" }), e("b", 1, 1)]), 1)).toBe(1);
  });

  test("on one page, the deepest entry; at the same depth, the first", () => {
    const o = parsed([e("A", 1, 2), e("A.1", 2, 2), e("B", 1, 2), e("C", 1, 2)]);
    expect(currentEntry(o, 2)).toBe(1);
    expect(currentEntry(parsed([e("A", 1, 2), e("B", 1, 2)]), 2)).toBe(0);
  });

  test("an entry on an earlier page after the current one does not replace it", () => {
    expect(currentEntry(parsed([e("A", 1, 3), e("B", 1, 2)]), 3)).toBe(0);
    expect(currentEntry(parsed([e("A", 1, 3), e("A.1", 2, 2)]), 3)).toBe(0);
  });

  test("an empty outline has none", () => {
    expect(currentEntry(parsed([]), 1)).toBe(-1);
  });
});

describe("the panel's state", () => {
  test("opening knows each entry's parent and children, with no filter", () => {
    const s = openOutline(nested(), 1);
    expect(s.parents).toEqual([-1, 0, -1]);
    expect(s.hasChildren).toEqual([true, false, false]);
    expect(s.expanded).toEqual([false, true, true]);
    expect(s).toMatchObject({ selected: 0, query: null, matches: [], match: 0 });
    expect(openOutline(parsed([]), 1).expanded).toEqual([]);
  });

  test("a collapsed first entry hides its children, and opens for the page inside it", () => {
    expect(titles(openOutline(nested(), 1))).toEqual(["Intro", "Usage"]);
    const inside = openOutline(nested(), 2);
    expect(selectedTitle(inside)).toBe("Setup");
    expect(titles(inside)).toEqual(["Intro", "Setup", "Usage"]);
  });

  test("following the page opens the path through the first entry", () => {
    const s = openOutline(nested(), 3);
    expect(titles(s)).toEqual(["Intro", "Usage"]);
    expect(titles(selectOutlinePage(s, 2))).toEqual(["Intro", "Setup", "Usage"]);
  });

  test("following the page keeps the folders the user left open", () => {
    const s = openOutline(outline(), 1);
    expect(titles(selectOutlinePage(s, 6))).toContain("Section 1.1");
  });

  test("tree rows have no path or matched ranges", () => {
    for (const r of outlineRows(openOutline(outline(), 1))) {
      expect(r).toMatchObject({ path: "", ranges: [] });
    }
  });

  test("h on a child of the first entry goes up to it", () => {
    const s = openOutline(nested(), 2);
    expect(selectedTitle(keys(s, "index.collapse").state)).toBe("Intro");
  });

  test("zc closes the selected entry only", () => {
    const s = keys(openOutline(outline(), 3), "index.expand_subtree").state; // Chapter 1, all open
    const closed = keys(s, "index.down", "index.collapse").state; // Section 1.1
    expect(closed.expanded).toEqual([true, true, false, true, true, true, true, true]);
  });

  test("zC on the last entry with children closes it and its descendants", () => {
    const o = parsed([e("A", 1, 1), e("B", 1, 2), e("B.1", 2, 2), e("B.1.a", 3, 2)]);
    const s = keys(openOutline(o, 2), "index.up", "index.up", "index.collapse_subtree").state;
    expect(selectedTitle(s)).toBe("B");
    expect(s.expanded).toEqual([true, false, false, false]);
    // A sibling of the same level ends the subtree.
    const t = keys(openOutline(outline(), 3), "index.collapse_subtree").state;
    expect(t.expanded).toEqual([true, false, false, false, false, false, true, true]);
  });

  test("H / zM go to the top entry above the selection, also the first one", () => {
    const s = keys(openOutline(nested(), 2), "index.collapse_all").state;
    expect(selectedTitle(s)).toBe("Intro");
    expect(s.expanded).toEqual([false, false, false]);
  });

  test("h on a top entry with nothing under it does nothing", () => {
    const s = openOutline(outline(), 1); // Preface
    expect(outlineKey(s, { id: "index.collapse" })).toEqual({ state: s, effect: null });
  });

  test("j on the last row stays there", () => {
    const s = openOutline(outline(), 1);
    expect(keys(s, "index.last", "index.down").state.selected).toBe(7);
  });

  test("G goes to the last row; k goes up one", () => {
    const s = openOutline(outline(), 4); // Detail
    expect(selectedTitle(keys(s, "index.up").state)).toBe("Section 1.1");
    expect(keys(s, "index.last").state.selected).toBe(7);
  });
});

describe("the filter in detail", () => {
  const filtered = (query: string, o = outline()) =>
    outlineRows(setOutlineQuery(keys(openOutline(o, 1), "index.filter").state, query));

  test("a blank filter lists every entry with no ranges", () => {
    const rows = filtered("   ");
    expect(rows).toHaveLength(8);
    for (const r of rows) expect(r.ranges).toEqual([]);
  });

  test("every term must match, whatever the white space", () => {
    expect(filtered("  sec  1.2 ").map((r) => r.title)).toEqual(["Section 1.2"]);
  });

  test("the best match comes first, before document order", () => {
    const o = parsed([e("Notes on setup", 1, 1), e("Setup", 1, 2)]);
    expect(filtered("setup", o).map((r) => r.title)).toEqual(["Setup", "Notes on setup"]);
  });

  test("a match's path names the first entry above it", () => {
    expect(filtered("setup", nested())).toMatchObject([{ title: "Setup", path: "Intro" }]);
  });

  test("ranges are in title order, and overlapping or touching ones merge", () => {
    const o = parsed([e("one two", 1, 1)]);
    expect(filtered("two one", o)[0]?.ranges).toEqual([
      [0, 3],
      [4, 7],
    ]);
    expect(filtered("on ne", o)[0]?.ranges).toEqual([[0, 3]]);
    expect(filtered("on e", o)[0]?.ranges).toEqual([[0, 3]]);
    expect(filtered("one n", o)[0]?.ranges).toEqual([[0, 3]]);
  });

  test("k, gg, G and ctrl+d / ctrl+u move among the matches, within them", () => {
    const f = setOutlineQuery(keys(openOutline(outline(), 1), "index.filter").state, "e");
    const n = f.matches.length;
    expect(n).toBeGreaterThan(4);
    const match = (...ids: string[]) => keys(f, ...ids).state.match;
    expect(match("index.down", "index.down", "index.up")).toBe(1);
    expect(match("index.up")).toBe(0);
    expect(match("index.last")).toBe(n - 1);
    expect(match("index.last", "index.first")).toBe(0);
    expect(match("index.half_down")).toBe(2);
    expect(match("index.half_down", "index.half_down", "index.half_up")).toBe(2);
    expect(match(...Array(20).fill("index.down"))).toBe(n - 1);
  });

  test("/ again keeps the filter; other keys do nothing; Esc leaves no matches", () => {
    const f = setOutlineQuery(keys(openOutline(outline(), 1), "index.filter").state, "sec");
    expect(outlineKey(f, { id: "index.filter" })).toEqual({ state: f, effect: { type: "filter" } });
    expect(outlineKey(f, { id: "index.expand_all" })).toEqual({ state: f, effect: null });
    expect(keys(f, "index.close").state.matches).toEqual([]);
  });

  test("an unknown key does nothing outside the filter", () => {
    const s = openOutline(outline(), 1);
    expect(outlineKey(s, { id: "index.nothing" })).toEqual({ state: s, effect: null });
  });
});
