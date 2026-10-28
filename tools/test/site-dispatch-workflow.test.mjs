import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// docs/security.md B14: site-dispatch.yml holds the vimma-site-dispatch app's key and a release
// event runs the tag's copy, so its token must reach vimma-site alone and nothing from the event
// may reach the shell but through env. Text checks, like sites-workflow.test.mjs: no YAML
// dependency.
const text = readFileSync(
  new URL("../../.github/workflows/site-dispatch.yml", import.meta.url),
  "utf8",
);

/** The `with:` block of the step that uses `action`. @param {string} action */
function withOf(action) {
  const start = text.indexOf(`uses: ${action}@`);
  if (start < 0) throw new Error(`no step uses ${action}`);
  const block = /\n {8}with:\n((?: {10}.+\n)+)/.exec(text.slice(start))?.[1] ?? "";
  return Object.fromEntries(
    [...block.matchAll(/^ {10}([\w-]+): (.+)$/gm)].map((m) => [m[1], m[2]?.trim()]),
  );
}

/** Every `run:` script's text, without the `run: |` line. */
function runScripts() {
  return [...text.matchAll(/\n( +)run: \|\n((?:\1 {2}.*\n|\n)+)/g)].map((m) => m[2] ?? "");
}

describe("site dispatch workflow (site-dispatch.yml)", () => {
  it("has no permission at the top level and no job asks for one", () => {
    expect(text).toMatch(/^permissions: \{\}$/m);
    expect(text.match(/^\s*permissions:/gm)).toHaveLength(1);
  });

  it("mints the app token for vimma-browser/vimma-site alone, with contents: write only", () => {
    const app = withOf("actions/create-github-app-token");
    expect(app).toEqual({
      "client-id": "${{ vars.SITE_DISPATCH_APP_ID }}",
      "private-key": "${{ secrets.SITE_DISPATCH_APP_KEY }}",
      owner: "vimma-browser",
      repositories: "vimma-site",
      "permission-contents": "write",
    });
  });

  it("holds the app's key and no other secret, and no personal token", () => {
    expect([...text.matchAll(/secrets\.(\w+)/g)].map((m) => m[1])).toEqual([
      "SITE_DISPATCH_APP_KEY",
    ]);
    expect(text).not.toContain("SITE_DISPATCH_TOKEN");
  });

  it("pins every action by full commit SHA and checks nothing out", () => {
    const uses = [...text.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
    expect(uses).toHaveLength(1);
    for (const use of uses) expect(use).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
    expect(text).not.toContain("actions/checkout");
  });

  it("sends the dispatch to vimma-site only", () => {
    const targets = [...text.matchAll(/repos\/([\w-]+\/[\w-]+)\//g)].map((m) => m[1]);
    expect(targets).toEqual(["vimma-browser/vimma-site"]);
  });

  it("passes the tag and every event value to run: through env only", () => {
    const scripts = runScripts();
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(script).not.toContain("${{");
    expect(text).toMatch(/^ {10}TAG: \$\{\{ github\.event\.release\.tag_name \}\}$/m);
  });

  it("without the app's ID, logs a notice and succeeds instead of failing", () => {
    expect(text).toMatch(/if: vars\.SITE_DISPATCH_APP_ID != ''/);
    const [script = ""] = runScripts();
    const guard = /if \[ -z "\$GH_TOKEN" \]; then\n(.*)\n(.*)\n/.exec(script);
    expect(guard?.[1]).toMatch(/echo "::notice::SITE_DISPATCH_APP_ID is not set;/);
    expect(guard?.[2]?.trim()).toBe("exit 0");
    expect(script.indexOf("exit 0")).toBeLessThan(script.indexOf("gh api"));
  });

  it("never runs for a pre-release or outside vimma-browser/vimma", () => {
    expect(text).toContain(
      "if: github.repository == 'vimma-browser/vimma' && !github.event.release.prerelease",
    );
  });
});
