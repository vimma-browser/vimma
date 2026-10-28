/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// An agent's screenshot of a tab of the agent workspace (docs/specs/mcp-forms.md F18-F21;
// security.md M25, M31). The tab's top window global draws its viewport in the parent with
// `drawSnapshot`, frames of other sites included and never the browser's chrome or another tab,
// as WebExtensions' `tabs.captureTab` does; a background tab draws its current page, so the tab
// is never selected or shown. First every frame's child says whether a password or payment card
// field with a value is on screen, and if one is, or a frame cannot say, nothing is drawn. The
// labels of the connection's current `vimma_elements` list may be drawn on the image in the
// theme's hint colours. The image is a PNG, or a JPEG when the PNG's base64 does not fit the
// reply line. Only an http or https page is captured, and the check of secret fields runs
// again after the drawing; meanwhile the agent's own keys, clicks and fills on that tab are
// `in-use`, and while one of them runs a screenshot is refused. agent-commands.mjs asked first
// and checks the tab again afterwards.

import {
  AGENT_SCREENSHOT,
  AGENT_SCREENSHOT_SMALL,
  screenshotEncodings,
  screenshotLabels,
  screenshotScale,
} from "../core/agent-act.mjs";
import { VimmaActors } from "../actors/VimmaActors.sys.mjs";

/** @import { HintTarget } from "../actors/VimmaActors.sys.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** How long the frames may take to answer, and the page to draw: a hung page must not hold it. */
const FRAME_TIMEOUT_MS = 5000;
const DRAW_TIMEOUT_MS = 10000;

/** Why a screenshot is refused (F18, F19, F21). */
export const SHOT_REFUSALS = Object.freeze({
  sensitive: "a payment or password field on screen has a value; Vimma does not capture it",
  unchecked: "Vimma could not check every frame of this page for payment fields",
  notWeb: "screenshots are taken only of http and https pages",
  scrolled: "the page scrolled while the screenshot was taken; try again",
  acting: "the agent is acting on this tab; try again when that call is done",
  unpainted: "the tab is not painted in the background: call vimma_show first",
  tooLarge: "the screenshot is too large",
  failed: "Vimma could not take a screenshot of this page",
});

/**
 * A page screenshots are taken of: a web page, as for `vimma_elements` (F2). A tab moved into the
 * agent workspace may show a privileged about: page, the start page or a local file.
 * @param {any} principal nsIPrincipal
 */
const onTheWeb = (principal) =>
  !!principal?.isContentPrincipal && (principal.schemeIs("http") || principal.schemeIs("https"));

/** The built-in vimma hint colours (hints.css), for a theme that sets none. */
const HINT_BG = "#1bf587";
const HINT_FG = "#0a0f12";

/**
 * `promise`, or `fallback` after `ms`.
 * @template T
 * @param {Promise<T>} promise @param {number} ms @param {T} fallback
 */
async function within(promise, ms, fallback) {
  /** @type {any} */
  let timer;
  const late = new Promise((resolve) => {
    timer = lazy.setTimeout(resolve, ms, fallback);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    lazy.clearTimeout(timer);
  }
}

/**
 * Draws each label as the user's hint mode does (hints.css): bold monospace capitals on the
 * theme's hint colour, at its element's top left corner.
 * @param {any} ctx  an OffscreenCanvasRenderingContext2D
 * @param {{ label: string, x: number, y: number }[]} labels
 * @param {number} scale
 * @param {{ bg: string, fg: string }} colours
 */
function drawLabels(ctx, labels, scale, colours) {
  const size = 11 * scale;
  const pad = 3 * scale;
  const height = Math.ceil(size * 1.4);
  ctx.font = `bold ${size}px monospace`;
  ctx.textBaseline = "middle";
  for (const { label, x, y } of labels) {
    const text = label.toUpperCase();
    const width = Math.ceil(ctx.measureText(text).width + 2 * pad);
    ctx.fillStyle = colours.bg;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 3 * scale);
    ctx.fill();
    ctx.fillStyle = colours.fg;
    ctx.fillText(text, x + pad, y + height / 2);
  }
}

/**
 * The theme's hint colours in `win`, as hints.css takes them.
 * @param {any} win  a browser window
 */
function hintColours(win) {
  const style = win.getComputedStyle(win.document.documentElement);
  /** A canvas keeps its last colour for one it cannot parse: the default instead. */
  const colour = (/** @type {string} */ name, /** @type {string} */ fallback) => {
    const v = style.getPropertyValue(name).trim();
    return v && win.CSS.supports("color", v) ? v : fallback;
  };
  return { bg: colour("--vimma-hint-bg", HINT_BG), fg: colour("--vimma-hint-fg", HINT_FG) };
}

/**
 * The image in an encoding whose base64 is at most `max` characters (F19; issue #584): the
 * smallest of screenshotEncodings' `smallest` (a full image: PNG; the default one: PNG or
 * JPEG), else the first of its `then` that fits; null when none fits.
 * @param {any} canvas  an OffscreenCanvas
 * @param {number} max @param {boolean} full
 * @returns {Promise<{ mimeType: string, data: string } | null>}
 */
async function encode(canvas, max, full) {
  const { smallest, then } = screenshotEncodings(full);
  const fits = (/** @type {any} */ blob) => 4 * Math.ceil(blob.size / 3) <= max;
  /** @param {any} blob @param {string} type */
  const encoded = async (blob, type) => {
    const bytes = /** @type {any} */ (new Uint8Array(await blob.arrayBuffer()));
    return { mimeType: type, data: bytes.toBase64() };
  };
  let best = null;
  for (const options of smallest) {
    const blob = await canvas.convertToBlob(options);
    if (fits(blob) && (!best || blob.size < best.blob.size)) best = { blob, type: options.type };
  }
  if (best) return encoded(best.blob, best.type);
  for (const options of then) {
    const blob = await canvas.convertToBlob(options);
    if (fits(blob)) return encoded(blob, options.type);
  }
  return null;
}

/**
 * Tabs, by <browser>, whose screenshot runs from its first check to its last, and those an
 * agent's keys, click or fill runs in, with how many: the two exclude each other, so the agent
 * cannot scroll or change a tab between the checks of its own screenshot (F21).
 */
const capturing = new WeakSet();
/** @type {WeakMap<object, number>} */
const acting = new WeakMap();

export const AgentShot = {
  /** Test-only: the longest base64 in place of AGENT_SCREENSHOT.base64. */
  _base64Max: /** @type {number | null} */ (null),
  /** Test-only: runs between the check and the drawing. */
  _beforeDraw: /** @type {(() => unknown) | null} */ (null),

  /**
   * A screenshot of `tab`'s viewport, in the background (F18-F21), with `labels` drawn on it;
   * or why there is none. At most AGENT_SCREENSHOT_SMALL.width pixels wide unless `full`
   * (issue #584).
   * @param {any} win  the browser window that holds the tab
   * @param {any} tab
   * @param {Map<string, HintTarget> | null} labels  the labels to draw, or none
   * @param {boolean} [full]
   * @returns {Promise<{ mimeType: string, data: string, width: number, height: number,
   *   drawn: number } | { refused: string }>}
   */
  async capture(win, tab, labels, full = false) {
    const browser = tab.linkedBrowser;
    if (!onTheWeb(browser.contentPrincipal)) return { refused: SHOT_REFUSALS.notWeb };
    if (acting.get(browser) || capturing.has(browser)) return { refused: SHOT_REFUSALS.acting };
    capturing.add(browser);
    try {
      return await this.draw(win, browser, labels, full);
    } finally {
      capturing.delete(browser);
    }
  },

  /**
   * Whether a screenshot of the tab of `browser` is being taken: the agent's keys, clicks and
   * fills there are then `in-use`.
   * @param {any} browser
   */
  capturing(browser) {
    return capturing.has(browser);
  },

  /**
   * Runs an agent's keys, click or fill on the tab of `browser`; a screenshot of it meanwhile
   * is refused.
   * @template T
   * @param {any} browser @param {() => Promise<T>} run
   * @returns {Promise<T>}
   */
  async acting(browser, run) {
    acting.set(browser, (acting.get(browser) ?? 0) + 1);
    try {
      return await run();
    } finally {
      const n = (acting.get(browser) ?? 1) - 1;
      if (n > 0) acting.set(browser, n);
      else acting.delete(browser);
    }
  },

  /**
   * The drawing of `capture`, once the tab is held.
   * @param {any} win @param {any} browser @param {Map<string, HintTarget> | null} labels
   * @param {boolean} full
   * @returns {Promise<{ mimeType: string, data: string, width: number, height: number,
   *   drawn: number } | { refused: string }>}
   */
  async draw(win, browser, labels, full) {
    const web = () => onTheWeb(browser.contentPrincipal);
    // The <browser>'s box is the viewport's size in the chrome's CSS pixels; a hidden tab
    // panel keeps it (Firefox lays out background tabs). Reading it also flushes the chrome's
    // layout, which `drawSnapshot` needs (as `tabs.captureTab` does). A box with no room draws
    // nothing.
    const box = browser.getBoundingClientRect();
    const wide = full ? AGENT_SCREENSHOT.width : AGENT_SCREENSHOT_SMALL.width;
    const fit = screenshotScale(box.width, win.devicePixelRatio, box.height, wide);
    const wg = browser.browsingContext?.currentWindowGlobal;
    if (fit === null || !wg) return { refused: SHOT_REFUSALS.unpainted };
    // The page's CSS pixels are the chrome's times its zoom, as `tabs.captureTab` scales: the
    // image shows the zoomed page at the viewport's size, and labels' rects scale the same way.
    const zoom = browser.fullZoom > 0 ? browser.fullZoom : 1;
    const scale = fit * zoom;
    /** Checked before and again after the drawing: a value typed meanwhile is not sent. */
    const secret = async () => {
      const found = await VimmaActors.agentSensitiveShown(browser, FRAME_TIMEOUT_MS);
      if (found === "shown") return SHOT_REFUSALS.sensitive;
      return found === "unchecked" ? SHOT_REFUSALS.unchecked : null;
    };
    const before = await secret();
    if (before) return { refused: before };
    const scrolled = await VimmaActors.scrollPosition(browser);
    await this._beforeDraw?.();
    const bitmap = await within(
      wg.drawSnapshot(null, scale, "white").catch(() => null),
      DRAW_TIMEOUT_MS,
      null,
    );
    if (!bitmap) return { refused: SHOT_REFUSALS.unpainted };
    const after = await secret();
    const now = await VimmaActors.scrollPosition(browser);
    // The drawing shows the page between the two checks; a scroll between them may have shown
    // what neither check saw.
    const moved = !scrolled || !now || now.x !== scrolled.x || now.y !== scrolled.y;
    const refused =
      after ?? (moved ? SHOT_REFUSALS.scrolled : null) ?? (web() ? null : SHOT_REFUSALS.notWeb);
    if (refused) {
      bitmap.close();
      return { refused };
    }
    const width = Math.min(bitmap.width, wide);
    const height = Math.min(bitmap.height, AGENT_SCREENSHOT.height);
    const canvas = new win.OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    let drawn = 0;
    if (labels) {
      const placed = screenshotLabels(labels, scale, { width, height });
      drawLabels(ctx, placed, scale, hintColours(win));
      drawn = placed.length;
    }
    const image = await encode(canvas, this._base64Max ?? AGENT_SCREENSHOT.base64, full);
    if (!image) return { refused: SHOT_REFUSALS.tooLarge };
    return { ...image, width, height, drawn };
  },
};
