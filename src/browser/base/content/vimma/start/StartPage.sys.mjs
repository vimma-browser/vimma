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

const lazy = /** @type {any} */ ({});
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
const FIREFOX_START = /^about:(home|newtab|welcome)(?:[?#]|$)/i;

/**
 * Sends a top-level load of a Firefox start page to Vimma's while the start page is the new tab.
 * Caught when the load starts, before Firefox's page draws, and the history entry is replaced so
 * that Back does not return to it.
 */
const redirector = {
  /**
   * @param {any} browser
   * @param {any} webProgress
   * @param {any} request
   * @param {number} flags
   */
  onStateChange(browser, webProgress, request, flags) {
    const start = Ci.nsIWebProgressListener.STATE_START;
    const doc = Ci.nsIWebProgressListener.STATE_IS_DOCUMENT;
    if (!(flags & start) || !(flags & doc) || !webProgress?.isTopLevel) return;
    let spec;
    try {
      spec = request.QueryInterface(Ci.nsIChannel).originalURI.spec;
    } catch {
      return;
    }
    if (!FIREFOX_START.test(spec) || !Services.prefs.getBoolPref(NEWTAB_PREF, true)) return;
    browser.loadURI(Services.io.newURI(START_PAGE_URL), {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_REPLACE_HISTORY,
    });
  },
};

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
   * @param {Window & { gInitialPages?: string[] }} win  a browser window
   */
  init(win) {
    // The home page alone is not the new-tab URL when vimma.startpage.newtab is off: its URL
    // bar should still be empty.
    if (Array.isArray(win.gInitialPages) && !win.gInitialPages.includes(START_PAGE_URL)) {
      win.gInitialPages.push(START_PAGE_URL);
    }
    // gBrowser exists once the window has loaded; this runs from browser.xhtml's scripts.
    const watch = () => /** @type {any} */ (win).gBrowser?.addTabsProgressListener(redirector);
    if (/** @type {any} */ (win).gBrowser) watch();
    else win.addEventListener("load", watch, { once: true });
    if (started) return;
    started = true;
    apply();
    Services.prefs.addObserver(NEWTAB_PREF, apply);
    // An extension that overrode the new tab resets it when it goes: apply makes it ours again.
    Services.obs.addObserver(apply, NEWTAB_TOPIC);
  },
};
