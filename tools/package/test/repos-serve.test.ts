import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tempDir } from "../../test/temp-dir.ts";
import { matchRedirect, parseRedirects, serve } from "../repos-serve.ts";

// The smoke test's stand-in for the update host (spec package-repositories, decision 11): it
// reads the _redirects that repos.ts writes the way Cloudflare's static assets do, a rule before
// an asset, a placeholder for one path segment.
describe("parseRedirects and matchRedirect", () => {
  const rules = parseRedirects(
    "# comment\n/apt/pool/:tag/:file https://github.com/o/r/releases/download/:tag/:file 302\n\n" +
      "/arch/x86_64/a.pkg.tar.zst https://example.org/v1/a.pkg.tar.zst 302\n",
  );

  it("fills one path segment per placeholder", () => {
    expect(matchRedirect(rules, "/apt/pool/v0.1.0/vimma_0.1.0_amd64.deb")).toEqual({
      location: "https://github.com/o/r/releases/download/v0.1.0/vimma_0.1.0_amd64.deb",
      status: 302,
    });
    expect(matchRedirect(rules, "/apt/pool/v0.1.0/a/b.deb")).toBeUndefined();
    expect(matchRedirect(rules, "/apt/pool/v0.1.0/")).toBeUndefined();
  });

  it("matches a static rule exactly", () => {
    expect(matchRedirect(rules, "/arch/x86_64/a.pkg.tar.zst")?.location).toBe(
      "https://example.org/v1/a.pkg.tar.zst",
    );
    expect(matchRedirect(rules, "/arch/x86_64/a.pkg.tar.zst.sig")).toBeUndefined();
  });

  it("refuses a malformed rule", () => {
    expect(() => parseRedirects("/a\n")).toThrow(/rule/);
    expect(() => parseRedirects("/a /b 200\n")).toThrow(/status/);
  });
});

describe("serve", () => {
  it("redirects before it serves a file, serves files, and logs each request", async () => {
    const dir = tempDir("vimma-serve-");
    mkdirSync(join(dir, "apt/pool/v1"), { recursive: true });
    writeFileSync(join(dir, "apt/pool/v1/x.deb"), "shadowed");
    writeFileSync(join(dir, "apt/Release"), "release");
    writeFileSync(
      join(dir, "_redirects"),
      "/apt/pool/:tag/:file http://127.0.0.1:1/dl/:tag/:file 302\n",
    );
    const log: string[] = [];
    const server = await serve(dir, 0, (line) => log.push(line));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const r = await fetch(`${base}/apt/pool/v1/x.deb`, { redirect: "manual" });
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe("http://127.0.0.1:1/dl/v1/x.deb");
      // apt's request for a flat repository's `Suites: ./`, sent as written
      const dot = await new Promise<number | undefined>((resolve) =>
        get(`${base}/x`, { path: "/apt/./Release" }, (res) => {
          res.resume();
          resolve(res.statusCode);
        }),
      );
      expect(dot).toBe(200);
      const f = await fetch(`${base}/apt/Release`);
      expect(f.status).toBe(200);
      expect(await f.text()).toBe("release");
      expect((await fetch(`${base}/apt/missing`)).status).toBe(404);
      expect((await fetch(`${base}/apt/`)).status).toBe(404);
      // a raw request, which fetch would normalise
      const status = await new Promise<number | undefined>((resolve) =>
        get(`${base}/x`, { path: "/apt/../../etc/passwd" }, (res) => {
          res.resume();
          resolve(res.statusCode);
        }),
      );
      expect(status).toBe(404);
      expect(log).toEqual([
        "GET /apt/pool/v1/x.deb 302 http://127.0.0.1:1/dl/v1/x.deb",
        "GET /apt/./Release 200",
        "GET /apt/Release 200",
        "GET /apt/missing 404",
        "GET /apt/ 404",
        "GET /apt/../../etc/passwd 404",
      ]);
    } finally {
      server.close();
    }
  });
});
