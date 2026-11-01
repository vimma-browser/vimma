/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The pop-up picker (`prefix+shift+o`, `:popups`) and its status bar cue
 * (docs/specs/popup-blocked.md): the rows of Firefox's "pop-up blocked" bar options menu
 * (PopupAndRedirectBlockerObserver.sys.mjs onPopupShowing) and the action each row runs. The host
 * reads the selected browser's popupAndRedirectBlocker into BlockedPopups; nothing here knows
 * Firefox.
 */

/**
 * What the host reads for the selected page.
 * @typedef {object} BlockedPopups
 * @property {string} site          the host the allow row names (Firefox's uriHost)
 * @property {readonly string[]} popups  each blocked pop-up's URL, in Firefox's report order
 * @property {string | null} redirect    the blocked redirect's URL, if any
 * @property {boolean} allowLocked  `dom.disable_open_during_load` is locked: Firefox hides allow
 * @property {boolean} showMessage  `privacy.popups.showBrowserMessage`: the bar is on
 */
/**
 * @typedef {object} PopupItem
 * @property {"popup"} kind
 * @property {string} popupId  `allow`, `popup:<n>`, `redirect`, `hide` or `settings`
 * @property {string} display
 * @property {string} detail   the row's right-hand cell
 * @property {boolean} active  never
 */
/**
 * @typedef {{ op: "allow" | "redirect" | "hide" | "settings" } | { op: "popup", index: number }}
 *   PopupOp
 */

export const NOTHING_BLOCKED = "no pop-ups blocked on this page";
export const AGENT_REFUSED = "pop-ups stay blocked in the agent workspace";

/**
 * @param {string} popupId
 * @param {string} display
 * @param {string} detail
 * @returns {PopupItem}
 */
const row = (popupId, display, detail) =>
  Object.freeze({ kind: /** @type {const} */ ("popup"), popupId, display, detail, active: false });

/**
 * The picker's rows, in the order of Firefox's options menu. None when nothing is blocked.
 * @param {BlockedPopups} b
 * @returns {PopupItem[]}
 */
export function popupItems(b) {
  if (!b.popups.length && !b.redirect) return [];
  return [
    ...(b.allowLocked ? [] : [row("allow", `Allow pop-ups for ${b.site}`, "opens them all")]),
    ...(b.redirect ? [row("redirect", `Go to ${b.redirect}`, "blocked redirect")] : []),
    ...b.popups.map((url, i) => row(`popup:${i}`, `Open ${url}`, "pop-up")),
    ...(b.showMessage
      ? [row("hide", "Don't show this message when pop-ups are blocked", "every site")]
      : []),
    row("settings", "Pop-up settings", "about:preferences"),
  ];
}

/**
 * The bar action a row's id stands for, or null.
 * @param {string} id
 * @returns {PopupOp | null}
 */
export function parsePopupId(id) {
  if (id === "allow" || id === "redirect" || id === "hide" || id === "settings") return { op: id };
  const m = /^popup:(\d+)$/.exec(id);
  return m ? { op: "popup", index: Number(m[1]) } : null;
}

/**
 * The status bar's cue while the selected page has the bar: the picker's first key, `:popups`
 * when it has none, and no way in at all in the agent workspace, where the picker refuses.
 * @param {readonly string[]} keys  keymap.keysFor("popup_picker")
 * @param {{ agent?: boolean }} [options]
 */
export function popupCue(keys, { agent = false } = {}) {
  if (agent) return "pop-up blocked";
  return `pop-up blocked · ${keys[0] ?? ":popups"}`;
}
