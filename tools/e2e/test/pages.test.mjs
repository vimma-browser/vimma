// The fixture pages server: scenarios open `fixture:<name>` and get an http://127.0.0.1 page
// from tests/e2e/fixtures/, i.e. a web content process with the default sandbox (a file: URL
// would load in the file process, which may read any file and so hides sandbox problems).
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureText, fixtureUrl, startPageServer } from "../pages.mjs";

/** @type {Array<() => unknown>} */
const cleanups = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe("fixtureUrl", () => {
  it("maps fixture:<name> onto the server and leaves other URLs alone", () => {
    expect(fixtureUrl("fixture:input.html", "http://127.0.0.1:9/")).toBe(
      "http://127.0.0.1:9/input.html",
    );
    expect(fixtureUrl("about:blank", "http://127.0.0.1:9/")).toBe("about:blank");
  });

  it("keeps a #fragment, which the page reads and the server never sees", () => {
    expect(fixtureUrl("fixture:cookie.html#work", "http://127.0.0.1:9/")).toBe(
      "http://127.0.0.1:9/cookie.html#work",
    );
    expect(() => fixtureUrl("fixture:cookie.html#a b", "http://h/")).toThrow(/fixture name/);
    expect(() => fixtureUrl("fixture:#x", "http://h/")).toThrow(/fixture name/);
  });

  it("refuses names that are not one plain file", () => {
    expect(() => fixtureUrl("fixture:../x.html", "http://h/")).toThrow(/fixture name/);
    expect(() => fixtureUrl("fixture:", "http://h/")).toThrow(/fixture name/);
    expect(() => fixtureUrl("fixture:a/b.html", "http://h/")).toThrow(/fixture name/);
  });

  it("needs a running server for a fixture", () => {
    expect(() => fixtureUrl("fixture:input.html", null)).toThrow(/server/);
  });
});

describe("fixtureText", () => {
  it("maps every fixture:<name> in a text onto the server, up to a space or ]", () => {
    expect(
      fixtureText("[[open fixture:shop.html]] [[open fixture:a.html#x]] b", "http://h:9/"),
    ).toBe("[[open http://h:9/shop.html]] [[open http://h:9/a.html#x]] b");
    expect(fixtureText("no fixtures here", null)).toBe("no fixtures here");
    expect(() => fixtureText("[[open fixture:../x]]", "http://h/")).toThrow(/fixture name/);
  });
});

describe("startPageServer", () => {
  it("serves the directory's files on 127.0.0.1 and 404s anything else", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vimma-pages-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "a.html"), "<p>hi</p>");
    const server = await startPageServer(dir);
    cleanups.push(() => server.close());
    expect(server.base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const ok = await fetch(`${server.base}a.html`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/text\/html/);
    expect(await ok.text()).toBe("<p>hi</p>");
    expect((await fetch(`${server.base}missing.html`)).status).toBe(404);
    expect((await fetch(`${server.base}..%2Fetc%2Fpasswd`)).status).toBe(404);
  });
});
