// Issue #16: the third-party code Vimma vendors ships its notice in about:license, which is in
// omni.ja and so in every release artefact (tarball, AppImage, .deb, AUR). The page is Firefox's
// toolkit/content/license.html.mako, rendered with the product-specific blocks that
// src/browser/base/moz-build.patch passes in from our licence/*.html.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const LICENCE_DIR = "browser/base/content/vimma/licence";
const SMOL = join(ROOT, "packages/vimma-core/src/vendor/smol-toml");

/** @param {string} s */
const squash = (s) => s.replace(/\s+/g, " ").trim();

/** @param {string} path relative to the repository */
const read = (path) => readFileSync(join(ROOT, path), "utf8");

describe("about:license notices", () => {
  it("moz-build.patch passes the product-specific licence blocks to license.html, in order", () => {
    // Firefox 158 renders about:license with toolkit/content/gen_license_html.py, which takes the
    // app blocks as extra GENERATED_FILES inputs after app-license.html, in its APP_BLOCKS order:
    // list, body, product name (they were #includesubst DEFINES up to Firefox 157).
    const patch = read("src/browser/base/moz-build.patch");
    const files = ["list.html", "body.html", "product-name.html"];
    const lines = [
      ' "content/overrides/app-license.html",',
      ...files.map((file) => `+    "content/vimma/licence/${file}",`),
    ];
    expect(patch).toContain(lines.join("\n"));
    for (const file of files) {
      expect(existsSync(join(ROOT, "src", LICENCE_DIR, file)), file).toBe(true);
    }
  });

  it("lists smol-toml with its full LICENSE, version, file and that the copy is modified", () => {
    const list = read(`src/${LICENCE_DIR}/list.html`);
    expect(list).toContain('<a href="about:license#smol-toml">');
    const body = read(`src/${LICENCE_DIR}/body.html`);
    expect(body).toContain('<h1><a id="smol-toml"></a>');
    const pre = /<pre>([\s\S]*?)<\/pre>/.exec(body)?.[1] ?? "";
    expect(squash(pre)).toBe(squash(readFileSync(join(SMOL, "LICENSE"), "utf8")));

    const version = /Vendored for vimma: smol-toml (\S+), generated/.exec(
      readFileSync(join(SMOL, "smol-toml.mjs"), "utf8"),
    )?.[1];
    expect(version).toBeTruthy();
    expect(body).toContain(`smol-toml ${version}`);
    expect(body).toContain("chrome://browser/content/vimma/core/vendor/smol-toml/smol-toml.mjs");
    expect(body).toMatch(/modified/);
  });

  it("the vendored file's header says it is modified, and the generator writes that line", () => {
    const head = readFileSync(join(SMOL, "smol-toml.mjs"), "utf8").split("\n").slice(0, 40);
    const line = head.find((l) => l.startsWith("// Modified for vimma:"));
    expect(line).toBeTruthy();
    expect(read("tools/vendor-smol-toml.ts")).toContain("// Modified for vimma:");
  });
});
