/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Issue #245: a pull request that changes only Markdown skips vitest, the mochitests and e2e.
// tools/ci/docs-only.mjs decides; ci.yml and e2e.yml gate their heavy steps and jobs on its
// answer, and keep every check that reads Markdown running. CodeQL and Semgrep always run.

import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_SCHEMA, load } from "js-yaml";
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
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (name === "node_modules" || name === "fixtures") return [];
      return statSync(path).isDirectory() ? walk(path) : [path];
    });

  it("lists every Vitest file that reads a Markdown file of the repo", () => {
    const tests = [...walk(join(ROOT, "packages")), ...walk(join(ROOT, "tools"))]
      .filter((p) => /\.test\.(?:mjs|ts)$/.test(p))
      .map((p) => relative(ROOT, p));
    const readers = tests.filter((p) =>
      /new URL\(\s*["'`](?:\.\.\/)+[^"'`]+\.md["'`]/.test(readFileSync(join(ROOT, p), "utf8")),
    );
    expect(readers.length).toBeGreaterThan(0);
    expect([...MARKDOWN_TESTS].sort()).toEqual(readers.sort());
  });
});

describe("the command line", () => {
  const git = (cwd: string, ...args: string[]) =>
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
  function repo(change: (dir: string) => void) {
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

  function run(r: { dir: string; base: string; head: string }, event: string = "pull_request") {
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
  const workflow = (name: string) => readFileSync(join(ROOT, ".github", "workflows", name), "utf8");

  function job(text: string, id: string) {
    const body = text.slice(text.indexOf("\njobs:\n") + 7);
    const parts = body.split(/^ {2}([a-z][a-z0-9-]*):\n/m).slice(1);
    for (let i = 0; i < parts.length; i += 2) if (parts[i] === id) return parts[i + 1] ?? "";
    throw new Error(`no job ${id}`);
  }

  /** The steps of a job block, each with its name and its `if:` (or ""). */
  function steps(block: string) {
    return block
      .split(/^ {6}- /m)
      .slice(1)
      .map((s) => ({
        name: /(?:^|\n {8})name: (.*)/.exec(s)?.[1] ?? /(?:^|\n {8})uses: (.*)/.exec(s)?.[1] ?? "",
        cond: /\n {8}if: (.*)/.exec(s)?.[1] ?? "",
        text: s,
      }));
  }

  const jobIf = (block: string) => /^ {4}if: (.*)/m.exec(block)?.[1] ?? "";

  /** The classifier job: least privilege, the script from the base, never from the PR. */
  function expectChangesJob(text: string) {
    const changes = job(text, "changes");
    expect(changes).toMatch(/^ {4}permissions:\n {6}contents: read\n/m);
    expect(changes).toContain("persist-credentials: false");
    expect(changes).toContain("docs-only: ${{ steps.classify.outputs.docs-only }}");
    expectClassifyStep(changes);
  }

  function expectClassifyStep(block: string) {
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
      `\${{ !cancelled() && ${RUNS} && !(github.event.pull_request.draft == true && (github.event.action == 'opened' || github.event.action == 'synchronize')) }}`,
    );
  });

  // Spec macos-build, sub-PR 1: the same gate, and never on a version run (the upstream
  // autopilot, the Beta canary), so macOS never blocks a Linux release (decision 13).
  it("e2e.yml: the macOS job runs unless docs-only, and only on the pinned version", () => {
    const text = workflow("e2e.yml");
    const mac = job(text, "mochitest-macos");
    expect(mac).toMatch(/^ {4}name: mochitest \(artifact build, macOS\)$/m);
    expect(mac).toMatch(/^ {4}runs-on: macos-15$/m);
    expect(mac).toMatch(/^ {4}needs: changes$/m);
    expect(jobIf(mac)).toBe(`\${{ !cancelled() && ${RUNS} && inputs.firefox-version == '' }}`);
    // Informational by branch protection, not by hiding a failure.
    expect(mac).not.toContain("continue-on-error");
    const names = steps(mac).map((s) => s.text);
    // npm test includes tools/bench's baseline test, which needs the branch's whole history.
    const checkout = names.find((t) => t.includes("actions/checkout@")) ?? "";
    expect(checkout).toMatch(/^ +fetch-depth: 0\b/m);
    const at = (s: string) => names.findIndex((t) => t.includes(s));
    const order = [
      "run: npm ci",
      "run: npm test",
      "tools/upstream/firefox-source.sh",
      "run: npm run import",
      "node tools/artifact-build/artifact-build.mjs",
      "npm run mochitest -- --artifact",
    ].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  // Spec macos-build, sub-PR 1: the same gate, and never on a version run (the upstream
  // autopilot, the Beta canary), so macOS never blocks a Linux release (decision 13).
  it("e2e.yml: the macOS job runs unless docs-only, and only on the pinned version", () => {
    const text = workflow("e2e.yml");
    const mac = job(text, "mochitest-macos");
    expect(mac).toMatch(/^ {4}name: mochitest \(artifact build, macOS\)$/m);
    expect(mac).toMatch(/^ {4}runs-on: macos-15$/m);
    expect(mac).toMatch(/^ {4}needs: changes$/m);
    expect(jobIf(mac)).toBe(`\${{ !cancelled() && ${RUNS} && inputs.firefox-version == '' }}`);
    // Informational by branch protection, not by hiding a failure.
    expect(mac).not.toContain("continue-on-error");
    const names = steps(mac).map((s) => s.text);
    // npm test includes tools/bench's baseline test, which needs the branch's whole history.
    const checkout = names.find((t) => t.includes("actions/checkout@")) ?? "";
    expect(checkout).toMatch(/^ +fetch-depth: 0\b/m);
    const at = (s: string) => names.findIndex((t) => t.includes(s));
    const order = [
      "run: npm ci",
      "run: npm test",
      "tools/upstream/firefox-source.sh",
      "run: npm run import",
      "node tools/artifact-build/artifact-build.mjs",
      "npm run mochitest -- --artifact",
    ].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
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
    const step = (re: RegExp) => {
      const found = all.find((s) => re.test(s.text));
      if (!found) throw new Error(`no step matching ${re}`);
      return found;
    };
    // Every change: these read Markdown, or are cheap and format-only.
    for (const re of [
      /npx --no -- prettier --check \./,
      /npm run security-links/,
      /npm run arch-lint/,
      /npm run layering/,
      /npm run diagrams:check/,
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

// The classify step runs the base's docs-only.mjs, on the runner's own Node with nothing of the
// pull request run before it (ADR-025, decision 7: it stays .mjs). These run the step's own shell
// text, as each job has it, in a repository whose base has the classifier or not.
describe("the classify step, run as the workflows have it", () => {
  const CLASSIFIER = readFileSync(SCRIPT, "utf8");
  /** Exits 3 and claims docs-only: a copy that must never be the one that runs. */
  const DECOY =
    'import { appendFileSync } from "node:fs";\n' +
    'appendFileSync(process.env.GITHUB_OUTPUT ?? "/dev/null", "docs-only=true\\n");\n' +
    "process.exit(3);\n";
  const GIT_ENV = {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });

  function classifyScript(file: string, jobId: string, id: string = "classify") {
    const doc = load(readFileSync(join(ROOT, ".github", "workflows", file), "utf8"), {
      schema: CORE_SCHEMA,
    }) as { jobs: Record<string, { steps: { id?: string; run?: string }[] }> };
    const run = doc.jobs[jobId]?.steps.find((s) => s.id === id)?.run;
    if (!run) throw new Error(`${file} ${jobId}: no ${id} step`);
    return run;
  }

  /**
   * A base commit with `base` files under tools/ci/ (a name starting with "." at the root), a head
   * commit that changes the guide and writes `head` files, and the step run with the head checked
   * out, as actions/checkout leaves it. The directories are real paths, as the runner's are:
   * macOS's temporary directory is under /var, a symlink to /private/var, and the classifier
   * runs only when started by its real path (below, "through a symlinked path").
   * @param runnerTemp RUNNER_TEMP, a real temporary directory by default
   */
  function runStep(
    script: string,
    base: Record<string, string>,
    head: Record<string, string> = {},
    runnerTemp?: string,
  ) {
    const dir = realpathSync(tempDir("vimma-classify-step-"));
    git(dir, "init", "-q", "-b", "main");
    mkdirSync(join(dir, "docs"));
    mkdirSync(join(dir, "tools", "ci"), { recursive: true });
    writeFileSync(join(dir, "docs", "guide.md"), "# Guide\n");
    for (const [name, text] of Object.entries(base))
      writeFileSync(name.startsWith(".") ? join(dir, name) : join(dir, "tools", "ci", name), text);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    const BASE = git(dir, "rev-parse", "HEAD").trim();
    writeFileSync(join(dir, "docs", "guide.md"), "# Guide\n\nMore.\n");
    for (const [path, text] of Object.entries(head)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "head");
    const HEAD = git(dir, "rev-parse", "HEAD").trim();
    const temp = runnerTemp ?? realpathSync(tempDir("vimma-classify-temp-"));
    const output = join(temp, "github-output");
    writeFileSync(output, "");
    const res = spawnSync("bash", ["-e", "-c", script], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, BASE, HEAD, RUNNER_TEMP: temp, GITHUB_OUTPUT: output },
    });
    return {
      status: res.status,
      stdout: res.stdout,
      written: readFileSync(output, "utf8"),
      temp,
      copies: readdirSync(temp)
        .filter((f) => f.startsWith("docs-only"))
        .sort(),
    };
  }

  const JOBS = [
    ["ci.yml", "check"],
    ["ci.yml", "vimma-ctl-macos"],
    ["e2e.yml", "changes"],
  ];

  describe.each(JOBS)("%s %s", (file, jobId) => {
    const script = classifyScript(file, jobId);

    it("runs the base's docs-only.mjs", () => {
      const res = runStep(script, { "docs-only.mjs": CLASSIFIER });
      expect(res.status).toBe(0);
      expect(res.written).toBe("docs-only=true\n");
      expect(res.copies).toEqual(["docs-only.mjs"]);
    });

    it("runs everything when the base has no classifier: no output, no skipped step", () => {
      const res = runStep(script, { "other.mjs": "" });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("No classifier on the base: running everything");
      expect(res.written).toBe("");
    });

    it("never runs the pull request's own copy, under any name", () => {
      const head = {
        "tools/ci/docs-only.ts": DECOY,
        "tools/ci/docs-only.mjs": DECOY,
        "src/x.mjs": "export {};\n",
      };
      const res = runStep(script, { "docs-only.mjs": CLASSIFIER }, head);
      expect(res.status).toBe(0);
      expect(res.written).toBe("docs-only=false\n");
      const none = runStep(script, { "other.mjs": "" }, head);
      expect(none.written).toBe("");
    });

    it("fails the step, rather than skipping checks, when the base's copy cannot run", () => {
      const res = runStep(script, { "docs-only.mjs": "process.exit(2);\n" });
      expect(res.status).not.toBe(0);
      expect(res.written).toBe("");
    });
  });

  // The classifier, like most tools here, runs its main() only when process.argv[1] is the real
  // path of the module (fileURLToPath(import.meta.url), which Node resolves). Started through a
  // symlinked directory it does nothing and exits 0: no output, so every check runs. The runners'
  // RUNNER_TEMP is a real path; this pins the fail-safe result. Giving docs-only the symlink
  // handling key-guard.mjs has would make it judge here too.
  it("through a symlinked RUNNER_TEMP the classifier does nothing, so everything runs", () => {
    const real = realpathSync(tempDir("vimma-classify-real-"));
    const link = join(realpathSync(tempDir("vimma-classify-link-")), "temp");
    symlinkSync(real, link);
    const res = runStep(
      classifyScript("ci.yml", "check"),
      { "docs-only.mjs": CLASSIFIER },
      {},
      link,
    );
    expect(res.status).toBe(0);
    expect(res.written).toBe("");
  });

  // A tools/ci tool under two names leaves a reader unsure which one a workflow runs; the guards
  // stay .mjs (ADR-025, decision 7), and tree-covered moves by renaming, never by copying.
  it("this branch holds each tools/ci tool under one name only", () => {
    const tracked = git(ROOT, "ls-files", "tools/ci").split("\n").filter(Boolean);
    for (const f of tracked.filter((t) => t.endsWith(".ts")))
      expect(tracked, f).not.toContain(f.replace(/\.ts$/, ".mjs"));
    expect(tracked.some((t) => /^tools\/ci\/docs-only\.(?:mjs|ts)$/.test(t))).toBe(true);
  });
});
