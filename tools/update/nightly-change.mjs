#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Whether tonight's nightly builds (docs/specs/m6a-updater.md, decision 44). nightly.yml's
 * `publish` job starts the rolling `nightly` pre-release's notes with a record of the build:
 *
 *   Nightly build <buildID> of main at <commit>, Firefox <version>.
 *
 * A scheduled run on the commit and Firefox version that record names builds nothing; it re-signs
 * that build's manifest instead, so installs see a fresh serial and no update. Anything else
 * builds: a manual run, public nightlies off, no release (or one that is a draft or a full
 * release), notes without the record, or a release whose newest files and SHA256SUMS are not
 * the recorded build's. Building is what every night did before, so a doubt costs runner time,
 * never a stale or wrong offer.
 *
 *   nightly-change.mjs --event schedule --public true --sha SHA --firefox X.Y [--release FILE]
 *
 * FILE is `gh release view nightly --json body,isDraft,isPrerelease,assets`; leave it out when
 * there is no release or it could not be read. Prints `build=true|false` and `build_id=<ID or
 * empty>` for $GITHUB_OUTPUT, and the reason as a notice on stderr. Node built-ins only.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SHA = /^[0-9a-f]{40}$/;
const FIREFOX = /^\d+\.\d+(?:\.\d+)?(?:[ab]\d+)?$/;
const RECORD =
  /^Nightly build (\d{14}) of main at ([0-9a-f]{40}), Firefox (\d+\.\d+(?:\.\d+)?(?:[ab]\d+)?)\./;
const FILE = /^vimma-nightly-(\d{14})-linux-x86_64\.(?:tar\.xz|complete\.mar)$/;

/**
 * The record's sentence, as nightly.yml's publish job writes it first in the notes.
 * @param {string} buildId @param {string} sha @param {string} firefox
 */
export function nightlyRecord(buildId, sha, firefox) {
  return `Nightly build ${buildId} of main at ${sha}, Firefox ${firefox}.`;
}

/**
 * The record at the start of the notes, or null when they do not start with one.
 * @param {string} body
 * @returns {{ buildId: string, sha: string, firefox: string } | null}
 */
export function readRecord(body) {
  const m = RECORD.exec(String(body ?? ""));
  if (!m) return null;
  return { buildId: String(m[1]), sha: String(m[2]), firefox: String(m[3]) };
}

/**
 * @typedef {{ body?: unknown, isDraft?: unknown, isPrerelease?: unknown,
 *   assets?: unknown }} Release
 * @typedef {{ build: true, reason: string } |
 *   { build: false, buildId: string, reason: string }} Decision
 */

/**
 * @param {{ event: string, isPublic: boolean, sha: string, firefox: string,
 *   release: Release | null }} input  `sha` and `firefox`: main's commit, and the Firefox
 *   version its surfer.json names
 * @returns {Decision}
 */
export function decide({ event, isPublic, sha, firefox, release }) {
  /** @param {string} reason @returns {Decision} */
  const build = (reason) => ({ build: true, reason });
  if (event !== "schedule") return build(`a ${event} run always builds`);
  if (!isPublic) return build("public nightlies are off, so no release records a build");
  if (!SHA.test(sha)) return build(`'${sha}' is not a commit`);
  if (!FIREFOX.test(firefox)) return build(`'${firefox}' is not a Firefox version`);
  if (!release) return build("there is no nightly release to compare with");
  if (release.isDraft !== false || release.isPrerelease !== true) {
    return build("the nightly release is not a public pre-release");
  }
  const record = readRecord(typeof release.body === "string" ? release.body : "");
  if (!record) return build("the nightly release's notes name no build, commit and Firefox");
  const names = Array.isArray(release.assets)
    ? release.assets.map((/** @type {any} */ a) => String(a?.name ?? ""))
    : [];
  const newest = names
    .flatMap((n) => FILE.exec(n)?.[1] ?? [])
    .sort()
    .at(-1);
  const has = (/** @type {string} */ n) => names.includes(n);
  if (
    newest !== record.buildId ||
    !has(`vimma-nightly-${newest}-linux-x86_64.tar.xz`) ||
    !has(`vimma-nightly-${newest}-linux-x86_64.complete.mar`) ||
    !has("SHA256SUMS") ||
    !has("SHA256SUMS.sigstore.json")
  ) {
    return build(`the nightly release's newest files are not build ${record.buildId}'s`);
  }
  if (record.sha !== sha) {
    return build(`main is at ${sha}, nightly build ${record.buildId} at ${record.sha}`);
  }
  if (record.firefox !== firefox) {
    return build(`main has Firefox ${firefox}, nightly build ${record.buildId} ${record.firefox}`);
  }
  return {
    build: false,
    buildId: record.buildId,
    reason: `main is still ${sha} with Firefox ${firefox}, as nightly build ${record.buildId}`,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        event: { type: "string" },
        public: { type: "string" },
        sha: { type: "string" },
        firefox: { type: "string" },
        release: { type: "string" },
      },
    });
    const { event, sha, firefox } = values;
    if (!event || !values.public || !sha || !firefox) {
      throw new Error(
        "usage: nightly-change.mjs --event E --public true|false --sha SHA --firefox X.Y [--release FILE]",
      );
    }
    /** @type {Release | null} */
    let release = null;
    if (values.release) {
      try {
        const parsed = JSON.parse(readFileSync(values.release, "utf8"));
        release = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
      } catch {
        // Not JSON (an error page, a cut-off answer): nothing to compare with, so it builds.
        release = null;
      }
    }
    const d = decide({ event, isPublic: values.public === "true", sha, firefox, release });
    console.error(`::notice::${d.build ? "build" : "no build"}: ${d.reason}`);
    process.stdout.write(`build=${d.build}\nbuild_id=${d.build ? "" : d.buildId}\n`);
  } catch (e) {
    console.error(`nightly-change: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
