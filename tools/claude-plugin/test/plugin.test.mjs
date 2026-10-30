/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The plugin as Claude Code runs it: the manifests, the hook commands and the entry scripts fed
// hook input on stdin.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../test/temp-dir.mjs";

const PLUGIN = fileURLToPath(new URL("..", import.meta.url));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** @param {string} path */
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

/** @param {string} script @param {object} payload */
function runHook(script, payload) {
  const run = spawnSync(process.execPath, [join(PLUGIN, "hooks", script)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe("manifests", () => {
  it("the repository marketplace lists the plugin under its manifest name", () => {
    const manifest = json(join(PLUGIN, ".claude-plugin", "plugin.json"));
    const market = json(join(ROOT, ".claude-plugin", "marketplace.json"));
    const entry = market.plugins.find((/** @type {any} */ p) => p.name === manifest.name);
    expect(entry?.source).toBe("./tools/claude-plugin");
    expect(market.owner?.name).toBeTruthy();
  });

  // Claude Code caches a git-hosted plugin under its version: plugin.json's, else the marketplace
  // entry's, else the commit SHA. A pinned string keeps every user on the cached copy until
  // someone bumps it, so auto-update would never deliver changed hooks; the commit versions it.
  it("neither manifest pins a version, so each commit is a new version", () => {
    const manifest = json(join(PLUGIN, ".claude-plugin", "plugin.json"));
    const market = json(join(ROOT, ".claude-plugin", "marketplace.json"));
    const entry = market.plugins.find((/** @type {any} */ p) => p.name === manifest.name);
    expect(manifest).not.toHaveProperty("version");
    expect(entry).not.toHaveProperty("version");
  });

  it("every hook command runs a script that exists", () => {
    const hooks = json(join(PLUGIN, "hooks", "hooks.json")).hooks.PreToolUse;
    const matchers = hooks.map((/** @type {any} */ h) => h.matcher).sort();
    expect(matchers).toEqual(["Bash", "Edit|Write|NotebookEdit"]);
    for (const group of hooks) {
      for (const hook of group.hooks) {
        const script = hook.command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w/.-]+\.mjs)/)?.[1];
        expect(script && existsSync(join(PLUGIN, script))).toBeTruthy();
      }
    }
  });

  it("the agent definition names no local paths", () => {
    const agent = readFileSync(join(PLUGIN, "agents", "vimma-pr.md"), "utf8");
    expect(agent).toMatch(/^---\nname: vimma-pr\n/);
    expect(agent).not.toMatch(/\/home\/|\/Users\//);
    expect(agent).toMatch(/ready-for-maintainer/);
  });
});

describe("bash-guard.mjs", () => {
  it("denies a blocked command with a reason", () => {
    const out = runHook("bash-guard.mjs", {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "pkill -f vimma" },
      cwd: "/",
    });
    expect(out.status).toBe(0);
    const decision = JSON.parse(out.stdout).hookSpecificOutput;
    expect(decision.hookEventName).toBe("PreToolUse");
    expect(decision.permissionDecision).toBe("deny");
    expect(decision.permissionDecisionReason).toMatch(/PID/);
  });

  it("says nothing for an allowed command", () => {
    const out = runHook("bash-guard.mjs", {
      tool_name: "Bash",
      tool_input: { command: "git status" },
      cwd: "/",
    });
    expect(out).toMatchObject({ status: 0, stdout: "" });
  });

  it("runs the repository's commitlint on a merge message", () => {
    const dir = tempDir("vimma-guard-msg-");
    writeFileSync(join(dir, "good.txt"), "Explains why.\n");
    const merge = (/** @type {string} */ subject) =>
      runHook("bash-guard.mjs", {
        tool_name: "Bash",
        tool_input: {
          command: `cd ${ROOT} && gh pr merge 1 --squash --subject '${subject}' --body-file ${dir}/good.txt`,
        },
        cwd: ROOT,
      });
    expect(merge("fix(x): a lower-case subject (#1)").stdout).toBe("");
    const bad = JSON.parse(merge("Fix: Upper Case Type").stdout).hookSpecificOutput;
    expect(bad.permissionDecisionReason).toMatch(/commitlint/);
  });
});

describe("file-guard.mjs", () => {
  it("leaves the main session alone", () => {
    const out = runHook("file-guard.mjs", {
      tool_name: "Edit",
      tool_input: { file_path: join(ROOT, "README.md") },
      cwd: ROOT,
    });
    expect(out).toMatchObject({ status: 0, stdout: "" });
  });
});
