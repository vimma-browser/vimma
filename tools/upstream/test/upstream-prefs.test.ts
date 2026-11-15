import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CFR,
  SB_LISTS,
  checkPrefs,
  prefLine,
  readPref,
  refreshPrefs,
  unifiedDiff,
} from "../upstream-prefs.mjs";
import { tempDir } from "../../test/temp-dir.mjs";

const OURS_PATH = "src/browser/branding/vimma/pref/firefox-branding.js";
const script = fileURLToPath(new URL("../upstream-prefs.mjs", import.meta.url));
const ours = readFileSync(
  new URL("../../../src/browser/branding/vimma/pref/firefox-branding.js", import.meta.url),
  "utf8",
);

// Upstream's lines as in Firefox 157.0.1 (browser/app/profile/firefox.js, modules/libpref/init/all.js).
const firefoxJs =
  'pref("browser.newtabpage.activity-stream.asrouter.providers.cfr", "{\\"id\\":\\"cfr\\",' +
  '\\"enabled\\":true,\\"type\\":\\"remote-settings\\",\\"collection\\":\\"cfr\\",' +
  '\\"updateCycleInMs\\":3600000}");\n';
const allJs =
  'pref("browser.safebrowsing.provider.google4.lists", "goog-badbinurl-proto,' +
  "goog-downloadwhite-proto,goog-phish-proto,googpub-phish-proto,goog-malware-proto," +
  'goog-unwanted-proto,goog-harmful-proto");\n' +
  'pref("browser.safebrowsing.provider.google5.lists", "goog-badbinurl-proto,' +
  "goog-downloadwhite-proto,goog-phish-proto,googpub-phish-proto,goog-malware-proto," +
  'goog-unwanted-proto,goog-harmful-proto,goog-globalcache-proto");\n';

describe("upstream prefs we carry copies of", () => {
  it("reads a pref's string value, escapes and all", () => {
    expect(readPref(firefoxJs, CFR)).toBe(
      '{"id":"cfr","enabled":true,"type":"remote-settings","collection":"cfr","updateCycleInMs":3600000}',
    );
    expect(readPref(firefoxJs, "no.such.pref")).toBeNull();
  });

  it("our branding prefs match Firefox 157.0.1's", () => {
    expect(checkPrefs({ firefoxJs, allJs, ours })).toEqual([]);
  });

  it("a new upstream cfr field is reported with the line to paste", () => {
    const newer = firefoxJs.replace("3600000}", '3600000,\\"frequency\\":2}');
    const [problem, ...rest] = checkPrefs({ firefoxJs: newer, allJs, ours });
    expect(rest).toEqual([]);
    expect(problem?.pref).toBe(CFR);
    expect(problem?.want).toBe(
      '{"id":"cfr","enabled":false,"type":"remote-settings","collection":"cfr",' +
        '"updateCycleInMs":3600000,"frequency":2}',
    );
    expect(prefLine(CFR, problem?.want ?? "")).toBe(
      `pref("${CFR}", "{\\"id\\":\\"cfr\\",\\"enabled\\":false,\\"type\\":\\"remote-settings\\",` +
        '\\"collection\\":\\"cfr\\",\\"updateCycleInMs\\":3600000,\\"frequency\\":2}");',
    );
  });

  it("a new upstream Safe Browsing list is reported, minus the Mozilla-key lists", () => {
    const newer = allJs.replace('goog-harmful-proto")', 'goog-harmful-proto,goog-new-proto")');
    const problems = checkPrefs({ firefoxJs, allJs: newer, ours });
    expect(problems.map((p) => [p.pref, p.want])).toEqual([
      [
        SB_LISTS[0],
        "goog-phish-proto,googpub-phish-proto,goog-malware-proto,goog-unwanted-proto," +
          "goog-harmful-proto,goog-new-proto",
      ],
    ]);
  });

  it("a pref upstream renamed or removed is its own problem, not a silent pass", () => {
    const problems = checkPrefs({ firefoxJs: "", allJs, ours });
    expect(problems).toEqual([
      { pref: CFR, ours: expect.any(String), want: null, missing: "upstream" },
    ]);
  });

  it("the CLI exits 0 when current, 1 with the fix when stale", () => {
    const engine = tempDir("prefs-");
    mkdirSync(join(engine, "browser/app/profile"), { recursive: true });
    mkdirSync(join(engine, "modules/libpref/init"), { recursive: true });
    writeFileSync(join(engine, "browser/app/profile/firefox.js"), firefoxJs);
    writeFileSync(join(engine, "modules/libpref/init/all.js"), allJs);
    const run = () =>
      spawnSync(process.execPath, [script, "--engine", engine], { encoding: "utf8" });
    const ok = run();
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("up to date");
    writeFileSync(
      join(engine, "modules/libpref/init/all.js"),
      allJs.replace("goog-phish-proto,", ""),
    );
    const stale = run();
    expect(stale.status).toBe(1);
    expect(stale.stdout).toContain(`pref("${SB_LISTS[0]}", "googpub-phish-proto,`);
  });
});

// Spec upstream-bump-automation, Behaviour 1 and 2: the autopilot writes the refreshed lines into
// the bump instead of failing on them.
describe("refreshing the copied prefs for a bump", () => {
  const newerCfr = firefoxJs.replace("3600000}", '3600000,\\"frequency\\":2}');
  const newerLists = allJs.replaceAll("goog-harmful-proto", "goog-harmful-proto,goog-new-proto");

  it("writes the derived cfr line when upstream adds a field", () => {
    const r = refreshPrefs({ firefoxJs: newerCfr, allJs, ours });
    expect(r.state).toBe("refreshed");
    expect(r.refreshed.map((p) => p.pref)).toEqual([CFR]);
    expect(r.refreshed[0]?.old).toBe(readPref(ours, CFR));
    expect(readPref(r.text, CFR)).toBe(
      '{"id":"cfr","enabled":false,"type":"remote-settings","collection":"cfr",' +
        '"updateCycleInMs":3600000,"frequency":2}',
    );
    expect(checkPrefs({ firefoxJs: newerCfr, allJs, ours: r.text })).toEqual([]);
  });

  it("writes both Safe Browsing lists without the Mozilla-key lists", () => {
    const r = refreshPrefs({ firefoxJs, allJs: newerLists, ours });
    expect(r.refreshed.map((p) => p.pref)).toEqual(SB_LISTS);
    for (const pref of SB_LISTS) {
      const v = readPref(r.text, pref) ?? "";
      expect(v).toContain("goog-new-proto");
      expect(v).not.toMatch(/goog-badbinurl-proto|goog-downloadwhite-proto/);
    }
    expect(checkPrefs({ firefoxJs, allJs: newerLists, ours: r.text })).toEqual([]);
  });

  it("leaves a current file byte-identical", () => {
    const r = refreshPrefs({ firefoxJs, allJs, ours });
    expect(r).toEqual({ state: "current", text: ours, refreshed: [], unresolved: [] });
    expect(unifiedDiff(OURS_PATH, ours, r.text)).toBe("");
  });

  it("reports unresolved and writes nothing for a pref missing upstream", () => {
    const r = refreshPrefs({ firefoxJs: "", allJs: newerLists, ours });
    expect(r.state).toBe("unresolved");
    expect(r.unresolved).toEqual([CFR]);
    expect(r.text).toBe(ours);
    expect(r.refreshed).toEqual([]);
  });

  it("the diff touches only the three copied pref lines", () => {
    const r = refreshPrefs({ firefoxJs: newerCfr, allJs: newerLists, ours });
    const diff = unifiedDiff(OURS_PATH, ours, r.text);
    const changed = diff.split("\n").filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+) /.test(l));
    expect(changed).toHaveLength(6);
    for (const l of changed) expect(l).toMatch(/^[-+]pref\("([^"]+)"/);
    const names = new Set(changed.map((l) => /^[-+]pref\("([^"]+)"/.exec(l)?.[1]));
    expect([...names].sort()).toEqual([CFR, ...SB_LISTS].sort());
  });

  it("--write-diff writes a patch git applies to the repository's file, and the state", () => {
    const up = tempDir("prefs-up-");
    writeFileSync(join(up, "firefox.js"), newerCfr);
    writeFileSync(join(up, "all.js"), allJs);
    const repo = tempDir("prefs-repo-");
    mkdirSync(join(repo, "src/browser/branding/vimma/pref"), { recursive: true });
    writeFileSync(join(repo, OURS_PATH), ours);
    const patch = join(up, "prefs-refresh.patch");
    const json = join(up, "prefs-refresh.json");
    const output = join(up, "github-output");
    writeFileSync(output, "");
    const args = ["--firefox-js", join(up, "firefox.js"), "--all-js", join(up, "all.js")];
    const r = spawnSync(
      process.execPath,
      [script, ...args, "--write-diff", patch, "--json", json, "--github-output", output],
      { encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("prefs=refreshed\n");
    expect(JSON.parse(readFileSync(json, "utf8")).refreshed[0].pref).toBe(CFR);
    spawnSync("git", ["init", "-q"], { cwd: repo });
    const apply = spawnSync("git", ["apply", patch], { cwd: repo, encoding: "utf8" });
    expect(apply.status, apply.stderr).toBe(0);
    const after = readFileSync(join(repo, OURS_PATH), "utf8");
    expect(checkPrefs({ firefoxJs: newerCfr, allJs, ours: after })).toEqual([]);
  });

  it("--write-diff on a current or unresolved file writes an empty patch", () => {
    const up = tempDir("prefs-up-");
    writeFileSync(join(up, "all.js"), allJs);
    const patch = join(up, "p.patch");
    const output = join(up, "github-output");
    writeFileSync(output, "");
    const r = spawnSync(
      process.execPath,
      [
        script,
        "--firefox-js",
        join(up, "absent.js"),
        "--all-js",
        join(up, "all.js"),
        "--write-diff",
        patch,
        "--github-output",
        output,
      ],
      { encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe("prefs=unresolved\n");
    expect(readFileSync(patch, "utf8")).toBe("");
    expect(r.stdout).toContain(`${CFR} is gone upstream`);
  });
});
