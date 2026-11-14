/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Hides Firefox's navigation toolbar (spec: docs/specs/toolbar-toggle.md). The pref
// vimma.ui.toolbar.hidden is one state for every window; toolbar.css hides the bar, keyed on a
// root attribute that follows it live. While the bar is hidden, each window keeps a set of
// reasons to reveal it, each asking for one of three sizes: the minimal bar (the URL field
// alone, to type an address), the prompt bar (the field with the site's identity and the
// prompts' icons, for a prompt or a panel hanging from them) or the full toolbar (a panel or an
// add-on popup hanging from a button). The reasons: the URL bar about to take focus, focus
// inside the bar, a doorhanger or a panel anchored in it, a mouse button held on it, an add-on
// popup. The largest size asked for wins; with none the bar hides again. Every reveal that focus
// or a popup needs happens before it, from Firefox's own events (`beforefocus`, `beforeselect`,
// `PopupNotificationsBeforeAnchor`, `popupshowing`), so nothing is focused in, or anchored to, a
// hidden element.

export const TOOLBAR_PREF = "vimma.ui.toolbar.hidden";
export const HIDDEN_ATTR = "vimma-toolbar-hidden";
export const REVEALED_ATTR = "vimma-toolbar-revealed";
export const MINIMAL_ATTR = "vimma-toolbar-minimal";
export const PROMPT_ATTR = "vimma-toolbar-prompt";
export const REVEAL_FAILED = "toolbar shown: the address bar could not be revealed";
export const PROMPT_REVEAL_FAILED = "toolbar shown: a prompt's icon could not be revealed";
const STYLESHEET = "chrome://browser/skin/vimma/toolbar.css";
/** F6 moves focus later than its keydown (after a remote page's reply): this long at most. */
const F6_MS = 1000;
/** A reveal held for a popup that has not opened after this long ends. */
const AWAIT_POPUP_MS = 5000;
/** Where Firefox's own toolbox rules apply instead of ours (toolbar.css). */
const FIREFOX_OWNS =
  "[customizing], [popup-window], [taskbartab], [inFullscreen], [inDOMFullscreen]";
const VISIBLE = { visibilityProperty: true };
/** In the URL field itself: the minimal bar is enough for them (its input, the suggestions). */
const IN_FIELD = ".urlbar-input-box, .urlbarView";
const WINDOW_EVENTS = [
  "keydown",
  "beforefocus",
  "beforeselect",
  "focusin",
  "focusout",
  "popupshowing",
  "popuphidden",
  "PopupNotificationsBeforeAnchor",
  "mousedown",
  "mouseup",
];

/** @typedef {"minimal" | "prompt" | "full"} Size */
/**
 * A popupshowing or popuphidden target: a popup, or, for a popup in a shadow tree, its host
 * (the window's capture listener sees the event retargeted), which has no anchor.
 * @typedef {Element & Partial<Pick<XULPopupElement, "anchorNode" | "triggerNode">>} PopupTarget
 */
/** @type {readonly Size[]} smallest first */
const SIZES = ["minimal", "prompt", "full"];

/**
 * @typedef {object} ToolbarHost  what the toolbar needs from VimmaHost
 * @property {(text: string) => void} say  the notice
 * @property {(text: string) => void} log  about:vimma's key log
 * @property {() => void} changed  the status bar may say something else now
 */

/** @type {WeakMap<Window, Toolbar>} */
const instances = new WeakMap();
/** @type {WeakSet<Window>} windows our stylesheet is loaded into (loading it twice throws) */
const styled = new WeakSet();

export class Toolbar {
  /** @param {BrowserWindow} win */
  static get(win) {
    return instances.get(win) ?? null;
  }

  /** Whether the toolbar is hidden, in every window. */
  static get hidden() {
    return Services.prefs.getBoolPref(TOOLBAR_PREF, false);
  }

  /** @param {boolean} hidden */
  static setHidden(hidden) {
    Services.prefs.setBoolPref(TOOLBAR_PREF, hidden);
  }

  /**
   * @param {BrowserWindow} win  a browser window, from its first script (before the body exists)
   * @param {ToolbarHost} host
   */
  constructor(win, host) {
    this.win = /** @type {EarlyBrowserWindow} */ (win);
    this.host = host;
    /** @type {Map<unknown, Size>} why the bar is revealed, and how much each reason asks for */
    this.reasons = new Map();
    /** @type {Set<unknown>} reasons that end once a popup anchored in the bar shows */
    this.awaiting = new Set();
    /** what the root attributes said last: "" or a size */
    this.shown = /** @type {"" | Size} */ ("");
    /** inside a PopupNotificationsBeforeAnchor: Firefox is anchoring right now */
    this.anchoring = false;
    this.onPref = () => this.apply();
    this.onEvent = (/** @type {Event} */ e) => this.handleEvent(e);
  }

  init() {
    const win = this.win;
    if (!styled.has(win)) {
      win.windowUtils.loadSheetUsingURIString(STYLESHEET, win.windowUtils.AUTHOR_SHEET);
      styled.add(win);
    }
    instances.set(win, this);
    Services.prefs.addObserver(TOOLBAR_PREF, this.onPref);
    for (const type of WINDOW_EVENTS) win.addEventListener(type, this.onEvent, true);
    win.document.documentElement.toggleAttribute(HIDDEN_ATTR, Toolbar.hidden);
  }

  uninit() {
    const win = this.win;
    Services.prefs.removeObserver(TOOLBAR_PREF, this.onPref);
    for (const type of WINDOW_EVENTS) win.removeEventListener(type, this.onEvent, true);
    for (const attr of [HIDDEN_ATTR, REVEALED_ATTR, MINIMAL_ATTR, PROMPT_ATTR]) {
      win.document.documentElement.removeAttribute(attr);
    }
    instances.delete(win);
  }

  /** Hidden, and in a state where our rules apply (toolbar.css), not Firefox's own. */
  get applies() {
    const root = this.win.document.documentElement;
    return root.hasAttribute(HIDDEN_ATTR) && !root.matches(FIREFOX_OWNS);
  }

  /**
   * Adds a reason to reveal the bar.
   * @param {unknown} key
   * @param {Size} size
   */
  hold(key, size) {
    if (this.reasons.get(key) === size) return;
    this.reasons.set(key, size);
    this.update();
  }

  /** @param {unknown} key */
  release(key) {
    this.awaiting.delete(key);
    if (this.reasons.delete(key)) this.update();
  }

  /**
   * A reason that holds until a popup anchored in the bar shows (that popup's own reason then
   * holds the bar), or AWAIT_POPUP_MS if none does: an add-on popup about to open.
   * @param {unknown} key
   * @param {Size} size
   */
  holdForPopup(key, size) {
    this.awaiting.add(key);
    this.hold(key, size);
    this.win.setTimeout(() => {
      if (this.awaiting.has(key)) this.release(key);
    }, AWAIT_POPUP_MS);
  }

  /** The pref changed: before hiding, move focus out of the bar (decision 14). */
  apply() {
    const hidden = Toolbar.hidden;
    const doc = this.win.document;
    if (hidden && this.focusInBar()) {
      // Focus in the bar: the window is up, with its gBrowser.
      /** @type {BrowserWindow} */ (this.win).gBrowser.selectedBrowser.focus();
      this.reasons.delete("urlbar");
      this.reasons.delete("focus");
    }
    doc.documentElement.toggleAttribute(HIDDEN_ATTR, hidden);
    this.update();
    // The status bar carries the hidden toolbar's cues (decision 12).
    this.host.changed();
  }

  /** @private */
  update() {
    let size = /** @type {"" | Size} */ ("");
    for (const s of this.reasons.values()) {
      if (!size || SIZES.indexOf(s) > SIZES.indexOf(size)) size = s;
    }
    const shown = this.win.document.documentElement.hasAttribute(HIDDEN_ATTR) ? size : "";
    this.reveal(shown);
    if (shown === this.shown) return;
    this.shown = shown;
    // Doorhanger anchors may have come or gone; Firefox re-anchors (not while it anchors).
    if (!this.anchoring) {
      try {
        this.win.UpdatePopupNotificationsVisibility?.();
      } catch (e) {
        console.error("vimma: toolbar", e);
      }
    }
    this.host.changed();
  }

  /**
   * Sets the root attributes toolbar.css reveals the bar from.
   * @param {"" | Size} size
   */
  reveal(size) {
    const root = this.win.document.documentElement;
    root.toggleAttribute(REVEALED_ATTR, !!size);
    // The prompt bar is the minimal one with the site's identity and the prompts' icons.
    root.toggleAttribute(MINIMAL_ATTR, size === "minimal" || size === "prompt");
    root.toggleAttribute(PROMPT_ATTR, size === "prompt");
  }

  /** @param {Event} e */
  handleEvent(e) {
    switch (e.type) {
      case "keydown":
        this.keyDown(/** @type {KeyboardEvent} */ (e));
        break;
      case "beforefocus":
      case "beforeselect":
        this.beforeUrlbarFocus(/** @type {Element} */ (e.target));
        break;
      case "focusin":
        this.focusChanged();
        this.release("f6");
        break;
      case "focusout":
        // Focus is still on its way: look once it has landed.
        if (this.inBar(e.target)) this.win.setTimeout(() => this.focusChanged(), 0);
        break;
      case "popupshowing":
        this.popupShowing(/** @type {PopupTarget | null} */ (e.target));
        break;
      case "popuphidden":
        this.popupHidden(/** @type {PopupTarget | null} */ (e.target));
        break;
      case "PopupNotificationsBeforeAnchor":
        this.beforeAnchor(/** @type {Element} */ (e.target));
        break;
      case "mousedown":
        this.pressed(e.target);
        break;
      case "mouseup":
        // After the click this mouseup makes, which opens the icon's panel (reason d).
        if (this.reasons.has("pointer")) this.win.setTimeout(() => this.release("pointer"), 0);
        break;
    }
  }

  /**
   * Reason a: the URL bar is about to take focus. Revealed now, before `focus()` runs, so focus
   * lands on a laid-out field. If it is still not visible, the toolbar comes back (decision 13).
   * @private
   * @param {Element} target
   */
  beforeUrlbarFocus(target) {
    const urlbar = this.win.gURLBar;
    if (!target?.closest?.("#urlbar") || !this.inBar(target)) return;
    this.hold("urlbar", "minimal");
    // Focus can fail or not happen at all: drop the reason once things settle.
    this.win.setTimeout(() => this.focusChanged(), 0);
    if (!this.applies || urlbar.checkVisibility(VISIBLE)) return;
    this.revealFailed(REVEAL_FAILED);
  }

  /**
   * The safety net (decision 13): what had to be revealed is still not visible, so the toolbar
   * comes back for good, before Firefox focuses or anchors to it.
   * @private
   * @param {string} text
   */
  revealFailed(text) {
    this.host.log(text);
    console.error(`vimma: ${text}`);
    Toolbar.setHidden(false);
    this.host.say(text);
  }

  /**
   * F6 and shift+F6 move focus between the page and the URL bar through the focus manager
   * (EventStateManager), which skips a collapsed bar and fires no `beforefocus`: reveal the
   * minimal bar first, as F11's toolbox does on F6 (FullScreen._keyToggleCallback).
   * @private
   * @param {KeyboardEvent} e
   */
  keyDown(e) {
    if (e.key !== "F6" || e.ctrlKey || e.altKey || e.metaKey) return;
    if (!this.applies || this.win.gURLBar?.focused) return;
    this.hold("f6", "minimal");
    this.win.setTimeout(() => this.release("f6"), F6_MS);
  }

  /**
   * Reasons a and b: the URL bar (focused, or its results open) asks for minimal; focus on an
   * item of the bar for the size that shows it: the site's identity and the prompts' icons in
   * the prompt bar, the buttons only in the full one.
   * @private
   */
  focusChanged() {
    const urlbar = this.win.gURLBar;
    if (urlbar?.focused || urlbar?.view?.isOpen) this.hold("urlbar", "minimal");
    else this.release("urlbar");
    const focused = this.focusedElement();
    if (focused && this.inBar(focused)) this.hold("focus", this.sizeFor(focused));
    else this.release("focus");
  }

  /**
   * Reason h: a mouse button goes down on the revealed bar. A click on the site's identity or a
   * prompt's icon takes focus from the field, or closes the prompt hanging from it, before the
   * click lands: the bar keeps its size until the button is up, so the click reaches the icon,
   * whose panel then holds the bar (reason d).
   * @private
   * @param {EventTarget | null} target
   */
  pressed(target) {
    if (this.shown && this.inBar(target)) this.hold("pointer", this.shown);
  }

  /**
   * The size of bar that shows `node`: the minimal bar holds the URL field and its suggestions;
   * the prompt bar the rest of the field (the site's identity, the prompts' icons, page
   * actions); the full bar everything else.
   * @private
   * @param {Element} node
   * @returns {Size}
   */
  sizeFor(node) {
    if (!node.closest("#urlbar")) return "full";
    return node.closest(IN_FIELD) ? "minimal" : "prompt";
  }

  /** Reason c: a doorhanger is about to anchor in the bar. @private @param {Element} anchor */
  beforeAnchor(anchor) {
    if (!this.inBar(anchor)) return;
    this.anchoring = true;
    try {
      this.hold("doorhanger", this.sizeFor(anchor));
      // A prompt must never open unanchored (docs/security.md C3): if its icon is still not
      // visible, the toolbar comes back before Firefox picks a fallback anchor.
      if (this.applies && !anchor.checkVisibility(VISIBLE)) this.revealFailed(PROMPT_REVEAL_FAILED);
    } finally {
      this.anchoring = false;
    }
    // A prompt that never opens (its notifications filtered out) leaves no popuphidden.
    this.win.setTimeout(() => this.doorhangerClosed(), AWAIT_POPUP_MS);
  }

  /** @private */
  doorhangerClosed() {
    if ((this.win.PopupNotifications?.panel.state ?? "closed") === "closed") {
      this.release("doorhanger");
    }
  }

  /**
   * Reason d: a panel or menu anchored in the bar holds it at the size its anchor needs, until
   * it closes, as F11's toolbox does (FullScreen._setPopupOpen).
   * @private
   * @param {PopupTarget | null} popup
   */
  popupShowing(popup) {
    if (popup?.localName === "tooltip") return;
    const anchor = popup?.anchorNode ?? popup?.triggerNode;
    if (!this.inBar(anchor)) return;
    // inBar is true only for a node with `closest`, which only an element has.
    this.hold(popup, this.sizeFor(/** @type {Element} */ (anchor)));
    for (const key of [...this.awaiting]) {
      this.awaiting.delete(key);
      this.reasons.delete(key);
    }
    this.update();
  }

  /** @private @param {PopupTarget | null} popup */
  popupHidden(popup) {
    this.release(popup);
    // A doorhanger that moves to another anchor hides and opens again: look after that.
    if (popup === this.win.PopupNotifications?.panel) {
      this.win.setTimeout(() => this.doorhangerClosed(), 0);
    }
  }

  /** @private */
  focusInBar() {
    const focused = this.focusedElement();
    return !!focused && this.inBar(focused);
  }

  /** @private @returns {Element | null} */
  focusedElement() {
    return this.win.document.commandDispatcher?.focusedElement ?? null;
  }

  /** @private @param {any} node */
  inBar(node) {
    return !!node?.closest?.("#nav-bar");
  }
}
