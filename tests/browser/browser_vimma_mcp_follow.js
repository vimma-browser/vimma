/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/mcp-drive.md, sub-PR 3: `vimma_keys`'s `f` lists an agent tab's visible links
// with labels, inside the untrusted-content delimiters (D12, D16; security.md M21), and
// `f<label>` follows one as a load of its href, never a click, from labels of the current
// document no older than 120 s; a link to another site is asked as `vimma_open` unless a
// `vimma_open` grant is in force (D18; M18); follows take slots of the open rate (M20). The
// agent's collection is keyed by its tab, so the user's hint mode in the same window is left
// alone.

"use strict";

/* global focusContent -- from head.js */
/* global Client -- from head_vimma_control.js */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);

const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentGate.sys.mjs",
);
const { AgentDrive } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentDrive.sys.mjs",
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
const LINKS = `${DIR}file_vimma_agent_links.html`;
const PAGE = `${DIR}file_vimma_agent_page.html`;
const OTHER = `${PAGE.replace("https://example.com", "https://example.org")}?other`;
const SUB = `${PAGE.replace("https://example.com", "https://test1.example.com")}?sub`;
const NOTICE_ID = "vimma-notice";
/** The fixture's links in reading order get these labels (DEFAULT_HINT_CHARS). */
const LABEL = { same: "a", handled: "s", js: "d", data: "f", other: "g", sub: "h" };

registerCleanupFunction(async () => {
  Services.prefs.clearUserPref(MCP_ENABLED_PREF);
  AgentDrive._linkTtlMs = null;
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
async function openAgentTab(url = LINKS) {
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
 * `agent-keys` on `tab`, answered with `answer` (null: not asked, a grant runs it).
 * @param {any} c @param {any} tab @param {string} keys @param {object | null} [answer]
 */
async function keys(c, tab, keys, answer = { kind: "once" }) {
  const id = c.request("agent-keys", { tab: idOf(tab), keys });
  if (answer) {
    const q = await question();
    Assert.equal(q.tool, "vimma_keys", "agent-keys asks as vimma_keys");
    AgentGate.answer(q.id, answer);
  }
  const r = await c.response(id);
  if (r.ok) {
    const v = validateMessage(r, { command: "agent-keys" });
    Assert.deepEqual(v.errors, [], `${keys}: a valid agent-keys result`);
  }
  return r;
}

/** The link list's lines, between the delimiters. @param {string} links */
const lines = (links) => links.split("\n").slice(1, -1);

add_task(async function test_f_lists_links_with_labels_marked_untrusted() {
  await mcp(true);
  const tab = await openAgentTab();
  await focusContent(gBrowser.selectedBrowser);
  const before = { workspace: activeName(), selected: gBrowser.selectedTab };
  const c = await agentClient();
  const r = await keys(c, tab, "f");
  Assert.ok(r.ok, "f runs");
  Assert.deepEqual(r.result.steps, [{ keys: "f", action: "hint.follow", ok: true }], "one step");
  Assert.ok(
    r.result.links.startsWith("<untrusted-web-content>\n") &&
      r.result.links.endsWith("\n</untrusted-web-content>"),
    "the list is inside the untrusted-content delimiters (M21)",
  );
  Assert.deepEqual(
    lines(r.result.links),
    [
      `a "Same site page" ${PAGE}?same`,
      `s "Handled link" ${PAGE}?href`,
      `d "Script link" javascript:void(document.title='ran')`,
      `f "Data link" data:text/html,hi`,
      `g "Other site" ${OTHER}`,
      `h "Subdomain" ${SUB}`,
    ],
    "each link in reading order: label, text, href; the button is not a link",
  );
  Assert.equal(r.result.dropped, 0, "none left out");
  Assert.equal(r.result.url, LINKS, "the page did not change");
  Assert.deepEqual(
    { workspace: activeName(), selected: gBrowser.selectedTab },
    before,
    "the window kept its workspace and tab",
  );
  Assert.ok(tab.hidden, "the agent tab stayed hidden");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

add_task(async function test_follow_loads_the_href_without_a_click() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  await keys(c, tab, "f");
  const r = await keys(c, tab, `f${LABEL.handled}`);
  Assert.deepEqual(
    r.result.steps,
    [{ keys: `f${LABEL.handled}`, action: "hint.follow", ok: true }],
    "the follow ran",
  );
  Assert.equal(
    r.result.url,
    `${PAGE}?href`,
    "the href loaded: no click or mousedown handler ran, which would have gone to ?clicked (M18)",
  );
  Assert.equal(tab.linkedBrowser.currentURI.spec, `${PAGE}?href`, "in the same tab");
  Assert.equal(r.result.loading, false, "and the result waited for the page");
  Assert.ok(tab.hidden, "in the background");
  const referrer = await SpecialPowers.spawn(
    tab.linkedBrowser,
    [],
    () => content.document.referrer,
  );
  Assert.equal(referrer, "", "a follow sends no referrer, whatever the page's policy");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

// A load can pass through an initial about:blank, which a process switch makes in the tab: that
// document is not the page the step loaded, so the wait goes on past it to the page itself.
add_task(async function test_the_load_wait_passes_over_an_initial_document() {
  const tab = BrowserTestUtils.addTab(gBrowser);
  const browser = tab.linkedBrowser;
  await until(() => !!browser.browsingContext?.currentWindowGlobal, "the tab has a document");
  Assert.ok(browser.browsingContext.currentWindowGlobal.isInitialDocument, "its initial one");
  Assert.ok(!browser.webProgress.isLoadingDocument, "which is not loading");
  // What the tab showed before the step: another document at another URL.
  const before = { doc: 0, url: LINKS };
  Assert.equal(
    await AgentDrive._loaded(browser, before, Date.now() + 500),
    false,
    "the initial document does not count as the loaded page",
  );
  BrowserTestUtils.startLoadingURIString(browser, PAGE);
  Assert.ok(
    await AgentDrive._loaded(browser, before, Date.now() + 10000),
    "the page after it does",
  );
  Assert.equal(browser.currentURI.spec, PAGE, "and is the page that loaded");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_follow_refuses_javascript_and_data_hrefs() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  await keys(c, tab, "f");
  const r = await keys(c, tab, `f${LABEL.js} f${LABEL.data}`);
  for (const step of r.result.steps) {
    Assert.equal(step.ok, false, `${step.keys} is not followed`);
    Assert.equal(step.note, "only http and https links are followed", "and says why");
  }
  Assert.equal(r.result.url, LINKS, "nothing loaded");
  const title = await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.document.title);
  Assert.equal(title, "Links agent fixture", "the javascript: href never ran");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

add_task(async function test_stale_labels_are_refused() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  let r = await keys(c, tab, `f${LABEL.same}`);
  Assert.equal(r.result.steps[0].ok, false, "a label without an f before it is refused");
  Assert.equal(r.result.steps[0].note, "stale labels: send f again", "as stale");

  await keys(c, tab, "f");
  // The page navigates: its labels could now name other links.
  const again = `${LINKS}?again`;
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, again);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, again);
  r = await keys(c, tab, `f${LABEL.same}`);
  Assert.equal(r.result.steps[0].note, "stale labels: send f again", "after a navigation");
  Assert.equal(r.result.url, again, "nothing loaded");

  // Labels last 120 s; the test shortens that.
  await keys(c, tab, "f");
  AgentDrive._linkTtlMs = 0;
  r = await keys(c, tab, `f${LABEL.same}`);
  AgentDrive._linkTtlMs = null;
  Assert.equal(r.result.steps[0].note, "stale labels: send f again", "once they expired");

  // Another connection's labels are its own.
  await keys(c, tab, "f");
  const other = await agentClient("other-agent");
  r = await keys(other, tab, `f${LABEL.same}`);
  Assert.equal(r.result.steps[0].note, "stale labels: send f again", "per connection");
  r = await keys(c, tab, `fk`);
  Assert.equal(r.result.steps[0].ok, false, "a label no link has is refused");
  Assert.equal(r.result.steps[0].note, 'no link has the label "k"', "naming it");
  other.close();
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

add_task(async function test_agent_hints_leave_the_users_hint_mode_alone() {
  await mcp(true);
  const tab = await openAgentTab();
  const mine = await BrowserTestUtils.openNewForegroundTab(gBrowser, LINKS);
  await focusContent(mine.linkedBrowser);
  const c = await agentClient();
  // The user is in hint mode in their own tab of the same window.
  EventUtils.synthesizeKey("f");
  await until(() => VimmaHost.status(window).mode === "hint", "the user's hint mode");
  const r = await keys(c, tab, "f");
  Assert.equal(lines(r.result.links).length, 6, "the agent's f got its links");
  Assert.equal(VimmaHost.status(window).mode, "hint", "the user's hint mode is still on (D12)");
  EventUtils.synthesizeKey(LABEL.same);
  await BrowserTestUtils.browserLoaded(mine.linkedBrowser, false, `${PAGE}?same`);
  Assert.ok(true, "and the user's label still follows their link");
  Assert.equal(tab.linkedBrowser.currentURI.spec, LINKS, "the agent tab did not move");

  // The other way round: the user's f while the agent's collection runs does not void it.
  BrowserTestUtils.startLoadingURIString(mine.linkedBrowser, LINKS);
  await BrowserTestUtils.browserLoaded(mine.linkedBrowser, false, LINKS);
  const agents = VimmaActors.collectHints(tab.linkedBrowser, "hint.follow", { agent: true });
  await VimmaActors.collectHints(mine.linkedBrowser, "hint.follow");
  Assert.equal((await agents).length, 6, "the agent's collection is keyed by its own tab");

  // In one tab, an agent's collection never takes the user's targets from the page's child.
  const users = await VimmaActors.collectHints(mine.linkedBrowser, "hint.follow");
  await VimmaActors.collectHints(mine.linkedBrowser, "hint.follow", { agent: true });
  const same = users.find((t) => t.href === `${PAGE}?same`);
  VimmaActors.activateHint(same);
  await BrowserTestUtils.browserLoaded(mine.linkedBrowser, false, `${PAGE}?same`);
  Assert.ok(true, "the user's target still follows after an agent's collection there");
  c.close();
  BrowserTestUtils.removeTab(mine);
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

add_task(async function test_cross_site_follow_asks_as_vimma_open() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient("claude-code");
  // Under a vimma_keys grant, a same-site follow runs unasked: a subdomain is the same site.
  await keys(c, tab, "f", { kind: "grant", minutes: 5 });
  let r = await keys(c, tab, `f${LABEL.sub}`, null);
  Assert.equal(r.result.url, SUB, "a follow to a subdomain runs under the keys grant");
  await until(
    () => noticeText().startsWith('claude-code followed a link to test1.example.com in "'),
    "its notice names the host it loaded (D14)",
  );
  const row = AgentGate.log.find((e) => e.outcome === "followed");
  Assert.equal(row?.detail, `f${LABEL.sub} → ${SUB}`, ":mcp log names the URL it loaded (M23)");
  Assert.equal(row?.tool, "vimma_keys", "as a vimma_keys row");
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, LINKS);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, LINKS);

  // Another site is asked as vimma_open, with the whole URL (D18).
  await keys(c, tab, "f", null);
  let id = c.request("agent-keys", { tab: idOf(tab), keys: `f${LABEL.other} j` });
  let q = await question();
  Assert.equal(q.tool, "vimma_open", "a cross-site follow asks as vimma_open");
  Assert.equal(q.what.url, OTHER, "naming the whole URL");
  Assert.equal(q.what.host, "example.org", "and its host");
  Assert.equal(q.what.current, LINKS, "and the page it replaces");
  AgentGate.answer(q.id, { kind: "deny" });
  r = await c.response(id);
  Assert.equal(r.result.stopped, "denied", "a no stops the call");
  Assert.equal(r.result.steps.length, 1, "after the follow");
  Assert.equal(r.result.steps[0].ok, false, "which did not run");
  Assert.equal(
    r.result.steps[0].note,
    "the user did not allow loading example.org",
    "and says the user said no to that host",
  );
  Assert.equal(r.result.url, LINKS, "nothing loaded");

  // A yes loads it.
  await keys(c, tab, "f", null);
  id = c.request("agent-keys", { tab: idOf(tab), keys: `f${LABEL.other}` });
  q = await question();
  AgentGate.answer(q.id, { kind: "grant", minutes: 5 });
  r = await c.response(id);
  Assert.equal(r.result.url, OTHER, "after the yes the other site loads");
  Assert.ok(
    AgentGate.log.some((e) => e.outcome === "followed" && e.detail.endsWith(OTHER)),
    "and the log names it too, after a yes",
  );

  // With a vimma_open grant, a cross-site follow runs unasked.
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, LINKS);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, LINKS);
  await keys(c, tab, "f", null);
  r = await keys(c, tab, `f${LABEL.other}`, null);
  Assert.equal(r.result.url, OTHER, "a vimma_open grant already means load any URL");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

add_task(async function test_follows_count_towards_the_open_rate() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  // Ten opens, the most a minute (M3), under a grant.
  const id = c.request("agent-open", { url: `${PAGE}?1` });
  AgentGate.answer((await question()).id, { kind: "grant", minutes: 5 });
  await c.response(id);
  for (let i = 2; i <= 10; i++) {
    Assert.ok((await c.call("agent-open", { url: `${PAGE}?x${i}` })).ok, `open ${i}`);
  }
  await keys(c, tab, "f");
  let r = await keys(c, tab, `f${LABEL.same}`);
  Assert.equal(r.result.stopped, "denied", "a follow needs a slot of the open rate (M20)");
  Assert.equal(r.result.steps[0].ok, false, "the step did not run");
  Assert.equal(r.result.url, LINKS, "and nothing loaded");
  // A cross-site follow is not asked when the rate is used up: a yes would load nothing.
  await keys(c, tab, "f");
  r = await keys(c, tab, `f${LABEL.other}`);
  Assert.equal(r.result.stopped, "denied", "a cross-site follow over the rate is denied");
  Assert.equal(AgentGate.waiting.length, 0, "without a vimma_open question");
  c.close();
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  await mcp(false);
});

add_task(async function test_links_only_on_web_pages() {
  await mcp(true);
  // A tab the user moved into the agent workspace may show a page that is not on the web.
  const tab = gBrowser.addTab("about:robots", {
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, "about:robots");
  await until(() => tab.hidden, "the agent tab is hidden in its workspace");
  const c = await agentClient();
  const r = await keys(c, tab, "f");
  Assert.equal(r.result.steps[0].ok, false, "f lists nothing there");
  Assert.equal(
    r.result.steps[0].note,
    "links are listed and followed only on http and https pages",
    "and says why",
  );
  Assert.equal(r.result.links, undefined, "no list");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});
