/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The tab line (spec: docs/specs/tab-line.md): one row of text at the top of the window listing
// the current workspace's tabs. vimma-core decides what it says (tabline.mjs); this module draws
// it into #navigator-toolbox before #nav-bar, at most once per frame, and never reads layout on
// the render path: the row's width and its font's column come from a ResizeObserver, as the
// status bar's do. It has no tab stop and no key or pointer handler (decision 17).

import { TABLINE_SETTINGS, TABLINE_WIDTH } from "../core/defaults.mjs";
import { fitTabLine, nextTabLineSetting, tabLineEntries, tabLineShown } from "../core/tabline.mjs";

/** @import { TabLineLabels, TabLineFit } from "../core/tabline.mjs" */
/** @import { TabLineSetting } from "../core/defaults.mjs" */
/** @import { PanelState } from "../core/sidepanel.mjs" */

export const TABLINE_ID = "vimma-tabline";
/** `[ui] tabline` in force, in every window (decision 5); `:tabline` writes it too. */
export const TABLINE_PREF = "vimma.ui.tabline";
/** Set on the root while the line is drawn: the status bar and tests read it. */
export const TABLINE_ATTR = "vimma-tabline";
const STYLESHEET = "chrome://browser/skin/vimma/tabline.css";
const HTML_NS = "http://www.w3.org/1999/xhtml";
/** Characters in the probe that measures one column of the line's font. */
const PROBE_CHARS = 10;
// As the status bar's: a title, a rename (SSTabRestoring), sound and the tabs themselves.
const TAB_EVENTS = [
  "TabSelect",
  "TabOpen",
  "TabClose",
  "TabMove",
  "TabAttrModified",
  "TabShow",
  "TabHide",
  "SSTabRestoring",
];
/** @type {WeakSet<Window>} windows our sheet is loaded into (loading one twice throws) */
const styled = new WeakSet();
/** @type {Set<TabLine>} */
const instances = new Set();

/**
 * `[ui] tabline_width` and `[statusbar] tab` from config.toml, for every window; ConfigHost
 * sets them. A change redraws every line and status bar.
 */
export const TabLineConfig = {
  /** @type {number} */
  width: TABLINE_WIDTH.default,
  statusTab: true,
  /** @param {{ width: number, statusTab: boolean }} next */
  set({ width, statusTab }) {
    if (width === this.width && statusTab === this.statusTab) return;
    this.width = width;
    this.statusTab = statusTab;
    for (const line of instances) {
      line.schedule();
      line.host.changed();
    }
  },
};

/**
 * @typedef {object} TabLineHost  what the line needs from VimmaHost
 * @property {() => PanelState | null} rows  the side panel's rows (SidePanel.snapshot)
 * @property {() => TabLineLabels | null} labels  gb's labels while they show
 * @property {(fn: () => void) => () => void} subscribe  host state changes; returns unsubscribe
 * @property {() => void} changed  whether the line is drawn changed: the status bar may differ
 */

export class TabLine {
  /** @param {BrowserWindow} win */
  static get(win) {
    for (const line of instances) if (line.win === win) return line;
    return null;
  }

  /** @returns {TabLineSetting} */
  static get setting() {
    const v = Services.prefs.getStringPref(TABLINE_PREF, "off");
    return /** @type {readonly string[]} */ (TABLINE_SETTINGS).includes(v)
      ? /** @type {TabLineSetting} */ (v)
      : "off";
  }

  /** @param {TabLineSetting} setting */
  static set setting(setting) {
    Services.prefs.setStringPref(TABLINE_PREF, setting);
  }

  /**
   * `:tabline` (decision 6): hides the line where `win` draws it, else shows it, in every window.
   * @param {BrowserWindow} win
   * @returns {boolean} whether it is shown now
   */
  static toggle(win) {
    const next = nextTabLineSetting(!!TabLine.get(win)?.drawn);
    TabLine.setting = next;
    return next !== "off";
  }

  /**
   * @param {BrowserWindow} win  a browser window, possibly before its body exists
   * @param {TabLineHost} host
   */
  constructor(win, host) {
    this.win = /** @type {EarlyBrowserWindow} */ (win);
    this.host = host;
    /** @type {HTMLElement | null} */
    this.line = null;
    /** @type {HTMLElement | null} */
    this.list = null;
    /** @type {HTMLElement | null} */
    this.probe = null;
    this.width = 0;
    this.column = 0;
    this.frame = 0;
    this.last = "";
    /** whether the last render drew the line */
    this.drawn = false;
    /** @type {string[]} the tab ids in line order, from the last render */
    this.ids = [];
    /** @type {ResizeObserver | null} */
    this.resize = null;
    /** @type {(() => void) | null} */
    this.unsubscribe = null;
    this.update = () => this.schedule();
    this.start = () => this.build();
  }

  init() {
    instances.add(this);
    Services.prefs.addObserver(TABLINE_PREF, this.update);
    if (this.win.document.readyState === "loading") {
      this.win.addEventListener("DOMContentLoaded", this.start, { once: true });
    } else {
      this.build();
    }
  }

  uninit() {
    const win = this.win;
    instances.delete(this);
    Services.prefs.removeObserver(TABLINE_PREF, this.update);
    win.removeEventListener("DOMContentLoaded", this.start);
    if (this.frame) win.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.resize?.disconnect();
    this.resize = null;
    if (this.line) for (const type of TAB_EVENTS) win.removeEventListener(type, this.update, true);
    this.line?.remove();
    this.line = this.list = this.probe = null;
    win.document.documentElement.removeAttribute(TABLINE_ATTR);
  }

  /** Mark dirty; one render per frame however many triggers fire. */
  schedule() {
    if (this.frame || !this.line) return;
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  /**
   * The tab ids in line order, as drawn or as they would be: gb labels them (decision 12).
   * @returns {string[]}
   */
  tabIds() {
    return (this.host.rows()?.rows ?? []).map((r) => r.tabId);
  }

  /** @private */
  build() {
    const win = /** @type {BrowserWindow} */ (this.win);
    const doc = win.document;
    const navBar = doc.getElementById("nav-bar");
    if (this.line || !navBar) return;
    if (!styled.has(win)) {
      win.windowUtils.loadSheetUsingURIString(STYLESHEET, win.windowUtils.AUTHOR_SHEET);
      styled.add(win);
    }
    const el = (/** @type {string} */ tag, /** @type {string} */ className) => {
      const node = /** @type {HTMLElement} */ (doc.createElementNS(HTML_NS, tag));
      node.className = className;
      return node;
    };
    const line = el("div", "vimma-tabline");
    line.id = TABLINE_ID;
    // Not a live region: the switch is said by the status bar's, not every change (decision 18).
    line.setAttribute("aria-label", "Tab line");
    line.hidden = true;
    this.list = el("div", "vimma-tabline-list");
    this.probe = el("span", "vimma-tabline-probe");
    this.probe.setAttribute("aria-hidden", "true");
    this.probe.textContent = "0".repeat(PROBE_CHARS);
    line.append(this.list, this.probe);
    // Above the address bar, which toolbar.css takes out of the flow when hidden (decision 2).
    navBar.before(line);
    this.line = line;

    this.resize = new win.ResizeObserver((entries) => {
      let refit = false;
      for (const entry of entries) {
        if (entry.target === this.line) {
          this.width = entry.contentBoxSize[0]?.inlineSize ?? entry.contentRect.width;
          refit = true;
        } else if (entry.target === this.probe) {
          const w = entry.contentRect.width / PROBE_CHARS;
          if (w > 0 && w !== this.column) {
            this.column = w;
            refit = true;
          }
        }
      }
      if (refit) this.schedule();
    });
    this.resize.observe(line);
    this.resize.observe(this.probe);
    for (const type of TAB_EVENTS) win.addEventListener(type, this.update, true);
    this.unsubscribe = this.host.subscribe(this.update);
    this.schedule();
  }

  /** @private */
  render() {
    const line = this.line;
    if (!line) return;
    const panel = this.host.rows();
    const rows = panel?.rows ?? [];
    const labels = this.host.labels();
    const drawn = tabLineShown(TabLine.setting, rows.length, !!labels) && rows.length > 0;
    this.ids = rows.map((r) => r.tabId);
    if (drawn !== this.drawn) {
      this.drawn = drawn;
      line.hidden = !drawn;
      this.win.document.documentElement.toggleAttribute(TABLINE_ATTR, drawn);
      this.host.changed();
    }
    if (!drawn) return;
    // Hidden, the row has no width yet: draw at a generous width, the ResizeObserver refits.
    const columns =
      this.column > 0 && this.width > 0 ? Math.floor(this.width / this.column + 0.01) : 200;
    const fit = fitTabLine(tabLineEntries(rows, panel?.panes ?? []), {
      width: columns,
      nameWidth: TabLineConfig.width,
      labels,
    });
    const key = JSON.stringify([fit, labels?.typed ?? null]);
    if (key === this.last) return;
    this.last = key;
    /** @type {HTMLElement} */ (this.list).replaceChildren(...this.draw(fit, labels));
  }

  /**
   * @private
   * @param {TabLineFit} fit
   * @param {TabLineLabels | null} labels
   */
  draw(fit, labels) {
    const doc = this.win.document;
    const el = (/** @type {string} */ className, /** @type {string} */ text = "") => {
      const node = /** @type {HTMLElement} */ (doc.createElementNS(HTML_NS, "span"));
      node.className = className;
      node.textContent = text;
      return node;
    };
    /** A glyph shown, its words read in its place (m7-a11y: no meaning by glyph alone). */
    const glyph = (/** @type {string} */ shown, /** @type {string} */ words) => {
      const seen = el("vimma-tabline-glyph", shown);
      seen.setAttribute("aria-hidden", "true");
      return [seen, el("vimma-tabline-sr", words)];
    };
    /** @type {HTMLElement[]} */
    const out = [];
    if (fit.before) {
      const more = el("vimma-tabline-more", `‹${fit.before}`);
      more.dataset.side = "before";
      out.push(more);
    }
    for (const item of fit.items) {
      const tab = el("vimma-tabline-tab");
      tab.dataset.number = String(item.number);
      if (item.current) tab.setAttribute("current", "");
      if (item.label) {
        const label = el("vimma-tabline-label");
        const typed = labels?.typed ?? "";
        if (typed) label.append(el("vimma-tabline-typed", typed.toUpperCase()));
        label.append(doc.createTextNode(item.label.slice(typed.length).toUpperCase()));
        label.dataset.label = item.label;
        tab.append(label, doc.createTextNode(" "));
      }
      tab.append(el("vimma-tabline-number", String(item.number)));
      if (item.pane) tab.append(...glyph("▪", " in a pane"));
      if (item.name) tab.append(doc.createTextNode(" "), el("vimma-tabline-name", item.name));
      if (item.playing) tab.append(doc.createTextNode(" "), ...glyph("♪", "playing sound"));
      out.push(tab);
    }
    if (fit.after) {
      const more = el("vimma-tabline-more", `${fit.after}›`);
      more.dataset.side = "after";
      out.push(more);
    }
    return out;
  }
}
