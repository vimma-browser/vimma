import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { MAINTAINER, REPO, SITE_REPO } from "../repo.mjs";

// tools/repo.mjs names the canonical repository once. Every workflow guard, the site dispatch
// and the maintainer gate must agree with it, so a move cannot leave one job silently skipped.
const dir = new URL("../../.github/workflows/", import.meta.url);
const workflows = readdirSync(dir)
  .filter((f) => f.endsWith(".yml"))
  .map((f) => /** @type {[string, string]} */ ([f, readFileSync(new URL(f, dir), "utf8")]));

describe("canonical repository", () => {
  it("every github.repository guard names REPO", () => {
    const guards = workflows.flatMap(([f, text]) =>
      [...text.matchAll(/github\.repository == '([^']*)'/g)].map((m) => `${f}: ${m[1]}`),
    );
    expect(guards.length).toBeGreaterThan(10);
    for (const g of guards) expect(g).toMatch(new RegExp(`: ${REPO.replace("/", "\\/")}$`));
  });

  it("the site dispatch targets SITE_REPO", () => {
    const text = readFileSync(new URL("site-dispatch.yml", dir), "utf8");
    expect(text).toContain(`repos/${SITE_REPO}/dispatches`);
  });

  it("no workflow treats the organization as a person", () => {
    for (const [f, text] of workflows) {
      expect(text, f).not.toContain("sender.login == github.repository_owner");
      expect(text, f).not.toMatch(/OWNER: \$\{\{ github\.repository_owner \}\}/);
    }
    const claude = readFileSync(new URL("claude.yml", dir), "utf8");
    expect(claude).toContain(`github.event.sender.login == '${MAINTAINER}'`);
    const owners = workflows.flatMap(([, text]) => [...text.matchAll(/^ +OWNER: (\S+)/gm)]);
    expect(owners.length).toBe(4); // upstream-beta.yml; upstream.yml's track, key, drift
    for (const m of owners) expect(m[1]).toBe(MAINTAINER);
  });

  // Files outside the workflows that state the repository's URL for users or for signing.
  it.each([
    "configs/common/mozconfig",
    "src/browser/branding/vimma/pref/firefox-branding.js",
    "tools/vimma-ctl/Cargo.toml",
    "README.md",
  ])("%s links the canonical repository", (path) => {
    const text = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    expect(text).toContain(`github.com/${REPO}`);
  });

  it("the release signing identity is the canonical repository's release.yml", () => {
    const text = readFileSync(new URL("../package/package.mjs", import.meta.url), "utf8");
    expect(text).toContain(`"^https://github\\\\.com/${REPO}/\\\\.github/workflows/release`);
  });

  it("no workflow names the repository's former path", () => {
    for (const [f, text] of workflows) expect(text, f).not.toMatch(/JRanne\/vimma/);
  });
});
