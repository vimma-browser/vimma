/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkFileChange } from "../hooks/lib/file-rules.mjs";
import { tempDir } from "../../test/temp-dir.mjs";

/** A repository with one commit and a linked worktree under .claude/worktrees/item. */
function repoWithWorktree() {
  const base = realpathSync(tempDir("vimma-guard-repo-"));
  const main = join(base, "repo");
  mkdirSync(main);
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync("git", ["-C", main, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(main, "README.md"), "x\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
  git("worktree", "add", "-q", join(main, ".claude", "worktrees", "item"), "-b", "item");
  return { base, main, worktree: join(main, ".claude", "worktrees", "item") };
}

/** @param {string} tool @param {Record<string, unknown>} toolInput @param {boolean} subagent */
function input(tool, toolInput, subagent = true) {
  return {
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: toolInput,
    cwd: "/",
    ...(subagent ? { agent_id: "a1", agent_type: "vimma-guardrails:vimma-pr" } : {}),
  };
}

describe("subagents and the primary checkout", () => {
  it("blocks a subagent editing a file in the primary checkout", () => {
    const { main } = repoWithWorktree();
    const result = checkFileChange(input("Edit", { file_path: join(main, "README.md") }), {});
    expect(result?.reason).toMatch(/worktree/);
  });

  it("blocks a subagent creating a file in a new directory of the primary checkout", () => {
    const { main } = repoWithWorktree();
    const result = checkFileChange(
      input("Write", { file_path: join(main, "docs", "new", "x.md") }),
      {},
    );
    expect(result?.reason).toMatch(/worktree/);
  });

  it("blocks NotebookEdit by its notebook_path", () => {
    const { main } = repoWithWorktree();
    const result = checkFileChange(
      input("NotebookEdit", { notebook_path: join(main, "a.ipynb") }),
      {},
    );
    expect(result?.reason).toMatch(/worktree/);
  });

  it("allows the main session to edit the primary checkout", () => {
    const { main } = repoWithWorktree();
    expect(
      checkFileChange(input("Edit", { file_path: join(main, "README.md") }, false), {}),
    ).toBeNull();
  });

  it("allows a subagent in its linked worktree", () => {
    const { worktree } = repoWithWorktree();
    expect(
      checkFileChange(input("Write", { file_path: join(worktree, "src", "new.mjs") }), {}),
    ).toBeNull();
  });

  it("allows a subagent outside any repository", () => {
    const { base } = repoWithWorktree();
    expect(
      checkFileChange(input("Write", { file_path: join(base, "scratch", "notes.txt") }), {}),
    ).toBeNull();
  });

  it("allows the git-ignored notes the agents keep in the primary checkout", () => {
    const { main } = repoWithWorktree();
    for (const file of ["TESTING.md", ".claude/handover/notes.md"]) {
      expect(checkFileChange(input("Write", { file_path: join(main, file) }), {})).toBeNull();
    }
  });

  it("allows everything when the opt-out variable is set", () => {
    const { main } = repoWithWorktree();
    expect(
      checkFileChange(input("Edit", { file_path: join(main, "README.md") }), {
        VIMMA_GUARD_ALLOW_MAIN_CHECKOUT: "1",
      }),
    ).toBeNull();
  });
});
