/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/workspace-routing.md, docs/specs/app-routes.md. A link from another program
// (the remote command line, with `-vimma-from <names>` from vimma-open) routes by the names of
// the programs that opened it, then by domain, then by `[routing] default_workspace`; a tab an
// app rule placed (a cold start's first tab too) keeps its names on its host; about:vimma shows
// the last names, never the URL; private windows are never routed. Split from
// browser_vimma_workspace_routes.js to keep each file under the harness's 45 s limit on two busy
// CPUs.

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
      // An XPCOM exception has its nsresult; anything else thrown has none.
      if (/** @type {{ result?: number }} */ (e).result === Cr.NS_ERROR_ABORT) throw e;
    }
  }
}

/**
 * `vimma <args>` while Vimma runs: the line the D-Bus remote hands over.
 * @param {string[]} args
 */
async function remote(args, state = Ci.nsICommandLine.STATE_REMOTE_AUTO) {
  const opened = nextTab();
  // An nsISupports in the IDL; the command line's class info gives it nsICommandLine.
  const cmdLine = /** @type {nsICommandLine} */ (Cu.createCommandLine(args, null, state));
  runHandlers(cmdLine);
  const tab = await opened;
  return { tab, cmdLine };
}

add_task(async function an_external_link_routes_by_the_app_that_opened_it() {
  route([
    { app: "testapp", workspace: "rt-home" },
    { domain: "example.com", workspace: "rt-work" },
  ]);
  ww().switchTo({ id: known("main").id });

  // vimma-open: `vimma -vimma-from <app> <url>`; the app rule comes first in the file.
  const { tab: fromApp, cmdLine } = await remote(["-vimma-from", "TestApp", `${WORK}?app`]);
  Assert.equal(cmdLine.findFlag("vimma-from", false), -1, "the flag is consumed");
  Assert.equal(fromApp.userContextId, home.userContextId, "the app rule wins: rt-home");
  await until(() => activeName() === "rt-home", "a foreground external open switches");
  Assert.deepEqual(WorkspaceRouter.apps, [], "the app hint ends with the command line");

  // Without the flag (a terminal's `vimma <url>`): the domain rule.
  const { tab: plain } = await remote([`${WORK}?noapp`]);
  Assert.equal(plain.userContextId, work.userContextId, "the domain rule: rt-work");

  // A hint that is not a simple name is ignored, even by a rule naming exactly that string
  // (config.toml would refuse such a rule; set here past the check).
  route([{ app: "../../testapp", workspace: "rt-home" }]);
  ww().switchTo({ id: known("main").id });
  const { tab: bad } = await remote(["-vimma-from", "../../testapp", `${ELSEWHERE}?bad`]);
  Assert.equal(bad.userContextId, known("main").userContextId, "not routed: the workspace default");

  route([{ domain: "example.com", workspace: "rt-work" }]);
  tidy();
});

add_task(async function a_background_external_link_goes_there_and_says_so() {
  // Decision 4: with links from other programs opened in the background, the routed tab joins
  // its workspace hidden and the notice says where it went.
  await SpecialPowers.pushPrefEnv({ set: [["browser.tabs.loadDivertedInBackground", true]] });
  try {
    ww().switchTo({ id: home.id });
    const page = await BrowserTestUtils.openNewForegroundTab(gBrowser, `${ELSEWHERE}?page`);
    clearNotice();
    const { tab } = await remote([`${WORK}?background`]);
    Assert.equal(tab.userContextId, work.userContextId, "the link is in rt-work's container");
    await until(() => tab.hidden, "hidden: it is not in the workspace shown");
    Assert.equal(activeName(), "rt-home", "a background open never switches");
    Assert.equal(gBrowser.selectedTab, page, "the page stays selected");
    await until(() => noticeText() === 'opened in "rt-work"', "the notice says where it went");
  } finally {
    await SpecialPowers.popPrefEnv();
    tidy();
  }
});

// docs/specs/app-routes.md: a link carries every program on the way, nearest first.
add_task(async function an_external_link_matches_by_the_nearest_name() {
  route([
    { app: "ghostty", workspace: "rt-work" },
    { app: "herdr", workspace: "rt-home" },
  ]);
  ww().switchTo({ id: known("main").id });
  const { tab } = await remote(["-vimma-from", "python3,zsh,herdr,zsh,ghostty", `${ELSEWHERE}?n`]);
  Assert.equal(tab.userContextId, home.userContextId, "herdr is nearer than ghostty: rt-home");
  Assert.deepEqual(WorkspaceRouter.apps, [], "the names end with the command line");
  const { tab: far } = await remote(["-vimma-from", "python3,zsh,ghostty", `${ELSEWHERE}?far`]);
  Assert.equal(far.userContextId, work.userContextId, "only ghostty is named: rt-work");
  route([{ domain: "example.com", workspace: "rt-work" }]);
  tidy();
});

// The command line MacApplicationDelegate-mm.patch builds for a link from a running macOS app:
// the sender's bundle identifier and executable name before the first -url or -url-background,
// run as STATE_REMOTE_EXPLICIT (app-routes, decision 11).
add_task(async function a_mac_apps_link_routes_by_its_bundle_identifier_or_executable() {
  const explicit = Ci.nsICommandLine.STATE_REMOTE_EXPLICIT;
  route([
    { app: "com.mitchellh.ghostty", workspace: "rt-home" },
    { domain: "example.com", workspace: "rt-work" },
  ]);
  ww().switchTo({ id: known("main").id });
  const names = "com.mitchellh.ghostty,ghostty";
  const { tab, cmdLine } = await remote(["-vimma-from", names, "-url", `${WORK}?id`], explicit);
  Assert.equal(tab.userContextId, home.userContextId, "the bundle identifier's rule: rt-home");
  Assert.equal(cmdLine.findFlag("vimma-from", false), -1, "the flag is consumed");
  ww().switchTo({ id: known("main").id });
  const { tab: behind } = await remote(
    ["-vimma-from", names, "-url-background", `${WORK}?behind`],
    explicit,
  );
  Assert.equal(behind.userContextId, home.userContextId, "-url-background routes the same");

  route([
    { app: "ghostty", workspace: "rt-home" },
    { domain: "example.com", workspace: "rt-work" },
  ]);
  ww().switchTo({ id: known("main").id });
  const { tab: exe } = await remote(["-vimma-from", names, "-url", `${WORK}?exe`], explicit);
  Assert.equal(exe.userContextId, home.userContextId, "the executable name's rule: rt-home");
  const { tab: none } = await remote(["-url", `${WORK}?none`], explicit);
  Assert.equal(none.userContextId, work.userContextId, "no names, as for open(1): rt-work");
  route([{ domain: "example.com", workspace: "rt-work" }]);
  tidy();
});

add_task(async function an_app_list_with_a_bad_name_routes_by_the_rest() {
  route([{ app: "herdr", workspace: "rt-home" }]);
  ww().switchTo({ id: known("main").id });
  const { tab } = await remote(["-vimma-from", "py thon,../x,HERDR", `${ELSEWHERE}?bad-name`]);
  Assert.equal(tab.userContextId, home.userContextId, "the names that are tokens still match");
  route([{ domain: "example.com", workspace: "rt-work" }]);
  tidy();
});

/**
 * A window opened for one URL from another program's command line, as BrowserContentHandler's
 * openBrowserWindow opens it (a cold start or an external window open: `fromExternal`).
 * @param {string} url
 */
async function openExternalWindow(url) {
  const extra = Cc["@mozilla.org/hash-property-bag;1"].createInstance(Ci.nsIWritablePropertyBag2);
  extra.setPropertyAsBool("fromExternal", true);
  const args = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
  const str = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
  str.data = url;
  args.appendElement(str);
  args.appendElement(extra);
  const opened = BrowserTestUtils.waitForNewWindow({ url });
  Services.ww.openWindow(
    null,
    AppConstants.BROWSER_CHROME_URL,
    "_blank",
    "chrome,all,dialog=no",
    args,
  );
  return opened;
}

/** `[routing] default_workspace` as ConfigHost sets it. */
const defaultTo = (/** @type {string | null} */ name) => WorkspaceRouter.setDefaultWorkspace(name);

add_task(async function an_unmatched_external_link_opens_in_the_default_workspace() {
  route([{ domain: "example.com", workspace: "rt-work" }]);
  defaultTo("rt-home");
  try {
    ww().switchTo({ id: known("main").id });
    const { tab } = await remote([`${ELSEWHERE}?default`]);
    Assert.equal(tab.userContextId, home.userContextId, "no rule, no program: rt-home");
    const { tab: named } = await remote(["-vimma-from", "slack", `${ELSEWHERE}?default-named`]);
    Assert.equal(named.userContextId, home.userContextId, "a program no rule names: rt-home");
    route([]);
    const { tab: noRules } = await remote([`${ELSEWHERE}?no-rules`]);
    Assert.equal(noRules.userContextId, home.userContextId, "with no rules at all, too");
  } finally {
    defaultTo(null);
    route([{ domain: "example.com", workspace: "rt-work" }]);
    tidy();
  }
});

add_task(async function a_rule_beats_the_default_workspace() {
  defaultTo("rt-home");
  try {
    ww().switchTo({ id: known("main").id });
    const { tab } = await remote([`${WORK}?rule-first`]);
    Assert.equal(tab.userContextId, work.userContextId, "the domain rule: rt-work");
  } finally {
    defaultTo(null);
    tidy();
  }
});

add_task(async function the_default_workspace_never_applies_in_a_private_window() {
  defaultTo("rt-home");
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    const opened = nextTab(priv);
    priv.browserDOMWindow.openURI(
      Services.io.newURI(`${ELSEWHERE}?private-external`),
      null,
      Ci.nsIBrowserDOMWindow.OPEN_NEWTAB,
      Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL,
      Services.scriptSecurityManager.getSystemPrincipal(),
    );
    const tab = await opened;
    Assert.equal(tab.userContextId, 0, "a link from another program in a private window");
    // The tab's window, compared as a Window (a BrowserWindow is one).
    Assert.equal(
      /** @type {Window | null} */ (tab.ownerDocument.defaultView),
      priv,
      "stays there, with no container",
    );
  } finally {
    await BrowserTestUtils.closeWindow(priv);
    defaultTo(null);
  }
});

add_task(async function private_windows_are_never_routed() {
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const tabs = gBrowser.tabs.length;
  const opened = nextTab(priv);
  priv.openTrustedLinkIn(`${WORK}?private`, "tab");
  const tab = await opened;
  Assert.equal(tab.userContextId, 0, "the private tab has no container");
  // The tab's window, compared as a Window (a BrowserWindow is one).
  Assert.equal(
    /** @type {Window | null} */ (tab.ownerDocument.defaultView),
    priv,
    "and stays in the private window",
  );
  Assert.equal(gBrowser.tabs.length, tabs, "nothing opens in the normal window");
  await BrowserTestUtils.closeWindow(priv);
});

// docs/specs/app-routes.md, decision 14: a tab an app rule placed keeps its names on its host.
/** @type {Record<string, string>[]} */
const SIGNIN = [
  { app: "testapp", domain: "example.com", workspace: "rt-home" },
  { domain: "example.com", workspace: "rt-work" },
  { domain: "example.org", workspace: "rt-work" },
];

/**
 * Every text the status bar notice of `win` shows from now on, until `stop()`.
 * @param {Window} [win]
 */
function recordNotices(win = window) {
  /** @type {string[]} */
  const seen = [];
  const take = () => {
    const text = noticeText(win);
    if (text && seen.at(-1) !== text) seen.push(text);
  };
  const observer = new win.MutationObserver(take);
  observer.observe(win.document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  return { seen, stop: () => observer.disconnect() };
}

/**
 * Loads `url` in `tab` as the page's own navigation (its own content principal).
 * @param {MozTabbrowserTab} tab
 * @param {string} url
 */
async function navigate(tab, url) {
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  await SpecialPowers.spawn(tab.linkedBrowser, [url], (u) => {
    // A link the page's own document follows: the load's triggering principal is the page's.
    // `content.location.href = u` here would run with the test sandbox's system principal, as
    // what the user opens does (decision 9).
    const link = content.document.createElement("a");
    link.href = u;
    content.document.body.append(link);
    link.click();
  });
  await loaded;
}

/** The app-routed sign-in tab: `testapp` opens example.com, the app rule puts it in rt-home. */
async function signInTab() {
  route(SIGNIN);
  ww().switchTo({ id: known("main").id });
  const { tab } = await remote(["-vimma-from", "testapp", `${WORK}?signin`]);
  Assert.equal(tab.userContextId, home.userContextId, "the app rule places it in rt-home");
  await until(() => gBrowser.selectedTab === tab, "the tab is shown");
  await until(
    () =>
      tab.linkedBrowser.currentURI.spec === `${WORK}?signin` &&
      !tab.linkedBrowser.webProgress?.isLoadingDocument,
    "the sign-in page has loaded",
  );
  return tab;
}

add_task(async function an_app_routed_tab_is_not_hinted_back_by_a_domain_rule() {
  const notices = recordNotices();
  try {
    const tab = await signInTab();
    await navigate(tab, `${WORK}?signin-step-2`);
    // Leaving the host is the page's own navigation: the hint describes it as before.
    await navigate(tab, `${ELSEWHERE}?left`);
    await until(
      () => noticeText() === 'example.org goes to "rt-work" (route 3): :route move',
      "a host the app rule did not place it on is hinted",
    );
    Assert.deepEqual(
      // Route 2 is SIGNIN's domain rule (route 1 of the earlier rules may be hinted on the way).
      notices.seen.filter((t) => t === 'example.com goes to "rt-work" (route 2): :route move'),
      [],
      "the sign-in host is never hinted back to rt-work",
    );
  } finally {
    notices.stop();
    route([{ domain: "example.com", workspace: "rt-work" }]);
    tidy();
  }
});

add_task(async function route_move_keeps_an_app_routed_tab_until_it_leaves_the_host() {
  try {
    const tab = await signInTab();
    clearNotice();
    await runCommand("route move");
    await until(
      () => noticeText() === ':route move: already in "rt-home"',
      ":route move matches with the tab's names while it is on the sign-in host",
    );
    Assert.ok(tab.isConnected, "the tab stays");

    await navigate(tab, `${ELSEWHERE}?left-move`);
    // The move opens a home tab first when it empties rt-home: wait for a tab in rt-work.
    const moved = BrowserTestUtils.waitForEvent(
      gBrowser.tabContainer,
      "TabOpen",
      false,
      // TabOpen's target is the new tab.
      (/** @type {Event} */ e) =>
        /** @type {MozTabbrowserTab} */ (e.target).userContextId === work.userContextId,
    );
    await runCommand("route move");
    await moved;
    await until(() => !tab.isConnected, "after it leaves, the domain rule's: moved to rt-work");
  } finally {
    route([{ domain: "example.com", workspace: "rt-work" }]);
    tidy();
  }
});

add_task(async function a_cold_start_app_routed_first_tab_is_not_hinted_back() {
  route(SIGNIN);
  Services.env.set("VIMMA_FROM", "testapp");
  WorkspaceRouter.resetStartupAppForTesting();
  const cold = await openExternalWindow(`${WORK}?cold-signin`);
  try {
    const tab = cold.gBrowser.selectedTab;
    Assert.equal(tab.userContextId, home.userContextId, "the app rule places the first tab");
    await until(
      () => WorkspaceRouter.matchTab(tab)?.workspace.name === "rt-home",
      "the first tab keeps the cold start's names on its host",
    );
    await navigate(tab, `${ELSEWHERE}?cold-left`);
    Assert.equal(
      WorkspaceRouter.matchTab(tab)?.workspace.name,
      "rt-work",
      "once it leaves the host, the rules alone",
    );
  } finally {
    await BrowserTestUtils.closeWindow(cold);
    route([{ domain: "example.com", workspace: "rt-work" }]);
  }
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

/** Opens about:vimma in a new tab and waits for it to render. */
async function openAboutVimma() {
  const about = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:vimma");
  await until(
    () => about.linkedBrowser.contentDocument?.documentElement?.dataset.ready === "true",
    "about:vimma rendered",
  );
  return about;
}

// docs/specs/app-routes.md, decision 15.
add_task(async function about_vimma_shows_the_last_names_without_the_url() {
  const { AboutVimma } = ChromeUtils.importESModule(
    "chrome://browser/content/vimma/about/AboutVimma.sys.mjs",
  );
  try {
    await signInTab();
    const about = await openAboutVimma();
    const last = section(aboutDoc(about), "route-last").textContent;
    Assert.stringContains(last, "testapp", "the names the link carried");
    Assert.stringContains(last, "rule 1 (rt-home)", "and the rule it matched");
    Assert.ok(!/signin|example\.com/.test(last), "never its URL");
    const report = AboutVimma.report(await AboutVimma.collect(window));
    Assert.ok(!report.includes("testapp"), "the :bug report keeps only the rule count");
    BrowserTestUtils.removeTab(about);

    route([{ domain: "example.com", workspace: "rt-work" }]);
    defaultTo("rt-work");
    await remote(["-vimma-from", "otherapp", `${ELSEWHERE}?unmatched`]);
    const again = await openAboutVimma();
    const doc = aboutDoc(again);
    Assert.stringContains(
      section(doc, "route-last").textContent,
      "otherapp → [routing] default_workspace (rt-work)",
      "an unmatched link names the default workspace",
    );
    Assert.stringContains(
      section(doc, "route-default").textContent,
      "rt-work",
      "the section shows [routing] default_workspace",
    );
  } finally {
    defaultTo(null);
    route([{ domain: "example.com", workspace: "rt-work" }]);
    tidy();
  }
});

add_task(async function about_vimma_marks_a_shadowed_rule() {
  route([
    { domain: "example.com", workspace: "rt-work" },
    { domain: "a.example.com", workspace: "rt-home" },
    { app: "testapp", domain: "example.com", workspace: "rt-home" },
    { domain: "example.org", workspace: "rt-home" },
  ]);
  try {
    const about = await openAboutVimma();
    const states = [...aboutDoc(about).querySelectorAll("#routes tbody tr td:last-child")].map(
      (td) => td.textContent,
    );
    Assert.deepEqual(
      states,
      ["in force", "shadowed by rule 1", "shadowed by rule 1", "in force"],
      "an earlier rule that always wins marks the later ones",
    );
  } finally {
    route([{ domain: "example.com", workspace: "rt-work" }]);
    tidy();
  }
});
