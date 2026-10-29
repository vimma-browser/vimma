/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/builtin-agent-cli.md, delivery 1 (C1, C3). An agent CLI's `vimma-ctl mcp`
// reaches the browser only through its conversation's gate connection: Vimma hands the run a
// one-time ticket, the control socket listens for it even with MCP and full control off, and a
// connection with the ticket acts as the conversation (`builtin:<n>`), on its tabs, under its
// grant. The ticket serves one connection (and that connection's reconnects by session id), is
// never written where another process or a log could read it, and ends with the run: a stop or a
// delete closes its connection.

"use strict";

/* global Client, tidyTask, hmacHex -- from head_vimma_control.js */
/* global add_setup -- the browser-chrome harness (browser-test.js) */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);

const { AgentChat, FEATURE_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/agent/AgentChat.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentGate.sys.mjs",
);
const { VimmaControl, ENABLED_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { MCP_ENABLED_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/mcp-ops.mjs",
);
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
const DISCOVERY = PathUtils.join(PathUtils.profileDir, "vimma-control.json");
/** A provider no test sends a task to: the CLI, not a model, takes the steps here. */
const PROVIDER = {
  name: "claude",
  kind: "openai",
  endpoint: "http://127.0.0.1:9/v1",
  model: "fake",
  vision: false,
};
const NONCE = "cd".repeat(32);
const SESSION = "5e".repeat(16);

/** @param {() => boolean} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);
const agentTabs = () =>
  gBrowser.tabs.filter(
    (t) => t.userContextId === /** @type {any} */ (WorkspaceStore.agent)?.userContextId,
  );

async function tidy() {
  AgentChat.stopAll();
  for (const c of AgentChat.list()) await AgentChat.delete(c.id);
  for (const q of AgentGate.waiting) AgentGate.answer(q.id, { kind: "deny" });
  AgentGate.revoke();
  const ww = WindowWorkspaces.get(window);
  ww.switchTo({ id: ww.model.workspaces.find((/** @type {any} */ w) => w.name === "main")?.id });
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  for (const t of gBrowser.tabs.slice(1)) BrowserTestUtils.removeTab(t);
  Services.prefs.clearUserPref(MCP_ENABLED_PREF);
  Services.prefs.clearUserPref(ENABLED_PREF);
  await VimmaControl.settled();
}

/** @param {() => Promise<void>} task */
const addTidyTask = (task) => add_task(tidyTask(task, tidy));

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({ set: [[FEATURE_PREF, true]] });
  OSKeyStoreTestUtils.setup();
  registerCleanupFunction(() => OSKeyStoreTestUtils.cleanup());
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, false);
  Services.prefs.setBoolPref(ENABLED_PREF, false);
  await VimmaControl.settled();
});

/**
 * The handshake as vimma-ctl does it with a ticket (S4 with the ticket as the key): the hello
 * names the ticket by its id, the server proves it knows the ticket, then the auth carries it.
 * Resolves to the welcome, or to the error the server answered with.
 * @param {any} client @param {string} ticket
 */
async function ticketHandshake(client, ticket) {
  const id = await hmacHex(ticket, "vimma-ticket\0");
  client.send({ type: "hello", protocol: 2, nonce: NONCE, role: "agent", ticket: id });
  const challenge = await client.take();
  if (challenge?.type !== "challenge") return challenge;
  Assert.equal(
    challenge.proof,
    await hmacHex(ticket, `vimma-server\0${NONCE}`),
    "the server proves it knows the ticket before the client sends it",
  );
  client.send({ type: "auth", ticket });
  return client.take();
}

/**
 * A connection with `ticket` that said its agent-hello, as `vimma-ctl mcp` opens it.
 * @param {number} port @param {string} ticket @param {string} [session]
 */
async function connect(port, ticket, session = SESSION) {
  const client = new Client(port);
  const welcome = await ticketHandshake(client, ticket);
  Assert.equal(welcome?.type, "welcome", "the ticket is welcomed");
  Assert.equal(welcome.role, "agent", "as the agent role");
  const hello = await client.call("agent-hello", { client: { name: "claude-code" }, session });
  Assert.ok(hello.ok, `agent-hello: ${JSON.stringify(hello.error)}`);
  return client;
}

/** The notices the gate sends while `task` runs. @param {() => Promise<void>} task */
async function noticesDuring(task) {
  /** @type {string[]} */
  const notices = [];
  const onGate = (/** @type {any} */ e) => {
    if (e?.kind === "notice") notices.push(e.text);
  };
  AgentGate.addListener(onGate);
  try {
    await task();
  } finally {
    AgentGate.removeListener(onGate);
  }
  return notices;
}

addTidyTask(async function test_ticket_connection_acts_as_the_conversation() {
  const c = AgentChat.create({ provider: PROVIDER });
  const other = AgentChat.create({ provider: PROVIDER });
  const { ticket, port } = await AgentChat.issueTicket(c.id, "claude-code");
  Assert.ok(/^[0-9a-f]{64}$/.test(ticket), "256 random bits, as hex");
  const client = await connect(port, ticket);
  Assert.ok(
    !AgentGate.connections.some((l) => /claude-code/.test(l.client)),
    "the ticket's connection is no MCP agent of its own: the gate knows only the conversation",
  );

  // No grant yet: its first step asks, as the conversation.
  const asked = client.request("agent-open", { url: PAGE });
  await until(() => AgentGate.waiting.length > 0, "the step asks");
  const q = AgentGate.waiting[0];
  Assert.equal(q.conn, c.conn, "asked as the conversation's connection");
  Assert.equal(q.label.client, "built-in · New conversation", "under the conversation's label");
  AgentGate.answer(q.id, { kind: "once" });
  const opened = await client.response(asked);
  Assert.ok(opened.ok, `agent-open ran: ${JSON.stringify(opened.error)}`);
  const tab = agentTabs().find((t) => String(t.linkedBrowser.browserId) === opened.result.tab);
  Assert.ok(tab, "the page opened in the agent workspace");
  Assert.equal(AgentChat.ownerOf(tab), c.id, "and belongs to the conversation (M36)");

  // The conversation's grant (Enter) covers the ticket's steps; another conversation's does not.
  AgentGate.grantConnection(other.conn);
  const tabs = client.request("agent-tabs");
  await until(() => AgentGate.waiting.length > 0, "another conversation's grant covers nothing");
  AgentGate.answer(AgentGate.waiting[0].id, { kind: "deny" });
  Assert.equal((await client.response(tabs)).error?.reason, "user", "denied by the user");
  AgentGate.grantConnection(c.conn);
  const listed = await client.call("agent-tabs");
  Assert.ok(listed.ok, "the conversation's grant covers the ticket's steps (B18)");
  Assert.deepEqual(
    listed.result.tabs.map((/** @type {any} */ t) => t.id),
    [opened.result.tab],
    "it sees the conversation's tabs only",
  );
  Assert.equal(
    (await client.call("send-keys", { keys: "j" })).error?.code,
    "unknown-command",
    "never a full-role command",
  );

  // The connection ending leaves the conversation, its grant and its tabs as they were.
  client.close();
  await until(() => VimmaControl.connections === 0, "the ticket's connection closed");
  Assert.ok(
    AgentGate.grants().some((g) => g.conn === c.conn),
    "the grant stays",
  );
  Assert.ok(AgentGate.isConnected(c.conn), "the conversation's connection stays");
  VimmaControl.revokeTicket(ticket);
});

addTidyTask(async function test_ticket_listener_with_mcp_off_takes_only_tickets() {
  Assert.equal(VimmaControl.port, null, "MCP and full control off: no listener");
  const c = AgentChat.create({ provider: PROVIDER });
  const { ticket, port } = await AgentChat.issueTicket(c.id, "claude-code");
  Assert.equal(VimmaControl.port, port, "a ticket starts the listener");
  Assert.ok(!(await IOUtils.exists(DISCOVERY)), "and no discovery file names it");

  for (const role of ["agent", "full"]) {
    const client = new Client(port);
    client.send({ type: "hello", protocol: 2, nonce: NONCE, role });
    const refused = await client.take();
    Assert.equal(refused?.error?.code, "role-off", `a ${role} hello without a ticket is refused`);
    client.close();
  }
  const stranger = new Client(port);
  const unknown = await ticketHandshake(stranger, "77".repeat(32));
  Assert.equal(unknown?.error?.code, "unauthorized", "a ticket Vimma did not make is refused");
  stranger.close();

  const client = await connect(port, ticket);
  // MCP going on and off again leaves the ticket's connection alone.
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, true);
  await VimmaControl.settled();
  Assert.ok(await IOUtils.exists(DISCOVERY), "MCP on writes the discovery file");
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, false);
  await VimmaControl.settled();
  Assert.ok(!(await IOUtils.exists(DISCOVERY)), "MCP off removes it");
  Assert.equal(VimmaControl.port, port, "the listener stays for the ticket");
  Assert.ok((await client.call("agent-ping")).ok, "and the ticket's connection goes on");

  VimmaControl.revokeTicket(ticket);
  Assert.equal(await client.take(), null, "revoking the ticket closes its connection at once");
  await VimmaControl.settled();
  Assert.equal(VimmaControl.port, null, "and the last ticket stops the listener");
});

addTidyTask(async function test_mcp_agents_cannot_keep_out_a_ticket() {
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, true);
  await VimmaControl.settled();
  /** @type {any[]} */
  const agents = [];
  const join = async () => {
    const a = new Client(VimmaControl.port);
    agents.push(a);
    return (await a.handshake({ protocol: 2, role: "agent" }))?.type ?? "closed";
  };
  for (let i = 0; i < 3; i++) Assert.equal(await join(), "welcome", "an MCP agent");
  const c = AgentChat.create({ provider: PROVIDER });
  const { ticket, port } = await AgentChat.issueTicket(c.id, "claude-code");
  const client = await connect(port, ticket);
  Assert.equal(await join(), "welcome", "the ticket's connection takes no MCP agent's place");
  const fifth = await join();
  Assert.equal(fifth, "response", "the fifth MCP agent is told busy (S5)");
  Assert.ok((await client.call("agent-ping")).ok, "and the ticket's connection goes on");
  // Four MCP agents fill their places; a ticket's connection still gets in.
  const d = AgentChat.create({ provider: PROVIDER });
  const second = await AgentChat.issueTicket(d.id, "claude-code");
  const client2 = await connect(second.port, second.ticket);
  Assert.ok((await client2.call("agent-ping")).ok, "a second task's connection gets in");
  for (const a of agents) a.close();
  VimmaControl.revokeTicket(ticket);
  VimmaControl.revokeTicket(second.ticket);
});

addTidyTask(async function test_second_connection_with_a_ticket_is_refused() {
  const c = AgentChat.create({ provider: PROVIDER });
  const { ticket, port } = await AgentChat.issueTicket(c.id, "claude-code");
  const first = await connect(port, ticket);

  const notices = await noticesDuring(async () => {
    const second = new Client(port);
    const refused = await ticketHandshake(second, ticket);
    Assert.equal(refused?.error?.code, "unauthorized", "a second connection is refused");
    second.close();
  });
  Assert.deepEqual(
    notices,
    ["a second program used claude-code's ticket and was refused"],
    "and shown as a notice",
  );
  Assert.ok((await first.call("agent-ping")).ok, "the first connection goes on");

  // The same vimma-ctl reconnects with its session id; another program does not get in.
  first.close();
  await until(() => VimmaControl.connections === 0, "the first connection closed");
  const stranger = new Client(port);
  Assert.equal((await ticketHandshake(stranger, ticket))?.type, "welcome", "a reconnect's auth");
  const notices2 = await noticesDuring(async () => {
    const hello = await stranger.call("agent-hello", {
      client: { name: "claude-code" },
      session: "99".repeat(16),
    });
    Assert.equal(hello.error?.code, "unauthorized", "another session id is refused");
    Assert.equal(await stranger.take(), null, "and its connection closed");
  });
  Assert.deepEqual(notices2, ["a second program used claude-code's ticket and was refused"]);
  const again = await connect(port, ticket, SESSION);
  Assert.ok((await again.call("agent-ping")).ok, "the session's own reconnect gets in");
  again.close();

  // A first connection that sent no session id spends the ticket: nobody can come back on it.
  const d = AgentChat.create({ provider: PROVIDER });
  const spent = await AgentChat.issueTicket(d.id, "claude-code");
  const silent = new Client(spent.port);
  Assert.equal((await ticketHandshake(silent, spent.ticket))?.type, "welcome", "its first one");
  silent.close();
  await until(() => VimmaControl.connections === 0, "it closed without an agent-hello");
  const notices3 = await noticesDuring(async () => {
    const next = new Client(spent.port);
    const refused = await ticketHandshake(next, spent.ticket);
    Assert.equal(refused?.error?.code, "unauthorized", "no later connection gets in");
    next.close();
  });
  Assert.deepEqual(notices3, ["a second program used claude-code's ticket and was refused"]);

  // With another ticket keeping the listener up, the server itself refuses a revoked ticket.
  VimmaControl.revokeTicket(ticket);
  Assert.equal(VimmaControl.port, port, "the listener stays for the other ticket");
  const late = new Client(port);
  const revoked = await ticketHandshake(late, ticket);
  Assert.equal(revoked?.error?.code, "unauthorized", "a revoked ticket is refused before a proof");
  late.close();
  VimmaControl.revokeTicket(spent.ticket);
});

addTidyTask(async function test_a_request_id_in_flight_is_not_reused() {
  const c = AgentChat.create({ provider: PROVIDER });
  const { ticket, port } = await AgentChat.issueTicket(c.id, "claude-code");
  const client = await connect(port, ticket);
  client.request("agent-open", { url: PAGE }, 7);
  await until(() => AgentGate.waiting.length > 0, "the step asks");
  const again = await client.response(client.request("agent-tabs", {}, 7));
  Assert.equal(again.error?.code, "bad-request", "a second request with id 7 is refused");
  Assert.equal(AgentGate.waiting.length, 1, "and asks nothing");
  client.close();
  await until(() => AgentGate.waiting.length === 0, "the first one's question is withdrawn");
  VimmaControl.revokeTicket(ticket);
});

addTidyTask(async function test_stop_and_delete_close_the_ticket_connection() {
  const c = AgentChat.create({ provider: PROVIDER });
  const { ticket, port } = await AgentChat.issueTicket(c.id, "claude-code");
  const client = await connect(port, ticket);
  // Another conversation's ticket keeps the listener up, so the server's refusal is tested.
  const keeper = AgentChat.create({ provider: PROVIDER });
  const kept = await AgentChat.issueTicket(keeper.id, "claude-code");
  // A question waiting on the ticket's connection is withdrawn with it.
  client.request("agent-open", { url: PAGE });
  await until(() => AgentGate.waiting.length > 0, "the step asks");
  AgentChat.stop(c.id);
  Assert.equal(await client.take(() => false), null, "and closes the ticket's connection");
  Assert.equal(AgentGate.waiting.length, 0, "no question of it waits");
  Assert.equal(VimmaControl.port, port, "the other ticket keeps the listener");
  const late = new Client(port);
  const refused = await ticketHandshake(late, ticket);
  Assert.equal(refused?.error?.code, "unauthorized", "the stop ended the ticket");
  late.close();
  VimmaControl.revokeTicket(kept.ticket);

  const d = AgentChat.create({ provider: PROVIDER });
  const second = await AgentChat.issueTicket(d.id, "claude-code");
  const client2 = await connect(second.port, second.ticket);
  await AgentChat.delete(d.id);
  Assert.equal(await client2.take(() => false), null, "a delete closes it too");
  await VimmaControl.settled();
  Assert.equal(VimmaControl.port, null, "no ticket left: no listener");
});

addTidyTask(async function test_ticket_never_in_prefs_files_notices_or_log() {
  const c = AgentChat.create({ provider: PROVIDER });
  const { ticket, port } = await AgentChat.issueTicket(c.id, "claude-code");
  const notices = await noticesDuring(async () => {
    const client = await connect(port, ticket);
    AgentGate.grantConnection(c.conn);
    Assert.ok((await client.call("agent-tabs")).ok, "a step ran");
    const second = new Client(port);
    await ticketHandshake(second, ticket);
    second.close();
    client.close();
  });
  Assert.ok(notices.length, "there were notices");
  for (const text of notices) Assert.ok(!text.includes(ticket), `not in a notice: ${text}`);
  for (const row of AgentGate.log) {
    Assert.ok(!JSON.stringify(row).includes(ticket), "not in :mcp log");
  }
  const prefs = Services.prefs
    .getChildList("")
    .filter((name) => Services.prefs.getPrefType(name) === Services.prefs.PREF_STRING)
    .filter((name) => Services.prefs.getStringPref(name, "").includes(ticket));
  Assert.deepEqual(prefs, [], "not in a pref");
  Assert.ok(!(await IOUtils.exists(DISCOVERY)), "no discovery file was written");
  /** @type {string[]} */
  const files = [];
  for (const child of await IOUtils.getChildren(PathUtils.profileDir)) {
    // The profile's lock is a dangling symlink: stat fails on it.
    const info = await IOUtils.stat(child).catch(() => null);
    if (info?.type !== "regular" || info.size > 1_000_000) continue;
    const text = new TextDecoder().decode(await IOUtils.read(child));
    if (text.includes(ticket)) files.push(PathUtils.filename(child));
  }
  Assert.deepEqual(files, [], "not in a file of the profile");
  VimmaControl.revokeTicket(ticket);
});
