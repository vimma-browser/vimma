import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { featurePrefDefaults, featurePrefFallbacks, listSourceFiles } from "./feature-prefs.mjs";

// docs/specs/firefox-versions.md, decision 16: main stays releasable because a Firefox security
// bump can release it with no person in the loop. A feature merged in parts lands behind
// pref("vimma.feature.<name>", false) until the sub-PR that finishes it removes the pref.
const brandingUrl = new URL(
  "../../src/browser/branding/vimma/pref/firefox-branding.js",
  import.meta.url,
);
const vimmaDir = new URL("../../src/browser/base/content/vimma/", import.meta.url);

describe("featurePrefDefaults", () => {
  it("reads each vimma.feature.* default with its line", () => {
    const text = [
      'pref("vimma.startpage.newtab", true);',
      'pref("vimma.feature.tiling", false);',
      'pref( "vimma.feature.mcp" , true );',
    ].join("\n");
    expect(featurePrefDefaults(text)).toEqual([
      { name: "vimma.feature.tiling", value: "false", line: 2 },
      { name: "vimma.feature.mcp", value: "true", line: 3 },
    ]);
  });

  it("keeps a default that is not a literal so the check can reject it", () => {
    expect(featurePrefDefaults('pref("vimma.feature.x", "false");')[0]?.value).toBe('"false"');
    expect(featurePrefDefaults('pref("vimma.feature.x", 0);')[0]?.value).toBe("0");
  });

  it("finds sticky_pref and lockPref definitions too", () => {
    const text = 'sticky_pref("vimma.feature.a", true);\nlockPref("vimma.feature.b", true);';
    expect(featurePrefDefaults(text).map((p) => p.name)).toEqual([
      "vimma.feature.a",
      "vimma.feature.b",
    ]);
  });

  it("ignores a commented-out line", () => {
    expect(featurePrefDefaults('// pref("vimma.feature.x", true);')).toEqual([]);
  });
});

describe("featurePrefFallbacks", () => {
  it("finds a getBoolPref read of a vimma.feature.* pref whose fallback is true", () => {
    const text = [
      'Services.prefs.getBoolPref("vimma.feature.a", false);',
      'Services.prefs.getBoolPref("vimma.feature.b", true);',
      'Services.prefs.getBoolPref(\n  "vimma.feature.c",\n  true,\n);',
    ].join("\n");
    expect(featurePrefFallbacks(text)).toEqual(["vimma.feature.b", "vimma.feature.c"]);
  });
});

describe("vimma.feature.* prefs on main", () => {
  it("every vimma.feature.* pref defaults to false", () => {
    const text = readFileSync(brandingUrl, "utf8");
    const notOff = featurePrefDefaults(text).filter((p) => p.value !== "false");
    expect(notOff).toEqual([]);
  });

  it("no vimma.feature.* read falls back to true when the pref is missing", () => {
    const found = listSourceFiles(vimmaDir).flatMap((file) =>
      featurePrefFallbacks(readFileSync(file, "utf8")).map((name) => `${file.pathname}: ${name}`),
    );
    expect(found).toEqual([]);
  });
});
