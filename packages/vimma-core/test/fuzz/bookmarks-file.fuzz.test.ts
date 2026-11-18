// Fuzzing bookmarks.toml (docs/specs/bookmarks-file.md): the file may come from someone else's
// repository, so the reader must take any text without a throw or a hang, and a file it accepts
// holds only lines the mirror may put into Places: absolute URLs, never data:, names within
// Places' limits.
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import {
  MAX_BOOKMARK_TITLE,
  parseBookmarksFile,
  readBookmarks,
} from "../../src/config/bookmarks-file.mjs";
import { editBookmarkLines } from "../../src/config/bookmarks-edit.mjs";
import { exportBookmarks } from "../../src/config/bookmarks-export.mjs";
import { FUZZ_TIMEOUT, PROTO_NAMES, fuzz, nastyString, within } from "./harness.ts";
import { configText } from "./toml-arb.ts";

type Item =
  | { kind: "folder"; title: string; children: Item[] }
  | { kind: "bookmark"; title: string; url: string };

const tomlString = (s: string) => JSON.stringify(s);

/** A bookmarks line: a path made of nasty names and separators, and a URL-ish value. */
const line = fc
  .tuple(
    fc.array(fc.oneof(nastyString, fc.constantFrom(...PROTO_NAMES, "/", "\\/", " ", "")), {
      maxLength: 4,
    }),
    fc.oneof(
      fc.constantFrom(
        "",
        "https://example.com/",
        "https://searchfox.org",
        "data:text/html,x",
        " DATA:,x",
        "javascript:alert(1)",
        "/relative",
        "file:///etc/passwd",
        "place:parent=toolbar_____",
      ),
      nastyString,
    ),
  )
  .map(([parts, value]) => `${tomlString(parts.join("/"))} = ${tomlString(value)}`);

const tableName = fc.oneof(nastyString, fc.constantFrom(...PROTO_NAMES, "work", "my shop"));

/** A bookmarks.toml of a few tables, or any TOML or text at all. */
const fileText = fc.oneof(
  {
    weight: 3,
    arbitrary: fc
      .array(fc.tuple(tableName, fc.array(line, { maxLength: 8 })), { maxLength: 4 })
      .map((tables) =>
        tables.map(([n, ls]) => [`[bookmarks.${tomlString(n)}]`, ...ls].join("\n")).join("\n"),
      ),
  },
  { weight: 1, arbitrary: configText },
);

/** Every item of a table, depth first. */
function* items(list: readonly Item[]): Generator<Item> {
  for (const i of list) {
    yield i;
    if (i.kind === "folder") yield* items(i.children);
  }
}

/** The URL of the line the edit property adds. */
const ADDED = "https://added.example/";
/** Whether a bookmark key (`[table, path, url]` as JSON) is not the added line's: its URL alone. */
const notAdded = (key: string) => (JSON.parse(key) as [string, string[], string])[2] !== ADDED;

/** Every bookmark of a parsed file as `table, path, url`, with its line. */
function bookmarksOf(text: string) {
  const r = parseBookmarksFile(text);
  const out: { table: string; key: string; line: number }[] = [];
  for (const t of r.tables) {
    const walk = (list: readonly Item[], at: string[]) => {
      for (const i of list) {
        if (i.kind === "folder") walk(i.children, [...at, i.title]);
        else {
          const line = (i as unknown as { line: number }).line;
          out.push({ table: t.name, key: JSON.stringify([t.name, [...at, i.title], i.url]), line });
        }
      }
    };
    walk(t.children as Item[], []);
  }
  return { errors: r.errors, bookmarks: out, tables: r.tables.map((t) => t.name) };
}

/** A Places node as promiseBookmarksTree gives it: a bookmark, a separator or a folder. */
type PlacesNode = {
  guid: string;
  typeCode: number;
  title?: string;
  uri?: string;
  children?: PlacesNode[];
};

/** A Places folder's contents: nasty titles, URLs of every kind, separators, nested folders. */
type PlacesArbs = { items: PlacesNode[]; item: PlacesNode };
const placesChildren: fc.Arbitrary<PlacesNode[]> = fc.letrec<PlacesArbs>((tie) => ({
  items: fc.array(tie("item"), { maxLength: 6 }),
  item: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.record({
      guid: fc.constant(""),
      typeCode: fc.constant(1),
      title: fc.oneof(nastyString, fc.constantFrom("a", "a", "a (2)", "", " a ")),
      uri: fc.oneof(
        fc.constantFrom(
          "https://example.com",
          "https://example.com/",
          "data:text/html,x",
          "javascript:alert(1)",
          "place:parent=toolbar_____",
          "file:///etc/passwd",
          "about:blank",
        ),
        nastyString.map((s) => `https://e.example/${s}`),
        nastyString,
      ),
    }),
    fc.constant({ guid: "", typeCode: 3 }),
    fc.record({
      guid: fc.constant(""),
      typeCode: fc.constant(2),
      title: fc.oneof(nastyString, fc.constantFrom("a", "f", "")),
      children: tie("items") as fc.Arbitrary<PlacesNode[]>,
    }),
  ),
})).items;

/** Gives every node a guid of its own (the generator cannot). */
function withGuids(nodes: PlacesNode[], prefix: string): PlacesNode[] {
  return nodes.map((n, i) => ({
    ...n,
    guid: `${prefix}${i}`.padEnd(12, "_"),
    ...(n.children ? { children: withGuids(n.children, `${prefix}${i}.`) } : {}),
  }));
}

/** Places' tree holding the parsed file's tables as folders, for exporting again. */
function placesFromFile(text: string) {
  const toNodes = (list: readonly Item[], at: string): PlacesNode[] =>
    list.map((i, n) =>
      i.kind === "folder"
        ? {
            guid: `${at}${n}`,
            typeCode: 2,
            title: i.title,
            children: toNodes(i.children, `${at}${n}.`),
          }
        : { guid: `${at}${n}`, typeCode: 1, title: i.title, uri: i.url },
    );
  const r = parseBookmarksFile(text);
  const folders = r.tables.map((t, n) => ({
    guid: `t${n}`,
    typeCode: 2,
    title: t.name,
    children: toNodes(t.children as Item[], `t${n}.`),
  }));
  return {
    places: {
      guid: "root________",
      typeCode: 2,
      children: [{ guid: "toolbar_____", typeCode: 2, children: folders }],
    },
    tables: r.tables.map((t, n) => ({ name: t.name, folder: `t${n}` })),
  };
}

describe("bookmarks.toml fuzzing", () => {
  test(
    "export then parse gives the same model: an exported file reads back without an error",
    () =>
      fuzz(
        "bookmarks-file-export",
        fc.property(
          fc.array(fc.tuple(tableName, placesChildren), { minLength: 1, maxLength: 3 }),
          (raw) => {
            const folders = raw.map(([, kids], n) => ({
              guid: `w${n}`.padEnd(12, "_"),
              typeCode: 2,
              title: `w${n}`,
              children: withGuids(kids, `w${n}.`),
            }));
            const places = {
              guid: "root________",
              typeCode: 2,
              children: [{ guid: "toolbar_____", typeCode: 2, children: folders }],
            };
            const tables = raw.map(([name], n) => ({ name, folder: `w${n}`.padEnd(12, "_") }));
            const r = within(500, () => exportBookmarks({ places, tables }));
            if (!r.ok) return; // refused: nothing written
            const parsed = parseBookmarksFile(r.text);
            expect(parsed.errors).toEqual([]);
            let count = 0;
            for (const t of parsed.tables)
              for (const i of items(t.children as Item[])) if (i.kind === "bookmark") count++;
            expect(count).toBe(r.bookmarks);
            expect(parsed.tables.map((t) => t.name)).toEqual(r.tables.map((t) => t.name));
            // The model the file holds exports to the same text: nothing is renamed twice.
            const again = placesFromFile(r.text);
            const second = exportBookmarks(again);
            expect(second.ok && second.text).toBe(r.text);
          },
        ),
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "editBookmarkLines on any parsed file either refuses or yields the expected model",
    () =>
      fuzz(
        "bookmarks-file-edit-lines",
        fc.property(
          fileText,
          fc.nat(),
          fc.nat(),
          fc.array(fc.oneof(nastyString, fc.constantFrom("a", "b/c", "x\\y", '"q"', " s ")), {
            minLength: 1,
            maxLength: 3,
          }),
          fc.boolean(),
          (text, pick, at, names, crlf) => {
            const source = crlf ? text.replace(/\n/g, "\r\n") : text;
            const before = bookmarksOf(source);
            if (before.errors.length || !before.tables.length) return;
            const table = before.tables[at % before.tables.length] as string;
            const gone = before.bookmarks.length
              ? before.bookmarks[pick % before.bookmarks.length]
              : undefined;
            const add = { names, folder: false, value: ADDED };
            const r = within(500, () =>
              editBookmarkLines(source, [
                ...(gone ? [{ op: "remove" as const, line: gone.line }] : []),
                { op: "add" as const, table, lines: [add] },
              ]),
            );
            if (!r.ok) return; // refused: nothing is written
            const after = bookmarksOf(r.text);
            if (after.errors.length) return; // a path the reader refuses: the writer's caller checks
            const want = before.bookmarks.filter((b) => b !== gone).map((b) => b.key);
            const got = after.bookmarks.map((b) => b.key);
            // Every other bookmark is still there, and nothing else is but the new line.
            expect(got.filter(notAdded).sort()).toEqual(want.filter(notAdded).sort());
            expect(after.tables).toEqual(before.tables);
          },
        ),
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "parse never throws and an accepted file holds only valid lines",
    () =>
      fuzz(
        "bookmarks-file-parse",
        fc.property(fileText, (text) => {
          const r = within(500, () => parseBookmarksFile(text));
          if (r.errors.length) return;
          for (const t of r.tables) {
            expect([...t.name].length).toBeGreaterThan(0);
            expect([...t.name].length).toBeLessThanOrEqual(32);
            for (const i of items(t.children as Item[])) {
              expect(i.title.trim()).toBe(i.title);
              expect(i.title.length).toBeGreaterThan(0);
              expect(i.title.length).toBeLessThanOrEqual(MAX_BOOKMARK_TITLE);
              if (i.kind === "bookmark") {
                expect(URL.canParse(i.url)).toBe(true);
                expect(new URL(i.url).href).toBe(i.url);
                expect(new URL(i.url).protocol).not.toBe("data:");
              }
            }
          }
        }),
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "reading bookmarks.toml beside any config.toml never throws",
    () =>
      fuzz(
        "bookmarks-file-read",
        fc.property(fc.option(fileText), fc.option(configText), (file, config) => {
          const r = within(500, () => readBookmarks({ file, config }));
          if (file !== null) expect(r.from).toBe("bookmarks.toml");
          for (const e of [...r.errors, ...r.warnings]) {
            expect(typeof e.message).toBe("string");
            expect(Number.isInteger(e.line)).toBe(true);
          }
        }),
      ),
    FUZZ_TIMEOUT,
  );
});
