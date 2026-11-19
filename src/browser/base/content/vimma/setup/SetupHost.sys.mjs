/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The first-run setup (docs/specs/first-run-setup.md): about:vimma-setup, registered at runtime
// like about:vimma (no upstream patch), and the privileged half of the page: the AMO requests,
// the add-on installs through Firefox's AMO path, the search engines, the config.toml writes,
// and for the Moving in chapter (docs/specs/setup-v2.md) Make Default and the import wizard. The
// page only draws and takes keys; nothing here is reachable from the control socket. Each
// setting step saves on its own `enter`: the page names a step and a choice index, never a key
// or a value (setup-v2 decision 7).

import { CONFIG_READ_TOPIC, ConfigHost } from "../config/ConfigHost.sys.mjs";
import { AppLauncher } from "../services/AppLauncher.sys.mjs";
import { SearchHost } from "../search/SearchHost.sys.mjs";
import { ThemeHost } from "../ui/theme-host.mjs";
import { parseConfig, setConfigKeysText } from "../core/config.mjs";
import {
  AMO_API,
  AMO_TIMEOUT_MS,
  BUILT_STEPS,
  amoCuratedUrl,
  amoEntries,
  amoSearchUrl,
  curatedOffline,
} from "../core/setup.mjs";
import {
  CHAPTERS,
  STEPS,
  editLines,
  fillStepText,
  inForceOf,
  planAtEnter,
  planChoice,
  stepChoices,
  textParts,
  windowSketch,
} from "../core/setup-steps.mjs";

/** @import { SetupChoice, SetupRuntime } from "../core/setup-steps.mjs" */

const lazy =
  /** @type {Lazy<"AddonManager" | "clearTimeout" | "PrivateBrowsingUtils" | "SearchService" | "setTimeout">} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
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
/** The chapters whose stop screen was reached, comma-separated (decision 19). */
const CHAPTERS_PREF = "vimma.setup.chapters";
/** What `:theme` remembered, in force without `[theme] appearance` (theme-appearance B4). */
const APPEARANCE_PREF = "vimma.theme.appearance";
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

/**
 * The choices each setup page was sent, by step, with the serial of that list (decision 7):
 * `enter` names an index into the list that page was shown and that list's serial, so a list
 * drawn again meanwhile (a config read, a visit with `h`) never shifts what an index means: an
 * older serial is refused as stale.
 * @type {WeakMap<MozBrowser, Map<string, { serial: number, choices: SetupChoice[] }>>}
 */
const sent = new WeakMap();
/** The serial of the next list sent. */
let nextSerial = 1;

/** @param {MozBrowser} browser */
function sentTo(browser) {
  let m = sent.get(browser);
  if (!m) sent.set(browser, (m = new Map()));
  return m;
}

/**
 * A private window's page saves nothing (behaviour 15), and neither does a page whose window
 * is not found. Through the window list, as close(): ownerGlobal reads undefined from here.
 * @param {MozBrowser | null} browser
 */
function isPrivate(browser) {
  if (!browser) return true;
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (win.gBrowser?.browsers.includes(/** @type {MozTabBrowser} */ (browser))) {
      return lazy.PrivateBrowsingUtils.isWindowPrivate(win);
    }
  }
  return true;
}

/** A step of setup v2 the page draws so far (BUILT_STEPS), or undefined. @param {string} id */
const builtStep = (id) => (BUILT_STEPS.includes(id) ? STEPS.find((s) => s.id === id) : undefined);

/** @returns {Promise<SetupRuntime>} what the file leaves to Firefox and `:theme` */
async function runtime() {
  const s = lazy.SearchService;
  await s.init();
  const pref = Services.prefs.prefHasUserValue(APPEARANCE_PREF)
    ? Services.prefs.getStringPref(APPEARANCE_PREF, "")
    : "";
  return {
    engine: (await s.getDefault()).name,
    engines: (await s.getVisibleEngines()).map((e) => e.name),
    ...(["dark", "light", "system"].includes(pref) ? { appearance: pref } : {}),
  };
}

/**
 * The values in force for `text`, the file now (null: missing, the defaults): its own when it
 * loads, else the config in force, which the broken file did not replace.
 * @param {string | null} text @param {SetupRuntime} rt
 */
function inForceFor(text, rt) {
  const parsed = parseConfig(text ?? "", { mac: Services.appinfo.OS === "Darwin" });
  const config = parsed.errors.length ? ConfigHost.config : parsed.config;
  return config ? inForceOf(config, rt) : {};
}

async function readConfigText() {
  try {
    return await IOUtils.readUTF8(configFile());
  } catch (e) {
    if (notFound(e)) return null;
    throw e;
  }
}

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

  /**
   * The notice the welcome screen and the setting steps show when config.toml cannot take an
   * edit, or null.
   */
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

  /** Notified after every read of config.toml (behaviour 12: a step draws its line again). */
  CONFIG_READ_TOPIC,

  /**
   * What setup v2's welcome screen needs (behaviours 2 and 13, decision 19): the chapters
   * finished before, whether this is a private window, and the parse error, if any.
   * @param {MozBrowser | null} browser  the page's
   */
  async flowStart(browser) {
    const finished = Services.prefs
      .getStringPref(CHAPTERS_PREF, "")
      .split(",")
      .filter((id) => CHAPTERS.some((c) => c.id === id));
    return { finished, private: isPrivate(browser), problem: await this.configProblem() };
  },

  /**
   * Records a chapter whose stop screen was reached, outside a private window (decision 19).
   * @param {MozBrowser | null} browser @param {string} id
   */
  finishChapter(browser, id) {
    if (isPrivate(browser) || !CHAPTERS.some((c) => c.id === id)) return;
    const list = Services.prefs.getStringPref(CHAPTERS_PREF, "").split(",").filter(Boolean);
    if (list.includes(id)) return;
    Services.prefs.setStringPref(CHAPTERS_PREF, [...list, id].join(","));
  },

  /**
   * One step as the page draws it, with the value in force selected (behaviour 9), each
   * choice's line (behaviour 12), and why it cannot save here (behaviours 13 and 15). The
   * choices are remembered for that page's `enter` (decision 7).
   * @param {MozBrowser | null} browser @param {string} id
   */
  async stepView(browser, id) {
    const step = builtStep(id);
    if (!step || !browser) return null;
    // The list this page had for the step is gone until the new one is sent.
    sentTo(browser).delete(id);
    const rt = await runtime();
    const text = await readConfigText().catch(() => null);
    const inForce = inForceFor(text, rt);
    const engines = step.id === "search_engine" ? (await this.engines()).names : [];
    const omarchy = step.id === "colours" ? await ThemeHost.omarchyFound() : false;
    const { choices, selected } = stepChoices(step, inForce, { engines, omarchy });
    const serial = nextSerial++;
    sentTo(browser).set(id, { serial, choices });
    /** @type {string | null} */
    let blocked = null;
    if (step.kind === "setting") {
      const problem = await this.configProblem();
      if (isPrivate(browser)) blocked = "A private window saves nothing to config.toml.";
      else if (problem) blocked = `${problem}. config.toml is not written until it loads.`;
    }
    const keymap = ConfigHost.keymap;
    return {
      id,
      kind: step.kind,
      title: step.title,
      question: step.question,
      text: textParts(keymap ? fillStepText(step, keymap) : step.text),
      choices: choices.map((c) => ({
        label: c.label,
        keep: !!c.keep,
        lines: editLines(planChoice(c, inForce)),
        // The window this choice leaves, for the step's drawing; null outside chapter 3.
        window: windowSketch(step, c, inForce),
      })),
      selected,
      blocked,
      serial,
    };
  },

  /**
   * `enter` on a setting step (behaviours 4, 8, 14, 16; decisions 4 and 7): the choice at
   * `index` of the list this page was sent, planned again against config.toml as it is now,
   * inside the one edit queue, and written only where it changes the value in force. The search
   * engine must still be installed (behaviour 20). Stale, with nothing written, when `serial`
   * is not the list the host sent last, or the choice is no longer offered at `enter`.
   * @param {MozBrowser | null} browser @param {string} id @param {number} index
   * @param {number} [serial]  the serial of the list the page drew (stepView)
   * @returns {Promise<{ written: string[] } | { error: string } | { stale: true }>}
   */
  async saveStep(browser, id, index, serial) {
    const step = builtStep(id);
    if (!step || step.kind !== "setting" || !browser) return { error: "not a step that saves" };
    if (isPrivate(browser)) return { error: "a private window saves nothing" };
    const list = sent.get(browser)?.get(id);
    const choice = Number.isInteger(index) && index >= 0 ? list?.choices[index] : undefined;
    if (!list || !choice) return { error: "no such choice" };
    if (serial !== list.serial) return { stale: true };
    if (step.id === "search_engine" && !choice.keep) {
      const name = choice.edits[0]?.value;
      if (!(await this.engines()).names.includes(String(name))) return { stale: true };
    }
    const rt = await runtime();
    const omarchy = await ThemeHost.omarchyFound();
    /** @type {import("../core/toml.mjs").TomlEdit[] | null} */
    let written = [];
    const why = await ConfigHost.setConfigKeys((text) => {
      const parsed = parseConfig(text ?? "", { mac: Services.appinfo.OS === "Darwin" });
      if (!parsed.config || parsed.errors.length) {
        return { error: "config.toml does not load; fix it first (:config shows it)" };
      }
      written = planAtEnter(step, choice, inForceOf(parsed.config, rt), { omarchy });
      return written ?? [];
    });
    if (why !== null) return { error: why };
    if (written === null) return { stale: true };
    return { written: written.length ? editLines(written) : [] };
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
