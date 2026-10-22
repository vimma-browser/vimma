/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// How Vimma restarts (docs/specs/m6a-updater.md §5, `:restart`). Firefox's restart starts the
// same binary path again, which for an AppImage is a file inside the image mounted at this start:
// it would run the old version even after the AppImage replaced its file, and keep the old mount
// alive. An AppImage therefore quits and starts `$APPIMAGE` anew, through a small /bin/sh script
// that waits for this process to exit, so the profile lock is free when the new one starts. The
// host (host/restart.mjs) brings the process and the quit.

/** @import { InstallType } from "./updates.mjs" */

/** How long the relaunch script waits for the old process to exit, in seconds. Firefox's own
 * shutdown watchdog ends a hung shutdown sooner (`toolkit.asyncshutdown.crash_timeout`, 60 s,
 * plus 10 s), so a restart never meets a profile still locked by a shutdown that goes on. */
export const RELAUNCH_WAIT_S = 120;

/**
 * Waits for process `$1` to exit (polling every 0.2 s, 600 times: RELAUNCH_WAIT_S), then replaces
 * itself with `$2`, with no arguments, as a launch from the desktop would run it. The pid and the
 * path are positional arguments, so no path is ever read as shell text. A `sleep` without
 * fractions falls back to whole seconds.
 */
export const RELAUNCH_SCRIPT =
  "i=0; " +
  'while kill -0 "$1" 2>/dev/null; do ' +
  'i=$((i + 1)); [ "$i" -gt 600 ] && exit 1; ' +
  "sleep 0.2 2>/dev/null || sleep 1; " +
  "done; " +
  'exec "$2"';

/**
 * `{ kind: "appimage", path }`: quit, then start the AppImage's file again; `{ kind: "firefox" }`:
 * Firefox's own restart. An AppImage whose `$APPIMAGE` is missing or not an absolute path
 * restarts through Firefox, which still restarts, into the version already running.
 * @param {{ installType: InstallType, appImage: string | null }} input
 * @returns {{ kind: "appimage", path: string } | { kind: "firefox" }}
 */
export function restartPlan({ installType, appImage }) {
  if (installType !== "appimage" || !usablePath(appImage)) return { kind: "firefox" };
  return { kind: "appimage", path: /** @type {string} */ (appImage) };
}

/** @param {string | null} path */
function usablePath(path) {
  return typeof path === "string" && path.startsWith("/") && !path.includes("\0");
}

/**
 * The relaunch process: /bin/sh with RELAUNCH_SCRIPT, `$0` a name for `ps`, then the pid to wait
 * for and the AppImage to start.
 * @param {{ pid: number, appImage: string }} input
 * @returns {{ program: string, args: string[] }}
 */
export function relaunchCommand({ pid, appImage }) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`not a process id: ${pid}`);
  if (!usablePath(appImage)) throw new Error("the AppImage path must be absolute");
  return {
    program: "/bin/sh",
    args: ["-c", RELAUNCH_SCRIPT, "vimma-restart", String(pid), appImage],
  };
}

/**
 * Whether session restore brings the tabs back after the restart. Firefox's restart keeps the
 * session even with history cleared on close (SessionStore stops listening for the purge on a
 * restart); an AppImage's restart is a quit, so the purge clears the session it would resume.
 * Permanent private browsing keeps no tab across any restart.
 * @param {{ appImage: boolean, permanentPrivate: boolean, clearsHistoryOnClose: boolean }} input
 *   `appImage`: the restart starts the AppImage again (restartPlan's "appimage")
 */
export function restartKeepsTabs({ appImage, permanentPrivate, clearsHistoryOnClose }) {
  if (permanentPrivate) return false;
  return !(appImage && clearsHistoryOnClose);
}

/**
 * The y/N `:restart` asks before tabs are lost, or null when none are: all of them when session
 * restore cannot bring them back, else the private workspace's, which it never does.
 * @param {{ privateTabs: number, tabsKept: boolean }} input  `privateTabs`: open private tabs
 * @returns {string | null}
 */
export function restartConfirmation({ privateTabs, tabsKept }) {
  if (!tabsKept) return "Restart Vimma? Tabs will not come back. (y/N)";
  if (privateTabs <= 0) return null;
  const tabs = privateTabs === 1 ? "1 private tab" : `${privateTabs} private tabs`;
  return `Restart Vimma? ${tabs} will close. (y/N)`;
}
