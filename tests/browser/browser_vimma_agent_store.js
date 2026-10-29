/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/builtin-agent.md, delivery 5 (B15, Behaviour 2, 19-23). Conversations are kept
// across restarts: one file per conversation in <profile>/vimma/agent/, encrypted with
// OSKeyStore, holding the user's messages, the agent's replies and Vimma's task summaries, never
// page text or tool output. A reopened conversation sends the model only those, as does one
// whose context was cleared. `d`, `:agent forget all` and `keep_days` delete the files. A
// provider set up in the window is written to config.toml, as `[agent] default` when none was
// set up, so it survives a restart. A restart is simulated by dropping the conversations from
// memory (AgentChat.reset) and reading the files again.

"use strict";

/* global tidyTask -- from head_vimma_control.js */
/* global requests, held, PORT, PROVIDER, script -- from head_vimma_agent_model.js */
/* global add_setup, focusContent -- the harness and head.js */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head_vimma_agent_model.js",
  this,
);

const { AgentChat } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/agent/AgentChat.sys.mjs",
);
const { AgentStore } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/agent/AgentStore.sys.mjs",
);
const { AgentKeys } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/agent/AgentKeys.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentGate.sys.mjs",
);
const { McpHost } = ChromeUtils.importESModule("chrome://browser/content/vimma/host/mcp-ops.mjs");
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
);
const { AGENT_DEFAULTS } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/config.mjs",
);
const { OSKeyStoreTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/OSKeyStoreTestUtils.sys.mjs",
);
const { OSKeyStore } = ChromeUtils.importESModule("resource://gre/modules/OSKeyStore.sys.mjs");
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
/** Words of the page's text: the model reads them, the store must never hold them. */
const PAGE_TEXT = "framework for serializing";
const CONFIG_PATH_PREF = "vimma.config.path";
const DAY = 86_400_000;

/** @param {() => boolean | Promise<boolean>} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 250);
const $ = (/** @type {string} */ id) => document.getElementById(id);
const box = () => $("vimma-agent-chat");
const isOpen = () => !!box() && !box().hidden;
const input = () => /** @type {HTMLTextAreaElement} */ ($("vimma-agent-chat-input"));
const log = () => $("vimma-agent-chat-log");
const logText = () => log()?.textContent ?? "";
const rows = () => [...(log()?.querySelectorAll(".vimma-agent-chat-row") ?? [])];
const chat = () => VimmaHost._state(window).agentChat;
const agentTabs = () =>
  gBrowser.tabs.filter(
    (t) => t.userContextId === /** @type {any} */ (WorkspaceStore.agent).userContextId,
  );

/** The conversation files there are. */
async function storedFiles() {
  if (!(await IOUtils.exists(AgentStore.dir))) return [];
  return (await IOUtils.getChildren(AgentStore.dir)).filter((p) => p.endsWith(".conv"));
}

/** A stored file's record, decrypted as the store does. @param {string} uid */
async function decrypted(uid) {
  const cipher = await IOUtils.readUTF8(PathUtils.join(AgentStore.dir, `${uid}.conv`));
  const bytes = await OSKeyStore.decrypt(cipher, "test");
  // OSKeyStore decrypts to UTF-8 bytes, one character a byte.
  const plain = new TextDecoder().decode(Uint8Array.from(bytes, (c) => c.charCodeAt(0)));
  return { cipher, plain };
}

/** A task that opens the page, reads it, and replies. */
const READ_TASK = script([
  // `elements` waits for the page to be ready, so the read finds it loaded.
  { call: "vimma_open", args: { url: PAGE, elements: true } },
  { call: "vimma_read_page", args: { tab: "$tab" } },
  { reply: "It is about Serde." },
]);

/** A conversation that ran READ_TASK to its end, and its saves done. */
async function ranTask() {
  const c = AgentChat.create({ provider: PROVIDER });
  const sent = await AgentChat.send(c.id, READ_TASK);
  Assert.deepEqual(sent, { started: true }, "the task starts");
  const result = await AgentChat.done(c.id);
  Assert.equal(result.outcome, "done", "and runs to its reply");
  await AgentChat.flush();
  return AgentChat.get(c.id);
}

/** `:line` Enter. */
function runCommand(/** @type {string} */ line) {
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString(line);
  EventUtils.synthesizeKey("KEY_Enter");
}

/** A page in normal mode, so `:` reaches Vimma. */
async function openPage() {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await focusContent(tab.linkedBrowser);
  await until(() => VimmaHost.status(window).mode === "normal", "the page is in normal mode");
  return tab;
}

async function tidy() {
  chat().close();
  if (input()) input().value = "";
  AgentChat.stopAll();
  for (const q of AgentGate.waiting) AgentGate.answer(q.id, { kind: "deny" });
  await AgentChat.forgetAll();
  AgentGate.revoke();
  for (const release of held.values()) release();
  held.clear();
  const ww = WindowWorkspaces.get(window);
  ww.switchTo({ id: ww.model.workspaces.find((/** @type {any} */ w) => w.name === "main")?.id });
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  for (const t of gBrowser.tabs.slice(1)) BrowserTestUtils.removeTab(t);
  McpHost.configureAgent({ ...AGENT_DEFAULTS, default: "scripted", providers: [PROVIDER] });
  requests.length = 0;
}

/** @param {() => Promise<void>} task */
const addTidyTask = (task) => add_task(tidyTask(task, tidy));

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [["vimma.mcp.askTimeoutMs", 20000]],
  });
  OSKeyStoreTestUtils.setup();
  registerCleanupFunction(() => OSKeyStoreTestUtils.cleanup());
  const saved = McpHost.agentConfig;
  McpHost.configureAgent({ ...AGENT_DEFAULTS, default: "scripted", providers: [PROVIDER] });
  registerCleanupFunction(() => McpHost.configureAgent(saved));
});

addTidyTask(async function test_stored_file_is_encrypted_and_holds_no_tool_output() {
  const c = await ranTask();
  const sent = requests.flatMap((r) => r.body.messages).map((m) => String(m.content));
  Assert.ok(
    sent.some((t) => t.includes(PAGE_TEXT)),
    "the model was sent the page's text while the task ran",
  );
  const files = await storedFiles();
  Assert.deepEqual(
    files.map((p) => PathUtils.filename(p)),
    [`${c.uid}.conv`],
    "one file, named by the conversation's id",
  );
  const { cipher, plain } = await decrypted(c.uid);
  Assert.ok(!cipher.includes("Serde") && !cipher.includes("SCRIPT"), "nothing in clear");
  Assert.equal((await IOUtils.stat(files[0])).permissions, 0o600, "readable by the user only");
  Assert.equal((await IOUtils.stat(AgentStore.dir)).permissions, 0o700, "in a 0700 folder");
  const record = JSON.parse(plain);
  Assert.deepEqual(
    record.entries.map((/** @type {any} */ e) => e.kind),
    ["user", "agent", "summary"],
    "the message, the reply and Vimma's summary",
  );
  Assert.equal(record.entries[0].text, READ_TASK, "the user's message");
  Assert.equal(record.entries[1].text, "It is about Serde.", "the agent's reply");
  Assert.equal(
    record.entries[2].text,
    "task done · 2 steps · 330 tokens · hosts: example.com",
    "the summary: outcome, counts and hosts",
  );
  Assert.ok(!plain.includes(PAGE_TEXT), "no page text");
  Assert.ok(!plain.includes("untrusted") && !plain.includes("agent workspace"), "no tool result");
  Assert.ok(!plain.includes("opened example.com"), "no transcript step line");
  Assert.deepEqual(
    record.provider,
    {
      name: "scripted",
      kind: "openai",
      endpoint: PROVIDER.endpoint,
      model: "scripted",
      vision: false,
    },
    "its provider and model",
  );
});

addTidyTask(async function test_nothing_written_in_clear_when_it_cannot_be_encrypted() {
  const encrypt = OSKeyStore.encrypt;
  OSKeyStore.encrypt = () => Promise.reject(new Error("no keyring"));
  try {
    const c = AgentChat.create({ provider: PROVIDER });
    await AgentChat.send(c.id, script([{ reply: "Hello." }]));
    await AgentChat.done(c.id);
    await AgentChat.flush();
    Assert.deepEqual(await storedFiles(), [], "no file at all");
    Assert.equal(AgentChat.get(c.id).title.length > 0, true, "the conversation stays in memory");
  } finally {
    OSKeyStore.encrypt = encrypt;
  }
});

addTidyTask(async function test_reopened_conversation_starts_with_a_clean_context() {
  const before = await ranTask();
  AgentChat.reset();
  Assert.deepEqual(AgentChat.list(), [], "a restart leaves nothing in memory");
  await AgentChat.restore();
  const [c] = AgentChat.list();
  Assert.equal(c.uid, before.uid, "the stored conversation is back");
  Assert.equal(c.title, before.title, "with its title");
  Assert.deepEqual(c.provider, before.provider, "and its provider and model");
  Assert.ok(!c.granted, "and no grant: a restart ends every connection");
  const entries = AgentChat.transcript(c.id).entries.map((/** @type {any} */ e) => e.text);
  Assert.deepEqual(
    entries,
    [READ_TASK, "It is about Serde.", "task done · 2 steps · 330 tokens · hosts: example.com"],
    "its transcript is the messages, the replies and the summary",
  );
  requests.length = 0;
  await AgentChat.send(c.id, script([{ reply: "Again." }]));
  await AgentChat.done(c.id);
  const messages = requests[0].body.messages.map((/** @type {any} */ m) => m);
  const text = JSON.stringify(messages);
  Assert.ok(!text.includes(PAGE_TEXT), "the model is not sent the pages read before");
  Assert.ok(!messages.some((/** @type {any} */ m) => m.role === "tool"), "nor any tool result");
  Assert.ok(text.includes("It is about Serde."), "but the reply");
  // The scripted server reads the body as bytes, so only the ASCII around the dots is compared.
  Assert.ok(/\(Vimma: an earlier task: task done \S+ 2 steps/.test(text), "and Vimma's summary");
});

addTidyTask(async function test_clear_context() {
  const c = await ranTask();
  requests.length = 0;
  Assert.equal(AgentChat.clear(c.id), null, "cleared");
  Assert.ok(
    AgentChat.transcript(c.id).entries.some((/** @type {any} */ e) =>
      e.text.startsWith("context cleared"),
    ),
    "the transcript marks the place",
  );
  await AgentChat.send(c.id, script([{ reply: "Fresh." }]));
  await AgentChat.done(c.id);
  const text = JSON.stringify(requests[0].body.messages);
  Assert.ok(!text.includes(PAGE_TEXT), "no page read before the clear");
  Assert.ok(text.includes("It is about Serde.") && text.includes("an earlier task"), "kept");
  await AgentChat.flush();
  const { plain } = await decrypted(c.uid);
  Assert.ok(plain.includes("Fresh."), "the conversation is still stored, with its new reply");
});

addTidyTask(async function test_delete_and_forget_all_remove_files() {
  const one = await ranTask();
  const two = await ranTask();
  Assert.equal((await storedFiles()).length, 2, "two files");
  // `d` in the list, after y.
  await openPage();
  runCommand("agent list");
  await until(() => isOpen() && rows().length === 2, "the list shows both");
  EventUtils.synthesizeKey("d");
  await until(() => !!$("vimma-rename") && !$("vimma-rename").hidden, "it asks first");
  Assert.ok(
    $("vimma-rename").textContent.includes(`Delete "${two.title}"? y/N`),
    "naming the newest, which is first",
  );
  EventUtils.synthesizeKey("y");
  await until(async () => (await storedFiles()).length === 1, "d removed its file");
  Assert.ok((await storedFiles())[0].endsWith(`${one.uid}.conv`), "and only that conversation's");
  chat().close();
  await ranTask();
  // `:agent forget all`: every file, a stray one the keyring cannot read included.
  await IOUtils.writeUTF8(
    PathUtils.join(AgentStore.dir, "00000000-0000-4000-8000-000000000000.conv"),
    "not ours",
  );
  runCommand("agent forget all");
  await until(
    () => /Delete all 2 agent conversations\? y\/N/.test($("vimma-rename")?.textContent ?? ""),
    ":agent forget all asks with the count",
  );
  EventUtils.synthesizeKey("y");
  await until(async () => (await storedFiles()).length === 0, "every file is gone");
  Assert.deepEqual(AgentChat.list(), [], "and every conversation");
});

addTidyTask(async function test_a_deleted_conversations_task_writes_nothing_after() {
  const c = AgentChat.create({ provider: PROVIDER });
  const task = script([{ hold: true }]);
  await AgentChat.send(c.id, task);
  await until(() => held.has(task), "the model's reply is held");
  await AgentChat.flush();
  Assert.equal((await storedFiles()).length, 1, "the message was stored");
  const done = AgentChat.done(c.id).catch(() => {});
  await AgentChat.delete(c.id);
  Assert.deepEqual(await storedFiles(), [], "d removed the file");
  held.get(task)();
  held.delete(task);
  await done;
  await TestUtils.waitForTick();
  await AgentChat.flush();
  Assert.deepEqual(await storedFiles(), [], "the task that ended after wrote nothing back");
});

addTidyTask(async function test_only_the_final_reply_is_stored_and_temp_files_go() {
  const c = AgentChat.create({ provider: PROVIDER });
  // A turn with a tool call carries text too; only the task's final reply is kept.
  await AgentChat.send(
    c.id,
    script([{ call: "vimma_tabs", args: {}, say: "Looking at the tabs." }, { reply: "Final." }]),
  );
  await AgentChat.done(c.id);
  await AgentChat.flush();
  const { plain } = await decrypted(AgentChat.get(c.id).uid);
  Assert.deepEqual(
    JSON.parse(plain).entries.map((/** @type {any} */ e) => e.kind),
    ["user", "agent", "summary"],
    "the message, the final reply and the summary",
  );
  // A temporary file a crash left between write and rename goes with forget all.
  const tmp = PathUtils.join(AgentStore.dir, `${AgentChat.get(c.id).uid}.conv.0a1b2c3d.tmp`);
  await IOUtils.writeUTF8(tmp, "left by a crash");
  await AgentChat.forgetAll();
  Assert.deepEqual(await IOUtils.getChildren(AgentStore.dir), [], "nothing is left");
});

addTidyTask(async function test_keep_days() {
  const old = await ranTask();
  const recent = await ranTask();
  const oldFile = PathUtils.join(AgentStore.dir, `${old.uid}.conv`);
  await IOUtils.setModificationTime(oldFile, Date.now() - 31 * DAY);
  McpHost.configureAgent({
    ...AGENT_DEFAULTS,
    default: "scripted",
    providers: [PROVIDER],
    keepDays: null,
  });
  await AgentChat.prune();
  Assert.equal((await storedFiles()).length, 2, "without keep_days nothing is deleted");
  McpHost.configureAgent({
    ...AGENT_DEFAULTS,
    default: "scripted",
    providers: [PROVIDER],
    keepDays: 30,
  });
  await AgentChat.prune();
  const left = await storedFiles();
  Assert.deepEqual(
    left.map((p) => PathUtils.filename(p)),
    [`${recent.uid}.conv`],
    "keep_days deleted the conversation unused for longer",
  );
  Assert.deepEqual(
    AgentChat.list().map((/** @type {any} */ c) => c.uid),
    [recent.uid],
    "from memory too",
  );
});

addTidyTask(async function test_list_shows_stored_conversations_newest_first() {
  const groceries = AgentChat.create({ provider: PROVIDER, title: "Weekly groceries" });
  await AgentChat.send(groceries.id, script([{ reply: "ok" }]));
  await AgentChat.done(groceries.id);
  const train = AgentChat.create({ provider: PROVIDER, title: "Train ticket" });
  await AgentChat.send(train.id, script([{ reply: "ok" }]));
  await AgentChat.done(train.id);
  await AgentChat.flush();
  AgentChat.reset();
  await openPage();
  runCommand("agent list");
  await until(() => isOpen() && rows().length === 2, "the stored conversations are listed");
  const text = rows().map((r) => r.textContent);
  Assert.ok(text[0].startsWith("Train ticket"), `newest first: ${text}`);
  Assert.ok(text[1].startsWith("Weekly groceries"), "then the older");
  Assert.ok(text[0].includes("scripted · scripted · just now"), "provider, model, last use");
  // `/` filters by title.
  EventUtils.synthesizeKey("/");
  await until(() => !!$("vimma-rename") && !$("vimma-rename").hidden, "it asks the filter");
  EventUtils.sendString("week");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => rows().length === 1, "one row matches");
  Assert.ok(rows()[0].textContent.startsWith("Weekly groceries"), "the one whose title matches");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(() => chat().view === "chat", "Enter opens it");
  Assert.ok(logText().includes("ok"), "with its transcript");
  Assert.equal(
    AgentChat.get(chat().conversation).title,
    "Weekly groceries",
    "the window is on that conversation",
  );
});

addTidyTask(async function test_setup_writes_the_provider_and_default_to_config() {
  const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-agent-config");
  const path = PathUtils.join(dir, "config.toml");
  await IOUtils.writeUTF8(path, "schema = 2\n# mine\n[mcp]\nenabled = false\n");
  await SpecialPowers.pushPrefEnv({ set: [[CONFIG_PATH_PREF, path]] });
  const name = "127.0.0.1";
  try {
    await ConfigHost.reload();
    Assert.deepEqual(McpHost.agentConfig?.providers, [], "no provider is set up");
    await openPage();
    runCommand("agent model");
    await until(
      () => logText().includes("add: OpenAI-compatible endpoint"),
      "setup offers a provider",
    );
    const at = rows().findIndex((r) => r.textContent.includes("add: OpenAI-compatible endpoint"));
    for (let i = 0; i < at; i++) EventUtils.synthesizeKey("j");
    EventUtils.synthesizeKey("KEY_Enter");
    await until(() => !!$("vimma-rename") && !$("vimma-rename").hidden, "it asks the endpoint");
    EventUtils.sendString(`http://127.0.0.1:${PORT}/v1`);
    EventUtils.synthesizeKey("KEY_Enter");
    await until(() => /model/.test($("vimma-rename").textContent), "then the model");
    EventUtils.sendString("scripted");
    EventUtils.synthesizeKey("KEY_Enter");
    await until(
      () => !!$("vimma-agent-chat-key") && !$("vimma-agent-chat-key").parentElement.hidden,
      "then the key",
    );
    EventUtils.sendString("sk-test-0000-9f3a");
    EventUtils.synthesizeKey("KEY_Enter");
    await until(
      () => McpHost.agentConfig?.default === name,
      "config.toml was written and read: [agent] default names the provider",
    );
    const text = await IOUtils.readUTF8(path);
    Assert.ok(text.startsWith("schema = 2\n# mine\n[mcp]\nenabled = false\n"), "lines kept");
    Assert.ok(!text.includes("sk-test"), "no key in config.toml");
    Assert.deepEqual(
      McpHost.agentConfig.providers,
      [
        {
          name,
          kind: "openai",
          endpoint: `http://127.0.0.1:${PORT}/v1`,
          model: "scripted",
          vision: false,
        },
      ],
      "the provider, by endpoint and model only",
    );
    await until(
      () => /saved to config\.toml as \[agent\] default/.test($("vimma-notice")?.textContent ?? ""),
      "the notice says where it went",
    );
    // After a restart a new conversation gets it.
    chat().close();
    await AgentChat.forgetAll();
    const fresh = chat().create();
    Assert.equal(AgentChat.get(fresh).provider.name, name, "a new conversation uses it");
  } finally {
    await AgentKeys.delete(name);
    await SpecialPowers.popPrefEnv();
    await ConfigHost.reload();
    await IOUtils.remove(dir, { recursive: true });
  }
});

addTidyTask(async function test_setup_creates_a_missing_config_with_the_provider() {
  const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-agent-config");
  const path = PathUtils.join(dir, "config.toml");
  await SpecialPowers.pushPrefEnv({ set: [[CONFIG_PATH_PREF, path]] });
  try {
    const r = await ConfigHost.addAgentProvider(PROVIDER, { makeDefault: true });
    Assert.deepEqual(r, { name: "scripted" }, "written to a config.toml that did not exist");
    Assert.equal(McpHost.agentConfig?.default, "scripted", "and read: it is [agent] default");
    Assert.equal((await IOUtils.stat(path)).permissions, 0o600, "the user's alone");
  } finally {
    await SpecialPowers.popPrefEnv();
    await ConfigHost.reload();
    await IOUtils.remove(dir, { recursive: true });
  }
});
