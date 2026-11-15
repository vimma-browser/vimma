/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jarModules, moduleTypes } from "../gen-mochitest-modules.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OUT = new URL("../../types/mochitest/modules.d.ts", import.meta.url);

/** The chrome://browser/content/vimma/ module URLs the JavaScript under tests/ imports. */
function importedUrls(): string[] {
  const urls = new Set<string>();
  const files = readdirSync(join(ROOT, "tests"), { recursive: true, encoding: "utf8" });
  for (const file of files.filter((f) => f.endsWith(".js"))) {
    const text = readFileSync(join(ROOT, "tests", file), "utf8");
    for (const m of text.matchAll(
      /importESModule\(\s*["'](chrome:\/\/browser\/content\/vimma\/[^"']+\.mjs)["']/g,
    )) {
      urls.add(m[1] ?? "");
    }
  }
  return [...urls].sort();
}

// The browser tests import Vimma's modules by chrome:// URL; types/mochitest/modules.d.ts maps
// each URL to its source module, so ChromeUtils.importESModule gives a test the product's own
// types (npm run gen-mochitest-modules).
describe("types/mochitest/modules.d.ts (#959)", () => {
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
    const missing = importedUrls().filter((url) => !file.includes(`"${url}":`));
    expect(missing).toEqual([]);
    expect(importedUrls().length).toBeGreaterThan(50);
  });

  it("is what jar.mn and vimma-core lay out: run npm run gen-mochitest-modules after a move", async () => {
    expect(readFileSync(OUT, "utf8")).toBe(await moduleTypes());
  }, 60_000);
});
