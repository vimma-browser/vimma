/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Which command Firefox's GNOME shell service takes as this browser (#855).

/* global Components -- a system module's global; its component manager tells which services run */

/**
 * nsGNOMEShellService::Init reads it once, as the browser's own command, else takes the binary's
 * path. Make Default then sets the installed desktop entry whose Exec program is that exact path
 * (nsGIOService::FindAppFromCommand), or writes a userapp- entry for it, and IsDefaultBrowser
 * counts only a handler whose program is that path. Firefox reads it for XSMP session restore
 * too, which falls back to the binary when it is empty, as the shell service does.
 */
const ENV = "MOZ_APP_LAUNCHER";

/**
 * The packages install it next to the binary, and their desktop entry's Exec names it by that
 * path (tools/package/package.mjs), so links from other apps keep going through it to routing.
 */
const LAUNCHER = "vimma-open";

/** How the package was installed (tools/package/package.mjs, PACKAGED_APP_FILE). */
const MARKER = "is-packaged-app";
const APPIMAGE = /^vimma-package=appimage\s*$/m;

const SHELL_SERVICE = "@mozilla.org/browser/shell-service;1";

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
 * @returns {string} the start of the file, or "" when it cannot be read
 */
function readSmallFile(path) {
  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    const stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(
      Ci.nsIFileInputStream,
    );
    stream.init(file, -1, -1, 0);
    try {
      const scriptable = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
        Ci.nsIScriptableInputStream,
      );
      scriptable.init(stream);
      return scriptable.read(256);
    } finally {
      stream.close();
    }
  } catch {
    return "";
  }
}

/** @returns {boolean} whether something has already started the shell service */
function shellServiceRunning() {
  return Components.manager
    .QueryInterface(Ci.nsIServiceManager)
    .isServiceInstantiatedByContractID(SHELL_SERVICE, Ci.nsISupports);
}

let done = false;

export const AppLauncher = {
  /**
   * Whether this process's shell service started with vimma-open as its command; false where
   * nothing was set, and when something had started it first (a profile service that makes a
   * dedicated default profile at startup, `vimma -setDefaultBrowser`), which keeps Firefox's
   * behaviour for that session.
   */
  startedFirst: false,

  /**
   * Once per process, from the first window's first script: before then only those two cases
   * start the shell service, which DefaultBrowserCheck otherwise does once windows are restored.
   *
   * On a package (vimma-open next to the binary), the shell service starts with vimma-open's
   * path, however Vimma was started (its desktop entry, or `vimma` from a terminal); a value
   * inherited from the caller is replaced, so no program can make Settings register another
   * command as Vimma. The value is then set to empty, so programs Vimma starts never inherit it:
   * a Firefox started from one would take vimma-open as itself (bug 1494436). An AppImage, by
   * its package marker, keeps AppRun's value (the .AppImage, which outlives the mount). Without
   * vimma-open (the tarball, a build from source) the shell service keeps Firefox's behaviour.
   *
   * @param {{
   *   platform?: string,
   *   env?: { get(name: string): string, set(name: string, value: string): void },
   *   exeDir?: string,
   *   exists?: (path: string) => boolean,
   *   marker?: string,
   *   running?: () => boolean,
   *   startShellService?: () => void,
   * }} [deps] for tests; each defaults to the real one, and passing any runs init again
   * @returns {boolean} whether the shell service started with vimma-open as its command
   */
  init(deps) {
    if (deps) {
      return start(deps);
    }
    if (!done) {
      done = true;
      this.startedFirst = start({});
    }
    return this.startedFirst;
  },
};

/**
 * @param {Parameters<typeof AppLauncher.init>[0] & {}} deps
 * @returns {boolean} whether the shell service started with vimma-open as its command
 */
function start(deps) {
  const { env = Services.env, exists = isExecutableFile, running = shellServiceRunning } = deps;
  const platform =
    deps.platform ??
    ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs").AppConstants.platform;
  if (platform !== "linux") {
    return false;
  }
  const exeDir =
    deps.exeDir ?? PathUtils.parent(Services.dirsvc.get("XREExeF", Ci.nsIFile).path) ?? "";
  const own = PathUtils.join(exeDir, LAUNCHER);
  const marker = deps.marker ?? readSmallFile(PathUtils.join(exeDir, MARKER));
  if (APPIMAGE.test(marker) || !exists(own)) {
    return false;
  }
  const late = running();
  if (late) {
    console.warn(
      "Vimma: the shell service started before Vimma could name its launcher; " +
        "Settings' Make Default keeps Firefox's behaviour until the next start (#855)",
    );
  } else {
    env.set(ENV, own);
    try {
      (deps.startShellService ?? (() => Cc[SHELL_SERVICE].getService(Ci.nsIShellService)))();
    } catch (e) {
      console.error("Vimma: the shell service did not start", e);
    }
  }
  env.set(ENV, "");
  return !late;
}
