import { describe, test, expect } from "vitest";
import {
  addonChanged,
  addonItems,
  addonRowText,
  bestAddon,
  isListedAddon,
  removeAddonQuestion,
} from "../src/addons.mjs";
import { filterItems, itemId, openPicker, pickerKey } from "../src/picker.mjs";
import { parseCommandLine, completeCommandLine } from "../src/cmdline.mjs";
import { getAction } from "../src/actions.mjs";
import { DEFAULT_CONFIG } from "../src/defaults.mjs";

/** @import { AddonRecord } from "../src/addons.mjs" */

/**
 * `value`, failing the test where it is missing.
 * @template T
 * @param {T | undefined} value
 * @returns {T}
 */
const defined = (value) => {
  if (value === undefined) throw new Error("expected a value");
  return value;
};

/**
 * @param {Partial<AddonRecord>} over
 * @returns {AddonRecord}
 */
const rec = (over) => ({
  id: "a@x",
  name: "A",
  version: "1.0",
  type: "extension",
  enabled: true,
  isSystem: false,
  isBuiltin: false,
  hidden: false,
  privateAllowed: false,
  update: false,
  ...over,
});

const records = [
  rec({ id: "ublock@x", name: "uBlock Origin", version: "1.60.0" }),
  rec({ id: "bw@x", name: "Bitwarden", version: "2024.1", privateAllowed: true }),
  rec({ id: "sys@x", name: "Form Autofill", isSystem: true, isBuiltin: true, hidden: true }),
  rec({ id: "hidden@x", name: "Hidden helper", hidden: true }),
  rec({ id: "builtin@x", name: "Builtin", isBuiltin: true }),
  rec({ id: "theme@x", name: "Dark", type: "theme" }),
  rec({ id: "off@x", name: "aardvark", enabled: false, update: true }),
];

describe("which add-ons the picker lists", () => {
  test("extensions only, never system, built-in or hidden ones", () => {
    expect(records.filter(isListedAddon).map((r) => r.id)).toEqual(["ublock@x", "bw@x", "off@x"]);
  });

  test("sorted by name, case-insensitively, then id", () => {
    const items = addonItems([...records, rec({ id: "bwz@x", name: "bitwarden" })]);
    expect(items.map((i) => i.addonId)).toEqual(["off@x", "bw@x", "bwz@x", "ublock@x"]);
    expect(items[0]).toMatchObject({ kind: "addon", display: "aardvark", enabled: false });
  });

  test("an item is selected by its add-on id", () => {
    const item = defined(addonItems([defined(records[1])])[0]);
    expect(itemId(item)).toBe("bw@x");
  });
});

describe("row text", () => {
  test("version, enabled state, private ok, pending update", () => {
    const items = addonItems(records);
    const [off, bw, ub] = [defined(items[0]), defined(items[1]), defined(items[2])];
    expect(addonRowText(bw)).toBe("2024.1 · enabled · private ok");
    expect(addonRowText(ub)).toBe("1.60.0 · enabled");
    expect(addonRowText(off)).toBe("1.0 · disabled · update");
  });

  test("a name with markup stays text in the item", () => {
    const item = defined(addonItems([rec({ name: "<b>bold</b>" })])[0]);
    expect(item.display).toBe("<b>bold</b>");
  });
});

describe("matching", () => {
  const items = addonItems(records);

  test("the picker matches add-ons by name only", () => {
    expect(filterItems(items, "bit").map((m) => m.item.display)).toEqual(["Bitwarden"]);
    expect(filterItems(items, "2024")).toEqual([]);
  });

  test(":addon picks the best fuzzy match, or none", () => {
    expect(bestAddon(items, "ublock")?.addonId).toBe("ublock@x");
    expect(bestAddon(items, "bwdn")?.addonId).toBe("bw@x");
    expect(bestAddon(items, "  Bitwarden ")?.addonId).toBe("bw@x");
    expect(bestAddon(items, "zzz")).toBeNull();
    expect(bestAddon(items, "")).toBeNull();
  });

  test(":addon never reaches a hidden or system add-on", () => {
    expect(bestAddon(items, "Form Autofill")).toBeNull();
    expect(bestAddon(items, "Hidden helper")).toBeNull();
  });
});

describe("picker keys on an add-on", () => {
  const s = openPicker(addonItems(records), { activeId: "bw@x" });

  test.each([
    ["o", "options"],
    ["x", "toggle"],
    ["d", "remove"],
    ["u", "update"],
    ["shift+p", "private"],
  ])("%s → %s on the selected add-on", (key, op) => {
    expect(pickerKey(s, key).effect).toEqual({ type: "addon", op, id: "bw@x" });
  });

  test("Enter selects it (opens the popup); Esc and q close", () => {
    expect(pickerKey(s, "enter").effect).toEqual({ type: "select", id: "bw@x" });
    expect(pickerKey(s, "esc").effect).toEqual({ type: "close" });
    expect(pickerKey(s, "q").effect).toEqual({ type: "close" });
  });

  test("in search mode the op keys type", () => {
    const searching = pickerKey(s, "/").state;
    const { state, effect } = pickerKey(searching, "x");
    expect(effect).toBeNull();
    expect(state.query).toBe("x");
  });

  test("the op keys do nothing on an empty list", () => {
    const empty = openPicker([]);
    expect(pickerKey(empty, "x").effect).toBeNull();
  });
});

describe("remove: the question and the stale-answer guard", () => {
  const bw = defined(addonItems(records)[1]);

  test("the question names the add-on and its version", () => {
    expect(removeAddonQuestion(bw)).toBe('remove "Bitwarden" 2024.1? (y/N)');
  });

  test("changed: gone, renamed or another version; not by enabling or private access", () => {
    expect(addonChanged(bw, null)).toBe(true);
    expect(addonChanged(bw, { ...bw, display: "Bitwarden 2" })).toBe(true);
    expect(addonChanged(bw, { ...bw, version: "2024.2" })).toBe(true);
    expect(addonChanged(bw, { ...bw, enabled: false, privateAllowed: false })).toBe(false);
  });
});

describe("keys and commands", () => {
  test("prefix+e opens the picker by default", () => {
    expect(getAction("addon_picker")?.id).toBe("addons.picker");
    expect(DEFAULT_CONFIG.keys?.addon_picker).toEqual(["prefix+e"]);
    expect(getAction("addon_popup")?.id).toBe("addons.popup");
    expect(DEFAULT_CONFIG.keys?.addon_popup).toBeUndefined();
  });

  test(":addons opens the picker; :addon name opens a popup", () => {
    expect(parseCommandLine(":addons")).toMatchObject({ action: { id: "addons.picker" } });
    expect(parseCommandLine(":addon ublock")).toMatchObject({
      command: "addon",
      action: { id: "addons.popup" },
      text: "ublock",
    });
    expect(parseCommandLine(":addon")).toMatchObject({ action: { id: "addons.popup" } });
  });

  test("Tab completes add-on names after :addon", () => {
    const names = ["uBlock Origin", "Bitwarden", "aardvark"];
    const complete = (/** @type {string} */ line) =>
      completeCommandLine(line, { args: { addon: names } }).candidates;
    expect(complete(":addon ").map((c) => c.value)).toEqual([
      "addon uBlock Origin",
      "addon Bitwarden",
      "addon aardvark",
    ]);
    const bw = complete(":addon bw");
    expect(bw.map((c) => c.value)).toEqual(["addon Bitwarden"]);
    expect(bw[0]).toMatchObject({ kind: "argument", label: "Bitwarden" });
    expect(complete(":addon zzz")).toEqual([]);
    // other commands keep completing only their word
    expect(complete(":tabnew x")).toEqual([]);
    // without names (no host), nothing
    expect(completeCommandLine(":addon b").candidates).toEqual([]);
  });
});
