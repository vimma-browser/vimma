// Workspace routing rules at their edges (spec workspace-routing, app-routes): the domain and URL
// forms a rule refuses or normalises, a domain rule against IP hosts, and what shadows what.
import { describe, expect, test } from "vitest";
import { matchRoute, resolveRoutes, shadowedBy, validateRoutes } from "../src/config/routes.mjs";

const BAD_DOMAIN =
  'must be a hostname like "github.com" or "*.corp.example", without scheme, port or path';

const routes = (raw: Record<string, string>[]) => {
  expect(validateRoutes(raw)).toEqual([]);
  return resolveRoutes(raw);
};

describe("domain values", () => {
  // ß is a letter of its own in an IDN (the URL parser does not fold it to "ss"), so straße.de
  // and strasse.de are two different sites.
  test("straße.de is its own host, not strasse.de", () => {
    const rules = routes([{ domain: "straße.de", workspace: "w" }]);
    expect(rules[0]?.domain?.host).toBe("xn--strae-oqa.de");
    expect(matchRoute(rules, { url: "https://straße.de/" })?.workspace).toBe("w");
    expect(matchRoute(rules, { url: "https://strasse.de/" })).toBeNull();
  });

  test.each(["999.1.1.1", "010.0.0.1", "1.2.3.04"])(
    "an IPv4 address the URL parser would read otherwise, %j, is refused",
    (domain) => {
      expect(validateRoutes([{ domain, workspace: "w" }])).toEqual([
        { path: [0, "domain"], message: BAD_DOMAIN },
      ]);
    },
  );

  test("a bracketed IPv6 address with a port is refused, suggesting the address", () => {
    expect(validateRoutes([{ domain: "[::1]:8080", workspace: "w" }])).toEqual([
      { path: [0, "domain"], message: BAD_DOMAIN, suggestion: "[::1]" },
    ]);
  });

  test("text before a bracketed IPv6 address is not dropped", () => {
    expect(validateRoutes([{ domain: "1[::2]", workspace: "w" }])).toEqual([
      { path: [0, "domain"], message: BAD_DOMAIN },
    ]);
  });

  test("a domain rule never matches a link to an IP address", () => {
    const rules = routes([{ domain: "example.com", workspace: "w" }]);
    expect(matchRoute(rules, { url: "http://192.0.2.1/" })).toBeNull();
    expect(matchRoute(rules, { url: "http://[2001:db8::1]/" })).toBeNull();
    expect(matchRoute(rules, { url: "http://example.com/" })?.workspace).toBe("w");
  });
});

describe("url values", () => {
  // A URL pasted from a web page often ends in a non-breaking space; the URL parser would keep it
  // as %C2%A0, and the rule would then match no link.
  test("a trailing non-breaking space is trimmed", () => {
    const rules = routes([{ url: "https://example.com/app ", workspace: "w" }]);
    expect(rules[0]?.url).toBe("https://example.com/app");
    expect(matchRoute(rules, { url: "https://example.com/app/x" })?.workspace).toBe("w");
  });
});

describe("rules that are not tables", () => {
  test("a null rule is reported, not read as a table", () => {
    expect(validateRoutes([null])).toEqual([
      { path: [0], message: expect.stringMatching(/^expected a table, got /) },
    ]);
  });
});

describe("shadowedBy at its edges", () => {
  test("an IP rule shadows the same IP below it, and nothing else", () => {
    const rules = routes([
      { domain: "192.0.2.1", workspace: "a" },
      { domain: "192.0.2.1", workspace: "b" },
      { domain: "192.0.2.2", workspace: "c" },
      { domain: "::1", workspace: "d" },
      { domain: "[::1]", workspace: "e" },
    ]);
    expect(shadowedBy(rules, 1)?.index).toBe(1);
    expect(shadowedBy(rules, 2)).toBeNull();
    expect(shadowedBy(rules, 3)).toBeNull();
    expect(shadowedBy(rules, 4)?.index).toBe(4);
  });

  test("a *. rule does not shadow a *. rule for another domain", () => {
    const rules = routes([
      { domain: "*.a.example", workspace: "a" },
      { domain: "*.b.example", workspace: "b" },
    ]);
    expect(shadowedBy(rules, 1)).toBeNull();
  });
});
