// docs/specs/mcp-drive.md, sub-PRs 2 and 3: `vimma_keys` parses its keys with a dispatcher of its
// own over Vimma's default keymap, and runs only the whitelisted action ids (D9, D10; security.md
// M16), within the limits of D15 (M20); `f` lists links and `f<label>` follows one (D12).
import { describe, expect, test } from "vitest";
import {
  AGENT_KEY_ACTIONS,
  AGENT_KEY_LIMITS,
  AGENT_LINKS,
  CONTROL,
  UNSHOWN,
  agentLinkLines,
  agentLinkList,
  agentTabTitle,
  agentTitle,
  agentUrl,
  markdownWithoutUserinfo,
  labelAgentLinks,
  labelsCurrent,
  parseAgentKeys,
  refusalReason,
  shownKeys,
} from "../src/agent/agent-keys.mjs";
import { FILL_INVISIBLE } from "../src/agent/agent-act.mjs";
import { budget } from "./budget.ts";
import { DEFAULT_HINT_CHARS, hintLabels } from "../src/page/hints.mjs";
import { compileKeymap } from "../src/keys/keymap.mjs";

const ids = (keys: string) => {
  const r = parseAgentKeys(keys);
  if (!r.ok) throw new Error(r.error);
  return r.steps.map((s) => (s.count ? `${s.count}${s.action}` : s.action));
};

const refusal = (keys: string) => {
  const r = parseAgentKeys(keys);
  if (r.ok) throw new Error(`${keys} was accepted: ${JSON.stringify(r.steps)}`);
  return r.error;
};

describe("the whitelist (D9)", () => {
  test("every whitelisted key parses to its action id", () => {
    const table = {
      j: "scroll.down",
      k: "scroll.up",
      "<C-e>": "scroll.down",
      "<C-y>": "scroll.up",
      h: "scroll.left",
      l: "scroll.right",
      d: "scroll.half_down",
      u: "scroll.half_up",
      "<C-d>": "scroll.half_down",
      "<C-u>": "scroll.half_up",
      "ctrl+d": "scroll.half_down",
      gg: "scroll.top",
      G: "scroll.bottom",
      H: "history.back",
      L: "history.forward",
      "<C-o>": "history.back",
      "<C-i>": "history.forward",
      n: "find.next",
      N: "find.previous",
      gu: "page.url_up",
      gU: "page.url_root",
    };
    for (const [keys, id] of Object.entries(table)) expect(ids(keys), keys).toEqual([id]);
    expect(ids("/x<CR>")).toEqual(["find.forward"]);
    expect(ids("?x<CR>")).toEqual(["find.backward"]);
    expect(ids("f")).toEqual(["hint.follow"]);
    expect(ids("fsd")).toEqual(["hint.follow"]);
  });

  test("the whitelist is the spec's table", () => {
    expect([...AGENT_KEY_ACTIONS].sort()).toEqual(
      [
        "scroll.down",
        "scroll.up",
        "scroll.left",
        "scroll.right",
        "scroll.half_down",
        "scroll.half_up",
        "scroll.top",
        "scroll.bottom",
        "history.back",
        "history.forward",
        "find.forward",
        "find.backward",
        "find.next",
        "find.previous",
        "page.url_up",
        "page.url_root",
        "hint.follow",
      ].sort(),
    );
  });

  test("the split actions are not agent key actions (docs/specs/multiple-splits.md)", () => {
    for (const id of ["pane.split_picker", "pane.next_split", "pane.previous_split"]) {
      expect(AGENT_KEY_ACTIONS.has(id)).toBe(false);
    }
    expect(refusal("ctrl+b S")).toContain("the prefix");
    expect(refusal("]s")).toBe(
      'key "]s" (pane.next_split) is refused: the tabs, workspaces, windows and layout are the user\'s',
    );
    expect(refusal("[s")).toContain("(pane.previous_split) is refused");
  });

  test("downloads.picker is not an agent key action (docs/specs/downloads.md decision 16)", () => {
    expect(AGENT_KEY_ACTIONS.has("downloads.picker")).toBe(false);
    expect(refusal("ctrl+b d")).toContain("the prefix");
  });

  test("counts, sequences and whitespace between keys", () => {
    expect(ids("3j")).toEqual(["3scroll.down"]);
    expect(ids("3j gg  G")).toEqual(["3scroll.down", "scroll.top", "scroll.bottom"]);
    expect(ids("jjk")).toEqual(["scroll.down", "scroll.down", "scroll.up"]);
    expect(ids(" 2H\t L ")).toEqual(["2history.back", "history.forward"]);
  });

  test("each refused group is invalid-args naming the key (M16)", () => {
    const refused = [
      "ctrl+b",
      "ctrl+b x",
      "prefix+x",
      ":",
      "t",
      "x",
      "gt",
      "i",
      "I",
      "gi",
      "v",
      "yy",
      "p",
      "P",
      "F",
      "gF",
      "gf",
      "r",
      "<Esc>",
      "]w",
      "<C-^>",
      "<C-w>h",
      "b",
      "ctrl+shift+i",
    ];
    for (const keys of refused) {
      const why = refusal(keys);
      expect(why, keys).toMatch(/^key "/);
      expect(why, keys).toContain("refused");
    }
    expect(refusal("t")).toBe(
      'key "t" (tab.new) is refused: the tabs, workspaces, windows and layout are the user\'s',
    );
    expect(refusal("i")).toContain("vimma_keys never types into a page");
    expect(refusal("yy")).toContain("the clipboard is the user's");
    expect(refusal(":")).toContain("the command line is the user's");
    expect(refusal("ctrl+b x")).toContain("the prefix");
    expect(refusal("ctrl+b i")).toContain("the prefix");
    expect(refusal("gF")).toContain("vimma_open");
    expect(refusal("F")).toContain("hint.element");
    expect(refusal("r")).toContain("form");
    expect(refusal("z")).toBe('key "z" is refused: it is not one of the keys vimma_keys runs');
  });

  test("the first refused key is named, and nothing before it counts", () => {
    expect(refusal("3j gg t x")).toContain('key "t"');
  });

  test("an incomplete sequence is refused", () => {
    expect(refusal("g")).toBe('key "g" is refused: the key sequence is incomplete');
    expect(refusal("3")).toContain("incomplete");
  });

  test("a user keymap that binds j to tab.close does not change the agent's j (D10)", () => {
    // The user's keymap compiles; the agent's parse never sees it.
    const user = compileKeymap({ modal: { normal: { j: "tab.close" } } });
    expect(user).toBeTruthy();
    expect(ids("j")).toEqual(["scroll.down"]);
  });
});

describe("links (D12)", () => {
  const steps = (keys: string) => {
    const r = parseAgentKeys(keys);
    if (!r.ok) throw new Error(r.error);
    return r.steps;
  };

  test("f at the end lists the links; f<label> follows one", () => {
    expect(steps("3j f")).toEqual([
      { keys: "3j", action: "scroll.down", count: 3 },
      { keys: "f", action: "hint.follow" },
    ]);
    expect(steps("fsd")).toEqual([{ keys: "fsd", action: "hint.follow", label: "sd" }]);
    expect(steps("fa")).toEqual([{ keys: "fa", action: "hint.follow", label: "a" }]);
  });

  test("fsd after f is a follow of sd, and keys after a label are keys again", () => {
    // Labels are prefix-free, so a label ends at the first key that is not a hint character
    // or at a space: `fsdG` is a follow of sd then G, `fsd j` a follow of sd then j.
    expect(steps("fsdG")).toEqual([
      { keys: "fsd", action: "hint.follow", label: "sd" },
      { keys: "G", action: "scroll.bottom" },
    ]);
    expect(steps("fsd j f")).toEqual([
      { keys: "fsd", action: "hint.follow", label: "sd" },
      { keys: "j", action: "scroll.down" },
      { keys: "f", action: "hint.follow" },
    ]);
  });

  // docs/specs/follow-link-switch.md decision 7: an agent's opens never switch.
  test("hint.follow_new_tab_fg is refused with hint.follow_new_tab's reason", () => {
    expect(refusalReason("hint.follow_new_tab")).toBe(
      "it opens a tab; vimma_open does that, asked",
    );
    expect(refusalReason("hint.follow_new_tab_fg")).toBe(refusalReason("hint.follow_new_tab"));
  });

  // Issue #1212: the action is looked up by its id, not its config name.
  test.each([
    ["Browser", "app.quit"],
    ["Browser", "page.stop"],
    ["Developer tools", "devtools.toggle"],
    ["Bookmarks", "bookmark.add"],
    ["Config", "config.reload"],
    ["Add-ons", "addons.picker"],
    ["Help", "help.show"],
    ["Agents", "mcp.answer"],
  ])("an action of the %s group is refused as the user's own (M16)", (_group, id) => {
    expect(refusalReason(id)).toBe("the browser's own tools and settings are the user's");
  });

  test("esc (page.stop) is refused as the user's own", () => {
    expect(refusal("esc")).toBe(
      `key "<esc>" (page.stop) is refused: the browser's own tools and settings are the user's`,
    );
  });

  test("an action of no user group, or no action, gets the generic reason", () => {
    expect(refusalReason("site.permissions")).toBe("it is not one of the keys vimma_keys runs");
    expect(refusalReason("no.such_action")).toBe("it is not one of the keys vimma_keys runs");
  });

  test("an upper-case character after f is not part of the label", () => {
    expect(steps("fsG")).toEqual([
      { keys: "fs", action: "hint.follow", label: "s" },
      { keys: "G", action: "scroll.bottom" },
    ]);
    expect(refusal("fsD")).toContain('key "D"');
  });

  test("f without a label anywhere but at the end is refused", () => {
    expect(refusal("f j")).toContain("f without a label lists the links and must be the last");
    expect(refusal("f fsd")).toContain("must be the last");
  });

  test("a label is lowercase hint characters, at most the longest label of 200 links", () => {
    const longest = Math.max(
      ...hintLabels(AGENT_LINKS.max, DEFAULT_HINT_CHARS).map((l) => l.length),
    );
    expect(AGENT_LINKS.label).toBe(longest);
    expect(steps(`f${"a".repeat(longest)}`)[0]?.label).toBe("a".repeat(longest));
    expect(refusal(`f${"a".repeat(longest + 1)}`)).toContain(`at most ${longest} characters`);
  });

  test("a count before f is refused", () => {
    expect(refusal("3f")).toContain("a count does not apply to f");
    expect(refusal("2fsd")).toContain("a count does not apply to f");
  });

  test("gF (a new tab), F (element focus) and the caret's f stay refused", () => {
    expect(refusal("gF")).toContain("vimma_open");
    expect(refusal("gFsd")).toContain("vimma_open");
    expect(refusal("F")).toContain("refused");
  });
});

describe("link lists (D12, D16; security.md M21)", () => {
  const at = (
    x: number,
    y: number,
    href: string = `https://a.example/${x}-${y}`,
    text: string = `${x},${y}`,
  ) => ({
    rect: { x, y, width: 10, height: 10 },
    href,
    text,
  });

  test("the spec's caps", () => {
    expect(AGENT_LINKS).toEqual({ max: 200, text: 80, href: 2048, ttlMs: 120_000, label: 3 });
  });

  test("labels in reading order over the default hint characters, never the user's", () => {
    const { links, dropped } = labelAgentLinks([at(50, 0), at(0, 100), at(0, 0)]);
    expect(dropped).toBe(0);
    expect(links.map((l) => [l.label, l.target.text])).toEqual([
      ["a", "0,0"],
      ["s", "50,0"],
      ["d", "0,100"],
    ]);
  });

  test("at most 200 links; the rest are dropped and counted", () => {
    const many = Array.from({ length: 250 }, (_, i) => at(0, i * 20));
    const { links, dropped } = labelAgentLinks(many);
    expect(links).toHaveLength(200);
    expect(dropped).toBe(50);
    expect(new Set(links.map((l) => l.label)).size).toBe(200);
    // Prefix-free: no label starts another.
    const labels = links.map((l) => l.label);
    for (const a of labels)
      for (const b of labels) if (a !== b) expect(b.startsWith(a)).toBe(false);
  });

  test("one line per link: the label, the text as JSON cut at 80, the href cut at 2,048", () => {
    const long = `https://a.example/${"x".repeat(3000)}`;
    const { links } = labelAgentLinks([
      at(0, 0, "https://a.example/p", 'Pricing "plans"\n'),
      at(0, 20, long, "y".repeat(100)),
      { rect: { x: 0, y: 40, width: 10, height: 10 }, text: "z" },
    ]);
    const lines = agentLinkLines(links).split("\n");
    expect(lines[0]).toBe('a "Pricing \\"plans\\"" https://a.example/p');
    expect(lines[1]).toBe(`s ${JSON.stringify(`${"y".repeat(79)}…`)} ${long.slice(0, 2047)}…`);
    expect(lines[2]).toBe('d "z" (no URL)');
    expect(lines).toHaveLength(3);
  });

  test("text is one line: whitespace collapsed, bidi and control characters dropped", () => {
    const { links } = labelAgentLinks([at(0, 0, "https://a.example/", "  a\n\tb\u202ec\u0000 ")]);
    expect(agentLinkLines(links)).toBe('a "a bc" https://a.example/');
    // Review: NFKC before quoting, so a fullwidth quote cannot end the JSON string; tag
    // characters, variation selectors and other invisible ones are dropped.
    const spoof = labelAgentLinks([
      at(0, 0, "https://evil.example/x", "Docs\uff02 https://d/ \uff02"),
    ]);
    expect(agentLinkLines(spoof.links)).toBe('a "Docs\\" https://d/ \\"" https://evil.example/x');
    const tags = labelAgentLinks([
      at(0, 0, "https://a/", "a\u{E0041}\u{E007F}b\ufe0fc\u180ed\u034fe\u3164f"),
    ]);
    expect(agentLinkLines(tags.links)).toBe('a "abcdef" https://a/');
    const bidi = labelAgentLinks([at(0, 0, "javascript:x\u202e//", "t")]).links;
    expect(agentLinkLines(bidi)).toBe('a "t" javascript:x//');
  });

  test("every character a fill refuses as invisible is dropped from link text and hrefs (M21)", () => {
    // The ends of each FILL_INVISIBLE range (U+206A to U+206F among them, #1205); the line and
    // paragraph separators are white space, which a link's text collapses and its href drops.
    for (const [lo, hi] of FILL_INVISIBLE) {
      for (const cp of [lo, hi]) {
        const c = String.fromCodePoint(cp);
        const space = cp === 0x2028 || cp === 0x2029;
        const { links } = labelAgentLinks([at(0, 0, `https://a/x${c}y`, `a${c}b`)]);
        const hex = cp.toString(16);
        expect(agentLinkLines(links), hex).toBe(`a "${space ? "a b" : "ab"}" https://a/xy`);
      }
    }
  });
});

describe("the link list's size (review: the reply must fit the protocol's line)", () => {
  test("links past the byte budget are left out and counted", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      rect: { x: 0, y: i * 20, width: 10, height: 10 },
      href: `https://a.example/${"x".repeat(100)}${i}`,
      text: "t",
    }));
    const { links } = labelAgentLinks(many);
    const all = agentLinkList(links, 1 << 20);
    expect(all.omitted).toBe(0);
    expect(all.text).toBe(agentLinkLines(links));
    const some = agentLinkList(links, 400);
    expect(some.omitted).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(some.text)).length).toBeLessThanOrEqual(400);
    expect(some.text.split("\n")).toHaveLength(10 - some.omitted);
  });
});

describe("find (D11)", () => {
  test("/foo bar<CR>n is one find and one find.next", () => {
    const r = parseAgentKeys("/foo bar<CR>n");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.steps).toEqual([
      { keys: '/"foo bar"⏎', action: "find.forward", query: "foo bar" },
      { keys: "n", action: "find.next" },
    ]);
  });

  test("the query is text, not keys, and <CR> ends it in any case", () => {
    const r = parseAgentKeys("?ctrl+b :x<cr>3N");
    expect(r.ok && r.steps).toEqual([
      { keys: '?"ctrl+b :x"⏎', action: "find.backward", query: "ctrl+b :x" },
      { keys: "3N", action: "find.previous", count: 3 },
    ]);
  });

  test("/ without <CR>, and an empty query, are refused", () => {
    expect(refusal("/foo")).toContain("<CR>");
    expect(refusal("/<CR>")).toContain("empty");
  });
});

describe("the limits (D15, M20)", () => {
  test("they are the spec's", () => {
    expect(AGENT_KEY_LIMITS).toEqual({ chars: 512, actions: 32, count: 99, query: 256 });
  });

  test("a count of 100, 33 actions, 513 characters and a 257-character query are refused", () => {
    expect(ids("99j")).toEqual(["99scroll.down"]);
    expect(refusal("100j")).toContain("99");
    expect(ids("j".repeat(32))).toHaveLength(32);
    expect(refusal("j".repeat(33))).toContain("32 actions");
    expect(refusal(" ".repeat(512) + "j")).toContain("512 characters");
    expect(ids(`/${"a".repeat(256)}<CR>`)).toEqual(["find.forward"]);
    expect(refusal(`/${"a".repeat(257)}<CR>`)).toContain("256 characters");
  });

  test("control characters and empty keys are refused", () => {
    expect(refusal("j\u0007")).toContain("control characters");
    expect(refusal("/a\nb<CR>")).toContain("control characters");
    expect(refusal("   ")).toContain("no keys");
    // A bidi control would make the question show the keys in another order (security.md M4).
    // So would an invisible character: the query shown would not be the one that runs.
    for (const c of [
      "\u202e",
      "\u2066",
      "\u200f",
      "\u061c",
      "\u2028",
      "\u200b",
      "\ufeff",
      "\u00ad",
    ]) {
      expect(refusal(`/a${c}b<CR>`)).toContain("control characters");
    }
  });

  test("every character a fill refuses as invisible is refused in keys (M16)", () => {
    // The ends of each FILL_INVISIBLE range: U+206A to U+206F among them (#1205), which drew
    // nothing, so "/foo\u206abar<CR>" was asked as a find of "foobar".
    for (const [lo, hi] of FILL_INVISIBLE) {
      for (const cp of [lo, hi]) {
        const c = String.fromCodePoint(cp);
        expect(refusal(`/foo${c}bar<CR>`), cp.toString(16)).toContain("control characters");
        expect(refusal(`j${c}`), cp.toString(16)).toContain("control characters");
      }
    }
  });
});

describe("the refused and dropped characters (M16, M21; review of #1205)", () => {
  type Ranges = readonly (readonly [number, number])[];
  /** One byte a code point: 1 where `ranges` hold it. */
  const table = (ranges: Ranges) => {
    const t = new Uint8Array(0x110000);
    for (const [lo, hi] of ranges) t.fill(1, lo, hi + 1);
    return t;
  };
  /** The code points where `actual` and `expected` disagree, every code point checked. */
  const differences = (actual: Ranges, expected: (cp: number) => boolean) => {
    const t = table(actual);
    const out: string[] = [];
    for (let cp = 0; cp < t.length; cp++) {
      if (t[cp] !== (expected(cp) ? 1 : 0)) out.push(cp.toString(16));
    }
    return out;
  };
  const fill = table(FILL_INVISIBLE);
  const invisible = (cp: number) => fill[cp] === 1;

  test("keys refuse C0 but the tab, C1 and FILL_INVISIBLE, and nothing else", () => {
    const expected = (cp: number) =>
      (cp <= 0x1f && cp !== 0x09) || (cp >= 0x7f && cp <= 0x9f) || invisible(cp);
    expect(differences(CONTROL, expected)).toEqual([]);
  });

  test("links drop C0 but white space, C1 and FILL_INVISIBLE but the separators, and no more", () => {
    // The tab, line feed, vertical tab, form feed, carriage return and U+2028, U+2029 are white
    // space: a link's text collapses them and its href drops them.
    const expected = (cp: number) =>
      (cp <= 0x1f && (cp < 0x09 || cp > 0x0d)) ||
      (cp >= 0x7f && cp <= 0x9f) ||
      (invisible(cp) && cp !== 0x2028 && cp !== 0x2029);
    expect(differences(UNSHOWN, expected)).toEqual([]);
  });
});

describe("the keys as the question shows them (D14)", () => {
  test("after parsing, with ⏎ for <CR> and find queries in quotes", () => {
    const r = parseAgentKeys('3j /pri"cing<CR> <C-d> gg');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(shownKeys(r.steps)).toBe('3j /"pri\\"cing"⏎ <C-d> gg');
  });
});

describe("how long labels last (D12; mcp-forms F3; issue #591)", () => {
  const mark = { doc: 7, url: "https://example.com/a" };
  const at = 1_000_000;
  const later = (ms: number) => ({ now: at + ms, mark });

  test("f's links last AGENT_LINKS.ttlMs on their page", () => {
    const links = { mark, at, source: "links" as const };
    expect(labelsCurrent(links, later(AGENT_LINKS.ttlMs - 1))).toBe(true);
    expect(labelsCurrent(links, later(AGENT_LINKS.ttlMs))).toBe(false);
  });

  test("an element list's labels last as long as their page, however slow the agent", () => {
    const elements = { mark, at, source: "elements" as const };
    expect(labelsCurrent(elements, later(AGENT_LINKS.ttlMs * 100))).toBe(true);
  });

  test("another document or URL ends either list, and no list is never current", () => {
    for (const source of ["links", "elements"] as const) {
      const session = { mark, at, source };
      expect(labelsCurrent(session, { now: at, mark: { ...mark, doc: 8 } })).toBe(false);
      expect(labelsCurrent(session, { now: at, mark: { ...mark, url: `${mark.url}#b` } })).toBe(
        false,
      );
    }
    expect(labelsCurrent(null, later(0))).toBe(false);
    expect(labelsCurrent(undefined, later(0))).toBe(false);
  });

  test("a shorter link lifetime can be given (tests)", () => {
    expect(labelsCurrent({ mark, at, source: "links" }, later(0), 0)).toBe(false);
    expect(labelsCurrent({ mark, at, source: "elements" }, later(0), 0)).toBe(true);
  });
});

// Issue #1119: what the weekly mutation run left unpinned.
describe("vimma_keys edges", () => {
  test("an exact name in a refusal group is not a prefix: page.open_clipboard is the clipboard's", () => {
    expect(refusalReason("page.open_clipboard")).toBe("the clipboard is the user's");
    expect(refusalReason("no.such_action")).toBe("it is not one of the keys vimma_keys runs");
  });

  test("a refused key is named as Vim writes it, every modifier included", () => {
    expect(refusal("meta+j")).toBe(
      'key "<M-j>" is refused: it is not one of the keys vimma_keys runs',
    );
    expect(refusal("ctrl+alt+x")).toBe(
      'key "<C-A-x>" is refused: it is not one of the keys vimma_keys runs',
    );
  });

  test("a word of two characters or more that names one key is that key", () => {
    expect(refusal("f1")).toBe('key "<f1>" is refused: it is not one of the keys vimma_keys runs');
    // Only the key's name: page.stop's reason is #1212's.
    expect(refusal("esc")).toMatch(/^key "<esc>" \(page\.stop\) is refused: /);
  });

  test("a word with other characters after a key's name is a run of keys", () => {
    expect(refusal("ctrl+j!")).toBe(
      'key "c" is refused: it is not one of the keys vimma_keys runs',
    );
  });

  test("the prefix and the leader are named as such", () => {
    const why = "the prefix, the leader and their bindings are the user's";
    expect(refusal("prefix+x")).toBe(`key "prefix" is refused: ${why}`);
    expect(refusal("<leader>x")).toBe(`key "<leader>" is refused: ${why}`);
  });

  test("keys of exactly the character limit are taken", () => {
    const keys = `j${" ".repeat(AGENT_KEY_LIMITS.chars - 1)}`;
    expect(ids(keys)).toEqual(["scroll.down"]);
  });

  test("a < with no > after it in its word is the < key", () => {
    const why = "it is not one of the keys vimma_keys runs";
    expect(refusal("<")).toBe(`key "<" is refused: ${why}`);
    expect(refusal("j<")).toBe(`key "<" is refused: ${why}`);
    expect(refusal("<x >")).toBe(`key "<" is refused: ${why}`);
  });

  test("a label that is too long is named with its f", () => {
    expect(refusal("fsdfsdfsdx")).toBe(
      `key "fsdfsdfsd" is refused: a label is at most ${AGENT_LINKS.label} characters`,
    );
  });

  test("a tab in a find query is refused", () => {
    expect(refusal("/a\tb<CR>")).toBe(
      'key "/" is refused: a find query must not contain control characters',
    );
  });

  test("keys after a find's <CR> are keys again, up to the next space and after it", () => {
    expect(ids("/foo<CR>n j")).toEqual(["find.forward", "find.next", "scroll.down"]);
    expect(ids("/foo<CR>n")).toEqual(["find.forward", "find.next"]);
  });
});

describe("vimma_keys edges: tokens", () => {
  test("a word that looks like one key but is none is refused as no key", () => {
    expect(refusal("ctrl+")).toBe('key "ctrl+" is refused: it is not a key');
  });

  test("a <...> that names no key is refused as no key, after another token too", () => {
    expect(refusal("<zzz>")).toBe('key "<zzz>" is refused: it is not a key');
    expect(refusal("<C-d><zzz>")).toBe('key "<zzz>" is refused: it is not a key');
  });

  test("after a token, a < whose > is missing or past a space is the < key", () => {
    const why = 'key "<" is refused: it is not one of the keys vimma_keys runs';
    expect(refusal("<C-d><")).toBe(why);
    expect(refusal("<C-d><x >")).toBe(why);
  });
});

describe("link list edges", () => {
  const rect = { x: 0, y: 0, width: 10, height: 10 };
  test("a text of exactly AGENT_LINKS.text characters is not cut", () => {
    const text = "t".repeat(AGENT_LINKS.text);
    expect(agentLinkLines([{ label: "a", target: { rect, href: "https://a/", text } }])).toBe(
      `a "${text}" https://a/`,
    );
  });

  test("a link with no text is an empty string; spaces in an href are dropped", () => {
    expect(agentLinkLines([{ label: "a", target: { rect, href: "https://a/ b\tc" } }])).toBe(
      'a "" https://a/bc',
    );
  });

  test("the byte budget counts each line and the line break between two exactly", () => {
    const links = [
      { label: "a", target: { rect, href: "https://a/", text: "x" } },
      { label: "s", target: { rect, href: "https://b/", text: "y" } },
    ];
    const one = agentLinkLines(links.slice(0, 1));
    const both = agentLinkLines(links);
    const size = (s: string) => new TextEncoder().encode(JSON.stringify(s)).length;
    expect(agentLinkList(links, size(one))).toEqual({ text: one, omitted: 1 });
    expect(agentLinkList(links, size(one) - 1)).toEqual({ text: "", omitted: 2 });
    expect(agentLinkList(links, size(both))).toEqual({ text: both, omitted: 0 });
    expect(agentLinkList(links, size(both) - 1)).toEqual({ text: one, omitted: 1 });
  });
});

describe("URLs without user names and passwords (security.md M21, #1209)", () => {
  const at = (href: string) => ({ rect: { x: 0, y: 0, width: 10, height: 10 }, href, text: "t" });
  const lineOf = (href: string) => agentLinkLines(labelAgentLinks([at(href)]).links);

  test("a link's href loses its user name and password", () => {
    expect(lineOf("https://ada:secret@example.com/p")).toBe('a "t" https://example.com/p');
    expect(lineOf("https://ada@x:secret@example.com/p")).toBe('a "t" https://example.com/p');
    expect(lineOf("http:\\\\ada:secret@example.com\\p")).toBe('a "t" http:\\\\example.com\\p');
    expect(lineOf("https://ada:secret＠example.com/p")).toBe('a "t" https://example.com/p');
    expect(lineOf("view-source:https://ada:secret@example.com/")).toBe(
      'a "t" view-source:https://example.com/',
    );
  });

  test("a user name and password longer than the cut are dropped before it", () => {
    const long = `https://ada:${"s".repeat(3 * AGENT_LINKS.href)}@example.com/p`;
    expect(lineOf(long)).toBe('a "t" https://example.com/p');
    const huge = `https://ada:${"s".repeat(5 * AGENT_LINKS.href)}@example.com/p`;
    expect(lineOf(huge)).toBe('a "t" https://…');
  });

  test("a read page's markdown links lose their user names and passwords", () => {
    const md = [
      "Intro [Plans](https://ada:secret@example.com/plans) and",
      "[Docs](http://ada@x:secret@docs.example/a?b=c@d) [Here](/rel)",
      "![logo](https://ada:secret@example.com/l.png) a:b@c.example stays as text",
    ].join("\n");
    expect(markdownWithoutUserinfo(md)).toBe(
      [
        "Intro [Plans](https://example.com/plans) and",
        "[Docs](http://docs.example/a?b=c@d) [Here](/rel)",
        "![logo](https://example.com/l.png) a:b@c.example stays as text",
      ].join("\n"),
    );
    // Text that is no link target keeps its white space.
    expect(markdownWithoutUserinfo("a](https://a:b@c/\nd) e](f\tg)")).toBe(
      "a](https://a:b@c/\nd) e](f\tg)",
    );
    // Work is bounded however long the text.
    const many = "[x](https://a:b@e.example/) ".repeat(100_000);
    expect(markdownWithoutUserinfo(many)).not.toContain("a:b@");
  });

  // Firefox's DOMExtractor.sys.mjs escapeMarkdownLink, as it is: a block anchor that wraps
  // inline anchors (the Google search strategy) runs it over text already holding `[a](href)`.
  const escapeMarkdownLink = (text: string, url: string): string =>
    `[${text.replace(/[[\]()]/g, "\\$&")}](${url.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;

  test("a link nested in another link's text loses its user name and password (#1217)", () => {
    const inner = escapeMarkdownLink("a", "https://ada:secret@www.google.com/x");
    const once = escapeMarkdownLink(`${inner} b`, "https://ada:secret@www.google.com/y");
    expect(once).toBe(
      "[\\[a\\]\\(https://ada:secret@www.google.com/x\\) b](https://ada:secret@www.google.com/y)",
    );
    expect(markdownWithoutUserinfo(once)).toBe(
      "[\\[a\\]\\(https://www.google.com/x\\) b](https://www.google.com/y)",
    );
    // Nested twice, the escapes pile up; IPv6 brackets in the href are escaped too.
    const twice = escapeMarkdownLink(
      escapeMarkdownLink(escapeMarkdownLink("c", "http://u:p@[::1]/z(1)"), "/r"),
      "/s",
    );
    const out = markdownWithoutUserinfo(twice);
    expect(out).not.toContain("u:p@");
    expect(out).toBe(twice.replace("u:p@", ""));
    expect(markdownWithoutUserinfo("\\[i\\]\\(foo://ada:secret@h\\x\\)")).toBe(
      "\\[i\\]\\(foo://h\\x\\)",
    );
  });

  test("a read page's link targets are found in linear time (CodeQL js/polynomial-redos)", () => {
    const start = performance.now();
    const open = `](${"\\".repeat(200_000)}`;
    expect(markdownWithoutUserinfo(open)).toBe(open);
    const runs = `]\\(${"\\".repeat(200_000)}x`.repeat(2);
    expect(markdownWithoutUserinfo(runs)).toBe(runs);
    expect(performance.now() - start).toBeLessThan(budget(1000));
    // Backslashes before the closing parenthesis stay as they were.
    expect(markdownWithoutUserinfo("]\\(https://a:b@h/x\\\\\\)")).toBe("]\\(https://h/x\\\\\\)");
  });

  test("text that is no link target is left byte for byte, URLs and emails too", () => {
    const text = [
      "Mail bob@example.com or ada:secret@example.com, see https://ada:secret@example.com/ here.",
      "`git clone ssh://git@github.com/a/b` and `\\](https://a:b@c/ x)` stay; so does mailto:bob@example.com.",
      "\\[not a link\\] \\(https://ada:secret@example.com/ x\\) and \\](a b@c\\) and ](\\u00e9)",
      "Caf\u00e9 \u2014 \u{1f600} \\\\ \\] \\( \\) [] () ](",
    ].join("\n");
    expect(markdownWithoutUserinfo(text)).toBe(text);
  });

  test("agentUrl takes the cut it is given", () => {
    expect(agentUrl("https://ada:secret@example.com/abcdef", 22)).toBe("https://example.com/a…");
  });
});

describe("tab titles without user names and passwords (security.md M21, #1209)", () => {
  // Firefox's #setTabLabel for a label made of a URL: no scheme or www., at most 256 characters.
  const firefoxLabel = (url: string) => url.replace(/^[^:]+:\/\/(?:www\.)?/, "").slice(0, 256);

  test("a label Firefox made of a URL is the tab's URL without them, as Firefox shows it", () => {
    const url = "https://ada:secret@www.example.com/a?b";
    expect(agentTabTitle(firefoxLabel(url), false, url)).toBe("example.com/a?b");
    // Clamped at 256 characters, a long password leaves no at sign in the label.
    const jwt = `eyJ${"x".repeat(400)}`;
    const long = `https://ci:${jwt}@registry.example.com/v2/`;
    expect(firefoxLabel(long)).not.toContain("@");
    expect(agentTabTitle(firefoxLabel(long), false, long)).toBe("registry.example.com/v2/");
    // An untitled page keeps the label of the URL it was opened at after a redirect.
    const opened = "https://ada:secret@example.com/file.txt";
    const now = "https://cdn.example.net/file.txt";
    expect(agentTabTitle(firefoxLabel(opened), false, now)).toBe("cdn.example.net/file.txt");
    // A new tab still at about:blank: the URL it is loading, which Firefox keeps as typed.
    expect(agentTabTitle(firefoxLabel(opened), false, "about:blank", opened)).toBe(
      "example.com/file.txt",
    );
    expect(agentTabTitle("New Tab", false, "about:blank", null)).toBe("about:blank");
    expect(agentTabTitle(firefoxLabel(opened), false, now, "https://elsewhere.example/")).toBe(
      "cdn.example.net/file.txt",
    );
    // A label of unknown kind is taken for one made of a URL.
    expect(agentTabTitle(firefoxLabel(opened), undefined, now)).toBe("cdn.example.net/file.txt");
  });

  test("a page's own title is its own, but a URL in it loses them", () => {
    const url = "https://ada:secret@example.com/a";
    expect(agentTabTitle("Plans and pricing", true, url)).toBe("Plans and pricing");
    expect(agentTabTitle("https://ada:secret@example.com/", true, url)).toBe(
      "https://example.com/",
    );
    // No guess at a title without a scheme: it is the page's text.
    expect(agentTabTitle("bob@example.com", true, url)).toBe("bob@example.com");
  });

  test("a title that is a URL loses its user name and password", () => {
    expect(agentTitle("https://ada:secret@example.com/")).toBe("https://example.com/");
    expect(agentTitle("  http://ada@x:secret@example.com/a?b")).toBe("http://example.com/a?b");
    expect(agentTitle("https://ada:secret\uff20example.com/")).toBe("https://example.com/");
    expect(agentTitle("view-source:https://ada:secret@example.com/")).toBe(
      "view-source:https://example.com/",
    );
    const long = `https://ada:${"s".repeat(5000)}@example.com/`;
    expect(agentTitle(long)).toBe("https://example.com/");
  });

  test("any other title is left as the page wrote it", () => {
    for (const title of [
      "Plans and pricing",
      "Note: read me",
      "Mail ada:secret@example.com now",
      "https://ada:secret@example.com/ is my address",
      "",
      "\u202eflipped",
      "ada:secret@example.com/a",
      "mailto:ada@example.com",
    ]) {
      expect(agentTitle(title)).toBe(title);
    }
  });
});
