// docs/specs/bookmarks-toolbar-hidden.md: the words, the notices and the one-time migration.
import { describe, expect, test } from "vitest";
import {
  BOOKMARKS_TOOLBAR_SETTINGS,
  MIGRATION_NOTICE,
  bookmarksToolbarNotice,
  needsMigration,
  settingFor,
  visibilityFor,
} from "../src/bookmarks-toolbar.mjs";

describe("Vimma's words and Firefox's values (decision 3)", () => {
  test("shown is always, hidden is never, newtab is newtab, both ways", () => {
    expect(BOOKMARKS_TOOLBAR_SETTINGS).toEqual(["shown", "hidden", "newtab"]);
    expect(visibilityFor("shown")).toBe("always");
    expect(visibilityFor("hidden")).toBe("never");
    expect(visibilityFor("newtab")).toBe("newtab");
    for (const s of BOOKMARKS_TOOLBAR_SETTINGS) expect(settingFor(visibilityFor(s))).toBe(s);
  });

  test("a pref value Firefox does not know reads as null", () => {
    expect(settingFor("sometimes")).toBeNull();
    expect(settingFor("")).toBeNull();
  });
});

describe("notices (Behaviour 6)", () => {
  test("one per state", () => {
    expect(bookmarksToolbarNotice("always", null)).toBe("bookmarks toolbar shown");
    expect(bookmarksToolbarNotice("never", null)).toBe("bookmarks toolbar hidden");
    expect(bookmarksToolbarNotice("newtab", null)).toBe("bookmarks toolbar shown on new tabs");
  });

  test("while config.toml sets the key, the change lasts until restart, and the notice says so", () => {
    expect(bookmarksToolbarNotice("never", "shown")).toBe(
      'bookmarks toolbar hidden (config.toml sets "shown"; until restart)',
    );
    expect(bookmarksToolbarNotice("always", "shown")).toBe(
      'bookmarks toolbar shown (config.toml sets "shown"; until restart)',
    );
  });

  test("the migration notice names the panel and the way back", () => {
    expect(MIGRATION_NOTICE).toBe(
      "bookmarks toolbar hidden: ctrl+b shift+b opens your bookmarks; " +
        ":bookmarkstoolbar show brings it back",
    );
  });
});

describe("needsMigration (decision 7)", () => {
  const base = { migrated: false, configured: null, userValue: "always" };

  test("an unmigrated profile that shows the toolbar is hidden once", () => {
    expect(needsMigration(base)).toBe(true);
    expect(needsMigration({ ...base, userValue: "newtab" })).toBe(true);
  });

  test("not again, not over config.toml, not when nothing shows it", () => {
    expect(needsMigration({ ...base, migrated: true })).toBe(false);
    expect(needsMigration({ ...base, configured: "shown" })).toBe(false);
    expect(needsMigration({ ...base, userValue: "never" })).toBe(false);
    expect(needsMigration({ ...base, userValue: null })).toBe(false);
  });
});
