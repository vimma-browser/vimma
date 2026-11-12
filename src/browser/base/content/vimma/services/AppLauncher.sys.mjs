/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Which command Firefox's GNOME shell service takes as this browser (#855).

/* global Components -- a system module's global; its component manager tells which services run */

import {
  dataDirs,
  isDefaultThroughRouter,
  mimeappsLists,
  OMARCHY_ROUTER,
} from "../core/default-browser.mjs";

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
const GIO_SERVICE = "@mozilla.org/gio-service;1";

/** A mimeapps.list longer than this is not read: the check then keeps Firefox's answer. */
const MAX_LIST_BYTES = 64 * 1024;

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
 * @param {number} [max]
 * @returns {string} the start of the file, or "" when it cannot be read
 */
function readSmallFile(path, max = 256) {
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
      return scriptable.read(max);
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

/**
 * @param {string} path
 * @returns {string | null} a whole mimeapps.list or desktop entry, or null when it is missing or
 *   too long
 */
function readList(path) {
  const text = readSmallFile(path, MAX_LIST_BYTES + 1);
  return text && text.length <= MAX_LIST_BYTES ? text : null;
}

/** @returns {any} the GIO service, or null where there is none */
function gioService() {
  try {
    return Cc[GIO_SERVICE]?.getService(Ci.nsIGIOService) ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {string} scheme
 * @returns {string} the id of GIO's default handler, or "" (none, or a Flatpak portal handler)
 */
function gioDefaultFor(scheme) {
  const app = gioService()?.getAppForURIScheme(scheme);
  return app instanceof Ci.nsIGIOMimeApp ? app.id : "";
}

/**
 * @param {string} program
 * @param {string} path PATH
 * @returns {boolean} whether the shell would find the program: an executable file by its absolute
 *   path, or by its name in an absolute PATH dir
 */
function resolvesIn(program, path) {
  if (program.startsWith("/")) {
    return isExecutableFile(program);
  }
  if (program.includes("/")) {
    return false;
  }
  return path
    .split(":")
    .some((dir) => dir.startsWith("/") && isExecutableFile(PathUtils.join(dir, program)));
}

/**
 * Firefox's isDefaultBrowser answer, or true when isDefaultThroughRouter() says so; the original
 * always runs first, for the side effect of its startup check (ShellService._checkedThisSession).
 * A failure in the second look is a no, which is Firefox's answer.
 *
 * @param {() => boolean} check
 * @returns {boolean}
 */
function safely(check) {
  try {
    return check();
  } catch (e) {
    console.error("Vimma: the default-browser check through Omarchy's router failed", e);
    return false;
  }
}

/**
 * @typedef {{
 *   platform?: string,
 *   env?: { get(name: string): string, set(name: string, value: string): void },
 *   exePath?: string,
 *   exeDir?: string,
 *   exists?: (path: string) => boolean,
 *   marker?: string,
 *   running?: () => boolean,
 *   startShellService?: () => void,
 * }} StartDeps
 */

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
   * The absolute command the shell service takes as this browser, to compare desktop entries
   * with; "" when it is not known (another platform, or a relative MOZ_APP_LAUNCHER, which the
   * shell service looks up in PATH).
   */
  appPath: "",

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
   * @param {StartDeps} [deps] for tests; each defaults to the real one, and passing any runs init again
   * @returns {boolean} whether the shell service started with vimma-open as its command
   */
  init(deps) {
    if (deps) {
      return start(deps).started;
    }
    if (!done) {
      done = true;
      const { started, appPath } = start({});
      this.startedFirst = started;
      this.appPath = appPath;
      if (appPath) {
        const { ShellService } = ChromeUtils.importESModule(
          "moz-src:///browser/components/shell/ShellService.sys.mjs",
        );
        this.wrapIsDefault(ShellService, () => this.isDefaultThroughRouter());
      }
    }
    return this.startedFirst;
  },

  /**
   * init's work with test doubles, without keeping its result.
   *
   * @param {StartDeps} deps
   * @returns {{ started: boolean, appPath: string }}
   */
  probe(deps) {
    return start(deps);
  },

  /**
   * Makes Settings and the startup prompt count Vimma as the default when Omarchy's router opens
   * it (core/default-browser.mjs). Replaces the two methods on ShellService's internal object,
   * which its proxy returns before the native service's; everything that asks (Settings'
   * DefaultBrowserHelper, DefaultBrowserCheck, BrowserGlue) goes through them.
   *
   * @param {{ isDefaultBrowser: Function, isDefaultBrowserAsync: Function }} target
   * @param {() => boolean} check
   */
  wrapIsDefault(target, check) {
    const isDefault = target.isDefaultBrowser;
    const isDefaultAsync = target.isDefaultBrowserAsync;
    target.isDefaultBrowser = function vimmaIsDefaultBrowser(/** @type {unknown[]} */ ...args) {
      return Boolean(isDefault.apply(this, args)) || safely(check);
    };
    target.isDefaultBrowserAsync = async function vimmaIsDefaultBrowserAsync(
      /** @type {unknown[]} */ ...args
    ) {
      return Boolean(await isDefaultAsync.apply(this, args)) || safely(check);
    };
  },

  /**
   * Whether GIO's http and https handler is Omarchy's router and the router opens Vimma's own
   * entry (core/default-browser.mjs). Reads nothing unless GIO names the router.
   *
   * @param {{
   *   env?: { get(name: string): string },
   *   appPath?: string,
   *   readFile?: (path: string) => string | null,
   *   defaultFor?: (scheme: string) => string,
   *   resolves?: (program: string) => boolean,
   * }} [deps] for tests; each defaults to the real one
   * @returns {boolean}
   */
  isDefaultThroughRouter(deps = {}) {
    const defaultFor = deps.defaultFor ?? gioDefaultFor;
    if (defaultFor("http") !== OMARCHY_ROUTER) {
      return false;
    }
    const env = deps.env ?? Services.env;
    const readFile = deps.readFile ?? readList;
    const dirs = dataDirs({
      home: env.get("HOME"),
      dataHome: env.get("XDG_DATA_HOME"),
      dataDirs: env.get("XDG_DATA_DIRS"),
    });
    const lists = mimeappsLists({
      home: env.get("HOME"),
      configHome: env.get("XDG_CONFIG_HOME"),
      configDirs: env.get("XDG_CONFIG_DIRS"),
      currentDesktop: env.get("XDG_CURRENT_DESKTOP"),
    }).map(readFile);
    return isDefaultThroughRouter({
      defaultFor,
      lists,
      entryFor: (id) => {
        for (const dir of dirs) {
          const text = readFile(PathUtils.join(dir, "applications", id));
          if (text !== null) {
            return text;
          }
        }
        return null;
      },
      resolves: deps.resolves ?? ((program) => resolvesIn(program, env.get("PATH"))),
      appPath: deps.appPath ?? this.appPath,
    });
  },
};

/**
 * @param {string} value MOZ_APP_LAUNCHER as the shell service finds it
 * @param {string} exePath
 * @returns {string} the command the shell service takes from it (GetAppPathFromLauncher, else the
 *   binary); "" for a relative value, which it looks up in PATH
 */
function commandFrom(value, exePath) {
  if (!value) {
    return exePath;
  }
  return value.startsWith("/") ? value : "";
}

/**
 * @param {StartDeps} deps
 * @returns {{ started: boolean, appPath: string }} whether the shell service started with
 *   vimma-open as its command, and the command it takes
 */
function start(deps) {
  const { env = Services.env, exists = isExecutableFile, running = shellServiceRunning } = deps;
  const platform =
    deps.platform ??
    ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs").AppConstants.platform;
  if (platform !== "linux") {
    return { started: false, appPath: "" };
  }
  const exePath = deps.exePath ?? Services.dirsvc.get("XREExeF", Ci.nsIFile).path;
  const exeDir = deps.exeDir ?? PathUtils.parent(exePath) ?? "";
  const own = PathUtils.join(exeDir, LAUNCHER);
  const marker = deps.marker ?? readSmallFile(PathUtils.join(exeDir, MARKER));
  if (APPIMAGE.test(marker) || !exists(own)) {
    return { started: false, appPath: commandFrom(env.get(ENV), exePath) };
  }
  const late = running();
  const found = env.get(ENV);
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
  return { started: !late, appPath: late ? commandFrom(found, exePath) : own };
}
