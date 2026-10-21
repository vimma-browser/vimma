// docs/specs/mcp-drive.md, sub-PR 2: `vimma_keys` parses its keys with a dispatcher of its own
// over Vimma's default keymap, and runs only the whitelisted action ids (D9, D10; security.md
// M16), within the limits of D15 (M20).
import { describe, expect, test } from "vitest";
import {
  AGENT_KEY_ACTIONS,
  AGENT_KEY_LIMITS,
  parseAgentKeys,
  shownKeys,
} from "../src/agent-keys.mjs";
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
  });

  test("the whitelist is the spec's table, without hint.follow until links come", () => {
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
    expect(refusal("F")).toContain("vimma_open");
    expect(refusal("r")).toContain("form");
    expect(refusal("z")).toBe('key "z" is refused: it is not one of the keys vimma_keys runs');
  });

  test("f is refused until following links comes (sub-PR 3)", () => {
    expect(refusal("f")).toContain("following links by hint label");
    expect(refusal("fsd")).toContain("following links by hint label");
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
