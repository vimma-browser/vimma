/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The steps that only need to know whether a file is on a published release. GitHub counts every
// request for a release asset as a download, a HEAD, a redirect not followed and the API's asset
// endpoint alike (docs/runbook.md, "Release download counts"), so these read the release's
// metadata instead, which counts nothing. Steps that need a file's bytes still download it and
// check its hash and signature; those are tested with each workflow.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_SCHEMA, load } from "js-yaml";
import { tempDir } from "./temp-dir.mjs";

const WORKFLOWS = new URL("../../.github/workflows/", import.meta.url);

/** @param {string} name */
const workflow = (name) =>
  /** @type {any} */ (
    load(readFileSync(new URL(name, WORKFLOWS), "utf8"), { schema: CORE_SCHEMA })
  );

/**
 * @param {string} file
 * @param {string} job
 * @param {string} step
 * @returns {string}
 */
const runOf = (file, job, step) => {
  const found = workflow(file).jobs[job].steps.find((/** @type {any} */ s) => s.name === step);
  return found?.run ?? "";
};

const DMG = "vimma-0.1.11-macos-aarch64.dmg";

// [workflow, job, step, the file it looks for, what it runs when the file is there]
const CHECKS = /** @type {const} */ ([
  [
    "homebrew.yml",
    "start",
    "Start the tap push on main",
    "vimma.rb",
    "gh workflow run homebrew.yml --repo vimma-browser/vimma --ref main -f tag=v0.1.11",
  ],
  [
    "release.yml",
    "macos-tap",
    "Start homebrew.yml for a published release",
    "vimma.rb",
    "gh api --method POST repos/vimma-browser/vimma/actions/workflows/homebrew.yml/dispatches",
  ],
  [
    "release.yml",
    "macos-tap",
    "Start update-publish.yml for the macOS manifest",
    DMG,
    "gh api --method POST repos/vimma-browser/vimma/actions/workflows/update-publish.yml/dispatches",
  ],
  [
    "update-publish.yml",
    "start",
    "Start the manifest run on main",
    DMG,
    "gh workflow run update-publish.yml --repo vimma-browser/vimma --ref main -f tag=v0.1.11 -f target=macos",
  ],
]);

/**
 * Runs a step with a stub `curl` that answers the release API with `code` and `body` (a string
 * is served as it is), and a stub `gh` that logs its arguments. Code 0 is a network error: curl
 * prints 000 and exits 7.
 * @param {string} run
 * @param {{ code?: number, body?: unknown }} api
 */
const runWith = (run, { code = 200, body }) => {
  const dir = tempDir("release-asset-check-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "log");
  writeFileSync(log, "");
  writeFileSync(
    join(dir, "body.json"),
    typeof body === "string" ? body : JSON.stringify(body ?? { message: "Not Found" }),
  );
  // curl [...] -o <file> [...] -w '%{http_code}' <url>: logs, writes the body, prints the code;
  // with -f, as curl does, a code of 400 or more is an error and prints nothing.
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/bash
echo "curl $*" >> "${log}"
out=/dev/stdout; fail=0; w=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out=$2; shift ;; -w) w=$2; shift ;; -f*) fail=1 ;; esac
  shift
done
if [ ${code} = 0 ]; then [ -z "$w" ] || printf 000; exit 7; fi
if [ ${code} -ge 400 ] && [ $fail = 1 ]; then exit 22; fi
cat "${join(dir, "body.json")}" > "$out"
[ -z "$w" ] || printf ${code}
`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "gh $*" >> "${log}"\n`, { mode: 0o755 });
  const result = spawnSync("bash", ["-e", "-c", run], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      TAG: "v0.1.11",
      GITHUB_REPOSITORY: "vimma-browser/vimma",
      RUNNER_TEMP: dir,
      GITHUB_STEP_SUMMARY: join(dir, "summary"),
      RELEASE_ENABLED: "true",
      MACOS_RELEASE_ENABLED: "true",
      UPDATES_ENABLED: "true",
    },
  });
  const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return {
    ...result,
    curl: lines.filter((l) => l.startsWith("curl ")),
    // the dispatch under test; update-publish.yml's start also starts the Linux run first
    gh: lines.filter(
      (l) =>
        l.startsWith("gh ") &&
        l !==
          "gh workflow run update-publish.yml --repo vimma-browser/vimma --ref main -f tag=v0.1.11",
    ),
  };
};

/** @param {string[]} names */
const release = (names, draft = false) => ({
  tag_name: "v0.1.11",
  draft,
  assets: names.map((name) => ({ name, state: "uploaded" })),
});

describe.each(CHECKS)("%s %s: %s", (file, job, step, asset, dispatch) => {
  const run = runOf(file, job, step);

  it("reads the release's metadata and never requests a release file", () => {
    expect(run).not.toBe("");
    expect(run).toContain('"https://api.github.com/repos/$GITHUB_REPOSITORY/releases/tags/$TAG"');
    expect(run).not.toMatch(/releases\/download|releases\/assets|application\/octet-stream/);
  });

  it(`starts the run once ${asset} is on the published release`, () => {
    const result = runWith(run, { body: release(["SHA256SUMS", asset]) });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.curl).toEqual([
      expect.stringMatching(
        /^curl -sS --proto =https --retry 3 -o \S+ -w %\{http_code\} https:\/\/api\.github\.com\/repos\/vimma-browser\/vimma\/releases\/tags\/v0\.1\.11$/,
      ),
    ]);
    expect(result.gh.join("\n")).toContain(dispatch);
  });

  it.each([
    ["the release lacks the file", { body: release(["SHA256SUMS", `${asset}.sigstore.json`]) }],
    [
      "the file is still uploading",
      { body: { ...release([]), assets: [{ name: asset, state: "starter" }] } },
    ],
    ["the release is a draft", { body: release([asset], true) }],
    ["the tag has no published release", { code: 404 }],
  ])("starts nothing, green, when %s", (_, api) => {
    const result = runWith(run, api);
    expect(result.status).toBe(0);
    expect(result.gh).toEqual([]);
    expect(result.stdout).toContain("::notice::");
  });

  // A rate limit or an outage must not pass for a release without the file: the run fails and
  // the workflow's failure report says so.
  it.each([403, 500])("fails when the release API answers %i", (code) => {
    const result = runWith(run, { code, body: { message: "API rate limit exceeded" } });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("::error::");
    expect(result.gh).toEqual([]);
  });

  it.each([
    ["the network fails (curl prints 000)", { code: 0 }],
    ["the release API answers 200 with a body that is not JSON", { body: "<html>busy</html>" }],
    ["the release API answers 200 with JSON that is not a release", { body: [] }],
  ])("fails when %s", (_, api) => {
    const result = runWith(run, api);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("::error::");
    expect(result.gh).toEqual([]);
  });
});

// A release asset URL requested with -o /dev/null, -I or a bare HEAD only checks that the file
// exists, and still counts as a download.
it("no workflow requests a release file only to see that it exists", () => {
  const offenders = [];
  for (const name of readdirSync(WORKFLOWS).filter((n) => /\.ya?ml$/.test(n))) {
    const text = readFileSync(new URL(name, WORKFLOWS), "utf8");
    for (const line of text.split("\n")) {
      if (
        /releases\/download\/|releases\/assets\//.test(line) &&
        /-o \/dev\/null|curl -\w*I|--head\b|-X HEAD/.test(line)
      ) {
        offenders.push(`${name}: ${line.trim()}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
