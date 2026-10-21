/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m6a-updater.md §5. `:restart` (action app.restart): Firefox's restart path for
// every install but the AppImage, which quits and starts its own file again through the fixed
// relaunch script, so a replaced AppImage runs its new version. What quits and what starts the
// script are fakes here (host/restart.mjs test hooks); the script itself runs under a real
// /bin/sh in packages/vimma-core/test/restart.test.mjs.

"use strict";

/* global focusContent -- from head.js */

const { Restart } = ChromeUtils.importESModule("chrome://browser/content/vimma/host/restart.mjs");
const { RELAUNCH_SCRIPT } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/restart.mjs",
);
const { VimmaUpdates } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/updates/VimmaUpdates.sys.mjs",
);
const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
);

const PAGE = "https://example.com/?restart";
const RESUME = "browser.sessionstore.resume_session_once";
const dir = PathUtils.join(PathUtils.tempDir, `vimma-restart-${Date.now()}`);
const appImage = PathUtils.join(dir, "vimma-0.1.0-x86_64.AppImage");

const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 50, 100);
const noticeText = () => document.getElementById("vimma-notice")?.textContent ?? "";
const promptOpen = () => document.getElementById("vimma-rename")?.hidden === false;
const promptText = () =>
  (
    document.getElementById("vimma-rename")?.querySelector(".vimma-cmdline-prompt")?.textContent ??
    ""
  ).trim();

/** What the fake startup was asked, and what it answers. */
let quits = [];
let spawned = [];
let refuse = false;
const fakeStartup = {
  quit(mode) {
    quits.push(mode);
  },
  restartInSafeMode(mode) {
    quits.push(`safe ${mode}`);
  },
  get attemptingQuit() {
    return !refuse && quits.length > 0;
  },
};

/** The restart requests other observers saw, by their data. */
let requests = [];
const requestObserver = (_subject, _topic, data) => requests.push(data);

/** @param {string} type */
async function install(type) {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.update.installType", type]] });
  VimmaUpdates._reset();
  await VimmaUpdates.describe();
  Assert.equal(VimmaUpdates.installType, type, `the install type is ${type}`);
}

async function runCommand(line) {
  await SimpleTest.promiseFocus(window);
  await focusContent(gBrowser.selectedBrowser);
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
}

function fresh() {
  Restart._reset();
  quits = [];
  spawned = [];
  requests = [];
  refuse = false;
  Services.prefs.clearUserPref(RESUME);
}

add_task(async function setup() {
  // No update check: the install type is all these tests need.
  await SpecialPowers.pushPrefEnv({ set: [["vimma.update.enabled", false]] });
  await IOUtils.makeDirectory(dir);
  await IOUtils.writeUTF8(appImage, "#!/bin/sh\n");
  await IOUtils.setPermissions(appImage, 0o755);
  const previous = {
    appImage: Services.env.get("APPIMAGE"),
    profile: Services.env.get("XRE_PROFILE_PATH"),
    local: Services.env.get("XRE_PROFILE_LOCAL_PATH"),
  };
  Services.env.set("APPIMAGE", appImage);
  Restart._setStartup(fakeStartup, (program, args) => spawned.push({ program, args }));
  Services.obs.addObserver(requestObserver, "quit-application-requested");
  await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  registerCleanupFunction(async () => {
    Restart._reset();
    Restart._setStartup(null);
    Services.obs.removeObserver(requestObserver, "quit-application-requested");
    Services.env.set("APPIMAGE", previous.appImage);
    Services.env.set("XRE_PROFILE_PATH", previous.profile);
    Services.env.set("XRE_PROFILE_LOCAL_PATH", previous.local);
    Services.prefs.clearUserPref(RESUME);
    VimmaUpdates._reset();
    while (gBrowser.tabs.length > 1) BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
    await IOUtils.remove(dir, { recursive: true });
  });
});

add_task(async function a_tarball_restarts_through_firefox() {
  fresh();
  await install("tarball");
  await runCommand("restart");
  await until(() => quits.length === 1, ":restart quit");
  Assert.deepEqual(requests, ["restart"], "asked as a restart, so Firefox warns of nothing else");
  Assert.equal(quits[0], Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart);
  // $APPIMAGE is set (setup), as for a tarball Vimma started from an AppImage: not this
  // Vimma's file, so it is never started.
  Assert.ok(!Restart._waiting, "no relaunch script: Firefox starts the same binary again");
  Assert.ok(!Services.prefs.prefHasUserValue(RESUME), "Firefox's restart resumes by itself");
});

add_task(async function an_appimage_quits_and_starts_its_file_again() {
  fresh();
  await install("appimage");
  await runCommand("restart");
  await until(() => quits.length === 1, ":restart quit");
  Assert.deepEqual(requests, ["restart"]);
  Assert.equal(quits[0], Ci.nsIAppStartup.eAttemptQuit, "a quit, not Firefox's restart");
  Assert.ok(Services.prefs.getBoolPref(RESUME), "the session comes back once, as on a restart");
  Assert.ok(Restart._waiting, "the relaunch waits until the quit is certain");
  Assert.deepEqual(spawned, [], "nothing starts before quit-application");
  Restart._quitApplication();
  Assert.deepEqual(spawned, [
    {
      program: "/bin/sh",
      args: ["-c", RELAUNCH_SCRIPT, "vimma-restart", String(Services.appinfo.processID), appImage],
    },
  ]);
  Assert.equal(
    Services.env.get("XRE_PROFILE_PATH"),
    Services.dirsvc.get("ProfD", Ci.nsIFile).path,
    "the new process opens this profile",
  );
  Assert.equal(
    Services.env.get("XRE_PROFILE_LOCAL_PATH"),
    Services.dirsvc.get("ProfLD", Ci.nsIFile).path,
  );
  Assert.ok(!Restart._waiting);
});

add_task(async function a_refused_quit_starts_nothing_and_leaves_the_session_as_it_was() {
  fresh();
  refuse = true; // a page's beforeunload kept its window
  await install("appimage");
  await runCommand("restart");
  await until(() => noticeText() === "restart cancelled", "it says so");
  Assert.equal(quits.length, 1);
  Assert.ok(!Restart._waiting, "no relaunch waits");
  Assert.ok(!Services.prefs.prefHasUserValue(RESUME), "the resume pref is as it was");
  Restart._quitApplication();
  Assert.deepEqual(spawned, [], "a later quit starts nothing");
});

add_task(async function a_cancelled_request_quits_nothing() {
  fresh();
  await install("appimage");
  const cancel = (subject) => {
    subject.QueryInterface(Ci.nsISupportsPRBool).data = true;
  };
  Services.obs.addObserver(cancel, "quit-application-requested");
  try {
    await runCommand("restart");
    await until(() => noticeText() === "restart cancelled", "it says so");
  } finally {
    Services.obs.removeObserver(cancel, "quit-application-requested");
  }
  Assert.deepEqual(quits, [], "nothing quits");
  Assert.ok(!Restart._waiting);
});

add_task(async function an_appimage_whose_file_cannot_run_restarts_through_firefox() {
  await install("appimage");
  // Not executable, then gone: Firefox's restart still restarts, into the version running.
  for (const spoil of [
    () => IOUtils.setPermissions(appImage, 0o644),
    () => IOUtils.remove(appImage),
  ]) {
    fresh();
    await spoil();
    await runCommand("restart");
    await until(() => quits.length === 1, ":restart quit");
    Assert.equal(quits[0], Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart);
    Assert.ok(!Restart._waiting, "nothing waits to start a file that cannot run");
  }
  await IOUtils.writeUTF8(appImage, "#!/bin/sh\n");
  await IOUtils.setPermissions(appImage, 0o755);
});

add_task(async function private_tabs_ask_before_they_close() {
  fresh();
  await install("tarball");
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  Assert.ok(PrivateBrowsingUtils.isWindowPrivate(priv));
  try {
    await runCommand("restart");
    await until(promptOpen, "the y/N question is open");
    Assert.equal(promptText(), "Restart Vimma? 1 private tab will close. (y/N)");
    EventUtils.synthesizeKey("n");
    await until(() => !promptOpen(), "n closes it");
    Assert.deepEqual(quits, [], "n restarts nothing");
    await runCommand("restart");
    await until(promptOpen, "asked again");
    EventUtils.synthesizeKey("y");
    await until(() => quits.length === 1, "y restarts");
  } finally {
    await BrowserTestUtils.closeWindow(priv);
  }
});
