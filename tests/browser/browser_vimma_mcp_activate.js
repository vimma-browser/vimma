/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/mcp-forms.md, sub-PR 2: `vimma_activate` (`agent-activate`) clicks an element
// of an agent tab by its label from `vimma_elements`, in the background (F8; security.md M25).
// The click is the child's `click()`, never synthesised input, so the page gets no user
// activation (M26). Fields, selects, file fields, disabled controls and links to another site
// are refused before anything is asked (F9, F10; M29). The result says whether a page loaded
// and which dialog the page opened (F11); a tab the user is typing in is `in-use` (F27); at most
// 30 clicks a connection a minute, each in `:mcp log` (F26, F28; M32).

"use strict";

/* global focusContent -- from head.js */
/* global Client, tidyTask -- from head_vimma_control.js */
/* global requestLongerTimeout -- the browser-chrome harness (browser-test.js) */
/* global XULBrowserWindow -- a browser window global (browser.js) */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);
// Every click and submission now also asks each frame of the tab for card fields and the
// total (mcp-checkpoints C6, C7): on a loaded macOS runner the file outgrows the default time.
requestLongerTimeout(2);

const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/AgentGate.sys.mjs",
);
const { MCP_ENABLED_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/mcp-ops.mjs",
);
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { AgentDrive } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentDrive.sys.mjs",
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
const PRESS = `${DIR}file_vimma_agent_press.html`;
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

const agent = () => /** @type {ContainedWorkspace} */ (WorkspaceStore.agent);
const agentTabs = () =>
  gBrowser.tabs.filter((t) => t.userContextId === agent().userContextId && !t.closing);
const idOf = (/** @type {MozTabbrowserTab} */ tab) => String(tab.linkedBrowser.browserId);
const ww = () => /** @type {LiveWorkspaces} */ (WindowWorkspaces.get(window));
const activeName = () =>
  ww().model.workspaces.find((/** @type {WorkspaceState} */ w) => w.id === ww().model.active)?.name;
const mainId = () =>
  /** @type {string} */ (
    ww().model.workspaces.find((/** @type {WorkspaceState} */ w) => w.name === "main")?.id
  );
const noticeText = () => document.getElementById(NOTICE_ID)?.textContent ?? "";

/** @param {() => unknown} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);

/** @param {boolean} on */
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

/** The connections the running task opened. @type {Client[]} */
const clients = [];

/** What a task leaves when it ends, passed or not (tidyTask): this file's state at its start. */
async function putBack() {
  for (const c of clients.splice(0)) c.close();
  Services.prefs.clearUserPref(ASK_TIMEOUT);
  AgentDrive._linkTtlMs = null;
  XULBrowserWindow.setOverLink("");
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
  // As vimma-ctl of this Vimma's version says it in its hello: a rate refusal's retryAfter
  // goes only to a client that new (issue #592).
  const { AppConstants } = ChromeUtils.importESModule(
    "resource://gre/modules/AppConstants.sys.mjs",
  );
  await c.call("agent-hello", { client: { name }, ctl: AppConstants.MOZ_APP_VERSION_DISPLAY });
  return c;
}

/** The oldest waiting question, once there is one. */
async function question() {
  await until(() => AgentGate.waiting.length > 0, "a question waits");
  return /** @type {AskedQuestion} */ (AgentGate.waiting[0]);
}

/** The list's elements by what they say. @param {Client} c @param {MozTabbrowserTab} tab */
async function labels(c, tab) {
  const id = c.request("agent-elements", { tab: idOf(tab) });
  // Under a grant the list runs unasked (mcp-grants G1).
  if (!AgentGate.grants().length) AgentGate.answer((await question()).id, { kind: "once" });
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
 * @param {Client} c @param {MozTabbrowserTab} tab @param {string} label @param {GateAnswer | null} [answer]
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

/** @param {MozTabbrowserTab} tab */
const seen = (tab) =>
  SpecialPowers.spawn(tab.linkedBrowser, [], () => ({
    items: content.document.querySelectorAll("#list li").length,
    seen: JSON.parse(JSON.stringify(content.wrappedJSObject.seen ?? [])),
    focused: content.document.activeElement?.localName ?? "",
    gesture: content.document.hasValidTransientUserGestureActivation,
    title: content.document.title,
  }));

addTidyTask(async function test_activate_clicks_a_button_in_a_background_tab() {
  await mcp(true);
  const tab = await openAgentTab();
  await focusContent(gBrowser.selectedBrowser);
  const before = { workspace: activeName(), selected: gBrowser.selectedTab };
  const c = await agentClient("claude-code");
  const by = await labels(c, tab);
  // The user's own hover preview, as the pointer on a link in their tab shows it.
  XULBrowserWindow.setOverLink("https://example.net/hovered");
  const shown = XULBrowserWindow.overLink;
  const id = c.request("agent-activate", { tab: idOf(tab), label: by["Add to list"] });
  const q = await question();
  Assert.deepEqual(
    [q.what.label, q.what.kind, q.what.text],
    [by["Add to list"], "button", "Add to list"],
    "the question names the element",
  );
  AgentGate.answer(q.id, { kind: "once" });
  const r = await c.response(id);
  Assert.ok(r.ok, "vimma_activate runs");
  // A press on a button, no link, leaves the user's preview alone (#1309).
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {});
  Assert.equal(XULBrowserWindow.overLink, shown, "the user's link preview is unchanged");
  XULBrowserWindow.setOverLink("");
  Assert.deepEqual(
    [r.result.url, r.result.title, r.result.navigated, r.result.loading],
    [CLICK, "Click agent fixture", false, false],
    "the page after the click, which loaded nothing",
  );
  await until(async () => (await seen(tab)).items === 1, "the button was clicked once");
  const page = await seen(tab);
  Assert.equal(page.seen[0].trusted, true, "the page saw a trusted click");
  Assert.notEqual(page.focused, "button", "the button was not focused (M25)");
  Assert.deepEqual(
    { workspace: activeName(), selected: gBrowser.selectedTab },
    before,
    "the window kept its workspace and tab (M25)",
  );
  Assert.ok(tab.hidden, "the agent tab stayed hidden");
  Assert.equal(AgentGate.log[0].tool, "vimma_activate", "a row in :mcp log (M32)");
  Assert.equal(
    AgentGate.log[0].detail,
    `${by["Add to list"]} button "Add to list"`,
    "naming the element",
  );
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_activate_gives_the_page_no_user_activation() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  const r = await activate(c, tab, by["Add to list"]);
  Assert.ok(r.ok, "the click ran");
  await until(async () => (await seen(tab)).seen[0]?.clipboard !== "pending", "the write settled");
  const page = await seen(tab);
  Assert.equal(page.seen[0].active, false, "no transient user activation in the handler (M26)");
  Assert.equal(page.seen[0].beenActive, false, "the page was never activated");
  Assert.equal(page.seen[0].clipboard, "refused", "so it cannot write the clipboard");
  Assert.equal(page.gesture, false, "the document has no valid transient activation");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

/** What the press fixture's elements got, in order. @param {MozTabbrowserTab} tab */
const pressEvents = (tab) =>
  SpecialPowers.spawn(tab.linkedBrowser, [], () => ({
    events: /** @type {{ id: string, type: string, trusted: boolean }[]} */ (
      JSON.parse(JSON.stringify(content.wrappedJSObject.events))
    ),
    focused: content.document.activeElement?.id ?? "",
  }));

addTidyTask(async function test_activate_presses_with_untrusted_mouse_events() {
  // Issue #1321: the mouse events before an agent's click are the page's own script's, so the
  // page sees them untrusted, and Gecko runs none of a trusted press's link handling on them:
  // the link takes no focus and the user's window shows no URL of the agent's hidden tab.
  await mcp(true);
  const tab = await openAgentTab(PRESS);
  await focusContent(gBrowser.selectedBrowser);
  XULBrowserWindow.setOverLink("");
  const c = await agentClient();
  const by = await labels(c, tab);
  for (const [name, id] of [
    ["Stay link", "stay"],
    ["Press me", "press"],
  ]) {
    const r = await activate(c, tab, by[name]);
    Assert.ok(r.ok, `${name}: the click ran`);
    await until(
      async () => (await pressEvents(tab)).events.some((e) => e.id === id && e.type === "click"),
      `${name}: the page saw the click`,
    );
    const page = await pressEvents(tab);
    const got = page.events.filter((e) => e.id === id);
    Assert.deepEqual(
      got.map((e) => [e.type, e.trusted]),
      [
        ["mouseover", false],
        ["mousedown", false],
        ["mouseup", false],
        ["click", true],
      ],
      `${name}: untrusted mouse events, then the trusted click, and no focus`,
    );
    Assert.equal(page.focused, "", `${name}: nothing in the page took focus`);
    // The child's link status reaches this process before its reply to pressEvents' spawn above
    // (both on the same actor channel, in order), so a URL the press set would be here by now.
    Assert.equal(XULBrowserWindow.overLink, "", `${name}: the user's window shows no link URL`);
  }
  Assert.equal(tab.linkedBrowser.currentURI.spec, PRESS, "the page handled the link itself");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_activate_on_a_page_whose_dispatch_event_throws_still_clicks() {
  // A page can replace the dispatchEvent an agent's press calls (page-events.mjs): it gets only
  // its own element and its own MouseEvents, its throw is caught, and the click still follows.
  await mcp(true);
  const url = `${PRESS}?hostile`;
  const tab = await openAgentTab(url);
  const c = await agentClient();
  const by = await labels(c, tab);
  const r = await activate(c, tab, by["Press me"]);
  Assert.ok(r.ok, "the click ran");
  await until(
    async () => (await pressEvents(tab)).events.some((e) => e.type === "click"),
    "the page saw the click",
  );
  const page = await pressEvents(tab);
  Assert.deepEqual(
    page.events.map((e) => [e.id, e.type, e.trusted]),
    [["press", "click", true]],
    "no mouse event reached a listener, and the click came trusted",
  );
  Assert.equal(page.focused, "", "nothing in the page took focus");
  const hostile = await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    JSON.parse(JSON.stringify(content.wrappedJSObject.hostile)),
  );
  Assert.deepEqual(
    hostile,
    [{ onPress: true, mouseEvent: true, pageProto: true, type: "mouseover" }],
    "the page's dispatchEvent got its own element and MouseEvent, then threw",
  );
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_activate_refuses_fields_files_disabled_and_other_sites() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  const refusals = [
    [by.Field, `label "${by.Field}" is a field: use vimma_fill`],
    [by.Pick, `label "${by.Pick}" is a select: use vimma_fill`],
    [
      by.upload,
      `label "${by.upload}" is a file field; Vimma never clicks it: ask the user to choose the file`,
    ],
    [by.Off, `label "${by.Off}" is disabled`],
    [by["Other site"], "that link goes to another site: follow it with vimma_keys"],
  ];
  for (const [label, message] of refusals) {
    Assert.ok(label, `${message}: the element is listed`);
    const r = await c.call("agent-activate", { tab: idOf(tab), label });
    Assert.equal(r.error?.code, "failed", `${message}: refused`);
    Assert.equal(r.error?.message, message, "naming the label and the reason (M29)");
  }
  Assert.equal(AgentGate.waiting.length, 0, "nothing was asked");
  Assert.equal(tab.linkedBrowser.currentURI.spec, CLICK, "nothing loaded");
  // A label from no list, and one the agent never got from vimma_elements.
  let r = await c.call("agent-activate", { tab: idOf(tab), label: "kkk" });
  Assert.equal(r.error?.message, 'no element has the label "kkk": call vimma_elements again');
  const keys = c.request("agent-keys", { tab: idOf(tab), keys: "f" });
  AgentGate.answer((await question()).id, { kind: "once" });
  await c.response(keys);
  r = await c.call("agent-activate", { tab: idOf(tab), label: by["Same site"] });
  Assert.equal(
    r.error?.message,
    "labels from f's link list are followed with vimma_keys: call vimma_elements to click",
    "a label of f's list is not clicked (F3)",
  );
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_activate_never_follows_a_link_moved_elsewhere_or_an_svg_link() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  // An SVG link to another site, around an element of its own.
  Assert.ok(by["Svg go"], "the element inside the SVG link is listed");
  let r = await c.call("agent-activate", { tab: idOf(tab), label: by["Svg go"] });
  Assert.equal(
    r.error?.message,
    "that link goes to another site: follow it with vimma_keys",
    "an SVG link to another site is refused (M29)",
  );
  // A same-site link that points elsewhere once the mouse is down on it.
  r = await activate(c, tab, by["Swap link"]);
  Assert.equal(
    r.error?.message,
    "the element changed as it was clicked; nothing was clicked",
    "the click does not follow a link moved after the question",
  );
  Assert.equal(tab.linkedBrowser.currentURI.spec, CLICK, "nothing loaded");
  // The hover the mouse events began has ended (#1309): the window's link preview shows no URL
  // of the agent's hidden tab. A round trip through the page lets what it sent arrive first.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {});
  Assert.equal(XULBrowserWindow.overLink, "", "the link preview shows no URL");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_activate_follows_a_same_site_link_as_an_open() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  const r = await activate(c, tab, by["Same site"]);
  Assert.ok(r.ok, "a same-site link is clicked");
  Assert.equal(r.result.navigated, true, "a page loaded");
  Assert.equal(r.result.url, `${PAGE}?clicked`, "the link's page");
  // Its labels are gone with the page.
  const again = await c.call("agent-activate", { tab: idOf(tab), label: by["Add to list"] });
  Assert.equal(again.error?.message, "stale labels: call vimma_elements again");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_element_labels_last_while_their_element_is_there() {
  // Issue #591: a slow model takes longer than f's link lifetime between listing and clicking.
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  // As if f's lifetime had passed since the list: an element list has none of its own (F3).
  AgentDrive._linkTtlMs = 0;
  const r = await activate(c, tab, by["Add to list"]);
  Assert.ok(r.ok, `a label of the same page and element still clicks: ${r.error?.message}`);
  // What ends a label is its element leaving the page (F4), not the time.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    /** @type {HTMLElement} */ (content.document.getElementById("ask")).remove(),
  );
  const gone = await activate(c, tab, by.Remove, null);
  Assert.equal(gone.error?.message, "that element is gone: call vimma_elements again");
  // So is one the page moved into a document of its own frame: still connected, but no longer
  // on the page the label was listed on.
  Services.prefs.setIntPref(ASK_TIMEOUT, 3000);
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const frame = content.document.createElement("iframe");
    frame.srcdoc = "<p>frame</p>";
    const ready = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
    content.document.body.append(frame);
    await ready;
    // A same-origin srcdoc frame, loaded: it has its document.
    const doc = /** @type {Document} */ (frame.contentDocument);
    doc.body.append(
      doc.adoptNode(/** @type {HTMLElement} */ (content.document.getElementById("add"))),
    );
  });
  const moved = await activate(c, tab, by["Add to list"], null);
  Assert.equal(
    moved.error?.message,
    "that element is gone: call vimma_elements again",
    "an element adopted into another document is gone",
  );
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_activate_reports_a_dialog() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  const r = await activate(c, tab, by.Remove);
  Assert.ok(r.ok, "the click ran");
  Assert.deepEqual(
    r.result.dialog,
    {
      type: "confirm",
      text: "<untrusted-web-content>\nRemove this item?\n</untrusted-web-content>",
    },
    "the dialog's type and its text, as untrusted content",
  );
  Assert.ok(tab.hidden, "the dialog waits in the hidden tab for the user");
  // The user answers it.
  const dialogs = gBrowser.getTabDialogBox(tab.linkedBrowser).getContentDialogManager().dialogs;
  Assert.equal(dialogs.length, 1, "one dialog in the tab");
  await dialogs[0]._dialogReady;
  dialogs[0]._frame.contentDocument.getElementById("commonDialog").cancelDialog();
  await until(
    async () =>
      (await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.wrappedJSObject.answer)) ===
      false,
    "the user's answer reached the page",
  );
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_activate_in_use_while_the_user_types() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await labels(c, tab);
  ww().switchTo({ id: agent().id });
  await until(() => gBrowser.selectedTab === tab, "the agent tab is in front");
  await focusContent(tab.linkedBrowser);
  // The user's own click: a field the page focuses by itself is not theirs (#1325).
  await BrowserTestUtils.synthesizeMouseAtCenter("#field", {}, tab.linkedBrowser);
  await until(() => VimmaHost.status(window).mode === "insert", "the user is in insert mode");
  const r = await c.call("agent-activate", { tab: idOf(tab), label: by["Add to list"] });
  Assert.equal(r.error?.reason, "in-use", "a tab the user types in is denied (F27)");
  Assert.equal(AgentGate.waiting.length, 0, "before anything is asked");
  Assert.equal((await seen(tab)).items, 0, "nothing was clicked");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
  ww().switchTo({ id: mainId() });
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

addTidyTask(async function test_activate_under_a_grant_notice_log_and_rate() {
  await mcp(true);
  Services.prefs.setIntPref(ASK_TIMEOUT, 200);
  const tab = await openAgentTab();
  const c = await agentClient("claude-code");
  const by = await labels(c, tab);
  let r = await activate(c, tab, by["Add to list"], { kind: "grant", minutes: 12 });
  Assert.ok(r.ok, "a grants vimma_activate");
  r = await activate(c, tab, by.Menu, null);
  Assert.ok(r.ok, "the next click runs unasked");
  await until(
    () =>
      noticeText().startsWith('claude-code clicked button "Menu" in "Click agent fixture" (grant'),
    "with a notice naming the element and the page",
  );
  Assert.equal(AgentGate.log[0].outcome, "grant", "and a row in :mcp log (M32)");
  // 30 a minute, counted when asked (F26): 2 so far.
  let busy = null;
  for (let i = 0; i < 29 && !busy; i++) {
    const x = await c.call("agent-activate", { tab: idOf(tab), label: by["Add to list"] });
    if (!x.ok) busy = { i, x };
  }
  Assert.equal(busy?.i, 28, "the 31st click in a minute is refused");
  Assert.equal(busy?.x.error?.reason, "busy", "as busy");
  // Issue #592: it names the limit and when the next call is allowed.
  Assert.equal(
    busy?.x.error?.message,
    "too many vimma_activate and vimma_fill calls from this agent in the last minute (at most 30)",
    "naming the limit it hit",
  );
  const wait = busy?.x.error?.retryAfter ?? 0;
  Assert.ok(wait >= 1 && wait <= 60_000, `and the wait for the next call: ${wait} ms`);
  Assert.equal(AgentGate.log[0].outcome, "busy", "and logged");
  c.close();
  Services.prefs.clearUserPref(ASK_TIMEOUT);
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

// Issue #1109: the agent's page work lives in AgentPage (actors/agent-page.mjs), which the child
// builds with itself and three callbacks. Driven here with a stand-in actor: a listed element of
// another generation is unknown, a click whose element is not as asked is refused, a click runs
// after the reply through the child's press with the re-check (`still`, M26), a click whose
// element changed before it is skipped and said back (M28), the page's pagehide skips a step
// still to run, a fill sets the field after the reply (F12), and the console read finds this
// document's own error (F22).
add_task(async function the_agent_page_helper_acts_on_the_document_it_is_given() {
  await BrowserTestUtils.withNewTab(PAGE, async (browser) => {
    const seen = await SpecialPowers.spawn(browser, [], async () => {
      const { AgentPage } = ChromeUtils.importESModule(
        "chrome://browser/content/vimma/actors/agent-page.mjs",
      );
      const doc = content.document;
      const button = doc.createElement("button");
      button.textContent = "Go";
      const field = doc.createElement("input");
      doc.body.append(button, field);
      /** @type {{ name: string, data: { step?: unknown } }[]} */
      const sent = [];
      const actor = /** @type {JSWindowActorChild} */ (
        /** @type {unknown} */ ({
          document: doc,
          contentWindow: content,
          docShell: content.docShell,
          manager: {
            isCurrentGlobal: true,
            innerWindowId: content.windowGlobalChild?.innerWindowId,
          },
          sendAsyncMessage: (/** @type {string} */ name, /** @type {{ step?: unknown }} */ data) =>
            sent.push({ name, data }),
        })
      );
      /** @type {boolean[]} */
      const pressed = [];
      const agent = new AgentPage(actor, {
        onPage: /** @type {(el: Element | null | undefined) => el is Element} */ (
          (el) => !!el?.isConnected && el.ownerDocument === doc
        ),
        press: (_el, still = () => true) => {
          const ok = still();
          pressed.push(ok);
          return ok;
        },
        beforeSubmitCheck: () => null,
      });
      agent.listed = { gen: 4, els: [new WeakRef(button), new WeakRef(field)] };
      const tick = () =>
        new Promise((resolve) => Services.tm.dispatchToMainThread(() => resolve(null)));
      const until = Date.now() + 30000;
      /** @type {{ op: string, gen: number, id: number, href: string | null, until: number }} */
      const click = { op: "activate", gen: 4, id: 0, href: null, until };
      const outcome = () => agent.element({ op: "outcome", gen: 4, id: 0 });
      const unknown = agent.element({ op: "alive", gen: 3, id: 0 });
      const alive = agent.element({ op: "alive", gen: 4, id: 0 });
      const notAsAsked = agent.element({ ...click, href: "https://example.org/" });
      const ok = agent.element({ ...click, step: 7 });
      const before = outcome();
      await tick();
      const clicked = outcome();
      agent.element({ ...click, step: 8 });
      button.disabled = true;
      await tick();
      const changed = outcome();
      button.disabled = false;
      agent.element({ ...click, step: 9 });
      agent.pageHidden();
      await tick();
      const hidden = outcome();
      const target = /** @type {FillTargetRaw} */ (
        agent.element({ op: "inspect-fill", gen: 4, id: 1, value: "hi" })
      );
      const expect = { field: target.field, type: target.type };
      const fill = agent.element({ op: "fill", gen: 4, id: 1, value: "hi", expect, until });
      await tick();
      const filled = agent.element({ op: "fill-outcome", gen: 4, id: 1 });
      content.console.error("agent page helper");
      const logged = agent
        .consoleEntries({})
        .entries.some((e) => e.message.includes("agent page helper"));
      return {
        unknown,
        alive,
        notAsAsked,
        ok,
        before,
        clicked,
        changed,
        hidden,
        pressed,
        skipped: sent.map((m) => `${m.name} ${m.data.step}`),
        fill,
        filled,
        value: field.value,
        logged,
        cards: agent.cards(),
        total: agent.total(),
      };
    });
    Assert.deepEqual(seen, {
      unknown: false,
      alive: true,
      notAsAsked: "changed",
      ok: "ok",
      before: "pending",
      clicked: "clicked",
      changed: "skipped",
      hidden: "skipped",
      pressed: [true, false],
      skipped: ["Vimma:AgentSkipped 8", "Vimma:AgentSkipped 9"],
      fill: "ok",
      filled: "kept",
      value: "hi",
      logged: true,
      cards: false,
      total: null,
    });
  });
});
