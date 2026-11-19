// bookmarks.toml's outside write-back (docs/specs/bookmarks-file.md, Delivery slice 3): the
// three-way merge of a change made in Places (the Library, Sync, an import) with the file and the
// base (D4, Behaviour 13, 15, 20, "Sync and file edits racing").
import { describe, expect, test } from "vitest";
import { mergeOutside } from "../src/config/bookmarks-merge.mjs";
import { parseBookmarksFile, planMirror } from "../src/config/bookmarks-file.mjs";
import { parseConfig } from "../src/config/config.mjs";
import { PLACES_ROOTS } from "../src/ui/bookmarks.mjs";
import { budget } from "./budget.ts";

type Item = {
  guid: string;
  typeCode?: number;
  title?: string;
  uri?: string;
  children?: Item[];
};
type FileItem =
  | { kind: "folder"; title: string; line: number; children: FileItem[] }
  | { kind: "bookmark"; title: string; url: string; line: number };
type Op = Record<string, unknown> & { op: string };
type Base = ReturnType<typeof planMirror>["base"];

const BM = 1;
const FOLDER = 2;

let guidCounter = 0;
const makeGuid = () => `gen${String(++guidCounter).padStart(9, "0")}`;

const bm = (guid: string, title: string, uri: string): Item => ({ guid, typeCode: BM, title, uri });
const folder = (guid: string, title: string, children: Item[] = []): Item => ({
  guid,
  typeCode: FOLDER,
  title,
  children,
});

/** Places as promiseBookmarksTree("") gives it, with `toolbar` filled in. */
function places(toolbar: Item[] = []): Item {
  return {
    guid: "root________",
    typeCode: FOLDER,
    title: "",
    children: [
      folder(PLACES_ROOTS.menu, "menu", []),
      folder(PLACES_ROOTS.toolbar, "toolbar", toolbar),
      folder(PLACES_ROOTS.unfiled, "unfiled", []),
      folder(PLACES_ROOTS.mobile, "mobile", []),
    ],
  };
}

function index(tree: Item) {
  const map = new Map<string, { node: Item; parent: Item | null }>();
  const walk = (n: Item, parent: Item | null) => {
    map.set(n.guid, { node: n, parent });
    for (const c of n.children ?? []) walk(c, n);
  };
  walk(tree, null);
  return map;
}

/** Applies a plan's operations to a copy of `tree`, as BookmarksFile applies them to Places. */
function applyOps(tree: Item, ops: readonly Op[]): Item {
  const root = structuredClone(tree);
  for (const op of ops) {
    const at = index(root);
    if (op.op === "insert") {
      const parent = at.get(op.parentGuid as string)?.node;
      if (!parent) throw new Error(`insert into missing ${String(op.parentGuid)}`);
      const node =
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
      const listed = (op.guids as string[]).map((g) => kids.find((k) => k.guid === g) as Item);
      parent.children = [
        ...listed,
        ...kids.filter((k) => !(op.guids as string[]).includes(k.guid)),
      ];
    } else throw new Error(`unknown op ${op.op}`);
  }
  return root;
}

function shape(items: readonly FileItem[]): unknown[] {
  return items.map((i) =>
    i.kind === "folder" ? { [`${i.title}/`]: shape(i.children) } : `${i.title} ${i.url}`,
  );
}

/** Every table of a bookmarks.toml text as its shape, failing on errors. */
function tables(text: string): Record<string, unknown[]> {
  const r = parseBookmarksFile(text);
  expect(r.errors).toEqual([]);
  return Object.fromEntries(r.tables.map((t) => [t.name, shape(t.children as FileItem[])]));
}

function contents(node: Item | undefined): unknown[] {
  return (node?.children ?? []).map((c) =>
    c.typeCode === FOLDER ? { [`${c.title}/`]: contents(c) } : `${c.title} ${c.uri}`,
  );
}

const toolbarOf = (tree: Item) =>
  tree.children?.find((c) => c.guid === PLACES_ROOTS.toolbar) as Item;
const topFolder = (tree: Item, name: string) =>
  toolbarOf(tree).children?.find((c) => c.typeCode === FOLDER && c.title === name);

/** Mirrors `text` into empty Places: the state both sides agree on after a run. */
function agreed(text: string, extra: Item[] = []) {
  const p = planMirror({
    tables: parseBookmarksFile(text).tables,
    base: null,
    places: places(extra),
    workspaces: [],
    bookmarklets: "none",
    approved: null,
    makeGuid,
  });
  expect(p.ask).toBeNull();
  return { base: p.base, tree: applyOps(places(extra), p.ops as Op[]) };
}

/** The item at `path` (titles) under table folder `table`. */
function at(tree: Item, table: string, ...path: string[]): Item {
  let n = topFolder(tree, table) as Item;
  for (const name of path) {
    n = (n.children ?? []).find((c) => c.title === name) as Item;
    if (!n) throw new Error(`no ${path.join("/")}`);
  }
  return n;
}

/** Changes Places as the Library or Sync would: `fn` gets a copy and edits it. */
function edit(tree: Item, fn: (t: Item, find: (table: string, ...p: string[]) => Item) => void) {
  const copy = structuredClone(tree);
  fn(copy, (table, ...p) => at(copy, table, ...p));
  return copy;
}

/** Moves `node` into `to` at `index` (the end when omitted). */
function move(tree: Item, node: Item, to: Item, index?: number) {
  const parent = [...index_(tree).values()].find((x) => x.node.children?.includes(node))?.node;
  if (parent) parent.children = (parent.children ?? []).filter((c) => c !== node);
  const kids = (to.children ??= []);
  kids.splice(index ?? kids.length, 0, node);
}
const index_ = index;
function remove(tree: Item, node: Item) {
  const parent = [...index(tree).values()].find((x) => x.node.children?.includes(node))?.node;
  if (parent) parent.children = (parent.children ?? []).filter((c) => c !== node);
}

type MergeInput = Parameters<typeof mergeOutside>[0];

function merge(input: Partial<MergeInput> & Pick<MergeInput, "text" | "base" | "places">) {
  return mergeOutside({ source: "bookmarks.toml", bookmarklets: "none", ...input });
}

/**
 * Merges, applies the plan that follows to Places, and checks the loop guard (D5): a second
 * merge changes nothing and the plan after it is empty.
 */
function settle(input: Partial<MergeInput> & Pick<MergeInput, "text" | "base" | "places">) {
  const m = merge(input);
  if (!m.ok) throw new Error(m.error);
  const text = m.text ?? input.text;
  const plan = planMirror({
    tables: parseBookmarksFile(text).tables,
    base: m.base,
    places: input.places,
    workspaces: [],
    bookmarklets: input.bookmarklets ?? "none",
    approved: 1000,
    keep: new Set(m.keep),
    makeGuid,
  });
  expect(plan.ask).toBeNull();
  const after = applyOps(input.places as Item, plan.ops as Op[]);
  const again = merge({ ...input, text, base: plan.base, places: after });
  if (!again.ok) throw new Error(again.error);
  expect(again.text).toBeNull();
  const quiet = planMirror({
    tables: parseBookmarksFile(text).tables,
    base: plan.base,
    places: after,
    workspaces: [],
    bookmarklets: input.bookmarklets ?? "none",
    approved: null,
    keep: new Set(again.keep),
    makeGuid,
  });
  expect(quiet.ops).toEqual([]);
  return { m, text, places: after, base: plan.base as Base };
}

const FILE = [
  "# my links",
  "[bookmarks.work]",
  '"docs/Guide" = "https://vimma.dev/docs"  # the guide',
  '"docs/Source" = "https://searchfox.org/"',
  "",
  "# daily",
  '"Calendar" = "https://calendar.example.com/"',
  '"Mail" = "https://mail.example.com/"',
  "",
].join("\n");

describe("bookmarks.toml: outside changes written to the file (three-way merge)", () => {
  test("an outside add, rename, URL change and removal are written, keeping comments", () => {
    const { base, tree } = agreed(FILE);
    const changed = edit(tree, (t, find) => {
      find("work", "Calendar").title = "Agenda";
      find("work", "Mail").uri = "https://mail.example.com/inbox";
      remove(t, find("work", "docs", "Source"));
      find("work", "docs").children?.push(bm("lib1", "Library add", "https://lib.example/"));
    });
    const { m, text } = settle({ text: FILE, base, places: changed });
    expect(m.ok && m.removing).toEqual([{ table: "work", count: 1, had: 4 }]);
    expect(text).toBe(
      [
        "# my links",
        "[bookmarks.work]",
        '"docs/Guide" = "https://vimma.dev/docs"  # the guide',
        '"docs/Library add" = "https://lib.example/"',
        "",
        "# daily",
        '"Agenda" = "https://calendar.example.com/"',
        '"Mail" = "https://mail.example.com/inbox"',
        "",
      ].join("\n"),
    );
  });

  test("a move within a folder moves only that line; a move between folders follows Places", () => {
    const { base, tree } = agreed(FILE);
    const reordered = edit(tree, (t, find) => {
      move(t, find("work", "Mail"), find("work"), 0);
    });
    const { text } = settle({ text: FILE, base, places: reordered });
    expect(tables(text).work).toEqual([
      "Mail https://mail.example.com/",
      { "docs/": ["Guide https://vimma.dev/docs", "Source https://searchfox.org/"] },
      "Calendar https://calendar.example.com/",
    ]);
    // One line moved; the comments and the other lines stay where they were.
    expect(text.split("\n").filter((l) => l.startsWith("#"))).toEqual(["# my links", "# daily"]);
    expect(text.indexOf('"docs/Guide" = "https://vimma.dev/docs"  # the guide')).toBeGreaterThan(0);

    const intoDocs = edit(tree, (t, find) => {
      move(t, find("work", "Calendar"), find("work", "docs"), 1);
    });
    expect(tables(settle({ text: FILE, base, places: intoDocs }).text).work).toEqual([
      {
        "docs/": [
          "Guide https://vimma.dev/docs",
          "Calendar https://calendar.example.com/",
          "Source https://searchfox.org/",
        ],
      },
      "Mail https://mail.example.com/",
    ]);
  });

  test("a folder renamed in Places renames every line under it; a removed one goes", () => {
    const { base, tree } = agreed(FILE);
    const renamed = edit(tree, (_t, find) => {
      find("work", "docs").title = "manuals";
    });
    expect(tables(settle({ text: FILE, base, places: renamed }).text).work).toEqual([
      { "manuals/": ["Guide https://vimma.dev/docs", "Source https://searchfox.org/"] },
      "Calendar https://calendar.example.com/",
      "Mail https://mail.example.com/",
    ]);
    const gone = edit(tree, (t, find) => remove(t, find("work", "docs")));
    const { m, text } = settle({ text: FILE, base, places: gone });
    expect(tables(text).work).toEqual([
      "Calendar https://calendar.example.com/",
      "Mail https://mail.example.com/",
    ]);
    expect(m.ok && m.removing).toEqual([{ table: "work", count: 2, had: 4 }]);
    // The last bookmark of a folder that stays: the folder's empty line takes its place.
    const emptied = edit(tree, (t, find) => {
      remove(t, find("work", "docs", "Guide"));
      remove(t, find("work", "docs", "Source"));
    });
    expect(tables(settle({ text: FILE, base, places: emptied }).text).work).toEqual([
      { "docs/": [] },
      "Calendar https://calendar.example.com/",
      "Mail https://mail.example.com/",
    ]);
  });

  test("the file wins when both changed one bookmark; removed and changed keeps it", () => {
    const { base, tree } = agreed(FILE);
    // The file: Calendar has a new URL, Mail is gone. Places: Calendar renamed, Mail renamed,
    // docs/Source removed while the file changed its URL.
    const file = FILE.replace("https://calendar.example.com/", "https://cal.example/")
      .replace('"Mail" = "https://mail.example.com/"\n', "")
      .replace("https://searchfox.org/", "https://searchfox.org/mozilla-central/");
    const changed = edit(tree, (t, find) => {
      find("work", "Calendar").title = "Agenda";
      find("work", "Mail").title = "Post";
      remove(t, find("work", "docs", "Source"));
    });
    const { m, text, places: after } = settle({ text: file, base, places: changed });
    expect(tables(text).work).toEqual([
      {
        "docs/": ["Guide https://vimma.dev/docs", "Source https://searchfox.org/mozilla-central/"],
      },
      "Calendar https://cal.example/",
      "Post https://mail.example.com/",
    ]);
    expect(m.ok && m.conflicts).toEqual([
      { table: "work", path: ["docs", "Source"], what: "removal" },
      { table: "work", path: ["Calendar"], what: "change" },
    ]);
    expect(contents(topFolder(after, "work"))).toEqual([
      {
        "docs/": ["Guide https://vimma.dev/docs", "Source https://searchfox.org/mozilla-central/"],
      },
      "Calendar https://cal.example/",
      "Post https://mail.example.com/",
    ]);
  });

  test("an addition on both sides under one name: the Places one is written as name (2)", () => {
    const { base, tree } = agreed(FILE);
    const file = `${FILE}"News" = "https://news.example/a"\n`;
    const changed = edit(tree, (_t, find) => {
      find("work").children?.push(bm("lib2", "News", "https://news.example/b"));
    });
    const { m, text, places: after } = settle({ text: file, base, places: changed });
    expect((tables(text).work ?? []).slice(-2)).toEqual([
      "News https://news.example/a",
      "News (2) https://news.example/b",
    ]);
    expect(m.ok && m.renamed).toEqual([{ table: "work", from: "News", to: "News (2)" }]);
    // Places takes the file's name and order.
    expect(contents(topFolder(after, "work")).slice(-2)).toEqual([
      "News https://news.example/a",
      "News (2) https://news.example/b",
    ]);
  });

  test("the same change or addition on both sides is one, not a conflict or a (2)", () => {
    const { base, tree } = agreed(FILE);
    // Both renamed Calendar to Agenda and added News (git and Sync carrying one change).
    const file = `${FILE.replace('"Calendar"', '"Agenda"')}"News" = "https://news.example/"\n`;
    const changed = edit(tree, (_t, find) => {
      find("work", "Calendar").title = "Agenda";
      find("work").children?.push(bm("news1", "News", "https://news.example/"));
    });
    const { m, text } = settle({ text: file, base, places: changed });
    expect(m.ok && m.text).toBeNull();
    expect(m.ok && [m.conflicts, m.renamed]).toEqual([[], []]);
    expect(text).toBe(file);
    const work = m.ok ? m.base.tables[0] : undefined;
    expect(work?.entries.find((e) => e.path.join("/") === "News")?.guid).toBe("news1");
  });

  test("an empty title is written as the URL; names are cleaned as the file holds them", () => {
    const { base, tree } = agreed(FILE);
    const changed = edit(tree, (_t, find) => {
      find("work").children?.push(bm("e1", "", "https://empty.example/"));
      find("work").children?.push(bm("e2", "  a‮b\tc ", "https://bidi.example/"));
    });
    expect(
      (tables(settle({ text: FILE, base, places: changed }).text).work ?? []).slice(-2),
    ).toEqual(["https://empty.example/ https://empty.example/", "ab c https://bidi.example/"]);
  });

  test("a guid changed by Sync's dedupe is the same item, not a removal and an addition", () => {
    const { base, tree } = agreed(FILE);
    const deduped = edit(tree, (_t, find) => {
      find("work").guid = "folderNEW01";
      find("work", "docs").guid = "docsNEW0001";
      find("work", "Mail").guid = "mailNEW0001";
    });
    const m = merge({ text: FILE, base, places: deduped });
    expect(m.ok && m.text).toBeNull();
    expect(m.ok && m.removing).toEqual([]);
    const work = m.ok ? m.base.tables.find((t) => t.name === "work") : undefined;
    expect(work?.folder).toBe("folderNEW01");
    expect(work?.entries.find((e) => e.path.join("/") === "Mail")?.guid).toBe("mailNEW0001");
    expect(work?.entries.find((e) => e.path.join("/") === "docs")?.guid).toBe("docsNEW0001");
  });

  test("a workspace folder renamed renames the table; moved or deleted removes it", () => {
    const two = `${FILE}\n[bookmarks.home]\n"h" = "https://h.example/"\n`;
    const { base, tree } = agreed(two);
    const renamed = edit(tree, (_t, find) => {
      find("work").title = "job";
    });
    const r = settle({ text: two, base, places: renamed });
    expect(r.text).toContain("[bookmarks.job]\n");
    expect(Object.keys(tables(r.text))).toEqual(["job", "home"]);
    // A name the file cannot take (another table's) is put back.
    const clash = edit(tree, (_t, find) => {
      find("work").title = "home";
    });
    const c = merge({ text: two, base, places: clash });
    expect(c.ok && c.text).toBeNull();
    expect(c.ok && c.putBack).toEqual([{ table: "work", id: "table" }]);

    const deleted = edit(tree, (t) => remove(t, topFolder(t, "work") as Item));
    const d = merge({ text: two, base, places: deleted });
    expect(d.ok && Object.keys(tables(d.text as string))).toEqual(["home"]);
    expect(d.ok && d.removing).toEqual([{ table: "work", count: 4, had: 4 }]);
    const moved = edit(tree, (t) => {
      const menu = t.children?.find((c) => c.guid === PLACES_ROOTS.menu) as Item;
      move(t, topFolder(t, "work") as Item, menu);
    });
    const mv = merge({ text: two, base, places: moved });
    expect(mv.ok && Object.keys(tables(mv.text as string))).toEqual(["home"]);
    // A table the file changed meanwhile is kept, and its folder made again.
    const edited = `${two}`.replace(
      '"Mail" = "https://mail.example.com/"',
      '"Mail" = "https://m2/"',
    );
    const kept = merge({ text: edited, base, places: deleted });
    expect(kept.ok && kept.text).toBeNull();
    expect(kept.ok && kept.conflicts).toEqual([{ table: "work", path: [], what: "removal" }]);
  });

  test("a folder moved into another table's folder moves its lines into that table", () => {
    const two = `${FILE}\n[bookmarks.home]\n"h" = "https://h.example/"\n`;
    const { base, tree } = agreed(two);
    const moved = edit(tree, (t) => {
      move(t, topFolder(t, "home") as Item, topFolder(t, "work") as Item);
    });
    const r = merge({ text: two, base, places: moved });
    expect(r.ok && tables(r.text as string)).toEqual({
      work: [
        { "docs/": ["Guide https://vimma.dev/docs", "Source https://searchfox.org/"] },
        "Calendar https://calendar.example.com/",
        "Mail https://mail.example.com/",
        { "home/": ["h https://h.example/"] },
      ],
    });
  });

  test("Places items the file cannot hold are kept in Places, never written or removed", () => {
    const { base, tree } = agreed(FILE);
    const changed = edit(tree, (_t, find) => {
      const w = find("work");
      w.children?.push(bm("d1", "data", "data:text/html,x"));
      w.children?.push(bm("p1", "place", "place:parent=toolbar_____"));
      w.children?.push(bm("j1", "script", "javascript:alert(1)"));
      w.children?.push(folder("f1", "only data", [bm("d2", "x", "data:,y")]));
    });
    const { m, text, places: after } = settle({ text: FILE, base, places: changed });
    expect(m.ok && [...m.keep].sort()).toEqual(["d1", "d2", "j1", "p1"]);
    expect((tables(text).work ?? []).at(-1)).toEqual({ "only data/": [] });
    expect(JSON.stringify(contents(topFolder(after, "work")))).toContain("data:text/html,x");
    // A bookmarklet is written while bookmarklets are allowed.
    const allowed = merge({ text: FILE, base, places: changed, bookmarklets: "user" });
    expect(allowed.ok && allowed.text).toContain('"script" = "javascript:alert(1)"');
  });

  test("a Places-only item (made in a private window) stays out of the file and is kept", () => {
    const { base, tree } = agreed(FILE);
    const changed = edit(tree, (_t, find) => {
      find("work").children?.push(bm("priv1", "secret", "https://private.example/"));
    });
    const m = merge({ text: FILE, base, places: changed, local: new Set(["priv1"]) });
    expect(m.ok && m.text).toBeNull();
    expect(m.ok && m.keep).toEqual(["priv1"]);
    expect(m.ok && m.local).toEqual(["priv1"]);
    // A change of a mirrored bookmark made there is put back, not written.
    const renamed = edit(tree, (_t, find) => {
      find("work", "Mail").title = "secret title";
    });
    const mail = at(tree, "work", "Mail").guid;
    const p = merge({ text: FILE, base, places: renamed, putBackGuids: new Set([mail]) });
    expect(p.ok && p.text).toBeNull();
    expect(p.ok && p.putBack).toEqual([{ table: "work", id: `guid\0${mail}` }]);
  });

  test("equal sides produce no edit, and a held table is left as it is", () => {
    const { base, tree } = agreed(FILE);
    const m = merge({ text: FILE, base, places: tree });
    expect(m.ok && m.text).toBeNull();
    expect(m.ok && m.removing).toEqual([]);
    const changed = edit(tree, (_t, find) => {
      find("work", "Mail").title = "Post";
    });
    const held = merge({ text: FILE, base, places: changed, hold: new Set(["work"]) });
    expect(held.ok && held.text).toBeNull();
  });

  test("inline tables in config.toml are edited in place, every other line kept", () => {
    const config = [
      "schema = 2",
      "[bookmarks]",
      'root = "toolbar"',
      "",
      "[bookmarks.work]",
      '"a" = "https://a.example/"',
      "",
      "[keys]",
      "",
    ].join("\n");
    const tablesIn = (text: string) => {
      const r = parseBookmarksFile(
        text.replace(/^schema = 2\n\[bookmarks\]\nroot = "toolbar"\n/, ""),
      );
      return r.tables.map((t) => [t.name, shape(t.children as FileItem[])]);
    };
    const p = planMirror({
      tables: parseBookmarksFile('[bookmarks.work]\n"a" = "https://a.example/"\n').tables,
      base: null,
      places: places(),
      workspaces: [],
      bookmarklets: "none",
      approved: null,
      makeGuid,
    });
    const tree = applyOps(places(), p.ops as Op[]);
    const changed = edit(tree, (_t, find) => {
      find("work").children?.push(bm("c1", "b", "https://b.example/"));
    });
    const m = mergeOutside({
      text: config,
      source: "config.toml",
      base: p.base,
      places: changed,
      bookmarklets: "none",
    });
    expect(m.ok && m.text).toBe(
      config.replace(
        '"a" = "https://a.example/"\n',
        '"a" = "https://a.example/"\n"b" = "https://b.example/"\n',
      ),
    );
    expect(tablesIn(m.ok ? (m.text as string) : "")).toEqual([
      ["work", ["a https://a.example/", "b https://b.example/"]],
    ]);
  });
});

describe("bookmarks.toml merge: a removal the user declined", () => {
  test("keepRemovals puts removals back and still writes the batch's additions, renames and moves", () => {
    const { base, tree } = agreed(FILE);
    // One Sync batch: removes docs/Source and Mail, adds two bookmarks, renames Calendar, and
    // moves Guide out of docs.
    const changed = edit(tree, (t, find) => {
      remove(t, find("work", "docs", "Source"));
      remove(t, find("work", "Mail"));
      find("work").children?.push(bm("new00000001", "New 1", "https://n.example/1"));
      find("work", "docs").children?.push(bm("new00000002", "New 2", "https://n.example/2"));
      find("work", "Calendar").title = "Agenda";
      move(t, find("work", "docs", "Guide"), find("work"));
    });
    const {
      m,
      text,
      places: after,
    } = settle({ text: FILE, base, places: changed, keepRemovals: true });
    expect(m.ok && m.removing).toEqual([]);
    expect(tables(text).work).toEqual([
      { "docs/": ["Source https://searchfox.org/", "New 2 https://n.example/2"] },
      "Agenda https://calendar.example.com/",
      "Mail https://mail.example.com/",
      "New 1 https://n.example/1",
      "Guide https://vimma.dev/docs",
    ]);
    // Places gets the removed ones back and keeps the additions.
    const urls = JSON.stringify(contents(topFolder(after, "work")));
    for (const u of ["searchfox.org", "mail.example.com", "n.example/1", "n.example/2"]) {
      expect(urls).toContain(u);
    }
    // A table whose folder went is kept too.
    const deleted = edit(tree, (t) => remove(t, topFolder(t, "work") as Item));
    const d = merge({ text: FILE, base, places: deleted, keepRemovals: true });
    expect(d.ok && [d.text, d.removing]).toEqual([null, []]);
  });
});

describe("bookmarks.toml merge: bounded time", () => {
  test("a full reorder of 16,000 bookmarks in 4 folders merges in linear time", () => {
    const n = 16_000;
    const names = (i: number) => `f${i % 4}/b${i}`;
    const text = `[bookmarks.work]\n${Array.from(
      { length: n },
      (_, i) => `${JSON.stringify(names(i))} = "https://example.com/${i}"`,
    ).join("\n")}\n`;
    const entries: { path: string[]; kind: "bookmark" | "folder"; url?: string; guid: string }[] = [
      0, 1, 2, 3,
    ].map((f) => ({ path: [`f${f}`], kind: "folder" as const, guid: `fold${f}` }));
    const folders = [0, 1, 2, 3].map((f) => folder(`fold${f}`, `f${f}`, []));
    for (let i = 0; i < n; i++) {
      const guid = `bm${String(i).padStart(10, "0")}`;
      entries.push({
        path: [`f${i % 4}`, `b${i}`],
        kind: "bookmark",
        url: `https://example.com/${i}`,
        guid,
      });
      folders[i % 4]?.children?.push(bm(guid, `b${i}`, `https://example.com/${i}`));
    }
    // Sorted the other way round, as the Library's "Sort by Name" or another device's order.
    for (const f of folders) f.children?.reverse();
    const start = performance.now();
    const m = merge({
      text,
      base: { tables: [{ name: "work", folder: "workfolder01", entries }] },
      places: places([folder("workfolder01", "work", folders)]),
    });
    expect(performance.now() - start).toBeLessThan(budget(3000));
    expect(m.ok).toBe(true);
    const t = tables(m.ok ? (m.text as string) : "").work as { [k: string]: string[] }[];
    expect(t[0]?.["f0/"]?.[0]).toBe(`b${n - 4} https://example.com/${n - 4}`);
  }, 60_000);

  test("5,000 Places additions of one title are named in linear time", () => {
    const text = '[bookmarks.work]\n"a" = "https://example.com/a"\n';
    const { base, tree } = agreed(text);
    const changed = edit(tree, (_t, find) => {
      for (let i = 0; i < 5000; i++)
        find("work").children?.push(bm(`same${i}`, "same", `https://s.example/${i}`));
    });
    const start = performance.now();
    const m = merge({ text, base, places: changed });
    expect(performance.now() - start).toBeLessThan(budget(2000));
    expect(m.ok && m.text?.includes('"same (5000)" = "https://s.example/4999"')).toBe(true);
  }, 60_000);

  test("a 5,000-bookmark folder with a Sync batch and a reorder merges in linear time", () => {
    const n = 5000;
    const text = `[bookmarks.work]\n${Array.from(
      { length: n },
      (_, i) => `"b${i}" = "https://example.com/${i}"`,
    ).join("\n")}\n`;
    // Built directly: the state a run leaves, without planning 5,000 inserts first.
    const entries = Array.from({ length: n }, (_, i) => ({
      path: [`b${i}`],
      kind: "bookmark" as const,
      url: `https://example.com/${i}`,
      guid: `bm${String(i).padStart(10, "0")}`,
    }));
    const kids = entries.map((e) => bm(e.guid, e.path[0] as string, e.url));
    for (let i = 0; i < 500; i++) kids.push(bm(`s${i}`, `s${i}`, `https://s.example/${i}`));
    kids.unshift(...kids.splice(10, 1));
    kids.splice(21, 1);
    const start = performance.now();
    const m = merge({
      text,
      base: { tables: [{ name: "work", folder: "workfolder01", entries }] },
      places: places([folder("workfolder01", "work", kids)]),
    });
    expect(performance.now() - start).toBeLessThan(budget(3000));
    expect(m.ok && m.text?.split("\n")[1]).toBe('"b10" = "https://example.com/10"');
    expect(m.ok && m.removing).toEqual([{ table: "work", count: 1, had: n }]);
  }, 20_000);
});

describe("config: [bookmarks] write_back", () => {
  test("config: write_back accepts all, vimma and none, defaults to all, suggests the closest", () => {
    expect(parseConfig("schema = 2\n").config?.bookmarks.writeBack).toBe("all");
    for (const v of ["all", "vimma", "none"]) {
      expect(
        parseConfig(`schema = 2\n[bookmarks]\nwrite_back = "${v}"\n`).config?.bookmarks.writeBack,
      ).toBe(v);
    }
    expect(parseConfig('schema = 2\n[bookmarks]\nwrite_back = "al"\n').errors).toEqual([
      {
        path: "bookmarks.write_back",
        line: 3,
        message: 'must be "all", "vimma" or "none"',
        suggestion: "all",
      },
    ]);
  });
});
