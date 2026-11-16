import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { advisoryUrl, firefoxNotes } from "../firefox-notes.ts";

// Spec firefox-versions, decisions 6 to 10: the newest changelog entry names the Firefox it is
// built on, and each Firefox bump links its Mozilla advisories.

const compare = "https://github.com/vimma-browser/vimma/compare/v0.5.1...v0.5.2";
const older = "https://github.com/vimma-browser/vimma/compare/v0.5.0...v0.5.1";
const commit = (sha: string) =>
  `([${sha}](https://github.com/vimma-browser/vimma/commit/${sha}${"0".repeat(33)}))`;
const issue = (n: number) => `([#${n}](https://github.com/vimma-browser/vimma/issues/${n}))`;
const mfsa = (id: string) =>
  `[MFSA ${id}](https://www.mozilla.org/en-US/security/advisories/mfsa${id}/)`;

/** A CHANGELOG.md as release-please writes it on the release branch. */
const changelog = [
  "# Changelog",
  "",
  "All notable changes to this project are documented here.",
  "",
  `## [0.5.2](${compare}) (2026-10-20)`,
  "",
  "",
  "### Added",
  "",
  `* **keys:** a new key ${issue(201)} ${commit("aaaaaaa")}`,
  "",
  "### Changed",
  "",
  `* **core:** vendor smol-toml 1.9.0 ${commit("bbbbbbb")}`,
  `* firefox 158.0 (MFSA 2026-106) ${issue(200)} ${commit("ccccccc")}`,
  `* firefox 157.0.3 (MFSA 2026-104, MFSA 2026-105) ${commit("ddddddd")}`,
  `* firefox 157.0.2 ${issue(199)} ${commit("eeeeeee")}`,
  "",
  `## [0.5.1](${older}) (2026-10-13)`,
  "",
  "### Changed",
  "",
  `* firefox 157.0.1 (MFSA 2026-100) ${commit("fffffff")}`,
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- firefox 1.0 (MFSA 2000-1) is a hand-written line that stays as it is.",
  "",
].join("\n");

describe("firefoxNotes", () => {
  const once = firefoxNotes(changelog, { firefox: "158.0" });
  const lines = once.split("\n");

  it("adds the Firefox version after the compare link of the newest heading", () => {
    expect(lines[4]).toBe(`## [0.5.2](${compare}) · Firefox 158.0 (2026-10-20)`);
  });

  it("adds it after the version when the heading has no compare link (a first release)", () => {
    expect(firefoxNotes("## 0.1.0 (2026-10-01)\n\n### Added\n", { firefox: "157.0" })).toBe(
      "## 0.1.0 · Firefox 157.0 (2026-10-01)\n\n### Added\n",
    );
  });

  it("puts the given Firefox version in place of an older one in the newest heading", () => {
    const stale = changelog.replace(`(${compare})`, `(${compare}) · Firefox 157.0.1`);
    expect(firefoxNotes(stale, { firefox: "158.0" })).toBe(once);
  });

  it("leaves older headings and [Unreleased] alone", () => {
    expect(once).toContain(`\n## [0.5.1](${older}) (2026-10-13)\n`);
    expect(once).toContain(`\n* firefox 157.0.1 (MFSA 2026-100) ${commit("fffffff")}\n`);
    expect(once).toContain("\n## [Unreleased]\n");
    expect(once).toContain("\n- firefox 1.0 (MFSA 2000-1) is a hand-written line");
    // Everything after the newest entry is byte for byte the same.
    const rest = changelog.slice(changelog.indexOf("\n## [0.5.1]"));
    expect(once.endsWith(rest)).toBe(true);
  });

  it("is idempotent: a second pass changes nothing", () => {
    expect(firefoxNotes(once, { firefox: "158.0" })).toBe(once);
  });

  it("links each MFSA ID in an upstream line and capitalises Firefox", () => {
    expect(once).toContain(
      `\n* Firefox 158.0 (${mfsa("2026-106")}) ${issue(200)} ${commit("ccccccc")}\n`,
    );
    expect(once).toContain(
      `\n* Firefox 157.0.3 (${mfsa("2026-104")}, ${mfsa("2026-105")}) ${commit("ddddddd")}\n`,
    );
    expect(advisoryUrl("MFSA 2026-106")).toBe(
      "https://www.mozilla.org/en-US/security/advisories/mfsa2026-106/",
    );
  });

  it('leaves a bump without an advisory as "Firefox 157.0.2"', () => {
    expect(once).toContain(`\n* Firefox 157.0.2 ${issue(199)} ${commit("eeeeeee")}\n`);
  });

  it("touches only bump lines of the Changed section", () => {
    const other = changelog.replace(
      "### Added\n\n",
      `### Added\n\n* firefox 999.0 (MFSA 2099-1) under Added ${commit("1111111")}\n`,
    );
    expect(firefoxNotes(other, { firefox: "158.0" })).toContain(
      "\n* firefox 999.0 (MFSA 2099-1) under Added",
    );
    expect(once).toContain(`\n* **core:** vendor smol-toml 1.9.0 ${commit("bbbbbbb")}\n`);
  });

  it("keeps text appended below the notes (the third-party notice)", () => {
    // A release body: the newest entry only, then whatever release.yml appended.
    const body =
      changelog.slice(changelog.indexOf("## [0.5.2]"), changelog.indexOf("\n## [0.5.1]")) +
      "\n---\n\n### Third-party software\n\nfirefox 158.0 (MFSA 2026-106) stays as written.\n";
    const out = firefoxNotes(body, { firefox: "158.0" });
    expect(out.startsWith(`## [0.5.2](${compare}) · Firefox 158.0 (2026-10-20)\n`)).toBe(true);
    expect(out).toContain(`* Firefox 158.0 (${mfsa("2026-106")})`);
    expect(out.endsWith("\nfirefox 158.0 (MFSA 2026-106) stays as written.\n")).toBe(true);
    expect(firefoxNotes(out, { firefox: "158.0" })).toBe(out);
  });

  it("returns text without a release heading unchanged", () => {
    const text = "# Changelog\n\n## [Unreleased]\n\n### Changed\n\n* firefox 158.0\n";
    expect(firefoxNotes(text, { firefox: "158.0" })).toBe(text);
  });

  it("refuses a malformed Firefox version", () => {
    expect(() => firefoxNotes(changelog, { firefox: "158" })).toThrow(/Firefox version/);
    expect(() => firefoxNotes(changelog, { firefox: "158.0)" })).toThrow(/Firefox version/);
  });

  // release-please 17.6.0 (the version release-please-action v5.0.0 locks) finds a release's
  // version and the previous entry with these two patterns. Copied verbatim:
  // src/util/pull-request-body.ts:155 (COMPARE_REGEX, used by extractSingleRelease on the release
  // PR body) and src/updaters/changelog.ts:22 (DEFAULT_VERSION_HEADER_REGEX, where the next entry
  // goes in CHANGELOG.md).
  const COMPARE_REGEX = /^#{2,} \[?(?<version>\d+\.\d+\.\d+[^\]]*)\]?/;
  // (the source is the string "\\n###? v?[0-9[]" given to new RegExp with the flag "s")
  const DEFAULT_VERSION_HEADER_REGEX = /\n###? v?[0-9[]/s;
  // src/version.ts:17-18: Version.parse takes the first SemVer in what COMPARE_REGEX matched.
  const VERSION_REGEX =
    /(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(-(?<preRelease>[^+]+))?(\+(?<build>.*))?/;
  /** extractSingleRelease, then Version.parse, then Version.toString */
  const releaseVersion = (body: string) => {
    const v = body.trim().match(COMPARE_REGEX)?.groups?.version ?? "";
    const g = v.match(VERSION_REGEX)?.groups;
    return g && `${g.major}.${g.minor}.${g.patch}${g.preRelease ? `-${g.preRelease}` : ""}`;
  };

  it("the rewritten heading still matches release-please 17.6.0's heading patterns", () => {
    const heading = lines[4] as string;
    expect(heading.match(COMPARE_REGEX)?.groups?.version).toBe("0.5.2");
    expect(releaseVersion(heading)).toBe("0.5.2");
    // Without a compare link COMPARE_REGEX runs to the end of the line (as it does for
    // release-please's own `## 0.1.0 (2026-10-01)`); Version.parse still reads 0.1.0.
    const firstRelease = firefoxNotes("## 0.1.0 (2026-10-01)\n", { firefox: "157.0" });
    expect(releaseVersion(firstRelease)).toBe("0.1.0");
    expect(releaseVersion("## 0.1.0 (2026-10-01)\n")).toBe("0.1.0");
    // The next release goes in right before this entry, as before the rewrite.
    expect(once.search(DEFAULT_VERSION_HEADER_REGEX)).toBe(once.indexOf("\n## [0.5.2]"));
    expect(once.search(DEFAULT_VERSION_HEADER_REGEX)).toBe(
      changelog.search(DEFAULT_VERSION_HEADER_REGEX),
    );
  });
});

describe("firefox-notes.ts CLI", () => {
  const script = fileURLToPath(new URL("../firefox-notes.ts", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "firefox-notes-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const surfer = join(dir, "surfer.json");
  const notes = join(dir, "CHANGELOG.md");
  writeFileSync(notes, changelog);
  const run = (firefox: unknown) => {
    writeFileSync(
      surfer,
      JSON.stringify({
        version: { product: "firefox", version: firefox },
        brands: { vimma: { release: { displayVersion: "0.5.2" } } },
      }),
    );
    return spawnSync(process.execPath, [script, notes, "--surfer", surfer], { encoding: "utf8" });
  };

  it("prints the notes with surfer.json's Firefox version", () => {
    const res = run("158.0");
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(firefoxNotes(changelog, { firefox: "158.0" }));
  });

  it("exits 2 on a malformed surfer.json", () => {
    const res = run("158");
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/^firefox-notes: .*version\.version/);
  });
});
