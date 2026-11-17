/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/mcp-consequence.md K2, K3 (security.md M28): a form checkpoint judges what the
// form really sends, also what a form-associated custom element holds, whose name and value its
// page script keeps (issue #1053). Such an entry is named but its value never read, and it asks
// under a grant; so does a form whose page handles `formdata`, as its script may add to what is
// sent. A component with no name and a plain value sends nothing, and that form runs unasked.

"use strict";

/* global Client, tidyTask -- from head_vimma_control.js */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);

const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/AgentGate.sys.mjs",
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
const { questionLine } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/agent-prompt.mjs",
);

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const FACE = `${DIR}file_vimma_agent_face_form.html`;
const PAGE = `${DIR}file_vimma_agent_page.html`;

registerCleanupFunction(async () => {
  Services.prefs.clearUserPref(MCP_ENABLED_PREF);
  await VimmaControl.settled();
  ww().switchTo({ id: mainId() });
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  for (const t of gBrowser.tabs.slice(1)) BrowserTestUtils.removeTab(t);
});

const agent = () => /** @type {ContainedWorkspace} */ (WorkspaceStore.agent);
const agentTabs = () =>
  gBrowser.tabs.filter((t) => t.userContextId === agent().userContextId && !t.closing);
const idOf = (/** @type {MozTabbrowserTab} */ tab) => String(tab.linkedBrowser.browserId);
const ww = () => /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(window));
const mainId = () =>
  /** @type {string} */ (
    ww().model.workspaces.find((/** @type {WorkspaceState} */ w) => w.name === "main")?.id
  );

/** @param {() => unknown} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);

/** @param {boolean} on */
async function mcp(on) {
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, on);
  await VimmaControl.settled();
}

/** A tab in the agent workspace, loaded with `url`, hidden while the window shows `main`. */
async function openAgentTab(url = FACE) {
  const tab = gBrowser.addTab(url, {
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  await until(() => tab.hidden, "the agent tab is hidden in its workspace");
  return tab;
}

/** The connections the running task opened. @type {Client[]} */
const clients = [];

/** What a task leaves when it ends, passed or not (tidyTask). */
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
async function agentClient(name = "claude-code") {
  const c = new Client(/** @type {number} */ (VimmaControl.port));
  clients.push(c);
  await c.handshake({ protocol: 2, role: "agent" });
  await c.call("agent-hello", { client: { name } });
  return c;
}

/**
 * The list's elements by what they say; the first list of the connection is answered with a
 * grant of 15 minutes, which covers every tool after it (mcp-grants G1).
 * @param {Client} c @param {MozTabbrowserTab} tab
 */
async function grantedLabels(c, tab) {
  const id = c.request("agent-elements", { tab: idOf(tab), full: true });
  if (!AgentGate.grants().length) {
    await until(() => AgentGate.waiting.length > 0, "the list asks");
    AgentGate.answer(/** @type {AskedQuestion} */ (AgentGate.waiting[0]).id, {
      kind: "grant",
      minutes: 15,
    });
  }
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
 * Clicks `label` under the grant: the question it asks, or null when it ran unasked, with the
 * response's id to answer it by.
 * @param {Client} c @param {MozTabbrowserTab} tab @param {string} label
 */
async function press(c, tab, label) {
  const id = c.request("agent-activate", { tab: idOf(tab), label });
  let done = false;
  const answered = c.response(id).then((r) => ((done = true), r));
  await until(() => AgentGate.waiting.length > 0 || done, "asked, or done");
  const q = /** @type {AskedQuestion | undefined} */ (AgentGate.waiting[0]) ?? null;
  return { q, response: () => answered };
}

/** Back to the page, and its labels. @param {Client} c @param {MozTabbrowserTab} tab */
async function reload(c, tab) {
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, FACE);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, FACE);
  return grantedLabels(c, tab);
}

addTidyTask(async function test_a_component_holding_typed_text_asks_under_a_grant() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  let by = await grantedLabels(c, tab);
  const filled = await c.call("agent-fill", {
    tab: idOf(tab),
    fields: [{ label: by["Note text"], value: "Meet me at noon" }],
  });
  Assert.ok(filled.ok, "the fill of the component's own field runs under the grant");
  let { q, response } = await press(c, tab, by["Send note"]);
  Assert.ok(q, "a form whose component holds the typed text asks under the grant (K2)");
  if (!q) {
    info(`it ran unasked: ${(await response()).result?.url}`);
    return;
  }
  Assert.equal(q.what.submit?.fields, 2, "the question counts the component's entry");
  Assert.deepEqual(
    q.what.sent?.fields,
    [
      { name: "qty", value: "1" },
      { name: "note", opaque: true },
    ],
    "it names the entry and reads no value of it",
  );
  Assert.ok(!JSON.stringify(q.what).includes("noon"), "the typed text is in no question");
  Assert.ok(
    questionLine(q, { grantMinutes: 15 }).label.includes("note (not read)"),
    "the line says the value is not read",
  );
  Assert.ok(!q.what.here, "and offers no a: an allowance must not rest on a value unread (K5)");
  AgentGate.answer(q.id, { kind: "deny" });
  Assert.equal((await response()).error?.reason, "user", "a no");
  Assert.equal(tab.linkedBrowser.currentURI.spec, FACE, "sends nothing");

  // A yes sends what the question named.
  by = await reload(c, tab);
  await c.call("agent-fill", {
    tab: idOf(tab),
    fields: [{ label: by["Note text"], value: "Meet me at noon" }],
  });
  ({ q, response } = await press(c, tab, by["Send note"]));
  Assert.ok(q, "asked again");
  AgentGate.answer(/** @type {AskedQuestion} */ (q).id, { kind: "once" });
  const r = await response();
  Assert.ok(r.ok, "a yes sends it");
  Assert.equal(r.result.url, `${PAGE}?qty=1&note=Meet+me+at+noon`, "with the component's entry");
});

addTidyTask(async function test_a_component_without_a_name_sends_nothing_and_runs() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await grantedLabels(c, tab);
  const { q, response } = await press(c, tab, by.Save);
  Assert.equal(q, null, "a component with no name sends no text: the grant runs it (K1)");
  const r = await response();
  Assert.ok(r.ok, "it runs");
  Assert.equal(r.result.url, `${PAGE}?qty=2`, "and sends only the quantity");
});

addTidyTask(async function test_a_component_sending_a_file_or_entries_asks() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  let by = await grantedLabels(c, tab);
  /** @type {[string, object[]][]} */
  const cases = [
    ["Attach", [{ name: "doc", file: true, opaque: true }]],
    // A FormData value sends its entries under their own names, whatever the component's name.
    ["Continue", [{ name: "entry", opaque: true }]],
  ];
  for (const [button, fields] of cases) {
    const { q, response } = await press(c, tab, by[button]);
    Assert.ok(q, `${button}: asks under the grant`);
    if (!q) {
      await response();
      by = await reload(c, tab);
      continue;
    }
    Assert.deepEqual(q.what.sent?.fields, fields, `${button}: names what is sent`);
    Assert.equal(q.what.submit?.fields, 1, `${button}: and counts it`);
    Assert.ok(!JSON.stringify(q.what).includes("typed by"), `${button}: reads no value`);
    Assert.ok(!q.what.here, `${button}: offers no a`);
    AgentGate.answer(q.id, { kind: "deny" });
    Assert.equal((await response()).error?.reason, "user", `${button}: a no`);
    Assert.equal(tab.linkedBrowser.currentURI.spec, FACE, `${button}: sends nothing`);
  }
});

addTidyTask(async function test_a_form_whose_page_handles_formdata_asks() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await grantedLabels(c, tab);
  /** How often the page's own formdata listener ran: it counts on the body. */
  const fired = () =>
    SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.body.dataset.formdata ?? "0");
  const { q, response } = await press(c, tab, by.Update);
  Assert.ok(q, "a form whose script may add to what it sends asks under the grant (K3)");
  if (!q) {
    await response();
    return;
  }
  Assert.equal(q.what.sent?.unread, true, "the question says the page's script adds to it");
  Assert.ok(
    questionLine(q, { grantMinutes: 15 }).label.includes("what the page adds"),
    "and so does its line",
  );
  Assert.ok(!q.what.here, "it offers no a");
  Assert.equal(await fired(), "0", "judging it ran none of the page's formdata listeners");
  AgentGate.answer(q.id, { kind: "deny" });
  Assert.equal((await response()).error?.reason, "user", "a no");
  Assert.equal(tab.linkedBrowser.currentURI.spec, FACE, "sends nothing");
});

/**
 * The "Refresh" form, slotted into a closed shadow root, with a page `formdata` listener at
 * `listen` on the event's path (the slot, that root, the document, the window), asks.
 * @param {string} listen
 */
async function listenerOnThePathAsks(listen) {
  await mcp(true);
  const tab = await openAgentTab(`${FACE}?listen=${listen}`);
  const c = await agentClient();
  const by = await grantedLabels(c, tab);
  const { q, response } = await press(c, tab, by.Refresh);
  Assert.ok(q, `${listen}: the form asks under the grant (K3)`);
  if (!q) {
    info(`${listen}: it ran unasked: ${(await response()).result?.url}`);
    return;
  }
  Assert.equal(q.what.sent?.unread, true, `${listen}: the page's script adds to it`);
  Assert.ok(
    questionLine(q, { grantMinutes: 15 }).label.includes("+ what the page adds"),
    `${listen}: and the line says so`,
  );
  const fired = await SpecialPowers.spawn(
    tab.linkedBrowser,
    [],
    () => content.document.body.dataset.formdata ?? "0",
  );
  Assert.equal(fired, "0", `${listen}: judging it ran no listener of the page`);
  AgentGate.answer(q.id, { kind: "deny" });
  Assert.equal((await response()).error?.reason, "user", `${listen}: a no`);
}

addTidyTask(async function test_a_formdata_listener_on_the_slot_asks() {
  await listenerOnThePathAsks("slot");
});

addTidyTask(async function test_a_formdata_listener_on_the_closed_shadow_root_asks() {
  await listenerOnThePathAsks("root");
});

addTidyTask(async function test_the_documents_onformdata_asks() {
  await listenerOnThePathAsks("document");
});

addTidyTask(async function test_a_formdata_listener_on_the_window_asks() {
  await listenerOnThePathAsks("window");
});

addTidyTask(async function test_a_component_behind_a_hidden_field_of_its_name_asks() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await grantedLabels(c, tab);
  const { q, response } = await press(c, tab, by.Keep);
  Assert.ok(q, "a hidden field of the same name does not hide the component's entry");
  if (!q) {
    info(`it ran unasked: ${(await response()).result?.url}`);
    return;
  }
  Assert.deepEqual(q.what.sent?.fields, [{ name: "note", opaque: true }], "one entry, unread");
  Assert.equal(q.what.sent?.hidden, 1, "and the hidden field counted");
  AgentGate.answer(q.id, { kind: "deny" });
  Assert.equal((await response()).error?.reason, "user", "a no");
});
