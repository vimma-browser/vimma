// docs/specs/bookmark-open.md: `:bookmarkopen [title]` and `:bookmarktab [title]` pick one of the
// stored bookmarks by its title. The typed text only chooses among stored bookmarks; what opens or
// runs is the stored bookmark, through the panel's path (bookmarklets B10).
import { describe, test, expect } from "vitest";
import {
  BOOKMARK_OPEN_QUOTE_MAX,
  bookmarkOpenItems,
  bookmarkOpenTarget,
} from "../src/ui/bookmark-open.mjs";
import { PLACES_ROOTS, bookmarkletDecision, fromPlaces } from "../src/ui/bookmarks.mjs";
import { filterItems, itemId, openPicker, pickerKey } from "../src/ui/picker.mjs";
import { parseCommandLine, completeCommandLine } from "../src/keys/cmdline.mjs";
import { compileKeymap } from "../src/keys/keymap.mjs";
import { createDispatcher } from "../src/keys/dispatcher.mjs";
import { parseKey } from "../src/keys/keys.mjs";
import { ACTIONS } from "../src/keys/actions.mjs";
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs";
import { AGENT_KEY_ACTIONS, parseAgentKeys } from "../src/agent/agent-keys.mjs";

import type { PlacesItem } from "../src/ui/bookmarks.mjs";
import type { BookmarkItem } from "../src/ui/bookmark-open.mjs";

const BM = 1;
const FOLDER = 2;

const bm = (guid: string, title: string, uri: string): PlacesItem => ({
  guid,
  typeCode: BM,
  title,
  uri,
});
const folder = (guid: string, title: string, children: PlacesItem[]): PlacesItem => ({
  guid,
  typeCode: FOLDER,
  title,
  children,
});

/** Places' tree: toolbar (with a workspace folder), Other Bookmarks and the Menu. */
const places: PlacesItem = folder("root________", "", [
  folder(PLACES_ROOTS.menu, "menu", [
    bm("m1", "Menu page", "https://menu.example/"),
    folder("rf", "Recipes", [bm("m2", "Soup", "https://soup.example/")]),
  ]),
  folder(PLACES_ROOTS.toolbar, "toolbar", [
    bm("g1", "Google", "https://www.google.com/"),
    bm("g2", "Google Shopping", "https://shopping.google.com/"),
    folder("ws", "work", [
      bm("s1", "goodshows", "https://goodshows.example/"),
      bm("d1", "Dark mode", "javascript:document.body.style.background='black'"),
    ]),
  ]),
  folder(PLACES_ROOTS.unfiled, "unfiled", [
    bm("r1", "reddit", "https://reddit.com/"),
    bm("t1", "Twin", "https://one.example/"),
    bm("t2", "twin", "https://two.example/"),
    bm("u1", "", "https://untitled.example/page"),
    bm("u2", "", "javascript:alert(document.cookie)"),
    bm("x1", "Data", "data:text/html,<p>x"),
  ]),
  folder(PLACES_ROOTS.mobile, "mobile", []),
]);

const items = () => bookmarkOpenItems(fromPlaces(places, "all"));
const byId = (id: string) => items().find((i) => i.bookmarkId === id) as BookmarkItem;

describe("bookmarkOpenItems: every stored bookmark, never a folder", () => {
  test("lists each bookmark once, in tree order, with its folder path", () => {
    expect(items().map((i) => [i.bookmarkId, i.path])).toEqual([
      ["g1", "toolbar"],
      ["g2", "toolbar"],
      ["s1", "toolbar/work"],
      ["d1", "toolbar/work"],
      ["r1", "other"],
      ["t1", "other"],
      ["t2", "other"],
      ["u1", "other"],
      ["u2", "other"],
      ["x1", "other"],
      ["m1", "menu"],
      ["m2", "menu/Recipes"],
    ]);
  });

  test("rows are picker rows: kind bookmark, selected by guid, never active", () => {
    const g = byId("g2");
    expect(g).toMatchObject({ kind: "bookmark", display: "Google Shopping", active: false });
    expect(itemId(g)).toBe("g2");
  });

  test("a web bookmark shows its host; a bookmarklet says so and never shows its script", () => {
    expect(byId("g2").detail).toBe("toolbar · shopping.google.com");
    expect(byId("d1").detail).toBe("toolbar/work · bookmarklet");
    expect(byId("d1").host).toBe("");
    const untitled = byId("u2");
    expect(untitled.display).toBe("(untitled bookmarklet)");
    expect(`${untitled.display} ${untitled.detail} ${untitled.host}`).not.toContain("cookie");
  });

  test("an untitled web bookmark shows its URL, as the panel does", () => {
    expect(byId("u1").display).toBe("https://untitled.example/page");
  });
});

describe("bookmarkOpenTarget: what the typed title does", () => {
  test("no title: the picker over every bookmark", () => {
    expect(bookmarkOpenTarget(items(), undefined)).toEqual({ kind: "pick", query: "" });
    expect(bookmarkOpenTarget(items(), "   ")).toEqual({ kind: "pick", query: "" });
  });

  test("one bookmark titled exactly so (any case, outer spaces) opens directly", () => {
    expect(bookmarkOpenTarget(items(), "Google Shopping")).toEqual({ kind: "open", id: "g2" });
    expect(bookmarkOpenTarget(items(), " google shopping ")).toEqual({ kind: "open", id: "g2" });
    expect(bookmarkOpenTarget(items(), "Google")).toEqual({ kind: "open", id: "g1" });
    expect(bookmarkOpenTarget(items(), "dark mode")).toEqual({ kind: "open", id: "d1" });
  });

  test("a partial title opens the picker with it as the query, even with one match", () => {
    expect(bookmarkOpenTarget(items(), "goo")).toEqual({ kind: "pick", query: "goo" });
    expect(bookmarkOpenTarget(items(), "redd")).toEqual({ kind: "pick", query: "redd" });
  });

  test("a quoted trailing space stays in the query, so the next key starts a new word", () => {
    const line = parseCommandLine("bookmarkopen 'goo '");
    expect(line).toMatchObject({ kind: "run", text: "goo " });
    const text = line.kind === "run" ? line.text : undefined;
    expect(bookmarkOpenTarget(items(), text)).toEqual({ kind: "pick", query: "goo " });
    let s = openPicker(items(), { typeFirst: true, query: "goo " });
    s = pickerKey(s, "s").state;
    expect(s.query).toBe("goo s");
    expect(s.matches.map((m) => m.item.display).sort()).toEqual(["Google Shopping", "goodshows"]);
  });

  test("two bookmarks with the same title: the picker, so the user chooses", () => {
    expect(bookmarkOpenTarget(items(), "twin")).toEqual({ kind: "pick", query: "twin" });
  });

  test("nothing matches: refused with the title, cut short", () => {
    expect(bookmarkOpenTarget(items(), "zzzz")).toEqual({
      kind: "refuse",
      text: 'bookmark: none matches "zzzz"',
    });
    const long = "q".repeat(500);
    const r = bookmarkOpenTarget(items(), long);
    expect(r.kind).toBe("refuse");
    expect(r.kind === "refuse" && [...r.text].length).toBeLessThan(BOOKMARK_OPEN_QUOTE_MAX + 30);
  });

  test("no bookmarks at all: says so, no picker", () => {
    expect(bookmarkOpenTarget([], "")).toEqual({
      kind: "refuse",
      text: "bookmark: none saved yet",
    });
    expect(bookmarkOpenTarget([], "x")).toEqual({
      kind: "refuse",
      text: "bookmark: none saved yet",
    });
  });

  test("the typed text is only compared with titles: a URL or script typed matches nothing", () => {
    expect(bookmarkOpenTarget(items(), "javascript:alert(1)").kind).toBe("refuse");
    expect(bookmarkOpenTarget(items(), "https://evil.example/").kind).toBe("refuse");
  });
});

describe("the picker over bookmark rows", () => {
  test("matches the title first, then the host and the folder path", () => {
    const titles = (q: string) => filterItems(items(), q).map((m) => m.item.display);
    expect(titles("goo")[0]).toBe("Google");
    expect([...titles("goo")].sort()).toEqual(["Google", "Google Shopping", "goodshows"]);
    expect(titles("reddit.com")).toEqual(["reddit"]);
    expect(titles("work")[0]).toBe("goodshows");
  });

  test("types from the first key with the query given; Enter selects the bookmark's guid", () => {
    let s = openPicker(items(), { typeFirst: true, query: "goo" });
    expect(s.mode).toBe("search");
    expect(pickerKey(s, "enter").effect).toEqual({ type: "select", id: "g1" });
    s = pickerKey(s, "ctrl+n").state;
    expect(pickerKey(s, "enter").effect).toEqual({
      type: "select",
      id: itemId((s.matches[1] as { item: BookmarkItem }).item),
    });
    expect(pickerKey(s, "esc").effect).toEqual({ type: "close" });
  });
});

const run = (command: string, id: string, text?: string) => ({
  kind: "run",
  command,
  action: { id },
  ...(text ? { text } : {}),
});

describe(":bookmarkopen and :bookmarktab", () => {
  test.each([
    [":bookmarkopen", run("bookmarkopen", "bookmark.open")],
    [":bookmarkopen goo", run("bookmarkopen", "bookmark.open", "goo")],
    [":bookmarkopen 'Google Shopping'", run("bookmarkopen", "bookmark.open", "Google Shopping")],
    [':bookmarkopen "Google Shopping"', run("bookmarkopen", "bookmark.open", "Google Shopping")],
    // No short alias: :bo and :boo stay :bookmark, as before these commands came.
    [":bo work/x", run("bookmark", "bookmark.add", "work/x")],
    [":boo", run("bookmark", "bookmark.add")],
    [":bookmarko Google", run("bookmarkopen", "bookmark.open", "Google")],
    [":bookmarkt reddit", run("bookmarktab", "bookmark.open_tab", "reddit")],
    [":bookmarktab", run("bookmarktab", "bookmark.open_tab")],
    [":bookmarktab Dark mode", run("bookmarktab", "bookmark.open_tab", "Dark mode")],
    [":open_bookmark", run("open_bookmark", "bookmark.open")],
    [":open_bookmark_tab", run("open_bookmark_tab", "bookmark.open_tab")],
    // :bookm stays :bookmark, the shortest command its prefix begins.
    [":bookm", run("bookmark", "bookmark.add")],
  ])("%s", (line, expected) => {
    expect(parseCommandLine(line)).toEqual(expected);
  });

  test("Tab completes the command names", () => {
    const values = completeCommandLine("bookmarko").candidates.map((c) => c.value);
    expect(values[0]).toBe("bookmarkopen");
  });

  test("the actions exist, in the Bookmarks group, with no default key", () => {
    for (const id of ["bookmark.open", "bookmark.open_tab"]) {
      const def = ACTIONS.find((a) => a.id === id);
      expect(def?.group).toBe("Bookmarks");
    }
    const bound = JSON.stringify(DEFAULT_CONFIG);
    expect(bound).not.toContain("open_bookmark");
    expect(bound).not.toContain("bookmark.open");
  });

  test("a key can be bound to a quoted title, as config.toml writes it", () => {
    const d = createDispatcher(
      compileKeymap({ modal: { normal: { "alt+g": ":bookmarkopen 'Google Shopping'" } } }),
    );
    expect(d.dispatch("normal", parseKey("alt+g"))).toStrictEqual({
      kind: "action",
      action: { id: "cmdline.run", line: "bookmarkopen 'Google Shopping'" },
    });
    expect(parseCommandLine("bookmarkopen 'Google Shopping'")).toEqual(
      run("bookmarkopen", "bookmark.open", "Google Shopping"),
    );
  });
});

describe("a bookmarklet from the command, as from the panel (bookmarklets B6, B7)", () => {
  const JS = "javascript:void(0)";
  test("runs in this page at user and agent; new tab refuses, naming the command", () => {
    for (const setting of ["user", "agent"] as const) {
      expect(
        bookmarkletDecision({ url: JS, setting, by: "user", where: "current", from: "command" }),
      ).toEqual({ kind: "run" });
      expect(
        bookmarkletDecision({ url: JS, setting, by: "user", where: "tab", from: "command" }),
      ).toEqual({ kind: "refuse", text: "a bookmarklet runs in this page: :bookmarkopen runs it" });
    }
  });

  test("the panel keeps its own hint", () => {
    expect(bookmarkletDecision({ url: JS, setting: "user", by: "user", where: "tab" })).toEqual({
      kind: "refuse",
      text: "a bookmarklet runs in this page: Enter runs it",
    });
  });

  test("none refuses as in the panel", () => {
    const d = bookmarkletDecision({
      url: JS,
      setting: "none",
      by: "user",
      where: "current",
      from: "command",
    });
    expect(d.kind).toBe("refuse");
  });
});

describe("review: exact titles, stale rows, long URLs, agents", () => {
  test("an untitled bookmark never opens by exact text, only through the picker", () => {
    expect(bookmarkOpenTarget(items(), "(untitled bookmarklet)")).toEqual({
      kind: "pick",
      query: "(untitled bookmarklet)",
    });
    expect(bookmarkOpenTarget(items(), "https://untitled.example/page")).toEqual({
      kind: "pick",
      query: "https://untitled.example/page",
    });
  });

  test("a row keeps the URL it was listed with, to check it again, but never draws it", () => {
    expect(byId("g2").listed).toBe("https://shopping.google.com/");
    const script = byId("u2");
    expect(script.listed).toBe("javascript:alert(document.cookie)");
    for (const shown of [script.display, script.detail, script.host]) {
      expect(shown).not.toContain("cookie");
    }
  });

  test("an untitled bookmark's long URL is cut for its row", () => {
    const long = `https://long.example/${"a".repeat(5000)}`;
    const tree = fromPlaces(
      folder("root________", "", [folder(PLACES_ROOTS.toolbar, "t", [bm("l1", "", long)])]),
      "all",
    );
    const [row] = bookmarkOpenItems(tree);
    expect([...(row as BookmarkItem).display].length).toBeLessThanOrEqual(201);
  });

  test("an unknown caller gets the panel's wording, never an empty refusal", () => {
    const d = bookmarkletDecision({
      url: "javascript:void(0)",
      setting: "user",
      by: "user",
      where: "tab",
      from: "other" as "panel",
    });
    expect(d).toEqual({ kind: "refuse", text: "a bookmarklet runs in this page: Enter runs it" });
  });

  test("vimma_keys can never reach the commands (mcp-drive D9)", () => {
    for (const id of ["bookmark.open", "bookmark.open_tab", "cmdline.run"]) {
      expect(AGENT_KEY_ACTIONS.has(id)).toBe(false);
    }
    const r = parseAgentKeys(":bookmarkopen Dark mode<CR>");
    expect(r.ok).toBe(false);
  });
});
