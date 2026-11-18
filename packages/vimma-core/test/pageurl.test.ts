import { describe, test, expect } from "vitest";
import {
  MAX_CLIPBOARD_CHARS,
  classifyClipboard,
  inputIndex,
  pageUrl,
  readerOriginalUrl,
  refusedScheme,
  urlRoot,
  urlUp,
} from "../src/page/pageurl.mjs";

// Spec: docs/specs/m1-actor-insert-scroll.md, "Follow-up: normal-mode extras" (gu, gU, p, P, gi).

describe("urlUp (gu)", () => {
  test("drops the last path segment, keeping a trailing slash", () => {
    expect(urlUp("https://example.com/a/b/c")).toBe("https://example.com/a/b/");
    expect(urlUp("https://example.com/a/b/index.html")).toBe("https://example.com/a/b/");
  });

  test("a trailing slash does not count as a level", () => {
    expect(urlUp("https://example.com/a/b/")).toBe("https://example.com/a/");
    expect(urlUp("https://example.com/a/b//")).toBe("https://example.com/a/");
  });

  test("the query and the hash go first, then a level", () => {
    expect(urlUp("https://example.com/a/b?q=1#top")).toBe("https://example.com/a/");
    expect(urlUp("https://example.com/a/#top")).toBe("https://example.com/");
  });

  test("at the root, only the query and hash go", () => {
    expect(urlUp("https://example.com/?q=1")).toBe("https://example.com/");
    expect(urlUp("https://example.com/#x")).toBe("https://example.com/");
  });

  test("at the root with nothing to drop there is nothing above", () => {
    expect(urlUp("https://example.com/")).toBeNull();
    expect(urlUp("https://example.com")).toBeNull();
  });

  test("a count goes up N levels, stopping at the root", () => {
    expect(urlUp("https://example.com/a/b/c/d", 2)).toBe("https://example.com/a/b/");
    expect(urlUp("https://example.com/a/b/c/d", 4)).toBe("https://example.com/");
    expect(urlUp("https://example.com/a/b", 99)).toBe("https://example.com/");
  });

  test("a missing or bad count is one level", () => {
    expect(urlUp("https://example.com/a/b", undefined)).toBe("https://example.com/a/");
    expect(urlUp("https://example.com/a/b", 0)).toBe("https://example.com/a/");
    expect(urlUp("https://example.com/a/b", Number.NaN)).toBe("https://example.com/a/");
  });

  test("keeps the port and the credentials", () => {
    expect(urlUp("http://localhost:8080/app/page")).toBe("http://localhost:8080/app/");
    expect(urlUp("https://u:p@example.com:8443/a/b")).toBe("https://u:p@example.com:8443/a/");
  });

  test("an IDN host survives (in its ASCII form, as Firefox loads it)", () => {
    expect(urlUp("https://bücher.example/a/b")).toBe("https://xn--bcher-kva.example/a/");
    expect(urlUp("https://xn--bcher-kva.example/a/b")).toBe("https://xn--bcher-kva.example/a/");
  });

  test("file: URLs walk up the directories to file:///", () => {
    expect(urlUp("file:///home/u/doc.txt")).toBe("file:///home/u/");
    expect(urlUp("file:///home/u/", 5)).toBe("file:///");
    expect(urlUp("file:///")).toBeNull();
  });

  test("a Windows drive letter is the root of a file: URL", () => {
    expect(urlUp("file:///C:/Users/u", 5)).toBe("file:///C:/");
    expect(urlUp("file:///C:/")).toBeNull();
  });

  test("about: pages have no levels: only the query and hash go", () => {
    expect(urlUp("about:config")).toBeNull();
    expect(urlUp("about:blank")).toBeNull();
    expect(urlUp("about:preferences#privacy")).toBe("about:preferences");
  });

  test("javascript:, data:, blob: and view-source: are never walked", () => {
    expect(urlUp("javascript:alert(1)//a/b")).toBeNull();
    expect(urlUp("data:text/html,<a>/b/c#x")).toBeNull();
    expect(urlUp("blob:https://example.com/0b6e-11")).toBeNull();
    expect(urlUp("view-source:https://example.com/a/b")).toBeNull();
  });

  test("not a URL: null", () => {
    expect(urlUp("")).toBeNull();
    expect(urlUp("not a url")).toBeNull();
  });
});

describe("urlRoot (gU)", () => {
  test("goes to the site root, without query or hash", () => {
    expect(urlRoot("https://example.com/a/b/c?q#h")).toBe("https://example.com/");
    expect(urlRoot("http://localhost:8080/x/y")).toBe("http://localhost:8080/");
    expect(urlRoot("https://bücher.example/a")).toBe("https://xn--bcher-kva.example/");
  });

  test("already at the root: null", () => {
    expect(urlRoot("https://example.com/")).toBeNull();
    expect(urlRoot("file:///")).toBeNull();
    expect(urlRoot("about:config")).toBeNull();
  });

  test("file: goes to / or the drive", () => {
    expect(urlRoot("file:///home/u/doc.txt")).toBe("file:///");
    expect(urlRoot("file:///D:/x/y")).toBe("file:///D:/");
  });

  test("never walks javascript: or data:", () => {
    expect(urlRoot("javascript:void(0)")).toBeNull();
    expect(urlRoot("data:text/plain,a/b")).toBeNull();
  });
});

describe("classifyClipboard (p, P)", () => {
  test("a URL with a scheme opens as a URL", () => {
    expect(classifyClipboard("https://example.com/a?b=c")).toEqual({
      kind: "url",
      text: "https://example.com/a?b=c",
    });
    expect(classifyClipboard("about:config")).toEqual({ kind: "url", text: "about:config" });
    expect(classifyClipboard("file:///tmp/x.html")).toEqual({
      kind: "url",
      text: "file:///tmp/x.html",
    });
  });

  test("a bare domain or host:port opens as a URL", () => {
    expect(classifyClipboard("example.com")).toEqual({ kind: "url", text: "example.com" });
    expect(classifyClipboard("example.com/path")).toEqual({
      kind: "url",
      text: "example.com/path",
    });
    expect(classifyClipboard("localhost:3000")).toEqual({ kind: "url", text: "localhost:3000" });
    expect(classifyClipboard("bücher.example")).toEqual({ kind: "url", text: "bücher.example" });
  });

  test("words are a search", () => {
    expect(classifyClipboard("vim keybindings")).toEqual({
      kind: "search",
      text: "vim keybindings",
    });
    expect(classifyClipboard("vimma")).toEqual({ kind: "search", text: "vimma" });
  });

  test("surrounding whitespace is trimmed and inner runs collapse", () => {
    expect(classifyClipboard("  \n https://example.com/ \t\n")).toEqual({
      kind: "url",
      text: "https://example.com/",
    });
    expect(classifyClipboard("two\nlines\t here")).toEqual({
      kind: "search",
      text: "two lines here",
    });
  });

  test("control characters are dropped", () => {
    expect(classifyClipboard("exa\u0000mple.com\u007f")).toEqual({
      kind: "url",
      text: "example.com",
    });
  });

  test("empty or blank: empty", () => {
    expect(classifyClipboard("")).toEqual({ kind: "empty" });
    expect(classifyClipboard(" \n\t ")).toEqual({ kind: "empty" });
    expect(classifyClipboard(null as any)).toEqual({ kind: "empty" });
  });

  test.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)",
    "java\nscript:alert(1)",
    "java\tscript:alert(1)",
    "\u0001javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "DATA:text/html;base64,PHNjcmlwdD4=",
    "view-source:javascript:alert(1)",
    "view-source: data:text/html,x",
  ])("refuses %j", (text) => {
    expect(classifyClipboard(text).kind).toBe("refused");
  });

  test("a search that merely mentions javascript: is still refused", () => {
    // Conservative: the text starts with the scheme, whatever follows.
    expect(classifyClipboard("javascript: the good parts").kind).toBe("refused");
  });

  test("the word javascript elsewhere is a search", () => {
    expect(classifyClipboard("learn javascript: basics")).toEqual({
      kind: "search",
      text: "learn javascript: basics",
    });
  });

  test("text over the cap is refused, not truncated", () => {
    const long = `https://example.com/${"a".repeat(MAX_CLIPBOARD_CHARS)}`;
    expect(classifyClipboard(long)).toMatchObject({ kind: "refused" });
    const fits = `https://example.com/${"a".repeat(MAX_CLIPBOARD_CHARS - 40)}`;
    expect(classifyClipboard(fits).kind).toBe("url");
  });

  test("the cap applies after trimming", () => {
    const padded = `${" ".repeat(MAX_CLIPBOARD_CHARS)}example.com`;
    expect(classifyClipboard(padded)).toEqual({ kind: "url", text: "example.com" });
  });
});

describe("refusedScheme (every Vimma open: p, :open, :tabnew)", () => {
  test.each([
    ["javascript:alert(1)", "javascript"],
    [" JAVA\nSCRIPT:void(0)", "javascript"],
    ["data:text/html,<h1>x</h1>", "data"],
    ["DATA:text/html;base64,PHNjcmlwdD4=", "data"],
    ["\u0001\u0000 data:text/plain,x", "data"],
    ["da\tta:text/plain,x", "data"],
    ["view-source:data:text/html,x", "data"],
    ["VIEW-SOURCE:\u0001 view-source:javascript:1", "javascript"],
  ])("refuses %j as %s", (text, scheme) => {
    expect(refusedScheme(text)).toBe(scheme);
  });

  test.each([
    "example.com",
    "https://example.com/?q=data:x",
    "view-source:https://example.com/",
    "view-source:file:///home/u/.config/vimma/config.toml",
    "about:vimma?tab=1#routes",
    "? learn data: urls",
    "learn data: urls",
  ])("lets %j through", (text) => {
    expect(refusedScheme(text)).toBeNull();
  });
});

describe("inputIndex (gi)", () => {
  test("no count is the first field", () => {
    expect(inputIndex(undefined, 3)).toBe(0);
  });

  test("a count picks the Nth, clamped to the last", () => {
    expect(inputIndex(2, 3)).toBe(1);
    expect(inputIndex(3, 3)).toBe(2);
    expect(inputIndex(9, 3)).toBe(2);
  });

  test("no fields: -1", () => {
    expect(inputIndex(undefined, 0)).toBe(-1);
    expect(inputIndex(4, 0)).toBe(-1);
  });
});

describe("pageurl edges", () => {
  test("a URL with an empty path has no root to walk to", () => {
    expect(urlRoot("git://example.com")).toBeNull();
    expect(urlUp("git://example.com")).toBeNull();
    expect(urlRoot("git://example.com?q=1")).toBe("git://example.com");
  });

  test("a URL without a special scheme keeps its leading slash at the root", () => {
    expect(urlRoot("foo://host/a/b")).toBe("foo://host/");
    expect(urlUp("foo://host/a/b")).toBe("foo://host/a/");
  });

  test("a drive-like first segment is a drive only in a file: URL", () => {
    expect(urlRoot("https://example.com/C:/a/b")).toBe("https://example.com/");
    expect(urlUp("https://example.com/C:/a")).toBe("https://example.com/C:/");
  });

  test("a drive must start the path", () => {
    expect(urlRoot("file:///x/C:/y")).toBe("file:///");
  });

  test("a bare drive is a root, given its slash", () => {
    expect(urlRoot("file:///C:")).toBe("file:///C:/");
  });

  test("the segments counted on a file: URL start after its drive", () => {
    expect(urlUp("file:///C:/a/b")).toBe("file:///C:/a/");
    expect(urlUp("file:///C:/a/b", 2)).toBe("file:///C:/");
  });

  test("controls are stripped only before the scheme, not inside it", () => {
    expect(refusedScheme("java script:alert(1)")).toBeNull();
    expect(refusedScheme("java\u0001script:alert(1)")).toBeNull();
    expect(refusedScheme(" \u0001javascript:alert(1)")).toBe("javascript");
  });

  test("text of exactly the limit is still opened", () => {
    const word = `a.${"b".repeat(MAX_CLIPBOARD_CHARS - 2)}`;
    expect(classifyClipboard(word)).toEqual({ kind: "url", text: word });
    expect(classifyClipboard(`${word}c`)).toEqual({
      kind: "refused",
      reason: `over ${MAX_CLIPBOARD_CHARS} characters`,
    });
  });

  test("the refusal names the scheme", () => {
    expect(classifyClipboard("JavaScript:alert(1)")).toEqual({
      kind: "refused",
      reason: "javascript: URL",
    });
    expect(classifyClipboard("data:text/html,x")).toEqual({ kind: "refused", reason: "data: URL" });
  });

  test("a scheme must start the word", () => {
    expect(classifyClipboard("1foo:bar")).toEqual({ kind: "search", text: "1foo:bar" });
  });

  test("a negative field count means no field", () => {
    expect(inputIndex(1, -2)).toBe(-1);
    expect(inputIndex(undefined, -1)).toBe(-1);
  });
});

// Issue #1310: Reader View's page is its article's URL, as Firefox's address bar shows it
// (ReaderMode.getOriginalUrl).
describe("readerOriginalUrl and pageUrl (Reader View)", () => {
  const reader = (url: string) => `about:reader?url=${encodeURIComponent(url)}`;

  test("an about:reader address gives the article's own URL", () => {
    expect(readerOriginalUrl(reader("http://127.0.0.1:28561/article.html"))).toBe(
      "http://127.0.0.1:28561/article.html",
    );
    expect(pageUrl(reader("https://example.com/a/b?q=1"))).toBe("https://example.com/a/b?q=1");
  });

  test("the reader's hash applies to the article's URL, as ReaderMode does", () => {
    expect(pageUrl(`${reader("https://example.com/a")}#part-2`)).toBe(
      "https://example.com/a#part-2",
    );
  });

  test("a file: article is a page too", () => {
    expect(pageUrl(reader("file:///home/me/a.html"))).toBe("file:///home/me/a.html");
  });

  test("any other address is itself", () => {
    expect(readerOriginalUrl("https://example.com/")).toBeNull();
    expect(pageUrl("https://example.com/about:reader?url=x")).toBe(
      "https://example.com/about:reader?url=x",
    );
    expect(pageUrl("about:config")).toBe("about:config");
    expect(pageUrl("")).toBe("");
  });

  test("a malformed about:reader address falls back to the raw address", () => {
    for (const raw of [
      "about:reader",
      "about:reader?",
      "about:reader?url=",
      "about:reader?nourl=https%3A%2F%2Fexample.com%2F",
      "about:reader?url=not%20a%20url",
      "about:reader?url=%2Frelative%2Fpath",
      `about:reader?url=${encodeURIComponent("http://[")}`,
    ]) {
      expect(readerOriginalUrl(raw)).toBeNull();
      expect(pageUrl(raw)).toBe(raw);
    }
  });

  test("an article URL Reader View cannot load stays the raw address, never a script URL", () => {
    for (const inner of ["javascript:alert(1)", "data:text/html,x", "about:config", "blob:x"]) {
      expect(readerOriginalUrl(reader(inner))).toBeNull();
      expect(pageUrl(reader(inner))).toBe(reader(inner));
    }
  });

  test("gu works on the article, not on the reader address", () => {
    expect(urlUp(pageUrl(reader("https://example.com/a/b/c.html")))).toBe(
      "https://example.com/a/b/",
    );
  });
});
