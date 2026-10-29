/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/mcp-checkpoints.md (security.md M33): under a grant, a step that may pay asks
// with y or n only, and its answer neither makes nor ends a grant (C1, C4). A step may pay when
// the tab's page shows a payment card field in any frame, payment providers' frames of other
// sites included, or the control it presses has a pay phrase in its words (C6), also a button
// that submits no form; the question names the button, the site and the total the page states
// (C7). Basket buttons with no such words run unasked.

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
const { questionLine } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/agent-prompt.mjs",
);
const { MockRegistrar } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistrar.sys.mjs",
);

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const SHOP = `${DIR}file_vimma_agent_shop.html`;
const CHECKOUT = `${DIR}file_vimma_agent_checkout.html`;
const PAGE = `${DIR}file_vimma_agent_page.html`;

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
const noticeText = () => document.getElementById("vimma-notice")?.textContent ?? "";

/** @param {() => boolean} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);

async function mcp(on) {
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, on);
  await VimmaControl.settled();
}

/** A tab in the agent workspace, loaded with `url`, hidden while the window shows `main`. */
async function openAgentTab(url = SHOP) {
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

/** The oldest waiting question, once there is one. */
async function question() {
  await until(() => AgentGate.waiting.length > 0, "a question waits");
  return AgentGate.waiting[0];
}

/**
 * The list's elements by what they say; the first list of the connection is answered with a
 * grant of 15 minutes, which covers every tool after it (mcp-grants G1).
 * @param {any} c @param {any} tab
 */
async function grantedLabels(c, tab) {
  const id = c.request("agent-elements", { tab: idOf(tab) });
  if (!AgentGate.grants().length) {
    AgentGate.answer((await question()).id, { kind: "grant", minutes: 15 });
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

/** What the page counted of the clicks. @param {any} tab */
const clicked = (tab) =>
  SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    [...content.document.querySelectorAll("#log li")].map((li) => li.textContent),
  );

/** The grant's end, which no checkpoint may move. */
const grantEnd = () => AgentGate.grants()[0]?.until;

addTidyTask(async function test_pay_button_outside_a_form_asks_under_a_grant() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await grantedLabels(c, tab);
  const until0 = grantEnd();
  Assert.ok(until0, "a grant is in force");
  // A type=submit button outside any form submits nothing: only its words say that it pays.
  const id = c.request("agent-activate", { tab: idOf(tab), label: by["Vahvista tilaus"] });
  const q = await question();
  Assert.equal(q.tool, "vimma_activate", "the click asks under the grant (C1)");
  Assert.deepEqual(
    q.what.pay,
    { text: "Vahvista tilaus", site: "example.com", total: "Yhteensä 42,90 €" },
    "as a payment, with the button, the site and the total before it (C7)",
  );
  Assert.ok(!("submit" in q.what), "though it sends no form");
  Assert.equal(
    questionLine(q, { grantMinutes: 15 }).label,
    '▲ claude-code wants to pay: "Vahvista tilaus" on example.com · the page says "Yhteensä 42,90 €"',
    "the question line",
  );
  Assert.deepEqual(await clicked(tab), [], "nothing is clicked before the answer");
  AgentGate.answer(q.id, { kind: "once" });
  const r = await c.response(id);
  Assert.ok(r.ok, "the yes runs the click");
  await until(async () => (await clicked(tab)).includes("confirm"), "the page saw it");
  Assert.equal(grantEnd(), until0, "the yes leaves the grant as it was (C1)");
  // An accessible name says it too: an arrow button named "Pay now".
  const arrow = c.request("agent-activate", { tab: idOf(tab), label: by["→"] });
  const q2 = await question();
  Assert.equal(q2.what.pay?.text, "→", "the arrow's own text is what the question quotes");
  AgentGate.answer(q2.id, { kind: "once" });
  Assert.ok((await c.response(arrow)).ok, "and its yes runs it");
});

addTidyTask(async function test_basket_button_does_not_ask() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await grantedLabels(c, tab);
  const r = await c.call("agent-activate", { tab: idOf(tab), label: by["Lisää ostoskoriin"] });
  Assert.ok(r.ok, "an add-to-basket button runs under the grant");
  Assert.equal(AgentGate.waiting.length, 0, "unasked");
  Assert.deepEqual(await clicked(tab), ["add"], "and the page saw the click");
  Assert.equal(AgentGate.log[0].outcome, "grant", "logged as run under the grant");
});

addTidyTask(async function test_card_fields_in_a_cross_site_frame_make_a_pay_step() {
  await mcp(true);
  const tab = await openAgentTab(CHECKOUT);
  // The payment provider's frame of another site has loaded its card field.
  await until(
    () =>
      tab.linkedBrowser.browsingContext.children[0]?.currentWindowGlobal?.documentURI?.host ===
      "example.org",
    "the provider's frame loaded",
  );
  const c = await agentClient();
  const by = await grantedLabels(c, tab);
  const id = c.request("agent-activate", { tab: idOf(tab), label: by["Apply coupon"] });
  const q = await question();
  Assert.deepEqual(
    q.what.pay,
    { text: "Apply coupon", site: "example.com", total: "Order total: 42.90 EUR" },
    "a button with no pay words asks as a payment where a card field shows (C6)",
  );
  AgentGate.answer(q.id, { kind: "once" });
  Assert.ok((await c.response(id)).ok, "and runs after the yes");
  Assert.deepEqual(await clicked(tab), ["apply"], "once");
});

// A payment provider's hosted frame takes the money: the question names its site, then the
// tab's, and so do the notices; a yes allows the click, which runs after it.
addTidyTask(async function test_a_pay_button_in_a_cross_site_frame_names_the_frames_site() {
  await mcp(true);
  const tab = await openAgentTab(`${CHECKOUT}?frame=hosted_pay`);
  const frame = () => tab.linkedBrowser.browsingContext.children[0];
  await until(
    () =>
      frame()?.currentWindowGlobal?.documentURI?.host === "example.org" &&
      frame().currentWindowGlobal.documentURI.spec.endsWith("hosted_pay.html"),
    "the provider's frame loaded",
  );
  const c = await agentClient();
  const by = await grantedLabels(c, tab);
  let id = c.request("agent-activate", { tab: idOf(tab), label: by["Pay 42.90 EUR"] });
  let q = await question();
  Assert.deepEqual(
    q.what.pay,
    { text: "Pay 42.90 EUR", site: "example.org", top: "example.com", total: "Total 42.90 EUR" },
    "the frame's site, then the tab's",
  );
  Assert.equal(
    questionLine(q, { grantMinutes: 10 })
      .parts.map((p) => p.text)
      .join(""),
    '▲ claude-code wants to pay: "Pay 42.90 EUR" on example.org (in example.com) · the page says "Total 42.90 EUR"',
    "as the question shows it",
  );
  AgentGate.answer(q.id, { kind: "once" });
  await until(
    () => noticeText() === "allowed payment on example.org (in example.com)",
    "a yes says what it allowed, and where",
  );
  Assert.ok((await c.response(id)).ok, "and the click runs after it");
  const clicks = await SpecialPowers.spawn(frame(), [], () =>
    [...content.document.querySelectorAll("#log li")].map((li) => li.textContent),
  );
  Assert.deepEqual(clicks, ["pay"], "once, in the frame");
  id = c.request("agent-activate", { tab: idOf(tab), label: by["Pay 42.90 EUR"] });
  q = await question();
  AgentGate.answer(q.id, { kind: "deny" });
  await c.response(id);
  await until(
    () => noticeText() === "stopped claude-code's payment on example.org (in example.com)",
    "a no names both too",
  );
});

// A link followed by a label of `f`'s own list, in the provider's frame, names that frame's site
// too: the follow loads it there.
addTidyTask(async function test_a_followed_pay_link_in_a_cross_site_frame_names_the_frames_site() {
  await mcp(true);
  const tab = await openAgentTab(`${CHECKOUT}?frame=hosted_pay`);
  const frame = () => tab.linkedBrowser.browsingContext.children[0];
  await until(
    () => frame()?.currentWindowGlobal?.documentURI?.spec.endsWith("hosted_pay.html"),
    "the provider's frame loaded",
  );
  const c = await agentClient();
  await grantedLabels(c, tab);
  const list = await c.call("agent-keys", { tab: idOf(tab), keys: "f" });
  Assert.ok(list.ok, "f lists the links under the grant");
  const line = list.result.links.split("\n").find((l) => l.includes('"Pay by bank"'));
  Assert.ok(line, "the frame's link is listed");
  const id = c.request("agent-keys", { tab: idOf(tab), keys: `f${line.split(" ")[0]}` });
  const q = await question();
  Assert.equal(q.what.pay?.text, "Pay by bank", "the follow asks as a payment");
  Assert.equal(q.what.pay?.site, "example.org", "naming the frame's site");
  Assert.equal(q.what.pay?.top, "example.com", "then the tab's");
  AgentGate.answer(q.id, { kind: "deny" });
  Assert.equal((await c.response(id)).error?.reason, "user", "a no stops it");
});

addTidyTask(async function test_a_no_stops_the_step_and_keeps_the_grant() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await grantedLabels(c, tab);
  const until0 = grantEnd();
  for (const answer of [{ kind: "deny" }, { kind: "mute" }]) {
    const id = c.request("agent-activate", { tab: idOf(tab), label: by["Vahvista tilaus"] });
    const q = await question();
    // `x` is a plain no at a checkpoint (Behaviour 2): it does not mute the agent.
    AgentGate.answer(q.id, /** @type {any} */ (answer));
    const r = await c.response(id);
    Assert.equal(r.error?.reason, "user", `${answer.kind}: the step is denied`);
  }
  Assert.deepEqual(await clicked(tab), [], "nothing was clicked");
  Assert.equal(grantEnd(), until0, "the grant stays (C4)");
  const r = await c.call("agent-activate", { tab: idOf(tab), label: by["Lisää ostoskoriin"] });
  Assert.ok(r.ok, "the agent goes on under it");
  Assert.equal(AgentGate.waiting.length, 0, "unasked");
});

addTidyTask(async function test_the_stated_total_is_quoted() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await grantedLabels(c, tab);
  // The confirm button: the total before it, not the subtotal, the delivery or one after it.
  const id = c.request("agent-activate", { tab: idOf(tab), label: by["Vahvista tilaus"] });
  const q = await question();
  Assert.equal(q.what.pay.total, "Yhteensä 42,90 €", "the nearest total before the button");
  AgentGate.answer(q.id, { kind: "deny" });
  await c.response(id);
  // With no total on the page, none is quoted.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    for (const p of content.document.querySelectorAll(".sum")) p.remove();
  });
  const by2 = await grantedLabels(c, tab);
  const id2 = c.request("agent-activate", { tab: idOf(tab), label: by2["Vahvista tilaus"] });
  const q2 = await question();
  Assert.deepEqual(q2.what.pay, { text: "Vahvista tilaus", site: "example.com" }, "no total");
  AgentGate.answer(q2.id, { kind: "deny" });
  await c.response(id2);
});

addTidyTask(async function test_a_key_that_acts_where_it_may_pay_asks() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await grantedLabels(c, tab);
  // A follow of a link whose words pay asks in the call's own question, once.
  const id = c.request("agent-keys", { tab: idOf(tab), keys: `f${by["Maksa nyt"]}` });
  const q = await question();
  Assert.equal(q.tool, "vimma_keys", "the keys ask under the grant");
  Assert.equal(q.what.pay?.text, "Maksa nyt", "as a payment naming the link");
  AgentGate.answer(q.id, { kind: "once" });
  const r = await c.response(id);
  Assert.ok(r.ok && r.result.steps[0].ok, "the yes follows it, with no second question");
  Assert.equal(r.result.url, `${PAGE}?paid`, "to the link's page");
  // Back on a page with card fields, H asks too: it acts there, and the keys stand in for a button.
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, CHECKOUT);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, CHECKOUT);
  await until(
    () =>
      tab.linkedBrowser.browsingContext.children[0]?.currentWindowGlobal?.documentURI?.host ===
      "example.org",
    "the provider's frame loaded",
  );
  const back = c.request("agent-keys", { tab: idOf(tab), keys: "H" });
  const q2 = await question();
  Assert.equal(q2.what.pay?.keys, "H", "a key step shows its keys");
  AgentGate.answer(q2.id, { kind: "deny" });
  const r2 = await c.response(back);
  Assert.equal(r2.error?.reason, "user", "a no stops it");
  Assert.equal(String(tab.linkedBrowser.currentURI.spec), CHECKOUT, "nothing loaded");
  // A yes to H asked in the call's own question runs it, with no second question.
  const again = c.request("agent-keys", { tab: idOf(tab), keys: "H" });
  AgentGate.answer((await question()).id, { kind: "once" });
  const r3 = await c.response(again);
  Assert.ok(r3.ok && r3.result.steps[0].ok, "the yes goes back once, unasked again");
  Assert.equal(r3.result.url, `${PAGE}?paid`, "to the page before");
});

addTidyTask(async function test_checkpoint_notice_log_row_and_notification() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await grantedLabels(c, tab);
  let id = c.request("agent-activate", { tab: idOf(tab), label: by["Vahvista tilaus"] });
  AgentGate.answer((await question()).id, { kind: "once" });
  await c.response(id);
  await until(
    () => noticeText() === "allowed payment on example.com",
    "a yes says what it allowed",
  );
  Assert.equal(AgentGate.log[0].outcome, "checkpoint-yes", ":mcp log: allowed (checkpoint)");
  id = c.request("agent-activate", { tab: idOf(tab), label: by["Vahvista tilaus"] });
  AgentGate.answer((await question()).id, { kind: "deny" });
  await c.response(id);
  await until(
    () => noticeText() === "stopped claude-code's payment on example.com",
    "a no says what it stopped",
  );
  Assert.equal(AgentGate.log[0].outcome, "checkpoint-no", ":mcp log: denied (checkpoint)");

  // A window not in front: the desktop notification says what is asked, never where or how much.
  /** @type {string[]} */
  const alerts = [];
  const cid = MockRegistrar.register("@mozilla.org/alerts-service;1", {
    QueryInterface: ChromeUtils.generateQI(["nsIAlertsService"]),
    showAlert(/** @type {any} */ alert) {
      alerts.push(alert.text);
    },
    showAlertNotification() {},
    closeAlert() {},
  });
  const other = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  await SimpleTest.promiseFocus(other);
  try {
    id = c.request("agent-activate", { tab: idOf(tab), label: by["Vahvista tilaus"] });
    await until(() => alerts.length === 1, "one desktop notification");
    Assert.equal(alerts[0], "claude-code asks to pay", "who and what, nothing else");
    AgentGate.answer((await question()).id, { kind: "deny" });
    await c.response(id);
  } finally {
    await BrowserTestUtils.closeWindow(other);
    MockRegistrar.unregister(cid);
  }
});
