/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Firefox's permission prompts (doorhangers) from the keyboard (docs/specs/toolbar-toggle.md
// decision 11a). VimmaHost hands every keydown here from its capture listener, after the agent
// question's: `y` clicks the prompt's main button, `n` its secondary one, `Tab` moves focus onto
// its buttons (where Firefox's own Tab, arrow keys, Enter and Space work), and Esc stays
// Firefox's. As the agent question line (agent-ui.mjs), the prompt never takes focus by itself,
// a key counts only once it is armed, and a key typed on through it (any key) starts the delay
// again, so typing never answers it; keys typed in a field are the field's, the prompt's own
// fields included (the password prompt's username and password). The delay is
// Firefox's own for these prompts (security.notification_enable_delay), whose buttons also
// refuse a click before it (PopupNotifications._onButtonEvent). A line in the prompt names the
// keys once it is armed.
//
// The delay counts from Firefox's own clock for the prompt, `notification.timeShown`, which
// Firefox moves forward whenever the panel is repositioned or resized ("popuppositioned") or the
// window is activated. A key armed on a clock of our own could reach a button Firefox still
// refuses, and the key would be lost. For the same reason the keys line keeps its place in the
// panel while hidden: showing it must not resize the panel and so restart Firefox's delay.
//
// The notice Firefox shows after an add-on install ("<name> was added", an app menu notification,
// ExtensionsUI.showInstallNotification) takes them too (issue #868): `y` presses its OK button and
// `p` toggles its "Pin extension to toolbar" checkbox (the checkbox's own access key), and `Tab`
// moves focus onto that checkbox, where Firefox's Space toggles it. Firefox gives the app menu's
// notices no delay of their own (PanelUI._onNotificationButtonEvent), so the clock is ours: from
// when the notice showed or the window was last activated, or the last key since. Only that notice
// takes the keys: the same panel shows the update notices, whose main button restarts the browser.
//
// Firefox's pop-up blocked bar takes the same keys with the same guards while no prompt is open
// (docs/specs/popup-blocked.md), with Esc to close it. Firefox gives the bar no delay of its own,
// so its clock is ours: from when the selected page's bar was first seen, or the last key since.
// The status bar names its keys (popupHint) and VimmaHost redraws it when they come to count; the
// bar names them too, in the prompt's keys line beside its button, hidden while the keys wait.
//
// Firefox's dialogs over a tab or the window ("Leave page?", a page's confirm) take the same keys
// with the same guards (docs/specs/firefox-dialogs.md, host/dialog-keys.mjs); a key typed in one
// is the dialog's alone.

import { doorhangerHint, doorhangerKey, popupBarHint, popupBarKey } from "../core/prompt-keys.mjs";
import { chordFromEvent, formatKey } from "../core/keys.mjs";
import { DialogKeys } from "./dialog-keys.mjs";
import { answerPopupBar, inAgentTab, popupBar, popupLocked } from "./popup-ops.mjs";

const DELAY_PREF = "security.notification_enable_delay";
const DEFAULT_DELAY_MS = 500;
const PANEL_ID = "notification-popup";
/** The app menu's notices (panelUI.inc.xhtml). */
const NOTICE_PANEL_ID = "appMenu-notification-popup";
/** The one of them that takes the keys: after an add-on install (browser-addons.js). */
const NOTICE_ID = "addon-installed";
const PIN_ID = "addon-pin-toolbarbutton-checkbox";
const HINT_CLASS = "vimma-prompt-keys";
/** On the keys line once the prompt is armed; without it the line is invisible, not gone. */
const ARMED_ATTR = "armed";
const HTML_NS = "http://www.w3.org/1999/xhtml";
const EVENTS = ["popupshowing", "popupshown", "popuppositioned", "popuphidden", "activate"];

/**
 * What the keys need from VimmaHost.
 * @typedef {object} PromptKeysHost
 * @property {() => boolean} inField  focus is in an editable field (insert mode)
 * @property {() => boolean} otherOpen  a picker, prompt, panel or the command line of Vimma's
 * @property {() => boolean} pending  a key sequence is under way (after ctrl+b)
 * @property {() => boolean} modeKeys  the mode types its own letters (hint, copy, element mode);
 *   `otherOpen` covers it too, this only words the keys line
 * @property {() => void} changed  the pop-up blocked bar's keys line changed: redraw the status bar
 */

/** @param {any} node  an element, possibly in a shadow root */
function hostChain(node) {
  /** @type {any[]} */
  const chain = [];
  for (let el = node; el; el = el.parentNode ?? el.host) chain.push(el);
  return chain;
}

export class PromptKeys {
  /**
   * @param {Window} win  a browser window
   * @param {PromptKeysHost} host
   */
  constructor(win, host) {
    this.win = win;
    this.host = host;
    /** the last key while it was open, on ChromeUtils.now()'s clock as `timeShown` is */
    this.lastKeyAt = 0;
    /** when the add-on notice last showed or the window was activated, its `timeShown` */
    this.noticeShownAt = Infinity;
    /** @type {MutationObserver | null} watches the notice's checkbox come and go */
    this.noticeChanged = null;
    this.armTimer = 0;
    /** @type {{ bar: any, at: number } | null} the bar last seen, and when it was first seen */
    this.barSeen = null;
    /** the last key in the window, on ChromeUtils.now()'s clock */
    this.barKeyAt = 0;
    this.barTimer = 0;
    /** @type {MutationObserver | null} watches the seen bar's box for its removal */
    this.barGone = null;
    this.onPopup = (/** @type {Event} */ e) => this.popup(e);
    this.dialogKeys = new DialogKeys(win, host);
  }

  init() {
    for (const type of EVENTS) this.win.addEventListener(type, this.onPopup, true);
    this.dialogKeys.init();
  }

  uninit() {
    this.dialogKeys.uninit();
    for (const type of EVENTS) this.win.removeEventListener(type, this.onPopup, true);
    this.win.clearTimeout(this.armTimer);
    this.win.clearTimeout(this.barTimer);
    this.barGone?.disconnect();
    this.noticeChanged?.disconnect();
  }

  get delay() {
    return Math.max(0, Services.prefs.getIntPref(DELAY_PREF, DEFAULT_DELAY_MS));
  }

  /** The prompt shown in the open doorhanger panel, or null. @returns {any} */
  get notification() {
    return this.topmost("open");
  }

  /** The prompt the keys answer: the doorhanger's first, then the add-on notice. @returns {any} */
  get current() {
    return this.notification ?? this.noticeIn("open");
  }

  /**
   * The add-on notice while the app menu's notice panel is in `state`, or null.
   * @param {string} state
   * @returns {any}
   */
  noticeIn(state) {
    const panel = /** @type {any} */ (this.win.document.getElementById(NOTICE_PANEL_ID));
    if (panel?.state !== state) return null;
    for (const n of panel.children) {
      if (!n.hidden && n.getAttribute("popupid") === NOTICE_ID) return n;
    }
    return null;
  }

  /** @param {any} n */
  isNotice(n) {
    return n.getAttribute("popupid") === NOTICE_ID && n.parentNode?.id === NOTICE_PANEL_ID;
  }

  /**
   * The checkbox `p` toggles in `n` while it shows: the add-on notice's pin, else null.
   * @param {any} n
   * @returns {any}
   */
  toggleOf(n) {
    if (!this.isNotice(n)) return null;
    const box = n.querySelector(`#${PIN_ID}`);
    return box && !box.hidden ? box : null;
  }

  /**
   * The topmost prompt, the one Firefox's own Esc answers (PopupNotifications), while the panel
   * is in `state`.
   * @param {string} state
   * @returns {any}
   */
  topmost(state) {
    const panel = /** @type {any} */ (this.win.document.getElementById(PANEL_ID));
    if (panel?.state !== state) return null;
    const n = panel.firstElementChild;
    return n?.localName === "popupnotification" ? n : null;
  }

  /**
   * When `n` is armed, on ChromeUtils.now()'s clock: Firefox's delay from when it last showed
   * the prompt, and ours from the last key. Infinity while Firefox has not stamped it.
   * @param {any} n
   */
  armedAt(n) {
    const shown = this.isNotice(n) ? this.noticeShownAt : n.notification?.timeShown;
    if (typeof shown !== "number") return Infinity;
    return Math.max(shown, this.lastKeyAt) + this.delay;
  }

  /** @param {Event} e */
  popup(e) {
    if (e.type === "activate") {
      // Firefox restarts its delay for an open prompt when the window is activated; the add-on
      // notice's clock does the same.
      if (this.noticeIn("open")) this.noticeShownAt = ChromeUtils.now();
      const n = this.current;
      if (n) this.arm(n);
      return;
    }
    const id = /** @type {Element} */ (e.target).id;
    if (id === NOTICE_PANEL_ID) {
      this.noticePopup(e);
      return;
    }
    if (id !== PANEL_ID) return;
    if (e.type === "popuphidden") {
      this.win.clearTimeout(this.armTimer);
      // An add-on notice under the prompt takes the keys now.
      const notice = this.noticeIn("open");
      if (notice) this.arm(notice);
      // The pop-up blocked bar's keys line and cue follow whether a prompt is open.
      this.host.changed();
      return;
    }
    if (e.type === "popupshowing") {
      // Firefox has filled the panel by now. The line goes in before it lays out, so that the
      // panel opens at its final size.
      this.lastKeyAt = 0;
      const n = this.topmost("showing");
      if (n) this.hintFor(n);
      return;
    }
    // popupshown, and popuppositioned: Firefox has just restarted its delay.
    const n = this.notification;
    if (n) this.arm(n);
    if (e.type === "popupshown") this.host.changed();
  }

  /**
   * The app menu's notice panel: the add-on notice's keys line and its own clock.
   * @param {Event} e
   */
  noticePopup(e) {
    if (e.type === "popupshowing") {
      const n = this.noticeIn("showing");
      if (n) this.hintFor(n);
      this.watchNotice(n);
    } else if (e.type === "popupshown") {
      this.noticeShownAt = ChromeUtils.now();
      const n = this.current;
      if (n) this.arm(n);
      this.host.changed();
    } else if (e.type === "popuphidden") {
      this.noticeShownAt = Infinity;
      this.watchNotice(null);
      if (!this.notification) this.win.clearTimeout(this.armTimer);
      this.host.changed();
    }
  }

  /**
   * Firefox shows the pin checkbox only once the add-on's toolbar button exists, which may be
   * after the notice opens (browser-addons.js, BrowserActionWidgetObserver). What `p` does then
   * changes, so the keys line follows and the wait starts again.
   * @param {any} n
   */
  watchNotice(n) {
    this.noticeChanged?.disconnect();
    this.noticeChanged = null;
    const box = n?.querySelector(`#${PIN_ID}`);
    if (!box) return;
    const observer = new /** @type {any} */ (this.win).MutationObserver(() => this.refresh());
    observer.observe(box, { attributes: true, attributeFilter: ["hidden", "label"] });
    this.noticeChanged = observer;
  }

  /**
   * The keys line in `n`, made and labelled after its buttons if need be; hidden while it is
   * made.
   * @param {any} n
   * @returns {HTMLElement}
   */
  hintFor(n) {
    let hint = n.querySelector(`.${HINT_CLASS}`);
    if (!hint) {
      hint = this.win.document.createElementNS(HTML_NS, "div");
      hint.className = HINT_CLASS;
      // The buttons say what they do; the line is a reminder of the keys, not a second label.
      hint.setAttribute("aria-hidden", "true");
      (n.buttonGroup ?? n).before(hint);
    }
    const secondaryHidden = n.hasAttribute("secondarybuttonhidden");
    const focus = this.focusIn(n);
    const text = doorhangerHint({
      // The add-on notice keeps Firefox's default label on the button itself (OK).
      main: n.getAttribute("buttonlabel") || n.button?.getAttribute("label") || "",
      secondary: secondaryHidden ? "" : (n.getAttribute("secondarybuttonlabel") ?? ""),
      toggle: this.toggleOf(n)?.getAttribute("label") ?? "",
      // Hint, copy and element mode keep y and n as well; Esc leaves them too.
      inField: (focus.inField || this.host.modeKeys()) && !focus.inPrompt,
    });
    if (hint.textContent !== text) {
      hint.removeAttribute(ARMED_ATTR);
      hint.textContent = text;
    }
    return hint;
  }

  /**
   * Where focus is, as `doorhangerKey` needs it: in a field (insert mode), inside the prompt `n`,
   * and in one of the prompt's own text fields.
   * @param {any} n
   */
  focusIn(n) {
    const focused = /** @type {any} */ (this.win.document).commandDispatcher?.focusedElement;
    // A prompt opened with `autofocus` (the add-on install prompt, ExtensionsUI) focuses the
    // panel itself and no element in it, so no field has focus; PopupNotifications sets
    // `noautofocus` back on the panel when it closes.
    const panelFocused = !focused && !n.parentNode?.hasAttribute("noautofocus");
    const inPrompt = panelFocused || hostChain(focused).includes(n);
    // The password prompt's fields keep their <input> in a shadow root.
    let inner = focused;
    while (inner?.shadowRoot?.activeElement) inner = inner.shadowRoot.activeElement;
    const editable =
      !!inner &&
      (inner.mozIsTextField?.(false) || inner.localName === "textarea" || inner.isContentEditable);
    return {
      inField: !panelFocused && this.host.inField(),
      inPrompt,
      promptField: inPrompt && editable,
    };
  }

  /**
   * After the mode may have changed (focus left a field, or went into one): the keys line of an
   * open prompt follows.
   */
  refresh() {
    const n = this.current;
    const hint = n?.querySelector(`.${HINT_CLASS}`);
    if (!hint) return;
    const before = hint.textContent;
    if (this.hintFor(n).textContent !== before) this.arm(n);
  }

  /**
   * Hides the keys line of `n` and shows it again once the prompt is armed.
   * @param {any} n
   */
  arm(n) {
    this.win.clearTimeout(this.armTimer);
    const hint = this.hintFor(n);
    const check = () => {
      // Firefox may have restarted its delay meanwhile; wait for the later deadline.
      const left = this.armedAt(n) - ChromeUtils.now();
      // Labels Firefox fills in late (Fluent) are in by now.
      if (left <= 0) this.hintFor(n).setAttribute(ARMED_ATTR, "");
      else if (left !== Infinity) this.armTimer = this.win.setTimeout(check, Math.ceil(left));
    };
    hint.removeAttribute(ARMED_ATTR);
    // The first look waits for the end of the event at hand: Firefox restamps `timeShown` in its
    // own listeners for the same events, which may run after this one.
    this.armTimer = this.win.setTimeout(check, 0);
  }

  /**
   * The selected page's pop-up blocked bar, stamped with when it was first seen; null while a
   * permission prompt is open, whose keys come first.
   * @returns {any}
   */
  bar() {
    const bar = this.current ? null : popupBar(this.win);
    if (this.barSeen?.bar !== bar) {
      this.barSeen = bar ? { bar, at: ChromeUtils.now() } : null;
      this.watchBar(bar);
    }
    return bar;
  }

  /**
   * Redraws the status bar when the bar leaves its box. Its close button, the options menu and
   * a navigation remove it without an event Vimma hears: Firefox's own eventCallback is the only
   * hook (notificationbox.js, _removeNotificationElement).
   * @param {any} bar
   */
  watchBar(bar) {
    this.barGone?.disconnect();
    this.barGone = null;
    if (!bar?.parentNode) return;
    const observer = new /** @type {any} */ (this.win).MutationObserver(() => {
      if (bar.isConnected) return;
      observer.disconnect();
      if (this.barGone === observer) this.barGone = null;
      this.host.changed();
    });
    observer.observe(bar.parentNode, { childList: true });
    this.barGone = observer;
  }

  /** When the bar's keys count, on ChromeUtils.now()'s clock. */
  barArmedAt() {
    return Math.max(this.barSeen?.at ?? Infinity, this.barKeyAt) + this.delay;
  }

  /**
   * The bar's keys line for the status bar once its keys count, else null (no bar, a prompt
   * open, or still waiting: the status bar is redrawn when the wait ends). The line in the bar
   * follows: armed with the same text, hidden while the keys wait, and gone in the agent
   * workspace, where no key answers the bar.
   * @returns {string | null}
   */
  popupHint() {
    const bar = this.bar();
    if (!bar) {
      // An open permission prompt takes y and n first: the bar's line must not offer them.
      popupBar(this.win)?.querySelector(`.${HINT_CLASS}`)?.removeAttribute(ARMED_ATTR);
      return null;
    }
    if (inAgentTab(this.win)) {
      bar.querySelector(`.${HINT_CLASS}`)?.remove();
      return null;
    }
    // Hint, copy and element mode, a picker and the command line keep y and n as well.
    const text = popupBarHint({
      inField: this.host.inField() || this.host.modeKeys() || this.host.otherOpen(),
      locked: popupLocked(),
    });
    const hint = this.barHintFor(bar, text);
    const left = this.barArmedAt() - ChromeUtils.now();
    if (left > 0) {
      hint?.removeAttribute(ARMED_ATTR);
      this.win.clearTimeout(this.barTimer);
      this.barTimer = this.win.setTimeout(() => this.host.changed(), Math.ceil(left));
      return null;
    }
    hint?.setAttribute(ARMED_ATTR, "");
    return text;
  }

  /**
   * The keys line in the pop-up blocked bar, made beside its button if need be. The bar's
   * buttons live in its light DOM, in the `actions` slot's container (notificationbox.js,
   * NotificationMessage.connectedCallback); null until the bar has made it.
   * @param {any} bar
   * @param {string} text
   * @returns {HTMLElement | null}
   */
  barHintFor(bar, text) {
    const box = bar.buttonContainer;
    if (!box) return null;
    let hint = box.querySelector(`.${HINT_CLASS}`);
    if (!hint) {
      hint = this.win.document.createElementNS(HTML_NS, "span");
      hint.className = HINT_CLASS;
      // The bar's button and message say what they do; the line is a reminder of the keys.
      hint.setAttribute("aria-hidden", "true");
      box.prepend(hint);
    }
    if (hint.textContent !== text) hint.textContent = text;
    return hint;
  }

  /**
   * A keydown while no prompt is open: the bar's y, n or Esc.
   * @param {KeyboardEvent} e
   * @param {any} chord
   * @returns {boolean} whether it was the bar's key (consumed)
   */
  onBarKey(e, chord) {
    const now = ChromeUtils.now();
    const bar = this.bar();
    const armed = !!bar && now >= this.barArmedAt();
    // Every key counts, with or without a bar: a key that switches to a tab with a bar starts
    // that bar's wait too.
    this.barKeyAt = now;
    if (!bar) return false;
    if (armed) this.host.changed();
    if (this.host.otherOpen()) return false;
    const result = popupBarKey(formatKey(chord), {
      open: true,
      armed,
      inField: this.host.inField(),
      pending: this.host.pending(),
      repeat: e.repeat,
      agent: inAgentTab(this.win),
      locked: popupLocked(),
    });
    if (result.kind === "pass") return false;
    e.preventDefault();
    e.stopPropagation();
    if (result.kind !== "wait") {
      answerPopupBar(this.win, result.kind);
      // Closing the bar fires no event the status bar hears.
      this.host.changed();
    }
    return true;
  }

  /**
   * A keydown in the window, before any binding.
   * @param {KeyboardEvent} e
   * @returns {boolean} whether it was the prompt's or the bar's key (consumed)
   */
  onKey(e) {
    const chord = chordFromEvent(e);
    if (!chord) return false; // a bare modifier
    const dialog = this.dialogKeys.dialogOf(e);
    if (dialog) return this.dialogKeys.onKey(e, dialog, formatKey(chord));
    const n = this.current;
    if (!n) return this.onBarKey(e, chord);
    const now = ChromeUtils.now();
    const armed = now >= this.armedAt(n);
    this.lastKeyAt = now;
    this.arm(n);
    if (this.host.otherOpen()) return false;
    const toggle = this.toggleOf(n);
    const result = doorhangerKey(formatKey(chord), {
      open: true,
      armed,
      ...this.focusIn(n),
      pending: this.host.pending(),
      repeat: e.repeat,
      toggle: !!toggle,
    });
    if (result.kind === "pass") return false;
    e.preventDefault();
    e.stopPropagation();
    if (result.kind === "allow") n.button?.click();
    else if (result.kind === "block") {
      if (!n.hasAttribute("secondarybuttonhidden")) n.secondaryButton?.click();
    } else if (result.kind === "toggle") toggle.click();
    // The add-on notice's checkbox comes first: Space toggles it there, and Tab goes on to OK.
    else if (result.kind === "focus") (toggle ?? n.footerFocusableButtons?.[0])?.focus();
    return true;
  }
}
