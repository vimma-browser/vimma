import { describe, test, expect } from "vitest";
import {
  suggestionListOpen,
  suggestionStep,
  SUGGESTION_ACTIONS,
} from "../src/keys/suggestions.mjs";

// docs/specs/page-suggestions.md decision 4: what counts as an open suggestion list.

const popup = (p: Partial<import("../src/keys/suggestions.mjs").PopupSnapshot> = {}) => ({
  role: "listbox",
  rendered: true,
  visible: true,
  hasOption: true,
  ...p,
});

const field = (f: Partial<import("../src/keys/suggestions.mjs").FieldSnapshot> = {}) => ({
  role: "",
  expanded: "",
  popups: [],
  ...f,
});

describe("suggestionListOpen", () => {
  test("an ARIA 1.2 combobox, expanded, with a visible popup", () => {
    const focused = field({ role: "combobox", expanded: "true", popups: [popup()] });
    expect(suggestionListOpen({ focused, combobox: null, autocompletePopup: false })).toBe(true);
  });

  test("an expanded combobox whose named popup is hidden", () => {
    for (const p of [popup({ rendered: false }), popup({ visible: false })]) {
      const focused = field({ role: "combobox", expanded: "true", popups: [p] });
      expect(suggestionListOpen({ focused, combobox: null, autocompletePopup: false })).toBe(false);
    }
  });

  test("an expanded combobox that names no popup", () => {
    const focused = field({ role: "combobox", expanded: "true" });
    expect(suggestionListOpen({ focused, combobox: null, autocompletePopup: false })).toBe(true);
  });

  test("a collapsed combobox", () => {
    const focused = field({ role: "combobox", expanded: "false", popups: [popup()] });
    expect(suggestionListOpen({ focused, combobox: null, autocompletePopup: false })).toBe(false);
  });

  test("an ARIA 1.1 wrapper combobox with aria-owns", () => {
    const combobox = field({ role: "combobox", expanded: "true", popups: [popup()] });
    expect(
      suggestionListOpen({
        focused: field({ role: "textbox" }),
        combobox,
        autocompletePopup: false,
      }),
    ).toBe(true);
  });

  test("a text box naming a visible listbox with options", () => {
    const focused = field({ popups: [popup()] });
    expect(suggestionListOpen({ focused, combobox: null, autocompletePopup: false })).toBe(true);
  });

  test("a listbox with no options, or a popup that is not a listbox", () => {
    for (const p of [popup({ hasOption: false }), popup({ role: "dialog" })]) {
      const focused = field({ popups: [p] });
      expect(suggestionListOpen({ focused, combobox: null, autocompletePopup: false })).toBe(false);
    }
  });

  test("Firefox's autocomplete popup open", () => {
    expect(suggestionListOpen({ focused: field(), combobox: null, autocompletePopup: true })).toBe(
      true,
    );
  });

  test("a plain input, or nothing focused", () => {
    expect(suggestionListOpen({ focused: field(), combobox: null, autocompletePopup: false })).toBe(
      false,
    );
    expect(suggestionListOpen({ focused: null, combobox: null, autocompletePopup: false })).toBe(
      false,
    );
  });
});

describe("suggestionStep", () => {
  test("with a list: next presses ArrowDown, prev ArrowUp", () => {
    expect(suggestionStep("page.suggestion_next", true)).toEqual({
      kind: "press",
      key: "ArrowDown",
    });
    expect(suggestionStep("page.suggestion_prev", true)).toEqual({ kind: "press", key: "ArrowUp" });
  });

  test("without a list, either falls back", () => {
    expect(suggestionStep("page.suggestion_next", false)).toEqual({ kind: "fallback" });
    expect(suggestionStep("page.suggestion_prev", false)).toEqual({ kind: "fallback" });
  });

  test("the two actions", () => {
    expect([...SUGGESTION_ACTIONS]).toEqual(["page.suggestion_next", "page.suggestion_prev"]);
  });
});

describe("suggestionListOpen: only a combobox's aria-expanded opens a list", () => {
  test("a textbox that says it is expanded, with no popup named, has no list open", () => {
    const focused = field({ role: "textbox", expanded: "true" });
    expect(suggestionListOpen({ focused, combobox: null, autocompletePopup: false })).toBe(false);
  });

  test("an expanded combobox with one of its named popups showing has a list open", () => {
    const focused = field({
      role: "combobox",
      expanded: "true",
      popups: [popup({ role: "grid", visible: false }), popup({ role: "grid" })],
    });
    expect(suggestionListOpen({ focused, combobox: null, autocompletePopup: false })).toBe(true);
  });
});
