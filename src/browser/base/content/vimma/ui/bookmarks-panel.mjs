/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The bookmarks panel (spec: docs/specs/bookmarks.md): a box in the side panel's slot, built by
// its helpers (side-panel.mjs) and styled by side-panel.css, listing Places' bookmarks as a
// tree. Keys reach it only through VimmaHost (`action`) in `panel` mode; the logic is core
// bookmarks.mjs, the Places calls host/bookmark-ops.mjs. Text only, at most RENDER_CAP rows.

import {
  RENDER_CAP,
  bookmarksKey,
  openBookmarks,
  refreshBookmarks,
  renderStart,
  setBookmarksQuery,
} from "../core/bookmarks.mjs";
import {
  PanelNumbers,
  buildPanelBox,
  emptyRow,
  giveFocusBack,
  panelElement,
  rememberFocus,
  rowsShown,
} from "./side-panel.mjs";
import { rowNumber } from "../core/sidepanel.mjs";

/** @import { BookmarksEffect, BookmarksState, Folder, Row } from "../core/bookmarks.mjs" */

export const BOOKMARKS_ID = "vimma-bookmarks";
export const FILTER_ID = "vimma-bookmarks-filter";
const HTML_NS = "http://www.w3.org/1999/xhtml";
/** Places events in one burst (an import, Sync) re-read the tree once, after this delay. */
const RELOAD_DELAY_MS = 30;

/**
 * @typedef {object} BookmarksPanelHost
 * @property {() => Promise<Folder>} load  the tree from Places
 * @property {(fn: () => void) => () => void} observe  Places changes; returns the unsubscribe
 * @property {(effect: BookmarksEffect) => void} effect  an open, add, rename, move, delete,
 *   yank or refusal for the host to carry out
 */

/**
 * An empty workspace folder or Bookmarks Toolbar (docs/specs/bookmarks.md, decisions 2 and
 * 11): what the panel shows, how to add to it, and how to see the bookmarks it leaves out. Not
 * a row: the tree describes itself with it, as with "no bookmarks".
 * @param {Document} doc
 * @param {HTMLElement} list
 * @param {Folder} tree
 */
function emptyState(doc, list, tree) {
  const li = emptyRow(
    doc,
    list,
    `${BOOKMARKS_ID}-empty`,
    "",
    "vimma-panel-empty vimma-bookmarks-empty",
  );
  /**
   * @param {string} tag
   * @param {string} text
   */
  const el = (tag, text) => panelElement(doc, tag, "", text);
  const add = el("p", "Press ");
  add.append(el("kbd", "a"), " to add the current page here.");
  if (tree.root === "workspace") {
    const others = el("p", "Bookmarks outside workspace folders show with ");
    others.append(
      el("code", 'root = "toolbar"'),
      " or ",
      el("code", 'root = "all"'),
      " under ",
      el("code", "[bookmarks]"),
      " in config.toml.",
    );
    li.append(
      panelElement(doc, "p", "vimma-bookmarks-empty-title", `No bookmarks in ${tree.title} yet`),
      el("p", `This panel shows workspace ${tree.title}'s folder in the Bookmarks Toolbar.`),
      add,
      others,
    );
    return li;
  }
  const all = el("p", "To list every bookmark, set ");
  all.append(el("code", 'root = "all"'), " under ", el("code", "[bookmarks]"), " in config.toml.");
  li.append(
    panelElement(doc, "p", "vimma-bookmarks-empty-title", "The Bookmarks Toolbar is empty"),
    el("p", "This panel shows the Bookmarks Toolbar."),
    add,
    all,
  );
  return li;
}

/**
 * What a row shows under its title: a bookmark's site (its folder path in the filter's flat
 * list), nothing for a folder.
 * @param {Row} row
 * @param {boolean} filtering
 */
function subtitle(row, filtering) {
  if (row.kind === "folder") return "";
  if (filtering) return row.path;
  try {
    const url = new URL(row.url);
    return url.host || url.protocol;
  } catch {
    return row.url;
  }
}

export class BookmarksPanel {
  /**
   * @param {Window} win  a browser window
   * @param {BookmarksPanelHost} host
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
    /** @type {HTMLElement | null} the header's title */
    this.name = null;
    /** @type {BookmarksState | null} null until the tree has loaded */
    this.state = null;
    this.opened = false;
    /** Kept from one opening to the next, for this window's session. */
    /** @type {readonly string[]} */
    this.expanded = [];
    /** @type {string | null} */
    this.lastGuid = null;
    /** The first rendered row and the rows it was rendered from. */
    this.start = 0;
    /** @type {readonly Row[] | null} */
    this.rendered = null;
    /** Whether the rendered rows carry numbers (`[panel] numbers`). */
    this.numbered = false;
    /** @type {(() => void) | null} */
    this.unobserve = null;
    /** @type {number | null} */
    this.reloadTimer = null;
    this.generation = 0;
    /** @type {string | null} the window's workspace, as the host last said it */
    this.workspace = null;
    /** The next load starts afresh: a workspace switch (other folders, other rows). */
    this.fresh = false;
    /** @type {import("./side-panel.mjs").Opener | null} focus before open, for close */
    this.opener = null;
    this.onSwitchDone = () => {
      const el = this.win.document.activeElement;
      if (this.isOpen && el?.localName === "browser") this.list?.focus();
    };
  }

  get isOpen() {
    return this.opened;
  }

  /** Whether the Places observer is in place (only while open). */
  get observing() {
    return !!this.unobserve;
  }

  /** Typing goes to the filter, not the keymap, while it has focus. */
  get filterFocused() {
    return !!this.filter && this.win.document.activeElement === this.filter;
  }

  /** The current tree, once loaded. */
  get tree() {
    return this.state?.tree ?? null;
  }

  open() {
    if (this.opened) return;
    const box = this.box ?? this.build();
    this.opener = rememberFocus(this.win);
    this.opened = true;
    this.state = null;
    this.rendered = null;
    this.render();
    box.hidden = false;
    this.unobserve = this.host.observe(() => this.scheduleReload());
    this.win.addEventListener("TabSwitchDone", this.onSwitchDone);
    // The tree, which carries aria-activedescendant (m7-a11y).
    /** @type {HTMLElement} */ (this.list).focus();
    this.reload();
  }

  toggle() {
    if (this.opened) this.close();
    else this.open();
  }

  /** Closes it; focus goes to the page when it was in the panel. */
  close() {
    if (!this.opened) return;
    this.opened = false;
    this.generation++;
    if (this.state) {
      this.expanded = this.state.expanded;
      this.lastGuid = this.state.rows[this.state.selected]?.guid ?? null;
    }
    this.state = null;
    this.unobserve?.();
    this.unobserve = null;
    if (this.reloadTimer !== null) this.win.clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
    this.win.removeEventListener("TabSwitchDone", this.onSwitchDone);
    const box = /** @type {HTMLElement} */ (this.box);
    // Focus first, then hide (side-panel.mjs giveFocusBack).
    giveFocusBack(this.win, box, this.opener);
    this.opener = null;
    /** @type {HTMLInputElement} */ (this.filter).hidden = true;
    box.hidden = true;
  }

  /** Focus back on the list (after a prompt, Enter in the filter). */
  focus() {
    if (this.opened) this.list?.focus();
  }

  /**
   * One `[modal.panel]` action: `panel.*` and `bookmarks.*`, with its count.
   * @param {{ id: string, arg?: number, count?: number }} action
   */
  action(action) {
    // Still loading: only Esc means something.
    if (!this.state) {
      if (action.id === "panel.close") this.close();
      return;
    }
    const page = rowsShown(this.list);
    const { state, effect } = bookmarksKey(this.state, { ...action, page });
    if (state !== this.state) {
      this.state = state;
      if (!state.query) this.endFilter();
      this.render();
    }
    if (!effect) return;
    if (effect.type === "close") this.close();
    else if (effect.type === "filter") this.startFilter();
    else this.host.effect(effect);
  }

  /** Re-reads Places soon, once for a burst of changes. */
  scheduleReload() {
    if (!this.opened || this.reloadTimer !== null) return;
    this.reloadTimer = this.win.setTimeout(() => {
      this.reloadTimer = null;
      this.reload();
    }, RELOAD_DELAY_MS);
  }

  /**
   * The window's workspace (an id and name, or null): a change re-reads the panel afresh, as
   * it shows that workspace's folder (docs/specs/bookmarks.md, decision 11).
   * @param {string | null} key
   */
  setWorkspace(key) {
    if (key === this.workspace) return;
    const switched = this.workspace?.split("\n")[0] !== key?.split("\n")[0];
    this.workspace = key;
    if (!this.opened) return;
    if (switched) this.fresh = true;
    this.scheduleReload();
  }

  /** @private */
  reload() {
    const generation = ++this.generation;
    this.host
      .load()
      .then((tree) => {
        if (!this.opened || generation !== this.generation) return;
        const fresh = this.fresh;
        this.fresh = false;
        this.state =
          this.state && !fresh
            ? refreshBookmarks(this.state, tree)
            : openBookmarks(tree, {
                expanded: fresh ? [] : this.expanded,
                selectedGuid: fresh ? null : this.lastGuid,
              });
        if (fresh) this.endFilter();
        this.render();
      })
      .catch((e) => console.error("vimma: bookmarks could not be read", e));
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
    const filter = /** @type {HTMLInputElement} */ (this.filter);
    const focused = this.filterFocused;
    filter.hidden = true;
    filter.value = "";
    if (focused) this.list?.focus();
  }

  /** @private */
  onFilterInput() {
    if (!this.state) return;
    this.state = setBookmarksQuery(this.state, /** @type {HTMLInputElement} */ (this.filter).value);
    this.render();
  }

  /**
   * Enter keeps the filter and gives the keys back to the list. Esc comes through the host as
   * panel.close, which clears it.
   * @private
   * @param {KeyboardEvent} e
   */
  onFilterKey(e) {
    if (e.key !== "Enter" || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (!this.state?.query) this.endFilter();
    else this.list?.focus();
  }

  /** Close and remove the box (VimmaHost.uninit). */
  destroy() {
    this.close();
    this.box?.remove();
    this.box = this.list = this.filter = this.name = null;
  }

  /** @private */
  render() {
    const doc = this.win.document;
    const list = /** @type {HTMLElement} */ (this.list);
    const state = this.state;
    if (!state) {
      list.replaceChildren(emptyRow(doc, list, `${BOOKMARKS_ID}-empty`, "loading…"));
      list.setAttribute("aria-busy", "true");
      list.removeAttribute("aria-activedescendant");
      return;
    }
    list.removeAttribute("aria-busy");
    const { rows, selected } = state;
    const filtering = !!state.query.trim();
    const toolbar = state.tree.root === "toolbar" || state.tree.root === "workspace";
    const name =
      state.tree.root === "workspace"
        ? state.tree.title
        : state.tree.root === "toolbar"
          ? "Bookmarks Toolbar"
          : "Bookmarks";
    if (this.name && this.name.textContent !== name) this.name.textContent = name;
    const start = renderStart(rows.length, selected, this.start);
    // The tree has no stable numbers: distances only, with "relative" or "hybrid"
    // (docs/specs/side-panel-counts.md decision 7).
    const numbered = PanelNumbers.mode !== "absolute";
    if (rows === this.rendered && start === this.start && numbered === this.numbered) {
      // Only the highlight moved, within the rendered window.
      for (const li of list.querySelectorAll("[role=treeitem][aria-selected=true]")) {
        li.setAttribute("aria-selected", "false");
      }
    } else {
      this.start = start;
      this.rendered = rows;
      this.numbered = numbered;
      const end = Math.min(rows.length, start + RENDER_CAP);
      const items = [];
      /** A "… n more" line: not a row of the tree. @param {string} text */
      const more = (text) => {
        const li = panelElement(doc, "li", "vimma-bookmarks-more", text);
        li.setAttribute("role", "none");
        return li;
      };
      list.removeAttribute("aria-describedby");
      if (start > 0) items.push(more(`… ${start} more`));
      for (let i = start; i < end; i++) {
        const r = /** @type {Row} */ (rows[i]);
        const row = panelElement(doc, "li", "vimma-panel-row");
        row.id = `${BOOKMARKS_ID}-${i}`;
        row.setAttribute("role", "treeitem");
        row.setAttribute("aria-level", String(r.depth + 1));
        row.setAttribute("aria-selected", "false");
        row.dataset.guid = r.guid;
        row.style.setProperty("--vimma-depth", String(r.depth));
        if (r.kind === "folder") {
          row.classList.add("vimma-bookmarks-folder");
          row.setAttribute("aria-expanded", String(r.open));
        }
        const twisty = panelElement(
          doc,
          "span",
          "vimma-bookmarks-twisty",
          r.kind === "folder" ? (r.open ? "▾" : "▸") : "",
        );
        twisty.setAttribute("aria-hidden", "true"); // aria-expanded says it
        if (numbered) {
          row.classList.add("vimma-bookmarks-numbered");
          const number = panelElement(doc, "span", "vimma-panel-number");
          number.setAttribute("aria-hidden", "true"); // a distance, for 4j: nothing to read
          row.append(number);
        }
        row.append(twisty, panelElement(doc, "span", "vimma-panel-title", r.title));
        const sub = subtitle(r, filtering);
        if (sub) row.append(panelElement(doc, "span", "vimma-panel-host", sub));
        items.push(row);
      }
      if (end < rows.length) items.push(more(`… ${rows.length - end} more`));
      if (!rows.length && toolbar && !filtering) items.push(emptyState(doc, list, state.tree));
      else if (!rows.length) {
        const text = filtering ? "no match" : "no bookmarks";
        items.push(emptyRow(doc, list, `${BOOKMARKS_ID}-empty`, text));
      }
      list.replaceChildren(...items);
    }
    if (numbered) {
      for (const li of list.querySelectorAll("[role=treeitem]")) {
        const i = Number(/** @type {HTMLElement} */ (li).id.slice(BOOKMARKS_ID.length + 1));
        const number = li.querySelector(".vimma-panel-number");
        if (number) number.textContent = String(rowNumber("relative", i, selected));
      }
    }
    const current = doc.getElementById(`${BOOKMARKS_ID}-${selected}`);
    if (current && rows.length) {
      current.setAttribute("aria-selected", "true");
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
      id: BOOKMARKS_ID,
      label: "Bookmarks",
      hint: "j/k move, 4j · gg G jump · h/l fold · Enter t s S open · a A r m d y edit · / filter · Esc close",
    });
    const doc = this.win.document;
    // Folders open and close: a tree of treeitems with levels, not a flat listbox (m7-a11y).
    list.setAttribute("role", "tree");
    list.setAttribute("aria-label", "Bookmarks");
    list.id = `${BOOKMARKS_ID}-tree`;
    const filter = /** @type {HTMLInputElement} */ (doc.createElementNS(HTML_NS, "input"));
    filter.id = FILTER_ID;
    filter.className = "vimma-bookmarks-filter";
    filter.type = "text";
    filter.spellcheck = false;
    filter.autocomplete = "off";
    filter.placeholder = "filter";
    filter.setAttribute("aria-label", "Filter bookmarks");
    filter.setAttribute("aria-controls", list.id);
    filter.hidden = true;
    filter.addEventListener("input", () => this.onFilterInput());
    filter.addEventListener("keydown", (e) => this.onFilterKey(e));
    const name = panelElement(doc, "span", "vimma-panel-name", "Bookmarks");
    header.append(name, filter);
    this.name = name;
    this.box = box;
    this.list = list;
    this.filter = filter;
    return box;
  }
}
