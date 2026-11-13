/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Instant Omarchy theme reload (spec m5-omarchy-theme, "Instant reload"), on by default and with
// no socket: Omarchy's theme-set hook (vimma-theme-reload.sh, next to this file) sends
// `-vimma-reload-theme` through Firefox's command-line remoting, the D-Bus call a second
// `vimma <args>` makes, and the handler registered here reloads the theme and opens nothing.
// Registered at runtime, once per process, like about:vimma: no upstream patch. The hook itself
// is installed here when Omarchy is found (pref vimma.theme.omarchyHook): ThemeHost looks for
// Omarchy once (docs/specs/theme-appearance.md, A); without it nothing here touches the disk.

const lazy = /** @type {Lazy<"PrivateBrowsingUtils" | "ThemeHost">} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  ThemeHost: "chrome://browser/content/vimma/ui/theme-host.mjs",
});

const FLAG = "vimma-reload-theme";
const CONTRACT = "@vimma.org/omarchy/reload-theme-clh;1";
/** Before "m-browser" (BrowserContentHandler), which would open a window for the line. */
const CATEGORY_ENTRY = "l-vimma-reload-theme";
const HOOK_URL = "chrome://browser/content/vimma/omarchy/vimma-theme-reload.sh";
const HOOK_NAME = "vimma-theme-reload.sh";
const ENABLED_PREF = "vimma.theme.omarchyHook";
/** Set once Vimma wrote the hook: a hook the user then deletes is not written again. */
const INSTALLED_PREF = "vimma.theme.omarchyHookInstalled";
const MARKER =
  "# Written by Vimma (pref vimma.theme.omarchyHook). Edit it and it is yours. sha256:";

/** engine/toolkit/components/commandlines/nsICommandLine.idl, the part used here. */
/** @typedef {{ handleFlag(flag: string, caseSensitive: boolean): boolean, readonly state: number,
 *   preventDefault: boolean }} CommandLine */

const handler = {
  handle(/** @type {CommandLine} */ cmdLine) {
    if (!cmdLine.handleFlag(FLAG, false)) return;
    // Only a line from another process: at first launch there is no theme to refresh yet, and
    // the window the launch opens is what the launch is for.
    if (cmdLine.state === Ci.nsICommandLine.STATE_INITIAL_LAUNCH) return;
    cmdLine.preventDefault = true;
    lazy.ThemeHost.reload().catch((/** @type {unknown} */ e) =>
      console.error("vimma: theme reload failed", e),
    );
  },
  helpInfo: `  --${FLAG}  Make the running Vimma read its Omarchy theme now.\n`,
  QueryInterface: ChromeUtils.generateQI(["nsICommandLineHandler"]),
};

const factory = {
  createInstance(/** @type {unknown} */ iid) {
    return handler.QueryInterface(iid);
  },
  QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
};

let registered = false;

/** @param {string} text */
function sha256(text) {
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
  hash.init(Ci.nsICryptoHash.SHA256);
  const bytes = new TextEncoder().encode(text);
  hash.update(bytes, bytes.length);
  return Array.from(hash.finish(false), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * The file Vimma writes: the hook and a last line with its hash, so an edit shows.
 * @param {string} body
 */
function render(body) {
  return `${body}${body.endsWith("\n") ? "" : "\n"}${MARKER}${sha256(body)}\n`;
}

/**
 * The hook's body if Vimma wrote `text` and nobody edited it since, else null.
 * @param {string} text
 */
function unedited(text) {
  const at = text.lastIndexOf(`\n${MARKER}`);
  if (at < 0) return null;
  const body = text.slice(0, at + 1);
  return render(body) === text ? body : null;
}

/** @param {string} path */
async function readOrNull(path) {
  try {
    return await IOUtils.readUTF8(path);
  } catch (e) {
    if (/** @type {any} */ (e)?.name === "NotFoundError") return null;
    throw e;
  }
}

/**
 * Brings `<home>/.config/omarchy/hooks/theme-set.d/vimma-theme-reload.sh` in line with the pref.
 * omarchy-hook reads `$HOME/.config/omarchy/hooks` (not XDG_CONFIG_HOME); no such directory, no
 * Omarchy. Never touches a file it did not write unedited.
 * @param {string} home
 * @returns {Promise<"no-omarchy" | "installed" | "updated" | "current" | "modified" | "removed"
 *   | "off" | "deleted">}
 */
async function sync(home) {
  const hooks = PathUtils.join(home, ".config", "omarchy", "hooks");
  if (!(await IOUtils.exists(hooks))) return "no-omarchy";
  const dir = PathUtils.join(hooks, "theme-set.d");
  const file = PathUtils.join(dir, HOOK_NAME);
  const current = await readOrNull(file);
  const ours = current === null ? null : unedited(current);
  if (current !== null && ours === null) return "modified";

  if (!Services.prefs.getBoolPref(ENABLED_PREF, true)) {
    Services.prefs.clearUserPref(INSTALLED_PREF);
    if (current === null) return "off";
    await IOUtils.remove(file);
    return "removed";
  }

  const body = await (await fetch(HOOK_URL)).text();
  if (ours === body) return "current";
  if (current === null && Services.prefs.getBoolPref(INSTALLED_PREF, false)) return "deleted";
  await IOUtils.makeDirectory(dir, { createAncestors: false, ignoreExisting: true });
  await IOUtils.writeUTF8(file, render(body), { tmpPath: `${file}.tmp` });
  await IOUtils.setPermissions(file, 0o644, false);
  Services.prefs.setBoolPref(INSTALLED_PREF, true);
  return current === null ? "installed" : "updated";
}

/**
 * `sync`, but only where ThemeHost found Omarchy: elsewhere not even its hooks directory is
 * looked for.
 * @param {string} home
 * @param {boolean} installed  ThemeHost's detection
 */
function syncIfInstalled(home, installed) {
  return installed ? sync(home) : Promise.resolve(/** @type {const} */ ("no-omarchy"));
}

export const OmarchyHook = {
  HOOK_URL,
  render,
  sync,
  syncIfInstalled,

  /** Why startup leaves the user's files alone, or null when it may sync them. */
  get startupBlocked() {
    if (Cu.isInAutomation) return "automation";
    if (lazy.PrivateBrowsingUtils.permanentPrivateBrowsing) return "private";
    return null;
  },

  /** Once per process (vimma.js): the command-line handler, then the hook, off the startup path. */
  init() {
    if (registered) return;
    registered = true;
    const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
    if (!registrar.isContractIDRegistered(CONTRACT)) {
      registrar.registerFactory(
        Components.ID(Services.uuid.generateUUID().toString()),
        "Vimma -vimma-reload-theme",
        CONTRACT,
        factory,
      );
      Services.catMan.addCategoryEntry(
        "command-line-handler",
        CATEGORY_ENTRY,
        CONTRACT,
        false,
        true,
      );
    }
    if (this.startupBlocked) return;
    const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
    const run = () =>
      sync(home).catch((e) => console.warn("vimma: Omarchy theme hook not synced", e));
    lazy.ThemeHost.omarchyDetected.then((/** @type {boolean} */ installed) => {
      if (!installed) return; // syncIfInstalled's rule
      // Live: turning the pref off removes Vimma's unedited hook at once, on writes it again.
      Services.prefs.addObserver(ENABLED_PREF, run);
      run();
    });
  },
};
