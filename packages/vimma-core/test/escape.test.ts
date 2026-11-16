import { describe, test, expect } from "vitest";
import { resolveEscape } from "../src/keys/escape.mjs";
import { MODES } from "../src/keys/modes.mjs";
import { createDispatcher } from "../src/keys/dispatcher.mjs";
import { compileKeymap } from "../src/keys/keymap.mjs";
import { parseKey } from "../src/keys/keys.mjs";

import type { Mode } from "../src/keys/modes.mjs";
import type { EscapeResult } from "../src/keys/escape.mjs";

const action = (id: string, mode: Mode, extra = {}) => ({
  kind: "action",
  action: { id },
  mode,
  ...extra,
});
/** The mode Esc leaves for; a pass has none. */
const modeOf = (r: EscapeResult) => (r.kind === "pass" ? undefined : r.mode);

describe("resolveEscape", () => {
  const idle: Array<[Mode, ReturnType<typeof action>]> = [
    ["insert", action("mode.normal", "normal", { blur: true })],
    ["visual", action("mode.normal", "normal", { collapseSelection: true })],
    ["command", action("command.cancel", "normal")],
    ["hint", action("hint.cancel", "normal")],
    ["help", action("help.close", "normal")],
    ["panel", action("panel.close", "normal")],
    ["normal", action("page.stop", "normal", { afterPage: true, blur: true })],
  ];
  test.each(idle)("Given %s with nothing pending, then %o", (mode, expected) => {
    expect(resolveEscape({ mode })).toEqual(expected);
    expect(resolveEscape({ mode, pending: false })).toEqual(expected);
  });

  test.each(MODES)("Given %s with a prefix or sequence pending, then cancel and stay", (mode) => {
    expect(resolveEscape({ mode, pending: true })).toEqual({ kind: "cancel", mode });
  });

  const overlays: Array<[Mode, Mode]> = [
    ["help", "insert"],
    ["panel", "visual"],
    ["help", "normal"],
  ];
  test.each(overlays)("Given %s opened from %s, then Esc returns there", (mode, previous) => {
    expect(modeOf(resolveEscape({ mode, previous }))).toBe(previous);
  });

  test.each(["command", "hint", "insert", "visual"] as Mode[])(
    "Given %s, then previous is ignored and Esc goes to normal",
    (mode) => {
      expect(modeOf(resolveEscape({ mode, previous: "insert" }))).toBe("normal");
    },
  );

  test("an unknown mode or previous mode throws", () => {
    expect(() => resolveEscape({ mode: "prefix" as any })).toThrow(/unknown mode/);
    expect(() => resolveEscape({ mode: "help", previous: "bogus" as any })).toThrow(/unknown mode/);
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
