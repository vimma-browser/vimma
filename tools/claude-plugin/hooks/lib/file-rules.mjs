/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Subagents work in linked git worktrees; the primary checkout is where a developer's dev build
// runs from, and an agent's half-finished edit there breaks that build. Claude Code sets
// `agent_id` in the hook input only inside a subagent, so the main session is never blocked.

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** Git-ignored notes that agents keep in the primary checkout on purpose. */
const ALLOWED = [/^\.claude(?:\/|$)/, /^TESTING\.md$/, /^CURRENT-STATE\.md$/];

/** @param {string} dir @param {string[]} args */
function git(dir, args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return null;
  }
}

/**
 * Why a file change from this hook input must not happen, or null when it may.
 * @param {{ agent_id?: string, cwd?: string, tool_input?: Record<string, unknown> }} input
 * @param {Record<string, string | undefined>} env
 * @returns {{ reason: string } | null}
 */
export function checkFileChange(input, env) {
  if (!input.agent_id || env.VIMMA_GUARD_ALLOW_MAIN_CHECKOUT === "1") return null;
  const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (typeof target !== "string" || !target) return null;

  const file = resolve(input.cwd ?? process.cwd(), target);
  let dir = dirname(file);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  const common = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!top || !common) return null;
  // A linked worktree's common dir is the primary checkout's .git, not its own.
  if (realpathSync(common) !== join(realpathSync(top), ".git")) return null;

  const real = join(realpathSync(dir), relative(dir, file));
  const rel = relative(realpathSync(top), real).split(sep).join("/");
  if (ALLOWED.some((re) => re.test(rel))) return null;
  return {
    reason:
      `Blocked: ${real} is in the primary checkout ${top}, which a running dev build may read. ` +
      "A subagent changes files only in its own git worktree: create one with " +
      "`git worktree add .claude/worktrees/<item> -b <branch> origin/main` from that checkout " +
      "and make the change there.",
  };
}
