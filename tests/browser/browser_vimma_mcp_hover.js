/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// docs/specs/hover.md sub-PR 2 (security.md M67): an agent's `vimma_hover` hovers an element of
// its `vimma_elements` list in a background agent tab, with untrusted events and the `:hover`
// lock, so that what a page shows only under the mouse can be listed and clicked; it is asked
// and granted as a click, shares the clicks' rate, is denied while the user uses the tab, and
// is released by `release: true`, the next hover, a navigation, the user and the connection's end.

"use strict";

/* global Client, tidyTask -- from head_vimma_control.js */
/* global focusContent -- from head.js */
/* global XULBrowserWindow -- a browser window global (browser.js) */
/* global requestLongerTimeout -- the browser-chrome harness (browser-test.js) */
/* global InspectorUtils -- chrome-only, in the content task's scope too */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);

requestLongerTimeout(3);

const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/AgentGate.sys.mjs",
);
const { MCP_ENABLED_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/mcp-ops.mjs",
);
const { HoverOps } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/hover-ops.mjs",
);
const { VimmaActors } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/actors/VimmaActors.sys.mjs",
);
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
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
const PAGE = `${DIR}file_vimma_hover.html`;
const OTHER = `${DIR}file_vimma_hover_other.html`;

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

/** The connections the running task opened. @type {Client[]} */
const clients = [];

/** What a task leaves when it ends, passed or not (tidyTask): this file's state at its start. */
async function putBack() {
  for (const c of clients.splice(0)) c.close();
  if (ww().model.active !== mainId()) ww().switchTo({ id: mainId() });
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  for (const t of gBrowser.tabs.slice(1)) BrowserTestUtils.removeTab(t);
  Services.prefs.clearUserPref(MCP_ENABLED_PREF);
  await VimmaControl.settled();
}

registerCleanupFunction(putBack);

/** add_task, with putBack after the task however it ends. @param {() => Promise<void>} task */
const addTidyTask = (task) => add_task(tidyTask(task, putBack));

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
async function agentClient() {
  const c = new Client(/** @type {number} */ (VimmaControl.port));
  clients.push(c);
  await c.handshake({ protocol: 2, role: "agent" });
  await c.call("agent-hello", { client: { name: "example-agent" } });
  return c;
}

/** The oldest waiting question, once there is one. */
async function question() {
  await until(() => AgentGate.waiting.length > 0, "a question waits");
  return /** @type {AskedQuestion} */ (AgentGate.waiting[0]);
}

/**
 * A request, its question answered with `answer` (none: it must not ask), then its response.
 * @template {string} C
 * @param {Client} c @param {C} command @param {Record<string, unknown>} args
 * @param {Parameters<typeof AgentGate.answer>[1] | null} [answer]
 */
async function call(c, command, args, answer = null) {
  const id = c.request(command, args);
  if (answer) AgentGate.answer((await question()).id, answer);
  const r = await c.response(id);
  if (r.ok) {
    const v = validateMessage(r, { command });
    Assert.deepEqual(v.errors, [], `a valid ${command} result`);
  }
  return r;
}

/** An element list's labels by what the elements say. @param {string} list */
function byText(list) {
  /** @type {Record<string, { label: string, kind: string }>} */
  const by = {};
  for (const line of list.split("\n").slice(1, -1)) {
    if (!line) continue;
    const e = JSON.parse(line);
    if ("label" in e) by[e.text || e.name || e.caption] = { label: e.label, kind: e.kind };
  }
  return by;
}

/**
 * The tab's hover-only targets and buttons by their text, the first call's question answered
 * with `answer`.
 * @param {Client} c @param {MozTabbrowserTab} tab
 * @param {Parameters<typeof AgentGate.answer>[1] | null} [answer]
 */
async function listed(c, tab, answer = null) {
  const r = await call(
    c,
    "agent-elements",
    { tab: idOf(tab), kinds: ["hover", "button"], full: true },
    answer,
  );
  Assert.ok(r.ok, "vimma_elements runs");
  return byText(r.result.elements);
}

/** @type {Parameters<typeof AgentGate.answer>[1]} */
const GRANT = { kind: "grant", minutes: 15 };

/** Whether `id` matches `:hover` in the tab, and whether Vimma holds a lock on it. */
async function hovered(/** @type {MozTabbrowserTab} */ tab, /** @type {string} */ id) {
  return SpecialPowers.spawn(tab.linkedBrowser, [id], (elId) => {
    const el = /** @type {Element} */ (content.document.getElementById(elId));
    return {
      matches: el.matches(":hover"),
      locked: InspectorUtils.hasPseudoClassLock(el, ":hover"),
    };
  });
}

/**
 * @typedef {{ type: string, id: string, trusted: boolean }} HoverEvent  one the page logged
 */

/**
 * The page's hover event log, emptied.
 * @param {MozTabbrowserTab} tab
 * @returns {Promise<HoverEvent[]>}
 */
async function takeLog(tab) {
  return SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const log = content.wrappedJSObject.vimmaLog;
    const out = JSON.parse(JSON.stringify(log));
    log.length = 0;
    return out;
  });
}

addTidyTask(async function test_agent_hover_reveals_and_lists() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const plain = await call(c, "agent-elements", { tab: idOf(tab) }, GRANT);
  Assert.ok(!plain.result.elements.includes('"kind":"hover"'), "a default list has no hover kind");
  // The newest list's labels are the connection's: the one asked with the kind hover.
  const by = await listed(c, tab);
  Assert.equal(by.General?.kind, "hover", "a row's text is listed as kind hover when asked");
  Assert.ok(!by.Settings, "the gear a hover reveals is not listed before it");
  // Under the grant: no question.
  const r = await call(c, "agent-hover", {
    tab: idOf(tab),
    label: by.General.label,
    elements: true,
  });
  Assert.ok(r.ok, `vimma_hover runs: ${JSON.stringify(r.error)}`);
  Assert.equal(AgentGate.waiting.length, 0, "a grant covers it: nothing was asked");
  const result = /** @type {{ hovered?: boolean, navigated?: boolean, elements?: string }} */ (
    r.result
  );
  Assert.equal(result.hovered, true, "the hover holds");
  Assert.equal(result.navigated, false, "no page loaded");
  const after = byText(result.elements ?? "");
  Assert.ok(after.Settings, "the revealed gear is in the list after it");
  Assert.deepEqual(
    await hovered(tab, "row1"),
    { matches: true, locked: true },
    "the row is hovered",
  );
  const status = HoverOps.status(tab.linkedBrowser);
  Assert.equal(status?.text, "General", "chrome holds it, with the element's text");
  Assert.equal(status?.agent, true, "as the agent's");
  Assert.equal(AgentGate.log[0].tool, "vimma_hover", "a :mcp log row");
  Assert.ok(AgentGate.log[0].detail.includes("General"), "naming the element");
  const click = await call(c, "agent-activate", { tab: idOf(tab), label: after.Settings.label });
  Assert.ok(click.ok, "vimma_activate clicks the revealed gear");
  const clicks = await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    JSON.parse(JSON.stringify(content.wrappedJSObject.vimmaClicks)),
  );
  Assert.deepEqual(clicks, ["gear1"], "the gear was clicked");
  Assert.equal((await hovered(tab, "row1")).matches, true, "a click does not end the hover");
});

addTidyTask(async function test_agent_hover_asks_once_as_a_click() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await listed(c, tab, { kind: "once" });
  const id = c.request("agent-hover", { tab: idOf(tab), label: by.General.label });
  const q = await question();
  Assert.equal(q.tool, "vimma_hover", "asked as vimma_hover");
  Assert.equal(q.what.text, "General", "naming the element");
  AgentGate.answer(q.id, { kind: "deny" });
  const r = await c.response(id);
  Assert.equal(r.error?.reason, "user", "a no denies it");
  Assert.equal((await hovered(tab, "row1")).matches, false, "and nothing is hovered");
});

addTidyTask(async function test_agent_hover_events_are_untrusted_and_change_nothing_else() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await listed(c, tab, GRANT);
  const before = XULBrowserWindow.overLink;
  await takeLog(tab);
  let r = await call(c, "agent-hover", { tab: idOf(tab), label: by.General.label });
  Assert.ok(r.ok, "vimma_hover runs");
  const entered = await takeLog(tab);
  Assert.deepEqual(
    entered.filter((e) => e.id === "row1" && e.type.endsWith("enter")).map((e) => e.type),
    ["pointerenter", "mouseenter"],
    "the row gets its enter events",
  );
  Assert.ok(entered.length > 0, "the page saw hover events");
  Assert.ok(
    entered.every((e) => e.trusted === false),
    "every one untrusted (M26, M67)",
  );
  // A link hovered by the agent never reaches the user's link preview.
  const links = await call(c, "agent-elements", { tab: idOf(tab) });
  const link = byText(links.result.elements)["a link"];
  Assert.ok(link, "the link is listed");
  r = await call(c, "agent-hover", { tab: idOf(tab), label: link.label });
  Assert.ok(r.ok, "vimma_hover over a link to another page runs");
  Assert.equal(XULBrowserWindow.overLink, before, "the user's link preview is unchanged");
  const state = await SpecialPowers.spawn(tab.linkedBrowser, [], () => ({
    active: content.navigator.userActivation.hasBeenActive,
    focused: content.document.activeElement?.localName ?? null,
  }));
  Assert.deepEqual(state, { active: false, focused: "body" }, "no activation, nothing focused");
  Assert.notEqual(gBrowser.selectedTab, tab, "the tab stays in the background");
  const left = await takeLog(tab);
  Assert.ok(
    left.some((e) => e.id === "row1" && e.type === "mouseleave" && !e.trusted),
    "moving to the link leaves the row, untrusted",
  );
});

addTidyTask(async function test_agent_hover_is_a_separate_message() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await listed(c, tab, GRANT);
  const userHover = VimmaActors.hover;
  const userRelease = VimmaActors.releaseHover;
  let sent = 0;
  VimmaActors.hover = (...args) => {
    sent++;
    return userHover.apply(VimmaActors, args);
  };
  VimmaActors.releaseHover = (...args) => {
    sent++;
    return userRelease.apply(VimmaActors, args);
  };
  try {
    let r = await call(c, "agent-hover", { tab: idOf(tab), label: by.General.label });
    Assert.ok(r.ok, "vimma_hover runs");
    r = await call(c, "agent-hover", { tab: idOf(tab), release: true });
    Assert.equal(r.result?.released, true, "and is released");
  } finally {
    VimmaActors.hover = userHover;
    VimmaActors.releaseHover = userRelease;
  }
  Assert.equal(sent, 0, "neither went through the user's Vimma:Hover");
  // A hovered row in a frame locks the <iframe> element around it, and only that one.
  const framed = await listed(c, tab);
  Assert.ok(framed["Framed row"], "the framed row is listed");
  const r = await call(c, "agent-hover", { tab: idOf(tab), label: framed["Framed row"].label });
  Assert.ok(r.ok, "vimma_hover in a frame runs");
  await until(async () => (await hovered(tab, "frame")).locked, "the <iframe> element is locked");
  Assert.equal((await hovered(tab, "row1")).locked, false, "nothing else of the top page is");
  const inner = await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    SpecialPowers.spawn(content.document.getElementById("frame"), [], () =>
      /** @type {Element} */ (content.document.getElementById("frow")).matches(":hover"),
    ),
  );
  Assert.ok(inner, "the framed row is hovered");
  await call(c, "agent-hover", { tab: idOf(tab), release: true });
  await until(async () => !(await hovered(tab, "frame")).locked, "the release unlocks it");
});

addTidyTask(async function test_agent_hover_in_use() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await listed(c, tab, GRANT);
  let r = await call(c, "agent-hover", { tab: idOf(tab), label: by.General.label });
  Assert.ok(r.ok, "vimma_hover runs");
  // The user brings the tab to the front and starts using it: the agent's hover goes.
  ww().switchTo({ id: agent().id });
  await until(() => gBrowser.selectedTab === tab, "the agent tab is in front");
  await focusContent(tab.linkedBrowser);
  EventUtils.synthesizeKey("j");
  await until(async () => !(await hovered(tab, "row1")).locked, "the user's key releases it");
  Assert.equal(HoverOps.status(tab.linkedBrowser), null, "and chrome lets it go");
  await BrowserTestUtils.synthesizeMouseAtCenter("#field", {}, tab.linkedBrowser);
  await until(() => VimmaHost.status(window).mode === "insert", "the user is in insert mode");
  r = await c.call("agent-hover", { tab: idOf(tab), label: by.Random.label });
  Assert.equal(r.error?.reason, "in-use", "a tab the user types in is denied (F27)");
  Assert.equal(AgentGate.waiting.length, 0, "before anything is asked");
  Assert.equal((await hovered(tab, "row2")).matches, false, "nothing was hovered");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => VimmaHost.status(window).mode === "normal", "normal mode");
  ww().switchTo({ id: mainId() });
});

addTidyTask(async function test_agent_hover_only_agent_tabs_and_listed_elements() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  // No list yet: no label names anything.
  let r = await c.call("agent-hover", { tab: idOf(tab), label: "sd" });
  Assert.equal(r.error?.code, "failed", "a label without a list is refused");
  Assert.equal(AgentGate.waiting.length, 0, "before anything is asked");
  const own = BrowserTestUtils.addTab(gBrowser, PAGE);
  await BrowserTestUtils.browserLoaded(own.linkedBrowser, false, PAGE);
  r = await c.call("agent-hover", { tab: idOf(own), label: "sd" });
  Assert.ok(!r.ok, "a tab outside the agent workspace is refused");
  r = await c.call("agent-hover", { tab: idOf(own), release: true });
  Assert.ok(!r.ok, "also for a release");
  BrowserTestUtils.removeTab(own);
});

addTidyTask(async function test_agent_hover_release() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await listed(c, tab, GRANT);
  let r = await call(c, "agent-hover", { tab: idOf(tab), label: by.General.label });
  Assert.ok(r.ok, "vimma_hover runs");
  await takeLog(tab);
  // release: true
  r = await call(c, "agent-hover", { tab: idOf(tab), release: true });
  Assert.equal(r.result?.released, true, "released");
  Assert.deepEqual(await hovered(tab, "row1"), { matches: false, locked: false }, "no lock left");
  const log = await takeLog(tab);
  Assert.ok(
    log.some((e) => e.id === "row1" && e.type === "mouseleave" && !e.trusted),
    "with the leave events, untrusted",
  );
  Assert.equal(HoverOps.status(tab.linkedBrowser), null, "chrome lets it go");
  r = await call(c, "agent-hover", { tab: idOf(tab), release: true });
  Assert.equal(r.result?.released, false, "a second release has nothing to end");
  // The next hover moves it.
  let fresh = await listed(c, tab);
  await call(c, "agent-hover", { tab: idOf(tab), label: fresh.General.label });
  r = await call(c, "agent-hover", { tab: idOf(tab), label: fresh.Random.label });
  Assert.ok(r.ok, "a second hover runs");
  Assert.equal((await hovered(tab, "row1")).locked, false, "the first row is let go");
  Assert.equal((await hovered(tab, "row2")).matches, true, "the second is hovered");
  // A navigation into the back-forward cache, and back: no lock left.
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, OTHER);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, OTHER);
  await until(() => HoverOps.status(tab.linkedBrowser) === null, "the navigation releases it");
  const shown = BrowserTestUtils.waitForContentEvent(tab.linkedBrowser, "pageshow");
  tab.linkedBrowser.goBack();
  await shown;
  Assert.deepEqual(
    await hovered(tab, "row2"),
    { matches: false, locked: false },
    "back from the cache, no lock left",
  );
  // The connection's end.
  fresh = await listed(c, tab);
  r = await call(c, "agent-hover", { tab: idOf(tab), label: fresh.General.label });
  Assert.ok(r.ok, "hovered again");
  c.close();
  await until(async () => !(await hovered(tab, "row1")).locked, "the connection's end releases it");
  Assert.equal(HoverOps.status(tab.linkedBrowser), null, "and chrome lets it go");
});

addTidyTask(async function test_agent_hover_rate() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await listed(c, tab, GRANT);
  // Counted when asked, before the label is looked up (F26): 29 hovers of no element, a click.
  for (let i = 0; i < 29; i++) {
    const r = await c.call("agent-hover", { tab: idOf(tab), label: "jjj" });
    Assert.equal(r.error?.code, "failed", "a label naming nothing fails");
  }
  const click = await call(c, "agent-activate", { tab: idOf(tab), label: by.General.label });
  Assert.notEqual(click.error?.reason, "busy", "the 30th call in a minute runs");
  const busy = await c.call("agent-hover", { tab: idOf(tab), label: by.General.label });
  Assert.equal(busy.error?.reason, "busy", "the 31st, hover or click, is refused");
  Assert.equal(
    busy.error?.message,
    "too many vimma_activate, vimma_fill and vimma_hover calls from this agent in the last " +
      "minute (at most 30)",
    "naming the shared limit",
  );
  // A release ends only what the connection began: it is never refused for the rate.
  const release = await call(c, "agent-hover", { tab: idOf(tab), release: true });
  Assert.ok(release.ok, "a release runs past the rate");
});

// security.md M67: a release or the connection's end while a hover is still on its way
// to the page ends it too; no lock stays that chrome does not know of.
addTidyTask(async function test_agent_hover_released_while_pending() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await listed(c, tab, GRANT);
  const hovering = c.request("agent-hover", { tab: idOf(tab), label: by.General.label });
  const released = await c.call("agent-hover", { tab: idOf(tab), release: true });
  Assert.ok(released.ok, "the release runs");
  await c.response(hovering);
  await TestUtils.waitForTick();
  Assert.deepEqual(
    await hovered(tab, "row1"),
    { matches: false, locked: false },
    "a hover released before it ran leaves no lock",
  );
  Assert.equal(HoverOps.status(tab.linkedBrowser), null, "and chrome holds none");
  // The connection ends while its hover is on its way.
  const c2 = await agentClient();
  const by2 = await listed(c2, tab, GRANT);
  c2.request("agent-hover", { tab: idOf(tab), label: by2.Random.label });
  c2.close();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  Assert.deepEqual(
    await hovered(tab, "row2"),
    { matches: false, locked: false },
    "a hover whose connection ended leaves no lock",
  );
  Assert.equal(HoverOps.status(tab.linkedBrowser), null, "and chrome holds none");
});

// security.md M67: the user's own hover in a tab is the user's: an agent's hover there
// is denied as the tab being in use, and its release never ends the user's.
addTidyTask(async function test_agent_hover_leaves_the_users_hover() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  const by = await listed(c, tab, GRANT);
  const targets = await VimmaActors.collectHints(tab.linkedBrowser, "hint.hover");
  const row = await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const r = /** @type {Element} */ (
      content.document.getElementById("name2")
    ).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const target = targets.find(
    (t) =>
      t.rect.x <= row.x &&
      row.x <= t.rect.x + t.rect.width &&
      t.rect.y <= row.y &&
      row.y <= t.rect.y + t.rect.height,
  );
  Assert.ok(target, "the user's hint for the second row");
  await HoverOps.hover(tab.linkedBrowser, /** @type {HintTarget} */ (target));
  Assert.equal(HoverOps.status(tab.linkedBrowser)?.agent, false, "the user holds a hover");
  const r = await c.call("agent-hover", { tab: idOf(tab), label: by.General.label });
  Assert.equal(r.error?.reason, "in-use", "an agent's hover is denied while the user hovers");
  const release = await call(c, "agent-hover", { tab: idOf(tab), release: true });
  Assert.equal(release.result?.released, false, "an agent's release has nothing of its own");
  Assert.equal(HoverOps.status(tab.linkedBrowser)?.agent, false, "the user's hover holds");
  Assert.equal((await hovered(tab, "row2")).locked, true, "with its lock");
  HoverOps.release(tab.linkedBrowser);
});

// security.md M31, M67: a rich text editor's content is never listed, also not as a
// hover target.
addTidyTask(async function test_agent_hover_lists_nothing_inside_an_editor() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const doc = content.document;
    const editor = doc.createElement("div");
    editor.contentEditable = "true";
    editor.innerHTML = '<p><span title="a note">Private draft words</span></p>';
    doc.body.prepend(editor);
  });
  const r = await call(
    c,
    "agent-elements",
    { tab: idOf(tab), kinds: ["hover"], full: true },
    GRANT,
  );
  Assert.ok(r.ok, "vimma_elements runs");
  Assert.ok(!r.result.elements.includes("Private draft"), "the editor's text is not listed");
});
