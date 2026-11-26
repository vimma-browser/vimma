/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/vimma-mcp.md, sub-PR 2a: what an agent connection's questions get. Every
// request but hello and ping waits for an answer (12), denied on timeout (16), capped (17), muted
// after three noes (18); one grant per connection, for every tool (mcp-grants G1), ended by
// `:mcp revoke` and by the connection closing (20-22), kept across a reconnect of the same
// session (mcp-session-grants); the rate and connection limits; and the notice an older
// vimma-ctl gets (ship-vimma-ctl). Roles, confinement and reads are in
// browser_vimma_mcp_agent.js, split from this file so that each runs well inside the per-file
// time limit (#1135); the helpers below are its own, kept alike (a shared head_*.js would
// declare names such as PAGE and until that head_vimma_grep.js declares too). Here the tests
// answer through AgentGate, as the question line does.

"use strict";

/* global Client, discovery -- from head_vimma_control.js */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);

const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/AgentGate.sys.mjs",
);
const { McpHost, MCP_ENABLED_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/mcp-ops.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
/** Vimma's version: what a vimma-ctl shipped with this build names in its agent-hello. */
const VIMMA_VERSION = AppConstants.MOZ_APP_VERSION_DISPLAY;

const CONTROL = "vimma.control.enabled";
const ASK_TIMEOUT = "vimma.mcp.askTimeoutMs";
const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = `${DIR}file_vimma_agent_page.html`;
const NOTICE_ID = "vimma-notice";

registerCleanupFunction(async () => {
  Services.prefs.clearUserPref(CONTROL);
  Services.prefs.clearUserPref(MCP_ENABLED_PREF);
  Services.prefs.clearUserPref(ASK_TIMEOUT);
  await VimmaControl.settled();
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
});

const agent = () => /** @type {ContainedWorkspace} */ (WorkspaceStore.agent);
const agentTabs = () =>
  gBrowser.tabs.filter((t) => t.userContextId === agent().userContextId && !t.closing);
const idOf = (/** @type {MozTabbrowserTab} */ tab) => String(tab.linkedBrowser.browserId);

/** @param {() => unknown} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);

async function setSwitches({ control = false, mcp = false }) {
  Services.prefs.setBoolPref(CONTROL, control);
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, mcp);
  await VimmaControl.settled();
}

/** A tab in the agent workspace, loaded with `url`, hidden while the window shows `main`. */
async function openAgentTab(url = PAGE) {
  const tab = gBrowser.addTab(url, {
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  await until(() => tab.hidden, "the agent tab is hidden in its workspace");
  return tab;
}

/**
 * An agent connection, after its agent-hello.
 * @param {string} [name] @param {string} [session]  the vimma-ctl mcp process's id
 */
async function agentClient(name = "example-agent", session = undefined) {
  const c = new Client(/** @type {number} */ (VimmaControl.port));
  const welcome = await c.handshake({ protocol: 2, role: "agent" });
  Assert.equal(welcome?.type, "welcome", "an agent connection is welcomed");
  Assert.equal(welcome?.role, "agent", "as the agent role");
  const hi = await c.call("agent-hello", {
    client: { name },
    via: "example",
    ctl: VIMMA_VERSION,
    ...(session ? { session } : {}),
  });
  Assert.deepEqual(hi.result, { workspace: agent().name, exists: true }, "agent-hello answers");
  return c;
}

/** The oldest waiting question, once there is one. */
async function question() {
  await until(() => AgentGate.waiting.length > 0, "a question waits");
  return /** @type {AskedQuestion} */ (AgentGate.waiting[0]);
}

/** Answer the oldest question. @param {GateAnswer} answer */
async function answer(answer) {
  const q = await question();
  AgentGate.answer(q.id, answer);
  return q;
}

add_task(async function test_denials_timeouts_queue_and_mute() {
  await setSwitches({ mcp: true });
  const tab = await openAgentTab();
  const c = await agentClient();
  const read = () => c.request("agent-read", { tab: idOf(tab) });

  let id = read();
  await answer({ kind: "deny" });
  /** @type {ControlReply<"agent-read" | "agent-tabs">} */
  let r = await c.response(id);
  Assert.deepEqual([r.error?.code, r.error?.reason], ["denied", "user"], "n denies");

  Services.prefs.setIntPref(ASK_TIMEOUT, 300);
  id = read();
  r = await c.response(id);
  Assert.deepEqual([r.error?.code, r.error?.reason], ["denied", "timeout"], "no answer: denied");
  Services.prefs.clearUserPref(ASK_TIMEOUT);

  id = read();
  await answer({ kind: "deny" });
  await c.response(id);
  r = await c.call("agent-read", { tab: idOf(tab) });
  Assert.deepEqual([r.error?.code, r.error?.reason], ["denied", "muted"], "three noes mute");
  Assert.equal(AgentGate.waiting.length, 0, "without asking");
  c.close();

  const d = await agentClient("codex");
  const ids = [0, 1, 2, 3, 4].map(() => d.request("agent-read", { tab: idOf(tab) }));
  r = await d.response(ids[4]);
  Assert.deepEqual([r.error?.code, r.error?.reason], ["denied", "busy"], "a 5th waiting: busy");
  await until(() => AgentGate.waiting.length === 4, "4 wait");
  AgentGate.answer(AgentGate.waiting[0].id, { kind: "mute" });
  for (const i of ids.slice(0, 4)) {
    const res = await d.response(i);
    Assert.equal(res.error?.code, "denied", `request ${i}: x denies it and every queued one`);
  }
  r = await d.call("agent-tabs");
  Assert.equal(r.error?.reason, "muted", "x mutes the connection");
  d.close();
  await until(() => AgentGate.waiting.length === 0, "nothing left waiting");
  BrowserTestUtils.removeTab(tab);
  await setSwitches({});
});

// Decision 17: MCP's notifications/cancelled withdraws the call's question. Only the
// connection's own requests, and only while they wait; a cancel is never refused as busy.
add_task(async function test_agent_cancel_withdraws_one_waiting_question() {
  await setSwitches({ mcp: true });
  const tab = await openAgentTab();
  const c = await agentClient();
  const ids = [0, 1, 2, 3].map(() => c.request("agent-read", { tab: idOf(tab) }));
  await until(() => AgentGate.waiting.length === 4, "4 questions wait");
  const first = AgentGate.waiting[0].id;

  let r = await c.call("agent-cancel", { id: ids[0] });
  Assert.deepEqual(r.result, { cancelled: true }, "the waiting question is withdrawn");
  r = await c.response(/** @type {number} */ (ids[0]));
  Assert.deepEqual([r.error?.code, r.error?.reason], ["denied", "cancelled"], "its call ends");
  Assert.equal(AgentGate.waiting.length, 3, "three still wait");
  Assert.ok(
    !AgentGate.waiting.some((/** @type {GateQuestion} */ q) => q.id === first),
    "the cancelled one is off the line",
  );

  r = await c.call("agent-cancel", { id: ids[0] });
  Assert.deepEqual(r.result, { cancelled: false }, "a second cancel finds nothing");
  r = await c.call("agent-cancel", { id: 999 });
  Assert.deepEqual(r.result, { cancelled: false }, "an unknown id finds nothing");

  const d = await agentClient("codex");
  r = await d.call("agent-cancel", { id: ids[1] });
  Assert.deepEqual(r.result, { cancelled: false }, "another connection cannot cancel it");
  Assert.equal(AgentGate.waiting.length, 3, "nothing else was withdrawn");
  r = await d.call("agent-cancel", { id: "1" });
  Assert.equal(r.error?.code, "invalid-args", "the id is an integer");
  d.close();

  AgentGate.answer(AgentGate.waiting[0].id, { kind: "mute" });
  for (const i of ids.slice(1)) await c.response(i);
  c.close();
  await until(() => AgentGate.waiting.length === 0, "nothing left waiting");
  BrowserTestUtils.removeTab(tab);
  await setSwitches({});
});

add_task(async function test_one_grant_covers_every_tool_of_its_connection() {
  await setSwitches({ mcp: true });
  const tab = await openAgentTab();
  const c = await agentClient();
  let id = c.request("agent-read", { tab: idOf(tab) });
  await answer({ kind: "grant", minutes: 15 });
  Assert.equal((await c.response(id)).ok, true, "15a allows the read");
  Assert.deepEqual(
    // A grant covers its connection, not one tool: `tool` is read to check that it has none.
    AgentGate.grants().map((/** @type {GateGrant & { tool?: string }} */ g) => [
      g.conn !== undefined,
      g.tool,
    ]),
    [[true, undefined]],
    "and makes one grant of the connection, for no one tool",
  );

  /** @type {ControlReply<"agent-read" | "agent-tabs" | "agent-open">} */
  let r = await c.call("agent-read", { tab: idOf(tab) });
  Assert.equal(r.ok, true, "the next read runs unasked");
  r = await c.call("agent-tabs");
  Assert.equal(r.ok, true, "so does another tool");
  r = await c.call("agent-open", { url: `${PAGE}?granted` });
  Assert.equal(r.ok, true, "an open too");
  Assert.equal(AgentGate.waiting.length, 0, "with no question");
  Assert.ok(
    AgentGate.log.some(
      (/** @type {GateLogRow} */ e) => e.tool === "vimma_open" && e.outcome === "grant",
    ),
    "and the open is in :mcp log as run under the grant",
  );

  const other = await agentClient("codex");
  id = other.request("agent-read", { tab: idOf(tab) });
  await question();
  await answer({ kind: "deny" });
  Assert.equal((await other.response(id)).error?.code, "denied", "another connection asks");
  other.close();

  Assert.ok(
    // revoke asks nothing, so it returns its notice.
    /** @type {string} */ (
      McpHost.run(
        "revoke",
        () => {},
        () => {},
      )
    ).includes("1"),
    ":mcp revoke says it ended 1",
  );
  id = c.request("agent-read", { tab: idOf(tab) });
  await question();
  await answer({ kind: "grant", minutes: 5 });
  await c.response(id);
  c.close();
  await until(() => AgentGate.grants().length === 0, "closing the connection ends its grant");
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  await setSwitches({});
});

// docs/specs/mcp-session-grants.md S1, S3: a bare `a` (grant_minutes 0, the default) allows the
// connection until it closes, and a reconnect of the same vimma-ctl mcp process (its session id)
// keeps that grant; another session, or a reconnect after :mcp off and on, asks again.
add_task(async function test_a_reconnect_of_the_same_session_keeps_its_grant() {
  await setSwitches({ mcp: true });
  const tab = await openAgentTab();
  const session = "5e".repeat(32);
  let c = await agentClient("example-agent", session);
  let id = c.request("agent-read", { tab: idOf(tab) });
  await answer({ kind: "grant", minutes: null });
  Assert.equal((await c.response(id)).ok, true, "a bare a allows the read");
  Assert.deepEqual(
    AgentGate.grants().map((/** @type {GateGrant} */ g) => g.until),
    [Infinity],
    "and grants the whole connection, with no end",
  );
  c.close();
  await until(() => AgentGate.grants().length === 0, "the closed connection holds no grant");

  c = await agentClient("example-agent", session);
  const r = await c.call("agent-read", { tab: idOf(tab) });
  Assert.equal(r.ok, true, "the same session's reconnect reads unasked");
  Assert.equal(AgentGate.waiting.length, 0, "with no question");

  const other = await agentClient("example-agent", "77".repeat(32));
  id = other.request("agent-read", { tab: idOf(tab) });
  await question();
  await answer({ kind: "deny" });
  Assert.equal((await other.response(id)).error?.code, "denied", "another session asks");
  other.close();

  // :mcp off ends the grants, the parked one included: on again, the same session asks.
  c.close();
  await until(() => AgentGate.connections.length === 0, "its link drops, and its grant waits");
  await setSwitches({});
  await until(() => AgentGate.connections.length === 0, ":mcp off closes the connections");
  await setSwitches({ mcp: true });
  c = await agentClient("example-agent", session);
  id = c.request("agent-read", { tab: idOf(tab) });
  await question();
  await answer({ kind: "deny" });
  Assert.equal((await c.response(id)).error?.code, "denied", "after :mcp off it asks again");
  c.close();
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  await setSwitches({});
});

// mcp-grants behaviour 1: the user answered only the question on the line, so a waiting call
// the grant releases shows as one run under it: a notice and a `:mcp log` row.
add_task(async function test_queued_calls_a_grant_releases_show_as_granted() {
  await setSwitches({ mcp: true });
  const tab = await openAgentTab();
  const c = await agentClient();
  /** @type {GateEvent[]} */
  const events = [];
  const listener = (/** @type {GateEvent | undefined} */ e) => e && events.push(e);
  AgentGate.addListener(listener);
  const read = c.request("agent-read", { tab: idOf(tab) });
  const open = c.request("agent-open", { url: `${PAGE}?queued` });
  await until(() => AgentGate.waiting.length === 2, "both wait");
  AgentGate.answer(AgentGate.waiting[0].id, { kind: "grant", minutes: 5 });
  Assert.equal((await c.response(read)).ok, true, "the read the user answered runs");
  Assert.equal((await c.response(open)).ok, true, "the waiting open runs under the grant");
  AgentGate.removeListener(listener);
  const row = AgentGate.log.find((/** @type {GateLogRow} */ e) => e.tool === "vimma_open");
  Assert.equal(row?.outcome, "grant", "logged as run under the grant, not as answered");
  // One notice: a separate one for the released call would replace the grant's at once.
  Assert.deepEqual(
    events.filter((e) => e.kind === "ran" || e.kind === "answered").map((e) => e.kind),
    ["answered"],
    "the grant's notice is the only one",
  );
  Assert.equal(
    events.find((e) => e.kind === "answered")?.released,
    1,
    "and it counts the waiting call the grant let run",
  );
  c.close();
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  await setSwitches({});
});

add_task(async function test_grants_cannot_flood() {
  await setSwitches({ mcp: true });
  const tab = await openAgentTab();
  const c = await agentClient();
  let id = c.request("agent-read", { tab: idOf(tab) });
  await answer({ kind: "grant", minutes: 5 });
  await c.response(id);
  // Six reads at once under the grant: four run, the rest are busy.
  const ids = [101, 102, 103, 104, 105, 106];
  c.sendLines(
    ids.map((n) => ({ type: "request", id: n, command: "agent-read", args: { tab: idOf(tab) } })),
  );
  const replies = await Promise.all(ids.map((n) => c.response(n)));
  Assert.equal(
    replies.filter((r) => r.error?.reason === "busy").length,
    2,
    "at most 4 agent requests of one connection run at once",
  );

  // New tabs under the same grant: at most 15 a minute by default (vimma-mcp decision 46).
  const opened = [];
  for (let i = 0; i < 16; i++) opened.push(await c.call("agent-open", { url: `${PAGE}?f${i}` }));
  Assert.equal(opened.filter((r) => r.ok).length, 15, "15 new tabs a minute");
  Assert.equal(opened.at(-1)?.error?.reason, "busy", "the rest are busy");
  Assert.equal(
    opened.at(-1)?.error?.message,
    "too many new tabs from this agent in the last minute (at most 15, [mcp] open_per_minute)",
    "naming the new-tab limit",
  );
  c.close();
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  await setSwitches({});
});

// Issue #693: without a grant every open asks; once the open rate is used up the next one is
// refused before the user is asked, as clicks and fills are.
add_task(async function test_a_used_up_open_rate_refuses_before_asking() {
  await setSwitches({ mcp: true });
  // An open that asked anyway ends at this timeout instead of hanging the test.
  Services.prefs.setIntPref(ASK_TIMEOUT, 2000);
  const c = await agentClient();
  for (let i = 0; i < 15; i++) {
    const id = c.request("agent-open", { url: `${PAGE}?a${i}` });
    await answer({ kind: "once" });
    Assert.ok((await c.response(id)).ok, `open ${i + 1} runs after its yes`);
  }
  const asked = AgentGate.log.length;
  const r = await c.call("agent-open", { url: `${PAGE}?a15` });
  Assert.equal(r.error?.reason, "busy", "the 16th open in a minute is refused as busy");
  Assert.ok((r.error?.retryAfter ?? 0) > 0, "with the wait for the next one");
  Assert.equal(AgentGate.waiting.length, 0, "and no question waits");
  Assert.equal(AgentGate.log.length, asked, "nor was the user asked");
  c.close();
  Services.prefs.clearUserPref(ASK_TIMEOUT);
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  await setSwitches({});
});

// Issue #1561, vimma-mcp decision 46: a load into an existing agent tab adds no tab, so it has
// a rate of its own (60 a minute by default), apart from the new tabs' 15.
add_task(async function test_loads_into_a_tab_have_their_own_rate() {
  await setSwitches({ mcp: true });
  const tab = await openAgentTab();
  const c = await agentClient();
  let id = c.request("agent-open", { url: `${PAGE}?n0` });
  await answer({ kind: "grant", minutes: 5 });
  Assert.ok((await c.response(id)).ok, "the first new tab, under a grant");
  for (let i = 1; i < 15; i++) {
    Assert.ok((await c.call("agent-open", { url: `${PAGE}?n${i}` })).ok, `new tab ${i + 1}`);
  }
  Assert.equal(
    (await c.call("agent-open", { url: `${PAGE}?n15` })).error?.reason,
    "busy",
    "the new tabs' rate is used up",
  );
  const loads = [];
  for (let i = 0; i < 61; i++) {
    loads.push(await c.call("agent-open", { url: `${PAGE}?l${i}`, tab: idOf(tab) }));
  }
  Assert.equal(loads.filter((r) => r.ok).length, 60, "while 60 loads into a tab still run");
  const last = loads.at(-1)?.error;
  Assert.equal(last?.reason, "busy", "and the 61st is busy");
  Assert.equal(
    last?.message,
    "too many loads from this agent in the last minute (at most 60, [mcp] load_per_minute)",
    "naming the load limit",
  );
  Assert.ok((last?.retryAfter ?? 0) > 0, "with the wait for the next one");
  c.close();
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  await setSwitches({});
});

// vimma-mcp decision 46: `[mcp] open_per_minute` and `load_per_minute` are read at each call,
// so a config.toml change holds from the next call on, as ask_timeout and max_read_chars do.
add_task(async function test_a_changed_rate_applies_to_the_next_call() {
  await setSwitches({ mcp: true });
  const before = McpHost.config;
  const base = {
    workspace: "agent",
    askTimeout: 50,
    grantMinutes: 0,
    grantMaxMinutes: 480,
    maxReadChars: 200000,
    notify: false,
    downloadDir: "~/Downloads/vimma-agent",
    downloadMaxMb: 200,
    clamavMaxAgeDays: 7,
  };
  McpHost.configure({ ...base, openPerMinute: 2, loadPerMinute: 1 });
  const tab = await openAgentTab();
  const c = await agentClient();
  let id = c.request("agent-open", { url: `${PAGE}?c0` });
  await answer({ kind: "grant", minutes: 5 });
  Assert.ok((await c.response(id)).ok, "new tab 1");
  Assert.ok((await c.call("agent-open", { url: `${PAGE}?c1` })).ok, "new tab 2");
  let r = await c.call("agent-open", { url: `${PAGE}?c2` });
  Assert.equal(
    r.error?.message,
    "too many new tabs from this agent in the last minute (at most 2, [mcp] open_per_minute)",
    "the third is over open_per_minute = 2",
  );
  Assert.ok((await c.call("agent-open", { url: `${PAGE}?d0`, tab: idOf(tab) })).ok, "load 1");
  r = await c.call("agent-open", { url: `${PAGE}?d1`, tab: idOf(tab) });
  Assert.equal(
    r.error?.message,
    "too many loads from this agent in the last minute (at most 1, [mcp] load_per_minute)",
    "the second load is over load_per_minute = 1",
  );
  McpHost.configure({ ...base, openPerMinute: 3, loadPerMinute: 2 });
  Assert.ok((await c.call("agent-open", { url: `${PAGE}?c3` })).ok, "raised: a third new tab");
  Assert.ok((await c.call("agent-open", { url: `${PAGE}?d2`, tab: idOf(tab) })).ok, "a 2nd load");
  c.close();
  McpHost.configure(before);
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  await setSwitches({});
});

add_task(async function test_agents_cannot_take_every_connection() {
  await setSwitches({ control: true, mcp: true });
  const agents = [];
  for (let i = 0; i < 4; i++) agents.push(await agentClient(`agent-${i}`));
  const fifth = new Client(/** @type {number} */ (VimmaControl.port));
  const refused = await fifth.handshake({ protocol: 2, role: "agent" });
  Assert.equal(refused?.error?.code, "busy", "a 5th agent connection is busy");
  const full = new Client(/** @type {number} */ (VimmaControl.port));
  // While MCP is on, a full connection asks first (decision 29 C): say yes.
  const welcomed = full.handshake({ protocol: 2, role: "full" });
  await answer({ kind: "once" });
  Assert.equal((await welcomed)?.type, "welcome", "while vimma-ctl still gets in");
  full.close();
  for (const a of agents) a.close();
  await setSwitches({});
});

// Spec: docs/specs/ship-vimma-ctl.md, behaviours 4-6. The discovery file names Vimma's version;
// an agent connection whose vimma-ctl is older, or names no version, still gets in and runs its
// commands, and Vimma shows a one-line notice; one as new as Vimma shows none.
add_task(async function test_an_older_vimma_ctl_gets_a_notice_and_still_works() {
  await setSwitches({ mcp: true });
  Assert.equal((await discovery()).version, VIMMA_VERSION, "the discovery file names the version");
  /** @type {string[]} */
  const notices = [];
  /** @param {GateEvent | undefined} e */
  const collect = (e) => {
    if (e?.kind === "notice") notices.push(e.text);
  };
  AgentGate.addListener(collect);
  try {
    // Names no other test uses: the notice is once per client name and version a session, and
    // the suite's other files connect as example-agent with no version.
    const hello = async (/** @type {string} */ name, /** @type {object} */ args) => {
      const c = new Client(/** @type {number} */ (VimmaControl.port));
      await c.handshake({ protocol: 2, role: "agent" });
      const hi = await c.call("agent-hello", { client: { name }, ...args });
      Assert.equal(hi.ok, true, `${JSON.stringify(args)}: welcomed all the same`);
      const ping = await c.call("agent-ping");
      Assert.equal(ping.ok, true, "and its commands run");
      return c;
    };

    const current = await hello("ctl-current", { ctl: VIMMA_VERSION });
    const older = await hello("ctl-older", { ctl: "0.0.1" });
    await until(() => notices.length === 1, "one notice, for the older client");
    Assert.equal(
      notices[0],
      `vimma-ctl 0.0.1 is older than Vimma ${VIMMA_VERSION}: agents get fewer tools until you update it`,
    );
    const unnamed = await hello("ctl-unnamed", {});
    await until(() => notices.length === 2, "and one for a client that names no version");
    Assert.equal(
      notices[1],
      `vimma-ctl is older than Vimma ${VIMMA_VERSION}: agents get fewer tools until you update it`,
    );
    const newer = await hello("ctl-newer", { ctl: "999.0.0" });
    Assert.equal(notices.length, 2, "none for a newer client");
    await until(
      () => document.getElementById(NOTICE_ID)?.textContent === notices[1],
      "the notice line shows it",
    );
    // Four agent connections at most: close these before the fifth.
    for (const c of [current, older, unnamed, newer]) c.close();
    await until(() => [current, older, unnamed, newer].every((c) => c.closed), "all closed");
    const bad = new Client(/** @type {number} */ (VimmaControl.port));
    await bad.handshake({ protocol: 2, role: "agent" });
    const refused = await bad.call("agent-hello", { client: { name: "x" }, ctl: "v1" });
    Assert.equal(refused?.error?.code, "invalid-args", "a ctl that is not a version is refused");
    Assert.equal(notices.length, 2, "and gives no notice");
    bad.close();
    // Once per client name and version a session: a client reconnecting, or an agent opening
    // connection after connection, cannot keep the notice line for itself.
    const again = await hello("ctl-older", { ctl: "0.0.1" });
    Assert.equal(notices.length, 2, "no second notice for the same client and version");
    again.close();
  } finally {
    AgentGate.removeListener(collect);
  }
  await setSwitches({});
});

// Spec ship-vimma-ctl, decision 9: an agent connects at its first call, so its question follows
// the hello at once. The notice waits until no question waits, so it never covers the line.
add_task(async function test_the_older_client_notice_waits_for_the_question_line() {
  await setSwitches({ mcp: true });
  const noticeText = () => document.getElementById(NOTICE_ID)?.textContent ?? "";
  const notice = document.getElementById(NOTICE_ID);
  if (notice) notice.textContent = "";
  const c = new Client(/** @type {number} */ (VimmaControl.port));
  await c.handshake({ protocol: 2, role: "agent" });
  await c.call("agent-hello", { client: { name: "held-agent" }, ctl: "0.0.1" });
  const tabs = c.call("agent-tabs");
  const q = await question();
  await new Promise((r) => setTimeout(r, 1000));
  Assert.ok(!noticeText().includes("is older than"), "no notice over the waiting question");
  AgentGate.answer(q.id, { kind: "once" });
  // A notice of what the agent did, shown just before the held one is due (1.6 s after the line
  // frees), is never cut short: it stays its 1.5 s, and the held one follows.
  const did = new Promise((r) => setTimeout(r, 1200)).then(() =>
    AgentGate.notify("the agent did something"),
  );
  Assert.equal((await tabs).ok, true, "the older client's call runs");
  await did;
  await new Promise((r) => setTimeout(r, 800));
  Assert.equal(noticeText(), "the agent did something", "the held notice waits for it");
  await until(
    () => noticeText().startsWith("vimma-ctl 0.0.1 is older than Vimma"),
    "the notice once the line is free",
  );
  c.close();
  await setSwitches({});
});
