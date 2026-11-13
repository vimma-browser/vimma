/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/start-page.md (typed and history loads) and docs/specs/firefox-surfaces-trim.md,
// decision 10. Firefox's own start pages and the privilegedabout process they live in: the start
// page module keeps Firefox's about: module while Firefox's page may live there (#950). Each test
// waits for real content processes to start and end, so this file has its own time budget, and a
// hang here cannot hide the trim file's other tests.

"use strict";

/* global requestLongerTimeout -- the browser-chrome harness (browser-test.js) */

// Four tests, each waiting for one to three content processes to launch and end: about 15 s in
// CI, over the default 45 s per file on a loaded machine.
requestLongerTimeout(2);

const { AboutNewTab } = ChromeUtils.importESModule("resource:///modules/AboutNewTab.sys.mjs");

const START = "chrome://browser/content/vimma/start/start.html";

/** Whether a privilegedabout content process (Firefox's new tab and home pages) is running. */
const aboutProcessRuns = () =>
  ChromeUtils.getAllDOMProcesses().some((p) => p.remoteType === "privilegedabout");

/**
 * Ends every privilegedabout process that holds no tab, and waits for its ipc:content-shutdown.
 * Firefox keeps one alive after its last tab (dom.ipc.keepProcessesAlive.privilegedabout), and
 * lowering that pref later does not end it: only a tab leaving checks the pref
 * (ContentParent::MaybeBeginShutDown). An earlier test file in the same browser session leaves
 * one: browser_vimma_branding_files.js opens about:logins. releaseCachedProcesses ends idle
 * processes whatever the pref. A process leaves getAllDOMProcesses as soon as it is marked dead,
 * before its ipc:content-shutdown, which is what clears the start page module's latch, so the
 * wait is for that notification too.
 * @param {string} what  the wait's message
 */
async function endAboutProcesses(what) {
  NewTabPagePreloading.removePreloadedBrowser(window);
  const ending = new Set(
    ChromeUtils.getAllDOMProcesses()
      .filter((p) => p.remoteType === "privilegedabout")
      .map((p) => p.childID),
  );
  /** @type {(subject: unknown, topic: string, id: string) => void} */
  const ended = (_subject, _topic, id) => ending.delete(Number(id));
  Services.obs.addObserver(ended, "ipc:content-shutdown");
  try {
    info(`waiting: ${what} (${[...ending].join(", ") || "none running"})`);
    await TestUtils.waitForCondition(
      () => {
        Services.ppmm.releaseCachedProcesses();
        return !aboutProcessRuns() && ending.size === 0;
      },
      what,
      100,
      150,
    );
  } finally {
    Services.obs.removeObserver(ended, "ipc:content-shutdown");
  }
}

/**
 * Runs `task` with Firefox's new tab page (vimma.startpage.newtab off), then waits for the
 * privilegedabout process to end before the start page comes back: while Firefox's page may live
 * there, the start page module keeps Firefox's (#950). Firefox keeps that process alive after its
 * last tab; the test lets it end, and keeps a preloaded Firefox new tab from holding it.
 * @param {() => Promise<void>} task
 */
async function withFirefoxNewTab(task) {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.startpage.newtab", false],
      ["dom.ipc.keepProcessesAlive.privilegedabout", 0],
      ["browser.newtab.preload", false],
    ],
  });
  try {
    await endAboutProcesses("no privilegedabout process before Firefox's page");
    await task();
  } finally {
    await endAboutProcesses("the privilegedabout process ends after Firefox's page");
    await SpecialPowers.popPrefEnv();
  }
}

/**
 * Loads `url` in `browser` and waits for it.
 * @param {any} browser
 * @param {string} url
 */
async function load(browser, url) {
  const loaded = BrowserTestUtils.browserLoaded(browser, false, url);
  BrowserTestUtils.startLoadingURIString(browser, url);
  await loaded;
}

// Once it has handed out Firefox's page, the start page module keeps Firefox's flags until a
// privilegedabout process that ran ends. The parent makes the page's channel before that
// process is alive, and getAllDOMProcesses leaves out a process still launching, so neither "no
// privilegedabout process is alive" nor the end of another content process may give the start
// page's flags back: a page loaded then would be killed when the start page is turned on (#950).
add_task(async function firefox_flags_stay_until_a_privilegedabout_process_ends() {
  const home = Services.io.newURI("about:home");
  const module = Cc["@mozilla.org/network/protocol/about;1?what=home"].getService(
    Ci.nsIAboutModule,
  );
  const startFlags = () => module.getURIFlags(home) === 0;
  await SpecialPowers.pushPrefEnv({
    set: [
      ["dom.ipc.keepProcessesAlive.privilegedabout", 0],
      ["browser.newtab.preload", false],
    ],
  });
  try {
    await endAboutProcesses("no privilegedabout process to begin with");
    Assert.ok(startFlags(), "the start page's flags to begin with");

    await SpecialPowers.pushPrefEnv({ set: [["vimma.startpage.newtab", false]] });
    try {
      // Firefox's page is handed out; its process is not alive yet.
      const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
      NetUtil.newChannel({ uri: home, loadUsingSystemPrincipal: true });
    } finally {
      await SpecialPowers.popPrefEnv();
    }
    Assert.ok(!startFlags(), "with no privilegedabout process alive yet, Firefox's flags stay");

    info("opening a web page in a process of its own");
    const web = await BrowserTestUtils.openNewForegroundTab({
      gBrowser,
      url: "https://example.org/",
      forceNewProcess: true,
    });
    const webID = web.linkedBrowser.browsingContext.currentWindowGlobal.domProcess.childID;
    const webEnded = TestUtils.topicObserved(
      "ipc:content-shutdown",
      (_s, id) => Number(id) === webID,
    );
    BrowserTestUtils.removeTab(web);
    info(`waiting: the web page's process ${webID} ends`);
    // Released at once, whatever the keep-alive and reuse prefs of its remote type.
    Services.ppmm.releaseCachedProcesses();
    await webEnded;
    Assert.ok(!startFlags(), "another content process ending keeps Firefox's flags");

    // A privilegedabout process that ran (about:logins) ends: the start page's flags come back.
    info("opening about:logins");
    const logins = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:logins");
    Assert.equal(logins.linkedBrowser.remoteType, "privilegedabout", "about:logins runs there");
    BrowserTestUtils.removeTab(logins);
    await endAboutProcesses("about:logins' process ends");
    info("waiting: the start page's flags come back");
    await TestUtils.waitForCondition(startFlags, "the start page's flags come back", 100, 50);
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function firefox_new_tab_stays_without_the_start_page() {
  await withFirefoxNewTab(async () => {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
    info("loading about:newtab");
    await load(tab.linkedBrowser, "about:newtab");
    const spec = tab.linkedBrowser.currentURI.spec;
    BrowserTestUtils.removeTab(tab);
    Assert.equal(spec, "about:newtab", "with the start page off, Firefox's new tab page loads");
  });
});

// Turning the start page on while Firefox's page is open must not get that page's process killed:
// the parent checks the page's principal on each message, such as a blob URL registration, against
// the about: module's flags at that moment (#950).
add_task(async function turning_the_start_page_on_keeps_firefox_new_tab_alive() {
  /** @type {number[]} */
  const abnormal = [];
  /** @type {(subject: any, topic: string, id: string) => void} */
  const onShutdown = (subject, _topic, id) => {
    const props = subject.QueryInterface(Ci.nsIPropertyBag2);
    if (props.hasKey("abnormal")) abnormal.push(Number(id));
  };
  Services.obs.addObserver(onShutdown, "ipc:content-shutdown");
  let childID = -1;
  try {
    await withFirefoxNewTab(async () => {
      const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
      const browser = tab.linkedBrowser;
      info("loading about:newtab");
      await load(browser, "about:newtab");
      Assert.equal(browser.remoteType, "privilegedabout", "Firefox's page is in its own process");
      childID = browser.browsingContext.currentWindowGlobal.domProcess.childID;
      await SpecialPowers.pushPrefEnv({ set: [["vimma.startpage.newtab", true]] });
      try {
        // The registration reaches the parent now; its unregistration when the tab goes, below.
        const url = await SpecialPowers.spawn(browser, [], () =>
          content.URL.createObjectURL(new content.Blob(["vimma"])),
        );
        Assert.ok(url.startsWith("blob:"), "Firefox's page still registers a blob URL");
        Assert.equal(AboutNewTab.newTabURL, START, "new tabs open the start page at once");
        await load(browser, "about:home");
        Assert.equal(
          browser.currentURI.spec,
          "about:home",
          "Firefox's pages stay while their process runs",
        );
        await SpecialPowers.spawn(browser, [], () => {
          content.URL.createObjectURL(new content.Blob(["vimma"]));
        });
      } finally {
        // Closed with the start page still on, so the page's blob URLs are unregistered then.
        BrowserTestUtils.removeTab(tab);
        await endAboutProcesses("Firefox's page's process ends with the start page on");
        await SpecialPowers.popPrefEnv();
      }
    });
  } finally {
    Services.obs.removeObserver(onShutdown, "ipc:content-shutdown");
  }
  Assert.greater(childID, 0, "Firefox's page had a content process");
  Assert.ok(!abnormal.includes(childID), "the content process is not killed");
});

// A history entry recorded as Firefox's page comes back as the start page once Firefox's page is
// gone: the start page replaces itself (start.mjs). Without bfcache, leaving Firefox's page ends
// its process.
add_task(async function firefox_page_from_history_comes_back_as_the_start_page() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank");
  const browser = tab.linkedBrowser;
  await withFirefoxNewTab(async () => {
    await SpecialPowers.pushPrefEnv({ set: [["browser.sessionhistory.max_total_viewers", 0]] });
    try {
      info("loading about:newtab, then example.com");
      await load(browser, "about:newtab");
      await load(browser, "https://example.com/");
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  });
  const loaded = BrowserTestUtils.browserLoaded(browser, false, START);
  info("going back to the entry recorded as Firefox's page");
  browser.goBack();
  await loaded;
  Assert.equal(browser.currentURI.spec, START, "the entry comes back as the start page's URL");
  BrowserTestUtils.removeTab(tab);
});
