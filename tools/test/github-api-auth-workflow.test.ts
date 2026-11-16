import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { jobs } from "./workflow-runners.ts";
import type { Job } from "./workflow-types.ts";

// Issue #1170: a step that asks api.github.com with curl and no token shares GitHub's
// unauthenticated limit of 60 requests an hour per IP with every other job on that hosted
// runner's address, and a 403 there is the rate limit, not the answer. Every such step sends the
// job's own GITHUB_TOKEN, which needs `contents: read` to read a release. `gh api` authenticates
// by itself; this checks the plain curl calls.
const dir = new URL("../../.github/workflows/", import.meta.url);
const workflows = readdirSync(dir)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((name) => ({ name, text: readFileSync(new URL(name, dir), "utf8") }));

const AUTH = '-H "Authorization: Bearer $GH_TOKEN"';

/** @returns a run script without its comment lines */
const code = (run: string) =>
  run
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

/**
 * @param script a run script, comments dropped
 * @returns each curl command in it, from `curl ` to the end of its last line (the first one that
 *   does not end in a backslash), so a header in a later command never counts for this one
 */
function curlCommands(script: string): string[] {
  const out: string[] = [];
  const lines = script.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i]?.search(/\bcurl /) ?? -1;
    if (at < 0) continue;
    const parts = [lines[i]?.slice(at) ?? ""];
    while (parts.at(-1)?.trimEnd().endsWith("\\") && i + 1 < lines.length)
      parts.push(lines[++i] ?? "");
    out.push(parts.join("\n"));
  }
  return out;
}

/** Whether a script asks the GitHub API: some https URL in it has exactly that host. */
function asksApi(script: string): boolean {
  return [...script.matchAll(/https:\/\/[^\s"'()]+/g)].some((m) => {
    try {
      return new URL(m[0]).hostname === "api.github.com";
    } catch {
      return false;
    }
  });
}

/** Every step whose script asks api.github.com, as `<workflow> <job> "<step>"`. */
const calls = workflows.flatMap(({ name, text }) =>
  [...jobs(text)].flatMap(([id, raw]) => {
    const job = raw as Job;
    return (job.steps ?? [])
      .filter((s) => typeof s.run === "string" && asksApi(code(s.run)))
      .map((step) => ({ label: `${name} ${id} "${step.name ?? "?"}"`, job, step }));
  }),
);

describe("curlCommands", () => {
  it("runs a command over its continued lines", () => {
    expect(
      curlCommands('x=$(curl -sS \\\n  -H "A: b" \\\n  "https://api.github.com/x")\necho ok'),
    ).toEqual(['curl -sS \\\n  -H "A: b" \\\n  "https://api.github.com/x")']);
  });

  it("does not count a header in a later command", () => {
    const script =
      'curl -sS "https://api.github.com/x"\ncurl -sS ' + AUTH + ' "https://example.org/"';
    const [first, second] = curlCommands(script);
    expect(first).not.toContain(AUTH);
    expect(second).toContain(AUTH);
    expect(
      curlCommands('curl -sS "https://api.github.com/x"\necho ' + AUTH).filter((c) =>
        c.includes(AUTH),
      ),
    ).toEqual([]);
  });
});

describe("steps that ask api.github.com authenticate (#1170)", () => {
  it("finds the release-metadata checks", () => {
    // release.yml's macos-tap (two), homebrew.yml's start, update-publish.yml's start
    expect(calls.map((c) => c.label).sort()).toEqual([
      'homebrew.yml start "Start the tap push on main"',
      'release.yml macos-tap "Start homebrew.yml for a published release"',
      'release.yml macos-tap "Start update-publish.yml for the macOS manifest"',
      'update-publish.yml start "Start the manifest run on main"',
    ]);
  });

  it("every step that asks api.github.com sends the job's token", () => {
    for (const c of calls) {
      const script = code(c.step.run ?? "");
      for (const curl of curlCommands(script).filter((p) => asksApi(p))) {
        expect(curl, c.label).toContain(AUTH);
      }
      expect(c.step.env?.GH_TOKEN ?? c.job.env?.GH_TOKEN, c.label).toBe("${{ github.token }}");
      expect(["read", "write"], c.label).toContain(c.job.permissions?.contents);
    }
  });
});
