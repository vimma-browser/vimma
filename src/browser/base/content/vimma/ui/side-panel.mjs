/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The side panel (spec: docs/specs/m3-workspaces.md, "Side panel" and sub-spec 6): our own box,
// the first child of #browser, not a SidebarController panel (decision 4). It lists the current
// workspace's tabs; keys reach it only through VimmaHost (`action`) in `panel` mode. The logic
// is core sidepanel.mjs, this only renders it.

import { WORKSPACE_COLOR_TOKENS } from "../core/statusbar.mjs";
import {
  gutterOf,
  inRange,
  markSummary,
  openPanel,
  panelKey,
  refreshPanel,
} from "../core/sidepanel.mjs";
import { PRIVATE_COLOR_TOKEN, PRIVATE_GLYPH } from "../core/privatews.mjs";

/** @import { PanelOptions, PanelState, PanelTabInfo } from "../core/sidepanel.mjs" */
/** @import { Workspaces } from "../core/workspaces.mjs" */

export const PANEL_ID = "vimma-panel";
const STYLESHEET = "chrome://browser/skin/vimma/side-panel.css";
const HTML_NS = "http://www.w3.org/1999/xhtml";
/** @type {WeakSet<Window>} windows our stylesheet is loaded into (once: a second load throws) */
const styled = new WeakSet();
/** Tab events that change a row: re-render while open. */
const TAB_EVENTS = ["TabOpen", "TabClose", "TabSelect", "TabAttrModified", "TabMove"];

/**
 * @typedef {object} SidePanelHost
 * @property {() => Workspaces | null} model  the window's workspaces, tabs in window order
 * @property {(tabId: string) => PanelTabInfo | undefined} info
 * @property {() => string | undefined} color  the active workspace's colour name
 * @property {() => PanelOptions | undefined} [where]  the private workspace's head and
 *   neighbours (docs/specs/private-workspace.md decision 6)
 * @property {(tabId: string) => void} select  a row was picked; the panel closes right after
 * @property {(text: string) => void} say  a refusal for the notice
 * @property {(tabId: string) => void} closeTab  `x`: close that tab; the panel stays open
 * @property {(tabId: string) => void} [move]  `m`: ask which workspace gets that tab; the panel
 *   has closed already
 * @property {(tabIds: string[], focus: string, alone?: string) => string | null} together
 *   `Enter` with marks: show those tabs as the workspace's panes
 *   (docs/specs/m4-side-panel-multiselect.md), or with `alone` keep them as a hidden view and show
 *   that tab by itself (side-panel-unsplit decision 25); a refusal's text, or null once done (the
 *   panel then closes)
 * @property {() => { panes: string[], focus: string | null, hidden?: boolean } | null} [split]
 *   the active workspace's split, its tabs (row ids), focused pane's tab and whether it is a
 *   hidden view; null without one
 *   (docs/specs/side-panel-unsplit.md)
 * @property {(tabId: string) => void} [alone]  `Enter` down to one mark or none: end the split
 *   and show that tab alone (side-panel-unsplit); the panel then closes
 */

export class SidePanel {
  /**
   * @param {Window} win  a browser window
   * @param {SidePanelHost} host
   */
  constructor(win, host) {
    this.win = win;
    this.host = host;
    /** @type {HTMLElement | null} */
    this.box = null;
    /** @type {HTMLElement | null} */
    this.list = null;
    /** @type {HTMLElement | null} the marks' count, a status (m4-side-panel-multiselect) */
    this.count = null;
    /** @type {PanelState | null} */
    this.state = null;
    /** @type {Opener | null} focus before open, for close */
    this.opener = null;
    this.onTabEvent = () => this.refresh();
    // Firefox moves focus to the page at the end of every tab switch (Tabbrowser.sys.mjs
    // _adjustFocusBeforeTabSwitch blurs chrome, AsyncTabSwitcher then focuses the browser), so a
    // switch made from the panel (ctrl+b ), prefix+c) would leave it without focus.
    this.onSwitchDone = () => {
      const el = this.win.document.activeElement;
      if (this.isOpen && el?.localName === "browser") this.list?.focus();
    };
  }

  get isOpen() {
    return !!this.state;
  }

  /** @returns {boolean} whether it opened (a window without workspaces has nothing to list) */
  open() {
    if (this.isOpen) return true;
    const model = this.host.model();
    if (!model) return false;
    const box = this.box ?? this.build();
    this.opener = rememberFocus(this.win);
    this.state = openPanel(model, this.host.info, this.#options());
    this.render();
    box.hidden = false;
    const tabs = this.#tabContainer();
    for (const type of TAB_EVENTS) tabs?.addEventListener(type, this.onTabEvent);
    this.win.addEventListener("TabSwitchDone", this.onSwitchDone);
    // The list, which carries aria-activedescendant (m7-a11y).
    /** @type {HTMLElement} */ (this.list).focus();
    return true;
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  /**
   * Closes it; focus goes to the selected page when it was in the panel, or nowhere (a tab
   * switch just blurred the panel: Tabbrowser's _adjustFocusBeforeTabSwitch).
   */
  close() {
    if (!this.isOpen) return;
    this.state = null;
    const tabs = this.#tabContainer();
    for (const type of TAB_EVENTS) tabs?.removeEventListener(type, this.onTabEvent);
    this.win.removeEventListener("TabSwitchDone", this.onSwitchDone);
    const box = /** @type {HTMLElement} */ (this.box);
    // Focus first, then hide: hiding the focused list would drop focus to the body.
    giveFocusBack(this.win, box, this.opener);
    this.opener = null;
    box.hidden = true;
  }

  /**
   * One `[modal.panel]` action (panel.down, panel.up, panel.open, panel.select, panel.close,
   * panel.close_tab, panel.mark, panel.visual, panel.move).
   * @param {{ id: string, arg?: number }} action
   */
  action(action) {
    if (!this.state) return;
    const { state, effect } = panelKey(this.state, action);
    if (state !== this.state) {
      this.state = state;
      this.render();
    }
    if (effect?.type === "close") this.close();
    if (effect?.type === "refuse") this.host.say(effect.text);
    // The highlight is on the next row already: the TabClose refresh keeps it there.
    if (effect?.type === "closeTab") this.host.closeTab(effect.id);
    // Closed first, so the picker that asks where takes focus from the page, not the panel.
    if (effect?.type === "move") {
      this.close();
      this.host.move?.(effect.id);
    }
    // Select first, so closing focuses the new page, not the one being left.
    if (effect?.type === "select") {
      this.host.select(effect.id);
      this.close();
    }
    // Ending the split first, then closing focuses the tab shown alone (side-panel-unsplit).
    if (effect?.type === "alone") {
      this.host.alone?.(effect.id);
      this.close();
    }
    // Refused (past [panes] max): nothing changed, so the panel stays open with its marks.
    if (effect?.type === "together") {
      const refused = this.host.together(effect.ids, effect.focus, effect.alone);
      if (refused) this.host.say(refused);
      else this.close();
    }
  }

  /** The model or a tab changed (ctrl+b ), a new tab, a title): list it again. */
  refresh() {
    if (!this.state) return;
    const model = this.host.model();
    if (!model) {
      this.close();
      return;
    }
    this.state = refreshPanel(this.state, model, this.host.info, this.#options());
    this.render();
  }

  /** Close and remove the box (VimmaHost.uninit). */
  destroy() {
    this.close();
    this.box?.remove();
    this.box = this.list = this.count = null;
  }

  /** @returns {PanelOptions} */
  #options() {
    const split = this.host.split?.();
    return {
      color: this.host.color(),
      ...this.host.where?.(),
      ...(split ? { panes: split.panes, paneFocus: split.focus, paneHidden: !!split.hidden } : {}),
    };
  }

  #tabContainer() {
    return /** @type {{ gBrowser?: { tabContainer: EventTarget } }} */ (
      /** @type {unknown} */ (this.win)
    ).gBrowser?.tabContainer;
  }

  /** @private */
  render() {
    const state = /** @type {PanelState} */ (this.state);
    const doc = this.win.document;
    /**
     * @param {string} tag
     * @param {string} className
     * @param {string} [text]
     */
    const el = (tag, className, text = "") => {
      const node = /** @type {HTMLElement} */ (doc.createElementNS(HTML_NS, tag));
      node.className = className;
      node.textContent = text;
      return node;
    };
    const box = /** @type {HTMLElement} */ (this.box);
    const header = /** @type {HTMLElement} */ (box.querySelector(".vimma-panel-header"));
    const { workspace: w } = state;
    const tokens = /** @type {Record<string, string>} */ (WORKSPACE_COLOR_TOKENS);
    // The private workspace: ◆ in the theme's magenta, no number (private-workspace 6).
    const dot = el("span", "vimma-panel-dot", w.private ? PRIVATE_GLYPH : "●");
    dot.setAttribute("aria-hidden", "true"); // the workspace's colour, nothing to read
    const colour = w.private
      ? PRIVATE_COLOR_TOKEN
      : (w.color && tokens[w.color]) || "--vimma-accent";
    dot.style.color = `var(${colour})`;
    const neighbours =
      state.previous === null
        ? ""
        : `ctrl+b ( ${state.previous} · ctrl+b ) ${/** @type {string} */ (state.next)}`;
    header.replaceChildren(
      dot,
      el("span", "vimma-panel-name", w.private ? w.name : `${w.index}:${w.name}`),
      el("span", "vimma-panel-neighbours", neighbours),
    );

    // m4-side-panel-multiselect decision 14: a persistent status, so a change is announced.
    const summary = markSummary(state);
    const count = /** @type {HTMLElement} */ (this.count);
    if (count.textContent !== summary) count.textContent = summary;

    const list = /** @type {HTMLElement} */ (this.list);
    list.setAttribute("aria-label", `Tabs in ${w.name}`);
    // aria-selected stays the highlight (m7-a11y); marks are the options' checked state, given
    // only while there is something marked, a range or a split (side-panel-unsplit), so a plain
    // list reads as before.
    const checkable = state.marked.length > 0 || state.anchor !== null || state.panes.length > 0;
    const marked = new Set(state.marked);
    list.replaceChildren(
      ...state.rows.map((r, i) => {
        const row = el("li", "vimma-panel-row");
        row.id = `${PANEL_ID}-${i}`;
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(i === state.selected));
        row.dataset.tabId = r.tabId;
        if (r.active) row.classList.add("vimma-panel-active");
        const isMarked = marked.has(r.tabId);
        const ranged = inRange(state, i);
        if (checkable) row.setAttribute("aria-checked", String(isMarked));
        if (isMarked) row.classList.add("vimma-panel-marked");
        if (ranged) row.classList.add("vimma-panel-in-range");
        const glyph = gutterOf(state, i);
        // A pane that leaves the split on Enter (side-panel-unsplit decision 16).
        if (glyph === "○") row.classList.add("vimma-panel-leaving");
        const gutter = el("span", "vimma-panel-mark", glyph);
        gutter.setAttribute("aria-hidden", "true"); // aria-checked says it
        const marks = [r.playing ? "♪" : "", r.foreign ? "foreign" : ""].filter(Boolean);
        row.append(
          gutter,
          el("span", "vimma-panel-number", String(r.number)),
          el("span", "vimma-panel-title", r.display),
          el("span", "vimma-panel-host", r.host),
        );
        if (marks.length) row.append(el("span", "vimma-panel-marks", marks.join(" ")));
        return row;
      }),
    );
    if (!state.rows.length) list.append(emptyRow(doc, list, `${PANEL_ID}-empty`, "no tabs"));
    else list.removeAttribute("aria-describedby");
    const current = list.children[state.selected];
    if (current && state.rows.length) {
      list.setAttribute("aria-activedescendant", current.id);
      current.scrollIntoView({ block: "nearest" });
    } else {
      list.removeAttribute("aria-activedescendant");
    }
  }

  /**
   * @private
   * @returns {HTMLElement}
   */
  build() {
    const { box, header, list } = buildPanelBox(this.win, {
      id: PANEL_ID,
      label: "Side panel",
      hint: "j/k move · 1-9 or Enter go · space V mark, Enter splits or unsplits · x close tab · m move tab · Esc close",
    });
    const count = panelElement(this.win.document, "div", "vimma-panel-count");
    count.setAttribute("role", "status");
    header.after(count);
    this.box = box;
    this.list = list;
    this.count = count;
    return box;
  }
}

/**
 * @typedef {{ el: Element | null, tab: Element | null }} Opener  focus when a panel opened
 * @typedef {{ selectedTab: Element, selectedBrowser: HTMLElement }} PanelTabs
 */

/** @param {Window} win */
function tabsOf(win) {
  return /** @type {{ gBrowser?: PanelTabs }} */ (/** @type {unknown} */ (win)).gBrowser;
}

/**
 * Where focus is as a panel opens, to give it back when it closes (spec m7-a11y).
 * @param {Window} win
 * @returns {Opener}
 */
export function rememberFocus(win) {
  return { el: Services.focus.focusedElement, tab: tabsOf(win)?.selectedTab ?? null };
}

/**
 * Before a panel hides: when focus is in it, or nowhere, it goes back where it was when the
 * panel opened; to the selected page instead after a tab switch (a row picked, ctrl+b c) or
 * when that element is gone. Focus elsewhere (a click into the page) stays put.
 * @param {Window} win
 * @param {Element} box  the panel
 * @param {Opener | null} opener
 */
export function giveFocusBack(win, box, opener) {
  const doc = win.document;
  const el = doc.activeElement;
  if (el && el !== doc.body && !box.contains(el)) return;
  const tabs = tabsOf(win);
  const back = opener?.el;
  if (back?.isConnected && !box.contains(back) && opener?.tab === tabs?.selectedTab) {
    /** @type {HTMLElement} */ (back).focus();
  } else {
    tabs?.selectedBrowser.focus();
  }
}

/**
 * A line in a list that is not a row ("no tabs", "loading…"): no option or treeitem, so the list
 * counts no row for it, and the list describes itself with it (m7-a11y).
 * @param {Document} doc
 * @param {HTMLElement} list
 * @param {string} id
 * @param {string} text
 * @param {string} [className]
 */
export function emptyRow(doc, list, id, text, className = "vimma-panel-empty") {
  const row = panelElement(doc, "li", className, text);
  row.id = id;
  row.setAttribute("role", "none");
  list.setAttribute("aria-describedby", id);
  return row;
}

/**
 * An element in the XHTML namespace with a class and text (never HTML).
 * @param {Document} doc
 * @param {string} tag
 * @param {string} className
 * @param {string} [text]
 */
export function panelElement(doc, tag, className, text = "") {
  const node = /** @type {HTMLElement} */ (doc.createElementNS(HTML_NS, tag));
  node.className = className;
  node.textContent = text;
  return node;
}

/**
 * A hidden panel box in the left slot (the first child of #browser), styled by side-panel.css:
 * a header, a listbox and a key hint. The side panel and the bookmarks panel
 * (docs/specs/bookmarks.md) are each one.
 * @param {Window} win
 * @param {{ id: string, label: string, hint: string }} options
 */
export function buildPanelBox(win, { id, label, hint }) {
  const doc = win.document;
  if (!styled.has(win)) {
    win.windowUtils.loadSheetUsingURIString(STYLESHEET, win.windowUtils.AUTHOR_SHEET);
    styled.add(win);
  }
  // A XUL vbox, as Firefox's own children of the #browser hbox (browser-box.inc.xhtml).
  const box = /** @type {HTMLElement} */ (
    /** @type {{ createXULElement: (tag: string) => Element }} */ (
      /** @type {unknown} */ (doc)
    ).createXULElement("vbox")
  );
  box.id = id;
  box.className = "vimma-side-panel";
  box.hidden = true;
  box.setAttribute("role", "region");
  box.setAttribute("aria-label", label);
  box.tabIndex = -1;
  const header = panelElement(doc, "header", "vimma-panel-header");
  const list = panelElement(doc, "ul", "");
  list.setAttribute("role", "listbox");
  // Focusable by script only: it carries aria-activedescendant; keys come through VimmaHost.
  list.tabIndex = -1;
  const footer = panelElement(doc, "footer", "vimma-panel-hint", hint);
  box.append(header, list, footer);
  /** @type {Element} */ (doc.getElementById("browser")).prepend(box);
  return { box, header, list };
}
