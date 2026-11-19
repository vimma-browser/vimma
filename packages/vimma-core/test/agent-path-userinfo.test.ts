// security.md M21 (#1372): a URL written unencoded in another URL's path, as archive and redirect
// services write it (`/web/2020/https://…`), loses its user name and password too, within the
// same nesting and time bounds as a URL in a query.
import { describe, expect, test } from "vitest";
import { agentTitle, agentUrl, markdownWithoutUserinfo } from "../src/agent/agent-keys.mjs";
import { budget } from "./budget.ts";

describe("a URL in another URL's path (#1372)", () => {
  test("a link's href loses the user name and password of a URL in its path", () => {
    expect(agentUrl("https://web.archive.org/web/2020/https://u:p@example.com/", 2048)).toBe(
      "https://web.archive.org/web/2020/https://example.com/",
    );
    expect(agentUrl("https://h.example/go/https://ada:secret@x.example/a?b=c#d", 2048)).toBe(
      "https://h.example/go/https://x.example/a?b=c#d",
    );
    // A special scheme's colon alone, and a backslash, are read as a URL parser reads them.
    expect(agentUrl("https://h.example/go/https:ada:secret@x.example/", 2048)).toBe(
      "https://h.example/go/https:x.example/",
    );
    expect(agentUrl("https://h.example/go/http:\\\\ada:secret@x.example\\a", 2048)).toBe(
      "https://h.example/go/http:\\\\x.example\\a",
    );
  });

  test("each URL of a chain in the path loses them, and the outer URL's too", () => {
    expect(
      agentUrl("https://o:p@h.example/a/https://u1:p1@x.example/b/ftp://u2:p2@y.example/c", 2048),
    ).toBe("https://h.example/a/https://x.example/b/ftp://y.example/c");
    expect(agentUrl("https://h.example/v/view-source:https://u:p@x.example/", 2048)).toBe(
      "https://h.example/v/view-source:https://x.example/",
    );
  });

  test("a page's markdown link target loses them", () => {
    expect(markdownWithoutUserinfo("[a](https://h/go/https://u:p@x/)")).toBe(
      "[a](https://h/go/https://x/)",
    );
  });

  test("a title that is a URL loses them from its path", () => {
    expect(agentTitle("https://web.archive.org/web/2020/https://u:p@example.com/")).toBe(
      "https://web.archive.org/web/2020/https://example.com/",
    );
  });

  test("a path without a nested user name is left byte for byte", () => {
    for (const url of [
      "https://web.archive.org/web/2020/https://example.com/a?b=c",
      "https://h.example/@ada/posts",
      "https://h.example/mailto:ada@example.com",
      "https://h.example/a:b@c",
    ]) {
      expect(agentUrl(url, 2048)).toBe(url);
    }
  });

  test("past the nesting limit the rest of the path is dropped", () => {
    const deep = `https://h.example/${"https://x.example/".repeat(6)}https://u:p@y.example/`;
    // Four levels are read; the fifth URL and all after it are dropped.
    const out = agentUrl(deep, 2048);
    expect(out.startsWith(`https://h.example/${"https://x.example/".repeat(4)}`)).toBe(true);
    expect(out).not.toContain("y.example");
    expect(out.length).toBeLessThan(`https://h.example/${"https://x.example/".repeat(5)}`.length);
  });

  test("a long, deeply nested path is read in bounded time", () => {
    const chain = "https://u:p@x.example/".repeat(200_000);
    const scheme = "https:".repeat(500_000);
    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      expect(agentUrl(`https://h.example/${chain}`, 2048)).not.toContain("u:p");
      agentUrl(`https://h.example/${scheme}`, 2048);
      markdownWithoutUserinfo(`[a](https://h.example/${chain.slice(0, 8192)}) `.repeat(20));
    }
    expect(performance.now() - start).toBeLessThan(budget(1000));
  });
});
