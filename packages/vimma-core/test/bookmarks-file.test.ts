// bookmarks.toml, the read-only mirror (docs/specs/bookmarks-file.md, Delivery slice 1): parse,
// validate, the model, the base and the plan that brings Places to the file.
import { describe, expect, test } from "vitest";
import {
  BOOKMARKS_FILE,
  MAX_BOOKMARKS_FILE_BYTES,
  formatBase,
  formatBookmarksFileError,
  inlineBookmarkTables,
  parseBase,
  parseBookmarksFile,
  planMirror,
  readBookmarks,
  tooManyRemoved,
} from "../src/config/bookmarks-file.mjs";
import { parseConfig } from "../src/config/config.mjs";
import { PLACES_ROOTS } from "../src/ui/bookmarks.mjs";
// Linear-time checks, not benches: the quadratic code they guard against took minutes or ran out
// of memory, so a loaded machine has a wide margin.
import { budget } from "./budget.ts";

type Item = {
  guid?: string;
  typeCode?: number;
  title?: string;
  uri?: string;
  children?: Item[];
};
type FileItem =
  | { kind: "folder"; title: string; line: number; children: FileItem[] }
  | { kind: "bookmark"; title: string; url: string; line: number };
type Op = Record<string, unknown> & { op: string };

const BM = 1;
const FOLDER = 2;
const SEP = 3;

/** A file's tables, failing the test on errors. */
function tablesOf(text: string) {
  const r = parseBookmarksFile(text);
  expect(r.errors).toEqual([]);
  return r.tables;
}

/** The shape of a table's items: folders as `name/` with their children, bookmarks as `title url`. */
function shape(items: readonly FileItem[]): unknown[] {
  return items.map((i) =>
    i.kind === "folder" ? { [`${i.title}/`]: shape(i.children) } : `${i.title} ${i.url}`,
  );
}

const errorsOf = (text: string) => parseBookmarksFile(text).errors;

let guidCounter = 0;
const makeGuid = () => `gen${String(++guidCounter).padStart(9, "0")}`;

const bm = (guid: string, title: string, uri: string): Item => ({
  guid,
  typeCode: BM,
  title,
  uri,
});
const folder = (guid: string, title: string, children: Item[] = []): Item => ({
  guid,
  typeCode: FOLDER,
  title,
  children,
});
const sep = (guid: string): Item => ({ guid, typeCode: SEP });

/** Places as promiseBookmarksTree("") gives it, with `toolbar` and `menu` filled in. */
function places({ toolbar = [], menu = [] }: { toolbar?: Item[]; menu?: Item[] } = {}): Item {
  return {
    guid: "root________",
    typeCode: FOLDER,
    title: "",
    children: [
      folder(PLACES_ROOTS.menu, "menu", menu),
      folder(PLACES_ROOTS.toolbar, "toolbar", toolbar),
      folder(PLACES_ROOTS.unfiled, "unfiled", []),
      folder(PLACES_ROOTS.mobile, "mobile", []),
    ],
  };
}

/** Every node with its parent. */
function index(tree: Item) {
  const map = new Map<string, { node: Item; parent: Item | null }>();
  const walk = (n: Item, parent: Item | null) => {
    map.set(n.guid as string, { node: n, parent });
    for (const c of n.children ?? []) walk(c, n);
  };
  walk(tree, null);
  return map;
}

/**
 * Applies a plan's operations to a copy of `tree`, as BookmarksFile applies them to Places:
 * inserts and moves append (DEFAULT_INDEX), reorder lists children first and appends the rest.
 */
function applyOps(tree: Item, ops: readonly Op[]): Item {
  const root = structuredClone(tree);
  for (const op of ops) {
    const at = index(root);
    if (op.op === "insert") {
      const parent = at.get(op.parentGuid as string)?.node;
      if (!parent) throw new Error(`insert into missing ${String(op.parentGuid)}`);
      const node: Item =
        op.kind === "folder"
          ? folder(op.guid as string, op.title as string)
          : bm(op.guid as string, op.title as string, op.url as string);
      (parent.children ??= []).push(node);
    } else if (op.op === "update") {
      const found = at.get(op.guid as string);
      if (!found) throw new Error(`update of missing ${String(op.guid)}`);
      if (op.title !== undefined) found.node.title = op.title as string;
      if (op.url !== undefined) found.node.uri = op.url as string;
      if (op.parentGuid !== undefined && found.parent) {
        found.parent.children = (found.parent.children ?? []).filter((c) => c !== found.node);
        const to = at.get(op.parentGuid as string)?.node;
        if (!to) throw new Error(`move into missing ${String(op.parentGuid)}`);
        (to.children ??= []).push(found.node);
      }
    } else if (op.op === "remove") {
      const found = at.get(op.guid as string);
      if (!found?.parent) throw new Error(`remove of missing ${String(op.guid)}`);
      found.parent.children = (found.parent.children ?? []).filter((c) => c !== found.node);
    } else if (op.op === "reorder") {
      const parent = at.get(op.parentGuid as string)?.node;
      if (!parent) throw new Error(`reorder of missing ${String(op.parentGuid)}`);
      const kids = parent.children ?? [];
      const listed = (op.guids as string[]).map((g) => kids.find((k) => k.guid === g));
      if (listed.some((k) => !k)) throw new Error("reorder names a child that is not there");
      parent.children = [
        ...(listed as Item[]),
        ...kids.filter((k) => !(op.guids as string[]).includes(k.guid as string)),
      ];
    } else throw new Error(`unknown op ${op.op}`);
  }
  return root;
}

const toolbarOf = (tree: Item) =>
  (tree.children ?? []).find((c) => c.guid === PLACES_ROOTS.toolbar) as Item;

/** A folder's contents as titles and urls, separators as `---`. */
function contents(node: Item | undefined): unknown[] {
  return (node?.children ?? []).map((c) =>
    c.typeCode === SEP
      ? "---"
      : c.typeCode === FOLDER
        ? { [`${c.title}/`]: contents(c) }
        : `${c.title} ${c.uri}`,
  );
}

/** The top-level toolbar folder titled `name`. */
const topFolder = (tree: Item, name: string) =>
  (toolbarOf(tree).children ?? []).find((c) => c.typeCode === FOLDER && c.title === name);

type PlanInput = Parameters<typeof planMirror>[0];

/** planMirror with the usual defaults. */
function plan(input: Partial<PlanInput> & Pick<PlanInput, "tables" | "places">) {
  return planMirror({
    base: null,
    workspaces: [],
    bookmarklets: "none",
    approved: null,
    makeGuid,
    ...input,
  });
}

/** Plans and applies; the next plan over the result must be empty (the loop guard, D5). */
function mirror(input: Partial<PlanInput> & Pick<PlanInput, "tables" | "places">) {
  const p = plan(input);
  expect(p.ask).toBeNull();
  const after = applyOps(input.places, p.ops as Op[]);
  const again = plan({ ...input, places: after, base: p.base, approved: null });
  expect(again.ops).toEqual([]);
  expect(again.ask).toBeNull();
  return { plan: p, places: after };
}

describe("bookmarks.toml: parse and validate", () => {
  test("parses tables into ordered models, integer-like titles keep their line order", () => {
    const tables = tablesOf(
      [
        "[bookmarks.work]",
        '"docs/Vimma guide" = "https://vimma.dev/docs"',
        '"2024" = "https://example.com/2024"',
        '"Calendar" = "https://calendar.example.com/"',
        '"10" = "https://example.com/10"',
        '"archive/" = ""',
        "",
        '[bookmarks."my shop"]',
        '"Cart" = "https://shop.example/cart"',
      ].join("\n"),
    );
    expect(tables.map((t) => [t.name, t.line])).toEqual([
      ["work", 1],
      ["my shop", 8],
    ]);
    expect(shape(tables[0]!.children)).toEqual([
      { "docs/": ["Vimma guide https://vimma.dev/docs"] },
      "2024 https://example.com/2024",
      "Calendar https://calendar.example.com/",
      "10 https://example.com/10",
      { "archive/": [] },
    ]);
    expect(tables[0]!.children.map((c) => c.line)).toEqual([2, 3, 4, 5, 6]);
    expect(BOOKMARKS_FILE).toBe("bookmarks.toml");
  });

  test("reads paths with quick add's rules: escapes, trimming, empty segments dropped", () => {
    const [t] = tablesOf(
      [
        "[bookmarks.w]",
        '" a / b // c " = "https://example.com/1"',
        '"x\\\\/y" = "https://example.com/2"',
        '"back\\\\\\\\slash" = "https://example.com/3"',
      ].join("\n"),
    );
    expect(shape(t!.children)).toEqual([
      { "a/": [{ "b/": ["c https://example.com/1"] }] },
      "x/y https://example.com/2",
      "back\\slash https://example.com/3",
    ]);
  });

  test('a folder key needs "" and a bookmark key cannot end in /', () => {
    expect(errorsOf('[bookmarks.w]\n"docs/" = "https://example.com/"')).toEqual([
      { line: 2, message: 'a folder line ("docs/") must have the value ""' },
    ]);
    expect(errorsOf('[bookmarks.w]\n"Guide" = ""')).toEqual([
      { line: 2, message: 'a bookmark line ("Guide") needs a URL; a folder line ends in /' },
    ]);
    expect(errorsOf('[bookmarks.w]\n" / " = ""')).toEqual([{ line: 2, message: "empty path" }]);
    expect(errorsOf('[bookmarks.w]\n"" = "https://example.com/"')).toEqual([
      { line: 2, message: "empty path" },
    ]);
  });

  test("refuses data: URLs, relative URLs, non-string values, inline tables and nested tables at their line", () => {
    const text = [
      "[bookmarks.w]",
      '"a" = "data:text/html,<script>1</script>"',
      '"b" = "/relative"',
      '"c" = 3',
      '"d" = ["https://example.com/"]',
      '"e" = { url = "https://example.com/" }',
      `"f" = "https://example.com/${"x".repeat(65_536)}"`,
      "",
      "[bookmarks.w.nested]",
      '"g" = "https://example.com/"',
    ].join("\n");
    expect(errorsOf(text)).toEqual([
      { line: 2, message: "data: URLs are never added to bookmarks" },
      { line: 3, message: 'not an absolute URL: "/relative"' },
      { line: 4, message: "expected a URL string, got an integer" },
      { line: 5, message: "expected a URL string, got an array" },
      { line: 6, message: "expected a URL string, got a table" },
      { line: 7, message: "URL longer than 65536 characters" },
      { line: 9, message: "expected a URL string, got a table" },
    ]);
    // DATA: in any case, and a data: URL behind spaces, is still data:.
    expect(errorsOf('[bookmarks.w]\n"a" = " DATA:text/plain,x"')).toEqual([
      { line: 2, message: "data: URLs are never added to bookmarks" },
    ]);
  });

  test("refuses two keys that read as the same path", () => {
    expect(
      errorsOf(
        [
          "[bookmarks.w]",
          '"docs/Guide" = "https://example.com/1"',
          '" docs / Guide " = "https://example.com/2"',
          '"docs//Guide" = "https://example.com/3"',
          '"docs/" = ""',
          '"docs /" = ""',
        ].join("\n"),
      ),
    ).toEqual([
      { line: 3, message: 'same path as line 2: "docs/Guide"' },
      { line: 4, message: 'same path as line 2: "docs/Guide"' },
      { line: 6, message: 'same path as line 5: "docs/"' },
    ]);
    // A folder and a bookmark of one name are two items, as in Places.
    expect(errorsOf('[bookmarks.w]\n"docs/" = ""\n"docs" = "https://example.com/"')).toEqual([]);
  });

  test("refuses a file over 4 MiB without parsing it", () => {
    const big = `[bookmarks.w]\n"a" = "https://example.com/"\n#${"x".repeat(MAX_BOOKMARKS_FILE_BYTES)}`;
    expect(errorsOf(big)).toEqual([{ line: 0, message: "larger than 4 MiB; not read" }]);
    // Bytes, not characters: 1.5 Mi three-byte characters are 4.5 MiB.
    expect(errorsOf(`#${"€".repeat(1_572_864)}`)).toEqual([
      { line: 0, message: "larger than 4 MiB; not read" },
    ]);
    expect(errorsOf(`#${"x".repeat(1000)}\n[bookmarks.w]`)).toEqual([]);
  });

  test("refuses a path segment over 4,096 characters and a table name that is not a workspace name", () => {
    const long = "t".repeat(4097);
    expect(errorsOf(`[bookmarks.w]\n"${long}" = "https://example.com/"`)).toEqual([
      { line: 2, message: "a name longer than 4096 characters" },
    ]);
    expect(errorsOf(`[bookmarks.w]\n"${"t".repeat(4096)}" = "https://example.com/"`)).toEqual([]);
    expect(errorsOf(`[bookmarks."${"n".repeat(33)}"]\n"a" = "https://example.com/"`)).toEqual([
      { line: 1, message: "workspace name must be 1 to 32 characters" },
    ]);
    expect(errorsOf('[bookmarks.""]\n"a" = "https://example.com/"')).toEqual([
      { line: 1, message: "workspace name must be 1 to 32 characters" },
    ]);
    expect(errorsOf('[bookmarks."a\\u0007b"]\n"a" = "https://example.com/"')).toEqual([
      { line: 1, message: "workspace name must not contain control characters" },
    ]);
  });

  test("refuses an inline table named root, bookmarklets or write_back, pointing at bookmarks.toml", () => {
    for (const name of ["root", "bookmarklets", "write_back"]) {
      const text = `schema = 2\n[bookmarks.${name}]\n"a" = "https://example.com/"\n`;
      const r = readBookmarks({ file: null, config: text });
      expect(r.errors).toEqual([
        {
          file: "config.toml",
          line: 2,
          message: `a workspace named "${name}" cannot have its table in config.toml: put [bookmarks.${name}] in bookmarks.toml`,
        },
      ]);
      // config.toml says the same, so the user sees why, whichever file they look at.
      const c = parseConfig(text);
      expect(c.errors.map((e) => e.message)).toContain(
        `a workspace named "${name}" cannot have its table in config.toml: put [bookmarks.${name}] in bookmarks.toml`,
      );
      // In bookmarks.toml it is an ordinary table.
      expect(errorsOf(`[bookmarks.${name}]\n"a" = "https://example.com/"`)).toEqual([]);
    }
  });

  test("titles __proto__ and constructor are ordinary titles", () => {
    const [t] = tablesOf(
      [
        "[bookmarks.__proto__]",
        '"__proto__/constructor" = "https://example.com/1"',
        '"constructor" = "https://example.com/2"',
        '"hasOwnProperty/" = ""',
      ].join("\n"),
    );
    expect(t!.name).toBe("__proto__");
    expect(shape(t!.children)).toEqual([
      { "__proto__/": ["constructor https://example.com/1"] },
      "constructor https://example.com/2",
      { "hasOwnProperty/": [] },
    ]);
    expect(({} as Record<string, unknown>).constructor).toBe(Object);
  });

  test("urls compare by href: a missing trailing slash is no change", () => {
    const [t] = tablesOf('[bookmarks.w]\n"S" = "https://searchfox.org"');
    expect(shape(t!.children)).toEqual(["S https://searchfox.org/"]);
    const tables = tablesOf('[bookmarks.w]\n"S" = "https://searchfox.org"');
    const tree = places({
      toolbar: [folder("wfolder00001", "w", [bm("bmsearchfox1", "S", "https://searchfox.org/")])],
    });
    const p = plan({ tables, places: tree });
    expect(p.ops).toEqual([]);
    expect(p.base.tables[0]!.entries).toEqual([
      { path: ["S"], kind: "bookmark", url: "https://searchfox.org/", guid: "bmsearchfox1" },
    ]);
  });

  test("folder names match exactly; Docs and docs are two folders", () => {
    const [t] = tablesOf(
      [
        "[bookmarks.w]",
        '"Docs/a" = "https://example.com/1"',
        '"docs/b" = "https://example.com/2"',
      ].join("\n"),
    );
    expect(shape(t!.children)).toEqual([
      { "Docs/": ["a https://example.com/1"] },
      { "docs/": ["b https://example.com/2"] },
    ]);
  });

  test("refuses keys other than [bookmarks.<name>] tables in bookmarks.toml", () => {
    expect(
      errorsOf(
        [
          'title = "x"',
          "[keys]",
          'prefix = "C-a"',
          "[bookmarks]",
          'write_back = "all"',
          'bookmarklets = "user"',
          "[bookmarks.w]",
          '"a" = "https://example.com/"',
        ].join("\n"),
      ),
    ).toEqual([
      { line: 1, message: 'only [bookmarks.<workspace>] tables belong here, not "title"' },
      { line: 2, message: 'only [bookmarks.<workspace>] tables belong here, not "keys"' },
      {
        line: 5,
        message: "bookmarks.write_back is a setting: it is read only from config.toml",
      },
      {
        line: 6,
        message: "bookmarks.bookmarklets is a setting: it is read only from config.toml",
      },
    ]);
    expect(errorsOf("bookmarks = 3")).toEqual([
      { line: 1, message: "expected [bookmarks.<workspace>] tables, got an integer" },
    ]);
    expect(errorsOf("[bookmarks.w")[0]).toMatchObject({ line: 1 });
    expect(errorsOf("")).toEqual([]);
  });

  test("errors read as bookmarks.toml:<line>: <message>", () => {
    expect(formatBookmarksFileError({ file: "bookmarks.toml", line: 4, message: "m" })).toBe(
      "bookmarks.toml:4: m",
    );
    expect(formatBookmarksFileError({ file: "bookmarks.toml", line: 0, message: "m" })).toBe(
      "bookmarks.toml: m",
    );
  });

  test("inline tables in config.toml are ignored with a warning when bookmarks.toml exists", () => {
    const config = [
      "schema = 2",
      "[bookmarks]",
      'root = "workspace"',
      "",
      "[bookmarks.work]",
      '"a" = "https://example.com/a"',
      "[bookmarks.home]",
      '"b" = "https://example.com/b"',
    ].join("\n");
    const file = '[bookmarks.work]\n"c" = "https://example.com/c"';
    const both = readBookmarks({ file, config });
    expect(both.from).toBe("bookmarks.toml");
    expect(both.errors).toEqual([]);
    expect(both.warnings).toEqual([
      {
        file: "config.toml",
        line: 5,
        message: "bookmarks.work ignored: bookmarks.toml is the bookmarks file",
      },
      {
        file: "config.toml",
        line: 7,
        message: "bookmarks.home ignored: bookmarks.toml is the bookmarks file",
      },
    ]);
    expect(both.tables.map((t) => t.name)).toEqual(["work"]);

    const inline = readBookmarks({ file: null, config });
    expect(inline.from).toBe("config.toml");
    expect(inline.warnings).toEqual([]);
    expect(inline.tables.map((t) => [t.name, t.line])).toEqual([
      ["work", 5],
      ["home", 7],
    ]);
    // Errors in an inline table name config.toml's line.
    const bad = readBookmarks({ file: null, config: `${config}\n"c" = "data:,x"` });
    expect(bad.errors).toEqual([
      { file: "config.toml", line: 9, message: "data: URLs are never added to bookmarks" },
    ]);
    // config.toml's own settings are not bookmarks; neither are other tables.
    expect(readBookmarks({ file: null, config: 'schema = 2\n[bookmarks]\nroot = "all"' })).toEqual({
      from: null,
      tables: [],
      errors: [],
      warnings: [],
    });
    expect(readBookmarks({ file: null, config: null }).from).toBeNull();
    // An empty bookmarks.toml is still the bookmarks file, with no tables.
    expect(readBookmarks({ file: "", config }).from).toBe("bookmarks.toml");
    expect(inlineBookmarkTables(config)).toEqual([
      { name: "work", line: 5 },
      { name: "home", line: 7 },
    ]);
    expect(inlineBookmarkTables("[bookmarks")).toEqual([]);
  });

  test("config.toml accepts inline [bookmarks.<name>] tables beside its settings", () => {
    const c = parseConfig(
      'schema = 2\n[bookmarks]\nroot = "all"\n[bookmarks.work]\n"a" = "https://example.com/"\n',
    );
    expect(c.errors).toEqual([]);
    expect(c.config?.bookmarks.root).toBe("all");
  });
});

describe("bookmarks.toml: the mirror's plan", () => {
  const W = "wfolder00001";
  const work = (children: Item[]) => places({ toolbar: [folder(W, "work", children)] });

  test("table to folder resolution: base guid, linked workspace, name at the toolbar's top, new", () => {
    const tables = tablesOf('[bookmarks.work]\n"a" = "https://example.com/a"');
    const elsewhere = places({
      menu: [folder("moved0000001", "renamed", [bm("bma000000001", "a", "https://example.com/a")])],
      toolbar: [folder("byname000001", "work", []), folder("linked000001", "linked", [])],
    });
    const base = {
      version: 1,
      source: "bookmarks.toml",
      tables: [
        {
          name: "work",
          folder: "moved0000001",
          entries: [
            { path: ["a"], kind: "bookmark", url: "https://example.com/a", guid: "bma000000001" },
          ],
        },
      ],
    } as const;
    // The base's folder, wherever it is now, while it is the workspace's linked folder: moved
    // back to the toolbar and renamed back.
    const p1 = plan({
      tables,
      places: elsewhere,
      base: structuredClone(base) as never,
      workspaces: [{ name: "work", folder: "moved0000001" }],
    });
    expect(p1.base.tables[0]!.folder).toBe("moved0000001");
    expect(p1.ops).toContainEqual({
      op: "update",
      guid: "moved0000001",
      title: "work",
      parentGuid: PLACES_ROOTS.toolbar,
    });
    // Without a base: the workspace's linked folder at the toolbar's top.
    const p2 = plan({
      tables,
      places: elsewhere,
      workspaces: [{ name: "work", folder: "linked000001" }],
    });
    expect(p2.base.tables[0]!.folder).toBe("linked000001");
    expect(p2.ops).toContainEqual({ op: "update", guid: "linked000001", title: "work" });
    // Else the first toolbar folder of its name.
    const p3 = plan({ tables, places: elsewhere });
    expect(p3.base.tables[0]!.folder).toBe("byname000001");
    // Else a new folder at the end of the toolbar.
    const p4 = plan({ tables, places: places() });
    expect(p4.ops[0]).toMatchObject({
      op: "insert",
      kind: "folder",
      title: "work",
      parentGuid: PLACES_ROOTS.toolbar,
    });
    expect(p4.links).toEqual([{ name: "work", folder: p4.base.tables[0]!.folder }]);
  });

  test("a file is mirrored into the folder in file order", () => {
    const tables = tablesOf(
      [
        "[bookmarks.work]",
        '"docs/Vimma guide" = "https://vimma.dev/docs"',
        '"Calendar" = "https://calendar.example.com/"',
        '"docs/Firefox source" = "https://searchfox.org/"',
        '"archive/" = ""',
      ].join("\n"),
    );
    const { places: after } = mirror({ tables, places: places() });
    expect(contents(topFolder(after, "work"))).toEqual([
      {
        "docs/": ["Vimma guide https://vimma.dev/docs", "Firefox source https://searchfox.org/"],
      },
      "Calendar https://calendar.example.com/",
      { "archive/": [] },
    ]);
  });

  test("diff: an addition on one side is not a deletion on the other (three-way)", () => {
    const v1 = tablesOf('[bookmarks.work]\n"a" = "https://example.com/a"');
    const first = mirror({ tables: v1, places: work([]) });
    const v2 = tablesOf(
      '[bookmarks.work]\n"a" = "https://example.com/a"\n"b" = "https://example.com/b"',
    );
    const p = plan({ tables: v2, places: first.places, base: first.plan.base });
    expect(p.ops.filter((o) => o.op === "remove")).toEqual([]);
    expect(p.removed).toEqual([]);
    expect(contents(topFolder(applyOps(first.places, p.ops as Op[]), "work"))).toEqual([
      "a https://example.com/a",
      "b https://example.com/b",
    ]);
    // An outside addition in Places is put back (read-only mirror): removed, and never counted as
    // a deletion from the file.
    const outside = structuredClone(first.places);
    topFolder(outside, "work")!.children!.push(bm("outside00001", "x", "https://example.com/x"));
    const q = plan({ tables: v1, places: outside, base: first.plan.base });
    expect(q.ops).toEqual([{ op: "remove", guid: "outside00001" }]);
    expect(q.removed).toEqual([{ table: "work", count: 1, cause: "outside" }]);
    expect(q.ask).toBeNull();
  });

  test("diff: same path, new URL keeps the guid; same URL, new path keeps the guid", () => {
    const v1 = tablesOf(
      '[bookmarks.work]\n"a" = "https://example.com/a"\n"b" = "https://example.com/b"',
    );
    const first = mirror({ tables: v1, places: work([]) });
    const guidOf = (path: string) =>
      first.plan.base.tables[0]!.entries.find((e) => e.path.join("/") === path)!.guid;
    const v2 = tablesOf(
      '[bookmarks.work]\n"a" = "https://example.com/a2"\n"docs/b2" = "https://example.com/b"',
    );
    const p = plan({ tables: v2, places: first.places, base: first.plan.base });
    expect(
      p.ops.filter((o) => o.op === "remove" || (o.op === "insert" && o.kind === "bookmark")),
    ).toEqual([]);
    expect(p.ops).toContainEqual({
      op: "update",
      guid: guidOf("a"),
      url: "https://example.com/a2",
    });
    const docs = p.base.tables[0]!.entries.find((e) => e.path.join("/") === "docs")!.guid;
    expect(p.ops).toContainEqual({
      op: "update",
      guid: guidOf("b"),
      title: "b2",
      parentGuid: docs,
    });
    expect(p.base.tables[0]!.entries.find((e) => e.path.join("/") === "docs/b2")!.guid).toBe(
      guidOf("b"),
    );
  });

  test("diff: path and URL both changed is a removal and an addition", () => {
    const v1 = tablesOf('[bookmarks.work]\n"a" = "https://example.com/a"');
    const first = mirror({ tables: v1, places: work([]) });
    const old = first.plan.base.tables[0]!.entries[0]!.guid;
    const v2 = tablesOf('[bookmarks.work]\n"z" = "https://example.com/z"');
    const p = plan({ tables: v2, places: first.places, base: first.plan.base });
    expect(p.ops).toContainEqual({ op: "remove", guid: old });
    expect(p.ops).toContainEqual(
      expect.objectContaining({ op: "insert", kind: "bookmark", title: "z" }),
    );
    expect(p.removed).toEqual([{ table: "work", count: 1, cause: "file" }]);
  });

  test("diff: the reorder list keeps separators after the bookmark they followed", () => {
    const tree = work([
      bm("bma000000001", "a", "https://example.com/a"),
      sep("sep000000001"),
      bm("bmb000000001", "b", "https://example.com/b"),
      bm("bmc000000001", "c", "https://example.com/c"),
    ]);
    const tables = tablesOf(
      [
        "[bookmarks.work]",
        '"c" = "https://example.com/c"',
        '"a" = "https://example.com/a"',
        '"b" = "https://example.com/b"',
      ].join("\n"),
    );
    const { plan: p, places: after } = mirror({ tables, places: tree });
    expect(p.ops).toEqual([
      {
        op: "reorder",
        parentGuid: W,
        guids: ["bmc000000001", "bma000000001", "sep000000001", "bmb000000001"],
      },
    ]);
    expect(contents(topFolder(after, "work"))).toEqual([
      "c https://example.com/c",
      "a https://example.com/a",
      "---",
      "b https://example.com/b",
    ]);
    // A separator at the top stays at the top.
    const top = work([sep("sep000000002"), bm("bma000000001", "a", "https://example.com/a")]);
    const two = tablesOf(
      '[bookmarks.work]\n"b" = "https://example.com/b"\n"a" = "https://example.com/a"',
    );
    const r = mirror({ tables: two, places: top });
    expect(contents(topFolder(r.places, "work"))).toEqual([
      "---",
      "b https://example.com/b",
      "a https://example.com/a",
    ]);
  });

  test("diff: two folders of one title in one parent become title and title (2)", () => {
    const tree = work([
      folder("docs00000001", "docs", [bm("bma000000001", "a", "https://example.com/a")]),
      folder("docs00000002", "docs", [bm("bmb000000001", "b", "https://example.com/b")]),
      bm("dupa00000001", "Guide", "https://example.com/g1"),
      bm("dupa00000002", "Guide", "https://example.com/g2"),
    ]);
    const tables = tablesOf(
      [
        "[bookmarks.work]",
        '"docs/a" = "https://example.com/a"',
        '"docs (2)/b" = "https://example.com/b"',
        '"Guide" = "https://example.com/g1"',
        '"Guide (2)" = "https://example.com/g2"',
      ].join("\n"),
    );
    const { plan: p } = mirror({ tables, places: tree, approved: 1000 });
    // The second of each is read as `title (2)`, matches its line, and is renamed to it.
    expect(p.ops).toContainEqual({ op: "update", guid: "docs00000002", title: "docs (2)" });
    expect(p.ops).toContainEqual({ op: "update", guid: "dupa00000002", title: "Guide (2)" });
    expect(p.ops.filter((o) => o.op === "remove" || o.op === "insert")).toEqual([]);
  });

  test("diff: a renamed, moved or deleted mirrored folder per write_back", () => {
    const tables = tablesOf('[bookmarks.work]\n"a" = "https://example.com/a"');
    const first = mirror({ tables, places: places() });
    const f = first.plan.base.tables[0]!.folder;
    // Renamed in the Library: the name is put back.
    const renamed = structuredClone(first.places);
    topFolder(renamed, "work")!.title = "job";
    expect(plan({ tables, places: renamed, base: first.plan.base }).ops).toEqual([
      { op: "update", guid: f, title: "work" },
    ]);
    // Moved elsewhere: moved back to the toolbar's top.
    const moved = structuredClone(first.places);
    const node = topFolder(moved, "work")!;
    toolbarOf(moved).children = [];
    moved.children![0]!.children!.push(node);
    expect(
      plan({
        tables,
        places: moved,
        base: first.plan.base,
        workspaces: [{ name: "work", folder: f }],
      }).ops,
    ).toEqual([{ op: "update", guid: f, parentGuid: PLACES_ROOTS.toolbar }]);
    // Deleted: made again from the file, with nothing to ask.
    const gone = plan({ tables, places: places(), base: first.plan.base });
    expect(gone.ask).toBeNull();
    expect(applyOps(places(), gone.ops as Op[])).toSatisfy(
      (t: Item) => contents(topFolder(t, "work")).join() === "a https://example.com/a",
    );
  });

  test("diff: both sides changed one bookmark, the file wins", () => {
    const v1 = tablesOf('[bookmarks.work]\n"a" = "https://example.com/a"');
    const first = mirror({ tables: v1, places: work([]) });
    const changed = structuredClone(first.places);
    topFolder(changed, "work")!.children![0]!.uri = "https://example.com/places";
    topFolder(changed, "work")!.children![0]!.title = "renamed";
    const v2 = tablesOf('[bookmarks.work]\n"a" = "https://example.com/file"');
    const p = plan({ tables: v2, places: changed, base: first.plan.base });
    expect(p.ops).toEqual([
      {
        op: "update",
        guid: first.plan.base.tables[0]!.entries[0]!.guid,
        title: "a",
        url: "https://example.com/file",
      },
    ]);
  });

  test("diff: equal sides produce no operations", () => {
    const tables = tablesOf(
      [
        "[bookmarks.work]",
        '"docs/Guide" = "https://example.com/g"',
        '"x" = "https://example.com/x"',
        '"empty/" = ""',
      ].join("\n"),
    );
    const { plan: p, places: after } = mirror({ tables, places: places() });
    expect(p.ops.length).toBeGreaterThan(0);
    // Titles are compared trimmed and cut to Places' limit; a Places title with outer spaces is
    // no change.
    const spaced = structuredClone(after);
    topFolder(spaced, "work")!.children![1]!.title = "  x ";
    expect(plan({ tables, places: spaced, base: p.base }).ops).toEqual([]);
    // Without a base, a folder that already holds exactly the file needs nothing either.
    expect(plan({ tables, places: after }).ops).toEqual([]);
  });

  test("diff: a folder sits at its first line; interleaved lines keep folder contents together", () => {
    const tables = tablesOf(
      [
        "[bookmarks.work]",
        '"b" = "https://example.com/b"',
        '"docs/x" = "https://example.com/x"',
        '"c" = "https://example.com/c"',
        '"docs/y" = "https://example.com/y"',
      ].join("\n"),
    );
    const { places: after } = mirror({ tables, places: places() });
    expect(contents(topFolder(after, "work"))).toEqual([
      "b https://example.com/b",
      { "docs/": ["x https://example.com/x", "y https://example.com/y"] },
      "c https://example.com/c",
    ]);
  });

  test("diff: separators, tags and keywords are never in the operations", () => {
    const tree = work([
      sep("sep000000001"),
      folder("docs00000001", "docs", [sep("sep000000002")]),
      sep("sep000000003"),
    ]);
    const tables = tablesOf('[bookmarks.work]\n"docs/" = ""');
    // Already in order: nothing at all, separators and all.
    expect(plan({ tables, places: tree }).ops).toEqual([]);
    // A file that adds and removes around them: separators appear only in a reorder's list,
    // never as an insert, a move or a removal.
    const more = tablesOf('[bookmarks.work]\n"a" = "https://example.com/a"');
    const ops = plan({ tables: more, places: tree, approved: 1000 }).ops as Op[];
    expect(ops.length).toBeGreaterThan(0);
    for (const o of ops.filter((x) => x.op !== "reorder")) {
      expect(String(o.guid)).not.toMatch(/^sep/);
    }
  });

  test("diff: counts deletions against the large-deletion limits (20, half of at least 5)", () => {
    expect(tooManyRemoved([{ removed: 21, had: 100 }])).toBe(true);
    expect(tooManyRemoved([{ removed: 20, had: 100 }])).toBe(false);
    expect(
      tooManyRemoved([
        { removed: 10, had: 100 },
        { removed: 11, had: 100 },
      ]),
    ).toBe(true);
    expect(tooManyRemoved([{ removed: 3, had: 5 }])).toBe(true);
    expect(tooManyRemoved([{ removed: 2, had: 5 }])).toBe(false);
    expect(tooManyRemoved([{ removed: 3, had: 4 }])).toBe(false);
    expect(tooManyRemoved([{ removed: 4, had: 4 }])).toBe(false);

    const lines = (n: number) =>
      Array.from({ length: n }, (_, i) => `"b${i}" = "https://example.com/${i}"`).join("\n");
    const v1 = tablesOf(`[bookmarks.work]\n${lines(30)}\n[bookmarks.docs]\n${lines(6)}`);
    const first = mirror({ tables: v1, places: places() });
    // An emptied file: 36 deletions over two tables, asked first; nothing applies.
    const emptied = plan({ tables: [], places: first.places, base: first.plan.base });
    expect(emptied.ask).toBe(
      'bookmarks.toml removes 36 bookmarks from "work", "docs": delete them? y/N',
    );
    expect(emptied.ops).toEqual([]);
    expect(emptied.base).toEqual(first.plan.base);
    // After a y, the same plan applies: the bookmarks go, the folders stay.
    const yes = plan({ tables: [], places: first.places, base: first.plan.base, approved: 1000 });
    expect(yes.ask).toBeNull();
    expect(yes.removed).toEqual([
      { table: "work", count: 30, cause: "file" },
      { table: "docs", count: 6, cause: "file" },
    ]);
    const after = applyOps(first.places, yes.ops as Op[]);
    expect(contents(topFolder(after, "work"))).toEqual([]);
    expect(yes.base.tables).toEqual([]);
    // Four of six from one table: more than half, asked; three of six is half, not more.
    const v2 = tablesOf(`[bookmarks.work]\n${lines(30)}\n[bookmarks.docs]\n${lines(2)}`);
    expect(plan({ tables: v2, places: first.places, base: first.plan.base }).ask).toBe(
      'bookmarks.toml removes 4 bookmarks from "docs": delete them? y/N',
    );
    const half = tablesOf(`[bookmarks.work]\n${lines(30)}\n[bookmarks.docs]\n${lines(3)}`);
    expect(plan({ tables: half, places: first.places, base: first.plan.base }).ask).toBeNull();
    // Two of six: said, not asked.
    const v3 = tablesOf(`[bookmarks.work]\n${lines(30)}\n[bookmarks.docs]\n${lines(4)}`);
    const small = plan({ tables: v3, places: first.places, base: first.plan.base });
    expect(small.ask).toBeNull();
    expect(small.removed).toEqual([{ table: "docs", count: 2, cause: "file" }]);
  });

  test("adoption: a folder's bookmarks the table lacks are deleted only after a question", () => {
    const tree = work([
      bm("bma000000001", "a", "https://example.com/a"),
      bm("bmx000000001", "x", "https://example.com/x"),
      folder("old000000001", "old", [bm("bmy000000001", "y", "https://example.com/y")]),
    ]);
    const tables = tablesOf('[bookmarks.work]\n"a" = "https://example.com/a"');
    const p = plan({ tables, places: tree });
    expect(p.ask).toBe(
      'bookmarks.toml takes over "work": delete its 2 bookmarks the file lacks? y/N',
    );
    expect(p.ops).toEqual([]);
    const yes = plan({ tables, places: tree, approved: 1000 });
    expect(yes.ops).toEqual([
      { op: "remove", guid: "bmx000000001" },
      { op: "remove", guid: "old000000001" },
    ]);
    expect(yes.removed).toEqual([{ table: "work", count: 2, cause: "adopt" }]);
    // A yes approves that many removals and no more: one more than asked asks again.
    expect(plan({ tables, places: tree, approved: 2 }).ask).toBeNull();
    expect(plan({ tables, places: tree, approved: 1 }).ask).toBe(
      'bookmarks.toml takes over "work": delete its 2 bookmarks the file lacks? y/N',
    );
    // Nothing the file lacks: nothing to ask.
    expect(
      plan({ tables, places: work([bm("bma000000001", "a", "https://example.com/a")]) }).ask,
    ).toBeNull();
  });

  test('javascript: lines are skipped below bookmarklets = "user", and those already in Places are kept', () => {
    const tables = tablesOf(
      [
        "[bookmarks.work]",
        '"run" = "javascript:alert(1)"',
        '"mine" = "javascript:void(2)"',
        '"page" = "https://example.com/"',
      ].join("\n"),
    );
    const tree = work([bm("bmmine000001", "mine", "javascript:void(1)")]);
    const none = plan({ tables, places: tree, approved: 1000 });
    expect(none.skipped).toEqual([
      { table: "work", line: 2 },
      { table: "work", line: 3 },
    ]);
    const after = applyOps(tree, none.ops as Op[]);
    // Not added, and the user's own bookmarklet is neither changed nor removed.
    expect(contents(topFolder(after, "work"))).toEqual([
      "mine javascript:void(1)",
      "page https://example.com/",
    ]);
    expect(plan({ tables, places: after, base: none.base }).ops).toEqual([]);
    // Once allowed, they reach Places.
    const user = plan({ tables, places: after, base: none.base, bookmarklets: "user" });
    expect(user.skipped).toEqual([]);
    expect(contents(topFolder(applyOps(after, user.ops as Op[]), "work"))).toEqual([
      "run javascript:alert(1)",
      "mine javascript:void(2)",
      "page https://example.com/",
    ]);
  });

  test("a folder holding a kept bookmarklet is still the file's folder, never made twice", () => {
    const tables = tablesOf('[bookmarks.work]\n"tools/page" = "https://example.com/"');
    const tree = work([
      folder("tools0000001", "tools", [bm("bmmine000001", "mine", "javascript:void(1)")]),
    ]);
    const p = plan({ tables, places: tree, approved: 1000 });
    const after = applyOps(tree, p.ops as Op[]);
    expect(contents(topFolder(after, "work"))).toEqual([
      { "tools/": ["mine javascript:void(1)", "page https://example.com/"] },
    ]);
    expect(p.base.tables[0]?.entries.find((e) => e.kind === "folder")?.guid).toBe("tools0000001");
    // A file without the folder leaves it, with the bookmarklet, where it is.
    const gone = plan({
      tables: tablesOf("[bookmarks.work]\n"),
      places: after,
      base: p.base,
      approved: 1000,
    });
    expect(contents(topFolder(applyOps(after, gone.ops as Op[]), "work"))).toEqual([
      { "tools/": ["mine javascript:void(1)"] },
    ]);
  });

  test("a folder holding a kept bookmarklet is matched by its line, not made again", () => {
    // An exported file of a folder of bookmarklets: under "none" they stay out of Places' side
    // of the plan, and the folder above them is neither made twice nor changed.
    const tables = tablesOf(
      [
        "[bookmarks.work]",
        '"tools/run" = "javascript:void(1)"',
        '"tools/page" = "https://e.example/"',
      ].join("\n"),
    );
    const tree = work([
      folder("tools0000001", "tools", [
        bm("tools0000002", "run", "javascript:void(1)"),
        bm("tools0000003", "page", "https://e.example/"),
      ]),
    ]);
    const p = plan({ tables, places: tree });
    expect(p.ops.filter((o) => o.op === "insert")).toEqual([]);
    expect(p.ops.filter((o) => o.op === "update" && o.guid === "tools0000001")).toEqual([]);
    expect(p.ask).toBe(null);
  });

  test("bookmarks outside the mirrored folders are never in the operations", () => {
    const tree = places({
      menu: [bm("menu00000001", "m", "https://example.com/m")],
      toolbar: [
        bm("loose0000001", "loose", "https://example.com/l"),
        folder("home00000001", "home", [bm("home00000002", "h", "https://example.com/h")]),
        folder(W, "work", []),
      ],
    });
    const tables = tablesOf('[bookmarks.work]\n"a" = "https://example.com/a"');
    const p = plan({ tables, places: tree });
    const touched = new Set(
      p.ops.map((o) => (o.op === "insert" || o.op === "reorder" ? o.parentGuid : o.guid)),
    );
    expect([...touched]).toEqual([W]);
  });
});

describe("bookmarks.toml: the base", () => {
  test("round-trips, and anything malformed is no base", () => {
    const base = {
      version: 1,
      source: "bookmarks.toml",
      tables: [
        {
          name: "work",
          folder: "wfolder00001",
          entries: [
            { path: ["docs"], kind: "folder", guid: "docs00000001" },
            {
              path: ["docs", "a"],
              kind: "bookmark",
              url: "https://example.com/a",
              guid: "a00000000001",
            },
          ],
        },
      ],
    };
    expect(parseBase(formatBase(base as never))).toEqual(base);
    for (const bad of [
      "",
      "{",
      "null",
      "[]",
      '{"version":2,"source":"bookmarks.toml","hash":"","tables":[]}',
      '{"version":1,"source":"x","hash":"","tables":[]}',
      '{"version":1,"source":"bookmarks.toml","hash":"","tables":[{"name":"w","folder":3,"entries":[]}]}',
      '{"version":1,"source":"bookmarks.toml","hash":"","tables":[{"name":"w","folder":"f","entries":[{"path":[],"kind":"bookmark","guid":"g"}]}]}',
      '{"version":1,"source":"bookmarks.toml","hash":"","tables":[{"name":"w","folder":"f","entries":[{"path":["a"],"kind":"bookmark","guid":"g"}]}]}',
    ]) {
      expect(parseBase(bad)).toBeNull();
    }
    // `:bookmarks forget` lasts across a restart: the base keeps the content it was given for.
    const forgotten = { version: 1, source: "bookmarks.toml", tables: [], forgotten: "abc=" };
    expect(parseBase(formatBase(forgotten as never))).toEqual(forgotten);
    expect(
      parseBase('{"version":1,"source":"bookmarks.toml","tables":[],"forgotten":3}'),
    ).toBeNull();
    // A table name like __proto__ stays data.
    const proto = { ...base, tables: [{ ...base.tables[0], name: "__proto__" }] };
    expect(parseBase(formatBase(proto as never))?.tables[0]?.name).toBe("__proto__");
  });
});

describe("bookmarks.toml: review fixes", () => {
  const W = "wfolder00001";
  const H = "hfolder00001";
  const twoTables =
    '[bookmarks.work]\n"a" = "https://e.com/a"\n[bookmarks.home]\n"h1" = "https://e.com/h1"\n"h2" = "https://e.com/h2"';
  const twoBase = {
    tables: [
      {
        name: "work",
        folder: W,
        entries: [{ path: ["a"], kind: "bookmark", url: "https://e.com/a", guid: "bmA000000001" }],
      },
      {
        name: "home",
        folder: H,
        entries: [
          { path: ["h1"], kind: "bookmark", url: "https://e.com/h1", guid: "bmH100000001" },
          { path: ["h2"], kind: "bookmark", url: "https://e.com/h2", guid: "bmH200000001" },
        ],
      },
    ],
  } as never;
  const A = () => bm("bmA000000001", "a", "https://e.com/a");
  const H1 = () => bm("bmH100000001", "h1", "https://e.com/h1");
  const H2 = () => bm("bmH200000001", "h2", "https://e.com/h2");

  test("caps path depth at 32 and lines at 20,000", () => {
    const deep = Array.from({ length: 33 }, (_, i) => `f${i}`).join("/");
    expect(errorsOf(`[bookmarks.w]\n"${deep}" = "https://e.com/"`)).toEqual([
      { line: 2, message: "a path deeper than 32 folders" },
    ]);
    const ok = Array.from({ length: 32 }, (_, i) => `f${i}`).join("/");
    expect(errorsOf(`[bookmarks.w]\n"${ok}" = "https://e.com/"`)).toEqual([]);
    const many = Array.from({ length: 20_001 }, (_, i) => `"b${i}" = "https://e.com/"`).join("\n");
    expect(errorsOf(`[bookmarks.w]\n${many}`)).toEqual([
      { line: 0, message: "more than 20000 lines; not read" },
    ]);
  });

  test("a 4 MiB file of deep paths or of many folders reads and plans in bounded time", () => {
    // One line: a path of 4 MiB.
    const deepLine = `[bookmarks.w]\n"${"a/".repeat(2_000_000)}x" = "https://e.com/"`;
    let t0 = performance.now();
    expect(errorsOf(deepLine)[0]?.message).toBe("a path deeper than 32 folders");
    expect(performance.now() - t0).toBeLessThan(budget(10_000));
    // 19,000 lines of paths 32 folders deep, about 3.6 MB, within the 20,000 items with the 31
    // folders they share.
    const seg = (i: number) => Array.from({ length: 31 }, (_, d) => `dir${d}`).join("/") + `/f${i}`;
    const deepMany = `[bookmarks.w]\n${Array.from({ length: 19_000 }, (_, i) => `"${seg(i)}/" = ""`).join("\n")}`;
    expect(deepMany.length).toBeGreaterThan(3_500_000);
    t0 = performance.now();
    const t1 = tablesOf(deepMany);
    const p1 = plan({ tables: t1, places: places() });
    expect(p1.ops.length).toBeGreaterThan(19_000);
    expect(performance.now() - t0).toBeLessThan(budget(15_000));
    // 20,000 empty folders side by side.
    const flat = `[bookmarks.w]\n${Array.from({ length: 20_000 }, (_, i) => `"folder number ${i}/" = ""`).join("\n")}`;
    t0 = performance.now();
    const p2 = plan({ tables: tablesOf(flat), places: places() });
    expect(p2.ops.length).toBe(20_001);
    expect(performance.now() - t0).toBeLessThan(budget(10_000));
  });

  test("the cap counts the folders paths make: 15,500 lines of distinct 31-folder paths are refused fast", () => {
    let text = "[bookmarks.w]\n";
    for (let i = 0; i < 15_500; i++) {
      text += `"${Array.from({ length: 31 }, (_, k) => `${i}x${k}`).join("/")}/b" = "https://x/${i}"\n`;
    }
    expect(text.length).toBeGreaterThan(4_000_000);
    const t0 = performance.now();
    expect(errorsOf(text)).toEqual([
      { line: 0, message: "more than 20000 bookmarks and folders; not read" },
    ]);
    expect(performance.now() - t0).toBeLessThan(budget(8_000));
    // Shared folders count once: 20,000 bookmarks in one folder are within the cap.
    const flat = Array.from({ length: 19_999 }, (_, i) => `"one/b${i}" = "https://e.com/"`).join(
      "\n",
    );
    expect(errorsOf(`[bookmarks.w]\n${flat}`)).toEqual([]);
  });

  test("allows only http, https, file and about, and javascript: behind the bookmarklets gate", () => {
    const bad = [
      "chrome://browser/content/browser.xhtml",
      "resource://gre/x",
      "moz-extension://abc/x",
      "view-source:https://a/",
      "view-source:javascript:alert(1)",
      "blob:https://a/x",
      "jar:file:///x!/y",
      "place:sort=8",
      "ftp://a/",
    ];
    const text = `[bookmarks.w]\n${bad.map((u, i) => `"b${i}" = ${JSON.stringify(u)}`).join("\n")}`;
    expect(errorsOf(text)).toEqual(
      bad.map((u, i) => ({
        line: i + 2,
        message: `${new URL(u).protocol} URLs are not bookmarked from the file: http, https, file, about and javascript only`,
      })),
    );
    expect(
      errorsOf(
        '[bookmarks.w]\n"a" = "https://a/"\n"b" = "http://a/"\n"c" = "file:///etc/hosts"\n"d" = "about:config"\n"e" = " JavaScript:void(0)"',
      ),
    ).toEqual([]);
  });

  test("names: controls, bidi and zero-width characters and outer spaces are refused", () => {
    for (const name of ["a\u202eb", "a\u2066b", "a\u200bb", "a\u0085b", " work", "work "]) {
      const r = errorsOf(`[bookmarks.${JSON.stringify(name)}]\n"a" = "https://e.com/"`);
      expect(r.length, JSON.stringify(name)).toBe(1);
      expect(r[0]!.line).toBe(1);
    }
    for (const title of ["a\u202eb", "a\u0007b", "a\u0085b", "a\u2069b"]) {
      const r = errorsOf(`[bookmarks.w]\n${JSON.stringify(title)} = "https://e.com/"`);
      expect(r, JSON.stringify(title)).toEqual([
        { line: 2, message: "a name with a control or bidirectional character" },
      ]);
    }
  });

  test("errors cut what they echo to 80 characters", () => {
    const long = `/${"x".repeat(500)}`;
    const [e] = errorsOf(`[bookmarks.w]\n"a" = "${long}"`);
    expect(e!.message.length).toBeLessThan(140);
    expect(e!.message).toContain("…");
  });

  test("one claimed set: a workspace folder dragged into another table's folder is moved back, not deleted", () => {
    const tree = places({
      toolbar: [folder(W, "work", [A(), folder(H, "home", [H1(), H2()])])],
    });
    const p = plan({ tables: tablesOf(twoTables), places: tree, base: twoBase });
    expect(p.ops).toEqual([{ op: "update", guid: H, parentGuid: PLACES_ROOTS.toolbar }]);
    expect(p.removed).toEqual([]);
  });

  test("one claimed set: a bookmark dragged from one table's folder into another's is moved back", () => {
    const tree = places({
      toolbar: [folder(W, "work", [A(), H1()]), folder(H, "home", [H2()])],
    });
    const p = plan({ tables: tablesOf(twoTables), places: tree, base: twoBase });
    expect(p.ops.filter((o) => o.op === "remove" || o.op === "insert")).toEqual([]);
    expect(p.ops).toContainEqual({ op: "update", guid: "bmH100000001", parentGuid: H });
    expect(p.removed).toEqual([]);
  });

  test("one claimed set: a renamed table that takes its old folder through the workspace link deletes nothing", () => {
    const tree = places({ toolbar: [folder(W, "work", [A()])] });
    const base = { tables: [(twoBase as { tables: unknown[] }).tables[0]] } as never;
    const p = plan({
      tables: tablesOf('[bookmarks.job]\n"a" = "https://e.com/a"'),
      places: tree,
      base,
      workspaces: [{ name: "job", folder: W }],
    });
    expect(p.ask).toBeNull();
    expect(p.removed).toEqual([]);
    expect(p.ops).toEqual([{ op: "update", guid: W, title: "job" }]);
  });

  test("a removed table keeps protected bookmarklets, also inside its folders", () => {
    const tree = places({
      toolbar: [
        folder(W, "work", [
          A(),
          folder("sub000000001", "tools", [
            bm("js0000000001", "run", "javascript:void(0)"),
            bm("bmB000000001", "b", "https://e.com/b"),
          ]),
        ]),
      ],
    });
    const base = {
      tables: [
        {
          name: "work",
          folder: W,
          entries: [
            { path: ["a"], kind: "bookmark", url: "https://e.com/a", guid: "bmA000000001" },
            { path: ["tools"], kind: "folder", guid: "sub000000001" },
            {
              path: ["tools", "b"],
              kind: "bookmark",
              url: "https://e.com/b",
              guid: "bmB000000001",
            },
          ],
        },
      ],
    } as never;
    const p = plan({ tables: [], places: tree, base, approved: 1000 });
    const after = applyOps(tree, p.ops as Op[]);
    expect(contents(topFolder(after, "work"))).toEqual([{ "tools/": ["run javascript:void(0)"] }]);
  });

  test("a base folder outside the toolbar's top that is not the workspace's is not trusted", () => {
    const tree = places({
      menu: [folder("menufold0001", "mine", [bm("mine00000001", "m", "https://e.com/m")])],
    });
    const base = {
      tables: [
        {
          name: "work",
          folder: "menufold0001",
          entries: [
            { path: ["m"], kind: "bookmark", url: "https://e.com/m", guid: "mine00000001" },
          ],
        },
      ],
    } as never;
    const p = plan({
      tables: tablesOf('[bookmarks.work]\n"a" = "https://e.com/a"'),
      places: tree,
      base,
    });
    const touched = (p.ops as Op[]).map((o) => (o.op === "insert" ? o.parentGuid : o.guid));
    expect(touched).not.toContain("menufold0001");
    expect(touched).not.toContain("mine00000001");
    expect(p.base.tables[0]!.folder).not.toBe("menufold0001");
  });

  test("a base guid outside every mirrored folder is never reused", () => {
    const tree = places({
      menu: [bm("bmA000000001", "a", "https://e.com/a")],
      toolbar: [folder(W, "work", [])],
    });
    const base = { tables: [(twoBase as { tables: unknown[] }).tables[0]] } as never;
    const p = plan({
      tables: tablesOf('[bookmarks.work]\n"a" = "https://e.com/a"'),
      places: tree,
      base,
    });
    expect((p.ops as Op[]).some((o) => o.guid === "bmA000000001")).toBe(false);
    expect(p.ops).toContainEqual(
      expect.objectContaining({ op: "insert", kind: "bookmark", title: "a" }),
    );
  });

  test("outside additions put back count toward the large-deletion question", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `"b${i}" = "https://e.com/${i}"`).join("\n");
    const tables = tablesOf(`[bookmarks.work]\n${lines}`);
    const first = mirror({ tables, places: places() });
    const synced = structuredClone(first.places);
    for (let i = 0; i < 25; i++) {
      topFolder(synced, "work")!.children!.push(
        bm(`sync${String(i).padStart(8, "0")}`, `s${i}`, `https://e.com/s${i}`),
      );
    }
    const p = plan({ tables, places: synced, base: first.plan.base });
    expect(p.ask).toBe('bookmarks.toml removes 25 bookmarks from "work": delete them? y/N');
    expect(p.ops).toEqual([]);
    expect(plan({ tables, places: synced, base: first.plan.base, approved: 25 }).ask).toBeNull();
  });

  test("the plan says which tables its operations change", () => {
    const tables = tablesOf(twoTables);
    const tree = places({ toolbar: [folder(W, "work", [A()]), folder(H, "home", [H1(), H2()])] });
    expect(plan({ tables, places: tree, base: twoBase }).touched).toEqual([]);
    const sep2 = structuredClone(tree);
    topFolder(sep2, "home")!.children!.push(sep("sep000000009"));
    expect(plan({ tables, places: sep2, base: twoBase }).touched).toEqual([]);
    const added = structuredClone(tree);
    topFolder(added, "home")!.children!.push(bm("new000000001", "n", "https://e.com/n"));
    expect(plan({ tables, places: added, base: twoBase }).touched).toEqual(["home"]);
  });

  test("schema 1 config.toml's inline tables are not read", () => {
    expect(
      readBookmarks({ file: null, config: '[bookmarks.work]\n"a" = "https://e.com/a"' }).from,
    ).toBeNull();
  });
});
