/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// ADR-026 decision 4, issue #936: the host runs a few commands of higher folders (the built-in
// agent's conversations, the agent-download test, `:route add`'s write to config.toml) through
// host/host-services.mjs, which vimma.js fills before the first window's host starts, and hands
// the agent chat window it builds the rest of what that window uses (the agent CLIs, the API
// keys, config.toml's refusal and setup's write to it). Only vimma.js may fill it, once per
// service, and nothing swaps a service afterwards; a service asked for before it is provided
// gives the answer that does the least (docs/security/ M11, M46), and the keys' service hands
// out no key.

"use strict";

/* global Components -- the test's own frame, which its registries take as their provider */

const { HostServices, createHostServices } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/host-services.mjs",
);
const { AgentChat } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/agent/AgentChat.sys.mjs",
);
const { AgentDownloads } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentDownloads.sys.mjs",
);
const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);
const { AgentCli } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/agent/AgentCli.sys.mjs",
);
const { AgentKeys } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/agent/AgentKeys.sys.mjs",
);
const { OSKeyStoreTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/OSKeyStoreTestUtils.sys.mjs",
);

/** This file, which the tests' own registries take as the one caller that may fill them. */
const HERE = Components.stack.filename;
/** @type {HostServiceName[]} */
const ALL = [
  "agentChat",
  "isAgentDownload",
  "addRoute",
  "agentCli",
  "agentKeys",
  "configRefused",
  "addAgentProvider",
];

/** Keys of the services' fakes, shaped as the registry asks. */
const FAKES = {
  agentCli: { enabled: true, find: async () => [], noneFound: () => "", use() {} },
  agentKeys: {
    hint: async () => "key stored · ends …fake",
    set: async () => {},
    delete: async () => true,
  },
  configRefused: () => ({ errors: [], file: "config.toml" }),
  addAgentProvider: async () => ({ name: "fake" }),
};

/**
 * Whether `served` is `original` narrowed: a frozen object whose every member is one of the
 * original's, read through (a property) or called through (a method).
 * @param {object} served @param {object} original
 */
function servesThrough(served, original) {
  return (
    served !== original &&
    Object.isFrozen(served) &&
    Object.keys(served).every((name) => name in original)
  );
}

add_task(async function test_vimma_js_provided_every_service_before_the_window_started() {
  Assert.deepEqual(HostServices.missing(), [], "every service is provided");
  Assert.ok(servesThrough(HostServices.agentChat, AgentChat), "the conversations are AgentChat's");
  Assert.equal(
    HostServices.isAgentDownload,
    AgentDownloads.isAgentDownload,
    "the agent-download test is AgentDownloads'",
  );
  Assert.equal(HostServices.addRoute, ConfigHost.addRoute, ":route add writes through ConfigHost");
  Assert.ok(servesThrough(HostServices.agentCli, AgentCli), "the window's agent CLIs are AgentCli");
  Assert.equal(
    HostServices.configRefused,
    ConfigHost.refused,
    "config.toml's refusal is ConfigHost's",
  );
  Assert.equal(
    HostServices.addAgentProvider,
    ConfigHost.addAgentProvider,
    "setup writes [[agent.providers]] through ConfigHost",
  );
  // Each window runs vimma.js, which hands over the same services again.
  const second = await BrowserTestUtils.openNewBrowserWindow();
  Assert.deepEqual(HostServices.missing(), [], "a second window changes nothing");
  Assert.ok(servesThrough(HostServices.agentChat, AgentChat), "the same conversations");
  await BrowserTestUtils.closeWindow(second);
});

add_task(function test_only_vimma_js_provides_and_nothing_swaps_a_service() {
  const mine = () => false;
  Assert.throws(
    () => HostServices.provide({ isAgentDownload: mine }),
    /only chrome:\/\/browser\/content\/vimma\/vimma\.js provides/,
    "another module cannot provide a service",
  );
  Assert.throws(
    () => {
      /** @type {any} */ (HostServices).isAgentDownload = mine;
    },
    TypeError,
    "nor assign one",
  );
  Assert.equal(
    HostServices.isAgentDownload,
    AgentDownloads.isAgentDownload,
    "the agent-download test is still AgentDownloads'",
  );
});

add_task(function test_code_named_vimma_js_still_cannot_replace_a_service() {
  // The caller check reads a file name, which code already running with the system principal can
  // choose: it catches mistakes. What holds against such code is that a service, once provided,
  // is never replaced.
  const sandbox = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal());
  sandbox.HostServices = HostServices;
  sandbox.same = AgentDownloads.isAgentDownload;
  const run = (/** @type {string} */ code) =>
    Cu.evalInSandbox(code, sandbox, "latest", "chrome://browser/content/vimma/vimma.js", 1);
  run("HostServices.provide({ isAgentDownload: same });");
  Assert.ok(true, "code named vimma.js passes the caller check");
  Assert.throws(
    () => run("HostServices.provide({ isAgentDownload: () => false });"),
    /isAgentDownload is already provided/,
    "but cannot hand over another agent-download test",
  );
  Assert.equal(
    HostServices.isAgentDownload,
    AgentDownloads.isAgentDownload,
    "the picker's test is still AgentDownloads'",
  );
});

add_task(async function test_the_keys_service_is_agentkeys_without_a_way_to_read_a_key() {
  OSKeyStoreTestUtils.setup();
  const keys = HostServices.agentKeys;
  const endpoint = "https://example.com/v1";
  try {
    Assert.deepEqual(
      Object.keys(keys),
      ["hint", "set", "delete"],
      "the chat window's three: a stored key's last four characters, store, delete (M46)",
    );
    Assert.ok(!("get" in keys), "never AgentKeys.get, which returns the key itself (M40)");
    Assert.ok(Object.isFrozen(keys), "and nothing can add it");
    await keys.set("host-services-test", "sk-test-0000wxyz", endpoint);
    Assert.equal(
      await AgentKeys.hint("host-services-test", endpoint),
      "key stored · ends …wxyz",
      "set stores the key through AgentKeys",
    );
    Assert.equal(
      await keys.hint("host-services-test", endpoint),
      "key stored · ends …wxyz",
      "hint reads its end through AgentKeys",
    );
    Assert.equal(await keys.delete("host-services-test"), true, "delete removes it");
    Assert.equal(await AgentKeys.has("host-services-test"), false, "from login storage");
  } finally {
    await AgentKeys.delete("host-services-test");
    OSKeyStoreTestUtils.cleanup();
  }
});

add_task(async function test_the_cli_service_is_agentcli_without_a_way_to_start_one() {
  const cli = HostServices.agentCli;
  Assert.deepEqual(
    Object.keys(cli).sort(),
    ["enabled", "find", "noneFound", "use"],
    "setup's four: whether CLIs are on, the PATH search, why none, the picked path",
  );
  for (const name of ["start", "init", "sweepGemini", "version", "check", "availability"]) {
    Assert.ok(!(name in cli), `never AgentCli.${name}`);
  }
  Assert.ok(Object.isFrozen(cli), "and nothing can add one");
  await SpecialPowers.pushPrefEnv({ set: [["vimma.agent.cli.enabled", false]] });
  try {
    Assert.equal(cli.enabled, false, "enabled follows the pref");
    Assert.deepEqual(await cli.find(), [], "find runs AgentCli's, which looks for none when off");
    Assert.throws(
      () => cli.use("claude", "/usr/bin/claude"),
      /agent CLIs are turned off/,
      "use runs AgentCli's",
    );
    await SpecialPowers.pushPrefEnv({ set: [["vimma.agent.cli.enabled", true]] });
    Assert.equal(cli.enabled, true, "read when asked, not when provided");
    await SpecialPowers.popPrefEnv();
  } finally {
    await SpecialPowers.popPrefEnv();
  }
  Assert.equal(cli.noneFound(), AgentCli.noneFound(), "noneFound is AgentCli's");
});

add_task(function test_the_conversations_service_is_agentchat_without_tickets_or_reset() {
  const chat = HostServices.agentChat;
  Assert.ok(Object.isFrozen(chat), "frozen");
  for (const name of ["issueTicket", "reset", "prune", "flush", "done", "running", "choices"]) {
    Assert.ok(
      !(name in chat),
      `never AgentChat.${name}, which neither the host nor the window uses`,
    );
  }
  // No model: chosen is only read back, never sent to.
  const provider = /** @type {AgentProviderConfig} */ ({
    name: "host-services-chosen",
    kind: "openai",
    endpoint: "",
    vision: false,
  });
  try {
    AgentChat.choose(provider);
    Assert.equal(chat.chosen, provider, "chosen is read when asked");
    Assert.equal(chat.restored, AgentChat.restored, "and so is restored");
  } finally {
    AgentChat.choose(null);
  }
  Assert.equal(chat.chosen, null, "it follows AgentChat");
});

add_task(function test_code_named_vimma_js_cannot_replace_the_chat_windows_services() {
  const sandbox = Cu.Sandbox(Services.scriptSecurityManager.getSystemPrincipal());
  sandbox.HostServices = HostServices;
  sandbox.fakes = FAKES;
  for (const name of ["agentCli", "agentKeys", "configRefused", "addAgentProvider"]) {
    Assert.throws(
      () =>
        Cu.evalInSandbox(
          `HostServices.provide({ ${name}: fakes.${name} });`,
          sandbox,
          "latest",
          "chrome://browser/content/vimma/vimma.js",
          1,
        ),
      new RegExp(`${name} is already provided`),
      `code named vimma.js cannot hand over another ${name}`,
    );
  }
  Assert.ok(servesThrough(HostServices.agentCli, AgentCli), "the agent CLIs are still AgentCli");
  Assert.equal(HostServices.configRefused, ConfigHost.refused, "the refusal still ConfigHost's");
  Assert.equal(
    HostServices.addAgentProvider,
    ConfigHost.addAgentProvider,
    "setup still writes through ConfigHost",
  );
  Assert.deepEqual(Object.keys(HostServices.agentKeys), ["hint", "set", "delete"], "same keys");
});

add_task(async function test_before_it_is_provided_each_service_does_the_least() {
  const services = createHostServices(HERE);
  Assert.deepEqual(services.missing(), ALL, "a new registry holds nothing");

  const users = {
    source: { url: "https://example.com/a.bin", userContextId: 0 },
    target: { path: PathUtils.join(PathUtils.tempDir, "a.bin") },
  };
  Assert.equal(AgentDownloads.isAgentDownload(users), false, "AgentDownloads calls it the user's");
  Assert.equal(
    services.isAgentDownload(users),
    true,
    "unprovided, every download counts as an agent's: the picker opens, retries, unblocks " +
      "and follows none (M11)",
  );

  const chat = services.agentChat;
  Assert.deepEqual(chat.list(), [], "no conversations, so the status bar shows none running");
  Assert.equal(chat.ownerOf(gBrowser.selectedTab), null, "no tab is a conversation's");
  // Nothing runs, so ctrl+b shift+a goes on to end the grants.
  chat.stopAll();
  chat.addListener(() => {});
  chat.removeListener(() => {});
  Assert.throws(
    () => chat.give(1, gBrowser.selectedTab, "a tab"),
    /the built-in agent is not started/,
    "no tab is given",
  );

  Assert.equal(
    await services.addRoute({ domain: "example.org", workspace: "main" }),
    "config.toml cannot be written before Vimma has started",
    ":route add writes nothing and says why",
  );

  // The chat window's part of the conversations: none to open, so it creates, sends, switches
  // and confirms nothing, and every send would first show where data goes.
  Assert.equal(chat.restored, true, "nothing to restore, so the window never waits for it");
  Assert.equal(chat.chosen, null, "no model picked this session");
  await chat.restore();
  for (const call of [
    () => chat.get(1),
    // No model: the call refuses before it reads the provider.
    () =>
      chat.create({
        provider: /** @type {AgentProviderConfig} */ ({
          name: "p",
          kind: "openai",
          endpoint: "",
          vision: false,
        }),
      }),
    () => chat.transcript(1),
  ]) {
    Assert.throws(call, /the built-in agent is not started/, "no conversation to read or make");
  }
  await Assert.rejects(
    chat.send(1, "a task", { ask: false }),
    /the built-in agent is not started/,
    "none sent",
  );
  await Assert.rejects(
    chat.prepareLocal("http://127.0.0.1:11434/v1", "m"),
    /the built-in agent is not started/,
    "no local model prepared",
  );
  Assert.equal(chat.clear(1), "the built-in agent is not started", "nothing cleared");
  Assert.equal(
    // No model: the call refuses before it reads the provider.
    chat.setProvider(
      1,
      /** @type {AgentProviderConfig} */ ({
        name: "p",
        kind: "openai",
        endpoint: "",
        vision: false,
      }),
    ),
    "the built-in agent is not started",
    "no model switched",
  );
  Assert.equal(chat.needsNotice(1), true, "a send would first say where data goes (M45)");
  Assert.deepEqual(await chat.probe({}), [], "no local server is asked");
  Assert.equal((await chat.modelStates([])).size, 0, "no model checked");
  Assert.equal(await chat.placeLocal("http://127.0.0.1:11434/v1", "m"), null, "nothing loaded");
  chat.stop(1);
  chat.confirm(1, "example.com");
  chat.choose(null);
  await chat.delete(1);
  await chat.forgetAll();

  const cli = services.agentCli;
  Assert.equal(cli.enabled, false, "no agent CLI is offered");
  Assert.deepEqual(await cli.find(), [], "none is looked for");
  Assert.equal(
    cli.noneFound(),
    "agent CLIs are not available before Vimma has started",
    "and the window says why",
  );
  Assert.throws(
    () => cli.use("claude", "/usr/bin/claude"),
    /the built-in agent is not started/,
    "no CLI's path is kept",
  );

  const keys = services.agentKeys;
  Assert.equal(await keys.hint("p", "https://example.com/v1"), null, "no key is known (M46)");
  await Assert.rejects(
    keys.set("p", "sk-test-0000abcd", "https://example.com/v1"),
    /no key can be stored before Vimma has started/,
    "and none is stored",
  );
  Assert.equal(await keys.delete("p"), false, "nor deleted");

  const refused = services.configRefused();
  Assert.equal(refused.file, "config.toml", "the refusal is about config.toml");
  Assert.deepEqual(
    refused.errors.map((/** @type {{ message: string }} */ e) => e.message),
    ["not read yet: Vimma has not started"],
    "which counts as refused, so the window offers no setup and names no [agent] provider",
  );
  Assert.deepEqual(
    await services.addAgentProvider(
      { name: "p", kind: "openai", endpoint: "https://example.com/v1", model: "m", vision: false },
      { makeDefault: true },
    ),
    { error: "config.toml cannot be written before Vimma has started" },
    "setup writes nothing to config.toml",
  );
});

add_task(function test_each_service_is_provided_once() {
  const services = createHostServices(HERE);
  const first = () => true;
  const second = () => false;
  services.provide({ isAgentDownload: first });
  services.provide({ isAgentDownload: first });
  Assert.equal(services.isAgentDownload, first, "the same service again changes nothing");
  Assert.throws(
    () => services.provide({ isAgentDownload: second }),
    /isAgentDownload is already provided/,
    "another one for it is refused",
  );
  Assert.equal(services.isAgentDownload, first, "and the first stays");
  Assert.throws(
    () => services.provide({ addRoute: async () => null, isAgentDownload: second }),
    /already provided/,
    "a call with one refused service",
  );
  Assert.deepEqual(
    services.missing(),
    ALL.filter((name) => name !== "isAgentDownload"),
    "provides none of them",
  );
  Assert.throws(
    () => services.provide(/** @type {any} */ ({ openTab: first })),
    /no service openTab/,
    "a service the host does not run is refused",
  );
  Assert.throws(
    () => services.provide(/** @type {any} */ ({ addRoute: "config.toml" })),
    /addRoute must be a function/,
    "so is a value of the wrong shape",
  );
  Assert.throws(
    () => services.provide(/** @type {any} */ ({ agentChat: { list: () => [] } })),
    /agentChat must have addListener/,
    "a part of the conversations is not enough",
  );
  Assert.throws(
    () => services.provide(/** @type {any} */ ({ agentKeys: { hint: FAKES.agentKeys.hint } })),
    /agentKeys must have set, delete/,
    "nor a part of the keys",
  );
  Assert.throws(
    () =>
      services.provide(/** @type {any} */ ({ agentCli: { find() {}, noneFound() {}, use() {} } })),
    /agentCli must have enabled/,
    "and the agent CLIs need their switch",
  );
  Assert.deepEqual(
    services.missing(),
    ALL.filter((name) => name !== "isAgentDownload"),
    "and none of them is provided",
  );
  // Each member the unprovided services have is one a provided service must have: the two are
  // one list, so a member added to the type and its default is asked for at provide.
  for (const name of /** @type {const} */ (["agentChat", "agentCli", "agentKeys"])) {
    const whole = /** @type {Record<string, unknown>} */ ({ ...services[name] });
    for (const member of Object.keys(whole)) {
      const rest = { ...whole };
      delete rest[member];
      Assert.throws(
        () => services.provide(/** @type {any} */ ({ [name]: rest })),
        new RegExp(`${name} must have ${member}$`),
        `${name} without ${member} is refused`,
      );
    }
  }
  services.provide({ agentKeys: FAKES.agentKeys });
  services.provide({ agentKeys: FAKES.agentKeys });
  Assert.notEqual(services.agentKeys, FAKES.agentKeys, "the keys come out narrowed");
  Assert.equal(services.agentKeys, services.agentKeys, "the same narrowed keys each time");
  Assert.throws(
    () => services.provide({ agentKeys: { ...FAKES.agentKeys } }),
    /agentKeys is already provided/,
    "other keys are refused",
  );
});
