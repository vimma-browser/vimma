// Spec: docs/specs/copy-link-url.md (Security and privacy, decisions 3, 5 to 7 and 13): the
// parent's check of a frame's list of link URLs, and what the status bar says.

import { describe, test, expect } from "vitest";
import fc from "fast-check";
import {
  LINK_URL_MAX,
  LINK_URLS_MAX,
  NO_LINK,
  NOT_A_SCRIPT,
  TOO_LONG,
  isScriptUrl,
  linkYank,
} from "../src/page/link-urls.mjs";
import { HINT_REPLY_MAX_HREF, parseBlockReply } from "../src/page/hints.mjs";

const reply = (urls: unknown, scripts = 0, long = 0) => ({ urls, scripts, long });

describe("linkYank", () => {
  test("one URL is copied as the parser writes it, and the notice shows it", () => {
    expect(linkYank(reply(["https://example.org/a?b=1"]))).toEqual({
      text: "https://example.org/a?b=1",
      notice: "yanked https://example.org/a?b=1",
    });
    expect(linkYank(reply(["HTTPS://Example.ORG"]))?.text).toBe("https://example.org/");
  });

  test("several URLs are copied one per line, each once, in the order given", () => {
    const urls = ["https://a.example/", "https://b.example/", "https://a.example/"];
    expect(linkYank(reply(urls))).toEqual({
      text: "https://a.example/\nhttps://b.example/",
      notice: "yanked 2 links",
    });
  });

  test("two spellings of the same URL count once", () => {
    expect(linkYank(reply(["https://a.example", "https://A.example/"]))).toEqual({
      text: "https://a.example/",
      notice: "yanked https://a.example/",
    });
  });

  test("no link: nothing is copied, and the notice says so", () => {
    expect(linkYank(reply([]))).toEqual({ text: null, notice: NO_LINK });
    expect(NO_LINK).toBe("no link here");
  });

  test("a javascript: URL is dropped, by the frame or again here", () => {
    expect(linkYank(reply([], 1))).toEqual({ text: null, notice: NOT_A_SCRIPT });
    expect(linkYank(reply(["javascript:alert(1)"]))).toEqual({ text: null, notice: NOT_A_SCRIPT });
    expect(linkYank(reply([" JavaScript:alert(1)"]))).toEqual({
      text: null,
      notice: NOT_A_SCRIPT,
    });
    expect(NOT_A_SCRIPT).toBe("link runs a script: not copied");
    expect(linkYank(reply(["java​script:alert(1)"]))?.text).toBeNull();
  });

  test("a javascript: link beside an address: only the address is copied", () => {
    expect(linkYank(reply(["javascript:void(0)", "https://a.example/"], 1))).toEqual({
      text: "https://a.example/",
      notice: "yanked https://a.example/",
    });
  });

  test("a URL over the cap is skipped; when it was the only one, the notice says why", () => {
    expect(linkYank(reply([], 0, 1))).toEqual({ text: null, notice: TOO_LONG });
    expect(TOO_LONG).toBe("link too long to copy");
    const long = `data:text/plain,${"a".repeat(LINK_URL_MAX)}`;
    expect(linkYank(reply([long]))).toEqual({ text: null, notice: TOO_LONG });
    const fits = `data:text/plain,${"a".repeat(LINK_URL_MAX - 16)}`;
    expect(linkYank(reply([fits]))?.text).toBe(fits);
  });

  test("data:, mailto: and other schemes are copied", () => {
    for (const url of [
      "data:text/plain,hi",
      "mailto:a@example.org",
      "tel:+358123",
      "about:blank",
    ]) {
      expect(linkYank(reply([url]))?.text).toBe(url);
    }
  });

  test("control and format characters are removed before parsing", () => {
    expect(linkYank(reply(["https://a.example/‮gnp.exe"]))?.text).toBe("https://a.example/gnp.exe");
  });

  test("a malformed or oversized reply copies nothing", () => {
    for (const bad of [
      null,
      undefined,
      "https://a.example/",
      [],
      reply("https://a.example/"),
      reply([1]),
      reply(["https://a.example/"], -1),
      reply(["https://a.example/"], 0, 1.5),
      reply(Array.from({ length: LINK_URLS_MAX + 1 }, (_, i) => `https://a.example/${i}`)),
      { urls: ["https://a.example/"] },
    ]) {
      expect(linkYank(bad), JSON.stringify(bad)?.slice(0, 80)).toEqual({
        text: null,
        notice: NO_LINK,
      });
    }
  });

  test("an entry that is not a URL or is over the cap is dropped, the rest are copied", () => {
    expect(linkYank(reply(["not a url", "https://a.example/"]))?.text).toBe("https://a.example/");
    expect(linkYank(reply(["x".repeat(LINK_URL_MAX + 1), "https://a.example/"]))?.text).toBe(
      "https://a.example/",
    );
  });

  test("at most LINK_URLS_MAX URLs are taken", () => {
    const urls = Array.from({ length: LINK_URLS_MAX }, (_, i) => `https://a.example/${i}`);
    expect(linkYank(reply(urls))).toMatchObject({ notice: `yanked ${LINK_URLS_MAX} links` });
  });

  test("whatever the reply, the copied text holds only parsed URLs that are not scripts", () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.string(), fc.webUrl()), { maxLength: 8 }), (urls) => {
        const { text } = linkYank(reply(urls));
        if (text === null) return;
        for (const line of text.split("\n")) {
          expect(URL.parse(line)?.href).toBe(line);
          expect(isScriptUrl(line)).toBe(false);
        }
      }),
    );
  });
});

describe("the caps and the element-mode reply", () => {
  test("a link URL has the cap of a hint's link", () => {
    expect(LINK_URL_MAX).toBe(HINT_REPLY_MAX_HREF);
  });

  test("a block's links reply is a fresh copy, or null when malformed", () => {
    const good = { urls: ["https://a.example/"], scripts: 0, long: 0, extra: 1 };
    expect(parseBlockReply(good, "links")).toEqual({
      urls: ["https://a.example/"],
      scripts: 0,
      long: 0,
    });
    expect(parseBlockReply({ urls: "x", scripts: 0, long: 0 }, "links")).toBeNull();
    expect(parseBlockReply([], "links")).toBeNull();
  });
});

describe("isScriptUrl", () => {
  test("only the javascript: scheme, in any case", () => {
    expect(isScriptUrl("javascript:void(0)")).toBe(true);
    expect(isScriptUrl("JAVASCRIPT:x")).toBe(true);
    expect(isScriptUrl("https://example.org/javascript:")).toBe(false);
    expect(isScriptUrl("data:text/html,<script>")).toBe(false);
    expect(isScriptUrl("not a url")).toBe(false);
  });
});
