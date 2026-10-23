import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkChangelog, handWrittenNotes, moveUnreleased } from "../changelog.mjs";

// Issue #529: the hand-written `## [Unreleased]` lines move into the release's own entry when
// release-please opens or updates its release pull request, above release-please's commit list,
// and reach the GitHub release's notes; `npm run lint` keeps `[Unreleased]` first and single.

const compare = "https://github.com/vimma-browser/vimma/compare/v0.5.1...v0.5.2";
const older = "https://github.com/vimma-browser/vimma/compare/v0.5.0...v0.5.1";
const commit = (/** @type {string} */ sha) =>
  `([${sha}](https://github.com/vimma-browser/vimma/commit/${sha}${"0".repeat(33)}))`;

const header = [
  "# Changelog",
  "",
  "All notable changes to this project are documented here.",
  "",
  "",
].join("\n");

/** The 0.5.2 entry as release-please writes it. */
const entry = [
  `## [0.5.2](${compare}) (2026-10-20)`,
  "",
  "",
  "### Added",
  "",
  `* **keys:** a new key ${commit("aaaaaaa")}`,
  "",
  "",
  "### Fixed",
  "",
  `* **hints:** a fix ${commit("bbbbbbb")}`,
  "",
].join("\n");

const unreleased = [
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- Keys: `gx` opens the thing, with the wording users see.",
  "- Agents (MCP): a second added line,",
  "  continued on an indented line.",
  "",
  "### Changed",
  "",
  "- `F` now starts element focus.",
  "",
  "### Fixed",
  "",
  "- Hints: a hand-written fix line.",
  "",
].join("\n");

const previous = [
  `## [0.5.1](${older}) (2026-10-13)`,
  "",
  "### Fixed",
  "",
  "- An older hand-written line.",
  "",
  `* **panel:** an older fix ${commit("ccccccc")}`,
  "",
].join("\n");

/** CHANGELOG.md on main: [Unreleased] first. */
const onMain = `${header}${unreleased}\n${previous}`;
/** CHANGELOG.md on the release branch: release-please put 0.5.2 above [Unreleased]. */
const onBranch = `${header}${entry}\n${unreleased}\n${previous}`;

const moved = [
  header + "## [Unreleased]",
  "",
  `## [0.5.2](${compare}) (2026-10-20)`,
  "",
  "",
  "### Added",
  "",
  "- Keys: `gx` opens the thing, with the wording users see.",
  "- Agents (MCP): a second added line,",
  "  continued on an indented line.",
  "",
  `* **keys:** a new key ${commit("aaaaaaa")}`,
  "",
  "",
  "### Fixed",
  "",
  "- Hints: a hand-written fix line.",
  "",
  `* **hints:** a fix ${commit("bbbbbbb")}`,
  "",
  "",
  "### Changed",
  "",
  "- `F` now starts element focus.",
  "",
  previous,
].join("\n");

describe("moveUnreleased", () => {
  it("moves the hand-written lines into the new version's sections, above release-please's", () => {
    expect(moveUnreleased(onBranch)).toBe(moved);
  });

  it("leaves an empty [Unreleased] as the first version heading", () => {
    const out = moveUnreleased(onBranch);
    expect(out.match(/^## .*$/m)?.[0]).toBe("## [Unreleased]");
    expect(checkChangelog(out)).toEqual([]);
  });

  it("is idempotent: a second pass changes nothing", () => {
    expect(moveUnreleased(moved)).toBe(moved);
  });

  it("keeps everything below the new entry byte for byte", () => {
    expect(moveUnreleased(onBranch).endsWith(`\n${previous}`)).toBe(true);
  });

  it("adds a section release-please did not write after its own sections", () => {
    const out = moveUnreleased(onBranch);
    expect(out.indexOf("### Changed")).toBeGreaterThan(out.indexOf("* **hints:** a fix"));
    expect(out.indexOf("### Changed")).toBeLessThan(out.indexOf("## [0.5.1]"));
  });

  it("adds a line written after an earlier pass below the lines already moved", () => {
    const again = moved.replace(
      "## [Unreleased]\n\n",
      "## [Unreleased]\n\n### Added\n\n- A line merged later.\n\n",
    );
    const out = moveUnreleased(again);
    expect(out).toBe(
      moved.replace(
        "  continued on an indented line.\n",
        "  continued on an indented line.\n- A line merged later.\n",
      ),
    );
  });

  it("moves a line that is the start of a longer line already in the entry", () => {
    const short = "- Keys: `gx` opens the thing";
    const again = moved.replace(
      "## [Unreleased]\n\n",
      `## [Unreleased]\n\n### Added\n\n${short}\n\n`,
    );
    expect(moveUnreleased(again)).toContain(`\n  continued on an indented line.\n${short}\n`);
  });

  it("moves what release-please 17.6.0's changelog updater really writes", () => {
    // src/updaters/changelog.ts updateContent, with DEFAULT_VERSION_HEADER_REGEX
    const i = onMain.search(/\n###? v?[0-9[]/s);
    const real = `${onMain.slice(0, i)}\n${entry}\n${onMain.slice(i)}`.trim() + "\n";
    expect(checkChangelog(real)).not.toEqual([]);
    const out = moveUnreleased(real);
    expect(checkChangelog(out)).toEqual([]);
    expect(out).toContain("### Fixed\n\n- Hints: a hand-written fix line.\n\n* **hints:** a fix");
    expect(moveUnreleased(out)).toBe(out);
  });

  it("leaves a changelog whose [Unreleased] is empty unchanged", () => {
    const empty = `${header}## [Unreleased]\n\n${entry}\n${previous}`;
    expect(moveUnreleased(empty)).toBe(empty);
  });

  it("adds an empty [Unreleased] when there is none", () => {
    const none = `${header}${entry}\n${previous}`;
    expect(moveUnreleased(none)).toBe(`${header}## [Unreleased]\n\n${entry}\n${previous}`);
  });

  it("works on a first release without a compare link", () => {
    const first = `${header}## 0.1.0 (2026-10-01)\n\n\n### Added\n\n* a ${commit("ddddddd")}\n\n${unreleased}`;
    const out = moveUnreleased(first);
    expect(out.startsWith(`${header}## [Unreleased]\n\n## 0.1.0 (2026-10-01)\n`)).toBe(true);
    expect(out).toContain("### Added\n\n- Keys: `gx` opens the thing");
  });

  it("refuses a changelog with two [Unreleased] sections or no release entry", () => {
    expect(() => moveUnreleased(`${onBranch}\n${unreleased}`)).toThrow(/\[Unreleased\]/);
    expect(() => moveUnreleased(onMain.replace(previous, ""))).toThrow(/version/);
  });

  it("refuses an [Unreleased] it cannot move whole, rather than drop text", () => {
    const prose = onBranch.replace("### Added\n\n- Keys", "Some prose.\n\n### Added\n\n- Keys");
    expect(() => moveUnreleased(prose)).toThrow(/line \d+/);
  });
});

describe("handWrittenNotes", () => {
  // The tag's CHANGELOG.md and the release body release-please created from the release PR's.
  const tagged = moved;
  const body = entry;

  it("adds the version's hand-written lines to the release notes, above the commit list", () => {
    const out = handWrittenNotes(body, tagged, "0.5.2");
    expect(out).toBe(moved.slice(moved.indexOf("## [0.5.2]"), moved.indexOf("## [0.5.1]") - 1));
  });

  it("is idempotent: a second pass changes nothing", () => {
    const once = handWrittenNotes(body, tagged, "0.5.2");
    expect(handWrittenNotes(once, tagged, "0.5.2")).toBe(once);
  });

  it("keeps the update steps above and the third-party notice below the entry", () => {
    const full = `### Updating\n\nsteps\n\n${entry}\n### Third-party notice\n\nnotice\n`;
    const out = handWrittenNotes(full, tagged, "0.5.2");
    expect(out.startsWith("### Updating\n\nsteps\n\n## [0.5.2]")).toBe(true);
    expect(out.endsWith("\n### Third-party notice\n\nnotice\n")).toBe(true);
    expect(out.indexOf("### Changed")).toBeLessThan(out.indexOf("### Third-party notice"));
    expect(out).toContain("### Fixed\n\n- Hints: a hand-written fix line.\n\n* **hints:**");
  });

  it("works on a heading that already names the Firefox version", () => {
    const named = tagged.replace(`(${compare})`, `(${compare}) · Firefox 158.0`);
    const out = handWrittenNotes(body, named, "0.5.2");
    expect(out).toContain("### Added\n\n- Keys: `gx` opens the thing");
  });

  it("leaves notes without hand-written lines as they are", () => {
    const plain = `${header}## [Unreleased]\n\n${entry}\n${previous}`;
    expect(handWrittenNotes(body, plain, "0.5.2")).toBe(body);
  });

  it("refuses notes or a changelog for another version", () => {
    expect(() => handWrittenNotes(body, tagged, "0.5.3")).toThrow(/0\.5\.3/);
    expect(() => handWrittenNotes(previous, tagged, "0.5.2")).toThrow(/0\.5\.2/);
  });
});

describe("checkChangelog", () => {
  it("accepts [Unreleased] as the first and only unreleased heading", () => {
    expect(checkChangelog(onMain)).toEqual([]);
    expect(checkChangelog(moved)).toEqual([]);
  });

  it("fails when [Unreleased] is not the first version heading", () => {
    expect(checkChangelog(onBranch)).toEqual([
      expect.stringMatching(/line 5: .*\[Unreleased\].* first/),
    ]);
  });

  it("fails when [Unreleased] appears twice", () => {
    expect(checkChangelog(`${onMain}\n${unreleased}`)).toEqual([
      expect.stringMatching(/line \d+: .*\[Unreleased\].* once/),
    ]);
  });

  it("fails when there is no [Unreleased]", () => {
    expect(checkChangelog(`${header}${previous}`)).toEqual([
      expect.stringMatching(/no `## \[Unreleased\]`/),
    ]);
  });

  it("fails on [Unreleased] content that the release step could not move", () => {
    const bad = onMain
      .replace("- `F` now starts", "* `F` now starts")
      .replace("### Fixed\n\n- Hints", "### Bugs\n\n- Hints");
    expect(checkChangelog(bad)).toEqual([
      expect.stringMatching(/line 15: .*`- `/),
      expect.stringMatching(/line 17: .*### Bugs/),
    ]);
  });

  it("runs in npm run lint", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts["changelog-lint"]).toBe(
      "node tools/release/changelog.mjs check CHANGELOG.md",
    );
    expect(pkg.scripts.lint).toMatch(/&& npm run changelog-lint(?: |$)/);
    // CI runs lint's parts as steps; this one also on a docs-only pull request, which is how a
    // changelog line usually lands.
    const ci = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(ci).toMatch(
      /\n {6}- name: [^\n]*\(npm run changelog-lint\)\n {8}run: npm run changelog-lint\n/,
    );
  });

  it("passes on the repository's CHANGELOG.md", () => {
    const file = readFileSync(new URL("../../../CHANGELOG.md", import.meta.url), "utf8");
    expect(checkChangelog(file)).toEqual([]);
  });
});

describe("changelog.mjs CLI", () => {
  const script = fileURLToPath(new URL("../changelog.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "changelog-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = (/** @type {string} */ name, /** @type {string} */ text) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  /** @param {string[]} args */
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

  it("move prints the changelog with [Unreleased] moved into the new version", () => {
    const res = run("move", file("branch.md", onBranch));
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(moved);
  });

  it("notes prints the release notes with the version's hand-written lines", () => {
    const res = run(
      "notes",
      file("body.md", entry),
      "--changelog",
      file("tag.md", moved),
      "--version",
      "0.5.2",
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(handWrittenNotes(entry, moved, "0.5.2"));
  });

  it("check exits 0 on a good changelog and 1 with each problem on a bad one", () => {
    expect(run("check", file("good.md", onMain)).status).toBe(0);
    const res = run("check", file("bad.md", onBranch));
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/bad\.md: line 5: .*\[Unreleased\]/);
  });

  it("exits 2 on a usage error", () => {
    expect(run("shuffle", file("x.md", onMain)).status).toBe(2);
    expect(run("notes", file("y.md", entry)).status).toBe(2);
  });
});
