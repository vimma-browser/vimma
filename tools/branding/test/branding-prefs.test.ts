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

/** Pref names a libpref defaults file sets with pref(), comments ignored. */
function prefNames(file: string): Set<string> {
  const text = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return new Set([...text.matchAll(/^\s*pref\(\s*"([^"]+)"/gm)].map((m) => m[1] as string));
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

/** A pref's value as written in the defaults file. */
function prefValue(name: string) {
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
    const url = JSON.parse(prefValue("vimma.update.url") as string);
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

// docs/specs/firefox-surfaces-trim.md, delivery step 2: the design table's prefs rows, written as
// defaults (decision 5: never locked, never a policy). browser_vimma_firefox_surfaces_trim.js
// checks what they do in a running build.
describe("Firefox and Mozilla surfaces (firefox-surfaces-trim, step 2)", () => {
  const RELEASES = '"https://github.com/vimma-browser/vimma/releases/latest"';
  /** pref name to its value as written */
  const rows: Record<string, string> = {
    "app.feedback.baseURL": '"https://github.com/vimma-browser/vimma/discussions"',
    "identity.fxaccounts.toolbar.pxiToolbarEnabled.monitorEnabled": "false",
    "identity.fxaccounts.toolbar.appMenuSignInPromo.dismissed": "true",
    "browser.ml.chat.enabled": "false",
    "browser.ml.linkPreview.enabled": "false",
    "browser.preferences.aiControls": "false",
    "sidebar.main.tools": '"opentabs,bookmarks,history,syncedtabs,passwords"',
    "signon.firefoxRelay.feature": '"disabled"',
    "browser.shell.checkDefaultBrowser": "false",
    "browser.tabs.firefox-view.importHistory.dismissed": "true",
    "extensions.getAddons.showPane": "false",
    "extensions.htmlaboutaddons.recommendations.enabled": "false",
    "toolkit.datacollection.infoURL": '""',
    "datareporting.policy.firstRunURL": '""',
    "browser.uitour.url": '""',
    "breakpad.reportURL": '""',
    "browser.backup.template.fallback-download.release": RELEASES,
    "browser.backup.template.fallback-download.beta": RELEASES,
    "browser.backup.template.fallback-download.aurora": RELEASES,
    "browser.backup.template.fallback-download.nightly": RELEASES,
    "browser.backup.template.fallback-download.esr": RELEASES,
  };

  it.each(Object.entries(rows))("%s defaults to %s", (name, value) => {
    expect(prefValue(name)).toBe(value);
  });

  // Step 4c: the error pages lay out without the mascot's slot (its image is also empty).
  it("browser.netError.illustration.enabled defaults to false", () => {
    expect(prefValue("browser.netError.illustration.enabled")).toBe("false");
  });

  it("turn the local onboarding provider off, upstream's value otherwise", () => {
    const raw = prefValue("browser.newtabpage.activity-stream.asrouter.providers.onboarding");
    expect(JSON.parse(JSON.parse(raw as string))).toEqual({
      id: "onboarding",
      type: "local",
      localProvider: "OnboardingMessageProvider",
      enabled: false,
      exclude: [],
    });
  });

  it("lock none of them", () => {
    expect(readFileSync(OURS, "utf8")).not.toMatch(/lockPref\(/);
  });
});
