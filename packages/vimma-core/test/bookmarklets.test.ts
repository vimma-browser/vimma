// docs/specs/bookmarklets.md: which stored bookmarks are bookmarklets (B4, B5), who may run one
// at each level of `[bookmarks] bookmarklets` (B1, B2, B6, B7, B13), and the config key (B1-B3).
import { describe, test, expect } from "vitest";
import {
  BOOKMARKLETS_SETTINGS,
  PLACES_ROOTS,
  bookmarkKind,
  bookmarkletDecision,
  bookmarksKey,
  fromPlaces,
  openBookmarks,
} from "../src/ui/bookmarks.mjs";
import { parseConfig } from "../src/config/config.mjs";
import { DEFAULT_CONFIG, formatDefaultsToml } from "../src/config/defaults.mjs";

import type { ResolvedConfig } from "../src/config/config.mjs";
import type { PlacesItem } from "../src/ui/bookmarks.mjs";

// A config.toml whose first line is a comment, so errors are on the lines they always were.
const cfg = (...lines: string[]) => ["# config.toml", ...lines].join("\n") + "\n";

function ok(text: string) {
  const r = parseConfig(text);
  expect(r.errors).toEqual([]);
  return r.config as ResolvedConfig;
}

function errors(text: string) {
  const r = parseConfig(text);
  expect(r.config).toBeNull();
  return r.errors.map((e) => ({
    line: e.line,
    path: e.path,
    message: e.message,
    ...(e.suggestion ? { suggestion: e.suggestion } : {}),
  }));
}

const JS = "javascript:document.title='ran'";
const DEFAULT_REFUSAL =
  "javascript: bookmarks don't open from Vimma (only http, https, file, about)";
const NOT_HERE = "a bookmarklet runs in this page: Enter runs it";

describe("bookmarkKind (B4, B5)", () => {
  test.each([
    ["https://a.example/", "openable"],
    ["about:config", "openable"],
    ["file:///tmp/a.html", "openable"],
    [JS, "bookmarklet"],
    ["JavaScript:void(0)", "bookmarklet"],
    [" \t\njavascript:void(0)", "bookmarklet"],
    ["\u0001javascript:void(0)", "bookmarklet"],
    ["java\tscript:void(0)", "bookmarklet"],
    ["data:text/html,<b>hi</b>", "refused"],
    ["DATA:text/html,hi", "refused"],
    ["view-source:javascript:void(0)", "refused"],
    ["blob:https://a.example/1", "refused"],
    ["chrome://browser/content/browser.xhtml", "refused"],
    ["", "refused"],
  ])("%j is %s", (url, kind) => expect(bookmarkKind(url)).toBe(kind));
});

/** Each level, caller and place, and what a bookmarklet does there (B6, B7, B13). */
const DECISIONS = [
  // setting, by, where, outcome
  ["none", "user", "current", { kind: "refuse", text: DEFAULT_REFUSAL }],
  ["none", "user", "tab", { kind: "refuse", text: DEFAULT_REFUSAL }],
  ["user", "user", "current", { kind: "run" }],
  ["user", "user", "tab", { kind: "refuse", text: NOT_HERE }],
  ["user", "user", "vertical", { kind: "refuse", text: NOT_HERE }],
  ["user", "user", "horizontal", { kind: "refuse", text: NOT_HERE }],
  ["agent", "user", "current", { kind: "run" }],
  ["agent", "user", "tab", { kind: "refuse", text: NOT_HERE }],
  ["agent", "agent", "current", { kind: "run" }],
] as const;

/** The levels that keep agents out (B13). */
const BELOW_AGENT = [["none"], ["user"]] as const;

describe("bookmarkKind reads a long URL in linear time (B4)", () => {
  test("100,000 spaces between letters, and before a scheme, are read in bounded time", () => {
    const url = `x${" ".repeat(100_000)}x`;
    const start = performance.now();
    expect(bookmarkKind(url)).toBe("refused");
    expect(bookmarkKind(`${" ".repeat(100_000)}javascript:void(0)`)).toBe("bookmarklet");
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe("bookmarkletDecision (B6, B7, B13)", () => {
  const where = "current";
  test("an ordinary bookmark opens at every level, for the user", () => {
    for (const setting of BOOKMARKLETS_SETTINGS) {
      expect(
        bookmarkletDecision({ url: "https://a.example/", setting, by: "user", where }),
      ).toEqual({ kind: "open" });
    }
  });

  test.each([...DECISIONS])(
    "a bookmarklet at %s, by the %s, %s → %j",
    (setting, by, at, outcome) => {
      expect(bookmarkletDecision({ url: JS, setting, by, where: at })).toEqual(outcome);
    },
  );

  test.each([...BELOW_AGENT])("an agent is refused at %s, naming the setting", (setting) => {
    expect(bookmarkletDecision({ url: JS, setting, by: "agent", where })).toEqual({
      kind: "refuse",
      text: 'bookmarklets are off for agents: [bookmarks] bookmarklets = "agent" in config.toml allows them',
    });
  });

  test("data: and other schemes refuse at every level, for anyone, anywhere", () => {
    for (const setting of BOOKMARKLETS_SETTINGS) {
      for (const by of ["user", "agent"] as const) {
        for (const url of ["data:text/html,hi", "view-source:javascript:void(0)", "blob:x"]) {
          const d = bookmarkletDecision({ url, setting, by, where });
          expect(d.kind).toBe("refuse");
        }
      }
    }
    expect(
      bookmarkletDecision({ url: "data:text/html,hi", setting: "agent", by: "user", where }),
    ).toEqual({
      kind: "refuse",
      text: "data: bookmarks don't open from Vimma (only http, https, file, about)",
    });
  });

  test("an agent never opens even an ordinary bookmark through it: agents only run bookmarklets", () => {
    expect(
      bookmarkletDecision({ url: "https://a.example/", setting: "agent", by: "agent", where }),
    ).toEqual({ kind: "refuse", text: "only a bookmarklet can be run" });
  });

  test("an unknown setting is treated as none", () => {
    const setting = "all" as never;
    expect(bookmarkletDecision({ url: JS, setting, by: "user", where }).kind).toBe("refuse");
    expect(bookmarkletDecision({ url: JS, setting, by: "agent", where }).kind).toBe("refuse");
  });
});

describe("the panel's keys follow the level (B7)", () => {
  const places: PlacesItem = {
    guid: "root________",
    typeCode: 2,
    children: [
      {
        guid: PLACES_ROOTS.toolbar,
        typeCode: 2,
        title: "toolbar",
        children: [{ guid: "js", typeCode: 1, title: "Bookmarklet", uri: JS }],
      },
    ],
  };
  const state = openBookmarks(fromPlaces(places, "toolbar"));

  test("none: Enter refuses as before (bookmarks decision 6)", () => {
    expect(bookmarksKey(state, { id: "panel.open" }).effect).toEqual({
      type: "refuse",
      text: DEFAULT_REFUSAL,
    });
  });

  test("user: Enter and l run it; t, s and S refuse", () => {
    for (const id of ["panel.open", "bookmarks.expand"]) {
      expect(bookmarksKey(state, { id }, { bookmarklets: "user" }).effect).toEqual({
        type: "run",
        guid: "js",
        url: JS,
      });
    }
    for (const id of ["bookmarks.open_tab", "bookmarks.open_vsplit", "bookmarks.open_hsplit"]) {
      expect(bookmarksKey(state, { id }, { bookmarklets: "agent" }).effect).toEqual({
        type: "refuse",
        text: NOT_HERE,
      });
    }
  });
});

describe("[bookmarks] bookmarklets (B1-B3)", () => {
  test('defaults to "none"', () => {
    expect(ok(cfg()).bookmarks.bookmarklets).toBe("none");
    expect(DEFAULT_CONFIG.bookmarks).toMatchObject({ bookmarklets: "none" });
    expect(formatDefaultsToml()).toMatch(
      /^\[bookmarks\]\n(#.*\n|\w+ = .*\n)*bookmarklets = "none"(?: +#.*)?$/m,
    );
  });

  test.each([["none"], ["user"], ["agent"]])('bookmarklets = "%s" is accepted', (value) => {
    expect(ok(cfg("[bookmarks]", `bookmarklets = "${value}"`)).bookmarks).toEqual({
      root: "workspace",
      bookmarklets: value,
      writeBack: "all",
    });
  });

  test("another value is an error, with the nearest name when one is close", () => {
    expect(errors(cfg("[bookmarks]", 'bookmarklets = "both"'))).toEqual([
      { line: 3, path: "bookmarks.bookmarklets", message: 'must be "none", "user" or "agent"' },
    ]);
    expect(errors(cfg("[bookmarks]", 'bookmarklets = "agnet"'))).toEqual([
      {
        line: 3,
        path: "bookmarks.bookmarklets",
        message: 'must be "none", "user" or "agent"',
        suggestion: "agent",
      },
    ]);
    expect(errors(cfg("[bookmarks]", "bookmarklets = true"))).toEqual([
      { line: 3, path: "bookmarks.bookmarklets", message: "expected a string, got a boolean" },
    ]);
  });

  test("an unknown key suggests bookmarklets when it is close", () => {
    expect(errors(cfg("[bookmarks]", 'bookmarklet = "user"'))).toEqual([
      {
        line: 3,
        path: "bookmarks.bookmarklet",
        message: 'unknown key "bookmarklet"',
        suggestion: "bookmarklets",
      },
    ]);
  });
});
