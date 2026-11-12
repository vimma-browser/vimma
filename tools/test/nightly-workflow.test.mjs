import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jobs, parseWorkflow } from "./workflow-runners.mjs";
import { tempDir } from "./temp-dir.mjs";
import { runJobs } from "./workflow-if.mjs";
import { readRecord } from "../update/nightly-change.mjs";

// Spec build-supply-chain, decision 23, and spec m6a-updater, decisions 42 and 43: the nightly's
// build job keeps the package as a short-lived workflow artifact and holds no write token. Only
// while the repository variables NIGHTLY_RELEASE_ENABLED and UPDATES_ENABLED are both `true`
// does a nightly reach the public: its MAR is signed by update-publish.yml's mar-sign, checked,
// listed in a cosign-signed SHA256SUMS, uploaded to the rolling `nightly` pre-release by a job
// that runs no repository code, and offered by the nightly channel's update manifest. Reporting a
// failure is a job of its own. Parsed as YAML (js-yaml), like self-hosted-runner.test.mjs.
const TEXT = readFileSync(new URL("../../.github/workflows/nightly.yml", import.meta.url), "utf8");
const JOBS = jobs(TEXT);
const PINNED = /^actions\/(upload|download)-artifact@[0-9a-f]{40}$/;
/** What every job after the build needs: public nightlies and update signing both on. */
const PUBLIC =
  "vars.NIGHTLY_ENABLED == 'true' && github.repository == 'vimma-browser/vimma' && " +
  "github.ref == 'refs/heads/main' && vars.NIGHTLY_RELEASE_ENABLED == 'true' && " +
  "vars.UPDATES_ENABLED == 'true'";
/** update-publish.yml's jobs' permissions: GitHub refuses a call whose jobs ask for more. */
const CEILING = {
  "id-token": "write",
  actions: "write",
  contents: "read",
  "pull-requests": "read",
  issues: "write",
};

/**
 * @param {string} id
 * @returns {Record<string, any>}
 */
function job(id) {
  const found = JOBS.get(id);
  if (!found) throw new Error(`no job ${id}`);
  return found;
}

/** @param {unknown} v */
const oneLine = (v) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * @param {string} id
 * @returns {Record<string, any>[]}
 */
const steps = (id) => /** @type {Record<string, any>[]} */ (job(id).steps ?? []);

/**
 * @param {string} id
 * @param {string} name
 */
function step(id, name) {
  const found = steps(id).find((s) => s.name === name);
  if (!found) throw new Error(`${id}: no step ${name}`);
  return found;
}

/**
 * The one step of job `id` that uses `action` (an `owner/name` without the ref), with
 * `with.name` equal to `artifact` when that is given.
 * @param {string} id
 * @param {string} action
 * @param {string} [artifact]
 */
function uses(id, action, artifact) {
  const found = steps(id).filter(
    (s) =>
      String(s.uses ?? "").startsWith(`${action}@`) &&
      (artifact === undefined || s.with?.name === artifact),
  );
  expect(found, `${id}: ${action} ${artifact ?? ""}`).toHaveLength(1);
  const s = found[0] ?? {};
  if (/artifact/.test(action)) expect(s.uses).toMatch(PINNED);
  return s;
}

describe("nightly.yml: a workflow artifact, and a public nightly only when switched on", () => {
  it("has the jobs: the change check, build, the MAR's signing and check, cosign, the release, the manifest, report", () => {
    expect([...JOBS.keys()]).toEqual([
      "changes",
      "build",
      "mar-sign",
      "mar",
      "sign",
      "publish",
      "manifest",
      "report",
    ]);
  });

  it("the workflow and its build job can only read the repository", () => {
    expect(parseWorkflow(TEXT).permissions).toEqual({ contents: "read" });
    expect(job("build").permissions).toEqual({ contents: "read" });
    // No token that can write reaches npm, Surfer, mach or the mochitests.
    const build = JSON.stringify(job("build"));
    expect(build).not.toContain("GH_TOKEN");
    expect(build).not.toContain("github.token");
    expect(build).not.toMatch(/gh (release|issue|label)/);
  });

  it("the build job keeps the package as a workflow artifact for 7 days", () => {
    const names = steps("build").map((s) => s.name ?? s.uses);
    const upload = uses("build", "actions/upload-artifact", "vimma-nightly");
    expect(upload.with).toMatchObject({
      path: "dist/",
      "retention-days": 7,
      "if-no-files-found": "error",
    });
    expect(names.indexOf(upload.name)).toBeGreaterThan(names.indexOf("Package"));
  });

  it("every job after the build runs only with NIGHTLY_RELEASE_ENABLED and UPDATES_ENABLED", () => {
    for (const id of ["mar-sign", "mar", "sign", "publish", "manifest"]) {
      expect(oneLine(job(id).if), id).toContain(PUBLIC);
    }
    // The build hands over the MAR and its tools only then, too.
    for (const artifact of ["mar-unsigned", "mar-tools"]) {
      expect(oneLine(uses("build", "actions/upload-artifact", artifact).if), artifact).toBe(
        "vars.NIGHTLY_RELEASE_ENABLED == 'true' && vars.UPDATES_ENABLED == 'true'",
      );
    }
  });

  it("only publish can write contents, and it runs no repository code", () => {
    for (const [id, j] of JOBS) {
      const perms = /** @type {Record<string, string>} */ (j.permissions ?? {});
      expect(perms.contents ?? "read", id).toBe(id === "publish" ? "write" : "read");
      // The change check only reads the release, with a read-only token.
      const raw = JSON.stringify(j);
      const text = id === "changes" ? raw.replace(/gh release view nightly/g, "") : raw;
      if (id !== "publish") expect(text, id).not.toMatch(/gh release|gh api/);
    }
    const publish = JSON.stringify(job("publish"));
    expect(job("publish").permissions).toEqual({ contents: "write" });
    expect(publish).not.toMatch(/actions\/checkout|setup-node|\bnode |\bnpm |\bnpx |secrets\./);
    expect(job("publish").environment).toBeUndefined();
  });

  it("the nightly release is a pre-release, never Latest or deleted, and no v* tag is touched", () => {
    const run = String(step("publish", "Upload to the rolling nightly release").run);
    expect(run).toContain("gh release create nightly --prerelease --latest=false");
    // The tag stays where the first public nightly made it: no job moves a ref.
    expect(TEXT).not.toMatch(/git\/refs|-X PATCH|git push/);
    expect(run).toContain("gh release upload nightly release/* --clobber");
    expect(TEXT).not.toMatch(/gh release delete (?!-asset)|refs\/tags\/v|releases\/latest/);
    expect(TEXT).not.toMatch(/--latest(?!=false)/);
  });

  it("publish uploads only files SHA256SUMS lists, after checking them", () => {
    const names = steps("publish").map((s) => s.name);
    const check = String(step("publish", "Check the files against SHA256SUMS").run);
    expect(check).toContain("sha256sum -c SHA256SUMS");
    expect(check).toContain("SHA256SUMS SHA256SUMS.sigstore.json");
    expect(names.indexOf("Check the files against SHA256SUMS")).toBeLessThan(
      names.indexOf("Upload to the rolling nightly release"),
    );
    expect(job("publish").needs).toEqual(["build", "sign"]);
  });

  it("the MAR is signed by update-publish.yml's mar-sign, with this run's MAR", () => {
    const sign = job("mar-sign");
    expect(sign.uses).toBe("./.github/workflows/update-publish.yml");
    expect(sign.with).toEqual({ mar: "${{ needs.build.outputs.mar }}" });
    expect(sign.needs).toBe("build");
    expect(oneLine(sign.if)).toBe(`${PUBLIC} && needs.build.outputs.mar != ''`);
    expect(sign.permissions).toEqual(CEILING);
    expect(sign.secrets).toBeUndefined();
  });

  it("the manifest is update-publish.yml's, called with the build ID once the release has it", () => {
    const manifest = job("manifest");
    expect(manifest.uses).toBe("./.github/workflows/update-publish.yml");
    expect(manifest.needs).toEqual(["changes", "build", "publish"]);
    expect(oneLine(manifest.if)).toContain(`!cancelled() && ${PUBLIC} && `);
    expect(manifest.permissions).toEqual(CEILING);
    expect(manifest.secrets).toBeUndefined();
  });

  it("the mar job fails, loudly, when the MAR was not signed", () => {
    const mar = job("mar");
    expect(mar.needs).toEqual(["build", "mar-sign"]);
    // !cancelled(): a cancelled run reports no failure.
    expect(oneLine(mar.if)).toBe(`!cancelled() && ${PUBLIC} && needs.build.result == 'success'`);
    expect(mar.permissions).toEqual({ contents: "read" });
    expect(steps("mar")[0]?.name).toBe("The MAR was signed");
    expect(String(steps("mar")[0]?.run)).toContain('[ "$MAR_SIGN" = success ]');
    expect(JSON.stringify(mar)).not.toContain("secrets.");
  });

  it("the mar job checks the signed MAR for the nightly channel, against the tarball", () => {
    const run = String(step("mar", "Check the signed MAR").run);
    expect(run).toContain('[ "$MAR" = "vimma-nightly-$BUILD_ID-linux-x86_64.complete.mar" ]');
    expect(run).toContain(
      'node tools/update/mar.mjs same-content --placeholder "mar-unsigned/$MAR" --signed "mar-signed/$MAR"',
    );
    expect(run).toContain(
      'node tools/update/mar.mjs verify --mar "mar-signed/$MAR" --cert configs/updater/primary.der --cert configs/updater/secondary.der --channel vimma-nightly --product-version "$firefox"',
    );
    expect(run).toContain('mar-tools/signmar -d "sql:$db" -n "$slot" -v "mar-signed/$MAR"');
    const files = String(step("mar", "The MAR installs the nightly tarball's files").run);
    expect(files).toContain('diff -r --no-dereference "$from_mar" "$from_tarball/vimma"');
  });

  it("the mar job lists exactly the tarball and the MAR, by build ID, in SHA256SUMS", () => {
    const run = String(step("mar", "The nightly's files and SHA256SUMS").run);
    expect(run).toContain(
      'cp dist/vimma-*.en-US.linux-x86_64.tar.xz "release/vimma-nightly-$BUILD_ID-linux-x86_64.tar.xz"',
    );
    expect(run).toContain('cp "mar-signed/$MAR" release/');
    expect(run).toContain("sha256sum vimma-nightly-* > SHA256SUMS");
    expect(uses("mar", "actions/upload-artifact", "nightly-release").with).toMatchObject({
      path: "release/",
      "if-no-files-found": "error",
    });
  });

  it("cosign signs SHA256SUMS as nightly.yml on main, running no repository code", () => {
    const sign = job("sign");
    expect(sign.permissions).toEqual({ "id-token": "write" });
    expect(sign.needs).toEqual(["build", "mar"]);
    expect(oneLine(sign.if)).toBe(PUBLIC);
    expect(JSON.stringify(sign)).not.toMatch(
      /actions\/checkout|setup-node|\bnode |\bnpm |secrets\./,
    );
    expect(sign.environment).toBeUndefined();
    const run = String(step("sign", "Sign SHA256SUMS").run);
    expect(run).toContain("sha256sum -c SHA256SUMS");
    expect(run).toContain(
      "cosign sign-blob --yes --bundle release/SHA256SUMS.sigstore.json release/SHA256SUMS",
    );
  });

  it("the build hands over the MAR named by its build ID, unsigned, only for a public nightly", () => {
    const build = job("build");
    expect(build.outputs).toEqual({
      mar: "${{ steps.mar.outputs.mar }}",
      build_id: "${{ steps.mar.outputs.build_id }}",
      firefox: "${{ steps.mar.outputs.firefox }}",
    });
    const mar = step("build", "Complete MAR, for the nightly channel");
    expect(mar.id).toBe("mar");
    expect(mar.env).toEqual({
      PUBLIC: "${{ vars.NIGHTLY_RELEASE_ENABLED == 'true' && vars.UPDATES_ENABLED == 'true' }}",
    });
    const run = String(mar.run);
    expect(run).toContain("--channel vimma-nightly");
    expect(run).toContain('mar="vimma-nightly-$build_id-linux-x86_64.complete.mar"');
    expect(run).toContain('if [ "$PUBLIC" = true ]; then');
    // Never in dist/: the package artifact stays the tarball alone.
    expect(run).not.toMatch(/--out "?dist/);
    // The build job holds no key: signing is update-publish.yml's.
    expect(JSON.stringify(build)).not.toMatch(/update-signing|id-token|GCP_/);
  });

  it("a failure of any job is reported by its own job, from the redacted log artifact", () => {
    const report = job("report");
    expect(report.needs).toEqual([
      "changes",
      "build",
      "mar-sign",
      "mar",
      "sign",
      "publish",
      "manifest",
    ]);
    expect(report.if).toBe("failure()");
    expect(report.permissions).toEqual({ issues: "write" });
    const download = uses("report", "actions/download-artifact");
    expect(download.with).toMatchObject({ name: "nightly-log" });
    const text = JSON.stringify(report);
    expect(text).not.toContain("secrets.");
    expect(text).not.toContain("actions/checkout");
    expect(text).toContain("gh issue create");
    // The build job uploads the log only after scrubbing the key from it.
    const names = steps("build").map((s) => s.name);
    const redact = names.indexOf("Redact the Safe Browsing key from the log");
    expect(redact).toBeGreaterThan(-1);
    expect(names.indexOf("Upload log")).toBeGreaterThan(redact);
    // A build stopped at timeout-minutes is cancelled, not failed: it still leaves its log.
    expect(steps("build")[names.indexOf("Upload log")]?.if).toBe("failure() || cancelled()");
    const issue = steps("report").find((s) => s.name === "Open or update the failure issue");
    expect(issue?.run).toContain("tail -n 150 nightly-log/nightly.log");
    // A log line holding a code fence must not end the issue's fence and render as Markdown.
    const tick = "`";
    expect(issue?.run).toContain(`sed 's/${tick}/\\\\${tick}/g'`);
  });

  it("the report job names the repository, since it checks nothing out", () => {
    const s = steps("report").find((x) => x.name === "Open or update the failure issue");
    expect(s?.env).toMatchObject({
      GH_TOKEN: "${{ github.token }}",
      GH_REPO: "${{ github.repository }}",
    });
  });
});

// Spec m6a-updater, decision 44: a scheduled nightly builds only when main moved on since the
// build the rolling `nightly` pre-release records; an unchanged day starts no build and re-signs
// that build's manifest under a new serial, so nightly installs never see "no news". A manual run
// always builds. The jobs a run starts are worked out from the workflow's own conditions.
describe("nightly.yml: an unchanged day skips the build and re-signs the manifest", () => {
  const RECORDED = "20261112030512";
  const NEW = "20261113030004";
  const VARS = {
    NIGHTLY_ENABLED: "true",
    NIGHTLY_RELEASE_ENABLED: "true",
    UPDATES_ENABLED: "true",
  };
  /**
   * @param {string} event
   * @param {{ build: string, build_id: string }} changes  the change check's outputs
   * @param {Record<string, string>} [vars]
   * @param {Record<string, "failure" | "cancelled">} [results]  jobs that do not succeed
   */
  function nightly(event, changes, vars = VARS, results = {}) {
    const ran = runJobs(JOBS, {
      github: { event_name: event, ref: "refs/heads/main", repository: "vimma-browser/vimma" },
      vars,
      results,
      outputs: {
        changes,
        build: { mar: `vimma-nightly-${NEW}-linux-x86_64.complete.mar`, build_id: NEW },
      },
    });
    return {
      started: [...ran].filter(([, j]) => j.result !== "skipped").map(([id]) => id),
      manifest: ran.get("manifest")?.with,
    };
  }
  const UNCHANGED = { build: "false", build_id: RECORDED };
  const CHANGED = { build: "true", build_id: "" };
  const FULL = ["changes", "build", "mar-sign", "mar", "sign", "publish", "manifest"];

  it("a scheduled run on an unchanged commit builds nothing and re-signs the recorded build", () => {
    const run = nightly("schedule", UNCHANGED);
    expect(run.started).toEqual(["changes", "manifest"]);
    expect(run.manifest).toEqual({ nightly: RECORDED });
  });

  it("a scheduled run on a changed commit builds, publishes and offers the new build", () => {
    const run = nightly("schedule", CHANGED);
    expect(run.started).toEqual(FULL);
    expect(run.manifest).toEqual({ nightly: NEW });
  });

  it("a manual run builds, whatever the change check says", () => {
    for (const changes of [CHANGED, UNCHANGED]) {
      const run = nightly("workflow_dispatch", changes);
      expect(run.started).toEqual(FULL);
      expect(run.manifest).toEqual({ nightly: NEW });
    }
  });

  it("re-signs nothing without public nightlies, or without a recorded build", () => {
    expect(nightly("schedule", UNCHANGED, { NIGHTLY_ENABLED: "true" }).started).toEqual([
      "changes",
    ]);
    expect(nightly("schedule", CHANGED, { NIGHTLY_ENABLED: "true" }).started).toEqual([
      "changes",
      "build",
    ]);
    expect(nightly("schedule", { build: "false", build_id: "" }).started).toEqual(["changes"]);
    expect(nightly("schedule", UNCHANGED, {}).started).toEqual([]);
  });

  it("a failed change check builds; a failed or cancelled build or release step offers nothing", () => {
    // A doubt builds: a change check that fails starts the build, and report opens the issue.
    const none = { build: "", build_id: "" };
    for (const event of ["schedule", "workflow_dispatch"]) {
      expect(nightly(event, none, VARS, { changes: "failure" }).started).toEqual([
        ...FULL,
        "report",
      ]);
    }
    for (const failed of ["build", "mar-sign", "mar", "sign", "publish"]) {
      // mar runs after a failed mar-sign only to fail on its first step ("The MAR was signed").
      const also = failed === "mar-sign" ? { mar: /** @type {const} */ ("failure") } : {};
      const run = nightly("schedule", CHANGED, VARS, { [failed]: "failure", ...also });
      expect(run.started, failed).not.toContain("manifest");
      expect(run.started, failed).toContain("report");
      const stopped = nightly("workflow_dispatch", CHANGED, VARS, { [failed]: "cancelled" });
      expect(stopped.started, failed).not.toContain("manifest");
    }
    // A cancelled change check stops the night: no build, no re-sign.
    expect(nightly("schedule", UNCHANGED, VARS, { changes: "cancelled" }).started).toEqual([
      "changes",
    ]);
    // A failed re-sign is reported too.
    const resign = nightly("schedule", UNCHANGED, VARS, { manifest: "failure" });
    expect(resign.started).toEqual(["changes", "manifest", "report"]);
  });

  it("the change check fails rather than hand on an empty decision", () => {
    const run = String(step("changes", "Decide whether to build").run);
    expect(run).toContain("grep -Exq 'build=true|build=false'");
    expect(run.indexOf("grep -Exq")).toBeLessThan(run.indexOf('>> "$GITHUB_OUTPUT"'));
  });

  it("the change check reads with contents: read alone, no secret and no environment", () => {
    const changes = job("changes");
    expect(changes.permissions).toEqual({ contents: "read" });
    expect(changes.environment).toBeUndefined();
    const text = JSON.stringify(changes);
    expect(text).not.toMatch(/secrets\.|id-token|SAFEBROWSING|GCP_|DEPLOY_KEY/);
    expect(changes.outputs).toEqual({
      build: "${{ steps.decide.outputs.build }}",
      build_id: "${{ steps.decide.outputs.build_id }}",
    });
    // The same gate as the build's: NIGHTLY_ENABLED, and a manual run only from main.
    expect(oneLine(job("build").if)).toBe(
      `!cancelled() && ${oneLine(changes.if)} && (github.event_name == 'workflow_dispatch' || ` +
        "needs.changes.result != 'success' || needs.changes.outputs.build == 'true')",
    );
    expect(job("build").needs).toBe("changes");
  });

  it("a skipped day starts no job in the build environment and none that reads the key", () => {
    for (const id of nightly("schedule", UNCHANGED).started) {
      expect(job(id).environment, id).toBeUndefined();
      expect(JSON.stringify(job(id)), id).not.toMatch(/SAFEBROWSING|secrets\./);
    }
  });

  it("the re-sign goes through update-publish.yml's nightly jobs, as a build's manifest does", () => {
    const manifest = job("manifest");
    expect(manifest.uses).toBe("./.github/workflows/update-publish.yml");
    expect(manifest.with).toEqual({
      nightly:
        "${{ needs.build.result == 'success' && needs.build.outputs.build_id || needs.changes.outputs.build_id }}",
    });
  });
});

// The change check's step, run with a stand-in for gh.
describe.skipIf(process.platform !== "linux")("the change check's step, run", () => {
  const BUILD = "20261112030512";
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const FIREFOX = String(
    JSON.parse(readFileSync(new URL("../../surfer.json", import.meta.url), "utf8")).version.version,
  );
  /**
   * @param {"pre" | "none" | "error"} release
   * @param {string} [sha]  main's commit
   * @param {string} [event]
   */
  function check(release, sha = SHA, event = "schedule") {
    const dir = tempDir("vimma-nightly-changes-");
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "runner"));
    const json = JSON.stringify({
      body: `Nightly build ${BUILD} of main at ${SHA}, Firefox ${FIREFOX}. Built from main.`,
      isDraft: false,
      isPrerelease: true,
      assets: [
        "SHA256SUMS",
        "SHA256SUMS.sigstore.json",
        `vimma-nightly-${BUILD}-linux-x86_64.tar.xz`,
        `vimma-nightly-${BUILD}-linux-x86_64.complete.mar`,
      ].map((name) => ({ name })),
    });
    writeFileSync(join(dir, "release.json"), json);
    writeFileSync(
      join(dir, "bin", "gh"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "${join(dir, "calls.txt")}"
case "${release}" in
  none) echo "release not found" >&2; exit 1 ;;
  error) echo "HTTP 502: Server Error" >&2; exit 1 ;;
  *) cat "${join(dir, "release.json")}" ;;
esac
`,
      { mode: 0o755 },
    );
    const s = step("changes", "Decide whether to build");
    writeFileSync(join(dir, "out.txt"), "");
    const result = spawnSync("bash", ["-e", "-c", String(s.run)], {
      cwd: new URL("../..", import.meta.url).pathname,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        GH_REPO: "vimma-browser/vimma",
        RUNNER_TEMP: join(dir, "runner"),
        GITHUB_OUTPUT: join(dir, "out.txt"),
        EVENT: event,
        SHA: sha,
        PUBLIC: "true",
      },
    });
    return { ...result, outputs: readFileSync(join(dir, "out.txt"), "utf8") };
  }

  it("on the recorded commit, outputs no build and the recorded build ID", () => {
    const r = check("pre");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("::notice::no build");
    expect(r.outputs).toBe(`build=false\nbuild_id=${BUILD}\n`);
  });

  it("builds on another commit, a manual run, no release, or a release it cannot read", () => {
    for (const r of [
      check("pre", "89abcdef0123456789abcdef0123456789abcdef"),
      check("pre", SHA, "workflow_dispatch"),
      check("none"),
      check("error"),
    ]) {
      expect(r.status, r.stderr).toBe(0);
      expect(r.outputs).toBe("build=true\nbuild_id=\n");
    }
  });
});

// The publish job's two scripts, run with a stand-in for gh that answers as GitHub would and
// records every call.
describe.skipIf(process.platform !== "linux")("the nightly release's steps, run", () => {
  const BUILD = "20261112030512";
  /** @param {string} id */
  const files = (id) => [
    `vimma-nightly-${id}-linux-x86_64.tar.xz`,
    `vimma-nightly-${id}-linux-x86_64.complete.mar`,
  ];

  /**
   * @param {{ release: "none" | "pre" | "full" | "draft" | "error", assets?: string[],
   *   live?: string | null | "down" }} state  live: the build ID the published nightly
   *   manifest offers, null for a 404, "down" for an update host that does not answer
   */
  function setUp({ release, assets = [], live = null }) {
    const dir = tempDir("vimma-nightly-publish-");
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "release"));
    for (const f of ["SHA256SUMS", "SHA256SUMS.sigstore.json", "vimma-nightly-x"]) {
      writeFileSync(join(dir, "release", f), f);
    }
    const state = {
      none: "",
      pre: "false true",
      full: "false false",
      draft: "true true",
      error: "",
    }[release];
    writeFileSync(join(dir, "state.txt"), state);
    writeFileSync(join(dir, "assets.txt"), assets.map((a) => `${a}\n`).join(""));
    writeFileSync(
      join(dir, "bin", "gh"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
case "$*" in
  release\\ view\\ nightly\\ --json\\ isDraft,isPrerelease*)
    case "${release}" in
      none) echo "release not found" >&2; exit 1 ;;
      error) echo "HTTP 502: Server Error" >&2; exit 1 ;;
      *) cat "$STATE"; echo ;;
    esac ;;
  "release view nightly --json assets --jq .assets[].name") cat "$ASSETS" ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    );
    const body =
      live === null || live === "down" ? "" : `<update type="minor" buildID="${live}">\n`;
    const code = live === null ? "404" : live === "down" ? "502" : "200";
    writeFileSync(
      join(dir, "bin", "curl"),
      `#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out=$2; shift ;; esac
  shift
done
[ -n "$out" ] && printf '%s' '${body}' > "$out"
printf '%s' ${code}
`,
      { mode: 0o755 },
    );
    return dir;
  }

  /**
   * As GitHub runs a step with no `shell:`: bash -e, without pipefail.
   * @param {string} dir
   * @param {string} name
   */
  function run(dir, name) {
    const script = String(step("publish", name).run);
    const result = spawnSync("bash", ["-e", "-c", script], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        GH_REPO: "vimma-browser/vimma",
        SHA: "0123456789abcdef0123456789abcdef01234567",
        BUILD_ID: BUILD,
        FIREFOX: "160.0",
        CALLS: join(dir, "calls.txt"),
        STATE: join(dir, "state.txt"),
        ASSETS: join(dir, "assets.txt"),
      },
    });
    let calls = "";
    try {
      calls = readFileSync(join(dir, "calls.txt"), "utf8");
    } catch {
      // gh was never called
    }
    return { ...result, calls: calls.split("\n").filter(Boolean) };
  }

  const UPLOAD = "Upload to the rolling nightly release";
  const PRUNE = "Remove the files of older builds";
  /** @param {{ calls: string[] }} r */
  const deleted = (r) =>
    r.calls.filter((c) => c.startsWith("release delete-asset")).map((c) => c.split(" ")[3]);

  it("creates the nightly pre-release the first time, at the commit built, and uploads", () => {
    const r = run(setUp({ release: "none" }), UPLOAD);
    expect(r.stdout + r.stderr).not.toMatch(/::error::/);
    expect(r.status).toBe(0);
    expect(r.calls.find((c) => c.startsWith("release create"))).toMatch(
      /^release create nightly --prerelease --latest=false --target 0123456789abcdef0123456789abcdef01234567 --title Vimma nightly --notes /,
    );
    expect(r.calls.find((c) => c.startsWith("release upload"))).toBe(
      "release upload nightly release/SHA256SUMS release/SHA256SUMS.sigstore.json release/vimma-nightly-x --clobber",
    );
  });

  it("records the build, its commit and Firefox's version first in the release notes", () => {
    const r = run(setUp({ release: "pre", assets: files("20261111030000") }), UPLOAD);
    expect(r.status, r.stderr).toBe(0);
    const edit = r.calls.find((c) => c.startsWith("release edit nightly --notes "));
    expect(readRecord(String(edit).slice("release edit nightly --notes ".length))).toEqual({
      buildId: BUILD,
      sha: "0123456789abcdef0123456789abcdef01234567",
      firefox: "160.0",
    });
  });

  it("uploads to the existing pre-release without creating another", () => {
    const r = run(setUp({ release: "pre", assets: files("20261111030000") }), UPLOAD);
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls.some((c) => c.startsWith("release create"))).toBe(false);
    expect(r.calls.some((c) => c.startsWith("release upload nightly"))).toBe(true);
  });

  it.each(["full", "draft", "error"])(
    "refuses a nightly release whose state is %s, and uploads nothing",
    (release) => {
      const r = run(setUp({ release: /** @type {any} */ (release) }), UPLOAD);
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/::error::/);
      expect(r.calls.some((c) => /^release (upload|create|edit)/.test(c))).toBe(false);
    },
  );

  it("refuses a re-run of an older night once a newer build is on the release", () => {
    const r = run(setUp({ release: "pre", assets: files("20261113030000") }), UPLOAD);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/::error::.*20261113030000/);
    expect(r.calls.some((c) => /^release (upload|edit)/.test(c))).toBe(false);
  });

  it("keeps this build, the previous one and the one the live manifest offers", () => {
    const assets = [
      "SHA256SUMS",
      "SHA256SUMS.sigstore.json",
      ...files("20261109030000"),
      ...files("20261110030000"),
      ...files("20261111030000"),
      ...files(BUILD),
      "notes.txt",
    ];
    const r = run(setUp({ release: "pre", assets, live: "20261109030000" }), PRUNE);
    expect(r.status, r.stderr).toBe(0);
    expect(deleted(r)).toEqual(files("20261110030000"));
  });

  it("with no published manifest keeps this build and the previous one", () => {
    const assets = [...files("20261110030000"), ...files("20261111030000"), ...files(BUILD)];
    const r = run(setUp({ release: "pre", assets, live: null }), PRUNE);
    expect(r.status, r.stderr).toBe(0);
    expect(deleted(r)).toEqual(files("20261110030000"));
  });

  it("removes nothing when the update host does not answer, nor any newer build", () => {
    const assets = [...files("20261110030000"), ...files(BUILD), ...files("20261113030000")];
    expect(deleted(run(setUp({ release: "pre", assets, live: "down" }), PRUNE))).toEqual([]);
    const r = run(setUp({ release: "pre", assets, live: BUILD }), PRUNE);
    expect(r.status, r.stderr).toBe(0);
    expect(deleted(r)).toEqual([]);
  });
});
