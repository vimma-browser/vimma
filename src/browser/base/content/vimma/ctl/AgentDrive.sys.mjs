/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `vimma_keys`'s steps, run on one agent tab (docs/specs/mcp-drive.md D8, D11, D13, D16;
// security.md M16, M17). Each step is a Vimma action on that tab's <browser>, never a key event:
// no page script sees a keydown, nothing is typed. The tab is never selected, shown or focused,
// and the window's workspace, mode, find bar and hint mode are never touched: scrolls go to the
// top frame without smooth scrolling (a background tab's refresh driver is throttled), finds go
// through the tab's own finder, and history moves within the tab's own session history. Core
// (agent-keys.mjs) parsed and whitelisted the steps; agent-commands.mjs asked first.

import { isCaseSensitive } from "../core/find.mjs";
import { urlRoot, urlUp } from "../core/pageurl.mjs";
import { VimmaActors } from "../actors/VimmaActors.sys.mjs";
import { VimmaHost } from "../host/VimmaHost.sys.mjs";

/** @import { AgentStep } from "../core/agent-keys.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** How long a step waits for the page it loaded (agent-commands' LOAD_TIMEOUT_MS). */
const LOAD_TIMEOUT_MS = 20000;
/** How long a find waits for the finder's answer. */
const FIND_TIMEOUT_MS = 5000;
/** nsITypeAheadFind's results. */
const FIND_NOTFOUND = 1;
const FIND_WRAPPED = 2;

/**
 * @typedef {any} Tab
 * @typedef {any} Browser
 * @typedef {{ keys: string, action: string, ok: boolean, note?: string }} StepResult
 * @typedef {{ query: string, found: boolean, wrapped: boolean }} FindResult
 * @typedef {{ url: string, title: string, loading: boolean, scroll: { y: number },
 *   steps: StepResult[], stopped?: "changed" | "in-use" | "timeout" | "denied",
 *   find?: FindResult }} KeysResult
 * @typedef {object} DriveContext
 * @property {() => boolean} stillAgent  the tab is still an agent tab (M2), checked before
 *   each step
 * @property {(url: string) => boolean} load  loads `url` in the tab as the agent's (its
 *   principal, its downloads, a slot of the open rate); false when the rate is used up
 * @property {number} deadline  ms since the epoch: the call stops here (D15)
 */

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => lazy.setTimeout(resolve, ms));

/** @param {unknown} s  well-formed, so the reply is one line vimma-ctl's parser takes */
const wf = (s) => /** @type {string} */ (/** @type {any} */ (String(s ?? "")).toWellFormed());

const SCROLLS = /** @type {Record<string, import("../actors/VimmaActors.sys.mjs").ScrollKind>} */ ({
  "scroll.down": "down",
  "scroll.up": "up",
  "scroll.left": "left",
  "scroll.right": "right",
  "scroll.half_down": "half_down",
  "scroll.half_up": "half_up",
  "scroll.top": "top",
  "scroll.bottom": "bottom",
});

/**
 * What the page is now, to see when a load it started is through: its document, and its URL
 * (a same-document navigation keeps the document).
 * @param {Browser} browser
 */
function pageMark(browser) {
  return {
    doc: browser.browsingContext?.currentWindowGlobal?.innerWindowId ?? 0,
    url: String(browser.currentURI?.spec ?? ""),
  };
}

/**
 * Waits until the page left `mark` and finished loading, or until `until`.
 * @param {Browser} browser @param {{ doc: number, url: string }} mark @param {number} until
 * @returns {Promise<boolean>} whether it loaded in time
 */
async function loaded(browser, mark, until) {
  for (;;) {
    const now = pageMark(browser);
    const moved = now.doc !== mark.doc || now.url !== mark.url;
    if (moved && !browser.webProgress?.isLoadingDocument) return true;
    if (Date.now() > until) return false;
    await sleep(50);
  }
}

/**
 * One find on the tab's own finder, never the window's find bar (D11): resolves with
 * nsITypeAheadFind's result, or null if the finder did not answer.
 * @param {Browser} browser @param {string} query @param {boolean} again @param {boolean} backward
 * @returns {Promise<number | null>}
 */
function findOnce(browser, query, again, backward) {
  const finder = browser.finder;
  return new Promise((resolve) => {
    let done = false;
    const listener = {
      onFindResult(/** @type {any} */ data) {
        if (done || String(data?.searchString ?? "") !== query) return;
        finish(Number(data.result));
      },
      onMatchesCountResult() {},
      onHighlightFinished() {},
      onCurrentSelection() {},
      // The agent's find never moves focus into the page (M16).
      shouldFocusContent: () => false,
    };
    /** @param {number | null} result */
    const finish = (result) => {
      done = true;
      finder.removeResultListener(listener);
      resolve(result);
    };
    finder.addResultListener(listener);
    finder.caseSensitive = isCaseSensitive(query);
    // The page's child may give back a focus this step's match takes (VimmaChild, #442).
    VimmaActors.findStep(browser);
    if (again) finder.findAgain(query, backward, false, false);
    else finder.fastFind(query, false, false);
    lazy.setTimeout(() => !done && finish(null), FIND_TIMEOUT_MS);
  });
}

export const AgentDrive = {
  /** Test-only: called after each step with the number of steps done. */
  _onStep: /** @type {((n: number) => void) | null} */ (null),

  /**
   * Runs `steps` on `tab`, in order, in the background.
   * @param {Tab} tab @param {AgentStep[]} steps @param {DriveContext} ctx
   * @returns {Promise<KeysResult>}
   */
  async run(tab, steps, { stillAgent, load, deadline }) {
    const browser = tab.linkedBrowser;
    /** @type {StepResult[]} */
    const done = [];
    /** @type {KeysResult["stopped"]} */
    let stopped;
    /** @type {{ query: string, backward: boolean } | null} the call's last search */
    let last = null;
    /** @type {FindResult | undefined} */
    let find;

    for (const step of steps) {
      if (Date.now() > deadline) {
        stopped = "timeout";
        break;
      }
      if (!stillAgent()) {
        stopped = "changed";
        break;
      }
      if (VimmaHost.inUse(browser)) {
        stopped = "in-use";
        break;
      }
      /** @type {StepResult} */
      const result = { keys: step.keys, action: step.action, ok: true };
      const count = step.count ?? 1;
      try {
        const id = step.action;
        if (id in SCROLLS) {
          const kind = /** @type {any} */ (SCROLLS)[id];
          const moved = await VimmaActors.scroll(browser, kind, count, {
            instant: true,
            top: true,
          });
          if (!moved) Object.assign(result, { ok: false, note: "nothing on the page scrolls" });
        } else if (id === "history.back" || id === "history.forward") {
          const history = browser.browsingContext?.sessionHistory;
          const delta = id === "history.back" ? -count : count;
          const index = history ? history.index : 0;
          const target = history ? Math.min(Math.max(index + delta, 0), history.count - 1) : index;
          if (!history || target === index) {
            const where = delta < 0 ? "back to" : "forward to";
            Object.assign(result, { ok: false, note: `no page to go ${where} in this tab` });
          } else {
            const mark = pageMark(browser);
            browser.gotoIndex(target);
            if (!(await loaded(browser, mark, Math.min(deadline, Date.now() + LOAD_TIMEOUT_MS)))) {
              result.note = "the page is still loading";
            }
          }
        } else if (id === "page.url_up" || id === "page.url_root") {
          const here = String(browser.currentURI?.spec ?? "");
          const url = id === "page.url_up" ? urlUp(here, count) : urlRoot(here);
          if (!url || !/^https?:/i.test(url)) {
            Object.assign(result, { ok: false, note: "already at the top of the site" });
          } else {
            const mark = pageMark(browser);
            if (!load(url)) {
              Object.assign(result, {
                ok: false,
                note: "too many loads from this agent in the last minute",
              });
              done.push(result);
              stopped = "denied";
              break;
            }
            if (!(await loaded(browser, mark, Math.min(deadline, Date.now() + LOAD_TIMEOUT_MS)))) {
              result.note = "the page is still loading";
            }
          }
        } else {
          // find.forward, find.backward, find.next, find.previous (D11).
          const fresh = id === "find.forward" || id === "find.backward";
          if (fresh)
            last = { query: /** @type {string} */ (step.query), backward: id === "find.backward" };
          if (!last) {
            Object.assign(result, { ok: false, note: "no search to repeat in this call" });
          } else {
            const backward = id === "find.previous" ? !last.backward : last.backward;
            let outcome = null;
            for (let i = 0; i < count; i++) {
              outcome = await findOnce(browser, last.query, !fresh || i > 0 || backward, backward);
              if (outcome === null || outcome === FIND_NOTFOUND) break;
            }
            const found = outcome !== null && outcome !== FIND_NOTFOUND;
            find = { query: wf(last.query), found, wrapped: outcome === FIND_WRAPPED };
            if (!found) {
              Object.assign(result, {
                ok: false,
                note: outcome === null ? "the page did not answer the find" : "not found",
              });
            }
          }
        }
      } catch (e) {
        Object.assign(result, {
          ok: false,
          note: `failed: ${wf(/** @type {Error} */ (e)?.message ?? e)}`,
        });
      }
      done.push(result);
      this._onStep?.(done.length);
    }

    // The tab left the agent workspace on the last step: nothing of it is said (M2).
    if (!stillAgent()) {
      return {
        url: "",
        title: "",
        loading: false,
        scroll: { y: 0 },
        steps: done,
        stopped: "changed",
      };
    }
    /** @type {KeysResult} */
    const out = {
      url: wf(browser.currentURI?.spec ?? ""),
      title: wf(tab.label ?? ""),
      loading: !!browser.webProgress?.isLoadingDocument || tab.hasAttribute("busy"),
      scroll: { y: Math.round((await VimmaActors.scrollFraction(browser)) * 1000) / 1000 },
      steps: done,
    };
    if (stopped) out.stopped = stopped;
    if (find) out.find = find;
    return out;
  },
};
