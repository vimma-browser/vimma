/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/vimma-mcp.md, decision 42 (docs/security/12-agents-mcp.md M24). A tab you did
// not open inside the agent workspace never takes its container: a link from another app (the
// remote command line, BrowserDOMWindow's external open, Firefox's container guess), a URL from the
// control socket, a new window's first tab, and the container cached for the next start. Such a
// link opens in the last workspace you used that is not the agent's, and a foreground open switches
// to it. What you open yourself inside the agent workspace (ctrl+t) stays there.

"use strict";

const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
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

const LOGIN = "https://example.com/?login-token=secret";
const STARTUP_PREF = "vimma.workspaces.startupUserContextId";

const def = (/** @type {string} */ name) =>
  WorkspaceStore.definitions.workspaces.find((w) => w.name === name);
const agent = () => /** @type {any} */ (WorkspaceStore.agent);
const ww = (win = window) => WindowWorkspaces.get(win);
const activeName = (win = window) =>
  ww(win).model.workspaces.find((w) => w.id === ww(win).model.active).name;

/** @param {() => boolean} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 50, 100);

/** Resolves with the next tab opened in `win`. */
const nextTab = (win = window) =>
  BrowserTestUtils.waitForEvent(win.gBrowser.tabContainer, "TabOpen").then((e) => e.target);

/** The workspace used before the agent's: `oo-home`. */
let home;

add_task(async function setup() {
  home = WorkspaceStore.addWorkspace({ name: "oo-home", color: "green", icon: "tree" });
  registerCleanupFunction(async () => {
    ww().switchTo({ id: def("main").id });
    while (gBrowser.tabs.length > 1) BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
    await WorkspaceStore.deleteWorkspace(home.id, { confirmed: true });
  });
  Assert.ok(agent()?.userContextId > 0, "the agent workspace has its container");
});

/** Shows oo-home, then the agent workspace with one agent tab selected. */
async function inAgentAfterHome() {
  ww().switchTo({ id: home.id });
  await until(() => activeName() === "oo-home", "oo-home is shown");
  ww().switchTo({ id: agent().id });
  await until(() => activeName() === agent().name, "the agent workspace is shown");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/?agent");
  Assert.equal(tab.userContextId, agent().userContextId, "ctrl+t-like opens there stay there");
  return tab;
}

/** Closes every tab but the first, back to main. */
function tidy() {
  ww().switchTo({ id: def("main").id });
  while (gBrowser.tabs.length > 1) BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
}

/**
 * What nsCommandLine::Run does with a command line from another process: every
 * command-line-handler in the order of its category entry (as browser_vimma_workspace_routes).
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

add_task(async function an_external_link_opens_in_the_last_normal_workspace_and_switches() {
  await inAgentAfterHome();
  const opened = nextTab();
  const cmdLine = Cu.createCommandLine([LOGIN], null, Ci.nsICommandLine.STATE_REMOTE_AUTO);
  runHandlers(cmdLine);
  const tab = await opened;
  Assert.notEqual(tab.userContextId, agent().userContextId, "never the agent container");
  Assert.equal(tab.userContextId, home.userContextId, "the last workspace used: oo-home");
  await until(() => activeName() === "oo-home", "the foreground open switches to oo-home");
  Assert.equal(gBrowser.selectedTab, tab, "and shows the link");
  tidy();
});

add_task(async function browser_dom_window_external_opens_skip_the_agent_container() {
  const agentTab = await inAgentAfterHome();
  const system = Services.scriptSecurityManager.getSystemPrincipal();
  const { OPEN_NEWTAB, OPEN_CURRENTWINDOW, OPEN_EXTERNAL } = Ci.nsIBrowserDOMWindow;

  // Firefox's guess picks the container with the most tabs on the host: the agent's here.
  let opened = nextTab();
  window.browserDOMWindow.openURI(
    Services.io.newURI("https://example.org/?guessed"),
    null,
    OPEN_NEWTAB,
    OPEN_EXTERNAL,
    system,
  );
  let tab = await opened;
  Assert.notEqual(tab.userContextId, agent().userContextId, "a guess never picks the agent's");
  Assert.equal(tab.userContextId, home.userContextId, "it falls back to oo-home");

  // "Open links from other apps in the current tab": never into the selected agent tab.
  ww().switchTo({ id: agent().id });
  await until(() => gBrowser.selectedTab === agentTab, "the agent tab is selected again");
  opened = nextTab();
  window.browserDOMWindow.openURI(
    Services.io.newURI(LOGIN),
    null,
    OPEN_CURRENTWINDOW,
    OPEN_EXTERNAL,
    system,
  );
  tab = await opened;
  Assert.equal(tab.userContextId, home.userContextId, "a new tab in oo-home instead");
  Assert.equal(
    agentTab.linkedBrowser.currentURI.spec,
    "https://example.org/?agent",
    "the agent tab is left as it was",
  );
  tidy();
});

add_task(async function tabs_loaded_from_outside_skip_the_agent_container() {
  await inAgentAfterHome();
  // `vimma <url1> <url2>` starting a window: browser-init's loadTabs, marked fromExternal.
  const tabs = gBrowser.loadTabs(["https://example.com/?one", "https://example.net/?two"], {
    inBackground: true,
    fromExternal: true,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  Assert.equal(tabs.length, 2, "two tabs");
  for (const tab of tabs) {
    Assert.equal(tab.userContextId, home.userContextId, "each in oo-home, never the agent's");
  }
  tidy();
});

add_task(async function a_guess_for_another_workspace_still_counts() {
  // Firefox guesses from visible tabs only: oo-other is shown in a second window.
  const other = WorkspaceStore.addWorkspace({ name: "oo-other", color: "red", icon: "circle" });
  const second = await BrowserTestUtils.openNewBrowserWindow();
  ww(second).switchTo({ id: other.id });
  await until(() => activeName(second) === "oo-other", "the second window shows oo-other");
  for (const n of [1, 2]) {
    await BrowserTestUtils.openNewForegroundTab(second.gBrowser, `https://example.org/?other-${n}`);
  }
  await inAgentAfterHome();
  window.focus();
  const opened = nextTab();
  window.browserDOMWindow.openURI(
    Services.io.newURI("https://example.org/?guessed-other"),
    null,
    Ci.nsIBrowserDOMWindow.OPEN_NEWTAB,
    Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL,
    Services.scriptSecurityManager.getSystemPrincipal(),
  );
  const tab = await opened;
  Assert.equal(tab.userContextId, other.userContextId, "Firefox's guess of oo-other is kept");
  await BrowserTestUtils.closeWindow(second);
  tidy();
  await WorkspaceStore.deleteWorkspace(other.id, { confirmed: true });
});

add_task(async function a_route_rule_naming_the_agent_workspace_is_not_followed_from_outside() {
  WorkspaceRouter.setRoutes(resolveRoutes([{ domain: "example.com", workspace: agent().name }]));
  try {
    await inAgentAfterHome();
    const opened = nextTab();
    window.browserDOMWindow.openURI(
      Services.io.newURI(LOGIN),
      null,
      Ci.nsIBrowserDOMWindow.OPEN_NEWTAB,
      Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL,
      Services.scriptSecurityManager.getSystemPrincipal(),
    );
    const tab = await opened;
    Assert.equal(tab.userContextId, home.userContextId, "a link from another app: oo-home");

    const url = "https://example.com/?window";
    const win = BrowserTestUtils.waitForNewWindow({ url });
    window.openDialog(AppConstants.BROWSER_CHROME_URL, "_blank", "chrome,all,dialog=no", url);
    const w = await win;
    Assert.equal(
      w.gBrowser.selectedTab.userContextId,
      home.userContextId,
      "a new window's first URL: oo-home",
    );
    await BrowserTestUtils.closeWindow(w);
  } finally {
    WorkspaceRouter.setRoutes([]);
    tidy();
  }
});

/**
 * A link from another program, `vimma -vimma-from <names> <url>`, while oo-home was used last.
 * @param {string} names
 * @param {string} url
 */
async function fromPrograms(names, url) {
  const opened = nextTab();
  const cmdLine = Cu.createCommandLine(
    ["-vimma-from", names, url],
    null,
    Ci.nsICommandLine.STATE_REMOTE_AUTO,
  );
  runHandlers(cmdLine);
  return opened;
}

// docs/specs/app-routes.md, decision 5.
add_task(async function a_rule_after_one_naming_the_agent_workspace_applies() {
  const other = WorkspaceStore.addWorkspace({ name: "oo-other", color: "red", icon: "fence" });
  WorkspaceRouter.setRoutes(
    resolveRoutes([
      { domain: "example.com", workspace: agent().name },
      { domain: "example.com", workspace: "oo-other" },
    ]),
  );
  try {
    await inAgentAfterHome();
    const tab = await fromPrograms("slack", LOGIN);
    Assert.equal(tab.userContextId, other.userContextId, "the next rule applies: oo-other");
  } finally {
    WorkspaceRouter.setRoutes([]);
    tidy();
    await WorkspaceStore.deleteWorkspace(other.id, { confirmed: true });
  }
});

add_task(async function an_agent_cli_link_skips_every_app_rule_after_an_agent_rule() {
  const admin = WorkspaceStore.addWorkspace({ name: "oo-admin", color: "red", icon: "fence" });
  WorkspaceRouter.setRoutes(
    resolveRoutes([
      { app: "claude", workspace: agent().name },
      { app: "ghostty", domain: "example.com", workspace: "oo-admin" },
    ]),
  );
  try {
    await inAgentAfterHome();
    const tab = await fromPrograms("claude,zsh,ghostty", LOGIN);
    Assert.notEqual(tab.userContextId, admin.userContextId, "never the terminal's oo-admin");
    Assert.notEqual(tab.userContextId, agent().userContextId, "never the agent's container");
    const user = await fromPrograms("python3,zsh,ghostty", LOGIN);
    Assert.equal(user.userContextId, admin.userContextId, "your own CLI's link: oo-admin");
  } finally {
    WorkspaceRouter.setRoutes([]);
    tidy();
    await WorkspaceStore.deleteWorkspace(admin.id, { confirmed: true });
  }
});

add_task(
  async function a_child_named_after_the_terminal_under_an_agent_cli_never_reaches_the_terminals_rule() {
    const admin = WorkspaceStore.addWorkspace({ name: "oo-admin", color: "red", icon: "fence" });
    WorkspaceRouter.setRoutes(
      resolveRoutes([
        { app: "ghostty", workspace: "oo-admin" },
        { app: "claude", workspace: agent().name },
      ]),
    );
    try {
      await inAgentAfterHome();
      const tab = await fromPrograms("ghostty,claude,zsh,ghostty", LOGIN);
      Assert.notEqual(tab.userContextId, admin.userContextId, "never oo-admin");
      Assert.equal(tab.userContextId, home.userContextId, "the last workspace used: oo-home");
    } finally {
      WorkspaceRouter.setRoutes([]);
      tidy();
      await WorkspaceStore.deleteWorkspace(admin.id, { confirmed: true });
    }
  },
);

add_task(async function a_default_workspace_naming_the_agent_workspace_is_passed_over() {
  WorkspaceRouter.setDefaultWorkspace(agent().name);
  try {
    await inAgentAfterHome();
    const tab = await fromPrograms("slack", LOGIN);
    Assert.equal(tab.userContextId, home.userContextId, "never the agent's: oo-home");
  } finally {
    WorkspaceRouter.setDefaultWorkspace(null);
    tidy();
  }
});

// docs/specs/app-routes.md, decision 14 (docs/security/02-workspace-routing.md R10): a tab's
// recorded names never pick a rule naming the agent workspace, for the hint, :route move or
// about:vimma.
add_task(async function an_app_routed_tabs_names_never_pick_the_agent_workspace() {
  WorkspaceRouter.setRoutes(
    resolveRoutes([{ app: "testapp", domain: "example.com", workspace: "oo-home" }]),
  );
  try {
    await inAgentAfterHome();
    const tab = await fromPrograms("testapp", LOGIN);
    Assert.equal(tab.userContextId, home.userContextId, "the app rule places it in oo-home");
    await until(
      () => WorkspaceRouter.matchTab(tab)?.workspace.name === "oo-home",
      "the tab keeps its names on its host",
    );
    WorkspaceRouter.setRoutes(
      resolveRoutes([
        { app: "testapp", workspace: agent().name },
        { app: "testapp", domain: "example.com", workspace: "oo-home" },
      ]),
    );
    Assert.notEqual(
      WorkspaceRouter.matchTab(tab)?.workspace.name,
      agent().name,
      "a rule naming the agent workspace is never chosen with the tab's names",
    );
  } finally {
    WorkspaceRouter.setRoutes([]);
    tidy();
  }
});

// docs/specs/app-routes.md, decision 15.
add_task(async function about_vimma_marks_an_agent_rule_and_an_agent_default() {
  WorkspaceRouter.setRoutes(
    resolveRoutes([
      { app: "claude", workspace: agent().name },
      { domain: "example.com", workspace: "oo-home" },
    ]),
  );
  WorkspaceRouter.setDefaultWorkspace(agent().name);
  try {
    const about = await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:vimma");
    await until(
      () => about.linkedBrowser.contentDocument?.documentElement.dataset.ready === "true",
      "about:vimma rendered",
    );
    const doc = about.linkedBrowser.contentDocument;
    const states = [...doc.querySelectorAll("#routes tbody tr td:last-child")].map(
      (td) => td.textContent,
    );
    Assert.deepEqual(
      states,
      ["never for links from other apps: the agent workspace", "in force"],
      "the agent rule is marked",
    );
    Assert.stringContains(
      doc.getElementById("route-default").textContent,
      "never for links from other apps: the agent workspace",
      "and so is a default workspace naming it",
    );
  } finally {
    WorkspaceRouter.setRoutes([]);
    WorkspaceRouter.setDefaultWorkspace(null);
    tidy();
  }
});

add_task(async function a_tab_sent_from_another_device_skips_the_agent_container() {
  await inAgentAfterHome();
  const opened = nextTab();
  const payload = { object: [{ uri: LOGIN, title: "login", sender: { name: "Phone" } }] };
  Services.obs.notifyObservers({ wrappedJSObject: payload }, "fxaccounts:commands:open-uri");
  const tab = await opened;
  Assert.equal(tab.userContextId, home.userContextId, "Send Tab: oo-home, never the agent's");
  tidy();
});

add_task(async function a_control_socket_open_skips_the_agent_container() {
  const agentTab = await inAgentAfterHome();
  let opened = nextTab();
  VimmaControl._commands.open({ url: LOGIN });
  let tab = await opened;
  Assert.equal(tab.userContextId, home.userContextId, "`open`: a new tab in oo-home");
  await until(() => activeName() === "oo-home", "the window switches to oo-home");

  ww().switchTo({ id: agent().id });
  await until(() => gBrowser.selectedTab === agentTab, "the agent tab is selected again");
  opened = nextTab();
  VimmaControl._commands.open({ url: LOGIN, where: "current" });
  tab = await opened;
  Assert.equal(tab.userContextId, home.userContextId, "`open` current: a new tab in oo-home");
  Assert.equal(
    agentTab.linkedBrowser.currentURI.spec,
    "https://example.org/?agent",
    "the agent tab is left as it was",
  );
  tidy();
});

add_task(async function a_new_windows_first_tab_and_the_startup_cache_skip_the_agent() {
  await inAgentAfterHome();
  Assert.notEqual(
    Services.prefs.getIntPref(STARTUP_PREF, 0),
    agent().userContextId,
    "the container cached for the next start is never the agent's",
  );
  Assert.equal(
    Services.prefs.getIntPref("vimma.workspaces.startupAgentUserContextId", 0),
    agent().userContextId,
    "and the agent's container is cached beside it",
  );
  const url = "https://example.net/?window";
  const opened = BrowserTestUtils.waitForNewWindow({ url });
  window.openDialog(AppConstants.BROWSER_CHROME_URL, "_blank", "chrome,all,dialog=no", url);
  const win = await opened;
  Assert.equal(
    win.gBrowser.selectedTab.userContextId,
    home.userContextId,
    "a window opened from the agent workspace starts in oo-home",
  );
  await BrowserTestUtils.closeWindow(win);
  tidy();
});

add_task(async function with_no_normal_workspace_used_yet_the_first_one_is_taken() {
  ww().switchTo({ id: agent().id });
  await until(() => activeName() === agent().name, "the agent workspace is shown");
  WorkspaceStore._forgetLastUserWorkspaceForTesting();
  Services.prefs.clearUserPref(STARTUP_PREF);
  const opened = nextTab();
  window.browserDOMWindow.openURI(
    Services.io.newURI(LOGIN),
    null,
    Ci.nsIBrowserDOMWindow.OPEN_NEWTAB,
    Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL,
    Services.scriptSecurityManager.getSystemPrincipal(),
  );
  const tab = await opened;
  Assert.equal(
    tab.userContextId,
    WorkspaceStore.definitions.workspaces[0].userContextId,
    "the first workspace in order",
  );
  Assert.notEqual(tab.userContextId, agent().userContextId, "never the agent's");
  tidy();
});

add_task(async function the_agent_workspace_is_known_before_config_toml_names_it() {
  // `[mcp] workspace = "bots"` is applied after the first tab; until then the workspace Vimma
  // made (its recorded id) and the one whose container the last save recorded count too.
  const ID_PREF = "vimma.mcp.agentWorkspaceId";
  const CACHE_PREF = "vimma.workspaces.startupAgentUserContextId";
  const savedId = Services.prefs.getStringPref(ID_PREF, "");
  const savedCache = Services.prefs.getIntPref(CACHE_PREF, 0);
  const bots = WorkspaceStore.addWorkspace({ name: "oo-bots", color: "cyan", icon: "circle" });
  const robots = WorkspaceStore.addWorkspace({ name: "oo-robots", color: "cyan", icon: "circle" });
  try {
    ww().switchTo({ id: home.id });
    /** A save records the agent's container again: set both after each switch. */
    const pretend = () => {
      Services.prefs.setStringPref(ID_PREF, bots.id);
      Services.prefs.setIntPref(CACHE_PREF, robots.userContextId);
    };
    pretend();
    Assert.ok(WorkspaceStore.isAgentContainer(bots.userContextId), "the recorded id counts");
    Assert.ok(WorkspaceStore.isAgentContainer(robots.userContextId), "the cached container too");
    Assert.ok(!WorkspaceStore.isAgentContainer(home.userContextId), "oo-home does not");
    for (const ws of [bots, robots]) {
      ww().switchTo({ id: ws.id });
      await until(() => activeName() === ws.name, `${ws.name} is shown`);
      pretend();
      Assert.equal(
        WorkspaceStore.nonAgentUserContextId(window),
        home.userContextId,
        `an outside open from ${ws.name} goes to oo-home`,
      );
    }
  } finally {
    Services.prefs.setStringPref(ID_PREF, savedId);
    Services.prefs.setIntPref(CACHE_PREF, savedCache);
    tidy();
    await WorkspaceStore.deleteWorkspace(bots.id, { confirmed: true });
    await WorkspaceStore.deleteWorkspace(robots.id, { confirmed: true });
  }
});

add_task(async function config_toml_naming_the_agent_workspace_retires_the_recorded_one() {
  // Once config.toml has named the agent workspace, a workspace Vimma made earlier under
  // another name is an ordinary one again (decision 8): outside opens may land there.
  const ID_PREF = "vimma.mcp.agentWorkspaceId";
  const savedId = Services.prefs.getStringPref(ID_PREF, "");
  const old = WorkspaceStore.addWorkspace({ name: "oo-old-agent", color: "cyan", icon: "circle" });
  const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-outside");
  const file = PathUtils.join(dir, "config.toml");
  await IOUtils.writeUTF8(file, "schema = 2\n");
  try {
    Services.prefs.setStringPref(ID_PREF, old.id);
    Assert.ok(WorkspaceStore.isAgentContainer(old.userContextId), "recorded: the agent's");
    await SpecialPowers.pushPrefEnv({ set: [["vimma.config.path", file]] });
    await ConfigHost.reload();
    await until(
      () => !WorkspaceStore.isAgentContainer(old.userContextId),
      "after config.toml is applied, only the named agent workspace counts",
    );
    Assert.ok(WorkspaceStore.isAgentContainer(agent().userContextId), "the named one still does");
  } finally {
    await SpecialPowers.popPrefEnv();
    await ConfigHost.reload();
    Services.prefs.setStringPref(ID_PREF, savedId);
    await WorkspaceStore.deleteWorkspace(old.id, { confirmed: true });
    await IOUtils.remove(dir, { recursive: true });
  }
});
