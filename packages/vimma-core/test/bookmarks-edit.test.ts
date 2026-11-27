// bookmarks.toml's write-back (docs/specs/bookmarks-file.md, Delivery slice 2): the line writer
// (D10), the edits Vimma's keys make through it (Behaviour 10, 15), the base kept in step with
// them (D4), the put-back loop guard (open question 2) and the one edit queue (D11).
import { describe, expect, test } from "vitest";
import {
  baseAfterEdit,
  bookmarkKey,
  editBookmarkLines,
  editBookmarks,
  locateInBase,
  notePutBacks,
  serialQueue,
} from "../src/config/bookmarks-edit.mjs";
import {
  parseBookmarksFile,
  planMirror,
  readBookmarks,
  MAX_BOOKMARK_LINES,
} from "../src/config/bookmarks-file.mjs";
import { parseConfig } from "../src/config/config.mjs";
import { PLACES_ROOTS } from "../src/ui/bookmarks.mjs";
import { budget } from "./budget.ts";

type FileItem =
  | { kind: "folder"; title: string; line: number; children: FileItem[] }
  | { kind: "bookmark"; title: string; url: string; line: number };

/** The shape of a table's items: folders as `name/` with their children, bookmarks as `title url`. */
function shape(items: readonly FileItem[]): unknown[] {
  return items.map((i) =>
    i.kind === "folder" ? { [`${i.title}/`]: shape(i.children) } : `${i.title} ${i.url}`,
  );
}

/** Every table of a bookmarks.toml text as its shape, failing on errors. */
function tables(text: string) {
  const r = parseBookmarksFile(text);
  expect(r.errors).toEqual([]);
  return Object.fromEntries(r.tables.map((t) => [t.name, shape(t.children as FileItem[])]));
}

/** editBookmarkLines, expecting success. */
function lines(text: string, ops: Parameters<typeof editBookmarkLines>[1]) {
  const r = editBookmarkLines(text, ops);
  if (!r.ok) throw new Error(r.error);
  return r.text;
}

/** editBookmarks on bookmarks.toml, expecting success. */
function edit(
  text: string,
  change: Parameters<typeof editBookmarks>[2],
  bookmarklets: "none" | "user" | "agent" = "none",
) {
  const r = editBookmarks(text, "bookmarks.toml", change, { bookmarklets });
  if (!r.ok) throw new Error(r.error);
  return r;
}

const FILE = [
  "# my links",
  "[bookmarks.work]",
  '"docs/Vimma guide" = "https://vimma.dev/docs"   # the guide',
  "",
  "# source",
  '"docs/Firefox source" = "https://searchfox.org/"',
  '"Calendar" = "https://calendar.example.com/"',
  '"archive/" = ""',
  "",
  '[bookmarks."my shop"]',
  '"Cart" = "https://shop.example/cart"',
  "",
].join("\n");

describe("editBookmarkLines (D10)", () => {
  test("editBookmarkLines keeps every other byte, comments and CRLF line ends", () => {
    const out = lines(FILE, [{ op: "remove", line: 7 }]);
    expect(out).toBe(FILE.replace('"Calendar" = "https://calendar.example.com/"\n', ""));
    const crlf = FILE.replace(/\n/g, "\r\n");
    const out2 = lines(crlf, [
      {
        op: "add",
        table: "work",
        after: 6,
        lines: [{ names: ["docs", "new"], folder: false, value: "https://n.example/" }],
      },
    ]);
    expect(out2).toBe(
      crlf.replace(
        '"docs/Firefox source" = "https://searchfox.org/"\r\n',
        '"docs/Firefox source" = "https://searchfox.org/"\r\n"docs/new" = "https://n.example/"\r\n',
      ),
    );
    // Nothing to do changes nothing.
    expect(lines(FILE, [])).toBe(FILE);
  });

  test("editBookmarkLines adds after a folder's last line, removes, renames, moves, renames a header", () => {
    // A replaced key keeps the line's value, indentation and trailing comment.
    const renamed = lines(FILE, [{ op: "replace", line: 3, names: ["docs", "Guide"] }]);
    expect(renamed.split("\n")[2]).toBe('"docs/Guide" = "https://vimma.dev/docs"   # the guide');
    const revalued = lines(FILE, [{ op: "replace", line: 7, value: "https://cal.example/" }]);
    expect(revalued.split("\n")[6]).toBe('"Calendar" = "https://cal.example/"');
    // At the table's end: after its last line, before the blank line and the next table.
    const added = lines(FILE, [
      {
        op: "add",
        table: "work",
        lines: [{ names: ["x"], folder: false, value: "https://x.example/" }],
      },
    ]);
    expect(added.split("\n").slice(7, 10)).toEqual([
      '"archive/" = ""',
      '"x" = "https://x.example/"',
      "",
    ]);
    // A line moved into another table.
    const moved = lines(FILE, [{ op: "move", line: 7, table: "my shop" }]);
    expect(tables(moved)).toEqual({
      work: [
        {
          "docs/": ["Vimma guide https://vimma.dev/docs", "Firefox source https://searchfox.org/"],
        },
        { "archive/": [] },
      ],
      "my shop": ["Cart https://shop.example/cart", "Calendar https://calendar.example.com/"],
    });
    // A header renamed, keeping its comment; quoted when it must be.
    const header = lines('[bookmarks.work] # mine\n"a" = "https://a.example/"\n', [
      { op: "renameTable", from: "work", to: "my work" },
    ]);
    expect(header).toBe('[bookmarks."my work"] # mine\n"a" = "https://a.example/"\n');
    // A table added at the end, and one removed with its lines; own-line comments stay.
    const t = lines(FILE, [
      { op: "removeTable", name: "work" },
      { op: "addTable", name: "home" },
      {
        op: "add",
        table: "home",
        lines: [{ names: ["h"], folder: false, value: "https://h.example/" }],
      },
    ]);
    expect(t).toBe(
      [
        "# my links",
        "",
        "# source",
        "",
        '[bookmarks."my shop"]',
        '"Cart" = "https://shop.example/cart"',
        "",
        "[bookmarks.home]",
        '"h" = "https://h.example/"',
        "",
      ].join("\n"),
    );
  });

  test("editBookmarkLines writes keys as quoted basic strings, \\/ as \\\\/, DEL escaped", () => {
    expect(bookmarkKey(["a/b", "c\\d", 'say "hi"\x7f'], false)).toBe(
      '"a\\\\/b/c\\\\\\\\d/say \\"hi\\"\\u007F"',
    );
    expect(bookmarkKey(["docs", "old"], true)).toBe('"docs/old/"');
    const out = lines("[bookmarks.work]\n", [
      {
        op: "add",
        table: "work",
        lines: [{ names: ["a/b"], folder: false, value: "https://a.example/" }],
      },
    ]);
    expect(out).toBe('[bookmarks.work]\n"a\\\\/b" = "https://a.example/"\n');
    expect(tables(out)).toEqual({ work: ["a/b https://a.example/"] });
  });

  test("editBookmarkLines refuses an edit whose result does not parse to the expected model", () => {
    // A multi-line value cannot be replaced on its line.
    const multi = '[bookmarks.work]\n"a" = """\nhttps://a.example/"""\n';
    expect(
      editBookmarkLines(multi, [{ op: "replace", line: 2, value: "https://b.example/" }]),
    ).toEqual({
      ok: false,
      error: expect.stringContaining("line 2"),
    });
    // A table that is not a header line of its own (a dotted key) is not edited.
    const dotted = '[bookmarks]\nwork."a" = "https://a.example/"\n';
    expect(editBookmarkLines(dotted, [{ op: "remove", line: 2 }]).ok).toBe(false);
    // A line that is not there.
    expect(editBookmarkLines(FILE, [{ op: "remove", line: 4 }]).ok).toBe(false);
    // Two keys that become one path: the result would not parse.
    expect(
      editBookmarkLines(FILE, [{ op: "replace", line: 6, names: ["docs", "Vimma guide"] }]).ok,
    ).toBe(false);
    // A file that does not parse is never edited.
    expect(editBookmarkLines("[bookmarks.work\n", []).ok).toBe(false);
  });

  test("an edit of config.toml's inline tables keeps every other key", () => {
    const config = [
      "schema = 2",
      "[bookmarks]",
      'root = "toolbar"',
      "[bookmarks.work]",
      '"a" = "https://a.example/"',
      "[keys]",
      'new_tab = "t"',
      "",
    ].join("\n");
    const r = editBookmarks(
      config,
      "config.toml",
      { op: "add", table: "work", folders: [], title: "b", url: "https://b.example/" },
      { bookmarklets: "none" },
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.text).toBe(
      config.replace(
        '"a" = "https://a.example/"\n',
        '"a" = "https://a.example/"\n"b" = "https://b.example/"\n',
      ),
    );
    expect(readBookmarks({ file: null, config: r.text }).errors).toEqual([]);
    expect(parseConfig(r.text).errors).toEqual([]);
  });
});

describe("editBookmarks: Vimma's keys write the file (Behaviour 10, 15)", () => {
  test("quick add writes after the last line of its folder, or at the table's end for a new one", () => {
    const r = edit(FILE, {
      op: "add",
      table: "work",
      folders: ["docs"],
      title: "New",
      url: "https://new.example",
    });
    expect(r.path).toEqual(["docs", "New"]);
    expect(r.text.split("\n").slice(5, 7)).toEqual([
      '"docs/Firefox source" = "https://searchfox.org/"',
      '"docs/New" = "https://new.example/"',
    ]);
    const r2 = edit(FILE, {
      op: "add",
      table: "work",
      folders: ["news"],
      title: "N",
      url: "https://n.example/",
    });
    expect(r2.text.split("\n")[8]).toBe('"news/N" = "https://n.example/"');
    // An empty folder's line gives way to its first bookmark, at its place.
    const r3 = edit(FILE, {
      op: "add",
      table: "work",
      folders: ["archive", "2024"],
      title: "old",
      url: "https://o.example/",
    });
    expect(r3.text.split("\n")[7]).toBe('"archive/2024/old" = "https://o.example/"');
    expect(tables(r3.text).work).toContainEqual({
      "archive/": [{ "2024/": ["old https://o.example/"] }],
    });
    // A folder alone is an empty folder's line; one that exists changes nothing.
    const r4 = edit(FILE, { op: "add", table: "work", folders: ["later"], title: null, url: null });
    expect(r4.text.split("\n")[8]).toBe('"later/" = ""');
    const r5 = edit(FILE, { op: "add", table: "work", folders: ["docs"], title: null, url: null });
    expect(r5.text).toBe(FILE);
  });

  test("duplicate titles in one folder are written with (2), (3)", () => {
    const r = edit(FILE, {
      op: "add",
      table: "work",
      folders: ["docs"],
      title: "Vimma guide",
      url: "https://x.example/",
    });
    expect(r.path).toEqual(["docs", "Vimma guide (2)"]);
    expect(r.renamed).toEqual({ from: "Vimma guide", to: "Vimma guide (2)" });
    const r2 = edit(r.text, {
      op: "add",
      table: "work",
      folders: ["docs"],
      title: "Vimma guide",
      url: "https://y.example/",
    });
    expect(r2.path).toEqual(["docs", "Vimma guide (3)"]);
    // A folder and a bookmark may share a name; two folders may not.
    const r3 = edit(FILE, {
      op: "add",
      table: "work",
      folders: [],
      title: "docs",
      url: "https://d.example/",
    });
    expect(r3.path).toEqual(["docs"]);
    const r4 = edit(FILE, {
      op: "move",
      table: "work",
      kind: "folder",
      path: ["archive"],
      toTable: "work",
      toFolders: [],
      toTitle: "docs",
    });
    expect(r4.moves).toEqual([
      { table: "work", kind: "folder", from: ["archive"], toTable: "work", to: ["docs (2)"] },
    ]);
  });

  test("an empty title is written as the URL, outer spaces trimmed, hidden characters dropped", () => {
    const r = edit(FILE, {
      op: "add",
      table: "work",
      folders: [],
      title: "  ",
      url: "https://e.example/a/b",
    });
    expect(r.path).toEqual(["https://e.example/a/b"]);
    expect(tables(r.text).work).toContainEqual("https://e.example/a/b https://e.example/a/b");
    const r2 = edit(FILE, {
      op: "add",
      table: "work",
      folders: [],
      title: " ‮evil​\tname ",
      url: "https://e.example/",
    });
    expect(r2.path).toEqual(["evil name"]);
    const long = edit(FILE, {
      op: "add",
      table: "work",
      folders: [],
      title: "x".repeat(5000),
      url: "https://e.example/",
    });
    expect(long.path[0]).toHaveLength(4096);
  });

  test("never writes a URL the file refuses, nor a bookmarklet below bookmarklets = user", () => {
    for (const url of [
      "data:text/html,x",
      "place:parent=toolbar_____",
      "chrome://browser/content/",
      "/relative",
    ]) {
      const r = editBookmarks(
        FILE,
        "bookmarks.toml",
        { op: "add", table: "work", folders: [], title: "x", url },
        { bookmarklets: "none" },
      );
      expect(r.ok).toBe(false);
    }
    const js = {
      op: "add",
      table: "work",
      folders: [],
      title: "js",
      url: "javascript:alert(1)",
    } satisfies Parameters<typeof editBookmarks>[2];
    expect(editBookmarks(FILE, "bookmarks.toml", js, { bookmarklets: "none" }).ok).toBe(false);
    expect(edit(FILE, js, "user").path).toEqual(["js"]);
    // A table the file lacks is not made by a key.
    expect(
      editBookmarks(
        FILE,
        "bookmarks.toml",
        { op: "add", table: "nope", folders: [], title: "x", url: "https://x.example/" },
        { bookmarklets: "none" },
      ).ok,
    ).toBe(false);
  });

  test("rename and move: in place in its folder, else after the destination's last line; an emptied folder keeps its line", () => {
    const rn = edit(FILE, {
      op: "move",
      table: "work",
      kind: "bookmark",
      path: ["docs", "Vimma guide"],
      toTable: "work",
      toFolders: ["docs"],
      toTitle: "Guide",
    });
    expect(rn.text.split("\n")[2]).toBe('"docs/Guide" = "https://vimma.dev/docs"   # the guide');
    const mv = edit(FILE, {
      op: "move",
      table: "work",
      kind: "bookmark",
      path: ["Calendar"],
      toTable: "work",
      toFolders: ["docs"],
      toTitle: "Calendar",
    });
    expect(tables(mv.text).work).toEqual([
      {
        "docs/": [
          "Vimma guide https://vimma.dev/docs",
          "Firefox source https://searchfox.org/",
          "Calendar https://calendar.example.com/",
        ],
      },
      { "archive/": [] },
    ]);
    // The folder's every line moves with it; a folder renamed in place keeps its lines' places.
    const f = edit(FILE, {
      op: "move",
      table: "work",
      kind: "folder",
      path: ["docs"],
      toTable: "work",
      toFolders: [],
      toTitle: "manuals",
    });
    expect(f.text.split("\n")[2]).toBe(
      '"manuals/Vimma guide" = "https://vimma.dev/docs"   # the guide',
    );
    expect(f.text.split("\n")[5]).toBe('"manuals/Firefox source" = "https://searchfox.org/"');
    // Out of a folder that it leaves empty: the folder stays, as its own line.
    const one = '[bookmarks.work]\n"f/a" = "https://a.example/"\n"b" = "https://b.example/"\n';
    const out = edit(one, {
      op: "move",
      table: "work",
      kind: "bookmark",
      path: ["f", "a"],
      toTable: "work",
      toFolders: [],
      toTitle: "a",
    });
    expect(tables(out.text).work).toEqual([
      { "f/": [] },
      "b https://b.example/",
      "a https://a.example/",
    ]);
    // Into another table.
    const other = edit(FILE, {
      op: "move",
      table: "work",
      kind: "folder",
      path: ["docs"],
      toTable: "my shop",
      toFolders: [],
      toTitle: "docs",
    });
    expect(tables(other.text)["my shop"]).toEqual([
      "Cart https://shop.example/cart",
      { "docs/": ["Vimma guide https://vimma.dev/docs", "Firefox source https://searchfox.org/"] },
    ]);
    // Never into itself.
    expect(
      editBookmarks(
        FILE,
        "bookmarks.toml",
        {
          op: "move",
          table: "work",
          kind: "folder",
          path: ["docs"],
          toTable: "work",
          toFolders: ["docs", "x"],
          toTitle: "docs",
        },
        { bookmarklets: "none" },
      ).ok,
    ).toBe(false);
  });

  test("remove: the line goes with its comment; a folder with all its lines; an emptied folder stays", () => {
    const r = edit(FILE, {
      op: "remove",
      table: "work",
      kind: "bookmark",
      path: ["docs", "Vimma guide"],
    });
    expect(r.text).not.toContain("the guide");
    expect(r.removed).toBe(1);
    const f = edit(FILE, { op: "remove", table: "work", kind: "folder", path: ["docs"] });
    expect(tables(f.text).work).toEqual([
      "Calendar https://calendar.example.com/",
      { "archive/": [] },
    ]);
    expect(f.removed).toBe(2);
    const nested = '[bookmarks.work]\n"f/a" = "https://a.example/"\n';
    expect(
      tables(edit(nested, { op: "remove", table: "work", kind: "bookmark", path: ["f", "a"] }).text)
        .work,
    ).toEqual([{ "f/": [] }]);
  });

  test("tables: renamed, merged into another with (2) for a clash, removed", () => {
    expect(tables(edit(FILE, { op: "renameTable", from: "work", to: "job" }).text)).toHaveProperty(
      "job",
    );
    expect(
      editBookmarks(
        FILE,
        "bookmarks.toml",
        { op: "renameTable", from: "work", to: "my shop" },
        { bookmarklets: "none" },
      ).ok,
    ).toBe(false);
    const clash = FILE.replace('"Cart"', '"Calendar"');
    const m = edit(clash, { op: "mergeTable", from: "my shop", to: "work" });
    expect(Object.keys(tables(m.text))).toEqual(["work"]);
    expect(tables(m.text).work).toContainEqual("Calendar (2) https://shop.example/cart");
    expect(m.moves).toEqual([
      {
        table: "my shop",
        kind: "bookmark",
        from: ["Calendar"],
        toTable: "work",
        to: ["Calendar (2)"],
      },
    ]);
    expect(Object.keys(tables(edit(FILE, { op: "removeTable", name: "work" }).text))).toEqual([
      "my shop",
    ]);
    // The last table too: the file is left with its comments.
    const last = edit('# team\n[bookmarks.kept]  # mine\n"a" = "https://a.example/"\n', {
      op: "removeTable",
      name: "kept",
    });
    expect(last.text).toBe("# team\n");
  });

  test("a subtree from Places goes in under its folder; adoption appends what the table lacks", () => {
    const t = edit(FILE, {
      op: "addTree",
      table: "work",
      folders: ["docs"],
      node: {
        title: "refs",
        children: [
          { title: "a", url: "https://a.example/" },
          { title: "empty", children: [] },
        ],
      },
    });
    expect(t.path).toEqual(["docs", "refs"]);
    expect(tables(t.text).work?.[0]).toEqual({
      "docs/": [
        "Vimma guide https://vimma.dev/docs",
        "Firefox source https://searchfox.org/",
        { "refs/": ["a https://a.example/", { "empty/": [] }] },
      ],
    });
    // A subtree holding what the file cannot hold is refused whole.
    expect(
      editBookmarks(
        FILE,
        "bookmarks.toml",
        {
          op: "addTree",
          table: "work",
          folders: [],
          node: { title: "x", children: [{ title: "d", url: "data:,x" }] },
        },
        { bookmarklets: "none" },
      ).ok,
    ).toBe(false);
    const a = edit(FILE, {
      op: "append",
      table: "work",
      items: [
        { names: ["mine"], url: "https://mine.example/" },
        { names: ["docs", "extra"], url: "https://extra.example/" },
        { names: ["bad"], url: "data:,x" },
        { names: ["Calendar"], url: "https://calendar.example.com/" },
      ],
    });
    expect(a.written).toBe(2);
    expect(a.text.split("\n").slice(8, 10)).toEqual([
      '"mine" = "https://mine.example/"',
      '"docs/extra" = "https://extra.example/"',
    ]);
  });

  test("the result is checked: over the line limit is refused", () => {
    const big = `[bookmarks.work]\n${Array.from({ length: MAX_BOOKMARK_LINES }, (_, i) => `"b${i}" = "https://e.example/${i}"`).join("\n")}\n`;
    const r = editBookmarks(
      big,
      "bookmarks.toml",
      { op: "add", table: "work", folders: [], title: "one more", url: "https://e.example/x" },
      { bookmarklets: "none" },
    );
    expect(r.ok).toBe(false);
  });
});

describe("the base follows Vimma's edits (D4)", () => {
  const base = {
    version: 1 as const,
    source: "bookmarks.toml" as const,
    tables: [
      {
        name: "work",
        folder: "workfolder01",
        entries: [
          { path: ["docs"], kind: "folder" as const, guid: "docsfolder01" },
          {
            path: ["docs", "a"],
            kind: "bookmark" as const,
            url: "https://a.example/",
            guid: "bookmarka001",
          },
          {
            path: ["b"],
            kind: "bookmark" as const,
            url: "https://a.example/",
            guid: "bookmarkb001",
          },
        ],
      },
      { name: "home", folder: "homefolder01", entries: [] },
    ],
  };

  test("a guid's table and path, or its table's folder", () => {
    expect(locateInBase(base, "docsfolder01")).toEqual({
      table: "work",
      kind: "folder",
      path: ["docs"],
    });
    expect(locateInBase(base, "homefolder01")).toEqual({ table: "home", kind: "table", path: [] });
    expect(locateInBase(base, "nothere00001")).toBeNull();
  });

  test("moves keep the guids at their new paths, so a URL two bookmarks share still keeps them", () => {
    const next = baseAfterEdit(base, {
      moves: [{ table: "work", kind: "folder", from: ["docs"], toTable: "home", to: ["manuals"] }],
    });
    expect(next.tables[0]!.entries.map((e) => e.guid)).toEqual(["bookmarkb001"]);
    expect(next.tables[1]!.entries).toEqual([
      { path: ["manuals"], kind: "folder", guid: "docsfolder01" },
      { path: ["manuals", "a"], kind: "bookmark", url: "https://a.example/", guid: "bookmarka001" },
    ]);
    const renamed = baseAfterEdit(base, { renameTable: { from: "work", to: "job" } });
    expect(renamed.tables[0]!.name).toBe("job");
    const dropped = baseAfterEdit(base, { removeTable: "work", drop: [] });
    expect(dropped.tables.map((t) => t.name)).toEqual(["home"]);
    const out = baseAfterEdit(base, { drop: [{ table: "work", kind: "folder", path: ["docs"] }] });
    expect(out.tables[0]!.entries.map((e) => e.guid)).toEqual(["bookmarkb001"]);
    const into = baseAfterEdit(base, {
      add: [
        {
          table: "home",
          entries: [
            { path: ["x"], kind: "bookmark", url: "https://x.example/", guid: "placesx00001" },
          ],
        },
      ],
    });
    expect(into.tables[1]!.entries).toHaveLength(1);
  });

  test("a renamed bookmark whose URL another shares keeps its guid through the plan", () => {
    const text = '[bookmarks.work]\n"docs/a" = "https://a.example/"\n"b" = "https://a.example/"\n';
    const r = edit(text, {
      op: "move",
      table: "work",
      kind: "bookmark",
      path: ["docs", "a"],
      toTable: "work",
      toFolders: ["docs"],
      toTitle: "renamed",
    });
    const next = baseAfterEdit(base, { moves: r.moves });
    const placesTree = {
      guid: "root________",
      typeCode: 2,
      children: [
        {
          guid: PLACES_ROOTS.toolbar,
          typeCode: 2,
          children: [
            {
              guid: "workfolder01",
              typeCode: 2,
              title: "work",
              children: [
                {
                  guid: "docsfolder01",
                  typeCode: 2,
                  title: "docs",
                  children: [
                    { guid: "bookmarka001", typeCode: 1, title: "a", uri: "https://a.example/" },
                  ],
                },
                { guid: "bookmarkb001", typeCode: 1, title: "b", uri: "https://a.example/" },
              ],
            },
          ],
        },
      ],
    };
    const p = planMirror({
      tables: parseBookmarksFile(r.text).tables,
      base: { tables: next.tables.filter((t) => t.name === "work") },
      places: placesTree,
      workspaces: [],
      bookmarklets: "none",
      approved: null,
      makeGuid: () => "new000000001",
    });
    expect(p.ops).toEqual([{ op: "update", guid: "bookmarka001", title: "renamed" }]);
  });
});

describe("the put-back loop guard (open question 2, answer b)", () => {
  test("a bookmark put back three times in ten minutes trips its table", () => {
    const history = new Map<string, number[]>();
    const item = { table: "work", id: "bookmark\0a" };
    expect(notePutBacks(history, [item], 0)).toEqual([]);
    expect(notePutBacks(history, [item, { table: "home", id: "x" }], 60_000)).toEqual([]);
    expect(notePutBacks(history, [item], 120_000)).toEqual(["work"]);
  });

  test("put-backs further apart than ten minutes, or of different bookmarks, do not", () => {
    const history = new Map<string, number[]>();
    notePutBacks(history, [{ table: "work", id: "a" }], 0);
    notePutBacks(history, [{ table: "work", id: "a" }], 300_000);
    expect(notePutBacks(history, [{ table: "work", id: "a" }], 600_001)).toEqual([]);
    const other = new Map<string, number[]>();
    for (const [i, id] of ["a", "b", "c"].entries()) {
      expect(notePutBacks(other, [{ table: "work", id }], i)).toEqual([]);
    }
  });

  test("one apply's ops count once a bookmark; the closing compare's apply counts again", () => {
    // #1595: a change that lands during a put-back's run is put back by its closing compare.
    const history = new Map<string, number[]>();
    const title = { table: "work", id: "bookmark\0a" };
    expect(notePutBacks(history, [title, title], 0)).toEqual([]);
    expect(history.get("work\0bookmark\0a")).toEqual([0]);
    const again = { ...title, round: 1 };
    expect(notePutBacks(history, [title, again], 1_000)).toEqual(["work"]);
  });
});

describe("planMirror for slice 2", () => {
  type Node = { guid: string; typeCode: number; title?: string; uri?: string; children?: Node[] };
  const tree = (children: Node[]): Node => ({
    guid: "root________",
    typeCode: 2,
    children: [{ guid: PLACES_ROOTS.toolbar, typeCode: 2, children }],
  });

  test("adoption merges a folder's extra bookmarks into the table; under none it asks", () => {
    const placesTree = tree([
      {
        guid: "workfolder01",
        typeCode: 2,
        title: "work",
        children: [
          { guid: "keep00000001", typeCode: 1, title: "keep", uri: "https://example.com/keep" },
          { guid: "mine00000001", typeCode: 1, title: "mine", uri: "https://example.com/mine" },
          { guid: "dup000000001", typeCode: 1, title: "mine", uri: "https://example.com/mine2" },
          {
            guid: "fold00000001",
            typeCode: 2,
            title: "f",
            children: [
              { guid: "inner0000001", typeCode: 1, title: "i", uri: "https://example.com/i" },
            ],
          },
          { guid: "data00000001", typeCode: 1, title: "d", uri: "data:,x" },
        ],
      },
    ]);
    const p = planMirror({
      tables: parseBookmarksFile('[bookmarks.work]\n"keep" = "https://example.com/keep"').tables,
      base: null,
      places: placesTree,
      workspaces: [],
      bookmarklets: "none",
      approved: null,
      makeGuid: () => "new000000001",
    });
    expect(p.ask).toContain("takes over");
    expect(p.adopt).toEqual([
      {
        table: "work",
        items: [
          { names: ["mine"], url: "https://example.com/mine" },
          { names: ["mine (2)"], url: "https://example.com/mine2", from: "mine" },
          { names: ["f", "i"], url: "https://example.com/i" },
          { names: ["d"], url: "data:,x" },
        ],
      },
    ]);
    // Written to the file, the next plan keeps them and asks only about what could not be.
    const r = edit('[bookmarks.work]\n"keep" = "https://example.com/keep"\n', {
      op: "append",
      table: "work",
      items: p.adopt[0]!.items,
    });
    expect(r.written).toBe(3);
    const again = planMirror({
      tables: parseBookmarksFile(r.text).tables,
      base: null,
      places: placesTree,
      workspaces: [],
      bookmarklets: "none",
      approved: null,
      makeGuid: () => "new000000002",
    });
    expect(again.ask).toBe(
      'bookmarks.toml takes over "work": delete its 1 bookmark the file lacks? y/N',
    );
    expect(again.ops.filter((o) => o.op === "insert")).toEqual([]);
  });

  test("a held table is left alone both ways, and its folder is not another's", () => {
    const placesTree = tree([
      {
        guid: "workfolder01",
        typeCode: 2,
        title: "work",
        children: [{ guid: "x00000000001", typeCode: 1, title: "x", uri: "https://x.example/" }],
      },
    ]);
    const base = {
      tables: [
        {
          name: "work",
          folder: "workfolder01",
          entries: [
            {
              path: ["a"],
              kind: "bookmark" as const,
              url: "https://a.example/",
              guid: "gone00000001",
            },
          ],
        },
      ],
    };
    const p = planMirror({
      tables: parseBookmarksFile('[bookmarks.work]\n"a" = "https://a.example/"').tables,
      base,
      places: placesTree,
      workspaces: [],
      bookmarklets: "none",
      approved: null,
      hold: new Set(["work"]),
      makeGuid: () => "new000000001",
    });
    expect(p.ops).toEqual([]);
    expect(p.ask).toBeNull();
    expect(p.base.tables).toEqual(base.tables);
  });
});

describe("one edit queue (D11)", () => {
  test("tasks run one at a time, in order; a failure does not stop the next", async () => {
    const q = serialQueue();
    const seen: string[] = [];
    let running = 0;
    const task =
      (name: string, fail = false) =>
      async () => {
        running++;
        expect(running).toBe(1);
        await new Promise((r) => setTimeout(r, 5));
        seen.push(name);
        running--;
        if (fail) throw new Error(name);
        return name;
      };
    const a = q.run(task("a"));
    const b = q.run(task("b", true));
    const c = q.run(task("c"));
    expect(await a).toBe("a");
    await expect(b).rejects.toThrow("b");
    expect(await c).toBe("c");
    expect(seen).toEqual(["a", "b", "c"]);
  });

  test("a task queued from inside a task runs after it, and idle() waits for both", async () => {
    const q = serialQueue();
    const seen: string[] = [];
    await q.run(async () => {
      void q.run(async () => {
        seen.push("inner");
      });
      seen.push("outer");
    });
    await q.idle();
    expect(seen).toEqual(["outer", "inner"]);
  });
});

describe("review fixes (PR #1343)", () => {
  test("a CRLF file without a final line break takes a line at the end of its last table", () => {
    const text = '[bookmarks.work]\r\n"a" = "https://a.example/"';
    const r = edit(text, {
      op: "add",
      table: "work",
      folders: [],
      title: "b",
      url: "https://b.example/",
    });
    expect(r.text).toBe(
      '[bookmarks.work]\r\n"a" = "https://a.example/"\r\n"b" = "https://b.example/"',
    );
    const t = edit(text, { op: "renameTable", from: "work", to: "job" });
    expect(t.text).toBe('[bookmarks.job]\r\n"a" = "https://a.example/"');
    const lf = edit('[bookmarks.work]\n"a" = "https://a.example/"', {
      op: "add",
      table: "work",
      folders: [],
      title: "b",
      url: "https://b.example/",
    });
    expect(lf.text).toBe(
      '[bookmarks.work]\n"a" = "https://a.example/"\n"b" = "https://b.example/"',
    );
  });

  test("a lone surrogate in a title becomes U+FFFD", () => {
    const r = edit(FILE, {
      op: "add",
      table: "work",
      folders: [],
      title: "half \ud800 pair",
      url: "https://s.example/",
    });
    expect(r.path).toEqual(["half � pair"]);
  });

  test("a moved line keeps its trailing comment; an emptied folder's line does not take it", () => {
    const text =
      '[bookmarks.work]\n"f/a" = "https://a.example/"  # mine\n"b" = "https://b.example/"\n';
    const r = edit(text, {
      op: "move",
      table: "work",
      kind: "bookmark",
      path: ["f", "a"],
      toTable: "work",
      toFolders: [],
      toTitle: "a",
    });
    expect(r.text).toBe(
      '[bookmarks.work]\n"f/" = ""\n"b" = "https://b.example/"\n"a" = "https://a.example/"  # mine\n',
    );
  });

  test("many subtrees go into a table as one edit, within budget at 5,000 lines", () => {
    const big = `[bookmarks.work]\n${Array.from({ length: 5000 }, (_, i) => `"b${i}" = "https://e.example/${i}"`).join("\n")}\n`;
    const nodes = Array.from({ length: 100 }, (_, i) => ({
      guid: `guid${String(i).padStart(8, "0")}`,
      title: i % 2 ? `n${i}` : "b0",
      url: `https://n.example/${i}`,
    }));
    const start = performance.now();
    const r = edit(big, { op: "addTrees", table: "work", folders: [], nodes });
    expect(performance.now() - start).toBeLessThan(budget(3000));
    expect(r.entries).toHaveLength(100);
    expect(r.entries[0]).toEqual({
      path: ["b0 (2)"],
      kind: "bookmark",
      url: "https://n.example/0",
      guid: "guid00000000",
    });
    expect(r.entries[2]!.path).toEqual(["b0 (3)"]);
  });
});

describe("planMirror: adoption names a renamed duplicate", () => {
  test("an adopted item whose name was made unique says what it was", () => {
    const placesTree = {
      guid: "root________",
      typeCode: 2,
      children: [
        {
          guid: PLACES_ROOTS.toolbar,
          typeCode: 2,
          children: [
            {
              guid: "workfolder01",
              typeCode: 2,
              title: "work",
              children: [
                { guid: "mine00000001", typeCode: 1, title: "mine", uri: "https://example.com/1" },
                { guid: "mine00000002", typeCode: 1, title: "mine", uri: "https://example.com/2" },
              ],
            },
          ],
        },
      ],
    };
    const p = planMirror({
      tables: parseBookmarksFile("[bookmarks.work]\n").tables,
      base: null,
      places: placesTree,
      workspaces: [],
      bookmarklets: "none",
      approved: null,
      makeGuid: () => "new000000001",
    });
    expect(p.adopt[0]!.items).toEqual([
      { names: ["mine"], url: "https://example.com/1" },
      { names: ["mine (2)"], url: "https://example.com/2", from: "mine" },
    ]);
  });
});
