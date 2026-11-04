import { describe, test, expect } from "vitest";
import { parseConfig } from "../src/config.mjs";
import { createDispatcher } from "../src/dispatcher.mjs";
import { boundChords } from "../src/firefox-keys.mjs";
import { KeymapError, compileKeymap } from "../src/keymap.mjs";
import { CONTEXTS } from "../src/modes.mjs";
import { formatKey, parseKey } from "../src/keys.mjs";

// Keymap contexts (docs/specs/pdf-mode.md decision 4, docs/adr/024-keymap-contexts.md): the `pdf`
// trie of normal mode is normal's bindings with [modal.pdf] merged over them.

/** @param {import("../src/keymap.mjs").TrieNode} root @param {string} seq */
function lookup(root, seq) {
  let node = root;
  for (const k of seq.split(" ")) {
    const next = node.children.get(formatKey(parseKey(k)));
    if (!next) return undefined;
    node = next;
  }
  return node.action?.name;
}

describe("keymap contexts", () => {
  test("the contexts are page and pdf", () => {
    expect(CONTEXTS).toEqual(["page", "pdf"]);
  });

  test("with no [modal.pdf], the pdf trie of normal mode binds what the page trie binds", () => {
    const km = compileKeymap();
    expect(km.sequences("normal", "pdf")).toEqual(km.sequences("normal", "page"));
    expect(km.sequences("normal")).toEqual(km.sequences("normal", "page"));
    expect(lookup(km.trie("normal", "pdf"), "d")).toBe(lookup(km.trie("normal"), "d"));
  });

  test("[modal.pdf] shadows normal's binding only in the pdf context", () => {
    const km = compileKeymap({ modal: { pdf: { d: "close_tab", J: "next_tab" } } });
    expect(lookup(km.trie("normal", "pdf"), "d")).toBe("close_tab");
    expect(lookup(km.trie("normal", "pdf"), "J")).toBe("next_tab");
    expect(lookup(km.trie("normal", "page"), "d")).not.toBe("close_tab");
    expect(lookup(km.trie("normal", "page"), "J")).toBeUndefined();
  });

  test("a user's [modal.normal] binding shows in pdf unless [modal.pdf] binds the sequence", () => {
    const km = compileKeymap({
      modal: { normal: { Q: "close_tab", W: "next_tab" }, pdf: { W: "previous_tab" } },
    });
    expect(lookup(km.trie("normal", "pdf"), "Q")).toBe("close_tab");
    expect(lookup(km.trie("normal", "pdf"), "W")).toBe("previous_tab");
    expect(lookup(km.trie("normal", "page"), "W")).toBe("next_tab");
  });

  test("[keys] bindings reach the pdf context, and [modal.pdf] shadows them there", () => {
    const km = compileKeymap({ modal: { pdf: { f5: "next_tab" } } });
    expect(lookup(km.trie("normal", "pdf"), "f5")).toBe("next_tab");
    expect(lookup(km.trie("normal", "page"), "f5")).toBe("reload");
    expect(lookup(km.trie("insert"), "f5")).toBe("reload");
    expect(lookup(km.trie("normal", "pdf"), "ctrl+b c")).toBe("new_tab");
  });

  test("[unbind] pdf removes a binding only in the pdf context", () => {
    const km = compileKeymap({ unbind: { pdf: ["x"] } });
    expect(lookup(km.trie("normal", "pdf"), "x")).toBeUndefined();
    expect(lookup(km.trie("normal", "page"), "x")).toBe("close_tab");
  });

  test("[unbind] normal removes a binding in both contexts", () => {
    const km = compileKeymap({ unbind: { normal: ["x"] } });
    expect(lookup(km.trie("normal", "pdf"), "x")).toBeUndefined();
  });

  test("[modal.pdf] cannot bind the prefix", () => {
    expect(() => compileKeymap({ modal: { pdf: { "ctrl+b": "close_tab" } } })).toThrow(KeymapError);
    expect(() => compileKeymap({ modal: { pdf: { "prefix+z": "close_tab" } } })).toThrow(/prefix/);
  });

  test("a [modal.pdf] binding is listed with its context", () => {
    const km = compileKeymap({ modal: { pdf: { J: "next_tab" } } });
    expect(km.bindingsFor("next_tab")).toContain("J [pdf]");
  });

  test("other modes have no pdf trie of their own", () => {
    const km = compileKeymap({ modal: { pdf: { J: "next_tab" } } });
    expect(km.trie("insert", "pdf")).toBe(km.trie("insert"));
  });

  test("a chord bound only in [modal.pdf] is bound for Firefox's keys", () => {
    expect(boundChords(compileKeymap())).not.toContain("alt+z");
    expect(boundChords(compileKeymap({ modal: { pdf: { "alt+z": "next_tab" } } }))).toContain(
      "alt+z",
    );
  });

  test("config.toml accepts [modal.pdf] and [unbind] pdf", () => {
    const r = parseConfig('[modal.pdf]\n"J" = "next_tab"\n[unbind]\npdf = ["x"]\n');
    expect(r.errors).toEqual([]);
    expect(lookup(/** @type {any} */ (r.keymap).trie("normal", "pdf"), "J")).toBe("next_tab");
  });
});

describe("dispatcher with a context", () => {
  const km = () => compileKeymap({ modal: { pdf: { J: "next_tab", "g x": "close_tab" } } });

  test("the same key gives the pdf action with context pdf and none with page", () => {
    const d = createDispatcher(km());
    expect(d.dispatch("normal", parseKey("J"), "pdf")).toEqual({
      kind: "action",
      action: { id: "tab.next" },
    });
    expect(d.dispatch("normal", parseKey("J"), "page")).toEqual({ kind: "pass" });
    expect(d.dispatch("normal", parseKey("J"))).toEqual({ kind: "pass" });
  });

  test("a context change resets a pending sequence and a count", () => {
    const d = createDispatcher(km());
    expect(d.dispatch("normal", parseKey("3"), "pdf")).toEqual({ kind: "pending" });
    expect(d.dispatch("normal", parseKey("g"), "pdf")).toEqual({ kind: "pending" });
    expect(d.pending()).toEqual(["3", "g"]);
    // `x` in the page context closes the tab with no count: nothing of `3g` carries over.
    expect(d.dispatch("normal", parseKey("x"), "page")).toEqual({
      kind: "action",
      action: { id: "tab.close" },
    });
  });

  test("an unknown context is an error", () => {
    const d = createDispatcher(km());
    expect(() => d.dispatch("normal", parseKey("j"), /** @type {any} */ ("nope"))).toThrow(
      /unknown context/,
    );
  });
});
