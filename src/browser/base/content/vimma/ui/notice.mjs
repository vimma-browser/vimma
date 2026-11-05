/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A brief chrome-level toast (spec: docs/specs/m2-tab-keys.md), e.g. "Split right: not
// implemented yet". A manual popover in the chrome document: top layer, above remote content and
// the help overlay, and it never takes focus. One per window; a new message replaces the old one.
//
// Screen readers (spec m7-a11y) hear it through two live regions that are always in the tree,
// visually hidden: a polite one, and an assertive one for errors. A region that appears with its
// text (the popover) is not reliably announced, so the popover itself is aria-hidden. The same
// text again while it is still shown is not announced again.

export const NOTICE_ID = "vimma-notice";
export const NOTICE_LIVE_ID = "vimma-notice-live";
export const NOTICE_ALERT_ID = "vimma-notice-alert";
export const NOTICE_MS = 1500;
const STYLESHEET = "chrome://browser/skin/vimma/notice.css";
const HTML_NS = "http://www.w3.org/1999/xhtml";
/** @type {WeakSet<Window>} windows our stylesheet is loaded into */
const styled = new WeakSet();

export class Notice {
  /** @param {Window} win  a browser window */
  constructor(win) {
    this.win = win;
    /** @type {HTMLElement | null} */
    this.el = null;
    /** @type {HTMLElement | null} */
    this.polite = null;
    /** @type {HTMLElement | null} */
    this.alert = null;
    /** @type {number | null} */
    this.timer = null;
    /** Shown until the next key (`untilKey`) rather than for a time. */
    this.untilKey = false;
  }

  /**
   * Shows `text`, except while a page is in DOM fullscreen (a video): the toast would sit over
   * it, and Firefox's own chrome is hidden there too (`inDOMFullscreen` on the root, set by
   * browser-fullScreenAndPointerLock.js).
   * @param {string} text
   * @param {{ error?: boolean, ms?: number, untilKey?: boolean }} [options]  error: something was
   *   refused or failed; said assertively. ms: how long it stays (NOTICE_MS unless given).
   *   untilKey: it stays until the host sees the next key (`keyPressed`) instead, for a refusal
   *   that says what to do and would be missed in 1.5 s (docs/specs/multiple-splits.md, 4)
   * @returns {boolean} whether it is shown
   */
  show(text, { error = false, ms = NOTICE_MS, untilKey = false } = {}) {
    if (this.win.document.documentElement.hasAttribute("inDOMFullscreen")) return false;
    const fresh = !this.el;
    const el = this.el ?? this.build();
    const shown = el.matches(":popover-open");
    if (fresh) {
      // A region that is new to the accessible tree misses its first change: speak a frame on.
      this.win.requestAnimationFrame(() => this.#say(text, error));
    } else if (!shown || el.textContent !== text) {
      this.#say(text, error);
    }
    el.textContent = text;
    if (!shown) el.showPopover();
    if (this.timer !== null) this.win.clearTimeout(this.timer);
    this.timer = untilKey ? null : this.win.setTimeout(() => this.hide(), ms);
    this.untilKey = untilKey;
    return true;
  }

  /** A key was pressed: a notice shown `untilKey` goes. Called before the key's own action. */
  keyPressed() {
    if (this.untilKey) this.hide();
  }

  hide() {
    if (this.timer !== null) this.win.clearTimeout(this.timer);
    this.timer = null;
    this.untilKey = false;
    if (this.el?.matches(":popover-open")) this.el.hidePopover();
  }

  /** Hide and remove the elements (VimmaHost.uninit). */
  destroy() {
    this.hide();
    this.el?.remove();
    this.polite?.parentElement?.remove();
    this.el = this.polite = this.alert = null;
  }

  /**
   * @param {string} text
   * @param {boolean} error
   */
  #say(text, error) {
    if (!this.polite || !this.alert) return; // destroyed in between
    const [speak, quiet] = error ? [this.alert, this.polite] : [this.polite, this.alert];
    quiet.textContent = "";
    speak.textContent = text;
  }

  /**
   * @private
   * @returns {HTMLElement}
   */
  build() {
    if (!styled.has(this.win)) {
      this.win.windowUtils.loadSheetUsingURIString(STYLESHEET, this.win.windowUtils.AUTHOR_SHEET);
      styled.add(this.win);
    }
    const doc = this.win.document;
    /** @param {string} tag */
    const el = (tag) => /** @type {HTMLElement} */ (doc.createElementNS(HTML_NS, tag));
    const toast = el("div");
    toast.id = NOTICE_ID;
    toast.popover = "manual";
    toast.setAttribute("aria-hidden", "true");
    const regions = el("div");
    regions.className = "vimma-notice-live";
    const polite = el("div");
    polite.id = NOTICE_LIVE_ID;
    polite.setAttribute("role", "status");
    polite.setAttribute("aria-live", "polite");
    polite.setAttribute("aria-atomic", "true");
    const alert = el("div");
    alert.id = NOTICE_ALERT_ID;
    alert.setAttribute("role", "alert");
    alert.setAttribute("aria-live", "assertive");
    alert.setAttribute("aria-atomic", "true");
    regions.append(polite, alert);
    doc.body.append(toast, regions);
    this.el = toast;
    this.polite = polite;
    this.alert = alert;
    return toast;
  }
}
