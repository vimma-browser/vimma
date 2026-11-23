// Edges of `vimma_keys`' keys and of the URLs, titles and link targets the agent may see
// (docs/specs/mcp-drive.md D9-D12; security.md M7, M16, M20, M21), found by mutation testing
// (#1119): each test fails when the rule it names is changed.
import { describe, expect, test } from "vitest";
import {
  agentTabTitle,
  agentTitle,
  agentUrl,
  markdownWithoutUserinfo,
  parseAgentKeys,
} from "../src/agent/agent-keys.mjs";

/** `s` percent-encoded `times` times, as a redirect inside a redirect writes it. */
function encoded(s: string, times: number): string {
  let out = s;
  for (let i = 0; i < times; i++) out = encodeURIComponent(out);
  return out;
}

describe("vimma_keys' words and labels (M16, M20)", () => {
  test("f's label is only the characters right after it, never the next word", () => {
    // `f jk` is a link list, then j and k: f must be last, so it is refused, rather than a follow
    // of the label k after j.
    expect(parseAgentKeys("f jk")).toStrictEqual({
      ok: false,
      error: 'key "f" is refused: f without a label lists the links and must be the last key',
    });
  });

  test("a character outside the Basic Multilingual Plane is no key, named whole", () => {
    expect(parseAgentKeys("j😀")).toStrictEqual({
      ok: false,
      error: 'key "😀" is refused: it is not a key',
    });
  });

  test("a step carries a count only when one was typed", () => {
    expect(parseAgentKeys("j3k")).toStrictEqual({
      ok: true,
      steps: [
        { keys: "j", action: "scroll.down" },
        { keys: "3k", action: "scroll.up", count: 3 },
      ],
    });
  });

  test("after a find's <CR> the rest of its word is a run of keys, never a key's name", () => {
    // A key's name (`ctrl+d`) is one key only as a whole word: a space starts one.
    const refusedC = {
      ok: false,
      error: 'key "c" is refused: it is not one of the keys vimma_keys runs',
    };
    expect(parseAgentKeys("/a<CR>ctrl+d")).toStrictEqual(refusedC);
    expect(parseAgentKeys("/a<CR>ctrl+d j")).toStrictEqual(refusedC);
    expect(parseAgentKeys("/a<CR> ctrl+d")).toStrictEqual({
      ok: true,
      steps: [
        { keys: '/"a"⏎', action: "find.forward", query: "a" },
        { keys: "<C-d>", action: "scroll.half_down" },
      ],
    });
  });
});

describe("URLs without user names and passwords: authorities (M21)", () => {
  test("a query right after an authority that held them is still read", () => {
    expect(agentUrl("https://u:p@h?next=https%3A%2F%2Fv%3Aq%40x%2F", 2048)).toBe(
      "https://h?next=https%3A%2F%2Fx%2F",
    );
    // A read page's link target is stripped once, with no second pass to catch a miss.
    expect(markdownWithoutUserinfo("[a](https://u:p@h?next=https%3A%2F%2Fv%3Aq%40x%2F)")).toBe(
      "[a](https://h?next=https%3A%2F%2Fx%2F)",
    );
  });

  test("an empty authority keeps the at signs of its path", () => {
    expect(markdownWithoutUserinfo("[a](sftp:///srv/u@h/f)")).toBe("[a](sftp:///srv/u@h/f)");
  });

  test("a link target behind control characters still loses them (M7)", () => {
    expect(markdownWithoutUserinfo("[a](\u0001\u0001https://u:p@h/)")).toBe("[a](https://h/)");
  });

  test("a link target keeps its other characters byte for byte (M7)", () => {
    const text = "[a](https://example.com/a\u0001b)";
    expect(markdownWithoutUserinfo(text)).toBe(text);
  });

  test("an authority's own characters are never read as a URL in its path", () => {
    // `a:` is the host and an empty port; the path that follows holds no URL of its own.
    expect(agentUrl("foo://a://u@h/p", 2048)).toBe("foo://a://u@h/p");
  });

  test("a URL in a path loses them; it runs to the path's end only when the text was cut", () => {
    expect(agentUrl("https://h/go/https://u@x", 2048)).toBe("https://h/go/https://x");
    // Cut in its query, the path before it is whole: its last URL keeps its host.
    expect(agentUrl(`https://h/go/https://u@x?q=${"b".repeat(300)}`, 60)).toBe(
      `https://h/go/https://x?q=${"b".repeat(34)}…`,
    );
  });

  test("past four nested URLs a URL in a path is dropped, and one level deeper than its own", () => {
    expect(agentUrl("view-source:jar:blob:view-source:https://h/go/https://u@x/", 2048)).toBe(
      // The second pass shows each ellipsis as NFKC writes it.
      "view-source:jar:blob:view-source:https://h/go/...",
    );
    // Three levels down, a URL in the path is the fourth, so a nested scheme in it is not read.
    expect(agentUrl("view-source:jar:blob:https://h/go/jar:/x", 2048)).toBe(
      "view-source:jar:blob:https://h/go/jar:...",
    );
  });

  test("past four URLs in a parameter's text, each after the last, the rest is dropped", () => {
    const urls = ["a", "b", "c", "d", "e", "f"].map((h) => `https://u:p@${h}/`).join(" ");
    expect(agentUrl(`https://h/?x=${encodeURIComponent(`z ${urls}`)}`, 2048)).toBe(
      "https://h/?x=z+https%3A%2F%2Fa%2F+https%3A%2F%2Fb%2F+https%3A%2F%2Fc%2F" +
        "+https%3A%2F%2Fd%2F+%E2%80%A6",
    );
  });

  test("past four URLs inside one parameter the rest is dropped", () => {
    const value = ["a", "b", "c", "d", "e", "f"].map((h) => `https://u:p@${h}/`).join("");
    expect(agentUrl(`https://h/?x=${value}`, 2048)).toBe(
      "https://h/?x=https%3A%2F%2Fa%2Fhttps%3A%2F%2Fb%2Fhttps%3A%2F%2Fc%2Fhttps%3A%2F%2Fd" +
        "%2Fhttps%3A%2F%2Fe%2F%E2%80%A6",
    );
  });
});

describe("URLs without user names and passwords: queries (M21)", () => {
  test("a parameter that is a whole URL with no name loses them, and nothing else", () => {
    expect(agentUrl("https://h/?https%3A%2F%2Fu%3Ap%40x%2F", 2048)).toBe(
      "https://h/?https%3A%2F%2Fx%2F",
    );
    expect(agentUrl("https://h/?=https%3A%2F%2Fu%3Ap%40x%2F", 2048)).toBe(
      "https://h/?=https%3A%2F%2Fx%2F",
    );
  });

  test("a parameter written in full-width look-alikes loses them", () => {
    const value = encodeURIComponent("ｈｔｔｐｓ：／／ｕ：ｐ＠ｘ／");
    expect(agentUrl(`https://h/?n=${value}`, 2048)).toBe("https://h/?n=https%3A%2F%2Fx%2F");
  });

  test("a parameter that lost them keeps its spaces", () => {
    expect(agentUrl("https://h/?next=https%3A%2F%2Fu%3Ap%40x%2Fa+b", 2048)).toBe(
      "https://h/?next=https%3A%2F%2Fx%2Fa+b",
    );
  });

  test("a query that was not cut keeps a last URL that has no path", () => {
    const url = "https://h/?next=https%3A%2F%2Fexample.com";
    expect(agentUrl(url, 2048)).toBe(url);
  });

  test("in a cut URL only the last parameter, and only its value, is read as cut", () => {
    const b = "b".repeat(300);
    expect(agentUrl(`https://h/?a=https%3A%2F%2Fexample.com&b=${b}`, 60)).toBe(
      `https://h/?a=https%3A%2F%2Fexample.com&b=${"b".repeat(18)}…`,
    );
    expect(agentUrl(`https://h/?https%3A%2F%2Fexample.com=${b}`, 60)).toBe(
      `https://h/?https%3A%2F%2Fexample.com=${"b".repeat(22)}…`,
    );
    // The hash is what was cut, so the query before it is whole.
    expect(agentUrl(`https://h/?n=https%3A%2F%2Fexample.com#${b}`, 60)).toBe(
      `https://h/?n=https%3A%2F%2Fexample.com#${"b".repeat(20)}…`,
    );
  });

  test("a cut parameter whose URL ends in its scheme's slashes has its authority cut off", () => {
    // Its host may have been in what the cut left out, so it is written again as read.
    expect(agentUrl(`https://h/?x=https:${"/".repeat(300)}`, 60)).toBe(
      `https://h/?x=https%3A${"%2F".repeat(12)}%2…`,
    );
  });

  test("a value encoded four times is read; once more, it is dropped", () => {
    expect(agentUrl(`https://h/?n=${encoded("https://u:p@x/", 4)}`, 2048)).toBe(
      "https://h/?n=https%2525253A%2525252F%2525252Fx%2525252F",
    );
    expect(agentUrl(`https://h/?n=${encoded("https://u:p@x/", 5)}`, 2048)).toBe(
      "https://h/?n=%2525E2%252580%2525A6",
    );
  });

  test("past four nested URLs the query and the hash are dropped, the rest kept", () => {
    const nested = "view-source:jar:blob:view-source:https://h/p";
    expect(agentUrl(nested, 2048)).toBe(nested);
    expect(agentUrl(`${nested}?a=1`, 2048)).toBe(`${nested}?…`);
    expect(agentUrl(`${nested}#b`, 2048)).toBe(`${nested}#…`);
    expect(agentUrl(`${nested}?a=1#b`, 2048)).toBe(`${nested}?…#…`);
    expect(agentUrl(`${nested}#b?a=1`, 2048)).toBe(`${nested}#…`);
  });

  test("a long URL of parameters read closely keeps them all within its budget", () => {
    const url = `https://h/?${`a=${"é".repeat(10)}&`.repeat(1000)}`;
    expect(agentUrl(url, 1_000_000)).toBe(url);
  });

  test("a URL whose queries cost more than its budget to read loses them", () => {
    const url = `https://h/?q=${"%252525zz".repeat(2000)}`;
    expect(agentUrl(url, 1_000_000)).toBe("https://h/?…");
  });

  test("a parameter of only + and % is decoded and read like any other", () => {
    // `+%` reads as " %": as shown, without its white space, that is "%" written again as
    // "%25". Only the leading white space goes (#1371 review); a parameter with other
    // characters that reads as itself stays as written.
    expect(agentUrl("https://h/?a=+%", 2048)).toBe("https://h/?a=%25");
    expect(agentUrl("https://h/?a=x+%", 2048)).toBe("https://h/?a=x+%");
    expect(markdownWithoutUserinfo("[a](https://h/?+%+%&b=1)")).toBe("[a](https://h/?%25+%25&b=1)");
  });

  test("no URL is no text", () => {
    expect(agentUrl(undefined, 2048)).toBe("");
    expect(agentUrl(null, 2048)).toBe("");
  });
});

describe("a read page's link targets (M7, #1352)", () => {
  test("all of a page's targets share one budget: kept until it is spent, then dropped", () => {
    // Each target's parameter is read closely, in two splits, at 4,096 code units a split:
    // 32 of them spend the 2^18 of the page exactly.
    const costly = `[a](https://h/?é${"a".repeat(4095)})`;
    const page = Array(32).fill(costly).join(" ");
    const tail = " [b](https://h/?x=1) [c](https://h/?é) [d](https://h/?x=1#y)";
    expect(markdownWithoutUserinfo(page + tail)).toBe(
      `${page} [b](https://h/?x=1) [c](https://h/?…) [d](https://h/?…#…)`,
    );
  });

  test("a target longer than a link's href is read that far and marked cut", () => {
    const target = `https://h/${"a".repeat(9000)}`;
    expect(markdownWithoutUserinfo(`[a](${target})`)).toBe(`[a](${target.slice(0, 8192)}…)`);
  });
});

describe("titles (M21, #1209)", () => {
  test("no title is no text", () => {
    expect(agentTitle(null)).toBe("");
    expect(agentTitle(undefined)).toBe("");
  });

  test("a title that is a URL holding no user name is left as the page wrote it", () => {
    for (const title of [
      "\u0001https://example.com/",
      "about:reader?url=https%3A%2F%2Fexample.com%2F",
      // A parameter read closely, well within the title's budget.
      "about:reader?url=https%3A%2F%2Fexample.com%2F&q=%C3%A9",
      "https://ex%41mpleｘ.com",
    ]) {
      expect(agentTitle(title)).toBe(title);
    }
  });

  test("a URL title of exactly the length agentUrl reads is read whole", () => {
    const title = `https://example.com/${"a".repeat(32768 - 20)}`;
    expect(agentTitle(title)).toBe(title);
  });

  test("a longer URL title is given as agentUrl gives it, cut, user name or not", () => {
    const title = `https://example.com/${"a".repeat(32769 - 20)}`;
    expect(agentTitle(title)).toBe(`${title.slice(0, 8191)}…`);
  });

  test("a longer title cut inside a character is read without its half", () => {
    // The head is letters alone, which may still begin a scheme, once the half is dropped.
    const title = `${"a".repeat(32767)}\u{1F600}b`;
    expect(agentTitle(title)).toBe(`${"a".repeat(8191)}…`);
  });

  test("a URL title whose queries cost more than its budget is given as agentUrl gives it", () => {
    expect(agentTitle(`https://h/?q=${"%252525zz".repeat(2000)}`)).toBe("https://h/?…");
  });

  test("a new tab's typed URL is shown only when it is text", () => {
    expect(agentTabTitle("x", false, "about:blank", 1)).toBe("about:blank");
  });
});
