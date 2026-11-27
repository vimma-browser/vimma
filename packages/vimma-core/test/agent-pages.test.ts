// Issue #1591, docs/security/12-agents-mcp.md M10: the notice for a modified click dropped in an
// agent tab. Its text is fixed (no page text, title or URL) and names the key from the keymap;
// it comes at most once per tab every CLICK_NOTICE_MS, so a page that scripts such clicks cannot
// fill the status bar.
import { describe, expect, test } from "vitest";
import { CLICK_NOTICE_MS, clickNoticeDue, droppedClickNotice } from "../src/agent/agent-pages.mjs";
import { compileKeymap } from "../src/keys/keymap.mjs";

describe("droppedClickNotice", () => {
  test("names the default key", () => {
    expect(droppedClickNotice(compileKeymap())).toBe(
      "the click opened nothing: in agent tabs, open a link in a new tab with gF or the context menu",
    );
  });

  test("names the key as remapped, brackets and all", () => {
    const unbound = { unbind: { normal: ["gF"] } };
    const alt = compileKeymap({ ...unbound, keys: { follow_link_new_tab: ["alt+[", "go"] } });
    expect(droppedClickNotice(alt)).toContain("with alt+[ or the context menu");
    const run = compileKeymap({ ...unbound, keys: { follow_link_new_tab: ["[x"] } });
    expect(droppedClickNotice(run)).toContain("with [x or the context menu");
  });

  test("skips a key that normal mode binds to another action or unbinds", () => {
    // Normal mode binds ctrl+[ to history_back: on a page it goes back, so naming it would point
    // at a key that does not open the link.
    const shadowed = compileKeymap({
      unbind: { normal: ["gF"] },
      keys: { follow_link_new_tab: ["ctrl+[", "go"] },
    });
    expect(droppedClickNotice(shadowed)).toContain("with go or the context menu");
    const rebound = compileKeymap({ modal: { normal: { gF: "tab.next" } } });
    expect(droppedClickNotice(rebound)).not.toContain("gF");
  });

  test("names only the context menu when the action has no key", () => {
    expect(droppedClickNotice(compileKeymap({ unbind: { normal: ["gF"] } }))).toBe(
      "the click opened nothing: in agent tabs, open a link in a new tab with the context menu",
    );
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
