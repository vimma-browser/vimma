/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Firefox's dialogs over a tab or over the window from the keyboard (docs/specs/
// firefox-dialogs.md): "Leave page?", a page's alert, confirm and prompt, a sign-in, Firefox's
// own questions shown the same way, and the external protocol questions ("Open the link with
// ...?", the application list). They are all a XUL <dialog> in a SubDialog frame of the browser
// window (TabDialogBox for a tab, gDialogBox for the window), and a key typed in one reaches the
// window's capture listeners: SubDialog listens there itself (SubDialog.sys.mjs,
// _addDialogEventListeners). PromptKeys hands those keys here.
//
// The download question (unknownContentType.xhtml) is a window of its own, opened over the
// browser window (HelperAppDlg.sys.mjs, reallyShow): it is found through the window watcher and
// its keys are taken in its own window, which VimmaHost never sees.
//
// `y` clicks the main button and `n` the cancel button, the one Firefox's Esc runs, with the
// permission prompt's guards: a key counts once the dialog has shown for
// security.notification_enable_delay with no key in between, and never in the dialog's own text
// fields. `y` also waits for Firefox to enable the main button (EnableDelayHelper), and a click
// on a disabled button does nothing. A line in the dialog names the keys once they count.

import { dialogHint, dialogKey } from "../core/prompt-keys.mjs";
import { chordFromEvent, formatKey } from "../core/keys.mjs";

/**
 * @typedef {object} Kind  how one of Firefox's dialog documents is built
 * @property {string} dialog  the <dialog>'s selector
 * @property {string} parent  the selector of the element the line closes
 * @property {string} [indent]  the element whose inline margin the line takes
 * @property {string[]} [fields]  the containers of its text fields, hidden when unused
 * @property {boolean} [window]  a window of its own, not a SubDialog frame
 */

/** @type {Record<string, Kind>} */
const KINDS = {
  // commonDialog.js: the message in #dialogGrid, the fields in their own containers.
  "chrome://global/content/commonDialog.xhtml": {
    dialog: "#commonDialog",
    parent: "#dialogGrid",
    indent: "#infoBody",
    fields: ["loginContainer", "password1Container"],
  },
  // ContentDispatchChooser.sys.mjs: "Allow this site to open the link with ...?"
  "chrome://mozapps/content/handling/permissionDialog.xhtml": {
    dialog: "dialog",
    parent: "#description-box",
  },
  // The application list, after the permission question or for a scheme set to always ask.
  "chrome://mozapps/content/handling/appChooser.xhtml": {
    dialog: "dialog",
    parent: "#rememberContainer",
  },
  // HelperAppDlg.sys.mjs: "What should Firefox do with this file?", open with or save.
  "chrome://mozapps/content/downloads/unknownContentType.xhtml": {
    dialog: "#unknownContentType",
    parent: "#container",
    indent: "#intro",
    window: true,
  },
};

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
 * @property {any} dialog  the document's <dialog>
 * @property {Kind} kind
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
    this.onOpen = (/** @type {Event} */ e) => this.dialogShown(e);
    this.onWindow = (/** @type {any} */ subject, /** @type {string} */ topic) =>
      topic === "domwindowopened" && this.windowOpened(subject);
  }

  init() {
    // Fired on the top window for every frame in it, as SubDialog itself relies on
    // (SubDialog.sys.mjs, _addDialogEventListeners); after the dialog's own DOMContentLoaded
    // has labelled its buttons, and before SubDialog measures the frame on load.
    this.win.addEventListener("DOMFrameContentLoaded", this.onFrame, true);
    this.win.addEventListener("dialogopen", this.onOpen, true);
    /** @type {any} */ (Services).ww.registerNotification(this.onWindow);
  }

  uninit() {
    this.win.removeEventListener("DOMFrameContentLoaded", this.onFrame, true);
    this.win.removeEventListener("dialogopen", this.onOpen, true);
    /** @type {any} */ (Services).ww.unregisterNotification(this.onWindow);
  }

  /**
   * A new window: one of ours when it is a dialog window opened over this browser window. Its
   * load listener is added during openWindow, before HelperAppDlg adds its own (initDialog), so
   * the line is in place before the dialog sizes itself to its content (postShowCallback).
   * @param {Window} w
   */
  windowOpened(w) {
    w.addEventListener(
      "load",
      () => {
        // Only a window opened over this one: the window watcher sets its opener after
        // domwindowopened, by load.
        if (/** @type {any} */ (w).opener !== this.win) return;
        const doc = w.document;
        const kind = KINDS[doc.documentURI];
        if (!kind?.window || !this.attach(doc, kind)) return;
        w.addEventListener(
          "keydown",
          (e) => {
            const chord = chordFromEvent(e);
            // A key sequence under way in the browser window does not reach this window.
            if (chord) this.onKey(e, doc, formatKey(chord), false);
          },
          true,
        );
      },
      { once: true },
    );
  }

  /**
   * SubDialog has sized the frame and made it visible (SubDialog.sys.mjs, _onLoad, after
   * document.l10n.ready): the wait starts again here, so that it counts only time the dialog
   * was on screen.
   * @param {Event} e
   */
  dialogShown(e) {
    const doc = /** @type {any} */ (e).detail?.dialog?._frame?.contentDocument;
    const state = doc && this.dialogs.get(doc);
    if (!state) return;
    state.at = ChromeUtils.now();
    this.arm(state);
  }

  get delay() {
    return Math.max(0, Services.prefs.getIntPref(DELAY_PREF, DEFAULT_DELAY_MS));
  }

  /** @param {Event} e */
  frameLoaded(e) {
    const frame = /** @type {any} */ (e.target);
    // Only SubDialog's frames (TabDialogBox, gDialogBox), never another frame of the window
    // that happens to load one of these documents.
    if (!frame?.classList?.contains("dialogFrame")) return;
    const doc = frame.contentDocument;
    const kind = KINDS[doc?.documentURI];
    if (kind && !kind.window) this.attach(doc, kind);
  }

  /**
   * Adds the keys line to a dialog document and starts its wait.
   * @param {Document} doc
   * @param {Kind} kind
   * @returns {boolean} whether the dialog is now one of ours
   */
  attach(doc, kind) {
    const view = /** @type {any} */ (doc.defaultView);
    if (!view || this.dialogs.has(doc)) return false;
    const dialog = /** @type {any} */ (doc.querySelector(kind.dialog));
    const parent = doc.querySelector(kind.parent);
    if (!dialog || !parent) return false;
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
    parent.append(line);
    // In line with the message, whose XUL <description> has a margin of its own.
    const body = kind.indent && doc.querySelector(kind.indent);
    if (body) line.style.marginInlineStart = view.getComputedStyle(body).marginInlineStart;
    const now = ChromeUtils.now();
    /** @type {Shown} */
    const state = { at: now, keyAt: now, timer: 0, line, dialog, kind };
    this.label(doc, state);
    // The protocol questions label their buttons through Fluent, after the frame has loaded
    // and after document.l10n.ready: follow the buttons' labels rather than reading them once.
    const relabel = new view.MutationObserver(() => this.label(doc, state));
    for (const type of ["accept", "cancel"]) {
      const button = dialog.getButton(type);
      if (button) relabel.observe(button, { attributeFilter: ["label", "hidden"] });
    }
    this.dialogs.set(doc, state);
    view.addEventListener(
      "unload",
      () => {
        relabel.disconnect();
        this.win.clearTimeout(state.timer);
        this.dialogs.delete(doc);
      },
      { once: true },
    );
    this.arm(state);
    return true;
  }

  /**
   * The line's text, from the dialog's own buttons as they are labelled now.
   * @param {Document} doc
   * @param {Shown} state
   */
  label(doc, state) {
    const { dialog } = state;
    state.line.textContent = dialogHint({
      accept: shown(dialog.getButton("accept")) ? dialog.getButton("accept").label : "",
      cancel: shown(dialog.getButton("cancel")) ? dialog.getButton("cancel").label : "",
      field: (state.kind.fields ?? []).some((id) => doc.getElementById(id)?.hidden === false),
    });
  }

  /**
   * Hides the line of the dialog and shows it again once its keys count. It keeps its place
   * while hidden, so that the dialog does not change size under the reader.
   * @param {Shown} state
   */
  arm(state) {
    this.win.clearTimeout(state.timer);
    const set = (/** @type {boolean} */ armed) => {
      state.line.toggleAttribute(ARMED_ATTR, armed);
      state.line.style.visibility = armed ? "visible" : "hidden";
    };
    const check = () => {
      const left = this.armedAt(state) - ChromeUtils.now();
      if (left <= 0) set(true);
      else state.timer = this.win.setTimeout(check, Math.ceil(left));
    };
    set(false);
    check();
  }

  /**
   * When the keys count: the delay from when the dialog was built or the last key in it.
   * @param {Shown} state
   */
  armedAt(state) {
    return Math.max(state.at, state.keyAt) + this.delay;
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
   * @param {boolean} [pending]  a key sequence is under way in the browser window
   * @returns {boolean} whether it was the dialog's key (consumed)
   */
  onKey(e, doc, key, pending = this.host.pending()) {
    const state = /** @type {Shown} */ (this.dialogs.get(doc));
    const now = ChromeUtils.now();
    const armed = now >= this.armedAt(state);
    state.keyAt = now;
    this.arm(state);
    const accept = state.dialog.getButton("accept");
    const cancel = state.dialog.getButton("cancel");
    const focused = /** @type {any} */ (doc.activeElement);
    const result = dialogKey(key, {
      // Firefox keeps the main button disabled until its window has had focus for a while
      // (PromptUtils.sys.mjs, EnableDelayHelper), or until an application is picked
      // (appChooser.js): `y` waits for it too, `n` does not need to.
      armed: armed && (key !== "y" || !accept?.disabled),
      // Text fields only: a checkbox ("Always allow") is the dialog's, not typing.
      inField:
        !!focused?.mozIsTextField?.(false) ||
        focused?.localName === "textarea" ||
        !!focused?.isContentEditable,
      pending,
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
