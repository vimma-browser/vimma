import { describe, expect, test } from "vitest";
import { archErrors, namedEntries } from "../arch-lint.mjs";

/** What the repository holds, in the shape `listEntries` returns. */
const repo = {
  vimma: ["actors", "host"],
  tools: ["e2e", "vimma-ctl"],
  workflows: ["ci.yml", "e2e.yml"],
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
].join("\n");

describe("namedEntries", () => {
  test("reads the folders and workflows named in code spans", () => {
    expect(namedEntries(complete)).toEqual({
      vimma: ["host", "actors"],
      tools: ["e2e", "vimma-ctl"],
      workflows: ["ci.yml", "e2e.yml"],
    });
  });

  test("a deeper path, a file or bare prose names no folder", () => {
    const md =
      "`vimma/host/VimmaHost.sys.mjs`, `tools/vimma-ctl/src/`, `.github/dependabot.yml`, " +
      "vimma/ui/ and tools/e2e/ outside code, `src/browser/base/content/vimma/core/`.";
    expect(namedEntries(md)).toEqual({ vimma: [], tools: [], workflows: [] });
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

  test("an entry the repository no longer has fails, so a removed folder leaves no stale line", () => {
    const errors = archErrors(complete, {
      vimma: ["host"],
      tools: ["e2e"],
      workflows: ["ci.yml"],
    });
    expect(errors).toEqual([
      "`vimma/actors/` names src/browser/base/content/vimma/actors/, which does not exist",
      "`tools/vimma-ctl/` names tools/vimma-ctl/, which does not exist",
      "`e2e.yml` names .github/workflows/e2e.yml, which does not exist",
    ]);
  });

  test("a name in prose, not in a code span, does not count", () => {
    const md = complete.replace("`vimma/actors/`", "vimma/actors/");
    expect(archErrors(md, repo)).toEqual([
      "src/browser/base/content/vimma/actors/ is missing: describe it as `vimma/actors/`",
    ]);
  });
});
