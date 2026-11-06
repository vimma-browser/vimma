import { describe, test, expect } from "vitest";
import { resolveEscape } from "../src/escape.mjs";
import { MODES } from "../src/modes.mjs";
import { createDispatcher } from "../src/dispatcher.mjs";
import { compileKeymap } from "../src/keymap.mjs";
import { parseKey } from "../src/keys.mjs";

const action = (id, mode, extra = {}) => ({ kind: "action", action: { id }, mode, ...extra });

describe("resolveEscape (plan §2)", () => {
  test.each([
    ["insert", action("mode.normal", "normal", { blur: true })],
    ["visual", action("mode.normal", "normal", { collapseSelection: true })],
    ["command", action("command.cancel", "normal")],
    ["hint", action("hint.cancel", "normal")],
    ["help", action("help.close", "normal")],
    ["panel", action("panel.close", "normal")],
    ["normal", action("page.stop", "normal", { afterPage: true, blur: true })],
  ])("Given %s with nothing pending, then %o", (mode, expected) => {
    expect(resolveEscape({ mode })).toEqual(expected);
    expect(resolveEscape({ mode, pending: false })).toEqual(expected);
  });

  test.each(MODES)("Given %s with a prefix or sequence pending, then cancel and stay", (mode) => {
    expect(resolveEscape({ mode, pending: true })).toEqual({ kind: "cancel", mode });
  });

  test.each([
    ["help", "insert"],
    ["panel", "visual"],
    ["help", "normal"],
  ])("Given %s opened from %s, then Esc returns there", (mode, previous) => {
    expect(resolveEscape({ mode, previous }).mode).toBe(previous);
  });

  test.each(["command", "hint", "insert", "visual"])(
    "Given %s, then previous is ignored and Esc goes to normal",
    (mode) => {
      expect(resolveEscape({ mode, previous: "insert" }).mode).toBe("normal");
    },
  );

  test("an unknown mode or previous mode throws", () => {
    expect(() => resolveEscape({ mode: /** @type {any} */ ("prefix") })).toThrow(/unknown mode/);
    expect(() => resolveEscape({ mode: "help", previous: /** @type {any} */ ("bogus") })).toThrow(
      /unknown mode/,
    );
  });

  test("the result is frozen", () => {
    expect(Object.isFrozen(resolveEscape({ mode: "insert" }))).toBe(true);
  });

  test.each(MODES)("in %s, the default keymap's <Esc> agrees with resolveEscape", (mode) => {
    const d = createDispatcher(compileKeymap());
    const fromKeymap = d.dispatch(mode, parseKey("esc"));
    const r = resolveEscape({ mode });
    if (r.kind === "action") {
      expect(fromKeymap).toEqual({ kind: "action", action: r.action });
    } else {
      expect(fromKeymap).toEqual({ kind: "pass" });
    }
  });
});
