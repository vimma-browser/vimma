/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The notice for a link click an agent tab drops (docs/security/12-agents-mcp.md M10, issue
// #1591): ctrl or cmd, shift, the middle button and alt-save open nothing there, which would
// otherwise look like a dead click. Pure: AgentPages shows it.

/**
 * At most one notice per tab in this interval. A page can script such clicks while it holds the
 * user's activation, so a burst must not fill the status bar; per tab, because a page reaches only
 * its own tab's clicks, so it cannot use up the notice of the user's click in another tab. Longer
 * than the notice shows, so a stream of clicks cannot keep it on screen either.
 */
export const CLICK_NOTICE_MS = 5000;

/** How long the notice shows: long enough to read its sentence. */
export const CLICK_NOTICE_SHOW_MS = 4000;

/**
 * The notice's text. It is fixed, apart from the key, which is the user's own: it carries no page
 * text, title or URL, which are the page's to choose.
 * @param {readonly string[]} keys  the keys of `follow_link_new_tab` (Keymap.keysFor); the first
 *   that normal mode reaches from a page is named (a modal binding carries its mode in brackets)
 */
export function droppedClickNotice(keys) {
  const key = keys.find((k) => !k.includes("["));
  const how = key ? `${key} or the context menu` : "the context menu";
  return `the click opened nothing: in agent tabs, open a link in a new tab with ${how}`;
}

/**
 * Whether a dropped click shows the notice.
 * @param {number | undefined} last  when this tab's last notice showed (ms), undefined for none
 * @param {number} now
 */
export function clickNoticeDue(last, now) {
  // A clock that went back (now < last) counts as due, so the notice is never silenced for good.
  return last === undefined || now < last || now - last >= CLICK_NOTICE_MS;
}
