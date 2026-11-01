/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The pop-up picker (`:popups`) and the bar's status bar cue
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
 * @property {"allow" | "block" | null} permission  the site's own pop-up permission, if it has one
 */
/**
 * @typedef {object} PopupItem
 * @property {"popup"} kind
 * @property {string} popupId  `allow`, `block`, `reset`, `popup:<n>`, `redirect`, `hide` or
 *   `settings`
 * @property {string} display
 * @property {string} detail   the row's right-hand cell
 * @property {boolean} active  never
 */
/**
 * @typedef {{ op: "allow" | "block" | "reset" | "redirect" | "hide" | "settings" }
 *   | { op: "popup", index: number }} PopupOp
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
 * The rows for the site's own permission. A site blocked with `n` can be allowed again or reset
 * to Firefox's default, an allowed one blocked, so a mistaken answer is undone here rather than in
 * Firefox's settings. A locked `dom.disable_open_during_load` leaves the permission alone, as
 * Firefox's Page Info does.
 * @param {BlockedPopups} b
 * @returns {PopupItem[]}
 */
function siteRows(b) {
  if (b.allowLocked) return [];
  const detail = b.popups.length > 0 || b.redirect ? "opens them all" : "this site";
  if (b.permission === "allow") return [row("block", `Block pop-ups for ${b.site}`, "this site")];
  const allow = row("allow", `Allow pop-ups for ${b.site}`, detail);
  if (b.permission !== "block") return [allow];
  return [allow, row("reset", `Reset pop-ups for ${b.site} to default`, "this site")];
}

/**
 * The picker's rows, in the order of Firefox's options menu, after the site's permission rows.
 * None when nothing is blocked and the site has no permission of its own.
 * @param {BlockedPopups} b
 * @returns {PopupItem[]}
 */
export function popupItems(b) {
  const blocked = b.popups.length > 0 || !!b.redirect;
  if (!blocked && !b.permission) return [];
  return [
    ...siteRows(b),
    ...(b.redirect ? [row("redirect", `Go to ${b.redirect}`, "blocked redirect")] : []),
    ...b.popups.map((url, i) => row(`popup:${i}`, `Open ${url}`, "pop-up")),
    ...(b.showMessage && blocked
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
  if (["allow", "block", "reset", "redirect", "hide", "settings"].includes(id)) {
    return /** @type {PopupOp} */ ({ op: id });
  }
  const m = /^popup:(\d+)$/.exec(id);
  return m ? { op: "popup", index: Number(m[1]) } : null;
}

/**
 * The status bar's cue. While the selected page has the bar: the bar's keys once they count
 * (popupBarHint), none before, and none in the agent workspace, where nothing answers the bar.
 * Without the bar, on a site blocked with `n`: the way to undo it. Else none.
 * @param {{ bar: boolean, hint: string | null, siteBlocked?: boolean, agent?: boolean }} s
 * @returns {string | null}
 */
export function popupCue({ bar, hint, siteBlocked = false, agent = false }) {
  if (bar) return !agent && hint ? `pop-up blocked · ${hint}` : "pop-up blocked";
  return siteBlocked && !agent ? "pop-ups blocked · :popups to allow" : null;
}
