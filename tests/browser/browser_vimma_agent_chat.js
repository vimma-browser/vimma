/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/builtin-agent.md, deliveries 4 and 6 (B1, B9, B13, B16, B19, B22, Behaviour
// 5-6, 10-17, 27-28, 35). The chat window in the side panel's slot: `:agent` and `ctrl+b i` open
// it with its input focused; the header says where data goes and where the agent works; Enter
// sends with the conversation's grant, ctrl+Enter asks every step, shift+Enter adds a line; the
// transcript shows the user's messages, the agent's replies as text under its label, and a line
// per step with its outcome; a question of the open conversation waits in the prompt slot, which
// neither the input nor the model can answer; `:agent give` moves the selected tab to the agent
// workspace after y and makes it the conversation's; the status bar shows a running task's
// steps and tokens. The model is the scripted server of head_vimma_agent_model.js.

"use strict";

/* global tidyTask -- from head_vimma_control.js */
/* global requests, held, PORT, PROVIDER, script, openStep -- from head_vimma_agent_model.js */
/* global add_setup, focusContent -- the harness and head.js */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_vimma_agent_model.js",
  this,
);

const { AgentChat } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/agent/AgentChat.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentGate.sys.mjs",
);
const { AgentUi } = ChromeUtils.importESModule("chrome://browser/content/vimma/host/agent-ui.mjs");
const { McpHost } = ChromeUtils.importESModule("chrome://browser/content/vimma/host/mcp-ops.mjs");
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { OSKeyStoreTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/OSKeyStoreTestUtils.sys.mjs",
);
const { AgentKeys } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/agent/AgentKeys.sys.mjs",
);
const { AGENT_DEFAULTS } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/config.mjs",
);
const { WorkspaceStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WorkspaceStore.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = `${DIR}file_vimma_agent_page.html`;
const ARMING = "security.dialog_enable_delay";

/** @param {() => boolean} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);
const $ = (/** @type {string} */ id) => document.getElementById(id);
const box = () => $("vimma-agent-chat");
const isOpen = () => !!box() && !box().hidden;
const input = () => /** @type {HTMLTextAreaElement} */ ($("vimma-agent-chat-input"));
const slot = () => $("vimma-agent-chat-slot");
const slotOpen = () => !!slot() && !slot().hidden;
const header = () =>
  [...box().querySelectorAll(".vimma-agent-chat-head")].map((l) => l.textContent);
const log = () => $("vimma-agent-chat-log");
const logText = () => log()?.textContent ?? "";
const statusText = (/** @type {string} */ id) =>
  $("vimma-statusbar")?.querySelector(`[data-segment="${id}"]`)?.textContent ?? "";
const agentTabs = () =>
  gBrowser.tabs.filter(
    (t) => t.userContextId === /** @type {any} */ (WorkspaceStore.agent).userContextId,
  );

/** `:line` Enter, typed in the window. */
function runCommand(/** @type {string} */ line) {
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
}

/** A page in normal mode, so `:` reaches Vimma. */
async function openPage(url = PAGE) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  await focusContent(tab.linkedBrowser);
  await until(() => VimmaHost.status(window).mode === "normal", "the page is in normal mode");
  return tab;
}

/** `:agent` from a page; the window opens with its input focused. */
async function openChat() {
  await openPage();
  runCommand("agent");
  await until(isOpen, "the chat window opened");
  await until(() => document.activeElement === input(), "its input has focus");
}

/** Types `text` into the input and sends it with `key` (Enter, or ctrl+Enter with `ask`). */
function send(/** @type {string} */ text, { ask = false } = {}) {
  EventUtils.sendString(text);
  EventUtils.synthesizeKey("KEY_Enter", ask ? { ctrlKey: true } : {});
}

/**
 * The open conversation's task, once the window's send has started it and it has ended: the
 * send reads the provider's key first, so the task starts a moment after Enter.
 */
async function finished() {
  await until(() => {
    const c = AgentChat.get(openId());
    return !c.running && c.last !== null;
  }, "the task ended");
  return AgentChat.done(openId());
}

/** The open conversation's id. */
const openId = () => /** @type {number} */ (VimmaHost._state(window).agentChat.conversation);

let savedConfig = null;

async function tidy() {
  const chat = VimmaHost._state(window).agentChat;
  chat.close();
  // A draft left in the input would join the next test's message.
  if (input()) input().value = "";
  AgentChat.stopAll();
  for (const q of AgentGate.waiting) AgentGate.answer(q.id, { kind: "deny" });
  for (const c of AgentChat.list()) AgentChat.delete(c.id);
  AgentGate.revoke();
  for (const release of held.values()) release();
  held.clear();
  const ww = WindowWorkspaces.get(window);
  ww.switchTo({ id: ww.model.workspaces.find((/** @type {any} */ w) => w.name === "main")?.id });
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  for (const t of gBrowser.tabs.slice(1)) BrowserTestUtils.removeTab(t);
  requests.length = 0;
}

/** @param {() => Promise<void>} task */
const addTidyTask = (task) => add_task(tidyTask(task, tidy));

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["vimma.mcp.askTimeoutMs", 20000],
      [ARMING, 300],
    ],
  });
  OSKeyStoreTestUtils.setup();
  registerCleanupFunction(() => OSKeyStoreTestUtils.cleanup());
  savedConfig = McpHost.agentConfig;
  McpHost.configureAgent({ ...AGENT_DEFAULTS, default: "scripted", providers: [PROVIDER] });
  registerCleanupFunction(() => McpHost.configureAgent(savedConfig));
});

add_task(async function test_the_agent_has_no_feature_pref() {
  // The window has its key, so the built-in agent ships whole, with no pref to turn it on (B22).
  Assert.equal(
    Services.prefs.getPrefType("vimma.feature.agentChat"),
    Services.prefs.PREF_INVALID,
    "no vimma.feature.agentChat",
  );
});

/** `ctrl+b i`, the window's default key (B13). */
function pressKey() {
  EventUtils.synthesizeKey("b", { ctrlKey: true });
  EventUtils.synthesizeKey("i");
}

addTidyTask(async function test_ctrl_b_i_opens_the_window_with_its_input_focused() {
  await openPage();
  pressKey();
  await until(isOpen, "ctrl+b i opened the chat window");
  await until(() => document.activeElement === input(), "its input has focus");
});

addTidyTask(async function test_header_says_where_it_works() {
  await openChat();
  Assert.ok(box().getBoundingClientRect().width >= 400, "about 420 px wide");
  Assert.deepEqual(
    header(),
    [
      `scripted · scripted · local endpoint 127.0.0.1:${PORT}`,
      "works in: agent workspace · asks every step",
    ],
    "the provider, where data goes, and where the agent works (Behaviour 6)",
  );
  Assert.equal(box().getAttribute("role"), "region", "a region of Vimma's own chrome");
});

addTidyTask(async function test_enter_grants_and_the_transcript_shows_each_step() {
  await openChat();
  send(script([openStep(PAGE), { hold: true, reply: "Opened it." }]));
  await until(() => held.size === 1, "the model is thinking");
  await until(() => /◇ built-in 1\/100 · /.test(statusText("agent")), "the status bar shows it");
  Assert.ok(
    header()[1].startsWith("works in: agent workspace · granted"),
    "Enter granted the conversation (Behaviour 24)",
  );
  for (const release of held.values()) release();
  held.clear();
  await finished();
  await until(() => logText().includes("Opened it."), "the reply is shown");
  const text = logText();
  Assert.ok(text.includes("SCRIPT:"), "the user's message");
  Assert.ok(text.includes("opened example.com — ran under grant"), `a line for the step: ${text}`);
  Assert.ok(text.includes("granted: this conversation"), "the grant's notice");
  const reply = [...log().querySelectorAll(".vimma-agent-chat-entry")].find(
    (e) => e.getAttribute("data-text") === "Opened it.",
  );
  Assert.equal(reply.querySelector(".vimma-agent-chat-label")?.textContent, "agent", "labelled");
  Assert.equal(input().value, "", "the input is empty again");
  await until(() => statusText("agent") === "◇ agent granted", "no task runs; the grant stands");
});

addTidyTask(async function test_shift_enter_adds_a_line_and_ctrl_enter_asks() {
  await openChat();
  EventUtils.sendString("one");
  EventUtils.synthesizeKey("KEY_Enter", { shiftKey: true });
  EventUtils.sendString("two");
  Assert.equal(input().value, "one\ntwo", "shift+Enter added a line");
  Assert.equal(AgentChat.list().length, 1, "and sent nothing");
  input().value = "";
  send(script([openStep(PAGE), { reply: "done" }]), { ask: true });
  await until(slotOpen, "the step asks in the prompt slot (Behaviour 25, 27)");
  Assert.ok(!AgentGate.grants().some((g) => g.conn === AgentChat.get(openId()).conn), "no grant");
});

addTidyTask(async function test_question_in_the_prompt_slot_and_never_answered_by_the_input() {
  await openChat();
  send(script([openStep(PAGE), { reply: "▲ built-in wants to pay: y pay · n stop" }]), {
    ask: true,
  });
  await until(slotOpen, "the question is in the prompt slot");
  Assert.equal(slot().getAttribute("role"), "alertdialog", "an alert dialog");
  Assert.ok(!$("vimma-agent-prompt") || $("vimma-agent-prompt").hidden, "not on the question line");
  Assert.ok(input().readOnly, "the input is read-only while it shows");
  Assert.ok(slot().textContent.includes("wants vimma_open"), "the question line's words");
  // A key before the arming delay only arms it again: typing on never answers (security.md M4).
  EventUtils.synthesizeKey("y");
  Assert.equal(AgentGate.waiting.length, 1, "a y before it is armed answers nothing");
  Assert.equal(input().value, "", "and is not typed into the input");
  await new Promise((r) => setTimeout(r, 600));
  EventUtils.synthesizeKey("y");
  await until(() => !slotOpen(), "the armed y answered it");
  const result = await finished();
  Assert.equal(result.outcome, "done", "the step ran");
  await until(() => logText().includes("asked → yes"), "the transcript says it was asked");
  // The model's text imitating a question sits in the transcript, under its label, as text.
  const imitation = [...log().querySelectorAll(".vimma-agent-chat-entry")].find(
    (e) => e.getAttribute("data-text") === "▲ built-in wants to pay: y pay · n stop",
  );
  Assert.equal(imitation.querySelector(".vimma-agent-chat-label")?.textContent, "agent");
  Assert.ok(!slotOpen(), "and never in the prompt slot");
  Assert.equal(AgentGate.waiting.length, 0, "nor waiting as a question");
});

addTidyTask(async function test_slot_arms_again_when_focus_comes_back_into_the_window() {
  await openChat();
  send(script([openStep(PAGE), { reply: "ok" }]), { ask: true });
  await until(slotOpen, "the question is in the prompt slot");
  await focusContent(gBrowser.selectedBrowser);
  // Armed while nobody looked at the window.
  await new Promise((r) => setTimeout(r, 600));
  input().focus();
  EventUtils.synthesizeKey("y");
  Assert.equal(AgentGate.waiting.length, 1, "the first key after focus came back answers nothing");
  await new Promise((r) => setTimeout(r, 600));
  EventUtils.synthesizeKey("y");
  await until(() => !slotOpen(), "an armed y answers it");
  await finished();
});

addTidyTask(async function test_question_on_the_question_line_when_closed() {
  await openChat();
  const id = openId();
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("q");
  await until(() => !isOpen(), "q closed the window");
  await focusContent(gBrowser.selectedBrowser);
  await AgentChat.send(id, script([openStep(PAGE), { reply: "ok" }]), { ask: true });
  await until(() => AgentGate.waiting.length === 1, "the step asks");
  await until(() => !!AgentUi._current, "on the question line, by itself");
  Assert.ok(!AgentUi._current.slot, "not in a slot: the window is closed");
  AgentGate.answer(AgentGate.waiting[0].id, { kind: "deny" });
  await AgentChat.done(id);
});

addTidyTask(async function test_reply_rendered_as_text() {
  await openChat();
  const reply =
    '<img src="http://127.0.0.1:' +
    PORT +
    '/elsewhere?html"> ![x](http://127.0.0.1:' +
    PORT +
    "/elsewhere?md) [link](http://127.0.0.1:" +
    PORT +
    "/elsewhere?link)‮evil";
  send(script([{ reply }]));
  await finished();
  await until(() => logText().includes("![x]"), "the reply is shown");
  Assert.equal(log().querySelectorAll("img, a, iframe").length, 0, "no markup was made");
  Assert.ok(logText().includes('<img src="http://127.0.0.1'), "the markup shows as text");
  Assert.ok(!logText().includes("‮"), "with no bidi override");
  await new Promise((r) => setTimeout(r, 300));
  Assert.ok(!requests.some((r) => r.path === "/elsewhere"), "and nothing was loaded");
});

addTidyTask(async function test_normal_mode_keys_stop_and_close() {
  await openChat();
  send(script([{ hold: true }, { reply: "never" }]));
  await until(() => held.size === 1, "the model is thinking");
  EventUtils.synthesizeKey("KEY_Escape");
  Assert.notEqual(document.activeElement, input(), "Esc left the input");
  EventUtils.synthesizeKey("s");
  const result = await finished();
  Assert.equal(result.outcome, "stopped", "s stopped the task (Behaviour 16)");
  await until(() => logText().includes("stopped"), "the transcript says so");
  EventUtils.synthesizeKey("i");
  Assert.equal(document.activeElement, input(), "i returned to the input");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("n");
  await until(() => AgentChat.list().length === 2, "n started a new conversation");
  Assert.equal(logText(), "", "with an empty transcript");
});

addTidyTask(async function test_give_moves_the_tab_after_y_and_makes_it_the_conversations() {
  await openChat();
  const id = openId();
  const tab = gBrowser.selectedTab;
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("P", { shiftKey: true });
  await until(() => !!$("vimma-rename") && !$("vimma-rename").hidden, "it asks first");
  Assert.ok(
    /Move this tab to "agent"\? Agents you allow can read it there/.test(
      $("vimma-rename").textContent,
    ),
    "as the picker's m asks",
  );
  EventUtils.synthesizeKey("y");
  await until(() => !tab.isConnected, "the tab moved");
  const moved = agentTabs()[0];
  Assert.ok(moved, "reopened in the agent workspace, with its container");
  Assert.equal(AgentChat.ownerOf(moved), id, "and it is the conversation's (Behaviour 17)");
  await until(() => logText().includes('you gave tab "Agent fixture"'), "the transcript says so");
});

addTidyTask(async function test_external_provider_notice_before_first_task() {
  const external = { ...PROVIDER, name: "far", endpoint: "https://example.com/v1" };
  McpHost.configureAgent({ ...AGENT_DEFAULTS, default: "far", providers: [external] });
  // A hosted provider asks for its key first; this one has one.
  await AgentKeys.set("far", "sk-test-far", external.endpoint);
  try {
    await openChat();
    Assert.equal(header()[0], "far · scripted · page text sent to example.com");
    send("hello");
    await until(() => !!$("vimma-rename") && !$("vimma-rename").hidden, "it asks first");
    Assert.ok(
      $("vimma-rename").textContent.includes("are sent to example.com. y send · n cancel"),
      "naming where the page text goes (Behaviour 5)",
    );
    EventUtils.synthesizeKey("n");
    await new Promise((r) => setTimeout(r, 200));
    Assert.ok(!AgentChat.get(openId()).running, "n sent nothing");
    Assert.equal(input().value, "hello", "and the message stays in the input");
    const direct = await AgentChat.send(openId(), "hello");
    Assert.ok("refused" in direct, "nor does a send that skips the window's notice");
    AgentChat.confirm(openId(), "https://elsewhere.example/v1");
    Assert.ok(AgentChat.needsNotice(openId()), "a y to another endpoint confirms nothing");
  } finally {
    await AgentKeys.delete("far");
    McpHost.configureAgent({ ...AGENT_DEFAULTS, default: "scripted", providers: [PROVIDER] });
  }
});

const SECRET = "sk-test-SECRET-9f3a";

/** The key field: masked, in the window, never the transcript. */
const keyField = () => /** @type {HTMLInputElement} */ ($("vimma-agent-chat-key"));
const keyOpen = () => !!keyField() && !keyField().parentElement.hidden;

/** Nothing Vimma shows or keeps outside login storage holds the key (Behaviour 3, M40). */
function assertKeyNowhere() {
  Assert.ok(!box().textContent.includes(SECRET), "not in the window");
  Assert.ok(!$("vimma-statusbar").textContent.includes(SECRET), "not in the status bar");
  Assert.ok(!($("vimma-notice")?.textContent ?? "").includes(SECRET), "not in a notice");
  Assert.equal(keyField()?.value ?? "", "", "the field is emptied");
  const prefs = Services.prefs.getChildList("").filter((name) => {
    const type = Services.prefs.getPrefType(name);
    return (
      type === Services.prefs.PREF_STRING && Services.prefs.getStringPref(name, "").includes(SECRET)
    );
  });
  Assert.deepEqual(prefs, [], "not in any pref");
  Assert.ok(
    !JSON.stringify(AgentChat.list()).includes(SECRET) &&
      !JSON.stringify(AgentChat.transcript(openId()).entries).includes(SECRET),
    "not in the conversation",
  );
}

addTidyTask(async function test_hosted_openai_compatible_provider_set_up_in_the_window() {
  McpHost.configureAgent({ ...AGENT_DEFAULTS, default: null, providers: [] });
  const name = "127.0.0.1";
  try {
    await openPage();
    runCommand("agent model");
    await until(
      () => logText().includes("add: OpenAI-compatible endpoint"),
      "the picker offers a hosted provider",
    );
    const rows = [...log().querySelectorAll(".vimma-agent-chat-row")].map((r) => r.textContent);
    const at = rows.findIndex((r) => r.includes("add: OpenAI-compatible endpoint"));
    for (let i = 0; i < at; i++) EventUtils.synthesizeKey("j");
    EventUtils.synthesizeKey("KEY_Enter");
    await until(() => !!$("vimma-rename") && !$("vimma-rename").hidden, "it asks the endpoint");
    EventUtils.sendString(`http://127.0.0.1:${PORT}/v1`);
    EventUtils.synthesizeKey("KEY_Enter");
    await until(() => /model/.test($("vimma-rename").textContent), "then the model");
    EventUtils.sendString("scripted");
    EventUtils.synthesizeKey("KEY_Enter");
    await until(keyOpen, "then the key, in the window");
    Assert.equal(keyField().type, "password", "masked");
    Assert.equal(document.activeElement, keyField(), "focused");
    EventUtils.sendString(SECRET);
    EventUtils.synthesizeKey("KEY_Enter");
    await until(() => !keyOpen(), "the key is stored");
    await until(
      () => /127\.0\.0\.1: key stored · ends …9f3a/.test($("vimma-notice")?.textContent ?? ""),
      "the notice shows only its last four characters",
    );
    Assert.equal(header()[0], `127.0.0.1 · scripted · local endpoint 127.0.0.1:${PORT}`);
    await until(() => document.activeElement === input(), "back in the input");
    send(script([openStep(PAGE), { reply: "Opened it." }]));
    await finished();
    await until(() => logText().includes("Opened it."), "the reply is shown");
    Assert.ok(
      logText().includes("opened example.com — ran under grant"),
      `and the step: ${logText()}`,
    );
    Assert.equal(requests.at(-1).authorization, `Bearer ${SECRET}`, "the key went to the endpoint");
    assertKeyNowhere();
  } finally {
    await AgentKeys.delete(name);
    McpHost.configureAgent({ ...AGENT_DEFAULTS, default: "scripted", providers: [PROVIDER] });
  }
});

addTidyTask(async function test_hosted_anthropic_provider_asks_for_its_key_before_the_task() {
  const anthropic = {
    name: "mock-anthropic",
    kind: "anthropic",
    endpoint: `http://127.0.0.1:${PORT}/anthropic`,
    model: "claude-mock",
    vision: true,
  };
  McpHost.configureAgent({ ...AGENT_DEFAULTS, default: anthropic.name, providers: [anthropic] });
  try {
    await openChat();
    send(script([openStep(PAGE), { reply: "Opened it." }]));
    await until(keyOpen, "no key yet: the window asks for it first");
    Assert.ok(box().textContent.includes("API key for mock-anthropic"), "naming the provider");
    Assert.ok(!requests.length, "and nothing was sent");
    EventUtils.sendString(SECRET);
    EventUtils.synthesizeKey("KEY_Enter");
    await until(() => document.activeElement === input(), "back in the input");
    Assert.ok(input().value.startsWith("SCRIPT:"), "with the task still there");
    EventUtils.synthesizeKey("KEY_Enter");
    await finished();
    await until(() => logText().includes("Opened it."), "the Messages API's reply is shown");
    Assert.ok(logText().includes("opened example.com — ran under grant"), "and the step");
    const sent = requests.filter((r) => r.path === "/anthropic/v1/messages");
    Assert.ok(sent.length >= 2, "both turns went to the Messages API");
    Assert.ok(
      sent.every((r) => r.apiKey === SECRET),
      "with the key in x-api-key",
    );
    assertKeyNowhere();
    // The picker shows the stored key by its last four characters and deletes it after y.
    EventUtils.synthesizeKey("KEY_Escape");
    EventUtils.synthesizeKey("m");
    await until(() => logText().includes("key stored · ends …9f3a"), "the picker names the key");
    EventUtils.synthesizeKey("x");
    await until(() => !!$("vimma-rename") && !$("vimma-rename").hidden, "it asks first");
    EventUtils.synthesizeKey("y");
    await until(async () => !(await AgentKeys.has(anthropic.name)), "x deleted the key");
  } finally {
    await AgentKeys.delete(anthropic.name);
    McpHost.configureAgent({ ...AGENT_DEFAULTS, default: "scripted", providers: [PROVIDER] });
  }
});

addTidyTask(async function test_a_key_typed_and_left_is_dropped_and_no_task_goes_keyless() {
  const anthropic = {
    name: "mock-anthropic",
    kind: "anthropic",
    endpoint: `http://127.0.0.1:${PORT}/anthropic`,
    model: "claude-mock",
    vision: true,
  };
  McpHost.configureAgent({ ...AGENT_DEFAULTS, default: anthropic.name, providers: [anthropic] });
  try {
    await openChat();
    const sent = await AgentChat.send(openId(), "hello");
    Assert.ok("refused" in sent, "a send without the provider's key is refused");
    Assert.ok(!requests.length, "and nothing reached the endpoint");
    send("hello");
    await until(keyOpen, "the window asks for the key");
    EventUtils.sendString("half-a-key");
    const chat = VimmaHost._state(window).agentChat;
    chat.close();
    Assert.equal(keyField().value, "", "closing the window drops what was typed");
    chat.askKey(anthropic);
    Assert.equal(keyField().value, "", "so the next key starts empty");
  } finally {
    McpHost.configureAgent({ ...AGENT_DEFAULTS, default: "scripted", providers: [PROVIDER] });
  }
});

addTidyTask(async function test_opened_from_another_workspace_reads_none_of_its_tabs() {
  await openChat();
  send(script([{ call: "vimma_tabs", args: {} }, { reply: "listed" }]));
  const result = await finished();
  const listed = result.messages
    .filter((/** @type {any} */ m) => m.role === "tool")
    .flatMap((/** @type {any} */ m) => m.results)
    .map((/** @type {any} */ r) => r.content.map((/** @type {any} */ c) => c.text).join(""))
    .join("");
  Assert.ok(!listed.includes("Agent fixture"), "the main workspace's page is not listed");
  Assert.ok(gBrowser.selectedTab.userContextId !== WorkspaceStore.agent.userContextId);
});
