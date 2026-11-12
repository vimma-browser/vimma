// docs/specs/m6a-updater.md, decision 44: a scheduled nightly builds only when main's commit or
// Firefox's version differs from what the rolling `nightly` pre-release records; otherwise it
// re-signs the same build's manifest under a new serial. A manual run always builds. Anything the
// record cannot vouch for (no release, a draft, a body in another shape, a build whose files are
// not on the release) builds, as every night did before.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../test/temp-dir.mjs";
import { decide, nightlyRecord, readRecord } from "../nightly-change.mjs";

const SCRIPT = new URL("../nightly-change.mjs", import.meta.url).pathname;
const BUILD = "20261112030512";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "89abcdef0123456789abcdef0123456789abcdef";
const FIREFOX = "160.0";
const NOTES = `${nightlyRecord(BUILD, SHA, FIREFOX)} Built from main on each night it changed.`;
/** @param {string} id */
const files = (id) => [
  { name: `vimma-nightly-${id}-linux-x86_64.tar.xz` },
  { name: `vimma-nightly-${id}-linux-x86_64.complete.mar` },
];
const SUMS = [{ name: "SHA256SUMS" }, { name: "SHA256SUMS.sigstore.json" }];
const RELEASE = {
  body: NOTES,
  isDraft: false,
  isPrerelease: true,
  assets: [...SUMS, ...files("20261111030000"), ...files(BUILD)],
};
const SKIP = {
  event: "schedule",
  isPublic: true,
  sha: SHA,
  firefox: FIREFOX,
  release: RELEASE,
};

describe("the nightly release's record", () => {
  it("names the build, the commit and Firefox's version, and reads back", () => {
    expect(nightlyRecord(BUILD, SHA, FIREFOX)).toBe(
      `Nightly build ${BUILD} of main at ${SHA}, Firefox ${FIREFOX}.`,
    );
    expect(readRecord(NOTES)).toEqual({ buildId: BUILD, sha: SHA, firefox: FIREFOX });
  });

  it.each([
    [
      "the first public nightly's notes, which name no Firefox version",
      `Nightly build ${BUILD} of main at ${SHA}. Built every night.`,
    ],
    ["a short commit", `Nightly build ${BUILD} of main at 0123456, Firefox 160.0.`],
    [
      "a build ID that is not 14 digits",
      `Nightly build 2026111203 of main at ${SHA}, Firefox 160.0.`,
    ],
    [
      "a version that is not Firefox's",
      `Nightly build ${BUILD} of main at ${SHA}, Firefox latest.`,
    ],
    [
      "a record that is not the first line",
      `Notes.\nNightly build ${BUILD} of main at ${SHA}, Firefox 160.0.`,
    ],
    ["an empty body", ""],
  ])("reads nothing from %s", (_, body) => {
    expect(readRecord(body)).toBeNull();
  });
});

describe("decide", () => {
  it("skips a scheduled run on the recorded commit and Firefox, and re-signs that build", () => {
    expect(decide(SKIP)).toEqual({
      build: false,
      buildId: BUILD,
      reason: `main is still ${SHA} with Firefox ${FIREFOX}, as nightly build ${BUILD}`,
    });
  });

  it("builds a manual run, even on the recorded commit", () => {
    expect(decide({ ...SKIP, event: "workflow_dispatch" })).toMatchObject({ build: true });
  });

  it("builds when main moved on", () => {
    expect(decide({ ...SKIP, sha: OTHER })).toEqual({
      build: true,
      reason: `main is at ${OTHER}, nightly build ${BUILD} at ${SHA}`,
    });
  });

  it("builds when Firefox's version differs from the record's", () => {
    expect(decide({ ...SKIP, firefox: "160.0.1" })).toMatchObject({ build: true });
  });

  it.each([
    ["public nightlies are off", { isPublic: false }],
    ["there is no nightly release", { release: null }],
    ["the release is a draft", { release: { ...RELEASE, isDraft: true } }],
    ["the release is a full release", { release: { ...RELEASE, isPrerelease: false } }],
    ["its notes hold no record", { release: { ...RELEASE, body: "Vimma nightly" } }],
    [
      "the recorded build's MAR is not on it",
      { release: { ...RELEASE, assets: [...SUMS, files(BUILD)[0]] } },
    ],
    [
      "a newer build than the recorded one is on it",
      { release: { ...RELEASE, assets: [...RELEASE.assets, ...files("20261113030000")] } },
    ],
    [
      "SHA256SUMS or its signature is missing",
      { release: { ...RELEASE, assets: [SUMS[0], ...files(BUILD)] } },
    ],
    ["the event is another", { event: "push" }],
    ["the commit is not a full SHA", { sha: "0123456" }],
  ])("builds when %s", (_, change) => {
    expect(decide({ ...SKIP, ...change })).toMatchObject({ build: true });
  });
});

describe("nightly-change.mjs, run as the changes job runs it", () => {
  /**
   * @param {string[]} args
   * @param {unknown} [release]
   */
  function run(args, release) {
    const dir = tempDir("vimma-nightly-change-");
    const extra = [];
    if (release !== undefined) {
      writeFileSync(join(dir, "release.json"), JSON.stringify(release));
      extra.push("--release", join(dir, "release.json"));
    }
    return spawnSync(process.execPath, [SCRIPT, ...args, ...extra], { encoding: "utf8" });
  }
  const ARGS = ["--event", "schedule", "--public", "true", "--sha", SHA, "--firefox", FIREFOX];

  it("prints the outputs of a skipped day", () => {
    const r = run(ARGS, RELEASE);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(`build=false\nbuild_id=${BUILD}\n`);
    expect(r.stderr).toContain(`::notice::no build: main is still ${SHA}`);
  });

  it("prints the outputs of a build, and builds with no release file", () => {
    const r = run(ARGS);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("build=true\nbuild_id=\n");
    expect(r.stderr).toContain("::notice::build: there is no nightly release to compare with");
  });

  it("builds when the release file is not JSON", () => {
    const dir = tempDir("vimma-nightly-change-");
    writeFileSync(join(dir, "release.json"), "<html>");
    const r = spawnSync(
      process.execPath,
      [SCRIPT, ...ARGS, "--release", join(dir, "release.json")],
      {
        encoding: "utf8",
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("build=true\nbuild_id=\n");
  });

  it("fails on a missing argument rather than guess", () => {
    const r = run(["--event", "schedule"]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
  });
});
