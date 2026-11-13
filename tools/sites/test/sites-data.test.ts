import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { filterSites, validateSites } from "../site-list.mjs";

const SITES = JSON.parse(readFileSync(new URL("../sites.json", import.meta.url), "utf8"));

describe("tools/sites/sites.json", () => {
  it("is a valid site list", () => {
    expect(validateSites(SITES)).toEqual([]);
  });

  // The names reach the site-compat issue as Markdown (decision 12): nothing GitHub would turn
  // into a mention, a reference or a link.
  it("names nothing GitHub would turn into a mention, reference or link", () => {
    for (const s of SITES) expect(s.name, s.id).not.toMatch(/[@#`<>[\]]|:\/\/|\bGH-\d/);
  });

  it("has the sites the suite covers", () => {
    const hosts = new Set(SITES.map((/** @type {any} */ s) => new URL(s.url).hostname));
    for (const host of [
      "github.com",
      "stackoverflow.com",
      "developer.mozilla.org",
      "docs.rs",
      "www.npmjs.com",
      "pypi.org",
      "doc.rust-lang.org",
      "docs.python.org",
      "news.ycombinator.com",
      "www.reddit.com",
      "www.youtube.com",
      "en.wikipedia.org",
      "www.google.com",
      "duckduckgo.com",
      "vercel.com",
      "developers.cloudflare.com",
      "codepen.io",
      "regex101.com",
      "excalidraw.com",
      "crates.io",
      "gitlab.com",
    ]) {
      expect(hosts.has(host), host).toBe(true);
    }
    const github = SITES.filter((/** @type {any} */ s) => s.id.startsWith("github-"));
    expect(github.map((/** @type {any} */ s) => s.id).sort()).toEqual([
      "github-file",
      "github-issues",
      "github-pr",
      "github-repo",
    ]);
    // Decision 14: a comments page as well as the front page.
    expect(
      SITES.some((/** @type {any} */ s) => s.url.startsWith("https://news.ycombinator.com/item?")),
    ).toBe(true);
    expect(SITES).toHaveLength(25);
  });
});

describe("validateSites", () => {
  it("rejects a non-array", () => {
    expect(validateSites({})).toEqual(["the site list must be an array"]);
  });

  it("names each problem with the entry", () => {
    const errors = validateSites([
      { id: "a", name: "A", url: "https://a.example/" },
      { id: "a", name: "A2", url: "http://b.example/" },
      { id: "Bad id", name: "", url: "nope", colour: "red" },
      { id: "c", name: "C", url: "https://c.example/", search: 3, find: "two words" },
    ]);
    expect(errors).toEqual([
      "entry 1 (a): duplicate id",
      "entry 1 (a): url must be https",
      "entry 2 (Bad id): id must be lowercase letters, digits and dashes",
      "entry 2 (Bad id): name must be a non-empty string",
      "entry 2 (Bad id): url must be https",
      "entry 2 (Bad id): unknown field colour",
      "entry 3 (c): search must be a CSS selector string",
      "entry 3 (c): find must be one word of letters and digits",
    ]);
  });
});

describe("filterSites", () => {
  const list = [
    { id: "github-repo", name: "GitHub repo", url: "https://github.com/x" },
    { id: "github-pr", name: "GitHub PR", url: "https://github.com/x/pull/1" },
    { id: "mdn", name: "MDN", url: "https://developer.mozilla.org/" },
  ];

  it("keeps every site without a filter", () => {
    expect(filterSites(list, undefined)).toHaveLength(3);
  });

  it("matches ids or names containing any comma-separated term, case-insensitively", () => {
    expect(filterSites(list, "github").map((s) => s.id)).toEqual(["github-repo", "github-pr"]);
    expect(filterSites(list, "PR,mdn").map((s) => s.id)).toEqual(["github-pr", "mdn"]);
  });
});
