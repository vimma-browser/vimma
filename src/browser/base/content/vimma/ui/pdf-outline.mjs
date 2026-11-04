/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The PDF viewer's outline panel (docs/specs/pdf-mode.md decision 10): a box in the side panel's
// slot, built by its helpers (side-panel.mjs) and styled by side-panel.css, showing the outline
// the host parsed (parsePdfOutline). Keys reach it only through VimmaHost (`action`) in `index`
// mode; the logic is core pdfoutline.mjs. Titles are text only (docs/security.md section 20,
// V8; section 6, C1), and at most RENDER_CAP rows are in the DOM.

import { RENDER_CAP, renderStart } from "../core/bookmarks.mjs";
import {
  OUTLINE_TRUNCATED_TEXT,
  openOutline,
  outlineKey,
  outlineRows,
  setOutlineQuery,
} from "../core/pdfoutline.mjs";
import {
  buildPanelBox,
  emptyRow,
  giveFocusBack,
  panelElement,
  rememberFocus,
  rowsShown,
} from "./side-panel.mjs";

/** @import { OutlineEffect, OutlineRow, OutlineState, PdfOutline } from "../core/pdfoutline.mjs" */

export const OUTLINE_ID = "vimma-outline";
export const OUTLINE_FILTER_ID = "vimma-outline-filter";
const HTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * @typedef {object} OutlinePanelHost
 * @property {(browser: any, effect: OutlineEffect) => void} effect  a follow, for the host
 */

export class OutlinePanel {
  /**
   * @param {Window} win  a browser window
   * @param {OutlinePanelHost} host
   */
  constructor(win, host) {
    this.win = win;
    this.host = host;
    /** @type {HTMLElement | null} */
    this.box = null;
    /** @type {HTMLElement | null} */
    this.list = null;
    /** @type {HTMLInputElement | null} */
    this.filter = null;
    /** @type {OutlineState | null} */
    this.state = null;
    /** @type {any} the <browser> whose document the outline is */
    this.browser = null;
    /** @type {import("./side-panel.mjs").Opener | null} */
    this.opener = null;
    this.start = 0;
    // The outline belongs to one document: it closes when its tab stops being the selected one.
    this.onTabSelect = () => {
      const selected = /** @type {any} */ (this.win).gBrowser?.selectedBrowser;
      if (selected !== this.browser) this.close();
    };
  }

  get isOpen() {
    return !!this.state;
  }

  /** Typing goes to the filter, not the keymap, while it has focus. */
  get filterFocused() {
    return !!this.filter && this.win.document.activeElement === this.filter;
  }

  /**
   * Shows `outline` for `browser`'s document, with the entry for `page` selected.
   * @param {any} browser
   * @param {PdfOutline} outline
   * @param {number} page
   */
  open(browser, outline, page) {
    const box = this.box ?? this.build();
    if (!this.state) this.opener = rememberFocus(this.win);
    this.browser = browser;
    this.state = openOutline(outline, page);
    this.start = 0;
    this.endFilter();
    this.render();
    box.hidden = false;
    /** @type {any} */ (this.win).gBrowser?.tabContainer.addEventListener(
      "TabSelect",
      this.onTabSelect,
    );
    // The tree, which carries aria-activedescendant (m7-a11y).
    /** @type {HTMLElement} */ (this.list).focus();
  }

  /** Closes it; focus goes back where it was (the page). */
  close() {
    if (!this.state) return;
    this.state = null;
    this.browser = null;
    /** @type {any} */ (this.win).gBrowser?.tabContainer.removeEventListener(
      "TabSelect",
      this.onTabSelect,
    );
    const box = /** @type {HTMLElement} */ (this.box);
    // Focus first, then hide (side-panel.mjs giveFocusBack).
    giveFocusBack(this.win, box, this.opener);
    this.opener = null;
    this.endFilter();
    box.hidden = true;
  }

  /**
   * One `[modal.index]` action.
   * @param {{ id: string }} action
   */
  action(action) {
    if (!this.state) return;
    const browser = this.browser;
    const { state, effect } = outlineKey(this.state, { id: action.id, page: rowsShown(this.list) });
    if (state !== this.state) {
      const leftFilter = this.state.query !== null && state.query === null;
      this.state = state;
      if (leftFilter) this.endFilter();
      this.render();
    }
    if (!effect) return;
    if (effect.type === "filter") this.startFilter();
    else {
      this.close();
      if (effect.type === "follow") this.host.effect(browser, effect);
    }
  }

  /** @private */
  startFilter() {
    const filter = /** @type {HTMLInputElement} */ (this.filter);
    filter.hidden = false;
    filter.value = this.state?.query ?? "";
    filter.focus();
  }

  /** @private */
  endFilter() {
    const filter = this.filter;
    if (!filter) return;
    const focused = this.filterFocused;
    filter.hidden = true;
    filter.value = "";
    if (focused) this.list?.focus();
  }

  /** @private */
  onFilterInput() {
    if (!this.state) return;
    this.state = setOutlineQuery(this.state, /** @type {HTMLInputElement} */ (this.filter).value);
    this.start = 0;
    this.render();
  }

  /**
   * The filter's own keys, which reach the input rather than the keymap: Enter goes to the
   * match, the arrow keys move, Tab closes the outline. Esc, ctrl+n and ctrl+p come through the
   * host as `index` actions.
   * @private
   * @param {KeyboardEvent} e
   */
  onFilterKey(e) {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    /** @type {Record<string, string>} */
    const ids = { Enter: "index.follow", ArrowDown: "index.down", ArrowUp: "index.up" };
    const id = ids[e.key];
    if (!id && e.key !== "Tab") return;
    e.preventDefault();
    e.stopPropagation();
    if (id) this.action({ id });
    else this.close();
  }

  /** Close and remove the box (VimmaHost.uninit). */
  destroy() {
    this.close();
    this.box?.remove();
    this.box = this.list = this.filter = null;
  }

  /** @private */
  render() {
    const doc = this.win.document;
    const list = /** @type {HTMLElement} */ (this.list);
    const state = this.state;
    if (!state) return;
    const rows = outlineRows(state);
    const filtering = state.query !== null;
    const selected = Math.max(
      0,
      rows.findIndex((r) => r.selected),
    );
    const start = renderStart(rows.length, selected, this.start);
    this.start = start;
    const end = Math.min(rows.length, start + RENDER_CAP);
    /** @type {HTMLElement[]} */
    const items = [];
    /** @param {string} text */
    const more = (text) => {
      const li = panelElement(doc, "li", "vimma-outline-more", text);
      li.setAttribute("role", "none");
      return li;
    };
    list.removeAttribute("aria-describedby");
    if (start > 0) items.push(more(`… ${start} more`));
    for (let i = start; i < end; i++) {
      items.push(this.row(/** @type {OutlineRow} */ (rows[i]), i, filtering));
    }
    if (end < rows.length) items.push(more(`… ${rows.length - end} more`));
    if (!rows.length) {
      items.push(emptyRow(doc, list, `${OUTLINE_ID}-empty`, filtering ? "no match" : "no outline"));
    }
    if (state.outline.truncated && !filtering) items.push(more(OUTLINE_TRUNCATED_TEXT));
    list.replaceChildren(...items);
    const current = doc.getElementById(`${OUTLINE_ID}-${selected}`);
    if (current && rows.length) {
      list.setAttribute("aria-activedescendant", current.id);
      current.scrollIntoView({ block: "nearest" });
    } else {
      list.removeAttribute("aria-activedescendant");
    }
  }

  /**
   * One entry's row: its twisty, its title (the filter's matches marked) and its page, or in
   * the filter the titles above it. Text only.
   * @private
   * @param {OutlineRow} r
   * @param {number} i
   * @param {boolean} filtering
   */
  row(r, i, filtering) {
    const doc = this.win.document;
    const row = panelElement(doc, "li", "vimma-panel-row");
    row.id = `${OUTLINE_ID}-${i}`;
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", String(r.depth + 1));
    row.setAttribute("aria-selected", String(r.selected));
    row.dataset.entry = String(r.index);
    row.style.setProperty("--vimma-depth", String(r.depth));
    if (r.parent && !filtering) row.setAttribute("aria-expanded", String(r.open));
    const twisty = panelElement(
      doc,
      "span",
      "vimma-outline-twisty",
      r.parent && !filtering ? (r.open ? "▾" : "▸") : "",
    );
    twisty.setAttribute("aria-hidden", "true"); // aria-expanded says it
    const title = panelElement(doc, "span", "vimma-panel-title");
    let at = 0;
    for (const [s, e] of r.ranges) {
      title.append(r.title.slice(at, s), panelElement(doc, "mark", "", r.title.slice(s, e)));
      at = e;
    }
    title.append(r.title.slice(at) || (r.ranges.length ? "" : "untitled"));
    row.append(twisty, title);
    const page = r.page ? String(r.page) : r.kind === "url" ? "link" : "";
    if (page) row.append(panelElement(doc, "span", "vimma-outline-page", page));
    if (filtering && r.path) row.append(panelElement(doc, "span", "vimma-panel-host", r.path));
    return row;
  }

  /**
   * @private
   * @returns {HTMLElement}
   */
  build() {
    const { box, header, list } = buildPanelBox(this.win, {
      id: OUTLINE_ID,
      label: "Outline",
      hint: "j/k move · gg G jump · h/l fold, zO zC H L all · Enter go · / filter · Tab or Esc close",
    });
    const doc = this.win.document;
    list.setAttribute("role", "tree");
    list.setAttribute("aria-label", "Outline");
    list.id = `${OUTLINE_ID}-tree`;
    const filter = /** @type {HTMLInputElement} */ (doc.createElementNS(HTML_NS, "input"));
    filter.id = OUTLINE_FILTER_ID;
    filter.className = "vimma-outline-filter";
    filter.type = "text";
    filter.spellcheck = false;
    filter.autocomplete = "off";
    filter.placeholder = "filter";
    filter.setAttribute("aria-label", "Filter the outline");
    filter.setAttribute("aria-controls", list.id);
    filter.hidden = true;
    filter.addEventListener("input", () => this.onFilterInput());
    filter.addEventListener("keydown", (e) => this.onFilterKey(e));
    header.append(panelElement(doc, "span", "vimma-panel-name", "Outline"), filter);
    this.box = box;
    this.list = list;
    this.filter = filter;
    return box;
  }
}
