// Vimma's brandings.ftl is generated from upstream's (spec firefox-surfaces-trim, "Product names"):
// tools/branding/brandings.ts renames the features Vimma ships as its own and keeps Mozilla's
// products. The generated file must match what the generator makes from the engine's upstream
// copy, and every upstream term that says Firefox or Mozilla must be decided by the mapping, so a
// Firefox bump surfaces a new name instead of shipping it. The upstream copy needs engine/: the
// e2e workflow reads it before `npm run import` (BRANDINGS_REQUIRE_UPSTREAM=1 forbids the skip
// there); the plain CI job has no engine/ and skips those checks.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GENERATED, KEEP, RENAME, generate, readUpstream, undecidedTerms } from "../brandings.ts";

const FIXTURE = `# License header.

## Group comment.

-relay-brand-name = Firefox Relay
-firefox-suggest-brand-name = Firefox Suggest
-pocket-brand-name = Pocket
-firefoxview-brand-name = Firefox View
-firefoxlabs-brand-name = Firefox Labs
-translations-brand-name = Firefox Translations
-screenshots-brand-name = Firefox Screenshots

# “Home” can be localized.
-firefox-home-brand-name = Firefox Home

-smart-window-brand-name =
    { $plural-form ->
        [true] Smart Windows
       *[false] Smart Window
    }
`;

describe("generate", () => {
  it("renames the features Vimma ships and keeps everything else as upstream has it", () => {
    const out = generate(FIXTURE);
    expect(out).toContain("-firefox-suggest-brand-name = Address Bar Suggestions\n");
    expect(out).toContain("-firefox-home-brand-name = Start Page\n");
    expect(out).toContain("-relay-brand-name = Firefox Relay\n");
    expect(out).toContain("-pocket-brand-name = Pocket\n");
    expect(out).toContain("       *[false] Smart Window\n");
    expect(out).toContain("# “Home” can be localized.\n");
  });

  it("says the file is generated, after the licence header", () => {
    const out = generate(FIXTURE);
    expect(out.startsWith("# License header.\n")).toBe(true);
    expect(out).toContain("npm run gen-brandings");
  });

  it("refuses an upstream term that says Firefox or Mozilla and the mapping does not decide", () => {
    const text = `${FIXTURE}-firefox-new-thing-brand-name = Firefox New Thing\n`;
    expect(undecidedTerms(text)).toEqual(["-firefox-new-thing-brand-name"]);
    expect(() => generate(text)).toThrow(/-firefox-new-thing-brand-name/);
  });

  it("refuses a renamed term that upstream no longer has", () => {
    const text = FIXTURE.replace("-firefox-home-brand-name = Firefox Home\n", "");
    expect(() => generate(text)).toThrow(/-firefox-home-brand-name/);
  });

  it("decides each term once", () => {
    const both = Object.keys(RENAME).filter((t) => KEEP.includes(t));
    expect(both).toEqual([]);
  });

  it("renames to names that name neither Firefox nor Mozilla", () => {
    for (const value of Object.values(RENAME)) expect(value).not.toMatch(/Firefox|Mozilla/);
  });
});

describe("the generated file", () => {
  it("is committed with the renamed features", () => {
    const text = readFileSync(GENERATED, "utf8");
    for (const [term, value] of Object.entries(RENAME)) {
      expect(text).toContain(`${term} = ${value}\n`);
    }
  });

  const upstream = readUpstream();
  if (upstream === null) {
    if (process.env.BRANDINGS_REQUIRE_UPSTREAM === "1") {
      it("finds upstream's brandings.ftl", () => {
        expect.fail("upstream brandings.ftl is unreadable (engine/ missing or already imported)");
      });
    } else {
      console.warn("brandings: upstream checks skipped, engine/ has no upstream brandings.ftl");
    }
  }

  it.skipIf(upstream === null)("decides every Firefox or Mozilla term upstream has", () => {
    expect(undecidedTerms(upstream as string)).toEqual([]);
  });

  it.skipIf(upstream === null)("is current (run npm run gen-brandings after a bump)", () => {
    expect(existsSync(GENERATED)).toBe(true);
    expect(readFileSync(GENERATED, "utf8")).toBe(generate(upstream as string));
  });
});
