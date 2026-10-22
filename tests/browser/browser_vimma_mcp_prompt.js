/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/vimma-mcp.md, sub-PR 2b: the agent question line. It opens by itself only in
// a focused window, out of fields, after 1,500 ms without a key (decision 14); otherwise it
// waits as `◇ agent 1?` for ctrl+b shift+a. Armed after security.dialog_enable_delay, held keys
// never count, other keys neither allow nor deny (13); a count and `a` grant every tool
// (20, mcp-grants G1) with a notice naming the scope and `◇ agent 14m` (23, 24, G3), and
// ctrl+b shift+a ends it at once (G4); timeouts deny with a notice (16); questions one at a time (17); `x`
// mutes (18). It never takes focus. browser_vimma_mcp_control.js has the window not in front
// (15), full control (29 C) and `:control` (29 D).

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
const { MCP_ENABLED_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/mcp-ops.mjs",
);
const { CONTROL_UNTIL_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/control-ops.mjs",
);

const CONTROL = "vimma.control.enabled";
const ASK_TIMEOUT = "vimma.mcp.askTimeoutMs";
const ARMING = "security.dialog_enable_delay";
const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = `${DIR}file_vimma_agent_page.html`;
const FORM = `data:text/html,<input id="f" value="">`;

registerCleanupFunction(async () => {
  for (const pref of [CONTROL, MCP_ENABLED_PREF, ASK_TIMEOUT, ARMING, CONTROL_UNTIL_PREF]) {
    Services.prefs.clearUserPref(pref);
  }
  AgentGate.revoke();
  await VimmaControl.settled();
});

/** @param {() => boolean} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 500);
const line = () => document.getElementById("vimma-agent-prompt");
const lineOpen = () => !!line() && !line().hidden;
const lineText = () => line()?.querySelector(".vimma-agent-prompt-text")?.textContent ?? "";
const hintShown = () => {
  const hint = line()?.querySelector(".vimma-agent-prompt-hint");
  return !!hint && !hint.hidden && hint.textContent !== "";
};
const segment = () =>
  document.querySelector('#vimma-statusbar [data-segment="agent"]')?.textContent ?? null;
const noticeText = () => document.getElementById("vimma-notice")?.textContent ?? "";
const renamePrompt = () => document.getElementById("vimma-rename");

async function setSwitches({ control = false, mcp = false }) {
  Services.prefs.setBoolPref(CONTROL, control);
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, mcp);
  await VimmaControl.settled();
}

/** An agent connection, after its agent-hello. */
async function agentClient(name = "example-agent") {
  const c = new Client(/** @type {number} */ (VimmaControl.port));
  const welcome = await c.handshake({ protocol: 2, role: "agent" });
  Assert.equal(welcome.role, "agent", "an agent connection");
  await c.call("agent-hello", { client: { name }, via: "example" });
  return c;
}

/** Quiet keys and a focused page: the question may open by itself after 1,500 ms. */
async function calmPage() {
  await focusContent(gBrowser.selectedBrowser);
  await new Promise((r) => setTimeout(r, 1600));
}

/** Wait until the line is open and armed. */
async function armed() {
  await until(lineOpen, "the question line opens");
  await until(hintShown, "and arms");
}

add_task(async function setup() {
  BrowserTestUtils.startLoadingURIString(gBrowser.selectedBrowser, PAGE);
  await BrowserTestUtils.browserLoaded(gBrowser.selectedBrowser, false, PAGE);
});

add_task(async function test_the_line_opens_arms_and_ignores_stray_keys() {
  await setSwitches({ mcp: true });
  Services.prefs.setIntPref(ARMING, 1000);
  await calmPage();
  const focused = document.commandDispatcher.focusedElement ?? document.activeElement;
  const c = await agentClient();
  const id = c.request("agent-tabs");
  await until(lineOpen, "the question opens by itself");
  Assert.equal(
    lineText(),
    "◇ example-agent wants vimma_tabs: the list of agent tabs (0)",
    "it says who wants what",
  );
  Assert.equal(line().getAttribute("role"), "alertdialog", "an alertdialog");
  // Drawn at the window's foot over the page, like the command line: seen, and no reflow.
  const panel = line().querySelector(".vimma-cmdline-panel").getBoundingClientRect();
  const bar = document.getElementById("vimma-statusbar").getBoundingClientRect();
  Assert.greater(panel.height, 0, "the line is drawn");
  Assert.ok(Math.abs(panel.bottom - bar.top) < 1, "just above the status bar");
  Assert.equal(line().getBoundingClientRect().height, 0, "a zero-height row");
  Assert.equal(line().getAttribute("aria-label"), lineText(), "named by its question");
  Assert.ok(!hintShown(), "the hint waits for the arming delay");
  Assert.equal(
    document.commandDispatcher.focusedElement ?? document.activeElement,
    focused,
    "the line takes no focus",
  );

  EventUtils.synthesizeKey("y");
  await new Promise((r) => setTimeout(r, 100));
  Assert.equal(AgentGate.waiting.length, 1, "y before the line is armed does nothing");

  await until(hintShown, "armed after the delay");
  Assert.equal(
    line().querySelector(".vimma-agent-prompt-hint").textContent,
    "y once · 10a 10 min, all but forms · n deny · x mute",
    "the hint says what a grant covers and what still asks",
  );
  EventUtils.synthesizeKey("y", { repeat: true });
  for (const key of ["j", "q", " "]) EventUtils.synthesizeKey(key);
  await new Promise((r) => setTimeout(r, 100));
  Assert.equal(AgentGate.waiting.length, 1, "a held y and other keys neither allow nor deny");
  Assert.ok(lineOpen(), "the line stays");

  EventUtils.synthesizeKey("y");
  const r = await c.response(id);
  Assert.ok(r.ok, "y allows");
  await until(() => !lineOpen(), "and the line closes");
  c.close();
  await setSwitches({});
});

add_task(async function test_n_esc_enter_deny_and_x_mutes() {
  await setSwitches({ mcp: true });
  Services.prefs.setIntPref(ARMING, 100);
  const c = await agentClient();
  for (const key of ["n", "KEY_Escape", "KEY_Enter"]) {
    await calmPage();
    const id = c.request("agent-tabs");
    await armed();
    EventUtils.synthesizeKey(key);
    const r = await c.response(id);
    Assert.equal(r.error?.code, "denied", `${key} denies`);
    Assert.equal(r.error?.reason, "user", "as the user's no");
    await until(
      () => noticeText() === "denied example-agent's vimma_tabs",
      `${key}: the notice says so`,
    );
    // Three noes in a row would mute: a yes in between keeps the connection asking.
    if (key !== "KEY_Enter") {
      await calmPage();
      const ok = c.request("agent-tabs");
      await armed();
      EventUtils.synthesizeKey("y");
      Assert.ok((await c.response(ok)).ok, "y in between");
    }
  }
  await calmPage();
  const one = c.request("agent-tabs");
  const two = c.request("agent-tabs");
  await armed();
  EventUtils.synthesizeKey("x");
  Assert.equal((await c.response(one)).error?.reason, "user", "x denies the one asked");
  Assert.equal((await c.response(two)).error?.reason, "muted", "and the queued ones");
  await until(() => noticeText().endsWith("muted until it reconnects"), "the notice says muted");
  Assert.equal((await c.call("agent-tabs")).error?.reason, "muted", "it stays muted");
  c.close();
  await setSwitches({});
});

add_task(async function test_a_count_and_a_grant_minutes_shown_in_the_status_bar() {
  await setSwitches({ mcp: true });
  Services.prefs.setIntPref(ARMING, 100);
  const c = await agentClient();
  await until(() => segment() === "◇ agent", "the segment shows while an agent is connected");
  await calmPage();
  const id = c.request("agent-tabs");
  await armed();
  Assert.equal(segment(), "◇ agent 1?", "a question waits");
  for (const key of ["1", "5", "a"]) EventUtils.synthesizeKey(key);
  Assert.ok((await c.response(id)).ok, "15a allows");
  await until(
    () =>
      noticeText() ===
      "example-agent may use the agent workspace for 15 min; sending a form still asks " +
        "(ctrl+b shift+a ends it)",
    "the grant notice names its scope and the key that ends it",
  );
  await until(() => segment() === "◇ agent 15m", "the status bar counts the grant down");

  const r = await c.call("agent-tabs");
  Assert.ok(r.ok, "the next call runs unasked");
  await until(
    () => noticeText() === "example-agent listed the agent tabs (grant, 15m left)",
    "and shows what it did",
  );
  Assert.ok(!lineOpen(), "without a question");

  // With nothing waiting, ctrl+b shift+a ends the grant at once (mcp-grants G4).
  await focusContent(gBrowser.selectedBrowser);
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("A", { shiftKey: true });
  await until(() => AgentGate.grants().length === 0, "ctrl+b shift+a ends the grant");
  Assert.ok(!renamePrompt() || renamePrompt().hidden, "without a second question");
  await until(() => noticeText() === "mcp: ended 1 agent grant", "and says so");
  await until(() => segment() === "◇ agent", "and the segment drops the minutes");
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("A", { shiftKey: true });
  await until(
    () => noticeText() === "no agent requests waiting and no grants",
    "with none left, it says so",
  );
  c.close();
  await until(() => segment() === null, "the segment goes with the last agent");
  await setSwitches({});
});

add_task(async function test_typing_in_a_field_waits_for_ctrl_b_shift_a() {
  await setSwitches({ mcp: true });
  Services.prefs.setIntPref(ARMING, 100);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, FORM);
  await focusContent(tab.linkedBrowser);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    content.document.getElementById("f").focus(),
  );
  const c = await agentClient();
  const id = c.request("agent-tabs");
  for (const ch of "hello") {
    EventUtils.synthesizeKey(ch);
    await new Promise((r) => setTimeout(r, 300));
  }
  await new Promise((r) => setTimeout(r, 1800));
  Assert.ok(!lineOpen(), "the question does not open while focus is in a field");
  Assert.equal(segment(), "◇ agent 1?", "it waits in the status bar");
  const { value, focused } = await SpecialPowers.spawn(tab.linkedBrowser, [], () => ({
    value: content.document.getElementById("f").value,
    focused: content.document.activeElement?.id,
  }));
  Assert.equal(value, "hello", "every character reached the field");
  Assert.equal(focused, "f", "and the field kept focus");

  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("A", { shiftKey: true });
  await armed();
  EventUtils.synthesizeKey("y");
  Assert.ok((await c.response(id)).ok, "answered after ctrl+b shift+a");
  const after = await SpecialPowers.spawn(tab.linkedBrowser, [], () => ({
    value: content.document.getElementById("f").value,
    focused: content.document.activeElement?.id,
  }));
  Assert.deepEqual(after, { value: "hello", focused: "f" }, "the y never reached the field");
  c.close();
  BrowserTestUtils.removeTab(tab);
  await setSwitches({});
});

add_task(async function test_timeouts_deny_and_questions_come_one_at_a_time() {
  await setSwitches({ mcp: true });
  Services.prefs.setIntPref(ARMING, 100);
  Services.prefs.setIntPref(ASK_TIMEOUT, 3000);
  const c = await agentClient();
  await calmPage();
  const first = c.request("agent-tabs");
  const second = c.request("agent-close", { tab: "999999" });
  await armed();
  Assert.ok(lineText().includes("vimma_tabs"), "the oldest first");
  await until(() => segment() === "◇ agent 1?", "one more waits behind it");
  EventUtils.synthesizeKey("y");
  Assert.ok((await c.response(first)).ok, "the first is answered");
  const r2 = await c.response(second);
  Assert.equal(r2.error?.code, "invalid-args", "a tab that is not the agent's never asks");

  await calmPage();
  const third = c.request("agent-tabs");
  await until(lineOpen, "asked");
  const r3 = await c.response(third);
  Assert.equal(r3.error?.reason, "timeout", "no answer in time denies");
  await until(() => !lineOpen(), "the line closes");
  await until(() => noticeText() === "agent request timed out (denied)", "with a notice");
  c.close();
  Services.prefs.clearUserPref(ASK_TIMEOUT);
  await setSwitches({});
});
