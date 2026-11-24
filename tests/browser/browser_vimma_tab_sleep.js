/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/tab-sleep.md, Behaviour 1-8, decisions 1-13 and 20 (Delivery slice 1). The
// check runs with a clock moved past `[tabs] sleep_after` (TabSleep._check(now)); the agent
// workspace's rule is in browser_vimma_agent_tab_sleep.js.

"use strict";

/* global focusContent -- from head.js */
/* global requestLongerTimeout -- the browser-chrome harness (browser-test.js) */
// Splits, a private window and a held download: past the default timeout on a busy runner.
requestLongerTimeout(2);

const { TabSleep } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/services/TabSleep.sys.mjs",
);
const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);
const { SessionStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
);
const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");

const CHECK_MS = "vimma.tabs.sleepCheckMs";
const HOUR = 60 * 60_000;
const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const LONG = `${ROOT}file_vimma_insert_scroll.html`;
const UNSAVED = `${ROOT}file_vimma_tab_sleep_unload.html`;
const DOWNLOADS = `${ROOT}file_vimma_downloads.sjs`;
const PAGE = "https://example.com/";
const dir = PathUtils.join(PathUtils.tempDir, `vimma-tab-sleep-${Date.now()}`);
const configFile = PathUtils.join(dir, "config.toml");
const saveDir = PathUtils.join(dir, "downloads");

/** @typedef {MozTabbrowserTab} Tab */

/** @param {() => unknown} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 200);
}

/** @param {BrowserWindow} [win] */
function nextFrame(win = window) {
  return new Promise((r) => win.requestAnimationFrame(() => win.requestAnimationFrame(r)));
}

/** @param {BrowserWindow} [win] */
const view = (win = window) => /** @type {PaneView} */ (PaneViews.get(win));

/** A check `hours` from now: every tab not seen since is past the default two hours. */
const check = (hours = 3) => TabSleep._check(Date.now() + hours * HOUR);

/** @param {Tab} t */
const asleep = (t) => !t.linkedPanel;

/** @type {Tab[]} */
const opened = [];
/** @type {Window[]} */
const windows = [];

function closeOpened() {
  for (const t of opened.splice(0)) {
    const win = /** @type {BrowserWindow | null} */ (t.ownerDocument?.defaultView ?? null);
    if (win && !win.closed && !t.closing && t.parentNode) win.gBrowser.removeTab(t);
  }
}

registerCleanupFunction(async () => {
  closeOpened();
  for (const w of windows) if (!w.closed) await BrowserTestUtils.closeWindow(w);
  await fetch(`${DOWNLOADS}?release`);
  const list = await Downloads.getList(Downloads.ALL);
  for (const d of await list.getAll()) {
    await list.remove(d);
    await d.finalize(true);
  }
  await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
  await SpecialPowers.popPrefEnv();
  await ConfigHost.reload();
});

/**
 * A background tab loaded with `url`.
 * @param {string} url
 * @param {BrowserWindow} [win]
 */
async function background(url, win = window) {
  const t = /** @type {Tab} */ (BrowserTestUtils.addTab(win.gBrowser, url));
  opened.push(t);
  await BrowserTestUtils.browserLoaded(t.linkedBrowser, false, url);
  await until(() => !t.hasAttribute("busy"), "the tab is done loading");
  return t;
}

/** The long page at 1200 with text typed into its field; `?back` came before it. */
async function longPage() {
  const t = await background(`${PAGE}?back`);
  BrowserTestUtils.startLoadingURIString(t.linkedBrowser, LONG);
  await BrowserTestUtils.browserLoaded(t.linkedBrowser, false, LONG);
  await SpecialPowers.spawn(t.linkedBrowser, [], () => {
    const field = /** @type {HTMLInputElement} */ (content.document.getElementById("text"));
    field.value = "kept";
    field.dispatchEvent(new content.Event("input", { bubbles: true }));
    content.scrollTo(0, 1200);
  });
  return t;
}

/** @param {Tab} t */
async function readLong(t) {
  try {
    return await SpecialPowers.spawn(t.linkedBrowser, [], () => ({
      y: content.scrollY,
      text: /** @type {HTMLInputElement | null} */ (content.document.getElementById("text"))?.value,
    }));
  } catch {
    return null;
  }
}

/** Writes config.toml and waits until it is in force. @param {string} text */
async function config(text) {
  await IOUtils.writeUTF8(configFile, text);
  await ConfigHost.reload();
}

/** Counts the TabBrowserDiscarded events of `win` until `stop`. @param {BrowserWindow} [win] */
function discards(win = window) {
  /** @type {Tab[]} */
  const seen = [];
  const on = (/** @type {Event} */ e) => seen.push(/** @type {Tab} */ (e.target));
  win.addEventListener("TabBrowserDiscarded", on);
  return { seen, stop: () => win.removeEventListener("TabBrowserDiscarded", on) };
}

add_task(async function setup() {
  await IOUtils.makeDirectory(saveDir);
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.config.path", configFile],
      ["browser.download.dir", saveDir],
      ["browser.download.folderList", 2],
      ["browser.download.always_ask_before_handling_new_types", false],
    ],
  });
  await config("");
  await /** @type {WindowWorkspacesImpl} */ (WindowWorkspaces.get(window)).ready;
});

add_task(async function a_background_tab_unseen_past_sleep_after_is_discarded() {
  const t = await longPage();
  Assert.deepEqual(await check(1), [], "an hour unseen: under the default two hours");
  Assert.ok(!asleep(t), "the tab stays loaded");
  const slept = await check(3);
  Assert.ok(slept.includes(t), "three hours unseen: it goes to sleep");
  Assert.ok(asleep(t), "Firefox discarded it");
  Assert.ok(t.isConnected && !t.closing, "the tab stays in the strip");
  const state = JSON.parse(SessionStore.getTabState(t));
  Assert.deepEqual(
    state.entries.map((/** @type {{ url: string }} */ e) => e.url),
    [`${PAGE}?back`, LONG],
    "its back and forward history is kept",
  );
  Assert.equal(state.scroll?.scroll, "0,1200", "and its scroll position");
  Assert.deepEqual(await check(3), [], "a sleeping tab is not planned again");
});

add_task(async function selecting_a_sleeping_tab_restores_its_page() {
  const t = opened.find((x) => asleep(x));
  Assert.ok(t, "the tab the last task put to sleep");
  const tab = /** @type {Tab} */ (t);
  await BrowserTestUtils.switchTab(gBrowser, tab);
  await until(() => !asleep(tab) && !tab.hasAttribute("pending"), "selecting it loads it again");
  await TestUtils.waitForCondition(
    () => readLong(tab).then((r) => r?.y === 1200 && r.text === "kept"),
    "at 1200 with its typed text",
  );
  closeOpened();
});

add_task(async function the_selected_tab_and_every_pane_of_the_shown_split_stay_loaded() {
  const a = await background(`${PAGE}?a`);
  const b = await background(`${PAGE}?b`);
  const c = await background(`${PAGE}?c`);
  await BrowserTestUtils.switchTab(gBrowser, a);
  Assert.ok(
    view().showTabs(/** @type {SplitTab[]} */ ([a, b, c]), /** @type {SplitTab} */ (a)).ok,
    "a | b | c",
  );
  await until(() => view().panes && !view().hidden, "the split shows");
  view().zoom();
  await nextFrame();
  const events = discards();
  const slept = await check(3);
  events.stop();
  Assert.ok(![a, b, c].some((t) => slept.includes(t)), "no pane is put to sleep");
  Assert.deepEqual(events.seen, [], "nor reloaded: Firefox discarded none");
  Assert.ok(!asleep(b) && !asleep(c), "zoomed-away panes stay loaded too");
  view().zoom();
  closeOpened();
  await until(() => !view().panes, "no split left");
});

add_task(async function a_pane_watched_without_focus_sleeps_only_after_its_split_is_hidden() {
  const a = await background(`${PAGE}?a`);
  const b = await background(`${PAGE}?b`);
  const c = await background(`${PAGE}?c`);
  await BrowserTestUtils.switchTab(gBrowser, a);
  Assert.ok(
    view().showTabs(/** @type {SplitTab[]} */ ([a, b]), /** @type {SplitTab} */ (a)).ok,
    "a | b, focus on a",
  );
  await until(() => view().panes && !view().hidden, "the split shows");
  // b is watched without focus for three hours: its lastAccessed stays at the start.
  const watched = Date.now() + 3 * HOUR;
  await TabSleep._check(watched);
  await BrowserTestUtils.switchTab(gBrowser, c);
  await until(() => view().hidden, "c shows alone, the split hidden");
  Assert.deepEqual(
    await TabSleep._check(watched + 10 * 60_000),
    [],
    "ten minutes after the split was hidden, its panes stay loaded",
  );
  Assert.ok(!asleep(a) && !asleep(b), "a and b are loaded");

  // A hidden split's tabs sleep like any other, and wake when the split shows.
  const slept = await TabSleep._check(watched + 3 * HOUR);
  Assert.ok(slept.includes(a) && slept.includes(b), "three hours on, the hidden split sleeps");
  Assert.ok(asleep(a) && asleep(b), "both are discarded");
  Assert.ok(view().hidden, "the split is still a hidden view");
  gBrowser.selectedTab = b;
  await until(() => !view().hidden && view().panes, "selecting b shows the split");
  await until(
    () => !asleep(a) && !asleep(b) && !a.hasAttribute("pending") && !b.hasAttribute("pending"),
    "both panes load again",
  );
  await until(
    () =>
      a.linkedBrowser.currentURI.spec === `${PAGE}?a` &&
      b.linkedBrowser.currentURI.spec === `${PAGE}?b`,
    "with their pages",
  );
  closeOpened();
  await until(() => !view().panes, "no split left");
});

add_task(async function pinned_sound_and_private_tabs_stay_loaded() {
  // Vimma unpins a tab pinned while workspaces are on (m3-workspaces decision 11); a pinned tab
  // still exists without them, and the rule holds for it.
  const ww = /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(window));
  ww.unpinsPinnedTabs = false;
  const pinned = await background(`${PAGE}?pinned`);
  gBrowser.pinTab(pinned);
  const sound = await background(`${PAGE}?sound`);
  // What tabbrowser sets while a page plays sound (tab.mjs, soundPlaying); discardBrowser itself
  // drops it, so only TabSleep's own rule keeps this tab.
  sound.toggleAttribute("soundplaying", true);
  const plain = await background(`${PAGE}?plain`);
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  windows.push(priv);
  const privTab = await background(`${PAGE}?private`, priv);
  await SimpleTest.promiseFocus(window);

  const slept = await check(3);
  Assert.ok(slept.includes(plain), "a plain background tab sleeps");
  Assert.ok(!asleep(pinned), "a pinned tab stays loaded");
  Assert.ok(!asleep(sound), "a tab playing sound stays loaded");
  Assert.ok(!asleep(privTab), "a private window's tab stays loaded");
  sound.removeAttribute("soundplaying");
  gBrowser.unpinTab(pinned);
  ww.unpinsPinnedTabs = true;
  closeOpened();
  await BrowserTestUtils.closeWindow(priv);
});

add_task(async function a_page_with_unsaved_input_stays_loaded_and_asks_nothing() {
  const t = await background(UNSAVED);
  await SpecialPowers.spawn(t.linkedBrowser, [], () => {
    // A beforeunload request counts only after the user used the page.
    content.document.notifyUserGestureActivation();
    const draft = /** @type {HTMLTextAreaElement} */ (content.document.getElementById("draft"));
    draft.value = "unsaved";
  });
  let prompts = 0;
  const onPrompt = () => prompts++;
  Services.obs.addObserver(onPrompt, "common-dialog-loaded");
  Services.obs.addObserver(onPrompt, "tabmodal-dialog-loaded");
  const slept = await check(3);
  Services.obs.removeObserver(onPrompt, "common-dialog-loaded");
  Services.obs.removeObserver(onPrompt, "tabmodal-dialog-loaded");
  Assert.ok(!slept.includes(t) && !asleep(t), "the page with unsaved input stays loaded");
  Assert.equal(prompts, 0, "and no prompt was shown");
  await SpecialPowers.spawn(t.linkedBrowser, [], () => {
    /** @type {HTMLTextAreaElement} */ (content.document.getElementById("draft")).value = "";
  });
  closeOpened();
});

add_task(async function an_about_page_stays_loaded() {
  const t = await background("about:robots");
  const web = await background(`${PAGE}?web`);
  const slept = await check(3);
  Assert.ok(slept.includes(web), "a web page sleeps");
  Assert.ok(!slept.includes(t) && !asleep(t), "about:robots stays loaded");
  closeOpened();
});

add_task(async function a_site_with_sleep_false_stays_loaded() {
  await config('[sites."example.org"]\nsleep = false\n');
  const kept = await background("https://test1.example.org/");
  const other = await background(`${PAGE}?other`);
  const slept = await check(3);
  Assert.ok(slept.includes(other), "example.com sleeps");
  Assert.ok(!asleep(kept), "a subdomain of example.org stays loaded");
  await config("");
  closeOpened();
});

add_task(async function sleep_after_zero_stops_the_check_and_a_new_value_starts_it() {
  await SpecialPowers.pushPrefEnv({ set: [[CHECK_MS, 60_000]] });
  await config("[tabs]\nsleep_after = 0\n");
  Assert.ok(!TabSleep.running, "sleep_after = 0: no check runs");
  const t = await background(`${PAGE}?off`);
  Assert.deepEqual(await check(1000), [], "and a check asked for puts nothing to sleep");
  Assert.ok(!asleep(t), "the tab stays loaded");
  await config("[tabs]\nsleep_after = 5\n");
  Assert.ok(TabSleep.running, "a new value starts the check at the next read");
  const slept = await TabSleep._check(Date.now() + 6 * 60_000);
  Assert.ok(slept.includes(t), "five minutes is the limit now");
  await config("");
  await SpecialPowers.popPrefEnv();
  closeOpened();
});

add_task(async function the_interval_set_by_vimma_tabs_sleepCheckMs_runs_a_check() {
  const before = TabSleep.checks;
  await SpecialPowers.pushPrefEnv({ set: [[CHECK_MS, 100]] });
  await until(() => TabSleep.checks >= before + 2, "the check runs on its own, more than once");
  await SpecialPowers.popPrefEnv();
});

add_task(async function a_download_started_from_a_tab_continues_while_the_tab_sleeps() {
  const from = await background(`${PAGE}?download`);
  /** @type {Promise<FirefoxDownload>} */
  const added = new Promise((resolve) => {
    Downloads.getList(Downloads.ALL).then((list) => {
      const v = {
        /** @param {FirefoxDownload} d */
        onDownloadAdded(d) {
          list.removeView(v);
          resolve(d);
        },
      };
      list.addView(v);
    });
  });
  await SpecialPowers.spawn(from.linkedBrowser, [`${DOWNLOADS}?hold&name=sleep.bin`], (u) => {
    const a = content.document.createElement("a");
    a.href = u;
    a.download = "";
    content.document.body.append(a);
    a.click();
  });
  const download = await added;
  // The fixture holds the rest of the file until ?release: the download is under way.
  Assert.ok(!download.stopped && !download.succeeded, "the download is under way");
  const slept = await check(3);
  Assert.ok(slept.includes(from) && asleep(from), "the tab it came from sleeps");
  Assert.ok(!download.stopped, "the download goes on");
  await fetch(`${DOWNLOADS}?release`);
  await download.whenSucceeded();
  Assert.ok(download.succeeded, "and finishes");
  closeOpened();
});

// Delivery slice 4: on for everyone, with no pref to set, at the default two hours.
add_task(async function by_default_a_tab_unseen_for_two_hours_sleeps() {
  await config("");
  Assert.ok(TabSleep.running, "the check runs with an empty config.toml");
  const t = await background(`${PAGE}?default`);
  Assert.deepEqual(await check(1.9), [], "not yet at 1 h 54 min");
  Assert.ok(!asleep(t), "the tab stays loaded");
  Assert.deepEqual(await check(2.1), [t], "asleep past two hours");
  Assert.ok(asleep(t), "the tab has no loaded page");
  closeOpened();
  await focusContent(gBrowser.selectedBrowser);
});
