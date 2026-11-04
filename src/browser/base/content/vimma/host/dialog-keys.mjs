/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Firefox's dialogs over a tab or over the window from the keyboard (docs/specs/
// firefox-dialogs.md): "Leave page?", a page's alert, confirm and prompt, a sign-in, and
// Firefox's own questions shown the same way. They are all commonDialog.xhtml in a SubDialog
// frame of the browser window (TabDialogBox for a tab, gDialogBox for the window), and a key
// typed in one reaches the window's capture listeners: SubDialog listens there itself
// (SubDialog.sys.mjs, _addDialogEventListeners). PromptKeys hands those keys here.
//
// `y` clicks the main button and `n` the cancel button, the one Firefox's Esc runs, with the
// permission prompt's guards: a key counts once the dialog has shown for
// security.notification_enable_delay with no key in between, and never in the dialog's own text
// fields. A click on a button Firefox keeps disabled (CommonDialog's enableDelay) does nothing,
// so such a dialog is not armed either. A line in the dialog names the keys once they count.

import { dialogHint, dialogKey } from "../core/prompt-keys.mjs";

const COMMON_DIALOG = "chrome://global/content/commonDialog.xhtml";
const DELAY_PREF = "security.notification_enable_delay";
const DEFAULT_DELAY_MS = 500;
const HINT_CLASS = "vimma-prompt-keys";
const ARMED_ATTR = "armed";
const HTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * @typedef {object} Shown
 * @property {number} at  when the dialog was built, on ChromeUtils.now()'s clock
 * @property {number} keyAt  the last key typed in it
 * @property {number} timer  shows the line once the keys count
 * @property {HTMLElement} line
 */

/** @param {any} button */
const shown = (button) => !!button && !button.hidden;

export class DialogKeys {
  /**
   * @param {Window} win  a browser window
   * @param {{ pending: () => boolean }} host
   */
  constructor(win, host) {
    this.win = win;
    this.host = host;
    /** @type {WeakMap<Document, Shown>} */
    this.dialogs = new WeakMap();
    this.onFrame = (/** @type {Event} */ e) => this.frameLoaded(e);
  }

  init() {
    // Fired on the top window for every frame in it, as SubDialog itself relies on
    // (SubDialog.sys.mjs, _addDialogEventListeners); after the dialog's own DOMContentLoaded
    // has labelled its buttons, and before SubDialog measures the frame on load.
    this.win.addEventListener("DOMFrameContentLoaded", this.onFrame, true);
  }

  uninit() {
    this.win.removeEventListener("DOMFrameContentLoaded", this.onFrame, true);
  }

  get delay() {
    return Math.max(0, Services.prefs.getIntPref(DELAY_PREF, DEFAULT_DELAY_MS));
  }

  /** @param {Event} e */
  frameLoaded(e) {
    const doc = /** @type {any} */ (e.target)?.contentDocument;
    if (doc?.documentURI !== COMMON_DIALOG || this.dialogs.has(doc)) return;
    const dialog = doc.getElementById("commonDialog");
    const grid = doc.getElementById("dialogGrid");
    if (!dialog || !grid) return;
    const line = doc.createElementNS(HTML_NS, "div");
    line.className = HINT_CLASS;
    // The buttons say what they do; the line is a reminder of the keys, not a second label.
    line.setAttribute("aria-hidden", "true");
    // The dialog's document takes none of the window's sheets, and its CSP refuses a <style>:
    // the look is set here, the command line's hint (cmdline.css) in the theme's tokens, which
    // theme-host gives the dialog while Vimma's theme is on.
    Object.assign(line.style, {
      marginBlockStart: "0.75em",
      fontFamily: "var(--vimma-font, monospace)",
      fontSize: "0.9em",
      color: "var(--vimma-fg-dim, GrayText)",
      whiteSpace: "nowrap",
    });
    line.textContent = dialogHint({
      accept: shown(dialog.getButton("accept")) ? dialog.getButton("accept").label : "",
      cancel: shown(dialog.getButton("cancel")) ? dialog.getButton("cancel").label : "",
      field: this.hasField(doc),
    });
    grid.append(line);
    // In line with the message, whose XUL <description> has a margin of its own.
    const body = doc.getElementById("infoBody");
    if (body)
      line.style.marginInlineStart = doc.defaultView.getComputedStyle(body).marginInlineStart;
    const now = ChromeUtils.now();
    /** @type {Shown} */
    const state = { at: now, keyAt: now, timer: 0, line };
    this.dialogs.set(doc, state);
    doc.defaultView.addEventListener(
      "unload",
      () => {
        this.win.clearTimeout(state.timer);
        this.dialogs.delete(doc);
      },
      { once: true },
    );
    this.arm(doc, state);
  }

  /** @param {Document} doc */
  hasField(doc) {
    return ["loginContainer", "password1Container"].some(
      (id) => doc.getElementById(id)?.hidden === false,
    );
  }

  /**
   * Hides the line of the dialog and shows it again once its keys count. It keeps its place
   * while hidden, so that the dialog does not change size under the reader.
   * @param {Document} doc
   * @param {Shown} state
   */
  arm(doc, state) {
    this.win.clearTimeout(state.timer);
    const set = (/** @type {boolean} */ armed) => {
      state.line.toggleAttribute(ARMED_ATTR, armed);
      state.line.style.visibility = armed ? "visible" : "hidden";
    };
    const check = () => {
      const left = this.armedAt(doc, state) - ChromeUtils.now();
      if (left <= 0) set(true);
      else state.timer = this.win.setTimeout(check, Math.ceil(left));
    };
    set(false);
    check();
  }

  /**
   * When the keys count: the delay from when the dialog was built or the last key in it, and
   * not before Firefox enables its buttons.
   * @param {Document} doc
   * @param {Shown} state
   */
  armedAt(doc, state) {
    const at = Math.max(state.at, state.keyAt) + this.delay;
    const accept = /** @type {any} */ (doc.getElementById("commonDialog"))?.getButton("accept");
    // CommonDialog's enableDelay disables the buttons until the window is focused for a while
    // (PromptUtils.sys.mjs, EnableDelayHelper); look again shortly.
    return accept?.disabled ? Math.max(at, ChromeUtils.now() + 100) : at;
  }

  /**
   * The dialog document a key was typed in, or null when it is not one of ours.
   * @param {KeyboardEvent} e
   * @returns {Document | null}
   */
  dialogOf(e) {
    const target = /** @type {any} */ (e.target);
    const doc = target?.ownerDocument ?? target?.document ?? target;
    return doc && this.dialogs.has(doc) ? doc : null;
  }

  /**
   * A keydown typed in one of the window's dialogs: y, n, or any other key, which starts the
   * wait again.
   * @param {KeyboardEvent} e
   * @param {Document} doc
   * @param {string} key  formatKey's notation
   * @returns {boolean} whether it was the dialog's key (consumed)
   */
  onKey(e, doc, key) {
    const state = /** @type {Shown} */ (this.dialogs.get(doc));
    const now = ChromeUtils.now();
    const armed = now >= this.armedAt(doc, state);
    state.keyAt = now;
    this.arm(doc, state);
    const dialog = /** @type {any} */ (doc.getElementById("commonDialog"));
    const accept = dialog.getButton("accept");
    const cancel = dialog.getButton("cancel");
    const focused = /** @type {any} */ (doc.activeElement);
    const result = dialogKey(key, {
      armed,
      inField: focused?.localName === "input" || !!focused?.isContentEditable,
      pending: this.host.pending(),
      accept: shown(accept),
      cancel: shown(cancel),
      repeat: e.repeat,
    });
    if (result.kind === "pass") return false;
    e.preventDefault();
    e.stopPropagation();
    // The buttons' own command: what a click, Enter and Esc run (dialog.js, _doButtonCommand).
    if (result.kind === "accept") accept.click();
    else if (result.kind === "cancel") cancel.click();
    return true;
  }
}
