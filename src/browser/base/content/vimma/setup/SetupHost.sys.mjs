/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The first-run setup (docs/specs/first-run-setup.md): about:vimma-setup, registered at runtime
// like about:vimma (no upstream patch), and the privileged half of the page: the AMO requests,
// the add-on installs through Firefox's AMO path, the search engines and the config.toml write.
// The page only draws and takes keys; nothing here is reachable from the control socket.

import { ConfigHost } from "../config/ConfigHost.sys.mjs";
import { formatConfigTemplate } from "../core/defaults.mjs";
import { setTomlKeys } from "../core/toml.mjs";
import {
  AMO_API,
  AMO_TIMEOUT_MS,
  amoCuratedUrl,
  amoEntries,
  amoSearchUrl,
  curatedOffline,
} from "../core/setup.mjs";

/** @type {any} */
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  // Firefox 158 has no Services.search; SearchHost.sys.mjs imports the module the same way.
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
});

export const SETUP_URL = "about:vimma-setup";
const PAGE_URL = "chrome://browser/content/vimma/setup/setup.html";
const CONTRACT = "@mozilla.org/network/protocol/about;1?what=vimma-setup";
const OFFERED_PREF = "vimma.setup.offered";
// Tests point AMO at a local server; a user never needs to.
const AMO_PREF = "vimma.setup.amoApi";
const CONFIG_PATH_PREF = "vimma.config.path";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** An nsIAboutModule that is its own nsIFactory, as about:vimma's (AboutVimma.sys.mjs). */
const aboutModule = /** @type {any} */ ({
  QueryInterface: ChromeUtils.generateQI(["nsIAboutModule", "nsIFactory"]),
  getURIFlags() {
    return Ci.nsIAboutModule.ALLOW_SCRIPT | Ci.nsIAboutModule.IS_SECURE_CHROME_UI;
  },
  getChromeURI() {
    return Services.io.newURI(PAGE_URL);
  },
  /** @param {any} uri @param {unknown} loadInfo */
  newChannel(uri, loadInfo) {
    const channel = Services.io.newChannelFromURIWithLoadInfo(
      Services.io.newURI(PAGE_URL),
      loadInfo,
    );
    channel.originalURI = uri;
    return channel;
  },
  /** @param {unknown} iid */
  createInstance(iid) {
    return aboutModule.QueryInterface(iid);
  },
});

/**
 * Every add-on the page has been shown, by GUID: an install is only ever for one of these, so a
 * page that was tampered with cannot name a file of its own (decision 4).
 * @type {Map<string, import("../core/setup.mjs").AddonEntry>}
 */
const offered = new Map();

/** @param {string} url @returns {Promise<unknown[] | null>} null offline or after 10 s */
async function amoResults(url) {
  /** @type {any} */
  let timer;
  const timeout = new Promise((resolve) => {
    timer = lazy.setTimeout(() => resolve(null), AMO_TIMEOUT_MS);
  });
  const request = fetch(url, { credentials: "omit", cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (Array.isArray(j?.results) ? j.results : null))
    .catch(() => null);
  try {
    return /** @type {unknown[] | null} */ (await Promise.race([request, timeout]));
  } finally {
    lazy.clearTimeout(timer);
  }
}

async function installedIds() {
  const addons = await lazy.AddonManager.getAddonsByTypes(["extension"]);
  return new Set(addons.map((/** @type {any} */ a) => a.id));
}

/** @param {import("../core/setup.mjs").AddonEntry[]} list */
function remember(list) {
  for (const a of list) if (a.url) offered.set(a.guid, a);
  return list;
}

const amoBase = () => Services.prefs.getStringPref(AMO_PREF, AMO_API);

/** The file the setup edits: config.toml, or the one `vimma.config.path` names (decision 11). */
const configFile = () => ConfigHost.configFile;

/** @param {unknown} e */
const notFound = (e) => /** @type {any} */ (e)?.name === "NotFoundError";

export const SetupHost = {
  /** Once per process (vimma.js): about:vimma-setup resolves from then on. */
  register() {
    const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
    if (registrar.isContractIDRegistered(CONTRACT)) return;
    registrar.registerFactory(
      Components.ID(Services.uuid.generateUUID().toString()),
      SETUP_URL,
      CONTRACT,
      aboutModule,
    );
  },

  /**
   * Why startup does not offer the setup, or null when it may (decision 1): another config file
   * is in force, a test harness runs the browser, or the profile was offered it already.
   * @returns {"path" | "automation" | "done" | null}
   */
  get offerBlocked() {
    if (Services.prefs.getStringPref(CONFIG_PATH_PREF, "")) return "path";
    if (Cu.isInAutomation) return "automation";
    if (Services.prefs.getBoolPref(OFFERED_PREF, false)) return "done";
    return null;
  },

  /**
   * Opens the welcome screen in front, once per profile. The pref is set before the page
   * loads, so a crash or a closed window never shows it twice.
   * @param {any} win
   * @returns {boolean} whether it opened
   */
  offer(win) {
    if (Services.prefs.getBoolPref(OFFERED_PREF, false)) return false;
    Services.prefs.setBoolPref(OFFERED_PREF, true);
    // Firefox writes a changed pref about 500 ms later (Preferences::HandleDirty in
    // modules/libpref/Preferences.cpp); a crash in that window would offer the setup again.
    Services.prefs.savePrefFile(null);
    const tab = win.gBrowser.addTrustedTab(SETUP_URL);
    win.gBrowser.selectedTab = tab;
    return true;
  },

  /** The curated list (decision 13): AMO's current files, or the offline list. */
  async curated() {
    const installed = await installedIds();
    const results = await amoResults(amoCuratedUrl(amoBase()));
    if (!results) return { addons: curatedOffline(installed), offline: true };
    const addons = amoEntries(results, { curated: true, installed });
    return { addons: remember(addons.length ? addons : curatedOffline(installed)), offline: false };
  },

  /** @param {string} terms @returns {Promise<{ addons: any[], offline: boolean }>} */
  async search(terms) {
    const results = await amoResults(amoSearchUrl(terms, amoBase()));
    if (!results) return { addons: [], offline: true };
    return {
      addons: remember(amoEntries(results, { installed: await installedIds() })),
      offline: false,
    };
  },

  /** The visible engines, app-provided first (decision 5), and the current default. */
  async engines() {
    const s = lazy.SearchService;
    await s.init();
    const visible = (await s.getVisibleEngines()).map((/** @type {any} */ e) => e.name);
    const app = new Set((await s.getAppProvidedEngines()).map((/** @type {any} */ e) => e.name));
    const names = [
      ...visible.filter((/** @type {string} */ n) => app.has(n)),
      ...visible.filter((/** @type {string} */ n) => !app.has(n)),
    ];
    const fromFile = /** @type {any} */ (ConfigHost.config)?.search?.default;
    const current = names.includes(fromFile) ? fromFile : (await s.getDefault()).name;
    return { names, current };
  },

  /** The notice the summary shows when config.toml cannot take the edit, or null. */
  async configProblem() {
    const path = configFile();
    let text;
    try {
      text = await IOUtils.readUTF8(path);
    } catch (e) {
      return notFound(e) ? null : `cannot read ${path}`;
    }
    const r = setTomlKeys(text, [{ table: "search", key: "default", value: "x" }]);
    return r.ok ? null : `${path}:${r.error.line}: ${r.error.message}`;
  },

  /**
   * `[search] default = engine` in config.toml, then the reload that applies it (decisions 9,
   * 11): atomic through a 0600 temporary file renamed over the old one, the old mode kept,
   * nothing written on a parse error or when the file changed since it was read.
   * @param {string} engine
   * @returns {Promise<string | null>} why not, or null once written and applied
   */
  async writeEngine(engine) {
    const path = configFile();
    /** @type {string | null} */
    let text = null;
    /** @type {any} */
    let before = null;
    try {
      before = await IOUtils.stat(path);
      text = await IOUtils.readUTF8(path);
    } catch (e) {
      if (!notFound(e)) return `cannot read ${path}`;
    }
    const r = setTomlKeys(text ?? formatConfigTemplate(), [
      { table: "search", key: "default", value: engine },
    ]);
    if (!r.ok) return `${path}:${r.error.line}: ${r.error.message}; nothing written`;
    const dir = PathUtils.parent(path) ?? "/";
    const tmp = PathUtils.join(
      dir,
      `.config.toml.${Services.uuid.generateUUID().toString().slice(1, 9)}`,
    );
    try {
      if (!(await IOUtils.exists(dir))) {
        await IOUtils.makeDirectory(dir, { createAncestors: true, permissions: DIR_MODE });
      }
      await IOUtils.writeUTF8(tmp, r.text, { mode: "create" });
      await IOUtils.setPermissions(tmp, before ? before.permissions : FILE_MODE, false);
      const now = await IOUtils.stat(path).catch(() => null);
      if ((now?.lastModified ?? null) !== (before?.lastModified ?? null)) {
        await IOUtils.remove(tmp);
        return `${path} changed while the setup ran; nothing written`;
      }
      await IOUtils.move(tmp, path);
    } catch (e) {
      console.error(`vimma: setup cannot write ${path}`, e);
      await IOUtils.remove(tmp, { ignoreAbsent: true }).catch(() => {});
      return `cannot write ${path}`;
    }
    await ConfigHost.reload();
    return null;
  },

  /**
   * The AddonInstall for an offered entry: AMO's file, checked against AMO's hash. Separate so
   * that tests can supply a local XPI, because AddonManager's own methods are read-only.
   * @param {import("../core/setup.mjs").AddonEntry} entry
   */
  installFor(entry) {
    return lazy.AddonManager.getInstallForURL(entry.url, { hash: entry.hash, name: entry.name });
  },

  /**
   * One add-on through Firefox's AMO path (decision 3): signature checks, enterprise policy and
   * the standard permission prompt are Firefox's own; Vimma never answers the prompt.
   * @param {any} browser  the setup page's browser, which the prompt anchors to
   * @param {string} guid  one the page was shown
   * @returns {Promise<"installed" | "declined" | "failed">}
   */
  async install(browser, guid) {
    const entry = offered.get(guid);
    if (!entry) return "failed";
    const AM = lazy.AddonManager;
    const install = await this.installFor(entry);
    return new Promise((resolve) => {
      /** @param {"installed" | "declined" | "failed"} r */
      const done = (r) => {
        install.removeListener(listener);
        resolve(r);
      };
      const listener = {
        onInstallEnded: () => done("installed"),
        onInstallCancelled: () => done("declined"),
        onDownloadCancelled: () => done("declined"),
        onInstallFailed: () => done("failed"),
        onDownloadFailed: () => done("failed"),
      };
      install.addListener(listener);
      AM.installAddonFromAOM(browser, Services.io.newURI(SETUP_URL), install);
    });
  },

  /**
   * The <browser> showing `page`. Searched from the windows, because the page's
   * browsingContext.embedderElement is null once a process switch has replaced the context.
   * @param {any} page  the setup page's window
   */
  browserFor(page) {
    for (const win of /** @type {any} */ (Services.wm).getEnumerator("navigator:browser")) {
      const found = /** @type {any} */ (win).gBrowser?.browsers.find(
        (/** @type {any} */ b) => b.contentWindow === page,
      );
      if (found) return found;
    }
    return null;
  },

  /** @param {any} browser  closes the page's tab */
  close(browser) {
    // Through the window list, as browserFor: the browser's ownerGlobal seen from here has no
    // gBrowser.
    for (const win of /** @type {any} */ (Services.wm).getEnumerator("navigator:browser")) {
      const gBrowser = /** @type {any} */ (win).gBrowser;
      const tab = gBrowser?.getTabForBrowser(browser);
      if (tab) {
        gBrowser.removeTab(tab);
        return;
      }
    }
  },
};
