/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The `:` command line (spec: docs/specs/m1-cmdline.md). A chrome-level <input> in our own
// container at the bottom of the window, above the status bar when there is one. VimmaHost
// opens and cancels it (`command.open`, `command.cancel` on Esc) and runs what it parses; the
// input's own keydown handles the line's editing keys: Tab / shift+Tab, Up / Down and Enter.

import {
  completeCommandLine,
  createHistory,
  historyNext,
  historyPrevious,
  parseCommandLine,
  pushHistory,
} from "../core/cmdline.mjs";

/** @import { Candidate, CommandError, CommandResult, History } from "../core/cmdline.mjs" */

export const CMDLINE_ID = "vimma-cmdline";
export const CMDLINE_INPUT_ID = "vimma-cmdline-input";
const LIST_ID = "vimma-cmdline-completions";
const STATUSBAR_ID = "vimma-statusbar";
const STYLESHEET = "chrome://browser/skin/vimma/cmdline.css";
const HTML_NS = "http://www.w3.org/1999/xhtml";
/** @type {WeakSet<Window>} windows our stylesheet is loaded into */
const styled = new WeakSet();

/** Set on the chrome root while the line is open (cmdline.css moves the notice above it). */
const OPEN_ATTR = "vimma-cmdline-open";
/** The open line's height on the chrome root, for the notice. */
const HEIGHT_VAR = "--vimma-cmdline-height";

/** @typedef {{ history: History }} HistoryStore  the entries; cursors stay per command line */

/**
 * The entries every non-private window of the session shares, in memory (Vim's history is
 * global too). A private window gets its own store, dropped with the window, and never writes
 * here. Persisting this later (a file in the profile, not a pref) must keep that rule: nothing
 * typed in a private window is stored (spec, Settled).
 * @type {HistoryStore}
 */
const sharedHistory = { history: createHistory() };

/**
 * Loads cmdline.css into `win` once (loading it twice throws); the rename prompt shares it.
 * @param {Window} win
 */
export function loadCmdlineSheet(win) {
  if (styled.has(win)) return;
  win.windowUtils.loadSheetUsingURIString(STYLESHEET, win.windowUtils.AUTHOR_SHEET);
  styled.add(win);
}

/** @param {Window} win */
function isPrivate(win) {
  const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  );
  return /** @type {boolean} */ (PrivateBrowsingUtils.isWindowPrivate(win));
}

/**
 * @typedef {object} Callbacks
 * @property {(result: Extract<CommandResult, { kind: "run" }>) => void} run
 * @property {() => void} [changed]  after it opens or closes (the status bar's mode)
 * @property {() => import("../core/cmdline.mjs").CompletionArgs} [args]  what commands'
 *   arguments complete to (`{ addon: names }`)
 * @property {() => readonly string[]} [hidden]  action ids whose commands do not exist now (an
 *   unfinished feature's, while its pref is off)
 */

export class CommandLine {
  /**
   * @param {Window} win  a browser window
   * @param {Callbacks} callbacks  `run` gets a parsed line once the command line has closed
   */
  constructor(win, { run, changed = () => {}, args = () => ({}), hidden = () => [] }) {
    this.win = win;
    this.run = run;
    this.changed = changed;
    this.args = args;
    this.hidden = hidden;
    /** @type {HTMLElement | null} */
    this.el = null;
    /** @type {HTMLInputElement | null} */
    this.input = null;
    /** @type {HTMLElement | null} */
    this.list = null;
    /** @type {HTMLElement | null} */
    this.error = null;
    /** @type {Element | null} focused before open; close() returns focus there */
    this.opener = null;
    /** @type {{ candidates: Candidate[], index: number } | null} while Tab cycles */
    this.cycle = null;
    /** @type {HistoryStore} */
    this.store = isPrivate(win) ? { history: createHistory() } : sharedHistory;
    /** This line's own history cursor: another window browsing the shared entries keeps it. */
    /** @type {{ index: number | null, draft: string }} */
    this.cursor = { index: null, draft: "" };
    /** @type {ResizeObserver | null} */
    this.resizeObserver = null;
  }

  get isOpen() {
    return !!this.el && !this.el.hidden;
  }

  /** @param {string} [text]  the line to start with (`open ` for an unbound `open_url` key) */
  open(text = "") {
    const root = this.win.document.documentElement;
    // Not over a fullscreen page (a video): Firefox hides its chrome there, as the bar does.
    if (!this.isOpen && root.hasAttribute("inDOMFullscreen")) return;
    const input = this.input ?? this.build().input;
    if (!this.isOpen) {
      this.opener = Services.focus.focusedElement;
      input.value = text;
      this.cycle = null;
      this.showError(null);
      this.resetCursor();
      /** @type {HTMLElement} */ (this.el).hidden = false;
      root.setAttribute(OPEN_ATTR, "true");
      this.refreshList();
    }
    input.focus();
    this.changed();
  }

  /**
   * Hides the line. Focus goes back to what had it before `:` unless focus already moved on
   * (`restoreFocus: false`); after a tab switch, or when that element is gone, to the selected
   * browser.
   * @param {{ restoreFocus?: boolean, tabChanged?: boolean }} [options]
   */
  close({ restoreFocus = true, tabChanged = false } = {}) {
    if (!this.isOpen) return;
    const opener = this.opener;
    this.opener = null;
    this.cycle = null;
    this.resetCursor();
    // Focus first, then hide: hiding the focused input would drop focus to nowhere.
    if (tabChanged || (restoreFocus && !opener?.isConnected)) {
      /** @type {{ gBrowser?: { selectedBrowser: HTMLElement } }} */ (
        /** @type {unknown} */ (this.win)
      ).gBrowser?.selectedBrowser.focus();
    } else if (restoreFocus) {
      /** @type {HTMLElement} */ (opener).focus();
    }
    /** @type {HTMLElement} */ (this.el).hidden = true;
    this.win.document.documentElement.removeAttribute(OPEN_ATTR);
    this.changed();
  }

  /** Close and remove the element (VimmaHost.uninit). */
  destroy() {
    this.close({ restoreFocus: false });
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.win.document.documentElement.style.removeProperty(HEIGHT_VAR);
    this.el?.remove();
    this.el = this.input = this.list = this.error = null;
  }

  /**
   * The line's own keys. The host has already seen the event: Esc and ctrl+b sequences never
   * get here; everything else passes through to the input.
   * @private
   * @param {KeyboardEvent} e
   */
  onKeyDown(e) {
    if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    const input = /** @type {HTMLInputElement} */ (this.input);
    switch (e.key) {
      case "Tab":
        this.complete(e.shiftKey ? -1 : 1);
        break;
      case "ArrowUp":
      case "ArrowDown": {
        const step = e.key === "ArrowUp" ? historyPrevious : historyNext;
        const view = Object.freeze({ ...this.store.history, ...this.cursor });
        const next = step(view, input.value);
        this.cursor = { index: next.history.index, draft: next.history.draft };
        input.value = next.text;
        this.cycle = null;
        this.showError(null);
        this.refreshList();
        break;
      }
      case "Enter":
        this.submit();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  /** @private */
  onInput() {
    this.cycle = null;
    this.resetCursor();
    this.showError(null);
    this.refreshList();
  }

  /**
   * Focus left the input. Moving elsewhere in the window (a click, `ctrl+b c`) closes the line
   * without running it; the window losing focus (alt+tab) keeps it, so it is there on return.
   * @private
   */
  onFocusOut() {
    this.win.setTimeout(() => {
      const doc = this.win.document;
      if (this.isOpen && doc.activeElement !== this.input && doc.hasFocus()) {
        this.close({ restoreFocus: false });
      }
    }, 0);
  }

  /** @private */
  resetCursor() {
    this.cursor = { index: null, draft: "" };
  }

  /** @private */
  submit() {
    const input = /** @type {HTMLInputElement} */ (this.input);
    const line = input.value;
    const result = parseCommandLine(line, { hidden: this.hidden() });
    this.store.history = pushHistory(this.store.history, line);
    this.resetCursor();
    if (result.kind === "error") {
      this.cycle = null;
      this.renderList([]);
      this.showError(result.error);
      return;
    }
    // Close first: the command then finds focus where `:` was pressed (a page for
    // `:scroll_down`), and may move it (`:tabnew` focuses the new tab's URL bar).
    this.close();
    if (result.kind === "run") this.run(result);
  }

  /**
   * Tab: the next candidate for the command word (shift+Tab: the previous), wrapping.
   * @private
   * @param {1 | -1} direction
   */
  complete(direction) {
    const input = /** @type {HTMLInputElement} */ (this.input);
    if (!this.cycle) {
      const { candidates } = completeCommandLine(input.value, {
        args: this.args(),
        hidden: this.hidden(),
      });
      if (!candidates.length) return;
      this.cycle = { candidates, index: direction > 0 ? 0 : candidates.length - 1 };
      this.renderList(candidates);
    } else {
      const n = this.cycle.candidates.length;
      this.cycle.index = (this.cycle.index + direction + n) % n;
    }
    const { candidates, index } = this.cycle;
    input.value = /** @type {Candidate} */ (candidates[index]).value;
    this.markSelected(index);
  }

  /**
   * The list follows typing while the line is just the command word.
   * @private
   */
  refreshList() {
    const value = /** @type {HTMLInputElement} */ (this.input).value;
    const word = value.replace(/^[\s:]*/, "");
    this.renderList(
      word
        ? completeCommandLine(value, { args: this.args(), hidden: this.hidden() }).candidates
        : [],
    );
  }

  /**
   * @private
   * @param {Candidate[]} candidates
   */
  renderList(candidates) {
    const list = /** @type {HTMLElement} */ (this.list);
    const doc = this.win.document;
    list.replaceChildren(
      ...candidates.map((c, i) => {
        const row = /** @type {HTMLElement} */ (doc.createElementNS(HTML_NS, "li"));
        row.id = `${LIST_ID}-${i}`;
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", "false");
        row.dataset.value = c.value;
        row.dataset.kind = c.kind;
        const name = doc.createElementNS(HTML_NS, "span");
        name.className = "vimma-cmdline-name";
        name.textContent = c.label ?? c.value;
        const description = doc.createElementNS(HTML_NS, "span");
        description.className = "vimma-cmdline-description";
        description.textContent = c.description;
        row.append(name, description);
        return row;
      }),
    );
    list.hidden = candidates.length === 0;
    /** @type {HTMLInputElement} */ (this.input).removeAttribute("aria-activedescendant");
    /** @type {HTMLInputElement} */ (this.input).setAttribute(
      "aria-expanded",
      String(candidates.length > 0),
    );
  }

  /**
   * @private
   * @param {number} index
   */
  markSelected(index) {
    const list = /** @type {HTMLElement} */ (this.list);
    const input = /** @type {HTMLInputElement} */ (this.input);
    for (const [i, row] of [...list.children].entries()) {
      row.setAttribute("aria-selected", String(i === index));
      if (i === index) {
        input.setAttribute("aria-activedescendant", row.id);
        row.scrollIntoView({ block: "nearest" });
      }
    }
  }

  /**
   * @private
   * @param {CommandError | null} error  null clears it
   */
  showError(error) {
    const el = /** @type {HTMLElement} */ (this.error);
    if (!error) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    const hint =
      error.code === "unknown-command" && error.suggestions.length
        ? `; did you mean ${error.suggestions.map((s) => `:${s}`).join(", ")}?`
        : "";
    el.textContent = `${error.message}${hint}`;
    el.hidden = false;
  }

  /**
   * @private
   * @returns {{ input: HTMLInputElement }}
   */
  build() {
    const doc = this.win.document;
    loadCmdlineSheet(this.win);
    /**
     * @param {string} tag
     * @param {string} [className]
     */
    const el = (tag, className) => {
      const node = /** @type {HTMLElement} */ (doc.createElementNS(HTML_NS, tag));
      if (className) node.className = className;
      return node;
    };

    const container = el("div");
    container.id = CMDLINE_ID;
    container.hidden = true;
    const panel = el("div", "vimma-cmdline-panel");

    const list = el("ul");
    list.id = LIST_ID;
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Completions");
    list.hidden = true;

    const row = el("div", "vimma-cmdline-row");
    const prompt = el("span", "vimma-cmdline-prompt");
    prompt.textContent = ":";
    prompt.setAttribute("aria-hidden", "true");
    const input = /** @type {HTMLInputElement} */ (el("input"));
    input.id = CMDLINE_INPUT_ID;
    input.type = "text";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-label", "Command line");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", LIST_ID);
    input.setAttribute("aria-expanded", "false");
    input.addEventListener("keydown", (e) => this.onKeyDown(e));
    input.addEventListener("input", () => this.onInput());
    input.addEventListener("focusout", () => this.onFocusOut());
    row.append(prompt, input);

    const error = el("div", "vimma-cmdline-error");
    error.setAttribute("role", "alert");
    error.hidden = true;

    panel.append(list, row, error);
    container.append(panel);
    // In the body's flex column: before the status bar if there is one, else right after
    // #browser, so the line sits at the window's foot either way.
    const statusBar = doc.getElementById(STATUSBAR_ID);
    const browser = doc.getElementById("browser");
    if (statusBar) statusBar.before(container);
    else if (browser) browser.after(container);
    else doc.body.append(container);

    const Observer = /** @type {Window & { ResizeObserver: typeof ResizeObserver }} */ (this.win)
      .ResizeObserver;
    const observer = new Observer(() => {
      if (!this.isOpen) return;
      const height = Math.ceil(panel.getBoundingClientRect().height);
      doc.documentElement.style.setProperty(HEIGHT_VAR, `${height}px`);
    });
    observer.observe(panel);
    this.resizeObserver = observer;

    this.el = container;
    this.input = input;
    this.list = list;
    this.error = error;
    return { input };
  }
}
