// :siteunbind and :sitebind (docs/specs/site-unbind-command.md): the arguments, the site's
// table, the keys until restart, the messages and the config.toml edit.
import { describe, test, expect } from "vitest";
import { parseConfig } from "../src/config/config.mjs";
import { formatConfigTemplate } from "../src/config/defaults.mjs";
import { parseToml } from "../src/config/toml.mjs";
import { editSiteUnbindText } from "../src/config/site-edit.mjs";
import { compileKeymap, withSiteUnbinds } from "../src/keys/keymap.mjs";
import { completeCommandLine, parseCommandLine } from "../src/keys/cmdline.mjs";
import { formatKey, parseKey } from "../src/keys/keys.mjs";
import { AGENT_KEY_ACTIONS, parseAgentKeys, refusalReason } from "../src/agent/agent-keys.mjs";
import {
  bindMessage,
  createTemporarySiteUnbinds,
  listMessage,
  parseSiteKeysCommand,
  siteOfUrl,
  siteTableFor,
  unbindMessage,
} from "../src/keys/site-keys.mjs";

import type { TrieNode } from "../src/keys/keymap.mjs";

const v2 = (...lines: string[]) => ["schema = 2", ...lines].join("\n") + "\n";

function keymapOf(text: string) {
  const r = parseConfig(text);
  expect(r.errors).toEqual([]);
  if (!r.keymap) throw new Error("no keymap");
  return r.keymap;
}

function lookup(root: TrieNode, seq: string) {
  let node = root;
  for (const k of seq.split(" ")) {
    const next = node.children.get(formatKey(parseKey(k)));
    if (!next) return undefined;
    node = next;
  }
  return node.action?.name;
}

const on = (k: ReturnType<typeof compileKeymap>, host: string, seq: string) =>
  lookup(k.trie("normal", "page", k.site(host)), seq);

describe("the commands", () => {
  test(":siteunbind takes keys, :sitebind needs them", () => {
    expect(parseCommandLine("siteunbind t ctrl+k")).toMatchObject({
      kind: "run",
      action: { id: "site.unbind" },
      text: "t ctrl+k",
    });
    expect(parseCommandLine("siteunbind")).toMatchObject({
      kind: "run",
      action: { id: "site.unbind" },
    });
    expect(parseCommandLine("sitebind --delete t")).toMatchObject({
      kind: "run",
      action: { id: "site.bind" },
      text: "--delete t",
    });
    expect(parseCommandLine("sitebind")).toMatchObject({
      kind: "error",
      error: { code: "missing-argument" },
    });
    // `:site` stays the permissions picker.
    expect(parseCommandLine("site")).toMatchObject({ action: { id: "site.permissions" } });
  });

  test("Tab completes --save, and :sitebind the site's keys and --delete", () => {
    const labels = (line: string, args = {}) =>
      completeCommandLine(line, { args }).candidates.map((c) => c.label);
    expect(labels("siteunbind ")).toEqual(["--save"]);
    expect(labels("sitebind ", { sitebind: ["--delete", "t", "ctrl+k"] })).toEqual([
      "--delete",
      "t",
      "ctrl+k",
    ]);
  });
});

describe("arguments", () => {
  const keymap = compileKeymap({});
  const parse = (cmd: "siteunbind" | "sitebind", text: string) =>
    parseSiteKeysCommand(cmd, text, keymap);

  test("without keys :siteunbind lists", () => {
    expect(parse("siteunbind", "")).toEqual({ kind: "list" });
    expect(parse("siteunbind", "   ")).toEqual({ kind: "list" });
  });

  test("each argument is one key, in canonical form, once", () => {
    expect(parse("siteunbind", "t <C-k> ctrl+k T space , <leader>")).toEqual({
      kind: "keys",
      keys: ["t", "ctrl+k", "shift+t", "space", ",", "space"].filter(
        (k, i, a) => a.indexOf(k) === i,
      ),
      save: false,
      delete: false,
    });
  });

  test("--save and --delete, each on its own command", () => {
    expect(parse("siteunbind", "--save t")).toMatchObject({ keys: ["t"], save: true });
    expect(parse("siteunbind", "t --save")).toMatchObject({ keys: ["t"], save: true });
    expect(parse("sitebind", "--delete t")).toMatchObject({ keys: ["t"], delete: true });
    expect(parse("sitebind", "--save t")).toEqual({
      kind: "refuse",
      text: ":sitebind takes --delete, not --save",
    });
    expect(parse("siteunbind", "--delete t")).toEqual({
      kind: "refuse",
      text: ":siteunbind takes --save, not --delete (:sitebind --delete removes a saved key)",
    });
    expect(parse("siteunbind", "--force t")).toEqual({
      kind: "refuse",
      text: ":siteunbind: unknown option --force (it takes --save)",
    });
    expect(parse("siteunbind", "--save")).toEqual({
      kind: "refuse",
      text: ":siteunbind --save needs keys: :siteunbind --save t",
    });
    // A lone minus is the key, not an option.
    expect(parse("siteunbind", "-")).toMatchObject({ keys: ["minus"] });
  });

  test("an argument that is not one key is refused, naming it, with a hint", () => {
    expect(parse("siteunbind", "t gc")).toEqual({
      kind: "refuse",
      text: ":siteunbind: gc is not one key (did you mean g c?)",
    });
    expect(parse("sitebind", "<C-k>j")).toEqual({
      kind: "refuse",
      text: ":sitebind: <C-k>j is not one key (did you mean ctrl+k j?)",
    });
    // No hint where none is obvious.
    expect(parse("siteunbind", "comma")).toEqual({
      kind: "refuse",
      text: ":siteunbind: comma is not one key",
    });
    expect(parse("siteunbind", "foo+x")).toEqual({
      kind: "refuse",
      text: ':siteunbind: foo+x is not a key: unknown modifier "foo" in "foo+x"',
    });
  });

  test("esc and the prefix are refused, as in config.toml", () => {
    expect(parse("siteunbind", "t esc")).toEqual({
      kind: "refuse",
      text: ":siteunbind: esc stays Vimma's on every site: it leaves insert mode and a pending key",
    });
    expect(parse("siteunbind", "ctrl+b")).toEqual({
      kind: "refuse",
      text: ":siteunbind: ctrl+b stays Vimma's on every site: it reaches every other command",
    });
    const remapped = keymapOf(v2("[keys]", 'prefix = "ctrl+a"'));
    expect(parseSiteKeysCommand("siteunbind", "ctrl+a", remapped)).toMatchObject({
      kind: "refuse",
    });
    expect(parseSiteKeysCommand("siteunbind", "ctrl+b", remapped)).toMatchObject({
      keys: ["ctrl+b"],
    });
  });
});

describe("the site", () => {
  test("only http and https pages have one", () => {
    expect(siteOfUrl("https://github.com/x")).toBe("github.com");
    expect(siteOfUrl("http://WWW.Example.com:8080/")).toBe("www.example.com");
    expect(siteOfUrl("http://[::1]:8000/")).toBe("::1");
    for (const url of [
      "about:blank",
      "file:///tmp/a.html",
      "data:text/html,x",
      "moz-extension://a/b",
    ]) {
      expect(siteOfUrl(url)).toBeNull();
    }
    expect(siteOfUrl("not a url")).toBeNull();
  });

  test("the most specific table that matches, else the host without www.", () => {
    const tables = ["github.com", "docs.github.com"];
    expect(siteTableFor("gist.github.com", tables)).toBe("github.com");
    expect(siteTableFor("docs.github.com", tables)).toBe("docs.github.com");
    expect(siteTableFor("www.reddit.com", tables)).toBe("reddit.com");
    expect(siteTableFor("www.com", tables)).toBe("www.com");
    expect(siteTableFor("example.org.", tables)).toBe("example.org");
    expect(siteTableFor("10.0.0.1", tables)).toBe("10.0.0.1");
  });
});

describe("keys until restart", () => {
  test("a temporary table merges with config.toml's and leaves the base keymap alone", () => {
    const base = keymapOf(v2('[sites."github.com"]', 'unbind = ["g"]', 'insert = "never"'));
    const temp = createTemporarySiteUnbinds();
    expect(temp.add("github.com", ["t", "ctrl+k"])).toEqual(["t", "ctrl+k"]);
    expect(temp.add("github.com", ["t"])).toEqual([]);
    temp.add("example.org", ["x"]);
    const k = withSiteUnbinds(base, temp.entries());
    expect(on(k, "gist.github.com", "t")).toBeUndefined();
    expect(on(k, "github.com", "g t")).toBeUndefined();
    expect(on(k, "example.org", "x")).toBeUndefined();
    expect(on(k, "example.com", "x")).toBe("close_tab");
    expect(on(base, "github.com", "t")).toBe("new_tab");
    expect(base.siteKeys("github.com")).toEqual(["g"]);
    expect(k.siteKeys("github.com")).toEqual(["g", "t", "ctrl+k"]);
    expect(base.siteTables()).toEqual(["github.com"]);
  });

  test("remove ends the temporary keys only, and drops an empty table", () => {
    const temp = createTemporarySiteUnbinds();
    temp.add("github.com", ["t", "g"]);
    expect(temp.remove("github.com", ["t", "x"])).toEqual(["t"]);
    expect(temp.keys("github.com")).toEqual(["g"]);
    temp.remove("github.com", ["g"]);
    expect(temp.tables()).toEqual([]);
    expect(temp.entries().size).toBe(0);
  });
});

describe("messages", () => {
  test("the confirmation lists keys one by one and says how long they last", () => {
    expect(unbindMessage("github.com", ["t", "ctrl+k"], [], "temporary")).toBe(
      "github.com: t · ctrl+k go to the page (until restart)",
    );
    expect(unbindMessage("github.com", ["t"], [], "saved")).toBe(
      "github.com: t goes to the page (saved to config.toml)",
    );
    expect(unbindMessage("github.com", [], ["t"], "temporary")).toBe(
      "github.com: t goes to the page already",
    );
    expect(unbindMessage("github.com", ["x"], ["t"], "saved")).toBe(
      "github.com: x goes to the page (saved to config.toml); t was already",
    );
  });

  test(":sitebind says which keys are Vimma's again and which stay saved", () => {
    expect(bindMessage("github.com", { bound: ["t", "x"], saved: [], idle: [] })).toBe(
      "github.com: t · x are Vimma's again",
    );
    expect(bindMessage("github.com", { bound: [], saved: ["t"], idle: [] })).toBe(
      "t is saved for github.com: :sitebind --delete t",
    );
    expect(bindMessage("github.com", { bound: ["x"], saved: ["t", "g"], idle: ["j"] })).toBe(
      "github.com: x is Vimma's again; t · g are saved for github.com: :sitebind --delete t g; " +
        "j was not unbound here",
    );
    expect(
      bindMessage("github.com", { bound: ["t"], saved: [], idle: [] }, { deleted: true }),
    ).toBe("github.com: t is Vimma's again (removed from config.toml)");
  });

  test("the list marks temporary and saved keys apart", () => {
    expect(listMessage("github.com", { temporary: ["t", "ctrl+k"], saved: ["g"] })).toBe(
      "github.com: t · ctrl+k go to the page until restart; g saved in config.toml",
    );
    expect(listMessage("github.com", { temporary: [], saved: ["g"] })).toBe(
      "github.com: g saved in config.toml",
    );
    expect(listMessage("github.com", { temporary: [], saved: [] })).toBe(
      "github.com: every key is Vimma's (:siteunbind <key> gives one to the page)",
    );
  });
});

describe("the agent cannot run them", () => {
  test("neither action is a vimma_keys action, and the : line is refused", () => {
    expect(AGENT_KEY_ACTIONS.has("site.unbind")).toBe(false);
    expect(AGENT_KEY_ACTIONS.has("site.bind")).toBe(false);
    expect(refusalReason("site.unbind")).toBe(
      "the browser's own tools and settings are the user's",
    );
    expect(refusalReason("site.bind")).toBe(refusalReason("site.unbind"));
    const r = parseAgentKeys(":siteunbind --save t");
    expect(r.ok).toBe(false);
  });
});

describe("config.toml", () => {
  const edit = (
    text: string | null,
    table: string,
    change: { add?: string[]; remove?: string[] },
  ) => editSiteUnbindText(text, table, change);
  const ok = (r: ReturnType<typeof edit>) => {
    if ("error" in r) throw new Error(r.error);
    return r;
  };
  /** A result that has text to write. */
  const written = (r: ReturnType<typeof edit>) => {
    const o = ok(r);
    if (o.text === null) throw new Error("nothing to write");
    return { ...o, text: o.text };
  };
  const unbindOf = (text: string | null, table: string) => {
    if (text === null) throw new Error("no text");
    expect(parseConfig(text).errors).toEqual([]);
    const r = parseToml(text);
    if (!r.ok) throw new Error("not TOML");
    return (r.value as { sites: Record<string, { unbind?: string[] }> }).sites[table]?.unbind;
  };

  test("a missing table is added at the end, the rest byte for byte", () => {
    const text = v2("# my keys", "[keys]", 'new_tab = "t" # here', "");
    const r = ok(edit(text, "github.com", { add: ["t", "ctrl+k"] }));
    expect(r.text).toBe(`${text}[sites."github.com"]\nunbind = ["t", "ctrl+k"]\n`);
    expect(r.added).toEqual(["t", "ctrl+k"]);
  });

  test("an existing table gets an unbind line after its keys, comments kept", () => {
    const text = v2(
      "# sites",
      '[sites."github.com"] # GitHub',
      'insert = "never" # forms',
      "",
      "# after",
      "[keys]",
      'new_tab = "t"',
    );
    const r = ok(edit(text, "github.com", { add: ["t"] }));
    expect(r.text).toBe(
      v2(
        "# sites",
        '[sites."github.com"] # GitHub',
        'insert = "never" # forms',
        'unbind = ["t"]',
        "",
        "# after",
        "[keys]",
        'new_tab = "t"',
      ),
    );
  });

  test("an existing list is appended to, without a key it has in another notation", () => {
    const text = v2('[sites."github.com"]', 'unbind = ["<C-k>", "g"] # mine');
    const r = ok(edit(text, "github.com", { add: ["ctrl+k", "t"] }));
    expect(r.text).toBe(v2('[sites."github.com"]', 'unbind = ["<C-k>", "g", "t"] # mine'));
    expect(r.added).toEqual(["t"]);
    expect(r.already).toEqual(["ctrl+k"]);
  });

  test("a multi-line list keeps its layout and comments", () => {
    const text = v2('[sites."github.com"]', "unbind = [", '  "g", # go to', '  "t",', "]");
    const r = written(edit(text, "github.com", { add: ["x"] }));
    expect(r.text).toBe(
      v2('[sites."github.com"]', "unbind = [", '  "g", # go to', '  "t",', '  "x",', "]"),
    );
    const removed = written(edit(r.text, "github.com", { remove: ["t"] }));
    expect(removed.text).toBe(
      v2('[sites."github.com"]', "unbind = [", '  "g", # go to', '  "x",', "]"),
    );
    expect(unbindOf(removed.text, "github.com")).toEqual(["g", "x"]);
  });

  test("nothing new writes nothing", () => {
    const text = v2('[sites."github.com"]', 'unbind = ["t"]');
    const r = ok(edit(text, "github.com", { add: ["t"] }));
    expect(r.text).toBe(text);
    expect(r.added).toEqual([]);
  });

  test("a removed key goes, every spelling of it, and an emptied line is dropped", () => {
    const text = v2(
      '[sites."github.com"]',
      'insert = "never"',
      'unbind = ["t", "<C-k>", "ctrl+k"]',
    );
    const r = written(edit(text, "github.com", { remove: ["ctrl+k"] }));
    expect(r.text).toBe(v2('[sites."github.com"]', 'insert = "never"', 'unbind = ["t"]'));
    expect(r.removed).toEqual(["ctrl+k"]);
    const empty = ok(edit(r.text, "github.com", { remove: ["t"] }));
    expect(empty.text).toBe(v2('[sites."github.com"]', 'insert = "never"'));
  });

  test("a table left empty goes too, unless it has comments", () => {
    const text = v2("[keys]", 'new_tab = "t"', "", '[sites."github.com"]', 'unbind = ["t"]', "");
    expect(ok(edit(text, "github.com", { remove: ["t"] })).text).toBe(
      v2("[keys]", 'new_tab = "t"', ""),
    );
    const commented = v2('[sites."github.com"]', "# GitHub's own keys", 'unbind = ["t"]');
    expect(ok(edit(commented, "github.com", { remove: ["t"] })).text).toBe(
      v2('[sites."github.com"]', "# GitHub's own keys"),
    );
  });

  test("removing a key the file does not list writes nothing", () => {
    const text = v2('[sites."github.com"]', 'unbind = ["t"]');
    const r = ok(edit(text, "github.com", { remove: ["x"] }));
    expect(r.text).toBe(text);
    expect(r.removed).toEqual([]);
    expect(ok(edit(v2("[keys]"), "github.com", { remove: ["x"] })).removed).toEqual([]);
  });

  test("a missing file is made from the template", () => {
    const r = written(edit(null, "github.com", { add: ["t"] }));
    expect(r.text.startsWith(formatConfigTemplate())).toBe(true);
    expect(unbindOf(r.text, "github.com")).toEqual(["t"]);
    expect(ok(edit(null, "github.com", { remove: ["t"] })).text).toBeNull();
  });

  test("a file with errors is refused, never rewritten", () => {
    expect(edit(v2("[keys]", 'new_tab = "nope+x"'), "github.com", { add: ["t"] })).toEqual({
      error:
        "config.toml has errors; fix them first (:config): line 3: keys.new_tab: " +
        'unknown modifier "nope" in "nope+x"',
    });
    expect(edit("this is = = not toml", "github.com", { add: ["t"] })).toMatchObject({
      error: expect.stringMatching(/^config.toml has errors; fix them first \(:config\): line 1/),
    });
  });

  test('a table not written as its own [sites."<host>"] header is left to the user', () => {
    const dotted = v2("[sites]", '"github.com".insert = "never"');
    expect(edit(dotted, "github.com", { add: ["t"] })).toEqual({
      error:
        'config.toml writes [sites."github.com"] in a form this edit leaves alone; edit it there (:config)',
    });
    const inline = v2('sites = { "a.com" = { insert = "never" } }');
    expect(edit(inline, "github.com", { add: ["t"] })).toMatchObject({
      error: expect.stringContaining("edit it there (:config)"),
    });
  });

  test("a header written with other quoting is found", () => {
    const text = v2("[ sites . 'github.com' ]", "unbind = ['t']");
    const r = written(edit(text, "github.com", { add: ["x"] }));
    expect(unbindOf(r.text, "github.com")).toEqual(["t", "x"]);
    expect(r.text.split("\n")[1]).toBe("[ sites . 'github.com' ]");
  });

  test("CRLF files keep CRLF", () => {
    const text = 'schema = 2\r\n[sites."github.com"]\r\ninsert = "never"\r\n';
    const r = ok(edit(text, "github.com", { add: ["t"] }));
    expect(r.text).toBe(
      'schema = 2\r\n[sites."github.com"]\r\ninsert = "never"\r\nunbind = ["t"]\r\n',
    );
  });

  test("a host that needs escaping is written as a TOML string", () => {
    const r = ok(edit(v2(), "::1", { add: ["t"] }));
    expect(r.text).toContain('[sites."::1"]');
    expect(unbindOf(r.text, "::1")).toEqual(["t"]);
  });
});
