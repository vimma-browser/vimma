/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/mcp-forms.md, sub-PR 1: `vimma_elements` (`agent-elements`) lists an agent
// tab's buttons, fields, links and other clickable elements on screen with hint labels, in the
// background, inside the untrusted-content delimiters (F2, F5; security.md M25, M31). Password,
// one-time-code and payment card fields, those form autofill's heuristics find included, are
// listed as sensitive with no value (F6). The agent's labels live beside the user's hint mode,
// never in place of it (F4), and `f<label>` follows only links from the list, while their element
// is still there (F3, F4). At most 30 lists a connection a minute (F26).

"use strict";

/* global focusContent -- from head.js */
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
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { VimmaActors } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/actors/VimmaActors.sys.mjs",
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
const FORM = `${DIR}file_vimma_agent_form.html`;
const PAGE = `${DIR}file_vimma_agent_page.html`;
const NOTICE_ID = "vimma-notice";
const ASK_TIMEOUT = "vimma.mcp.askTimeoutMs";
/** Values the page holds in its sensitive fields: none may reach the agent (F6). */
const SECRETS = [
  "hunter2-secret",
  "old-secret-value",
  "864213",
  "4111111111111111",
  "12/31",
  "737",
  "5555444433331111",
  "4321",
];

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
const activeName = () => ww().model.workspaces.find((w) => w.id === ww().model.active)?.name;
const mainId = () => ww().model.workspaces.find((w) => w.name === "main")?.id;
const noticeText = () => document.getElementById(NOTICE_ID)?.textContent ?? "";

/** @param {() => boolean} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);

async function mcp(on) {
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, on);
  await VimmaControl.settled();
}

/** A tab in the agent workspace, loaded with `url`, hidden while the window shows `main`. */
async function openAgentTab(url = FORM) {
  const tab = gBrowser.addTab(url, {
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  await until(() => tab.hidden, "the agent tab is hidden in its workspace");
  if (url === FORM) {
    // The frame of another site has loaded its button.
    await until(
      () =>
        tab.linkedBrowser.browsingContext.children[0]?.currentWindowGlobal?.documentURI?.spec?.endsWith(
          "file_vimma_agent_widget.html",
        ),
      "the widget frame loaded",
    );
  }
  return tab;
}

/** The connections the running task opened. @type {any[]} */
const clients = [];

/** What a task leaves when it ends, passed or not (tidyTask): this file's state at its start. */
async function putBack() {
  for (const c of clients.splice(0)) c.close();
  Services.prefs.clearUserPref(ASK_TIMEOUT);
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
 * `agent-elements` on `tab`, answered with `answer` (null: not asked, a grant runs it).
 * @param {any} c @param {any} tab @param {object | null} [answer]
 */
async function elements(c, tab, answer = { kind: "once" }) {
  const id = c.request("agent-elements", { tab: idOf(tab) });
  if (answer) {
    const q = await question();
    Assert.equal(q.tool, "vimma_elements", "agent-elements asks as vimma_elements");
    AgentGate.answer(q.id, answer);
  }
  const r = await c.response(id);
  if (r.ok) {
    const v = validateMessage(r, { command: "agent-elements" });
    Assert.deepEqual(v.errors, [], "a valid agent-elements result");
  }
  return r;
}

/**
 * `agent-keys` on `tab`, answered once.
 * @param {any} c @param {any} tab @param {string} keys
 */
async function keys(c, tab, keys) {
  const id = c.request("agent-keys", { tab: idOf(tab), keys });
  AgentGate.answer((await question()).id, { kind: "once" });
  return c.response(id);
}

/** The list's JSON objects, between the delimiters. @param {string} list */
const parsed = (list) =>
  list
    .split("\n")
    .slice(1, -1)
    .map((l) => JSON.parse(l));

/** @param {any[]} list @param {(e: any) => boolean} pick @param {string} what */
function one(list, pick, what) {
  const found = list.filter(pick);
  Assert.equal(found.length, 1, `one ${what} is listed`);
  return found[0] ?? {};
}

addTidyTask(async function test_elements_lists_kinds_fields_and_forms() {
  await mcp(true);
  const tab = await openAgentTab();
  await focusContent(gBrowser.selectedBrowser);
  const before = { workspace: activeName(), selected: gBrowser.selectedTab };
  const c = await agentClient();
  const r = await elements(c, tab);
  Assert.ok(r.ok, "vimma_elements runs");
  Assert.equal(r.result.url, FORM, "the page");
  Assert.equal(r.result.title, "Form agent fixture", "its title");
  Assert.equal(r.result.dropped, 0, "none left out");
  Assert.ok(
    r.result.elements.startsWith("<untrusted-web-content>\n") &&
      r.result.elements.endsWith("\n</untrusted-web-content>"),
    "the list is inside the untrusted-content delimiters (M31)",
  );
  const list = parsed(r.result.elements);
  const forms = list.filter((e) => "action" in e);
  Assert.deepEqual(
    forms,
    [
      { form: 1, method: "post", action: "https://example.com/api/signup" },
      { form: 2, method: "post", action: "https://example.com/api/pay" },
      { form: 3, method: "get", action: "https://example.com/search" },
    ],
    "the forms first, numbered in reading order, with method and action",
  );
  const items = list.filter((e) => "label" in e);
  Assert.ok(
    items.every((e) => /^[asdfghjkl]{1,2}$/.test(e.label)),
    "labels over the default hint characters",
  );
  Assert.equal(new Set(items.map((e) => e.label)).size, items.length, "one label each");
  Assert.deepEqual(
    one(items, (e) => e.name === "email", "email field"),
    {
      label: one(items, (e) => e.name === "email", "email field").label,
      kind: "field",
      text: "",
      type: "email",
      name: "email",
      autocomplete: "email",
      caption: "Email address",
      required: true,
      value: "",
      form: 1,
    },
    "a field: type, name, autocomplete, its label's text, required, value, form",
  );
  const country = one(items, (e) => e.name === "country", "select");
  Assert.equal(country.kind, "select", "a select");
  Assert.deepEqual(
    country.options,
    [
      { value: "fi", text: "Finland" },
      { value: "se", text: "Sweden" },
    ],
    "with its options",
  );
  Assert.equal(country.selected, "fi", "and the selected one");
  const remember = one(items, (e) => e.name === "remember", "checkbox");
  Assert.equal(remember.kind, "checkbox", "a checkbox");
  Assert.equal(remember.checked, true, "checked");
  Assert.equal(remember.caption, "Remember me", "named by its label");
  const bio = one(items, (e) => e.name === "bio", "text area");
  Assert.deepEqual([bio.kind, bio.type, bio.value], ["field", "textarea", "Hello there"]);
  const later = one(items, (e) => e.text === "Later", "disabled button");
  Assert.deepEqual([later.kind, later.disabled], ["button", true], "listed, disabled");
  const submit = one(items, (e) => e.text === "Sign up", "submit button");
  Assert.deepEqual([submit.kind, submit.type, submit.form], ["button", "submit", 1]);
  const q = one(items, (e) => e.name === "q", "search field");
  Assert.deepEqual([q.type, q.text, q.value, q.form], ["search", "Search the site", "cats", 3]);
  const plans = one(items, (e) => e.kind === "link", "link");
  Assert.deepEqual([plans.text, plans.href], ["Plans", `${PAGE}?plans`], "a link with its href");
  const menu = one(items, (e) => e.text === "Menu", "script button");
  Assert.equal(menu.kind, "button", "a role=button element is a button");
  const like = one(items, (e) => e.text === "Like", "button in a frame of another site");
  Assert.equal(like.frame, "example.org", "names the frame's host");
  const inline = one(items, (e) => e.text === "Inline", "button in a srcdoc frame");
  Assert.ok(!("frame" in inline), "a srcdoc frame is the page's own site");
  Assert.deepEqual(
    { workspace: activeName(), selected: gBrowser.selectedTab },
    before,
    "the window kept its workspace and tab (M25)",
  );
  Assert.ok(tab.hidden, "the agent tab stayed hidden");
  const title = await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.title);
  Assert.equal(title, "Form agent fixture", "nothing on the page was clicked");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_password_and_card_fields_are_sensitive_without_values() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const r = await elements(c, tab);
  const items = parsed(r.result.elements).filter((e) => "label" in e);
  for (const name of ["password", "old", "code", "cardnumber", "expiry", "cvc", "card2", "pin"]) {
    const field = one(items, (e) => e.name === name, `${name} field`);
    Assert.equal(field.sensitive, true, `${name} is sensitive (M27)`);
    Assert.ok(!("value" in field), `${name} has no value`);
  }
  const old = one(items, (e) => e.name === "old", "switched field");
  Assert.equal(old.type, "text", "a field switched from password to text is still sensitive");
  for (const secret of SECRETS) {
    Assert.ok(!r.result.elements.includes(secret), `the value ${secret} never reaches the agent`);
  }
  const email = one(items, (e) => e.name === "email", "email field");
  Assert.ok(!email.sensitive, "an email field is not sensitive");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_agent_labels_leave_the_users_hint_mode_alone() {
  await mcp(true);
  const tab = await openAgentTab();
  const mine = await BrowserTestUtils.openNewForegroundTab(gBrowser, FORM);
  await focusContent(mine.linkedBrowser);
  const c = await agentClient();
  // The user is in hint mode in their own tab of the same window.
  EventUtils.synthesizeKey("f");
  await until(() => VimmaHost.status(window).mode === "hint", "the user's hint mode");
  const r = await elements(c, tab);
  Assert.ok(r.ok, "the agent's list ran");
  Assert.equal(VimmaHost.status(window).mode, "hint", "the user's hint mode is still on (F4)");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => VimmaHost.status(window).mode === "normal", "the user left hint mode");

  // In one tab, an agent's list never takes the user's targets from the page's child.
  const users = await VimmaActors.collectHints(mine.linkedBrowser, "hint.follow");
  await VimmaActors.collectHints(mine.linkedBrowser, "hint.follow", {
    agent: true,
    elements: true,
  });
  const plans = users.find((t) => t.href === `${PAGE}?plans`);
  VimmaActors.activateHint(plans);
  await BrowserTestUtils.browserLoaded(mine.linkedBrowser, false, `${PAGE}?plans`);
  Assert.ok(true, "the user's target still follows after an agent's list there");
  c.close();
  BrowserTestUtils.removeTab(mine);
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_f_follows_only_links_from_an_elements_list() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const items = parsed((await elements(c, tab)).result.elements).filter((e) => "label" in e);
  const submit = one(items, (e) => e.text === "Sign up", "submit button");
  let r = await keys(c, tab, `f${submit.label}`);
  Assert.equal(r.result.steps[0].ok, false, "a button's label is not followed (F3)");
  Assert.equal(
    r.result.steps[0].note,
    `label "${submit.label}" is a button, not a link: f follows links only`,
    "and says why",
  );
  Assert.equal(r.result.url, FORM, "nothing loaded or submitted");
  const plans = one(items, (e) => e.kind === "link", "link");
  r = await keys(c, tab, `f${plans.label}`);
  Assert.equal(r.result.steps[0].ok, true, "a link's label from the list follows");
  Assert.equal(r.result.url, `${PAGE}?plans`, "as a load of its href");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_labels_of_a_gone_element_are_refused() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const items = parsed((await elements(c, tab)).result.elements).filter((e) => "label" in e);
  const plans = one(items, (e) => e.kind === "link", "link");
  // The page replaces the link after it was listed, at the same URL and in the same document.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const old = content.document.getElementById("plans");
    old.replaceWith(old.cloneNode(true));
  });
  const r = await keys(c, tab, `f${plans.label}`);
  Assert.equal(r.result.steps[0].ok, false, "the label of a removed element is refused (F4)");
  Assert.equal(
    r.result.steps[0].note,
    "that element is gone: call vimma_elements again",
    "and says so",
  );
  Assert.equal(r.result.url, FORM, "nothing loaded");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_elements_only_on_web_pages_and_agent_tabs() {
  await mcp(true);
  const c = await agentClient();
  // A tab of the user's own workspace is unknown to the agent (M2), and nothing is asked.
  const mine = await BrowserTestUtils.openNewForegroundTab(gBrowser, FORM);
  let r = await c.call("agent-elements", { tab: idOf(mine) });
  Assert.equal(r.error?.code, "invalid-args", "the user's tab is refused");
  Assert.equal(AgentGate.waiting.length, 0, "unasked");
  BrowserTestUtils.removeTab(mine);
  // A tab the user moved into the agent workspace may show a page that is not on the web.
  const tab = gBrowser.addTab("about:robots", {
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, "about:robots");
  await until(() => tab.hidden, "the agent tab is hidden in its workspace");
  r = await elements(c, tab);
  Assert.equal(r.error?.code, "failed", "nothing is listed there");
  Assert.equal(r.error?.message, "elements are listed only on http and https pages", "says why");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_elements_under_a_grant_notice_log_and_rate() {
  await mcp(true);
  Services.prefs.setIntPref(ASK_TIMEOUT, 200);
  const tab = await openAgentTab();
  const c = await agentClient("claude-code");
  let r = await elements(c, tab, { kind: "grant", minutes: 12 });
  Assert.ok(r.ok, "a grants vimma_elements");
  r = await elements(c, tab, null);
  Assert.ok(r.ok, "the next list runs unasked");
  await until(
    () =>
      noticeText().startsWith('claude-code listed the buttons and fields of "Form agent fixture"'),
    "with a notice naming the page",
  );
  Assert.equal(AgentGate.log[0].tool, "vimma_elements", "and a row in :mcp log (M23)");
  Assert.equal(AgentGate.log[0].outcome, "grant", "that ran under the grant");
  // A vimma_elements grant is not a read grant.
  const read = c.request("agent-read", { tab: idOf(tab) });
  Assert.equal((await question()).tool, "vimma_read_page", "a read still asks");
  AgentGate.answer(AgentGate.waiting[0].id, { kind: "deny" });
  await c.response(read);
  // 30 a minute, counted when asked (F26): 2 so far.
  let busy = null;
  for (let i = 0; i < 29 && !busy; i++) {
    const x = await c.call("agent-elements", { tab: idOf(tab) });
    if (!x.ok) busy = { i, x };
  }
  Assert.equal(busy?.i, 28, "the 31st list in a minute is refused");
  Assert.equal(busy?.x.error.reason, "busy", "as busy");
  Assert.equal(AgentGate.log[0].outcome, "busy", "and logged");
  c.close();
  Services.prefs.clearUserPref(ASK_TIMEOUT);
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});
