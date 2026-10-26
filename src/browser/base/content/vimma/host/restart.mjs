/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `:restart` (action app.restart, docs/specs/m6a-updater.md §5). Every install but the AppImage
// takes Firefox's restart path, as Firefox's own restart commands do: `quit-application-requested`
// with "restart" (an observer can cancel it), then `eAttemptQuit | eRestart` (a page's
// beforeunload can still cancel it), and session restore brings the tabs back. Firefox's restart
// starts the same binary path again, which in an AppImage lies inside the image mounted at this
// start, so it would run the old version even after the AppImage replaced its file. The AppImage
// therefore quits, and once the quit can no longer be cancelled (quit-application) starts a
// /bin/sh relaunch script (core/restart.mjs) that waits for this process to exit and then runs
// `$APPIMAGE`, on the same profile, with the session resumed once, as Firefox's restart would.

import { relaunchCommand, restartKeepsTabs, restartPlan } from "../core/restart.mjs";

/** @import { InstallType } from "../core/updates.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

/** Firefox's restart sets it in SessionStore's quit-application; a plain quit does not. */
const RESUME_PREF = "browser.sessionstore.resume_session_once";

/**
 * What quits; Services.startup outside tests.
 * @typedef {{ quit(mode: number): void, readonly attemptingQuit: boolean,
 *   restartInSafeMode(mode: number): void }} Startup
 */

/**
 * Starts relaunchCommand's process and does not wait for it (security.md C2: its only caller is
 * startRelaunch, with relaunchCommand's program and arguments).
 * @param {string} program @param {string[]} args
 */
function runDetached(program, args) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(program);
  const proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
  proc.init(file);
  proc.startHidden = true;
  proc.noShell = true;
  proc.runw(false, args, args.length);
}

/** @type {Startup | null} */
let startupOverride = null;
let spawn = runDetached;
/** The AppImage to start once the quit is certain; null when no relaunch waits. */
let relaunchPath = /** @type {string | null} */ (null);

/** The test hooks below work only in automation (`Cu.isInAutomation`), never in a release. */
const inAutomation = () => /** @type {any} */ (globalThis).Cu?.isInAutomation === true;

/** Services, with the members this module uses that the typings leave out. */
const services = /** @type {any} */ (Services);
const startup = () => /** @type {Startup} */ (startupOverride ?? services.startup);

/** @param {string} path */
function isExecutableFile(path) {
  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    return file.exists() && file.isFile() && file.isExecutable();
  } catch {
    return false;
  }
}

/** Starts the relaunch script; runs in quit-application, when the quit is certain. */
function startRelaunch() {
  const path = relaunchPath;
  if (!path) return;
  relaunchPath = null;
  Services.obs.removeObserver(observer, "quit-application");
  try {
    // The profile this process runs, as Firefox's restart passes it (AppShutdown::MaybeDoRestart):
    // a desktop launch could otherwise pick another one from profiles.ini.
    Services.env.set("XRE_PROFILE_PATH", Services.dirsvc.get("ProfD", Ci.nsIFile).path);
    Services.env.set("XRE_PROFILE_LOCAL_PATH", Services.dirsvc.get("ProfLD", Ci.nsIFile).path);
    const { program, args } = relaunchCommand({
      pid: Services.appinfo.processID,
      appImage: path,
    });
    spawn(program, args);
  } catch (e) {
    // Vimma still quits; the next start from the desktop runs the new file.
    console.error("vimma: restart could not start the AppImage again", e);
  }
}

/** A function is an nsIObserver to XPCOM. */
const observer = () => startRelaunch();

/**
 * Firefox clears history when it closes (Settings, "Delete cookies and site data when Firefox is
 * closed" with history ticked), which purges the session a quit would resume. The old pref counts
 * too, until Sanitizer migrates it at the first shutdown that sanitizes.
 */
function clearsHistoryOnClose() {
  const on = (/** @type {string} */ name, /** @type {boolean} */ fallback) =>
    Services.prefs.getBoolPref(name, fallback);
  return (
    on("privacy.sanitize.sanitizeOnShutdown", false) &&
    (on("privacy.clearOnShutdown_v2.browsingHistoryAndDownloads", true) ||
      on("privacy.clearOnShutdown.history", true))
  );
}

/**
 * Whether session restore brings the tabs back after restartVimma with this `appImage`.
 * @param {string | null} appImage  the AppImage it would start again, null for Firefox's restart
 */
export function tabsKeptBy(appImage) {
  return restartKeepsTabs({
    appImage: !!appImage,
    permanentPrivate: !!lazy.PrivateBrowsingUtils.permanentPrivateBrowsing,
    clearsHistoryOnClose: clearsHistoryOnClose(),
  });
}

/**
 * Restarts Vimma. Returns false when something cancelled it (an add-on, a page's beforeunload),
 * true when the restart is under way.
 * @param {{ installType: InstallType | null, appImage: string | null }} where
 */
export function restartVimma({ installType, appImage }) {
  if (relaunchPath) return true;
  const cancel = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
  Services.obs.notifyObservers(cancel, "quit-application-requested", "restart");
  if (cancel.data) return false;
  const s = startup();
  const plan = installType ? restartPlan({ installType, appImage }) : null;
  const safeMode = !!services.appinfo.inSafeMode;
  // Safe mode is Firefox's to keep across a restart (QuickActionsLoaderDefault's restart).
  if (plan?.kind !== "appimage" || !isExecutableFile(plan.path) || safeMode) {
    if (safeMode) s.restartInSafeMode(Ci.nsIAppStartup.eAttemptQuit);
    else s.quit(Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart);
    return s.attemptingQuit;
  }
  const resumed = Services.prefs.getBoolPref(RESUME_PREF, false);
  if (!lazy.PrivateBrowsingUtils.permanentPrivateBrowsing) {
    Services.prefs.setBoolPref(RESUME_PREF, true);
  }
  relaunchPath = plan.path;
  Services.obs.addObserver(observer, "quit-application");
  s.quit(Ci.nsIAppStartup.eAttemptQuit);
  if (s.attemptingQuit) return true;
  // A window refused to close: nothing quits, so nothing is started and the session is as before.
  relaunchPath = null;
  Services.obs.removeObserver(observer, "quit-application");
  Services.prefs.setBoolPref(RESUME_PREF, resumed);
  return false;
}

export const Restart = {
  /**
   * Test-only: a fake for what quits, and for what starts the relaunch process; null restores
   * Firefox's.
   * @param {Startup | null} fakeStartup
   * @param {((program: string, args: string[]) => void) | null} [fakeSpawn]
   */
  _setStartup(fakeStartup, fakeSpawn = null) {
    if (!inAutomation()) throw new Error("test-only");
    startupOverride = fakeStartup;
    spawn = fakeSpawn ?? runDetached;
  },

  /** Test-only: what quit-application does once the quit is certain. */
  _quitApplication() {
    if (!inAutomation()) throw new Error("test-only");
    startRelaunch();
  },

  /** Test-only: no relaunch waits any more, as after a quit that never came. */
  _reset() {
    if (!relaunchPath) return;
    relaunchPath = null;
    Services.obs.removeObserver(observer, "quit-application");
  },

  /** Test-only: whether a relaunch waits for the quit. */
  get _waiting() {
    return relaunchPath !== null;
  },
};
