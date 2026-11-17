// docs/specs/mcp-forms.md F5, F6; security.md M31: a page's child describes its elements, and
// only a fresh copy with the known fields, each of its type and within its cap, is kept. Issue
// #1119: the edges the weekly mutation run left unpinned (agent-act.test.ts has the rest).
import { describe, expect, test } from "vitest";
import {
  ELEMENT_REPLY_CAPS,
  parseAgentElement,
  parseAgentForms,
} from "../src/agent/agent-element.mjs";

const link = { kind: "link", text: "Home" };
/** Not an object, but carrying every field an element needs. */
const fn = (fields: Record<string, unknown>) => Object.assign(() => {}, fields);
const throwing = (key: string) =>
  Object.defineProperty({ kind: "link", text: "a" }, key, {
    enumerable: true,
    get() {
      throw new Error("a child's getter");
    },
  });

describe("parseAgentElement", () => {
  test("only a plain object is an element: not a function or an array with the fields", () => {
    expect(parseAgentElement(fn(link), 0)).toBeNull();
    expect(parseAgentElement(Object.assign(["x"], link), 0)).toBeNull();
    expect(parseAgentElement(null, 0)).toBeNull();
    expect(parseAgentElement(link, 0)).toEqual(link);
  });

  test("a text must be a string, up to its cap and no longer", () => {
    expect(parseAgentElement({ kind: "link", text: ["x"] }, 0)).toBeNull();
    const full = "t".repeat(ELEMENT_REPLY_CAPS.text);
    expect(parseAgentElement({ kind: "link", text: full }, 0)).toEqual({
      kind: "link",
      text: full,
    });
    expect(parseAgentElement({ kind: "link", text: `${full}t` }, 0)).toBeNull();
  });

  test("a kind outside the list is refused", () => {
    expect(parseAgentElement({ kind: "iframe", text: "a" }, 0)).toBeNull();
    expect(parseAgentElement({ kind: 1, text: "a" }, 0)).toBeNull();
  });

  test("disabled, readonly and sensitive are kept as the child says", () => {
    const field = { kind: "field", text: "Name", disabled: true, readonly: true, sensitive: false };
    expect(parseAgentElement(field, 0)).toEqual(field);
  });

  test("a field the child says is sensitive is refused with a value or a selected option", () => {
    const secret = { kind: "field", text: "PIN", sensitive: true };
    expect(parseAgentElement(secret, 0)).toEqual(secret);
    expect(parseAgentElement({ ...secret, value: "1234" }, 0)).toBeNull();
    expect(parseAgentElement({ ...secret, kind: "select", selected: "1" }, 0)).toBeNull();
  });

  test("a select may have exactly the cap of options, and each must be an object", () => {
    const options = Array.from({ length: ELEMENT_REPLY_CAPS.options }, (_, i) => ({
      value: `${i}`,
      text: `Option ${i}`,
    }));
    expect(parseAgentElement({ kind: "select", text: "Pick", options }, 0)).toEqual({
      kind: "select",
      text: "Pick",
      options,
    });
    expect(
      parseAgentElement(
        { kind: "select", text: "Pick", options: [fn({ value: "a", text: "A" })] },
        0,
      ),
    ).toBeNull();
    expect(parseAgentElement({ kind: "select", text: "Pick", options: [null] }, 0)).toBeNull();
  });

  test("a child whose reply throws when read gets null, not undefined", () => {
    expect(parseAgentElement(throwing("name"), 0)).toBeNull();
  });
});

describe("parseAgentForms", () => {
  test("exactly the cap of forms is taken, one more is refused", () => {
    const form = { method: "get", action: "https://a.example/" };
    const forms = Array.from({ length: ELEMENT_REPLY_CAPS.forms }, () => form);
    expect(parseAgentForms(forms)).toHaveLength(ELEMENT_REPLY_CAPS.forms);
    expect(parseAgentForms([...forms, form])).toBeNull();
  });

  test("a form must be a plain object with a method Firefox reports", () => {
    expect(parseAgentForms([fn({ method: "get", action: "" })])).toBeNull();
    expect(parseAgentForms([null])).toBeNull();
    expect(parseAgentForms([{ method: "put", action: "" }])).toBeNull();
    expect(parseAgentForms([{ method: 1, action: "" }])).toBeNull();
    expect(parseAgentForms([{ method: "dialog", action: "" }])).toEqual([
      { method: "dialog", action: "" },
    ]);
  });

  test("a reply that throws when read gets null, not undefined", () => {
    const form = Object.defineProperty({ action: "" }, "method", {
      enumerable: true,
      get() {
        throw new Error("a child's getter");
      },
    });
    expect(parseAgentForms([form])).toBeNull();
  });
});
