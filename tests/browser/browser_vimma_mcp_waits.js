/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Issue #579 (docs/specs/mcp-forms.md F11, F12; security.md M28): an agent's call waits for the
// page only as long as the page is busy. After a click that loads nothing it returns once the
// page has gone quiet, not after a fixed second; a fill without a submission does not wait for
// a page at all; a page that loads counts as ready at DOMContentLoaded and a short quiet
// period, not at its load event. The submission allowance closes with the call as before, so a
// submission the page makes after the call, however it was started, is still cancelled.

"use strict";

/* global Client, tidyTask -- from head_vimma_control.js */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);

const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentGate.sys.mjs",
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
const WAITS = `${DIR}file_vimma_agent_waits.html`;
const PAGE = `${DIR}file_vimma_agent_page.html`;
const SLOW = `${DIR}file_vimma_agent_slow.sjs?page`;

registerCleanupFunction(async () => {
  Services.prefs.clearUserPref(MCP_ENABLED_PREF);
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

/** @param {boolean} on */
async function mcp(on) {
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, on);
  await VimmaControl.settled();
}

/** A tab in the agent workspace, loaded with `url`, hidden while the window shows `main`. */
async function openAgentTab(url = WAITS) {
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

/**
 * `command` with `args`, its question answered once; the response, and when it came.
 * @param {any} c @param {string} command @param {object} args
 */
async function call(c, command, args) {
  const id = c.request(command, args);
  AgentGate.answer((await question()).id, { kind: "once" });
  const r = await c.response(id);
  const at = Date.now();
  if (r.ok) {
    const v = validateMessage(r, { command });
    Assert.deepEqual(v.errors, [], `a valid ${command} result`);
  }
  return { r, at };
}

/** The list's elements by what they say. @param {any} c @param {any} tab */
async function labels(c, tab) {
  const { r } = await call(c, "agent-elements", { tab: idOf(tab) });
  Assert.ok(r.ok, "vimma_elements runs");
  /** @type {Record<string, string>} */
  const by = {};
  for (const line of r.result.elements.split("\n").slice(1, -1)) {
    const e = JSON.parse(line);
    if ("label" in e) by[e.text || e.name || e.caption] = e.label;
  }
  return by;
}

/** When the page saw the agent's step (ms since the epoch). @param {any} tab */
const pageAt = (tab) =>
  SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.at);

/** @param {any} tab */
const readyState = (tab) =>
  SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.readyState);

/**
 * The status of the next request to a URL starting with `prefix`, once every observer of it
 * has run: NS_BINDING_ABORTED when Vimma cancelled it.
 * @param {string} prefix
 * @returns {Promise<number>}
 */
function requestStatus(prefix) {
  return new Promise((resolve) => {
    const observe = (/** @type {any} */ subject) => {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      if (!channel.URI.spec.startsWith(prefix)) return;
      Services.obs.removeObserver(observe, "http-on-modify-request");
      Services.tm.dispatchToMainThread(() => resolve(channel.status));
    };
    Services.obs.addObserver(observe, "http-on-modify-request");
  });
}

addTidyTask(async function test_a_click_returns_once_the_page_is_quiet() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  const { r, at } = await call(c, "agent-activate", { tab: idOf(tab), label: by.Add });
  Assert.ok(r.ok, "the click ran");
  Assert.deepEqual(r.result.changed, ["text"], "the change is in the result");
  const ms = at - (await pageAt(tab));
  info(`vimma_activate, a click that updates the page at once: ${ms} ms after the click`);
  // The old wait was a fixed second after the click, then a look for changes.
  Assert.less(ms, 800, `the call returned a quiet period after the change, not a second (${ms})`);
});

addTidyTask(async function test_a_click_waits_for_the_request_it_started() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  const { r, at } = await call(c, "agent-activate", { tab: idOf(tab), label: by.Fetch });
  Assert.ok(r.ok, "the click ran");
  const ms = at - (await pageAt(tab));
  info(`vimma_activate, a click whose page updates when a 600 ms request answers: ${ms} ms`);
  Assert.deepEqual(r.result.changed, ["text"], "the update after the request is in the result");
  // At most the 2 s a busy page gets (AGENT_WAITS.busy), with room for a slow runner's IPC.
  Assert.less(ms, 2600, `and the call ended within its cap, not at a load deadline (${ms})`);
});

addTidyTask(async function test_a_click_that_changes_nothing_waits_less_than_before() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  const { r, at } = await call(c, "agent-activate", { tab: idOf(tab), label: by.Nothing });
  Assert.ok(r.ok, "the click ran");
  Assert.deepEqual(r.result.changed, [], "nothing changed");
  const ms = at - (await pageAt(tab));
  info(`vimma_activate, a click that changes nothing: ${ms} ms after the click`);
  // Past a hidden tab's one-second timer clamp, short of the old second and second more.
  Assert.greaterOrEqual(ms, 1000, `the call waited out a timer the page might have set (${ms})`);
  Assert.less(ms, 1900, `but not the old two seconds (${ms})`);
});

addTidyTask(async function test_a_fill_without_a_submission_does_not_wait_for_a_page() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  const { r, at } = await call(c, "agent-fill", {
    tab: idOf(tab),
    fields: [{ label: by.Name, value: "Ada" }],
  });
  Assert.ok(r.ok, "the fill ran");
  Assert.equal(r.result.filled, 1, "the field was filled");
  const ms = at - (await pageAt(tab));
  info(`vimma_fill without submit: ${ms} ms after the field was set`);
  Assert.less(ms, 500, `the call returned without a page wait (${ms})`);
});

addTidyTask(async function test_a_followed_link_is_ready_at_domcontentloaded() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  const start = Date.now();
  const { r, at } = await call(c, "agent-activate", { tab: idOf(tab), label: by["Slow page"] });
  Assert.ok(r.ok, "the link was followed");
  info(`vimma_activate, a link to a page whose load event takes 5 s: ${at - start} ms`);
  Assert.equal(r.result.navigated, true, "a page loaded");
  Assert.equal(r.result.url, SLOW, "the slow page");
  Assert.equal(r.result.loading, true, "the result came before its image, and says so");
  Assert.equal(await readyState(tab), "interactive", "the page had its DOMContentLoaded only");
});

addTidyTask(async function test_reading_a_loading_page_waits_for_domcontentloaded_only() {
  await mcp(true);
  const c = await agentClient();
  const opened = await call(c, "agent-open", { url: SLOW });
  Assert.ok(opened.r.ok, "vimma_open ran");
  const tab = agentTabs().find((t) => idOf(t) === opened.r.result.tab);
  await until(() => tab.linkedBrowser.currentURI.spec === SLOW, "the slow page is in the tab");
  const start = Date.now();
  const { r, at } = await call(c, "agent-read", { tab: opened.r.result.tab });
  Assert.ok(r.ok, `vimma_read_page ran: ${JSON.stringify(r.error)}`);
  info(`vimma_read_page on a page whose load event takes 5 s: ${at - start} ms`);
  Assert.ok(r.result.text.includes("A page whose image takes 5 s"), "the page's text was read");
  Assert.equal(await readyState(tab), "interactive", "before the page's load event");
});

addTidyTask(async function test_a_followed_link_by_keys_is_ready_at_domcontentloaded() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const list = await call(c, "agent-keys", { tab: idOf(tab), keys: "f" });
  Assert.ok(list.r.ok, "f lists the links");
  const line = list.r.result.links.split("\n").find((l) => l.includes('"Slow page"'));
  const label = line?.split(" ")[0];
  Assert.ok(label, "the slow page's link is listed");
  const start = Date.now();
  const { r, at } = await call(c, "agent-keys", { tab: idOf(tab), keys: `f${label}` });
  Assert.ok(r.ok, "the link was followed");
  info(`vimma_keys f<label> to a page whose load event takes 5 s: ${at - start} ms`);
  Assert.equal(r.result.url, SLOW, "the slow page");
  Assert.equal(r.result.loading, true, "the result came before its image, and says so");
  Assert.equal(await readyState(tab), "interactive", "the page had its DOMContentLoaded only");
});

addTidyTask(async function test_a_submission_the_page_makes_after_a_click_is_still_cancelled() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  // A plain button whose script submits a form 1.5 s later, after the call has returned.
  const sent = requestStatus(`${PAGE}?late`);
  const { r } = await call(c, "agent-activate", { tab: idOf(tab), label: by["Submit late"] });
  Assert.ok(r.ok, "the click ran");
  Assert.equal(r.result.navigated, false, "nothing loaded during the call");
  Assert.equal(await sent, Cr.NS_BINDING_ABORTED, "the page's later submission was cancelled");
  Assert.equal(tab.linkedBrowser.currentURI.spec, WAITS, "the page stayed");
});

addTidyTask(async function test_an_allowed_submission_the_page_holds_back_is_cancelled_later() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  // The question allows this button's submission; the page cancels it and sends the same form
  // again 1.5 s later, to the same destination, after the call: no longer the asked one (M28).
  const sent = requestStatus(`${PAGE}?order`);
  const id = c.request("agent-activate", { tab: idOf(tab), label: by["Order held"] });
  const q = await question();
  Assert.equal(q.what.submit?.host, "example.com", "asked as a submission");
  AgentGate.answer(q.id, { kind: "once" });
  const r = await c.response(id);
  Assert.ok(r.ok, "the click ran");
  Assert.equal(r.result.navigated, false, "nothing loaded during the call");
  Assert.equal(await sent, Cr.NS_BINDING_ABORTED, "the page's resubmission was cancelled");
  Assert.equal(tab.linkedBrowser.currentURI.spec, WAITS, "the page stayed");
});

/**
 * `agent-activate` of a submit button, its submission question answered once.
 * @param {any} c @param {any} tab @param {string} label
 */
async function submitClick(c, tab, label) {
  const id = c.request("agent-activate", { tab: idOf(tab), label });
  const q = await question();
  Assert.equal(q.what.submit?.host, "example.com", "asked as a submission");
  AgentGate.answer(q.id, { kind: "once" });
  return c.response(id);
}

addTidyTask(async function test_an_allowed_submission_to_a_slow_server_goes_through() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  // The destination answers after 3 s, long after the page went quiet: the call waits for that
  // load with the allowance open, and the browser keeps running meanwhile.
  const slow = `${DIR}file_vimma_agent_slow.sjs?wait=3000`;
  const sent = requestStatus(slow);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 100);
  const start = Date.now();
  const r = await submitClick(c, tab, by["Order slow"]);
  clearInterval(timer);
  const ms = Date.now() - start;
  info(`vimma_activate of a submission whose server answers after 3 s: ${ms} ms, ${ticks} ticks`);
  Assert.ok(r.ok, `the click ran: ${JSON.stringify(r.error)}`);
  Assert.equal(await sent, Cr.NS_OK, "the asked submission was sent");
  Assert.equal(r.result.navigated, true, "and its page loaded within the call");
  Assert.equal(r.result.url, slow, "the destination");
  Assert.greater(ticks, ms / 200, "the parent's event loop ran during the wait");
});

addTidyTask(async function test_a_page_kept_busy_does_not_keep_the_allowance_open() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  // The page holds back the allowed submission, keeps a request open so that it never looks
  // settled, and sends the form again 1.5 s later: the allowance closed a second after the
  // click ran, as it always did, so that is the page's own submission (M28).
  const sent = requestStatus(`${PAGE}?busy`);
  const r = await submitClick(c, tab, by["Order busy"]);
  Assert.ok(r.ok, "the click ran");
  Assert.equal(await sent, Cr.NS_BINDING_ABORTED, "the page's resubmission was cancelled");
  Assert.equal(tab.linkedBrowser.currentURI.spec, WAITS, "the page stayed");
});
