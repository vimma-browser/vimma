/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Tab rename labels (spec: docs/specs/m2-picker-rename.md), kept as a SessionStore custom tab
// value so they are saved and restored with the tab (restart, undo close, a move to another
// window). M3's window snapshot (m3-workspaces sub-spec 3) also writes them as `tabLabels` and
// fills in a tab that comes back without its value; the tab value stays the source of truth,
// because only it travels with a closed or adopted tab. A change fires LABEL_EVENT on the tab.

import { normalizeTabLabel } from "../core/tablabels.mjs";

/** The SessionStore custom tab value that holds a tab's label. */
export const TAB_LABEL_KEY = "vimma.tabLabel";

/** Dispatched (bubbling) on a tab whose label changed; the window's workspaces save then. */
export const LABEL_EVENT = "VimmaTabLabelChanged";

/**
 * @typedef {{
 *   getCustomTabValue(tab: Element, key: string): string,
 *   setCustomTabValue(tab: Element, key: string, value: string): void,
 *   deleteCustomTabValue(tab: Element, key: string): void,
 * }} SessionStoreApi
 */

/** @returns {SessionStoreApi} */
function sessionStore() {
  return ChromeUtils.importESModule(
    "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  ).SessionStore;
}

/**
 * The tab's rename, or null.
 * @param {Element} tab
 * @returns {string | null}
 */
export function getTabLabel(tab) {
  return sessionStore().getCustomTabValue(tab, TAB_LABEL_KEY) || null;
}

/**
 * Sets the tab's label from what the user typed, normalised (core normalizeTabLabel: bidi and
 * format characters stripped, whitespace collapsed); a name that normalises to "" clears it.
 * @param {Element} tab
 * @param {string} text
 * @returns {string | null} the label now in effect
 */
export function setTabLabel(tab, text) {
  const label = normalizeTabLabel(text);
  if (label) sessionStore().setCustomTabValue(tab, TAB_LABEL_KEY, label);
  else sessionStore().deleteCustomTabValue(tab, TAB_LABEL_KEY);
  const event = /** @type {Document} */ (tab.ownerDocument).createEvent("Events");
  event.initEvent(LABEL_EVENT, true, false);
  tab.dispatchEvent(event);
  return label || null;
}
