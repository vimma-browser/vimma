/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Perf timings (plan §5 "key-to-paint in the window", issue #17; m4-split-panes "Perf", m3's
// 200-tab risk in plan §9): key to paint for ctrl+b l across two live panes, and ctrl+b ) / (
// into and out of a workspace of 200 tabs. Read-only: it presses keys and listens for the
// chrome window's MozAfterPaint; nothing in the product reports a timestamp.
//
// Each case logs one `VIMMA_PERF {json}` line (median, p90, max over SAMPLES presses) and
// checks the medians against BUDGETS, set from CI runs (docs/runbook/ci-key-to-paint-timings.md,
// "Key-to-paint timings").

"use strict";

/* global focusContent -- from head.js */

const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);

const PAGE = "https://example.com/";
const SAMPLES = 21;
const TABS = 200;

/**
 * Median budgets in ms, per case and timing; `null`: recorded, not gated (the floors are the
 * yardstick, not a target). About twice the higher median of two CI runs on PR #108
 * (ubuntu-24.04, headless artifact build; action / paint): pane-focus 8.7 / 37.9 and
 * 10.6 / 40.7, workspace-200-in 9.2 / 55.4 and 12.8 / 76.4, workspace-200-out 9.4 / 36.6 and
 * 12.8 / 56.5; floor paint 35.1 and 36.2. Re-record from CI, never from a laptop (runbook).
 * @type {Record<string, { action: number | null, paint: number | null }>}
 */
const BUDGETS = {
  floor: { action: null, paint: null },
  "key-floor": { action: null, paint: null },
  "pane-focus": { action: 25, paint: 85 },
  "workspace-200-in": { action: 25, paint: 150 },
  "workspace-200-out": { action: 25, paint: 115 },
};

/**
 * A value the test's own lookup found. It changes nothing at run time: a read through a missing
 * one throws, as it did before.
 * @template T
 * @param {T | null | undefined} value
 */
function found(value) {
  return /** @type {T} */ (value);
}

// The window's workspaces and pane view, which Vimma made when it started this window.
const ww = () => found(WindowWorkspaces.get(window));
const view = () => found(PaneViews.get(window));
/** The window's workspace model, which it has once its workspaces are set up. */
const workspaceModel = () => found(ww().model);
/** @type {string[]} */
const created = [];

registerCleanupFunction(async () => {
  while (view().panes) view().close();
  const main = WorkspaceStore.definitions.workspaces.find((w) => w.name === "main");
  if (main) ww().switchTo({ id: main.id });
  for (const id of created) await WorkspaceStore.deleteWorkspace(id, { confirmed: true });
  while (gBrowser.tabs.length > 1) {
    gBrowser.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
  }
  Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
});

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 20, 250);
}

/** Two frames and a tick: whatever the last step scheduled has painted. */
async function settle() {
  for (let i = 0; i < 2; i++) {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await TestUtils.waitForTick();
  }
}

/**
 * One timed press. `action`: from just before the key to when the synchronous key handling
 * returns. `paint`: from just before the key to the first MozAfterPaint of this window after
 * which `done()` holds (the paint that can show the result).
 * @param {() => void} press
 * @param {() => boolean} done
 * @param {{ paint?: boolean }} [options] paint: false when the press changes nothing on screen
 */
async function timePress(press, done, { paint: waitPaint = true } = {}) {
  await settle();
  /** @type {(t: number) => void} */
  let painted = () => {};
  const paint = new Promise((r) => (painted = r));
  const onPaint = () => {
    if (done()) painted(performance.now());
  };
  window.addEventListener("MozAfterPaint", onPaint);
  try {
    const t0 = performance.now();
    press();
    const t1 = performance.now();
    await until(done, "the key took effect");
    if (!waitPaint) return { action: t1 - t0, paint: Number.NaN };
    const t2 = await Promise.race([
      paint,
      new Promise((r) => setTimeout(() => r(Number.NaN), 5000)),
    ]);
    return { action: t1 - t0, paint: t2 - t0 };
  } finally {
    window.removeEventListener("MozAfterPaint", onPaint);
  }
}

/** @param {number[]} xs @param {number} q */
function quantile(xs, q) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

/**
 * @param {string} name
 * @param {Array<{ action: number, paint: number }>} samples
 */
function report(name, samples) {
  /** @param {"action" | "paint"} k */
  const stats = (k) => {
    const xs = samples.map((s) => s[k]).filter(Number.isFinite);
    if (xs.length === 0) return null;
    const r = (/** @type {number} */ x) => Math.round(x * 100) / 100;
    return { median: r(quantile(xs, 0.5)), p90: r(quantile(xs, 0.9)), max: r(Math.max(...xs)) };
  };
  const result = {
    case: name,
    samples: samples.length,
    action: stats("action"),
    paint: stats("paint"),
  };
  info(`VIMMA_PERF ${JSON.stringify(result)}`);
  Assert.ok(
    name === "key-floor" || samples.every((s) => Number.isFinite(s.paint)),
    `${name}: every press was followed by a paint`,
  );
  const budget = BUDGETS[name];
  for (const k of /** @type {const} */ (["action", "paint"])) {
    const limit = budget?.[k];
    if (limit === null || limit === undefined) continue;
    Assert.lessOrEqual(
      result[k]?.median ?? Infinity,
      limit,
      `${name}: median ${k} within ${limit} ms`,
    );
  }
  return result;
}

/**
 * ctrl+b, then `key`.
 * @param {string} key
 * @param {KeyEventOptions} [mods]
 */
function prefix(key, mods = {}) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key, mods);
}

// The floor: an outline drawn on the status bar, no key and no Vimma code, to the next paint.
// Key-to-paint can only be read against it: the refresh driver paints on its own clock, so even
// a change that costs nothing waits for the next tick.
add_task(async function paint_floor_without_a_key() {
  const bar = /** @type {HTMLElement} */ (document.getElementById("vimma-statusbar"));
  const samples = [];
  let on = false;
  for (let i = 0; i < SAMPLES; i++) {
    const want = !on;
    samples.push(
      await timePress(
        () => {
          bar.style.outline = want ? "1px solid red" : "";
          on = want;
        },
        () => on === want,
      ),
    );
  }
  bar.style.outline = "";
  report("floor", samples);
});

// The key floor: ctrl+b then esc (the prefix, then cancelled: Vimma's dispatch, no action), so
// what EventUtils and the key path cost on their own is not read as an action's cost.
add_task(async function key_floor_prefix_then_escape() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?floor`);
  await focusContent(tab.linkedBrowser);
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    samples.push(
      await timePress(
        () => {
          EventUtils.synthesizeKey("b", { ctrlKey: true });
          EventUtils.synthesizeKey("KEY_Escape");
        },
        () => true,
        { paint: false },
      ),
    );
  }
  report("key-floor", samples);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function key_to_paint_pane_focus_across_two_live_panes() {
  const a = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?a`);
  const b = /** @type {SplitTab} */ (
    await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?b`)
  );
  await BrowserTestUtils.switchTab(gBrowser, a);
  Assert.ok(view().split("vertical", { tab: b }).ok, "split a | b");
  view().focus("left");
  await focusContent(a.linkedBrowser);
  await until(() => gBrowser.selectedTab === a, "sanity: the left pane has focus");

  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    const to = gBrowser.selectedTab === a ? b : a;
    const key = to === b ? "l" : "h";
    samples.push(
      await timePress(
        () => prefix(key),
        () => gBrowser.selectedTab === to,
      ),
    );
  }
  report("pane-focus", samples);
  while (view().panes) view().close();
  BrowserTestUtils.removeTab(b);
  BrowserTestUtils.removeTab(a);
});

add_task(async function key_to_paint_workspace_switch_with_200_tabs() {
  const big = WorkspaceStore.addWorkspace({ name: "perf-200", color: "blue", icon: "briefcase" });
  created.push(big.id);
  const main = WorkspaceStore.definitions.workspaces.find((w) => w.name === "main");
  ww().switchTo({ id: big.id });
  await until(() => workspaceModel().active === big.id, "sanity: in perf-200");
  const userContextId = big.userContextId;
  Assert.ok(userContextId, "sanity: perf-200 has a container of its own");
  const principal = Services.scriptSecurityManager.getSystemPrincipal();
  // Lazy tabs, as most of a large restored workspace is: hidden and shown like any other.
  while (gBrowser.visibleTabs.length < TABS) {
    gBrowser.addTab("about:blank", {
      createLazyBrowser: true,
      skipAnimation: true,
      userContextId,
      triggeringPrincipal: principal,
    });
  }
  const bigTabs = workspaceModel().workspaces.find((w) => w.id === big.id)?.tabs.length;
  Assert.equal(bigTabs, TABS, `perf-200 holds ${TABS} tabs`);
  // The profile's own workspace, which every profile has.
  const mainId = found(main).id;
  ww().switchTo({ id: mainId });
  await until(() => workspaceModel().active === mainId, "sanity: back in main");
  // Two workspaces only (main and perf-200, plus any the profile has): ) and ( alternate
  // between main and perf-200 when they are neighbours; switch by name otherwise.
  // The agent workspace (docs/specs/vimma-mcp.md decision 9) sorts last and is not cycled.
  const all = WorkspaceStore.definitions.workspaces.map((w) => w.id);
  Assert.equal(all.at(-1), WorkspaceStore.agent?.id, "sanity: the agent workspace is last");
  const order = all.filter((id) => id !== WorkspaceStore.agent?.id);
  Assert.equal(order.at(-1), big.id, "sanity: perf-200 is the last cycled workspace");
  Assert.equal(order.length, 2, "sanity: main and perf-200 are the only cycled workspaces");

  const into = [];
  const outOf = [];
  for (let i = 0; i < SAMPLES; i++) {
    into.push(
      await timePress(
        () => prefix(")", { shiftKey: true }),
        () => workspaceModel().active === big.id && gBrowser.visibleTabs.length === TABS,
      ),
    );
    outOf.push(
      await timePress(
        () => prefix("(", { shiftKey: true }),
        () => workspaceModel().active === mainId && gBrowser.visibleTabs.length < TABS,
      ),
    );
  }
  report("workspace-200-in", into);
  report("workspace-200-out", outOf);
});
