/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/builtin-agent.md (Behaviour 17, B17, Behaviour 35). The host's side of the
// built-in agent, which it reaches through host/host-services.mjs (ADR-026, issue #936):
// `:agent give` on a tab already in the agent workspace hands it over without a question, and
// never takes it from another conversation; every window's status bar hears of each change to
// the conversations, until the window closes. The chat window (ui/agent-chat.mjs) takes the
// conversations, the agent CLIs, the API keys, config.toml's refusal and its setup write, and
// the [agent] providers from the host that builds it, and reaches none of them itself.

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
const { AgentKeys } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/agent/AgentKeys.sys.mjs",
);
const { AgentChatWindow } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ui/agent-chat.mjs",
);
const { OSKeyStoreTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/OSKeyStoreTestUtils.sys.mjs",
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

/** @param {() => boolean} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);
const notice = () => document.getElementById("vimma-notice")?.textContent ?? "";
/** The window the host built for this browser window. */
const hostChat = () =>
  /** @type {NonNullable<ReturnType<typeof VimmaHost._state>>} */ (VimmaHost._state(window))
    .agentChat;
/** @param {{ view?: "chat" | "models" | "list" }} [opts] */
const openChat = (opts = {}) =>
  new Promise((resolve) => hostChat().open({ ...opts, then: () => resolve(undefined) }));
// `[agent]` without localOnly, keepDays and keepResults, which AgentChat reads as false, null
// and null when they are left out.
const SCRIPTED_ONLY = () =>
  McpHost.configureAgent(
    /** @type {AgentConfig} */ ({ ...AGENT_DEFAULTS, default: "scripted", providers: [PROVIDER] }),
  );

/** Closes the host's chat window and forgets every conversation and the session's choice. */
function tidyChat() {
  hostChat().close();
  for (const c of AgentChat.list()) AgentChat.delete(c.id);
  AgentChat.choose(null);
}

add_setup(async () => {
  OSKeyStoreTestUtils.setup();
  registerCleanupFunction(() => OSKeyStoreTestUtils.cleanup());
  const saved = McpHost.agentConfig;
  McpHost.configureAgent(
    /** @type {AgentConfig} */ ({ ...AGENT_DEFAULTS, default: "scripted", providers: [PROVIDER] }),
  );
  registerCleanupFunction(() => {
    for (const c of AgentChat.list()) AgentChat.delete(c.id);
    McpHost.configureAgent(saved);
  });
});

add_task(async function test_give_hands_over_an_agent_tab_but_never_anothers() {
  const id = AgentChat.create({ provider: PROVIDER }).id;
  const other = AgentChat.create({ provider: PROVIDER }).id;
  const agent = /** @type {any} */ (WorkspaceStore.agent);
  const ww = /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(window));
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
        (/** @type {string} */ text) => said.push(text),
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

add_task(async function test_a_new_conversation_takes_the_agent_default_then_the_sessions_pick() {
  tidyChat();
  const second = { ...PROVIDER, name: "second" };
  McpHost.configureAgent(
    /** @type {AgentConfig} */ ({
      ...AGENT_DEFAULTS,
      default: "second",
      providers: [PROVIDER, second],
    }),
  );
  try {
    await openChat();
    const chat = hostChat();
    Assert.equal(
      AgentChat.get(/** @type {number} */ (chat.conversation)).provider.name,
      "second",
      "the provider [agent] default names, not the first listed (Behaviour 7)",
    );
    AgentChat.choose(PROVIDER);
    chat.newConversation();
    Assert.equal(
      AgentChat.get(/** @type {number} */ (chat.conversation)).provider.name,
      "scripted",
      "the model picked this session comes before [agent] default",
    );
  } finally {
    tidyChat();
    SCRIPTED_ONLY();
  }
});

add_task(async function test_the_picker_offers_agent_clis_only_while_they_are_on() {
  tidyChat();
  const offersCli = () =>
    hostChat().rows.some((/** @type {{ label: string }} */ r) =>
      r.label.startsWith("add: agent CLI"),
    );
  await SpecialPowers.pushPrefEnv({ set: [["vimma.agent.cli.enabled", false]] });
  try {
    await openChat({ view: "models" });
    Assert.ok(
      hostChat().rows.some((/** @type {{ label: string }} */ r) => r.label.startsWith("scripted")),
      "the picker lists the configured provider",
    );
    Assert.ok(!offersCli(), "but no agent CLI while vimma.agent.cli.enabled is false");
    hostChat().close();
    await SpecialPowers.pushPrefEnv({ set: [["vimma.agent.cli.enabled", true]] });
    await openChat({ view: "models" });
    Assert.ok(offersCli(), "and one once it is true");
  } finally {
    tidyChat();
    await SpecialPowers.popPrefEnv();
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_the_picker_shows_a_keys_end_and_x_deletes_it_after_y() {
  tidyChat();
  /** @type {AgentProviderConfig} */
  const hosted = {
    name: "hosted",
    kind: "openai",
    endpoint: "https://example.com/v1",
    model: "big",
    vision: false,
  };
  await AgentKeys.set(hosted.name, "sk-test-0000a1b2", hosted.endpoint);
  McpHost.configureAgent(
    /** @type {AgentConfig} */ ({
      ...AGENT_DEFAULTS,
      default: "scripted",
      providers: [PROVIDER, hosted],
    }),
  );
  const row = () =>
    hostChat().rows.findIndex(
      (/** @type {{ provider?: { name: string } }} */ r) => r.provider?.name === "hosted",
    );
  try {
    await openChat({ view: "models" });
    await until(
      () => hostChat().rows[row()]?.detail === "key stored · ends …a1b2",
      "the row shows the stored key's last four characters only (Behaviour 3, M46)",
    );
    hostChat().row = row();
    hostChat().deleteKey();
    const rename = () => document.getElementById("vimma-rename");
    await until(() => !!rename() && !rename()?.hidden, "x asks first");
    Assert.equal(
      rename()?.textContent?.trim(),
      "Delete the API key of hosted? y/N",
      "naming the provider",
    );
    EventUtils.synthesizeKey("y");
    await until(() => notice() === "agent: deleted the key of hosted", "y deletes it");
    Assert.equal(await AgentKeys.hint(hosted.name, hosted.endpoint), null, "no key is stored");
    await until(
      () => hostChat().rows[row()]?.detail === "no key · Enter adds one",
      "and the picker says so",
    );
  } finally {
    tidyChat();
    await AgentKeys.delete(hosted.name);
    SCRIPTED_ONLY();
  }
});

add_task(async function test_the_window_uses_the_services_the_host_hands_it() {
  // A window built with services of the test's own: everything it says comes from them, and
  // from no module it would reach by itself.
  McpHost.configureAgent(
    /** @type {AgentConfig} */ ({
      ...AGENT_DEFAULTS,
      default: /** @type {string | null} */ (null),
      providers: /** @type {AgentProviderConfig[]} */ ([]),
    }),
  );
  // A file of its own, in case a write went past the services to config.toml.
  const file = PathUtils.join(PathUtils.tempDir, "vimma-agent-chat-services.toml");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.agent.cli.enabled", false],
      ["vimma.config.path", file],
    ],
  });
  /** @type {AgentProviderConfig} */
  const hosted = {
    name: "fake-hosted",
    kind: "openai",
    endpoint: "https://example.com/v1",
    model: "big",
    vision: false,
  };
  /** @type {string[]} */
  const calls = [];
  /** @type {[string, boolean][]} */
  const said = [];
  const services = {
    chat: {
      chosen: null,
      probe: async () => [],
      modelStates: async () => new Map(),
    },
    cli: {
      enabled: true,
      find: async () => [],
      noneFound: () => "the test's CLIs are none",
    },
    keys: {
      hint: async (/** @type {string} */ name) => {
        calls.push(`hint ${name}`);
        return "key stored · ends …fake";
      },
      delete: async (/** @type {string} */ name) => {
        calls.push(`delete ${name}`);
        return true;
      },
    },
    configRefused: () => ({
      errors: [{ line: 3, path: "agent", message: "refused by the test" }],
      file: "fake.toml",
    }),
    addAgentProvider: async (
      /** @type {{ name: string }} */ provider,
      /** @type {{ makeDefault: boolean }} */ opts,
    ) => {
      calls.push(`add ${provider.name} ${opts.makeDefault}`);
      return { error: "the test keeps config.toml" };
    },
    agentConfig: () => ({ ...AGENT_DEFAULTS, default: null, providers: [hosted] }),
  };
  const host = {
    ask: (/** @type {string} */ _question, /** @type {() => void} */ yes) => yes(),
    say: (/** @type {string} */ text, /** @type {boolean | undefined} */ error) =>
      said.push([text, !!error]),
    give() {},
    copy() {},
    rearm() {},
    prompt() {},
    changed() {},
  };
  const chat = new AgentChatWindow(window, host, /** @type {any} */ (services));
  try {
    services.agentConfig = () => ({ ...AGENT_DEFAULTS, default: null, providers: [] });
    chat.newConversation();
    Assert.deepEqual(
      said.pop(),
      ["agent: no model: fake.toml:3: agent: refused by the test", true],
      "no model, named by the host's config.toml refusal",
    );

    Assert.equal(
      await chat.remember(hosted),
      "; not saved to config.toml (the test keeps config.toml)",
      "setup writes through the host's addAgentProvider",
    );
    Assert.deepEqual(calls.splice(0), ["add fake-hosted true"], "as [agent] default");

    services.agentConfig = () => ({ ...AGENT_DEFAULTS, default: null, providers: [hosted] });
    chat.rows = [{ label: "fake-hosted · big", detail: "", provider: hosted }];
    chat.row = 0;
    chat.deleteKey();
    await until(() => said.length > 0, "x deleted the key");
    Assert.deepEqual(
      said.pop(),
      ["agent: deleted the key of fake-hosted", false],
      "through the host's keys",
    );
    Assert.deepEqual(calls.splice(0), ["delete fake-hosted"], "for that provider");

    // The picker, as if open, with no box drawn: setup's CLIs and the providers' keys.
    chat.opened = true;
    chat.view = "models";
    chat.findClis();
    await until(() => said.length > 0, "the CLIs were looked for");
    Assert.deepEqual(
      said.pop(),
      ["agent: the test's CLIs are none", true],
      "by the host's AgentCli",
    );
    Assert.ok(
      chat.rows.some((/** @type {{ label: string }} */ r) => r.label.startsWith("add: agent CLI")),
      "which says they are on",
    );
    await until(
      () => chat.rows.find((r) => r.provider === hosted)?.detail === "key stored · ends …fake",
      "the provider's key comes from the host's keys",
    );
  } finally {
    chat.opened = false;
    chat.destroy();
    await SpecialPowers.popPrefEnv();
    Assert.ok(!(await IOUtils.exists(file)), "config.toml was not written");
    await IOUtils.remove(file, { ignoreAbsent: true });
    SCRIPTED_ONLY();
  }
});
