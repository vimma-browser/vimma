/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { jobs, parseWorkflow } from "./workflow-runners.ts";
import type { Job, Step } from "./workflow-types.ts";

// claude.yml `spec` (docs/security/14-build-and-release-supply-chain.md B23): what reaches the
// model, and what the commands it runs can see.
const text = readFileSync(new URL("../../.github/workflows/claude.yml", import.meta.url), "utf8");
const spec = jobs(text).get("spec") as Job;
const steps: Step[] = spec.steps ?? [];
const claude = steps.findIndex((s) => s.uses?.startsWith("anthropics/claude-code-action@"));
const claudeStep = steps[claude] as Step;
const args = String(claudeStep.with?.claude_args ?? "");
const prompt = String(claudeStep.with?.prompt ?? "");
const allowed = (/--allowedTools "([^"]*)"/.exec(args)?.[1] ?? "").split(",");
const MAINTAINER_GATE = "github.event.issue.user.login == 'JRanne'";

describe("claude.yml spec", () => {
  it("has a Claude step with an allowlist", () => {
    expect(claude).toBeGreaterThan(0);
    expect(allowed.length).toBeGreaterThan(5);
  });

  // `gh issue view` also prints the comments (`--comments`), which anyone can write. The list is
  // pinned whole: an MCP server, WebFetch or another network tool would bring in outside text,
  // and a bare Read or Edit reaches past the checkout (/proc, PATH folders).
  it("gives Claude no gh tool", () => {
    expect(args.match(/--allowed-?[Tt]ools\b/g)).toHaveLength(1);
    expect(allowed).toEqual([
      "Edit(./**)",
      "Bash(npm test)",
      "Bash(npm run lint)",
      "Bash(npm run typecheck)",
      "Bash(npm run coverage)",
      "Bash(npm run format)",
      "Bash(npm run gen-docs)",
      "Bash(npm run test:py)",
      "Bash(git status)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git add:*)",
      "Bash(git commit:*)",
    ]);
    expect(args).toContain('--disallowedTools "Edit(./.git/**)"');
    expect(prompt).not.toMatch(/gh issue view/);
  });

  it("runs only on the maintainer's own issue", () => {
    expect(spec.if).toContain(MAINTAINER_GATE);
    expect(spec.if).not.toMatch(/\|\||!/);
  });

  // From the event that started the run, so Claude reads the text as it stood when the
  // maintainer added the label, and the step needs no token.
  it("saves only the issue's title and body before Claude, and the prompt names that file", () => {
    const i = steps.findIndex((s) => (s.run ?? "").includes("$GITHUB_EVENT_PATH"));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(claude);
    const step = steps[i] as Step;
    const run = step.run ?? "";
    expect(run).toContain("jq '{title: .issue.title, body: .issue.body}' \"$GITHUB_EVENT_PATH\"");
    expect(run).not.toMatch(/comments|\bgh\b/);
    expect(run).not.toContain("${{");
    expect(step.env).toBeUndefined();
    const out = /> "\$RUNNER_TEMP\/([^"]+)"/.exec(run)?.[1];
    expect(out).toBeDefined();
    expect(prompt).toContain(`\${{ runner.temp }}/${out}`);
    expect(args).toContain(`--add-dir \${{ runner.temp }}/${out?.split("/")[0]}`);
  });

  // Claude Code removes Anthropic, cloud and Actions secrets from its tools' environments only
  // with this variable, and then needs bubblewrap, which runs them in their own PID namespace.
  it("keeps the Claude credential from the commands Claude runs", () => {
    expect(spec.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
    // A workflow-level or step-level value would win over the job's.
    const env = parseWorkflow(text).env as Record<string, unknown> | undefined;
    expect(env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined();
    expect(claudeStep.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined();
    expect(args).toMatch(/--permission-mode default\b/);
    const i = steps.findIndex((s) => /apt-get install\b.*\bbubblewrap\b/.test(s.run ?? ""));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(claude);
    expect(steps[i]?.["continue-on-error"]).toBeUndefined();
  });

  // A file Claude wrote could hold the credential; the artifact is public to signed-in users.
  it("exports the patch with the system git and checks it for a credential before the upload", () => {
    const i = steps.findIndex((s) => s.id === "patch");
    const upload = steps.findIndex((s) => s.uses?.startsWith("actions/upload-artifact@"));
    expect(i).toBeGreaterThan(claude);
    expect(upload).toBeGreaterThan(i);
    const run = steps[i]?.run ?? "";
    expect(run).toMatch(/\/usr\/bin\/git -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false/);
    expect(run).toMatch(/grep -qE 'sk-ant-\[A-Za-z0-9_-\]\{8\}' spec\.patch/);
  });

  it("the header asks the maintainer to read the issue's comments before claude:go", () => {
    const header = text.slice(0, text.indexOf("\nname:"));
    expect(header).toMatch(/reads? the issue's comments/);
  });
});
