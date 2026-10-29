/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/builtin-agent.md, delivery 3 (B4, B5, B11, B17, B18). The built-in agent's
// conversations run in the browser's process through the agent commands and AgentGate, each on
// a connection of its own (`builtin:<n>`), with MCP off. Sending a task with `Enter` is the
// conversation's grant, with no question and no expiry; `ctrl+Enter` (`ask`) asks every step;
// checkpoints and vimma_show ask under the grant. A conversation sees and acts only on its own
// tabs and is refused another's as a tab outside the agent workspace; an MCP agent sees only the
// tabs no conversation owns; a client that calls itself built-in over MCP is shown with (mcp).
// At most `[agent] max_running` tasks run at once, and `ctrl+b shift+a` stops them all. Model
// requests go only to the endpoint, with no cookies and no redirects. The model is a scripted
// OpenAI-compatible server on 127.0.0.1 in this process.

"use strict";

/* global Client, tidyTask -- from head_vimma_control.js */
/* global requests, held, PORT, PROVIDER, script, openStep -- from head_vimma_agent_model.js */
/* global add_setup -- the browser-chrome harness (browser-test.js) */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_vimma_agent_model.js",
  this,
);

const { AgentChat, FEATURE_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/agent/AgentChat.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentGate.sys.mjs",
);
const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { MCP_ENABLED_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/mcp-ops.mjs",
);
const { AgentUi } = ChromeUtils.importESModule("chrome://browser/content/vimma/host/agent-ui.mjs");
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { OSKeyStoreTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/OSKeyStoreTestUtils.sys.mjs",
);

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = `${DIR}file_vimma_agent_page.html`;
const CLICK = `${DIR}file_vimma_agent_click.html`;
const ASK_TIMEOUT = "vimma.mcp.askTimeoutMs";

/** @param {() => boolean} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);
const agent = () => /** @type {any} */ (WorkspaceStore.agent);
const agentTabs = () =>
  gBrowser.tabs.filter((t) => t.userContextId === agent().userContextId && !t.closing);
const idOf = (/** @type {any} */ tab) => String(tab.linkedBrowser.browserId);

/** The text of a task's tool results, in order. @param {any} result */
const toolTexts = (result) =>
  result.messages
    .filter((/** @type {any} */ m) => m.role === "tool")
    .flatMap((/** @type {any} */ m) => m.results)
    .map((/** @type {any} */ r) => r.content.map((/** @type {any} */ c) => c.text).join("\n"));

async function tidy() {
  AgentChat.stopAll();
  for (const c of AgentChat.list()) AgentChat.delete(c.id);
  for (const q of AgentGate.waiting) AgentGate.answer(q.id, { kind: "deny" });
  AgentGate.revoke();
  // vimma_show switches to the agent workspace: back to main before its tabs go.
  const ww = WindowWorkspaces.get(window);
  ww.switchTo({ id: ww.model.workspaces.find((/** @type {any} */ w) => w.name === "main")?.id });
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  for (const t of gBrowser.tabs.slice(1)) BrowserTestUtils.removeTab(t);
  Services.prefs.clearUserPref(MCP_ENABLED_PREF);
  await VimmaControl.settled();
  requests.length = 0;
}

/** @param {() => Promise<void>} task */
const addTidyTask = (task) => add_task(tidyTask(task, tidy));

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [
      [FEATURE_PREF, true],
      [ASK_TIMEOUT, 20000],
    ],
  });
  // Conversations are stored, encrypted with OSKeyStore: under a test label, never the user's.
  OSKeyStoreTestUtils.setup();
  registerCleanupFunction(() => OSKeyStoreTestUtils.cleanup());
});

/** The oldest waiting question, once there is one. */
async function question() {
  await until(() => AgentGate.waiting.length > 0, "a question waits");
  return AgentGate.waiting[0];
}

add_task(async function test_nothing_without_the_feature_pref() {
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE_PREF, false]] });
  Assert.throws(
    () => AgentChat.create({ provider: PROVIDER }),
    /vimma\.feature\.agentChat/,
    "no conversation while the built-in agent is unfinished and off",
  );
  await SpecialPowers.popPrefEnv();
});

addTidyTask(async function test_works_with_mcp_off_and_enter_grants_without_a_question() {
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, false);
  await VimmaControl.settled();
  Assert.equal(VimmaControl.port, null, "MCP off: no control socket");
  const c = AgentChat.create({ provider: PROVIDER });
  Assert.equal(c.conn, `builtin:${c.id}`, "a connection of its own, in this process");
  let asked = 0;
  const onGate = (/** @type {any} */ e) => {
    if (e?.kind === "asked") asked++;
  };
  AgentGate.addListener(onGate);
  const sent = await AgentChat.send(c.id, script([openStep(PAGE), { reply: "Opened it." }]));
  Assert.deepEqual(sent, { started: true }, "the task starts");
  const result = await AgentChat.done(c.id);
  AgentGate.removeListener(onGate);
  Assert.equal(result.outcome, "done", "the task ran to its reply");
  Assert.equal(result.reply, "Opened it.", "the model's reply");
  Assert.equal(asked, 0, "sending with Enter asked nothing");
  const grant = AgentGate.grants().find((g) => g.conn === c.conn);
  Assert.equal(grant?.until, Infinity, "the conversation's grant has no expiry (B18)");
  Assert.equal(agentTabs().length, 1, "the page opened in the agent workspace");
  const row = AgentGate.log[0];
  Assert.equal(row.client, `built-in · ${AgentChat.get(c.id).title}`, ":mcp log names it");
  Assert.equal(row.outcome, "grant", "and its step ran under the grant");
  Assert.ok(AgentChat.get(c.id).title.startsWith("SCRIPT:"), "titled by its first line");
});

addTidyTask(async function test_ctrl_enter_asks_every_step_and_ends_the_grant() {
  const c = AgentChat.create({ provider: PROVIDER });
  await AgentChat.send(c.id, script([{ reply: "hi" }]));
  await AgentChat.done(c.id);
  Assert.ok(
    AgentGate.grants().some((g) => g.conn === c.conn),
    "Enter granted the conversation",
  );
  await AgentChat.send(c.id, script([openStep(PAGE), openStep(`${PAGE}?2`), { reply: "two" }]), {
    ask: true,
  });
  Assert.ok(
    !AgentGate.grants().some((g) => g.conn === c.conn),
    "ctrl+Enter ended the standing grant (Behaviour 25)",
  );
  let q = await question();
  Assert.equal(q.conn, c.conn, "the step asks");
  Assert.equal(
    q.label.client,
    `built-in · ${AgentChat.get(c.id).title}`,
    "naming the conversation",
  );
  AgentGate.answer(q.id, { kind: "once" });
  await until(() => AgentGate.waiting.some((w) => w.id !== q.id), "the next step asks too");
  q = AgentGate.waiting[0];
  AgentGate.answer(q.id, { kind: "once" });
  const result = await AgentChat.done(c.id);
  Assert.equal(result.outcome, "done", "both steps ran on yes");
});

addTidyTask(async function test_grant_covers_later_tasks_until_stopped() {
  const c = AgentChat.create({ provider: PROVIDER });
  await AgentChat.send(c.id, script([openStep(PAGE), { reply: "one" }]));
  await AgentChat.done(c.id);
  await AgentChat.send(c.id, script([openStep(`${PAGE}?again`), { reply: "two" }]));
  const second = await AgentChat.done(c.id);
  Assert.equal(second.outcome, "done", "a later task ran under the same grant");
  Assert.equal(AgentGate.waiting.length, 0, "with no question");
  await AgentChat.send(c.id, script([{ hold: true }]));
  await until(() => held.size === 1, "the model is thinking");
  AgentChat.stop(c.id);
  Assert.ok(!AgentGate.grants().some((g) => g.conn === c.conn), "stopping ended the grant");
  const stopped = await AgentChat.done(c.id);
  Assert.equal(stopped.outcome, "stopped", "and the task");
  for (const release of held.values()) release();
  held.clear();
});

addTidyTask(async function test_checkpoint_and_show_ask_under_the_conversation_grant() {
  const c = AgentChat.create({ provider: PROVIDER });
  await AgentChat.send(
    c.id,
    script([
      { call: "vimma_open", args: { url: CLICK, elements: true } },
      { call: "vimma_activate", args: { tab: "$tab", label: "$label:Search" } },
      { call: "vimma_show", args: { tab: "$tab" } },
      { reply: "asked twice" },
    ]),
  );
  let q = await question();
  Assert.equal(q.tool, "vimma_activate", "a submit asks under the conversation's grant (B18)");
  Assert.ok(q.what.submit, "as a form submission");
  AgentGate.answer(q.id, { kind: "deny" });
  q = await TestUtils.waitForCondition(
    () => AgentGate.waiting.find((w) => w.tool === "vimma_show"),
    "vimma_show asks too",
  );
  AgentGate.answer(q.id, { kind: "once" });
  const result = await AgentChat.done(c.id);
  Assert.equal(result.outcome, "done", "the task went on after the answers");
  const texts = toolTexts(result);
  Assert.equal(
    texts[1],
    "The user denied this request in Vimma.",
    "the model read the no in vimma-ctl's words",
  );
  Assert.ok(texts[2].startsWith("The user now sees tab "), "and the yes to the show");
  Assert.ok(
    AgentGate.grants().some((g) => g.conn === c.conn && g.until === Infinity),
    "the grant stands after the checkpoint",
  );
});

addTidyTask(async function test_two_conversations_see_only_their_tabs() {
  const a = AgentChat.create({ provider: PROVIDER });
  const b = AgentChat.create({ provider: PROVIDER });
  await AgentChat.send(a.id, script([openStep(`${PAGE}?a`), { reply: "a" }]));
  const ra = await AgentChat.done(a.id);
  const tabA = /\btab (\d+)\b/.exec(toolTexts(ra)[0])?.[1];
  Assert.ok(tabA, "conversation a opened a tab");
  await AgentChat.send(
    b.id,
    script([
      openStep(`${PAGE}?b`),
      { call: "vimma_tabs", args: {} },
      { call: "vimma_read_page", args: { tab: tabA } },
      { reply: "b" },
    ]),
  );
  const rb = await AgentChat.done(b.id);
  const [, list, read] = toolTexts(rb);
  Assert.ok(list.startsWith("1 tab in Vimma's agent workspace"), "b lists only its own tab");
  Assert.ok(list.includes("?b") && !list.includes("?a"), "and not a's");
  Assert.equal(
    read,
    `Vimma refused the arguments: tab ${tabA} is not a tab of the agent workspace.`,
    "a's tab is refused as a tab outside the agent workspace (B17)",
  );
});

addTidyTask(async function test_mcp_agent_sees_only_unowned_tabs() {
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, true);
  await VimmaControl.settled();
  const loose = gBrowser.addTab(`${PAGE}?loose`, {
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(loose.linkedBrowser);
  const c = AgentChat.create({ provider: PROVIDER });
  await AgentChat.send(c.id, script([openStep(`${PAGE}?owned`), { reply: "ok" }]));
  const owned = /\btab (\d+)\b/.exec(toolTexts(await AgentChat.done(c.id))[0])?.[1];

  const mcp = new Client(/** @type {number} */ (VimmaControl.port));
  await mcp.handshake({ protocol: 2, role: "agent" });
  await mcp.call("agent-hello", { client: { name: "built-in · groceries" } });
  Assert.equal(
    AgentGate.connections.find((l) => l.client.startsWith("built-in · groceries"))?.client,
    "built-in · groceries (mcp)",
    "an MCP client named built-in is shown with (mcp) (Behaviour 31)",
  );
  const listing = mcp.request("agent-tabs", {});
  AgentGate.answer((await question()).id, { kind: "grant", minutes: null });
  const tabs = (await mcp.response(listing)).result.tabs.map((/** @type {any} */ t) => t.id);
  Assert.deepEqual(tabs, [idOf(loose)], "the MCP agent sees the tab no conversation owns only");
  const read = await mcp.call("agent-read", { tab: owned });
  Assert.equal(read.error?.code, "invalid-args", "and is refused the conversation's tab");
  Assert.equal(
    read.error?.message,
    `tab ${owned} is not a tab of the agent workspace`,
    "as a tab outside the agent workspace",
  );
  mcp.close();
});

/** An MCP connection after its hello, with a grant; returns the ids agent-tabs lists. */
async function mcpTabs() {
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, true);
  await VimmaControl.settled();
  const mcp = new Client(/** @type {number} */ (VimmaControl.port));
  await mcp.handshake({ protocol: 2, role: "agent" });
  await mcp.call("agent-hello", { client: { name: "example" } });
  const listing = mcp.request("agent-tabs", {});
  AgentGate.answer((await question()).id, { kind: "once" });
  const ids = (await mcp.response(listing)).result.tabs.map((/** @type {any} */ t) => t.id);
  mcp.close();
  return ids;
}

addTidyTask(async function test_an_unloaded_tab_stays_its_conversations() {
  const c = AgentChat.create({ provider: PROVIDER });
  await AgentChat.send(c.id, script([openStep(`${PAGE}?owned`), { reply: "ok" }]));
  await AgentChat.done(c.id);
  const [tab] = agentTabs();
  gBrowser.discardBrowser(tab, true);
  await until(() => !tab.linkedPanel, "the tab was unloaded");
  Assert.deepEqual(await mcpTabs(), [], "an MCP agent does not see the unloaded owned tab");
  await AgentChat.send(c.id, script([{ call: "vimma_tabs", args: {} }, { reply: "ok" }]));
  const list = toolTexts(await AgentChat.done(c.id)).at(-1);
  Assert.ok(list.startsWith("1 tab in Vimma's agent workspace"), "its conversation still does");
});

addTidyTask(async function test_tabs_opened_from_an_owned_tab_stay_owned() {
  const c = AgentChat.create({ provider: PROVIDER });
  await AgentChat.send(c.id, script([openStep(`${PAGE}?owned`), { reply: "ok" }]));
  await AgentChat.done(c.id);
  const [owned] = agentTabs();
  // tabbrowser's addTab takes the opener as its browser, as a page's window.open passes it.
  const opts = (/** @type {any} */ opener) => ({
    openerBrowser: opener.linkedBrowser,
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  const child = gBrowser.addTab(`${PAGE}?child`, opts(owned));
  const grandchild = gBrowser.addTab(`${PAGE}?grandchild`, opts(child));
  await BrowserTestUtils.browserLoaded(grandchild.linkedBrowser);
  BrowserTestUtils.removeTab(owned);
  Assert.deepEqual(
    await mcpTabs(),
    [],
    "neither a tab opened from it nor one opened from that is an MCP agent's, its opener gone",
  );
});

addTidyTask(async function test_max_running() {
  const convs = [1, 2, 3, 4].map(() => AgentChat.create({ provider: PROVIDER }));
  for (const c of convs.slice(0, 3)) {
    Assert.deepEqual(
      await AgentChat.send(c.id, script([{ hold: true }, { reply: `c${c.id}` }])),
      { started: true },
      "up to three run",
    );
  }
  Assert.deepEqual(
    await AgentChat.send(convs[3].id, script([{ reply: "x" }])),
    { refused: "3 agent tasks are running ([agent] max_running); s stops one" },
    "a fourth is refused (Behaviour 32)",
  );
  Assert.equal(AgentChat.running, 3, "three run");
  AgentChat.stop(convs[0].id);
  Assert.deepEqual(
    await AgentChat.send(convs[3].id, script([{ reply: "x" }])),
    { started: true },
    "one stopped, the fourth starts",
  );
  await AgentChat.done(convs[3].id);
  for (const release of held.values()) release();
  held.clear();
});

addTidyTask(async function test_ctrl_b_shift_a_stops_every_task() {
  const convs = [1, 2].map(() => AgentChat.create({ provider: PROVIDER }));
  for (const c of convs) {
    await AgentChat.send(c.id, script([{ hold: true }, { reply: `c${c.id}` }]));
  }
  await until(() => held.size === 2, "both models are thinking");
  AgentUi.answer(window);
  const outcomes = await Promise.all(convs.map((c) => AgentChat.done(c.id)));
  Assert.deepEqual(
    outcomes.map((r) => r.outcome),
    ["stopped", "stopped"],
    "ctrl+b shift+a with no question stopped every task (Behaviour 16)",
  );
  Assert.equal(AgentGate.grants().length, 0, "and ended every grant");
  for (const release of held.values()) release();
  held.clear();
});

addTidyTask(async function test_requests_only_to_the_endpoint_without_credentials_or_redirects() {
  Services.cookies.add(
    "127.0.0.1",
    "/",
    "session",
    "secret",
    false,
    false,
    false,
    Date.now() + 60_000,
    {},
    Ci.nsICookie.SAMESITE_NONE,
    Ci.nsICookie.SCHEME_HTTP,
  );
  const c = AgentChat.create({ provider: PROVIDER });
  await AgentChat.send(c.id, script([{ reply: "ok" }]));
  await AgentChat.done(c.id);
  Assert.equal(requests.length, 1, "one request");
  Assert.equal(requests[0].path, "/v1/chat/completions", "to the endpoint");
  Assert.equal(requests[0].cookie, null, "with no cookie (credentials: omit)");
  Assert.equal(requests[0].authorization, null, "and no key for a local server without one");
  Assert.equal(requests[0].body.model, "scripted", "for the conversation's model");

  requests.length = 0;
  const moved = AgentChat.create({
    provider: { ...PROVIDER, endpoint: `http://127.0.0.1:${PORT}/moved/v1` },
  });
  await AgentChat.send(moved.id, script([{ reply: "never" }]));
  const result = await AgentChat.done(moved.id);
  Assert.equal(result.outcome, "error", "a redirect fails the request");
  Assert.deepEqual(
    requests.map((r) => r.path),
    ["/moved/v1/chat/completions"],
    "and is not followed",
  );
  Services.cookies.removeAll();
});

add_task(async function test_probe_only_on_setup_and_only_loopback() {
  Assert.equal(requests.length, 0, "nothing was asked before setup");
  const found = await AgentChat.probe({ servers: [{ server: "test", port: PORT }] });
  Assert.deepEqual(
    found,
    [
      {
        server: "test",
        endpoint: `http://127.0.0.1:${PORT}/v1`,
        models: ["scripted", "scripted-2"],
      },
    ],
    "the probe lists the models of a server on 127.0.0.1",
  );
});

// agent-speed S4 (security.md M31): clearing a conversation's context forgets its last element
// lists too, so the next list of a site it listed before comes in full, not as labels of lines
// the model no longer has.
addTidyTask(async function test_clear_forgets_the_last_element_lists() {
  const c = AgentChat.create({ provider: PROVIDER });
  const open = { call: "vimma_open", args: { url: CLICK, elements: true } };
  const compact = "as in your last list of this site";
  await AgentChat.send(c.id, script([open, open, { reply: "twice" }]));
  const [first, second] = toolTexts(await AgentChat.done(c.id));
  Assert.ok(!first.includes(compact), "the first list of the site is in full");
  Assert.ok(second.includes(compact), `the second leaves out what the first gave: ${second}`);
  Assert.equal(AgentChat.clear(c.id), null, "the context is cleared");
  await AgentChat.send(c.id, script([open, { reply: "again" }]));
  const [after] = toolTexts(await AgentChat.done(c.id));
  Assert.ok(after.includes("<untrusted-web-content>"), "the page is listed");
  Assert.ok(!after.includes(compact), "after a clear, the list is in full");
});
