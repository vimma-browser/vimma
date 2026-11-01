import { describe, test, expect } from "vitest";
import {
  PERMISSION_STATE,
  permissionItems,
  permissionPlan,
  permissionTitle,
} from "../src/sitepermissions.mjs";
import { filterItems, itemId, openPicker, pickerKey } from "../src/picker.mjs";
import { parseCommandLine } from "../src/cmdline.mjs";
import { getAction } from "../src/actions.mjs";
import { DEFAULT_CONFIG } from "../src/defaults.mjs";

/** @import { PermissionRecord } from "../src/sitepermissions.mjs" */

const { UNKNOWN, ALLOW, BLOCK, PROMPT } = PERMISSION_STATE;

/**
 * @param {Partial<PermissionRecord>} over
 * @returns {PermissionRecord}
 */
const rec = (over = {}) => ({
  id: "camera",
  label: "Use the camera",
  state: UNKNOWN,
  stateLabel: "Always Ask",
  states: [UNKNOWN, ALLOW, BLOCK],
  set: false,
  scope: "persistent",
  locked: false,
  ...over,
});

describe("permissionItems", () => {
  test("one row per permission, by Firefox's label, with its real state", () => {
    const items = permissionItems([
      rec({
        id: "geo",
        label: "Access your location",
        state: BLOCK,
        stateLabel: "Block",
        set: true,
      }),
      rec(),
      rec({
        id: "popup",
        label: "Open pop-up windows",
        state: BLOCK,
        stateLabel: "Block",
        states: [ALLOW, BLOCK],
      }),
    ]);
    expect(items.map((i) => [i.permissionId, i.display, i.detail])).toEqual([
      ["geo", "Access your location", "Block"],
      ["popup", "Open pop-up windows", "Block · default"],
      ["camera", "Use the camera", "Always Ask · default"],
    ]);
    expect(items.every((i) => i.kind === "permission" && i.active === false)).toBe(true);
    expect(items.map((i) => i.set)).toEqual([true, false, false]);
  });

  test("says how long a setting lasts and when it cannot be changed", () => {
    const detail = (/** @type {Partial<PermissionRecord>} */ over) =>
      permissionItems([rec({ set: true, state: ALLOW, stateLabel: "Allow", ...over })])[0]?.detail;
    expect(detail({})).toBe("Allow");
    expect(detail({ scope: "temporary" })).toBe("Allow · temporary");
    expect(detail({ scope: "session" })).toBe("Allow · this session");
    expect(detail({ scope: "policy", locked: true })).toBe("Allow · set by policy");
    expect(detail({ scope: "global", state: BLOCK, stateLabel: "Block", locked: true })).toBe(
      "Block · temporary · locked",
    );
    expect(detail({ set: false, locked: true })).toBe("Allow · default · locked");
  });

  test("rows are picker items: selected by permission id, matched by their label", () => {
    const items = permissionItems([rec(), rec({ id: "geo", label: "Access your location" })]);
    expect(items.map(itemId)).toEqual(["geo", "camera"]);
    expect(filterItems(items, "camera").map((m) => itemId(m.item))).toEqual(["camera"]);
  });
});

describe("picker keys", () => {
  const items = permissionItems([rec(), rec({ id: "geo", label: "Access your location" })]);

  test("a, b and r ask to allow, block or reset the selected row; the picker stays", () => {
    const state = openPicker(items, { activeId: null });
    expect(pickerKey(state, "a").effect).toEqual({ type: "permission", op: "allow", id: "geo" });
    expect(pickerKey(state, "b").effect).toEqual({ type: "permission", op: "block", id: "geo" });
    expect(pickerKey(state, "r").effect).toEqual({ type: "permission", op: "reset", id: "geo" });
    const next = pickerKey(state, "j").state;
    expect(pickerKey(next, "enter").effect).toEqual({
      type: "permission",
      op: "next",
      id: "camera",
    });
  });

  test("in search, a, b and r type", () => {
    let state = pickerKey(openPicker(items, { activeId: null }), "/").state;
    for (const key of ["c", "a", "b", "r"]) {
      const { state: s, effect } = pickerKey(state, key);
      expect(effect).toBeNull();
      state = s;
    }
    expect(state.query).toBe("cabr");
  });

  test("other pickers' rows get no permission effect", () => {
    const tab = {
      tabId: "t1",
      workspaceId: "w",
      workspaceName: "main",
      workspaceIndex: 1,
      tabIndex: 1,
      title: "x",
      url: "https://x.test/",
      label: null,
      display: "x",
      active: false,
    };
    const state = openPicker([tab], { activeId: null });
    for (const key of ["a", "b", "r"]) expect(pickerKey(state, key).effect).toBeNull();
  });
});

describe("permissionPlan", () => {
  test("allow and block set Firefox's state, when Firefox offers it", () => {
    expect(permissionPlan(rec(), "allow")).toEqual({ type: "set", state: ALLOW });
    expect(permissionPlan(rec(), "block")).toEqual({ type: "set", state: BLOCK });
  });

  test("a state Firefox does not offer for the permission is refused", () => {
    const screen = rec({ id: "screen", label: "Share the screen", states: [UNKNOWN, BLOCK] });
    expect(permissionPlan(screen, "allow")).toEqual({
      type: "refuse",
      text: "Share the screen cannot be set to allow",
    });
    const handler = rec({ label: "Open apps", states: [UNKNOWN, ALLOW] });
    expect(permissionPlan(handler, "block")).toEqual({
      type: "refuse",
      text: "Open apps cannot be set to block",
    });
  });

  test("reset removes the site's setting, and says when there is none", () => {
    expect(permissionPlan(rec({ set: true, state: ALLOW }), "reset")).toEqual({ type: "remove" });
    expect(permissionPlan(rec(), "reset")).toEqual({
      type: "refuse",
      text: "Use the camera is already the default",
    });
  });

  test("next steps through Firefox's states for the permission, in its order", () => {
    const autoplay = rec({ state: BLOCK, states: [ALLOW, BLOCK, 5] });
    expect(permissionPlan(autoplay, "next")).toEqual({ type: "set", state: 5 });
    expect(permissionPlan({ ...autoplay, state: 5 }, "next")).toEqual({
      type: "set",
      state: ALLOW,
    });
    // A state outside the list (a persisted PROMPT) starts at the first.
    expect(permissionPlan(rec({ state: PROMPT, states: [ALLOW, BLOCK] }), "next")).toEqual({
      type: "set",
      state: ALLOW,
    });
  });

  test("a locked row changes nothing", () => {
    const policy = rec({ set: true, scope: "policy", locked: true });
    for (const op of /** @type {const} */ (["allow", "block", "reset", "next"])) {
      expect(permissionPlan(policy, op)).toEqual({
        type: "refuse",
        text: "Use the camera is set by policy",
      });
      expect(permissionPlan(rec({ locked: true }), op)).toEqual({
        type: "refuse",
        text: "Use the camera is locked",
      });
    }
  });
});

describe("permissionTitle", () => {
  test("names the site, and says a private one lasts until the private workspace closes", () => {
    expect(permissionTitle({ site: "example.com", isPrivate: false })).toBe(
      "Site permissions · example.com",
    );
    expect(permissionTitle({ site: "example.com", isPrivate: true })).toBe(
      "Site permissions · example.com · private: until the private workspace closes",
    );
  });
});

describe("reach", () => {
  test(":site and :permissions open the picker; no default key", () => {
    expect(getAction("site_permissions")?.id).toBe("site.permissions");
    expect(DEFAULT_CONFIG.keys?.site_permissions).toBeUndefined();
    expect(parseCommandLine(":site")).toMatchObject({ action: { id: "site.permissions" } });
    expect(parseCommandLine(":permissions")).toMatchObject({ action: { id: "site.permissions" } });
  });
});
