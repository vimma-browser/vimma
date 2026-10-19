import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

// Spec build-supply-chain, decisions 3 to 10 and rules B1 (builds) and B2: the nightly, the
// release and the macOS cross build (spec macos-build, decision 6) build on GitHub-hosted runners from Firefox source that firefox-source.sh verified and
// extracted in the same job, and restore nothing from the Actions cache. Text checks, like
// release-workflow.test.mjs: no YAML dependency.
const DIR = new URL("../../.github/workflows/", import.meta.url);
/** @param {string} name */
const workflow = (name) => readFileSync(new URL(name, DIR), "utf8");
const ALL = readdirSync(DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((name) => ({ name, text: workflow(name) }));

/**
 * The YAML block of job `id` (up to the next job at the same indent).
 * @param {string} text
 * @param {string} id
 */
function job(text, id) {
  const body = text.slice(text.indexOf("\njobs:\n") + 7);
  const parts = body.split(/^ {2}([a-z][a-z0-9-]*):\n/m).slice(1);
  for (let i = 0; i < parts.length; i += 2) if (parts[i] === id) return parts[i + 1] ?? "";
  throw new Error(`no job ${id}`);
}

const BUILDS = [
  { name: "nightly.yml", block: job(workflow("nightly.yml"), "build") },
  { name: "release.yml", block: job(workflow("release.yml"), "build") },
  { name: "macos.yml", block: job(workflow("macos.yml"), "build") },
  { name: "release.yml macos-build", block: job(workflow("release.yml"), "macos-build") },
];

/**
 * Index of `needle` in `block`, failing the test when it is missing.
 * @param {string} block
 * @param {string} needle
 */
function at(block, needle) {
  const i = block.indexOf(needle);
  expect(i, needle).toBeGreaterThan(-1);
  return i;
}

describe("full builds (nightly.yml, release.yml, macos.yml)", () => {
  it.each(BUILDS)("$name gets Firefox source only through firefox-source.sh", ({ block }) => {
    const source = at(block, "run: tools/upstream/firefox-source.sh");
    expect(at(block, "npm run import")).toBeGreaterThan(source);
    expect(block).not.toMatch(/surfer download/);
  });

  it("no workflow runs surfer download itself", () => {
    for (const { name, text } of ALL) expect(text, name).not.toMatch(/surfer download/);
    // The PR and site-compat jobs use the same script, so every path verifies the same way.
    for (const name of ["e2e.yml", "sites.yml"]) {
      expect(workflow(name), name).toContain("tools/upstream/firefox-source.sh");
    }
  });

  it("no workflow reads or writes engine/.vimma-firefox-version", () => {
    for (const { name, text } of ALL) expect(text, name).not.toContain(".vimma-firefox-version");
  });

  it("the build jobs check out clean and restore nothing from the Actions cache", () => {
    for (const { name, block } of BUILDS) {
      expect(block, name).toContain("uses: actions/checkout@");
      expect(block, name).not.toMatch(/clean: false/);
      expect(block, name).not.toMatch(/actions\/cache/);
      expect(block, name).not.toContain("SCCACHE_GHA_ENABLED");
      // setup-node pins the version, but without its `cache` input (no npm cache restored).
      const node = block.slice(at(block, "uses: actions/setup-node@"));
      const inputs = node.slice(0, node.search(/\n {6}- /));
      expect(inputs, name).toContain("node-version-file: .nvmrc");
      expect(inputs, name).not.toMatch(/\bcache:/);
    }
  });

  it("a release builds in a fresh objdir with an empty compiler cache", () => {
    const block = BUILDS[1]?.block ?? "";
    const fresh = at(block, "- name: Fresh objdir and compiler cache for this release");
    expect(block).toMatch(/rm -rf "\$objdir" "\$cache"/);
    expect(block).toContain('echo "MOZ_OBJDIR=$objdir"; echo "SCCACHE_DIR=$cache"');
    expect(at(block, "npx --no -- surfer build")).toBeGreaterThan(fresh);
  });

  it.each(BUILDS)("$name checks for 50 GB free before downloading Firefox source", ({ block }) => {
    const guard = at(block, "- name: Disk guard");
    const step = block.slice(guard, block.indexOf("\n      - ", guard + 1));
    expect(step).toMatch(/df --output=avail -BG/);
    expect(step).toMatch(/-lt 50 \]/);
    expect(at(block, "run: tools/upstream/firefox-source.sh")).toBeGreaterThan(guard);
  });

  // mach's taskgraph hashes the files a repository tracks to find Mozilla's toolchains for
  // --enable-bootstrap; in an empty repository it finds none. Without .git, engine/ is a source
  // tarball to mach, and every file counts.
  it.each(BUILDS)(
    "$name drops engine/'s empty repository between import and build",
    ({ block }) => {
      const imp = at(block, "npm run import");
      const drop = at(block, "rm -rf engine/.git");
      expect(drop).toBeGreaterThan(imp);
      expect(at(block, "npx --no -- surfer build")).toBeGreaterThan(drop);
    },
  );

  // Measured on ubuntu-24.04 (docs/runbook.md, "Full builds"): the Rust stage peaks at 15.3 GB
  // of the runner's 16 GB of memory plus 10.4 GB of swap; without the swap file the first
  // measured build was killed after 38 minutes.
  it.each(BUILDS)("$name adds a 16 GB swap file before building", ({ block }) => {
    const swap = at(block, "- name: Swap file");
    const step = block.slice(swap, block.indexOf("\n      - ", swap + 1));
    expect(step).toMatch(/fallocate -l 16G/);
    expect(step).toMatch(/swapon/);
    expect(at(block, "npx --no -- surfer build")).toBeGreaterThan(swap);
  });

  // A token that can write issues never reaches npm, Surfer, mach or the mochitests: the nightly's
  // build job holds none, and only the failure-issue step, in a job of its own that runs nothing
  // from the repository, gets GH_TOKEN. The nightly publishes no release (decision 23).
  it("only the nightly's failure-issue step gets GH_TOKEN", () => {
    const text = workflow("nightly.yml");
    const holders = [];
    for (const id of ["build", "report"]) {
      const steps = job(text, id)
        .split(/\n(?= {6}- )/)
        .slice(1);
      for (const step of steps.filter((s) => /^ +GH_TOKEN:/m.test(s))) {
        holders.push(`${id}: ${/- (?:name|uses): (.*)/.exec(step)?.[1]}`);
      }
      const head = job(text, id).slice(0, job(text, id).indexOf("\n    steps:\n"));
      expect(head, id).not.toMatch(/^ +GH_TOKEN:/m);
    }
    expect(holders).toEqual(["report: Open or update the failure issue"]);
    expect(job(text, "build")).not.toContain("github.token");
  });

  it.each(BUILDS)("$name stops itself before GitHub's 6-hour job limit", ({ block }) => {
    const minutes = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(block)?.[1]);
    expect(minutes).toBeGreaterThan(0);
    expect(minutes).toBeLessThanOrEqual(345);
  });
});
