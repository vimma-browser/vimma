/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jarModules, moduleTypes } from "../gen-vimma-modules.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OUT = new URL("../../types/vimma-modules.d.ts", import.meta.url);
const FIREFOX = new URL("../../types/firefox-modules.d.ts", import.meta.url);

/**
 * The module URLs that the JavaScript under `dir` (relative to the repository) imports with
 * ChromeUtils.importESModule, each a literal string; `only` keeps the URLs that match it.
 */
function importedUrls(dir: string, only = /^/): string[] {
  const urls = new Set<string>();
  const files = readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" });
  for (const file of files.filter((f) => /\.(m?js)$/.test(f))) {
    const text = readFileSync(join(ROOT, dir, file), "utf8");
    for (const m of text.matchAll(/importESModule\(\s*["']([^"']+)["']/g)) {
      const url = m[1] ?? "";
      if (only.test(url)) urls.add(url);
    }
  }
  return [...urls].sort();
}

// Vimma's code imports its own modules by chrome:// URL; types/vimma-modules.d.ts maps each URL to
// its source module, so ChromeUtils.importESModule gives the importer the module's own types (npm
// run gen-vimma-modules). The Firefox modules the product imports are in
// types/firefox-modules.d.ts.
describe("types/vimma-modules.d.ts (#959, #938)", () => {
  it("reads the modules of a jar.mn, not its folders or other files", () => {
    const jar = [
      "browser.jar:",
      "        content/browser/vimma/vimma.js                    (vimma.js)",
      "        content/browser/vimma/host/VimmaHost.sys.mjs      (host/VimmaHost.sys.mjs)",
      "        content/browser/vimma/core                        (core/**/*.mjs)",
      "        content/browser/vimma/about/x.mjs                 (/browser/config/vimma/x.mjs)",
      "        skin/classic/browser/vimma/a.css                  (/browser/themes/shared/vimma/a.css)",
      "% override chrome://browser/skin/a.svg chrome://browser/skin/vimma/empty.svg",
    ].join("\n");
    expect([...jarModules(jar, "src/v")]).toEqual([
      ["host/VimmaHost.sys.mjs", "src/v/host/VimmaHost.sys.mjs"],
      ["about/x.mjs", "src/browser/config/vimma/x.mjs"],
    ]);
  });

  it("maps every Vimma module a test imports, so none is left `any`", async () => {
    const file = readFileSync(OUT, "utf8");
    const urls = importedUrls("tests", /^chrome:\/\/browser\/content\/vimma\//);
    expect(urls.filter((url) => !file.includes(`"${url}":`))).toEqual([]);
    expect(urls.length).toBeGreaterThan(50);
  });

  it("maps every module the product imports, Vimma's and Firefox's, so none is `unknown`", () => {
    const maps = readFileSync(OUT, "utf8") + readFileSync(FIREFOX, "utf8");
    const urls = [...importedUrls("src"), ...importedUrls("packages/vimma-core/src")];
    expect(urls.filter((url) => !maps.includes(`"${url}":`))).toEqual([]);
    expect(urls).toContain("resource://gre/modules/AppConstants.sys.mjs");
    expect(urls.length).toBeGreaterThan(30);
  });

  it("is what jar.mn and vimma-core lay out: run npm run gen-vimma-modules after a move", async () => {
    expect(readFileSync(OUT, "utf8")).toBe(await moduleTypes());
  }, 60_000);
});
