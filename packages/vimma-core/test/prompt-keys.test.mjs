// docs/specs/toolbar-toggle.md decision 11a: Firefox's permission prompts (doorhangers) from the
// keyboard. `y` runs the prompt's main action and `n` its secondary one, only once the prompt is
// armed; `Tab` moves focus into the prompt; nothing typed in a field ever answers it.
import { describe, test, expect } from "vitest";
import { doorhangerHint, doorhangerKey } from "../src/prompt-keys.mjs";

/** An open, armed prompt, focus in the page (normal mode), no key sequence under way. */
const base = { open: true, armed: true, inField: false, inPrompt: false, pending: false };

describe("doorhangerKey", () => {
  test("y allows and n blocks an armed prompt", () => {
    expect(doorhangerKey("y", base)).toEqual({ kind: "allow" });
    expect(doorhangerKey("n", base)).toEqual({ kind: "block" });
  });

  test("before the prompt is armed, y and n are swallowed and start the delay again", () => {
    expect(doorhangerKey("y", { ...base, armed: false })).toEqual({ kind: "wait" });
    expect(doorhangerKey("n", { ...base, armed: false })).toEqual({ kind: "wait" });
  });

  test("a held key never answers", () => {
    expect(doorhangerKey("y", { ...base, repeat: true })).toEqual({ kind: "wait" });
    expect(doorhangerKey("n", { ...base, repeat: true })).toEqual({ kind: "wait" });
  });

  test("only the lower-case letters answer", () => {
    for (const key of ["Y", "N", "shift+y", "ctrl+y", "alt+n", "enter", "space", "a"]) {
      expect(doorhangerKey(key, base)).toEqual({ kind: "pass" });
    }
  });

  test("Tab moves focus into the prompt; inside it, Tab is Firefox's", () => {
    expect(doorhangerKey("tab", base)).toEqual({ kind: "focus" });
    expect(doorhangerKey("tab", { ...base, armed: false })).toEqual({ kind: "focus" });
    expect(doorhangerKey("tab", { ...base, inPrompt: true })).toEqual({ kind: "pass" });
  });

  test("Esc is left to Firefox, whose prompt runs its own Esc action", () => {
    expect(doorhangerKey("esc", base)).toEqual({ kind: "pass" });
  });

  test("keys typed in a field never answer a prompt", () => {
    for (const key of ["y", "n", "tab"]) {
      expect(doorhangerKey(key, { ...base, inField: true })).toEqual({ kind: "pass" });
    }
  });

  test("with focus in the prompt, y and n answer it", () => {
    const inPrompt = { ...base, inField: true, inPrompt: true };
    expect(doorhangerKey("y", inPrompt)).toEqual({ kind: "allow" });
    expect(doorhangerKey("n", inPrompt)).toEqual({ kind: "block" });
  });

  test("keys typed in the prompt's own text field are the field's", () => {
    // The password prompt's username and password fields: a username with a y in it is typed,
    // and Tab is Firefox's, to the next field or the buttons.
    const field = { ...base, inField: true, inPrompt: true, promptField: true };
    for (const key of ["y", "n", "tab", "Y", "esc"]) {
      expect(doorhangerKey(key, field)).toEqual({ kind: "pass" });
    }
  });

  test("no prompt open, or a key sequence under way: every key passes", () => {
    for (const key of ["y", "n", "tab"]) {
      expect(doorhangerKey(key, { ...base, open: false })).toEqual({ kind: "pass" });
      expect(doorhangerKey(key, { ...base, pending: true })).toEqual({ kind: "pass" });
    }
  });
});

describe("doorhangerHint", () => {
  test("names the prompt's own buttons", () => {
    expect(doorhangerHint({ main: "Allow", secondary: "Block" })).toBe(
      "y allow · n block · Tab buttons",
    );
    expect(doorhangerHint({ main: "Allow", secondary: "Don’t allow" })).toBe(
      "y allow · n don’t allow · Tab buttons",
    );
  });

  test("a prompt without a secondary button offers only y", () => {
    expect(doorhangerHint({ main: "OK", secondary: "" })).toBe("y ok · Tab buttons");
  });

  test("with focus in a field outside the prompt, it says to leave the field first", () => {
    expect(doorhangerHint({ main: "Save", secondary: "Not now", inField: true })).toBe(
      "Esc, then y save · n not now",
    );
    expect(doorhangerHint({ main: "Save", secondary: "Not now", inField: false })).toBe(
      "y save · n not now · Tab buttons",
    );
  });

  test("labels are trimmed and kept short", () => {
    const long = "Allow this site to do something with a very long label indeed";
    const hint = doorhangerHint({ main: `  ${long} `, secondary: "Block" });
    expect(hint.startsWith("y allow this site")).toBe(true);
    expect(hint).toContain("…");
    expect(hint.split(" · ")[0].length).toBeLessThanOrEqual(26);
  });
});
