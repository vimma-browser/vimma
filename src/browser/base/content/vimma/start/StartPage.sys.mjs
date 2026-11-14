/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The start page (spec: docs/specs/start-page.md). The home page is a default pref
// (browser.startup.homepage, in firefox-branding.js); the new-tab URL lives only in memory
// (AboutNewTab.newTabURL), so it is set here, once per app, while vimma.startpage.newtab is on.
// Firefox treats a chrome:// page as a blank new tab the same way it treats its own
// chrome://browser/content/blanktab.html (AboutNewTabRedirector): it loads in the parent
// process, and the URL bar stays empty because it is BROWSER_NEW_TAB_URL (isInitialPage,
// isBlankPageURL).

const lazy = /** @type {Lazy<"AboutNewTab">} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  AboutNewTab: "resource:///modules/AboutNewTab.sys.mjs",
});

export const START_PAGE_URL = "chrome://browser/content/vimma/start/start.html";
const NEWTAB_PREF = "vimma.startpage.newtab";
const NEWTAB_TOPIC = "newtab-url-changed";

let started = false;

// Firefox's own start pages, which a user can still type (docs/specs/firefox-surfaces-trim.md,
// decision 10). about:firefoxview stays: it is Tab Overview, a page of its own. None of them is
// linkable from a web page (AboutRedirector.cpp and AboutNewTabRedirector.sys.mjs give them no
// MAKE_LINKABLE flag), so only the user, Vimma or Firefox's own code starts these loads.
const FIREFOX_START = ["home", "newtab", "welcome"];

// Whether Firefox's own page may still live in a content process. Firefox's pages load in the
// privilegedabout process, and the parent checks each principal that process sends against the
// about: module's flags as they are when the message arrives (ProcessIsolation.cpp,
// ValidatePrincipalCouldPotentiallyBeLoadedBy). The start page's flags say "parent process", so
// with them the parent kills the process over the next message from Firefox's page, such as a
// blob URL registration, and every tab in it crashes (#950). Set when Firefox's page is handed
// out; cleared only when the last privilegedabout process that ran ends while none of Firefox's
// channels is still loading. Firefox keeps one alive (dom.ipc.keepProcessesAlive.privilegedabout),
// so in practice it stays set until the next start. Staying set too long only shows Firefox's
// page; clearing too early brings the kill back, so nothing else clears it: getAllDOMProcesses
// leaves out a process that is still launching.
let firefoxServed = false;

// Firefox's channels handed out and not yet finished. A page's channel is pending from the moment
// it is handed out until its content process is alive and noted below: the parent opens a
// document channel as it creates it (DocumentLoadListener::Open), suspends it while it picks and
// launches the process (OnStartRequest), and lets it finish only once that process is alive
// (ContentParent::Init sends ipc:content-created before the launch resolves). A page whose process
// is still launching, or not yet picked, when the last privilegedabout process ends is in neither
// aboutIDs nor getAllDOMProcesses, so its channel keeps firefoxServed set (#984). Finished
// channels are dropped, so a page that has reached its process holds nothing. Firefox's wrapper
// for the loads it holds until its newtab add-on starts (AboutNewTabRedirector's suspended
// channels, SuspendableChannelWrapper::IsPending) counts as loading until then, opened or not.
/** @type {Set<any>} */
const inFlight = new Set();

/** Whether a Firefox channel handed out is still loading; drops the ones that finished. */
function firefoxLoading() {
  for (const channel of inFlight) if (!channel.isPending()) inFlight.delete(channel);
  return inFlight.size > 0;
}

// The childIDs of the privilegedabout processes seen starting (ipc:content-created, sent once a
// process is alive, with its remote type already set) and not yet ended.
const aboutIDs = new Set();

/**
 * Whether a privilegedabout content process other than `except` is alive.
 * @param {number} except  the childID of a process that is ending
 */
const privilegedAboutRuns = (except) =>
  ChromeUtils.getAllDOMProcesses().some(
    (p) => p.remoteType === "privilegedabout" && p.childID !== except,
  );

/** @param {any} process  an nsIDOMProcessParent */
function noteProcess(process) {
  if (process?.remoteType === "privilegedabout") aboutIDs.add(process.childID);
}

/**
 * ipc:content-shutdown: only the end of a privilegedabout process may clear firefoxServed.
 * @param {unknown} _subject
 * @param {string} _topic
 * @param {string | null} id  the childID of the process that ended
 */
function processEnded(_subject, _topic, id) {
  const childID = Number(id);
  // Evaluated first, whatever the rest says, so finished channels never outlive a process's end.
  const loading = firefoxLoading();
  if (
    aboutIDs.delete(childID) &&
    aboutIDs.size === 0 &&
    !privilegedAboutRuns(childID) &&
    !loading
  ) {
    firefoxServed = false;
  }
}

/** Whether a load of a Firefox start page opens Vimma's instead. */
const redirecting = () => Services.prefs.getBoolPref(NEWTAB_PREF, true) && !firefoxServed;

/**
 * Stands in for Firefox's about: module of `page` in this (the parent) process, so the load is
 * the start page from its first request. Replacing a load that has started (#863) loses when that
 * load's own switch to the privilegedabout process ends first, and Firefox's page stays.
 * The parent creates every top-level document channel and picks an about: load's process from
 * this module's flags (ProcessIsolation.cpp, IsolationBehaviorForURI); content processes keep
 * Firefox's module.
 * @param {string} page
 */
function standIn(page) {
  const contract = `@mozilla.org/network/protocol/about;1?what=${page}`;
  const firefox = /** @type {any} */ (Cc[contract].getService(Ci.nsIAboutModule));
  const startURI = () => Services.io.newURI(START_PAGE_URL);
  const module = /** @type {any} */ ({
    /** @param {any} uri */
    getURIFlags(uri) {
      // Without Firefox's URI_SAFE_FOR_UNTRUSTED_CONTENT and child-process flags the load stays
      // in the parent, where the system-principal start page belongs; without MAKE_LINKABLE the
      // web still cannot link to it. The flags are read again when the process is picked, so a
      // pref change in the milliseconds between can mismatch page and process for that one load.
      return redirecting() ? 0 : firefox.getURIFlags(uri);
    },
    /**
     * The start page's channel, with the start page as the result principal URI: the docshell
     * gives the channel the typed about: URL as its originalURI (nsDocShell.cpp,
     * CreateAndConfigureRealChannelForLoadState), and the document takes its URL from the result
     * principal URI, so the document is the start page's URL, as after a redirect, and the URL
     * bar treats it as the new tab. A history load overrides that URI (start.mjs replaces the
     * page then). The final URI is checked against the load's triggering principal, so only the
     * user, Vimma and Firefox's own system-principal code reach the page this way.
     * @param {any} uri
     * @param {any} loadInfo
     */
    newChannel(uri, loadInfo) {
      if (!redirecting()) {
        firefoxServed = true;
        firefoxLoading(); // drops finished channels, so the set holds only loads in flight
        const channel = firefox.newChannel(uri, loadInfo);
        inFlight.add(channel);
        return channel;
      }
      const start = startURI();
      loadInfo.resultPrincipalURI = start;
      return Services.io.newChannelFromURIWithLoadInfo(start, loadInfo);
    },
    /** @param {any} uri */
    getChromeURI(uri) {
      return redirecting() ? startURI() : firefox.getChromeURI(uri);
    },
    // Firefox's newtab code reaches its own module through this contract and wrappedJSObject
    // (AboutNewTab.sys.mjs, AboutNewTabResourceMapping.sys.mjs: the built-in add-on's start
    // resumes the about:newtab loads Firefox's module held while vimma.startpage.newtab is off);
    // without it those loads never start.
    wrappedJSObject: firefox.wrappedJSObject,
    QueryInterface: ChromeUtils.generateQI(["nsIAboutModule"]),
  });
  Components.manager
    .QueryInterface(Ci.nsIComponentRegistrar)
    .registerFactory(Services.uuid.generateUUID(), `Vimma about:${page}`, contract, {
      /** @param {any} iid */
      createInstance: (iid) => module.QueryInterface(iid),
      QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
    });
}

/** Sets or resets the new-tab URL from the pref; never replaces an extension's own page. */
function apply() {
  const newTab = lazy.AboutNewTab;
  const ours = newTab.newTabURL === START_PAGE_URL;
  if (Services.prefs.getBoolPref(NEWTAB_PREF, true)) {
    // Overridden by someone else (an extension's chrome_url_overrides.newtab): theirs wins.
    if (!ours && !newTab.newTabURLOverridden) newTab.newTabURL = START_PAGE_URL;
  } else if (ours) {
    newTab.resetNewTabURL();
  }
}

export const StartPage = {
  /**
   * Once per window (vimma.js); the new-tab URL once per app.
   * @param {BrowserWindow & { gInitialPages?: string[] }} win  a browser window
   */
  init(win) {
    // The home page alone is not the new-tab URL when vimma.startpage.newtab is off: its URL
    // bar should still be empty.
    if (Array.isArray(win.gInitialPages) && !win.gInitialPages.includes(START_PAGE_URL)) {
      win.gInitialPages.push(START_PAGE_URL);
    }
    if (started) return;
    started = true;
    for (const page of FIREFOX_START) standIn(page);
    apply();
    Services.prefs.addObserver(NEWTAB_PREF, apply);
    // An extension that overrode the new tab resets it when it goes: apply makes it ours again.
    Services.obs.addObserver(apply, NEWTAB_TOPIC);
    for (const process of ChromeUtils.getAllDOMProcesses()) noteProcess(process);
    Services.obs.addObserver((subject) => {
      noteProcess(/** @type {any} */ (subject).QueryInterface(Ci.nsIDOMProcessParent));
    }, "ipc:content-created");
    Services.obs.addObserver(processEnded, "ipc:content-shutdown");
  },
};
