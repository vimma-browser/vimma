/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Firefox's permission prompts (doorhangers) from the keyboard (docs/specs/toolbar-toggle.md
// decision 11a). VimmaHost hands every keydown here from its capture listener, after the agent
// question's: `y` clicks the prompt's main button, `n` its secondary one, `Tab` moves focus onto
// its buttons (where Firefox's own Tab, arrow keys, Enter and Space work), and Esc stays
// Firefox's. As the agent question line (agent-ui.mjs), the prompt never takes focus by itself,
// a key counts only once it is armed, and a key typed on through it (any key) starts the delay
// again, so typing never answers it; keys typed in a field are the field's. The delay is
// Firefox's own for these prompts (security.notification_enable_delay), whose buttons also
// refuse a click before it (PopupNotifications._onButtonEvent). A line in the prompt names the
// keys once it is armed.
//
// The delay counts from Firefox's own clock for the prompt, `notification.timeShown`, which
// Firefox moves forward whenever the panel is repositioned or resized ("popuppositioned") or the
// window is activated. A key armed on a clock of our own could reach a button Firefox still
// refuses, and the key would be lost. For the same reason the keys line keeps its place in the
// panel while hidden: showing it must not resize the panel and so restart Firefox's delay.

import { doorhangerHint, doorhangerKey } from "../core/prompt-keys.mjs";
import { chordFromEvent, formatKey } from "../core/keys.mjs";

const DELAY_PREF = "security.notification_enable_delay";
const DEFAULT_DELAY_MS = 500;
const PANEL_ID = "notification-popup";
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
    this.armTimer = 0;
    this.onPopup = (/** @type {Event} */ e) => this.popup(e);
  }

  init() {
    for (const type of EVENTS) this.win.addEventListener(type, this.onPopup, true);
  }

  uninit() {
    for (const type of EVENTS) this.win.removeEventListener(type, this.onPopup, true);
    this.win.clearTimeout(this.armTimer);
  }

  get delay() {
    return Math.max(0, Services.prefs.getIntPref(DELAY_PREF, DEFAULT_DELAY_MS));
  }

  /** The prompt shown in the open doorhanger panel, or null. @returns {any} */
  get notification() {
    return this.topmost("open");
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
    const shown = n.notification?.timeShown;
    if (typeof shown !== "number") return Infinity;
    return Math.max(shown, this.lastKeyAt) + this.delay;
  }

  /** @param {Event} e */
  popup(e) {
    if (e.type === "activate") {
      // Firefox restarts its delay for an open prompt when the window is activated.
      const n = this.notification;
      if (n) this.arm(n);
      return;
    }
    if (/** @type {Element} */ (e.target).id !== PANEL_ID) return;
    if (e.type === "popuphidden") {
      this.win.clearTimeout(this.armTimer);
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
    const text = doorhangerHint({
      main: n.getAttribute("buttonlabel") ?? "",
      secondary: secondaryHidden ? "" : (n.getAttribute("secondarybuttonlabel") ?? ""),
    });
    if (hint.textContent !== text) {
      hint.removeAttribute(ARMED_ATTR);
      hint.textContent = text;
    }
    return hint;
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
      if (left <= 0) hint.setAttribute(ARMED_ATTR, "");
      else if (left !== Infinity) this.armTimer = this.win.setTimeout(check, Math.ceil(left));
    };
    hint.removeAttribute(ARMED_ATTR);
    // The first look waits for the end of the event at hand: Firefox restamps `timeShown` in its
    // own listeners for the same events, which may run after this one.
    this.armTimer = this.win.setTimeout(check, 0);
  }

  /**
   * A keydown in the window, before any binding.
   * @param {KeyboardEvent} e
   * @returns {boolean} whether it was the prompt's key (consumed)
   */
  onKey(e) {
    const n = this.notification;
    if (!n) return false;
    const chord = chordFromEvent(e);
    if (!chord) return false; // a bare modifier
    const now = ChromeUtils.now();
    const armed = now >= this.armedAt(n);
    this.lastKeyAt = now;
    this.arm(n);
    if (this.host.otherOpen()) return false;
    const focused = /** @type {any} */ (this.win.document).commandDispatcher?.focusedElement;
    // A prompt opened with `autofocus` (the add-on install prompt, ExtensionsUI) focuses the
    // panel itself and no element in it, so no field has focus; PopupNotifications sets
    // `noautofocus` back on the panel when it closes.
    const panelFocused = !focused && !n.parentNode?.hasAttribute("noautofocus");
    const inPrompt = panelFocused || hostChain(focused).includes(n);
    const result = doorhangerKey(formatKey(chord), {
      open: true,
      armed,
      inField: !panelFocused && this.host.inField(),
      inPrompt,
      pending: this.host.pending(),
      repeat: e.repeat,
    });
    if (result.kind === "pass") return false;
    e.preventDefault();
    e.stopPropagation();
    if (result.kind === "allow") n.button?.click();
    else if (result.kind === "block") {
      if (!n.hasAttribute("secondarybuttonhidden")) n.secondaryButton?.click();
    } else if (result.kind === "focus") n.footerFocusableButtons?.[0]?.focus();
    return true;
  }
}
