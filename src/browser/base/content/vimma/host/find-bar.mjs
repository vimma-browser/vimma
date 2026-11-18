/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Firefox's find bar as Vimma's `/` prompt (docs/specs/m1-find.md, "Since changed"): the bar
// `/` and `?` open carries `vimma-prompt`, which firefox-chrome.css floats over the page in the
// pickers' style. A bar Firefox opens itself (the Edit menu's Find in Page) loses it and is
// Firefox's, with its buttons and checkboxes. The attribute stays while the bar closes, so a
// closed prompt goes at once instead of sliding out as Firefox's bar.
//
// The prompt shows the match count as `[2/5]`, the status bar's form. Firefox's own label
// ("2 of 5 matches") stays for screen readers, out of sight; the count mirrors it. It follows
// the label rather than the finder because pdf.js gives its count to the find bar alone
// (PdfJsParent).

import { findCountText } from "../core/find.mjs";

const XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const PROMPT = "vimma-prompt";

/**
 * @typedef {Element & {
 *   hidden: boolean,
 *   FIND_NORMAL: number,
 *   open(mode: number): boolean,
 * }} FindBar
 */

/** Find bars being opened by `openPrompt`, until their `hidden` change is seen. */
const opening = new WeakSet();

/**
 * Styles `findbar` as Vimma's prompt before it opens. A bar `/` creates gets this as soon as it
 * exists: until the prompt opens (host/find.mjs, start) it is then `display: none`, not Firefox's
 * hidden bar below the page, whose margin transition would slide the prompt up from under the
 * status bar. A bar Firefox opens itself still loses it (decorate).
 * @param {FindBar} findbar
 */
export function markPrompt(findbar) {
  findbar.setAttribute(PROMPT, "");
}

/**
 * Opens `findbar` as Vimma's prompt.
 * @param {FindBar} findbar
 */
export function openPrompt(findbar) {
  findbar.setAttribute(PROMPT, "");
  if (findbar.hidden) opening.add(findbar);
  findbar.open(findbar.FIND_NORMAL);
}

/**
 * Firefox's count label's Fluent arguments (findbar.js onMatchesCountResult), as a count.
 * @param {Element} label
 * @returns {{ current?: number, total?: number, limit?: number }}
 */
function labelCount(label) {
  if (/** @type {Partial<XULElement>} */ (label).hidden) return {};
  const attributes = label.ownerDocument.l10n?.getAttributes(label);
  if (!attributes) return {};
  const { id, args } = attributes;
  // Numbers, as findbar.js sets them.
  const num = (/** @type {unknown} */ v) => (typeof v === "number" ? v : undefined);
  if (id === "findbar-found-matches")
    return { current: num(args?.current), total: num(args?.total) };
  if (id === "findbar-found-matches-count-limit") return { total: -1, limit: num(args?.limit) };
  return {};
}

/**
 * Adds the `[2/5]` count after the bar's field, kept in step with Firefox's label, and drops
 * the prompt style when the bar is opened by anything but `openPrompt`.
 * @param {FindBar} findbar
 */
function decorate(findbar) {
  const label = findbar.querySelector(".found-matches");
  // Inside the field's wrapper: findbar.js's _updateFindUI hides the container's other
  // children in its minimal mode.
  const wrapper = findbar.querySelector(".findbar-textbox")?.parentElement;
  if (!label || !wrapper || wrapper.querySelector(".vimma-find-count")) return;
  const doc = /** @type {Document} */ (findbar.ownerDocument);
  const win = doc.defaultView;
  if (!win) return;
  const count = doc.createElementNS(XUL, "label");
  count.className = "vimma-find-count";
  // Screen readers have Firefox's label, in the user's language.
  count.setAttribute("aria-hidden", "true");
  wrapper.append(count);
  const update = () => {
    count.textContent = findCountText(labelCount(label));
  };
  new win.MutationObserver(update).observe(label, {
    attributes: true,
    attributeFilter: ["hidden", "data-l10n-id", "data-l10n-args"],
  });
  update();
  // Runs before the next paint, so Firefox's own bar never shows in the prompt's style.
  new win.MutationObserver(() => {
    if (findbar.hidden) return;
    if (opening.has(findbar)) opening.delete(findbar);
    else findbar.removeAttribute(PROMPT);
  }).observe(findbar, { attributes: true, attributeFilter: ["hidden"] });
}

/**
 * Decorates every find bar the window creates from now on (one per tab, on first use).
 * @param {BrowserWindow} win
 * @returns {() => void} stops
 */
export function watchFindBars(win) {
  const onInit = (/** @type {Event} */ e) => {
    // TabFindInitialized is dispatched on the tab (Tabbrowser.getFindBar).
    const findbar = win.gBrowser.getCachedFindBar(/** @type {MozTabbrowserTab} */ (e.target));
    if (findbar) decorate(findbar);
  };
  win.addEventListener("TabFindInitialized", onInit, true);
  return () => win.removeEventListener("TabFindInitialized", onInit, true);
}
