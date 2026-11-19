/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The first-run setup (docs/specs/first-run-setup.md): about:vimma-setup, registered at runtime
// like about:vimma (no upstream patch), and the privileged half of the page: the AMO requests,
// the add-on installs through Firefox's AMO path, the search engines and the config.toml write,
// and for setup v2's Moving in chapter (docs/specs/setup-v2.md) Make Default and the import
// wizard. The page only draws and takes keys; nothing here is reachable from the control socket.

import { ConfigHost } from "../config/ConfigHost.sys.mjs";
import { AppLauncher } from "../services/AppLauncher.sys.mjs";
import { SearchHost } from "../search/SearchHost.sys.mjs";
import { parseConfig, setConfigKeysText } from "../core/config.mjs";
import {
  AMO_API,
  AMO_TIMEOUT_MS,
  amoCuratedUrl,
  amoEntries,
  amoSearchUrl,
  curatedOffline,
} from "../core/setup.mjs";

const lazy =
  /** @type {Lazy<"AddonManager" | "clearTimeout" | "SearchService" | "setTimeout">} */ ({});
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
// Settings hides Make Default while this pref is locked (main.js, isNotDefaultPane).
const DEFAULT_BUTTON_PREF = "pref.general.disable_button.default_browser";
const WIZARD_URL = "chrome://browser/content/migration/migration-dialog-window.html";

/** An nsIAboutModule that is its own nsIFactory, as about:vimma's (AboutVimma.sys.mjs). */
const aboutModule = {
  QueryInterface: ChromeUtils.generateQI(["nsIAboutModule", "nsIFactory"]),
  getURIFlags() {
    return Ci.nsIAboutModule.ALLOW_SCRIPT | Ci.nsIAboutModule.IS_SECURE_CHROME_UI;
  },
  getChromeURI() {
    return Services.io.newURI(PAGE_URL);
  },
  /** @param {nsIURI} uri @param {nsILoadInfo} loadInfo */
  newChannel(uri, loadInfo) {
    const channel = Services.io.newChannelFromURIWithLoadInfo(
      Services.io.newURI(PAGE_URL),
      loadInfo,
    );
    channel.originalURI = uri;
    return channel;
  },
  /** @param {nsIJSIID<unknown>} iid @returns {unknown} */
  createInstance(iid) {
    return aboutModule.QueryInterface(iid);
  },
};

/**
 * Every add-on the page has been shown, by GUID: an install is only ever for one of these, so a
 * page that was tampered with cannot name a file of its own (decision 4).
 * @type {Map<string, import("../core/setup.mjs").AddonEntry>}
 */
const offered = new Map();

/** @param {string} url @returns {Promise<unknown[] | null>} null offline or after 10 s */
async function amoResults(url) {
  /** @type {number | undefined} */
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
  return new Set(addons.map((a) => a.id));
}

/** @param {import("../core/setup.mjs").AddonEntry[]} list */
function remember(list) {
  for (const a of list) if (a.url) offered.set(a.guid, a);
  return list;
}

const amoBase = () => Services.prefs.getStringPref(AMO_PREF, AMO_API);

/** The file the setup edits: config.toml, or the one `vimma.config.path` names (decision 11). */
const configFile = () => ConfigHost.configFile;

/**
 * Firefox's shell service: the proxy whose own object carries AppLauncher's wrappers, so a call
 * here takes the same path as Settings' Make Default.
 */
const shell = () =>
  ChromeUtils.importESModule("moz-src:///browser/components/shell/ShellService.sys.mjs")
    .ShellService;

/**
 * The import wizard open over a setup page's browser, until it closes.
 * @type {WeakMap<MozBrowser, Promise<"closed">>}
 */
const wizards = new WeakMap();

/** @param {unknown} e */
const notFound = (e) => /** @type {Thrown} */ (e)?.name === "NotFoundError";

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
   * @param {BrowserWindow} win
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

  /**
   * @param {string} terms
   * @returns {Promise<{ addons: import("../core/setup.mjs").AddonEntry[], offline: boolean }>}
   */
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
    const visible = (await s.getVisibleEngines()).map((e) => e.name);
    const app = new Set((await s.getAppProvidedEngines()).map((e) => e.name));
    const names = [...visible.filter((n) => app.has(n)), ...visible.filter((n) => !app.has(n))];
    // config.toml's [search] default, found as SearchHost applies it, else Firefox's default.
    const current = SearchHost.configuredDefault(names) ?? (await s.getDefault()).name;
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
    const mac = Services.appinfo.OS === "Darwin";
    // A file that does not load: its first error, with its line.
    const first = parseConfig(text, { mac }).errors[0];
    if (first) {
      return `${path}:${first.line ?? 1}: ${first.path ? `${first.path}: ` : ""}${first.message}`;
    }
    // Else the writer's own check (ConfigHost.setConfigKeys), so that whatever it would refuse
    // after `enter` shows before it.
    const r = setConfigKeysText(text, [{ table: "search", key: "default", value: "x" }], { mac });
    return "error" in r ? `${path}${r.error.slice("config.toml".length)}` : null;
  },

  /**
   * `[search] default = engine` in config.toml, then the reload that applies it (decisions 9,
   * 11), through ConfigHost's one writer (docs/specs/setup-v2.md decision 5): the edit queue, a
   * temporary file with the old mode renamed over the file (or a symlink's target), nothing
   * written when the file does not load, would not with the edit, or changed meanwhile.
   * @param {string} engine
   * @returns {Promise<string | null>} why not, or null once written and applied
   */
  async writeEngine(engine) {
    const why = await ConfigHost.setConfigKeys([
      { table: "search", key: "default", value: engine },
    ]);
    return why === null ? null : `${why}; nothing written`;
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
   * @param {MozBrowser | null} browser  the setup page's browser, which the prompt anchors to.
   *   Without one, "failed": Firefox's permission prompt throws on a null anchor
   *   (ExtensionsUI.sys.mjs getTabBrowser), and the page would stay at "applying".
   * @param {string} guid  one the page was shown
   * @returns {Promise<"installed" | "declined" | "failed">}
   */
  async install(browser, guid) {
    const entry = offered.get(guid);
    if (!entry || !browser) return "failed";
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
   * Whether Vimma is the default browser now, and whether the default browser step may ask to
   * make it so: not where Settings hides its Make Default button (main.js, isNotDefaultPane;
   * DefaultBrowserHelper.canCheck): a policy against it, its locked pref, or Flatpak, which can
   * neither set nor detect the default.
   * @returns {{ isDefault: boolean, canSet: boolean }}
   */
  defaultBrowserState() {
    if (AppLauncher.underFlatpak()) return { isDefault: false, canSet: false };
    let isDefault = false;
    try {
      // forAllTypes, as Settings asks; AppLauncher's wrapper also counts Omarchy's router.
      isDefault = Boolean(shell().isDefaultBrowser(false, true));
    } catch (e) {
      console.error("vimma: setup cannot tell whether Vimma is the default browser", e);
    }
    const canSet =
      Services.policies.isAllowed("setDefaultBrowser") &&
      !Services.prefs.prefIsLocked(DEFAULT_BUTTON_PREF);
    return { isDefault, canSet };
  },

  /**
   * Make Default, as Settings' button asks it (decision 17): Firefox's shell service, which
   * checks the policy again, through AppLauncher's wrapper where a package installed one
   * (security O10, O11). Nothing is asked when Vimma already is the default.
   * @returns {Promise<"default" | "asked" | "unavailable" | "failed">} "asked" when the system
   *   took the request but the check still says another browser is the default
   */
  async setDefaultBrowser() {
    const before = this.defaultBrowserState();
    if (before.isDefault) return "default";
    if (!before.canSet) return "unavailable";
    try {
      await shell().setDefaultBrowser(false);
    } catch (e) {
      console.error("vimma: setup cannot make Vimma the default browser", e);
      return "failed";
    }
    return this.defaultBrowserState().isDefault ? "default" : "asked";
  },

  /**
   * Firefox's import wizard as a dialog over the setup page's tab, as Firefox's tabModal path
   * opens it (MigrationUtils.showMigrationWizard), which gives no close signal of its own; the
   * dialog box's closedPromise does (decision 17). Only over a browser showing the setup page,
   * and never where the profileImport policy forbids it (security P9). A second request while
   * the wizard is open waits for the same dialog. Closing the tab closes the wizard, which
   * resolves it.
   * @param {MozBrowser | null} browser  the setup page's browser
   * @returns {Promise<"closed" | "unavailable">}
   */
  openImportWizard(browser) {
    const open = browser && wizards.get(browser);
    if (open) return open;
    if (!browser || browser.currentURI?.spec !== SETUP_URL) return Promise.resolve("unavailable");
    if (!Services.policies.isAllowed("profileImport")) return Promise.resolve("unavailable");
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      const gBrowser = win.gBrowser;
      if (!gBrowser?.getTabForBrowser(browser)) continue;
      /** @type {Promise<void>} */
      let closedPromise;
      try {
        const { MigrationUtils } = ChromeUtils.importESModule(
          "moz-src:///browser/components/migration/MigrationUtils.sys.mjs",
        );
        ({ closedPromise } = gBrowser.getTabDialogBox(browser).open(
          WIZARD_URL,
          { features: "resizable=no", modalType: Ci.nsIPrompt.MODAL_TYPE_CONTENT },
          {
            options: { entrypoint: MigrationUtils.MIGRATION_ENTRYPOINTS.FILE_MENU, tabModal: true },
          },
        ));
      } catch (e) {
        // A step waiting on the wizard would otherwise never move on.
        console.error("vimma: setup cannot open the import wizard", e);
        return Promise.resolve("unavailable");
      }
      /** @type {Promise<"closed">} */
      const closed = closedPromise.then(() => {
        wizards.delete(browser);
        return "closed";
      });
      wizards.set(browser, closed);
      return closed;
    }
    return Promise.resolve("unavailable");
  },

  /**
   * The <browser> showing `page`. Searched from the windows, because the page's
   * browsingContext.embedderElement is null once a process switch has replaced the context.
   * @param {Window} page  the setup page's window
   * @returns {MozTabBrowser | null}
   */
  browserFor(page) {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      const found = win.gBrowser?.browsers.find((b) => b.contentWindow === page);
      if (found) return found;
    }
    return null;
  },

  /** @param {MozBrowser | null} browser  closes the page's tab */
  close(browser) {
    // Through the window list, as browserFor: the browser's ownerGlobal seen from here has no
    // gBrowser.
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      const gBrowser = win.gBrowser;
      const tab = browser && gBrowser?.getTabForBrowser(browser);
      if (tab) {
        gBrowser.removeTab(tab);
        return;
      }
    }
  },
};
