/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Issue #245: a pull request that changes only Markdown skips vitest, the mochitests and e2e.
// tools/ci/docs-only.mjs decides; ci.yml and e2e.yml gate their heavy steps and jobs on its
// answer, and keep every check that reads Markdown running. CodeQL and Semgrep always run.

import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../test/temp-dir.mjs";
import { GENERATED_MARKDOWN, MARKDOWN_TESTS, classify, isDocsOnly } from "../docs-only.mjs";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../docs-only.mjs", import.meta.url));

describe("isDocsOnly", () => {
  it.each([
    [["README.md"]],
    [["docs/guide.md", "docs/specs/x.md", "CHANGELOG.md", "CONTRIBUTING.md"]],
    [["docs/adr/011-vimma-ctl.md"]],
  ])("%j is docs-only", (files) => {
    expect(isDocsOnly(files)).toEqual({ docsOnly: true, reason: expect.any(String) });
  });

  it.each([
    [["docs/guide.md", "src/browser/base/content/vimma/host/VimmaHost.sys.mjs"], "src/"],
    [["docs/guide.md", "package.json"], "package.json"],
    [["docs/guide.md", ".github/workflows/ci.yml"], ".github/workflows/ci.yml"],
    [["docs/guide.md", "tools/ci/docs-only.mjs"], "tools/ci/docs-only.mjs"],
    [["docs/bindings.md"], "docs/bindings.md"],
    [["docs/guide.md", "docs/bindings.json"], "docs/bindings.json"],
    [["tools/upstream/fixtures/patch-audit/adr.md"], "tools/"],
    [["tools/package/vendor/README.md"], "tools/"],
    [["packages/vimma-core/src/vendor/smol-toml/README.md"], "packages/"],
    [[".github/pull_request_template.md"], ".github/"],
    [["tests/e2e/notes.md"], "tests/"],
    [["src/notes.md"], "src/"],
    [["docs/guide.MD"], "docs/guide.MD"],
    [["docs/notes.md.mjs"], "docs/notes.md.mjs"],
  ])("%j is not docs-only (names %s)", (files, named) => {
    const result = isDocsOnly(files);
    expect(result.docsOnly).toBe(false);
    expect(result.reason).toContain(named);
  });

  it("an empty change runs everything", () => {
    expect(isDocsOnly([]).docsOnly).toBe(false);
  });

  it("treats every generated Markdown file as code", () => {
    expect(GENERATED_MARKDOWN).toContain("docs/bindings.md");
    for (const file of GENERATED_MARKDOWN) expect(isDocsOnly([file]).docsOnly).toBe(false);
  });

  it("knows every tracked Markdown file that says it is generated", () => {
    const tracked = execFileSync("git", ["ls-files", "-z", "*.md"], { cwd: ROOT, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
    const generated = tracked.filter((f) =>
      /^Generated from .*do not edit/m.test(readFileSync(join(ROOT, f), "utf8")),
    );
    expect(generated.length).toBeGreaterThan(0);
    for (const file of generated) expect(GENERATED_MARKDOWN).toContain(file);
  });
});

describe("classify", () => {
  const docs = ["docs/guide.md"];

  it("a pull request with only Markdown is docs-only", () => {
    expect(classify({ event: "pull_request", files: docs }).docsOnly).toBe(true);
  });

  it.each(["push", "schedule", "workflow_dispatch", "workflow_call", "pull_request_target", ""])(
    "a %s run runs everything, whatever changed",
    (event) => {
      const result = classify({ event, files: docs });
      expect(result.docsOnly).toBe(false);
      expect(result.reason).toContain("pull_request");
    },
  );
});

describe("MARKDOWN_TESTS", () => {
  /** @param {string} dir @returns {string[]} */
  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (name === "node_modules" || name === "fixtures") return [];
      return statSync(path).isDirectory() ? walk(path) : [path];
    });

  it("lists every Vitest file that reads a Markdown file of the repo", () => {
    const tests = [...walk(join(ROOT, "packages")), ...walk(join(ROOT, "tools"))]
      .filter((p) => p.endsWith(".test.mjs"))
      .map((p) => relative(ROOT, p));
    const readers = tests.filter((p) =>
      /new URL\(\s*["'`](?:\.\.\/)+[^"'`]+\.md["'`]/.test(readFileSync(join(ROOT, p), "utf8")),
    );
    expect(readers.length).toBeGreaterThan(0);
    expect([...MARKDOWN_TESTS].sort()).toEqual(readers.sort());
  });
});

describe("the command line", () => {
  /** @param {string} cwd @param {string[]} args */
  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  const GIT_ENV = {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };

  /** A repo with a base commit and a head commit from `change`. */
  function repo(/** @type {(dir: string) => void} */ change) {
    const dir = tempDir("vimma-docs-only-");
    git(dir, "init", "-q", "-b", "main");
    mkdirSync(join(dir, "docs"));
    mkdirSync(join(dir, "tools"));
    writeFileSync(join(dir, "docs", "guide.md"), "# Guide\n");
    writeFileSync(join(dir, "tools", "run.mjs"), "console.log(1);\n".repeat(20));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    const base = git(dir, "rev-parse", "HEAD").trim();
    change(dir);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "head");
    const head = git(dir, "rev-parse", "HEAD").trim();
    return { dir, base, head };
  }

  /** @param {{dir: string, base: string, head: string}} r @param {string} event */
  function run(r, event = "pull_request") {
    const output = join(tempDir("vimma-docs-only-out-"), "github-output");
    writeFileSync(output, "");
    const res = spawnSync(
      process.execPath,
      [SCRIPT, "--event", event, "--base", r.base, "--head", r.head],
      { cwd: r.dir, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output } },
    );
    const written = readFileSync(output, "utf8");
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, written };
  }

  it("writes docs-only=true for a Markdown-only pull request", () => {
    const r = repo((dir) => writeFileSync(join(dir, "docs", "guide.md"), "# Guide\n\nMore.\n"));
    const res = run(r);
    expect(res.status).toBe(0);
    expect(res.written).toBe("docs-only=true\n");
  });

  it("writes docs-only=false when code changed too", () => {
    const r = repo((dir) => {
      writeFileSync(join(dir, "docs", "guide.md"), "# Guide\n\nMore.\n");
      writeFileSync(join(dir, "tools", "run.mjs"), "console.log(2);\n");
    });
    const res = run(r);
    expect(res.status).toBe(0);
    expect(res.written).toBe("docs-only=false\n");
    expect(res.stdout).toContain("tools/run.mjs");
  });

  it("sees a file renamed to Markdown as the code file it was", () => {
    const r = repo((dir) => git(dir, "mv", "tools/run.mjs", "docs/run.md"));
    expect(run(r).written).toBe("docs-only=false\n");
  });

  it("writes docs-only=false for a push", () => {
    const r = repo((dir) => writeFileSync(join(dir, "docs", "guide.md"), "# Guide\n\nMore.\n"));
    expect(run(r, "push").written).toBe("docs-only=false\n");
  });

  it("refuses a base or head that is not a commit hash", () => {
    const r = repo((dir) => writeFileSync(join(dir, "docs", "guide.md"), "x\n"));
    const res = spawnSync(
      process.execPath,
      [SCRIPT, "--event", "pull_request", "--base", "HEAD~1", "--head", r.head],
      { cwd: r.dir, encoding: "utf8" },
    );
    expect(res.status).not.toBe(0);
  });
});

describe("workflow wiring", () => {
  /** @param {string} name */
  const workflow = (name) => readFileSync(join(ROOT, ".github", "workflows", name), "utf8");

  /** @param {string} text @param {string} id */
  function job(text, id) {
    const body = text.slice(text.indexOf("\njobs:\n") + 7);
    const parts = body.split(/^ {2}([a-z][a-z0-9-]*):\n/m).slice(1);
    for (let i = 0; i < parts.length; i += 2) if (parts[i] === id) return parts[i + 1] ?? "";
    throw new Error(`no job ${id}`);
  }

  /** The steps of a job block, each with its name and its `if:` (or ""). */
  function steps(/** @type {string} */ block) {
    return block
      .split(/^ {6}- /m)
      .slice(1)
      .map((s) => ({
        name: /(?:^|\n {8})name: (.*)/.exec(s)?.[1] ?? /(?:^|\n {8})uses: (.*)/.exec(s)?.[1] ?? "",
        cond: /\n {8}if: (.*)/.exec(s)?.[1] ?? "",
        text: s,
      }));
  }

  /** @param {string} block */
  const jobIf = (block) => /^ {4}if: (.*)/m.exec(block)?.[1] ?? "";

  /** The classifier job: least privilege, the script from the base, never from the PR. */
  function expectChangesJob(/** @type {string} */ text) {
    const changes = job(text, "changes");
    expect(changes).toMatch(/^ {4}permissions:\n {6}contents: read\n/m);
    expect(changes).toContain("persist-credentials: false");
    expect(changes).toContain("docs-only: ${{ steps.classify.outputs.docs-only }}");
    expectClassifyStep(changes);
  }

  /** @param {string} block */
  function expectClassifyStep(block) {
    const step = steps(block).find((s) => s.text.includes("id: classify"));
    expect(step?.cond).toBe("github.event_name == 'pull_request'");
    expect(step?.text).toContain('git show "$BASE:tools/ci/docs-only.mjs"');
    expect(step?.text).toContain("BASE: ${{ github.event.pull_request.base.sha }}");
    expect(step?.text).toContain("HEAD: ${{ github.event.pull_request.head.sha }}");
    expect(step?.text).not.toMatch(/node tools\/ci\/docs-only\.mjs/);
  }

  const RUNS = "needs.changes.outputs.docs-only != 'true'";

  it("e2e.yml: the mochitest job runs unless the change is docs-only", () => {
    const text = workflow("e2e.yml");
    expectChangesJob(text);
    const mochitest = job(text, "mochitest");
    expect(mochitest).toMatch(/^ {4}name: mochitest \(artifact build\)$/m);
    expect(mochitest).toMatch(/^ {4}needs: changes$/m);
    // !cancelled(), not success(): a failed classifier runs the job instead of skipping it.
    // A draft pull request skips it too (issue #443, tools/test/draft-pull-requests.test.mjs).
    expect(jobIf(mochitest)).toBe(
      `\${{ !cancelled() && ${RUNS} && github.event.pull_request.draft != true }}`,
    );
  });

  // Not gated: the ruleset's code scanning rule waits for CodeQL results on every pull request,
  // so a docs-only one without an analysis stays blocked (draft PR #249, mergeStateStatus
  // BLOCKED with every required check green).
  it.each(["codeql.yml", "semgrep.yml"])("%s is not gated", (name) => {
    expect(workflow(name)).not.toContain("outputs.docs-only");
  });

  it("ci.yml: Markdown checks run on every change, the rest unless docs-only", () => {
    const text = workflow("ci.yml");
    const check = job(text, "check");
    expect(check).toMatch(/^ {4}name: lint, typecheck, test, commitlint, licences$/m);
    expect(text).toMatch(/^permissions:\n {2}contents: read\n/m);
    expectClassifyStep(check);
    const SKIP = "steps.classify.outputs.docs-only != 'true'";
    const all = steps(check);
    /** @param {RegExp} re */
    const step = (re) => {
      const found = all.find((s) => re.test(s.text));
      if (!found) throw new Error(`no step matching ${re}`);
      return found;
    };
    // Every change: these read Markdown, or are cheap and format-only.
    for (const re of [
      /npx --no -- prettier --check \./,
      /npm run security-links/,
      /npm run test:py/,
      /npm run gen-docs/,
      /npx --no -- commitlint --from "\$FROM"/,
    ])
      expect(step(re).cond).not.toContain("docs-only");
    // Docs-only: the Vitest files that read Markdown, instead of the whole suite.
    expect(step(/--markdown-tests/).cond).toBe("steps.classify.outputs.docs-only == 'true'");
    // Everything else skips on a docs-only change.
    for (const re of [
      /npx --no -- eslint \./,
      /npm run typecheck/,
      /npm run coverage/,
      /npm run bench/,
      /npm run license-check$/m,
      /cargo fmt --check/,
      /cargo clippy --locked/,
      /cargo test --locked/,
      /npm run license-check:crates/,
      /npx --no -- surfer license-check/,
    ])
      expect(step(re).cond).toBe(SKIP);
  });

  it("ci.yml: vimma-ctl's clippy and tests also run on macOS, unless docs-only", () => {
    const text = workflow("ci.yml");
    const mac = job(text, "vimma-ctl-macos");
    expect(mac).toMatch(/^ {4}runs-on: macos-15$/m);
    expect(mac).toMatch(/^ {4}needs: covered$/m);
    expect(jobIf(mac)).toBe("${{ !cancelled() && needs.covered.outputs.skip != 'true' }}");
    expect(mac).toMatch(/^ {4}permissions:\n {6}contents: read\n(?! {6})/m);
    expect(mac).toContain("persist-credentials: false");
    expectClassifyStep(mac);
    const SKIP = "steps.classify.outputs.docs-only != 'true'";
    const all = steps(mac);
    for (const re of [/rustup toolchain install/, /cargo clippy --locked/, /cargo test --locked/]) {
      const found = all.find((s) => re.test(s.text));
      expect(found?.cond, String(re)).toBe(SKIP);
      expect(found?.text).toContain("working-directory: tools/vimma-ctl");
    }
  });
});
