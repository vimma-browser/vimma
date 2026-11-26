/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/workspace-routing.md. `[[routes]]` rules send links from other programs to a
// workspace's container; what the user opens inside Vimma (the URL bar, `:open`, `:tabnew`, `P`,
// bookmarks) and a link a page opens stay in the workspace shown (decision 9), with the hint.
// Same-tab navigation is never moved, only hinted; `:route add` writes a rule. Split so that each file stays under the
// harness's 45 s limit on two busy CPUs: links from other programs are in
// browser_vimma_workspace_routes_external.js, new windows in
// browser_vimma_workspace_routes_windows.js.

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
/**
 * A window's workspaces, built: every window of these tests has them.
 * @param {BrowserWindow} [win]
 */
const ww = (win = window) => /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(win));
/**
 * The name of the shown workspace, one of the window's.
 * @param {BrowserWindow} [win]
 */
const activeName = (win = window) =>
  /** @type {WorkspaceState} */ (
    ww(win).model.workspaces.find((w) => w.id === ww(win).model.active)
  ).name;
/** @param {Window} [win] */
const noticeText = (win = window) => win.document.getElementById(NOTICE_ID)?.textContent ?? "";
/**
 * Forgets the last notice's text (a hidden notice keeps it), so a check sees only new ones.
 * @param {Window} [win]
 */
const clearNotice = (win = window) => {
  const el = win.document.getElementById(NOTICE_ID);
  if (el) el.textContent = "";
};

/** @param {() => boolean} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 50, 100);

/**
 * Resolves with the next tab opened in `win`.
 * @param {BrowserWindow} [win]
 */
const nextTab = (win = window) =>
  BrowserTestUtils.waitForEvent(win.gBrowser.tabContainer, "TabOpen").then(
    // Tabbrowser fires TabOpen on the new tab.
    (e) => /** @type {MozTabbrowserTab} */ (e.target),
  );

/**
 * A workspace definition these tests know exists.
 * @param {string} name
 */
const known = (name) => /** @type {ContainedWorkspace} */ (def(name));

/** @param {Record<string, string>[]} rules */
const route = (rules) => WorkspaceRouter.setRoutes(resolveRoutes(rules));

/**
 * Two workspaces, `rt-work` (example.com) and `rt-home` (the rest), `rt-home` shown; each has its
 * container, as containers are on in the browser tests.
 * @type {ContainedWorkspace}
 */
let work;
/** @type {ContainedWorkspace} */
let home;

add_task(async function setup() {
  work = /** @type {ContainedWorkspace} */ (
    WorkspaceStore.addWorkspace({ name: "rt-work", color: "blue", icon: "briefcase" })
  );
  home = /** @type {ContainedWorkspace} */ (
    WorkspaceStore.addWorkspace({ name: "rt-home", color: "green", icon: "tree" })
  );
  // The checks that a tab is not in rt-home hold only if rt-home has a container of its own.
  Assert.greater(work.userContextId ?? 0, 0, "work has a container");
  Assert.greater(home.userContextId ?? 0, 0, "home has a container");
  registerCleanupFunction(async () => {
    route([]);
    ww().switchTo({ id: known("main").id });
    for (const w of WorkspaceStore.definitions.workspaces.filter(
      (d) => d.name !== "main" && d.id !== WorkspaceStore.agent?.id,
    )) {
      await WorkspaceStore.deleteWorkspace(w.id, { confirmed: true });
    }
    while (gBrowser.tabs.length > 1) {
      BrowserTestUtils.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
    }
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

/**
 * `:line` Enter, from the selected page in normal mode.
 * @param {string} line
 */
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
  ww().switchTo({ id: known("main").id });
  while (gBrowser.tabs.length > 1) {
    BrowserTestUtils.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
  }
}

const HINT = 'example.com goes to "rt-work" (route 1): :route move';

/**
 * The tab that has loaded `url`, whichever it is and whether shown or not.
 * @param {string} url
 */
async function loadedIn(url) {
  /** @param {MozTabbrowserTab} t */
  const done = (t) =>
    t.linkedBrowser.currentURI?.spec === url && !t.linkedBrowser.webProgress?.isLoadingDocument;
  await until(() => gBrowser.tabs.some(done), `${url} has loaded`);
  return /** @type {MozTabbrowserTab} */ (gBrowser.tabs.find(done));
}

add_task(async function the_url_bar_opens_a_routed_site_in_the_shown_workspace() {
  // Decision 9: what the user opens from inside a workspace stays there; only links from other
  // programs are routed.
  ww().switchTo({ id: home.id });
  // ctrl+t is Vimma's new_tab on every platform; cmd+t, accel on a Mac, is off there (#385).
  const opened = nextTab();
  EventUtils.synthesizeKey("t", { ctrlKey: true });
  const blank = await opened;
  Assert.equal(blank.userContextId, home.userContextId, "ctrl+t: a new tab in rt-home");
  clearNotice();
  const count = gBrowser.tabs.length;

  gURLBar.focus();
  gURLBar.value = `${WORK}?urlbar`;
  EventUtils.synthesizeKey("KEY_Enter");
  const tab = await loadedIn(`${WORK}?urlbar`);
  Assert.equal(tab, blank, "the new tab loads it");
  Assert.equal(gBrowser.tabs.length, count, "no tab opens");
  Assert.equal(blank.userContextId, home.userContextId, "in rt-home's container");
  Assert.equal(activeName(), "rt-home", "and the workspace stays");
  await until(() => noticeText() === HINT, "the hint says where links from outside go");
  tidy();
});

add_task(async function open_loads_a_routed_site_in_the_shown_workspace() {
  const page = await inHome();
  const count = gBrowser.tabs.length;
  await runCommand(`open ${WORK}?open`);
  Assert.equal(await loadedIn(`${WORK}?open`), page, ":open loads it in the page's tab");
  Assert.equal(gBrowser.tabs.length, count, "no tab opens");
  Assert.equal(page.userContextId, home.userContextId, ":open stays in rt-home's container");
  Assert.equal(activeName(), "rt-home", "and the workspace stays");
  tidy();
});

add_task(async function tabnew_and_shift_p_open_a_routed_site_in_the_shown_workspace() {
  await inHome();
  let opened = nextTab();
  await runCommand(`tabnew ${WORK}?tabnew`);
  let tab = await opened;
  Assert.equal(tab.userContextId, home.userContextId, ":tabnew opens it in rt-home's container");
  Assert.equal(activeName(), "rt-home", "and the workspace stays");

  const url = `${WORK}?pasted`;
  await SimpleTest.promiseClipboardChange(url, () => SpecialPowers.clipboardCopyString(url));
  gBrowser.selectedTab = /** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-2));
  const browser = gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the page has loaded");
  await focusContent(browser);
  opened = nextTab();
  EventUtils.synthesizeKey("P");
  tab = await opened;
  Assert.equal(tab.userContextId, home.userContextId, "P opens the URL in rt-home's container");
  Assert.equal(activeName(), "rt-home", "and the workspace stays");
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

add_task(async function a_bookmark_or_a_new_window_opens_a_routed_site_in_the_shown_workspace() {
  const page = await inHome();
  const opened = nextTab();
  // A bookmark opened in the background (chrome: the system principal, no container chosen).
  window.openTrustedLinkIn(`${WORK}?background`, "tab", { inBackground: true });
  const tab = await opened;
  Assert.equal(tab.userContextId, home.userContextId, "the URL is in rt-home's container");
  Assert.ok(!tab.hidden, "and in the workspace shown");
  Assert.equal(gBrowser.selectedTab, page, "the page stays selected");

  // A container chosen on purpose ("Open in New Container Tab") is the user's choice.
  const chosen = nextTab();
  window.openTrustedLinkIn(`${WORK}?chosen`, "tab", {
    inBackground: true,
    userContextId: work.userContextId,
  });
  Assert.equal((await chosen).userContextId, work.userContextId, "an explicit container stays");

  // A bookmark or the URL bar opened in a new window.
  const url = `${WORK}?window`;
  const win = BrowserTestUtils.waitForNewWindow({ url });
  window.openTrustedLinkIn(url, "window");
  const other = await win;
  Assert.equal(
    other.gBrowser.selectedTab.userContextId,
    home.userContextId,
    "a new window opened on it starts in rt-home's container",
  );
  await BrowserTestUtils.closeWindow(other);
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
  await until(() => noticeText() === HINT, "and is hinted, so the user can move it");
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
  await until(() => noticeText() === HINT, "the status bar hints where the rule would put it");

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
 * The document of about:vimma in `tab`, once it has rendered: it loads in the parent process,
 * so its browser has the document.
 * @param {MozTabbrowserTab} tab
 */
function aboutDoc(tab) {
  return /** @type {Document} */ (tab.linkedBrowser.contentDocument);
}

/**
 * The element of about:vimma with this id, which it always renders.
 * @param {Document} doc
 * @param {string} id
 */
function section(doc, id) {
  return /** @type {HTMLElement} */ (doc.getElementById(id));
}

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
    () => about.linkedBrowser.contentDocument?.documentElement?.dataset.ready === "true",
    "about:vimma rendered",
  );
  const doc = aboutDoc(about);
  Assert.ok(about.linkedBrowser.currentURI.spec.startsWith("about:vimma?tab="), "about:vimma");
  Assert.equal(doc.querySelectorAll("#routes tbody tr").length, 1, "one rule listed");
  Assert.ok(
    section(doc, "route-tab").textContent.includes("route 1"),
    "and which rule matches the tab :route was typed in",
  );

  await SpecialPowers.popPrefEnv();
  await ConfigHost.reload();
  await IOUtils.remove(dir, { recursive: true });
  route([{ domain: "example.com", workspace: "rt-work" }]);
  tidy();
});

add_task(async function route_add_says_why_config_toml_refused_the_rule() {
  const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-routes");
  const file = PathUtils.join(dir, "config.toml");
  const broken = "schema = 2\n[[routes]\n";
  await IOUtils.writeUTF8(file, broken);
  await SpecialPowers.pushPrefEnv({ set: [["vimma.config.path", file]] });
  try {
    await ConfigHost.reload();
    await inHome(`${ELSEWHERE}?refused`);
    await runCommand("route add rt-work");
    await until(
      () =>
        noticeText() ===
        ":route add: config.toml does not parse now; fix it first (:config shows it)",
      "the notice says why config.toml took nothing",
    );
    Assert.equal(await IOUtils.readUTF8(file), broken, "and the file is as it was");
  } finally {
    await SpecialPowers.popPrefEnv();
    await ConfigHost.reload();
    await IOUtils.remove(dir, { recursive: true });
    route([{ domain: "example.com", workspace: "rt-work" }]);
    tidy();
  }
});

// setup-v2 decision 5: `:route add` appends inside the queue every config.toml edit runs in, so
// a rewrite that read the file before the append neither refuses ("changed meanwhile") nor drops
// the rule when it renames its copy over the file.
add_task(async function route_add_waits_for_a_running_rewrite() {
  const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-routes");
  const file = PathUtils.join(dir, "config.toml");
  await IOUtils.writeUTF8(file, "schema = 2\n");
  await SpecialPowers.pushPrefEnv({ set: [["vimma.config.path", file]] });
  try {
    await ConfigHost.reload();
    const rewrite = ConfigHost.editSiteUnbind("example.net", { add: ["j"] });
    const append = ConfigHost.addRoute({ domain: "example.org", workspace: "rt-work" });
    const [edited, appended] = await Promise.all([rewrite, append]);
    Assert.ok(!("error" in edited), `the rewrite is written: ${JSON.stringify(edited)}`);
    Assert.deepEqual(appended, { added: "config.toml" }, "the rule is written");
    const text = await IOUtils.readUTF8(file);
    Assert.ok(
      text.includes('[sites."example.net"]'),
      `the rewrite's table is in the file:\n${text}`,
    );
    Assert.ok(text.includes('domain = "example.org"'), `and the rule after it:\n${text}`);
    Assert.equal(WorkspaceRouter.routes.length, 1, "the rule is read");
  } finally {
    await SpecialPowers.popPrefEnv();
    await ConfigHost.reload();
    await IOUtils.remove(dir, { recursive: true });
    route([{ domain: "example.com", workspace: "rt-work" }]);
    tidy();
  }
});
