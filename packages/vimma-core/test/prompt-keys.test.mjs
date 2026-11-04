// docs/specs/toolbar-toggle.md decision 11a: Firefox's permission prompts (doorhangers) from the
// keyboard. `y` runs the prompt's main action and `n` its secondary one, only once the prompt is
// armed; `Tab` moves focus into the prompt; nothing typed in a field ever answers it.
import { describe, test, expect } from "vitest";
import {
  dialogHint,
  dialogKey,
  doorhangerHint,
  doorhangerKey,
  popupBarHint,
  popupBarKey,
} from "../src/prompt-keys.mjs";

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

// docs/specs/popup-blocked.md: Firefox's pop-up blocked bar takes the same keys, with the same
// guards: `y` allows the site, `n` blocks it, `Esc` closes the bar; never from a field.
describe("popupBarKey", () => {
  const bar = { open: true, armed: true, inField: false, pending: false };

  test("y allows, n blocks and Esc closes an armed bar", () => {
    expect(popupBarKey("y", bar)).toEqual({ kind: "allow" });
    expect(popupBarKey("n", bar)).toEqual({ kind: "block" });
    expect(popupBarKey("esc", bar)).toEqual({ kind: "close" });
  });

  test("before the bar is armed, y and n are swallowed and Esc stays the page's", () => {
    expect(popupBarKey("y", { ...bar, armed: false })).toEqual({ kind: "wait" });
    expect(popupBarKey("n", { ...bar, armed: false })).toEqual({ kind: "wait" });
    expect(popupBarKey("esc", { ...bar, armed: false })).toEqual({ kind: "pass" });
  });

  test("a held key never answers", () => {
    expect(popupBarKey("y", { ...bar, repeat: true })).toEqual({ kind: "wait" });
    expect(popupBarKey("esc", { ...bar, repeat: true })).toEqual({ kind: "pass" });
  });

  test("keys typed in a field, during a key sequence or with no bar are not the bar's", () => {
    for (const s of [
      { ...bar, inField: true },
      { ...bar, pending: true },
      { ...bar, open: false },
    ]) {
      for (const key of ["y", "n", "esc"]) expect(popupBarKey(key, s)).toEqual({ kind: "pass" });
    }
  });

  test("Tab never moves focus onto the bar, and other keys pass", () => {
    for (const key of ["tab", "Y", "shift+y", "ctrl+n", "enter", "j"]) {
      expect(popupBarKey(key, bar)).toEqual({ kind: "pass" });
    }
  });

  test("a locked dom.disable_open_during_load leaves y and n alone; Esc still closes", () => {
    const locked = { ...bar, locked: true };
    expect(popupBarKey("y", locked)).toEqual({ kind: "pass" });
    expect(popupBarKey("n", locked)).toEqual({ kind: "pass" });
    expect(popupBarKey("esc", locked)).toEqual({ kind: "close" });
  });

  test("in the agent workspace nothing answers the bar", () => {
    for (const key of ["y", "n", "esc"]) {
      expect(popupBarKey(key, { ...bar, agent: true })).toEqual({ kind: "pass" });
    }
  });
});

describe("popupBarHint", () => {
  test("the permission prompt's line, with Esc to close", () => {
    expect(popupBarHint({})).toBe("y allow · n block · Esc close");
  });

  test("from a field (or hint, copy and element mode) it starts with the way out", () => {
    expect(popupBarHint({ inField: true })).toBe("Esc, then y allow · n block");
  });

  test("with the pop-up pref locked, only the way to close is named", () => {
    expect(popupBarHint({ locked: true })).toBe("Esc close");
    expect(popupBarHint({ inField: true, locked: true })).toBe("Esc, then Esc close");
  });
});

// docs/specs/firefox-dialogs.md: Firefox's dialogs over a tab or over the window (a page's alert,
// confirm and prompt, "Leave page?", a sign-in) take the same keys: `y` the main button, `n` the
// button Esc runs (the safe choice), once the dialog is armed, never from its text fields.
describe("dialogKey", () => {
  /** An armed two-button dialog, focus on its buttons. */
  const dialog = { armed: true, inField: false, pending: false, accept: true, cancel: true };

  test("y runs the main button and n the cancel button of an armed dialog", () => {
    expect(dialogKey("y", dialog)).toEqual({ kind: "accept" });
    expect(dialogKey("n", dialog)).toEqual({ kind: "cancel" });
  });

  test("before it is armed, or held down, y and n wait", () => {
    for (const s of [
      { ...dialog, armed: false },
      { ...dialog, repeat: true },
    ]) {
      expect(dialogKey("y", s)).toEqual({ kind: "wait" });
      expect(dialogKey("n", s)).toEqual({ kind: "wait" });
    }
  });

  test("typing in the dialog's own fields is never an answer", () => {
    for (const key of ["y", "n"]) {
      expect(dialogKey(key, { ...dialog, inField: true })).toEqual({ kind: "pass" });
    }
  });

  test("an alert has no cancel button: n is not its key", () => {
    const alert = { ...dialog, cancel: false };
    expect(dialogKey("y", alert)).toEqual({ kind: "accept" });
    expect(dialogKey("n", alert)).toEqual({ kind: "pass" });
  });

  test("Esc, Enter, Tab and the rest stay Firefox's; a key sequence passes", () => {
    for (const key of ["esc", "enter", "tab", "Y", "shift+y", "ctrl+n", "j"]) {
      expect(dialogKey(key, dialog)).toEqual({ kind: "pass" });
    }
    expect(dialogKey("y", { ...dialog, pending: true })).toEqual({ kind: "pass" });
  });
});

describe("dialogHint", () => {
  test("named after the dialog's own buttons", () => {
    expect(dialogHint({ accept: "Leave page", cancel: "Stay on page" })).toBe(
      "y leave page · n stay on page",
    );
    expect(dialogHint({ accept: "OK", cancel: "" })).toBe("y ok");
  });

  test("with a text field the letters type: Enter and Esc answer", () => {
    expect(dialogHint({ accept: "OK", cancel: "Cancel", field: true })).toBe(
      "Enter ok · Esc cancel",
    );
  });
});
