/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec m5-omarchy-theme, "Instant reload": Omarchy's theme-set hook sends `-vimma-reload-theme`
// to the running Vimma through Firefox's command-line remoting; Vimma reads the theme at once and
// opens nothing. Vimma installs that hook itself when it finds Omarchy (vimma.theme.omarchyHook).

"use strict";

const { VIMMA_DARK } = ChromeUtils.importESModule("chrome://browser/content/vimma/core/index.mjs");
const { OmarchyHook } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/omarchy/OmarchyHook.sys.mjs",
);

const HOOK_PREF = "vimma.theme.omarchyHook";

function colorsToml(/** @type {string} */ darkBackground) {
  const palette = { ...VIMMA_DARK, dark_background: darkBackground };
  return Object.entries(palette)
    .map(([key, value]) => `${key} = "${value}"`)
    .join("\n");
}

/** "#rrggbb" → "rgb(r, g, b)", as getComputedStyle reports it. */
function rgb(/** @type {string} */ hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

function barBackground() {
  const bar = document.getElementById("vimma-statusbar");
  if (!bar) throw new Error("the window has no status bar");
  return getComputedStyle(bar).backgroundColor;
}

/**
 * What nsCommandLine::Run does with a command line from another process (it is not scriptable):
 * every command-line-handler in the order of its category entry, each given the same line.
 * @param {nsICommandLine} cmdLine
 */
function runHandlers(cmdLine) {
  const entries = [...Services.catMan.enumerateCategory("command-line-handler")].sort((a, b) =>
    a.entry < b.entry ? -1 : 1,
  );
  for (const { value } of entries) {
    try {
      Cc[value].getService(Ci.nsICommandLineHandler).handle(cmdLine);
    } catch (e) {
      // An XPCOM exception has its nsresult; anything else thrown has none.
      if (/** @type {{ result?: number }} */ (e).result === Cr.NS_ERROR_ABORT) throw e;
    }
  }
}

const browserWindows = () => [...Services.wm.getEnumerator("navigator:browser")].length;

add_task(async function test_remote_reload_theme() {
  const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-remote-reload");
  // Also when an assertion fails before the end (#207).
  registerCleanupFunction(() => IOUtils.remove(dir, { recursive: true, ignoreAbsent: true }));
  const colors = PathUtils.join(dir, "colors.toml");
  await IOUtils.writeUTF8(colors, colorsToml("#102030"));
  await SpecialPowers.pushPrefEnv({
    set: [
      // An hour: within this test only the reload reads the file again.
      ["vimma.theme.pollMs", 3600000],
      ["vimma.theme.omarchyPath", dir],
      ["vimma.theme.source", "omarchy"],
    ],
  });
  await TestUtils.waitForCondition(
    () => barBackground() === rgb("#102030"),
    "the first theme applies (a pref change re-reads at once)",
  );
  await IOUtils.writeUTF8(colors, colorsToml("#302010"));

  const windows = browserWindows();
  const tabs = gBrowser.tabs.length;
  const changed = TestUtils.topicObserved("vimma-theme-changed");
  let opened = 0;
  const onWindow = (/** @type {unknown} */ _w, /** @type {string} */ topic) => {
    if (topic === "domwindowopened") opened++;
  };
  Services.ww.registerNotification(onWindow);
  // An nsISupports in the IDL; the command line's class info gives it nsICommandLine.
  const cmdLine = /** @type {nsICommandLine} */ (
    Cu.createCommandLine(["-vimma-reload-theme"], null, Ci.nsICommandLine.STATE_REMOTE_AUTO)
  );
  runHandlers(cmdLine);

  Assert.equal(cmdLine.length, 0, "the flag is consumed");
  Assert.ok(cmdLine.preventDefault, "and nothing else handles the line");
  Assert.equal(browserWindows(), windows, "no window opens");
  Assert.equal(gBrowser.tabs.length, tabs, "no tab opens");
  await changed;
  Assert.equal(barBackground(), rgb("#302010"), "the new theme is read at once");
  // Anything opened late would be a window or tab from the browser's own handler.
  await new Promise((r) => setTimeout(r, 200));
  Assert.equal(browserWindows(), windows, "still no window");
  Assert.equal(gBrowser.tabs.length, tabs, "still no tab");
  Services.ww.unregisterNotification(onWindow);
  Assert.equal(opened, 0, "no window was even started");

  await SpecialPowers.popPrefEnv();
  await IOUtils.remove(dir, { recursive: true });
});

/** A temporary HOME; nothing here ever touches the real one. */
async function tempHome(/** @type {boolean} */ omarchy) {
  const home = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-hook-home");
  // Also when an assertion fails before the test removes it (#207).
  registerCleanupFunction(() => IOUtils.remove(home, { recursive: true, ignoreAbsent: true }));
  if (omarchy) await IOUtils.makeDirectory(PathUtils.join(home, ".config", "omarchy", "hooks"));
  return home;
}

const hookFile = (/** @type {string} */ home) =>
  PathUtils.join(home, ".config", "omarchy", "hooks", "theme-set.d", "vimma-theme-reload.sh");

add_task(async function test_installer() {
  Assert.ok(Cu.isInAutomation, "under test");
  Assert.equal(OmarchyHook.startupBlocked, "automation", "startup never installs into real HOME");
  await SpecialPowers.pushPrefEnv({ set: [[HOOK_PREF, true]] });

  const none = await tempHome(false);
  Assert.equal(await OmarchyHook.sync(none), "no-omarchy", "no Omarchy: nothing to do");
  Assert.deepEqual(await IOUtils.getChildren(none), [], "and nothing written");

  const home = await tempHome(true);
  const file = hookFile(home);
  Assert.equal(await OmarchyHook.sync(home), "installed", "missing: written");
  const shipped = await (await fetch(OmarchyHook.HOOK_URL)).text();
  const text = await IOUtils.readUTF8(file);
  Assert.ok(text.startsWith(shipped), "the shipped hook");
  Assert.ok(text.includes("vimma.theme.omarchyHook"), "with the opt-out in it");
  Assert.equal((await IOUtils.stat(file)).permissions, 0o644, "mode 0644");
  const { lastModified } = await IOUtils.stat(file);
  Assert.equal(await OmarchyHook.sync(home), "current", "a second start leaves it be");
  Assert.equal((await IOUtils.stat(file)).lastModified, lastModified, "not rewritten");

  // An older hook Vimma wrote and nobody edited: brought up to date.
  await IOUtils.writeUTF8(file, await OmarchyHook.render("#!/bin/bash\nexit 0\n"));
  Assert.equal(await OmarchyHook.sync(home), "updated", "an unedited old copy is updated");
  Assert.equal(await IOUtils.readUTF8(file), text, "to the shipped hook");

  // The user's edit: never overwritten, never removed.
  const edited = text.replace("exit 0", "notify-send hi\nexit 0");
  await IOUtils.writeUTF8(file, edited);
  Assert.equal(await OmarchyHook.sync(home), "modified", "an edited hook is the user's");
  Assert.equal(await IOUtils.readUTF8(file), edited, "left alone");
  Services.prefs.setBoolPref(HOOK_PREF, false);
  Assert.equal(await OmarchyHook.sync(home), "modified", "opting out leaves it too");
  Assert.equal(await IOUtils.readUTF8(file), edited, "still there");

  // Opting out removes Vimma's own, unedited copy.
  await IOUtils.writeUTF8(file, text);
  Assert.equal(await OmarchyHook.sync(home), "removed", "opt-out removes ours");
  Assert.ok(!(await IOUtils.exists(file)), "gone");
  Assert.equal(await OmarchyHook.sync(home), "off", "and stays off");
  Assert.ok(!(await IOUtils.exists(file)), "not written while off");

  // Back on: installed once; a hook the user then deletes stays deleted.
  Services.prefs.setBoolPref(HOOK_PREF, true);
  Assert.equal(await OmarchyHook.sync(home), "installed", "on again: written");
  await IOUtils.remove(file);
  Assert.equal(await OmarchyHook.sync(home), "deleted", "deleted by the user: not again");
  Assert.ok(!(await IOUtils.exists(file)), "still deleted");

  await SpecialPowers.popPrefEnv();
  Services.prefs.clearUserPref("vimma.theme.omarchyHookInstalled");
  await IOUtils.remove(none, { recursive: true });
  await IOUtils.remove(home, { recursive: true });
});
