/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The geometry half of split panes (docs/specs/m4-split-panes.md sub-spec 2, ADR-013): puts
// Firefox's split-view panels at core layout() rectangles through split.css. Knows nothing of the
// pane tree; PaneView.mjs decides the rectangles.

const STYLESHEET = "chrome://browser/skin/vimma/split.css";
export const PANES_ATTR = "vimma-panes";
export const ZOOMED_AWAY_ATTR = "vimma-zoomed-away";
const PROPS = /** @type {const} */ ([
  ["--vimma-pane-x", "x"],
  ["--vimma-pane-y", "y"],
  ["--vimma-pane-w", "width"],
  ["--vimma-pane-h", "height"],
]);
const EDGES = ["--vimma-pane-il", "--vimma-pane-it", "--vimma-pane-ir", "--vimma-pane-ib"];

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */
/** @typedef {{ linkedPanel: string }} PanelTab */

/** @type {WeakSet<BrowserWindow>} windows the sheet is loaded into (loading it twice throws) */
const styled = new WeakSet();

/**
 * Loads split.css into a window once; it also hides Firefox's own split-view UI.
 * @param {BrowserWindow} win
 */
export function loadSheet(win) {
  if (styled.has(win)) return;
  win.windowUtils.loadSheetUsingURIString(STYLESHEET, win.windowUtils.AUTHOR_SHEET);
  styled.add(win);
}

/**
 * The content area panes are laid out in: #tabbrowser-tabpanels, as an integer rect at 0,0.
 * @param {BrowserWindow} win
 * @returns {Rect}
 */
export function contentArea(win) {
  const el = /** @type {Element} */ (win.document.getElementById("tabbrowser-tabpanels"));
  const r = el.getBoundingClientRect();
  return { x: 0, y: 0, width: Math.round(r.width), height: Math.round(r.height) };
}

/**
 * Positions each tab's panel at its rectangle, in CSS px relative to #tabbrowser-tabpanels.
 * Edges inside `area` get half the pane gap each (split.css). Panels of tabs not in `rects` keep
 * their last position.
 * @param {BrowserWindow} win
 * @param {Map<PanelTab, Rect>} rects
 * @param {Rect} [area]  defaults to the bounding box of `rects`
 */
export function applyLayout(win, rects, area = boundingBox([...rects.values()])) {
  loadSheet(win);
  const doc = win.document;
  doc.getElementById("tabbrowser-tabpanels")?.toggleAttribute(PANES_ATTR, true);
  const right = area.x + area.width;
  const bottom = area.y + area.height;
  for (const [tab, rect] of rects) {
    const panel = /** @type {HTMLElement | null} */ (doc.getElementById(tab.linkedPanel));
    if (!panel) continue;
    for (const [prop, key] of PROPS) panel.style.setProperty(prop, `${rect[key]}px`);
    const interior = [
      rect.x > area.x,
      rect.y > area.y,
      rect.x + rect.width < right,
      rect.y + rect.height < bottom,
    ];
    EDGES.forEach((prop, i) => panel.style.setProperty(prop, interior[i] ? "1" : "0"));
  }
}

/**
 * @param {Rect[]} rects
 * @returns {Rect}
 */
function boundingBox(rects) {
  if (!rects.length) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const width = Math.max(...rects.map((r) => r.x + r.width)) - x;
  const height = Math.max(...rects.map((r) => r.y + r.height)) - y;
  return { x, y, width, height };
}

/**
 * Hides a tab's panel visually (zoomed away: no paint, no hit, frame and scroll kept) or shows it.
 * @param {BrowserWindow} win
 * @param {PanelTab} tab
 * @param {boolean} hidden
 */
export function setHidden(win, tab, hidden) {
  win.document.getElementById(tab.linkedPanel)?.toggleAttribute(ZOOMED_AWAY_ATTR, hidden);
}

/**
 * Whether a tab's panel is hidden visually by setHidden.
 * @param {BrowserWindow} win
 * @param {PanelTab} tab
 */
export function isHidden(win, tab) {
  return !!win.document.getElementById(tab.linkedPanel)?.hasAttribute(ZOOMED_AWAY_ATTR);
}

/**
 * Removes our attribute and custom properties from the given tabs' panels; `all` also takes the
 * attribute off #tabbrowser-tabpanels (no split left).
 * @param {BrowserWindow} win
 * @param {PanelTab[]} tabs
 * @param {{ all?: boolean }} [options]
 */
export function clearLayout(win, tabs, { all = true } = {}) {
  const doc = win.document;
  if (all) doc.getElementById("tabbrowser-tabpanels")?.removeAttribute(PANES_ATTR);
  for (const tab of tabs) {
    const panel = /** @type {HTMLElement | null} */ (doc.getElementById(tab.linkedPanel));
    if (!panel) continue;
    panel.removeAttribute(ZOOMED_AWAY_ATTR);
    for (const [prop] of PROPS) panel.style.removeProperty(prop);
    for (const prop of EDGES) panel.style.removeProperty(prop);
  }
}
