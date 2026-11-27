/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/vimma-mcp.md decision 30: pages in the agent workspace's
// container ask for no permission and open no pop-up. Every nsIContentPermissionPrompt request
// from the agent container is cancelled (Integration.contentPermission); camera, microphone and
// screen are denied by a session DENY on each origin that loads there (WebRTCParent and
// MediaManager read it); every agent tab's browsing context has SANDBOXED_AUXILIARY_NAVIGATION.
// A tab of another workspace still asks and still opens pop-ups.

/* global contextOf -- from head.js */

"use strict";

/* global PopupNotifications -- the browser window's (browser.js) */

const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
const { BrowserWindowTracker } = ChromeUtils.importESModule(
  "resource:///modules/BrowserWindowTracker.sys.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { AgentPages } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentPages.sys.mjs",
);

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = `${DIR}file_vimma_agent_page.html`;
const SANDBOXED_AUXILIARY_NAVIGATION = 0x2;

add_task(async function setup() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["media.navigator.streams.fake", true],
      // Fake devices skip the permission check unless this is set (MediaManager, askPermission).
      ["media.navigator.permission.fake", true],
      // No loopback devices, so only the fakes are there (browser/base/content/test/webrtc).
      ["media.audio_loopback_dev", ""],
      ["media.video_loopback_dev", ""],
      ["media.navigator.permission.disabled", false],
      ["geo.provider.testing", true],
      ["dom.disable_open_during_load", true],
    ],
  });
  registerCleanupFunction(() => Services.perms.removeAll());
});

/** A tab in `userContextId`, loaded with `url`. @param {number} userContextId */
async function tabIn(userContextId, url = PAGE) {
  const tab = gBrowser.addTab(url, {
    userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  return tab;
}

/**
 * What a page gets when it asks for each permission, without a user answering.
 * @param {MozBrowser} browser
 */
function ask(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    const settle = (/** @type {Promise<string>} */ p) =>
      Promise.race([p, new Promise((r) => content.setTimeout(() => r("pending"), 1500))]);
    const geo = await settle(
      new Promise((resolve) =>
        content.navigator.geolocation.getCurrentPosition(
          () => resolve("allowed"),
          (e) => resolve(e.code === e.PERMISSION_DENIED ? "denied" : `error ${e.code}`),
        ),
      ),
    );
    // From the page's own script: SpecialPowers' sandbox is privileged, and MediaManager does
    // not ask a privileged caller.
    const fromPage = (/** @type {string} */ constraints) =>
      settle(
        new Promise((resolve) => {
          const key = `gum${Math.random()}`.replace(".", "");
          const script = content.document.createElement("script");
          script.textContent =
            `navigator.mediaDevices.getUserMedia(${constraints}).then(` +
            `() => (document.body.dataset.${key} = "allowed"),` +
            `(e) => (document.body.dataset.${key} = e.name === "NotAllowedError" ? "denied" : e.name));`;
          content.document.body.append(script);
          const poll = () => {
            const v = content.document.body.dataset[key];
            if (v) resolve(v);
            else content.setTimeout(poll, 50);
          };
          poll();
        }),
      );
    const camera = await fromPage("{ video: true }");
    const microphone = await fromPage("{ audio: true }");
    content.document.notifyUserGestureActivation();
    // A cancelled request leaves the permission at "default": nothing granted, no prompt.
    const notification = await settle(content.Notification.requestPermission());
    const storage = await settle(
      content.navigator.storage.persist().then((ok) => (ok ? "allowed" : "denied")),
    );
    return { geo, camera, microphone, notification, storage };
  });
}

add_task(async function test_the_agent_container_asks_for_nothing() {
  const agent = /** @type {ContainedWorkspace} */ (WorkspaceStore.agent);
  const tab = await tabIn(agent.userContextId);
  /** @type {string[]} */
  const shown = [];
  const onShown = (/** @type {Event} */ e) => shown.push(/** @type {Element} */ (e.target).id);
  PopupNotifications.panel.addEventListener("popupshowing", onShown);
  const got = await ask(tab.linkedBrowser);
  PopupNotifications.panel.removeEventListener("popupshowing", onShown);
  Assert.deepEqual(
    got,
    {
      geo: "denied",
      camera: "denied",
      microphone: "denied",
      notification: "default",
      storage: "denied",
    },
    "every permission an agent page asks for is refused",
  );
  for (const id of [
    "geolocation",
    "webRTC-shareDevices",
    "web-notifications",
    "persistent-storage",
  ]) {
    Assert.equal(
      PopupNotifications.getNotification(id, tab.linkedBrowser),
      null,
      `no ${id} prompt waits on the agent tab`,
    );
  }
  Assert.deepEqual(shown, [], "and no prompt was shown");
  const principal = tab.linkedBrowser.contentPrincipal;
  Assert.equal(
    Services.perms.getForBrowser(principal, "camera", tab.linkedBrowser.browserId)?.capability,
    Services.perms.DENY_ACTION,
    "camera is denied for the agent tab",
  );
  for (const type of ["camera", "geo", "desktop-notification"]) {
    Assert.equal(
      Services.perms.testExactPermissionFromPrincipal(principal, type),
      Services.perms.UNKNOWN_ACTION,
      `no ${type} permission for the origin itself: permissions are shared across containers`,
    );
  }
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_another_workspace_still_asks() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const prompt = BrowserTestUtils.waitForEvent(PopupNotifications.panel, "popupshown");
  SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.navigator.geolocation.getCurrentPosition(
      () => {},
      () => {},
    );
  });
  await prompt;
  Assert.ok(
    PopupNotifications.getNotification("geolocation", tab.linkedBrowser),
    "a main tab's geolocation request shows Firefox's prompt",
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_agent_tabs_open_no_popups() {
  const agent = /** @type {ContainedWorkspace} */ (WorkspaceStore.agent);
  const tab = await tabIn(agent.userContextId);
  Assert.ok(
    contextOf(tab.linkedBrowser).sandboxFlags & SANDBOXED_AUXILIARY_NAVIGATION,
    "the agent tab's browsing context is sandboxed against new windows",
  );
  const before = gBrowser.tabs.length;
  const windows = BrowserWindowTracker.windowCount;
  const opened = await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.notifyUserGestureActivation();
    // A sandboxed context's window.open throws InvalidAccessError, or gives null.
    let w = null;
    try {
      w = content.open("https://example.com/", "_blank");
    } catch (e) {
      if (/** @type {DOMException} */ (e).name !== "InvalidAccessError") throw e;
    }
    const a = content.document.createElement("a");
    a.href = "https://example.org/";
    a.target = "_blank";
    content.document.body.append(a);
    a.click();
    return w !== null;
  });
  await new Promise((r) => setTimeout(r, 500));
  Assert.ok(!opened, "window.open gives nothing, even after a click");
  Assert.equal(gBrowser.tabs.length, before, "no tab opened");
  Assert.equal(BrowserWindowTracker.windowCount, windows, "no window opened");

  // Its browsing context keeps the flag across a navigation to another site.
  const other = "https://example.org/browser/";
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, other);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  Assert.ok(
    contextOf(tab.linkedBrowser).sandboxFlags & SANDBOXED_AUXILIARY_NAVIGATION,
    "after a cross-site navigation too",
  );
  BrowserTestUtils.removeTab(tab);

  const mine = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  Assert.ok(
    !(contextOf(mine.linkedBrowser).sandboxFlags & SANDBOXED_AUXILIARY_NAVIGATION),
    "a main tab is not sandboxed",
  );
  const newTab = BrowserTestUtils.waitForNewTab(gBrowser, "https://example.com/");
  await SpecialPowers.spawn(mine.linkedBrowser, [], () => {
    content.document.notifyUserGestureActivation();
    content.open("https://example.com/", "_blank");
  });
  BrowserTestUtils.removeTab(await newTab);
  BrowserTestUtils.removeTab(mine);
});

// Site permissions are kept per workspace (security.md M10, P7): per
// container (permissions.isolateBy.userContext), so an ALLOW given in the default container or
// in `work` never reaches the agent workspace, and `work`'s own ALLOW still works in `work`.
add_task(async function test_site_permissions_are_per_workspace() {
  Assert.equal(
    Services.prefs.getDefaultBranch("").getBoolPref("permissions.isolateBy.userContext", false),
    true,
    "Vimma's default: permissions are isolated by container",
  );
  const { ContextualIdentityService } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
  );
  const work = ContextualIdentityService.create("vimma-test-work", "briefcase", "blue");
  registerCleanupFunction(() => ContextualIdentityService.remove(work.userContextId));
  const uri = Services.io.newURI(PAGE);
  for (const userContextId of [0, work.userContextId]) {
    const principal = Services.scriptSecurityManager.createContentPrincipal(uri, { userContextId });
    for (const type of ["geo", "camera"]) {
      Services.perms.addFromPrincipal(principal, type, Services.perms.ALLOW_ACTION);
    }
  }
  const agent = /** @type {ContainedWorkspace} */ (WorkspaceStore.agent);
  const agentTab = await tabIn(agent.userContextId);
  const there = await ask(agentTab.linkedBrowser);
  Assert.equal(there.geo, "denied", "the default and work ALLOWs do not reach an agent tab");
  Assert.equal(there.camera, "denied", "nor its camera");
  BrowserTestUtils.removeTab(agentTab);

  // work's own ALLOW stays work's: read with each container's principal.
  const of = (/** @type {number} */ userContextId) =>
    Services.perms.testPermissionFromPrincipal(
      Services.scriptSecurityManager.createContentPrincipal(uri, { userContextId }),
      "geo",
    );
  Assert.equal(of(work.userContextId), Services.perms.ALLOW_ACTION, "work keeps its ALLOW");
  Assert.equal(of(0), Services.perms.ALLOW_ACTION, "so does the default container");
  Assert.equal(of(agent.userContextId), Services.perms.UNKNOWN_ACTION, "the agent has none");
  Services.perms.removeAll();
});

// security.md M10: a document a service worker serves has no HTTP response, so the camera
// deny is set when its window global is created, whatever served it.
add_task(async function test_a_page_from_a_service_worker_is_denied_too() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["dom.serviceWorkers.enabled", true],
      ["dom.serviceWorkers.testing.enabled", true],
    ],
  });
  const agent = /** @type {ContainedWorkspace} */ (WorkspaceStore.agent);
  const tab = await tabIn(agent.userContextId, `${DIR}file_vimma_agent_sw.html`);
  await TestUtils.waitForCondition(
    () => tab.linkedBrowser.contentTitle === "sw ready",
    "the worker is ready",
  );
  const browserId = tab.linkedBrowser.browserId;
  const principal = tab.linkedBrowser.contentPrincipal;
  for (const type of ["camera", "microphone", "screen", "speaker"]) {
    Services.perms.removeFromPrincipalForBrowser(principal, type, browserId);
  }
  Assert.equal(
    Services.perms.getForBrowser(principal, "camera", browserId),
    null,
    "sanity: no deny before the worker's page",
  );
  const page = `${DIR}file_vimma_agent_sw_page.html`;
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, page);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, page);
  Assert.equal(tab.linkedBrowser.contentTitle, "from the worker", "the worker served it");
  Assert.equal(
    Services.perms.getForBrowser(principal, "camera", browserId)?.capability,
    Services.perms.DENY_ACTION,
    "the worker's page is denied the camera",
  );
  const got = await ask(tab.linkedBrowser);
  Assert.equal(got.camera, "denied", "and its getUserMedia is refused");
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    for (const r of await content.navigator.serviceWorker.getRegistrations()) await r.unregister();
  });
  BrowserTestUtils.removeTab(tab);
});

// security.md M10: a document keeps the sandbox flags it loaded with. When the agent
// workspace changes (a sweep), an agent tab that loaded without the flag is reloaded, so the
// flag applies to the page in it, not only to its next navigation.
add_task(async function test_a_sweep_reloads_agent_tabs_that_loaded_unsandboxed() {
  const agent = /** @type {ContainedWorkspace} */ (WorkspaceStore.agent);
  const tab = await tabIn(agent.userContextId);
  const bc = contextOf(tab.linkedBrowser);
  bc.sandboxFlags &= ~SANDBOXED_AUXILIARY_NAVIGATION;
  BrowserTestUtils.reloadTab(tab);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  // The document's own flags (Document.sandboxFlagsAsString lists what it may still do; null
  // for none): whether the page in the tab may open windows.
  const opens = () =>
    SpecialPowers.spawn(tab.linkedBrowser, [], () => {
      const flags = content.document.sandboxFlagsAsString;
      return flags === null || flags.split(" ").includes("allow-popups");
    });
  Assert.ok(await opens(), "sanity: a page loaded without the flag may open windows");

  const reloaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  Services.obs.notifyObservers(null, "vimma-mcp-changed");
  await reloaded;
  Assert.ok(
    contextOf(tab.linkedBrowser).sandboxFlags & SANDBOXED_AUXILIARY_NAVIGATION,
    "the sweep set the flag",
  );
  Assert.ok(!(await opens()), "and reloaded the page, which now opens none");
  BrowserTestUtils.removeTab(tab);
});

// security.md M10: an agent page cannot launch another app through an external protocol
// (zoommtg:, mailto: …; Firefox's "always open" choice is shared across containers). Its
// downloads are asked and quarantined: browser_vimma_mcp_downloads.js.
add_task(async function test_agent_pages_launch_no_app() {
  const { AgentPages } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/ctl/AgentPages.sys.mjs",
  );
  /** @type {string[]} */
  const launched = [];
  AgentPages._chooserForTests = {
    QueryInterface: ChromeUtils.generateQI(["nsIContentDispatchChooser"]),
    /** @param {unknown} _handler @param {nsIURI} uri */
    handleURI(_handler, uri) {
      launched.push(uri.spec);
    },
  };
  registerCleanupFunction(() => (AgentPages._chooserForTests = null));
  // A known protocol (a web handler for vimmatest:), so a load of it reaches the chooser.
  const handlerSvc = Cc["@mozilla.org/uriloader/handler-service;1"].getService(
    Ci.nsIHandlerService,
  );
  const info = Cc["@mozilla.org/uriloader/external-protocol-service;1"]
    .getService(Ci.nsIExternalProtocolService)
    .getProtocolHandlerInfo("vimmatest");
  const web = Cc["@mozilla.org/uriloader/web-handler-app;1"].createInstance(Ci.nsIWebHandlerApp);
  web.name = "vimma test";
  web.uriTemplate = "https://example.com/vimmatest/%s";
  info.possibleApplicationHandlers.appendElement(web);
  handlerSvc.store(info);
  registerCleanupFunction(() => handlerSvc.remove(info));
  const agent = /** @type {ContainedWorkspace} */ (WorkspaceStore.agent);
  const agentTab = await tabIn(agent.userContextId);
  await SpecialPowers.spawn(agentTab.linkedBrowser, [], () => {
    content.document.notifyUserGestureActivation();
    content.location.href = "vimmatest:from-agent";
  });
  const mine = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await SpecialPowers.spawn(mine.linkedBrowser, [], () => {
    content.document.notifyUserGestureActivation();
    content.location.href = "vimmatest:from-main";
  });
  await TestUtils.waitForCondition(() => launched.length > 0, "main's launch reached Firefox");
  await new Promise((r) => setTimeout(r, 300));
  Assert.deepEqual(launched, ["vimmatest:from-main"], "the agent page launched nothing");
  BrowserTestUtils.removeTab(mine);

  // Without the test's stand-in, the wrapper makes Firefox's own chooser for every other load.
  AgentPages._chooserForTests = null;
  const chooser = Cc["@mozilla.org/content-dispatch-chooser;1"].createInstance(
    Ci.nsIContentDispatchChooser,
  );
  Assert.equal(typeof chooser.handleURI, "function", "Firefox's chooser is reached");
  BrowserTestUtils.removeTab(agentTab);
});

const accel = AppConstants.platform === "macosx" ? { metaKey: true } : { ctrlKey: true };

/**
 * Resolves once ClickHandlerParent handled the next click in a browser. It tells its listeners
 * right after contentAreaClick, which opens the tab synchronously: once a listener heard the
 * click, any tab it opens is in gBrowser.tabs.
 * @returns {(browser: MozBrowser) => Promise<void>}
 */
function clickWatcher() {
  const { ClickHandlerParent } = ChromeUtils.importESModule(
    "resource:///actors/ClickHandlerParent.sys.mjs",
  );
  /** @type {MozBrowser[]} */
  const seen = [];
  const listener = { onContentClick: (/** @type {MozBrowser} */ b) => seen.push(b) };
  ClickHandlerParent.addContentClickListener(listener);
  registerCleanupFunction(() => ClickHandlerParent.removeContentClickListener(listener));
  return async (browser) => {
    const count = seen.filter((b) => b === browser).length;
    await TestUtils.waitForCondition(
      () => seen.filter((b) => b === browser).length > count,
      "ClickHandlerParent handled the click",
    );
  };
}

/**
 * A link the page's (or a frame's) script clicks, with the user's activation.
 * @param {MozBrowser | BrowsingContext} target @param {MouseEventInit} init
 */
function scripted(target, init) {
  return SpecialPowers.spawn(target, [init], (opts) => {
    const a = content.document.createElement("a");
    a.href = "https://example.org/browser/?scripted";
    a.textContent = "link";
    content.document.body.append(a);
    content.document.notifyUserGestureActivation();
    const type = opts.button === 1 ? "auxclick" : "click";
    a.dispatchEvent(new content.MouseEvent(type, { bubbles: true, cancelable: true, ...opts }));
  });
}

// security.md M10, issue #1568: a modified click (ctrl or cmd, shift, middle) on a link in an
// agent tab opens no tab or window. Firefox's ClickHandlerChild sends it to ClickHandlerParent,
// which opens it with openLinkIn, outside the pop-up sandbox, so without the guard a page
// holding the user's activation could open one uncounted tab per gesture. The same click in a
// main tab still opens a tab.
add_task(async function test_agent_tabs_open_nothing_on_modified_clicks() {
  const handled = clickWatcher();

  const agent = /** @type {ContainedWorkspace} */ (WorkspaceStore.agent);
  const tab = await tabIn(agent.userContextId);
  const previous = gBrowser.selectedTab;
  gBrowser.selectedTab = tab;
  const before = gBrowser.tabs.length;
  // openWindow notifies domwindowopened synchronously, inside contentAreaClick; the window
  // tracker would count the window only once it has loaded.
  let windowsOpened = 0;
  const onWindow = (/** @type {unknown} */ _subject, /** @type {string} */ topic) => {
    if (topic === "domwindowopened") windowsOpened++;
  };
  Services.ww.registerNotification(onWindow);
  registerCleanupFunction(() => Services.ww.unregisterNotification(onWindow));
  for (const init of [accel, { button: 1 }, { shiftKey: true }]) {
    const done = handled(tab.linkedBrowser);
    await scripted(tab.linkedBrowser, init);
    await done;
    Assert.equal(gBrowser.tabs.length, before, `a scripted ${JSON.stringify(init)} opens no tab`);
    Assert.equal(windowsOpened, 0, "and no window");
  }
  // A cross-origin frame's script: the guard goes by the tab's top browsing context.
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const frame = content.document.createElement("iframe");
    frame.src = "https://example.org/browser/";
    const loaded = new Promise((r) => frame.addEventListener("load", r, { once: true }));
    content.document.body.append(frame);
    await loaded;
  });
  const frameBC = /** @type {BrowsingContext} */ (contextOf(tab.linkedBrowser).children[0]);
  const frameDone = handled(tab.linkedBrowser);
  await scripted(frameBC, accel);
  await frameDone;
  Assert.equal(gBrowser.tabs.length, before, "a cross-origin frame's scripted click opens no tab");
  // The user's own (trusted) ctrl-click and middle click on a link the page shows.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const a = content.document.createElement("a");
    a.id = "real";
    a.href = "https://example.org/browser/?trusted";
    a.textContent = "a link the user clicks";
    content.document.body.prepend(a);
  });
  for (const init of [{ accelKey: true }, { button: 1 }]) {
    const done = handled(tab.linkedBrowser);
    await BrowserTestUtils.synthesizeMouseAtCenter("#real", init, tab.linkedBrowser);
    await done;
    Assert.equal(gBrowser.tabs.length, before, `a real ${JSON.stringify(init)} opens no tab`);
  }
  Assert.equal(
    tab.linkedBrowser.currentURI.spec,
    PAGE,
    "and the agent tab stays on its page (a modified click is dropped, not followed)",
  );
  gBrowser.selectedTab = previous;
  BrowserTestUtils.removeTab(tab);

  // A main tab (the container of the tab the test started in): the same scripted ctrl-click
  // opens a tab in the background.
  const mine = await tabIn(previous.userContextId);
  gBrowser.selectedTab = mine;
  Assert.notEqual(mine.userContextId, agent.userContextId, "sanity: a main tab");
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, "https://example.org/browser/?scripted");
  await scripted(mine.linkedBrowser, accel);
  BrowserTestUtils.removeTab(await opened);
  BrowserTestUtils.removeTab(mine);
});

// security.md M10, issue #1591: a dropped modified click says so in the status bar, with the
// fixed text that names gF (from the keymap) and the context menu. At most one notice per tab
// every CLICK_NOTICE_MS, so a page that scripts a burst of such clicks shows one; another agent
// tab has its own; a tab of another workspace, whose click opens a tab, shows none.
add_task(async function test_a_dropped_modified_click_shows_one_notice_per_tab() {
  const { VimmaHost } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
  );
  const { droppedClickNotice } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/core/agent-pages.mjs",
  );
  const text = droppedClickNotice(VimmaHost.baseKeymap());
  Assert.ok(text.includes("gF"), "sanity: the default key is named");
  /** @type {{ win: ChromeWindow, text: string }[]} */
  const said = [];
  const say = VimmaHost.say;
  VimmaHost.say = function (win, t, options) {
    said.push({ win, text: t });
    return say.call(this, win, t, options);
  };
  registerCleanupFunction(() => (VimmaHost.say = say));
  const notices = () => said.filter((s) => s.text === text);
  const handled = clickWatcher();

  const agent = /** @type {ContainedWorkspace} */ (WorkspaceStore.agent);
  const previous = gBrowser.selectedTab;
  const tab = await tabIn(agent.userContextId);
  gBrowser.selectedTab = tab;
  for (const init of [accel, { button: 1 }, { shiftKey: true }, accel, accel]) {
    const done = handled(tab.linkedBrowser);
    await scripted(tab.linkedBrowser, init);
    await done;
  }
  Assert.equal(notices().length, 1, "a burst of five dropped clicks shows one notice");
  Assert.equal(notices()[0].win, window, "in the tab's window");
  Assert.equal(
    document.getElementById("vimma-notice")?.textContent,
    text,
    "the status bar shows it",
  );

  const other = await tabIn(agent.userContextId);
  gBrowser.selectedTab = other;
  const done = handled(other.linkedBrowser);
  await scripted(other.linkedBrowser, accel);
  await done;
  Assert.equal(notices().length, 2, "another agent tab shows its own notice");

  // The activation outlasts a quick switch away: a background tab's notice would cover what the
  // shown tab put in the status bar.
  const background = await tabIn(agent.userContextId);
  const behind = handled(background.linkedBrowser);
  await scripted(background.linkedBrowser, accel);
  await behind;
  Assert.equal(notices().length, 2, "a background agent tab shows none");
  gBrowser.selectedTab = background;
  const shown = handled(background.linkedBrowser);
  await scripted(background.linkedBrowser, accel);
  await shown;
  Assert.equal(notices().length, 3, "nor does it use up its notice: once shown, it says so");
  gBrowser.selectedTab = other;

  const mine = await tabIn(previous.userContextId);
  gBrowser.selectedTab = mine;
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, "https://example.org/browser/?scripted");
  await scripted(mine.linkedBrowser, accel);
  BrowserTestUtils.removeTab(await opened);
  Assert.equal(notices().length, 3, "a tab of another workspace shows none");

  gBrowser.selectedTab = previous;
  for (const t of [tab, other, background, mine]) BrowserTestUtils.removeTab(t);
});

/**
 * A link dragged out of `source`'s page and dropped on `target` in this window's interface, as
 * the parent sees a drag that started in a content process: the drag session names the page's
 * window context (nsBaseDragSession::InvokeDragSessionWithRemoteImage), and the data is the
 * page's. Headless Firefox has no drag service, so there the source goes through AgentPages'
 * test hook instead; a headed run (`npm run mochitest -- --headed`) takes the real session.
 * Returns whether the dragover was cancelled, that is whether the target takes the drop.
 * @param {MozBrowser} source @param {Element} target @param {string} url
 */
function dragLink(source, target, url) {
  const context = /** @type {WindowGlobalParent} */ (source.browsingContext?.currentWindowGlobal);
  /** @type {nsIDragSession | null} */
  let session = null;
  // The production read (AgentPages' dragSource) needs this attribute, headless or not: without
  // it the guard would fail open while the hook below kept this test green.
  Assert.ok("dragSession" in window.windowUtils, "sanity: windowUtils has dragSession");
  try {
    EventUtils.startDragSession(window, "link");
    session = window.windowUtils.dragSession;
  } catch {
    // No drag service (headless).
  }
  info(session ? "the drag's source: a drag session" : "the drag's source: AgentPages' hook");
  if (session) {
    session.sourceWindowContext = context;
    session.sourceTopWindowContext = context;
    session.triggeringPrincipal = context.documentPrincipal;
  } else {
    AgentPages._dragSourceForTests = context.browsingContext;
  }
  const data = new DataTransfer();
  data.mozSetDataAt("text/uri-list", url, 0);
  data.dropEffect = "link";
  let accepted = false;
  try {
    for (const type of ["dragover", "drop"]) {
      const event = EventUtils.createDragEventObject(type, target, window, data, {});
      const notCancelled = EventUtils.sendDragEvent(event, target, window);
      if (type === "dragover") accepted = !notCancelled;
    }
  } finally {
    session?.endDragSession(true, EventUtils._parseModifiers({}));
    AgentPages._dragSourceForTests = null;
  }
  return accepted;
}

add_task(async function test_links_dragged_from_agent_tabs_open_no_tab() {
  const agent = /** @type {ContainedWorkspace} */ (WorkspaceStore.agent);
  const previous = gBrowser.selectedTab;
  const tab = await tabIn(agent.userContextId);
  const mine = await tabIn(previous.userContextId);
  gBrowser.selectedTab = tab;
  const strip = gBrowser.tabContainer;
  const newTabButton = /** @type {Element} */ (
    [document.getElementById("tabs-newtab-button"), document.getElementById("new-tab-button")]
      .filter((b) => b && b.getBoundingClientRect().width > 0)
      .at(0)
  );
  Assert.ok(newTabButton, "sanity: a new-tab button is shown");
  const before = gBrowser.tabs.length;
  const url = "https://example.org/browser/?dragged";
  for (const [name, target] of /** @type {const} */ ([
    ["the tab strip", strip],
    ["the new-tab button", newTabButton],
    ["another tab", mine],
  ])) {
    Assert.ok(!dragLink(tab.linkedBrowser, target, url), `${name} refuses an agent tab's link`);
  }
  // Dropped on another workspace's page, the link reaches that page as data, but Firefox loads
  // nothing for it: the content process hands the drop back (MozBrowser.dropLinks), refused.
  dragLink(tab.linkedBrowser, mine.linkedBrowser, url);
  Assert.ok(
    !mine.linkedBrowser.dropLinks(
      [`${url}3`, "", "", `${url}4`, "", ""],
      Services.scriptSecurityManager.getSystemPrincipal(),
    ),
    "another workspace's page loads nothing an agent tab's drag carries",
  );
  // Several links dropped on an agent tab's own page (from one of its frames, which Firefox
  // allows): the tab loads the first, as a link the page follows; no tab opens for the others.
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, `${url}1`);
  tab.linkedBrowser.dropLinks(
    [`${url}1`, "", "", `${url}2`, "", ""],
    Services.scriptSecurityManager.getSystemPrincipal(),
  );
  await loaded;

  // The same drops from a main tab open a tab each; once they have, the agent tab's would have.
  gBrowser.selectedTab = mine;
  for (const target of [strip, newTabButton]) {
    const opened = BrowserTestUtils.waitForNewTab(gBrowser, url);
    Assert.ok(dragLink(mine.linkedBrowser, target, url), "a main tab's link drops");
    BrowserTestUtils.removeTab(await opened);
  }
  const both = BrowserTestUtils.waitForNewTab(gBrowser, `${url}2`);
  mine.linkedBrowser.dropLinks(
    [`${url}1`, "", "", `${url}2`, "", ""],
    Services.scriptSecurityManager.getSystemPrincipal(),
  );
  BrowserTestUtils.removeTab(await both);
  Assert.equal(gBrowser.tabs.length, before, "no drag from the agent tab opened a tab");
  Assert.equal(tab.linkedBrowser.currentURI.spec, `${url}1`, "and it loaded only its first link");
  gBrowser.selectedTab = previous;
  BrowserTestUtils.removeTab(mine);
  BrowserTestUtils.removeTab(tab);
});
