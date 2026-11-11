/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Which command Firefox's GNOME shell service takes as this browser (#855).

/**
 * nsGNOMEShellService::Init reads it once, as the browser's own command, else takes the binary's
 * path. Make Default then sets the installed desktop entry whose Exec program is that exact path
 * (nsGIOService::FindAppFromCommand), or writes a userapp- entry for it, and IsDefaultBrowser
 * counts only a handler whose program is that path. Firefox reads it for XSMP session restore
 * too, which falls back to the binary when it is empty.
 */
const ENV = "MOZ_APP_LAUNCHER";

/**
 * The packages install it next to the binary, and their desktop entry's Exec names it by that
 * path (tools/package/package.mjs), so links from other apps keep going through it to routing.
 */
const LAUNCHER = "vimma-open";

/**
 * @param {string} path
 * @returns {boolean} whether `path` is an executable file
 */
function isExecutableFile(path) {
  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    return file.isFile() && file.isExecutable();
  } catch {
    return false;
  }
}

/**
 * @param {string} path
 * @returns {string} `path` with its symbolic links resolved, as the binary's own path is
 */
function resolved(path) {
  if (!path) {
    return "";
  }
  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    file.normalize();
    return file.path;
  } catch {
    return path;
  }
}

export const AppLauncher = {
  /**
   * Once per process, from the first window's first script: before then nothing has started
   * the shell service, which DefaultBrowserCheck does once windows are restored.
   *
   * On a package (vimma-open next to the binary), the shell service starts with vimma-open's
   * path, whether Vimma was started through it (it sets the same path) or as `vimma` from a
   * terminal; a value inherited from the caller is replaced, so no program can make Settings
   * register another command as Vimma. The value is then cleared, so programs Vimma starts never
   * inherit it: a Firefox started from one would take vimma-open as itself (bug 1494436).
   * Inside an AppImage, AppRun's value (the .AppImage, which outlives the mount) stands. Without
   * vimma-open (the tarball, a build from source) the shell service keeps Firefox's behaviour.
   *
   * @param {{
   *   platform?: string,
   *   env?: { get(name: string): string, set(name: string, value: string): void },
   *   exeDir?: string,
   *   appDir?: string,
   *   exists?: (path: string) => boolean,
   *   startShellService?: () => void,
   * }} [deps]
   */
  init({ platform, env = Services.env, exeDir, appDir, exists, startShellService } = {}) {
    platform ??= ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs")
      .AppConstants.platform;
    if (platform !== "linux") {
      return;
    }
    exeDir ??= PathUtils.parent(Services.dirsvc.get("XREExeF", Ci.nsIFile).path) ?? "";
    appDir ??= resolved(env.get("APPDIR"));
    if (appDir && (exeDir === appDir || exeDir.startsWith(`${appDir}/`))) {
      return;
    }
    const own = PathUtils.join(exeDir, LAUNCHER);
    if (!(exists ?? isExecutableFile)(own)) {
      return;
    }
    env.set(ENV, own);
    try {
      (
        startShellService ??
        (() => Cc["@mozilla.org/browser/shell-service;1"].getService(Ci.nsIShellService))
      )();
    } catch (e) {
      console.error("Vimma: the shell service did not start", e);
    } finally {
      env.set(ENV, "");
    }
  },
};
