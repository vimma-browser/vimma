// Issue #1591, docs/security/12-agents-mcp.md M10: the notice for a modified click dropped in an
// agent tab. Its text is fixed (no page text, title or URL) and names the key from the keymap;
// it comes at most once per tab every CLICK_NOTICE_MS, so a page that scripts such clicks cannot
// fill the status bar.
import { describe, expect, test } from "vitest";
import { CLICK_NOTICE_MS, clickNoticeDue, droppedClickNotice } from "../src/agent/agent-pages.mjs";

describe("droppedClickNotice", () => {
  test("names the default key", () => {
    expect(droppedClickNotice(["gF"])).toBe(
      "the click opened nothing: in agent tabs, open a link in a new tab with gF or the context menu",
    );
  });

  test("names the first key a user presses from a page, as remapped", () => {
    expect(droppedClickNotice(["esc [panel]", "ctrl+b o", "go"])).toContain("with ctrl+b o or");
  });

  test("names only the context menu when the action has no key", () => {
    expect(droppedClickNotice([])).toBe(
      "the click opened nothing: in agent tabs, open a link in a new tab with the context menu",
    );
    expect(droppedClickNotice(["esc [panel]"])).not.toContain("esc");
  });
});

describe("clickNoticeDue", () => {
  test("the first drop in a tab is due", () => {
    expect(clickNoticeDue(undefined, 1000)).toBe(true);
  });

  test("a burst inside the interval is not", () => {
    expect(clickNoticeDue(1000, 1000)).toBe(false);
    expect(clickNoticeDue(1000, 1000 + CLICK_NOTICE_MS - 1)).toBe(false);
  });

  test("the interval's end is due again", () => {
    expect(clickNoticeDue(1000, 1000 + CLICK_NOTICE_MS)).toBe(true);
  });

  test("a clock that went back is due, so a notice is never lost for good", () => {
    expect(clickNoticeDue(5000, 1000)).toBe(true);
  });

  test("the interval is a few seconds, at least as long as the notice shows", () => {
    expect(CLICK_NOTICE_MS).toBeGreaterThanOrEqual(3000);
    expect(CLICK_NOTICE_MS).toBeLessThanOrEqual(10000);
  });
});
