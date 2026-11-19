// Fuzzing the outside write-back's three-way merge (docs/specs/bookmarks-file.md, Delivery slice
// 3): for any base, any change of the file and any change of Places (adds, removals, renames, new
// URLs, moves, reorders, items the file cannot hold), the merge never throws, the file it writes
// reads without an error, no item present in either side is lost, and once the run has brought
// Places to the file a second merge changes nothing (the loop guard, D5).
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { mergeOutside } from "../../src/config/bookmarks-merge.mjs";
import { parseBookmarksFile, planMirror } from "../../src/config/bookmarks-file.mjs";
import { PLACES_ROOTS } from "../../src/ui/bookmarks.mjs";
import { FUZZ_TIMEOUT, fuzz, within } from "./harness.ts";

type Item = { guid: string; typeCode?: number; title?: string; uri?: string; children?: Item[] };
type Op = Record<string, unknown> & { op: string };
type FileItem =
  | { kind: "folder"; title: string; children: FileItem[] }
  | { kind: "bookmark"; title: string; url: string };

const BM = 1;
const FOLDER = 2;
const NAMES = ["a", "b", "c", "docs", "Docs", "x y", "2024", "__proto__"];
const URLS = [
  "https://a.example/",
  "https://b.example/",
  "https://c.example/x",
  "https://a.example/",
  "http://d.example/",
];
const BAD = ["data:text/html,x", "place:parent=toolbar_____", "javascript:void(0)"];

let guids = 0;
const makeGuid = () => `fz${String(++guids).padStart(10, "0")}`;

function places(toolbar: Item[] = []): Item {
  const f = (guid: string, children: Item[]) => ({ guid, typeCode: FOLDER, title: "", children });
  return {
    guid: "root________",
    typeCode: FOLDER,
    children: [
      f(PLACES_ROOTS.menu, []),
      f(PLACES_ROOTS.toolbar, toolbar),
      f(PLACES_ROOTS.unfiled, []),
      f(PLACES_ROOTS.mobile, []),
    ],
  };
}

function index(tree: Item) {
  const map = new Map<string, { node: Item; parent: Item | null }>();
  const stack: [Item, Item | null][] = [[tree, null]];
  while (stack.length) {
    const [n, parent] = stack.pop() as [Item, Item | null];
    map.set(n.guid, { node: n, parent });
    for (const c of n.children ?? []) stack.push([c, n]);
  }
  return map;
}

function applyOps(tree: Item, ops: readonly Op[]): Item {
  const root = structuredClone(tree);
  for (const op of ops) {
    const at = index(root);
    if (op.op === "insert") {
      const parent = at.get(op.parentGuid as string)?.node as Item;
      parent.children ??= [];
      parent.children.push(
        op.kind === "folder"
          ? { guid: op.guid as string, typeCode: FOLDER, title: op.title as string, children: [] }
          : {
              guid: op.guid as string,
              typeCode: BM,
              title: op.title as string,
              uri: op.url as string,
            },
      );
    } else if (op.op === "update") {
      const found = at.get(op.guid as string);
      if (!found) throw new Error(`update of missing ${String(op.guid)}`);
      if (op.title !== undefined) found.node.title = op.title as string;
      if (op.url !== undefined) found.node.uri = op.url as string;
      if (op.parentGuid !== undefined && found.parent) {
        found.parent.children = (found.parent.children ?? []).filter((c) => c !== found.node);
        const to = at.get(op.parentGuid as string)?.node as Item;
        (to.children ??= []).push(found.node);
      }
    } else if (op.op === "remove") {
      const found = at.get(op.guid as string);
      if (!found?.parent) throw new Error(`remove of missing ${String(op.guid)}`);
      found.parent.children = (found.parent.children ?? []).filter((c) => c !== found.node);
    } else if (op.op === "reorder") {
      const parent = at.get(op.parentGuid as string)?.node as Item;
      const kids = parent.children ?? [];
      const listed = (op.guids as string[]).map((g) => kids.find((k) => k.guid === g) as Item);
      parent.children = [
        ...listed,
        ...kids.filter((k) => !(op.guids as string[]).includes(k.guid)),
      ];
    }
  }
  return root;
}

/** A small table: names and URLs from short lists, so that paths and URLs collide. */
const fileItem: fc.Memo<FileItem> = fc.memo((n) =>
  n <= 1
    ? fc.record({
        kind: fc.constant("bookmark" as const),
        title: fc.constantFrom(...NAMES),
        url: fc.constantFrom(...URLS),
      })
    : fc.oneof(
        {
          weight: 3,
          arbitrary: fc.record({
            kind: fc.constant("bookmark" as const),
            title: fc.constantFrom(...NAMES),
            url: fc.constantFrom(...URLS),
          }),
        },
        {
          weight: 1,
          arbitrary: fc.record({
            kind: fc.constant("folder" as const),
            title: fc.constantFrom(...NAMES),
            children: fc.array(fileItem(n - 1), { maxLength: 3 }),
          }),
        },
      ),
);

/** A table's items as lines, each path once. */
function linesOf(
  items: readonly FileItem[],
  at: string[] = [],
  seen = new Set<string>(),
): string[] {
  const out: string[] = [];
  for (const i of items) {
    const path = [...at, i.title];
    const key = `${i.kind}\0${path.join("\0")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (i.kind === "bookmark")
      out.push(`${JSON.stringify(path.join("/"))} = ${JSON.stringify(i.url)}`);
    else if (!i.children.length) out.push(`${JSON.stringify(`${path.join("/")}/`)} = ""`);
    else out.push(...linesOf(i.children, path, seen));
  }
  return out;
}

const tableText = (name: string, items: readonly FileItem[]) =>
  [`[bookmarks.${name}]`, ...linesOf(items)].join("\n");

/** A change of Places as the Library or Sync makes one, picked by numbers. */
const placesChange = fc.tuple(
  fc.constantFrom("add", "addBad", "addFolder", "remove", "rename", "url", "move", "reorder"),
  fc.nat(),
  fc.nat(),
  fc.constantFrom(...NAMES, "", " a "),
  fc.constantFrom(...URLS),
);

type PlacesChange = typeof placesChange extends fc.Arbitrary<infer T> ? T : never;

/** A change of the file's lines, picked by numbers. */
const fileChange = fc.tuple(
  fc.constantFrom("drop", "url", "rename", "add"),
  fc.nat(),
  fc.constantFrom(...NAMES),
  fc.constantFrom(...URLS),
);

type FileChange = typeof fileChange extends fc.Arbitrary<infer T> ? T : never;

function mirrored(tree: Item, folders: readonly string[]) {
  const at = index(tree);
  const out: Item[] = [];
  for (const f of folders) {
    const stack = [...(at.get(f)?.node.children ?? [])];
    while (stack.length) {
      const n = stack.pop() as Item;
      if (n.typeCode === BM || n.typeCode === FOLDER) out.push(n);
      stack.push(...(n.children ?? []));
    }
  }
  return out;
}

function changePlaces(tree: Item, folders: readonly string[], changes: PlacesChange[]) {
  const t = structuredClone(tree);
  for (const [what, i, j, name, url] of changes) {
    const at = index(t);
    const items = mirrored(t, folders);
    const dirs = [
      ...folders.map((f) => at.get(f)?.node as Item),
      ...items.filter((n) => n.typeCode === FOLDER),
    ];
    const dir = dirs[i % dirs.length] as Item;
    const item = items.length ? items[j % items.length] : undefined;
    if (what === "add" || what === "addBad") {
      (dir.children ??= []).push({
        guid: makeGuid(),
        typeCode: BM,
        title: name,
        uri: what === "add" ? url : (BAD[i % BAD.length] as string),
      });
    } else if (what === "addFolder") {
      (dir.children ??= []).push({ guid: makeGuid(), typeCode: FOLDER, title: name, children: [] });
    } else if (!item) continue;
    else if (what === "remove") {
      const p = at.get(item.guid)?.parent as Item;
      p.children = (p.children ?? []).filter((c) => c !== item);
    } else if (what === "rename") item.title = name;
    else if (what === "url" && item.typeCode === BM) item.uri = url;
    else if (what === "move") {
      // Never into itself or below it.
      for (let p: Item | null | undefined = dir; p; p = at.get(p.guid)?.parent)
        if (p === item) return t;
      const p = at.get(item.guid)?.parent as Item;
      p.children = (p.children ?? []).filter((c) => c !== item);
      (dir.children ??= []).splice(i % ((dir.children?.length ?? 0) + 1), 0, item);
    } else if (what === "reorder") {
      const p = at.get(item.guid)?.parent as Item;
      const kids = (p.children ?? []).filter((c) => c !== item);
      kids.splice(i % (kids.length + 1), 0, item);
      p.children = kids;
    }
  }
  return t;
}

function changeFile(text: string, changes: FileChange[]) {
  const rows = text.split("\n");
  for (const [what, i, name, url] of changes) {
    const lines = rows.map((r, k) => [r, k] as const).filter(([r]) => r.startsWith('"'));
    if (what === "add") {
      rows.push(`${JSON.stringify(`${name} new`)} = ${JSON.stringify(url)}`);
      continue;
    }
    if (!lines.length) continue;
    const [row, k] = lines[i % lines.length] as readonly [string, number];
    if (what === "drop") rows.splice(k, 1);
    else if (what === "url" && !row.endsWith('= ""'))
      rows[k] = row.replace(/= ".*"$/, `= ${JSON.stringify(url)}`);
    else if (what === "rename")
      rows[k] = row.replace(/^"((?:[^"\\]|\\.)*)"/, (_m, key: string) =>
        JSON.stringify(`${JSON.parse(`"${key}"`) as string}.${name}`),
      );
  }
  const out = rows.join("\n");
  return parseBookmarksFile(out).errors.length ? text : out;
}

/** Every bookmark URL of a parsed file. */
function urlsOf(text: string) {
  const out = new Set<string>();
  for (const t of parseBookmarksFile(text).tables) {
    const stack = [...t.children];
    while (stack.length) {
      const i = stack.pop() as (typeof stack)[number];
      if (i.kind === "bookmark") out.add(i.url);
      else stack.push(...i.children);
    }
  }
  return out;
}

/** Every bookmark of a file as table, path and URL. */
function linesWithPaths(text: string) {
  const out: { table: string; path: string[]; url: string }[] = [];
  for (const t of parseBookmarksFile(text).tables) {
    const stack: [(typeof t.children)[number], string[]][] = t.children.map((c) => [c, [c.title]]);
    while (stack.length) {
      const [i, path] = stack.pop() as [(typeof t.children)[number], string[]];
      if (i.kind === "bookmark") out.push({ table: t.name, path, url: i.url });
      else for (const c of i.children) stack.push([c, [...path, c.title]]);
    }
  }
  return out;
}

describe("bookmarks.toml merge fuzzing", () => {
  test(
    "merging then parsing never loses an item present in either side, and settles",
    () =>
      fuzz(
        "bookmarks-merge",
        fc.property(
          fc.array(fileItem(3), { maxLength: 6 }),
          fc.array(fileItem(2), { maxLength: 3 }),
          fc.array(placesChange, { maxLength: 5 }),
          fc.array(fileChange, { maxLength: 3 }),
          (work, home, pc, fcs) => {
            const text = `${tableText("work", work)}\n\n${tableText("home", home)}\n`;
            const tables = parseBookmarksFile(text).tables;
            if (parseBookmarksFile(text).errors.length) return;
            const first = planMirror({
              tables,
              base: null,
              places: places(),
              workspaces: [],
              bookmarklets: "none",
              approved: null,
              makeGuid,
            });
            const tree = applyOps(places(), first.ops as Op[]);
            const base = first.base;
            const folders = base.tables.map((t) => t.folder);
            const changed = changePlaces(tree, folders, pc);
            const file = changeFile(text, fcs);
            const m = within(1000, () =>
              mergeOutside({
                text: file,
                source: "bookmarks.toml",
                base,
                places: changed,
                bookmarklets: "none",
              }),
            );
            if (!m.ok) return; // refused: nothing written, nothing lost
            const out = m.text ?? file;
            expect(parseBookmarksFile(out).errors).toEqual([]);
            const got = urlsOf(out);
            const keep = new Set(m.keep);
            const lines = linesWithPaths(out);
            const at = (table: string, path: readonly string[]) =>
              lines.find((l) => l.table === table && l.path.join("\0") === path.join("\0"));
            const baseByGuid = new Map(
              base.tables.flatMap((t) => t.entries.map((e) => [e.guid, { ...e, table: t.name }])),
            );
            const fileLines = linesWithPaths(file);
            const inFile = (table: string, path: readonly string[], url?: string) =>
              fileLines.some(
                (l) => l.table === table && l.path.join("\0") === path.join("\0") && l.url === url,
              );
            const live = new Set(mirrored(changed, folders).map((n) => n.guid));
            // Places' side: every bookmark in a mirrored folder is still somewhere, by its guid: in
            // the file (with the file's change, when both changed it), or kept in Places; unless
            // the file removed it while Places left it as it was.
            for (const n of mirrored(changed, folders)) {
              if (n.typeCode !== BM || keep.has(n.guid)) continue;
              const entry = m.base.tables
                .flatMap((t) => t.entries.map((e) => ({ ...e, table: t.name })))
                .find((e) => e.guid === n.guid && e.kind === "bookmark");
              if (entry && at(entry.table, entry.path)) continue;
              const url = new URL(n.uri as string).href;
              // A guid the base does not know with a base item's place and URL is that item, its
              // guid changed (Sync's dedupe): the merge cannot tell a removal and an identical add.
              const e =
                baseByGuid.get(n.guid) ??
                [...baseByGuid.values()].find(
                  (x) => x.url === url && x.path.at(-1) === n.title?.trim() && !live.has(x.guid),
                );
              const placesSame = !!e && n.title?.trim() === e.path.at(-1) && url === e.url;
              const removedByFile = !!e && !inFile(e.table, e.path, e.url) && placesSame;
              expect({ lost: n, removedByFile }).toEqual({ lost: n, removedByFile: true });
            }
            // The file's side: every line is still there, unless Places removed or changed it
            // while the file left it as it was.
            for (const l of fileLines) {
              if (got.has(l.url)) continue;
              const t = base.tables.find((x) => x.name === l.table);
              const e = t?.entries.find(
                (x) =>
                  x.kind === "bookmark" && x.url === l.url && x.path.join("/") === l.path.join("/"),
              );
              expect({ lost: l, takenByPlaces: !!e }).toEqual({ lost: l, takenByPlaces: true });
            }
            // The loop guard: the run brings Places to the file, and a second merge is empty.
            const plan = planMirror({
              tables: parseBookmarksFile(out).tables,
              base: m.base,
              places: changed,
              workspaces: [],
              bookmarklets: "none",
              approved: 100000,
              keep,
              makeGuid,
            });
            const after = applyOps(changed, plan.ops as Op[]);
            const again = mergeOutside({
              text: out,
              source: "bookmarks.toml",
              base: plan.base,
              places: after,
              bookmarklets: "none",
            });
            expect(again.ok).toBe(true);
            expect(again.ok && again.text).toBeNull();
          },
        ),
      ),
    FUZZ_TIMEOUT,
  );
});
