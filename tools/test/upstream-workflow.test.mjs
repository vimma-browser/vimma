import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./temp-dir.mjs";

// Spec m7-upstream-autopilot, docs/security.md §10: the upstream autopilot's workflow shape.
// Text checks, like safebrowsing-workflows.test.mjs: no YAML dependency.
const dir = new URL("../../.github/workflows/", import.meta.url);
/** @param {string} name */
const workflow = (name) => readFileSync(new URL(name, dir), "utf8");
const upstream = workflow("upstream.yml");
const e2e = workflow("e2e.yml");
const source = readFileSync(new URL("../upstream/source-check.sh", import.meta.url), "utf8");

/**
 * @param {string} text a workflow
 * @param {string} id a job id
 * @returns {string} that job's YAML block
 */
function job(text, id) {
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

describe("upstream autopilot workflow", () => {
  it("detects every 4 hours, so a release has a PR within 6 hours", () => {
    expect(upstream).toContain('- cron: "17 */4 * * *"');
  });

  it("grants nothing by default and each job only what it needs", () => {
    expect(upstream).toMatch(/^permissions: \{\}$/m);
    expect(permissions(job(upstream, "detect"))).toEqual(["contents: read", "issues: read"]);
    expect(permissions(job(upstream, "track"))).toEqual(["contents: read", "issues: write"]);
    expect(permissions(job(upstream, "patch-check"))).toEqual(["contents: read"]);
    expect(permissions(job(upstream, "test"))).toEqual(["contents: read"]);
    expect(permissions(job(upstream, "drift"))).toEqual(["contents: read", "issues: write"]);
    expect(permissions(job(upstream, "key"))).toEqual(["issues: write"]);
    expect(permissions(job(upstream, "publish"))).toEqual([
      "contents: write",
      "pull-requests: write",
      "issues: write",
    ]);
  });

  it("no secret reaches detection, the patch check or the suites", () => {
    for (const id of ["detect", "track", "patch-check", "test", "drift"]) {
      expect(job(upstream, id), id).not.toContain("secrets.");
    }
    expect(job(upstream, "test")).not.toContain("secrets: inherit");
    expect(upstream).not.toMatch(/secrets\.SAFEBROWSING/);
  });

  it("detect compares Mozilla's KEY with the pinned key; a change opens a security issue", () => {
    const detect = job(upstream, "detect");
    expect(detect).toContain(
      "https://archive.mozilla.org/pub/firefox/nightly/latest-mozilla-central/KEY",
    );
    expect(detect).toContain("python3 tools/upstream/mozilla-key-check.py --current");
    expect(detect).toContain("key-title: ${{ steps.key.outputs.key-title }}");
    const key = job(upstream, "key");
    expect(key).toContain("if: needs.detect.outputs.key-title != ''");
    // It runs only gh: no checkout, so no repository code runs with issues: write.
    expect(key).not.toContain("actions/checkout");
    expect(key).not.toContain("secrets.");
    expect(key).toContain("--label security");
  });

  it("no workflow runs on pull_request_target", () => {
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
      expect(workflow(name), name).not.toMatch(/^\s*pull_request_target\s*:/m);
    }
  });

  it("every action it uses is pinned by a full commit SHA", () => {
    for (const [name, text] of [
      ["upstream.yml", upstream],
      ["e2e.yml", e2e],
    ]) {
      const uses = [...(text ?? "").matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((m) => m[1] ?? "");
      expect(uses.length, name).toBeGreaterThan(0);
      for (const u of uses) {
        if (u.startsWith("./")) continue;
        expect(u, `${name}: ${u}`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  it("the suites run through e2e.yml on the new version, read-only", () => {
    const block = job(upstream, "test");
    expect(block).toContain("uses: ./.github/workflows/e2e.yml");
    expect(block).toContain("firefox-version: ${{ needs.detect.outputs.version }}");
    expect(e2e).toMatch(/workflow_call:\n\s+inputs:\n\s+firefox-version:/);
    expect(e2e).toContain('python3 tools/upstream/bump-surfer-json.py "$VERSION"');
  });

  it("nothing is built from a tarball whose SHA-512 Mozilla did not publish", () => {
    // e2e.yml gets its source through firefox-source.sh, which verifies before Surfer unpacks.
    const fetch = e2e.indexOf("tools/upstream/firefox-source.sh");
    const imp = e2e.indexOf("run: npm run import");
    expect(fetch).toBeGreaterThan(0);
    expect(imp).toBeGreaterThan(fetch);
    const script = readFileSync(new URL("../upstream/firefox-source.sh", import.meta.url), "utf8");
    const verify = script.indexOf('python3 "$here/verify-sha512.py"');
    expect(verify).toBeGreaterThan(0);
    expect(script.indexOf("npx --no -- surfer download")).toBeGreaterThan(verify);
    expect(source).toContain('python3 "$here/verify-sha512.py"');
    expect(job(upstream, "patch-check")).toContain("tools/upstream/source-check.sh");
  });

  it("every verify-sha512.py call passes a signature", () => {
    // B1: no caller may check a hash against an unsigned SHA512SUMS. Every workflow and every
    // shell script under tools/ that calls the verifier fetches SHA512SUMS.asc and passes it.
    const callers = [
      ...readdirSync(dir).map((f) => [`.github/workflows/${f}`, workflow(f)]),
      ...readdirSync(new URL("..", import.meta.url), { recursive: true, encoding: "utf8" })
        .filter((f) => f.endsWith(".sh"))
        .map((f) => [`tools/${f}`, readFileSync(new URL(`../${f}`, import.meta.url), "utf8")]),
    ];
    const calls = callers.flatMap(([name, text]) => {
      const joined = text.replace(/\\\n\s*/g, " ");
      const lines = joined.split("\n").filter((l) => /^\s*[^#\s].*verify-sha512\.py/.test(l));
      return lines.map((line) => ({ name, text, line }));
    });
    expect(calls.map((c) => c.name).sort()).toEqual(
      expect.arrayContaining([
        "tools/upstream/firefox-source.sh",
        "tools/upstream/source-check.sh",
      ]),
    );
    for (const { name, text, line } of calls) {
      expect(line, name).toMatch(/--signature "?\$[a-z_{}]+\/SHA512SUMS\.asc"?/);
      expect(text, name).toMatch(/SHA512SUMS\.asc"? -o /);
    }
  });

  it("a report on a tarball that failed verification is never uploaded", () => {
    // source-check.sh writes `result` only after the signature and hash are verified, so an
    // upload gated on it never publishes patch-check output from an unverified tarball (G4, G10).
    for (const [name, step] of [
      ["upstream.yml", "Upload the patch-check report"],
      ["upstream-beta.yml", "Upload the source check"],
    ]) {
      const text = workflow(name);
      const at = text.indexOf(`- name: ${step}`);
      expect(at, name).toBeGreaterThan(0);
      const cond = /\n\s+if: (.*)\n/.exec(text.slice(at))?.[1];
      expect(cond, name).toBe("always() && steps.check.outputs.result != ''");
    }
  });

  it("npm run import refuses an engine/ whose source was never verified", () => {
    // B1 on a contributor's machine: import is the first step of every local build and lane.
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.import).toMatch(/^tools\/upstream\/verify-source\.sh --require && /);
  });

  it("upstream.yml checks the source through source-check.sh", () => {
    // One script for the release autopilot and the Beta canary, so their checks cannot drift.
    const block = job(upstream, "patch-check");
    expect(block).toContain('run: tools/upstream/source-check.sh "$VERSION"');
    expect(block).not.toContain("curl ");
    expect(block).toContain("result: ${{ steps.check.outputs.result }}");
    expect(block).toContain("artifacts: ${{ steps.check.outputs.artifacts }}");
    expect(source).toContain(`patch-check.py" --tarball - --drain`);
    expect(source).toContain("patch-audit.py");
    expect(source).toContain(`artifact-preflight.mjs" patch-check.json`);
  });

  it("falls back to a compare link when Actions may not open PRs", () => {
    const block = job(upstream, "publish");
    expect(block).toContain('grep -qi "not permitted to create or approve pull requests"');
    expect(block).toContain("autopilot-body.mjs");
    expect(block).toContain("body fallback");
  });

  // Spec upstream-beta-canary, decision 11: detect looks up the canary's issues with the
  // issues: read it already holds; publish only renders them into the bump PR's body.
  /** @param {string} version @param {string} ghOut @param {number} [ghStatus] */
  const betaLookup = (version, ghOut, ghStatus = 0) => {
    const tmp = tempDir("upstream-beta-lookup-");
    const out = join(tmp, "out");
    const argv = join(tmp, "argv");
    writeFileSync(out, "");
    writeFileSync(argv, "");
    writeFileSync(join(tmp, "list.json"), ghOut);
    writeFileSync(
      join(tmp, "gh"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argv}"\ncat "${join(tmp, "list.json")}"\nexit ${ghStatus}\n`,
      { mode: 0o755 },
    );
    const r = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script(step(upstream, "beta"))], {
      encoding: "utf8",
      env: {
        PATH: `${tmp}:${process.env.PATH}`,
        VERSION: version,
        GITHUB_OUTPUT: out,
        GITHUB_REPOSITORY: "vimma-browser/vimma",
        GITHUB_STEP_SUMMARY: join(tmp, "summary"),
      },
    });
    return {
      status: r.status,
      stdout: r.stdout,
      output: readFileSync(out, "utf8"),
      argv: readFileSync(argv, "utf8").trim().split("\n").join(" "),
    };
  };

  it("detect finds the canary's issues for the release's major, open and closed", () => {
    const list = JSON.stringify([
      { number: 230, state: "OPEN", title: "Firefox 159 beta: canary findings" },
      { number: 221, state: "CLOSED", title: "Firefox 159 beta: canary findings" },
      { number: 219, state: "CLOSED", title: "Firefox 158 beta: canary findings" },
      { number: 218, state: "OPEN", title: "Re: Firefox 159 beta: canary findings" },
    ]);
    const r = betaLookup("159.0", list);
    expect(r.status).toBe(0);
    expect(r.output).toBe(
      'beta-issues=[{"number":230,"state":"OPEN"},{"number":221,"state":"CLOSED"}]\n',
    );
    expect(r.argv).toContain(
      "issue list --repo vimma-browser/vimma --state all --label upstream-beta",
    );
    expect(r.argv).toContain('--search "Firefox 159 beta: canary findings" in:title');
    expect(betaLookup("159.0.1", list).output).toContain('"number":230');
  });

  it("a failed lookup never stops the bump: no issues, a warning", () => {
    const r = betaLookup("159.0", "", 1);
    expect(r.status).toBe(0);
    expect(r.output).toBe("beta-issues=[]\n");
    expect(r.stdout).toContain("::warning::");
  });

  it("the bump PR's body gets the canary's issues from detect", () => {
    expect(job(upstream, "detect")).toContain("beta-issues: ${{ steps.beta.outputs.beta-issues }}");
    const block = job(upstream, "publish");
    expect(block).toContain("BETA_ISSUES: ${{ needs.detect.outputs.beta-issues }}");
    expect(block).toContain('--beta-issues "$BETA_ISSUES"');
  });

  it("the drift job fails the run", () => {
    const block = job(upstream, "drift");
    expect(block).toContain("if: needs.detect.outputs.drift == 'overdue'");
    expect(block).toMatch(/exit 1\n?$/);
  });
});

/**
 * @param {string} text a workflow
 * @param {string} id a step's `id:`
 * @returns {string} that step's YAML, from its `- name:` line to the next step
 */
function step(text, id) {
  const steps = text.split(/^(?= {6}- )/m);
  const found = steps.find((s) => new RegExp(`^ {8}id: ${id}$`, "m").test(s));
  if (!found) throw new Error(`no step with id ${id}`);
  return found.replace(/\n{2,}[^]*$/, "\n");
}

/** @param {string} block a step @returns {string} its `run: |` script, unindented */
function script(block) {
  const m = /^ {8}run: \|\n((?: {10}.*\n|\n)+)/m.exec(block);
  if (!m?.[1]) throw new Error("no run block");
  return m[1].replace(/^ {10}/gm, "");
}

// Spec upstream-beta-canary, decision 4. A Firefox Beta (`159.0b1`) turns on Beta mode: every
// check and suite runs and is reported in suite-results.json. Anything else, PR CI and the
// release autopilot included, fails on the first failure exactly as before.
describe("e2e.yml Beta mode", () => {
  /** @param {string} version @returns {string} the mode step's `beta` output */
  const mode = (version) => {
    const dir = tempDir("e2e-mode-");
    const out = join(dir, "out");
    writeFileSync(out, "");
    const r = spawnSync("bash", ["-e", "-c", script(step(e2e, "mode"))], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, VERSION: version, GITHUB_OUTPUT: out },
    });
    expect(r.status, r.stderr).toBe(0);
    return readFileSync(out, "utf8");
  };

  it("is on only for a version matching ^\\d+\\.0b\\d+$", () => {
    for (const v of ["159.0b1", "159.0b12", "160.0b3"]) expect(mode(v), v).toBe("beta=true\n");
    for (const v of [
      "",
      "158.0",
      "158.0.1",
      "160.0a1",
      "159.1b1",
      "159.0b",
      "159.0b1 ",
      "x159.0b1",
      "159.0b1\n158.0",
    ]) {
      expect(mode(v), JSON.stringify(v)).toBe("beta=false\n");
    }
  });

  it("can be started by hand on a version, as well as by upstream.yml", () => {
    expect(e2e).toMatch(/workflow_dispatch:\n\s+inputs:\n\s+firefox-version:/);
    expect(e2e).toMatch(/^ {2}pull_request:\n/m);
  });

  it("passes --allow-beta to bump-surfer-json.py only in beta mode", () => {
    const block = step(e2e, "bump");
    expect(block).toContain("BETA: ${{ steps.mode.outputs.beta }}");
    const run = script(block);
    expect(run).toMatch(
      /if \[ "\$BETA" = true \]; then\n\s+python3 tools\/upstream\/bump-surfer-json.py --allow-beta "\$VERSION"\nelse\n\s+python3 tools\/upstream\/bump-surfer-json.py "\$VERSION"\nfi/,
    );
    expect(e2e.match(/bump-surfer-json.py --allow-beta/g)).toHaveLength(1);
    expect(e2e.indexOf("id: mode")).toBeLessThan(e2e.indexOf("id: bump"));
  });

  it("e2e.yml continues after a failed suite only in beta mode", () => {
    const lines = [...e2e.matchAll(/^\s*continue-on-error:.*$/gm)].map((m) => m[0].trim());
    expect(lines).toEqual(
      Array(4).fill("continue-on-error: ${{ steps.mode.outputs.beta == 'true' }}"),
    );
    for (const id of ["branding", "upstream-prefs", "mochitest", "e2e"]) {
      expect(step(e2e, id), id).toContain(
        "continue-on-error: ${{ steps.mode.outputs.beta == 'true' }}",
      );
    }
    // the build steps still stop the job: there is nothing to test without them
    for (const id of ["import", "artifact-build"]) {
      expect(step(e2e, id), id).not.toContain("continue-on-error");
    }
  });

  // `npm run mochitest` prints mach's own log format, not TBPL: Beta mode asks mozlog for a TBPL
  // log file as well. A fake npm records the command each step runs.
  /** @param {string} id @param {string} beta @returns {{ status: number | null, argv: string }} */
  const runStep = (id, beta) => {
    const dir = tempDir("e2e-step-");
    const record = join(dir, "argv");
    writeFileSync(join(dir, "npm"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\nexit 3\n`, {
      mode: 0o755,
    });
    const r = spawnSync("bash", ["-e", "-c", script(step(e2e, id))], {
      encoding: "utf8",
      env: { PATH: `${dir}:${process.env.PATH}`, BETA: beta, RUNNER_TEMP: "/t" },
    });
    return { status: r.status, argv: readFileSync(record, "utf8").trim().split("\n").join(" ") };
  };

  it("a release run's suite commands are exactly as before, and fail their step", () => {
    expect(runStep("mochitest", "false")).toEqual({
      status: 3,
      argv: "run mochitest -- --artifact --setenv=VIMMA_REQUIRE_CTL=1 tests/browser/",
    });
    expect(runStep("e2e", "false")).toEqual({ status: 3, argv: "run e2e -- --artifact" });
  });

  it("a beta run also writes the mochitests' TBPL log and the e2e report, and fails its step", () => {
    expect(runStep("mochitest", "true")).toEqual({
      status: 3,
      argv:
        "run mochitest -- --artifact --setenv=VIMMA_REQUIRE_CTL=1 " +
        "--log-tbpl=/t/mochitest.tbpl.log tests/browser/",
    });
    expect(runStep("e2e", "true")).toEqual({
      status: 3,
      argv: "run e2e -- --artifact --report-json /t/e2e-report.json",
    });
    for (const id of ["mochitest", "e2e"]) {
      expect(step(e2e, id), id).toContain("BETA: ${{ steps.mode.outputs.beta }}");
    }
    expect(step(e2e, "suite-results")).toContain(
      '--mochitest-log "$RUNNER_TEMP/mochitest.tbpl.log"',
    );
  });

  it("writes and uploads suite-results.json only in beta mode, even after a failed step, never on a cancelled run", () => {
    const write = step(e2e, "suite-results");
    expect(write).toContain(`if: "!cancelled() && steps.mode.outputs.beta == 'true'"`);
    expect(write).toContain("STEPS: ${{ toJSON(steps) }}");
    expect(write).toContain("node tools/upstream/suite-results.mjs");
    const upload = e2e.slice(e2e.indexOf("id: suite-results"));
    expect(upload).toMatch(
      /- name: Upload suite-results\.json[^]*?if: "!cancelled\(\) && steps\.mode\.outputs\.beta == 'true'"[^]*?name: suite-results\n/,
    );
  });

  // B9: the canary records findings in its issue and its run stays green; a manual Beta run of
  // e2e.yml, and any caller that does not say otherwise, still fails once everything reported.
  it("fails on findings unless the caller passes fail-on-findings: false", () => {
    expect(e2e).toMatch(
      /workflow_call:\n\s+inputs:\n(?:.*\n)*?\s+fail-on-findings:\n\s+description: .*\n\s+type: boolean\n\s+required: false\n\s+default: true\n/,
    );
    const block = step(e2e, "suite-results");
    expect(block).toContain("FAIL_ON_FINDINGS: ${{ inputs.fail-on-findings }}");
    /** @param {number} exit suite-results.mjs's status @param {string} flag */
    const run = (exit, flag) => {
      const tmp = tempDir("e2e-findings-");
      writeFileSync(join(tmp, "node"), `#!/bin/sh\nexit ${exit}\n`, { mode: 0o755 });
      return spawnSync("bash", ["-e", "-c", script(block)], {
        encoding: "utf8",
        env: { PATH: `${tmp}:${process.env.PATH}`, FAIL_ON_FINDINGS: flag, RUNNER_TEMP: tmp },
      }).status;
    };
    // "" is a pull_request or workflow_dispatch run, where the input does not exist
    for (const flag of ["", "true"]) expect(run(1, flag), flag).toBe(1);
    expect(run(1, "false")).toBe(0);
    expect(run(0, "false")).toBe(0);
    // a usage error (2) is a broken step, never a finding
    for (const flag of ["", "true", "false"]) expect(run(2, flag), flag).toBe(2);
  });

  it("a release run uploads failed screenshots as before; a beta run when the e2e step failed", () => {
    expect(e2e).toContain(
      "if: failure() || (steps.mode.outputs.beta == 'true' && steps.e2e.outcome == 'failure')",
    );
  });
});

describe("e2e.yml concurrency", () => {
  it("a run cancels only an older run of the same ref and version", () => {
    // A manual Beta run on a branch must not cancel the canary's run of that Beta on main, nor
    // the autopilot's run on main a manual run without a version; a new push to a PR still
    // cancels that PR's older run. Only a PR run cancels: a manual run of the version the
    // autopilot or the canary is testing waits for that run (workflow-concurrency.test.mjs).
    expect(e2e).toContain("group: e2e-${{ github.ref }}-${{ inputs.firefox-version }}");
    expect(e2e).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });
});

// Spec upstream-bump-automation, sub-PR 1 (decisions 1 to 4).
describe("pref refresh in the upstream autopilot", () => {
  it("source-check computes the refresh only after the SHA-512 check passed", () => {
    expect(source).toContain("--extract browser/app/profile/firefox.js");
    expect(source).toContain("--extract modules/libpref/init/all.js");
    const verify = source.indexOf('python3 "$here/verify-sha512.py"');
    const refresh = source.indexOf('node "$here/upstream-prefs.mjs"');
    expect(refresh).toBeGreaterThan(verify);
    expect(source).toContain("--write-diff prefs-refresh.patch");
  });

  it("the patch-check artifact carries the refresh and the job exports its state", () => {
    const block = job(upstream, "patch-check");
    expect(block).toContain("prefs: ${{ steps.check.outputs.prefs }}");
    // A path line of the upload step's `path: |` list (12 spaces), not a regex over the block.
    const upload = block.slice(block.indexOf("name: patch-check"));
    expect(upload.split("\n")).toContain("            prefs-refresh.*");
  });

  it("the e2e call passes the prefs patch and no secret", () => {
    const block = job(upstream, "test");
    expect(block).toContain("prefs-patch-artifact: patch-check");
    expect(block).not.toContain("secrets");
    expect(e2e).toMatch(/workflow_call:\n(?:.*\n)*?\s+prefs-patch-artifact:\n/);
  });

  it("a pull request run never writes prefs", () => {
    // Only workflow_call declares the input; on a pull request it is empty and the step skips.
    const head = e2e.slice(0, e2e.indexOf("\njobs:\n"));
    const dispatch = head.slice(head.indexOf("workflow_dispatch:"), head.indexOf("workflow_call:"));
    expect(dispatch).not.toContain("prefs-patch-artifact");
    const apply = step(e2e, "prefs-refresh");
    expect(apply).toContain("if: inputs.prefs-patch-artifact != ''");
    expect(apply).not.toContain("secrets");
    // The refresh lands before the import and the strict check, which still runs.
    expect(e2e.indexOf("id: prefs-refresh")).toBeLessThan(e2e.indexOf("run: npm run import"));
    expect(e2e).toContain("run: node tools/upstream/upstream-prefs.mjs\n");
  });

  it("publish commits the refreshed lines with the bump and lists them in the body", () => {
    const block = job(upstream, "publish");
    // --include: the refresh can only ever touch the branding file.
    const apply = block.search(
      /git apply --include=src\/browser\/branding\/vimma\/pref\/firefox-branding\.js \\\n\s+"\$pc\/prefs-refresh\.patch"/,
    );
    expect(apply).toBeGreaterThan(0);
    expect(apply).toBeLessThan(block.indexOf('git commit -am "upstream: firefox $VERSION"'));
    expect(block).toContain('--prefs "$pc/prefs-refresh.json"');
  });
});

// Spec upstream-bump-automation, sub-PR 3 (decisions 14 and 15).
describe("fuzz re-export in the upstream autopilot", () => {
  it("source-check re-exports only after the SHA-512 check, from the extracted patched files", () => {
    const verify = source.indexOf('python3 "$here/verify-sha512.py"');
    const reexport = source.indexOf('python3 "$here/reexport.py"');
    expect(reexport).toBeGreaterThan(verify);
    expect(source).toContain('python3 "$here/patch-check.py" --list-files');
    expect(source).toContain("--out reexport");
  });

  it("the patch-check artifact carries the re-export", () => {
    const upload = job(upstream, "patch-check");
    expect(upload.slice(upload.indexOf("name: patch-check")).split("\n")).toContain(
      "            reexport/",
    );
  });

  it("publish commits re-exported patches as a second commit, only under src/", () => {
    const block = job(upstream, "publish");
    const bump = block.indexOf('git commit -am "upstream: firefox $VERSION"');
    const second = block.indexOf('git commit -m "upstream: re-export $names for firefox $VERSION"');
    expect(second).toBeGreaterThan(bump);
    expect(block).toContain("^src/[A-Za-z0-9._/-]+\\.patch$");
    expect(block).toContain('--reexport "$pc/reexport/reexport.json"');
  });
});

// Spec upstream-bump-automation, decisions 6 to 13 (docs/security.md, G13 and G14).
describe("auto-merge in the upstream autopilot", () => {
  it("auto-merge only with the variable, the token, a ready PR and the allowlist", () => {
    const decide = step(upstream, "pr");
    expect(decide).toContain("AUTO_MERGE: ${{ vars.AUTO_MERGE_UPSTREAM }}");
    const decideRun = script(decide);
    expect(decideRun).toContain("node tools/upstream/bump-diff.mjs");
    expect(decideRun).toContain('--bump-diff "$RUNNER_TEMP/bump-diff.json"');
    // step() stops at the first blank line; the outputs are written further down the step.
    expect(job(upstream, "publish")).toContain('echo "auto-merge=$(body pr --auto-merge-only)"');
    const block = step(upstream, "automerge");
    // Only the fine-grained token: a GITHUB_TOKEN merge would start no push workflow on main.
    expect(block).toContain("GH_TOKEN: ${{ secrets.UPSTREAM_PR_TOKEN }}");
    expect(block).not.toContain("github.token");
    expect(block).toContain(
      "if: steps.pr.outputs.number != '' && steps.pr.outputs.auto-merge == 'true'",
    );
    const run = script(block);
    expect(run).toContain("--json isDraft,headRefOid");
    expect(run).toContain('[ "$draft" = false ] && [ "$pr_head" = "$head" ]');
    expect(upstream.indexOf("bump-diff.mjs")).toBeLessThan(upstream.indexOf("--auto --squash"));
  });

  it("auto-merge uses --match-head-commit and the bump's subject", () => {
    const run = script(step(upstream, "automerge"));
    expect(run).toContain('gh pr merge "$number" --auto --squash --match-head-commit "$head"');
    expect(run).toContain('--subject "$TITLE (#$number)"');
  });

  it("the allowlist reads the branch as pushed", () => {
    const run = script(step(upstream, "pr"));
    expect(run).toContain('git diff --unified=0 "origin/main...$head"');
    expect(run.indexOf("head=$(git rev-parse HEAD)")).toBeLessThan(run.indexOf("git diff"));
  });

  it("rebuild disables auto-merge before the push", () => {
    const block = job(upstream, "publish");
    const disable = block.indexOf('gh pr merge "$n" --disable-auto');
    const push = block.indexOf('git push --force origin "HEAD:refs/heads/$branch"');
    expect(disable).toBeGreaterThan(0);
    expect(disable).toBeLessThan(push);
  });

  it("the token reaches only publish", () => {
    const at = upstream.split("\n").filter((l) => l.includes("secrets.UPSTREAM_PR_TOKEN"));
    expect(at.length).toBeGreaterThan(0);
    const publish = job(upstream, "publish");
    for (const l of at) expect(publish).toContain(l);
  });
});

// Spec upstream-bump-automation, decisions 16 to 21 (docs/security.md, G15).
describe("the failing-patches issue in the upstream autopilot", () => {
  it("patch-issue runs only on a failed patch check, with issues: write and no secret", () => {
    const block = job(upstream, "patch-issue");
    expect(block).toContain("needs.patch-check.outputs.result == 'fail'");
    expect(permissions(block)).toEqual(["contents: read", "issues: write"]);
    expect(block).not.toContain("secrets.");
    expect(block).toContain("GH_TOKEN: ${{ github.token }}");
    expect(block).toContain("persist-credentials: false");
  });

  it("patch-issue updates the open issue with the same title", () => {
    const run = script(step(upstream, "patch-issue"));
    expect(run).toContain("select(.title == $t)");
    expect(run).toContain('gh issue edit "$n" --body-file');
    expect(run).toContain('gh issue create --title "$title" --label upstream --label triage');
    // Outside text only through files, never in a command line.
    expect(run).not.toMatch(/--body "/);
  });

  it("publish hands the bump PR's number to patch-issue", () => {
    expect(job(upstream, "publish")).toContain("pr: ${{ steps.pr.outputs.number }}");
    expect(job(upstream, "patch-issue")).toContain("PR: ${{ needs.publish.outputs.pr }}");
  });

  it("no workflow holds an AI secret", () => {
    for (const f of readdirSync(dir).filter((x) => x !== "claude.yml")) {
      expect(workflow(f), f).not.toMatch(/ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/);
    }
  });
});
