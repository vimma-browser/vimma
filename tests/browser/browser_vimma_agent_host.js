/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/builtin-agent.md (Behaviour 17, B17, Behaviour 35). The host's side of the
// built-in agent, which it reaches through host/host-services.mjs (ADR-026, issue #936):
// `:agent give` on a tab already in the agent workspace hands it over without a question, and
// never takes it from another conversation; every window's status bar hears of each change to
// the conversations, until the window closes.

"use strict";

/* global PROVIDER -- from head_vimma_agent_model.js */
/* global add_setup -- the harness */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_vimma_agent_model.js",
  this,
);

const { AgentChat } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/agent/AgentChat.sys.mjs",
);
const { giveSelectedTab } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/agent-chat-ops.mjs",
);
const { McpHost } = ChromeUtils.importESModule("chrome://browser/content/vimma/host/mcp-ops.mjs");
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { AGENT_DEFAULTS } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/config.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);

const PAGE = `${getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
)}file_vimma_agent_page.html`;

add_setup(async () => {
  const saved = McpHost.agentConfig;
  McpHost.configureAgent({ ...AGENT_DEFAULTS, default: "scripted", providers: [PROVIDER] });
  registerCleanupFunction(() => {
    for (const c of AgentChat.list()) AgentChat.delete(c.id);
    McpHost.configureAgent(saved);
  });
});

add_task(async function test_give_hands_over_an_agent_tab_but_never_anothers() {
  const id = AgentChat.create({ provider: PROVIDER }).id;
  const other = AgentChat.create({ provider: PROVIDER }).id;
  const agent = /** @type {any} */ (WorkspaceStore.agent);
  const ww = WindowWorkspaces.get(window);
  const home = ww.model.active;
  ww.switchTo({ id: agent.id });
  try {
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
    Assert.equal(tab.userContextId, agent.userContextId, "a tab of the agent workspace");
    /** @type {string[]} */
    const said = [];
    const give = (/** @type {number} */ to) =>
      giveSelectedTab(
        window,
        to,
        () => Assert.ok(false, "a tab already in the agent workspace is given without a question"),
        (text) => said.push(text),
      );
    give(id);
    Assert.equal(AgentChat.ownerOf(tab), id, "it is the conversation's (Behaviour 17)");
    Assert.deepEqual(said, [], "with nothing to say");
    give(id);
    Assert.deepEqual(said, ["agent: that tab is this conversation's already"], "given twice");
    give(other);
    Assert.equal(said[1], "agent: that tab is another conversation's", "never another's (B17)");
    Assert.equal(AgentChat.ownerOf(tab), id, "it stays the first conversation's");
  } finally {
    ww.switchTo({ id: home });
    // The agent workspace opened its own first tab too.
    for (const t of gBrowser.tabs.filter((x) => x.userContextId === agent.userContextId)) {
      BrowserTestUtils.removeTab(t);
    }
    for (const c of AgentChat.list()) AgentChat.delete(c.id);
  }
});

add_task(async function test_each_windows_status_bar_follows_the_conversations_until_it_closes() {
  const id = AgentChat.create({ provider: PROVIDER }).id;
  const second = await BrowserTestUtils.openNewBrowserWindow();
  /** @type {Set<Window>} */
  const told = new Set();
  const emit = VimmaHost._emit;
  VimmaHost._emit = function (/** @type {any} */ state) {
    told.add(state.win);
    return emit.call(this, state);
  };
  try {
    AgentChat.clear(id);
    Assert.ok(told.has(window) && told.has(second), "every window hears of a change");
    await BrowserTestUtils.closeWindow(second);
    told.clear();
    AgentChat.clear(id);
    Assert.ok(told.has(window), "an open window still does");
    Assert.ok(!told.has(second), "a closed one no longer does");
  } finally {
    VimmaHost._emit = emit;
    AgentChat.delete(id);
  }
});
