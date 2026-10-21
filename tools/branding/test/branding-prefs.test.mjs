// Our branding prefs file replaces the one Surfer generates from upstream's unofficial brand
// (spec m0-branding), so a pref upstream adds there is silently dropped. Firefox reads several of
// them without a fallback (BrowserGlue's getIntPref("app.update.checkInstallTime.days")), and a
// missing one breaks startup. Needs engine/ (Firefox source): the e2e workflow has it, the plain CI
// job does not, so the check skips there.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const OURS = `${root}src/browser/branding/vimma/pref/firefox-branding.js`;
const UPSTREAM = `${root}engine/browser/branding/unofficial/pref/firefox-branding.js`;

/**
 * Pref names a libpref defaults file sets with pref(), comments ignored.
 *
 * @param {string} file
 * @returns {Set<string>}
 */
function prefNames(file) {
  const text = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return new Set([...text.matchAll(/^\s*pref\(\s*"([^"]+)"/gm)].map((m) => m[1]));
}

const hasEngine = existsSync(UPSTREAM);
if (!hasEngine) {
  console.warn(`branding-prefs: skipped, ${UPSTREAM} is absent (run npm run import first)`);
}

describe("Vimma branding prefs", () => {
  it.skipIf(!hasEngine)(
    "define every pref upstream's unofficial brand defines (skipped without engine/)",
    () => {
      const ours = prefNames(OURS);
      const missing = [...prefNames(UPSTREAM)].filter((name) => !ours.has(name));
      expect(missing).toEqual([]);
    },
  );
});

/**
 * A pref's value as written in the defaults file.
 * @param {string} name
 */
function prefValue(name) {
  const text = readFileSync(OURS, "utf8");
  const m = new RegExp(
    `^\\s*pref\\(\\s*"${name.replaceAll(".", "\\.")}"\\s*,\\s*(.+?)\\s*\\);`,
    "m",
  ).exec(text);
  return m?.[1];
}

// docs/specs/m6a-updater.md, decision 13 and "Security and privacy".
describe("update checks", () => {
  it("run every 12 hours, on by default", () => {
    expect(prefValue("app.update.interval")).toBe("43200");
    expect(prefValue("vimma.update.enabled")).toBe("true");
  });

  it("ask updates.vimma.dev with the platform and channel only", () => {
    const url = JSON.parse(/** @type {string} */ (prefValue("vimma.update.url")));
    expect(url).toBe(
      "https://updates.vimma.dev/updates/browser/%BUILD_TARGET%/%CHANNEL%/update.xml",
    );
  });
});

// docs/specs/bookmarks-toolbar-hidden.md, decision 1.
describe("Firefox's Bookmarks Toolbar", () => {
  it('is hidden by default ("never"), a default the user can change, not a locked pref', () => {
    expect(prefValue("browser.toolbars.bookmarks.visibility")).toBe('"never"');
    expect(readFileSync(OURS, "utf8")).not.toMatch(/lockPref\(\s*"browser\.toolbars\.bookmarks/);
  });
});
