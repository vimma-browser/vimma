/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The `prefix+?` bindings overlay (spec: docs/specs/m0-help-overlay.md). A modal <dialog> in the
// chrome document, so it sits above every page: about:preferences, pdf.js, remote content.
// Keys reach it only through VimmaHost; it owns no key handling of its own.

import { bindingTable, filterBindings, keyLegend } from "../core/help.mjs";

/** @import { Keymap } from "../core/keymap.mjs" */
/** @import { BindingRow } from "../core/help.mjs" */

export const HELP_OVERLAY_ID = "vimma-help";
const STYLESHEET = "chrome://browser/skin/vimma/help-overlay.css";
const HTML_NS = "http://www.w3.org/1999/xhtml";
/** @type {WeakSet<Window>} windows our stylesheet is loaded into */
const styled = new WeakSet();

export class HelpOverlay {
  /**
   * @param {Window} win  a browser window
   * @param {Keymap} keymap  the keymap the dispatcher uses, so help cannot drift from behaviour
   * @param {ReadonlySet<string>} [runnable]  action ids the host runs (VimmaHost's RUNNABLE);
   *   the others are dimmed, under a legend (core's isRunnable).
   *   Without it every row counts as runnable and there is no legend.
   * @param {() => readonly { chord: string, id: string, label: string }[]} [firefoxOn]  the
   *   Firefox keys `[firefox] enable` keeps on, read at each open: Firefox adds keys late
   *   (DevTools), so the list can change without a new keymap
   */
  constructor(win, keymap, runnable, firefoxOn = () => []) {
    this.win = win;
    this.keymap = keymap;
    this.firefoxOn = firefoxOn;
    /** @type {string} the Firefox rows the dialog was built with, to rebuild when they change */
    this.firefoxBuilt = "";
    /** @type {BindingRow[]} */
    this.rows = bindingTable(keymap, { runnable });
    /** What prefix and leader stand for in the rows: `prefix = ctrl+b · leader = space`. */
    this.legend = keyLegend(keymap);
    this.runnable = runnable;
    /** @type {HTMLDialogElement | null} */
    this.dialog = null;
    /** @type {HTMLInputElement | null} */
    this.input = null;
    /** @type {Element | null} focused before open; close() falls back if it is gone */
    this.opener = null;
  }

  /**
   * A new keymap (config.toml reloaded, m5-config-load): the rows are rebuilt from it; an open
   * overlay closes, so it never lists bindings that no longer apply.
   * @param {Keymap} keymap
   */
  setKeymap(keymap) {
    this.destroy(); // the dialog is built from the rows once; the next open builds it anew
    this.keymap = keymap;
    this.firefoxBuilt = ""; // open() adds the Firefox rows again
    this.rows = bindingTable(keymap, { runnable: this.runnable });
    this.legend = keyLegend(keymap);
  }

  get isOpen() {
    return !!this.dialog?.open;
  }

  get filterFocused() {
    return this.isOpen && this.win.document.activeElement === this.input;
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    if (this.isOpen) return;
    this.opener = Services.focus.focusedElement;
    const firefox = this.firefoxOn();
    if (JSON.stringify(firefox) !== this.firefoxBuilt) {
      this.destroy();
      this.firefoxBuilt = JSON.stringify(firefox);
      this.rows = bindingTable(this.keymap, { runnable: this.runnable, firefox });
    }
    const dialog = this.dialog ?? this.build();
    /** @type {HTMLInputElement} */ (this.input).value = "";
    this.applyFilter();
    dialog.showModal();
    dialog.scrollTop = 0;
    // Not redundant: showModal() focuses the first focusable descendant, the filter input.
    dialog.focus();
  }

  /**
   * HTMLDialogElement.close() returns focus to where it was before showModal(). When the tab
   * changed underneath (`tabChanged`) or that element is gone, focus the selected browser
   * instead of a dying one or nothing.
   * @param {{ tabChanged?: boolean }} [options]
   */
  close({ tabChanged = false } = {}) {
    if (!this.isOpen) return;
    /** @type {HTMLDialogElement} */ (this.dialog).close();
    const opener = this.opener;
    this.opener = null;
    if (tabChanged || !opener?.isConnected) {
      /** @type {{ gBrowser?: { selectedBrowser: HTMLElement } }} */ (
        /** @type {unknown} */ (this.win)
      ).gBrowser?.selectedBrowser.focus();
    }
  }

  /** Close and remove the dialog (VimmaHost.uninit). */
  destroy() {
    this.close();
    this.dialog?.remove();
    this.dialog = null;
    this.input = null;
  }

  focusFilter() {
    this.input?.focus();
  }

  /** @private */
  applyFilter() {
    const dialog = /** @type {HTMLDialogElement} */ (this.dialog);
    const query = /** @type {HTMLInputElement} */ (this.input).value;
    const shown = new Set(filterBindings(this.rows, query).map((r) => r.name));
    for (const section of dialog.querySelectorAll("section")) {
      let any = false;
      for (const row of section.querySelectorAll("[data-action]")) {
        const visible = shown.has(/** @type {HTMLElement} */ (row).dataset.action ?? "");
        /** @type {HTMLElement} */ (row).hidden = !visible;
        any ||= visible;
      }
      /** @type {HTMLElement} */ (section).hidden = !any;
    }
  }

  /**
   * @private
   * @returns {HTMLDialogElement}
   */
  build() {
    const doc = this.win.document;
    if (!styled.has(this.win)) {
      // Loading the same sheet twice throws NS_ERROR_ILLEGAL_VALUE (re-init, a second overlay).
      this.win.windowUtils.loadSheetUsingURIString(STYLESHEET, this.win.windowUtils.AUTHOR_SHEET);
      styled.add(this.win);
    }

    /**
     * @param {string} tag
     * @param {string} [className]
     * @param {string} [text]
     */
    const el = (tag, className, text) => {
      const node = /** @type {HTMLElement} */ (doc.createElementNS(HTML_NS, tag));
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    const dialog = /** @type {HTMLDialogElement} */ (el("dialog"));
    dialog.id = HELP_OVERLAY_ID;
    dialog.tabIndex = -1;
    dialog.setAttribute("aria-label", "Key bindings");
    // showModal() makes it modal already; said out loud for older assistive tech (m7-a11y).
    dialog.setAttribute("aria-modal", "true");

    const header = el("header");
    header.append(el("h1", "", "Key bindings"));
    const input = /** @type {HTMLInputElement} */ (el("input"));
    input.type = "search";
    input.placeholder = "/ to filter, Esc to close";
    input.setAttribute("aria-label", "Filter bindings");
    input.addEventListener("input", () => this.applyFilter());
    header.append(input);
    dialog.append(header);
    dialog.append(el("p", "vimma-help-key-legend", this.legend));
    if (this.runnable) {
      dialog.append(el("p", "vimma-help-legend", "Dimmed rows: not implemented yet"));
    }

    /** @type {HTMLElement | null} */
    let section = null;
    let group = "";
    for (const r of this.rows) {
      if (!section || r.group !== group) {
        group = r.group;
        section = el("section");
        section.append(el("h2", "", group));
        dialog.append(section);
      }
      const row = el("div", "vimma-help-row");
      row.dataset.action = r.name;
      row.dataset.runnable = String(r.runnable);
      // Screen readers get the mark the dimming shows.
      if (!r.runnable) row.setAttribute("aria-description", "not implemented yet");
      row.append(
        el("span", "vimma-help-override", r.overridden ? "*" : ""),
        el("span", "vimma-help-keys", r.bindings.length ? r.bindings.join(", ") : "(unbound)"),
        el("span", "vimma-help-name", r.name),
        el("span", "vimma-help-description", r.description),
      );
      section.append(row);
    }

    doc.body.append(dialog);
    this.dialog = dialog;
    this.input = input;
    return dialog;
  }
}
