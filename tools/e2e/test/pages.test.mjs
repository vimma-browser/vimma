// The fixture pages server: scenarios open `fixture:<name>` and get an http://127.0.0.1 page
// from tests/e2e/fixtures/, i.e. a web content process with the default sandbox (a file: URL
// would load in the file process, which may read any file and so hides sandbox problems).
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { PAGE_PORT, fixtureText, fixtureUrl, pagePort, startPageServer } from "../pages.mjs";

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

  it("serves a PDF as application/pdf, so it opens in the PDF viewer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vimma-pages-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "doc.pdf"), "%PDF-1.4");
    const server = await startPageServer(dir);
    cleanups.push(() => server.close());
    const res = await fetch(`${server.base}doc.pdf`);
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });
});

// Issue #953: the URL and status bars show the page server's port, so the e2e scenarios serve
// their fixtures on one fixed port: two runs then draw the same pixels.
describe("the page server's port", () => {
  it("is fixed, below Linux's ephemeral range, so the kernel never hands it to another socket", () => {
    expect(Number.isInteger(PAGE_PORT)).toBe(true);
    expect(PAGE_PORT).toBeGreaterThan(1024);
    expect(PAGE_PORT).toBeLessThan(32768);
  });

  it("is PAGE_PORT unless --port or VIMMA_E2E_PORT names another (the flag first)", () => {
    expect(pagePort({ flag: undefined, env: {} })).toBe(PAGE_PORT);
    expect(pagePort({ flag: undefined, env: { VIMMA_E2E_PORT: "8123" } })).toBe(8123);
    expect(pagePort({ flag: "9000", env: { VIMMA_E2E_PORT: "8123" } })).toBe(9000);
    expect(pagePort({ flag: "0", env: {} })).toBe(0);
  });

  // As VIMMA_E2E_BUILD: an empty variable is an unset one (an empty --port stays an error).
  it("takes an empty VIMMA_E2E_PORT as unset", () => {
    expect(pagePort({ flag: undefined, env: { VIMMA_E2E_PORT: "" } })).toBe(PAGE_PORT);
  });

  it.each(["", "x", "-1", "65536", "80.5", " 80"])("refuses %j as a port", (bad) => {
    expect(() => pagePort({ flag: bad, env: {} })).toThrow(/--port/);
    if (bad === "") return;
    expect(() => pagePort({ flag: undefined, env: { VIMMA_E2E_PORT: bad } })).toThrow(
      /VIMMA_E2E_PORT/,
    );
  });

  it("listens on the port it is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vimma-pages-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const probe = await startPageServer(dir);
    const port = Number(new URL(probe.base).port);
    await probe.close();
    const server = await startPageServer(dir, { port });
    cleanups.push(() => server.close());
    expect(server.base).toBe(`http://127.0.0.1:${port}/`);
  });

  it("fails, naming the port, when another process holds it, and never moves to another", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vimma-pages-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const other = createServer();
    await new Promise((resolve) => other.listen(0, "127.0.0.1", () => resolve(undefined)));
    cleanups.push(() => new Promise((resolve) => other.close(() => resolve(undefined))));
    const address = other.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await expect(startPageServer(dir, { port })).rejects.toMatchObject({
      code: "EADDRINUSE",
      message: expect.stringContaining(`127.0.0.1:${port}`),
    });
  });
});
