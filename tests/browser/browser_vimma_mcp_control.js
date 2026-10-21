/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/vimma-mcp.md, sub-PR 2b: attention and a notification without a URL or
// buttons when the asking window is not in front (decision 15); while MCP is on, each new
// full-control connection asks y/N in the agent question line, and with MCP off nothing asks
// (29 C); `:control on <minutes>` turns full control on for that long, across restarts (29 D).
// docs/specs/mcp-drive.md, sub-PR 1: while MCP is on, both full-control questions say that full
// control reaches beyond the agent workspace (D22, D23; security.md M22).

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
const { ControlHost, CONTROL_UNTIL_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/control-ops.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { MockRegistrar } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistrar.sys.mjs",
);

const CONTROL = "vimma.control.enabled";
const ASK_TIMEOUT = "vimma.mcp.askTimeoutMs";
const ARMING = "security.dialog_enable_delay";
const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = `${DIR}file_vimma_agent_page.html`;

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

add_task(async function test_a_window_not_in_front_gets_attention_and_a_notification() {
  await setSwitches({ mcp: true });
  /** @type {string[]} */
  const alerts = [];
  const cid = MockRegistrar.register("@mozilla.org/alerts-service;1", {
    QueryInterface: ChromeUtils.generateQI(["nsIAlertsService"]),
    showAlert(alert) {
      alerts.push(`${alert.title}\n${alert.text}\n${alert.actions?.length ?? 0}`);
    },
    showAlertNotification() {},
    closeAlert() {},
  });
  let attention = 0;
  const original = window.getAttention;
  window.getAttention = () => attention++;
  // A private window in front: the asking window (the most recent normal one) is not.
  const other = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  await SimpleTest.promiseFocus(other);
  try {
    const c = await agentClient();
    const tab = gBrowser.addTab(PAGE, {
      userContextId: WorkspaceStore.agent.userContextId,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE);
    const read = c.request("agent-read", { tab: String(tab.linkedBrowser.browserId) });
    await until(() => alerts.length === 1, "one desktop notification");
    Assert.equal(attention, 1, "and the window is marked urgent once");
    const [title, text, actions] = alerts[0].split("\n");
    Assert.equal(title, "Vimma", "from Vimma");
    Assert.equal(text, "example-agent asks to use Vimma's agent workspace (read a page)", "what");
    Assert.ok(!/example\.com|https?:/.test(alerts[0]), "never a URL");
    Assert.equal(actions, "0", "and no buttons");
    Assert.ok(!lineOpen(), "the line does not open in a window that is not in front");
    await until(() => segment() === "◇ agent 1?", "it waits there");
    c.close();
    await c.response(read);
    BrowserTestUtils.removeTab(tab);
  } finally {
    window.getAttention = original;
    MockRegistrar.unregister(cid);
    await BrowserTestUtils.closeWindow(other);
    await SimpleTest.promiseFocus(window);
    await setSwitches({});
  }
});

/** A full connection's handshake, up to the welcome or its refusal. */
async function fullHandshake(auth = {}) {
  const c = new Client(/** @type {number} */ (VimmaControl.port));
  const reply = c.handshake({ protocol: 2, role: "full" }, auth);
  return { c, reply };
}

add_task(async function test_full_control_asks_only_while_mcp_is_on() {
  Services.prefs.setIntPref(ARMING, 100);
  await setSwitches({ control: true });
  const quiet = await fullHandshake();
  Assert.equal((await quiet.reply).type, "welcome", "MCP off: a full connection is welcomed");
  Assert.equal(AgentGate.waiting.length, 0, "without a question");
  const v1 = new Client(/** @type {number} */ (VimmaControl.port));
  Assert.equal((await v1.handshake({ protocol: 1 })).type, "welcome", "v1 too");
  v1.close();

  await setSwitches({ control: true, mcp: true });
  Assert.ok(!quiet.c.closed, "a full connection open before MCP was on stays open");
  quiet.c.close();
  await calmPage();
  // The question shows the code the client printed, so a racing client is told apart.
  const asked = await fullHandshake({ code: "7F3K" });
  await armed();
  Assert.equal(
    lineText(),
    '◇ vimma-ctl with code 7F3K wants full control (every workspace, not only "agent") — y/N',
    "MCP on: it asks, with the client's code and what it reaches",
  );
  Assert.equal(line().querySelector("b")?.textContent, "7F3K", "the code in bold");
  Assert.equal(
    line().querySelector(".vimma-agent-prompt-hint").textContent,
    "y if the code is the one vimma-ctl printed · n deny",
    "with no grant",
  );
  EventUtils.synthesizeKey("a");
  EventUtils.synthesizeKey("1");
  await new Promise((r) => setTimeout(r, 100));
  Assert.ok(lineOpen(), "a and digits do nothing here");
  EventUtils.synthesizeKey("y");
  const welcome = await asked.reply;
  Assert.equal(welcome.type, "welcome", "y lets that connection in");
  Assert.equal((await asked.c.call("state")).ok, true, "and it works");
  asked.c.close();

  await calmPage();
  const refused = await fullHandshake();
  await armed();
  Assert.equal(
    lineText(),
    '◇ a client with no code wants full control (every workspace, not only "agent") — y/N',
    "a client that sent no code is named as one",
  );
  EventUtils.synthesizeKey("n");
  const no = await refused.reply;
  Assert.equal(no.error?.code, "denied", "n refuses it");
  Assert.equal(no.error?.reason, "user", "as the user's no");
  await until(() => refused.c.closed, "and closes it");
  Assert.equal(AgentGate.grants().length, 0, "nothing is remembered");

  await calmPage();
  const again = await fullHandshake();
  await until(lineOpen, "the next new connection asks again");
  EventUtils.synthesizeKey("KEY_Escape");
  await new Promise((r) => setTimeout(r, 150));
  EventUtils.synthesizeKey("KEY_Escape");
  Assert.equal((await again.reply).error?.code, "denied", "Esc refuses");
  await setSwitches({});
});

add_task(async function test_control_on_minutes_turns_itself_off() {
  Services.prefs.setIntPref(ARMING, 100);
  await setSwitches({});
  await focusContent(gBrowser.selectedBrowser);
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("control on 15");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => renamePrompt() && !renamePrompt().hidden, ":control on asks");
  Assert.ok(
    renamePrompt().textContent.includes(
      "Turn on full control (vimma-ctl: keys in this window, every workspace) for 15 min? y/N",
    ),
    "naming the minutes",
  );
  EventUtils.synthesizeKey("y");
  await until(() => Services.prefs.getBoolPref(CONTROL, false), "y turns full control on");
  const until15 = Number(Services.prefs.getStringPref(CONTROL_UNTIL_PREF, "0"));
  Assert.ok(Math.abs(until15 - (Date.now() + 900_000)) < 30_000, "for 15 minutes, in ms");
  await until(() => noticeText().startsWith("full control on, 15m left"), "and says so");

  // The end time comes closer: control goes off when it passes.
  Services.prefs.setStringPref(CONTROL_UNTIL_PREF, String(Date.now() + 1000));
  await until(() => !Services.prefs.getBoolPref(CONTROL, true), "off when the time is up");
  Assert.ok(!Services.prefs.prefHasUserValue(CONTROL_UNTIL_PREF), "and the end time is gone");

  // A restart after the end time: off at startup.
  Services.prefs.setBoolPref(CONTROL, true);
  Services.prefs.setStringPref(CONTROL_UNTIL_PREF, String(Date.now() - 60_000));
  ControlHost.init();
  Assert.ok(!Services.prefs.getBoolPref(CONTROL, true), "an end time in the past turns it off");

  // An end time that is not one fails closed.
  for (const bad of ["", "0", "-5", "soon", String(Date.now() + 2 * 24 * 3600_000)]) {
    Services.prefs.setBoolPref(CONTROL, true);
    Services.prefs.setStringPref(CONTROL_UNTIL_PREF, bad);
    ControlHost.init();
    Assert.ok(
      !Services.prefs.getBoolPref(CONTROL, true),
      `an end time of ${JSON.stringify(bad)}: off`,
    );
  }

  Services.prefs.setBoolPref(CONTROL, true);
  Services.prefs.setStringPref(CONTROL_UNTIL_PREF, String(Date.now() + 600_000 - 1000));
  await focusContent(gBrowser.selectedBrowser);
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("mcp");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => noticeText().includes("full control on, 10m left"), ":mcp shows it");
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("control off");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => !Services.prefs.getBoolPref(CONTROL, true), ":control off, at once");
  Assert.ok(!Services.prefs.prefHasUserValue(CONTROL_UNTIL_PREF), "with its end time");
  await setSwitches({});
});

add_task(async function test_control_on_says_it_reaches_beyond_agent_while_mcp_is_on() {
  Services.prefs.setIntPref(ARMING, 100);
  const question = async () => {
    await focusContent(gBrowser.selectedBrowser);
    EventUtils.synthesizeKey(":", { shiftKey: true });
    EventUtils.sendString("control on 15");
    EventUtils.synthesizeKey("KEY_Enter");
    await until(() => renamePrompt() && !renamePrompt().hidden, ":control on asks");
    const said = renamePrompt().textContent;
    EventUtils.synthesizeKey("n");
    await until(() => renamePrompt().hidden, "n closes it");
    Assert.ok(!Services.prefs.getBoolPref(CONTROL, false), "and leaves full control off");
    return said;
  };

  await setSwitches({ mcp: true });
  Assert.ok(
    (await question()).includes(
      'Turn on full control for 15 min? It reaches every workspace and tab, not only "agent", ' +
        "and any local AI agent with a shell can use it. y/N",
    ),
    "MCP on: the question says what full control gives away",
  );

  await setSwitches({});
  Assert.ok(
    (await question()).includes(
      "Turn on full control (vimma-ctl: keys in this window, every workspace) for 15 min? y/N",
    ),
    "MCP off: the question stays as it was",
  );
});
