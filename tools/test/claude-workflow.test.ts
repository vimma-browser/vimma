import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { jobs } from "./workflow-runners.ts";
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

describe("claude.yml spec", () => {
  it("has a Claude step with an allowlist", () => {
    expect(claude).toBeGreaterThan(0);
    expect(allowed.length).toBeGreaterThan(5);
  });

  // `gh issue view` also prints the comments (`--comments`), which anyone can write.
  it("gives Claude no gh tool", () => {
    expect(allowed.filter((t) => /^Bash\(gh\b/.test(t))).toEqual([]);
    expect(prompt).not.toMatch(/gh issue view/);
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
    const i = steps.findIndex((s) => /apt-get install\b.*\bbubblewrap\b/.test(s.run ?? ""));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(claude);
    expect(steps[i]?.["continue-on-error"]).toBeUndefined();
  });

  it("the header asks the maintainer to read the issue's comments before claude:go", () => {
    const header = text.slice(0, text.indexOf("\nname:"));
    expect(header).toMatch(/reads? the issue's comments/);
  });
});
