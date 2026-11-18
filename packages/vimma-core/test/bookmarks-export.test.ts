// `:bookmarks export` (docs/specs/bookmarks-file.md Behaviour 17, Delivery slice 4): Places'
// workspace folders written as a new bookmarks.toml, one table per workspace, in Places order,
// with only lines the mirror reads back as the same bookmarks.
import { describe, expect, test } from "vitest";
import {
  EXPORT_HEADER,
  describeBookmarksFile,
  exportBookmarks,
} from "../src/config/bookmarks-export.mjs";
import { MAX_BOOKMARK_DEPTH, parseBookmarksFile } from "../src/config/bookmarks-file.mjs";
import { PLACES_ROOTS } from "../src/ui/bookmarks.mjs";

type Node = {
  guid?: string;
  typeCode?: number;
  title?: string;
  uri?: string;
  children?: Node[];
};

let next = 0;
const guid = () => `g${String(next++).padStart(10, "0")}`;
const bm = (title: string, uri: string): Node => ({ guid: guid(), typeCode: 1, title, uri });
const folder = (title: string, children: Node[], g = guid()): Node => ({
  guid: g,
  typeCode: 2,
  title,
  children,
});
const sep = (): Node => ({ guid: guid(), typeCode: 3 });

/** Places' whole tree: the toolbar's top holds `toolbar`; the other roots what is given. */
function places(
  toolbar: Node[],
  others: Partial<Record<"menu" | "unfiled" | "mobile", Node[]>> = {},
) {
  return {
    guid: "root________",
    typeCode: 2,
    children: [
      { guid: PLACES_ROOTS.menu, typeCode: 2, children: others.menu ?? [] },
      { guid: PLACES_ROOTS.toolbar, typeCode: 2, children: toolbar },
      {
        guid: "tags________",
        typeCode: 2,
        children: [folder("tag", [bm("t", "https://t.example/")])],
      },
      { guid: PLACES_ROOTS.unfiled, typeCode: 2, children: others.unfiled ?? [] },
      { guid: PLACES_ROOTS.mobile, typeCode: 2, children: others.mobile ?? [] },
    ],
  };
}

type FileItem =
  | { kind: "folder"; title: string; children: FileItem[] }
  | { kind: "bookmark"; title: string; url: string };

function shape(items: readonly FileItem[]): unknown[] {
  return items.map((i) =>
    i.kind === "folder" ? { [`${i.title}/`]: shape(i.children) } : `${i.title} ${i.url}`,
  );
}

/** The text's tables as their shapes, failing on any error. */
function tables(text: string) {
  const r = parseBookmarksFile(text);
  expect(r.errors).toEqual([]);
  return r.tables.map((t) => [t.name, shape(t.children as FileItem[])]);
}

function ok(r: ReturnType<typeof exportBookmarks>) {
  if (!r.ok) throw new Error(r.error);
  return r;
}

describe("exportBookmarks", () => {
  test("export: one table per linked workspace, in the order given, Places order inside", () => {
    const work = folder("work", [
      bm("Calendar", "https://calendar.example.com"),
      folder("docs", [
        bm("Vimma guide", "https://vimma.dev/docs"),
        sep(),
        bm("Firefox source", "https://searchfox.org/"),
      ]),
      bm("2024", "https://y.example/"),
      folder("archive", []),
    ]);
    const shop = folder("my shop", [bm("Cart", "https://shop.example/cart")]);
    const r = ok(
      exportBookmarks({
        places: places([shop, work]),
        tables: [
          { name: "work", folder: work.guid as string },
          { name: "my shop", folder: shop.guid as string },
        ],
      }),
    );
    expect(r.text).toBe(
      [
        EXPORT_HEADER,
        "",
        "[bookmarks.work]",
        '"Calendar" = "https://calendar.example.com/"',
        '"docs/Vimma guide" = "https://vimma.dev/docs"',
        '"docs/Firefox source" = "https://searchfox.org/"',
        '"2024" = "https://y.example/"',
        '"archive/" = ""',
        "",
        '[bookmarks."my shop"]',
        '"Cart" = "https://shop.example/cart"',
        "",
      ].join("\n"),
    );
    expect(tables(r.text)).toEqual([
      [
        "work",
        [
          "Calendar https://calendar.example.com/",
          {
            "docs/": [
              "Vimma guide https://vimma.dev/docs",
              "Firefox source https://searchfox.org/",
            ],
          },
          "2024 https://y.example/",
          { "archive/": [] },
        ],
      ],
      ["my shop", ["Cart https://shop.example/cart"]],
    ]);
    expect(r.bookmarks).toBe(5);
    expect(r.tables).toEqual([
      { name: "work", bookmarks: 4 },
      { name: "my shop", bookmarks: 1 },
    ]);
    expect(r.leftOut).toEqual({ outside: 0, data: 0, unholdable: 0, deep: 0 });
    expect(r.renames).toEqual([]);
  });

  test("export: data: left out and counted; other schemes the file refuses too; javascript: kept", () => {
    const work = folder("work", [
      bm("page", "data:text/html,<b>x</b>"),
      bm("place", "place:parent=toolbar_____"),
      bm("chrome", "chrome://browser/content/browser.xhtml"),
      bm("tool", "javascript:void(document.title)"),
      folder("only data", [bm("d", "DATA:,x")]),
    ]);
    const r = ok(
      exportBookmarks({
        places: places([work]),
        tables: [{ name: "work", folder: work.guid as string }],
      }),
    );
    expect(tables(r.text)).toEqual([
      ["work", ["tool javascript:void(document.title)", { "only data/": [] }]],
    ]);
    expect(r.leftOut).toEqual({ outside: 0, data: 2, unholdable: 2, deep: 0 });
    expect(r.bookmarks).toBe(1);
  });

  test("export: bookmarks outside the exported folders are counted, tags are not", () => {
    const work = folder("work", [bm("a", "https://a.example/")]);
    const other = folder("other", [
      bm("b", "https://b.example/"),
      folder("f", [bm("c", "https://c.example/")]),
    ]);
    const r = ok(
      exportBookmarks({
        places: places([work, other, bm("loose", "https://l.example/")], {
          menu: [bm("m", "https://m.example/")],
          unfiled: [bm("u", "https://u.example/")],
        }),
        tables: [{ name: "work", folder: work.guid as string }],
      }),
    );
    expect(r.leftOut.outside).toBe(5);
    expect(r.bookmarks).toBe(1);
  });

  test("export: names cleaned and made unique as the mirror names them; Places gets the new names", () => {
    const empty = bm("", "https://untitled.example/");
    const twin = bm("Twin", "https://two.example/");
    const ctl = bm("a\u0007b‮ ", "https://ctl.example/");
    const noName = folder("", [bm("x", "https://x.example/")]);
    const spaced = bm("  Spaced  ", "https://s.example/");
    const work = folder("work", [
      bm("Twin", "https://one.example/"),
      twin,
      empty,
      ctl,
      noName,
      spaced,
    ]);
    const r = ok(
      exportBookmarks({
        places: places([work]),
        tables: [{ name: "work", folder: work.guid as string }],
      }),
    );
    expect(tables(r.text)).toEqual([
      [
        "work",
        [
          "Twin https://one.example/",
          "Twin (2) https://two.example/",
          "https://untitled.example/ https://untitled.example/",
          "a b https://ctl.example/",
          { "untitled/": ["x https://x.example/"] },
          "Spaced https://s.example/",
        ],
      ],
    ]);
    // Places' own trimming is no rename: the mirror compares trimmed titles (D5).
    expect(r.renames).toEqual([
      { guid: twin.guid, title: "Twin (2)" },
      { guid: empty.guid, title: "https://untitled.example/" },
      { guid: ctl.guid, title: "a b" },
      { guid: noName.guid, title: "untitled" },
    ]);
  });

  test("export: a slash and a backslash in a name survive the path escapes", () => {
    const work = folder("work", [
      folder("a/b", [bm("c\\d", "https://e.example/")]),
      bm('q"uote', "https://q.example/"),
    ]);
    const r = ok(
      exportBookmarks({
        places: places([work]),
        tables: [{ name: "work", folder: work.guid as string }],
      }),
    );
    expect(r.text).toContain('"a\\\\/b/c\\\\\\\\d" = "https://e.example/"');
    expect(tables(r.text)).toEqual([
      ["work", [{ "a/b/": ["c\\d https://e.example/"] }, 'q"uote https://q.example/']],
    ]);
  });

  test("export: items deeper than the file holds are left out and counted", () => {
    let inner: Node = bm("deep", "https://deep.example/");
    for (let i = 0; i < MAX_BOOKMARK_DEPTH; i++) inner = folder(`f${i}`, [inner]);
    const work = folder("work", [inner, bm("top", "https://top.example/")]);
    const r = ok(
      exportBookmarks({
        places: places([work]),
        tables: [{ name: "work", folder: work.guid as string }],
      }),
    );
    expect(r.leftOut.deep).toBe(1);
    expect(parseBookmarksFile(r.text).errors).toEqual([]);
    expect(r.text).toContain('"top" = "https://top.example/"');
  });

  test("export: an empty workspace folder is a table with no lines; a missing one is skipped", () => {
    const work = folder("work", []);
    const r = ok(
      exportBookmarks({
        places: places([work]),
        tables: [
          { name: "work", folder: work.guid as string },
          { name: "gone", folder: "missingguid1" },
        ],
      }),
    );
    expect(tables(r.text)).toEqual([["work", []]]);
  });

  test("export: one folder or one name twice is written once; a name the file refuses is skipped", () => {
    const work = folder("work", [bm("a", "https://a.example/")]);
    const r = ok(
      exportBookmarks({
        places: places([work]),
        tables: [
          { name: "work", folder: work.guid as string },
          { name: "again", folder: work.guid as string },
          { name: "work", folder: "othersguid01" },
          { name: " spaced", folder: work.guid as string },
        ],
      }),
    );
    expect(tables(r.text).map(([n]) => n)).toEqual(["work"]);
  });

  test("export: more bookmarks and folders than the file holds is refused", () => {
    const many = Array.from({ length: 20_001 }, (_, i) => bm(`b${i}`, `https://e.example/${i}`));
    const work = folder("work", many);
    const r = exportBookmarks({
      places: places([work]),
      tables: [{ name: "work", folder: work.guid as string }],
    });
    expect(r).toEqual({
      ok: false,
      error:
        "more than 20000 bookmarks and folders: bookmarks.toml cannot hold them; nothing written",
    });
  });

  test("export then parse gives the same model, and exporting that model again the same text", () => {
    const work = folder("work", [
      folder("x", [folder("y", [bm("1", "https://1.example/")]), bm("2", "https://2.example/")]),
      bm("x", "https://bookmark-named-like-a-folder.example/"),
      folder("z", []),
    ]);
    const first = ok(
      exportBookmarks({
        places: places([work]),
        tables: [{ name: "work", folder: work.guid as string }],
      }),
    );
    const parsed = parseBookmarksFile(first.text);
    expect(parsed.errors).toEqual([]);
    const toPlaces = (items: readonly FileItem[]): Node[] =>
      items.map((i) =>
        i.kind === "folder" ? folder(i.title, toPlaces(i.children)) : bm(i.title, i.url),
      );
    const again = folder("work", toPlaces((parsed.tables[0] as { children: FileItem[] }).children));
    const second = ok(
      exportBookmarks({
        places: places([again]),
        tables: [{ name: "work", folder: again.guid as string }],
      }),
    );
    expect(second.text).toBe(first.text);
  });
});

describe("describeBookmarksFile", () => {
  test("says how many bookmarks a file holds and in which tables, or that it does not read", () => {
    expect(
      describeBookmarksFile(
        '[bookmarks.work]\n"a" = "https://a.example/"\n"f/b" = "https://b.example/"\n[bookmarks.home]\n"e/" = ""\n',
      ),
    ).toBe('2 bookmarks in "work", "home"');
    expect(describeBookmarksFile('[bookmarks.work]\n"a" = "https://a.example/"\n')).toBe(
      '1 bookmark in "work"',
    );
    expect(describeBookmarksFile("")).toBe("no bookmarks");
    expect(describeBookmarksFile('[bookmarks.work]\n"a" = 3\n')).toBe(
      "a file that does not read (line 2: expected a URL string, got an integer)",
    );
  });
});
