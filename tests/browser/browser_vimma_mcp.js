/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/vimma-mcp.md, sub-PR 1: every profile has the agent workspace (decision 8),
// made at the startup reconcile, empty, in its own cyan container; it is in the picker but not
// in ctrl+b ( ) or ctrl+^ (decision 9); closing it empties it, renaming it is refused, and
// `:mcp forget` clears its site data; `:mcp on|off` with its y/N (decisions 3 and 26); moving a
// tab into it warns (decision 11). The socket's agent role: browser_vimma_mcp_agent.js.

"use strict";

/* global focusContent -- from head.js */

const { WorkspaceStore, WorkspaceStoreImpl, AGENT_ID_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { McpHost, MCP_ENABLED_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/mcp-ops.mjs",
);
const { ContextualIdentityService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
);

const PAGE = "https://example.com/";
const NOTICE_ID = "vimma-notice";
const PROMPT_ID = "vimma-rename";
const PICKER_ID = "vimma-workspace-picker";

const def = (/** @type {string} */ name) =>
  /** @type {ContainedWorkspace} */ (
    WorkspaceStore.definitions.workspaces.find(
      (/** @type {WorkspaceDefinition} */ w) => w.name === name,
    )
  );
const ww = () => /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(window));
const active = () => ww().model.active;
const activeName = () =>
  ww().model.workspaces.find((/** @type {WorkspaceState} */ w) => w.id === active())?.name;
const identity = (/** @type {number} */ id) =>
  ContextualIdentityService.getPublicIdentityFromId(id);
const tabsOf = (/** @type {number} */ ucid) =>
  gBrowser.tabs.filter((t) => t.userContextId === ucid && !t.closing);
const noticeText = () => document.getElementById(NOTICE_ID)?.textContent ?? "";
const promptOpen = () => document.getElementById(PROMPT_ID)?.hidden === false;
const promptText = () =>
  (
    document.getElementById(PROMPT_ID)?.querySelector(".vimma-cmdline-prompt")?.textContent ?? ""
  ).trim();
const picker = () => /** @type {HTMLDialogElement | null} */ (document.getElementById(PICKER_ID));
const rows = () => [...(picker()?.querySelectorAll("[role=option]") ?? [])];
const cell = (/** @type {Element} */ row, /** @type {string} */ name) =>
  /** @type {Element} */ (row.querySelector(`.vimma-picker-${name}`)).textContent;
const cookieCount = (/** @type {number} */ userContextId) =>
  Services.cookies.getCookiesWithOriginAttributes(JSON.stringify({ userContextId }), "example.com")
    .length;

function setCookie(/** @type {number} */ userContextId) {
  Services.cookies.add(
    "example.com",
    "/",
    "session",
    "agent",
    true,
    false,
    false,
    Date.now() + 86400000,
    { userContextId },
    Ci.nsICookie.SAMESITE_NONE,
    Ci.nsICookie.SCHEME_HTTPS,
  );
}

/** Containers the temporary stores below made, removed at the end. */
/** @type {number[]} */
const madeContainers = [];

registerCleanupFunction(async () => {
  if (promptOpen()) EventUtils.synthesizeKey("KEY_Escape");
  if (picker()?.open) EventUtils.synthesizeKey("KEY_Escape");
  Services.prefs.clearUserPref(MCP_ENABLED_PREF);
  McpHost.configure(null);
  ww().switchTo({ id: def("main").id });
  for (const w of WorkspaceStore.definitions.workspaces.filter(
    (/** @type {WorkspaceDefinition} */ d) =>
      d.name !== "main" && d.id !== WorkspaceStore.agent?.id,
  )) {
    await WorkspaceStore.deleteWorkspace(w.id, { confirmed: true });
  }
  for (const ucid of madeContainers) ContextualIdentityService.remove(ucid);
  Services.cookies.removeAll();
  while (gBrowser.tabs.length > 1)
    BrowserTestUtils.removeTab(/** @type {MozTabbrowserTab} */ (gBrowser.tabs.at(-1)));
});

/** @param {() => unknown} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 50, 100);
}

/** ctrl+b, then `key`. @param {string} key @param {KeyEventOptions} [mods] */
function prefix(key, mods = {}) {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey(key, mods);
}

async function focusPage() {
  const browser = gBrowser.selectedBrowser;
  await until(() => !browser.webProgress?.isLoadingDocument, "the selected page has loaded");
  await focusContent(browser);
}

/** `:line` Enter, from the selected page in normal mode. @param {string} line */
async function runCommand(line) {
  await focusPage();
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
}

/**
 * A temporary definitions file with `doc`, and a store over it (not the app's).
 * @param {{ workspaces?: { id: string, [field: string]: unknown }[], [key: string]: unknown } | null} doc
 * @param {object} [options]
 */
async function tempStore(doc, options = {}) {
  const path = PathUtils.join(PathUtils.tempDir, `vimma-mcp-${Date.now()}-${Math.random()}.json`);
  if (doc) await IOUtils.writeJSON(path, doc);
  // and the backup JSONFile writes next to it (backupTo), which was left in /tmp (#207)
  registerCleanupFunction(async () => {
    for (const file of [path, `${path}.bak`]) await IOUtils.remove(file, { ignoreAbsent: true });
  });
  const store = new WorkspaceStoreImpl({ path, saveDelayMs: 0, ...options });
  await store.init();
  for (const w of store.definitions.workspaces) {
    if (w.userContextId !== null && !doc?.workspaces?.some((d) => d.id === w.id)) {
      madeContainers.push(w.userContextId);
    }
  }
  return store;
}

add_task(async function a_fresh_profile_has_main_and_an_empty_agent_workspace() {
  await ww().ready;
  const names = WorkspaceStore.definitions.workspaces.map(
    (/** @type {WorkspaceDefinition} */ w) => w.name,
  );
  Assert.equal(names[0], "main", "main first");
  Assert.equal(names.at(-1), "agent", "the agent workspace last");
  const agent = def("agent");
  Assert.equal(WorkspaceStore.agent?.id, agent.id, "the store knows it as the agent's");
  Assert.equal(agent.source, "runtime", "a runtime workspace, so schema 1 stays as it is");
  Assert.equal(agent.color, "cyan", "cyan");
  Assert.equal(agent.icon, "fingerprint", "with the fingerprint icon");
  Assert.ok(agent.userContextId > 0, "with a container");
  Assert.notEqual(agent.userContextId, def("main").userContextId, "of its own");
  Assert.equal(identity(agent.userContextId)?.name, "agent", "named after it");
  Assert.equal(tabsOf(agent.userContextId).length, 0, "and no tab, so no page and no process");
  Assert.equal(Services.prefs.getStringPref(AGENT_ID_PREF, ""), agent.id, "its id is recorded");
  Assert.ok(WorkspaceStore.agentIsOurs(), "as one Vimma made");
});

add_task(async function a_profile_from_before_gets_agent_appended_at_its_next_start() {
  const before = {
    schema: 1,
    lastActive: "ws-work",
    workspaces: [
      {
        id: "ws-main",
        name: "main",
        userContextId: null,
        color: "gray",
        icon: "circle",
        source: "runtime",
      },
      {
        id: "ws-work",
        name: "work",
        userContextId: null,
        color: "blue",
        icon: "circle",
        source: "runtime",
      },
    ],
  };
  const pref = "vimma.test.mcp.agentId";
  registerCleanupFunction(() => Services.prefs.clearUserPref(pref));
  const store = await tempStore(before, { agent: "agent", agentPref: pref });
  const ws = store.definitions.workspaces;
  Assert.deepEqual(
    ws.map((/** @type {WorkspaceDefinition} */ w) => [w.id, w.name]),
    [
      ["ws-main", "main"],
      ["ws-work", "work"],
      [ws[2].id, "agent"],
    ],
    "agent is appended; the others keep their ids and order",
  );
  Assert.equal(store.definitions.lastActive, "ws-work", "and the active workspace stays");
  Assert.equal(Services.prefs.getStringPref(pref, ""), ws[2].id, "the made one is recorded");
  for (const w of /** @type {ContainedWorkspace[]} */ (ws)) madeContainers.push(w.userContextId);
  await store.finalize();
  const again = await tempStore(store.definitions, { agent: "agent", agentPref: pref });
  Assert.deepEqual(
    again.definitions.workspaces,
    store.definitions.workspaces,
    "a second start: no change",
  );
  await again.finalize();
});

add_task(async function a_workspace_already_named_agent_is_adopted_not_duplicated() {
  const pref = "vimma.test.mcp.adopted";
  registerCleanupFunction(() => Services.prefs.clearUserPref(pref));
  const store = await tempStore(
    {
      schema: 1,
      lastActive: null,
      workspaces: [
        {
          id: "ws-mine",
          name: "agent",
          userContextId: null,
          color: "red",
          icon: "circle",
          source: "runtime",
        },
        {
          id: "ws-main",
          name: "main",
          userContextId: null,
          color: "gray",
          icon: "circle",
          source: "runtime",
        },
      ],
    },
    { agent: "agent", agentPref: pref },
  );
  for (const w of /** @type {ContainedWorkspace[]} */ (store.definitions.workspaces))
    madeContainers.push(w.userContextId);
  Assert.deepEqual(
    store.definitions.workspaces.map((/** @type {WorkspaceDefinition} */ w) => w.id),
    ["ws-main", "ws-mine"],
    "the user's agent is kept, last, and no second one is made",
  );
  Assert.equal(/** @type {WorkspaceDefinition} */ (store.agent).color, "red", "with its own looks");
  Assert.ok(!store.agentIsOurs(), "and is known as the user's own");
  Assert.equal(Services.prefs.getStringPref(pref, ""), "", "no id recorded");

  // [mcp] workspace = "bots": bots is ensured; the old agent stays, an ordinary workspace.
  await store.setConfig([], { agent: "bots" });
  for (const w of /** @type {ContainedWorkspace[]} */ (store.definitions.workspaces))
    madeContainers.push(w.userContextId);
  Assert.deepEqual(
    store.definitions.workspaces.map((/** @type {WorkspaceDefinition} */ w) => w.name),
    ["main", "agent", "bots"],
    "bots is appended and is the agent's now",
  );
  Assert.equal(
    /** @type {WorkspaceDefinition} */ (store.agent).name,
    "bots",
    "the store's agent workspace is bots",
  );
  await store.finalize();
});

add_task(async function ctrl_b_paren_cycles_past_agent_and_ctrl_caret_never_lands_on_it() {
  WorkspaceStore.newWorkspace("work");
  await until(
    () =>
      def("work") &&
      ww().model.workspaces.some((/** @type {WorkspaceState} */ w) => w.name === "work"),
    "work",
  );
  Assert.deepEqual(
    ww().model.workspaces.map((/** @type {WorkspaceState} */ w) => w.name),
    ["main", "work", "agent"],
    "a new workspace goes before the agent workspace",
  );
  ww().switchTo({ id: def("main").id });
  await focusPage();
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const was = active();
    prefix(")", { shiftKey: true });
    await until(() => active() !== was, `ctrl+b ) #${i + 1} switches`);
    seen.push(activeName());
    await focusPage();
  }
  Assert.deepEqual(seen, ["work", "main", "work"], "ctrl+b ) three times: never agent");
  prefix("(", { shiftKey: true });
  await until(() => activeName() === "main", "ctrl+b ( from work: main, not agent");

  // main → agent → work: work's alternate is main, never agent.
  ww().switchTo({ id: def("agent").id });
  await until(() => activeName() === "agent", "in agent on purpose");
  ww().switchTo({ id: def("work").id });
  await until(() => activeName() === "work", "then work");
  ww().last();
  await until(() => activeName() === "main", "ctrl+^ from work goes to main");
  // From agent, ctrl+^ goes back to where you came from.
  ww().switchTo({ id: def("agent").id });
  await until(() => activeName() === "agent", "in agent again");
  ww().last();
  await until(() => activeName() === "main", "ctrl+^ from agent goes back to main");
});

add_task(async function the_picker_lists_agent_last_and_enter_switches_to_it() {
  ww().switchTo({ id: def("main").id });
  await focusPage();
  prefix("w");
  await until(() => !!picker()?.open, "ctrl+b w opens the picker");
  const titles = rows().map((r) => cell(r, "title"));
  Assert.deepEqual(
    titles,
    ["main", "work", "◇ agent", "◆ private"],
    "agent last of the normal ones",
  );
  EventUtils.synthesizeKey("/");
  EventUtils.sendString("agent");
  await until(() => rows().length === 1, "its name finds it");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !picker()?.open && activeName() === "agent", "Enter switches to agent");
  await until(
    () =>
      document.getElementById("vimma-statusbar")?.querySelector('[data-segment="workspace"]')
        ?.textContent === "● 3:agent",
    "the bar shows it",
  );
});

add_task(async function closing_agent_empties_it_keeps_its_container_and_cookies() {
  const agent = def("agent");
  ww().switchTo({ id: agent.id });
  await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?a1`);
  await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?a2`);
  await until(() => tabsOf(agent.userContextId).length >= 2, "agent has tabs");
  const tabs = tabsOf(agent.userContextId).length;
  setCookie(agent.userContextId);
  setCookie(def("main").userContextId);

  await focusPage();
  prefix("D", { shiftKey: true });
  await until(promptOpen, "ctrl+b shift+d asks");
  Assert.equal(
    promptText(),
    `Close the ${tabs} tabs of "agent"? It stays, with its cookies and logins (:mcp forget clears them). y/N`,
    "the question says it stays",
  );
  EventUtils.synthesizeKey("y");
  await until(() => tabsOf(agent.userContextId).length === 0, "y closes its tabs");
  Assert.equal(def("agent")?.id, agent.id, "the workspace stays");
  Assert.equal(def("agent").userContextId, agent.userContextId, "with its container");
  Assert.ok(identity(agent.userContextId), "which still exists");
  Assert.equal(cookieCount(agent.userContextId), 1, "and keeps its cookie");

  await runCommand("wsdelete agent");
  await until(() => /has no tabs, and stays/.test(noticeText()), "an empty agent is not deleted");
  Assert.ok(!promptOpen(), "nothing to confirm");
});

add_task(async function renaming_agent_is_refused() {
  ww().switchTo({ id: def("agent").id });
  await until(() => activeName() === "agent", "in agent");
  await runCommand("wsrename robots");
  await until(
    () => noticeText() === "rename workspace: its name is [mcp] workspace in config.toml",
    "the notice says why",
  );
  Assert.ok(def("agent") && !def("robots"), "the name stays");
});

add_task(async function mcp_forget_clears_its_site_data_and_the_workspace_stays() {
  const agent = def("agent");
  Assert.equal(cookieCount(agent.userContextId), 1, "agent has a cookie");
  await runCommand("mcp forget");
  await until(promptOpen, ":mcp forget asks");
  Assert.equal(
    promptText(),
    "Delete the agent workspace's cookies and site data (its logins)? y/N",
    "the question",
  );
  EventUtils.synthesizeKey("n");
  await until(() => !promptOpen(), "n answers no");
  Assert.equal(cookieCount(agent.userContextId), 1, "n deletes nothing");

  await runCommand("mcp forget");
  await until(promptOpen, "asked again");
  const cleared = TestUtils.topicObserved(
    "clear-origin-attributes-data",
    (_s, data) => JSON.parse(/** @type {string} */ (data)).userContextId === agent.userContextId,
  );
  EventUtils.synthesizeKey("y");
  await cleared;
  await until(() => cookieCount(agent.userContextId) === 0, "y clears the cookie");
  Assert.equal(cookieCount(def("main").userContextId), 1, "main's cookie stays");
  Assert.equal(def("agent")?.id, agent.id, "the workspace stays");
  Assert.ok(identity(agent.userContextId), "with its container");
});

add_task(async function mcp_on_asks_off_does_not_and_config_wins() {
  ww().switchTo({ id: def("main").id });
  Services.prefs.clearUserPref(MCP_ENABLED_PREF);
  await runCommand("mcp");
  await until(() => noticeText().startsWith("mcp off"), ":mcp says it is off");

  await runCommand("mcp on");
  await until(promptOpen, ":mcp on asks");
  Assert.equal(
    promptText(),
    'Let local AI agents ask to use the "agent" workspace? Every request asks you first. y/N',
    "the question names the workspace",
  );
  EventUtils.synthesizeKey("n");
  await until(() => !promptOpen(), "n");
  Assert.ok(!Services.prefs.getBoolPref(MCP_ENABLED_PREF, false), "n keeps it off");

  await runCommand("mcp on");
  await until(promptOpen, "asked again");
  EventUtils.synthesizeKey("y");
  await until(() => Services.prefs.getBoolPref(MCP_ENABLED_PREF, false), "y turns it on");
  await until(() => noticeText().startsWith("mcp on"), "and says so");

  await runCommand("mcp off");
  await until(() => !Services.prefs.getBoolPref(MCP_ENABLED_PREF, true), ":mcp off, at once");
  Assert.ok(!promptOpen(), "without a question");

  // `[mcp]` with `enabled` and `workspace` over what is in force (none of it when nothing is):
  // :mcp off reads only `enabled`, the change's observers take a missing field as its default,
  // and the reset below comes before any agent connects or is answered, which would read the
  // rest (AgentGate, AgentDownloads, agent-ui).
  McpHost.configure(
    /** @type {McpConfig} */ ({ ...McpHost.config, enabled: true, workspace: "agent" }),
  );
  await runCommand("mcp off");
  await until(
    () => noticeText() === "mcp: config.toml sets [mcp] enabled = true; change it there",
    "with [mcp] enabled in the file, :mcp off says to edit it",
  );
  Assert.ok(!Services.prefs.getBoolPref(MCP_ENABLED_PREF, false), "and changes nothing");
  McpHost.configure(null);
});

add_task(async function moving_a_tab_into_agent_warns_first() {
  ww().switchTo({ id: def("main").id });
  await BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE}?share`);
  // Its home tab, from the switches into it above.
  const before = tabsOf(def("agent").userContextId).length;
  await runCommand("wsmove agent");
  await until(promptOpen, ":wsmove agent asks");
  Assert.equal(
    promptText(),
    'Move this tab to "agent"? Agents you allow can read it there. It is reopened with the ' +
      "agent's cookies; its history and form data are lost. y/N",
    "the question says agents can read it",
  );
  EventUtils.synthesizeKey("n");
  await until(() => !promptOpen(), "n");
  Assert.equal(tabsOf(def("agent").userContextId).length, before, "n moves nothing");
  await runCommand("wsmove agent");
  await until(promptOpen, "asked again");
  EventUtils.synthesizeKey("y");
  await until(
    () =>
      tabsOf(def("agent").userContextId).some(
        (t) => t.linkedBrowser.currentURI.spec === `${PAGE}?share`,
      ),
    "y reopens it in the agent's container",
  );
  Assert.equal(activeName(), "main", "and the window stays in main");
});
