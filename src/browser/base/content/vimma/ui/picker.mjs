/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The `prefix+g` goto picker, which is tab search (specs: docs/specs/m2-picker-rename.md,
// docs/specs/tab-search.md), and the `prefix+w`
// workspace picker (docs/specs/m3-workspaces.md, sub-spec 5). A modal <dialog> in the chrome
// document, as the help overlay. Keys reach it only through VimmaHost (`key`), which consumes
// every one while it is open; the logic is core picker.mjs, this only renders it.

import { addonRowText } from "../core/addons.mjs";
import { AGENT_GLYPH } from "../core/agent.mjs";
import { itemId, openPicker, pickerKey, sectionOf, setPickerItems } from "../core/picker.mjs";
import { accessibleName, countText, rowRange, sectionHeading } from "../core/tabsearch.mjs";

/** @import { AnyItem, AddonOp, PickerItem, PickerState, WorkspaceItem } from "../core/picker.mjs" */
/** @import { AddonItem } from "../core/addons.mjs" */
/** @import { LogItem } from "../core/picker.mjs" */

export const PICKER_ID = "vimma-picker";
export const WORKSPACE_PICKER_ID = "vimma-workspace-picker";
export const ADDON_PICKER_ID = "vimma-addon-picker";
export const MCP_LOG_ID = "vimma-mcp-log";
const STYLESHEET = "chrome://browser/skin/vimma/picker.css";
const HTML_NS = "http://www.w3.org/1999/xhtml";
/** @type {WeakSet<Window>} windows our stylesheet is loaded into */
const styled = new WeakSet();

/**
 * @typedef {object} PickerHost
 * @property {() => AnyItem[]} items  what to list, in order
 * @property {() => string | null} activeId  selected when the picker opens
 * @property {(id: string) => void} select  Enter on a row; the picker has closed already
 * @property {(id: string) => void} [reopen]  Enter on a recently closed row; closed already
 * @property {(id: string) => void} [move]  `m` on a workspace row; the picker has closed already
 * @property {(op: AddonOp, id: string) => void} [addon]  an add-on key; the picker stays open
 */

/**
 * What one kind of picker shows: its dialog id, heading, hint, and a row's cells after the index.
 * @typedef {object} PickerLook
 * @property {string} id
 * @property {string} title
 * @property {string} listLabel
 * @property {string} hint
 * @property {(item: any) => [index: string, right: string]} cells
 * @property {string} [empty]  the list's one row when there are no items
 * @property {boolean} [tabs]  tab search (docs/specs/tab-search.md): typing from the first
 *   key, section headings, a muted cell for workspace, window and markers, host highlights,
 *   accessible names and a live count
 */

/** @type {PickerLook} */
const GOTO = {
  id: PICKER_ID,
  title: "Tabs",
  listLabel: "Tabs",
  hint: "type to search · ctrl+n/p move · Tab section · Enter go · Esc close",
  cells: (/** @type {PickerItem} */ item) => [
    item.closed ? "" : String(item.tabIndex),
    item.closedWindow ? closedWindowText(item.tabCount ?? 0) : hostOf(item.url),
  ],
  tabs: true,
};

/** @param {number} n */
function closedWindowText(n) {
  return `${n} ${n === 1 ? "tab" : "tabs"}`;
}

/**
 * Tab search's muted cell: workspace (`◇` for the agent's), window, markers (decision 4).
 * @param {PickerItem} item
 * @returns {{ text: string, className: string }[]}
 */
function metaParts(item) {
  /** @type {{ text: string, className: string }[]} */
  const parts = [];
  if (item.agent) parts.push({ text: AGENT_GLYPH, className: "vimma-picker-agent" });
  if (item.workspaceName) parts.push({ text: item.workspaceName, className: "" });
  if (item.window) parts.push({ text: `w${item.window}`, className: "" });
  if (item.playing) parts.push({ text: "♪", className: "vimma-picker-playing" });
  if (item.muted) parts.push({ text: "muted", className: "" });
  if (item.pinned) parts.push({ text: "pinned", className: "" });
  if (item.closed) {
    parts.push({
      text: item.closedWindow ? "closed window" : "closed",
      className: "vimma-picker-closed",
    });
  }
  return parts;
}

/** @type {PickerLook} */
const WORKSPACES = {
  id: WORKSPACE_PICKER_ID,
  title: "Workspaces",
  listLabel: "Workspaces",
  hint: "j/k move · / search · Enter switch · m move tab here · Esc close",
  cells: (/** @type {WorkspaceItem & { countText?: string }} */ item) => {
    // The private workspace's row: its count only, `new` while closed (private-workspace 5).
    if (item.countText !== undefined) {
      return ["", `${item.countText}${item.active ? " · current" : ""}`];
    }
    const tabs = `${item.tabCount} ${item.tabCount === 1 ? "tab" : "tabs"}`;
    const foreign = item.foreignCount ? `, ${item.foreignCount} foreign` : "";
    return [String(item.workspaceIndex), `${tabs}${foreign}${item.active ? " · current" : ""}`];
  },
};

/** @type {PickerLook} docs/specs/addon-manager.md */
const ADDONS = {
  id: ADDON_PICKER_ID,
  title: "Add-ons",
  listLabel: "Add-ons",
  hint: "Enter popup · o options · x on/off · d remove · u update · P private · / search",
  cells: (/** @type {AddonItem} */ item) => [item.enabled ? "●" : "○", addonRowText(item)],
  empty: "No add-ons installed. Get them at addons.mozilla.org.",
};

/** @type {PickerLook} `:mcp log` (docs/specs/mcp-drive.md D14): newest first, read only. */
export const MCP_LOG = {
  id: MCP_LOG_ID,
  title: "Agent calls",
  listLabel: "Agent calls, newest first",
  hint: "j/k move · / search · Esc close",
  cells: (/** @type {LogItem} */ item) => [item.time, item.outcome],
  empty: "No agent calls since :mcp on.",
};

/**
 * The host of a URL, or the URL itself when it has none (about:, data:).
 * @param {string} url
 */
function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export class GotoPicker {
  /**
   * @param {Window} win  a browser window
   * @param {PickerHost} host
   * @param {PickerLook} [look]
   */
  constructor(win, host, look = GOTO) {
    this.win = win;
    this.host = host;
    this.look = look;
    /** @type {HTMLDialogElement | null} */
    this.dialog = null;
    /** @type {HTMLElement | null} */
    this.query = null;
    /** @type {HTMLElement | null} */
    this.list = null;
    /** @type {PickerState | null} */
    this.state = null;
    /** @type {Element | null} focused before open; close() falls back if it is gone */
    this.opener = null;
    /** @type {HTMLElement | null} tab search's live count */
    this.count = null;
    /** @type {string | null} the query the live count was last said for */
    this.counted = null;
  }

  get isOpen() {
    return !!this.dialog?.open;
  }

  /**
   * @param {{ query?: string }} [options]  tab search's query already typed (`:tabsearch text`)
   */
  open({ query = "" } = {}) {
    if (this.isOpen) return;
    this.opener = Services.focus.focusedElement;
    const dialog = this.dialog ?? this.build();
    this.counted = null;
    this.state = openPicker(this.host.items(), {
      activeId: this.host.activeId(),
      ...(this.look.tabs ? { typeFirst: true, query } : {}),
    });
    this.render();
    dialog.showModal();
    // The list, not the dialog: aria-activedescendant names the active row only while the
    // element carrying it has focus (m7-a11y).
    /** @type {HTMLElement} */ (this.list).focus();
  }

  /**
   * One key, as formatKey writes it.
   * @param {string} key
   */
  key(key) {
    if (!this.state) return;
    const { state, effect } = pickerKey(this.state, key);
    if (state !== this.state) {
      this.state = state;
      this.render();
    }
    if (effect?.type === "close") this.close();
    if (effect?.type === "select") {
      this.close();
      this.host.select(effect.id);
    }
    if (effect?.type === "reopen") {
      this.close();
      this.host.reopen?.(effect.id);
    }
    if (effect?.type === "move") {
      const moving = this.moving();
      this.close();
      moving(effect.id);
    }
    if (effect?.type === "addon") this.host.addon?.(effect.op, effect.id);
  }

  /**
   * New rows while open (an add-on toggled); the selected row stays selected if it survives.
   * @param {AnyItem[]} items
   */
  setItems(items) {
    if (!this.state) return;
    this.state = setPickerItems(this.state, items);
    this.render();
  }

  /**
   * As HelpOverlay.close: focus returns where it was, or to the selected browser when the tab
   * changed underneath or that element is gone.
   * @param {{ tabChanged?: boolean }} [options]
   */
  close({ tabChanged = false } = {}) {
    if (!this.isOpen) return;
    /** @type {HTMLDialogElement} */ (this.dialog).close();
    this.state = null;
    const opener = this.opener;
    this.opener = null;
    if (tabChanged || !opener?.isConnected) {
      /** @type {{ gBrowser?: { selectedBrowser: HTMLElement } }} */ (
        /** @type {unknown} */ (this.win)
      ).gBrowser?.selectedBrowser.focus();
    }
  }

  /**
   * What `m` on a workspace row runs, taken before close() resets the picker.
   * @returns {(id: string) => void}
   */
  moving() {
    return (id) => this.host.move?.(id);
  }

  /** Close and remove the dialog (VimmaHost.uninit). */
  destroy() {
    this.close();
    this.dialog?.remove();
    this.dialog = this.query = this.list = this.count = null;
  }

  /** @private */
  render() {
    const state = /** @type {PickerState} */ (this.state);
    const doc = this.win.document;
    const query = /** @type {HTMLElement} */ (this.query);
    const searching = state.mode === "search" || state.query !== "";
    query.textContent = searching ? `/${state.query}` : "";
    query.hidden = !searching;
    // Tab search is always typing: its hint stays (it names the keys that move).
    /** @type {HTMLElement} */ (query.nextElementSibling).hidden = searching && !this.look.tabs;

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
    /**
     * `text` with `ranges` marked, into `node`.
     * @param {HTMLElement} node
     * @param {string} text
     * @param {[number, number][]} ranges
     */
    const marked = (node, text, ranges) => {
      let at = 0;
      for (const [start, end] of ranges) {
        node.append(text.slice(at, start));
        node.append(el("mark", "", text.slice(start, end)));
        at = end;
      }
      node.append(text.slice(at));
      return node;
    };
    const list = /** @type {HTMLElement} */ (this.list);
    const tabs = !!this.look.tabs;
    const { start, end } = tabs
      ? rowRange(state.matches.length, state.selected)
      : { start: 0, end: state.matches.length };
    // Section headings in the grouped view (blank query): not options, so j/k and screen readers
    // skip them; each option's name carries its section instead (tab-search decision 11).
    const grouped = tabs && !state.query.trim();
    /** @type {Map<string, number>} */
    const sizes = new Map();
    if (grouped) {
      for (const m of state.matches) {
        const key = sectionOf(m.item);
        sizes.set(key, (sizes.get(key) ?? 0) + 1);
      }
    }
    /** @type {HTMLElement[]} */
    const nodes = [];
    /** @param {string} text */
    const more = (text) => {
      const li = el("li", "vimma-picker-more", text);
      li.setAttribute("role", "none");
      nodes.push(li);
    };
    if (start > 0) more(`… ${start} more above`);
    let section = start > 0 ? sectionOf(/** @type {any} */ (state.matches[start - 1]).item) : null;
    for (let i = start; i < end; i++) {
      const m = /** @type {import("../core/picker.mjs").Match} */ (state.matches[i]);
      if (grouped && sectionOf(m.item) !== section) {
        section = sectionOf(m.item);
        const heading = el(
          "li",
          "vimma-picker-heading",
          sectionHeading(/** @type {PickerItem} */ (m.item), sizes.get(section) ?? 0),
        );
        heading.setAttribute("role", "presentation");
        nodes.push(heading);
      }
      const row = el("li", "vimma-picker-row");
      row.id = `${this.look.id}-${i}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === state.selected));
      row.dataset.id = itemId(m.item);
      if ("tabId" in m.item) row.dataset.tabId = m.item.tabId;
      if (m.item.active) row.classList.add("vimma-picker-active");
      if ("enabled" in m.item && !m.item.enabled) row.classList.add("vimma-picker-disabled");
      const title = marked(
        el("span", "vimma-picker-title"),
        m.item.display,
        m.highlights.display ?? [],
      );
      const [index, right] = this.look.cells(m.item);
      row.append(el("span", "vimma-picker-index", index), title);
      if (tabs) {
        const item = /** @type {PickerItem} */ (m.item);
        row.setAttribute("aria-label", accessibleName(item));
        const meta = el("span", "vimma-picker-meta");
        for (const part of metaParts(item)) {
          if (meta.childNodes.length) meta.append(" ");
          meta.append(el("span", part.className, part.text));
        }
        // The host cell shows the URL match's highlights where they fall in the host.
        const host = el("span", "vimma-picker-host");
        const at = item.url.indexOf(right);
        const ranges = (m.highlights.url ?? [])
          .map(([a, b]) => /** @type {[number, number]} */ ([a - at, b - at]))
          .filter(([a, b]) => at >= 0 && a >= 0 && b <= right.length);
        row.append(meta, marked(host, right, ranges));
      } else {
        row.append(el("span", "vimma-picker-host", right));
      }
      nodes.push(row);
    }
    if (end < state.matches.length) more(`… ${state.matches.length - end} more, type to narrow`);
    list.replaceChildren(...nodes);
    if (tabs && this.count && this.counted !== state.query) {
      // Said when the query changes, not on every move (tab-search decision 11).
      this.counted = state.query;
      this.count.textContent = countText(state.matches.length);
    }
    if (!state.items.length && this.look.empty) {
      // Not an option: the listbox is empty, and describes itself with this line.
      const empty = el("li", "vimma-picker-empty", this.look.empty);
      empty.id = `${this.look.id}-empty`;
      empty.setAttribute("role", "none");
      list.append(empty);
      list.setAttribute("aria-describedby", empty.id);
    } else {
      list.removeAttribute("aria-describedby");
    }
    const current = state.matches.length
      ? list.querySelector(`#${this.look.id}-${state.selected}`)
      : undefined;
    if (current) {
      list.setAttribute("aria-activedescendant", current.id);
      current.scrollIntoView({ block: "nearest" });
    } else {
      list.removeAttribute("aria-activedescendant");
    }
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
    /** @param {string} tag */
    const el = (tag) => /** @type {HTMLElement} */ (doc.createElementNS(HTML_NS, tag));

    const dialog = /** @type {HTMLDialogElement} */ (el("dialog"));
    dialog.id = this.look.id;
    dialog.className = "vimma-picker";
    dialog.tabIndex = -1;
    dialog.setAttribute("aria-label", this.look.title);
    dialog.setAttribute("aria-modal", "true");
    const header = el("header");
    const h1 = el("h1");
    h1.textContent = this.look.title;
    const query = el("span");
    query.className = "vimma-picker-query";
    const hint = el("span");
    hint.className = "vimma-picker-hint";
    hint.textContent = this.look.hint;
    header.append(h1, query, hint);
    if (this.look.tabs) {
      dialog.classList.add("vimma-picker-tabs");
      const count = el("span");
      count.className = "vimma-picker-count";
      count.setAttribute("role", "status");
      count.setAttribute("aria-live", "polite");
      header.append(count);
      this.count = count;
    }
    const list = el("ul");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", this.look.listLabel);
    // Focusable by script only: keys reach the picker through VimmaHost, not Tab.
    list.tabIndex = -1;
    dialog.append(header, list);
    doc.body.append(dialog);
    this.dialog = dialog;
    this.query = query;
    this.list = list;
    return dialog;
  }
}

/**
 * `prefix+w`: the workspaces, Enter switches, `m` moves the current tab (m3-workspaces 5).
 * `openFor` (`m` on a side-panel row): Enter or `m` moves that row's tab instead.
 */
export class WorkspacePicker extends GotoPicker {
  /**
   * @param {Window} win  a browser window
   * @param {PickerHost & { moveRow?: (tab: Element, id: string) => void }} host
   */
  constructor(win, host) {
    super(win, host, WORKSPACES);
    /** @type {Element | null} the side-panel row's tab while opened for one */
    this.row = null;
  }

  /**
   * @param {Element} tab  the tab to move
   * @param {string} title  its title, for the heading
   */
  openFor(tab, title) {
    if (this.isOpen) return;
    this.open();
    this.row = tab;
    this.#heading(`Move "${title}" to`, "j/k move · / search · Enter move here · Esc close");
  }

  /**
   * Opened for a row, Enter and `m` both mean "move it here": Enter must not switch workspace.
   * @param {string} key
   */
  key(key) {
    super.key(this.row && key === "enter" ? "m" : key);
  }

  /** @returns {(id: string) => void} */
  moving() {
    const row = this.row;
    if (!row) return super.moving();
    const host = /** @type {{ moveRow?: (tab: Element, id: string) => void }} */ (this.host);
    return (id) => host.moveRow?.(row, id);
  }

  /** @param {{ tabChanged?: boolean }} [options] */
  close(options) {
    if (this.row) {
      this.row = null;
      this.#heading(WORKSPACES.title, WORKSPACES.hint);
    }
    super.close(options);
  }

  /**
   * @param {string} title
   * @param {string} hint
   */
  #heading(title, hint) {
    const h1 = this.dialog?.querySelector("h1");
    const hintEl = this.dialog?.querySelector(".vimma-picker-hint");
    if (h1) h1.textContent = title;
    if (hintEl) hintEl.textContent = hint;
    this.dialog?.setAttribute("aria-label", title);
  }
}

/**
 * `prefix+e` / `:addons` (docs/specs/addon-manager.md): the installed extensions. AddonManager
 * answers asynchronously, so `load` fetches the rows first and `items` hands them over.
 */
export class AddonPicker extends GotoPicker {
  /**
   * @param {Window} win  a browser window
   * @param {Omit<PickerHost, "items" | "activeId"> & { load: () => Promise<AnyItem[]> }} host
   */
  constructor(win, host) {
    /** @type {AnyItem[]} */
    let rows = [];
    super(win, { ...host, items: () => rows, activeId: () => null }, ADDONS);
    this.load = host.load;
    /** @param {AnyItem[]} next */
    this.setRows = (next) => {
      rows = next;
    };
    /** @type {Promise<void> | null} while the rows load for open() */
    this.opening = null;
  }

  /**
   * Opens once the rows are in. Resolves when it is open (or did not open).
   * @returns {Promise<void>}
   */
  openAsync() {
    if (this.isOpen) return Promise.resolve();
    this.opening ??= this.load()
      .then((rows) => {
        this.setRows(rows);
        super.open();
      })
      .finally(() => {
        this.opening = null;
      });
    return this.opening;
  }

  open() {
    this.openAsync().catch((e) => console.error("vimma: add-on picker", e));
  }

  /**
   * Reloads the rows while open (after `x`, `shift+p`, `u`).
   * @returns {Promise<void>}
   */
  async refresh() {
    const rows = await this.load();
    this.setRows(rows);
    if (this.isOpen) this.setItems(rows);
  }
}
