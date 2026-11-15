import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { tempDir } from "../../test/temp-dir.mjs";
import { archErrors, listEntries, namedEntries } from "../arch-lint.ts";

/** What the repository holds, in the shape `listEntries` returns. */
const repo = {
  vimma: ["actors", "host"],
  tools: ["e2e", "vimma-ctl"],
  workflows: ["ci.yml", "e2e.yml"],
  core: ["agent", "keys"],
};

/** A document naming every entry of `repo`. */
const complete = [
  "# Architecture",
  "",
  "| Folder | Role |",
  "| --- | --- |",
  "| `vimma/host/` | key capture |",
  "| `vimma/actors/` | content side |",
  "",
  "- `tools/e2e/` and `tools/vimma-ctl/`.",
  "- `ci.yml` and `e2e.yml`.",
  "- `packages/vimma-core/src/keys/` and `packages/vimma-core/src/agent/`.",
].join("\n");

describe("namedEntries", () => {
  test("reads the folders and workflows named in code spans", () => {
    expect(namedEntries(complete)).toEqual({
      vimma: ["host", "actors"],
      tools: ["e2e", "vimma-ctl"],
      workflows: ["ci.yml", "e2e.yml"],
      core: ["keys", "agent"],
    });
  });

  test("a .yaml workflow counts like a .yml one", () => {
    expect(namedEntries("`nightly.yaml` and `ci.yml`").workflows).toEqual([
      "nightly.yaml",
      "ci.yml",
    ]);
  });

  test("a deeper path, a file or bare prose names no folder", () => {
    const md =
      "`vimma/host/VimmaHost.sys.mjs`, `tools/vimma-ctl/src/`, `.github/dependabot.yml`, " +
      "vimma/ui/ and tools/e2e/ outside code, `src/browser/base/content/vimma/core/`, " +
      "`packages/vimma-core/src/keys/keys.mjs`, `packages/vimma-core/src/`.";
    expect(namedEntries(md)).toEqual({ vimma: [], tools: [], workflows: [], core: [] });
  });
});

describe("archErrors", () => {
  test("a document naming every folder and workflow passes", () => {
    expect(archErrors(complete, repo)).toEqual([]);
  });

  test("a folder under vimma/ that the document leaves out fails", () => {
    const errors = archErrors(complete, { ...repo, vimma: [...repo.vimma, "agent"] });
    expect(errors).toEqual([
      "src/browser/base/content/vimma/agent/ is missing: describe it as `vimma/agent/`",
    ]);
  });

  test("a tools/ folder that the document leaves out fails", () => {
    const errors = archErrors(complete, { ...repo, tools: [...repo.tools, "lanes"] });
    expect(errors).toEqual(["tools/lanes/ is missing: describe it as `tools/lanes/`"]);
  });

  test("a workflow that the document leaves out fails", () => {
    const errors = archErrors(complete, { ...repo, workflows: [...repo.workflows, "fuzz.yml"] });
    expect(errors).toEqual([".github/workflows/fuzz.yml is missing: describe it as `fuzz.yml`"]);
  });

  test("a folder of vimma-core's src/ that the document leaves out fails", () => {
    const errors = archErrors(complete, { ...repo, core: [...repo.core, "updates"] });
    expect(errors).toEqual([
      "packages/vimma-core/src/updates/ is missing: describe it as `packages/vimma-core/src/updates/`",
    ]);
  });

  test("an entry the repository no longer has fails, so a removed folder leaves no stale line", () => {
    const errors = archErrors(complete, {
      vimma: ["host"],
      tools: ["e2e"],
      workflows: ["ci.yml"],
      core: ["keys"],
    });
    expect(errors).toEqual([
      "`vimma/actors/` names src/browser/base/content/vimma/actors/, which does not exist",
      "`tools/vimma-ctl/` names tools/vimma-ctl/, which does not exist",
      "`e2e.yml` names .github/workflows/e2e.yml, which does not exist",
      "`packages/vimma-core/src/agent/` names packages/vimma-core/src/agent/, which does not exist",
    ]);
  });

  test("a name in prose, not in a code span, does not count", () => {
    const md = complete.replace("`vimma/actors/`", "vimma/actors/");
    expect(archErrors(md, repo)).toEqual([
      "src/browser/base/content/vimma/actors/ is missing: describe it as `vimma/actors/`",
    ]);
  });
});

describe("listEntries", () => {
  /** A git repository holding `files`, each tracked unless listed in `ignored`. */
  function repoWith(files: string[], untracked: string[] = []) {
    const root = tempDir("vimma-arch-lint-");
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd: root, stdio: "pipe" });
    git("init", "-q");
    for (const f of [...files, ...untracked]) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), "x\n");
    }
    git("add", "--", ...files);
    return root;
  }

  test("lists the tracked folders and workflows, never untracked or ignored ones", () => {
    const root = repoWith(
      [
        "src/browser/base/content/vimma/vimma.js",
        "src/browser/base/content/vimma/host/VimmaHost.sys.mjs",
        "src/browser/base/content/vimma/host/hypr/HyprIpc.sys.mjs",
        "src/browser/base/content/vimma/ui/statusbar.mjs",
        "tools/build.mjs",
        "tools/e2e/e2e.mjs",
        ".github/workflows/ci.yml",
        ".github/workflows/nightly.yaml",
        ".github/workflows/README.md",
        ".github/dependabot.yml",
        "packages/vimma-core/src/index.mjs",
        "packages/vimma-core/src/keys/keys.mjs",
        "packages/vimma-core/src/vendor/smol-toml/smol-toml.mjs",
        "packages/vimma-core/test/keys.test.mjs",
      ],
      [
        "src/browser/base/content/vimma/core/keys.mjs",
        "tools/stray/x.mjs",
        ".github/workflows/x.yml",
      ],
    );
    expect(listEntries(root)).toEqual({
      vimma: ["host", "ui"],
      tools: ["e2e"],
      workflows: ["ci.yml", "nightly.yaml"],
      core: ["keys", "vendor"],
    });
  });
});
