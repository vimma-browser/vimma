/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Which scroll area the scroll keys move (docs/specs/scroll-area.md): `gs` and `gS` across the
// frames of a tab, and the status bar marker. The choice itself lives in each frame's
// PageScroll (actors/page-scroll.mjs); this keeps only which document of a tab holds one, so the
// marker can say so, and forgets it with that document.

import { VimmaActors } from "../actors/VimmaActors.sys.mjs";
import { currentScrollArea, nextScrollArea, orderScrollAreas } from "../core/scroll-areas.mjs";

/** How long the chosen area's outline shows, in ms (decision 8). */
export const SCROLL_AREA_FLASH_MS = 600;

/** The document of each tab whose chosen area the keys move instead of the page's own. */
/** @type {WeakMap<MozBrowser, WindowGlobalParent>} */
const chosen = new WeakMap();
/** Tabs with a marker, for a document's end; weak, as tabs close. */
/** @type {Set<WeakRef<MozBrowser>>} */
const marked = new Set();
/** Each tab's last `gs`: a later one drops an earlier one's late answer. */
/** @type {WeakMap<MozBrowser, number>} */
const runs = new WeakMap();

/** Each tab's `gs` still running: the scroll keys pressed after it wait for it. */
/** @type {WeakMap<MozBrowser, Promise<void>>} */
const running = new WeakMap();

/** @type {(browser: MozBrowser) => void} */
let changed = () => {};

/**
 * @param {MozBrowser} browser
 * @param {WindowGlobalParent | null} wg  the document that holds a choice now, or none
 */
function setChosen(browser, wg) {
  const before = chosen.get(browser) ?? null;
  if (wg) {
    chosen.set(browser, wg);
    if (![...marked].some((r) => r.deref() === browser)) marked.add(new WeakRef(browser));
  } else {
    chosen.delete(browser);
  }
  for (const r of marked) if (!r.deref() || (!wg && r.deref() === browser)) marked.delete(r);
  if (before !== wg) changed(browser);
}

/**
 * The tab's <browser> of a frame: its top frame's embedder.
 * @param {CanonicalBrowsingContext} bc
 * @returns {MozBrowser | null}
 */
function browserOf(bc) {
  return /** @type {MozBrowser | null} */ (bc.top?.embedderElement ?? null);
}

/**
 * One `gs` or `gS`, once the one before it has finished (ScrollAreaOps.cycle).
 * @param {MozBrowser} browser
 * @param {1 | -1} direction
 * @param {number | undefined} count
 * @param {(browser: MozBrowser, box: { x: number, y: number, width: number, height: number })
 *   => void} flash
 */
async function cycleNow(browser, direction, count, flash) {
  const run = (runs.get(browser) ?? 0) + 1;
  runs.set(browser, run);
  const { viewport, areas } = await VimmaActors.scrollAreas(browser);
  if (!viewport || runs.get(browser) !== run) return;
  // Which area is chosen is the parent's own record, not a frame's say: a frame that claims a
  // choice it does not hold moves nothing.
  const holder = chosen.get(browser) ?? null;
  const ordered = orderScrollAreas(
    areas.map((a) => ({ ...a, chosen: a.chosen && a.wg === holder })),
    viewport,
  );
  const current = currentScrollArea(ordered, VimmaActors.scrollFrameOrder(browser));
  const next = nextScrollArea({ length: ordered.length, current, direction, count });
  const area = next === null ? null : ordered[next];
  if (!area) return;
  const picked = await VimmaActors.pickScrollArea(area.bc, area.wg, area.index);
  if (picked === null) {
    // No answer in time, but the frame may still make the pick: a clear sent now reaches its
    // actor after the pick, so no choice is left there that the parent does not know of.
    VimmaActors.clearScrollArea(area.wg);
    // That clear also ends a choice the frame held before (an earlier gs, a click meanwhile),
    // and it reports nothing back: the record and its marker end here.
    if (chosen.get(browser) === area.wg) setChosen(browser, null);
    return;
  }
  if (runs.get(browser) !== run) return;
  const before = chosen.get(browser);
  if (before && before !== area.wg) VimmaActors.clearScrollArea(before);
  setChosen(browser, picked ? area.wg : null);
  flash(browser, area.rect);
}

export const ScrollAreaOps = {
  /**
   * Who hears that a tab's marker changed: the host, which redraws that window's status bar.
   * @param {(browser: MozBrowser) => void} fn
   */
  onChange(fn) {
    changed = fn;
  },

  /**
   * `gs` (direction 1) or `gS` (-1): the scroll keys move the next or previous area, or with a
   * count the Nth, and the area is outlined for a moment (decisions 1 and 8).
   * @param {MozBrowser} browser
   * @param {1 | -1} direction
   * @param {number | undefined} count
   * @param {(browser: MozBrowser, box: { x: number, y: number, width: number, height: number })
   *   => void} flash  draws the outline, in the top frame's CSS pixels
   */
  cycle(browser, direction, count, flash) {
    const done = (this.pending(browser) ?? Promise.resolve())
      .then(() => cycleNow(browser, direction, count, flash))
      .finally(() => {
        if (running.get(browser) === done) running.delete(browser);
      });
    running.set(browser, done);
    return done;
  },

  /**
   * While a `gs` of the tab runs, a promise of its end, so that `gs j` typed quickly scrolls the
   * new area, as the keys were typed; null when none runs.
   * @param {MozBrowser} browser
   * @returns {Promise<void> | null}
   */
  pending(browser) {
    return running.get(browser)?.catch(() => {}) ?? null;
  },

  /**
   * A frame's click chose a scroll area, or its choice ended (`Vimma:ScrollAreaChosen`). It
   * moves only the marker of the frame's own tab; a choice there ends the other frames'.
   * @param {CanonicalBrowsingContext} bc
   * @param {WindowGlobalParent} wg
   * @param {boolean} isChosen
   */
  onReport(bc, wg, isChosen) {
    const browser = browserOf(bc);
    if (!browser) return;
    if (bc.currentWindowGlobal !== wg) {
      // The holder's own end, sent at its pagehide, can come after another document is shown
      // (Back into the back-forward cache and out again): it still ends that choice.
      if (!isChosen && chosen.get(browser) === wg) setChosen(browser, null);
      return;
    }
    // A click anywhere ends a choice another document of the tab holds; only that document is
    // told, and nothing is sent when none holds one.
    const before = chosen.get(browser);
    if (before && before !== wg) VimmaActors.clearScrollArea(before);
    setChosen(browser, isChosen ? wg : null);
  },

  /**
   * A frame's document went away: its choice goes with it (behaviour 4).
   * @param {WindowGlobalParent} wg
   */
  onFrameGone(wg) {
    for (const r of [...marked]) {
      const browser = r.deref();
      if (browser && chosen.get(browser) === wg) setChosen(browser, null);
    }
  },

  /**
   * Whether the status bar shows the marker for this tab (behaviour 6).
   * @param {MozBrowser | null | undefined} browser
   */
  status(browser) {
    const wg = browser && chosen.get(browser);
    // Only while that document is still shown in this tab: one in the back-forward cache is
    // not, and a browsing context swap there may leave it in another.
    const bc = wg?.browsingContext;
    return !!bc && bc.currentWindowGlobal === wg && bc.top?.embedderElement === browser;
  },
};
