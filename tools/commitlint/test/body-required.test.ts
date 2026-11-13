import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { bodyRequiredForTypes, ignoreCommit } from "../body-required.ts";
import { cliPath, commitlint, root } from "./repo-commitlint.ts";

describe("body-required-for-types rule", () => {
  const types = ["feat", "fix"];

  it("fails a feat commit without a body", () => {
    const [ok, why] = bodyRequiredForTypes({ type: "feat", body: null }, "always", types);
    expect(ok).toBe(false);
    expect(why).toMatch(/feat/);
  });

  it("fails a fix commit whose body is only whitespace", () => {
    const [ok] = bodyRequiredForTypes({ type: "fix", body: "  \n " }, "always", types);
    expect(ok).toBe(false);
  });

  it("passes a feat commit with a body", () => {
    const [ok] = bodyRequiredForTypes({ type: "feat", body: "Adds x." }, "always", types);
    expect(ok).toBe(true);
  });

  it("ignores types outside the list", () => {
    const [ok] = bodyRequiredForTypes({ type: "docs", body: null }, "always", types);
    expect(ok).toBe(true);
  });

  it('treats a git-style `Revert "..."` header as type revert', () => {
    const parsed = { type: null, header: 'Revert "feat: x"', body: null };
    expect(bodyRequiredForTypes(parsed, "always", ["revert"])[0]).toBe(false);
    expect(bodyRequiredForTypes(parsed, "always", ["feat"])[0]).toBe(true);
  });

  it("is a no-op when the rule is set to never", () => {
    const [ok] = bodyRequiredForTypes({ type: "feat", body: null }, "never", types);
    expect(ok).toBe(true);
  });
});

describe("ignoreCommit (replaces commitlint's default ignores)", () => {
  it.each([
    "Merge pull request #1 from JRanne/x",
    "Merge branch 'main' into x",
    "fixup! feat: x",
    'Revert "feat: x"\n\nThis reverts commit abc1234.',
  ])("ignores %j", (message) => {
    expect(ignoreCommit(message)).toBe(true);
  });

  it.each([
    'Revert "feat: x"',
    'Revert "feat: x"\n\nCloses #3',
    'Reapply "fix: y"\n',
    "feat: x",
    "revert: feat: x",
  ])("lints %j", (message) => {
    expect(ignoreCommit(message)).toBe(false);
  });
});

describe("the commitlint CLI", () => {
  // The other tests lint in-process (repo-commitlint.ts); this one runs the installed CLI on
  // stdin from the repository root, as CI and the merge check do, so a change in how the CLI
  // finds the config or reports a failure still shows here.
  const run = (input: string) =>
    spawnSync(process.execPath, [cliPath], { cwd: root, input, encoding: "utf8" });

  it("finds commitlint.config.mjs and exits 1 on a bodyless feat", () => {
    const bad = run("feat: x\n");
    expect(bad.status, bad.stdout + bad.stderr).toBe(1);
    expect(bad.stdout + bad.stderr).toMatch(/body-required-for-types/);
  });

  it("exits 0 and prints nothing on a feat with a body", () => {
    const good = run("feat: x\n\nAdds x to the status bar.\n");
    expect(good.status, good.stdout + good.stderr).toBe(0);
    expect(good.stdout + good.stderr).toBe("");
  });
});

describe("repo commitlint config", () => {
  it("rejects `feat: x` without a body", async () => {
    const run = await commitlint("feat: x\n");
    expect(run.status).not.toBe(0);
    expect(run.output).toMatch(/body-required-for-types/);
  });

  it("rejects `fix(host): y` without a body", async () => {
    const run = await commitlint("fix(host): y\n");
    expect(run.status).not.toBe(0);
    expect(run.output).toMatch(/body-required-for-types/);
  });

  it("accepts `feat: x` with a body", async () => {
    const run = await commitlint("feat: x\n\nAdds x to the status bar.\n");
    expect(run.output).toBe("");
    expect(run.status).toBe(0);
  });

  it.each([
    ["only a `Closes` footer", "feat: x\n\nCloses #3\n"],
    ["only a BREAKING CHANGE footer", "feat: x\n\nBREAKING CHANGE: y\n"],
    ["only trailers", "fix: x\n\nCo-Authored-By: A <a@b.c>\n"],
  ])("rejects feat/fix with %s (footers are not a body)", async (_, message) => {
    const run = await commitlint(message);
    expect(run.status).not.toBe(0);
    expect(run.output).toMatch(/body-required-for-types/);
  });

  it("rejects `revert: feat: x` without a body", async () => {
    const run = await commitlint("revert: feat: x\n");
    expect(run.status).not.toBe(0);
    expect(run.output).toMatch(/body-required-for-types/);
  });

  it("accepts `revert: feat: x` with a body", async () => {
    expect((await commitlint("revert: feat: x\n\nThe status bar flickered.\n")).status).toBe(0);
  });

  it('rejects a git-style `Revert "feat: x"` without a body', async () => {
    const run = await commitlint('Revert "feat: x"\n');
    expect(run.status).not.toBe(0);
    expect(run.output).toMatch(/body-required-for-types/);
  });

  it('accepts a git-style `Revert "feat: x"` with a body', async () => {
    expect((await commitlint('Revert "feat: x"\n\nThis reverts commit abc1234.\n')).status).toBe(0);
  });

  it("accepts `docs: x` without a body", async () => {
    expect((await commitlint("docs: x\n")).status).toBe(0);
  });
});

describe("Dependabot's commits (repo commitlint config)", () => {
  // Dependabot writes `Bump` in sentence case or lower case, titles that can pass 100 columns and
  // a body of release notes with longer lines; none of it can be set in .github/dependabot.yml.
  const signedOff = "Signed-off-by: dependabot[bot] <support@github.com>";
  const longLine = `- ${"release note ".repeat(12)}`;

  it("accepts a Dependabot commit on its branch", async () => {
    const message = [
      "build(deps-dev): Bump the npm-minor-patch group with 2 updates",
      "",
      "Bumps the npm-minor-patch group with 2 updates: vitest and @vitest/coverage-v8.",
      longLine,
      "",
      signedOff,
      "",
    ].join("\n");
    const run = await commitlint(message);
    expect(run.output).toBe("");
    expect(run.status).toBe(0);
  });

  it("accepts the squash of a Dependabot pull request (title and body)", async () => {
    const message = [
      "build(deps): Bump js-yaml from 4.3.2 to 5.4.3 (#288)",
      "",
      longLine,
      "",
      "Dependabot will resolve any conflicts with this PR as long as you don't alter it yourself.",
      "",
    ].join("\n");
    expect((await commitlint(message)).status).toBe(0);
  });

  it("accepts a GitHub Actions update", async () => {
    const message = `ci(deps): Bump actions/checkout from 7.0.1 to 7.1.0\n\n${signedOff}\n`;
    expect((await commitlint(message)).status).toBe(0);
  });

  it("accepts the squash of a lower-case Dependabot title over 100 columns", async () => {
    const message = [
      "ci(deps): bump anthropics/claude-code-action from 1.0.251 to 1.0.252 in the actions-minor-patch group (#396)",
      "",
      longLine,
      "",
      signedOff,
      "",
    ].join("\n");
    const run = await commitlint(message);
    expect(run.output).toBe("");
    expect(run.status).toBe(0);
  });

  it("still rejects a lower-case `bump` over 100 columns that does not come from Dependabot", async () => {
    const run = await commitlint(`build(deps): bump ${"x".repeat(100)} from 1 to 2\n\nBy hand.\n`);
    expect(run.status).not.toBe(0);
    expect(run.output).toMatch(/header-max-length/);
  });

  it("still rejects a sentence-case `Bump` that does not come from Dependabot", async () => {
    const run = await commitlint("build(deps): Bump x from 1 to 2\n\nBy hand.\n");
    expect(run.status).not.toBe(0);
    expect(run.output).toMatch(/subject-case/);
  });

  it("still rejects another header with Dependabot's trailer", async () => {
    const run = await commitlint(`feat: Bump everything\n\nBody.\n\n${signedOff}\n`);
    expect(run.status).not.toBe(0);
    expect(run.output).toMatch(/subject-case/);
  });
});
