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

describe("bookmarks.toml fuzzing", () => {
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
