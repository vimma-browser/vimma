/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/mcp-forms.md, sub-PR 4: `vimma_screenshot` (`agent-screenshot`) returns an
// image of an agent tab's viewport, taken in the background without selecting or showing the tab
// (F18; security.md M25), as a PNG, or a JPEG when the PNG does not fit the reply line (F19), with
// the labels of the connection's current `vimma_elements` list drawn on it when asked (F20). It is
// refused while a password or payment card field on screen, in any frame, has a value, and at
// most 12 are taken a connection a minute (F21; security.md M32).

"use strict";

/* global Client -- from head_vimma_control.js */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);

const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentGate.sys.mjs",
);
const { AgentShot } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentShot.sys.mjs",
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
const { MAX_LINE_LENGTH, validateMessage } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/index.mjs",
);

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const SHOT = `${DIR}file_vimma_agent_shot.html`;
const NOTICE_ID = "vimma-notice";
const ASK_TIMEOUT = "vimma.mcp.askTimeoutMs";
const SENSITIVE = "a payment or password field on screen has a value; Vimma does not capture it";

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
async function openAgentTab(url = SHOT) {
  const tab = gBrowser.addTab(url, {
    userContextId: agent().userContextId,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  await until(() => tab.hidden, "the agent tab is hidden in its workspace");
  if (url.startsWith(SHOT)) {
    await until(
      () =>
        tab.linkedBrowser.browsingContext.children[0]?.currentWindowGlobal?.documentURI?.spec?.endsWith(
          "file_vimma_agent_shot_card.html",
        ),
      "the payment frame loaded",
    );
  }
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
 * `agent-screenshot` on `tab`, answered with `answer` (null: not asked, a grant runs it).
 * @param {any} c @param {any} tab @param {object} [args] @param {object | null} [answer]
 */
async function screenshot(c, tab, args = {}, answer = { kind: "once" }) {
  const id = c.request("agent-screenshot", { tab: idOf(tab), ...args });
  if (answer) {
    const q = await question();
    Assert.equal(q.tool, "vimma_screenshot", "agent-screenshot asks as vimma_screenshot");
    AgentGate.answer(q.id, answer);
  }
  const r = await c.response(id);
  if (r.ok) {
    const v = validateMessage(r, { command: "agent-screenshot" });
    Assert.deepEqual(v.errors, [], "a valid agent-screenshot result");
  }
  return r;
}

/** `agent-elements` on `tab`, answered once. @param {any} c @param {any} tab */
async function elements(c, tab) {
  const id = c.request("agent-elements", { tab: idOf(tab) });
  AgentGate.answer((await question()).id, { kind: "once" });
  return c.response(id);
}

/**
 * The image of a result, to read pixels from.
 * @param {{ data: string, mimeType: string }} result
 */
async function decode(result) {
  const bytes = /** @type {any} */ (Uint8Array).fromBase64(result.data);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: result.mimeType }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  return {
    width: bitmap.width,
    height: bitmap.height,
    /** @param {number} x @param {number} y */
    at: (x, y) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)],
  };
}

/** A CSS colour as [r, g, b]. @param {string} css */
function rgb(css) {
  const ctx = new OffscreenCanvas(1, 1).getContext("2d");
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
}

/** Whether two colours are within `d` of each other in every channel. */
const near = (/** @type {number[]} */ a, /** @type {number[]} */ b, d = 3) =>
  a.every((v, i) => Math.abs(v - b[i]) <= d);

/**
 * Sets a field of the page, or of its payment frame, as the user's typing would, and scrolls the
 * page to it or back to the top.
 * @param {any} tab @param {string} id @param {string} value @param {{ frame?: boolean, scroll?: boolean }} [o]
 */
async function typeInto(tab, id, value, { frame = false, scroll = true } = {}) {
  const bc = frame
    ? tab.linkedBrowser.browsingContext.children[0]
    : tab.linkedBrowser.browsingContext;
  await SpecialPowers.spawn(bc, [id, value], (fid, v) => {
    const el = content.document.getElementById(fid);
    el.setUserInput(v);
  });
  if (!frame) {
    await SpecialPowers.spawn(tab.linkedBrowser, [id, scroll], (fid, s) => {
      if (s) content.document.getElementById(fid).scrollIntoView({ block: "center" });
      else content.scrollTo(0, 0);
    });
  }
}

add_task(async function test_screenshot_of_a_background_tab_shows_its_page() {
  await mcp(true);
  const tab = await openAgentTab();
  // The page changes after its load, while it is in the background: the image must show it now.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.getElementById("band").style.background = "rgb(255, 0, 0)";
  });
  const before = { workspace: activeName(), selected: gBrowser.selectedTab };
  const c = await agentClient();
  const r = await screenshot(c, tab);
  Assert.ok(r.ok, `vimma_screenshot runs: ${JSON.stringify(r.error)}`);
  Assert.equal(r.result.url, SHOT, "the page");
  Assert.equal(r.result.title, "Screenshot agent fixture", "its title");
  Assert.equal(r.result.mimeType, "image/png", "a PNG");
  Assert.ok(!("labels" in r.result), "no labels unless asked");
  const image = await decode(r.result);
  Assert.deepEqual([image.width, image.height], [r.result.width, r.result.height], "its size");
  const { width, height } = tab.linkedBrowser.getBoundingClientRect();
  const scale = Math.min(window.devicePixelRatio, 1280 / width);
  Assert.ok(image.width <= 1280, "at most 1,280 pixels wide");
  Assert.equal(image.width, Math.round(width * scale), "the whole viewport's width");
  Assert.equal(image.height, Math.round(height * scale), "and height");
  Assert.deepEqual(image.at(10, 10), [255, 0, 0], "shows the page as it is now (F18)");
  Assert.deepEqual(image.at(10, 125 * scale + 40), [255, 255, 255], "below the band, the page");
  Assert.deepEqual(
    { workspace: activeName(), selected: gBrowser.selectedTab },
    before,
    "the window kept its workspace and tab (M25)",
  );
  Assert.ok(tab.hidden, "the agent tab stayed hidden");
  Assert.ok(!tab.linkedBrowser.docShellIsActive, "and inactive");
  // A zoomed page is captured as it shows: the same viewport, its contents larger.
  tab.linkedBrowser.fullZoom = 2;
  const zoomed = await screenshot(c, tab);
  tab.linkedBrowser.fullZoom = 1;
  const big = await decode(zoomed.result);
  // The zoomed viewport is a whole number of the page's CSS pixels: a pixel more at most.
  Assert.ok(
    Math.abs(big.width - image.width) <= 1 && Math.abs(big.height - image.height) <= 1,
    `the same size zoomed: ${big.width}x${big.height}`,
  );
  Assert.deepEqual(big.at(10, 200 * scale), [255, 0, 0], "with the band twice as high");
  Assert.deepEqual(image.at(10, 200 * scale), [255, 255, 255], "where unzoomed is the page");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

add_task(async function test_screenshot_fits_the_reply_line() {
  await mcp(true);
  const c = await agentClient();
  // Coarse noise: too much for a PNG within the reply, not for a JPEG.
  const tab = await openAgentTab(`${SHOT}?noise=4`);
  let r = await screenshot(c, tab);
  Assert.ok(r.ok, `a noisy page is captured: ${JSON.stringify(r.error)}`);
  Assert.equal(r.result.mimeType, "image/jpeg", "as a JPEG (F19)");
  Assert.ok(r.result.data.length <= 700 * 1024, "whose base64 fits 700 KiB");
  Assert.ok(r.bytes <= MAX_LINE_LENGTH, "in one reply line");
  const image = await decode(r.result);
  Assert.equal(image.width, r.result.width, "a whole image");
  // An image that fits no encoding is refused, with nothing sent. The real limit takes a
  // screen larger than the test window's, so the test lowers it.
  AgentShot._base64Max = 64 * 1024;
  r = await screenshot(c, tab);
  AgentShot._base64Max = null;
  Assert.equal(r.error?.code, "failed", "a screenshot too large for the reply is refused");
  Assert.equal(r.error?.message, "the screenshot is too large", "and says so");
  Assert.equal(AgentGate.log[0].outcome, "failed", ":mcp log says it failed");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

add_task(async function test_screenshot_draws_labels() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  // Without a current element list nothing is drawn, and the result says so (F20).
  let r = await screenshot(c, tab, { labels: true });
  Assert.ok(r.ok, "a screenshot with labels runs");
  Assert.deepEqual([r.result.labels, r.result.stale], [0, true], "no list: stale, none drawn");
  const go = await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const b = content.document.getElementById("go").getBoundingClientRect();
    return { x: b.x, y: b.y };
  });
  const plain = await decode(r.result);
  const listed = await elements(c, tab);
  Assert.ok(listed.ok, "vimma_elements lists the page");
  const count = listed.result.elements.split("\n").filter((l) => l.includes('"label"')).length;
  r = await screenshot(c, tab, { labels: true });
  Assert.ok(r.ok, "and the screenshot runs");
  Assert.equal(r.result.labels, count, "every listed label on screen is drawn");
  Assert.ok(!("stale" in r.result), "from a current list");
  const labelled = await decode(r.result);
  const scale = r.result.width / tab.linkedBrowser.getBoundingClientRect().width;
  const style = getComputedStyle(document.documentElement);
  const hint = rgb(style.getPropertyValue("--vimma-hint-bg").trim() || "#1bf587");
  const corner = [go.x * scale + 2, go.y * scale + 2];
  Assert.ok(
    near(labelled.at(...corner), hint),
    `the button's label in the hint colour at its corner: ${labelled.at(...corner)} vs ${hint}`,
  );
  Assert.ok(!near(plain.at(...corner), hint), "where the page alone draws no hint colour");
  // Without labels asked, the same page has none.
  r = await screenshot(c, tab);
  Assert.ok(!near((await decode(r.result)).at(...corner), hint), "no labels unless asked");
  // Once the page scrolled, the list's places are wrong: nothing is drawn, and it is stale.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.scrollTo(0, 40));
  r = await screenshot(c, tab, { labels: true });
  Assert.deepEqual([r.result.labels, r.result.stale], [0, true], "a scrolled page: stale");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

add_task(async function test_screenshot_refused_while_a_sensitive_value_is_on_screen() {
  await mcp(true);
  const tab = await openAgentTab();
  const c = await agentClient();
  // A card form without autocomplete attributes, found by form autofill's heuristics.
  await typeInto(tab, "cardno", "4111111111111111");
  let r = await screenshot(c, tab);
  Assert.equal(r.error?.code, "failed", "a card number on screen is refused (F21)");
  Assert.equal(r.error?.message, SENSITIVE, "and says why");
  Assert.equal(AgentGate.log[0].outcome, "failed", ":mcp log says it failed");
  // The same value scrolled out of the viewport is not captured, so the screenshot runs.
  await typeInto(tab, "cardno", "4111111111111111", { scroll: false });
  r = await screenshot(c, tab);
  Assert.ok(r.ok, `with the field off screen it runs: ${JSON.stringify(r.error)}`);
  // An empty card field on screen is fine; a password with a value is not.
  await typeInto(tab, "cardno", "");
  r = await screenshot(c, tab);
  Assert.ok(r.ok, "an empty card field on screen is captured");
  await typeInto(tab, "pw", "hunter2-secret");
  r = await screenshot(c, tab);
  Assert.equal(r.error?.message, SENSITIVE, "a password with a value on screen is refused");
  await typeInto(tab, "pw", "", { scroll: false });
  // A hosted payment frame of another site is checked in its own process.
  await typeInto(tab, "hosted", "5555444433331111", { frame: true });
  r = await screenshot(c, tab);
  Assert.equal(r.error?.message, SENSITIVE, "a card number in a frame of another site too");
  await typeInto(tab, "hosted", "", { frame: true });
  r = await screenshot(c, tab);
  Assert.ok(r.ok, "and once it is empty, the page is captured");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});

add_task(async function test_screenshot_only_of_agent_tabs() {
  await mcp(true);
  const c = await agentClient();
  // A tab of the user's own workspace is unknown to the agent (M2), and nothing is asked.
  const mine = await BrowserTestUtils.openNewForegroundTab(gBrowser, SHOT);
  const r = await c.call("agent-screenshot", { tab: idOf(mine) });
  Assert.equal(r.error?.code, "invalid-args", "the user's tab is refused");
  Assert.equal(AgentGate.waiting.length, 0, "unasked");
  BrowserTestUtils.removeTab(mine);
  c.close();
  await mcp(false);
});

add_task(async function test_screenshot_under_a_grant_notice_log_and_rate() {
  await mcp(true);
  Services.prefs.setIntPref(ASK_TIMEOUT, 200);
  const tab = await openAgentTab();
  const c = await agentClient("claude-code");
  let r = await screenshot(c, tab, {}, { kind: "grant", minutes: 12 });
  Assert.ok(r.ok, "a grants vimma_screenshot");
  r = await screenshot(c, tab, {}, null);
  Assert.ok(r.ok, "the next screenshot runs unasked");
  await until(
    () => noticeText().startsWith('claude-code took a screenshot of "Screenshot agent fixture"'),
    "with a notice naming the page",
  );
  Assert.equal(AgentGate.log[0].tool, "vimma_screenshot", "and a row in :mcp log (M23)");
  Assert.equal(AgentGate.log[0].outcome, "grant", "that ran under the grant");
  // A screenshot grant is no element-list grant (F25).
  const list = c.request("agent-elements", { tab: idOf(tab) });
  Assert.equal((await question()).tool, "vimma_elements", "a list still asks");
  AgentGate.answer(AgentGate.waiting[0].id, { kind: "deny" });
  await c.response(list);
  // 12 a minute, counted when asked (F21): 2 so far.
  let busy = null;
  for (let i = 0; i < 11 && !busy; i++) {
    const x = await c.call("agent-screenshot", { tab: idOf(tab) });
    if (!x.ok) busy = { i, x };
  }
  Assert.equal(busy?.i, 10, "the 13th screenshot in a minute is refused");
  Assert.equal(busy?.x.error.reason, "busy", "as busy");
  Assert.equal(AgentGate.log[0].outcome, "busy", "and logged");
  c.close();
  Services.prefs.clearUserPref(ASK_TIMEOUT);
  BrowserTestUtils.removeTab(tab);
  await mcp(false);
});
