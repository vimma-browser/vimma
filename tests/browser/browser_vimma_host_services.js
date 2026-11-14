/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// ADR-026 decision 4, issue #936: the host runs a few commands of higher folders (the built-in
// agent's conversations, the agent-download test, `:route add`'s write to config.toml) through
// host/host-services.mjs, which vimma.js fills before the first window's host starts. Only
// vimma.js may fill it, once per service, and nothing swaps a service afterwards; a service
// asked for before it is provided gives the answer that does the least (docs/security.md M11).

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

/** This file, which the tests' own registries take as the one caller that may fill them. */
const HERE = Components.stack.filename;
const ALL = ["agentChat", "isAgentDownload", "addRoute"];

add_task(async function test_vimma_js_provided_every_service_before_the_window_started() {
  Assert.deepEqual(HostServices.missing(), [], "every service is provided");
  Assert.equal(HostServices.agentChat, AgentChat, "the conversations are AgentChat's");
  Assert.equal(
    HostServices.isAgentDownload,
    AgentDownloads.isAgentDownload,
    "the agent-download test is AgentDownloads'",
  );
  Assert.equal(HostServices.addRoute, ConfigHost.addRoute, ":route add writes through ConfigHost");
  // Each window runs vimma.js, which hands over the same services again.
  const second = await BrowserTestUtils.openNewBrowserWindow();
  Assert.deepEqual(HostServices.missing(), [], "a second window changes nothing");
  Assert.equal(HostServices.agentChat, AgentChat, "the same conversations");
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
  Assert.deepEqual(services.missing(), ["agentChat", "addRoute"], "provides none of them");
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
  Assert.deepEqual(services.missing(), ["agentChat", "addRoute"], "and none of them is provided");
});
