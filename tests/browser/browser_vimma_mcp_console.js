/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/mcp-forms.md, sub-PR 5: `vimma_console` (`agent-console`) returns an agent
// tab's script errors, its page's console.error and console.warn calls, and its failed requests
// (F22), read from Firefox's own caches and an http-on-stop-request observer, without running
// any code in the page (F23; security.md M30), capped, newest first and inside the
// untrusted-content delimiters (F24; M31), at most 30 a connection a minute (F26; M32).

"use strict";

/* global Client -- from head_vimma_control.js */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);

const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentGate.sys.mjs",
);
const { VimmaActors } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/actors/VimmaActors.sys.mjs",
);
const { AgentConsole } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentConsole.sys.mjs",
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
const { validateMessage } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/index.mjs",
);
const { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/agent.mjs",
);

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = `${DIR}file_vimma_agent_console.html`;
const SJS = `${DIR}file_vimma_agent_console.sjs`;
const NOTICE_ID = "vimma-notice";
const ASK_TIMEOUT = "vimma.mcp.askTimeoutMs";

registerCleanupFunction(async () => {
  Services.prefs.clearUserPref(MCP_ENABLED_PREF);
  Services.prefs.clearUserPref(ASK_TIMEOUT);
  await VimmaControl.settled();
  ww().switchTo({ id: mainId() });
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  for (const t of gBrowser.tabs.slice(1)) BrowserTestUtils.removeTab(t);
});

const agent = () => /** @type {any} */ (WorkspaceStore.agent);
const agentTabs = () =>
  gBrowser.tabs.filter((t) => t.userContextId === agent().userContextId && !t.closing);
const idOf = (/** @type {any} */ tab) => String(tab.linkedBrowser.browserId);
const ww = () => WindowWorkspaces.get(window);
const mainId = () => ww().model.workspaces.find((w) => w.name === "main")?.id;
const noticeText = () => document.getElementById(NOTICE_ID)?.textContent ?? "";

/** @param {() => boolean} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);

async function mcp(on) {
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, on);
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

/** An agent connection, after its agent-hello. */
async function agentClient(name = "example-agent") {
  const c = new Client(/** @type {number} */ (VimmaControl.port));
  await c.handshake({ protocol: 2, role: "agent" });
  await c.call("agent-hello", { client: { name } });
  return c;
}

/** The oldest waiting question, once there is one. */
async function question() {
  await until(() => AgentGate.waiting.length > 0, "a question waits");
  return AgentGate.waiting[0];
}

/**
 * `agent-console` on `tab`, answered with `answer` (null: not asked, a grant runs it).
 * @param {any} c @param {any} tab @param {object} [args] @param {object | null} [answer]
 */
async function readConsole(c, tab, args = {}, answer = { kind: "once" }) {
  const id = c.request("agent-console", { tab: idOf(tab), ...args });
  if (answer) {
    const q = await question();
    Assert.equal(q.tool, "vimma_console", "agent-console asks as vimma_console");
    AgentGate.answer(q.id, answer);
  }
  const r = await c.response(id);
  if (r.ok) {
    const v = validateMessage(r, { command: "agent-console" });
    Assert.deepEqual(v.errors, [], "a valid agent-console result");
  }
  return r;
}

/** The JSON lines inside one list's delimiters. @param {string} wrapped */
function lines(wrapped) {
  Assert.ok(wrapped.startsWith(`${UNTRUSTED_OPEN}\n`), "the list opens the delimiters");
  Assert.ok(wrapped.endsWith(`\n${UNTRUSTED_CLOSE}`), "and closes them");
  const inner = wrapped.slice(UNTRUSTED_OPEN.length + 1, -UNTRUSTED_CLOSE.length - 1);
  return inner ? inner.split("\n").map((l) => JSON.parse(l)) : [];
}

/** Waits until the fixture's own requests and its uncaught error are in. @param {any} c @param {any} tab */
async function settled(c, tab) {
  let r;
  await until(() => {
    const failed = AgentConsole._requestsForTests(tab.linkedBrowser.browserId);
    return failed.length >= 2;
  }, "the fixture's failed requests are logged");
  // The uncaught error is thrown from a timer after the load.
  await SpecialPowers.spawn(
    tab.linkedBrowser,
    [],
    () => new Promise((r) => content.setTimeout(r, 100)),
  );
  r = await readConsole(c, tab);
  return r;
}

add_task(async function test_console_returns_uncaught_errors_and_console_errors() {
  await mcp(true);
  const tab = await openAgentTab();
  const before = { selected: gBrowser.selectedTab };
  const c = await agentClient();
  const r = await settled(c, tab);
  Assert.ok(r.ok, `vimma_console runs: ${JSON.stringify(r.error)}`);
  Assert.equal(r.result.url, PAGE, "the page");
  Assert.equal(r.result.title, "Console agent fixture", "its title");
  Assert.ok(Math.abs(r.result.time - Date.now()) < 60000, "Vimma's clock");
  const errors = lines(r.result.errors);
  const find = (/** @type {(e: any) => boolean} */ f) => errors.find(f);
  const thrown = find((e) => e.message.includes("boom from the fixture"));
  Assert.equal(thrown?.level, "error", "the uncaught error, as an error");
  Assert.equal(thrown?.source, "script", "from a script");
  Assert.equal(thrown?.file, PAGE, "naming its file");
  Assert.ok(thrown?.line > 0, "and line");
  const logged = find((e) => e.source === "console" && e.message.startsWith("Failed to save"));
  Assert.equal(
    logged?.message,
    "Failed to save 42 true null [object] [object]",
    "console.error with its primitives, any other argument as its type (F23)",
  );
  Assert.ok(
    find((e) => e.source === "console" && e.level === "warn" && e.message === "deprecated call"),
    "console.warn",
  );
  Assert.ok(
    !find((e) => /plain (log|info) line/.test(e.message)),
    "never console.log or console.info (F22)",
  );
  Assert.ok(
    find((e) => e.message === "error in the frame of another site"),
    "a frame of another site, read in its own process",
  );
  const times = errors.map((e) => e.time);
  Assert.deepEqual(
    times,
    [...times].sort((a, b) => b - a),
    "newest first",
  );
  Assert.deepEqual({ selected: gBrowser.selectedTab }, before, "the window kept its tab (M25)");
  Assert.ok(tab.hidden, "the agent tab stayed hidden");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

add_task(async function test_console_returns_failed_requests_with_status() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const r = await settled(c, tab);
  const requests = lines(r.result.requests);
  const of = (/** @type {string} */ part) => requests.filter((q) => q.url.includes(part));
  Assert.deepEqual(
    of("status=500").map((q) => [q.method, q.status, q.type]),
    [["POST", 500, "fetch"]],
    "a 500 with its method and type",
  );
  Assert.deepEqual(
    of("missing.json").map((q) => [q.method, q.status]),
    [["GET", 404]],
    "a 404",
  );
  Assert.equal(of("status=200").length, 0, "neither a request that succeeded nor one aborted");
  // `since`: only what came after the last read, such as a request the page makes now.
  await SpecialPowers.spawn(tab.linkedBrowser, [`${SJS}?status=503&late=1`], async (url) => {
    await content.fetch(url).catch(() => {});
  });
  await until(
    () =>
      AgentConsole._requestsForTests(tab.linkedBrowser.browserId).some((q) =>
        q.url.includes("late=1"),
      ),
    "the new failed request is logged",
  );
  const next = await readConsole(c, tab, { since: r.result.time });
  const after = lines(next.result.requests);
  Assert.deepEqual(
    after.map((q) => [q.status, q.url]),
    [[503, `${SJS}?status=503&late=1`]],
    "since: only the request after the last read",
  );
  Assert.deepEqual(lines(next.result.errors), [], "and no older error");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

add_task(async function test_console_runs_no_page_code() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const r = await settled(c, tab);
  Assert.ok(r.ok, "vimma_console runs");
  const touched = await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    Array.from(content.wrappedJSObject.touched),
  );
  Assert.deepEqual(touched, [], "no getter, toString or proxy trap of the page ran (M30)");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

add_task(async function test_a_noisy_page_sends_one_replys_worth() {
  await mcp(true);
  const url = `${PAGE}?noisy=400`;
  const tab = await openAgentTab(url);
  // Each frame answers only its newest entries after `since`, cut, and counts the rest, so a page
  // cannot make the parent copy and sort everything it logged (F24).
  const answers = await VimmaActors.agentConsole(tab.linkedBrowser, 5000, { since: 0, max: 100 });
  const top = answers[0];
  Assert.equal(top.entries.length, 100, "the top frame answers 100 entries");
  Assert.ok(top.omitted >= 300, `and counts the rest: ${top.omitted}`);
  Assert.ok(
    top.entries.every((e) => e.message.length <= 1000),
    "each message cut in the child",
  );
  const c = await agentClient();
  const r = await readConsole(c, tab);
  Assert.equal(lines(r.result.errors).length, 100, "the reply holds 100 errors");
  Assert.ok(r.result.dropped >= 300, `and counts what the frames left out: ${r.result.dropped}`);
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

add_task(async function test_console_only_of_agent_tabs_and_web_pages() {
  await mcp(true);
  const c = await agentClient();
  // A tab of the user's own workspace is unknown to the agent (M2), and nothing is asked.
  const mine = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  const r = await c.call("agent-console", { tab: idOf(mine) });
  Assert.equal(r.error?.code, "invalid-args", "the user's tab is refused");
  Assert.equal(AgentGate.waiting.length, 0, "unasked");
  // Its failed requests are never logged: only agent tabs' are.
  await until(
    () => !!mine.linkedBrowser.browsingContext?.currentWindowGlobal,
    "the user's page is up",
  );
  await SpecialPowers.spawn(mine.linkedBrowser, [`${SJS}?status=500`], async (url) => {
    await content.fetch(url).catch(() => {});
  });
  Assert.deepEqual(
    AgentConsole._requestsForTests(mine.linkedBrowser.browserId),
    [],
    "the user's own tab is not watched",
  );
  BrowserTestUtils.removeTab(mine);
  // A tab moved into the agent workspace may show a page that is not on the web.
  const about = gBrowser.addTab("about:robots", {
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(about.linkedBrowser, false, "about:robots");
  await until(() => about.hidden, "the agent tab is hidden in its workspace");
  const x = await c.call("agent-console", { tab: idOf(about) });
  Assert.equal(AgentGate.waiting.length, 0, "before anything is asked");
  Assert.equal(x.error?.code, "failed", "an about: page is refused");
  Assert.equal(x.error?.message, "console output is read only of http and https pages");
  BrowserTestUtils.removeTab(about);
  c.close();
  await mcp(false);
});

add_task(async function test_request_log_cleared_when_the_tab_closes_or_mcp_turns_off() {
  await mcp(true);
  let tab = await openAgentTab();
  let id = tab.linkedBrowser.browserId;
  await until(() => AgentConsole._requestsForTests(id).length >= 2, "logged");
  BrowserTestUtils.removeTab(tab);
  await until(() => !AgentConsole._tabsForTests().includes(id), "a closed tab's log goes (F24)");
  tab = await openAgentTab();
  id = tab.linkedBrowser.browserId;
  await until(() => AgentConsole._requestsForTests(id).length >= 2, "logged");
  await mcp(false);
  Assert.deepEqual(AgentConsole._tabsForTests(), [], ":mcp off clears every log (F24)");
  // While MCP is off nothing is logged.
  await SpecialPowers.spawn(tab.linkedBrowser, [`${SJS}?status=500`], async (url) => {
    await content.fetch(url).catch(() => {});
  });
  Assert.deepEqual(AgentConsole._requestsForTests(id), [], "nothing is logged while off");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_console_under_a_grant_notice_log_and_rate() {
  await mcp(true);
  Services.prefs.setIntPref(ASK_TIMEOUT, 200);
  const tab = await openAgentTab();
  const c = await agentClient("claude-code");
  let r = await readConsole(c, tab, {}, { kind: "grant", minutes: 12 });
  Assert.ok(r.ok, "a grant of vimma_console");
  r = await readConsole(c, tab, {}, null);
  Assert.ok(r.ok, "the next read runs unasked");
  await until(
    () => noticeText().startsWith('claude-code read the errors of "Console agent fixture"'),
    "with a notice naming the page",
  );
  Assert.equal(AgentGate.log[0].tool, "vimma_console", "and a row in :mcp log (M23)");
  Assert.equal(AgentGate.log[0].outcome, "grant", "that ran under the grant");
  // The grant covers screenshots too (mcp-grants G1).
  const shot = await c.call("agent-screenshot", { tab: idOf(tab) });
  Assert.notEqual(shot.error?.code, "denied", "a screenshot runs under it, unasked");
  Assert.equal(AgentGate.waiting.length, 0, "with no question");
  // 30 a minute, counted when asked (F26): 2 so far.
  let busy = null;
  for (let i = 0; i < 29 && !busy; i++) {
    const x = await c.call("agent-console", { tab: idOf(tab) });
    if (!x.ok) busy = { i, x };
  }
  Assert.equal(busy?.i, 28, "the 31st read in a minute is refused");
  Assert.equal(busy?.x.error.reason, "busy", "as busy");
  Assert.equal(AgentGate.log[0].outcome, "busy", "and logged");
  c.close();
  Services.prefs.clearUserPref(ASK_TIMEOUT);
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});
