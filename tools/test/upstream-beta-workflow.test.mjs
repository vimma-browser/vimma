import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.mjs";

// Spec upstream-beta-canary, B8–B10 and "Security and privacy"; docs/security.md G9, G10. The
// Beta canary's workflow shape. Text checks, like upstream-workflow.test.mjs: no YAML dependency.
const dir = new URL("../../.github/workflows/", import.meta.url);
const text = readFileSync(new URL("upstream-beta.yml", dir), "utf8");
const e2e = readFileSync(new URL("e2e.yml", dir), "utf8");
const JOBS = ["detect", "source-check", "test", "render", "report"];

/** @param {string} id a job id @returns {string} that job's YAML block */
function job(id) {
  const body = text.slice(text.indexOf("\njobs:\n") + 7);
  const parts = body.split(/^ {2}([a-z][a-z0-9-]*):\n/m).slice(1);
  for (let i = 0; i < parts.length; i += 2) if (parts[i] === id) return parts[i + 1] ?? "";
  throw new Error(`no job ${id}`);
}

/** @param {string} block @returns {string[]} the job's `permissions:` lines, comments dropped */
function permissions(block) {
  const m = /^ {4}permissions:\n((?: {6}[a-z-]+: [a-z]+.*\n)+)/m.exec(block);
  if (!m?.[1]) return [];
  return m[1]
    .trim()
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim());
}

/** @param {string} block a job @param {string} id a step's `id:` @returns {string} its script */
function script(block, id) {
  const steps = block.split(/^(?= {6}- )/m);
  const found = steps.find((s) => new RegExp(`^ {8}id: ${id}$`, "m").test(s));
  if (!found) throw new Error(`no step with id ${id}`);
  const m = /^ {8}run: \|\n((?: {10}.*\n|\n)+)/m.exec(found);
  if (!m?.[1]) throw new Error(`no run block in ${id}`);
  return m[1].replace(/^ {10}/gm, "");
}

describe("upstream-beta.yml (the Beta canary)", () => {
  it("runs every 6 hours and by hand, never on pull_request_target", () => {
    expect(text).toMatch(/^ {2}schedule:\n {4}- cron: "41 \*\/6 \* \* \*"\n/m);
    expect(text).toMatch(/^ {2}workflow_dispatch:\n {4}inputs:\n {6}version:/m);
    expect(text).not.toMatch(/^\s*(pull_request\w*|push|workflow_run|issue_comment)\s*:/m);
  });

  it("grants nothing by default and no job more than issues: write", () => {
    expect(text).toMatch(/^permissions: \{\}$/m);
    expect(permissions(job("detect"))).toEqual(["contents: read", "actions: read"]);
    expect(permissions(job("source-check"))).toEqual(["contents: read"]);
    expect(permissions(job("test"))).toEqual(["contents: read"]);
    expect(permissions(job("render"))).toEqual(["contents: read"]);
    expect(permissions(job("report"))).toEqual(["issues: write"]);
    for (const p of [
      "contents: write",
      "pull-requests",
      "actions: write",
      "id-token",
      "packages",
    ]) {
      expect(text, p).not.toContain(p);
    }
    expect(text.match(/issues: write/g)).toHaveLength(1);
  });

  it("the job with issues: write checks out and runs no repository code", () => {
    const report = job("report");
    expect(report).not.toContain("actions/checkout");
    expect(report).not.toMatch(/\bnode\b|\bnpm\b|\bnpx\b|python|tools\//);
    // it only reads the issue.json render produced, with gh and jq
    expect(report).toContain("actions/download-artifact@");
    expect(report).toContain("gh issue");
    for (const id of ["detect", "source-check", "render"]) {
      expect(job(id), id).toContain("persist-credentials: false");
    }
  });

  it("the report job runs only on main", () => {
    expect(job("report")).toMatch(/^ {4}if: (?:>-\n\s+)?[^\n]*github\.ref == 'refs\/heads\/main'/m);
    // no other job writes anything, so a manual run on a branch writes nothing
    for (const id of JOBS.filter((j) => j !== "report")) {
      expect(job(id), id).not.toContain("gh issue");
      expect(job(id), id).not.toContain("gh label");
    }
  });

  it("no job pushes, commits or opens a pull request", () => {
    expect(text).not.toMatch(/git (push|commit)|gh pr |gh release|gh api -X|--method/);
    expect(text).not.toContain("surfer.json");
  });

  it("no secret reaches any job, and the e2e call passes none", () => {
    expect(text).not.toContain("secrets.");
    expect(text).not.toMatch(/^\s*secrets:/m);
    expect(job("test")).toContain("uses: ./.github/workflows/e2e.yml");
  });

  it("every job is skipped outside vimma-browser/vimma", () => {
    for (const id of JOBS) {
      expect(job(id), id).toMatch(
        /^ {4}if: (?:>-\n\s+)?[^\n]*github\.repository == 'vimma-browser\/vimma'/m,
      );
    }
  });

  it("nothing is built from a tarball whose SHA-512 Mozilla did not publish", () => {
    // source-check.sh exits 1 on a mismatch: the job fails, so the suites and the report
    // never see that tarball (G10), and e2e.yml checks its own download through firefox-source.sh.
    expect(job("source-check")).toContain('run: tools/upstream/source-check.sh "$VERSION"');
    expect(job("test")).toMatch(/needs: \[detect, source-check\]/);
    expect(job("test")).toContain("needs.source-check.outputs.result == 'ok'");
    expect(job("test")).toContain("needs.source-check.outputs.artifacts == 'yes'");
    expect(job("render")).toContain("needs.source-check.result == 'success'");
    expect(e2e).toContain("tools/upstream/firefox-source.sh");
  });

  it("every action is pinned by a full commit SHA", () => {
    const uses = [...text.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((m) => m[1] ?? "");
    expect(uses.length).toBeGreaterThan(3);
    for (const u of uses) {
      if (u === "./.github/workflows/e2e.yml") continue;
      expect(u).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("the suites report findings without failing the run (B9)", () => {
    const block = job("test");
    expect(block).toContain("firefox-version: ${{ needs.detect.outputs.version }}");
    expect(block).toContain("fail-on-findings: false");
    // render runs after failed suites, never after a cancelled run
    expect(job("render")).toMatch(/^ {4}if: (?:>-\n\s+)?[^\n]*!cancelled\(\)/m);
    expect(job("render")).toContain("name: suite-results");
  });
});

// The report job's scripts, run in bash against a fake `gh` that records every call and answers
// `gh issue list` from a file: what the canary does to issues, without GitHub.
describe("upstream-beta.yml report job", () => {
  /**
   * @param {{ issue?: object | null, open?: Array<{ number: number, title: string }>,
   *   tracking?: Array<{ number: number, title: string }>, released?: string }} o
   * @returns {{ status: number | null, calls: string[], files: Record<string, string>,
   *   stderr: string }}
   */
  const report = ({ issue = null, open = [], tracking = [], released = "158" }) => {
    const tmp = tempDir("canary-report-");
    const bin = join(tmp, "bin");
    mkdirSync(bin);
    mkdirSync(join(tmp, "canary"));
    if (issue) writeFileSync(join(tmp, "canary", "issue.json"), JSON.stringify(issue));
    writeFileSync(join(tmp, "open.json"), JSON.stringify(open));
    writeFileSync(join(tmp, "tracking.json"), JSON.stringify(tracking));
    // Records argv (one call per line) and copies each --body-file it is given. $((...)) strips
    // the padding BSD wc (macOS) puts before the count; GNU wc's bare count passes unchanged.
    writeFileSync(
      join(bin, "gh"),
      `#!/usr/bin/env bash
echo "$*" >> "${tmp}/calls"
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  if [ "\${args[i]}" = --body-file ]; then cp "\${args[i+1]}" "${tmp}/body-$(($(wc -l < "${tmp}/calls")))"; fi
done
case "$1 $2" in
  "issue list") if [[ "$*" == *"--label upstream "* ]]; then cat "${tmp}/tracking.json"; else cat "${tmp}/open.json"; fi ;;
  "issue create") echo "https://github.com/vimma-browser/vimma/issues/300" ;;
esac
`,
      { mode: 0o755 },
    );
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: tmp,
      RELEASED: released,
      GH_TOKEN: "t",
      GH_REPO: "vimma-browser/vimma",
    };
    const block = job("report");
    let status = 0;
    let stderr = "";
    for (const id of ["released", "apply"]) {
      const r = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script(block, id)], {
        encoding: "utf8",
        env,
      });
      stderr += r.stderr;
      if (r.status !== 0) {
        status = r.status ?? 1;
        break;
      }
    }
    const callsFile = join(tmp, "calls");
    const calls = existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n") : [];
    /** @type {Record<string, string>} */
    const files = {};
    calls.forEach((_, i) => {
      const f = join(tmp, `body-${i + 1}`);
      if (existsSync(f)) files[String(i + 1)] = readFileSync(f, "utf8");
    });
    return { status, calls, files, stderr };
  };
  const TITLE = "Firefox 159 beta: canary findings";
  const issue = {
    version: "159.0b2",
    major: 159,
    title: TITLE,
    label: "upstream-beta",
    findings: true,
    action: "update",
    body: "BODY\n",
    openBody: "BODY\n@JRanne: new\n",
    comment: "COMMENT\n",
    closeComment: "CLOSED\n",
  };
  /** @param {string[]} calls */
  const writes = (calls) => calls.filter((c) => !/^(issue list|label create)/.test(c));

  it("opens the issue with the owner mention when none is open", () => {
    const r = report({ issue });
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls[0]).toMatch(/^label create upstream-beta --force/);
    const w = writes(r.calls);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(new RegExp(`^issue create --title ${TITLE} --label upstream-beta`));
    const n = String(r.calls.indexOf(w[0] ?? "") + 1);
    expect(r.files[n]).toBe("BODY\n@JRanne: new\n");
  });

  it("updates the open issue's body and comments when the results changed", () => {
    const r = report({ issue, open: [{ number: 41, title: TITLE }] });
    expect(r.status, r.stderr).toBe(0);
    const w = writes(r.calls);
    expect(w.map((c) => c.split(" --")[0])).toEqual(["issue edit 41", "issue comment 41"]);
    expect(Object.values(r.files)).toEqual(["BODY\n", "COMMENT\n"]);
  });

  it("updates the body without a comment when the results are unchanged", () => {
    const r = report({
      issue: { ...issue, comment: "" },
      open: [
        { number: 40, title: "Firefox 159 beta: canary findings (old)" },
        { number: 41, title: TITLE },
      ],
    });
    expect(writes(r.calls).map((c) => c.split(" --")[0])).toEqual(["issue edit 41"]);
  });

  it("closes the open issue when everything passes, and does nothing when none is open", () => {
    const pass = { ...issue, findings: false, action: "close", comment: "" };
    const r = report({ issue: pass, open: [{ number: 41, title: TITLE }] });
    expect(writes(r.calls)).toEqual(["issue close 41 --comment CLOSED"]);
    expect(writes(report({ issue: { ...pass, action: "none" } }).calls)).toEqual([]);
  });

  it("closes issues of released versions and links the tracking issue", () => {
    const r = report({
      released: "159",
      open: [
        { number: 30, title: "Firefox 158 beta: canary findings" },
        { number: 41, title: TITLE },
        { number: 50, title: "Firefox 160 beta: canary findings" },
        { number: 51, title: "Something else" },
      ],
      tracking: [
        { number: 77, title: "Firefox 159.0 released (draft)" },
        { number: 78, title: "Firefox 159.0 released" },
      ],
    });
    expect(r.status, r.stderr).toBe(0);
    const closes = writes(r.calls);
    expect(closes).toEqual([
      "issue close 30 --comment Firefox 158 is released: the release autopilot (upstream.yml) takes it from here.",
      "issue close 41 --comment Firefox 159 is released: the release autopilot (upstream.yml) takes it from here, in #78.",
    ]);
    // the issue of a released version is never reopened by a late result for it
    const late = report({ released: "159", issue });
    expect(writes(late.calls)).toEqual([]);
  });

  it("does nothing but the released check when render did not run", () => {
    const r = report({ open: [{ number: 41, title: TITLE }] });
    expect(r.status, r.stderr).toBe(0);
    expect(writes(r.calls)).toEqual([]);
  });

  it("never mentions anyone outside a newly opened issue", () => {
    const block = job("report");
    expect(block.match(/openBody/g)).toHaveLength(1);
    expect(block).toMatch(/jq -j '\.openBody'[^\n]*\n[^\n]*gh issue create/);
  });
});
