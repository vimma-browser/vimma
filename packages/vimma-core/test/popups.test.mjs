import { describe, test, expect } from "vitest";
import { parsePopupId, popupCue, popupItems } from "../src/popups.mjs";
import { filterItems, itemId, openPicker, pickerKey } from "../src/picker.mjs";
import { parseCommandLine } from "../src/cmdline.mjs";
import { getAction } from "../src/actions.mjs";
import { DEFAULT_CONFIG } from "../src/defaults.mjs";
import { statusSegments } from "../src/statusbar.mjs";

/** @import { BlockedPopups } from "../src/popups.mjs" */

/**
 * @param {Partial<BlockedPopups>} over
 * @returns {BlockedPopups}
 */
const blocked = (over = {}) => ({
  site: "example.com",
  popups: ["https://example.com/a.html", "https://example.com/b.html"],
  redirect: null,
  allowLocked: false,
  showMessage: true,
  ...over,
});

describe("popupItems", () => {
  test("Firefox's options menu, in its order: allow, each pop-up, hide the bar, settings", () => {
    const items = popupItems(blocked());
    expect(items.map((i) => [i.popupId, i.display])).toEqual([
      ["allow", "Allow pop-ups for example.com"],
      ["popup:0", "Open https://example.com/a.html"],
      ["popup:1", "Open https://example.com/b.html"],
      ["hide", "Don't show this message when pop-ups are blocked"],
      ["settings", "Pop-up settings"],
    ]);
    expect(items.every((i) => i.kind === "popup" && i.active === false)).toBe(true);
  });

  test("a blocked redirect gets its own row before the pop-ups", () => {
    const items = popupItems(blocked({ popups: [], redirect: "https://example.net/next" }));
    expect(items.map((i) => i.popupId)).toEqual(["allow", "redirect", "hide", "settings"]);
    expect(items[1].display).toBe("Go to https://example.net/next");
  });

  test("a locked dom.disable_open_during_load hides allow, as Firefox does", () => {
    const ids = popupItems(blocked({ allowLocked: true })).map((i) => i.popupId);
    expect(ids).toEqual(["popup:0", "popup:1", "hide", "settings"]);
  });

  test("with the bar already turned off, there is no row to turn it off", () => {
    const ids = popupItems(blocked({ showMessage: false })).map((i) => i.popupId);
    expect(ids).toEqual(["allow", "popup:0", "popup:1", "settings"]);
  });

  test("nothing blocked: no rows", () => {
    expect(popupItems(blocked({ popups: [], redirect: null }))).toEqual([]);
  });

  test("rows are picker items: selected by popupId, matched by their text", () => {
    const items = popupItems(blocked());
    expect(items.map(itemId)).toEqual(["allow", "popup:0", "popup:1", "hide", "settings"]);
    expect(filterItems(items, "b.html").map((m) => itemId(m.item))).toEqual(["popup:1"]);
    let state = openPicker(items, { activeId: null });
    state = pickerKey(state, "j").state;
    expect(pickerKey(state, "enter").effect).toEqual({ type: "select", id: "popup:0" });
  });
});

describe("parsePopupId", () => {
  test("names the bar action a row runs", () => {
    expect(parsePopupId("allow")).toEqual({ op: "allow" });
    expect(parsePopupId("popup:3")).toEqual({ op: "popup", index: 3 });
    expect(parsePopupId("redirect")).toEqual({ op: "redirect" });
    expect(parsePopupId("hide")).toEqual({ op: "hide" });
    expect(parsePopupId("settings")).toEqual({ op: "settings" });
  });

  test("anything else is no action", () => {
    for (const id of ["", "popup:", "popup:-1", "popup:x", "popup:1.5", "nope"]) {
      expect(parsePopupId(id)).toBeNull();
    }
  });
});

describe("status bar cue", () => {
  test("names the picker's key, or :popups when it has none", () => {
    expect(popupCue(["ctrl+b shift+o"])).toBe("pop-up blocked · ctrl+b shift+o");
    expect(popupCue([])).toBe("pop-up blocked · :popups");
  });

  test("in the agent workspace it names no way to allow anything", () => {
    expect(popupCue(["ctrl+b shift+o"], { agent: true })).toBe("pop-up blocked");
  });

  test("a right-hand segment while the selected page has the bar, none otherwise", () => {
    const base = { mode: /** @type {const} */ ("normal") };
    const cue = statusSegments({ ...base, popups: "pop-up blocked · ctrl+b shift+o" }).find(
      (s) => s.id === "popups",
    );
    expect(cue).toMatchObject({
      text: "pop-up blocked · ctrl+b shift+o",
      side: "right",
      fg: "--vimma-text-yellow",
    });
    expect(statusSegments({ ...base, popups: null }).some((s) => s.id === "popups")).toBe(false);
    expect(statusSegments(base).some((s) => s.id === "popups")).toBe(false);
  });
});

describe("keys and commands", () => {
  test("prefix+shift+o and :popups open the picker", () => {
    expect(getAction("popup_picker")?.id).toBe("popups.picker");
    expect(DEFAULT_CONFIG.keys?.popup_picker).toEqual(["prefix+shift+o"]);
    expect(parseCommandLine(":popups")).toMatchObject({ action: { id: "popups.picker" } });
  });
});
