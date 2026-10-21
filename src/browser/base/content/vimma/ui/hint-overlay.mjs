/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Link-hint labels (spec: docs/specs/m1-hints.md), drawn in the chrome document over the
// page's <browser>, never in the page: the page cannot see, restyle or remove them. The layer
// is a child of the browser's .browserStack (a XUL stack, so it covers exactly the browser),
// ignores the mouse and clips to the content area. Element focus outlines the chosen text block
// in a layer of its own beside it (docs/specs/element-focus.md, decision 6).

/** @import { Hint } from "../core/hints.mjs" */
/** @import { HintTarget } from "../actors/VimmaActors.sys.mjs" */

export const HINT_OVERLAY_ID = "vimma-hints";
export const ELEMENT_OUTLINE_ID = "vimma-element";
const STYLESHEET = "chrome://browser/skin/vimma/hints.css";
const HTML_NS = "http://www.w3.org/1999/xhtml";
/** @type {WeakSet<Window>} windows our stylesheet is loaded into */
const styled = new WeakSet();

export class HintOverlay {
  /** @param {Window} win  a browser window */
  constructor(win) {
    this.win = win;
    /** @type {HTMLElement | null} */
    this.layer = null;
    /** @type {Map<string, HTMLElement>} label → its element */
    this.labels = new Map();
    /** @type {HTMLElement | null} the element-focus outline's layer */
    this.ring = null;
  }

  #style() {
    if (styled.has(this.win)) return;
    this.win.windowUtils.loadSheetUsingURIString(STYLESHEET, this.win.windowUtils.AUTHOR_SHEET);
    styled.add(this.win);
  }

  /**
   * Outlines a text block: a ring just outside its border box, in chrome over the page.
   * @param {any} browser XULBrowserElement
   * @param {{ x: number, y: number, width: number, height: number }} box  in the top frame's
   *   CSS pixels
   */
  outline(browser, box) {
    this.ring?.remove();
    this.#style();
    const doc = this.win.document;
    const layer = /** @type {HTMLElement} */ (doc.createElementNS(HTML_NS, "div"));
    layer.id = ELEMENT_OUTLINE_ID;
    // The status bar says what is focused (m7-a11y); the ring is a picture of where.
    layer.setAttribute("aria-hidden", "true");
    const zoom = Number(browser.fullZoom) || 1;
    const ring = /** @type {HTMLElement} */ (doc.createElementNS(HTML_NS, "div"));
    ring.className = "vimma-element-ring";
    // 2 px outside the border box, which is the ring's own width.
    ring.style.left = `${Math.round(box.x * zoom) - 2}px`;
    ring.style.top = `${Math.round(box.y * zoom) - 2}px`;
    ring.style.width = `${Math.round(box.width * zoom) + 4}px`;
    ring.style.height = `${Math.round(box.height * zoom) + 4}px`;
    layer.append(ring);
    (browser.closest(".browserStack") ?? browser.parentNode).append(layer);
    this.ring = layer;
  }

  /**
   * Draws a label at the top left of each target.
   * @param {any} browser XULBrowserElement the targets belong to
   * @param {readonly Hint<HintTarget>[]} hints
   */
  show(browser, hints) {
    this.hide();
    const doc = this.win.document;
    this.#style();
    const layer = /** @type {HTMLElement} */ (doc.createElementNS(HTML_NS, "div"));
    layer.id = HINT_OVERLAY_ID;
    // Labels drawn over a page are a picture of where to type, thousands of them: out of the
    // accessible tree. The status bar says "hint mode" (m7-a11y).
    layer.setAttribute("aria-hidden", "true");
    // Content CSS pixels to chrome CSS pixels: the page's full zoom, from the parent, not
    // from content.
    const zoom = Number(browser.fullZoom) || 1;
    const fragment = doc.createDocumentFragment();
    for (const { label, target } of hints) {
      const el = /** @type {HTMLElement} */ (doc.createElementNS(HTML_NS, "span"));
      el.className = "vimma-hint";
      el.dataset.label = label;
      el.style.left = `${Math.round(target.rect.x * zoom)}px`;
      el.style.top = `${Math.round(target.rect.y * zoom)}px`;
      el.textContent = label; // the typed part gets its own span only once there is one
      fragment.append(el);
      this.labels.set(label, el);
    }
    layer.append(fragment);
    (browser.closest(".browserStack") ?? browser.parentNode).append(layer);
    this.layer = layer;
  }

  /**
   * Hides the labels that do not start with `typed` and marks the typed part of the others.
   * @param {string} typed
   */
  filter(typed) {
    for (const [label, el] of this.labels) {
      const match = label.startsWith(typed);
      el.hidden = !match;
      if (!match) continue;
      if (typed) this.#fill(el, label, typed);
      else el.textContent = label;
    }
  }

  /** Removes the labels and the outline. */
  hide() {
    this.layer?.remove();
    this.layer = null;
    this.labels.clear();
    this.ring?.remove();
    this.ring = null;
  }

  /**
   * @param {HTMLElement} el
   * @param {string} label
   * @param {string} typed
   */
  #fill(el, label, typed) {
    const doc = this.win.document;
    const done = doc.createElementNS(HTML_NS, "span");
    done.className = "vimma-hint-typed";
    done.textContent = typed;
    el.replaceChildren(done, label.slice(typed.length));
  }
}
