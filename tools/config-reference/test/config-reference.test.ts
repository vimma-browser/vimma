/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// docs/guide.md's config.toml reference is the :config template's own annotated lines (issue
// #1443), written there by npm run gen-docs, so the guide, the template and vimma.dev agree.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { configReferenceMarkdown, spliceConfigReference } from "../config-reference.ts";

const guide = () => readFileSync(new URL("../../../docs/guide.md", import.meta.url), "utf8");

describe("docs/guide.md's config.toml reference", () => {
  test("is the one npm run gen-docs writes", () => {
    expect(guide()).toBe(spliceConfigReference(guide()));
  });

  test("shows each setting as key = value in TOML blocks, with no tables", () => {
    const md = configReferenceMarkdown();
    expect(md).toContain("```toml\n[panes]\n");
    expect(md).toMatch(/^max_splits = 9 +# /m);
    expect(md).toMatch(/^write_back = "all" +# /m);
    expect(md).not.toMatch(/^\|/m);
  });

  test("shows [tabs] with tab sleep's defaults, linked to Sleeping tabs", () => {
    const md = configReferenceMarkdown();
    expect(md).toMatch(/^\[tabs\]\nsleep_after = 120 +# .*\nsleep_on_low_memory = true +# /m);
    expect(md).toContain("[Sleeping tabs](#sleeping-tabs)");
  });

  test("replaces only what lies between the reference's first heading and Search engines", () => {
    const text =
      "# A\n\nkept\n\n### Keys and modes\n\nOLD-TEXT\n\n### Search engines\n\nkept too\n";
    const out = spliceConfigReference(text);
    expect(out.startsWith("# A\n\nkept\n\n### Keys and modes\n")).toBe(true);
    expect(out).not.toContain("OLD-TEXT");
    expect(out.endsWith("\n### Search engines\n\nkept too\n")).toBe(true);
  });

  test("refuses a guide without the reference's headings", () => {
    expect(() => spliceConfigReference("# A\n")).toThrow(/### Keys and modes/);
  });
});
