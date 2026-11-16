/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The agent commands' waits (docs/specs/vimma-mcp.md, decision 4): whether a page is loading,
// a time limit for a step, and the raise of a tab's content process while a command works on it
// (issue #605). This module asks nothing and finds no tab: agent-commands.mjs, which asks the
// gate and holds the tab model, passes it the tab or its browser.

import { AgentError } from "./agent-errors.mjs";

/** @import { Tab } from "./agent-tabs.mjs" */

/** @typedef {"setTimeout"} LazyName */
const lazy = /** @type {Lazy<LazyName>} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** How long a read waits for a page (a lazy tab's first load) before it gives up. */
export const LOAD_TIMEOUT_MS = 20000;

/** Whether the page in `tab` is loading no document now. @param {Tab} tab */
export const notLoading = (tab) => !(tab.linkedBrowser.webProgress?.isLoadingDocument ?? true);

/** @param {MozBrowser} browser  the id of its top document */
export const docOf = (browser) => browser.browsingContext?.currentWindowGlobal?.innerWindowId ?? 0;

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => lazy.setTimeout(resolve, ms));

/**
 * `promise`, or a `failed` refusal after `ms`.
 * @template T
 * @param {number} ms @param {Promise<T>} promise
 * @returns {Promise<T>}
 */
export function within(ms, promise) {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new AgentError("failed", "reading the page took too long");
    }),
  ]);
}

/**
 * The agent tabs' browsers that commands are running on, and how many commands each.
 * @type {Map<MozBrowser, { count: number, ours: Set<{ priorityHint: boolean }>,
 *   apply: () => void }>}
 */
const raised = new Map();

/**
 * Runs the content process of `browser` at foreground priority until the returned release is
 * called. An agent works on hidden tabs, whose processes Firefox keeps at background priority,
 * and on macOS that also puts their main thread at the lowest QoS class
 * (threads.lower_mainthread_priority_in_background): a page then loads and answers many times
 * slower than a shown one (issue #605). The tab switcher raises a tab it is about to show the
 * same way, through nsIRemoteTab.priorityHint, which neither renders nor shows anything. A lazy
 * tab gets its process during the command, and a load can move the page to another process:
 * each new frame loader is raised too. Overlapping commands on one tab share the raise.
 * @param {MozBrowser} browser
 * @returns {() => void} release
 */
export function raisePriority(browser) {
  let entry = raised.get(browser);
  if (!entry) {
    /** @type {{ count: number, ours: Set<{ priorityHint: boolean }>, apply: () => void }} */
    const e = {
      count: 0,
      ours: new Set(),
      apply() {
        const remote = browser.frameLoader?.remoteTab;
        // A hint that is already set belongs to the tab switcher: it stays as it is.
        if (!remote || remote.priorityHint) return;
        remote.priorityHint = true;
        e.ours.add(remote);
      },
    };
    entry = e;
    raised.set(browser, e);
    browser.addEventListener("XULFrameLoaderCreated", e.apply);
    e.apply();
  }
  entry.count++;
  const e = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--e.count > 0) return;
    raised.delete(browser);
    browser.removeEventListener("XULFrameLoaderCreated", e.apply);
    // A tab the user shows meanwhile is the tab switcher's to keep raised.
    if (browser.docShellIsActive) return;
    const remote = browser.frameLoader?.remoteTab;
    if (remote && e.ours.has(remote)) remote.priorityHint = false;
  };
}
