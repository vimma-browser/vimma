// Keys a site keeps: [sites."<host>"] unbind (docs/specs/site-unbind.md).
import { beforeAll, describe, test, expect } from "vitest";
import { parseConfig } from "../src/config/config.mjs";
import { formatConfigTemplate, formatDefaultsToml } from "../src/config/defaults.mjs";
import { createDispatcher } from "../src/keys/dispatcher.mjs";
import { compileKeymap } from "../src/keys/keymap.mjs";
import { formatKey, parseKey } from "../src/keys/keys.mjs";

import type { TrieNode } from "../src/keys/keymap.mjs";
import type { Mode, Context } from "../src/keys/modes.mjs";

// A config.toml whose first line is a comment, so errors are on the lines they always were.
const cfg = (...lines: string[]) => ["# config.toml", ...lines].join("\n") + "\n";

/** The action name `seq` (space-separated chords) runs from `root`, if any. */
function lookup(root: TrieNode, seq: string) {
  let node = root;
  for (const k of seq.split(" ")) {
    const next = node.children.get(formatKey(parseKey(k)));
    if (!next) return undefined;
    node = next;
  }
  return node.action?.name;
}

/** The keymap of a config that must load. */
function keymapOf(text: string) {
  const r = parseConfig(text);
  expect(r.errors).toEqual([]);
  if (!r.keymap) throw new Error("no keymap");
  return r.keymap;
}

function errors(text: string) {
  const r = parseConfig(text);
  expect(r.config).toBeNull();
  return r.errors.map((e) => ({
    line: e.line,
    path: e.path,
    message: e.message,
    ...(e.suggestion ? { suggestion: e.suggestion } : {}),
  }));
}

/** What `seq` runs in `mode` on `host`, through site() and trie() as the host calls them. */
function on(
  keymap: ReturnType<typeof compileKeymap>,
  host: string,
  mode: Mode,
  seq: string,
  context: Context = "page",
) {
  return lookup(keymap.trie(mode, context, keymap.site(host)), seq);
}

describe("[sites] unbind in the keymap", () => {
  let keymap: ReturnType<typeof compileKeymap>;
  beforeAll(() => {
    keymap = keymapOf(
      cfg('[sites."github.com"]', 'unbind = ["t", "ctrl+t", "g"]', '[sites."example.org"]'),
    );
  });

  test("an unbound key is off on the site and its subdomains, on elsewhere", () => {
    expect(on(keymap, "github.com", "normal", "t")).toBeUndefined();
    expect(on(keymap, "gist.github.com", "normal", "t")).toBeUndefined();
    expect(on(keymap, "GitHub.com.", "normal", "t")).toBeUndefined();
    expect(on(keymap, "notgithub.com", "normal", "t")).toBe("new_tab");
    expect(on(keymap, "example.com", "normal", "t")).toBe("new_tab");
  });

  test("every other binding keeps working on the site", () => {
    expect(on(keymap, "github.com", "normal", "j")).toBe("scroll_down");
    expect(on(keymap, "github.com", "normal", "x")).toBe("close_tab");
    expect(on(keymap, "github.com", "normal", "ctrl+b c")).toBe("new_tab");
  });

  test("a key that starts sequences takes all of them", () => {
    expect(on(keymap, "github.com", "normal", "g g")).toBeUndefined();
    expect(on(keymap, "github.com", "normal", "g t")).toBeUndefined();
    expect(on(keymap, "github.com", "normal", "g")).toBeUndefined();
    expect(on(keymap, "example.com", "normal", "g t")).toBe("next_tab");
  });

  test("insert mode loses the unbound chords too", () => {
    expect(on(keymap, "github.com", "insert", "ctrl+t")).toBeUndefined();
    expect(on(keymap, "example.com", "insert", "ctrl+t")).toBe("new_tab");
    expect(on(keymap, "github.com", "insert", "esc")).toBe("normal_mode");
  });

  test("Vimma's own modes and the PDF viewer keep their keys", () => {
    expect(on(keymap, "github.com", "visual", "g g")).toBe("caret_top");
    expect(on(keymap, "github.com", "panel", "ctrl+t")).toBe("new_tab");
    expect(on(keymap, "github.com", "normal", "t", "pdf")).toBe("new_tab");
  });

  test("the most specific table is the whole rule", () => {
    const k = keymapOf(
      cfg(
        '[sites."github.com"]',
        'unbind = ["t"]',
        '[sites."gist.github.com"]',
        'insert = "never"',
        '[sites."docs.github.com"]',
        'unbind = ["x"]',
      ),
    );
    expect(on(k, "gist.github.com", "normal", "t")).toBe("new_tab");
    expect(on(k, "docs.github.com", "normal", "t")).toBe("new_tab");
    expect(on(k, "docs.github.com", "normal", "x")).toBeUndefined();
    expect(on(k, "www.github.com", "normal", "t")).toBeUndefined();
  });

  test("IP literals match only exactly", () => {
    const k = keymapOf(
      cfg('[sites."10.0.0.1"]', 'unbind = ["t"]', '[sites."[::1]"]', 'unbind = ["t"]'),
    );
    expect(on(k, "10.0.0.1", "normal", "t")).toBeUndefined();
    expect(on(k, "110.0.0.1", "normal", "t")).toBe("new_tab");
    expect(on(k, "[::1]", "normal", "t")).toBeUndefined();
    expect(on(k, "::1", "normal", "t")).toBeUndefined();
  });

  test("site() is null without a table that unbinds, and for an unmatched host", () => {
    expect(compileKeymap({}).site("github.com")).toBeNull();
    expect(keymapOf(cfg('[sites."a.com"]', 'insert = "never"')).site("a.com")).toBeNull();
    expect(keymap.site("example.com")).toBeNull();
    expect(keymap.site("")).toBeNull();
    expect(keymap.site("gist.github.com")).toBe("github.com");
  });

  test("the leader and the other notations name one key", () => {
    const k = keymapOf(
      cfg(
        "[modal.normal]",
        '"<leader>n" = "toggle_sidebar"',
        '[sites."a.com"]',
        'unbind = ["<leader>", "<C-t>", "T"]',
      ),
    );
    expect(on(k, "a.com", "normal", "space n")).toBeUndefined();
    expect(on(k, "b.com", "normal", "space n")).toBe("toggle_sidebar");
    expect(on(k, "a.com", "normal", "ctrl+t")).toBeUndefined();
    expect(on(k, "a.com", "normal", "shift+t")).toBeUndefined();
  });

  test("unbinds() names the chords a site gives the page; hasSiteUnbinds() says whether any", () => {
    const site = keymap.site("github.com");
    expect(keymap.unbinds(site, "ctrl+t")).toBe(true);
    expect(keymap.unbinds(site, "t")).toBe(true);
    expect(keymap.unbinds(site, "j")).toBe(false);
    expect(keymap.unbinds(null, "t")).toBe(false);
    expect(keymap.hasSiteUnbinds()).toBe(true);
    expect(compileKeymap({}).hasSiteUnbinds()).toBe(false);
    expect(keymapOf(cfg('[sites."a.com"]', 'insert = "never"')).hasSiteUnbinds()).toBe(false);
  });

  test("the bindings listed for help and :map are the configuration's", () => {
    expect(keymap.keysFor("new_tab")).toContain("t");
  });
});

describe("the dispatcher on a site", () => {
  test("an unbound key passes; a site change drops a pending key", () => {
    const keymap = keymapOf(cfg('[sites."github.com"]', 'unbind = ["t"]'));
    const d = createDispatcher(keymap);
    const site = keymap.site("github.com");
    expect(d.dispatch("normal", parseKey("t"), "page", site).kind).toBe("pass");
    expect(d.dispatch("normal", parseKey("t"), "page", null).kind).toBe("action");
    expect(d.dispatch("normal", parseKey("g"), "page", null).kind).toBe("pending");
    // The g was pressed elsewhere: on the site the t is the page's.
    expect(d.dispatch("normal", parseKey("t"), "page", site).kind).toBe("pass");
    expect(d.pending()).toEqual([]);
  });
});

describe("[sites] unbind is checked", () => {
  test.each([
    ['"esc"', "esc stays Vimma's on every site: it leaves insert mode and a pending key"],
    ['"<Esc>"', "esc stays Vimma's on every site: it leaves insert mode and a pending key"],
    ['"prefix+c"', "the prefix stays Vimma's on every site: it reaches every other command"],
    ['"ctrl+b"', "the prefix stays Vimma's on every site: it reaches every other command"],
    ['"gt"', 'must be one key: on a site, "g" gives the page g and every sequence it starts'],
    ['"ctrl+b c"', "the prefix stays Vimma's on every site: it reaches every other command"],
    [
      '"ctrl+x c"',
      'must be one key: on a site, "ctrl+x" gives the page ctrl+x and every sequence it starts',
    ],
  ])("%s is an error at its line", (entry, message) => {
    expect(errors(cfg('[sites."a.com"]', `unbind = ["t", ${entry}]`))).toEqual([
      { line: 3, path: 'sites."a.com".unbind[1]', message },
    ]);
  });

  test("a remapped prefix is the one kept", () => {
    expect(
      errors(cfg('keys.prefix = "ctrl+a"', '[sites."a.com"]', 'unbind = ["ctrl+a"]'))[0]?.message,
    ).toBe("the prefix stays Vimma's on every site: it reaches every other command");
    expect(
      keymapOf(cfg('keys.prefix = "ctrl+a"', '[sites."a.com"]', 'unbind = ["ctrl+b"]')).site(
        "a.com",
      ),
    ).toBe("a.com");
  });

  test("a key that does not parse, a non-string and a non-list say why", () => {
    expect(errors(cfg('[sites."a.com"]', 'unbind = ["ctrl+"]'))).toMatchObject([
      { line: 3, path: 'sites."a.com".unbind[0]' },
    ]);
    expect(errors(cfg('[sites."a.com"]', "unbind = [1]"))).toEqual([
      { line: 3, path: 'sites."a.com".unbind[0]', message: "expected a string, got an integer" },
    ]);
    expect(errors(cfg('[sites."a.com"]', 'unbind = "t"'))).toEqual([
      { line: 3, path: 'sites."a.com".unbind', message: "expected a list of keys, got a string" },
    ]);
  });

  test("a near miss suggests unbind; a key bound to nothing is accepted", () => {
    expect(errors(cfg('[sites."a.com"]', 'unbnd = ["t"]'))).toEqual([
      {
        line: 3,
        path: 'sites."a.com".unbnd',
        message: 'unknown key "unbnd"',
        suggestion: "unbind",
      },
    ]);
    expect(keymapOf(cfg('[sites."a.com"]', 'unbind = ["z"]')).site("a.com")).toBe("a.com");
  });

  test("a schema-1 file may have [sites]", () => {
    expect(
      parseConfig(["schema = 1", '[sites."a.com"]', 'unbind = ["t"]'].join("\n") + "\n").errors,
    ).toEqual([]);
  });
});

describe("the defaults file shows unbind", () => {
  test.each([
    ["defaults.toml", formatDefaultsToml],
    [":config's template", formatConfigTemplate],
  ])("%s has a commented example", (_name, format) => {
    expect(format()).toMatch(/^# unbind = \["t"\]/m);
  });
});
