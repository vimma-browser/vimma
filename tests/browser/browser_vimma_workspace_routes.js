/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/workspace-routing.md. `[[routes]]` rules send a URL to a workspace's
// container: from the URL bar and `:open`, a link a page opens in a new tab, a link from another
// app (the remote command line, with `-vimma-from <app>` from vimma-open), and a new window's
// first tab. A foreground open switches, a background one says where; same-tab navigation is
// never moved, only hinted; private windows are never routed.

"use strict";

/* global focusContent -- from head.js */

const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { WorkspaceRouter } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceRouter.sys.mjs",
);
const { resolveRoutes } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/routes.mjs",
);
const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);

const WORK = "https://example.com/";
const ELSEWHERE = "https://example.org/";
const NOTICE_ID = "vimma-notice";

const def = (/** @type {string} */ name) =>
  WorkspaceStore.definitions.workspaces.find((w) => w.name === name);
const ww = (win = window) => WindowWorkspaces.get(win);
const activeName = (win = window) =>
  ww(win).model.workspaces.find((w) => w.id === ww(win).model.active).name;
const noticeText = (win = window) => win.document.getElementById(NOTICE_ID)?.textContent ?? "";
/** Forgets the last notice's text (a hidden notice keeps it), so a check sees only new ones. */
const clearNotice = (win = window) => {
  const el = win.document.getElementById(NOTICE_ID);
  if (el) el.textContent = "";
};

/** @param {() => boolean} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 50, 100);

/** Resolves with the next tab opened in `win`. */
const nextTab = (win = window) =>
  BrowserTestUtils.waitForEvent(win.gBrowser.tabContainer, "TabOpen").then((e) => e.target);

/** @param {Record<string, string>[]} rules */
const route = (rules) => WorkspaceRouter.setRoutes(resolveRoutes(rules));

/** Two workspaces, `rt-work` (example.com) and `rt-home` (the rest), `rt-home` shown. */
let work;
let home;

add_task(async function setup() {
  work = WorkspaceStore.addWorkspace({ name: "rt-work", color: "blue", icon: "briefcase" });
  home = WorkspaceStore.addWorkspace({ name: "rt-home", color: "green", icon: "tree" });
  registerCleanupFunction(async () => {
    route([]);
    ww().switchTo({ id: def("main").id });
    for (const w of WorkspaceStore.definitions.workspaces.filter(
      (d) => d.name !== "main" && d.id !== WorkspaceStore.agent?.id,
    )) {
      await WorkspaceStore.deleteWorkspace(w.id, { confirmed: true });
    }
    while (gBrowser.tabs.length > 1) BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
  });
  route([{ domain: "example.com", workspace: "rt-work" }]);
});

/** Shows rt-home with one page of `url` in it, selected and loaded. */
async function inHome(url = `${ELSEWHERE}?home`) {
  ww().switchTo({ id: home.id });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  Assert.equal(tab.userContextId, home.userContextId, "the page is in rt-home");
  Assert.equal(activeName(), "rt-home", "rt-home is shown");
  clearNotice();
  return tab;
}

/** `:line` Enter, from the selected page in normal mode. */
async function runCommand(line) {
  const browser = gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the selected page has loaded");
  await focusContent(browser);
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
}

/** Closes every tab but the first, back to main. */
function tidy() {
  ww().switchTo({ id: def("main").id });
  while (gBrowser.tabs.length > 1) BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
}

add_task(async function the_url_bar_routes_to_the_rules_workspace_and_switches() {
  ww().switchTo({ id: home.id });
  // ctrl+t is Vimma's new_tab on every platform; cmd+t, accel on a Mac, is off there (#385).
  let opened = nextTab();
  EventUtils.synthesizeKey("t", { ctrlKey: true });
  const blank = await opened;
  Assert.equal(blank.userContextId, home.userContextId, "ctrl+t: a new tab in rt-home");
  clearNotice();

  opened = nextTab();
  gURLBar.focus();
  gURLBar.value = `${WORK}?urlbar`;
  EventUtils.synthesizeKey("KEY_Enter");
  const routed = await opened;
  Assert.equal(routed.userContextId, work.userContextId, "the page opens in rt-work's container");
  await until(() => activeName() === "rt-work", "a foreground open switches to rt-work");
  Assert.equal(gBrowser.selectedTab, routed, "and shows the routed tab");
  Assert.ok(!routed.hidden, "never hidden on the way");
  Assert.ok(!noticeText().includes("opened in"), "a foreground open does not say 'opened in'");
  await until(() => !blank.isConnected, "the untouched new tab left behind is closed");
  tidy();
});

add_task(async function open_routes_but_keeps_a_page_that_is_not_blank() {
  const page = await inHome();
  const opened = nextTab();
  await runCommand(`open ${WORK}?open`);
  const routed = await opened;
  Assert.equal(routed.userContextId, work.userContextId, ":open goes to rt-work's container");
  await until(() => activeName() === "rt-work", "and switches to rt-work");
  Assert.ok(page.isConnected, "the page :open was typed on stays");
  Assert.equal(page.linkedBrowser.currentURI.spec, `${ELSEWHERE}?home`, "and was not navigated");
  tidy();
});

add_task(async function shift_p_routes_a_clipboard_url() {
  await inHome();
  const url = `${WORK}?pasted`;
  await SimpleTest.promiseClipboardChange(url, () => SpecialPowers.clipboardCopyString(url));
  const browser = gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the page has loaded");
  await focusContent(browser);
  const opened = nextTab();
  EventUtils.synthesizeKey("P");
  const routed = await opened;
  Assert.equal(routed.userContextId, work.userContextId, "P opens the URL in rt-work's container");
  await until(() => activeName() === "rt-work", "and switches there");
  tidy();
});

add_task(async function no_loop_when_the_rule_names_the_shown_workspace() {
  ww().switchTo({ id: work.id });
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${WORK}?first`);
  Assert.equal(tab.userContextId, work.userContextId, "a page in rt-work");
  const count = gBrowser.tabs.length;
  clearNotice();
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, `${WORK}?again`);
  await runCommand(`open ${WORK}?again`);
  await loaded;
  Assert.equal(gBrowser.tabs.length, count, "no tab opens");
  Assert.equal(gBrowser.selectedTab, tab, "the same tab loads it");
  Assert.equal(activeName(), "rt-work", "the workspace stays");
  Assert.ok(!noticeText().includes("goes to"), "no hint");
  tidy();
});

add_task(async function a_background_open_by_the_user_goes_there_and_says_so() {
  const page = await inHome();
  const opened = nextTab();
  // A bookmark opened in the background (chrome: the system principal, no container chosen).
  window.openTrustedLinkIn(`${WORK}?background`, "tab", { inBackground: true });
  const routed = await opened;
  Assert.equal(routed.userContextId, work.userContextId, "the URL is in rt-work's container");
  await until(() => routed.hidden, "hidden: it is not in the workspace shown");
  Assert.equal(activeName(), "rt-home", "a background open never switches");
  Assert.equal(gBrowser.selectedTab, page, "the page stays selected");
  await until(() => noticeText() === 'opened in "rt-work"', "the notice says where it went");

  // A container chosen on purpose ("Open in New Container Tab") is the user's choice.
  const chosen = nextTab();
  window.openTrustedLinkIn(`${WORK}?chosen`, "tab", {
    inBackground: true,
    userContextId: home.userContextId,
  });
  Assert.equal((await chosen).userContextId, home.userContextId, "an explicit container stays");
  tidy();
});

/**
 * A link on the selected page (in rt-home) to `href`, with `target` if given, clicked by the
 * page's own script after a user gesture, as a hostile page can: `mods` as on a MouseEvent.
 * `accelKey` is the open-in-a-new-tab modifier: ctrl, or cmd on macOS, where ctrl+click is a
 * right click (BrowserUtils.whereToOpenLink reads metaKey there).
 * @param {string} href
 * @param {{ target?: string, accelKey?: boolean, button?: number }} how
 */
function pageClicks(href, { target = "", accelKey = false, button = 0 } = {}) {
  const meta = accelKey && AppConstants.platform == "macosx";
  return SpecialPowers.spawn(
    gBrowser.selectedBrowser,
    [href, target, accelKey && !meta, meta, button],
    (url, tgt, ctrl, cmd, btn) => {
      const a = content.document.createElement("a");
      a.href = url;
      if (tgt) a.target = tgt;
      a.textContent = "link";
      content.document.body.append(a);
      content.document.notifyUserGestureActivation();
      const type = btn === 1 ? "auxclick" : "click";
      a.dispatchEvent(
        new content.MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          ctrlKey: ctrl,
          metaKey: cmd,
          button: btn,
        }),
      );
    },
  );
}

add_task(async function a_page_can_never_route_the_links_it_opens() {
  // Decision 3: a page in rt-home must not open a URL of its choosing in rt-work's container
  // (with rt-work's cookies). Every open a page triggers stays in the page's container.
  const page = await inHome();

  // A synthetic ctrl-click (cmd-click on macOS) from the page's script: ClickHandlerChild →
  // ClickHandlerParent → openLinkIn, a background tab with the page's principal.
  let opened = nextTab();
  await pageClicks(`${WORK}?ctrl`, { accelKey: true });
  let tab = await opened;
  Assert.equal(tab.userContextId, home.userContextId, "a scripted ctrl-click stays in rt-home");
  Assert.equal(activeName(), "rt-home", "and opens nothing in rt-work");
  Assert.equal(gBrowser.selectedTab, page, "in the background");
  BrowserTestUtils.removeTab(tab);

  // A scripted middle-click.
  opened = nextTab();
  await pageClicks(`${WORK}?middle`, { button: 1 });
  tab = await opened;
  Assert.equal(tab.userContextId, home.userContextId, "a scripted middle-click stays in rt-home");
  BrowserTestUtils.removeTab(tab);

  // What ClickHandlerParent passes on (the page's principal and container), directly.
  opened = nextTab();
  window.openLinkIn(`${WORK}?direct`, "tab", {
    inBackground: true,
    triggeringPrincipal: page.linkedBrowser.contentPrincipal,
    userContextId: page.userContextId,
  });
  tab = await opened;
  Assert.equal(tab.userContextId, home.userContextId, "openLinkIn from a page stays in rt-home");
  BrowserTestUtils.removeTab(tab);

  // target=_blank: a foreground tab tied to its opener, with the hint once it is shown.
  clearNotice();
  opened = nextTab();
  await pageClicks(`${WORK}?blank`, { target: "_blank" });
  tab = await opened;
  Assert.equal(tab.userContextId, home.userContextId, "target=_blank stays in rt-home");
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, `${WORK}?blank`);
  await until(
    () => noticeText() === 'example.com goes to "rt-work" (route 1): :route move',
    "and is hinted, so the user can move it",
  );
  BrowserTestUtils.removeTab(tab);

  // A page in no container (a foreign tab): ClickHandlerParent passes no container at all, so
  // only the page's principal tells the open apart from one the user started.
  const bare = BrowserTestUtils.addTab(gBrowser, `${ELSEWHERE}?bare`, { userContextId: 0 });
  gBrowser.selectedTab = bare;
  await BrowserTestUtils.browserLoaded(bare.linkedBrowser);
  Assert.equal(bare.userContextId, 0, "a page in no container");
  opened = nextTab();
  await pageClicks(`${WORK}?bare-ctrl`, { accelKey: true });
  tab = await opened;
  Assert.equal(tab.userContextId, 0, "its scripted ctrl-click stays in no container");
  BrowserTestUtils.removeTab(tab);

  // window.open.
  gBrowser.selectedTab = page;
  opened = nextTab();
  await SpecialPowers.spawn(page.linkedBrowser, [`${WORK}?open`], (url) => {
    content.document.notifyUserGestureActivation();
    content.window.open(url);
  });
  tab = await opened;
  Assert.equal(tab.userContextId, home.userContextId, "window.open stays in rt-home");
  BrowserTestUtils.removeTab(tab);
  tidy();
});

add_task(async function same_tab_navigation_is_never_moved_but_hinted() {
  const page = await inHome();
  const count = gBrowser.tabs.length;
  const loaded = BrowserTestUtils.browserLoaded(page.linkedBrowser, false, `${WORK}?nav`);
  await SpecialPowers.spawn(page.linkedBrowser, [`${WORK}?nav`], (url) => {
    content.location.href = url;
  });
  await loaded;
  Assert.equal(gBrowser.tabs.length, count, "no tab opens");
  Assert.equal(page.userContextId, home.userContextId, "the tab stays in rt-home's container");
  Assert.equal(activeName(), "rt-home", "and the workspace stays");
  await until(
    () => noticeText() === 'example.com goes to "rt-work" (route 1): :route move',
    "the status bar hints where the rule would put it",
  );

  const moved = nextTab();
  await runCommand("route move");
  const copy = await moved;
  Assert.equal(copy.userContextId, work.userContextId, ":route move reopens it in rt-work");
  await until(() => !page.isConnected, "and closes the original");
  tidy();
});

add_task(async function a_redirect_inside_a_tab_is_never_moved() {
  const page = await inHome();
  const count = gBrowser.tabs.length;
  const loaded = BrowserTestUtils.browserLoaded(page.linkedBrowser, false, `${WORK}?redirect`);
  await SpecialPowers.spawn(page.linkedBrowser, [`${WORK}?redirect`], (url) => {
    content.location.replace(url);
  });
  await loaded;
  Assert.equal(gBrowser.tabs.length, count, "no tab opens");
  Assert.equal(page.userContextId, home.userContextId, "the tab stays in rt-home's container");
  Assert.equal(gBrowser.selectedTab, page, "and stays selected");
  Assert.equal(activeName(), "rt-home", "the workspace stays");
  tidy();
});

/**
 * What nsCommandLine::Run does with a command line from another process (not scriptable):
 * every command-line-handler in the order of its category entry (as browser_vimma_omarchy_hook).
 * @param {nsICommandLine} cmdLine
 */
function runHandlers(cmdLine) {
  const entries = [...Services.catMan.enumerateCategory("command-line-handler")].sort((a, b) =>
    a.entry < b.entry ? -1 : 1,
  );
  for (const { value } of entries) {
    try {
      Cc[value].getService(Ci.nsICommandLineHandler).handle(cmdLine);
    } catch (e) {
      if (e.result === Cr.NS_ERROR_ABORT) throw e;
    }
  }
}

/** `vimma <args>` while Vimma runs: the line the D-Bus remote hands over. */
async function remote(args) {
  const opened = nextTab();
  const cmdLine = Cu.createCommandLine(args, null, Ci.nsICommandLine.STATE_REMOTE_AUTO);
  runHandlers(cmdLine);
  const tab = await opened;
  return { tab, cmdLine };
}

add_task(async function an_external_link_routes_by_the_app_that_opened_it() {
  route([
    { app: "testapp", workspace: "rt-home" },
    { domain: "example.com", workspace: "rt-work" },
  ]);
  ww().switchTo({ id: def("main").id });

  // vimma-open: `vimma -vimma-from <app> <url>`; the app rule comes first in the file.
  const { tab: fromApp, cmdLine } = await remote(["-vimma-from", "TestApp", `${WORK}?app`]);
  Assert.equal(cmdLine.findFlag("vimma-from", false), -1, "the flag is consumed");
  Assert.equal(fromApp.userContextId, home.userContextId, "the app rule wins: rt-home");
  await until(() => activeName() === "rt-home", "a foreground external open switches");
  Assert.equal(WorkspaceRouter.app, null, "the app hint ends with the command line");

  // Without the flag (a terminal's `vimma <url>`): the domain rule.
  const { tab: plain } = await remote([`${WORK}?noapp`]);
  Assert.equal(plain.userContextId, work.userContextId, "the domain rule: rt-work");

  // A hint that is not a simple name is ignored, even by a rule naming exactly that string
  // (config.toml would refuse such a rule; set here past the check).
  route([{ app: "../../testapp", workspace: "rt-home" }]);
  ww().switchTo({ id: def("main").id });
  const { tab: bad } = await remote(["-vimma-from", "../../testapp", `${ELSEWHERE}?bad`]);
  Assert.equal(bad.userContextId, def("main").userContextId, "not routed: the workspace default");

  route([{ domain: "example.com", workspace: "rt-work" }]);
  tidy();
});

add_task(async function a_new_windows_first_tab_is_routed_with_the_startup_app() {
  route([
    { app: "coldapp", workspace: "rt-home" },
    { domain: "example.com", workspace: "rt-work" },
  ]);
  /** A window opened with one URL, as a cold start or an external window open does. */
  const openWindow = async (url) => {
    const opened = BrowserTestUtils.waitForNewWindow({ url });
    window.openDialog(AppConstants.BROWSER_CHROME_URL, "_blank", "chrome,all,dialog=no", url);
    return opened;
  };

  Services.env.set("VIMMA_FROM", "coldapp");
  WorkspaceRouter.resetStartupAppForTesting();
  const cold = await openWindow(`${ELSEWHERE}?cold`);
  Assert.equal(
    cold.gBrowser.selectedTab.userContextId,
    home.userContextId,
    "a cold start from the app: its rule (VIMMA_FROM)",
  );
  Assert.equal(cold.gBrowser.tabs.length, 1, "in the first tab, no second one");
  Assert.equal(Services.env.get("VIMMA_FROM"), "", "the variable is read once and cleared");
  await BrowserTestUtils.closeWindow(cold);

  const later = await openWindow(`${ELSEWHERE}?later`);
  Assert.notEqual(
    later.gBrowser.selectedTab.userContextId,
    home.userContextId,
    "a later window does not get the startup app",
  );
  await BrowserTestUtils.closeWindow(later);

  // Read and cleared at once, even when the first window never asks (a private one).
  Services.env.set("VIMMA_FROM", "coldapp");
  WorkspaceRouter.resetStartupAppForTesting();
  Assert.equal(Services.env.get("VIMMA_FROM"), "", "cleared before any window asks");
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  await BrowserTestUtils.closeWindow(priv);
  const afterPrivate = await openWindow(`${ELSEWHERE}?after-private`);
  Assert.notEqual(
    afterPrivate.gBrowser.selectedTab.userContextId,
    home.userContextId,
    "the startup app is gone once a first window has started",
  );
  await BrowserTestUtils.closeWindow(afterPrivate);

  const byDomain = await openWindow(`${WORK}?window`);
  Assert.equal(
    byDomain.gBrowser.selectedTab.userContextId,
    work.userContextId,
    "a window opened on a routed URL starts in that workspace",
  );
  await BrowserTestUtils.closeWindow(byDomain);
  route([{ domain: "example.com", workspace: "rt-work" }]);
});

add_task(async function private_windows_are_never_routed() {
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const tabs = gBrowser.tabs.length;
  const opened = nextTab(priv);
  priv.openTrustedLinkIn(`${WORK}?private`, "tab");
  const tab = await opened;
  Assert.equal(tab.userContextId, 0, "the private tab has no container");
  Assert.equal(tab.ownerDocument.defaultView, priv, "and stays in the private window");
  Assert.equal(gBrowser.tabs.length, tabs, "nothing opens in the normal window");
  await BrowserTestUtils.closeWindow(priv);
});

add_task(async function route_add_writes_a_rule_and_route_lists_them() {
  const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-routes");
  const file = PathUtils.join(dir, "config.toml");
  await IOUtils.writeUTF8(file, "schema = 2\n");
  await SpecialPowers.pushPrefEnv({ set: [["vimma.config.path", file]] });
  await ConfigHost.reload();
  Assert.deepEqual(WorkspaceRouter.routes, [], "the file has no rules");

  await inHome(`${ELSEWHERE}?add`);
  await runCommand("route add rt-work");
  await until(() => WorkspaceRouter.routes.length === 1, "the rule is read at once");
  Assert.equal(
    await IOUtils.readUTF8(file),
    'schema = 2\n\n[[routes]]\ndomain = "example.org"\nworkspace = "rt-work"\n',
    "appended to config.toml",
  );
  await until(
    () => noticeText() === 'added: example.org → "rt-work" (config.toml)',
    "the notice says what was added",
  );

  await runCommand("route add rt-home");
  await until(
    () => noticeText().includes('route 1 already sends example.org to "rt-work"'),
    "a host an earlier rule routes is refused, naming the rule",
  );

  const opened = nextTab();
  await runCommand("route");
  const about = await opened;
  await until(
    () => about.linkedBrowser.contentDocument?.documentElement.dataset.ready === "true",
    "about:vimma rendered",
  );
  const doc = about.linkedBrowser.contentDocument;
  Assert.ok(about.linkedBrowser.currentURI.spec.startsWith("about:vimma?tab="), "about:vimma");
  Assert.equal(doc.querySelectorAll("#routes tbody tr").length, 1, "one rule listed");
  Assert.ok(
    doc.getElementById("route-tab").textContent.includes("route 1"),
    "and which rule matches the tab :route was typed in",
  );

  await SpecialPowers.popPrefEnv();
  await ConfigHost.reload();
  await IOUtils.remove(dir, { recursive: true });
  route([{ domain: "example.com", workspace: "rt-work" }]);
  tidy();
});
