/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/vimma-mcp.md, sub-PR 2b: the question line arms again whenever its window
// comes or goes, or a key arrives before it is armed, and gives the keys up to a prompt, picker or
// the command line opened over it.

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
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { DEFAULT_HINT_CHARS } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/hints.mjs",
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
const hintShown = () => {
  const hint = line()?.querySelector(".vimma-agent-prompt-hint");
  return !!hint && !hint.hidden && hint.textContent !== "";
};
const segment = () =>
  document.querySelector('#vimma-statusbar [data-segment="agent"]')?.textContent ?? null;

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

// A window that comes to the front, by the user or by a process that can
// focus windows (hyprctl dispatch focuswindow), re-arms the line, so a `y` typed for another
// app never answers it; a key pressed while the line is not armed yet restarts the delay.
add_task(async function test_focus_changes_and_early_keys_rearm_the_line() {
  await setSwitches({ mcp: true });
  Services.prefs.setIntPref(ARMING, 1000);
  const c = await agentClient();
  await calmPage();
  const id = c.request("agent-tabs");
  await armed();

  const other = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  await SimpleTest.promiseFocus(other);
  await SimpleTest.promiseFocus(window);
  Assert.ok(lineOpen(), "the line is still there after the window came back");
  Assert.ok(!hintShown(), "but disarmed");
  EventUtils.synthesizeKey("y");
  await new Promise((r) => setTimeout(r, 100));
  Assert.equal(AgentGate.waiting.length, 1, "a y right after the window came back does nothing");

  // Keys while it is not armed restart the delay: 600 ms after a key, still not armed.
  await new Promise((r) => setTimeout(r, 600));
  EventUtils.synthesizeKey("j");
  await new Promise((r) => setTimeout(r, 600));
  Assert.ok(!hintShown(), "a key while disarmed restarted the delay");
  EventUtils.synthesizeKey("y");
  await new Promise((r) => setTimeout(r, 100));
  Assert.equal(AgentGate.waiting.length, 1, "so this y does nothing either");

  await until(hintShown, "armed a full delay after the last key");
  EventUtils.synthesizeKey("y");
  Assert.ok((await c.response(id)).ok, "then y allows");
  c.close();
  await BrowserTestUtils.closeWindow(other);
  await SimpleTest.promiseFocus(window);
  await setSwitches({});
});

// Another prompt, picker or the command line opened while the line shows
// (by a chord, which the line lets through) takes the keys; the line goes back to waiting.
add_task(async function test_other_ui_opened_over_the_line_gets_the_keys() {
  await setSwitches({ mcp: true });
  Services.prefs.setIntPref(ARMING, 100);
  const c = await agentClient();
  await calmPage();
  const id = c.request("agent-tabs");
  await armed();
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("g");
  const picker = () => document.getElementById("vimma-picker");
  await until(() => picker()?.open, "ctrl+b g opens the goto picker over the line");
  EventUtils.synthesizeKey("y");
  await new Promise((r) => setTimeout(r, 200));
  Assert.equal(AgentGate.waiting.length, 1, "the y went to the picker, not the question");
  Assert.ok(!lineOpen(), "the line went back to waiting");
  Assert.equal(segment(), "◇ agent 1?", "as the status bar says");
  EventUtils.synthesizeKey("KEY_Escape");
  await until(() => !picker()?.open, "the picker closes");
  await armed();
  EventUtils.synthesizeKey("y");
  Assert.ok((await c.response(id)).ok, "the line came back, and y answers it");
  c.close();
  await setSwitches({});
});

// Issue #495: hint, copy and element mode type y for themselves (a label from any
// `[modal] hint_chars`, the yank), and a grant can release a whole task's calls: the question
// never opens over them, and their y never answers it. It opens once Esc leaves the mode.
add_task(async function test_hint_and_copy_mode_keep_their_keys() {
  await setSwitches({ mcp: true });
  Services.prefs.setIntPref(ARMING, 100);
  const browser = gBrowser.selectedBrowser;
  await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    for (let i = 0; i < 4; i++) {
      const a = doc.createElement("a");
      a.href = `#link${i}`;
      a.textContent = `link ${i} `;
      doc.body.prepend(a);
    }
  });
  const mode = () => VimmaHost.status(window).mode;
  registerCleanupFunction(() => VimmaHost.configure({ hintChars: DEFAULT_HINT_CHARS }));
  const c = await agentClient();

  for (const [what, key, inMode] of [
    ["hint mode", "f", "hint"],
    ["copy mode", "v", "visual"],
  ]) {
    VimmaHost.configure({ hintChars: "yn" });
    await calmPage();
    EventUtils.synthesizeKey(key);
    await until(() => mode() === inMode, `${what} starts`);
    const id = c.request("agent-tabs");
    await until(() => segment() === "◇ agent 1?", `${what}: the question waits`);
    // Past the quiet time the line would open by itself in normal mode.
    await new Promise((r) => setTimeout(r, 2000));
    Assert.ok(!lineOpen(), `${what}: the line does not open over the mode`);
    EventUtils.synthesizeKey("y");
    await new Promise((r) => setTimeout(r, 300));
    Assert.equal(AgentGate.waiting.length, 1, `${what}: the y went to the mode`);
    if (mode() === inMode) EventUtils.synthesizeKey("KEY_Escape");
    await until(() => mode() === "normal", `${what}: back in normal mode`);
    await armed();
    EventUtils.synthesizeKey("y");
    Assert.ok((await c.response(id)).ok, `${what}: then the line opens, and y answers it`);
  }
  VimmaHost.configure({ hintChars: DEFAULT_HINT_CHARS });
  c.close();
  await setSwitches({});
});

// A right-to-left title or client name cannot reorder the question: names
// and titles are <bdi>, URLs a left-to-right isolate.
add_task(async function test_names_titles_and_urls_are_bidi_isolates() {
  await setSwitches({ mcp: true });
  Services.prefs.setIntPref(ARMING, 100);
  const c = await agentClient("עברית agent");
  await calmPage();
  const id = c.request("agent-open", { url: "https://example.com/‮evil" });
  await armed();
  const bdi = [...line().querySelectorAll("bdi")].map((b) => b.textContent);
  Assert.deepEqual(bdi, ["עברית agent"], "the client name is a <bdi>");
  const ltr = [...line().querySelectorAll('[dir="ltr"]')];
  Assert.ok(ltr.length > 0, "the URL is drawn left to right");
  for (const el of ltr) {
    Assert.equal(window.getComputedStyle(el).unicodeBidi, "isolate", "as an isolate");
  }
  EventUtils.synthesizeKey("n");
  await c.response(id);
  c.close();
  await setSwitches({});
});
