import { describe, test, expect } from "vitest";
import { parsePopupId, popupCue, popupItems } from "../src/ui/popups.mjs";
import { filterItems, itemId, openPicker, pickerKey } from "../src/ui/picker.mjs";
import { parseCommandLine } from "../src/keys/cmdline.mjs";
import { getAction } from "../src/keys/actions.mjs";
import { DEFAULT_CONFIG } from "../src/config/defaults.mjs";
import { statusSegments } from "../src/ui/statusbar.mjs";

/** @import { BlockedPopups } from "../src/ui/popups.mjs" */

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
  permission: null,
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
    expect(items[1]?.display).toBe("Go to https://example.net/next");
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

  test("a site blocked with n: allow it again, or reset it, with nothing blocked or a bar", () => {
    const items = popupItems(blocked({ popups: [], permission: "block" }));
    expect(items.map((i) => [i.popupId, i.display])).toEqual([
      ["allow", "Allow pop-ups for example.com"],
      ["reset", "Reset pop-ups for example.com to default"],
      ["settings", "Pop-up settings"],
    ]);
    const ids = popupItems(blocked({ permission: "block" })).map((i) => i.popupId);
    expect(ids).toEqual(["allow", "reset", "popup:0", "popup:1", "hide", "settings"]);
  });

  test("a site whose pop-ups are allowed: block them", () => {
    const items = popupItems(blocked({ popups: [], permission: "allow" }));
    expect(items.map((i) => [i.popupId, i.display])).toEqual([
      ["block", "Block pop-ups for example.com"],
      ["settings", "Pop-up settings"],
    ]);
  });

  test("a locked dom.disable_open_during_load leaves the site's permission alone", () => {
    for (const permission of /** @type {const} */ (["block", "allow"])) {
      const ids = popupItems(blocked({ popups: [], permission, allowLocked: true }));
      expect(ids.map((i) => i.popupId)).toEqual(["settings"]);
    }
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
    expect(parsePopupId("block")).toEqual({ op: "block" });
    expect(parsePopupId("reset")).toEqual({ op: "reset" });
  });

  test("anything else is no action", () => {
    for (const id of ["", "popup:", "popup:-1", "popup:x", "popup:1.5", "nope"]) {
      expect(parsePopupId(id)).toBeNull();
    }
  });
});

describe("status bar cue", () => {
  test("names the bar's keys once they count, and none before", () => {
    expect(popupCue({ bar: true, hint: "y allow · n block · Esc close" })).toBe(
      "pop-up blocked · y allow · n block · Esc close",
    );
    expect(popupCue({ bar: true, hint: null })).toBe("pop-up blocked");
  });

  test("in the agent workspace it names no way to allow anything", () => {
    expect(popupCue({ bar: true, hint: "y allow · n block · Esc close", agent: true })).toBe(
      "pop-up blocked",
    );
    expect(popupCue({ bar: false, hint: null, siteBlocked: true, agent: true })).toBeNull();
  });

  test("after n, the way to undo it; nothing for a site left at the default", () => {
    expect(popupCue({ bar: false, hint: null, siteBlocked: true })).toBe(
      "pop-ups blocked · :popups to allow",
    );
    expect(popupCue({ bar: false, hint: null, siteBlocked: false })).toBeNull();
  });

  test("a right-hand segment while the selected page has the bar, none otherwise", () => {
    const base = { mode: /** @type {const} */ ("normal") };
    const cue = statusSegments({
      ...base,
      popups: "pop-up blocked · y allow · n block · Esc close",
    }).find((s) => s.id === "popups");
    expect(cue).toMatchObject({
      text: "pop-up blocked · y allow · n block · Esc close",
      side: "right",
      fg: "--vimma-text-yellow",
    });
    expect(statusSegments({ ...base, popups: null }).some((s) => s.id === "popups")).toBe(false);
    expect(statusSegments(base).some((s) => s.id === "popups")).toBe(false);
  });
});

describe("keys and commands", () => {
  test(":popups opens the picker; it has no default key, y and n answer the bar", () => {
    expect(getAction("popup_picker")?.id).toBe("popups.picker");
    expect(DEFAULT_CONFIG.keys?.popup_picker).toBeUndefined();
    expect(parseCommandLine(":popups")).toMatchObject({ action: { id: "popups.picker" } });
  });
});
