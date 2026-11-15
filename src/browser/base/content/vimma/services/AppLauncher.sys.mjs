/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Which command Firefox's GNOME shell service takes as this browser (#855).

/* global Components -- a system module's global; its component manager tells which services run */

import {
  dataDirs,
  handlersRun,
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

/**
 * What Firefox's GNOME Make Default sets (nsGNOMEShellService.cpp, appProtocols and appTypes), in
 * its order: the schemes, then each type with its file extensions.
 */
const DEFAULT_SCHEMES = ["http", "https", "chrome"];
/** @type {[type: string, extensions: string][]} */
const DEFAULT_TYPES = [
  ["text/html", "htm html shtml"],
  ["application/xhtml+xml", "xhtml xht"],
];

/** The prefs Firefox's Make Default sets afterwards (nsShellService.h). */
const CHECK_PREF = "browser.shell.checkDefaultBrowser";
const CHECK_COUNT_PREF = "browser.shell.defaultBrowserCheckCount";

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
 * @returns {boolean} whether the file exists and can be read, as the shell's `-r` tells
 */
function isReadableFile(path) {
  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    return file.isFile() && file.isReadable();
  } catch {
    return false;
  }
}

/**
 * @param {string} path
 * @returns {string | null} a whole mimeapps.list or desktop entry; "" for one that exists but is
 *   empty or too long, which hides the copies after it as it does for Omarchy's launcher; null
 *   when there is no readable file
 */
function readList(path) {
  if (!isReadableFile(path)) {
    return null;
  }
  const text = readSmallFile(path, MAX_LIST_BYTES + 1);
  return text.length <= MAX_LIST_BYTES ? text : "";
}

/** @returns {nsIGIOService | null} the GIO service, or null where there is none */
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
  const gio = gioService();
  // Under Flatpak each call is a portal round trip, and its handler is never Omarchy's router.
  if (!gio || gio.isRunningUnderFlatpak) {
    return "";
  }
  try {
    const app = gio.getAppForURIScheme(scheme);
    return app instanceof Ci.nsIGIOMimeApp ? app.id : "";
  } catch {
    // nsGIOService throws NS_ERROR_FAILURE when no app handles the scheme.
    return "";
  }
}

/**
 * @param {string} program
 * @param {string} path PATH
 * @returns {string} the file the shell would run for the program: the program itself when it is
 *   an absolute path to an executable file, else the first one by its name in an absolute PATH
 *   dir; "" when there is none
 */
function findIn(program, path) {
  if (program.startsWith("/")) {
    return isExecutableFile(program) ? program : "";
  }
  if (program.includes("/")) {
    return "";
  }
  for (const dir of path.split(":")) {
    if (dir.startsWith("/") && isExecutableFile(PathUtils.join(dir, program))) {
      return PathUtils.join(dir, program);
    }
  }
  return "";
}

/**
 * @param {string} program
 * @param {string} path PATH
 * @returns {boolean} whether the shell would find the program
 */
function resolvesIn(program, path) {
  return findIn(program, path) !== "";
}

/**
 * @param {string} scheme
 * @returns {string} the command line of GIO's default handler, or "" (none, or under Flatpak)
 */
function gioCommandFor(scheme) {
  const gio = gioService();
  if (!gio || gio.isRunningUnderFlatpak) {
    return "";
  }
  try {
    const app = gio.getAppForURIScheme(scheme);
    return app instanceof Ci.nsIGIOMimeApp ? app.command : "";
  } catch {
    return "";
  }
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

/**
 * @param {nsIGIOService | null} gio
 * @param {string} own
 * @returns {nsIGIOMimeApp | null} the first desktop entry GIO lists whose Exec program, found as
 *   the shell finds it, is `own`, as Firefox's own Make Default takes it: usually the package's,
 *   but a user entry in ~/.local/share/applications that runs `own` (extra arguments and all)
 *   comes first, which only a program that could write mimeapps.list itself can place there
 *   (security §11); null under Flatpak, or when there is none
 */
function ownEntry(gio, own) {
  if (!gio || gio.isRunningUnderFlatpak) {
    return null;
  }
  try {
    return gio.findAppFromCommand(own);
  } catch {
    // nsGIOService throws NS_ERROR_NOT_AVAILABLE when no installed entry runs it.
    return null;
  }
}

let done = false;

export const AppLauncher = {
  /**
   * Whether this process's shell service started with vimma-open as its command; false where
   * nothing was set, and when something had started it first (a profile service that makes a
   * dedicated default profile at startup), when Make Default goes through wrapSetDefault.
   */
  startedFirst: false,

  /**
   * The absolute command the shell service takes as this browser, to compare desktop entries
   * with; "" when it is not known (another platform, or a relative MOZ_APP_LAUNCHER, which the
   * shell service looks up in PATH).
   */
  appPath: "",

  /**
   * The package's vimma-open when something started the shell service before Vimma could name
   * it, so the service took another command (the binary, or a value inherited from the caller);
   * "" otherwise. Make Default then sets the package's entry itself, and the default-browser
   * check also counts that entry (wrapSetDefault, handlersRunOwn).
   */
  lateOwn: "",

  /**
   * Who ran init first: "before-ui-startup" (beforeUIStartup), "window" (vimma.js, which only
   * comes first where the category entry is missing), or "" before either.
   *
   * @type {"" | "before-ui-startup" | "window"}
   */
  firstCaller: "",

  /**
   * BrowserGlue's browser-before-ui-startup category (jar.mn), at final-ui-startup: after the
   * profile is chosen but before the command line runs (nsAppRunner.cpp, XRE_mainRun), so before
   * BrowserContentHandler handles `-setDefaultBrowser` with Firefox's Make Default, and before
   * any window. Its arguments (the category's jsGlobal) are ignored.
   *
   * @returns {boolean} init's result
   */
  beforeUIStartup() {
    if (!done) {
      this.firstCaller = "before-ui-startup";
    }
    return this.init();
  },

  /**
   * Once per process, first from beforeUIStartup, then again (a no-op) from the first window's
   * first script: before then only the profile service starts the shell service, which
   * DefaultBrowserCheck otherwise does once windows are restored.
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
      this.firstCaller ||= "window";
      const { started, appPath, own } = start({});
      this.startedFirst = started;
      this.appPath = appPath;
      this.lateOwn = own;
      if (appPath || own) {
        const { ShellService } = ChromeUtils.importESModule(
          "moz-src:///browser/components/shell/ShellService.sys.mjs",
        );
        if (own) {
          this.wrapSetDefault(ShellService, own);
        }
        this.wrapIsDefault(
          ShellService,
          () =>
            (!!appPath && this.isDefaultThroughRouter()) ||
            (!!own &&
              (this.handlersRunOwn({ own }) || this.isDefaultThroughRouter({ appPath: own }))),
        );
      }
    }
    return this.startedFirst;
  },

  /**
   * init's work with test doubles, without keeping its result.
   *
   * @param {StartDeps} deps
   * @returns {{ started: boolean, appPath: string, own: string }}
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
   * Makes Settings' Make Default set the package's own entry, the first one GIO lists whose Exec
   * program is vimma-open's path (ownEntry: a user entry that runs it comes first), as it does when the shell service starts with that path
   * (nsGNOMEShellService::SetDefaultBrowser), for a shell service that started with another
   * command. Without such an entry, under Flatpak, or where a policy forbids Make Default,
   * Firefox's own method runs. Only an explicit request reaches it: Settings' button, the startup prompt's,
   * and `vimma -setDefaultBrowser`.
   *
   * @param {{ setDefaultBrowser: Function, _attemptedSetDefaultThisSession?: boolean }} target
   *   ShellService, whose proxy returns its internal object's methods before the native service's
   * @param {string} own vimma-open's absolute path
   * @param {{
   *   gio?: () => nsIGIOService | null,
   *   allowed?: () => boolean,
   *   setPref?: (name: string, value: boolean | number) => void,
   * }} [deps] for tests; each defaults to the real one
   */
  wrapSetDefault(target, own, deps = {}) {
    const original = target.setDefaultBrowser;
    const gio = deps.gio ?? gioService;
    const allowed = deps.allowed ?? (() => Services.policies.isAllowed("setDefaultBrowser"));
    const setPref =
      deps.setPref ??
      ((/** @type {string} */ name, /** @type {boolean | number} */ value) =>
        typeof value === "boolean"
          ? Services.prefs.setBoolPref(name, value)
          : Services.prefs.setIntPref(name, value));
    target.setDefaultBrowser = async function vimmaSetDefaultBrowser(
      /** @type {unknown[]} */ ...args
    ) {
      const app = allowed() ? ownEntry(gio(), own) : null;
      if (!app) {
        return original.apply(this, args);
      }
      this._attemptedSetDefaultThisSession = true;
      // Each call stands alone, as in Firefox, which ignores their results.
      const each = (/** @type {() => void} */ set) => {
        try {
          set();
        } catch (e) {
          console.error("Vimma: Make Default could not set one association", e);
        }
      };
      for (const scheme of DEFAULT_SCHEMES) {
        each(() => app.setAsDefaultForURIScheme(scheme));
      }
      for (const [type, extensions] of DEFAULT_TYPES) {
        each(() => app.setAsDefaultForMimeType(type));
        each(() => app.setAsDefaultForFileExtensions(extensions));
      }
      setPref(CHECK_PREF, true);
      setPref(CHECK_COUNT_PREF, 0);
      return undefined;
    };
  },

  /**
   * Whether GIO's http and https handlers both run `own`, the package's vimma-open, after a late
   * start (core/default-browser.mjs handlersRun); false when `own` is "".
   *
   * @param {{
   *   own: string,
   *   commandFor?: (scheme: string) => string,
   *   which?: (program: string) => string,
   * }} deps `commandFor` and `which` for tests; each defaults to the real one
   * @returns {boolean}
   */
  handlersRunOwn({ own, commandFor = gioCommandFor, which }) {
    if (!own) {
      return false;
    }
    return handlersRun({
      commandFor,
      which: which ?? ((program) => findIn(program, Services.env.get("PATH"))),
      appPath: own,
    });
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
      // The first readable copy decides, empty or not, as in omarchy-cmd-default-browser.
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
 * @returns {{ started: boolean, appPath: string, own: string }} whether the shell service
 *   started with vimma-open as its command, the command it takes, and vimma-open's path when the
 *   service had started first with another one ("" otherwise)
 */
function start(deps) {
  const { env = Services.env, exists = isExecutableFile, running = shellServiceRunning } = deps;
  const platform =
    deps.platform ??
    ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs").AppConstants.platform;
  if (platform !== "linux") {
    return { started: false, appPath: "", own: "" };
  }
  const exePath = deps.exePath ?? Services.dirsvc.get("XREExeF", Ci.nsIFile).path;
  const exeDir = deps.exeDir ?? PathUtils.parent(exePath) ?? "";
  const own = PathUtils.join(exeDir, LAUNCHER);
  const marker = deps.marker ?? readSmallFile(PathUtils.join(exeDir, MARKER));
  if (APPIMAGE.test(marker) || !exists(own)) {
    return { started: false, appPath: commandFrom(env.get(ENV), exePath), own: "" };
  }
  const late = running();
  const found = env.get(ENV);
  if (late) {
    console.warn(
      "Vimma: the shell service started before Vimma could name its launcher; " +
        "Make Default sets the package's own entry through GIO instead (#855)",
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
  return {
    started: !late,
    appPath: late ? commandFrom(found, exePath) : own,
    own: late ? own : "",
  };
}
