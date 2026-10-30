// docs/specs/mcp-drive.md, sub-PRs 2 and 3: `vimma_keys` parses its keys with a dispatcher of its
// own over Vimma's default keymap, and runs only the whitelisted action ids (D9, D10; security.md
// M16), within the limits of D15 (M20); `f` lists links and `f<label>` follows one (D12).
import { describe, expect, test } from "vitest";
import {
  AGENT_KEY_ACTIONS,
  AGENT_KEY_LIMITS,
  AGENT_LINKS,
  agentLinkLines,
  agentLinkList,
  labelAgentLinks,
  labelsCurrent,
  parseAgentKeys,
  shownKeys,
} from "../src/agent-keys.mjs";
import { DEFAULT_HINT_CHARS, hintLabels } from "../src/hints.mjs";
import { compileKeymap } from "../src/keymap.mjs";

/** @param {string} keys */
const ids = (keys) => {
  const r = parseAgentKeys(keys);
  if (!r.ok) throw new Error(r.error);
  return r.steps.map((s) => (s.count ? `${s.count}${s.action}` : s.action));
};

/** @param {string} keys */
const refusal = (keys) => {
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
  /** @param {string} keys */
  const steps = (keys) => {
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
  /** @param {number} x @param {number} y @param {string} [href] @param {string} [text] */
  const at = (x, y, href = `https://a.example/${x}-${y}`, text = `${x},${y}`) => ({
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
  const later = (ms) => ({ now: at + ms, mark });

  test("f's links last AGENT_LINKS.ttlMs on their page", () => {
    const links = { mark, at, source: "links" };
    expect(labelsCurrent(links, later(AGENT_LINKS.ttlMs - 1))).toBe(true);
    expect(labelsCurrent(links, later(AGENT_LINKS.ttlMs))).toBe(false);
  });

  test("an element list's labels last as long as their page, however slow the agent", () => {
    const elements = { mark, at, source: "elements" };
    expect(labelsCurrent(elements, later(AGENT_LINKS.ttlMs * 100))).toBe(true);
  });

  test("another document or URL ends either list, and no list is never current", () => {
    for (const source of ["links", "elements"]) {
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
