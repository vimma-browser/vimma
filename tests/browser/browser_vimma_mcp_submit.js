/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/mcp-forms.md, sub-PR 2: a click that submits a form asks every time, also
// under a `vimma_activate` grant, naming the form's method, destination and fields, and its yes
// makes no grant (F15; security.md M28). A form the page's script submits by itself after an
// agent's click is cancelled, and the result says so (F16); the user's own submission in an
// agent tab, and a page's own with no agent step in it, go through.

"use strict";

/* global Client, tidyTask -- from head_vimma_control.js */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);

const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentGate.sys.mjs",
);
const { AgentAct } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentAct.sys.mjs",
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

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const CLICK = `${DIR}file_vimma_agent_click.html`;
const PAGE = `${DIR}file_vimma_agent_page.html`;
const ASK_TIMEOUT = "vimma.mcp.askTimeoutMs";

registerCleanupFunction(async () => {
  AgentAct._settleMs = null;
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

/** @param {() => boolean} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);

async function mcp(on) {
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, on);
  await VimmaControl.settled();
}

/** A tab in the agent workspace, loaded with `url`, hidden while the window shows `main`. */
async function openAgentTab(url = CLICK) {
  const tab = gBrowser.addTab(url, {
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  await until(() => tab.hidden, "the agent tab is hidden in its workspace");
  return tab;
}

/** The connections the running task opened. @type {any[]} */
const clients = [];

/** What a task leaves when it ends, passed or not (tidyTask): this file's state at its start. */
async function putBack() {
  for (const c of clients.splice(0)) c.close();
  Services.prefs.clearUserPref(ASK_TIMEOUT);
  AgentAct._settleMs = null;
  if (ww().model.active !== mainId()) ww().switchTo({ id: mainId() });
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  for (const t of gBrowser.tabs.slice(1)) BrowserTestUtils.removeTab(t);
  await mcp(false);
}

/** add_task, with putBack after the task however it ends. @param {() => Promise<void>} task */
const addTidyTask = (task) => add_task(tidyTask(task, putBack));

/** An agent connection, after its agent-hello. */
async function agentClient(name = "example-agent") {
  const c = new Client(/** @type {number} */ (VimmaControl.port));
  clients.push(c);
  await c.handshake({ protocol: 2, role: "agent" });
  await c.call("agent-hello", { client: { name } });
  return c;
}

/** The oldest waiting question, once there is one. */
async function question() {
  await until(() => AgentGate.waiting.length > 0, "a question waits");
  return AgentGate.waiting[0];
}

/** The list's elements by what they say. @param {any} c @param {any} tab */
async function labels(c, tab) {
  const id = c.request("agent-elements", { tab: idOf(tab) });
  AgentGate.answer((await question()).id, { kind: "once" });
  const r = await c.response(id);
  Assert.ok(r.ok, "vimma_elements runs");
  /** @type {Record<string, string>} */
  const by = {};
  for (const line of r.result.elements.split("\n").slice(1, -1)) {
    const e = JSON.parse(line);
    if ("label" in e) by[e.text || e.name || e.caption] = e.label;
  }
  return by;
}

/**
 * `agent-activate` on `tab`, answered with `answer` (null: not asked, a grant runs it).
 * @param {any} c @param {any} tab @param {string} label @param {object | null} [answer]
 */
async function activate(c, tab, label, answer = { kind: "once" }) {
  const id = c.request("agent-activate", { tab: idOf(tab), label });
  if (answer) {
    const q = await question();
    Assert.equal(q.tool, "vimma_activate", "agent-activate asks as vimma_activate");
    AgentGate.answer(q.id, answer);
  }
  const r = await c.response(id);
  if (r.ok) {
    const v = validateMessage(r, { command: "agent-activate" });
    Assert.deepEqual(v.errors, [], "a valid agent-activate result");
  }
  return r;
}

add_task(async function setup() {
  // The default wait after a click: a page's submission a moment later is still in its result.
  AgentAct._settleMs = null;
});

addTidyTask(async function test_submit_asks_under_a_grant() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient("claude-code");
  const by = await labels(c, tab);
  let r = await activate(c, tab, by["Add to list"], { kind: "grant", minutes: 12 });
  Assert.ok(r.ok, "a grants vimma_activate");
  const id = c.request("agent-activate", { tab: idOf(tab), label: by.Search });
  const q = await question();
  Assert.equal(q.tool, "vimma_activate", "a submit button asks, under the grant (M28)");
  Assert.deepEqual(
    q.what.submit,
    { method: "get", action: PAGE, host: "example.com", fields: 2 },
    "with the form's method, destination and the fields it sends",
  );
  // A grant answer to a submit is that one submission.
  AgentGate.answer(q.id, { kind: "grant", minutes: 60 });
  r = await c.response(id);
  Assert.ok(r.ok, "the submit ran");
  Assert.equal(r.result.navigated, true, "the form was sent");
  Assert.equal(r.result.url, `${PAGE}?q=cats&from=fixture`, "to its destination");
  Assert.ok(!("blocked" in r.result), "the submission the user allowed was not stopped");
  Assert.ok(
    AgentGate.grants().every((g) => g.until < Date.now() + 13 * 60_000),
    "the yes to a submit made no grant of 60 min",
  );
  Assert.ok(
    AgentGate.log[0].detail.endsWith(`button "Search" → GET ${PAGE} (2 fields)`),
    ":mcp log names the destination",
  );
  // Back on the form: the next submit asks again.
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, CLICK);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, CLICK);
  const again = await labels(c, tab);
  const next = c.request("agent-activate", { tab: idOf(tab), label: again.Search });
  const q2 = await question();
  Assert.ok(q2.what.submit, "asked again");
  AgentGate.answer(q2.id, { kind: "deny" });
  r = await c.response(next);
  Assert.equal(r.error?.reason, "user", "a no");
  Assert.equal(tab.linkedBrowser.currentURI.spec, CLICK, "sends nothing");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_page_script_submit_after_a_click_is_cancelled() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  for (const button of ["Save draft", "Save later"]) {
    const r = await activate(c, tab, by[button]);
    Assert.ok(r.ok, `${button}: the click ran`);
    Assert.equal(r.result.navigated, false, `${button}: the form was not sent (M28)`);
    Assert.equal(r.result.blocked, "example.com", `${button}: the result says Vimma stopped it`);
    Assert.equal(tab.linkedBrowser.currentURI.spec, CLICK, `${button}: the page stayed`);
  }
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_a_submit_sent_elsewhere_than_asked_is_stopped() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  const id = c.request("agent-activate", { tab: idOf(tab), label: by.Send });
  const q = await question();
  Assert.equal(q.what.submit?.host, "example.com", "asked as a submission to example.com");
  AgentGate.answer(q.id, { kind: "once" });
  const r = await c.response(id);
  Assert.ok(r.ok, "the click ran");
  Assert.equal(r.result.navigated, false, "the form the page sent elsewhere was not sent (M28)");
  Assert.equal(r.result.blocked, "example.org", "the result names where it was going");
  Assert.equal(tab.linkedBrowser.currentURI.spec, CLICK, "the page stayed");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_a_submit_listener_moving_the_destination_is_stopped() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  const id = c.request("agent-activate", { tab: idOf(tab), label: by.Post });
  const q = await question();
  Assert.equal(q.what.submit?.host, "example.com", "asked as a submission to example.com");
  AgentGate.answer(q.id, { kind: "once" });
  const r = await c.response(id);
  Assert.equal(r.result.navigated, false, "the form its submit listener moved was not sent");
  Assert.equal(r.result.blocked, "example.org", "the result names where it was going");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(
  async function test_page_submits_after_a_cached_verdict_or_through_a_dialog_are_stopped() {
    await mcp(true);
    const tab = await openAgentTab();
    const c = await agentClient();
    const by = await labels(c, tab);
    for (const button of ["Resend", "Close"]) {
      const r = await activate(c, tab, by[button]);
      Assert.ok(r.ok, `${button}: the click ran`);
      Assert.equal(r.result.navigated, false, `${button}: the page's submission was not sent`);
      Assert.equal(r.result.blocked, "example.com", `${button}: the result says Vimma stopped it`);
      Assert.equal(tab.linkedBrowser.currentURI.spec, CLICK, `${button}: the page stayed`);
    }
    c.close();
    BrowserTestUtils.removeTab(tab);
    await mcp(false);
  },
);

addTidyTask(async function test_an_allowed_submit_follows_its_redirect() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  const r = await activate(c, tab, by.Checkout);
  Assert.ok(r.ok, "the submit ran");
  Assert.ok(!("blocked" in r.result), "its redirect was not taken for an unasked submission");
  Assert.equal(r.result.url, `${PAGE}?redirected`, "the tab followed the redirect");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_the_users_earlier_input_does_not_cover_an_agents_click() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  // The user clicks in the page, then within the activation window the agent clicks a button
  // whose script submits a form.
  ww().switchTo({ id: agent().id });
  await until(() => gBrowser.selectedTab === tab, "the agent tab is in front");
  await BrowserTestUtils.synthesizeMouseAtCenter("#list", {}, tab.linkedBrowser);
  const r = await activate(c, tab, by["Save draft"]);
  Assert.ok(r.ok, "the click ran");
  Assert.equal(r.result?.navigated, false, "the user's earlier click does not send the form");
  Assert.equal(r.result?.blocked, "example.com", "Vimma stopped it");
  ww().switchTo({ id: mainId() });
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_users_own_submit_in_an_agent_tab_goes_through() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  Assert.ok((await activate(c, tab, by["Add to list"])).ok, "an agent's step in the page");
  // The user looks at the tab and presses the page's own button with the mouse.
  ww().switchTo({ id: agent().id });
  await until(() => gBrowser.selectedTab === tab, "the agent tab is in front");
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, `${PAGE}?draft`);
  await BrowserTestUtils.synthesizeMouseAtCenter("#save", {}, tab.linkedBrowser);
  await loaded;
  Assert.ok(true, "the user's own submission went through");
  ww().switchTo({ id: mainId() });
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_a_page_submitting_with_no_agent_step_is_untouched() {
  await mcp(true);
  const tab = await openAgentTab();
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, `${PAGE}?draft`);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    content.document.getElementById("draft").submit(),
  );
  await loaded;
  Assert.ok(true, "a page's own submission, with no agent step, went through");
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});
