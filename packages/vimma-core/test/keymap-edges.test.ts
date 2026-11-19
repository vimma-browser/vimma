// keymap.mjs at the edges its other tests leave open (#1119, mutation testing): the order config
// errors are reported in, [firefox] enable on macOS, the [sites] checks compileKeymap makes of
// its own, the site lookups for a table that unbinds nothing, and withSiteUnbinds' shortcuts.
import { describe, test, expect } from "vitest";
import { compileKeymap, KeymapError, readSiteKey, withSiteUnbinds } from "../src/keys/keymap.mjs";
import { parseKey } from "../src/keys/keys.mjs";

import type { Mode } from "../src/keys/modes.mjs";

type Keymap = ReturnType<typeof compileKeymap>;

const at = (km: Keymap, chord: string, mode: Mode = "normal") =>
  km.trie(mode).children.get(chord)?.action?.name;

function failure(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    if (e instanceof KeymapError) return { path: e.path, detail: e.detail };
    throw e;
  }
  throw new Error("expected a KeymapError");
}

describe("the order config errors are reported in", () => {
  test("the first mistake in [keys] is the one reported, in the file's order", () => {
    // A bad value before an unknown action name: the value's line is the first to fix.
    expect(failure(() => compileKeymap({ keys: { new_tab: 5, new_tabb: "x" } } as never))).toEqual({
      path: "keys.new_tab",
      detail: "expected a key string or a list of key strings",
    });
  });
});

describe("[firefox] enable on macOS", () => {
  const mac = { mac: true };

  test("a default [keys] binding on the chord goes, though macOS Firefox runs no action on it", () => {
    // macOS Firefox opens a tab with cmd+t; Vimma's default ctrl+t goes all the same.
    const km = compileKeymap({ firefox: { enable: ["ctrl+t"] } }, mac);
    expect(at(km, "ctrl+t")).toBeUndefined();
    expect(at(km, "ctrl+t", "insert")).toBeUndefined();
    expect(km.keysFor("new_tab")).not.toContain("ctrl+t");
  });

  test("a normal-mode default stays when it is not macOS Firefox's action for the chord", () => {
    // Linux Firefox's ctrl+o goes back, as Vim's does; macOS Firefox's does not, so on macOS
    // normal mode's ctrl+o is Vimma's own key and stays.
    const km = compileKeymap({ firefox: { enable: ["ctrl+o"] } }, mac);
    expect(at(km, "ctrl+o")).toBe("history_back");
    expect(at(compileKeymap({ firefox: { enable: ["ctrl+o"] } }), "ctrl+o")).toBeUndefined();
  });
});

describe("text-field keys on macOS", () => {
  test("ctrl+h is no text-field key on macOS, so a ctrl+h prefix works in insert mode", () => {
    // On Linux ctrl+h is Vim's backspace in a field; macOS fields have no such key.
    const km = compileKeymap({ keys: { prefix: "ctrl+h" } }, { mac: true });
    for (const mode of ["normal", "insert", "command", "help"] as const) {
      expect(km.trie(mode).children.get("ctrl+h")?.children.get("c")?.action?.name, mode).toBe(
        "new_tab",
      );
    }
  });
});

describe("[sites] unbind checked by compileKeymap itself", () => {
  // config.mjs refuses these first; the keymap checks them too, for a config built in code
  // (withSiteUnbinds).
  test("an unbind that is not a list says so at the table", () => {
    expect(failure(() => compileKeymap({ sites: { "a.com": { unbind: "t" } } } as never))).toEqual({
      path: 'sites."a.com".unbind',
      detail: "expected a list of keys",
    });
  });

  test("an entry that is not a string says so at its index", () => {
    expect(
      failure(() => compileKeymap({ sites: { "a.com": { unbind: ["t", 1] } } } as never)),
    ).toEqual({ path: 'sites."a.com".unbind[1]', detail: "expected a string" });
  });

  test("a site entry without a table unbinds nothing", () => {
    const km = compileKeymap({ sites: { "a.com": undefined } } as never);
    expect(km.siteTables()).toEqual(["a.com"]);
    expect(km.siteKeys("a.com")).toEqual([]);
    expect(km.hasSiteUnbinds()).toBe(false);
  });
});

describe("site lookups", () => {
  const km = compileKeymap({
    sites: {
      "github.com": { unbind: ["t"] },
      "gist.github.com": { unbind: [] },
    },
  });

  test("the most specific table unbinding nothing gives no site, though a parent unbinds", () => {
    expect(km.site("gist.github.com")).toBeNull();
    expect(km.site("www.github.com")).toBe("github.com");
  });

  test("a table that unbinds nothing, or no table at all, leaves the mode's trie", () => {
    expect(km.trie("normal", "page", "gist.github.com")).toBe(km.trie("normal"));
    expect(km.trie("normal", "page", "example.com")).toBe(km.trie("normal"));
  });

  test("a site's trie is built once and reused (site-unbind decision 6)", () => {
    const first = km.trie("normal", "page", "github.com");
    expect(first.children.get("t")).toBeUndefined();
    expect(km.trie("normal", "page", "github.com")).toBe(first);
    expect(km.trie("insert", "page", "github.com")).not.toBe(first);
  });

  test("the context defaults to the page", () => {
    expect(km.trie("normal", undefined, "github.com").children.get("t")).toBeUndefined();
  });

  test("the PDF viewer keeps its own keys on a site", () => {
    // G is the pdf context's own last-page key; an unbound key still runs there.
    const pdf = compileKeymap({ sites: { "a.com": { unbind: ["t", "shift+g"] } } });
    const trie = pdf.trie("normal", "pdf", "a.com");
    expect(trie).toBe(pdf.trie("normal", "pdf"));
    expect(trie.children.get("shift+g")?.action?.name).toBe(
      pdf.trie("normal", "pdf").children.get("shift+g")?.action?.name,
    );
    expect(trie.children.get("t")?.action?.name).toBe("new_tab");
  });

  test("a host with no table unbinds no key, and lists no keys", () => {
    expect(km.unbinds("example.com", "t")).toBe(false);
    expect(km.siteKeys("example.com")).toEqual([]);
  });
});

describe("readSiteKey", () => {
  const keys = { prefix: parseKey("ctrl+b"), leader: parseKey("space") };

  test("the prefix is refused as the prefix, for :siteunbind to name", () => {
    expect(readSiteKey("ctrl+b", keys)).toEqual({
      ok: false,
      why: "prefix",
      message: "stays Vimma's on every site: it reaches every other command",
    });
    expect(compileKeymap().siteKey("prefix+c")).toMatchObject({ ok: false, why: "prefix" });
  });
});

describe("withSiteUnbinds", () => {
  test("no extra keys keeps the keymap as it is", () => {
    const km = compileKeymap();
    expect(withSiteUnbinds(km, new Map())).toBe(km);
  });

  test("a table whose every extra key is refused is not added", () => {
    const km = withSiteUnbinds(compileKeymap(), new Map([["a.com", ["ctrl+b"]]]));
    expect(km.siteTables()).toEqual([]);
  });

  test("a macOS keymap stays macOS's", () => {
    const km = withSiteUnbinds(compileKeymap({}, { mac: true }), new Map([["a.com", ["t"]]]));
    expect(at(km, "meta+left")).toBe("history_back");
    expect(km.source.mac).toBe(true);
    expect(km.siteKeys("a.com")).toEqual(["t"]);
  });
});
