/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Hides Firefox's tab strip (spec: docs/specs/m0-tabstrip-hidden.md). tabstrip.css hides it,
// keyed on a root attribute that follows the pref live. tab-bar-visibility-js.patch reads the
// same attribute, so Firefox lays out the window as with the strip hidden (window controls in
// the nav bar); this module only has to re-run TabBarVisibility.update() when the pref flips.

export const TABSTRIP_PREF = "vimma.ui.tabstrip.hidden";
export const TABSTRIP_ATTR = "vimma-tabstrip-hidden";
const STYLESHEET = "chrome://browser/skin/vimma/tabstrip.css";
const TOOLBOX_EVENTS = ["customizationstarting", "aftercustomization"];
/** @type {WeakSet<Window>} windows our stylesheet is loaded into (loading it twice throws) */
const styled = new WeakSet();

export class TabStrip {
  /** @param {BrowserWindow} win  a browser window, from its first script (before the body exists) */
  constructor(win) {
    this.win = /** @type {EarlyBrowserWindow} */ (win);
    this.onPref = () => this.apply();
    /** @param {Event} e */
    this.onToolbox = (e) => {
      // Entering or leaving customize mode, where the strip shows (tabstrip.css): re-lay out.
      if (e.target === this.win.gNavToolbox) this.update();
    };
  }

  init() {
    const win = this.win;
    if (!styled.has(win)) {
      win.windowUtils.loadSheetUsingURIString(STYLESHEET, win.windowUtils.AUTHOR_SHEET);
      styled.add(win);
    }
    Services.prefs.addObserver(TABSTRIP_PREF, this.onPref);
    for (const type of TOOLBOX_EVENTS) win.addEventListener(type, this.onToolbox, true);
    this.setAttribute();
    // Normally the window's own startup runs the first update; on a re-init it has already run.
    if (win.document.readyState === "complete") this.update();
  }

  uninit() {
    Services.prefs.removeObserver(TABSTRIP_PREF, this.onPref);
    for (const type of TOOLBOX_EVENTS) this.win.removeEventListener(type, this.onToolbox, true);
    // No update here: this also runs on unload. The next update clears the rest.
    this.win.document.documentElement.removeAttribute(TABSTRIP_ATTR);
  }

  /** The pref changed: update the root attribute, then let Firefox recompute its toolbars. */
  apply() {
    this.setAttribute();
    this.update();
  }

  /** @private */
  setAttribute() {
    const hidden = Services.prefs.getBoolPref(TABSTRIP_PREF, true);
    this.win.document.documentElement.toggleAttribute(TABSTRIP_ATTR, hidden);
  }

  /** @private */
  update() {
    this.win.TabBarVisibility.update(true);
  }
}
