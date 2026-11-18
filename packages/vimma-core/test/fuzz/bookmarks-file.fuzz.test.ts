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

describe("bookmarks.toml fuzzing", () => {
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
