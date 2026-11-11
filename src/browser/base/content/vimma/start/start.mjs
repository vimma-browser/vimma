/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The start page's theme tokens (spec: docs/specs/start-page.md): the app's theme host
// (ui/theme-host.mjs, spec m5-omarchy-theme) adds them and rewrites them when the Omarchy
// theme changes, so the page matches the bar. start.css falls back to vimma's dark colours until
// this runs, so the first paint already has colours.

// Reloaded, restored or reached by Back from a history entry recorded as Firefox's page (while
// vimma.startpage.newtab was off), the start page comes up under that about: URL: the docshell
// gives such a load the entry's empty result principal URI over the one StartPage.sys.mjs sets
// (nsDocShell.cpp, CreateAndConfigureRealChannelForLoadState). Replacing it from here stays in
// the parent process, so no process switch can overtake it (#863).
if (location.protocol === "about:") {
  location.replace("chrome://browser/content/vimma/start/start.html");
}

const { ThemeHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ui/theme-host.mjs",
);
ThemeHost.attachDocument(document);

// The way to switch the built-in palette, for a first-time user (docs/specs/theme-appearance.md
// B6); left out when the colours are an Omarchy theme's, which `:theme` does not change.
const tip = document.getElementById("vimma-theme-tip");
ThemeHost.followsOmarchy().then((/** @type {boolean} */ omarchy) => {
  if (!tip) return;
  tip.hidden = omarchy;
  tip.dataset.ready = "true";
});

// The versions in the footer, read from the running app, never written into the page: Vimma's
// own (surfer.json displayVersion -> MOZ_APP_VERSION_DISPLAY, what `vimma --version` prints)
// and the Firefox it is built on (appinfo.version, spec m0-app-version).
const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
/** @param {string} id @param {string} text */
const fill = (id, text) => {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
};
fill("vimma-version", `Vimma ${AppConstants.MOZ_APP_VERSION_DISPLAY}`);
fill("firefox-version", `Firefox ${Services.appinfo.version}`);
