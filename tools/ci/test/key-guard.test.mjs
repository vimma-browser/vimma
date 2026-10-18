/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// tools/ci/key-guard.mjs fails a pull request that changes Mozilla's pinned release key or the
// fingerprint pinned in verify-sha512.py, unless a maintainer added the key-rotation-approved
// label (ADR-021, docs/security.md B1, docs/runbook.md "Mozilla's release key").

import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../test/temp-dir.mjs";
import {
  APPROVAL_LABEL,
  GUARD_PATHS,
  GUARD_SCRIPT,
  KEY_PATH,
  VERIFIER_PATH,
  keyChanges,
  parseLabels,
  pinnedLines,
  verdict,
} from "../key-guard.mjs";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../key-guard.mjs", import.meta.url));

const VERIFIER = [
  '"""Checks SHA512SUMS against PINNED_FINGERPRINT below."""',
  "import re",
  'PINNED_FINGERPRINT = "14F26682D0916CDD81E37B6D61B7B526D98F0353"',
  'KEY_FILE = Path(__file__).resolve().with_name("mozilla-release-key.asc")',
  'HASH = re.compile(r"[0-9a-f]{128}")',
  "def check_signature(sums, signature, key_file=KEY_FILE, fingerprint=PINNED_FINGERPRINT):",
  "    return 0",
  "",
].join("\n");
const KEY = "-----BEGIN PGP PUBLIC KEY BLOCK-----\nmQINBF...\n-----END PGP PUBLIC KEY BLOCK-----\n";
const side = (/** @type {Partial<{key: string|null, verifier: string|null}>} */ over = {}) => ({
  key: KEY,
  verifier: VERIFIER,
  ...over,
});

describe("the guarded paths", () => {
  it("name the real key file and verifier, which pin the fingerprint", () => {
    expect(KEY_PATH).toBe("tools/upstream/mozilla-release-key.asc");
    expect(VERIFIER_PATH).toBe("tools/upstream/verify-sha512.py");
    const verifier = readFileSync(join(ROOT, VERIFIER_PATH), "utf8");
    expect(verifier).toMatch(/^PINNED_FINGERPRINT = "[0-9A-F]{40}"$/m);
    expect(pinnedLines(verifier)?.some((l) => l.startsWith("PINNED_FINGERPRINT ="))).toBe(true);
    expect(readFileSync(join(ROOT, KEY_PATH), "utf8")).toContain("BEGIN PGP PUBLIC KEY BLOCK");
    expect(APPROVAL_LABEL).toBe("key-rotation-approved");
  });
});

describe("the guard's own files", () => {
  it("are the workflow, the script and its tests, and all exist", () => {
    expect(GUARD_PATHS).toEqual([
      ".github/workflows/key-guard.yml",
      "tools/ci/key-guard.mjs",
      "tools/ci/test/key-guard.test.mjs",
    ]);
    expect(GUARD_SCRIPT).toBe("tools/ci/key-guard.mjs");
    for (const path of GUARD_PATHS) expect(readFileSync(join(ROOT, path), "utf8")).not.toBe("");
  });

  it.each([
    ["changed", { [GUARD_SCRIPT]: "100644 blob aaa" }, { [GUARD_SCRIPT]: "100644 blob bbb" }],
    ["deleted", { [GUARD_SCRIPT]: "100644 blob aaa" }, { [GUARD_SCRIPT]: null }],
    ["added", { [GUARD_SCRIPT]: null }, { [GUARD_SCRIPT]: "100644 blob aaa" }],
  ])("are reported when one is %s", (how, before, after) => {
    const changes = keyChanges(side({ guard: before }), side({ guard: after }));
    expect(changes).toEqual([`${GUARD_SCRIPT} ${how} (the key guard itself)`]);
  });

  it("are not reported while the base has no guard yet (the pull request that adds it)", () => {
    const before = side({ guard: { [GUARD_SCRIPT]: null } });
    const after = side({ guard: { [GUARD_SCRIPT]: "100644 blob aaa" } });
    expect(keyChanges(before, after, { guardOnBase: false })).toEqual([]);
  });
});

describe("pinnedLines", () => {
  it("keeps every line that names PINNED_FINGERPRINT or KEY_FILE, in order", () => {
    expect(pinnedLines(VERIFIER)).toEqual([
      '"""Checks SHA512SUMS against PINNED_FINGERPRINT below."""',
      'PINNED_FINGERPRINT = "14F26682D0916CDD81E37B6D61B7B526D98F0353"',
      'KEY_FILE = Path(__file__).resolve().with_name("mozilla-release-key.asc")',
      "def check_signature(sums, signature, key_file=KEY_FILE, fingerprint=PINNED_FINGERPRINT):",
    ]);
  });

  it("a missing file has no lines", () => {
    expect(pinnedLines(null)).toBeNull();
  });
});

describe("keyChanges", () => {
  it("finds nothing when neither file changed", () => {
    expect(keyChanges(side(), side())).toEqual([]);
  });

  it("ignores a change elsewhere in the verifier", () => {
    const after = side({ verifier: VERIFIER.replace("{128}", "{128,}") + "# more\n" });
    expect(keyChanges(side(), after)).toEqual([]);
  });

  it.each([
    ["a changed key file", { key: KEY.replace("BF...", "BG...") }, KEY_PATH],
    ["a deleted key file", { key: null }, KEY_PATH],
    ["a whitespace-only key change", { key: KEY + "\n" }, KEY_PATH],
  ])("reports %s", (_, over, named) => {
    const changes = keyChanges(side(), side(over));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain(named);
  });

  it("reports a key file that appears", () => {
    expect(keyChanges(side({ key: null }), side())[0]).toContain(KEY_PATH);
  });

  it.each([
    ["a new fingerprint", VERIFIER.replace('"14F2', '"AAAA')],
    ["a second assignment", VERIFIER + 'PINNED_FINGERPRINT = "' + "A".repeat(40) + '"\n'],
    ["a fingerprint indented into a block", VERIFIER + '    PINNED_FINGERPRINT = "x"\n'],
    ["another key file", VERIFIER.replace('with_name("mozilla', 'with_name("other')],
    ["a changed default argument", VERIFIER.replace("fingerprint=PINNED", "fingerprint=OTHER")],
    ["a deleted verifier", null],
  ])("reports %s", (_, verifier) => {
    const changes = keyChanges(side(), side({ verifier }));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain(VERIFIER_PATH);
  });

  it("reports both files when both changed", () => {
    const after = side({ key: "x", verifier: VERIFIER.replace('"14F2', '"AAAA') });
    expect(keyChanges(side(), after)).toHaveLength(2);
  });
});

describe("parseLabels", () => {
  it.each([
    ["[]", []],
    ['["security","key-rotation-approved"]', ["security", "key-rotation-approved"]],
  ])("reads %s", (json, labels) => {
    expect(parseLabels(json)).toEqual(labels);
  });

  it.each(["", "null", "{}", '"key-rotation-approved"', "[1]", "[null]", "not json"])(
    "refuses %j",
    (json) => {
      expect(() => parseLabels(json)).toThrow();
    },
  );
});

describe("verdict", () => {
  const change = [`${KEY_PATH} changed`];

  it("passes when nothing changed, with or without the label", () => {
    expect(verdict([], []).ok).toBe(true);
    expect(verdict([], [APPROVAL_LABEL]).ok).toBe(true);
  });

  it("fails a change without the label, and names the label", () => {
    const v = verdict(change, ["security"]);
    expect(v.ok).toBe(false);
    expect(v.message).toContain(APPROVAL_LABEL);
    expect(v.message).toContain(KEY_PATH);
  });

  it("passes a change with the label", () => {
    const v = verdict(change, ["security", APPROVAL_LABEL]);
    expect(v.ok).toBe(true);
    expect(v.message).toContain(KEY_PATH);
  });

  it.each(["Key-Rotation-Approved", "key-rotation-approved ", "key-rotation"])(
    "does not take %j for the label",
    (label) => {
      expect(verdict(change, [label]).ok).toBe(false);
    },
  );
});

describe("the command line", () => {
  const GIT_ENV = {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  /** @param {string} cwd @param {string[]} args */
  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });

  /** @param {string} dir */
  const commit = (dir, msg = "c") => {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "--allow-empty", "-m", msg);
    return git(dir, "rev-parse", "HEAD").trim();
  };

  /**
   * A repo with the key material (and, unless `guard` is false, the guard's own files) on main,
   * and `change` on a branch made from it.
   */
  function repo(/** @type {(dir: string) => void} */ change, { guard = true } = {}) {
    const dir = tempDir("vimma-key-guard-");
    git(dir, "init", "-q", "-b", "main");
    mkdirSync(join(dir, "tools", "upstream"), { recursive: true });
    writeFileSync(join(dir, KEY_PATH), KEY);
    writeFileSync(join(dir, VERIFIER_PATH), VERIFIER);
    if (guard) writeGuard(dir);
    const base = commit(dir, "base");
    git(dir, "checkout", "-q", "-b", "pr");
    change(dir);
    const head = commit(dir, "head");
    return { dir, base, head };
  }

  /**
   * @param {{dir: string, base: string, head: string}} r
   * @param {string | null} labels  PR_LABELS, as toJSON(...labels.*.name) gives it; null unsets it
   */
  function run(r, labels = "[]", base = r.base) {
    /** @type {Record<string, string | undefined>} */
    const env = { ...process.env, ...GIT_ENV, PR_LABELS: labels ?? undefined };
    if (labels === null) delete env.PR_LABELS;
    const res = spawnSync(process.execPath, [SCRIPT, "--base", base, "--head", r.head], {
      cwd: r.dir,
      encoding: "utf8",
      env,
    });
    return { status: res.status, out: res.stdout + res.stderr };
  }

  /** @param {string} dir */
  function writeGuard(dir, text = "guard\n") {
    for (const path of GUARD_PATHS) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  }

  it("fails a change to any of the guard's own files without the label, and passes it with", () => {
    for (const path of GUARD_PATHS) {
      const r = repo((dir) => writeFileSync(join(dir, path), "weakened\n"));
      const res = run(r);
      expect(res.status, path).toBe(1);
      expect(res.out).toContain(path);
      expect(run(r, JSON.stringify([APPROVAL_LABEL])).status, path).toBe(0);
    }
  });

  it("fails a deleted guard file without the label", () => {
    const r = repo((dir) => rmSync(join(dir, GUARD_PATHS[0])));
    expect(run(r).status).toBe(1);
  });

  it("passes the pull request that first adds the guard to a base without one", () => {
    const r = repo((dir) => writeGuard(dir), { guard: false });
    expect(run(r).status).toBe(0);
  });

  it("passes a pull request that leaves the key alone", () => {
    const r = repo((dir) => writeFileSync(join(dir, "README.md"), "hi\n"));
    const res = run(r);
    expect(res.status).toBe(0);
  });

  it("fails a changed key file without the label", () => {
    const r = repo((dir) => writeFileSync(join(dir, KEY_PATH), KEY + "more\n"));
    const res = run(r, '["security"]');
    expect(res.status).toBe(1);
    expect(res.out).toContain(KEY_PATH);
    expect(res.out).toContain(APPROVAL_LABEL);
  });

  it("fails a changed fingerprint without the label, and passes it with", () => {
    const r = repo((dir) =>
      writeFileSync(join(dir, VERIFIER_PATH), VERIFIER.replace('"14F2', '"AAAA')),
    );
    expect(run(r).status).toBe(1);
    expect(run(r, JSON.stringify([APPROVAL_LABEL])).status).toBe(0);
  });

  it("fails a deleted key file", () => {
    const r = repo((dir) => rmSync(join(dir, KEY_PATH)));
    expect(run(r).status).toBe(1);
  });

  it("judges the pull request's own changes, not a newer main", () => {
    // main moves on (an approved rotation lands) after the branch was made: the branch changed
    // nothing, so it passes even though base and head hold different keys.
    const r = repo((dir) => writeFileSync(join(dir, "README.md"), "hi\n"));
    git(r.dir, "checkout", "-q", "main");
    writeFileSync(join(r.dir, KEY_PATH), KEY + "rotated\n");
    const newMain = commit(r.dir, "rotation");
    expect(run(r, "[]", newMain).status).toBe(0);
  });

  it("sees a change that a later commit of the branch does not undo", () => {
    const r = repo((dir) => {
      writeFileSync(join(dir, KEY_PATH), "other\n");
      commit(dir, "swap key");
      writeFileSync(join(dir, "README.md"), "hi\n");
    });
    expect(run(r).status).toBe(1);
  });

  it.each([
    ["missing labels", null],
    ["labels that are not a list of names", "{}"],
  ])("cannot check with %s (exit 2)", (_, labels) => {
    const r = repo((dir) => writeFileSync(join(dir, "README.md"), "hi\n"));
    expect(run(r, labels).status).toBe(2);
  });

  it("refuses a base or head that is not a commit hash (exit 2)", () => {
    const r = repo((dir) => writeFileSync(join(dir, "README.md"), "hi\n"));
    expect(run(r, "[]", "main").status).toBe(2);
    expect(run(r, "[]", "--output=/tmp/x").status).toBe(2);
  });

  it("fails a renamed key file or verifier", () => {
    const key = repo((dir) => git(dir, "mv", KEY_PATH, KEY_PATH + ".old"));
    expect(run(key).status).toBe(1);
    const verifier = repo((dir) => git(dir, "mv", VERIFIER_PATH, "tools/upstream/verify.py"));
    expect(run(verifier).status).toBe(1);
  });

  it("fails a key file replaced by a symlink to another key", () => {
    const r = repo((dir) => {
      writeFileSync(join(dir, "tools", "upstream", "other.asc"), KEY);
      rmSync(join(dir, KEY_PATH));
      symlinkSync("other.asc", join(dir, KEY_PATH));
    });
    expect(run(r).status).toBe(1);
  });

  it("still judges when started through a symlinked path", () => {
    // Node resolves import.meta.url to the real path but leaves argv[1] as given; a check that
    // compared the two would skip main() and exit 0 without a verdict.
    const r = repo((dir) => writeFileSync(join(dir, KEY_PATH), "other\n"));
    const real = tempDir("vimma-key-guard-real-");
    copyFileSync(SCRIPT, join(real, "key-guard.mjs"));
    const link = join(tempDir("vimma-key-guard-link-"), "via");
    symlinkSync(real, link);
    const res = spawnSync(
      process.execPath,
      [join(link, "key-guard.mjs"), "--base", r.base, "--head", r.head],
      { cwd: r.dir, encoding: "utf8", env: { ...process.env, ...GIT_ENV, PR_LABELS: "[]" } },
    );
    expect(res.status).toBe(1);
  });
});

describe("workflow wiring", () => {
  const text = readFileSync(join(ROOT, ".github", "workflows", "key-guard.yml"), "utf8");

  it("runs on pull_request, never pull_request_target, for every label change and push", () => {
    expect(text).toMatch(/^ {2}pull_request:\n {4}types: \[(.*)\]$/m);
    const types = /^ {4}types: \[(.*)\]$/m.exec(text)?.[1].split(/,\s*/) ?? [];
    expect(types.sort()).toEqual(["labeled", "opened", "reopened", "synchronize", "unlabeled"]);
    expect(text).not.toMatch(/^\s*pull_request_target:/m);
  });

  it("holds contents: read and nothing else", () => {
    expect(text).toMatch(/^permissions:\n {2}contents: read\n\n/m);
    expect(text).not.toMatch(/^ +permissions:/m);
    expect(text).toContain("persist-credentials: false");
  });

  it("has the job name the ruleset requires", () => {
    expect(text).toMatch(/^ {4}name: Mozilla release key unchanged or approved$/m);
  });

  it("skips the whole job once the pull request is merged, and still runs on a closed unmerged one", () => {
    // release-please swaps `autorelease: pending` for `autorelease: tagged` on a merged release
    // pull request, which fires unlabeled and labeled after the head branch is gone; the job
    // must not start, since no step could then find the head commit (#357).
    const job = /^ {2}key-guard:\n([\s\S]*?)^ {4}steps:/m.exec(text)?.[1] ?? "";
    expect(job).toMatch(/^ {4}if: github\.event\.pull_request\.merged != true$/m);
    expect(job).not.toMatch(/state == 'open'/);
    expect(text).not.toMatch(/^ {6}- if:|^ {8}if:/m);
  });

  it("passes event values to run: through env only", () => {
    expect(text).toContain("PR_LABELS: ${{ toJSON(github.event.pull_request.labels.*.name) }}");
    expect(text).toContain("BASE: ${{ github.event.pull_request.base.sha }}");
    expect(text).toContain("HEAD: ${{ github.event.pull_request.head.sha }}");
    const runs = text.split(/^ {8}run: /m).slice(1);
    expect(runs.length).toBeGreaterThan(0);
    for (const block of runs) expect(block.split(/^ {6}- /m)[0]).not.toContain("${{");
  });

  it("runs the guard as the base branch has it, falling back to the pull request's only when the base has none", () => {
    expect(text).toContain('git show "$BASE:tools/ci/key-guard.mjs"');
    // A base that is not there is an error, not a reason to run the pull request's copy, and the
    // fallback is taken only when the base commit lacks the file.
    expect(text).toContain('git cat-file -e "$BASE^{commit}" || exit 2');
    expect(text).toMatch(/if git cat-file -e "\$BASE:tools\/ci\/key-guard\.mjs"/);
    expect(text).not.toContain("2>/dev/null");
  });

  it("pins every action by commit", () => {
    const uses = [...text.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });
});
