import { describe, test, expect } from "vitest";
import { parseConfig } from "../src/config.mjs";
import { DEFAULT_CONFIG, formatConfigTemplate } from "../src/defaults.mjs";
import { createDispatcher } from "../src/dispatcher.mjs";
import { boundChords } from "../src/firefox-keys.mjs";
import { KeymapError, compileKeymap } from "../src/keymap.mjs";
import { CONTEXTS, MODES } from "../src/modes.mjs";
import { formatKey, parseBinding, parseKey } from "../src/keys.mjs";

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

  test("the pdf trie of normal mode is the page trie with the default [modal.pdf] over it", () => {
    const km = compileKeymap();
    const pdfDefaults = new Set(
      Object.keys(DEFAULT_CONFIG.modal.pdf).map((t) => parseBinding(t).map(formatKey).join(" ")),
    );
    const pdf = new Map(km.sequences("normal", "pdf").map((e) => [e.seq, e.name]));
    for (const e of km.sequences("normal", "page")) {
      if (!pdfDefaults.has(e.seq)) expect(pdf.get(e.seq), e.seq).toBe(e.name);
    }
    expect(km.sequences("normal")).toEqual(km.sequences("normal", "page"));
  });

  // docs/specs/pdf-mode.md Behaviour 2 to 4 and decision 21: the PDF viewer adds zathura's keys
  // only where Vimma's normal mode has none, so a Vimma key does the same in a PDF as on a page.
  test.each([
    ["J", "pdf_next_page", undefined],
    ["K", "pdf_previous_page", undefined],
    ["gg", "pdf_first_page", "scroll_top"],
    ["G", "pdf_last_page", "scroll_bottom"],
    ["+", "pdf_zoom_in", undefined],
    ["z i", "pdf_zoom_in", undefined],
    ["z shift+i", "pdf_zoom_in", undefined],
    ["-", "pdf_zoom_out", undefined],
    ["z o", "pdf_zoom_out", undefined],
    ["z shift+o", "pdf_zoom_out", undefined],
    ["=", "pdf_zoom_set", undefined],
    ["z z", "pdf_zoom_set", undefined],
    ["z shift+z", "pdf_zoom_set", undefined],
    ["z 0", "pdf_zoom_set", undefined],
    ["a", "pdf_fit_page", undefined],
    ["s", "pdf_fit_width", undefined],
    ["D", "pdf_first_page_alone", undefined],
    ["w", "pdf_single_page", undefined],
    ["R", "reload", undefined],
    ["Y", "yank_url", undefined],
    ["tab", "pdf_outline", undefined],
    ["c", "copy_link_target", undefined],
  ])("%s is %s in the pdf context, %s on pages", (key, pdf, page) => {
    const km = compileKeymap();
    const seq = key.replace(/^(g)(g)$/, "$1 $2");
    expect(lookup(km.trie("normal", "pdf"), seq)).toBe(pdf);
    expect(lookup(km.trie("normal", "page"), seq)).toBe(page);
  });

  // Decision 21: zathura's meanings no longer shadow these keys in the PDF viewer.
  test.each([
    ["d", "scroll_half_down"],
    ["r", "reload"],
    ["H", "history_back"],
    ["L", "history_forward"],
    ["F", "focus_element"],
    ["P", "open_clipboard_tab"],
    ["ctrl+f", "find_forward"],
    ["f5", "reload"],
  ])("%s is %s in the PDF viewer, as on pages", (key, action) => {
    const km = compileKeymap();
    expect(lookup(km.trie("normal", "pdf"), key)).toBe(action);
    expect(lookup(km.trie("normal", "page"), key)).toBe(action);
  });

  test("no default [modal.pdf] key changes a page key's meaning, only gg and G take a page", () => {
    const km = compileKeymap();
    const page = new Map(km.sequences("normal", "page").map((e) => [e.seq, e.name]));
    const shadowed = Object.keys(DEFAULT_CONFIG.modal.pdf)
      .map((t) => parseBinding(t).map(formatKey).join(" "))
      .filter((seq) => page.has(seq));
    // gg and G still go to the top and the bottom; in a PDF a count names a page (decision 6).
    expect(shadowed.sort()).toEqual(["g g", "shift+g"]);
  });

  test("the config template's zathura block, uncommented, gives zathura's keys back", () => {
    const lines = formatConfigTemplate().split("\n");
    const start = lines.findIndex((l) => /zathura/.test(l) && l.startsWith("#"));
    expect(start).toBeGreaterThan(lines.indexOf("[modal.pdf]"));
    const block = [];
    for (const l of lines.slice(start + 1)) {
      const m = /^# ("[^"]+" = "[^"]+")$/.exec(l);
      if (!m) break;
      block.push(m[1]);
    }
    const pdf = Object.fromEntries(
      block.map((l) => /** @type {[string, string]} */ (JSON.parse(`[${l.replace(" = ", ",")}]`))),
    );
    const km = compileKeymap({ modal: { pdf } });
    for (const [key, action] of [
      ["d", "pdf_dual_page"],
      ["r", "pdf_rotate"],
      ["H", "pdf_page_top"],
      ["L", "pdf_page_bottom"],
      ["P", "pdf_page_top"],
      ["F", "show_link_target"],
      ["ctrl+f", "pdf_screen_down"],
      ["f5", "pdf_presentation"],
    ]) {
      expect(lookup(km.trie("normal", "pdf"), key), key).toBe(action);
    }
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

// docs/specs/pdf-mode.md Behaviour 5 and decision 10: the outline panel's `index` mode.
describe("index mode", () => {
  test("index is a mode, and Tab opens the outline in the pdf context only", () => {
    const km = compileKeymap();
    expect(MODES).toContain("index");
    expect(lookup(km.trie("normal", "pdf"), "tab")).toBe("pdf_outline");
    expect(lookup(km.trie("normal", "page"), "tab")).toBeUndefined();
  });

  test.each([
    ["j", "index_down"],
    ["down", "index_down"],
    ["k", "index_up"],
    ["up", "index_up"],
    ["l", "index_expand"],
    ["z o", "index_expand"],
    ["h", "index_collapse"],
    ["z c", "index_collapse"],
    ["z shift+o", "index_expand_subtree"],
    ["z shift+c", "index_collapse_subtree"],
    ["shift+l", "index_expand_all"],
    ["z shift+r", "index_expand_all"],
    ["shift+h", "index_collapse_all"],
    ["z shift+m", "index_collapse_all"],
    ["g g", "index_first"],
    ["shift+g", "index_last"],
    ["ctrl+d", "index_half_down"],
    ["ctrl+u", "index_half_up"],
    ["enter", "index_follow"],
    ["space", "index_follow"],
    ["tab", "index_close"],
    ["esc", "index_close"],
    ["ctrl+[", "index_close"],
    ["q", "index_close"],
    ["/", "index_filter"],
  ])("%s is %s", (key, name) => {
    expect(lookup(compileKeymap().trie("index"), key)).toBe(name);
  });

  test("index mode turns off none of Firefox's keys that no other mode binds", () => {
    // ctrl+c is Firefox's copy; ctrl+j its web search once the user unbinds Vimma's.
    expect(boundChords(compileKeymap()).has("ctrl+c")).toBe(false);
    expect(boundChords(compileKeymap({ keys: { web_search: [] } })).has("ctrl+j")).toBe(false);
  });

  test("config.toml accepts [modal.index] as a mode table", () => {
    const r = parseConfig('[modal.index]\n"o" = "index_follow"\n[unbind]\nindex = ["q"]\n');
    expect(r.errors).toEqual([]);
    const trie = /** @type {any} */ (r.keymap).trie("index");
    expect(lookup(trie, "o")).toBe("index_follow");
    expect(lookup(trie, "q")).toBeUndefined();
  });
});
