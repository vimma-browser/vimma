/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Live grep's dialog (docs/specs/live-grep.md decision 5): Telescope's horizontal layout. A
// scope box, a "Results" box and a "Live Grep" prompt box on the left, the best result at the
// bottom next to the prompt, and a "Grep Preview" box on the right that CSS hides below 900
// pixels. The dialog covers the page area, from wherever the toolbar leaves it to start. Keys
// reach it only through VimmaHost; the session (host/grep.mjs) owns the state, this renders it.
// Page text is untrusted: every row and preview line is built from text nodes and <mark>s.

import { AGENT_GLYPH } from "../core/agent.mjs";

/** @import { GrepPickerState, GrepPreview, GrepRow } from "../core/grep.mjs" */

const PREVIEW_TITLE = "Grep Preview";
/** The preview box's title cuts the selected result's tab title to this many characters. */
const PREVIEW_TAB_WIDTH = 40;

export const GREP_ID = "vimma-grep";
const STYLESHEET = "chrome://browser/skin/vimma/grep.css";
const HTML_NS = "http://www.w3.org/1999/xhtml";
/** A row's tab title is cut to this many characters (decision 5). */
const TITLE_WIDTH = 24;
/** A row shows at most this many characters of its line before the match, so it stays in view. */
const ROW_BEFORE = 16;
/**
 * @typedef {{ list: HTMLElement, query: HTMLElement, cursor: HTMLElement, marker: HTMLElement,
 *   flags: HTMLElement, count: HTMLElement, preview: HTMLElement, previewBody: HTMLElement,
 *   previewTitle: HTMLElement, scope: HTMLElement, scopeTitle: HTMLElement,
 *   scopeBody: HTMLElement, status: HTMLElement }} Parts
 */
/** @type {WeakSet<BrowserWindow>} windows our stylesheet is loaded into */
const styled = new WeakSet();

/**
 * What the prompt line shows besides the query.
 * @typedef {object} GrepInfo
 * @property {number} count  matches found
 * @property {boolean} literal  the query is matched literally
 * @property {boolean} timedOut  a frame did not answer in time
 * @property {boolean} busy  frames are still answering
 * @property {boolean} cut  a tab had more frames, or a page more text, than are searched
 * @property {boolean} tooLong  the query is longer than a frame takes; nothing was searched
 */

/**
 * @param {string} s
 * @param {number} n
 */
const cut = (s, n) => ([...s].length > n ? `${[...s].slice(0, n - 1).join("")}…` : s);

/**
 * An option's accessible name (decision 15): the line, its tab, host and workspace, and its
 * window when it is another; a closed row says it is recently closed.
 * @param {GrepRow} row
 */
function accessibleName(row) {
  const other = row.window > 1 ? [`window ${row.window}`] : [];
  if (row.kind === "closed") {
    const what = row.closedWindow ? "recently closed window" : "recently closed tab";
    return [row.title, row.url, what, ...(row.workspace ? [row.workspace] : []), ...other].join(
      ", ",
    );
  }
  const line = row.kind === "match" ? row.context : "not loaded";
  return [line, row.title, row.host, row.workspace, ...other].join(", ");
}

export class GrepPicker {
  /** @param {BrowserWindow} win  a browser window */
  constructor(win) {
    this.win = win;
    /** @type {HTMLDialogElement | null} */
    this.dialog = null;
    /** @type {Parts | null} */
    this.built = null;
    /** @type {string | null} the row id the preview shows */
    this.previewOf = null;
    this.onResize = () => this.place();
  }

  get isOpen() {
    return !!this.dialog?.open;
  }

  open() {
    if (this.isOpen) return;
    const dialog = this.dialog ?? this.build();
    this.place();
    dialog.showModal();
    this.win.addEventListener("resize", this.onResize);
    // The list, not the dialog: aria-activedescendant names the active row only while the
    // element carrying it has focus (m7-a11y).
    this.parts.list.focus();
  }

  /** Closes it; the caller decides where focus goes. */
  close() {
    if (!this.isOpen) return;
    /** @type {HTMLDialogElement} */ (this.dialog).close();
    this.win.removeEventListener("resize", this.onResize);
    this.previewOf = null;
  }

  /**
   * Fits the dialog to the page area: it starts where the page starts, below the toolbar or at
   * the window's top when the toolbar is hidden, and ends where the page ends, above the status
   * bar. Centring it in the whole window left a gap above it whenever the toolbar was hidden.
   */
  place() {
    const area = this.win.gBrowser?.tabbox?.getBoundingClientRect();
    const dialog = this.dialog;
    if (!dialog || !area?.height) return;
    dialog.style.setProperty("--vimma-grep-top", `${area.top}px`);
    dialog.style.setProperty("--vimma-grep-height", `${area.height}px`);
  }

  /** Close and remove the dialog (VimmaHost.uninit). */
  destroy() {
    this.close();
    this.dialog?.remove();
    this.dialog = null;
    this.built = null;
  }

  /** The dialog's parts; build() made them. */
  get parts() {
    return /** @type {Parts} */ (this.built);
  }

  /** Whether the preview is shown: CSS hides it in a dialog narrower than 900 pixels. */
  previewShown() {
    const preview = this.built?.preview;
    return !!preview && this.win.getComputedStyle(preview).display !== "none";
  }

  /**
   * @param {string} tag
   * @param {string} className
   * @param {string} [text]
   */
  el(tag, className, text = "") {
    const node = /** @type {HTMLElement} */ (this.win.document.createElementNS(HTML_NS, tag));
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  /**
   * `text` with [start, end] in a <mark>, into `into`.
   * @param {HTMLElement} into
   * @param {string} text
   * @param {[number, number]} at
   */
  marked(into, text, [start, end]) {
    into.append(text.slice(0, start));
    if (end > start) into.append(this.el("mark", "", text.slice(start, end)));
    into.append(text.slice(end));
  }

  /**
   * @param {GrepPickerState} state
   * @param {GrepInfo} info
   */
  render(state, info) {
    const p = this.parts;
    const dialog = /** @type {HTMLDialogElement} */ (this.dialog);
    dialog.toggleAttribute("busy", info.busy);
    p.query.textContent = state.refine ? state.refine.query : state.query;
    p.cursor.hidden = state.mode !== "search";
    p.marker.textContent = state.refine ? "fuzzy >" : ">";
    const flags = [];
    if (info.literal) flags.push("literal");
    if (state.refine) flags.push("fuzzy");
    if (info.timedOut) flags.push("timed out");
    if (info.cut) flags.push("cut");
    if (info.tooLong) flags.push("too long");
    p.flags.textContent = flags.join(" · ");
    // Closed rows are matches too, on their title or URL; not-loaded tabs are not.
    const found = (/** @type {readonly GrepRow[]} */ rows) =>
      rows.filter((r) => r.kind !== "unloaded").length;
    const matches = found(state.rows);
    const total = state.refine ? found(state.all) : info.count;
    p.count.textContent = state.query || state.refine ? `${matches} / ${total}` : "";

    const list = p.list;
    list.replaceChildren(...state.rows.map((row, i) => this.row(row, i, i === state.selected)));
    const current = list.children[state.selected];
    if (current) {
      list.setAttribute("aria-activedescendant", current.id);
      current.scrollIntoView({ block: "nearest" });
    } else {
      list.removeAttribute("aria-activedescendant");
    }
  }

  /**
   * A row: its window (`w2`), its tab (number and title, or `closed`), its host, the line
   * number and the line with the match marked; a closed row's title and URL instead of a line.
   * @param {GrepRow} row
   * @param {number} i
   * @param {boolean} selected
   */
  row(row, i, selected) {
    const li = this.el("li", "vimma-grep-row");
    li.id = `${GREP_ID}-${i}`;
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(selected));
    if (selected) li.classList.add("vimma-grep-selected");
    li.dataset.tabId = row.tabId;
    li.dataset.kind = row.kind;
    li.setAttribute("aria-label", accessibleName(row));
    const win = this.el("span", "vimma-grep-win", row.window ? `w${row.window}` : "");
    const tab = this.el("span", "vimma-grep-tab");
    if (row.agent) tab.append(this.el("span", "vimma-grep-agent", `${AGENT_GLYPH} agent`), " ");
    const text = this.el("span", "vimma-grep-text");
    const where = this.el("span", "vimma-grep-where");
    if (row.kind === "closed") {
      tab.append(row.closedWindow ? "closed window" : "closed");
      tab.classList.add("vimma-grep-closed");
      this.marked(text, row.title, row.titleAt ?? [0, 0]);
      const url = this.el("span", "vimma-grep-url");
      this.marked(url, row.url, row.urlAt ?? [0, 0]);
      text.append(" ", url);
    } else {
      tab.append(`${row.tabIndex} ${cut(row.title, TITLE_WIDTH)}`);
    }
    if (row.kind === "match") {
      if (row.frameHost) where.append(this.el("span", "vimma-grep-frame", `↳ ${row.frameHost}`));
      const [start, end] = row.at;
      let from = Math.max(0, start - ROW_BEFORE);
      const code = row.context.charCodeAt(from);
      if (code >= 0xdc00 && code <= 0xdfff) from++;
      const shown = from > 0 ? `…${row.context.slice(from)}` : row.context;
      const shift = from > 0 ? from - 1 : 0;
      this.marked(text, shown, [start - shift, end - shift]);
    } else if (row.kind === "unloaded") {
      text.textContent = "not loaded";
      text.classList.add("vimma-grep-unloaded");
    }
    where.append(text);
    li.append(
      this.el("span", "vimma-grep-marker", selected ? ">" : ""),
      win,
      tab,
      this.el("span", "vimma-grep-host", row.host),
      this.el("span", "vimma-grep-line", row.kind === "match" ? `:${row.line}:` : ""),
      where,
    );
    return li;
  }

  /**
   * The scope box: which windows, workspaces and tabs are searched (core grepScopeText).
   * @param {{ title: string, lines: string[] }} scope
   */
  setScope({ title, lines }) {
    const p = this.parts;
    p.scopeTitle.textContent = title;
    p.scopeBody.replaceChildren(
      ...lines.map((line) => this.el("div", "vimma-grep-scope-line", line)),
    );
  }

  /**
   * The preview box's title names where the selected result is: its window, workspace, tab and
   * host, so a result is never shown without its place.
   * @param {GrepRow | null} row
   */
  setPreviewTitle(row) {
    const p = this.parts;
    if (!row) {
      p.previewTitle.textContent = PREVIEW_TITLE;
      return;
    }
    const parts = [];
    if (row.window) parts.push(`w${row.window}`);
    if (row.workspace) parts.push(row.agent ? `${AGENT_GLYPH} ${row.workspace}` : row.workspace);
    if (row.kind === "closed") parts.push(row.closedWindow ? "closed window" : "closed");
    else parts.push(`${row.tabIndex} ${cut(row.title, PREVIEW_TAB_WIDTH)}`);
    if (row.host) parts.push(row.host);
    p.previewTitle.textContent = parts.join(" · ");
  }

  /**
   * The preview of the row `rowId`, or empty.
   * @param {string | null} rowId
   * @param {GrepPreview | null} preview
   */
  setPreview(rowId, preview) {
    this.previewOf = rowId;
    const body = this.parts.previewBody;
    if (!preview) {
      body.replaceChildren();
      return;
    }
    body.replaceChildren(
      ...preview.lines.map((text, i) => {
        const line = this.el("div", "vimma-grep-preview-line");
        if (i === preview.line) {
          line.classList.add("vimma-grep-preview-match");
          this.marked(line, text, preview.at);
        } else {
          line.textContent = text;
        }
        return line;
      }),
    );
    const match = body.querySelector(".vimma-grep-preview-match");
    if (match) {
      const lineTop = /** @type {HTMLElement} */ (match).offsetTop;
      body.scrollTop = lineTop - body.clientHeight / 2;
    }
  }

  /**
   * ctrl+d / ctrl+u: half the preview's height down or up.
   * @param {1 | -1} by
   */
  scrollPreview(by) {
    const body = this.parts.previewBody;
    body.scrollBy({ top: (by * body.clientHeight) / 2, behavior: "instant" });
  }

  /**
   * The live region's text (decision 15).
   * @param {string} text
   */
  announce(text) {
    if (this.parts.status.textContent !== text) this.parts.status.textContent = text;
  }

  /**
   * @private
   * @returns {HTMLDialogElement}
   */
  build() {
    const doc = this.win.document;
    if (!styled.has(this.win)) {
      this.win.windowUtils.loadSheetUsingURIString(STYLESHEET, this.win.windowUtils.AUTHOR_SHEET);
      styled.add(this.win);
    }
    const dialog = /** @type {HTMLDialogElement} */ (this.el("dialog", "vimma-grep"));
    dialog.id = GREP_ID;
    dialog.tabIndex = -1;
    dialog.setAttribute("aria-label", "Live Grep");
    dialog.setAttribute("aria-modal", "true");

    /** @param {string} className @param {string} title */
    const box = (className, title) => {
      const section = this.el("section", `vimma-grep-box ${className}`);
      section.append(this.el("h2", "vimma-grep-title", title));
      return section;
    };
    const scope = box("vimma-grep-scope", "Scope");
    scope.setAttribute("role", "region");
    scope.setAttribute("aria-label", "Scope");
    const scopeTitle = /** @type {HTMLElement} */ (scope.firstChild);
    const scopeBody = this.el("div", "vimma-grep-scope-body");
    scope.append(scopeBody);

    const results = box("vimma-grep-results", "Results");
    const list = this.el("ul", "vimma-grep-list");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Results");
    // Focusable by script only: keys reach the picker through VimmaHost, not Tab.
    list.tabIndex = -1;
    results.append(list);

    const prompt = box("vimma-grep-prompt", "Live Grep");
    const input = this.el("div", "vimma-grep-input");
    const marker = this.el("span", "vimma-grep-prompt-marker", ">");
    const query = this.el("span", "vimma-grep-query");
    const cursor = this.el("span", "vimma-grep-cursor");
    const flags = this.el("span", "vimma-grep-flags");
    const count = this.el("span", "vimma-grep-count");
    input.append(marker, query, cursor, flags, count);
    prompt.append(input);

    const left = this.el("div", "vimma-grep-left");
    left.append(scope, results, prompt);

    const preview = box("vimma-grep-preview", PREVIEW_TITLE);
    preview.setAttribute("role", "region");
    preview.setAttribute("aria-label", PREVIEW_TITLE);
    const previewTitle = /** @type {HTMLElement} */ (preview.firstChild);
    const previewBody = this.el("div", "vimma-grep-preview-body");
    preview.append(previewBody);

    const status = this.el("div", "vimma-grep-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    const body = this.el("div", "vimma-grep-body");
    body.append(left, preview);
    dialog.append(body, status);
    doc.body.append(dialog);
    this.dialog = dialog;
    this.built = {
      list,
      query,
      cursor,
      marker,
      flags,
      count,
      preview,
      previewBody,
      previewTitle,
      scope,
      scopeTitle,
      scopeBody,
      status,
    };
    return dialog;
  }
}
