/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkBash } from "../hooks/lib/bash-rules.mjs";
import { tempDir } from "../../test/temp-dir.mjs";

/** A commitlint stand-in: passes every message, and records what it was given. */
function passingLint() {
  /** @type {{ message: string, cwd: string }[]} */
  const calls = [];
  return {
    calls,
    /** @param {string} message @param {string} cwd */
    lint(message, cwd) {
      calls.push({ message, cwd });
      return { ok: true, output: "" };
    },
  };
}

/** @param {string} command @param {object} [opts] */
function blocked(command, opts = {}) {
  return checkBash(command, { cwd: "/nonexistent", commitlint: passingLint().lint, ...opts });
}

describe("pkill -f and kill by pattern", () => {
  it.each([
    "pkill -f vimma",
    "pkill -9 -f 'firefox --profile'",
    "pkill -fa xvfb",
    "pkill --full vimma",
    "sudo pkill -f vimma",
    "sleep 1 && pkill -f vimma",
    "pgrep -f vimma | xargs kill",
    "pgrep -f vimma | xargs -r kill -9",
    "kill $(pgrep -f vimma)",
    "kill -9 `pgrep -f vimma`",
    'bash -c "pkill -f vimma"',
  ])("blocks %s", (command) => {
    expect(blocked(command)?.reason).toMatch(/PID/);
  });

  it.each([
    "pkill vimma",
    "pgrep -a vimma",
    "pgrep -f vimma",
    "pgrep -af firefox | head",
    "kill 12345",
    "kill -TERM 4242",
    'git commit -m "never use pkill -f in scripts"',
    "echo 'pgrep -f x | xargs kill'",
    "grep -rn 'pkill -f' docs",
    "cat <<'EOF' > notes.txt\npkill -f vimma\nEOF",
  ])("allows %s", (command) => {
    expect(blocked(command)).toBeNull();
  });
});

describe("force pushes", () => {
  it.each([
    "git push --force",
    "git push -f origin main",
    "git push -uf origin topic",
    "git push --force-with-lease origin topic",
    "git push --force-with-lease=topic:abc123 origin topic",
    "git push origin +topic",
    "git push origin +HEAD:topic",
    "git -C /repo push --force",
    "cd /repo && git push origin topic --force",
  ])("blocks %s", (command) => {
    expect(blocked(command)?.reason).toMatch(/git merge origin\/main/);
  });

  it.each([
    "git push",
    "git push -u origin topic",
    "git push origin HEAD:topic",
    "git push --tags",
    "git fetch --force origin",
    "git commit -m 'explain why --force is never needed'",
    "git push -o ci.skip origin topic",
  ])("allows %s", (command) => {
    expect(blocked(command)).toBeNull();
  });
});

describe("code-scanning alerts", () => {
  it.each([
    "gh api -X PATCH repos/vimma-browser/vimma/code-scanning/alerts/12 -f state=dismissed",
    "gh api repos/o/r/code-scanning/alerts/12 -f state=dismissed -f dismissed_reason='false positive'",
    "gh api --method PATCH /repos/o/r/code-scanning/alerts/3 --input body.json",
    "gh api repos/o/r/secret-scanning/alerts/3 -F state=resolved",
    "gh api repos/o/r/dependabot/alerts/3 -X PATCH -f state=dismissed",
    "gh code-scanning alert dismiss 12",
    'curl -X PATCH https://api.github.com/repos/o/r/code-scanning/alerts/1 -d \'{"state":"dismissed"}\'',
  ])("blocks %s", (command) => {
    expect(blocked(command)?.reason).toMatch(/alert/);
  });

  it.each([
    "gh api repos/o/r/code-scanning/alerts",
    "gh api repos/o/r/code-scanning/alerts?state=open --paginate",
    "gh api repos/o/r/code-scanning/alerts/12 --jq .most_recent_instance",
    "gh api -X GET repos/o/r/code-scanning/alerts -f state=open",
    "echo 'never PATCH code-scanning/alerts to state=dismissed'",
  ])("allows %s", (command) => {
    expect(blocked(command)).toBeNull();
  });
});

describe("workflows", () => {
  it.each([
    "gh workflow disable ci.yml",
    "gh workflow disable 'CI'",
    "gh api -X PUT repos/o/r/actions/workflows/ci.yml/disable",
  ])("blocks %s", (command) => {
    expect(blocked(command)?.reason).toMatch(/workflow/);
  });

  it.each(["gh workflow list", "gh workflow run ci.yml", "gh workflow view ci.yml"])(
    "allows %s",
    (command) => {
      expect(blocked(command)).toBeNull();
    },
  );
});

describe("gh pr merge", () => {
  /** A temp dir holding msg.txt with a body. */
  function withMessage(body = "Adds the thing.\n\nCloses #1\n") {
    const dir = tempDir("vimma-guard-");
    writeFileSync(join(dir, "msg.txt"), body);
    return dir;
  }

  it("allows a merge with --subject and a non-empty --body-file that passes commitlint", () => {
    const dir = withMessage();
    const lint = passingLint();
    const result = checkBash(
      'gh pr merge 12 --squash --subject "fix(x): y (#12)" --body-file msg.txt',
      { cwd: dir, commitlint: lint.lint },
    );
    expect(result).toBeNull();
    expect(lint.calls).toEqual([
      { message: "fix(x): y (#12)\n\nAdds the thing.\n\nCloses #1\n", cwd: dir },
    ]);
  });

  it("reads the body file relative to an earlier cd", () => {
    const dir = withMessage();
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "m.txt"), "Body.\n");
    const result = checkBash(
      `cd ${dir}/sub && gh pr merge 12 --squash -t 'docs: z (#12)' -F m.txt --delete-branch`,
      { cwd: "/", commitlint: passingLint().lint },
    );
    expect(result).toBeNull();
  });

  it("allows --auto with a checked message, and --disable-auto alone", () => {
    const dir = withMessage();
    const opts = { cwd: dir, commitlint: passingLint().lint };
    expect(
      checkBash("gh pr merge 12 --auto --squash --subject 'ci: a (#12)' --body-file msg.txt", opts),
    ).toBeNull();
    expect(checkBash("gh pr merge 12 --disable-auto", opts)).toBeNull();
  });

  it.each([
    "gh pr merge 12 --squash",
    "gh pr merge 12 --squash --auto",
    "gh pr merge 12 --squash --admin",
    'gh pr merge 12 --squash --subject "fix: y (#12)"',
    'gh pr merge 12 --squash --subject "fix: y (#12)" --body "$(tail -n +3 msg.txt)"',
    "gh pr merge 12 --squash --body-file msg.txt",
    "npx commitlint < msg.txt ; gh pr merge 12 --squash",
  ])("blocks %s", (command) => {
    const dir = withMessage();
    expect(checkBash(command, { cwd: dir, commitlint: passingLint().lint })?.reason).toMatch(
      /--subject .*--body-file/,
    );
  });

  it("blocks a missing or empty body file", () => {
    const dir = withMessage("");
    const opts = { cwd: dir, commitlint: passingLint().lint };
    expect(
      checkBash("gh pr merge 1 --squash --subject 'ci: a (#1)' --body-file msg.txt", opts)?.reason,
    ).toMatch(/empty/);
    expect(
      checkBash("gh pr merge 1 --squash --subject 'ci: a (#1)' --body-file nope.txt", opts)?.reason,
    ).toMatch(/not found|empty/);
  });

  it("blocks a subject or path it cannot read without running the shell", () => {
    const dir = withMessage();
    const opts = { cwd: dir, commitlint: passingLint().lint };
    expect(
      checkBash('gh pr merge 1 --squash --subject "$(head -1 msg.txt)" --body-file msg.txt', opts)
        ?.reason,
    ).toMatch(/literal/);
    expect(
      checkBash('gh pr merge 1 --squash --subject "ci: a (#1)" --body-file "$MSG"', opts)?.reason,
    ).toMatch(/literal/);
  });

  it("blocks when commitlint fails, quoting its output", () => {
    const dir = withMessage();
    const result = checkBash("gh pr merge 1 --squash --subject 'Bad Subject' --body-file msg.txt", {
      cwd: dir,
      commitlint: () => ({ ok: false, output: "subject-case: must be lower case" }),
    });
    expect(result?.reason).toMatch(/commitlint/);
    expect(result?.reason).toMatch(/subject-case/);
  });

  it("blocks merging through the REST API", () => {
    expect(
      blocked("gh api -X PUT repos/o/r/pulls/12/merge -f merge_method=squash")?.reason,
    ).toMatch(/gh pr merge/);
  });

  it.each([
    "gh pr view 12",
    "gh pr checks 12 --watch",
    'git commit -m "docs: explain gh pr merge --squash"',
    "gh pr list --search 'merge'",
  ])("allows %s", (command) => {
    expect(blocked(command)).toBeNull();
  });
});

describe("ordinary commands", () => {
  it.each([
    "npm test",
    "ls -la && git status",
    "npm run lint 2>&1 | tail -20",
    "for p in a b; do echo $p; done",
    "FOO=1 node tools/x.mjs",
    "git log --oneline -5",
    "",
  ])("allows %s", (command) => {
    expect(blocked(command)).toBeNull();
  });
});
