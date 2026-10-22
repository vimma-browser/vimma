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
// reply line. agent-commands.mjs asked first and checks the tab again afterwards.

import { AGENT_SCREENSHOT, screenshotLabels, screenshotScale } from "../core/agent-act.mjs";
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
  unpainted: "the tab is not painted in the background: call vimma_show first",
  tooLarge: "the screenshot is too large",
  failed: "Vimma could not take a screenshot of this page",
});

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
  return {
    bg: style.getPropertyValue("--vimma-hint-bg").trim() || HINT_BG,
    fg: style.getPropertyValue("--vimma-hint-fg").trim() || HINT_FG,
  };
}

/**
 * The image in the first encoding whose base64 is at most `max` characters (F19): PNG, else
 * JPEG at each quality in turn; null when none fits.
 * @param {any} canvas  an OffscreenCanvas
 * @param {number} max
 * @returns {Promise<{ mimeType: string, data: string } | null>}
 */
async function encode(canvas, max) {
  const tries = [
    { type: "image/png" },
    ...AGENT_SCREENSHOT.jpeg.map((quality) => ({ type: "image/jpeg", quality })),
  ];
  for (const options of tries) {
    const blob = await canvas.convertToBlob(options);
    if (4 * Math.ceil(blob.size / 3) > max) continue;
    const bytes = /** @type {any} */ (new Uint8Array(await blob.arrayBuffer()));
    return { mimeType: options.type, data: bytes.toBase64() };
  }
  return null;
}

export const AgentShot = {
  /** Test-only: the longest base64 in place of AGENT_SCREENSHOT.base64. */
  _base64Max: /** @type {number | null} */ (null),

  /**
   * A screenshot of `tab`'s viewport, in the background (F18-F21), with `labels` drawn on it;
   * or why there is none.
   * @param {any} win  the browser window that holds the tab
   * @param {any} tab
   * @param {Map<string, HintTarget> | null} labels  the labels to draw, or none
   * @returns {Promise<{ mimeType: string, data: string, width: number, height: number,
   *   drawn: number } | { refused: string }>}
   */
  async capture(win, tab, labels) {
    const browser = tab.linkedBrowser;
    // The <browser>'s box is the viewport's size in the chrome's CSS pixels; a hidden tab
    // panel keeps it (Firefox lays out background tabs). A box with no room draws nothing.
    const box = browser.getBoundingClientRect();
    const fit = screenshotScale(box.width, win.devicePixelRatio, box.height);
    const wg = browser.browsingContext?.currentWindowGlobal;
    if (fit === null || !wg) return { refused: SHOT_REFUSALS.unpainted };
    // The page's CSS pixels are the chrome's times its zoom, as `tabs.captureTab` scales: the
    // image shows the zoomed page at the viewport's size, and labels' rects scale the same way.
    const zoom = browser.fullZoom > 0 ? browser.fullZoom : 1;
    const scale = fit * zoom;
    if (await VimmaActors.agentSensitiveShown(browser, FRAME_TIMEOUT_MS)) {
      return { refused: SHOT_REFUSALS.sensitive };
    }
    const bitmap = await within(
      wg.drawSnapshot(null, scale, "white").catch(() => null),
      DRAW_TIMEOUT_MS,
      null,
    );
    if (!bitmap) return { refused: SHOT_REFUSALS.unpainted };
    const width = Math.min(bitmap.width, AGENT_SCREENSHOT.width);
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
    const image = await encode(canvas, this._base64Max ?? AGENT_SCREENSHOT.base64);
    if (!image) return { refused: SHOT_REFUSALS.tooLarge };
    return { ...image, width, height, drawn };
  },
};
