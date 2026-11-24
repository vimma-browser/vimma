/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Tabs put to sleep by hand (docs/specs/tab-sleep.md Behaviour 9-13): `:sleep`, `:sleep all`,
// `:sleep N` and the side panel's `z`. TabSleep applies the rules; this module picks the tabs
// and words the outcome for the notice.

import { noTabText } from "../core/cmdline.mjs";
import {
  PRIVATE_SLEEP_TEXT,
  namedSleepText,
  outcomeReport,
  sleepReport,
} from "../core/tabsleep.mjs";
import { TabSleep } from "../services/TabSleep.sys.mjs";
import { selectableTabs } from "./tab-ops.mjs";

/** @import { Action } from "../core/dispatcher.mjs" */
/** @import { SleepOutcome } from "../core/tabsleep.mjs" */

const lazy = /** @type {Lazy<"PrivateBrowsingUtils">} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

/** @typedef {MozTabbrowserTab} Tab */

/** @param {BrowserWindow} win */
const isPrivate = (win) => lazy.PrivateBrowsingUtils.isWindowPrivate(win);

/** `:sleep`'s report of `outcomes`. @param {readonly SleepOutcome[]} outcomes */
const report = (outcomes) => sleepReport(outcomeReport(outcomes));

/**
 * `tab.sleep`: this workspace's tabs, `all` (every normal window's), or tab N by the number
 * `{N}gt` uses (`action.count`); `text` is N as typed, for "no tab N". Resolves to the notice.
 * @param {BrowserWindow} win
 * @param {Action} action
 * @param {string} [text]
 * @returns {Promise<string>}
 */
export async function sleepCommand(win, action, text) {
  if (isPrivate(win)) return PRIVATE_SLEEP_TEXT;
  if (text === "all") {
    /** @type {{ win: BrowserWindow, tab: Tab }[]} */
    const all = [];
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      if (w.closed || !w.gBrowser || isPrivate(w)) continue;
      for (const tab of /** @type {Tab[]} */ (w.gBrowser.tabs)) {
        if (!tab.closing) all.push({ win: w, tab });
      }
    }
    return report(await TabSleep.sleepTabs(all, "hand"));
  }
  const tabs = selectableTabs(win);
  if (action.count) {
    const tab = tabs[action.count - 1];
    if (!tab) return noTabText(text ?? String(action.count), tabs.length);
    const [reason = null] = await TabSleep.sleepTabs([{ win, tab }], "named");
    return namedSleepText([{ number: action.count, reason }]);
  }
  return report(
    await TabSleep.sleepTabs(
      tabs.map((tab) => ({ win, tab })),
      "hand",
    ),
  );
}

/**
 * The side panel's `z`: `rows`' tabs, each named as `:sleep N` names one (decision 14), said by
 * its row number. Resolves to the notice.
 * @param {BrowserWindow} win
 * @param {readonly { tab: Tab, number: number }[]} rows
 * @returns {Promise<string>}
 */
export async function sleepRows(win, rows) {
  if (isPrivate(win)) return PRIVATE_SLEEP_TEXT;
  const outcomes = await TabSleep.sleepTabs(
    rows.map(({ tab }) => ({ win, tab })),
    "named",
  );
  return namedSleepText(rows.map(({ number }, i) => ({ number, reason: outcomes[i] ?? null })));
}
